# pump.fun frontend API + realtime notes

Reverse-engineered from pump.fun's own Next.js/Turbopack bundles (same method as
`fomo-ws-protocol.md`): homepage HTML → chunk list → grep for hosts / route
registry / NATS subjects. Bundle snapshots live in `%TEMP%\pump-bundles\chunks`.

## Hosts

| Host | Role |
|---|---|
| `https://frontend-api-v3.pump.fun` | main REST (`CLIENT`) — **CORS-locked**: any foreign `Origin` gets **403**; works fine server-side / no Origin |
| `https://profile-api.pump.fun` | profiles, `/v4/pnl/{addr}/trades` |
| `https://swap-api.pump.fun` | per-coin market data (`/v1`, `/v2` prefixes via `getPumpSwapClientServerUrl`) |
| `wss://multichain-prod.nats.realtime.pump.fun` | NATS-over-WebSocket realtime (binary frames) |
| `https://solana-mainnet.pump.fun/...` + `wss://…` | dedicated Solana RPC + PubSub |

## Endpoints the Token Monitor panel uses

**`GET /following-positions/alerts`** (auth: `auth_token` cookie) — the panel's
source, pump.fun's own "following" feed, the counterpart of fomo's
`trading_activity`: everything the signed-in user's followed accounts did as
first-class rows — callouts, updates, replies, quotes, reposts, trades, likes,
posts — newest first with cursor paging.

- query: `pageSize` (server clamps to 10 — page on `nextCursor`, never on array
  length), `cursor`, `kinds` (comma-separated subset of the eight; omitted = all
  eight), `chainId`/`chainIds` (Codex ids), `minTradeAmountUsd` (trade rows
  only), `minMarketCapUsd`/`maxMarketCapUsd` (band on the coin's CURRENT cap;
  unknown-mcap coins drop while a bound is set)
- response: `{ items: AlertItem[], nextCursor: string|null }` (null = end)
- `AlertItem` = `{ kind, author{userId,userName,profileImage,isVerified,
  xUsername,walletAddress}, coinMint, chainId (Solana 1399811149, Ethereum 1,
  Base 8453, BSC 56; 0 = unresolvable), createdAt (ISO, sort key), coinName,
  coinImage, symbol, marketCap, callout{calloutId, calledOutAtMcap, multiple,
  maxMultiplier, thesis, calloutTimestamp, updates[{id,content,…}], updateCount,
  commentCount, likes}, position{amountHeld, pnlUsd, pnlPercentage, valueUsd,
  realizedPnlUsd, costBasisUsd, tokenPriceUsd}, trade{tx, isBuy, timestamp,
  amountUsd, baseAmount, priceUsd, fillMarketCapUsd}, reply, repost,
  like{callout}, post, totalCallouts }` — exactly one payload slot is set per
  kind; `position` only on callout rows

### Auth findings (verified 2026-09-20)

- Session = `auth_token` cookie: an HS256 JWT (`address`, `userId`, `roles`,
  ~30-day `exp`) minted by `POST /auth/login/token` from a Privy ID token
  (`rawJwt: true` returns the token; otherwise it's set as the cookie).
- **Browser-only enforcement**: a token captured *minutes* earlier — valid and
  working in the logged-in browser — 401'd from node under every transport
  (cookie, `Authorization: Bearer`, both, `x-auth-token`, `x-device-id`, full
  browser header replica with Cloudflare cookies) while public endpoints 200'd
  from the same box. pump.fun (or the Cloudflare bot-management in front of it)
  authenticates only real browser requests; tokens also rotate on each login.
  Conclusion: no server-side proxy can ever call the authed API.
- Client attach style (from the bundle): `credentials: "include"` cookie +
  optional `Authorization: Bearer` hook + `x-device-id` from `generateDeviceId()`.

### Solution shipped: `scripts/pump-fun-bridge.user.js`

Same pattern as `scripts/fomo-token-bridge.user.js`: a Tampermonkey userscript
runs on a logged-in pump.fun tab (browser context → auth always passes), polls
`/following-positions/alerts` every 10s same-site, and relays the newest page
two ways — GM storage → `pump-feed-refresh` window event on the tools app
(same machine), and `POST /api/pump-ingest` (works across the LAN; set
`TOOL_URL` in the script to the machine running the dev server). The panel
merges relayed items (dedupe by item key, `fresh` highlight) and its
Calls/Trades/Posts chips filter client-side. The direct `/api/pump-api` poll
stays as a dormant fallback.

v1.1.0 bridge/panel notes:
- The pump.fun tab may be pinned/background — v1.0.0 skipped polling whenever
  `document.hidden` (i.e. always, in exactly that deployment) which left the
  panel eternally empty; hidden tabs now poll too (the browser merely throttles
  the interval to ~1/min, which the feed tolerates).
- Every successful poll relays a snapshot, **including empty ones** — an empty
  page is a heartbeat proving the bridge is alive; the panel shows
  `bridge ⟳ Ns ago` and "Bridge connected — waiting for alerts…" instead of a
  misleading "no source" state.
- The pump panel's layout mirrors the fomo panel: header (min $ / Pause /
    Clear) → toolbar (status dot + heartbeat/token chips | auth_token input) →
  count/filter chips (colored by group) → rows colored by action (calls
  purple, trades green/red by side).

v1.1.1 bridge/panel notes:
- **Panel-side root cause of the still-empty panel:** `pumpRow()` never set a
  `kind` field, so the Calls/Trades/Posts filter
  (`visiblePump = pumpAlerts.filter(a => on.has(a.kind))`) matched `undefined`
  and dropped **every** row no matter what the bridge delivered (pre-existing
  bug, previously masked by the v1.1.0 bridge issues). Rows now carry `kind`.
- **Clock-skew immunity:** `POST /api/pump-ingest` stamps `at` server-side on
  receipt; the bridge's client timestamp is preserved as `clientAt`. A relay
  box with a skewed clock (e.g. Mac −5 min vs the Windows tools machine) can
  no longer make fresh pages look stale.
- **Relay failures are no longer silent:** the userscript warns to the pump.fun
  tab console, throttled to 1/min (`[pump-bridge] relay … failed`). When the
  panel is empty that console is the first thing to check — then verify
  `TOOL_URL` points at the tools machine's LAN address, the dev server runs
  with `--host`, and Tampermonkey's `@connect` allows it.

### Realtime path (future)

`POST /following-positions/alerts/presence` (auth) returns the subscription
contract: `{ subject: <exact NATS subject>, heartbeatIntervalSeconds,
presenceTtlSeconds }` — CC publishes stream events **only for viewers with live
presence**; re-register every heartbeat (best-effort: a registry outage serves
`{subject: null}` and the site degrades to HTTP polling). `DELETE
.../presence` removes it. So push updates = presence → subscribe to the
returned subject on the NATS WS (which itself is `auth_required`). Note the
presence/auth REST and the NATS WS sit behind the same browser-only auth (see
"Auth findings"), so from the tools app the socket is as unreachable as the
REST — the shipped bridge polls REST from inside the browser; an in-page
presence+NATS upgrade for the userscript is the future step.

## Other endpoints worth knowing (from the bundle's zod route registry)

Public (no auth, verified live):

- `GET /home-feed?pageSize=N` — homepage "trending activity": ranked callouts
  (`coins[]` = coin + `position` + `position.callout{multiple, thesis,
  calledOutAtMcap, calloutTimestamp}`); `GET /home-feed/new` — same, newest
  first; `GET /coins?sortBy=creationTime|score|marketCap&sortOrder=DESC&limit=N&offset=0&includeNsfw=false`

Authed (same cookie):

`GET /following-positions` (positions snapshot the
`followingFeed.{wallet}` NATS stream keeps live), `/following-feed`,
`/coin-activity/{mint}` (per-coin tweet/callout/trade merge, `minUsd` default
900), `/callout/{calloutId}`, `/callout/user/{userId}/mint/{coinMint}`,
`/callout/top/{coinMint}`, `/mayhem/top-traders`, `/users/{address}/streak`,
`/pnl-leaderboard/…`; swap-api `GET /coins/{mint}/trades?limit&cursor&program`,
`GET /v2/coins/{mint}/candles`, `/v1/coins/{mint}/line-chart|market-activity`.

## NATS realtime — auth-gated

`INFO` advertises `nats 2.12.11`, `auth_required: true`; an anonymous
`CONNECT` gets `-ERR 'Authorization Violation'` and close code 1008. Subjects
referenced by the frontend: `multichain.trade.<caip2chainid>.<checksummedMint>`
(EVM trades), `unifiedTradeEvent.lite.*`, `unifiedTradeEvent.processed`,
`unifiedCoinCreationEvent`, `mayhemTradeEvent`, `mayhemState`. Auth flows from a
pump.fun session (see above); the following-feed push additionally requires a
registered presence (see Realtime path).

## Same-origin proxy (vite.config.js)

- `POST /api/pump-api {path, token?}` → `GET https://frontend-api-v3.pump.fun<path>`
  with `Origin`/`Referer` set to pump.fun, path charset + `..` validated, token
  charset-validated and forwarded as the `auth_token` cookie, 20s timeout —
  mirrors `/api/fomo-api`. Needed because of the 403-CORS lock. (Authed paths
  still 401 server-side per the browser-only finding above; this proxy remains
  useful for public reads.)
- `GET/POST /api/pump-ingest` — relay endpoint for the bridge userscript
  (CORS-open POST, snapshot buffer `{seq, at, items}` on GET).

### Vercel deployment (api/)

Both endpoints (and the fomo ones) only exist under `npm run dev`/`preview` —
a static deployment 404s every `/api/*`. `api/*.mjs` in the repo root ports
each middleware to a Vercel serverless function (same shapes, verified against
the same smoke cases), so `ddududu-tool.vercel.app/api/*` works after a Git
push. Caveats: `pump-ingest` state is per-instance memory (a cold start can
drop one bridge POST; the next one — 10s later — catches up), and `fomo-token`
reads `FOMO_SESSION_JSON` (env var) instead of the gitignored session file.
Authed pump.fun reads still 401 from any server (browser-only auth — see
"Auth findings"), which is why the bridge userscript is the source; v1.2.0+
defaults `TOOL_URL` to the deployed origin and matches/@connects it, so a
logged-in pump.fun tab on any machine feeds the deployed panel (same-browser
GM-storage relay included). The Token Monitor's fallback poll self-stops
after three consecutive 401s instead of hammering the endpoint forever.


