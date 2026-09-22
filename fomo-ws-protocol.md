# fomo.family WebSocket — connectivity findings (2026-09-13)

Endpoint: `wss://prod-api.fomo.family/ws` (Cloudflare-fronted, 172.66.40.82 / 172.66.43.174)

## Transport: fully reachable ✅
- DNS, TLS, and WebSocket upgrade all work.
- Server responds `HTTP/1.1 101 Switching Protocols` with `Sec-WebSocket-Accept`.
- CORS headers allow Origin `https://fomo.family`.

## Application protocol (reverse-engineered from their FomoWS client, `token-v2-d2DTmrP3.js`)

1. On connect the server immediately pushes: `{"type":"challenge"}`
2. Client must reply: `{"type":"challengeResponse","jwt":"<JWT>"}`
   - Guest/empty JWT is **rejected**: server closes with code `1008`, reason `"missing jwt"`.
   - The JWT is the **Privy access token** (user must be logged in via the site's
     wallet login; client calls Privy's `getCustomerAccessToken()`, fallback cookie).
3. On success server sends `{"type":"challengeAccepted"}` → client is authenticated
   and can subscribe.
4. Subscribe / unsubscribe:
   `{"type":"subscribe","topicType":T,"topicId":I}`
   `{"type":"unsubscribe","topicType":T,"topicId":I}`
5. Server acks with `{"type":"subscribed"}` / `{"type":"unsubscribed"}`,
   streams `{"type":"data","topicType":T,"topicId":I,"payload":...}`,
   and can send `{"type":"error","code":...,"message":...}`.

Known topic types: `trending_tokens`, `graduated_tokens`, `pre_graduated_tokens`
(list topics; topicId = chain id, e.g. `1399811149` Solana), `prices`,
`token_details` (topicId = token address). The site also subscribes to the
combined multi-chain board as ONE topic using a comma-joined chain-id list —
topicId `1,56,143,4663,5042,8453,1399811149` — whose snapshots mix all listed
chains (this is what the Token Monitor's "Trending tokens" panel subscribes to).

The web client auto-unsubscribes suspended topics after 3s hidden and resubscribes
on focus; it uses a reconnecting wrapper (1s–30s backoff).

## Verified end-to-end (2026-09-13, with a real Privy JWT)
Full flow confirmed live:
```
[TOKEN] sub=did:privy:cml0... expires in 2634s
[OPEN] Handshake succeeded.
[MSG] {"type":"challenge"}
 -> {"type":"challengeResponse","jwt":"<privy access token>"}
[MSG] {"type":"challengeAccepted"}
 -> subscribe x4 (trending_tokens, graduated_tokens, pre_graduated_tokens @1399811149, prices @USDC)
[MSG] {"type":"subscribed","topicType":...,"activeSubscriptions":N}   (one per topic)
[DATA] ... 419 data frames in 25s ...
```

### Data frame shapes
- `subscribed` ack includes `activeSubscriptions` (server-side count).
- `payload.kind: "snapshot"` — full token array on first push per topic:
  ```json
  {"type":"data","topicType":"trending_tokens","topicId":"1399811149","payload":{"kind":"snapshot","tokens":[
    {"change24":"1.36","marketCap":"41681729.42","priceUSD":"0.0419","volume24":"33548477.58","holders":21107,
     "token":{"address":"5dvX...","networkId":1399811149,"name":"embercurve","symbol":"EMBER",
              "info":{"circulatingSupply":"994399751.75","totalSupply":"994399751.75","imageThumbUrl":"https://metadata.mobula.io/..."}},
     "createdAt":1789312282,                          // graduated/pre_graduated only
     "launchpad":{"launchpadName":"Pump.fun","graduationPercent":96.31}}  // pre_graduated only
  ]}}
  ```
- `payload.kind: "update"` — incremental single-token update (same token-entry shape
  under `payload.update`). Snapshots also re-occur periodically for list topics.
- `pre_graduated_tokens` entries include `launchpad.graduationPercent` (pump.fun
  bonding-curve progress); `graduated_tokens` include launchpad names like
  `Pump.fun` / `MeteoraDBC`. Metadata/images are served from `metadata.mobula.io`.

## `trading_activity` topic (verified live 2026-09-13)
Subscribe with a **feed UUID** as topicId (the one captured from a logged-in
browser session): `25597e33-fee6-5d58-8ba4-2f3d4469ec3f`. Server acks and then
pushes individual activity frames (no snapshot; push-only, event-driven):

**What the feed UUID actually is (bundle-verified 2026-09-20):** in
`TradingActivityFeed-v2-*.js` the site subscribes via
`subscribe("trading_activity", fomoUser.id, …)` — the topicId is **your own
fomo user id**, and the feed contents are computed server-side for that
account (follows/alerts + threshold filters). Consequences:

- following a new user on fomo does **not** change the feed id — no need to
  re-capture it
- if you re-login to fomo with a **different wallet**, your fomo user id
  changes and the old feed id goes silent (subscribe may still ack)
- "followed a user but see nothing" → either that user hasn't traded since,
  their trades fall below the server-side threshold filters, or membership
  requires alerts (bell) rather than plain follows

Diagnostics (Token Monitor → **Check** button): the vite proxy
`POST /api/fomo-api {path, jwt}` GETs `prod-api.fomo.family` with the live JWT
and reports (1) `GET /v2/users/current/followingIds` — how many users the
JWT's account follows, and (2) `GET /feed/tradingActivity?threshold=0` — the
server-side feed contents right now (this is the same REST catch-up the site
uses). If REST sees trades but the socket stays silent → wrong feed id for
this account; if REST is empty too → membership/filters/no-trades.

Client-side fan-out (2026-09-21): `FomoSocket`
(src/modules/token-monitor/fomoSocket.js) refcounts topics per
`topicType:topicId` and delivers every `data` frame to **all** registered
listeners, so several panels share one authenticated connection. The Token
Monitor's leftmost "Trending tokens" panel subscribes to `trending_tokens`
with the multi-chain topicId `1,56,143,4663,5042,8453,1399811149`.

How fomo.family itself arranges the trending board (verified 2026-09-21 by
reading their production bundle: `token-v2-*.js`, `authenticated-v2-*.js`,
`index-v2-*.js` under /assets):
- Board order is SERVER-authoritative. Snapshots carry `tokens[]`; the client
  keeps an `order` array + `tokensByKey` map keyed `address:networkId` and
  renders rows in that order. `update` frames carry a sibling `index` field:
  `>=0` splices the token to that position (their `vn`/`Ct` helpers), `-1`
  appends, and a missing `index` keeps the current position. `remove` frames
  carry only `tokenKey`. The web client never re-sorts the trending list.
- `change24` is a percent FRACTION: the site renders `Number(change24) * 100`,
  so `"1.36"` displays as +136%. (REST seed path confirms:
  `change24 = String(price_change_24h / 100)`.)
- Trending rows show the token image, then market cap as the rolling number
  while `0 < MC <= 1e10` and the token is outside their majors/stables
  blocklist — otherwise the price — plus the colored 24h change.
- Their /prices table sorters: Name / Price / 24H Change / 24H Volume /
  Market Cap (each asc+desc). Quick filter `TopTrending` =
  `liquidity > 75_000 && txnCount1 > 100`, ranked by 24h volume desc, top 20;
  `TopGainers` = change24 > 0 desc; `NewestCoins` = createdAt desc, top 20.
- If the WS topic is still empty, the client seeds a snapshot from a REST
  `mobula-token-list` query (staleTime 5s, behind the
  `mobula_direct_token_lists` gate). Store keys are namespaced
  `trending_tokens:mobula:<chainIdList>`; the wire topicId is the bare
  comma-joined chain list.

```json
{"type":"data","topicType":"trading_activity","topicId":"<feed uuid>","payload":{
  "type":"swap_sell",            // also seen: "thesis" (comments); likely swap_buy too
  "id":"b17da8a8-...","tradeId":"934e7193-...","createdAt":"2026-09-13T15:02:45.608Z",
  "userId":"2b31b1ed-...","displayName":"sol.engineer","userHandle":"sol_engineer",
  "profilePictureLink":"https://prod-fomo-profile-pics.s3.amazonaws.com/....jpg",
  "verified":false,"twitter":"https://x.com/sol_engineer",
  "usdAmount":1026.55,"marketCap":38858.56,"fdv":38858.56,"price":0.00003807,
  "ticker":"FLOPPENHEIMER","tokenImageUrl":"https://token-media.defined.fi/4663_0x....png",
  "tokenAddress":"0xd684d756...","networkId":4663,
  "equity":35460.71,"isDev":false,
  // thesis-type frames additionally carry "comment":{...} and
  // "authorTrade":{humanTokenAmount, usdValue, unrealizedPnlUsd, ...}
}}
```

Notes from the client bundle (`alertsFeedFilters-v2-oBOvvaP6.js`):
- The web app subscribes via `Zt.subscribe("trading_activity", feedId)` — feedId is
  the same UUID; the feed id is per-account (alerts feed), captured from the site.
- Filtering (threshold ≥ $1000 usdAmount, minEquity, market-cap range) is done
  **client-side** in a zustand store (`alerts-feed-threshold-storage`) — the socket
  sends everything for that feed, so filter locally in your consumer.
- Feed cadence: ~1 frame/min on this feed during testing (whale-style alerts, not
  every trade on the platform).

### Files
- `ws-test.mjs` — runnable Node (v22+) test: `node ws-test.mjs <privy-jwt>`
  - Default topic: `trading_activity` feed above; override with env
    `TOPIC_TYPE` / `TOPIC_ID` (e.g. `TOPIC_TYPE=trending_tokens TOPIC_ID=1399811149`).

## Auto-refreshing the JWT (2026-09-20)

### Why the token dies every hour
The JWT is a **Privy access token** (ES256, `iss: privy.io`, `aud: cm6h485o300n3zj9yl6vpedq7`)
hard-limited to `iat + 3600s`. Per Privy's docs (`docs.privy.io/authentication/user-authentication/tokens`):

- access token: **1 h**, auto-refreshed **only** by the Privy SDK when the app calls `getAccessToken()`;
- refresh token: **30 d**, opaque, stored in Privy-managed secure storage (httpOnly cookies in
  Privy's `auth.privy.io` iframe) and "**not directly accessible to developers**";
- there is **no public REST endpoint** to refresh a session yourself
  (`auth.privy.io/api/v1/siwa/sessions*` → 404, verified live).

So you cannot mint fresh tokens headlessly from an expired one — a logged-in
fomo.family tab must do the refreshing. fomo's bundle does exactly that
(`index-C4V-Gi_H-v2-B0yZ_u52.js`, deobfuscated):

```js
function FVe() {                                    // exported as bR, imported as re()
  let t = Iv();                                     // Privy SDK context
  return t
    ? t.getCustomerAccessToken()                    // mints a FRESH jwt on demand
    : Promise.resolve(je.get(xl) || null);          // fallback: 'privy-token' cookie
}
```

### Where fresh tokens surface inside a logged-in fomo.family tab
1. localStorage `privy:token` / `privy:<appId>:token` — copies kept by the Privy SDK (v3.34.0)
2. cookie `privy-token` / `privy-<appId>-token` — **non-httpOnly** (fomo's own service
   worker literally checks `document.cookie.includes("privy-token")`)
3. the FomoWS auth frame `{"type":"challengeResponse","jwt":…}` — sent on every
   (re)connect, always freshly minted via `getCustomerAccessToken()`
4. `Authorization: Bearer <jwt>` headers on fomo's authenticated REST calls

### Solution shipped: `scripts/fomo-token-bridge.user.js`
A Tampermonkey/Violentmonkey userscript (install once, keep a logged-in fomo.family
tab open — pinned/background is fine):

- **on fomo.family** — watches sources 1–4 above (localStorage poll, cookie poll,
  `WebSocket.send` + `fetch` hooks on `unsafeWindow`) and stores the longest-lived
  valid token in GM storage;
- **on the tools app** (`localhost:5173` / `:4173`) — pushes new tokens into
  `localStorage['token-monitor:jwt']` and dispatches a `fomo-token-refresh` event;
  `TokenMonitor.jsx` listens for it, applies the upgraded JWT (which reconnects the
  socket via the existing `[jwt, feedId]` effect) and shows an `auto ⟳` chip in the
  toolbar. Manual paste still works and is never downgraded by an older harvested token.

Limits: the fomo tab must stay logged in (Privy sessions last 30 d by default, so
re-login roughly monthly, or sooner if you log out). For fully headless operation,
the same four sources can be scraped from a Playwright persistent profile instead.

### Fully automatic, headless

Two flavors — both use the same reverse-engineered Privy refresh endpoint
(verified live server-to-server, no browser cookies required):

**Primary — built into the Token Monitor page (nothing else to run).** The
browser can't call Privy directly (CORS allows only `Origin: https://fomo.family`),
so `vite.config.js` exposes a same-origin proxy `POST /api/privy-refresh`.
One-time seed: copy the `privy-refresh-token` cookie (DevTools → Application →
Cookies → `privy.fomo.family`; it is httpOnly, so only DevTools can read it)
into the dashed settings input on the Token Monitor page and hit Apply. From
then on the page itself refreshes whenever its JWT is missing or < 10 min from
expiry, persists the rotated refresh token to
`localStorage['token-monitor:refresh-token']` (rotation-first write; a
30 s cross-tab localStorage lock prevents two tabs from racing the single-use
token), and reconnects the socket. Works after the tab has been closed for days.

**Deployed site (Vercel) notes (2026-09-22):** the `/api/*` ports behave
identically — a dummy refresh token got Privy's `401 missing_or_invalid_token`
relayed verbatim both through `ddududu-tool.vercel.app/api/privy-refresh` and
direct, and `/api/fomo-token` reports the (unset) `FOMO_SESSION_JSON` session.
What does NOT carry over is localStorage: JWT, feed id and the refresh-token
seed are per-origin, so re-paste them once on the deployed site — the toolbar
shows an `auto …` chip with the reason when the seed is missing or rejected.
The bridge userscript v1.1.0+ also matches the deployed origin. Mind the
single-consumer rule: a logged-in fomo.family tab rotates the refresh token
~hourly — run the bridge userscript with it, or close it and let the panel own
the session.

**Optional — `scripts/fomo-token-refresher.mjs` daemon** (`npm run fomo-token --
<refresh-token>`) for keeping tokens fresh while the page is closed; serves
`GET /api/fomo-token` from `scripts/.fomo-session.json`. Seed only ONE of the
two: both hold the same single session, and a refresh by one rotates the token
out from under the other.

Request/response (identical for both flavors):

```
POST https://privy.fomo.family/api/v1/sessions     (fomo's Privy auth proxy, CNAME
  → cm6h485o300n3zj9yl6vpedq7.api.privy.systems; auth.privy.io/api/v1/sessions works too)
  privy-app-id: cm6h485o300n3zj9yl6vpedq7
  privy-client: react-auth:3.34.0
  privy-ca-id:  <any persisted uuid>
  Origin: https://fomo.family
  body: {"refresh_token":"<opaque 30-day token>"}
→ 200 {"session_update_action":"set"|"ignore"|"clear", token, privy_access_token,
        refresh_token (ROTATED — also may arrive as set-cookie), identity_token, user}
```

Failure modes: `session_update_action:"clear"` or `missing_or_invalid_token` →
the session was revoked (fomo logout, Privy dashboard, or a mis-copied seed);
re-login and re-seed. Losing `.fomo-session.json` after a rotation also kills
the session (each refresh token is single-use) → re-seed. Verified live:
invalid refresh token → `401 {"error":"Invalid auth token","code":"missing_or_invalid_token"}`,
valid flow identical to the SDK's `_refreshSession()`.



