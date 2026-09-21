// Balance Transfers section (below the wallet table): move native balance
// between saved wallets — disperse one → many, or collect many → one.
// Signed locally with the stored keys, broadcast via public RPCs, exactly
// like Batch Mint. Amounts are plain native sends (21k gas each).
import { useEffect, useMemo, useRef, useState } from 'react';
import { ethers } from 'ethers';
import { MINT_CHAINS, mintChainById, makeRpc, feePlan } from '../nft-mint/mint.js';
import { disperseBalances, collectBalances, transferGasLimit } from './transfer.js';

const shortAddr = (a) => `${a.slice(0, 8)}…${a.slice(-6)}`;
const fmtNative = (wei) => {
  try {
    return Number(ethers.formatEther(wei)).toFixed(6).replace(/\.?0+$/, '') || '0';
  } catch {
    return '—';
  }
};

function TransferPanel({ wallets }) {
  const [mode, setMode] = useState('disperse'); // 'disperse' (one→many) | 'collect' (many→one)
  const [chainId, setChainId] = useState('eth');
  const [anchorId, setAnchorId] = useState(''); // disperse: source · collect: destination
  const [picked, setPicked] = useState(() => new Set()); // disperse: recipients · collect: sources
  const [amountStr, setAmountStr] = useState('');
  const [keepStr, setKeepStr] = useState('0');
  const [balances, setBalances] = useState({}); // address → wei hex string
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState([]);
  const [msg, setMsg] = useState('');
  const abortRef = useRef({ current: false });
  const logRef = useRef(null);

  const chain = mintChainById(chainId);

  // Keep selections valid as wallets come and go.
  useEffect(() => {
    const ids = new Set(wallets.map((w) => w.id));
    setAnchorId((a) => (ids.has(a) ? a : ''));
    setPicked((p) => {
      const next = new Set([...p].filter((id) => ids.has(id)));
      return next.size === p.size ? p : next;
    });
  }, [wallets]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const refreshBalances = async () => {
    const call = makeRpc(chain);
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
  };

  useEffect(() => {
    if (wallets.length) refreshBalances();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainId, wallets.length]);

  const amountWei = useMemo(() => {
    try {
      return ethers.parseEther(String(amountStr || '0'));
    } catch {
      return 0n;
    }
  }, [amountStr]);

  const keepWei = useMemo(() => {
    try {
      return ethers.parseEther(String(keepStr || '0'));
    } catch {
      return 0n;
    }
  }, [keepStr]);

  const anchor = wallets.find((w) => w.id === anchorId) || null;
  const others = wallets.filter((w) => w.id !== anchorId); // pickable movers
  const movers = others.filter((w) => picked.has(w.id));
  const anchorBal = anchor ? balances[anchor.address] : null;

  const pickedSum = movers.reduce((sum, w) => {
    const b = balances[w.address];
    return b == null ? sum : sum + BigInt(b);
  }, 0n);

  const toggle = (id) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Fill "amount / wallet" with the largest per-recipient amount the source
  // can cover: (fresh balance − worst-case gas × sends − drift cushion) ÷
  // recipients. The cushion matters: maxFee (2× base fee) re-rolls every block
  // and rotating public RPCs return slightly different snapshots, so the run's
  // precheck can see a hair more gas than the click did — with zero headroom
  // that flips "have ≥ need". 20% of the worst-case gas (≥ 1 µETH) absorbs it
  // and stays behind on the source as dust.
  const setMaxAmount = async () => {
    setMsg('');
    if (!anchor || movers.length === 0) return;
    try {
      const call = makeRpc(chain);
      const fees = await feePlan(call, chain);
      const gasLimit = await transferGasLimit(call, anchor.address, movers[0].address);
      const gasCost = gasLimit * fees.maxFee; // worst-case gas per send
      const bal = BigInt(await call('eth_getBalance', [anchor.address, 'latest']));
      setBalances((b) => ({ ...b, [anchor.address]: '0x' + bal.toString(16) })); // keep the shown balance fresh
      const n = BigInt(movers.length);
      const gasTotal = gasCost * n;
      const cushion = gasTotal / 5n + 10n ** 12n; // fee-drift margin, µETH-scale
      const per = (bal > gasTotal + cushion ? bal - gasTotal - cushion : 0n) / n;
      setAmountStr(ethers.formatEther(per));
    } catch (err) {
      setMsg(err?.message || String(err));
    }
  };

  const run = async () => {
    setMsg('');
    if (!anchor || !movers.length) return;
    if (mode === 'disperse' && amountWei <= 0n) return;

    const summary =
      mode === 'disperse'
        ? `Send ${fmtNative(amountWei)} ${chain.native} from "${anchor.label || shortAddr(anchor.address)}" ` +
          `to each of ${movers.length} wallet${movers.length === 1 ? '' : 's'}?` +
          `\n\nTotal ${fmtNative(amountWei * BigInt(movers.length))} ${chain.native} + gas, ` +
          `${movers.length} sequential tx${movers.length === 1 ? '' : 's'}.`
        : `Sweep balances from ${movers.length} wallet${movers.length === 1 ? '' : 's'} into ` +
          `"${anchor.label || shortAddr(anchor.address)}"?` +
          `\n\nEach source keeps only its gas${keepWei > 0n ? ` plus ${fmtNative(keepWei)} ${chain.native}` : ''}; ` +
          `current picked balance ≈ ${fmtNative(pickedSum)} ${chain.native} (before gas).`;
    if (!window.confirm(summary)) return;

    setRunning(true);
    abortRef.current.current = false;
    setLog([]);
    const onEvent = (ev) => setLog((l) => [...l, { ...ev, ts: Date.now() }]);
    try {
      if (mode === 'disperse') {
        await disperseBalances({
          chain,
          source: anchor,
          recipients: movers,
          amountPerWei: amountWei,
          onEvent,
          abortRef: abortRef.current,
        });
      } else {
        await collectBalances({
          chain,
          sources: movers,
          toAddress: anchor.address,
          keepForGasWei: keepWei,
          onEvent,
          abortRef: abortRef.current,
        });
      }
    } catch (err) {
      setMsg(err?.message || String(err));
    } finally {
      setRunning(false);
      refreshBalances();
    }
  };

  if (wallets.length < 2) return null; // transfers need at least two wallets

  const canRun =
    !running && anchor && movers.length > 0 && (mode === 'collect' || amountWei > 0n);

  return (
    <div className="wlt-transfer">
      <div className="wlt-transfer-head">
        <h3>💸 Balance transfers</h3>
        <div className="wlt-mode-tabs">
          <button
            type="button"
            className={`wlt-mode-tab${mode === 'disperse' ? ' on' : ''}`}
            onClick={() => setMode('disperse')}
            disabled={running}
            title="Send from one wallet to many wallets"
          >
            🔁 Disperse (1 → many)
          </button>
          <button
            type="button"
            className={`wlt-mode-tab${mode === 'collect' ? ' on' : ''}`}
            onClick={() => setMode('collect')}
            disabled={running}
            title="Collect balances from many wallets into one"
          >
            🧲 Collect (many → 1)
          </button>
        </div>
        <div className="wlt-transfer-tools">
          <select
            className="wlt-input"
            value={chainId}
            onChange={(e) => setChainId(e.target.value)}
            disabled={running}
            title="Chain to transfer on"
          >
            {MINT_CHAINS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button className="wlt-btn mini" type="button" onClick={refreshBalances} disabled={running}>
            ⟲ balances
          </button>
        </div>
      </div>

      <div className="wlt-transfer-row">
        <label className="wlt-field">
          <span>{mode === 'disperse' ? 'from (source)' : 'to (destination)'}</span>
          <select
            className="wlt-input"
            value={anchorId}
            onChange={(e) => setAnchorId(e.target.value)}
            disabled={running}
          >
            <option value="">— pick a wallet —</option>
            {wallets.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label ? `${w.label} · ` : ''}
                {shortAddr(w.address)}
              </option>
            ))}
          </select>
        </label>
        {mode === 'disperse' ? (
          <label className="wlt-field" title={`Amount sent to EACH recipient, in ${chain.native}`}>
            <span>amount / wallet ({chain.native})</span>
            <div className="wlt-amt-row">
              <input
                className="wlt-input wlt-amt"
                type="text"
                inputMode="decimal"
                placeholder="0.001"
                value={amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
                disabled={running}
              />
              <button
                className="wlt-btn mini"
                type="button"
                onClick={setMaxAmount}
                disabled={running || !anchor || movers.length === 0}
                title="Fill the largest per-wallet amount the source can cover: (fresh balance − worst-case gas × sends − fee-drift cushion) ÷ recipients"
              >
                max
              </button>
            </div>
          </label>
        ) : (
          <label
            className="wlt-field"
            title={`Left on every source wallet after the sweep, in ${chain.native} — gas is always kept on top of this`}
          >
            <span>keep on sources ({chain.native})</span>
            <input
              className="wlt-input wlt-amt"
              type="text"
              inputMode="decimal"
              placeholder="0"
              value={keepStr}
              onChange={(e) => setKeepStr(e.target.value)}
              disabled={running}
            />
          </label>
        )}
        {anchorBal != null && (
          <span
            className={`wlt-anchor-bal${
              mode === 'disperse' && BigInt(anchorBal) < amountWei * BigInt(movers.length) ? ' low' : ''
            }`}
          >
            {mode === 'disperse' ? 'source' : 'destination'} balance: {fmtNative(anchorBal)} {chain.native}
          </span>
        )}
      </div>

      <div className="wlt-transfer-list">
        <div className="wlt-transfer-list-head">
          <h4>
            {mode === 'disperse'
              ? `Recipients (${movers.length}/${others.length})`
              : `Sources (${movers.length}/${others.length})`}
          </h4>
          <button
            className="wlt-btn mini"
            type="button"
            onClick={() => setPicked(new Set(others.map((w) => w.id)))}
            disabled={running || !others.length}
          >
            select all
          </button>
          <button className="wlt-btn mini" type="button" onClick={() => setPicked(new Set())} disabled={running}>
            none
          </button>
        </div>
        {others.length === 0 ? (
          <div className="wlt-transfer-empty">
            {anchor
              ? 'No other wallets — add at least one more to transfer between them.'
              : 'Pick a source/destination wallet first.'}
          </div>
        ) : (
          others.map((w) => {
            const bal = balances[w.address];
            return (
              <label key={w.id} className={`wlt-transfer-item${picked.has(w.id) ? ' on' : ''}`}>
                <input type="checkbox" checked={picked.has(w.id)} onChange={() => toggle(w.id)} disabled={running} />
                <span className="wlt-transfer-item-label">{w.label || 'unlabeled'}</span>
                <span className="mono wlt-transfer-item-addr">{shortAddr(w.address)}</span>
                <span className={`mono wlt-transfer-item-bal${bal != null && BigInt(bal) === 0n ? ' zero' : ''}`}>
                  {bal != null ? `${fmtNative(bal)} ${chain.native}` : '—'}
                </span>
              </label>
            );
          })
        )}
      </div>

      <div className="wlt-transfer-row">
        <button className="wlt-btn primary" type="button" onClick={run} disabled={!canRun}>
          {running
            ? 'Transferring…'
            : mode === 'disperse'
              ? `Send — ${movers.length} × ${fmtNative(amountWei)} ${chain.native}`
              : `Collect — sweep ${movers.length} wallet${movers.length === 1 ? '' : 's'} (≈ ${fmtNative(pickedSum)} ${chain.native} before gas)`}
        </button>
        {running && (
          <button className="wlt-btn danger" type="button" onClick={() => (abortRef.current.current = true)}>
            ■ Abort after current tx
          </button>
        )}
        {mode === 'disperse' && movers.length > 0 && amountWei > 0n && (
          <span className="wlt-transfer-hint">
            total {fmtNative(amountWei * BigInt(movers.length))} {chain.native} + gas · {movers.length} sequential tx
            {movers.length === 1 ? '' : 's'}
          </span>
        )}
        {mode === 'collect' && movers.length > 0 && (
          <span className="wlt-transfer-hint">
            each source sends balance − gas{keepWei > 0n ? ` − ${fmtNative(keepWei)} keep` : ''}
          </span>
        )}
      </div>

      {msg && <div className="wlt-msg err">{msg}</div>}

      {log.length > 0 && (
        <div className="wlt-transfer-log mono" ref={logRef}>
          {log.map((ev, i) => (
            <div key={i} className={`wlt-transfer-log-line ${ev.type}`}>
              {new Date(ev.ts).toLocaleTimeString(undefined, { hour12: false })}{' '}
              {ev.type === 'wallet-start' && `▶ ${shortAddr(ev.address)}`}
              {ev.type === 'tx-sent' && (
                <>
                  {'  ↗ '}
                  {fmtNative(ev.valueWei)} {chain.native} → {shortAddr(ev.to)} ·{' '}
                  <a href={`${chain.explorer}/tx/${ev.hash}`} target="_blank" rel="noreferrer">
                    {ev.hash.slice(0, 18)}…
                  </a>
                </>
              )}
              {ev.type === 'tx-mined' &&
                (ev.ok === true ? '  ✓ confirmed' : ev.ok === false ? '  ✗ reverted on-chain' : '  ⏳ still pending after wait')}
              {ev.type === 'tx-error' && `  ✗ ${shortAddr(ev.address)} — ${ev.error}`}
              {ev.type === 'done' && '■ transfer batch finished'}
            </div>
          ))}
        </div>
      )}

      <p className="wlt-transfer-note">
        Plain native-token sends, signed locally with the stored keys and broadcast via public RPCs — sequential,
        one transfer per tx, receipt-confirmed. Disperse checks the source can cover value + max gas up front;
        Collect leaves each source just its gas
        {mode === 'collect' && keepWei > 0n ? ' plus your keep amount' : ''}.
      </p>
    </div>
  );
}

export default TransferPanel;
