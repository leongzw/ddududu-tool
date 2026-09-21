#!/usr/bin/env node
// Auto-refreshes fomo.family Privy access tokens headlessly — no browser tab
// and no userscript needed.
//
// Protocol (reverse-engineered from Privy's SDK v3.34.0 inside fomo's bundle;
// full notes in fomo-ws-protocol.md § "Auto-refreshing the JWT"):
//   POST https://privy.fomo.family/api/v1/sessions
//     (fomo's Privy auth proxy, CNAME → <appId>.api.privy.systems;
//      https://auth.privy.io/api/v1/sessions works identically)
//     headers: privy-app-id, privy-client: react-auth:3.34.0,
//              privy-ca-id: <any persisted uuid>,
//              Authorization: Bearer <last access token — optional>,
//              Origin: https://fomo.family
//     body: {"refresh_token":"<opaque 30-day token>"}
//   → {"session_update_action":"set"|"ignore"|"clear", token, privy_access_token,
//      refresh_token (ROTATED — must be persisted immediately!),
//      identity_token, user}
//
// ONE-TIME SEED — copy the refresh token from your logged-in browser:
//   1. open https://fomo.family logged in → F12 → Application → Cookies
//   2. pick https://privy.fomo.family → copy the `privy-refresh-token` value
//      (it's httpOnly, so only DevTools — not page JS — can read it)
//   3. seed + start:   node scripts/fomo-token-refresher.mjs <refresh-token>
//
// Usage:
//   node scripts/fomo-token-refresher.mjs <refresh-token>  seed & run forever
//   node scripts/fomo-token-refresher.mjs                  run with saved state
//   node scripts/fomo-token-refresher.mjs --once           single refresh, exit
//   node scripts/fomo-token-refresher.mjs --status         show saved state
//
// State lives in scripts/.fomo-session.json (gitignored). The vite dev server
// serves the current access token at /api/fomo-token for TokenMonitor.jsx.
// Caveats: refresh tokens ROTATE on every use — losing this file (or crashing
// between the refresh and the save) kills the session and you must re-seed.
// A "clear" response means Privy revoked the session → re-login & re-seed.

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const BASE = process.env.FOMO_AUTH_BASE || 'https://privy.fomo.family';
const APP_ID = 'cm6h485o300n3zj9yl6vpedq7';
const SDK = 'react-auth:3.34.0';
const STATE_FILE = new URL('./.fomo-session.json', import.meta.url);
const INTERVAL_MS = (Number(process.env.FOMO_REFRESH_MINUTES) || 45) * 60_000;

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
// hard process.exit() while undici's keep-alive sockets are still open trips a
// libuv assertion on Windows — give handles a beat to close first
const gracefulExit = (code) => {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 150);
};
const mask = (t) =>
  typeof t === 'string' && t.length > 16 ? `${t.slice(0, 10)}…${t.slice(-4)} (${t.length} ch)` : '∅';

const jwtExp = (t) => {
  try {
    const p = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());
    return p.iss === 'privy.io' && p.aud === APP_ID ? p.exp || 0 : 0;
  } catch {
    return 0;
  }
};

const loadState = () => {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
};

const saveState = (s) => {
  // atomic-ish: write a temp file, then rename over the real one, so a crash
  // can never leave a half-written state (the rotating refresh token is
  // unrecoverable once lost)
  const tmp = new URL('./.fomo-session.json.tmp', import.meta.url);
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
  renameSync(tmp, STATE_FILE);
};

// rotated refresh tokens may arrive in the body OR as a set-cookie (fomo uses
// server-cookies mode) — accept either
const cookieValue = (res, name) => {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of raw) {
    const m = c.match(new RegExp(`^${name}=([^;]+)`));
    if (m && m[1] !== 'deleted') return decodeURIComponent(m[1]);
  }
  return null;
};

async function refresh(state) {
  const res = await fetch(`${BASE}/api/v1/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'privy-app-id': APP_ID,
      'privy-client': SDK,
      'privy-ca-id': state.caId,
      Origin: 'https://fomo.family',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    },
    body: JSON.stringify({ refresh_token: state.refreshToken }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.code = body.code || '';
    throw err;
  }

  if (body.session_update_action === 'clear') {
    // Privy revoked the session — the refresh token is dead. Re-seed needed.
    saveState({ caId: state.caId, lastError: 'session cleared — re-login & re-seed' });
    log('✗ session_update_action=clear — refresh token rejected/revoked.');
    log('  Re-login at https://fomo.family, copy the privy-refresh-token cookie');
    log('  (DevTools → Application → Cookies → privy.fomo.family) and re-seed.');
    gracefulExit(2);
  }

  // "set" = full token bundle, "ignore" = partial update — take whatever exists
  const token = body.token || body.privy_access_token || null;
  const rotated = body.refresh_token || cookieValue(res, 'privy-refresh-token');
  if (token) {
    state.token = token;
    state.exp = jwtExp(token);
    state.at = Date.now();
  }
  if (rotated && rotated !== state.refreshToken) {
    log(`  refresh token rotated → ${mask(rotated)}`);
    state.refreshToken = rotated;
  }
  state.lastRefreshAt = new Date().toISOString();
  state.lastError = '';
  saveState(state); // persist BEFORE anything else — rotation is one-shot

  const expMin = state.exp ? Math.round((state.exp * 1000 - Date.now()) / 60_000) : '?';
  log(`✓ ${body.session_update_action} — access token ${mask(state.token)} expires in ${expMin}m`);
  if (!state.exp) log('  ⚠ returned token did not parse as a fomo Privy JWT — check APP_ID');
}

// ---- CLI ----
const args = process.argv.slice(2);
const state = { caId: randomUUID(), ...loadState() };

if (args.includes('--status')) {
  console.log(JSON.stringify(
    {
      stateFile: STATE_FILE.pathname.replace(/\//g, '\\'),
      hasRefreshToken: Boolean(state.refreshToken),
      tokenExpiresAt: state.exp ? new Date(state.exp * 1000).toISOString() : null,
      lastRefreshAt: state.lastRefreshAt || null,
      lastError: state.lastError || null,
    },
    null,
    2,
  ));
  process.exit(0);
}

const seed = args.find((a) => !a.startsWith('--'));
if (seed) {
  state.refreshToken = seed;
  state.lastError = '';
  log(`seeded refresh token ${mask(seed)}`);
}
if (!state.refreshToken) {
  console.error('No refresh token. Grab it once from DevTools → Application → Cookies →');
  console.error('https://privy.fomo.family → privy-refresh-token, then run:');
  console.error('  node scripts/fomo-token-refresher.mjs <refresh-token>');
  process.exit(1);
}

const once = args.includes('--once');
let attempt = 0;

const nextDelayMs = () => {
  if (state.lastError) return Math.min(2 ** Math.min(attempt, 5) * 60_000, 30 * 60_000);
  const tillExp = state.exp ? state.exp * 1000 - Date.now() - 5 * 60_000 : Infinity;
  return Math.max(30_000, Math.min(INTERVAL_MS, tillExp));
};

const tick = async () => {
  try {
    await refresh(state);
    attempt = 0;
  } catch (e) {
    attempt += 1;
    state.lastError = `${e.code ? `${e.code}: ` : ''}${e.message}`;
    saveState(state);
    log(`✗ refresh failed (attempt ${attempt}): ${state.lastError}`);
    if (e.code === 'missing_or_invalid_token') {
      log('  Token rejected — revoked or mis-copied. Re-login at fomo.family and re-seed.');
    }
  }
  if (once) {
    gracefulExit(state.lastError ? 1 : 0);
    return;
  }
  const wait = nextDelayMs();
  log(`next refresh in ${Math.round(wait / 60_000)}m`);
  setTimeout(tick, wait);
};

log(`fomo token refresher — ${BASE} · interval ${Math.round(INTERVAL_MS / 60_000)}m`);
tick();
