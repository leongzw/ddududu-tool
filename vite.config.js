import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

// ---- fomo.family Privy token plumbing for the Token Monitor ----
// The browser can't call Privy directly (CORS only allows Origin:
// https://fomo.family), so two same-origin endpoints are provided:
//   GET  /api/fomo-token    — current access token from scripts/.fomo-session.json
//                             (optional scripts/fomo-token-refresher.mjs daemon)
//   POST /api/privy-refresh — proxies a Privy session refresh so the Token
//                             Monitor page can keep its own JWT fresh with NO
//                             daemon and NO browser tab (server-side, no CORS)
const PRIVY_BASE = process.env.FOMO_AUTH_BASE || 'https://privy.fomo.family';
const PRIVY_APP_ID = 'cm6h485o300n3zj9yl6vpedq7';
const PRIVY_CLIENT = 'react-auth:3.34.0';

const json = (res, code, obj) => {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
};

const readBody = (req) =>
  new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    });
  });

const privyRefresh = async (req, res) => {
  const body = await readBody(req);
  if (!body.refreshToken) {
    json(res, 400, { error: 'missing refreshToken' });
    return;
  }
  try {
    const r = await fetch(`${PRIVY_BASE}/api/v1/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'privy-app-id': PRIVY_APP_ID,
        'privy-client': PRIVY_CLIENT,
        'privy-ca-id': body.caId || '00000000-0000-4000-8000-000000000000',
        Origin: 'https://fomo.family',
      },
      body: JSON.stringify({ refresh_token: body.refreshToken }),
      signal: AbortSignal.timeout(20_000),
    });
    const out = await r.json().catch(() => ({}));
    // fomo uses server-cookies mode: the rotated refresh token may arrive as a
    // set-cookie instead of in the body — surface it either way (never any
    // other cookie material)
    let rotated = out.refresh_token || null;
    if (!rotated && typeof r.headers.getSetCookie === 'function') {
      for (const c of r.headers.getSetCookie()) {
        const m = c.match(/^privy-refresh-token=([^;]+)/);
        if (m && m[1] !== 'deleted') rotated = decodeURIComponent(m[1]);
      }
    }
    json(res, r.status, {
      session_update_action: out.session_update_action || null,
      token: out.token || out.privy_access_token || null,
      refreshToken: rotated,
      error: out.error || null,
      code: out.code || null,
    });
  } catch (e) {
    json(res, 502, { error: `privy proxy: ${e.message}` });
  }
};

// Read-only proxy for fomo's REST API (prod-api.fomo.family) — powers the
// Token Monitor's "Check" feed diagnostics. GET-only with a strict path
// charset; the caller supplies the (auto-refreshed) Privy JWT.
const fomoApi = async (req, res) => {
  const body = await readBody(req);
  if (!body.path || !body.jwt) {
    json(res, 400, { error: 'missing path or jwt' });
    return;
  }
  if (!/^\/[a-zA-Z0-9/_?=&.-]*$/.test(body.path)) {
    json(res, 400, { error: 'bad path' });
    return;
  }
  try {
    const r = await fetch(`https://prod-api.fomo.family${body.path}`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${body.jwt}`,
        Origin: 'https://fomo.family',
        Referer: 'https://fomo.family/',
      },
      signal: AbortSignal.timeout(20_000),
    });
    json(res, r.status, await r.json().catch(() => ({})));
  } catch (e) {
    json(res, 502, { error: `fomo api proxy: ${e.message}` });
  }
};

// Read-only proxy for pump.fun's frontend API (frontend-api-v3.pump.fun) —
// powers the Token Monitor's pump.fun following panel. Same-origin POST
// {path, token?} style matching fomoApi above, because the API is CORS-locked
// to pump.fun's own origin (foreign origins get 403). Public reads (home-feed)
// need no auth; the following-positions/alerts feed needs the pump.fun session
// JWT, passed as the auth_token cookie exactly like pump.fun's own site.
const pumpApi = async (req, res) => {
  const body = await readBody(req);
  if (!body.path) {
    json(res, 400, { error: 'missing path' });
    return;
  }
  // % for URL-encoded query values (kinds=callout%2Cupdate), , and : for plain ones
  if (!/^\/[a-zA-Z0-9/_?=&.,%:-]*$/.test(body.path) || body.path.includes('..')) {
    json(res, 400, { error: 'bad path' });
    return;
  }
  const token =
    typeof body.token === 'string' && /^[A-Za-z0-9._-]{20,}$/.test(body.token) ? body.token : null;
  try {
    const r = await fetch(`https://frontend-api-v3.pump.fun${body.path}`, {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Origin: 'https://pump.fun',
        Referer: 'https://pump.fun/',
        ...(token ? { Cookie: `auth_token=${token}` } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    json(res, r.status, await r.json().catch(() => ({})));
  } catch (e) {
    json(res, 502, { error: `pump api proxy: ${e.message}` });
  }
};

// Ingest for the pump.fun bridge userscript (scripts/pump-fun-bridge.user.js).
// pump.fun's authed API enforces browser-only clients (a minutes-old auth_token
// 401s from node under every transport), so the userscript polls
// /following-positions/alerts inside a logged-in pump.fun tab and POSTs the
// latest page here; the Token Monitor GETs it back and merges (dedupe by item
// key). LAN-local, read-mostly, no credentials stored.
let pumpIngestState = { seq: 0, at: 0, items: [] };
const pumpIngest = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method === 'POST') {
    readBody(req)
      .then((b) => {
        if (Array.isArray(b.items)) {
          // stamp `at` server-side — a skewed bridge machine's clock must never
          // make fresh pages look stale to the panel (keep client time as clientAt)
          pumpIngestState = {
            seq: pumpIngestState.seq + 1,
            at: Date.now(),
            clientAt: b.at || 0,
            items: b.items.slice(0, 50),
          };
          json(res, 200, { ok: true, seq: pumpIngestState.seq });
        } else {
          json(res, 400, { error: 'items[] required' });
        }
      })
      .catch(() => json(res, 400, { error: 'bad body' }));
    return;
  }
  json(res, 200, pumpIngestState);
};

function fomoTokenApi() {
  const SESSION_FILE = new URL('./scripts/.fomo-session.json', import.meta.url);
  const serveTokenFile = (_req, res) => {
    let out = { token: '', exp: 0, at: 0, lastError: '' };
    try {
      const s = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
      out = { token: s.token || '', exp: s.exp || 0, at: s.at || 0, lastError: s.lastError || '' };
    } catch {
      out.lastError = 'no session — seed scripts/fomo-token-refresher.mjs';
    }
    json(res, 200, out);
  };
  const install = (server) => {
    server.middlewares.use('/api/fomo-token', serveTokenFile);
    server.middlewares.use('/api/privy-refresh', privyRefresh);
    server.middlewares.use('/api/fomo-api', fomoApi);
    server.middlewares.use('/api/pump-api', pumpApi);
    server.middlewares.use('/api/pump-ingest', pumpIngest);
  };
  return {
    name: 'fomo-token-api',
    configureServer: install,
    configurePreviewServer: install,
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), fomoTokenApi()],
});


