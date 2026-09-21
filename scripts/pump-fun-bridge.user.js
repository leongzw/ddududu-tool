// ==UserScript==
// @name         pump.fun → ddududu-tools following-feed bridge
// @namespace    ddududu-tools
// @version      1.3.0
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
// ==/UserScript==

/* global unsafeWindow, GM_getValue, GM_setValue, GM_addValueChangeListener */
/*
 * Why this exists (details in pump-fun-api.md § "Auth findings"): history.
 * The belief was that GET /following-positions/alerts only worked from a real
 * browser; the 2026-09-21 correction showed server-side calls with a LIVE
 * token work fine (earlier 401s were rotated-out tokens). The panel now polls
 * /api/pump-api itself, so this script is only a same-machine accelerator:
 *
 * On pump.fun (any logged-in tab; pinned/background is fine) this polls the
 * alerts feed same-site — exactly the request pump.fun's own frontend makes —
 * and relays the latest page via GM storage + a 'pump-feed-refresh' event on
 * the tools app opened in the same browser (dev server or deployed site).
 *
 * On the tools app it just re-dispatches stored pages as window events;
 * TokenMonitor.jsx listens and merges them into the pump.fun panel.
 */

(() => {
  'use strict';

  const STORE_KEY = 'ddududu-pump-feed'; // { items, at } | null
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
