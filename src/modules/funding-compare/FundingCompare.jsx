import { useState, useEffect, useCallback, useRef, Fragment } from 'react';
import './FundingCompare.css';

const ONDO_API = 'https://api.ondoperps.xyz/v1/perps/contracts?sparkline=false';
const VARIATIONAL_API = 'https://omni-client-api.prod.ap-northeast-1.variational.io/metadata/stats';
const HISTORY_KEY = 'funding-compare-history-v3';
const MAX_HISTORY_HOURS = 72;
const MAX_SNAPSHOTS = MAX_HISTORY_HOURS * 60;

// Legacy localStorage keys from earlier metric versions.
// v1 ('funding-compare-history') stored lastPrice - mark_price, a fair-value
// dislocation just like the current mid-to-mid metric → migrated below.
// v2 ('funding-compare-history-v2') stored the executable cross-spread →
// semantically incompatible → deliberately NOT migrated.
const LEGACY_HISTORY_KEYS = ['funding-compare-history'];

const migrateSnapshot = (s) => {
  if (!s || s.ts == null || typeof s.priceDiff !== 'number') return null;
  return {
    ts: s.ts,
    ondoMid: s.ondoMid ?? s.ondoPrice ?? null,
    varMid: s.varMid ?? s.varPrice ?? null,
    ondoFR: s.ondoFR ?? null,
    varFR: s.varFR ?? null,
    priceDiff: s.priceDiff,
  };
};

// Load current history and one-time migrate any compatible legacy snapshots
// (v1 lastPrice/mark_price) into the current key so old data isn't lost.
const loadHistory = (currentKey) => {
  let result = {};
  try {
    const cur = localStorage.getItem(currentKey);
    if (cur) {
      const parsed = JSON.parse(cur);
      if (parsed && typeof parsed === 'object') result = parsed;
    }
  } catch { /* ignore */ }

  let migratedAny = false;
  for (const legacyKey of LEGACY_HISTORY_KEYS) {
    try {
      const raw = localStorage.getItem(legacyKey);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') continue;

      for (const [base, snaps] of Object.entries(parsed)) {
        if (!Array.isArray(snaps)) continue;
        const migrated = snaps.map(migrateSnapshot).filter(Boolean);
        if (!migrated.length) continue;
        const existing = Array.isArray(result[base]) ? result[base] : [];
        const byTs = new Map();
        [...existing, ...migrated].forEach(s => byTs.set(s.ts, s));
        result[base] = [...byTs.values()].sort((a, b) => a.ts - b.ts).slice(-MAX_SNAPSHOTS);
      }
      migratedAny = true;
      localStorage.removeItem(legacyKey); // clean up once migrated
    } catch { /* ignore malformed legacy entry */ }
  }

  // Persist the merged result so nothing is lost if the tab closes before a poll.
  if (migratedAny) {
    try { localStorage.setItem(currentKey, JSON.stringify(result)); } catch { /* full */ }
  }
  return result;
};

function FundingCompare() {
  const [ondoContracts, setOndoContracts] = useState([]);
  const [variationalListings, setVariationalListings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [ondoError, setOndoError] = useState(null);
  const [varError, setVarError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [sortField, setSortField] = useState('zScore');
  const [sortDir, setSortDir] = useState('desc');
  const [searchQuery, setSearchQuery] = useState('');
  const [history, setHistory] = useState(() => loadHistory(HISTORY_KEY));
  const [selectedPair, setSelectedPair] = useState(null);
  const historyRef = useRef(history);

  const saveHistory = (newHistory) => {
    historyRef.current = newHistory;
    setHistory(newHistory);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(newHistory));
    } catch { /* localStorage full */ }
  };

  const fetchOndo = async () => {
    try {
      const res = await fetch(ONDO_API);
      if (!res.ok) throw new Error(`Ondo API: ${res.status}`);
      const data = await res.json();
      if (data.success) setOndoContracts(data.result);
      setOndoError(null);
    } catch (err) {
      setOndoError(err.message);
    }
  };

  const fetchVariational = async () => {
    try {
      const res = await fetch(`${VARIATIONAL_API}?_t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`Variational API: ${res.status}`);
      const data = await res.json();
      if (data.listings && Array.isArray(data.listings)) {
        setVariationalListings(data.listings);
        setVarError(null);
      } else {
        throw new Error('Unexpected response format');
      }
    } catch (err) {
      setVarError(err.message);
    }
  };

  const fetchData = useCallback(async () => {
    setLoading(true);
    await Promise.all([fetchOndo(), fetchVariational()]);
    setLastUpdated(new Date());
    setLoading(false);
  }, []);

  useEffect(() => {
    if (ondoContracts.length === 0 || variationalListings.length === 0) return;

    const now = Date.now();
    const newHistory = { ...historyRef.current };

    ondoContracts
      .filter(contract => parseFloat(contract.usdVolume) > 8000000 || contract.displayName?.includes('XAU'))
      .forEach(contract => {
      const base = contract.baseCurrency;
      const varData = variationalListings.find(l => l.ticker === base);
      if (!varData) return;

      // Live bid/ask from both venues → mid price (clean fair-value proxy,
      // free of spread-width noise). Var mark_price is often stale.
      const ondoBid = parseFloat(contract.bid);
      const ondoAsk = parseFloat(contract.ask);
      const varBid = parseFloat(varData.quotes?.base?.bid);
      const varAsk = parseFloat(varData.quotes?.base?.ask);
      if (!ondoBid || !ondoAsk || !varBid || !varAsk) return;

      const ondoMid = (ondoBid + ondoAsk) / 2;
      const varMid = (varBid + varAsk) / 2;

      // Funding rates normalized to per-hour: Ondo is 1h (decimal→%), Variational is 8h (→/8).
      const ondoFR = parseFloat(contract.nextFundingRate) * 100;
      const varFR = parseFloat(varData.funding_rate) / 8;

      // Mean-reversion signal: mid-to-mid difference, recorded over time so the
      // running mean/σ/z-score reflect fair-value dislocation, not spread noise.
      const priceDiff = ondoMid - varMid;

      if (!newHistory[base]) newHistory[base] = [];
      newHistory[base] = [...newHistory[base], {
        ts: now,
        ondoMid,
        varMid,
        ondoFR,
        varFR,
        priceDiff,
      }].slice(-MAX_SNAPSHOTS);
    });

    saveHistory(newHistory);
  }, [ondoContracts, variationalListings]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const getStats = (baseCurrency) => {
    const snapshots = history[baseCurrency];
    if (!snapshots || snapshots.length < 2) return null;

    const diffs = snapshots.map(s => s.priceDiff);
    const n = diffs.length;
    const mean = diffs.reduce((a, b) => a + b, 0) / n;
    const variance = diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
    const stdDev = Math.sqrt(variance);

    const ondoFRs = snapshots.map(s => s.ondoFR);
    const varFRs = snapshots.map(s => s.varFR);
    const frDiffs = ondoFRs.map((o, i) => o - varFRs[i]);
    const frMean = frDiffs.reduce((a, b) => a + b, 0) / n;
    const frVariance = frDiffs.reduce((a, b) => a + (b - frMean) ** 2, 0) / n;
    const frStdDev = Math.sqrt(frVariance);

    return { mean, stdDev, n, frMean, frStdDev };
  };

  const mergedData = ondoContracts
    .filter(contract => parseFloat(contract.usdVolume) > 8000000 || contract.displayName?.includes('XAU'))
    .map(contract => {
    const varData = variationalListings.find(l => l.ticker === contract.baseCurrency) || null;
    // Variational funding_rate is quoted per 8h (already in %) → normalize to per-hour.
    const varFundingRate = varData ? parseFloat(varData.funding_rate) : null;
    const varPerHour = varFundingRate !== null ? varFundingRate / 8 : null;
    // Ondo nextFundingRate is quoted per 1h in decimal → convert to %.
    const ondoPerHour = parseFloat(contract.nextFundingRate) * 100;

    // Live bid/ask from both venues → mid price (clean fair-value proxy).
    const ondoBid = parseFloat(contract.bid);
    const ondoAsk = parseFloat(contract.ask);
    const varBid = varData ? parseFloat(varData.quotes?.base?.bid) : null;
    const varAsk = varData ? parseFloat(varData.quotes?.base?.ask) : null;

    const ondoMid = (!isNaN(ondoBid) && !isNaN(ondoAsk)) ? (ondoBid + ondoAsk) / 2 : null;
    const varMid = (varBid !== null && varAsk !== null && !isNaN(varBid) && !isNaN(varAsk))
      ? (varBid + varAsk) / 2 : null;

    // Mean-reversion signal: mid-to-mid difference (scored by z-score below).
    const priceDiff = (ondoMid !== null && varMid !== null) ? ondoMid - varMid : null;

    const stats = getStats(contract.baseCurrency);
    const zScore = (stats && stats.stdDev > 0 && priceDiff !== null)
      ? (priceDiff - stats.mean) / stats.stdDev
      : null;

    // Reversion direction: which leg to LONG so we bet the gap reverts to mean.
    // ondoMid abnormally high vs norm (midDiff >= mean) → short Ondo / long Var.
    const ondoExpensive = priceDiff !== null
      ? (stats && stats.stdDev > 0 ? priceDiff >= stats.mean : priceDiff >= 0)
      : null;
    const arbDir = ondoExpensive === null ? null : (ondoExpensive ? 'var' : 'ondo');

    // Live tradeable entry spread for the indicated direction (cross both books).
    // Usually negative = net cost to put the trade on; needs reversion beyond
    // this amount + fees to profit. Not stored — only a live entry check.
    let tradeableSpread = null;
    if (arbDir === 'var') tradeableSpread = ondoBid - varAsk;       // sell Ondo@bid, buy Var@ask
    else if (arbDir === 'ondo') tradeableSpread = varBid - ondoAsk; // buy Ondo@ask, sell Var@bid

    return {
      market: contract.market,
      baseCurrency: contract.baseCurrency,
      displayName: contract.displayName,
      ondoNextFundingRate: parseFloat(contract.nextFundingRate),
      ondoPerHour,
      variationalFundingRate: varPerHour,
      ondoBid,
      ondoAsk,
      varBid,
      varAsk,
      ondoMid,
      varMid,
      priceDiff,
      tradeableSpread,
      arbDir,
      zScore,
      hasVariational: !!varData,
      stats,
    };
  });

  let filtered = mergedData.filter(d => d.hasVariational);
  if (searchQuery) {
    const q = searchQuery.toUpperCase();
    filtered = filtered.filter(d =>
      d.baseCurrency.includes(q) || d.displayName.includes(q) || d.market.includes(q)
    );
  }

  const sorted = [...filtered].sort((a, b) => {
    let va, vb;
    switch (sortField) {
      case 'baseCurrency':
        va = a.baseCurrency; vb = b.baseCurrency;
        return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
      case 'ondoFundingRate':
        va = a.ondoPerHour; vb = b.ondoPerHour;
        break;
      case 'variationalFundingRate':
        va = a.variationalFundingRate ?? -Infinity; vb = b.variationalFundingRate ?? -Infinity;
        break;
      case 'priceDiff':
        va = a.priceDiff ?? Infinity; vb = b.priceDiff ?? Infinity;
        break;
      case 'zScore':
        va = Math.abs(a.zScore ?? 0); vb = Math.abs(b.zScore ?? 0);
        break;
      default:
        va = a.baseCurrency; vb = b.baseCurrency;
        return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    }
    return sortDir === 'asc' ? va - vb : vb - va;
  });

  const toggleSort = (field) => {
    if (sortField === field) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const formatRate = (val) => {
    if (val === null || val === undefined) return '—';
    const abs = Math.abs(val);
    if (abs >= 10) return val.toFixed(2) + '%';
    if (abs >= 1) return val.toFixed(3) + '%';
    if (abs >= 0.01) return val.toFixed(4) + '%';
    return val.toFixed(5) + '%';
  };

  const formatBook = (bid, ask) => {
    if (bid === null || ask === null || isNaN(bid) || isNaN(ask)) return '—';
    const f = (v) => {
      if (v >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
      if (v >= 1) return v.toFixed(4);
      return v.toFixed(6);
    };
    return `$${f(ask)} / ${f(bid)}`;
  };

  const formatDiff = (val) => {
    if (val === null || val === undefined) return '—';
    const abs = Math.abs(val);
    const sign = val >= 0 ? '+' : '';
    if (abs >= 100) return sign + val.toFixed(2);
    if (abs >= 1) return sign + val.toFixed(4);
    return sign + val.toFixed(6);
  };

  const formatZScore = (val) => {
    if (val === null || val === undefined) return '—';
    return val.toFixed(2);
  };

  const getZScoreColor = (z) => {
    if (z === null) return 'var(--text-secondary)';
    const abs = Math.abs(z);
    if (abs >= 2) return 'var(--accent-red)';
    if (abs >= 1.5) return 'var(--accent-yellow)';
    return 'var(--text-secondary)';
  };

  const getSortIcon = (field) => {
    if (sortField !== field) return '↕';
    return sortDir === 'asc' ? '↑' : '↓';
  };

  const variationalCount = mergedData.filter(d => d.hasVariational).length;

  const clearHistory = () => saveHistory({});

  const getChartData = (baseCurrency) => {
    const snapshots = history[baseCurrency];
    if (!snapshots || snapshots.length === 0) return null;
    return snapshots;
  };

  const renderDetailChart = (base) => {
        const chartData = getChartData(base);
        if (!chartData || chartData.length === 0) return null;
        const stats = getStats(base);
        const latest = chartData[chartData.length - 1];
        const chartWidth = 600;
        const chartHeight = 120;
        const pad = 10;
        const xAt = (i) => chartData.length > 1 ? (i / (chartData.length - 1)) * chartWidth : 0;

        // --- Price (mid-diff) chart geometry ---
        const diffs = chartData.map(s => s.priceDiff);
        const minDiff = Math.min(...diffs);
        const maxDiff = Math.max(...diffs);
        const range = maxDiff - minDiff || 1;
        const priceZ = stats && stats.stdDev > 0 ? (latest.priceDiff - stats.mean) / stats.stdDev : null;

        // --- Funding-rate chart geometry (both series on a shared axis) ---
        const allFR = chartData.flatMap(s => [s.ondoFR, s.varFR]).filter(Number.isFinite);
        const minFR = Math.min(...allFR, 0);
        const maxFR = Math.max(...allFR, 0);
        const frRange = (maxFR - minFR) || 1;
        const frY = (v) => pad + chartHeight - ((v - minFR) / frRange) * chartHeight;
        const frNow = latest.ondoFR - latest.varFR;

        return (
          <div className="fc-detail-panel">
            <div className="fc-detail-header">
              <h3>{base}/USD</h3>
              <button className="fc-detail-close" onClick={() => setSelectedPair(null)}>✕</button>
            </div>
            <div className="fc-detail-charts">
              <div className="fc-chart-block">
                <div className="fc-chart-title">Mid Diff (Price)</div>
                <div className="fc-detail-stats">
                  <span>Now: <strong>{formatDiff(latest.priceDiff)}</strong></span>
                  <span>Mean: <strong>{stats ? formatDiff(stats.mean) : '—'}</strong></span>
                  <span>σ: <strong>{stats ? stats.stdDev.toFixed(stats.stdDev >= 1 ? 2 : 6) : '—'}</strong></span>
                  <span>Z: <strong style={{ color: getZScoreColor(priceZ) }}>{priceZ !== null ? formatZScore(priceZ) : '—'}</strong></span>
                  <span>N: <strong>{chartData.length}</strong></span>
                  <span>Since: <strong>{new Date(chartData[0].ts).toLocaleString()}</strong></span>
                </div>
                <svg className="fc-chart" viewBox={`0 0 ${chartWidth} ${chartHeight + pad * 2}`} preserveAspectRatio="none">
              {stats && (
                <line
                  x1={0} y1={pad + chartHeight - ((stats.mean - minDiff) / range) * chartHeight}
                  x2={chartWidth} y2={pad + chartHeight - ((stats.mean - minDiff) / range) * chartHeight}
                  stroke="var(--accent-yellow)" strokeWidth="1" strokeDasharray="4 2" vectorEffect="non-scaling-stroke"
                />
              )}
              {stats && stats.stdDev > 0 && (
                <>
                  <rect
                    x={0}
                    y={pad + chartHeight - ((stats.mean + 2 * stats.stdDev - minDiff) / range) * chartHeight}
                    width={chartWidth}
                    height={Math.abs(((4 * stats.stdDev) / range) * chartHeight)}
                    fill="rgba(248, 81, 73, 0.08)"
                  />
                  <line
                    x1={0} y1={pad + chartHeight - ((stats.mean + 2 * stats.stdDev - minDiff) / range) * chartHeight}
                    x2={chartWidth} y2={pad + chartHeight - ((stats.mean + 2 * stats.stdDev - minDiff) / range) * chartHeight}
                    stroke="var(--accent-red)" strokeWidth="0.5" strokeDasharray="2 2" vectorEffect="non-scaling-stroke"
                  />
                  <line
                    x1={0} y1={pad + chartHeight - ((stats.mean - 2 * stats.stdDev - minDiff) / range) * chartHeight}
                    x2={chartWidth} y2={pad + chartHeight - ((stats.mean - 2 * stats.stdDev - minDiff) / range) * chartHeight}
                    stroke="var(--accent-red)" strokeWidth="0.5" strokeDasharray="2 2" vectorEffect="non-scaling-stroke"
                  />
                </>
              )}
              <polyline
                fill="none"
                stroke="var(--accent-blue, #58a6ff)"
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
                points={chartData.map((s, i) => {
                  const x = (i / (chartData.length - 1)) * chartWidth;
                  const y = pad + chartHeight - ((s.priceDiff - minDiff) / range) * chartHeight;
                  return `${x},${y}`;
                }).join(' ')}
              />
              <circle
                cx={chartWidth}
                cy={pad + chartHeight - ((latest.priceDiff - minDiff) / range) * chartHeight}
                r={3}
                fill="var(--accent-blue, #58a6ff)"
              />
            </svg>
                <div className="fc-detail-legend">
                  <span className="legend-item"><span className="legend-line blue" /> Mid Diff</span>
                  <span className="legend-item"><span className="legend-line yellow" /> Mean</span>
                  <span className="legend-item"><span className="legend-line red" /> ±2σ</span>
                </div>
              </div>

              <div className="fc-chart-block">
                <div className="fc-chart-title">Funding Rate /hr</div>
                <div className="fc-detail-stats">
                  <span>Ondo: <strong style={{ color: 'var(--accent-green)' }}>{formatRate(latest.ondoFR)}</strong></span>
                  <span>Var: <strong style={{ color: 'var(--accent-purple)' }}>{formatRate(latest.varFR)}</strong></span>
                  <span>Δ Now: <strong className={`diff-value ${frNow >= 0 ? 'positive' : 'negative'}`}>{formatRate(frNow)}</strong></span>
                  <span>Δ Mean: <strong>{stats ? formatRate(stats.frMean) : '—'}</strong></span>
                  <span>Δ σ: <strong>{stats ? formatRate(stats.frStdDev) : '—'}</strong></span>
                </div>
                <svg className="fc-chart" viewBox={`0 0 ${chartWidth} ${chartHeight + pad * 2}`} preserveAspectRatio="none">
                  <line
                    x1={0} y1={frY(0)} x2={chartWidth} y2={frY(0)}
                    stroke="var(--text-muted)" strokeWidth="0.5" vectorEffect="non-scaling-stroke"
                  />
                  <polyline
                    fill="none" stroke="var(--accent-green)" strokeWidth="1.5" vectorEffect="non-scaling-stroke"
                    points={chartData.map((s, i) => `${xAt(i)},${frY(s.ondoFR)}`).join(' ')}
                  />
                  <polyline
                    fill="none" stroke="var(--accent-purple)" strokeWidth="1.5" vectorEffect="non-scaling-stroke"
                    points={chartData.map((s, i) => `${xAt(i)},${frY(s.varFR)}`).join(' ')}
                  />
                  <circle cx={chartWidth} cy={frY(latest.ondoFR)} r={3} fill="var(--accent-green)" />
                  <circle cx={chartWidth} cy={frY(latest.varFR)} r={3} fill="var(--accent-purple)" />
                </svg>
                <div className="fc-detail-legend">
                  <span className="legend-item"><span className="legend-line green" /> Ondo FR</span>
                  <span className="legend-item"><span className="legend-line purple" /> Var FR</span>
                  <span className="legend-item"><span className="legend-line muted" /> Zero</span>
                </div>
              </div>
            </div>
          </div>
        );
      };

  return (
    <div className="funding-compare">
      <div className="fc-toolbar">
        <div className="fc-search">
          <span className="fc-search-icon">🔍</span>
          <input
            type="text"
            placeholder="Search pairs..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="fc-search-input"
          />
        </div>
        <div className="fc-stats">
          <span className="fc-stat">
            <span className="fc-stat-label">Pairs</span>
            <span className="fc-stat-value">{variationalCount}</span>
          </span>
          {lastUpdated && (
            <span className="fc-stat">
              <span className="fc-stat-label">Updated</span>
              <span className="fc-stat-value">{lastUpdated.toLocaleTimeString()}</span>
            </span>
          )}
          <span className="fc-stat">
            <span className="fc-stat-label">History</span>
            <span className="fc-stat-value">
              {Object.keys(history).length > 0
                ? `${Object.values(history)[0]?.length || 0} pts`
                : '—'}
            </span>
          </span>
        </div>
        <button className="fc-refresh" onClick={fetchData} disabled={loading}>
          {loading ? '⟳' : '↻'} Refresh
        </button>
        <button className="fc-clear" onClick={clearHistory}>
          🗑 Clear History
        </button>
      </div>

      {ondoError && (
        <div className="fc-error">
          ⚠️ Ondo: {ondoError}
          <button onClick={fetchData}>Retry</button>
        </div>
      )}
      {varError && (
        <div className="fc-error var-error">
          ⚠️ Variational: {varError}
          <button onClick={fetchData}>Retry</button>
        </div>
      )}

      {(() => {
        const alerts = sorted.filter(row => {
          if (Math.abs(row.ondoPerHour) > 0.1) return true;
          if (row.hasVariational && Math.abs(row.variationalFundingRate) > 0.1) return true;
          return false;
        });
        if (alerts.length === 0) return null;
        return (
          <div className="fc-alert-banner">
            <span className="fc-alert-icon">⚠️</span>
            <span className="fc-alert-text">
              High funding rate: {alerts.map(row => {
                const worst = Math.abs(row.ondoPerHour) > Math.abs(row.variationalFundingRate) ? row.ondoPerHour : row.variationalFundingRate;
                return (
                  <span key={row.market} className={`fc-alert-pair ${worst >= 0 ? 'positive' : 'negative'}`}>
                    {row.baseCurrency} ({worst >= 0 ? '+' : ''}{formatRate(worst)})
                  </span>
                );
              })}
            </span>
          </div>
        );
      })()}

      {(() => {
        const arbAlerts = sorted.filter(row => row.zScore !== null && Math.abs(row.zScore) >= 2);
        if (arbAlerts.length === 0) return null;
        return (
          <div className="fc-alert-banner fc-arb-alert">
            <span className="fc-alert-icon">💰</span>
            <div className="fc-arb-list">
              {arbAlerts.map(row => {
                const longLeg = row.arbDir === 'ondo' ? 'Ondo' : 'Var';
                const shortLeg = row.arbDir === 'ondo' ? 'Var' : 'Ondo';
                return (
                  <div key={row.market} className="fc-arb-card">
                    <span className="fc-arb-pair">{row.baseCurrency}</span>
                    <span className="fc-arb-z">(Z={formatZScore(row.zScore)})</span>
                    <span className="fc-arb-signal">
                      <span className="fc-signal-long">Long {longLeg}</span>
                      <span className="fc-arb-divider">/</span>
                      <span className="fc-signal-short">Short {shortLeg}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {loading && ondoContracts.length === 0 ? (
        <div className="fc-loading">
          <div className="fc-spinner"></div>
          <p>Loading funding rates from both platforms...</p>
        </div>
      ) : (
        <div className="fc-table-wrapper">
          <table className="fc-table">
            <thead>
              <tr>
                <th onClick={() => toggleSort('baseCurrency')} className="sortable">
                  Pair {getSortIcon('baseCurrency')}
                </th>
                <th onClick={() => toggleSort('ondoFundingRate')} className="sortable">
                  Ondo FR/hr {getSortIcon('ondoFundingRate')}
                </th>
                <th onClick={() => toggleSort('variationalFundingRate')} className="sortable">
                  Var FR/hr {getSortIcon('variationalFundingRate')}
                </th>
                <th>Ondo Ask/Bid</th>
                <th>Var Ask/Bid</th>
                <th onClick={() => toggleSort('priceDiff')} className="sortable">
                  Mid Diff {getSortIcon('priceDiff')}
                </th>
                <th>Entry</th>
                <th>Signal</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(row => {
                const isSelected = selectedPair === row.baseCurrency;
                return (
                  <Fragment key={row.market}>
                  <tr
                    className={`var-row${isSelected ? ' selected' : ''}${Math.abs(row.zScore ?? 0) >= 2 ? ' arb-opportunity' : ''}`}
                    onClick={() => setSelectedPair(isSelected ? null : row.baseCurrency)}
                  >
                    <td className="pair-cell">
                      <span className="pair-base">{row.baseCurrency}</span>
                      <span className="pair-quote">/USD</span>
                      {row.displayName?.includes('RWA') && (
                        <span className="pair-badge rwa">RWA</span>
                      )}
                    </td>
                    <td className="rate-cell">
                      <span className={`rate-value ${row.ondoPerHour >= 0 ? 'positive' : 'negative'}`}>
                        {formatRate(row.ondoPerHour)}
                      </span>
                    </td>
                    <td className="rate-cell">
                      {row.variationalFundingRate === null ? (
                        <span className="rate-na">—</span>
                      ) : (
                        <span className={`rate-value ${row.variationalFundingRate >= 0 ? 'positive' : 'negative'}`}>
                          {formatRate(row.variationalFundingRate)}
                        </span>
                      )}
                    </td>
                    <td className="price-cell">{formatBook(row.ondoBid, row.ondoAsk)}</td>
                    <td className="price-cell">{formatBook(row.varBid, row.varAsk)}</td>
                    <td className="diff-cell">
                      {row.priceDiff !== null ? (
                        <span className={`diff-value ${row.priceDiff >= 0 ? 'positive' : 'negative'}`}>
                          {formatDiff(row.priceDiff)}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="diff-cell">
                      {row.tradeableSpread !== null ? (
                        <span className={`diff-value ${row.tradeableSpread >= 0 ? 'positive' : 'negative'}`}>
                          {formatDiff(row.tradeableSpread)}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="signal-cell">
                      {row.zScore !== null && Math.abs(row.zScore) >= 2 ? (
                        <span className="fc-signal-badge">
                          {(() => {
                            const longLeg = row.arbDir === 'ondo' ? 'Ondo' : 'Var';
                            const shortLeg = row.arbDir === 'ondo' ? 'Var' : 'Ondo';
                            return (
                              <>
                                <span className="fc-signal-long">
                                  ↗ Long {longLeg}
                                </span>
                                <span className="fc-signal-short">
                                  ↘ Short {shortLeg}
                                </span>
                              </>
                            );
                          })()}
                        </span>
                      ) : row.zScore !== null ? (
                        <span className="fc-signal-neutral">Neutral</span>
                      ) : '—'}
                    </td>
                  </tr>
                  {isSelected && (
                    <tr className="fc-detail-row">
                      <td colSpan={8}>{renderDetailChart(row.baseCurrency)}</td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

    </div>
  );
}

export default FundingCompare;
