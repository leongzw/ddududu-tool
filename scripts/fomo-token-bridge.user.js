// ==UserScript==
// @name         fomo.family → ddududu-tools JWT bridge
// @namespace    ddududu-tools
// @version      1.0.0
// @description  Auto-refresh the Privy JWT used by ddududu-tools' Token Monitor. Keep a fomo.family tab logged in; every fresh token Privy mints there is relayed to the tools app automatically.
// @match        https://fomo.family/*
// @match        http://localhost:5173/*
// @match        http://127.0.0.1:5173/*
// @match        http://localhost:4173/*
// @match        http://127.0.0.1:4173/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// ==/UserScript==

/* global unsafeWindow, GM_getValue, GM_setValue, GM_addValueChangeListener */
/*
 * Why this exists (details in fomo-ws-protocol.md § "Auto-refreshing the JWT"):
 *   - Privy access tokens (the JWT fomo's WS challenge needs) live exactly 1h.
 *   - Privy's 30-day refresh token is locked inside Privy's auth iframe and is
 *     not accessible to page JS; there is no public endpoint to mint tokens
 *     yourself. Only the Privy SDK running inside a logged-in fomo.family tab
 *     can refresh — so we harvest tokens from that tab.
 *
 *   On fomo.family this script watches every place a fresh token surfaces:
 *     1. localStorage  `privy:token` / `privy:<appId>:token`   (Privy SDK copies)
 *     2. cookie        `privy-token` / `privy-<appId>-token`   (non-httpOnly)
 *     3. the FomoWS auth frame  {"type":"challengeResponse","jwt":…}  (minted on
 *        demand by Privy's getCustomerAccessToken() right before every connect)
 *     4. `Authorization: Bearer <jwt>` headers on fomo's authenticated REST calls
 *   …and keeps the longest-lived one in Tampermonkey storage.
 *
 *   On the tools app (localhost) it pushes new tokens into
 *   localStorage['token-monitor:jwt'] and dispatches a 'fomo-token-refresh'
 *   event, which TokenMonitor.jsx listens for and reconnects with.
 *
 *   Limits: keep one logged-in fomo.family tab open (pinned/background is fine);
 *   re-login to fomo.family when Privy's 30-day session eventually expires.
 */

(() => {
  const LS_JWT = 'token-monitor:jwt';
  const STORE_KEY = 'ddududu:fomo-jwt-bridge';
  const PRIVY_APP_ID = 'cm6h485o300n3zj9yl6vpedq7'; // aud claim of fomo.family's tokens

  // exp of a Privy-issued, fomo-scoped JWT, or 0 if the string is not one
  const jwtExp = (t) => {
    if (typeof t !== 'string') return 0;
    try {
      const s = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const p = JSON.parse(atob(s + '='.repeat((4 - (s.length % 4)) % 4)));
      return p.iss === 'privy.io' && p.aud === PRIVY_APP_ID ? p.exp || 0 : 0;
    } catch {
      return 0;
    }
  };

  const readStore = () => GM_getValue(STORE_KEY, null); // { token, exp, at } | null
  const host = location.hostname;

  if (host === 'fomo.family' || host.endsWith('.fomo.family')) {
    // ---------- source side: harvest fresh tokens from the logged-in session ----------
    const store = (token) => {
      const exp = jwtExp(token);
      if (exp * 1000 < Date.now() + 30_000) return; // junk or about to expire — ignore
      const prev = readStore();
      if (prev && jwtExp(prev.token) >= exp) return; // keep the longest-lived
      GM_setValue(STORE_KEY, { token, exp, at: Date.now() });
    };

    // 1) localStorage copies kept by the Privy SDK
    const fromLocalStorage = () => {
      for (const k of [`privy:${PRIVY_APP_ID}:token`, 'privy:token']) {
        const v = localStorage.getItem(k);
        if (v) store(v);
      }
    };

    // 2) non-httpOnly cookies (fomo's own service worker reads these too)
    const fromCookie = () => {
      for (const part of document.cookie.split(';')) {
        const i = part.indexOf('=');
        if (i <= 0) continue;
        const name = part.slice(0, i).trim();
        if (name === 'privy-token' || name === `privy-${PRIVY_APP_ID}-token`) {
          try {
            store(decodeURIComponent(part.slice(i + 1).trim()));
          } catch {
            store(part.slice(i + 1).trim());
          }
        }
      }
    };

    const poll = () => {
      fromLocalStorage();
      fromCookie();
    };
    poll();
    setInterval(poll, 10_000);
    // ---- 3+4) page-context hooks continue below ----

    // 3+4) Patch on unsafeWindow so fomo's own calls run through these hooks.
    //     All errors are swallowed — never break the host page.
    const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : null;
    if (page?.WebSocket?.prototype?.send) {
      const wsSend = page.WebSocket.prototype.send;
      page.WebSocket.prototype.send = function (data) {
        try {
          if (typeof data === 'string' && data.includes('challengeResponse')) {
            const m = JSON.parse(data);
            if (m?.type === 'challengeResponse' && m.jwt) store(m.jwt);
          }
        } catch {
          /* not for us */
        }
        return wsSend.apply(this, arguments);
      };
    }
    if (typeof page?.fetch === 'function') {
      const fetchOrig = page.fetch.bind(page);
      page.fetch = (input, init) => {
        try {
          let auth = null;
          if (input && typeof input.headers?.get === 'function') {
            auth = input.headers.get('authorization');
          } else if (init?.headers) {
            const h = init.headers;
            if (typeof h.get === 'function') auth = h.get('authorization');
            else if (Array.isArray(h)) {
              auth = h.find(([k]) => String(k).toLowerCase() === 'authorization')?.[1] ?? null;
            } else if (typeof h === 'object') {
              for (const k of Object.keys(h)) {
                if (k.toLowerCase() === 'authorization') auth = h[k];
              }
            }
          }
          if (typeof auth === 'string' && auth.startsWith('Bearer ')) store(auth.slice(7));
        } catch {
          /* not for us */
        }
        return fetchOrig(input, init);
      };
    }
  } else {
    // ---------- sink side: push fresh tokens into the Token Monitor ----------
    const apply = (entry) => {
      const exp = jwtExp(entry?.token);
      if (exp * 1000 < Date.now() + 30_000) return; // nothing usable
      const cur = localStorage.getItem(LS_JWT) || '';
      if (cur === entry.token) return;
      if (jwtExp(cur) >= exp) return; // never downgrade a token the user just pasted
      localStorage.setItem(LS_JWT, entry.token);
      window.dispatchEvent(new CustomEvent('fomo-token-refresh', { detail: entry }));
    };

    apply(readStore()); // in case a fresh token arrived before the page loaded
    setInterval(() => apply(readStore()), 5_000);
    if (typeof GM_addValueChangeListener === 'function') {
      GM_addValueChangeListener(STORE_KEY, (_k, _old, nv, remote) => {
        if (remote) apply(nv);
      });
    }
  }
})();
