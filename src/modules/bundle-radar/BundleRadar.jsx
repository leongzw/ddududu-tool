import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ethers } from 'ethers';
import { analyzeToken, buildReport, createLiveMonitor } from './engine';
import { CHAINS, chainById, explorerAddressUrl, explorerTxUrl } from './chains';
import './BundleRadar.css';

const LS_CHAIN = 'bundle-radar:chain';
const LS_TOKEN = 'bundle-radar:token';
const LS_RPC = 'bundle-radar:rpc';
const LS_EKEY = 'bundle-radar:etherscan-key';
const MAX_FEED = 150;

// ---- formatting helpers (token amounts are plain Numbers in the report) ----
const fmtNum = (n) => {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  if (abs >= 1) return n.toFixed(abs >= 100 ? 0 : 2);
  return n.toPrecision(3);
};
const fmtPct = (n) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n.toFixed(2)}%`);
const fmtUsd = (tokens, price) => (price > 0 && Number.isFinite(tokens) ? `$${fmtNum(tokens * price)}` : null);
const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const fmtTime = (t) => (t ? new Date(t).toISOString().slice(5, 16).replace('T', ' ') : '');
const timeAgo = (t, now) => {
  if (!t) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};
const parseList = (s) =>
  s
    .split(/[,\s]+/)
    .map((a) => a.trim())
    .filter((a) => a.length > 0 && ethers.isAddress(a));

const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dead';

// Ticking "now" for relative timestamps in the live feed.
function useNow(intervalMs) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function BundleRadar() {
  // ---- inputs (persisted) ----
  const [chainId, setChainId] = useState(() => localStorage.getItem(LS_CHAIN) || CHAINS[0].id);
  const [tokenInput, setTokenInput] = useState(() => localStorage.getItem(LS_TOKEN) || '');
  const [customRpc, setCustomRpc] = useState(() => localStorage.getItem(LS_RPC) || '');
  const [etherscanKey, setEtherscanKey] = useState(() => localStorage.getItem(LS_EKEY) || '');
  const [fromBlockInput, setFromBlockInput] = useState('');
  const [priceInput, setPriceInput] = useState('');

  // ---- clustering knobs ----
  const [minWallets, setMinWallets] = useState(3);
  const [minCoEvents, setMinCoEvents] = useState(2);
  const [poolMinDistinct, setPoolMinDistinct] = useState(8);
  const [linkMoves, setLinkMoves] = useState(true);
  const [extraPoolsInput, setExtraPoolsInput] = useState('');
  const [notPoolsInput, setNotPoolsInput] = useState('');

  // ---- scan / report state ----
  const [scan, setScan] = useState({ busy: false, phase: 'idle', pct: 0, detail: '', error: '' });
  const [dataset, setDataset] = useState(null);
  const [report, setReport] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [copied, setCopied] = useState(false);

  // ---- live state ----
  const [liveRunning, setLiveRunning] = useState(false);
  const [feed, setFeed] = useState([]);
  const [liveStats, setLiveStats] = useState({});
  const [showAllLive, setShowAllLive] = useState(false);

  const cancelRef = useRef(false);
  const monitorRef = useRef(null);
  const reportRef = useRef(null);
  const seenLiveRef = useRef(new Set());

  reportRef.current = report;
  const chain = chainById(chainId);
  const price = Number(priceInput) > 0 ? Number(priceInput) : 0;
  const nowTick = useNow(1000);

  const currentOpts = useCallback(
    () => ({
      minWallets: Math.max(2, Number(minWallets) || 3),
      minCoEvents: Math.max(1, Number(minCoEvents) || 2),
      poolMinDistinct: Math.max(2, Number(poolMinDistinct) || 8),
      linkMoves,
      extraPools: parseList(extraPoolsInput),
      notPools: parseList(notPoolsInput),
    }),
    [minWallets, minCoEvents, poolMinDistinct, linkMoves, extraPoolsInput, notPoolsInput],
  );

  const stopLive = useCallback(() => {
    if (monitorRef.current) {
      monitorRef.current.stop();
      monitorRef.current = null;
    }
    setLiveRunning(false);
  }, []);

  const runAnalyze = useCallback(async () => {
    if (!tokenInput || scan.busy) return;
    stopLive();
    setFeed([]);
    setLiveStats({});
    setSelectedId(null);
    setCopied(false);
    seenLiveRef.current = new Set();
    cancelRef.current = false;
    setScan({ busy: true, phase: 'scan', pct: 0, detail: 'starting…', error: '' });
    localStorage.setItem(LS_CHAIN, chainId);
    localStorage.setItem(LS_TOKEN, tokenInput.trim());
    localStorage.setItem(LS_RPC, customRpc.trim());
    localStorage.setItem(LS_EKEY, etherscanKey.trim());
    try {
      const raw = await analyzeToken({
        chain,
        token: tokenInput.trim(),
        customRpc: customRpc.trim() || null,
        explorerKey: etherscanKey.trim() || null,
        fromBlock: Number(fromBlockInput) > 0 ? Math.floor(Number(fromBlockInput)) : 0,
        onProgress: (p) => {
          const pct = p.total ? Math.min(99, Math.round((p.scanned / p.total) * 100)) : 0;
          setScan((s) => ({
            ...s,
            phase: p.phase,
            pct: p.phase === 'scan' ? pct : 100,
            detail: p.detail || `blocks ${p.from}–${p.to} · ${p.logs} transfers`,
          }));
        },
        isCancelled: () => cancelRef.current,
      });
      const rep = buildReport(raw, currentOpts());
      setDataset(raw);
      setReport(rep);
      setSelectedId(rep.groups[0]?.id ?? null);
      setScan({
        busy: false,
        phase: 'done',
        pct: 100,
        detail: `${rep.stats.transfers} transfers · ${rep.groups.length} group(s)`,
        error: '',
      });
    } catch (err) {
      setScan({ busy: false, phase: 'error', pct: 0, detail: '', error: err?.message || String(err) });
    }
  }, [tokenInput, scan.busy, chainId, customRpc, etherscanKey, fromBlockInput, chain, currentOpts, stopLive]);

  const cancelScan = useCallback(() => {
    cancelRef.current = true;
  }, []);

  const recluster = useCallback(() => {
    if (!dataset) return;
    const rep = buildReport(dataset, currentOpts());
    setReport(rep);
    if (!rep.groups.some((g) => g.id === selectedId)) setSelectedId(rep.groups[0]?.id ?? null);
  }, [dataset, currentOpts, selectedId]);

  // Classify live transfers against the latest report so re-clustering (pool
  // overrides, thresholds) applies to the feed without restarting it.
  const handleLiveEvents = useCallback(
    (transfers) => {
      const rep = reportRef.current;
      if (!rep) return;
      const div = 10 ** rep.meta.decimals;
      const entries = [];
      const statsAdd = {};
      for (const t of transfers) {
        const key = `${t.txHash}:${t.logIndex}`;
        if (seenLiveRef.current.has(key)) continue;
        seenLiveRef.current.add(key);
        if (t.from === ZERO || t.to === ZERO || t.from === DEAD || t.to === DEAD) continue;
        const fp = rep.poolSet.has(t.from);
        const tp = rep.poolSet.has(t.to);
        if (fp && tp) continue; // pool↔pool
        const dir = fp ? 'buy' : tp ? 'sell' : null;
        if (!dir) continue; // wallet↔wallet move
        const wallet = dir === 'buy' ? t.to : t.from;
        const g = rep.groupByWallet.get(wallet);
        if (!g && !showAllLive) continue;
        const tokens = Number(t.value) / div;
        entries.push({
          key,
          time: Date.now(),
          block: t.block,
          dir,
          wallet,
          groupId: g ? g.id : null,
          colorIdx: g ? g.colorIdx : null,
          tokens,
          txHash: t.txHash,
        });
        if (g) {
          const s = statsAdd[g.id] || (statsAdd[g.id] = { buy: 0, sell: 0 });
          s[dir] += tokens;
        }
      }
      if (entries.length) {
        setFeed((f) => [...entries.reverse(), ...f].slice(0, MAX_FEED));
        setLiveStats((s) => {
          const next = { ...s };
          for (const [id, v] of Object.entries(statsAdd)) {
            const cur = next[id] || { buy: 0, sell: 0 };
            next[id] = { buy: cur.buy + v.buy, sell: cur.sell + v.sell };
          }
          return next;
        });
      }
      if (seenLiveRef.current.size > 5000) seenLiveRef.current = new Set([...seenLiveRef.current].slice(-2500));
    },
    [showAllLive],
  );

  const toggleLive = useCallback(() => {
    if (monitorRef.current) {
      stopLive();
      return;
    }
    const rep = reportRef.current;
    if (!rep) return;
    monitorRef.current = createLiveMonitor({
      chain,
      customRpc: customRpc.trim() || null,
      token: rep.meta.token.toLowerCase(),
      startBlock: rep.meta.latestBlock,
      onEvents: (trs) => handleLiveEvents(trs),
      onError: () => {},
    });
    setLiveRunning(true);
  }, [chain, customRpc, stopLive, handleLiveEvents]);

  const exportGroups = useCallback(async () => {
    if (!report) return;
    const data = report.groups.map((g) => ({
      group: g.label,
      isDev: g.isDev,
      nWallets: g.nWallets,
      bagPct: +g.bagPct.toFixed(2),
      wallets: g.wallets.map((w) => w.address),
    }));
    try {
      await navigator.clipboard.writeText(
        JSON.stringify({ token: report.meta.token, chain: report.meta.chain.id, groups: data }, null, 2),
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }, [report]);

  // Cancel scan / stop monitor on unmount.
  useEffect(
    () => () => {
      cancelRef.current = true;
      if (monitorRef.current) monitorRef.current.stop();
    },
    [],
  );

  const selected = useMemo(
    () => (report && selectedId ? report.groups.find((g) => g.id === selectedId) : null),
    [report, selectedId],
  );

  return (
    <div className="br">
      {/* ---- toolbar ---- */}
      <div className="br-toolbar">
        <div className="br-toolbar-main">
          <select className="br-input br-chain" value={chainId} onChange={(e) => setChainId(e.target.value)}>
            {CHAINS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <input
            className="br-input br-token"
            placeholder="token contract address (0x…)"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            spellCheck={false}
          />
          {scan.busy ? (
            <button className="br-btn warn" onClick={cancelScan}>
              Cancel
            </button>
          ) : (
            <button className="br-btn primary" onClick={runAnalyze} disabled={!tokenInput}>
              Analyze
            </button>
          )}
          <button className={`br-btn ${liveRunning ? 'warn' : 'go'}`} onClick={toggleLive} disabled={!report}>
            {liveRunning ? '◼ Stop live' : '● Go live'}
          </button>
        </div>
        <div className="br-toolbar-side">
          <input
            className="br-input br-price"
            placeholder="price USD (optional — values the bags)"
            value={priceInput}
            onChange={(e) => setPriceInput(e.target.value)}
          />
          <button className="br-btn" onClick={exportGroups} disabled={!report}>
            {copied ? 'Copied ✓' : 'Copy groups'}
          </button>
        </div>
      </div>
      {/* ---- clustering settings ---- */}
      <div className="br-settings">
        <label className="br-field" title="leave empty to auto-find the creation block">
          start block
          <input className="br-input" placeholder="auto" value={fromBlockInput} onChange={(e) => setFromBlockInput(e.target.value)} />
        </label>
        <label className="br-field" title="min distinct wallets acting in one block to count as a coordinated event">
          min wallets/block
          <input className="br-input" type="number" min="2" value={minWallets} onChange={(e) => setMinWallets(e.target.value)} />
        </label>
        <label className="br-field" title="min shared coordinated events before two wallets merge into one group">
          min co-events
          <input className="br-input" type="number" min="1" value={minCoEvents} onChange={(e) => setMinCoEvents(e.target.value)} />
        </label>
        <label className="br-field" title="min distinct counterparties (both directions) for an address to count as a pool">
          pool cp min
          <input className="br-input" type="number" min="2" value={poolMinDistinct} onChange={(e) => setPoolMinDistinct(e.target.value)} />
        </label>
        <label className="br-check" title="treat direct token transfers between two trading wallets as a cluster link">
          <input type="checkbox" checked={linkMoves} onChange={(e) => setLinkMoves(e.target.checked)} /> link moves
        </label>
        <input
          className="br-input br-pools"
          placeholder="force pools (comma separated 0x…)"
          value={extraPoolsInput}
          onChange={(e) => setExtraPoolsInput(e.target.value)}
          spellCheck={false}
        />
        <input
          className="br-input br-pools"
          placeholder="exclude from pools (comma separated 0x…)"
          value={notPoolsInput}
          onChange={(e) => setNotPoolsInput(e.target.value)}
          spellCheck={false}
        />
        <input
          className="br-input br-rpc"
          placeholder="custom RPC URL (optional)"
          value={customRpc}
          onChange={(e) => setCustomRpc(e.target.value)}
          spellCheck={false}
        />
        <input
          className="br-input br-rpc"
          placeholder="Etherscan V2 key (optional — Ethereum only on free plan)"
          title="Free key from etherscan.io/apidocs. NOTE: the free plan only covers Ethereum mainnet — BSC/Base/others need a paid plan. Without a key everything still works via RPC log scans."
          value={etherscanKey}
          onChange={(e) => setEtherscanKey(e.target.value)}
          spellCheck={false}
        />
        <button className="br-btn" onClick={recluster} disabled={!dataset}>
          Re-cluster
        </button>
      </div>

      {/* ---- progress / status ---- */}
      {(scan.busy || scan.error) && (
        <div className={`br-progress ${scan.error ? 'err' : ''}`}>
          {scan.busy && (
            <div className="br-progress-bar">
              <div className="br-progress-fill" style={{ width: `${scan.pct}%` }} />
            </div>
          )}
          <div className="br-progress-text">
            {scan.error ? `⚠ ${scan.error}` : `${scan.phase} · ${scan.pct}% · ${scan.detail}`}
          </div>
        </div>
      )}
      {!scan.busy && !scan.error && scan.phase === 'done' && <div className="br-progress done">✓ {scan.detail}</div>}

      {report && (
        <>
          <div className="br-summary">
            <a className="br-chip main" href={explorerAddressUrl(chain, report.meta.token)} target="_blank" rel="noreferrer">
              {report.meta.symbol || shortAddr(report.meta.token)} ↗
            </a>
            <span className="br-chip">supply {fmtNum(report.meta.supply)}</span>
            <span className="br-chip">{report.stats.transfers} transfers</span>
            <span className="br-chip">{report.stats.txs} txs</span>
            <span className="br-chip">{report.stats.wallets} wallets</span>
            <span className="br-chip buy">{report.stats.buys} buys</span>
            <span className="br-chip sell">{report.stats.sells} sells</span>
            <span
              className="br-chip"
              title={report.pools.map((p) => `${p.address} · ${p.txCount} txs · in ${p.inCp}/out ${p.outCp} cps`).join('\n')}
            >
              {report.pools.length} pools
            </span>
            <span className="br-chip groups">{report.groups.length} groups</span>
          </div>

          <div className="br-panels">
            <div className="br-left">
              <div className="br-panel">
                <div className="br-panel-head">
                  <h2>Wallet groups 莊家</h2>
                  <span className="br-sub">by current bag</span>
                </div>
                <div className="br-groups">
                  {report.groups.map((g) => {
                    const ls = liveStats[g.id];
                    const usd = fmtUsd(g.bagTokens, price);
                    return (
                      <div
                        key={g.id}
                        className={`br-group ${selectedId === g.id ? 'active' : ''}`}
                        onClick={() => setSelectedId(g.id)}
                      >
                        <div className="br-group-head">
                          <span className={`br-badge g${g.colorIdx}`}>{g.label}</span>
                          <span className="br-group-n">{g.nWallets}w</span>
                          <span className="br-group-bag">
                            {fmtNum(g.bagTokens)} <em>{fmtPct(g.bagPct)}</em>
                          </span>
                        </div>
                        <div className="br-group-meta">
                          <span>bought {fmtNum(g.boughtTokens)}</span>
                          <span>sold {fmtNum(g.soldTokens)}</span>
                          {usd && <span>{usd}</span>}
                        </div>
                        <TimelineBar timeline={g.timeline} />
                        {ls && (ls.buy > 0 || ls.sell > 0) && (
                          <div className="br-group-live">
                            live <span className="buy">+{fmtNum(ls.buy)}</span> / <span className="sell">−{fmtNum(ls.sell)}</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {!report.groups.length && (
                    <div className="br-empty">no coordinated groups found — try lower thresholds</div>
                  )}
                </div>
              </div>
              <div className="br-panel">
                <div className="br-panel-head">
                  <h2>Ungrouped top holders</h2>
                </div>
                <div className="br-ungrouped">
                  {report.ungroupedTop.map((w) => (
                    <div key={w.address} className="br-ung">
                      <a href={explorerAddressUrl(chain, w.address)} target="_blank" rel="noreferrer">
                        {shortAddr(w.address)}
                      </a>
                      {w.isDev && <span className="br-dev-tag">DEV</span>}
                      <span className="br-ung-bag">
                        {fmtNum(w.bag)} · {fmtPct(w.bagPct)}
                      </span>
                    </div>
                  ))}
                  {!report.ungroupedTop.length && <div className="br-empty">none</div>}
                </div>
              </div>

            </div>
            <div className="br-panel br-detail">
              {selected ? (
                <>
                  <div className="br-panel-head">
                    <h2>
                      <span className={`br-badge g${selected.colorIdx}`}>{selected.label}</span> {selected.nWallets} wallets
                    </h2>
                    <div className="br-head-stats">
                      <span>
                        bag <b>{fmtNum(selected.bagTokens)}</b> ({fmtPct(selected.bagPct)} supply)
                      </span>
                      {fmtUsd(selected.bagTokens, price) && <span>{fmtUsd(selected.bagTokens, price)}</span>}
                      <span>
                        bought {fmtNum(selected.boughtTokens)} · sold {fmtNum(selected.soldTokens)}
                      </span>
                    </div>
                  </div>
                  <TimelineBar timeline={selected.timeline} big />
                  <div className="br-detail-cols">
                    <div className="br-events">
                      <div className="br-subhead">coordinated events ({selected.events.length})</div>
                      <div className="br-events-list">
                        {selected.events
                          .slice()
                          .reverse()
                          .map((ev, i) => (
                            <div key={`${ev.block}-${ev.dir}-${i}`} className={`br-ev ${ev.dir}`}>
                              <span className="br-ev-time">{ev.time ? fmtTime(ev.time) : `#${ev.block}`}</span>
                              <span className="br-ev-dir">{ev.dir}</span>
                              <span className="br-ev-kind">{ev.kind === 'tx' ? 'same-tx' : 'same-block'}</span>
                              <span className="br-ev-n">{ev.nWallets}w</span>
                              <span className="br-ev-amt">{fmtNum(ev.tokens)}</span>
                              {ev.txHash ? (
                                <a className="br-ev-link" href={explorerTxUrl(chain, ev.txHash)} target="_blank" rel="noreferrer">
                                  tx↗
                                </a>
                              ) : (
                                <span className="br-ev-link" />
                              )}
                            </div>
                          ))}
                        {!selected.events.length && <div className="br-empty">no coordinated events recorded</div>}
                      </div>
                    </div>
                    <div className="br-wallets">
                      <div className="br-subhead">wallets</div>
                      <div className="br-wallets-list">
                        <table className="br-table">
                          <thead>
                            <tr>
                              <th>address</th>
                              <th>bought</th>
                              <th>sold</th>
                              <th>bag</th>
                              <th>b/s</th>
                            </tr>
                          </thead>
                          <tbody>
                            {selected.wallets.map((w) => (
                              <tr key={w.address} className={w.isDev ? 'dev' : ''}>
                                <td>
                                  <a href={explorerAddressUrl(chain, w.address)} target="_blank" rel="noreferrer">
                                    {shortAddr(w.address)}
                                  </a>
                                  {w.isDev && <span className="br-dev-tag">DEV</span>}
                                </td>
                                <td className="buy">{fmtNum(w.bought)}</td>
                                <td className="sell">{fmtNum(w.sold)}</td>
                                <td>
                                  {fmtNum(w.bag)} {fmtUsd(w.bag, price) ? <em className="br-usd">{fmtUsd(w.bag, price)}</em> : null}
                                </td>
                                <td className="br-bs">
                                  {w.buys}/{w.sells}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="br-empty br-detail-empty">select a group on the left</div>
              )}
            </div>

          </div>
          <div className="br-panel br-feed-panel">
            <div className="br-panel-head">
              <h2>
                Live feed
                <span className={`br-live-dot ${liveRunning ? 'on' : ''}`} />
                <span className="br-sub">{liveRunning ? 'watching new transfers' : 'stopped'}</span>
              </h2>
              <div className="br-head-actions">
                <label className="br-check">
                  <input type="checkbox" checked={showAllLive} onChange={(e) => setShowAllLive(e.target.checked)} /> show ungrouped
                </label>
                <button className="br-btn" onClick={toggleLive}>
                  {liveRunning ? 'Stop' : 'Start'}
                </button>
              </div>
            </div>
            <div className="br-feed">
              {feed.map((f) => (
                <div key={f.key} className={`br-feed-row ${f.dir}`}>
                  <span className="br-feed-time">{timeAgo(f.time, nowTick)}</span>
                  {f.groupId ? (
                    <span className={`br-badge g${f.colorIdx}`}>{f.groupId}</span>
                  ) : (
                    <span className="br-badge none">—</span>
                  )}
                  <a className="br-feed-wallet" href={explorerAddressUrl(chain, f.wallet)} target="_blank" rel="noreferrer">
                    {shortAddr(f.wallet)}
                  </a>
                  <span className="br-feed-dir">{f.dir === 'buy' ? 'BUY' : 'SELL'}</span>
                  <span className="br-feed-amt">{fmtNum(f.tokens)}</span>
                  {fmtUsd(f.tokens, price) && <span className="br-feed-usd">{fmtUsd(f.tokens, price)}</span>}
                  <a className="br-feed-link" href={explorerTxUrl(chain, f.txHash)} target="_blank" rel="noreferrer">
                    tx↗
                  </a>
                </div>
              ))}
              {!feed.length && (
                <div className="br-empty">{liveRunning ? 'waiting for grouped wallets to trade…' : 'press Start to watch buys/sells'}</div>
              )}
            </div>
          </div>

        </>
      )}

    </div>
  );
}
// Daily net-flow bars (buys green up / sells red down) — the 建倉 → dump →
// rebuy phases read directly off the shape. Hover shows per-day values.
function TimelineBar({ timeline, big }) {
  const days = timeline.slice(-(big ? 60 : 30));
  if (!days.length) return null;
  const max = Math.max(...days.map((d) => Math.abs(d.net)), 1e-9);
  return (
    <div
      className={`br-tl ${big ? 'big' : ''}`}
      title={days.map((d) => `${d.day}: ${d.net >= 0 ? '+' : ''}${fmtNum(d.net)}`).join('\n')}
    >
      {days.map((d) => (
        <div
          key={d.day}
          className={`br-tl-bar ${d.net >= 0 ? 'up' : 'down'}`}
          style={{ height: `${Math.max(8, Math.round((Math.abs(d.net) / max) * 100))}%` }}
        />
      ))}
    </div>
  );
}

export default BundleRadar;


