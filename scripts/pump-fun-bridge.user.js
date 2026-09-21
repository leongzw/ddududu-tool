// ==UserScript==
// @name         pump.fun → ddududu-tools following-feed bridge
// @namespace    ddududu-tools
// @version      1.2.0
// @description  Streams pump.fun's "following" alerts (what the accounts you follow call & trade) into ddududu-tools' Token Monitor. pump.fun's API only accepts real browser requests, so this polls from inside a logged-in pump.fun tab and relays the page to the tools app.
// @match        https://pump.fun/*
// @match        http://localhost:5173/*
// @match        http://127.0.0.1:5173/*
// @match        http://localhost:4173/*
// @match        http://127.0.0.1:4173/*
// @match        https://ddududu-tool.vercel.app/*
// @run-at       document-idle
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @connect      127.0.0.1
// @connect      ddududu-tool.vercel.app
// ==/UserScript==

/* global unsafeWindow, GM_getValue, GM_setValue, GM_addValueChangeListener, GM_xmlhttpRequest */
/*
 * Why this exists (details in pump-fun-api.md § "Auth findings"):
 * GET /following-positions/alerts needs the pump.fun session (auth_token
 * cookie), and pump.fun rejects that cookie from anything that isn't a real
 * browser — a token captured seconds earlier still 401s from curl/node, so the
 * Token Monitor can't fetch the feed itself.
 *
 * On pump.fun (any logged-in tab; pinned/background is fine) this polls the
 * alerts feed same-site — exactly the request pump.fun's own frontend makes —
 * and relays the latest page two ways:
 *   1. GM storage + a 'pump-feed-refresh' event on the tools app (same machine)
 *   2. POST /api/pump-ingest on the tools app (works across the LAN and to
 *      the Vercel deployment — TOOL_URL below defaults to it; switch to the
 *      dev-server address for local-only setups)
 *
 * On the tools app it just re-dispatches stored pages as window events;
 * TokenMonitor.jsx listens and merges them into the pump.fun panel.
 */

(() => {
  'use strict';

  const STORE_KEY = 'ddududu-pump-feed'; // { items, at } | null
  // Where the deployed tools app lives — the ingest relay reaches it from any
  // machine. For local-only dev switch to 'http://localhost:5173' (or a LAN
  // address like 'http://192.168.1.20:5173') and allow that host in
  // Tampermonkey's @connect settings when prompted.
  const TOOL_URL = 'https://ddududu-tool.vercel.app';
  const FEED_URL =
    'https://frontend-api-v3.pump.fun/following-positions/alerts' +
    '?pageSize=10&kinds=callout,update,trade&minTradeAmountUsd=10'; // edit kinds to taste
  const POLL_MS = 5_000;
  const STALE_MS = 60_000;

  const host = location.hostname;
  const isTools =
    host === 'localhost' || host === '127.0.0.1' || host === 'ddududu-tool.vercel.app';

  if (isTools) {
    const apply = (snap) => {
      if (!snap || !Array.isArray(snap.items)) return;
      if (Date.now() - (snap.at || 0) > STALE_MS) return; // stale page — ignore
      // dispatch even empty pages — the panel uses them as a bridge heartbeat
      window.dispatchEvent(new CustomEvent('pump-feed-refresh', { detail: snap }));
    };
    apply(GM_getValue(STORE_KEY, null)); // in case a page arrived before we loaded
    setInterval(() => apply(GM_getValue(STORE_KEY, null)), 3_000);
    if (typeof GM_addValueChangeListener === 'function') {
      GM_addValueChangeListener(STORE_KEY, (_k, _old, nv, remote) => {
        if (remote) apply(nv);
      });
    }
    return;
  }

  // ---- on pump.fun: poll the following feed and relay it ----
  // NOTE: do NOT skip when document.hidden — a pinned/background pump.fun tab
  // is the intended deployment; the browser merely throttles the interval
  // (down to ~1/min after a while), which this feed tolerates fine.
  let lastToolWarn = 0;
  const warnToolDown = (why) => {
    if (Date.now() - lastToolWarn < 60_000) return; // throttle the console spam
    lastToolWarn = Date.now();
    console.warn(
      `[pump-bridge] relay to ${TOOL_URL}/api/pump-ingest failed (${why}) — ` +
        'if the tools app runs on another machine, set TOOL_URL (top of this ' +
        "script) to that machine's address and allow it in Tampermonkey's @connect prompt",
    );
  };
  let busy = false;
  const poll = async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await fetch(FEED_URL, {
        credentials: 'include', // sends the auth_token cookie, same-site
        headers: { accept: 'application/json' },
      });
      if (!r.ok) return;
      const d = await r.json();
      if (!Array.isArray(d.items)) return;
      // relay even an empty page — it heartbeat-proves the bridge is alive
      const snap = { items: d.items, at: Date.now() };
      GM_setValue(STORE_KEY, snap); // same-machine relay via GM storage
      GM_xmlhttpRequest({
        // cross-machine relay (extension context → no CORS/mixed-content)
        method: 'POST',
        url: `${TOOL_URL}/api/pump-ingest`,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(snap),
        onload: (r) => {
          if (r.status >= 400) warnToolDown(`HTTP ${r.status}`);
        },
        onerror: () => warnToolDown('network'),
        ontimeout: () => warnToolDown('timeout'),
      });
    } catch {
      /* logged out or offline — retry on the next tick */
    } finally {
      busy = false;
    }
  };

  poll();
  setInterval(poll, POLL_MS);
  // catch up quickly when the tab becomes visible again
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) poll();
  });
})();
