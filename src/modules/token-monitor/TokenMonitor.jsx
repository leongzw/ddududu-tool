import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FomoSocket } from './fomoSocket';
import './TokenMonitor.css';

// ---- connection defaults (full protocol notes: fomo-ws-protocol.md) ----
const FOMO_WS_URL = 'wss://prod-api.fomo.family/ws';
const DEFAULT_JWT =
  'eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6IkI4SXlObWU1V0lZRnJIclJRVDBLdFlPRlFIUjFKVXFnaGVTMHhSZHR1QVkifQ.eyJzaWQiOiJjbXR0dnNvY3YwMjE4MGNsNGJrbHE4aHh4IiwiaXNzIjoicHJpdnkuaW8iLCJpYXQiOjE3ODkzMTUxODYsImF1ZCI6ImNtNmg0ODVvMzAwbjN6ajl5bDZ2cGVkcTciLCJzdWIiOiJkaWQ6cHJpdnk6Y21sMGtna2hqMDJrN2lmMGQwaXEwZXY0cSIsImV4cCI6MTc4OTMxODc4Nn0.BU-NwRi5U_zBM5LRouucQok6AjyfL2vU8LNyROUlVw9LWDx35VwG3ef0TIAjRzhSo4jxDIT8xVCyxm8Xv4Lydw';
const DEFAULT_FEED_ID = '25597e33-fee6-5d58-8ba4-2f3d4469ec3f'; // alerts feed id from the fomo.family session
const LS_JWT = 'token-monitor:jwt';
const LS_FEED = 'token-monitor:feedId';
const LS_REFRESH = 'token-monitor:refresh-token'; // one-time Privy refresh-token seed
const LS_CAID = 'token-monitor:caid'; // privy-ca-id (any persistent uuid)
const REFRESH_LOCK = 'token-monitor:refresh-lock'; // cross-tab mutex (tokens are single-use)
const MAX_ACTIVITIES = 300;
const MAX_TREND = 60; // trending board hard cap — updates append new entries and
// nothing evicts dropped tokens server-side, so without this the list (and its
// DOM/image load) grows forever on long-running tabs → renderer memory pressure.
const TREND_TOPIC_ID = '1,56,143,4663,5042,8453,1399811149'; // trending_tokens multi-chain board (comma-joined chain ids)

const CHAIN_NAMES = {
  '1399811149': 'Solana',
  '1': 'Ethereum',
  '56': 'BSC',
  '8453': 'Base',
  '42161': 'Arbitrum',
  '10': 'Optimism',
  '137': 'Polygon',
  '81457': 'Blast',
  '4663': 'Robinhood',
  '143': 'Monad',
  '5042': 'Arc'
};
const chainName = (id) => CHAIN_NAMES[String(id)] || `#${id}`;

// Brand colors for the little chain labels (unknown chains keep the muted
// default; hexes follow each chain's brand, nudged where too dim on dark bg).
const CHAIN_COLORS = {
  '1399811149': '#14F195', // Solana — green end of the brand gradient
  '1': '#627EEA', // Ethereum
  '56': '#F0B90B', // BSC / BNB Chain
  '8453': '#3D7BFF', // Base — lightened from #0052FF for the dark theme
  '42161': '#28A0F0', // Arbitrum
  '10': '#FF0420', // Optimism
  '137': '#8247E5', // Polygon
  '81457': '#FCFC03', // Blast
  '4663': '#00C805', // Robinhood
  '143': '#836EF9', // Monad
  '5042': '#2DD4BF' // Arc
};
const chainStyle = (id) => {
  const c = CHAIN_COLORS[String(id)];
  return c ? { color: c } : undefined;
};

const ACTIONS = {
  swap_buy: { verb: 'bought', cls: 'buy' },
  swap_sell: { verb: 'sold', cls: 'sell' },
  thesis: { verb: 'commented on', cls: 'thesis' },
};
const knownType = (t) => t === 'swap_buy' || t === 'swap_sell' || t === 'thesis';

const fmtUsd = (v) => {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  const n = Number(v);
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(abs < 10 ? 2 : 0)}`;
};

const fmtPrice = (p) => {
  if (p === null || p === undefined || Number.isNaN(Number(p))) return '—';
  const n = Number(p);
  if (n === 0) return '$0';
  if (n >= 1) return `$${n.toFixed(3)}`;
  const exp = Math.floor(Math.log10(n));
  const digits = Math.min(12, 2 - exp);
  return `$${n.toFixed(digits)}`;
};

const fmtPct = (v) => {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  const n = Number(v);
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
};

const timeAgo = (iso, now) => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

const jwtPayload = (jwt) => {
  try {
    const s = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(s + '='.repeat((4 - (s.length % 4)) % 4)));
  } catch {
    return null;
  }
};

// one trending_tokens list entry → display model (API sends strings; numbers
// or null out), or null when the entry has no token identity at all.
// Shape per fomo-ws-protocol.md "Data frame shapes".
const trendEntry = (e) => {
  const t = e?.token;
  if (!t || (!t.address && !t.symbol && !t.name)) return null;
  const num = (v) => {
    if (v === null || v === undefined || v === '') return null; // Number(null) is 0!
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    key: t.address || `${t.networkId ?? ''}:${t.symbol ?? t.name ?? ''}`,
    address: t.address || null,
    name: t.name || '',
    symbol: t.symbol || t.name || '???',
    networkId: t.networkId ?? null,
    image: t.info?.imageThumbUrl || null,
    price: num(e?.priceUSD),
    change24: num(e?.change24),
    marketCap: num(e?.marketCap),
    volume24: num(e?.volume24),
    holders: num(e?.holders),
  };
};

// ---- pump.fun following-alerts helpers (contract from their bundle's zod registry) ----
const LS_PUMP_TOKEN = 'token-monitor:pump-auth';
const PUMP_POLL_MS = 5_000; // fallback poll cadence (also re-checks bridge liveness)
const PUMP_CHAINS = { 1399811149: 'Solana', 1: 'Ethereum', 8453: 'Base', 56: 'BSC' };
const pumpChain = (id) => (id == null ? '' : PUMP_CHAINS[id] || `#${id}`);
// kind chips: calls = callout+update, trades = trade, posts = the social kinds
// (their site defaults to callout,update,trade)
const PUMP_KINDS = { calls: ['callout', 'update'], trades: ['trade'], posts: ['reply', 'quote', 'repost', 'post', 'like'] };
const PUMP_GROUP_LABELS = { calls: 'Calls', trades: 'Trades', posts: 'Posts' };
const PUMP_GROUP_OF = Object.fromEntries(
  Object.entries(PUMP_KINDS).flatMap(([g, ks]) => ks.map((k) => [k, g])),
);

const alertKey = (it) =>
  it.trade?.tx ||
  (it.callout?.calloutId ? `${it.callout.calloutId}:${it.createdAt}` : '') ||
  it.reply?.id ||
  it.post?.postId ||
  it.repost?.repostId ||
  `${it.kind}:${it.author?.userId}:${it.createdAt}`;

const pumpRow = (it, key, fresh) => {
  const a = it.author || {};
  const trade = it.trade || null;
  const callout = it.callout || null;
  const position = it.position || null;
  const kind = it.kind || '?';
  const cls =
    kind === 'trade' ? (trade?.isBuy ? 'buy' : 'sell') : kind === 'callout' || kind === 'update' ? 'thesis' : 'other';
  const verb =
    {
      callout: 'called',
      update: 'updated',
      reply: 'replied',
      quote: 'quoted',
      repost: 'reposted',
      like: 'liked',
      post: 'posted',
    }[kind] || kind;
  return {
    key,
    fresh,
    kind, // kept for chip filtering (visiblePump / pumpCounts match on it)
    cls,
    verb: kind === 'trade' ? (trade?.isBuy ? 'bought' : 'sold') : verb,
    user: a.userName || null,
    avatar: a.profileImage || null,
    verified: !!a.isVerified,
    x: a.xUsername || null,
    symbol: it.symbol || (it.coinName || '?').slice(0, 12),
    img: it.coinImage || null,
    mint: it.coinMint || null,
    chainId: it.chainId ?? null,
    mc: it.marketCap ?? null,
    at: it.createdAt || trade?.timestamp || callout?.calloutTimestamp || null,
    thesis: callout?.thesis || it.reply?.content || it.post?.content || null,
    mult: callout?.multiple ?? null,
    atMc: callout?.calledOutAtMcap ?? null,
    pnl: position?.pnlPercentage ?? null,
    val: position?.valueUsd ?? null,
    amount: trade?.amountUsd ?? null,
    price: trade?.priceUsd ?? null,
  };
};

function TokenMonitor() {
  const [jwt, setJwt] = useState(() => localStorage.getItem(LS_JWT) || DEFAULT_JWT);
  const [feedId, setFeedId] = useState(() => localStorage.getItem(LS_FEED) || DEFAULT_FEED_ID);
  const [draftJwt, setDraftJwt] = useState(jwt);
  const [draftFeed, setDraftFeed] = useState(feedId);
  const [status, setStatus] = useState({ state: 'idle', detail: '' });
  const [paused, setPaused] = useState(false);
  const [missed, setMissed] = useState(0);
  const [typeFilter, setTypeFilter] = useState({ swap_buy: true, swap_sell: true, thesis: true, other: false });
  const [minUsd, setMinUsd] = useState(0);
  const [activities, setActivities] = useState([]);
  const [, setTick] = useState(0); // re-render clock for time-ago labels
  const [tip, setTip] = useState(null); // { stat, x, y } hover card for a token's buyers

  const bufRef = useRef([]);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 15000);
    return () => clearInterval(t);
  }, []);

  const pushActivity = useCallback((p) => {
    if (!p || !p.id || p.type === 'manual') return; // 'manual' = fomo's own alert inserts
    const buf = bufRef.current;
    if (buf.some((a) => a.id === p.id)) return;
    buf.unshift(p);
    if (buf.length > MAX_ACTIVITIES) buf.length = MAX_ACTIVITIES;
    if (pausedRef.current) setMissed((n) => n + 1);
    else setActivities(buf.slice());
  }, []);

  // ---- Trending tokens (leftmost panel) ----
  // Subscribes to the server-computed trending_tokens LIST topic with a
  // comma-joined chain-id topicId (the site's combined multi-chain board —
  // see fomo-ws-protocol.md). Payloads are {kind:'snapshot', tokens:[…]}
  // (the full board, on subscribe and periodically re-sent) or
  // {kind:'update', update:{…}} (patch a single entry, same shape as the
  // snapshot entries — an optional sibling `index` field says where the token
  // sits on the board: >=0 = that position, -1 = append; without it the entry
  // keeps its current position, mirroring the site's own vn/Ct helpers).
  // Shares the authenticated connection with the trading_activity feed —
  // FomoSocket handles per-topic fan-out.
  const [trendTokens, setTrendTokens] = useState([]);
  const [trendSort, setTrendSort] = useState('board'); // board | volume | gainers | losers | mc
  const applyTrendMsg = useCallback((payload) => {
    if (!payload || typeof payload !== 'object') return;
    if (payload.kind === 'snapshot' && Array.isArray(payload.tokens)) {
      setTrendTokens(payload.tokens.map(trendEntry).filter(Boolean).slice(0, MAX_TREND));
      return;
    }
    if (payload.kind === 'update') {
      const e = trendEntry(payload.update);
      if (!e) return;
      const idx = typeof payload.index === 'number' ? payload.index : -2; // -2 = no index
      setTrendTokens((prev) => {
        const i = prev.findIndex((t) => t.key === e.key);
        const next = prev.slice();
        if (i !== -1) next.splice(i, 1);
        if (idx >= 0) next.splice(Math.min(idx, next.length), 0, e);
        else if (idx === -1 || i === -1) next.push(e); // append / brand-new entry
        else next.splice(i, 0, e); // keep position, just refresh the entry
        if (next.length > MAX_TREND) next.length = MAX_TREND; // evict the tail
        return next;
      });
    }
  }, []);

  const clearTrend = () => setTrendTokens([]);

  // (Re)connect whenever the JWT or feed id changes.
  useEffect(() => {
    const sock = new FomoSocket(FOMO_WS_URL);
    sock.setJwt(jwt);
    const offStatus = sock.onStatus(setStatus);
    const unsubs = [
      sock.subscribe('trading_activity', feedId, { id: 'tm-activity', callback: pushActivity }),
      sock.subscribe('trending_tokens', TREND_TOPIC_ID, { id: 'tm-trending', callback: applyTrendMsg }),
    ];
    sock.connect();
    return () => {
      offStatus();
      unsubs.forEach((u) => u());
      sock.disconnect();
    };
  }, [jwt, feedId, pushActivity, applyTrendMsg]);

  // ---- JWT auto-refresh: headless refresher daemon + bridge userscript ----
  // Two automatic sources feed fresh Privy JWTs into this component:
  //   1. scripts/fomo-token-refresher.mjs — refreshes with Privy directly
  //      (no browser needed) and exposes the token at /api/fomo-token via a
  //      vite plugin in vite.config.js; polled below
  //   2. scripts/fomo-token-bridge.user.js (Tampermonkey) — dispatches a
  //      'fomo-token-refresh' event from a logged-in fomo.family tab
  // Applying a new jwt re-triggers the socket effect above → auto reconnect.
  const [autoAt, setAutoAt] = useState(0);
  const jwtRef = useRef(jwt);
  jwtRef.current = jwt;
  const applyToken = useCallback((t) => {
    const tok = typeof t === 'string' ? t.trim() : '';
    if (!tok || tok === jwtRef.current) return;
    const curExp = jwtPayload(jwtRef.current)?.exp || 0;
    const newExp = jwtPayload(tok)?.exp || 0;
    if (newExp <= curExp) return; // only ever upgrade to a longer-lived token
    localStorage.setItem(LS_JWT, tok);
    jwtRef.current = tok;
    setJwt(tok);
    setDraftJwt(tok);
    setAutoAt(Date.now());
  }, []);

  useEffect(() => {
    const onRefresh = (e) => applyToken(e.detail?.token);
    window.addEventListener('fomo-token-refresh', onRefresh);
    return () => window.removeEventListener('fomo-token-refresh', onRefresh);
  }, [applyToken]);

  // Poll the refresher daemon's endpoint (silently no-ops when it isn't
  // running or the app is deployed statically without the vite plugin).
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch('/api/fomo-token', { cache: 'no-store' });
        if (!r.ok) return;
        const s = await r.json();
        if (alive && s?.token) applyToken(s.token);
      } catch {
        /* endpoint absent — userscript bridge / manual paste still work */
      }
    };
    poll();
    const t = setInterval(poll, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [applyToken]);

  // ---- in-page Privy session refresh (primary — no daemon, no fomo tab) ----
  // Seeded once via the settings input with the `privy-refresh-token` cookie
  // value (DevTools → Application → Cookies → privy.fomo.family). The page then
  // keeps its own JWT fresh: whenever the current token is missing or < 10 min
  // from expiry it calls the same-origin /api/privy-refresh vite proxy (the
  // browser can't hit Privy directly — CORS). Refresh tokens ROTATE on every
  // use, so the rotated value is persisted to localStorage before anything
  // else, and a cross-tab lock keeps two tabs from racing the single-use token.
  const [draftRefresh, setDraftRefresh] = useState('');
  const refreshRef = useRef(localStorage.getItem(LS_REFRESH) || '');

  const privyRefresh = useCallback(async () => {
    const rt = refreshRef.current;
    if (!rt) return false;
    try {
      const lock = JSON.parse(localStorage.getItem(REFRESH_LOCK) || 'null');
      if (lock && Date.now() - lock.at < 30_000) return false; // another tab is on it
    } catch {
      /* corrupt lock — take it over */
    }
    localStorage.setItem(REFRESH_LOCK, JSON.stringify({ at: Date.now() }));
    try {
      let caId = localStorage.getItem(LS_CAID);
      if (!caId) {
        caId = crypto.randomUUID();
        localStorage.setItem(LS_CAID, caId);
      }
      const r = await fetch('/api/privy-refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt, caId }),
      });
      const s = await r.json().catch(() => ({}));
      if (s.session_update_action === 'clear') {
        localStorage.removeItem(LS_REFRESH); // session revoked — needs a new seed
        refreshRef.current = '';
        return false;
      }
      if (s.refreshToken) {
        refreshRef.current = s.refreshToken;
        localStorage.setItem(LS_REFRESH, s.refreshToken); // rotate first, always
      }
      if (s.token) applyToken(s.token);
      return Boolean(s.token);
    } catch {
      return false; // dev server away / network blip — retried on the next tick
    } finally {
      localStorage.removeItem(REFRESH_LOCK);
    }
  }, [applyToken]);

  useEffect(() => {
    if (!refreshRef.current) return undefined;
    const maybe = () => {
      const p = jwtPayload(jwtRef.current);
      const left = p?.exp ? p.exp - Date.now() / 1000 : 0;
      if (!p?.exp || left < 600) privyRefresh();
    };
    maybe(); // page just opened (possibly after days closed) — refresh at once
    const t = setInterval(maybe, 60_000);
    return () => clearInterval(t);
  }, [privyRefresh]);

  // ---- one-click feed diagnostics (via the /api/fomo-api vite proxy) ----
  // The trading_activity topic id is YOUR fomo user id (fomoUser.id in the
  // site bundle) and its content is computed server-side for that account —
  // following a new user on fomo does NOT change the feed id. This check asks
  // fomo's REST API two read-only questions with the live JWT: which users
  // does this account follow, and what does the server-side feed actually
  // contain right now — distinguishing "JWT/feed-id problem" from "the new
  // follow simply hasn't traded (or isn't a feed member yet)".
  const [check, setCheck] = useState(null); // { busy, text }
  const checkFeed = async () => {
    if (!jwtRef.current) return;
    setCheck({ busy: true, text: 'checking…' });
    const api = async (path) => {
      const r = await fetch('/api/fomo-api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, jwt: jwtRef.current }),
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const toMs = (v) => (typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v));
    try {
      const fol = await api('/v2/users/current/followingIds');
      if (fol.status === 401 || fol.status === 430) {
        setCheck({ busy: false, text: `✗ JWT rejected (${fol.status}) — token stale or session revoked` });
        return;
      }
      const ids = fol.body?.followingIds ?? [];
      const feed = await api('/feed/tradingActivity?threshold=0');
      const items = Array.isArray(feed.body) ? feed.body : (feed.body?.items ?? []);
      if (!items.length) {
        setCheck({
          busy: false,
          text: `✓ auth ok · following ${ids.length} · feed EMPTY server-side — followed users may need alerts enabled on fomo, or nobody has traded yet`,
        });
        return;
      }
      const newest = items.reduce((a, b) => (toMs(b?.createdAt) > toMs(a?.createdAt) ? b : a), items[0]);
      const age = timeAgo(new Date(toMs(newest.createdAt)).toISOString(), Date.now());
      const who = [...new Set(items.slice(0, 10).map((i) => i.displayName || i.userHandle).filter(Boolean))]
        .slice(0, 3)
        .join(', ');
      setCheck({
        busy: false,
        text: `✓ auth ok · following ${ids.length} · feed has ${items.length} recent trades (newest ${age} ago${who ? ` · e.g. ${who}` : ''}) — REST sees them; if the live socket stays silent, the feed id likely belongs to another account`,
      });
    } catch (e) {
      setCheck({ busy: false, text: `✗ check failed: ${e.message}` });
    }
  };

  const now = Date.now();
  const token = useMemo(() => jwtPayload(jwt), [jwt]);
  const expLeft = token?.exp ? token.exp - now / 1000 : null;
  const expLabel =
    expLeft === null
      ? ''
      : expLeft <= 0
        ? 'JWT expired'
        : `JWT expires in ${Math.floor(expLeft / 60)}m ${Math.floor(expLeft % 60)}s`;

  const visibleActivities = useMemo(
    () =>
      activities.filter((a) => {
        const on = knownType(a.type) ? typeFilter[a.type] : typeFilter.other;
        if (!on) return false;
        const amt = a.usdAmount ?? a.authorTrade?.usdValue ?? 0;
        return amt >= minUsd;
      }),
    [activities, typeFilter, minUsd],
  );

  const typeCounts = useMemo(() => {
    const c = { swap_buy: 0, swap_sell: 0, thesis: 0, other: 0 };
    for (const a of activities) c[knownType(a.type) ? a.type : 'other'] += 1;
    return c;
  }, [activities]);

  // pump.fun followed-account alerts — declared here, above its panel section,
  // because the tokenStats aggregation right below merges its buys into the
  // Tokens board (and its dependency array needs the binding in scope).
  const [pumpAlerts, setPumpAlerts] = useState([]);

  // Aggregate the raw (unfiltered) streams into per-token stats: distinct
  // tracked buyers, total buy/sell USD, latest market cap/price and recency.
  // Buys arrive from BOTH sources — this feed's swap_buy events and pump.fun
  // followed-account trade buys — merging into one board (same mint = same
  // row). Sells never create a row or add a buyer — they only sum into the
  // token's/seller's sell totals and refresh recency. Rows are ordered by
  // latest activity (buy or sell, either source), then distinct buyers.
  // Powers the left "Tokens" panel.
  const tokenStats = useMemo(() => {
    const map = new Map();
    for (const a of activities) {
      if (a.type !== 'swap_buy') continue; // sells are not recorded
      const key = a.tokenAddress || `${a.networkId ?? ''}:${a.ticker ?? a.id}`;
      if (!key) continue;
      let s = map.get(key);
      if (!s) {
        s = {
          key,
          ticker: a.ticker || '???',
          tokenAddress: a.tokenAddress || null,
          image: a.tokenImageUrl || null,
          networkId: a.networkId,
          marketCap: null,
          price: null,
          lastAt: '',
          buyUsd: 0,
          sellUsd: 0, // Σ sell USD by tracked users — red chip on the row
          pf: 0, // pump.fun followed buys feeding this row
          buyers: new Map(), // userKey -> buyer info
        };
        map.set(key, s);
      }
      if (!s.lastAt || a.createdAt > s.lastAt) s.lastAt = a.createdAt;
      if (a.marketCap != null) s.marketCap = a.marketCap;
      if (a.price != null) s.price = a.price;
      const usd = a.swapTransaction?.usdAmount ?? a.usdAmount ?? a.authorTrade?.usdValue ?? 0;
      s.buyUsd += usd;
      const userKey = a.userHandle || a.displayName || a.userId || a.id;
      const b =
        s.buyers.get(userKey) ||
        {
          id: userKey,
          name: a.displayName || a.userHandle || 'anon',
          img: a.profilePictureLink || null,
          verified: a.verified,
          isDev: a.isDev,
          twitter: a.twitter || null,
          usd: 0,
          n: 0,
          fomo: 0, // buys seen on this fomo feed → "F n" chip in the hover card
          mcSum: 0, // Σ marketCap over buys → avg entry MC
          mcN: 0,
          sells: 0,
          sellUsd: 0, // Σ sell USD — shown next to the sell count
          at: '',
        };
      b.usd += usd;
      b.n += 1;
      b.fomo += 1;
      if (a.marketCap != null) {
        b.mcSum += a.marketCap;
        b.mcN += 1;
      }
      if (!b.at || a.createdAt > b.at) {
        b.at = a.createdAt;
        if (a.profilePictureLink) b.img = a.profilePictureLink;
      }
      s.buyers.set(userKey, b);
    }
    // Second pass: a sell never creates a token row or adds a new name to
    // the buyers list — it sums into the token's/seller's sell totals and
    // refreshes the row's recency (rows sort by latest buy OR sell).
    for (const a of activities) {
      if (a.type !== 'swap_sell') continue;
      const s = map.get(a.tokenAddress || `${a.networkId ?? ''}:${a.ticker ?? a.id}`);
      if (!s) continue;
      if (!s.lastAt || a.createdAt > s.lastAt) s.lastAt = a.createdAt;
      const usd = a.swapTransaction?.usdAmount ?? a.usdAmount ?? a.authorTrade?.usdValue ?? 0;
      s.sellUsd += usd;
      const b = s.buyers.get(a.userHandle || a.displayName || a.userId || a.id);
      if (b) {
        b.sells += 1;
        b.sellUsd += usd;
      }
    }
    // Third pass: pump.fun followed-account trades ride the same board — a
    // buy creates/refreshes a row exactly like a fomo swap_buy (addresses
    // are chain-native, so a token traded on both sources merges into one
    // row), a sell only bumps the selling buyer's count.
    for (const p of pumpAlerts) {
      if (p.kind !== 'trade') continue; // calls/posts never create rows
      const key = p.mint || `${p.chainId ?? ''}:${p.symbol ?? p.key}`;
      if (!key) continue;
      let s = map.get(key);
      if (p.cls !== 'buy') {
        if (s) {
          const at = p.at || '';
          if (at && (!s.lastAt || at > s.lastAt)) s.lastAt = at;
          const usd = p.amount ?? 0;
          s.sellUsd += usd;
          const seller = s.buyers.get(p.user || p.key);
          if (seller) {
            seller.sells += 1;
            seller.sellUsd += usd;
          }
        }
        continue;
      }
      if (!s) {
        s = {
          key,
          ticker: p.symbol || '???',
          tokenAddress: p.mint || null,
          image: p.img || null,
          networkId: p.chainId,
          marketCap: null,
          price: null,
          lastAt: '',
          buyUsd: 0,
          sellUsd: 0,
          pf: 0,
          buyers: new Map(),
        };
        map.set(key, s);
      }
      const at = p.at || '';
      if (at && (!s.lastAt || at > s.lastAt)) s.lastAt = at;
      if (p.mc != null) s.marketCap = p.mc;
      if (p.price != null) s.price = p.price;
      const usd = p.amount ?? 0;
      s.buyUsd += usd;
      s.pf += 1;
      const userKey = p.user || p.key;
      const b =
        s.buyers.get(userKey) ||
        {
          id: userKey,
          name: p.user || 'anon',
          img: p.avatar || null,
          verified: p.verified,
          isDev: false,
          twitter: p.x ? `https://x.com/${p.x}` : null,
          usd: 0,
          n: 0,
          fomo: 0, // stays 0 unless the same user also buys via the fomo feed
          mcSum: 0, // Σ marketCap over buys → avg entry MC
          mcN: 0,
          sells: 0,
          sellUsd: 0, // Σ sell USD — shown next to the sell count
          at: '',
        };
      b.usd += usd;
      b.n += 1;
      if (p.mc != null) {
        b.mcSum += p.mc;
        b.mcN += 1;
      }
      if (at && (!b.at || at > b.at)) {
        b.at = at;
        if (p.avatar) b.img = p.avatar;
      }
      b.pf = (b.pf || 0) + 1; // "PF" marker in the hover card
      s.buyers.set(userKey, b);
    }
    // Per-source distinct buyer counts for the row chips ("Fomo n" / "PF n") —
    // a buyer seen on both feeds counts toward both, so the chips can sum to
    // more than the total-buyers badge.
    for (const s of map.values()) {
      let fomoN = 0;
      let pfN = 0;
      for (const b of s.buyers.values()) {
        if (b.fomo > 0) fomoN += 1;
        if (b.pf > 0) pfN += 1;
      }
      s.fomoN = fomoN;
      s.pfN = pfN;
    }
    return [...map.values()].sort(
      (x, y) => Date.parse(y.lastAt) - Date.parse(x.lastAt) || y.buyers.size - x.buyers.size,
    );
  }, [activities, pumpAlerts]);

  // Sorted view of the trending board. The site renders the server's own board
  // order (snapshot order + per-update `index`), so 'board' (default) keeps it;
  // the other chips mirror fomo's /prices sorters. change24 is a percent
  // fraction — the site renders Number(change24) * 100, so "1.36" → +136%.
  const trendStats = useMemo(() => {
    const sorters = {
      board: () => 0,
      volume: (x, y) => (y.volume24 ?? -1) - (x.volume24 ?? -1),
      gainers: (x, y) => (y.change24 ?? -Infinity) - (x.change24 ?? -Infinity),
      losers: (x, y) => (x.change24 ?? Infinity) - (y.change24 ?? Infinity),
      mc: (x, y) => (y.marketCap ?? -1) - (x.marketCap ?? -1),
    };
    return trendTokens.slice().sort(sorters[trendSort] || sorters.board);
  }, [trendTokens, trendSort]);

  const applySettings = () => {
    const j = draftJwt.trim();
    const f = draftFeed.trim();
    if (j && f) {
      localStorage.setItem(LS_JWT, j);
      localStorage.setItem(LS_FEED, f);
      setJwt(j);
      setFeedId(f);
    }
    // one-time seed: pasting the privy-refresh-token cookie enables the page's
    // own auto-refresh (see privyRefresh above)
    const rt = draftRefresh.trim();
    if (rt) {
      refreshRef.current = rt;
      localStorage.setItem(LS_REFRESH, rt);
      setDraftRefresh('');
      privyRefresh(); // mint a fresh JWT immediately
    }
  };

  const resetDefaults = () => {
    localStorage.removeItem(LS_JWT);
    localStorage.removeItem(LS_FEED);
    setDraftJwt(DEFAULT_JWT);
    setDraftFeed(DEFAULT_FEED_ID);
    setJwt(DEFAULT_JWT);
    setFeedId(DEFAULT_FEED_ID);
  };

  // ---- pump.fun following panel (bridge userscript + REST poll fallback) ----
  // Mirrors fomo's trading_activity: everything the signed-in user's followed
  // pump.fun accounts do — callouts, updates, trades (optionally posts) — from
  // GET /following-positions/alerts. pump.fun enforces browser-only auth (even
  // a minutes-old auth_token 401s from node, under every transport), so the
  // primary source is scripts/pump-fun-bridge.user.js polling inside a
  // logged-in pump.fun tab, relaying items as 'pump-feed-refresh' events
  // (same machine, GM storage) and via POST /api/pump-ingest (LAN). The direct
  // /api/pump-api poll below is only a fallback and pauses while the bridge
  // is delivering. (pumpAlerts itself is declared above tokenStats.)
  const [pumpStatus, setPumpStatus] = useState({ state: 'idle', detail: '' }); // idle | ok | auth | error
  const [pumpToken, setPumpToken] = useState(() => localStorage.getItem(LS_PUMP_TOKEN) || '');
  const [pumpMinUsd, setPumpMinUsd] = useState(10); // minTradeAmountUsd — trade rows only
  const [pumpGroups, setPumpGroups] = useState({ calls: true, trades: true, posts: false });
  const [pumpPaused, setPumpPaused] = useState(false);
  const [pumpMissed, setPumpMissed] = useState(0);
  const [pumpBridgeAt, setPumpBridgeAt] = useState(0); // last relay seen — drives the toolbar heartbeat chip
  const pumpPausedRef = useRef(false);
  pumpPausedRef.current = pumpPaused;
  const pumpSeenRef = useRef(null); // item keys from the previous fallback poll
  const pumpBridgeAtRef = useRef(0); // last bridge delivery — suppresses the fallback poll
  const mergePumpRef = useRef(null);
  mergePumpRef.current = (items, tag) => {
    const at = Date.now();
    pumpBridgeAtRef.current = at;
    setPumpBridgeAt(at);
    if (pumpPausedRef.current) {
      setPumpMissed((n) => n + items.length);
      return;
    }
    setPumpAlerts((prev) => {
      const have = new Set(prev.map((p) => p.key));
      const add = items
        .filter(Boolean)
        .map((it) => pumpRow(it, alertKey(it), true))
        .filter((x) => !have.has(x.key));
      if (!add.length) return prev;
      return [...add, ...prev].slice(0, 150);
    });
    setPumpStatus({ state: 'ok', detail: tag });
  };

  // bridge path 1: same-machine GM-storage relay → window event
  useEffect(() => {
    const onFeed = (e) => {
      if (Array.isArray(e.detail?.items)) mergePumpRef.current(e.detail.items, 'bridge');
    };
    window.addEventListener('pump-feed-refresh', onFeed);
    return () => window.removeEventListener('pump-feed-refresh', onFeed);
  }, []);

  // bridge path 2: POST /api/pump-ingest relay (works across machines on the LAN)
  useEffect(() => {
    let alive = true;
    let lastSeq = -1;
    const id = setInterval(async () => {
      try {
        const r = await fetch('/api/pump-ingest');
        if (!r.ok) return;
        const d = await r.json();
        if (!alive) return;
        if (Array.isArray(d.items) && d.items.length > 0 && d.seq !== lastSeq) {
          lastSeq = d.seq;
          mergePumpRef.current(d.items, 'bridge');
        } else if (d.at && Date.now() - d.at < 45_000) {
          pumpBridgeAtRef.current = d.at; // heartbeat: someone is bridging (quiet feed)
          setPumpBridgeAt(d.at);
        }
      } catch {
        /* endpoint absent — event bridge / fallback poll still work */
      }
    }, 3_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // fallback: direct poll through the vite proxy — only ever works if pump.fun
  // accepts non-browser clients; sleeps 30s after any bridge delivery
  useEffect(() => {
    const kinds = Object.keys(pumpGroups).flatMap((g) => (pumpGroups[g] ? PUMP_KINDS[g] : []));
    if (!pumpToken || kinds.length === 0) {
      if (Date.now() - pumpBridgeAtRef.current > 60_000) {
        setPumpStatus({ state: 'idle', detail: pumpToken ? 'pick a kind' : 'no bridge' });
      }
      return undefined;
    }
    let alive = true;
    let timer = null;
    const path =
      `/following-positions/alerts?pageSize=10&kinds=${encodeURIComponent(kinds.join(','))}` +
      `&minTradeAmountUsd=${Math.max(0, pumpMinUsd || 0)}`;
    const poll = async () => {
      if (Date.now() - pumpBridgeAtRef.current < 30_000) {
        timer = setTimeout(poll, PUMP_POLL_MS); // bridge is live — stay quiet
        return;
      }
      try {
        const r = await fetch('/api/pump-api', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path, token: pumpToken }),
        });
        const d = await r.json().catch(() => ({}));
        if (!alive) return;
        if (r.status === 401) {
          setPumpStatus({ state: 'auth', detail: '401' });
        } else if (!r.ok || !Array.isArray(d.items)) {
          setPumpStatus({ state: 'error', detail: `${r.status}` });
        } else {
          const items = d.items.filter(Boolean);
          const seen = pumpSeenRef.current;
          pumpSeenRef.current = new Set(items.map(alertKey));
          if (!seen) {
            setPumpAlerts(items.map((it) => pumpRow(it, alertKey(it), false)));
          } else {
            const add = items
              .filter((it) => !seen.has(alertKey(it)))
              .map((it) => pumpRow(it, alertKey(it), true));
            if (add.length) {
              setPumpAlerts((prev) => {
                const have = new Set(prev.map((p) => p.key));
                return [...add.filter((f) => !have.has(f.key)), ...prev].slice(0, 150);
              });
            }
          }
          setPumpStatus({ state: 'ok', detail: 'poll' });
        }
      } catch {
        if (alive) setPumpStatus({ state: 'error', detail: 'network' });
      } finally {
        if (alive) timer = setTimeout(poll, PUMP_POLL_MS);
      }
    };
    poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [pumpToken, pumpGroups, pumpMinUsd]);

  // chips filter client-side (the bridge relays whatever kinds the userscript polls)
  const visiblePump = useMemo(() => {
    const on = new Set(Object.keys(pumpGroups).flatMap((g) => (pumpGroups[g] ? PUMP_KINDS[g] : [])));
    return pumpAlerts.filter((a) => on.has(a.kind));
  }, [pumpAlerts, pumpGroups]);

  const pumpCounts = useMemo(() => {
    const c = { calls: 0, trades: 0, posts: 0 };
    for (const a of pumpAlerts) {
      const g = PUMP_GROUP_OF[a.kind];
      if (g) c[g] += 1;
    }
    return c;
  }, [pumpAlerts]);

  const togglePause = () => {
    if (paused) {
      setPaused(false);
      setActivities(bufRef.current.slice());
      setMissed(0);
    } else setPaused(true);
  };

  const clearActivities = () => {
    bufRef.current = [];
    setActivities([]);
    setMissed(0);
  };

  const statusCls = status.state;
  const chip = (key, label) => (
    <button
      key={key}
      type="button"
      className={`tm-chip ${typeFilter[key] ? 'on' : ''} ${key}`}
      onClick={() => setTypeFilter((f) => ({ ...f, [key]: !f[key] }))}
      title="toggle filter"
    >
      {label}
      {typeCounts[key] > 0 && <span className="tm-chip-count">{typeCounts[key]}</span>}
    </button>
  );

  const togglePumpPause = () => {
    if (pumpPaused) {
      setPumpPaused(false);
      setPumpMissed(0);
    } else setPumpPaused(true);
  };

  const clearPump = () => {
    setPumpAlerts([]);
    setPumpMissed(0);
    pumpSeenRef.current = null;
  };

  const pumpDot =
    pumpStatus.state === 'ok'
      ? 'connected'
      : pumpStatus.state === 'error' || pumpStatus.state === 'auth'
        ? 'error'
        : '';
  const pumpChip = (key, label) => (
    <button
      key={key}
      type="button"
      className={`tm-chip ${pumpGroups[key] ? 'on' : ''} ${key}`}
      onClick={() => setPumpGroups((p) => ({ ...p, [key]: !p[key] }))}
      title="toggle filter"
    >
      {label}
      {pumpCounts[key] > 0 && <span className="tm-chip-count">{pumpCounts[key]}</span>}
    </button>
  );

  return (
    <div className="tm">
      {/* ---- panels ---- */}
      <div className="tm-panels">
        {/* Panel 0: trending tokens — the server-computed trending_tokens list
            topic (multi-chain board): snapshot frames replace the board, update
            frames patch one entry; rows re-ranked client-side by the chips */}
        <section className="tm-panel tm-trend">
          <header className="tm-panel-head">
            <div>
              <h2>Trending tokens</h2>
              <span className="tm-sub">trending_tokens · multi-chain</span>
            </div>
            <div className="tm-head-actions">
              <span className="tm-count" title="tokens on the board">
                {trendStats.length}
              </span>
              <button type="button" className="tm-btn" onClick={clearTrend}>
                Clear
              </button>
            </div>
          </header>
          <div className="tm-filters">
            {[
              ['board', 'Board'],
              ['volume', 'Volume'],
              ['gainers', 'Gainers'],
              ['losers', 'Losers'],
              ['mc', 'Mkt cap'],
            ].map(([k, label]) => (
              <button
                key={k}
                type="button"
                className={`tm-chip ${trendSort === k ? 'on' : ''}`}
                onClick={() => setTrendSort(k)}
                title="rank by"
              >
                {label}
              </button>
            ))}
            <span className="tm-count">{trendStats.length} tokens</span>
          </div>
          <div className="tm-panel-body">
            {trendStats.length === 0 ? (
              <div className="tm-empty">
                {status.state === 'connected'
                  ? 'Connected — waiting for board snapshot…'
                  : 'Waiting for connection…'}
              </div>
            ) : (
              trendStats.map((t, i) => {
                const rank = i + 1;
                return (
                  <div key={t.key} className={`tm-trd ${rank <= 3 ? `r${rank}` : ''}`}>
                    <span className="tm-trd-rank">{rank}</span>
                    <Thumb src={t.image} alt={t.symbol} className="tm-trd-img" />
                    <div className="tm-trd-main">
                      <div className="tm-tok-line">
                        <span
                          className="tm-tok-ticker"
                          title={
                            t.address
                              ? `${t.address} · ${chainName(t.networkId)}${t.name ? ` · ${t.name}` : ''} — click to copy`
                              : t.name || undefined
                          }
                          onClick={() => t.address && navigator.clipboard?.writeText(t.address)}
                        >
                          ${t.symbol}
                        </span>
                        <span className="tm-tok-chain" style={chainStyle(t.networkId)}>
                          {chainName(t.networkId)}
                        </span>
                        {t.marketCap != null && <span className="tm-tok-chip">MC {fmtUsd(t.marketCap)}</span>}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* Panel 1: tokens seen in the feed, ranked by distinct tracked buyers */}
        <section className="tm-panel tm-tokens">
          <header className="tm-panel-head">
            <div>
              <h2>Tokens</h2>
              <span className="tm-sub">fomo + pump.fun · latest buy/sell first</span>
            </div>
            <span className="tm-count" title="distinct tokens seen">
              {tokenStats.length}
            </span>
          </header>
          <div className="tm-panel-body tm-token-list" onScroll={() => setTip(null)}>
            {tokenStats.length === 0 ? (
              <div className="tm-empty">waiting for buys…</div>
            ) : (
              tokenStats.map((s) => (
                <div
                  key={s.key}
                  className={`tm-tok ${s.buyers.size > 1 ? 'hot' : ''}`}
                  onMouseEnter={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setTip({ stat: s, x: r.right + 10, y: r.top });
                  }}
                  onMouseLeave={() => setTip(null)}
                >
                  <Thumb src={s.image} alt={s.ticker} className="tm-tok-img" />
                  <div className="tm-tok-main">
                    <div className="tm-tok-line">
                      <span
                        className="tm-tok-ticker"
                        title={
                          s.tokenAddress ? `${s.tokenAddress} · ${chainName(s.networkId)} — click to copy` : undefined
                        }
                        onClick={() => s.tokenAddress && navigator.clipboard?.writeText(s.tokenAddress)}
                      >
                        ${s.ticker}
                      </span>
                      <span className="tm-tok-chain" style={chainStyle(s.networkId)}>
                        {chainName(s.networkId)}
                      </span>
                    </div>
                    <div className="tm-tok-meta">
                      {s.marketCap != null && <span className="tm-tok-chip">MC {fmtUsd(s.marketCap)}</span>}
                      {s.buyUsd > 0 && <span className="tm-tok-chip buy">buys {fmtUsd(s.buyUsd)}</span>}
                      {s.sellUsd > 0 && (
                        <span className="tm-tok-chip sell" title="total sold by tracked users (fomo + pump.fun)">
                          sells {fmtUsd(s.sellUsd)}
                        </span>
                      )}
                      {s.fomoN > 0 && (
                        <span className="tm-tok-chip fomo" title="distinct buyers seen on the fomo feed">
                          Fomo {s.fomoN}
                        </span>
                      )}
                      {s.pfN > 0 && (
                        <span className="tm-tok-chip pf" title="distinct pump.fun buyers merged into this row">
                          PF {s.pfN}
                        </span>
                      )}
                      <span className="tm-tok-time">{timeAgo(s.lastAt, now)}</span>
                    </div>
                  </div>
                  <span
                    className="tm-tok-badge buy"
                    title={`${s.buyers.size} tracked user(s) bought — hover for who`}
                  >
                    {s.buyers.size}
                  </span>
                </div>
              ))
            )}
          </div>
        </section>

        {/* Panel 2: fomo trending feed (thesis / swap_buy / swap_sell only) */}
        <section className="tm-panel tm-activity">
          <header className="tm-panel-head">
            <div>
              <h2>Fomo Trending</h2>
              <span className="tm-sub">trading_activity · feed {feedId.slice(0, 8)}…</span>
            </div>
            <div className="tm-head-actions">
              <label className="tm-min">
                min $
                <input
                  type="number"
                  min="0"
                  step="100"
                  value={minUsd}
                  onChange={(e) => setMinUsd(Math.max(0, Number(e.target.value) || 0))}
                />
              </label>
              <button type="button" className={`tm-btn ${paused ? 'warn' : ''}`} onClick={togglePause}>
                {paused ? `Resume${missed ? ` (+${missed})` : ''}` : 'Pause'}
              </button>
              <button type="button" className="tm-btn" onClick={clearActivities}>
                Clear
              </button>
            </div>
          </header>
          {/* fomo connection + session settings — status, JWT, feed id, refresh
              token and Check all belong to the fomo feed, so they live here */}
          <div className="tm-toolbar">
            <div className="tm-status">
              <span className={`tm-dot ${statusCls}`} />
              <span className="tm-state">{status.state}</span>
              {status.detail && <span className="tm-detail">{status.detail}</span>}
              {expLabel && <span className={`tm-exp ${expLeft <= 0 ? 'bad' : ''}`}>{expLabel}</span>}
              {jwt && (
                <span
                  className="tm-exp"
                  title="live JWT fingerprint — changes whenever the token is refreshed; the input field below also holds the current token"
                >
                  jwt …{jwt.slice(-6)}
                </span>
              )}
              {autoAt > 0 && (
                <span
                  className="tm-exp"
                  title="JWT auto-refreshed in-page via the Privy session proxy (and/or the optional refresher daemon + bridge userscript)"
                >
                  auto ⟳ {timeAgo(new Date(autoAt).toISOString(), now)} ago
                </span>
              )}
            </div>
            <div className="tm-settings">
              <input
                className="tm-input tm-input-jwt"
                type="text"
                spellCheck={false}
                placeholder="Privy JWT (from fomo.family session)"
                value={draftJwt}
                onChange={(e) => setDraftJwt(e.target.value)}
              />
              <input
                className="tm-input tm-input-feed"
                type="text"
                spellCheck={false}
                placeholder="trading_activity feed id"
                value={draftFeed}
                onChange={(e) => setDraftFeed(e.target.value)}
              />
              <input
                className="tm-input tm-input-refresh"
                type="text"
                spellCheck={false}
                title="One-time setup: DevTools → Application → Cookies → privy.fomo.family → privy-refresh-token. Paste it here and Apply — the page then refreshes its JWT automatically."
                placeholder="privy-refresh-token (one-time, enables auto-refresh)"
                value={draftRefresh}
                onChange={(e) => setDraftRefresh(e.target.value)}
              />
              <button type="button" className="tm-btn" onClick={applySettings}>
                Apply
              </button>
              <button
                type="button"
                className="tm-btn"
                onClick={checkFeed}
                disabled={check?.busy}
                title="Ask fomo's REST API (with the live JWT) what this account follows and what the server-side feed contains"
              >
                {check?.busy ? 'Checking…' : 'Check'}
              </button>
              <button type="button" className="tm-btn" onClick={resetDefaults} title="restore defaults">
                Reset
              </button>
            </div>
            {check?.text && (
              <div className="tm-check" title={check.text}>
                {check.text}
              </div>
            )}
          </div>
          <div className="tm-filters">
            {chip('swap_buy', 'Buys')}
            {chip('swap_sell', 'Sells')}
            {chip('thesis', 'Thesis')}
            {chip('other', 'Other')}
            <span className="tm-count">{visibleActivities.length} shown</span>
          </div>
          <div className="tm-panel-body">
            {visibleActivities.length === 0 && (
              <div className="tm-empty">
                {status.state === 'connected'
                  ? 'Connected — waiting for activity… (event-driven feed)'
                  : 'Waiting for connection…'}
              </div>
            )}
            {visibleActivities.map((a) => {
              const act = ACTIONS[a.type] || { verb: String(a.type || '?'), cls: 'other' };
              const amt = a.usdAmount ?? a.authorTrade?.usdValue ?? null;
              const pnl = a.authorTrade?.percentageUnrealizedPnl ?? null;
              return (
                <article key={a.id} className={`tm-act ${act.cls}`}>
                  <Thumb
                    src={a.profilePictureLink}
                    alt={a.displayName || a.userHandle || '?'}
                    className="tm-act-avatar"
                  />
                  <div className="tm-act-main">
                    <div className="tm-act-user">
                      <span className="tm-act-name">{a.displayName || a.userHandle || 'anon'}</span>
                      {a.verified && (
                        <span className="tm-act-verified" title="verified">
                          ✔
                        </span>
                      )}
                      {a.isDev && <span className="tm-act-dev">DEV</span>}
                      {a.twitter && (
                        <a className="tm-act-twitter" href={a.twitter} target="_blank" rel="noreferrer" title={a.twitter}>
                          𝕏
                        </a>
                      )}
                    </div>
                    <div className="tm-act-line">
                      <span className={`tm-act-verb ${act.cls}`}>{act.verb}</span>
                      <Thumb src={a.tokenImageUrl} alt={a.ticker || '?'} className="tm-act-tokenimg" />
                      <span
                        className="tm-act-ticker"
                        title={`${a.tokenAddress || ''} · ${chainName(a.networkId)} — click to copy address`}
                        onClick={() => a.tokenAddress && navigator.clipboard?.writeText(a.tokenAddress)}
                      >
                        ${a.ticker || '???'}
                      </span>
                      <span className="tm-act-chain" style={chainStyle(a.networkId)}>
                        {chainName(a.networkId)}
                      </span>
                    </div>
                    {a.type === 'thesis' && a.comment?.comment && (
                      <div className="tm-act-comment">{a.comment.comment}</div>
                    )}
                    <div className="tm-act-meta">
                      {amt !== null && <span className={`tm-act-amt ${act.cls}`}>{fmtUsd(amt)}</span>}
                      {a.marketCap != null && <span className="tm-act-chip">MC {fmtUsd(a.marketCap)}</span>}
                      {a.price != null && <span className="tm-act-chip">{fmtPrice(a.price)}</span>}
                      {a.equity != null && (
                        <span className="tm-act-chip" title="trader equity">
                          EQ {fmtUsd(a.equity)}
                        </span>
                      )}
                      {pnl !== null && (
                        <span className={`tm-act-chip ${pnl >= 0 ? 'up' : 'down'}`}>PNL {fmtPct(pnl)}</span>
                      )}
                    </div>
                  </div>
                  <div className="tm-act-time">{timeAgo(a.createdAt, now)}</div>
                </article>
              );
            })}
          </div>
        </section>

        {/* Panel 3: pump.fun following alerts — what YOUR followed accounts
            call & trade, bridged from a logged-in pump.fun tab by
            scripts/pump-fun-bridge.user.js (direct poll fallback via
            /api/pump-api, auth_token in the toolbar — browser-only auth
            usually 401s it) */}
        <section className="tm-panel tm-pump">
          <header className="tm-panel-head">
            <div>
              <h2>pump.fun Following</h2>
              <span className="tm-sub">following-positions/alerts · bridge feed</span>
            </div>
            <div className="tm-head-actions">
              <label
                className="tm-min"
                title="minTradeAmountUsd — drops trade rows below this size (fallback poll only)"
              >
                min $
                <input
                  type="number"
                  min="0"
                  step="10"
                  value={pumpMinUsd}
                  onChange={(e) => setPumpMinUsd(Math.max(0, Number(e.target.value) || 0))}
                />
              </label>
              <button type="button" className={`tm-btn ${pumpPaused ? 'warn' : ''}`} onClick={togglePumpPause}>
                {pumpPaused ? `Resume${pumpMissed ? ` (+${pumpMissed})` : ''}` : 'Pause'}
              </button>
              <button type="button" className="tm-btn" onClick={clearPump}>
                Clear
              </button>
            </div>
          </header>
          {/* pump.fun bridge + fallback session — mirrors the fomo toolbar row:
              status + heartbeat chips on the left, auth_token input on the right */}
          <div className="tm-toolbar">
            <div className="tm-status">
              <span
                className={`tm-dot ${pumpDot}`}
                title={
                  pumpStatus.state === 'auth'
                    ? 'unauthorized — pump.fun only accepts real browser requests; the Tampermonkey bridge is the primary source'
                    : `pump.fun ${pumpStatus.state} ${pumpStatus.detail}`.trim()
                }
              />
              <span className="tm-state">{pumpStatus.state}</span>
              {pumpStatus.detail && <span className="tm-detail">{pumpStatus.detail}</span>}
              {pumpBridgeAt > 0 && (
                <span className="tm-exp" title="last page relayed by the Tampermonkey bridge userscript">
                  bridge ⟳ {timeAgo(new Date(pumpBridgeAt).toISOString(), now)} ago
                </span>
              )}
              {pumpToken && (
                <span
                  className="tm-exp"
                  title="auth_token fingerprint for the poll fallback — rotates on every pump.fun login"
                >
                  token …{pumpToken.slice(-6)}
                </span>
              )}
            </div>
            <div className="tm-settings">
              <input
                className="tm-input tm-input-jwt"
                type="text"
                spellCheck={false}
                title="DevTools → Application → Cookies → pump.fun → auth_token. Fallback poll only — pump.fun's browser-only auth usually 401s server-side use, so the Tampermonkey bridge is the primary source."
                placeholder="pump.fun auth_token cookie (poll fallback)"
                defaultValue={pumpToken}
                onChange={(e) => {
                  const v = e.target.value.trim();
                  setPumpToken(v);
                  if (v) localStorage.setItem(LS_PUMP_TOKEN, v);
                  else localStorage.removeItem(LS_PUMP_TOKEN);
                }}
              />
            </div>
          </div>
          <div className="tm-filters">
            {pumpChip('calls', PUMP_GROUP_LABELS.calls)}
            {pumpChip('trades', PUMP_GROUP_LABELS.trades)}
            {pumpChip('posts', PUMP_GROUP_LABELS.posts)}
            <span className="tm-count">{visiblePump.length} shown</span>
          </div>
          <div className="tm-panel-body">
            {visiblePump.length === 0 && (
              <div className="tm-empty">
                {Object.values(pumpGroups).every((v) => !v)
                  ? 'all kind chips are off — enable Calls / Trades / Posts above…'
                  : now - pumpBridgeAt < 60_000
                    ? 'Bridge connected — waiting for alerts from your followed accounts…'
                    : pumpStatus.state === 'auth'
                      ? 'unauthorized — pump.fun only accepts real browser requests; use the Tampermonkey bridge (scripts/pump-fun-bridge.user.js)'
                      : pumpStatus.state === 'error'
                        ? `pump.fun api error ${pumpStatus.detail} — retrying…`
                        : pumpStatus.state === 'ok'
                          ? 'Connected — waiting for alerts…'
                          : 'no bridge yet — install scripts/pump-fun-bridge.user.js in Tampermonkey and keep a logged-in pump.fun tab open (pinned/background is fine)'}
              </div>
            )}
            {visiblePump.map((c) => (
              <article key={c.key} className={`tm-act tm-pf ${c.cls} ${c.fresh ? 'fresh' : ''}`}>
                <Thumb src={c.avatar} alt={c.user || '?'} className="tm-act-avatar" />
                <div className="tm-act-main">
                  <div className="tm-act-user">
                    <span className="tm-act-name">{c.user || 'anon'}</span>
                    {c.verified && (
                      <span className="tm-act-verified" title="verified">
                        ✔
                      </span>
                    )}
                    {c.x && (
                      <a
                        className="tm-act-twitter"
                        href={`https://x.com/${c.x}`}
                        target="_blank"
                        rel="noreferrer"
                        title={`@${c.x}`}
                      >
                        𝕏
                      </a>
                    )}
                  </div>
                  <div className="tm-act-line">
                    <span className={`tm-act-verb ${c.cls}`}>{c.verb}</span>
                    <Thumb src={c.img} alt={c.symbol} className="tm-act-tokenimg" />
                    <span
                      className="tm-act-ticker"
                      title={c.mint ? `${c.mint} · ${pumpChain(c.chainId)} — click to copy mint` : pumpChain(c.chainId)}
                      onClick={() => c.mint && navigator.clipboard?.writeText(c.mint)}
                    >
                      ${c.symbol}
                    </span>
                    <span className="tm-act-chain" style={chainStyle(c.chainId)}>
                      {pumpChain(c.chainId)}
                    </span>
                    {c.mint && (
                      <a
                        className="tm-pf-link"
                        href={`https://pump.fun/coin/${c.mint}`}
                        target="_blank"
                        rel="noreferrer"
                        title="open on pump.fun"
                      >
                        ↗
                      </a>
                    )}
                  </div>
                  {c.thesis && <div className="tm-act-comment">{c.thesis}</div>}
                  <div className="tm-act-meta">
                    {c.amount != null && (
                      <span className={`tm-act-chip ${c.cls === 'buy' ? 'up' : c.cls === 'sell' ? 'down' : ''}`}>
                        {fmtUsd(c.amount)}
                      </span>
                    )}
                    {c.price != null && (
                      <span className="tm-act-chip" title="effective fill price">
                        @ {fmtPrice(c.price)}
                      </span>
                    )}
                    {c.mc != null && <span className="tm-act-chip">MC {fmtUsd(c.mc)}</span>}
                    {c.mult != null && (
                      <span className={`tm-act-chip ${c.mult >= 2 ? 'up' : ''}`} title="multiple since callout">
                        ×{c.mult.toFixed(2)}
                      </span>
                    )}
                    {c.pnl != null && (
                      <span className={`tm-act-chip ${c.pnl >= 0 ? 'up' : 'down'}`}>PNL {fmtPct(c.pnl)}</span>
                    )}
                    {c.val != null && (
                      <span className="tm-act-chip" title="position value">
                        VAL {fmtUsd(c.val)}
                      </span>
                    )}
                    {c.atMc > 0 && (
                      <span className="tm-act-chip" title="market cap when called">
                        from {fmtUsd(c.atMc)}
                      </span>
                    )}
                  </div>
                </div>
                <div className="tm-act-time">{timeAgo(c.at, now)}</div>
              </article>
            ))}
          </div>
        </section>
      </div>

      {/* ---- hover card: who bought the hovered token (fixed, so it never
          gets clipped by the panel's scroll area) ---- */}
      {tip && (
        <div
          className="tm-tip"
          style={{
            left: Math.max(8, Math.min(tip.x, window.innerWidth - 268)),
            top: Math.max(8, Math.min(tip.y, window.innerHeight - 300)),
          }}
        >
          <div className="tm-tip-head">
            <span>${tip.stat.ticker}</span>
            <span className="tm-tip-count">
              {tip.stat.buyers.size} buyer{tip.stat.buyers.size === 1 ? '' : 's'}
            </span>
          </div>
          {[...tip.stat.buyers.values()]
            .sort((x, y) => y.usd - x.usd)
            .map((b) => (
              <div key={b.id} className="tm-tip-user">
                <Thumb src={b.img} alt={b.name} className="tm-tip-avatar" />
                <div className="tm-tip-info">
                  <div className="tm-tip-line">
                    <span className="tm-tip-name">
                      {b.name}
                      {b.verified && (
                        <span className="tm-act-verified" title="verified">
                          ✔
                        </span>
                      )}
                      {b.isDev && <span className="tm-act-dev">DEV</span>}
                      {b.fomo > 0 && (
                        <span className="tm-tip-src fomo" title="buys seen on the fomo feed">
                          F {b.fomo}
                        </span>
                      )}
                      {b.pf > 0 && (
                        <span className="tm-tip-src" title="buys seen via the pump.fun bridge">
                          PF {b.pf}
                        </span>
                      )}
                    </span>
                    <span className="tm-tip-usd" title="total bought">
                      {fmtUsd(b.usd)}
                    </span>
                  </div>
                  <div className="tm-tip-line tm-tip-stats">
                    <span className="tm-tip-entry" title="average entry market cap (buys only)">
                      avg MC {b.mcN ? fmtUsd(b.mcSum / b.mcN) : '—'}
                    </span>
                    <span className="tm-tip-buys">
                      {b.n} buy{b.n === 1 ? '' : 's'}
                    </span>
                    <span className={`tm-tip-sells ${b.sells > 0 ? 'has' : ''}`} title="total sold">
                      {b.sells} sell{b.sells === 1 ? '' : 's'}
                      {b.sellUsd > 0 ? ` · ${fmtUsd(b.sellUsd)}` : ''}
                    </span>
                  </div>
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

// Avatar/token image with a letter fallback when the remote image fails.
function Thumb({ src, alt, className }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return <span className={`${className || ''} tm-thumb-fallback`}>{(alt || '?').slice(0, 1).toUpperCase()}</span>;
  }
  return <img className={className} src={src} alt={alt || ''} loading="lazy" decoding="async" onError={() => setFailed(true)} />;
}

export default TokenMonitor;
