import { useState, useEffect, useCallback } from 'react';
import './RhVolume.css';

const CHAINS = [
  { name: 'Robinhood Chain', short: 'RH Chain', color: 'orange' },
  { name: 'Solana', short: 'SOL', color: 'purple' },
  { name: 'Ethereum', short: 'ETH', color: 'blue' },
  { name: 'BSC', short: 'BSC', color: 'yellow' },
  { name: 'Base', short: 'BASE', color: 'green' },
];

const POLL_MS = 10 * 60 * 1000;
const MA_WINDOW = 7;

const colorVar = (c) =>
  ({
    orange: 'var(--accent-orange)',
    purple: 'var(--accent-purple)',
    blue: 'var(--accent-blue)',
    yellow: 'var(--accent-yellow)',
    green: 'var(--accent-green)',
  })[c] || 'var(--accent-blue)';

const formatUSD = (v) => {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
};

const formatPct = (v) => {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}%`;
};

const formatDate = (ts) =>
  new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

const average = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

const getSignal = (momentum) => {
  if (momentum === null) return { label: 'Gathering', tone: 'neutral' };
  if (momentum <= -25) return { label: 'Capital leaving', tone: 'danger' };
  if (momentum <= -5) return { label: 'Cooling off', tone: 'warn' };
  if (momentum <= 5) return { label: 'Holding steady', tone: 'neutral' };
  return { label: 'Growing', tone: 'good' };
};

const getMetrics = (chart) => {
  if (!chart || chart.length === 0) return null;
  const n = chart.length;
  const todayVol = chart[n - 1][1];
  const yestVol = n > 1 ? chart[n - 2][1] : null;
  const dayChange = yestVol ? ((todayVol - yestVol) / yestVol) * 100 : null;
  const avg7 = average(chart.slice(-7).map((p) => p[1]));
  const prevAvg7 = average(n > 7 ? chart.slice(-14, -7).map((p) => p[1]) : []);
  const avg30 = average(chart.slice(-30).map((p) => p[1]));
  const peak = Math.max(...chart.map((p) => p[1]));
  const peakIdx = chart.findIndex((p) => p[1] === peak);
  const momentum = avg7 != null && prevAvg7 ? ((avg7 - prevAvg7) / prevAvg7) * 100 : null;
  return {
    n, todayVol, dayChange, avg7, prevAvg7, avg30, peak, peakIdx,
    momentum, signal: getSignal(momentum),
  };
};

function RhVolume() {
  const [chains, setChains] = useState(() =>
    Object.fromEntries(CHAINS.map((c) => [c.name, { chart: null, breakdown: null, error: null }])),
  );
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [selectedChain, setSelectedChain] = useState('Robinhood Chain');
  const [chartMode, setChartMode] = useState('normalized');

  const fetchChain = useCallback(async (name) => {
    const res = await fetch(
      `https://api.llama.fi/overview/dexs/${encodeURIComponent(name)}?_t=${Date.now()}`,
      { cache: 'no-store' },
    );
    if (!res.ok) throw new Error(`${res.status}`);
    const json = await res.json();
    const chart = Array.isArray(json.totalDataChart) ? json.totalDataChart : [];
    const breakdown = Array.isArray(json.totalDataChartBreakdown) ? json.totalDataChartBreakdown : [];
    if (chart.length === 0) throw new Error('No data');
    return { chart, breakdown };
  }, []);

  const fetchAll = useCallback(async () => {
    setRefreshing(true);
    const results = await Promise.allSettled(CHAINS.map((c) => fetchChain(c.name)));
    setChains((prev) => {
      const next = {};
      CHAINS.forEach((c, i) => {
        const r = results[i];
        const prevC = prev[c.name];
        if (r.status === 'fulfilled') {
          next[c.name] = { chart: r.value.chart, breakdown: r.value.breakdown, error: null };
        } else {
          next[c.name] =
            prevC && prevC.chart
              ? { ...prevC }
              : { chart: null, breakdown: null, error: r.reason?.message || 'Failed' };
        }
      });
      return next;
    });
    setLastUpdated(new Date());
    setLoading(false);
    setRefreshing(false);
  }, [fetchChain]);

  useEffect(() => {
    fetchAll();
    const id = setInterval(fetchAll, POLL_MS);
    return () => clearInterval(id);
  }, [fetchAll]);

  // Per-chain metrics
  const metricsByName = {};
  for (const c of CHAINS) {
    const m = getMetrics(chains[c.name]?.chart);
    if (m) metricsByName[c.name] = m;
  }

  const loadedChains = CHAINS.filter((c) => chains[c.name]?.chart);

  // ---- Combined trend chart: common timestamp window across all chains ----
  const windows = (() => {
    if (loadedChains.length === 0) return [];
    const tsSets = loadedChains.map((c) => new Set(chains[c.name].chart.map((p) => p[0])));
    let common = tsSets[0];
    for (let i = 1; i < tsSets.length; i++) {
      common = new Set([...common].filter((t) => tsSets[i].has(t)));
    }
    return [...common].sort((a, b) => a - b);
  })();
  const wn = windows.length;

  // Per-chain series aligned to the window (index = vol / firstVol * 100).
  const series = loadedChains.map((c) => {
    const map = new Map(chains[c.name].chart.map((p) => [p[0], p[1]]));
    const base = (wn > 0 && map.get(windows[0])) || 1;
    return {
      chain: c,
      points: windows.map((ts) => {
        const vol = map.get(ts);
        return { ts, vol, idx: vol != null && base ? (vol / base) * 100 : null };
      }),
    };
  });

  const W = 1000;
  const H = 280;
  const padT = 10;
  const padB = 10;
  const plotH = H - padT - padB;
  const xAt = (i) => (wn > 1 ? (i / (wn - 1)) * W : 0);

  // Normalized geometry
  const maxIdx = Math.max(100, ...series.flatMap((s) => s.points.map((p) => p.idx || 0)));
  const ny = (v) => padT + plotH - (v / maxIdx) * plotH;

  // Absolute (log) geometry
  const allVols = series.flatMap((s) => s.points.map((p) => p.vol)).filter((v) => v > 0);
  const minLog = allVols.length ? Math.log10(Math.min(...allVols)) : 0;
  const maxLog = allVols.length ? Math.log10(Math.max(...allVols)) : 0;
  const logRange = maxLog - minLog || 1;
  const ly = (v) => (v > 0 ? padT + plotH - ((Math.log10(v) - minLog) / logRange) * plotH : padT + plotH);

  const absTicks = (() => {
    if (!allVols.length) return [];
    const ticks = [];
    let v = Math.pow(10, Math.floor(minLog));
    const top = Math.pow(10, maxLog);
    while (v <= top && ticks.length < 6) {
      if (v >= Math.pow(10, minLog)) ticks.push(v);
      v *= 10;
    }
    return ticks;
  })();

  const yOf = chartMode === 'absolute' ? ly : ny;
  const valOf = (p) => (chartMode === 'absolute' ? p.vol : p.idx);

  const xLabels = (() => {
    const want = Math.min(6, wn);
    const out = [];
    for (let k = 0; k < want; k++) {
      const i = wn > 1 ? Math.round((k / (want - 1)) * (wn - 1)) : 0;
      out.push({ i, label: formatDate(windows[i]) });
    }
    return out;
  })();

  const normTicks = maxIdx > 100 ? [0, 100, Math.round(maxIdx)] : [0, 50, 100];
  const yTicks = chartMode === 'absolute' ? absTicks : normTicks;
  const fmtYTick = (t) => (chartMode === 'absolute' ? formatUSD(t) : Math.round(t).toString());

  // ---- Per-chain detail (selected chain) ----
  const sel = chains[selectedChain];
  const selChart = sel?.chart ?? [];
  const selBreakdown = sel?.breakdown ?? [];
  const selMeta = CHAINS.find((c) => c.name === selectedChain);
  const selM = getMetrics(selChart) || {};
  const selN = selChart.length;

  const selMA = selChart.map((_, i) =>
    average(selChart.slice(Math.max(0, i - MA_WINDOW + 1), i + 1).map((p) => p[1])),
  );
  const selDex = (() => {
    const map = {};
    selBreakdown.slice(-7).forEach(([, dexes]) => {
      for (const [name, vol] of Object.entries(dexes || {})) map[name] = (map[name] || 0) + vol;
    });
    const total = Object.values(map).reduce((a, b) => a + b, 0) || 1;
    return Object.entries(map)
      .map(([name, vol]) => ({ name, vol, share: (vol / total) * 100 }))
      .sort((a, b) => b.vol - a.vol)
      .slice(0, 10);
  })();
  const selRecent = (() => {
    const start = Math.max(0, selN - 14);
    const out = [];
    for (let i = selN - 1; i >= start; i--) {
      const prev = i > 0 ? selChart[i - 1][1] : null;
      out.push({
        ts: selChart[i][0],
        vol: selChart[i][1],
        dayChange: prev ? ((selChart[i][1] - prev) / prev) * 100 : null,
        vsAvg: selM.avg7 != null ? ((selChart[i][1] - selM.avg7) / selM.avg7) * 100 : null,
      });
    }
    return out;
  })();

  const dW = 1000;
  const dH = 300;
  const dPadT = 12;
  const dPadB = 8;
  const dPlotH = dH - dPadT - dPadB;
  const dMaxV = selM.peak || 1;
  const dBarW = selN > 0 ? dW / selN : 0;
  const dY = (v) => dPadT + dPlotH - (v / dMaxV) * dPlotH;
  const dMaPoints = selMA
    .map((v, i) => (v == null ? null : `${i * dBarW + dBarW / 2},${dY(v)}`))
    .filter(Boolean)
    .join(' ');
  const dXLabels = (() => {
    const want = Math.min(6, selN);
    const out = [];
    for (let k = 0; k < want; k++) {
      const i = selN > 1 ? Math.round((k / (want - 1)) * (selN - 1)) : 0;
      out.push({ i, label: formatDate(selChart[i][0]) });
    }
    return out;
  })();
  const dYTicks = [1, 0.5, 0].map((f) => ({ f, value: f * dMaxV }));

  const cardToneClass = (tone) =>
    tone === 'danger'
      ? 'rhv-tone-danger'
      : tone === 'warn'
        ? 'rhv-tone-warn'
        : tone === 'good'
          ? 'rhv-tone-good'
          : 'rhv-tone-neutral';

  return (
    <div className="rhv">
      <div className="rhv-toolbar">
        <span className="rhv-source">
          <span className={`rhv-source-dot ${refreshing ? 'refreshing' : ''}`} />
          DefiLlama · DEX volume · {loadedChains.length}/{CHAINS.length} chains
        </span>
        <div className="rhv-stats">
          {lastUpdated && (
            <span className="rhv-stat">
              <span className="rhv-stat-label">Updated</span>
              <span className="rhv-stat-value">{lastUpdated.toLocaleTimeString()}</span>
            </span>
          )}
        </div>
        <button className="rhv-refresh" onClick={fetchAll} disabled={refreshing}>
          {refreshing ? '⟳' : '↻'} Refresh
        </button>
      </div>

      {loading ? (
        <div className="rhv-loading">Loading chain volumes…</div>
      ) : (
        <>
          {/* Chain momentum comparison cards */}
          <div className="rhv-chain-cards">
            {CHAINS.map((c) => {
              const m = metricsByName[c.name];
              const cd = chains[c.name];
              const isActive = selectedChain === c.name;
              return (
                <button
                  key={c.name}
                  className={`rhv-chain-card ${isActive ? 'active' : ''}`}
                  onClick={() => setSelectedChain(c.name)}
                  style={{ '--chain-color': colorVar(c.color) }}
                >
                  <div className="rhv-chain-card-top">
                    <span className="rhv-chain-dot" style={{ background: colorVar(c.color) }} />
                    <span className="rhv-chain-name">{c.short}</span>
                    <span className={`rhv-chain-signal ${cardToneClass(m?.signal.tone)}`}>
                      {m?.signal.label || '—'}
                    </span>
                  </div>
                  <div className="rhv-chain-vol">{m ? formatUSD(m.todayVol) : '…'}</div>
                  <div className="rhv-chain-mom">
                    {cd.error ? (
                      <span className="rhv-chain-err">load error</span>
                    ) : m?.momentum != null ? (
                      <span className={`diff-value ${m.momentum >= 0 ? 'positive' : 'negative'}`}>
                        {formatPct(m.momentum)} WoW
                      </span>
                    ) : (
                      <span className="rhv-chain-err">—</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
          {/* Combined trend chart */}
          <div className="rhv-chart-card">
            <div className="rhv-chart-head">
              <span className="rhv-chart-title">Relative volume trend</span>
              <div className="rhv-chart-controls">
                <div className="rhv-mode-toggle">
                  <button
                    className={chartMode === 'normalized' ? 'active' : ''}
                    onClick={() => setChartMode('normalized')}
                  >
                    Normalized
                  </button>
                  <button
                    className={chartMode === 'absolute' ? 'active' : ''}
                    onClick={() => setChartMode('absolute')}
                  >
                    Absolute (log)
                  </button>
                </div>
                <div className="rhv-legend">
                  {loadedChains.map((c) => (
                    <span className="rhv-legend-item" key={c.name}>
                      <span className="rhv-legend-line" style={{ background: colorVar(c.color) }} />
                      {c.short}
                    </span>
                  ))}
                </div>
              </div>
            </div>
            {wn < 2 ? (
              <div className="rhv-empty">Not enough overlapping data yet.</div>
            ) : (
              <div className="rhv-chart-body">
                <div className="rhv-yaxis">
                  {yTicks.map((t, i) => (
                    <span key={i} style={{ top: `${(yOf(t) / H) * 100}%` }}>
                      {fmtYTick(t)}
                    </span>
                  ))}
                </div>
                <div className="rhv-plot">
                  <svg className="rhv-chart-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
                    {yTicks.map((t, i) => (
                      <line
                        key={i}
                        x1={0}
                        y1={yOf(t)}
                        x2={W}
                        y2={yOf(t)}
                        stroke="var(--border-color)"
                        strokeWidth="1"
                        vectorEffect="non-scaling-stroke"
                      />
                    ))}
                    {chartMode === 'normalized' && (
                      <line
                        x1={0}
                        y1={ny(100)}
                        x2={W}
                        y2={ny(100)}
                        stroke="var(--text-muted)"
                        strokeWidth="1"
                        strokeDasharray="4 2"
                        vectorEffect="non-scaling-stroke"
                      />
                    )}
                    {series.map((s) => {
                      const pts = s.points
                        .map((p, i) =>
                          valOf(p) == null ? null : `${xAt(i)},${yOf(valOf(p))}`,
                        )
                        .filter(Boolean)
                        .join(' ');
                      const last = s.points[s.points.length - 1];
                      return (
                        <polyline
                          key={s.chain.name}
                          points={pts}
                          fill="none"
                          stroke={colorVar(s.chain.color)}
                          strokeWidth="2"
                          vectorEffect="non-scaling-stroke"
                        >
                          <title>{`${s.chain.short}: ${formatUSD(last?.vol)} latest`}</title>
                        </polyline>
                      );
                    })}
                  </svg>
                  <div className="rhv-xaxis">
                    {xLabels.map((l) => (
                      <span key={l.i} style={{ left: `${(l.i / (wn - 1)) * 100}%` }}>
                        {l.label}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}
            <div className="rhv-chart-note">
              {chartMode === 'normalized'
                ? 'Each chain indexed to 100 at the window start — slopes show relative momentum.'
                : 'Log scale so a $500M chain and a $5B chain are both visible.'}
            </div>
          </div>
          {/* Per-chain detail tabs */}
          <div className="rhv-detail-tabs">
            {CHAINS.map((c) => (
              <button
                key={c.name}
                className={`rhv-detail-tab ${selectedChain === c.name ? 'active' : ''}`}
                onClick={() => setSelectedChain(c.name)}
              >
                <span className="rhv-chain-dot" style={{ background: colorVar(c.color) }} />
                {c.short}
              </button>
            ))}
          </div>

          {sel?.error && !selChart.length ? (
            <div className="rhv-error">
              ⚠️ {selMeta.name}: {sel.error}
              <button onClick={fetchAll}>Retry</button>
            </div>
          ) : selN === 0 ? (
            <div className="rhv-loading">Loading {selMeta?.name}…</div>
          ) : (
            <>
              <div className={`rhv-signal rhv-signal-${selM.signal?.tone || 'neutral'}`}>
                <div className="rhv-signal-main">
                  <span className="rhv-signal-pulse" />
                  <div>
                    <div className="rhv-signal-label">{selMeta.name} — is money leaving?</div>
                    <div className="rhv-signal-answer">{selM.signal?.label || '—'}</div>
                  </div>
                </div>
                <div className="rhv-signal-desc">
                  {selM.momentum != null ? (
                    <>
                      7-day avg vs prior week:{' '}
                      <strong className={`diff-value ${selM.momentum >= 0 ? 'positive' : 'negative'}`}>
                        {formatPct(selM.momentum)}
                      </strong>
                    </>
                  ) : (
                    'Need 14+ days to measure the trend.'
                  )}
                </div>
              </div>

              <div className="rhv-cards">
                <div className="rhv-card">
                  <span className="rhv-card-label">Today (24h)</span>
                  <span className="rhv-card-value">{formatUSD(selM.todayVol)}</span>
                  {selM.dayChange != null && (
                    <span className={`rhv-card-sub ${selM.dayChange >= 0 ? 'positive' : 'negative'}`}>
                      {formatPct(selM.dayChange)} vs yesterday
                    </span>
                  )}
                </div>
                <div className="rhv-card">
                  <span className="rhv-card-label">7-day avg</span>
                  <span className="rhv-card-value">{formatUSD(selM.avg7)}</span>
                </div>
                <div className="rhv-card">
                  <span className="rhv-card-label">30-day avg</span>
                  <span className="rhv-card-value">{formatUSD(selM.avg30)}</span>
                </div>
                <div className="rhv-card">
                  <span className="rhv-card-label">All-time peak</span>
                  <span className="rhv-card-value">{formatUSD(selM.peak)}</span>
                  {selM.peakIdx >= 0 && (
                    <span className="rhv-card-sub">{formatDate(selChart[selM.peakIdx][0])}</span>
                  )}
                </div>
                <div className={`rhv-card ${cardToneClass(selM.signal?.tone)}`}>
                  <span className="rhv-card-label">WoW momentum</span>
                  <span className="rhv-card-value">{formatPct(selM.momentum)}</span>
                </div>
              </div>
              {/* Selected chain daily volume bar chart */}
              <div className="rhv-chart-card">
                <div className="rhv-chart-head">
                  <span className="rhv-chart-title">{selMeta.name} · daily volume</span>
                  <div className="rhv-legend">
                    <span className="rhv-legend-item">
                      <span className="rhv-swatch blue" /> Daily
                    </span>
                    <span className="rhv-legend-item">
                      <span className="rhv-swatch line" style={{ background: 'var(--accent-purple)' }} />
                      7d MA
                    </span>
                    <span className="rhv-legend-item">
                      <span className="rhv-swatch yellow" /> Peak
                    </span>
                  </div>
                </div>
                <div className="rhv-chart-body">
                  <div className="rhv-yaxis">
                    {dYTicks.map((t) => (
                      <span key={t.f} style={{ top: `${(1 - t.f) * 100}%` }}>
                        {formatUSD(t.value)}
                      </span>
                    ))}
                  </div>
                  <div className="rhv-plot">
                    <svg className="rhv-chart-svg" viewBox={`0 0 ${dW} ${dH}`} preserveAspectRatio="none">
                      {dYTicks.map((t) => (
                        <line
                          key={t.f}
                          x1={0}
                          y1={dY(t.value)}
                          x2={dW}
                          y2={dY(t.value)}
                          stroke="var(--border-color)"
                          strokeWidth="1"
                          vectorEffect="non-scaling-stroke"
                        />
                      ))}
                      {selChart.map((p, i) => {
                        const isPeak = i === selM.peakIdx;
                        const isToday = i === selN - 1;
                        const h = (p[1] / dMaxV) * dPlotH;
                        const fill = isToday
                          ? 'var(--accent-green)'
                          : isPeak
                            ? 'var(--accent-yellow)'
                            : 'var(--accent-blue)';
                        const opacity = isToday || isPeak ? 0.95 : 0.55;
                        return (
                          <rect
                            key={p[0]}
                            x={i * dBarW + dBarW * 0.15}
                            y={dPadT + dPlotH - h}
                            width={Math.max(dBarW * 0.7, 0.5)}
                            height={h}
                            fill={fill}
                            opacity={opacity}
                          >
                            <title>{`${formatDate(p[0])}: ${formatUSD(p[1])}`}</title>
                          </rect>
                        );
                      })}
                      {dMaPoints && (
                        <polyline
                          points={dMaPoints}
                          fill="none"
                          stroke="var(--accent-purple)"
                          strokeWidth="2"
                          vectorEffect="non-scaling-stroke"
                        />
                      )}
                    </svg>
                    <div className="rhv-xaxis">
                      {dXLabels.map((l) => (
                        <span key={l.i} style={{ left: `${((l.i + 0.5) / selN) * 100}%` }}>
                          {l.label}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
              <div className="rhv-grid">
                <div className="rhv-panel">
                  <div className="rhv-panel-head">
                    <h3>Top DEXs · last 7 days</h3>
                  </div>
                  {selDex.length === 0 ? (
                    <div className="rhv-empty">No protocol breakdown.</div>
                  ) : (
                    <table className="rhv-table">
                      <thead>
                        <tr>
                          <th>Protocol</th>
                          <th className="num">Volume</th>
                          <th className="num">Share</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selDex.map((d) => (
                          <tr key={d.name}>
                            <td className="rhv-dex-name">{d.name}</td>
                            <td className="num mono">{formatUSD(d.vol)}</td>
                            <td className="num">
                              <div className="rhv-share">
                                <div className="rhv-share-bar" style={{ width: `${d.share}%` }} />
                                <span className="rhv-share-val mono">{d.share.toFixed(1)}%</span>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                <div className="rhv-panel">
                  <div className="rhv-panel-head">
                    <h3>Recent days</h3>
                  </div>
                  <table className="rhv-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th className="num">Volume</th>
                        <th className="num">1D</th>
                        <th className="num">vs 7D avg</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selRecent.map((d) => (
                        <tr key={d.ts}>
                          <td>{formatDate(d.ts)}</td>
                          <td className="num mono">{formatUSD(d.vol)}</td>
                          <td className="num">
                            <span
                              className={`diff-value ${d.dayChange == null ? '' : d.dayChange >= 0 ? 'positive' : 'negative'}`}
                            >
                              {formatPct(d.dayChange)}
                            </span>
                          </td>
                          <td className="num">
                            <span
                              className={`diff-value ${d.vsAvg == null ? '' : d.vsAvg >= 0 ? 'positive' : 'negative'}`}
                            >
                              {formatPct(d.vsAvg)}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

export default RhVolume;






