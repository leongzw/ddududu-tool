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
- **CORRECTION (2026-09-21): the conclusion above was wrong.** The 401s came
  from **rotated-out tokens**, not browser fingerprinting — a live token
  returned 200 from node on the local box AND from the Vercel serverless
  function, with and without spoofed `Origin`/`Referer` (a bare
  `Cookie: auth_token=…` suffices). Server-side polling works; the token just
  has to be current (re-login rotates it, ~30-day `exp`). If a server-side
  call 401s, suspect the token first, not the transport.
- **Which cookie to copy:** `auth_token` (HS256, `address`/`userId`, ~30-day
  `exp`) — NOT `privy-id-token` (ES256, `iss: privy.io`, ~10h), which is the
  Privy login material pump.fun exchanges for the session (2026-09-21: a
  pasted privy-id-token 401'd through the proxy while the real auth_token
  200'd seconds later). The proxy and the panel now detect and reject it with
  a hint instead of a bare 401.
- Client attach style (from the bundle): `credentials: "include"` cookie +
  optional `Authorization: Bearer` hook + `x-device-id` from `generateDeviceId()`.

### Panel source: server-side poll with a pasted token (userscript removed)

The Tampermonkey bridge (`scripts/pump-fun-bridge.user.js`, v1.0.0–v1.3.0) was
**removed on 2026-09-22** — manual-token operation only. The panel polls
`/api/pump-api` server-side with the toolbar token (see the correction under
"Auth findings"), merges pages (dedupe by item key, `fresh` highlight), and its
Calls/Trades/Posts chips filter client-side. The poll self-stops after three
consecutive 401s with status `401 — paste fresh token` (rotated/expired token);
re-pasting restarts it. Historical bridge/panel notes live in git history
(commits up to `e818d44`).

### Realtime path (future)

`POST /following-positions/alerts/presence` (auth) returns the subscription
contract: `{ subject: <exact NATS subject>, heartbeatIntervalSeconds,
presenceTtlSeconds }` — CC publishes stream events **only for viewers with live
presence**; re-register every heartbeat (best-effort: a registry outage serves
`{subject: null}` and the site degrades to HTTP polling). `DELETE
.../presence` removes it. So push updates = presence → subscribe to the
returned subject on the NATS WS (which itself is `auth_required`). The
presence/auth REST and the NATS WS use the same auth_token cookie (see "Auth
findings" and its 2026-09-21 correction), so a live token should reach them
from anywhere the REST works — an in-page presence+NATS upgrade in the
`/api/pump-api` proxy style is the plausible future step.

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
  mirrors `/api/fomo-api`. Needed because of the 403-CORS lock. Works for
  authed reads while the token is live (see the 2026-09-21 correction above);
  it is the pump panel's primary data source.
- `GET/POST /api/pump-ingest` — **removed 2026-09-21** together with the
  bridge relay (history in git, commit 1bd4507); the Tampermonkey userscript
  itself followed on 2026-09-22.

### Vercel deployment (api/)

The vite middlewares only exist under `npm run dev`/`preview` — a static
deployment 404s every `/api/*`. `api/*.mjs` in the repo root ports each
middleware to a Vercel serverless function (same shapes), so
`ddududu-tool.vercel.app/api/*` works after a Git push. Verified 2026-09-21:
`/api/pump-api` serves live feed data from Vercel with a fresh token — the
datacenter IP is not blocked. `fomo-token` reads `FOMO_SESSION_JSON`
(env var) instead of the gitignored session file.


