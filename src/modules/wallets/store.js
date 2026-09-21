// Wallet store for batch minting: holds EVM private keys + derived addresses.
//
// SECURITY MODEL — this is a local personal tool, and batch minting requires the
// tool to *sign* transactions, so private keys must be available in the page.
//   - 'saved' storage (DEFAULT): keys persist in localStorage in PLAINTEXT and
//     survive reloads. The UI warns loudly that anything stored there is at
//     the mercy of this browser profile.
//   - 'session' storage (opt-out): keys live in sessionStorage — wiped when
//     the tab closes, never written to disk-persistent localStorage.
// Only ever import this module from the browser build.
import { ethers } from 'ethers';

const PERSIST_KEY = 'bnm-wallets-v1';
const SESSION_KEY = 'bnm-wallets-session';
const EVT = 'bnm:wallets';

// Diagnostics: every storage failure (probe or write) is recorded here with
// the verbatim browser error, so "why is storage blocked?" is answerable
// from the UI instead of guesswork. Shown in the blocked banner.
export const STORAGE_LOG = [];
const note = (storage, stage, err) => {
  STORAGE_LOG.push({ storage, stage, error: err?.message || String(err) });
};

// Some browsers / extensions block Web Storage outright (access or write
// throws SecurityError when site data is disabled). Fall back to a
// per-page-load memory store so the tool keeps working — memory wallets
// vanish on reload; the UI warns about that via STORAGE_BLOCKED.
const memoryStore = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => {
      m.set(k, String(v));
    },
    removeItem: (k) => {
      m.delete(k);
    },
  };
};

let storageBlocked = false;
const openStorage = (get, which) => {
  try {
    const s = get();
    const probe = '__bnm_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch (err) {
    note(which, 'probe', err);
    storageBlocked = true;
    return memoryStore();
  }
};

let ls = openStorage(() => globalThis.localStorage, 'local');
let ss = openStorage(() => globalThis.sessionStorage, 'session');

/** True when the browser blocked real storage — wallets live in memory only.
 *  Live `let` binding: can flip to true at RUNTIME if a late write fails
 *  (see degradeToMemory) — importing modules see the updated value. */
export let STORAGE_BLOCKED = storageBlocked;

/** Last-resort self-heal: real storage passed the load-time probe but a later
 *  write failed anyway (quota exceeded, an extension interfering mid-session).
 *  Snapshot everything we can still read, swap BOTH handles to memory mode,
 *  and keep working for the rest of this page load. */
const degradeToMemory = (reason) => {
  note('local/session', 'write', reason);
  const snapshot = read(); // via the still-current handles
  ls = memoryStore();
  ss = memoryStore();
  ss.setItem(SESSION_KEY, JSON.stringify(snapshot));
  STORAGE_BLOCKED = true;
};

/** Live re-probe of the browser's real storage. If the user lifted the block
 *  (settings change / disabled extension) WITHOUT reloading, this moves all
 *  in-memory wallets into real localStorage+sessionStorage (deduped by
 *  address), swaps the handles back, and clears STORAGE_BLOCKED — nothing is
 *  lost. Returns { ok, error? }. */
export function recheckStorage() {
  try {
    const probe = '__bnm_probe2__';
    globalThis.localStorage.setItem(probe, '1');
    globalThis.localStorage.removeItem(probe);
  } catch (err) {
    note('local', 'recheck', err);
    return { ok: false, error: err?.message || String(err) };
  }
  try {
    const persist = safeParse(ls.getItem(PERSIST_KEY));
    const sess = safeParse(ss.getItem(SESSION_KEY));
    const realLocal = globalThis.localStorage;
    const realSess = globalThis.sessionStorage;
    // `list` is an ALREADY-PARSED array — only `existingRaw` needs parsing.
    const merge = (list, existingRaw) => {
      const existing = safeParse(existingRaw);
      const have = new Set(existing.map((w) => w.address));
      for (const w of list) if (!have.has(w.address)) existing.push(w);
      return JSON.stringify(existing);
    };
    // Wallets created in memory-mode with persist=true are being moved into
    // real localStorage now — relabel their badges to 'saved'.
    const persistRelabeled = persist.map((w) => ({ ...w, storage: 'saved' }));
    realLocal.setItem(PERSIST_KEY, merge(persistRelabeled, realLocal.getItem(PERSIST_KEY)));
    realSess.setItem(SESSION_KEY, merge(sess, realSess.getItem(SESSION_KEY)));
    ls = realLocal;
    ss = realSess;
    STORAGE_BLOCKED = false;
    window.dispatchEvent(new Event(EVT));
    return { ok: true };
  } catch (err) {
    note('local', 'recheck-restore', err);
    return { ok: false, error: err?.message || String(err) };
  }
}

const read = () => [...safeParse(ls.getItem(PERSIST_KEY)), ...safeParse(ss.getItem(SESSION_KEY))];

/** Never throws on corrupt/missing values. */
const safeParse = (raw) => {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

// One-time: promote legacy session-only wallets to persistent storage, so
// wallets created before persistence-became-the-default survive tab close.
// Runs once ever (flag in localStorage); afterwards the "keep saved"
// opt-out behaves normally.
const MIGRATED_KEY = 'bnm-wallets-migrated-v2';
const migrateLegacySession = () => {
  if (STORAGE_BLOCKED) return;
  try {
    if (ls.getItem(MIGRATED_KEY)) return;
    const sess = safeParse(ss.getItem(SESSION_KEY));
    if (sess.length) {
      const saved = safeParse(ls.getItem(PERSIST_KEY));
      const have = new Set(saved.map((w) => w.address));
      for (const w of sess) {
        if (!have.has(w.address)) saved.push({ ...w, storage: 'saved' });
      }
      ls.setItem(PERSIST_KEY, JSON.stringify(saved));
      ss.removeItem(SESSION_KEY);
    }
    ls.setItem(MIGRATED_KEY, String(Date.now()));
  } catch {
    // Best-effort only; the write paths self-heal anyway.
  }
};
migrateLegacySession();

/** Normalize + validate a private key; returns { key, address } or throws. */
export function normalizePrivateKey(input) {
  let k = String(input || '').trim();
  if (!k.startsWith('0x') && /^[0-9a-fA-F]{64}$/.test(k)) k = `0x${k}`;
  const w = new ethers.Wallet(k); // throws on invalid
  return { key: w.privateKey.toLowerCase(), address: w.address.toLowerCase() };
}

export function getWallets() {
  if (typeof window === 'undefined') return [];
  return read();
}

// Quota handling ------------------------------------------------------------
// localStorage for an origin is ~5 MB and this app's own regenerable caches
// (funding history, NFT collection metadata) can fill it. Wallet keys always
// outrank caches: on QuotaExceededError we evict caches and retry the write.

const CACHE_KEY_PREFIXES = ['funding-compare-history', 'nft-mint-meta-'];

const isQuotaError = (err) =>
  !!err && (err.name === 'QuotaExceededError' || /quota/i.test(String(err.message)));

/** Approximate bytes used per localStorage key (UTF-16 ≈ 2 bytes/char). */
export function storageUsage() {
  const items = [];
  let total = 0;
  try {
    const real = globalThis.localStorage;
    for (let i = 0; i < real.length; i++) {
      const k = real.key(i);
      if (k == null) continue;
      const v = real.getItem(k);
      const bytes = (k.length + (v ? v.length : 0)) * 2;
      total += bytes;
      items.push({ key: k, bytes });
    }
  } catch {
    /* storage unreadable (blocked) — report empty */
  }
  items.sort((a, b) => b.bytes - a.bytes);
  return { total, items };
}

/** Delete regenerable caches (NEVER wallet data). Returns bytes freed. */
export function evictCaches() {
  const kill = [];
  try {
    const real = globalThis.localStorage;
    for (let i = 0; i < real.length; i++) {
      const k = real.key(i);
      if (k && CACHE_KEY_PREFIXES.some((p) => k.startsWith(p))) kill.push(k);
    }
  } catch {
    return 0;
  }
  let freed = 0;
  for (const k of kill) {
    try {
      const v = globalThis.localStorage.getItem(k);
      freed += (k.length + (v ? v.length : 0)) * 2;
      globalThis.localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  }
  if (freed) note('local', 'evict', new Error(`freed ${(freed / 1024).toFixed(0)} KB of regenerable caches`));
  return freed;
}

export function addWallet(privateKey, { label = '', persist = true, generated = false } = {}) {
  const { key, address } = normalizePrivateKey(privateKey);
  const existing = getWallets();
  if (existing.some((w) => w.address === address)) {
    throw new Error('This address is already in the wallet list');
  }
  const wallet = {
    id: `${address}`,
    address,
    label: String(label || '').trim() || `${address.slice(0, 6)}…${address.slice(-4)}`,
    key,
    generated: Boolean(generated),
    storage: persist && !STORAGE_BLOCKED ? 'saved' : 'session',
    addedAt: Date.now(),
  };

  const write = () => {
    if (persist) {
      const saved = safeParse(ls.getItem(PERSIST_KEY));
      saved.push(wallet);
      ls.setItem(PERSIST_KEY, JSON.stringify(saved));
    } else {
      const sess = safeParse(ss.getItem(SESSION_KEY));
      sess.push(wallet);
      ss.setItem(SESSION_KEY, JSON.stringify(sess));
    }
  };

  let failed = null;
  try {
    write();
  } catch (err) {
    failed = err;
    if (isQuotaError(err)) {
      // localStorage is full — drop regenerable caches, then retry.
      evictCaches();
      try {
        write();
        failed = null;
      } catch (err2) {
        failed = err2;
      }
    }
  }
  if (failed) {
    // Real storage is unusable (blocked / still over quota). Degrade to
    // memory mode and retry — the user's action must never be lost.
    degradeToMemory(failed);
    try {
      write();
    } catch (err2) {
      throw new Error(`Could not save the wallet even in memory: ${err2?.message || String(err2)}`);
    }
  }
  window.dispatchEvent(new Event(EVT));
  return wallet;
}

export function removeWallet(id) {
  ls.setItem(PERSIST_KEY, JSON.stringify(safeParse(ls.getItem(PERSIST_KEY)).filter((w) => w.id !== id)));
  ss.setItem(SESSION_KEY, JSON.stringify(safeParse(ss.getItem(SESSION_KEY)).filter((w) => w.id !== id)));
  window.dispatchEvent(new Event(EVT));
}

/** Bulk-remove wallets by id; single store update + one change event. */
export function removeWallets(ids) {
  const drop = new Set((ids || []).map(String));
  const keep = (raw) => JSON.stringify(safeParse(raw).filter((w) => !drop.has(w.id)));
  ls.setItem(PERSIST_KEY, keep(ls.getItem(PERSIST_KEY)));
  ss.setItem(SESSION_KEY, keep(ss.getItem(SESSION_KEY)));
  window.dispatchEvent(new Event(EVT));
}

/** Parse bulk import text: one wallet per line — "privateKey, label"
 *  (label optional; blank lines and #-comments skipped; label capped at 48 chars).
 *  Returns { entries: [{ line, key, label }], errors: [{ line, message }] }. */
export function parseWalletImport(text) {
  const entries = [];
  const errors = [];
  String(text || '')
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      const comma = line.indexOf(',');
      const keyPart = (comma === -1 ? line : line.slice(0, comma)).trim();
      const label = comma === -1 ? '' : line.slice(comma + 1).trim();
      try {
        entries.push({ line: i + 1, key: normalizePrivateKey(keyPart).key, label: label.slice(0, 48) });
      } catch {
        errors.push({ line: i + 1, message: 'not a valid private key (64 hex chars, 0x optional)' });
      }
    });
  return { entries, errors };
}

export function clearWallets() {
  ls.removeItem(PERSIST_KEY);
  ss.removeItem(SESSION_KEY);
  window.dispatchEvent(new Event(EVT));
}

/** Subscribe to store changes (same tab + cross-tab); returns unsubscribe. */
export function subscribeWallets(cb) {
  const onChange = () => cb(getWallets());
  window.addEventListener(EVT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(EVT, onChange);
    window.removeEventListener('storage', onChange);
  };
}
