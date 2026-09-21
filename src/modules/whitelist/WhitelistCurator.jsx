// Whitelist Curator page: pick saved wallets, call deposit() on a whitelist/
// points contract with growing random ETH amounts. The contract refunds every
// deposit, so each wallet only spends gas per tx. Ethereum mainnet only
// (fixed chain) — amounts per the curator game: first send floored at 0.05
// ETH, each next = previous ×1.10–1.30 plus a guaranteed +0.1 (one wallet
// selected at a time; expected per-tx list shown on the page).
import { useEffect, useMemo, useRef, useState } from 'react';
import { ethers } from 'ethers';
import { mintChainById, makeRpc, feePlan } from '../nft-mint/mint.js';
import { getWallets, subscribeWallets } from '../wallets/store';
import { transferGasLimit } from '../wallets/transfer.js';
import { runCuration, planSends, DEFAULT_PARAMS, DEFAULT_CONTRACT, DEPOSIT_DATA, MAX_SENDS_PER_WALLET, MIN_FIRST_ETH, MIN_GROW_ETH, expectedSends } from './curate.js';
import './WhitelistCurator.css';

const CHAIN = mintChainById('eth'); // Ethereum mainnet, fixed
const shortAddr = (a) => `${a.slice(0, 8)}…${a.slice(-6)}`;
const fmtNative = (wei) => {
  try {
    return Number(ethers.formatEther(wei)).toFixed(4).replace(/\.?0+$/, '') || '0';
  } catch {
    return '—';
  }
};

function WhitelistCurator() {
  const [wallets, setWallets] = useState(() => getWallets());
  const [contractStr, setContractStr] = useState(DEFAULT_CONTRACT);
  const [picked, setPicked] = useState(() => new Set());
  const [firstMin, setFirstMin] = useState(String(DEFAULT_PARAMS.firstMin));
  const [firstMax, setFirstMax] = useState(String(DEFAULT_PARAMS.firstMax));
  const [growMin, setGrowMin] = useState(String(DEFAULT_PARAMS.growMinPct));
  const [growMax, setGrowMax] = useState(String(DEFAULT_PARAMS.growMaxPct));
  const [balances, setBalances] = useState({}); // address → wei hex
  const [feeInfo, setFeeInfo] = useState(null); // { gasCostWei }
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState([]);
  const [msg, setMsg] = useState('');
  const abortRef = useRef({ current: false });
  const logRef = useRef(null);

  useEffect(() => subscribeWallets(setWallets), []);
  useEffect(() => {
    const ids = new Set(wallets.map((w) => w.id));
    setPicked((prev) => {
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [wallets]);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const contractAddr = useMemo(() => {
    const t = contractStr.trim();
    return ethers.isAddress(t) ? ethers.getAddress(t) : null;
  }, [contractStr]);

  const params = useMemo(
    () => ({
      // Engine floors sends at the 0.05 ETH game minimum; clamp here too so
      // previews/confirms show the amounts that will actually go out.
      firstMin: Math.max(Number(firstMin) || 0, MIN_FIRST_ETH),
      firstMax: Math.max(Number(firstMax) || 0, MIN_FIRST_ETH),
      growMinPct: Number(growMin) || 0,
      growMaxPct: Number(growMax) || 0,
    }),
    [firstMin, firstMax, growMin, growMax],
  );

  const refresh = async () => {
    setMsg('');
    const call = makeRpc(CHAIN);
    const entries = await Promise.all(
      wallets.map(async (w) => {
        try {
          return [w.address, await call('eth_getBalance', [w.address, 'latest'])];
        } catch {
          return [w.address, null];
        }
      }),
    );
    setBalances(Object.fromEntries(entries));
    try {
      const fees = await feePlan(call, CHAIN);
      // deposit() runs contract code (bookkeeping + refund), so estimate with
      // the real calldata and a typical first value — well over a plain 21k
      // send. Without a valid contract yet, fall back to a plain-send estimate.
      const from = wallets[0]?.address || ethers.ZeroAddress;
      const gasLimit = contractAddr
        ? await transferGasLimit(
            call,
            from,
            contractAddr,
            DEPOSIT_DATA,
            ethers.parseEther(String(Math.min(params.firstMin, params.firstMax) || 0)),
          )
        : await transferGasLimit(call, from, wallets[1]?.address || ethers.ZeroAddress);
      setFeeInfo({ gasCostWei: gasLimit * fees.maxFee });
    } catch {
      setFeeInfo(null);
    }
  };

  useEffect(() => {
    if (wallets.length) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallets.length, contractAddr]);
/* PART2 */
  const movers = wallets.filter((w) => picked.has(w.id));
  const preview = useMemo(
    () =>
      feeInfo == null
        ? null
        : movers.map((w) => {
            const bal = balances[w.address];
            const plan = bal == null ? null : planSends(BigInt(bal), feeInfo.gasCostWei, params);
            return { w, bal, plan };
          }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [movers, balances, feeInfo, params],
  );

  const plannedTotals = useMemo(() => {
    if (!preview) return { n: 0, total: 0n, gas: 0n, minSends: 0, maxSends: 0 };
    let total = 0n; // total deposited (refunded) — the real spend is gas only
    let txs = 0;
    let minSends = Infinity;
    let maxSends = 0;
    let n = 0;
    for (const row of preview) {
      if (!row.plan || row.plan.sends.length === 0) continue;
      n += 1;
      total += row.plan.sends.reduce((s, v) => s + v, 0n);
      txs += row.plan.sends.length;
      minSends = Math.min(minSends, row.plan.sends.length);
      maxSends = Math.max(maxSends, row.plan.sends.length);
    }
    return { n, total, gas: feeInfo ? feeInfo.gasCostWei * BigInt(txs) : 0n, minSends: minSends === Infinity ? 0 : minSends, maxSends };
  }, [preview, feeInfo]);

  const run = async () => {
    setMsg('');
    if (!contractAddr || !movers.length) return;
    const summary =
      `Curate ${movers.length} wallet${movers.length === 1 ? '' : 's'} on Ethereum?\n\n` +
      `Each calls deposit() on ${shortAddr(contractAddr)} with a growing ETH value:\n` +
      `first ${params.firstMin}–${params.firstMax} ETH, every next = previous ×${(1 + params.growMinPct / 100).toFixed(2)}–${(1 + params.growMaxPct / 100).toFixed(2)} + ${MIN_GROW_ETH}.\n` +
      `The contract refunds every deposit, so wallets only spend gas.\n\n` +
      `Live plan ≈ ${plannedTotals.n} wallet(s), ${plannedTotals.minSends}${plannedTotals.maxSends !== plannedTotals.minSends ? `–${plannedTotals.maxSends}` : ''} txs each, deposits ≈ ${fmtNative(plannedTotals.total)} ETH (refunded), gas ≈ ${fmtNative(plannedTotals.gas)} ETH. Amounts re-roll live.`;
    if (!window.confirm(summary)) return;

    setRunning(true);
    abortRef.current.current = false;
    setLog([]);
    const onEvent = (ev) => setLog((l) => [...l, { ...ev, ts: Date.now() }]);
    try {
      await runCuration({
        chain: CHAIN,
        wallets: movers,
        contractAddress: contractAddr,
        params,
        onEvent,
        abortRef: abortRef.current,
      });
    } catch (err) {
      setMsg(err?.message || String(err));
    } finally {
      setRunning(false);
      refresh();
    }
  };

  const canRun = !running && Boolean(contractAddr) && movers.length > 0 && Boolean(preview?.some((r) => r.plan?.sends.length > 0));
/* PART3 */
  const numField = (label, value, set, title) => (
    <label className="wlc-field" title={title}>
      <span>{label}</span>
      <input
        className="wlc-input mono"
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => set(e.target.value)}
        disabled={running}
      />
    </label>
  );

  return (
    <div className="wlc">
      <div className="wlc-head">
        <h3>🎟️ Whitelist Curator · Ethereum</h3>
        <button className="wlc-btn mini" type="button" onClick={refresh} disabled={running || !wallets.length}>
          ⟲ balances
        </button>
      </div>

      <div className="wlc-row">
        <label className="wlc-field wlc-grow" title="Whitelist / points contract — plain ETH sends, no calldata">
          <span>curator contract</span>
          <input
            className="wlc-input mono"
            type="text"
            placeholder="0x…"
            value={contractStr}
            onChange={(e) => setContractStr(e.target.value)}
            disabled={running}
          />
        </label>
        {numField('first min', firstMin, setFirstMin, `First send: random between min and max (ETH) — floored at ${MIN_FIRST_ETH}, the game minimum`)}
        {numField('first max', firstMax, setFirstMax, `First send: random between min and max (ETH) — floored at ${MIN_FIRST_ETH}, the game minimum`)}
        {numField('grow min %', growMin, setGrowMin, `Every next send = previous × (1 + random min–max %) + ${MIN_GROW_ETH} ETH guaranteed`)}
        {numField('grow max %', growMax, setGrowMax, `Every next send = previous × (1 + random min–max %) + ${MIN_GROW_ETH} ETH guaranteed`)}
        <span className="wlc-check" title="The contract refunds every deposit — each tx only costs gas">
          deposit() — ETH refunded, gas only
        </span>
      </div>

      <p className="wlc-strategy">
        Strategy: the picked wallet calls deposit() with a growing value — first random {params.firstMin}–{params.firstMax} ETH (floored at
        {' '}{MIN_FIRST_ETH}), every next = previous ×{(1 + params.growMinPct / 100).toFixed(2)}–{(1 + params.growMaxPct / 100).toFixed(2)} +
        {' '}{MIN_GROW_ETH} guaranteed (e.g. 0.05 → 0.155–0.165 → 0.27–0.31). The contract refunds each deposit, so the wallet only pays gas
        per tx and keeps going until the next amount no longer fits its balance momentarily (hard cap {MAX_SENDS_PER_WALLET} sends).
        Sequential, receipt-confirmed, one tx at a time, 5s pause after each confirmation. Amounts re-roll for every run.
      </p>

      {contractStr.trim() !== '' && !contractAddr && <div className="wlc-msg err">Not a valid contract address.</div>}
      {(Number(firstMin) < MIN_FIRST_ETH || Number(firstMax) < MIN_FIRST_ETH) && (
        <div className="wlc-msg err">First amount is below the game floor — every deposit is sent at ≥ {MIN_FIRST_ETH} ETH.</div>
      )}

      <div className="wlc-list">
        <div className="wlc-list-head">
          <h4>Wallet ({movers.length}/{wallets.length}) — pick one at a time</h4>
          <button className="wlc-btn mini" type="button" onClick={() => setPicked(new Set())} disabled={running || movers.length === 0}>
            clear
          </button>
        </div>
        {wallets.length === 0 ? (
          <div className="wlc-empty">No saved wallets — add them on the Wallets page first.</div>
        ) : (
          wallets.map((w) => {
            const bal = balances[w.address];
            return (
              <label key={w.id} className={`wlc-item${picked.has(w.id) ? ' on' : ''}`}>
                <input
                  type="checkbox"
                  checked={picked.has(w.id)}
                  onChange={() => setPicked((prev) => (prev.has(w.id) ? new Set() : new Set([w.id])))}
                  disabled={running}
                />
                <span className="wlc-item-label">{w.label || 'unlabeled'}</span>
                <span className="mono wlc-item-addr">{shortAddr(w.address)}</span>
                <span className={`mono wlc-item-bal${bal != null && BigInt(bal) === 0n ? ' zero' : ''}`}>
                  {bal != null ? `${fmtNative(bal)} ETH` : '—'}
                </span>
              </label>
            );
          })
        )}
      </div>

      {preview && movers.length > 0 && (
        <table className="wlc-preview">
          <thead>
            <tr>
              <th>Wallet</th>
              <th>Balance</th>
              <th>Sends</th>
              <th>First</th>
              <th>Last</th>
              <th>Deposits ≈</th>
              <th>Left</th>
            </tr>
          </thead>
          <tbody>
            {preview.map(({ w, bal, plan }) => {
              const s = plan?.sends || [];
              return (
                <tr key={w.id} title={s.length ? s.map((v) => fmtNative(v)).join(' → ') : ''}>
                  <td>{w.label || shortAddr(w.address)}</td>
                  <td className="mono">{bal != null ? fmtNative(bal) : '—'}</td>
                  <td className="mono">
                    {s.length ? s.length : plan?.stopped === 'cant-start' ? '— too low' : '—'}
                  </td>
                  <td className="mono">{s.length ? fmtNative(s[0]) : '—'}</td>
                  <td className="mono">{s.length ? fmtNative(s[s.length - 1]) : '—'}</td>
                  <td className="mono">{s.length ? fmtNative(s.reduce((a, v) => a + v, 0n)) : '—'}</td>
                  <td className="mono">{s.length ? fmtNative(plan.leftoverWei) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {preview && movers.length === 1 && feeInfo != null && (() => {
        const { w, bal } = preview[0];
        if (bal == null) return null;
        const expected = expectedSends(params, BigInt(bal), feeInfo.gasCostWei);
        if (expected.length === 0) return null;
        const cap = expected.length >= MAX_SENDS_PER_WALLET;
        return (
          <div className="wlc-expected">
            <h4>Expected per-tx amounts — {w.label || shortAddr(w.address)} (min–max ETH, re-rolled live)</h4>
            <table className="wlc-preview">
              <thead>
                <tr>
                  <th>Tx</th>
                  <th>Min</th>
                  <th>Max</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {expected.map((r, k) => (
                  <tr key={r.i}>
                    <td className="mono">#{r.i}</td>
                    <td className="mono">{fmtNative(r.minWei)}</td>
                    <td className="mono">{fmtNative(r.maxWei)}</td>
                    <td>
                      {r.i === 1
                        ? 'first'
                        : k === expected.length - 1
                          ? cap
                            ? 'send cap reached'
                            : 'last — next no longer fits'
                          : r.maybeLast
                            ? 'a high roll may not fit'
                            : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })()}

      <div className="wlc-runrow">
        <button className="wlc-btn primary" type="button" onClick={run} disabled={!canRun}>
          {running ? 'Curating…' : `Curate — ${movers.length} wallet${movers.length === 1 ? '' : 's'}, ≈ ${fmtNative(plannedTotals.gas)} ETH gas`}
        </button>
        {running && (
          <button className="wlc-btn danger" type="button" onClick={() => (abortRef.current.current = true)}>
            ■ Abort after current tx
          </button>
        )}
      </div>

      {msg && <div className="wlc-msg err">{msg}</div>}

      {log.length > 0 && (
        <div className="wlc-log mono" ref={logRef}>
          {log.map((ev, i) => (
            <div key={i} className={`wlc-log-line ${ev.type}`}>
              {new Date(ev.ts).toLocaleTimeString(undefined, { hour12: false })}{' '}
              {ev.type === 'wallet-start' && `▶ ${shortAddr(ev.address)}`}
              {ev.type === 'tx-sent' && (
                <>
                  {'  ↗ '}
                  {fmtNative(ev.valueWei)} ETH deposit() → {shortAddr(ev.to)} ·{' '}
                  <a href={`${CHAIN.explorer}/tx/${ev.hash}`} target="_blank" rel="noreferrer">
                    {ev.hash.slice(0, 18)}…
                  </a>
                </>
              )}
              {ev.type === 'tx-mined' &&
                (ev.ok === true ? '  ✓ confirmed' : ev.ok === false ? '  ✗ reverted on-chain' : '  ⏳ still pending after wait')}
              {ev.type === 'info' && `  ℹ ${shortAddr(ev.address)} — ${ev.note}`}
              {ev.type === 'wallet-done' &&
                (ev.sent > 0
                  ? `  ● ${shortAddr(ev.address)} done — ${ev.sent} send${ev.sent === 1 ? '' : 's'}`
                  : `  ● ${shortAddr(ev.address)} done — nothing sent`)}
              {ev.type === 'tx-error' && `  ✗ ${shortAddr(ev.address)} — ${ev.error}`}
              {ev.type === 'done' && '■ curation finished'}
            </div>
          ))}
        </div>
      )}

      <p className="wlc-note">
        Every tx is a deposit() call (0xd0e30db0) to the curator contract carrying the grown ETH value, signed locally
        with the stored keys and broadcast via public RPCs — Ethereum mainnet only. The contract refunds each deposit,
        so a wallet's balance only drops by gas. The preview is a fresh random roll of the same algorithm the run
        uses; live amounts are drawn at send time and shown in the log. A wallet whose tx reverts or gets stuck is
        skipped without blocking the rest, and the whole batch aborts cleanly after the current tx.
      </p>
    </div>
  );
}

export default WhitelistCurator;
