import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { CHAINS, chainById, explorerTokenUrl, explorerTxUrl } from './chains.js';
import { createChainStream, swapIpfsGateway, IPFS_GATEWAYS } from './rpc.js';
import { classifyCollection, fetchCollectionImage, loadMetaMap, saveMetaMap, NFT_ID_MAX } from './enrich.js';
import './NftMint.css';

const WINDOW_5M = 5 * 60 * 1000;
const WINDOW_15M = 15 * 60 * 1000;
const WINDOW_1H = 60 * 60 * 1000;
const PRUNE_MS = 65 * 60 * 1000;
const FEED_CAP = 120;
const ROWS_SHOWN = 40;
const MAX_EVENTS_PER_COLLECTION = 24000;
// Backlog + metadata caps: spam-heavy chains mint thousands of fresh contracts
// per hour; without caps the live queues/meta map grow until the tab OOMs.
const MAX_QUEUE = 2000;
const MAX_META = 6000;
// Hard bound on collections tracked per chain (least-recently-active dropped
// when exceeded) and the minimum 1h mints for a leaderboard row — the two
// remaining unbounded growth paths that crashed the renderer (native
// STATUS_ACCESS_VIOLATION) after the page sat open for a while.
const MAX_COLLECTIONS = 30000;
const ROW_MIN_H1 = 3;
const SPARK_BUCKETS = 12; // x 5min = last hour
// Mints with token numbers above this are skipped entirely — spam contracts
// mint pseudo-random huge ids, real collections mint sequentially from low ids.
const MAX_TOKEN_ID = 10_000n;

const fmtInt = (n) => {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString();
};

const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

const fmtTokenId = (id) => {
  if (id === null || id === undefined) return '';
  try {
    return id <= 0xffffffffffffffffn ? id.toString() : `0x${id.toString(16).slice(0, 10)}…`;
  } catch {
    return '';
  }
};

const fmtClock = (tsMs) =>
  new Date(tsMs).toLocaleTimeString(undefined, { hour12: false });

const timeAgo = (ms) => {
  if (ms == null) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return 'now';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
};

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

// Copies the full contract address to the clipboard; icon flips to a green
// check for ~1.2s as confirmation. Falls back to execCommand when the async
// clipboard API is unavailable (non-secure contexts).
function CopyAddr({ addr }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(null);
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const onClick = async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(addr);
      ok = true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = addr;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        ta.remove();
      } catch {
        ok = false;
      }
    }
    if (ok) {
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1200);
    }
  };

  return (
    <button
      type="button"
      className={`bnm-copy${copied ? ' copied' : ''}`}
      onClick={onClick}
      title={copied ? 'Copied!' : 'Copy contract address'}
      aria-label="Copy contract address"
    >
      {copied ? (
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3 8.5 6.5 12 13 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      )}
    </button>
  );
}

function Sparkline({ data }) {
  const max = Math.max(...data, 1);
  return (
    <div className="bnm-spark" title="Mints per 5min · last hour">
      {data.map((v, i) => (
        <div
          key={i}
          className={`bnm-spark-bar ${v > 0 ? 'has-value' : ''}`}
          style={{ height: `${Math.max(4, Math.round((v / max) * 100))}%` }}
        />
      ))}
    </div>
  );
}

function Avatar({ row }) {
  const [attempt, setAttempt] = useState(0); // 0 = original URL, then alternate gateways
  const initial = (row.symbol || row.name || '?').trim().charAt(0).toUpperCase() || '?';
  if (row.img) {
    // Try each public IPFS gateway before giving up (ipfs.io 429s are common);
    // non-gateway URLs fall straight through to the letter fallback.
    const src =
      attempt === 0
        ? row.img
        : attempt < IPFS_GATEWAYS.length
          ? swapIpfsGateway(row.img, attempt)
          : null;
    if (src) {
      return (
        <img
          className="bnm-avatar"
          src={src}
          alt={row.name}
          loading="lazy"
          onError={() => setAttempt((a) => a + 1)}
        />
      );
    }
  }
  const hue = parseInt(row.addr.slice(2, 8), 16) % 360;
  return (
    <div
      className="bnm-avatar bnm-avatar-fallback"
      style={{ background: `linear-gradient(135deg, hsl(${hue} 60% 45%), hsl(${(hue + 60) % 360} 60% 35%))` }}
    >
      {initial}
    </div>
  );
}

const COLUMNS = [
  { key: 'hot', label: 'Hot', title: 'Hotness score (recent-weighted)' },
  { key: 'm5', label: '5m', title: 'Mints in last 5 minutes' },
  { key: 'm15', label: '15m', title: 'Mints in last 15 minutes' },
  { key: 'h1', label: '1h', title: 'Mints in last hour' },
  { key: 'minters1', label: 'Minters', title: 'Unique minters in last hour' },
];

const makeChainState = (id) => ({
  id,
  events: new Map(), // address -> [{ ts, minter, amount, tokenId, standard }]
  meta: null,        // address -> { std, name, symbol, uri, img, ... } (lazy)
  feed: [],
  classifyQueue: new Set(),
  thumbQueue: new Set(),
  seen: 0,
  conn: { state: 'connecting', url: '', block: 0, headTs: [] },
});

function NftMint() {
  const [snapshot, setSnapshot] = useState(null); // { ts, byChain: { id: {rows, feed, stats, conn} } }
  const [paused, setPaused] = useState(false);
  const [sortKey, setSortKey] = useState('hot');
  const [query, setQuery] = useState('');

  const pausedRef = useRef(false);
  const statesRef = useRef(Object.fromEntries(CHAINS.map((c) => [c.id, makeChainState(c.id)])));
  // Read by computeSnapshot (1s ticker): when the user is searching, low-activity
  // collections matching the query are kept as rows despite the leaderboard gate.
  const queryRef = useRef('');
  const dirtyChainsRef = useRef(new Set());

  const ensureMeta = useCallback((chainState, address) => {
    let map = chainState.meta;
    if (!map) {
      map = loadMetaMap(chainById(chainState.id).chainId);
      chainState.meta = map;
    }
    let meta = map.get(address);
    if (!meta) {
      if (map.size >= MAX_META) {
        // Evict a batch of the stalest entries at once. At spam rates (~100 new
        // contracts/s) a per-insert scan of the whole map burned serious CPU;
        // dropping 250 per scan amortizes it to one scan per ~250 inserts.
        const overflow = map.size - MAX_META + 1;
        const batch = [...map.entries()]
          .sort((a, b) => (a[1]?.at || 0) - (b[1]?.at || 0))
          .slice(0, Math.max(overflow, Math.min(250, MAX_META >> 2)));
        for (const [k] of batch) map.delete(k);
      }
      meta = { at: Date.now() };
      map.set(address, meta);
    }
    return meta;
  }, []);

  // Insertion-ordered Sets iterate oldest-first, so the dropped item is the
  // least recently queued address.
  const queueAdd = useCallback((set, addr) => {
    set.add(addr);
    if (set.size > MAX_QUEUE) set.delete(set.values().next().value);
  }, []);

  const ingest = useCallback(
    (chainId) => (mint) => {
      if (pausedRef.current) return;
      // High token numbers are (almost) always spam contracts minting
      // pseudo-random ids — drop them before they can touch any state.
      if (mint.tokenId > MAX_TOKEN_ID) return;
      const st = statesRef.current[chainId];
      st.seen += 1;
      let evs = st.events.get(mint.address);
      if (!evs) {
        evs = [];
        st.events.set(mint.address, evs);
      }
      evs.push({
        ts: mint.tsMs,
        minter: mint.minter,
        amount: mint.amount,
        tokenId: mint.tokenId,
        standard: mint.standard,
        idIndexed: mint.idIndexed,
      });
      if (evs.length > MAX_EVENTS_PER_COLLECTION) {
        evs.splice(0, evs.length - MAX_EVENTS_PER_COLLECTION);
      }
      st.feed.unshift(mint);
      if (st.feed.length > FEED_CAP) st.feed.length = FEED_CAP;

      const meta = ensureMeta(st, mint.address);
      // Instant no-probe classification keeps the leaderboard alive under heavy
      // new-contract minting (Robinhood Chain sees ~100 mints/s across fresh
      // contracts — the RPC-probe ladder alone could not keep up).
      if (!meta.std) {
        if (mint.standard === 'erc1155' || mint.idIndexed || mint.tokenId < NFT_ID_MAX) {
          meta.std = mint.standard === 'erc1155' ? 'erc1155' : 'erc721';
          meta.at = Date.now();
        }
      }
      if (!meta.std || meta.named === undefined) queueAdd(st.classifyQueue, mint.address);
    },
    [ensureMeta, queueAdd],
  );

  // Streams for every configured chain + background enrichment workers
  // (classification, thumbnails, cache). All chains ingest concurrently; the
  // tabs only switch which chain's accumulated data is displayed.
  useEffect(() => {
    const states = statesRef.current; // stable object — mutated in place, never reassigned
    const streams = CHAINS.map((chainCfg) =>
      createChainStream(chainCfg, {
        onMint: ingest(chainCfg.id),
        onHead: (head) => {
          const st = states[chainCfg.id];
          st.conn.block = parseInt(head.number, 16);
          if (head.timestamp) {
            st.conn.headTs.push(Number(BigInt(head.timestamp)));
            if (st.conn.headTs.length > 40) st.conn.headTs.shift();
          }
        },
        onStatus: (s) => {
          const st = states[chainCfg.id];
          st.conn.state = s.state;
          st.conn.url = s.url;
        },
      }),
    );

    // Enrichment workers: one classification + one thumbnail per chain per
    // cycle. Self-scheduling setTimeout chains, NOT setInterval — a cycle
    // awaits RPC/metadata calls that can take seconds on rate-limited public
    // endpoints, and setInterval would stack overlapping cycles without bound
    // until the tab freezes (this is what made the page die after a while).
    const runWorker = (intervalMs, cycle) => {
      let stopped = false;
      let timer = null;
      const tick = async () => {
        if (stopped) return;
        try {
          await cycle();
        } catch {
          /* a bad cycle must not stop the worker */
        }
        if (!stopped) timer = setTimeout(tick, intervalMs);
      };
      timer = setTimeout(tick, intervalMs);
      return () => {
        stopped = true;
        clearTimeout(timer);
      };
    };

    const stopClassify = runWorker(350, async () => {
      for (let i = 0; i < CHAINS.length; i++) {
        const st = states[CHAINS[i].id];
        // NB: Set iterators — .values() yields the element; .entries() would
        // yield [value, value] pairs and silently break the Map lookups below.
        const { value: address, done } = st.classifyQueue.values().next();
        if (done) continue;
        const evs = st.events.get(address);
        const meta = st.meta?.get(address);
        if (!evs || !evs.length || !meta) {
          st.classifyQueue.delete(address);
          continue;
        }
        try {
          await classifyCollection(streams[i].call, address, evs, meta);
        } catch {
          /* leave for retry */
        }
        if (meta.std && meta.named !== undefined) {
          st.classifyQueue.delete(address);
          dirtyChainsRef.current.add(CHAINS[i].id);
          if (meta.std !== 'token' && meta.img === undefined) {
            queueAdd(st.thumbQueue, address);
          }
        }
      }
    });

    const stopThumb = runWorker(900, async () => {
      for (let i = 0; i < CHAINS.length; i++) {
        const st = states[CHAINS[i].id];
        const { value: address, done } = st.thumbQueue.values().next();
        if (done) continue;
        st.thumbQueue.delete(address);
        const evs = st.events.get(address);
        const meta = st.meta?.get(address);
        if (!evs || !evs.length || !meta) continue;
        try {
          await fetchCollectionImage(streams[i].call, address, evs, meta);
          dirtyChainsRef.current.add(CHAINS[i].id);
        } catch {
          /* image stays unresolved this session */
        }
      }
    });

    // Persist enriched metadata only for chains that changed — serializing
    // every chain's map each tick was its own CPU + transient-string spike.
    const saveTimer = setInterval(() => {
      if (dirtyChainsRef.current.size === 0) return;
      for (const id of dirtyChainsRef.current) {
        const c = chainById(id);
        const st = states[c.id];
        if (st.meta) saveMetaMap(c.chainId, st.meta);
      }
      dirtyChainsRef.current.clear();
    }, 15000);

    return () => {
      for (const stream of streams) stream.close();
      stopClassify();
      stopThumb();
      clearInterval(saveTimer);
      for (const c of CHAINS) {
        const st = states[c.id];
        if (st.meta) saveMetaMap(c.chainId, st.meta);
      }
    };
  }, [ingest, queueAdd]);

  // Recomputes rolling-window aggregates for every chain, pruning old data.
  const computeSnapshot = useCallback(() => {
    const now = Date.now();
    const byChain = {};

    for (const c of CHAINS) {
      const st = statesRef.current[c.id];
      const events = st.events;
      const metaMap = st.meta;

      const cutoff = now - PRUNE_MS;
      for (const [addr, evs] of events) {
        let i = 0;
        while (i < evs.length && evs[i].ts < cutoff) i++;
        if (i > 0) evs.splice(0, i);
        if (evs.length === 0) events.delete(addr);
      }

      // Hard cap on tracked collections. Time-pruning alone is not enough on
      // spam-heavy chains: ~100 fresh contracts/s keep the 65-minute window
      // populated with hundreds of thousands of Map entries until the renderer
      // dies (native STATUS_ACCESS_VIOLATION after the page sat open a while).
      // Overflow is resolved by dropping the least-recently-active entries.
      if (events.size > MAX_COLLECTIONS) {
        const lru = [...events.entries()]
          .map(([a, evs]) => [evs.length ? evs[evs.length - 1].ts : 0, a])
          .sort((x, y) => x[0] - y[0]);
        // Capture the overflow before deleting — events.size shrinks per iteration.
        const overflow = events.size - MAX_COLLECTIONS;
        for (let k = 0; k < overflow; k++) events.delete(lru[k][1]);
      }

      const q = queryRef.current;
      const rows = [];
      let totalM5 = 0;
      let totalH1 = 0;
      let activeCols = 0;
      const minters5Global = new Set();

      for (const [addr, evs] of events) {
        const meta = metaMap?.get(addr);
        if (!meta || (meta.std !== 'erc721' && meta.std !== 'erc1155')) continue;

        // Pass 1 — plain numbers only, no per-row allocations.
        let m5 = 0;
        let m15 = 0;
        let h1 = 0;
        let lastTs = 0;
        for (let i = 0; i < evs.length; i++) {
          const ev = evs[i];
          const age = now - ev.ts;
          if (age < WINDOW_5M) {
            m5 += ev.amount;
            minters5Global.add(ev.minter);
          }
          if (age < WINDOW_15M) m15 += ev.amount;
          if (age < WINDOW_1H) h1 += ev.amount;
          if (ev.ts > lastTs) lastTs = ev.ts;
        }

        totalM5 += m5;
        totalH1 += h1;
        if (h1 > 0) activeCols += 1;

        // Leaderboard gate: 1–2-mint contracts are mint-and-dump noise on spam
        // chains, and building a row (two Sets + sparkline) for every one of
        // them each tick created ~100k throwaway objects/second — the GC storm
        // that destabilized the renderer. Gated collections still count toward
        // the stats above, still appear in the live feed, and remain findable
        // via search (matches check below).
        const matches =
          q !== '' &&
          (addr.includes(q) ||
            (meta.name != null && meta.name.toLowerCase().includes(q)) ||
            (meta.symbol != null && meta.symbol.toLowerCase().includes(q)));
        if (h1 < ROW_MIN_H1 && !matches) continue;

        // Pass 2 — heavier per-row state, only for leaderboard candidates.
        const minters5 = new Set();
        const minters1 = new Set();
        const spark = new Array(SPARK_BUCKETS).fill(0);
        for (let i = 0; i < evs.length; i++) {
          const ev = evs[i];
          const age = now - ev.ts;
          if (age < WINDOW_5M) minters5.add(ev.minter);
          if (age < WINDOW_1H) minters1.add(ev.minter);
          const bucket = Math.floor(age / WINDOW_5M);
          if (bucket < SPARK_BUCKETS) spark[SPARK_BUCKETS - 1 - bucket] += ev.amount;
        }

        rows.push({
          addr,
          name: meta.name || null,
          symbol: meta.symbol || null,
          std: meta.std,
          img: typeof meta.img === 'string' ? meta.img : null,
          m5,
          m15,
          h1,
          minters5: minters5.size,
          minters1: minters1.size,
          lastTs,
          spark,
          hot: m5 * 4 + m15 * 1.5 + h1 * 0.4,
        });
      }

      const feed = st.feed.slice(0, 50).map((e) => {
        const meta = metaMap?.get(e.address);
        return {
          ...e,
          name: meta?.name || shortAddr(e.address),
          symbol: meta?.symbol || null,
        };
      });

      let blockTime = null;
      if (st.conn.headTs.length > 5) {
        const span = st.conn.headTs[st.conn.headTs.length - 1] - st.conn.headTs[0];
        blockTime = span / (st.conn.headTs.length - 1);
      }

      byChain[c.id] = {
        rows,
        feed,
        stats: {
          block: st.conn.block,
          blockTime,
          mintsPerMin: totalM5 / 5,
          totalH1,
          activeCols,
          minters5: minters5Global.size,
          seen: st.seen,
        },
        conn: { ...st.conn, headTs: undefined },
      };
    }

    return { ts: now, byChain };
  }, []);

  // 1s render ticker: keeps "x seconds ago" cells and rankings fresh.
  useEffect(() => {
    const t = setInterval(() => setSnapshot(computeSnapshot()), 1000);
    return () => clearInterval(t);
  }, [computeSnapshot]);

  // Sort/filter the snapshot for every chain at once — all are rendered together.
  const views = useMemo(() => {
    const out = {};
    const q = query.trim().toLowerCase();
    for (const c of CHAINS) {
      const snap = snapshot?.byChain?.[c.id];
      if (!snap) {
        out[c.id] = { rows: [], feed: [], stats: null, conn: null };
        continue;
      }
      let rows = snap.rows;
      if (q) {
        rows = rows.filter(
          (r) =>
            r.name?.toLowerCase().includes(q) ||
            r.symbol?.toLowerCase().includes(q) ||
            r.addr.includes(q),
        );
      }
      rows = [...rows]
        .sort((a, b) => (b[sortKey] || 0) - (a[sortKey] || 0) || b.hot - a.hot)
        .slice(0, ROWS_SHOWN);
      out[c.id] = { rows, feed: snap.feed, stats: snap.stats, conn: snap.conn };
    }
    return out;
  }, [snapshot, sortKey, query]);

  const togglePause = () => {
    const next = !paused;
    setPaused(next);
    pausedRef.current = next;
  };

  const clearData = (chainId) => {
    const st = statesRef.current[chainId];
    st.events = new Map();
    st.feed = [];
    st.seen = 0;
    st.conn.headTs = [];
    setSnapshot(computeSnapshot());
  };

  const now = snapshot?.ts || Date.now();

  return (
    <div className="bnm">
      <div className="bnm-toolbar">
        <div className="bnm-actions">
          <input
            className="bnm-input"
            type="text"
            placeholder="Filter by name / address…"
            value={query}
            onChange={(e) => {
              const v = e.target.value;
              setQuery(v);
              queryRef.current = v.trim().toLowerCase();
            }}
          />
          <button className="bnm-btn" onClick={togglePause}>
            {paused ? '▶ Resume' : '⏸ Pause'}
          </button>
        </div>
      </div>

      <div className="bnm-chains">
        {CHAINS.map((chain) => {
        const { rows, feed, stats, conn } = views[chain.id] || { rows: [], feed: [], stats: null, conn: null };
        const connected = conn?.state === 'connected';
        return (
        <section className="bnm-chain" key={chain.id}>
          <div className="bnm-chain-head">
            <div className={`bnm-status ${conn?.state || ''}`}>
              <span className={`bnm-dot ${paused ? 'paused' : ''}`} />
              <span className="bnm-status-label">
                {paused ? 'Paused' : connected ? 'Live' : conn?.state === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}
              </span>
              <span className="bnm-status-chain">{chain.name}</span>
              {conn?.url && <span className="bnm-status-url mono">{hostOf(conn.url)}</span>}
              {stats?.block ? <span className="bnm-status-block mono">#{stats.block.toLocaleString()}</span> : null}
              {stats?.blockTime ? (
                <span className="bnm-status-blocktime mono">~{stats.blockTime.toFixed(2)}s/block</span>
              ) : null}
            </div>
            <div className="bnm-chain-tools">
              <div className="bnm-stats">
                <div className="bnm-stat">
                  <span className="bnm-stat-label">Mints/min</span>
                  <span className="bnm-stat-value">{stats ? stats.mintsPerMin.toFixed(1) : '—'}</span>
                </div>
                <div className="bnm-stat">
                  <span className="bnm-stat-label">Minters 5m</span>
                  <span className="bnm-stat-value">{stats ? fmtInt(stats.minters5) : '—'}</span>
                </div>
                <div className="bnm-stat">
                  <span className="bnm-stat-label">Active cols 1h</span>
                  <span className="bnm-stat-value">{stats ? fmtInt(stats.activeCols) : '—'}</span>
                </div>
                <div className="bnm-stat">
                  <span className="bnm-stat-label">Mints 1h</span>
                  <span className="bnm-stat-value">{stats ? fmtInt(stats.totalH1) : '—'}</span>
                </div>
              </div>
              <button className="bnm-btn" onClick={() => clearData(chain.id)}>
                ⟲ Clear
              </button>
            </div>
          </div>

          {conn && conn.state !== 'connected' && conn.state !== 'connecting' ? (
            <div className="bnm-warn">
              Lost connection to the {chain.name} node — retrying with backoff. Data may be incomplete.
            </div>
          ) : null}

        <div className="bnm-chain-body">
        <section className="bnm-panel">
          <div className="bnm-panel-head">
            <h3>🔥 Trending mints · {chain.name}</h3>
            <span className="bnm-panel-note">click column headers to sort</span>
          </div>
          {rows.length === 0 ? (
            <div className="bnm-empty">
              {!connected
                ? `Connecting to ${chain.name} and subscribing to mint events…`
                : query
                  ? 'No collections match your filter.'
                  : stats && stats.seen > 0
                    ? 'Mints seen but none confirmed as NFT collections yet — classifying…'
                    : 'Listening for NFT mints — none detected yet. New collections appear here within seconds of minting.'}
            </div>
          ) : (
            <div className="bnm-table-wrap">
              <table className="bnm-table">
                <thead>
                  <tr>
                    <th className="bnm-th-rank">#</th>
                    <th>Collection</th>
                    {COLUMNS.map((col) => (
                      <th
                        key={col.key}
                        className={`num sortable ${sortKey === col.key ? 'active' : ''}`}
                        title={col.title}
                        onClick={() => setSortKey(col.key)}
                      >
                        {col.label}
                        {sortKey === col.key ? ' ▾' : ''}
                      </th>
                    ))}
                    <th className="bnm-th-spark">Activity</th>
                    <th className="num">Last</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={row.addr} className={i < 3 ? 'bnm-row-top' : ''}>
                      <td className="bnm-rank mono">{i + 1}</td>
                      <td className="bnm-coll">
                        <Avatar row={row} />
                        <div className="bnm-coll-text">
                          <span className="bnm-coll-name">
                            {i < 3 ? '🔥 ' : ''}
                            {row.name || (
                              <span className="bnm-coll-unnamed" title="name() not resolved (yet)">
                                {row.symbol || 'Unnamed'}
                              </span>
                            )}
                            {row.name && row.symbol ? <span className="bnm-coll-symbol"> ${row.symbol}</span> : null}
                          </span>
                          <span className="bnm-coll-sub">
                            <span className={`bnm-std ${row.std}`}>{row.std === 'erc1155' ? '1155' : '721'}</span>
                            <a
                              className="bnm-link mono"
                              href={explorerTokenUrl(chain, row.addr)}
                              target="_blank"
                              rel="noreferrer"
                              title={row.addr}
                            >
                              {shortAddr(row.addr)} ↗
                            </a>
                            <CopyAddr addr={row.addr} />
                          </span>
                        </div>
                      </td>
                      <td className="num mono bnm-hot-col">{row.hot >= 100 ? Math.round(row.hot) : row.hot.toFixed(1)}</td>
                      <td className="num mono">{fmtInt(row.m5)}</td>
                      <td className="num mono">{fmtInt(row.m15)}</td>
                      <td className="num mono">{fmtInt(row.h1)}</td>
                      <td className="num mono">{fmtInt(row.minters1)}</td>
                      <td className="bnm-td-spark"><Sparkline data={row.spark} /></td>
                      <td className="num mono bnm-ago">{timeAgo(now - row.lastTs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <aside className="bnm-panel bnm-feed-panel">
          <div className="bnm-panel-head">
            <h3><span className="bnm-live-dot" /> Live mint feed · {chain.short}</h3>
            <span className="bnm-panel-note">latest {feed.length}</span>
          </div>
          {feed.length === 0 ? (
            <div className="bnm-empty">Waiting for the first mint event…</div>
          ) : (
            <div className="bnm-feed">
              {feed.map((e) => (
                <a
                  key={`${e.txHash}-${e.logIndex}`}
                  className="bnm-feed-row"
                  href={explorerTxUrl(chain, e.txHash)}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className="bnm-feed-time mono">{fmtClock(e.tsMs)}</span>
                  <span className="bnm-feed-main">
                    <span className="bnm-feed-coll">
                      {e.amount > 1 ? <span className="bnm-feed-amount">×{fmtInt(e.amount)}</span> : null}
                      {e.name}
                    </span>
                    <span className="bnm-feed-sub mono">
                      #{fmtTokenId(e.tokenId)} · {shortAddr(e.minter)}
                      {e.batchIds > 1 ? ` · batch of ${e.batchIds}` : ''}
                    </span>
                  </span>
                  <span className={`bnm-std ${e.standard === 'erc1155' ? 'erc1155' : 'erc721'}`}>
                    {e.standard === 'erc1155' ? '1155' : '721'}
                  </span>
                </a>
              ))}
            </div>
          )}
        </aside>
        </div>
        </section>
        );
        })}
      </div>
    </div>
  );
}

export default NftMint;






