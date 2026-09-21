// Opensea auto-mint — point it at an OpenSea collection, select wallets, and
// it waits for the public mint to open, then fires from every wallet.
//
// Two live data sources:
//   1. OpenSea API v2 (free key, stored locally) — turns the collection URL
//      into the contract address + chain, plus name/artwork for the card.
//   2. The chain itself — SeaDrop drops expose the public window's exact
//      start/end, price and per-wallet cap on the canonical router
//      (resolveSeaDrop in mint.js); non-SeaDrop contracts are probed with
//      eth_estimateGas until the sale actually opens.
// "Arm & wait" polls on-chain (tightening to 3s inside the final minute of a
// known start time), re-probes, then runs the same batch runner the old Batch
// Mint panel used — signed locally, broadcast through public RPCs.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ethers } from 'ethers';
import {
  MINT_CHAINS,
  mintChainById,
  parseMintTarget,
  decodeRevertReason,
  makeRpc,
  resolveCollectionInfo,
  resolveSeaDrop,
  probeMintMethod,
  runBatch,
  runSnipeBatch,
  seadropMethod,
} from '../nft-mint/mint.js';
import { fetchOsCollection, loadApiKey, saveApiKey, loadSlugCache, saveSlugEntry } from './opensea.js';
import { getWallets, subscribeWallets } from '../wallets/store';
import './OpenseaMint.css';

const DEFAULT_INPUT = 'https://opensea.io/collection/ntrpygenesis/overview';
const POLL_CHOICES = [5, 10, 15, 30, 60];
const FINAL_MINUTE_MS = 75 * 1000; // inside this window polls speed up to 3s (custom-signature drops)
const FAST_POLL_MS = 3 * 1000;
const SNIPER_PREWARM_MS = 30 * 1000; // hand off to the precision sniper this early

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shortAddr = (a) => `${a.slice(0, 8)}…${a.slice(-6)}`;
const fmtNative = (wei) => {
  try {
    return Number(ethers.formatEther(wei)).toFixed(4).replace(/\.?0+$/, '');
  } catch {
    return '—';
  }
};
const fmtWhen = (sec) => new Date(sec * 1000).toLocaleString();
const fmtCountdown = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (x) => String(x).padStart(2, '0');
  return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${pad(m)}m ${pad(s % 60)}s` : `${m}m ${pad(s % 60)}s`;
};

function CopyBtn({ text }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      type="button"
      className="osm-copy"
      title="copy contract address"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setOk(true);
          setTimeout(() => setOk(false), 1200);
        } catch {
          /* clipboard unavailable (non-secure context) */
        }
      }}
    >
      {ok ? '✓' : '⧉'}
    </button>
  );
}

function OpenseaMint() {
  const [input, setInput] = useState(DEFAULT_INPUT);
  const [apiKey, setApiKey] = useState(() => loadApiKey());
  const [resolving, setResolving] = useState(false);
  const [resolveMsg, setResolveMsg] = useState('');
  const [probeMsg, setProbeMsg] = useState('');
  const [chainId, setChainId] = useState('eth');
  const [info, setInfo] = useState(null); // { addr, name, symbol, price, seadrop }
  const [osMeta, setOsMeta] = useState(null); // { slug, name, image }
  const [method, setMethod] = useState(null); // { sig, gas, hasQty, to?, encode? }
  const [customSig, setCustomSig] = useState('');
  const [valueStr, setValueStr] = useState('');
  const [qty, setQty] = useState(1);
  const [gasOverride, setGasOverride] = useState('');
  const [wallets, setWallets] = useState(() => getWallets());
  const [selected, setSelected] = useState(() => new Set());
  const [balances, setBalances] = useState({});
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState([]);
  const [armed, setArmed] = useState(false);
  const [armStatus, setArmStatus] = useState(null); // { attempts, reason, nextAt }
  const [pollSec, setPollSec] = useState(15);
  const [now, setNow] = useState(() => Date.now());
  const [rpcPing, setRpcPing] = useState(null); // { ms } | { ms: null, err }
  const [pinging, setPinging] = useState(false);

  const abortRef = useRef({ current: false });
  const armedRef = useRef(false);
  const logRef = useRef(null);

  useEffect(() => subscribeWallets(setWallets), []);
  // Stop any waiting loop / in-flight batch when the page unmounts.
  useEffect(
    () => () => {
      armedRef.current = false;
      abortRef.current.current = true;
    },
    [],
  );

  const chain = mintChainById(chainId);
  const busy = resolving || armed || running;
  const valueWei = useMemo(() => {
    try {
      return ethers.parseEther(String(valueStr || '0'));
    } catch {
      return 0n;
    }
  }, [valueStr]);
  const chosen = wallets.filter((w) => selected.has(w.id));
  // SeaDrop price lives on the router and overrides whatever the value field
  // says; otherwise the manual value is what each mint costs.
  const perMintWei = info?.seadrop ? BigInt(info.seadrop.mintFee) : valueWei;
  const needEach = perMintWei * BigInt(qty);
  const totalValue = chosen.length ? needEach * BigInt(chosen.length) : 0n;

  // Drop state derived from the freshest SeaDrop read + the clock.
  const drop = useMemo(() => {
    const sd = info?.seadrop;
    if (!sd) return null;
    if (sd.live) return { state: 'live' };
    if (sd.endTime && now >= sd.endTime * 1000) return { state: 'ended' };
    if (sd.startTime && now < sd.startTime * 1000)
      return { state: 'upcoming', msLeft: sd.startTime * 1000 - now };
    return { state: 'pending' }; // window nominally open, drop not activated yet
  }, [info, now]);

  // 1s ticker while a countdown or armed status is on screen.
  useEffect(() => {
    if (!info?.seadrop && !armed) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [info?.seadrop, armed]);

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
    if (info && wallets.length) refreshBalances();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, chainId, wallets.length]);

  // RPC latency chip: times a trivial eth_blockNumber through the same
  // failover path minting uses, so the number reflects the real firing path.
  const pingRpc = async () => {
    setPinging(true);
    const t0 = performance.now();
    try {
      await makeRpc(chain)('eth_blockNumber');
      setRpcPing({ ms: Math.round(performance.now() - t0) });
    } catch (err) {
      setRpcPing({ ms: null, err: err.message || String(err) });
    } finally {
      setPinging(false);
    }
  };
  useEffect(() => {
    pingRpc(); // fresh reading whenever the chain changes (incl. auto-set by Resolve)
    const t = setInterval(() => pingRpc(), 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainId]);

  // Idle refresh of the drop state (the armed loop polls on its own schedule).
  const refreshDrop = async () => {
    if (!info?.addr || !info.seadrop) return;
    const sd = await resolveSeaDrop(makeRpc(chain), info.addr).catch(() => null);
    if (sd) setInfo((p) => (p ? { ...p, seadrop: sd } : p));
  };
  useEffect(() => {
    if (!info || armed || running) return undefined;
    const t = setInterval(() => refreshDrop(), 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, armed, running]);

  // Best-funded saved wallet — estimating from a funded address passes the
  // node's gas*price+value precheck, giving a real estimate (broke wallets
  // soft-pass with a fallback gas + warning instead).
  const probeSender = () => {
    let best = null;
    let bestBal = -1n;
    for (const w of wallets) {
      const b = balances[w.address];
      if (b == null) continue;
      try {
        const bb = BigInt(b);
        if (bb > bestBal) {
          bestBal = bb;
          best = w.address;
        }
      } catch {
        /* skip malformed balance */
      }
    }
    return best || wallets[0]?.address || null;
  };

  const probeNow = async (call, addr, from, colInfo) => {
    try {
      const m = await probeMintMethod(
        call,
        addr,
        from,
        qty,
        colInfo?.price != null ? BigInt(colInfo.price) : valueWei,
        customSig,
        colInfo?.seadrop,
      );
      setMethod(m);
      setProbeMsg(
        `✓ ${m.sig} passed gas estimation (${m.gas} gas)${m.to ? ' · via SeaDrop router' : ''}` +
          `${m.hasQty ? ' · takes a quantity arg' : ''}${m.warning ? ` · ${m.warning}` : ''}`,
      );
      return m;
    } catch (err) {
      setMethod(null);
      setProbeMsg(`✗ ${err.message}`);
      return null;
    }
  };

  const disarm = () => {
    armedRef.current = false;
    setArmed(false);
    setArmStatus(null);
    abortRef.current.current = true; // also stops a pre-warmed sniper mid-wait
  };

  // Resolve the pasted URL / address into an on-chain view of the collection.
  // keyOverride lets the boot effect pass the persisted key before state runs.
  const resolve = async (keyOverride) => {
    const key = String(keyOverride ?? apiKey).trim();
    setResolving(true);
    setResolveMsg('');
    setProbeMsg('');
    setInfo(null);
    setMethod(null);
    setOsMeta(null);
    disarm();

    const target = parseMintTarget(input);
    let addr = null;
    let cid = chainId;
    let col = null;
    let fromCache = false;
    let detectNote = '';
    try {
      if (target.kind === 'slug') {
        // Cache-first when keyless: a slug resolved once never needs OpenSea
        // again. A pasted key forces a fresh API look (and refreshes the cache).
        const slug = target.slug.toLowerCase();
        const cached = !key ? loadSlugCache()[slug] : null;
        if (cached?.addr && cached.chainId) {
          col = {
            slug,
            name: cached.name || null,
            image: cached.image || null,
            contract: { addr: cached.addr, chainId: cached.chainId },
          };
          fromCache = true;
        } else {
          col = await fetchOsCollection(slug, key);
          saveSlugEntry(slug, {
            addr: col.contract.addr,
            chainId: col.contract.chainId,
            name: col.name,
            image: col.image,
            ts: Date.now(),
          });
        }
        cid = col.contract.chainId;
        addr = col.contract.addr;
        setChainId(cid);
        setOsMeta({ slug: col.slug, name: col.name, image: col.image });
      } else if (target.kind === 'address') {
        addr = target.addr;
        if (target.chain) {
          cid = target.chain;
          setChainId(cid);
        } else {
          // Bare contract address: probe every chain's RPC for bytecode and
          // pick the one that actually hosts it (user's choice wins ties).
          const hits = (
            await Promise.all(
              MINT_CHAINS.map(async (c) => {
                try {
                  const code = await makeRpc(c)('eth_getCode', [addr, 'latest']);
                  return code && code !== '0x' ? c.id : null;
                } catch {
                  return null;
                }
              }),
            )
          ).filter(Boolean);
          if (!hits.length) {
            setResolveMsg(
              `No contract code at ${addr} on any supported chain (or the public RPCs are unreachable) — ` +
                'check the address, or pick the chain manually and Resolve again.',
            );
            setResolving(false);
            return;
          }
          cid = hits.includes(chainId) ? chainId : hits[0];
          setChainId(cid);
          if (hits.length > 1)
            detectNote = `contract also exists on: ${hits
              .filter((h) => h !== cid)
              .map((h) => mintChainById(h).name)
              .join(', ')}`;
        }
      } else {
        setResolveMsg(
          target.kind === 'empty'
            ? 'Paste an OpenSea collection URL or a contract address.'
            : 'Unrecognised input — paste an OpenSea collection/asset URL or a 0x… contract address.',
        );
        setResolving(false);
        return;
      }

      const ch = mintChainById(cid);
      const call = makeRpc(ch);
      let colInfo;
      try {
        colInfo = await resolveCollectionInfo(call, addr);
      } catch (err) {
        setResolveMsg(`Could not read the contract on ${ch.name}: ${err.message}`);
        setResolving(false);
        return;
      }
      setInfo(colInfo);
      if (colInfo.price != null) setValueStr(ethers.formatEther(colInfo.price));

      const dispName = col?.name || colInfo.name || 'Unnamed contract';
      let msg = `${dispName}${colInfo.symbol ? ` ($${colInfo.symbol})` : ''} on ${ch.name} — ${addr}`;
      if (colInfo.seadrop) {
        const price =
          colInfo.seadrop.mintFee === 0n ? 'FREE' : `${ethers.formatEther(colInfo.seadrop.mintFee)} ${ch.native}`;
        msg += `\nSeaDrop public drop — ${price}/NFT · max ${colInfo.seadrop.maxPerWallet || '∞'}/wallet`;
        if (colInfo.seadrop.live) msg += '\nmint is LIVE now — Arm & wait fires immediately, or hit Mint now.';
        else if (colInfo.seadrop.startTime)
          msg += `\npublic mint starts ${fmtWhen(colInfo.seadrop.startTime)}` +
            (colInfo.seadrop.endTime ? ` (ends ${fmtWhen(colInfo.seadrop.endTime)})` : '');
        else msg += '\nno start time configured yet — Arm & wait polls until it goes live.';
      } else if (colInfo.price != null) {
        msg += `\nprice() = ${ethers.formatEther(colInfo.price)} ${ch.native} — no SeaDrop schedule; Arm & wait probes until the sale opens.`;
      } else {
        msg += '\nno public price getter found — enter the mint value manually.';
      }
      if (fromCache) msg += '\n· resolved from the local slug cache — no OpenSea call (paste a key to re-check)';
      if (detectNote) msg += `\n· ${detectNote}`;
      setResolveMsg(msg);

      // Initial probe: only meaningful when a sale could be open. For an
      // upcoming SeaDrop drop the estimate would just revert "not started".
      const from = probeSender();
      if (!from) {
        setProbeMsg('Add a wallet on the Wallets page to probe/arm the mint.');
      } else if (colInfo.seadrop && !colInfo.seadrop.live) {
        setMethod(null);
        setProbeMsg(
          colInfo.seadrop.startTime
            ? 'Drop has not started — Arm & wait pre-signs your txs and fires the instant it opens.'
            : 'Drop is not active yet — Arm & wait polls until it opens.',
        );
      } else {
        await probeNow(call, addr, from, colInfo);
      }
    } catch (err) {
      setResolveMsg(err.message || String(err));
    }
    setResolving(false);
  };

  // Boot: auto-resolve the prefilled collection when a key is already saved.
  const bootRef = useRef(false);
  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    const k = loadApiKey();
    if (k) {
      setApiKey(k);
      resolve(k);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Probe + run the batch across the selected wallets. A fresh probe right
  // before firing catches "sold out / deactivated" in the gap after liveness.
  const fire = async () => {
    if (!info || !chosen.length) return;
    disarm();
    const call = makeRpc(chain);
    let m = null;
    try {
      m = await probeMintMethod(
        call,
        info.addr,
        probeSender(),
        qty,
        info.price != null ? BigInt(info.price) : valueWei,
        customSig,
        info.seadrop,
      );
      setMethod(m);
    } catch (err) {
      setMethod(null);
      setProbeMsg(`✗ cannot mint yet: ${decodeRevertReason(err) || err.message}`);
      return;
    }
    setRunning(true);
    abortRef.current.current = false;
    await runBatch({
      chain,
      wallets: chosen,
      contract: info.addr,
      method: m,
      qtyPerWallet: qty,
      valuePerMintWei: valueWei,
      gasLimitOverride: gasOverride ? BigInt(gasOverride) : null,
      abortRef: abortRef.current,
      onEvent: (ev) => setLog((l) => [...l.slice(-300), { ...ev, ts: Date.now() }]),
    });
    setRunning(false);
  };

  // Precision path for a scheduled SeaDrop start: pre-warm every wallet
  // (nonce, balance, fees, signatures) ~30 s out, then broadcast the moment
  // chain time reaches the start — at T only the sends happen.
  const snipe = async (startMs, attempts, sd) => {
    const call = makeRpc(chain);
    const m = seadropMethod(sd, qty, info.addr);
    setMethod(m);
    setArmStatus({
      attempts,
      reason: 'pre-warming (nonces, fees, signatures) — chain-clock aligned fire',
      nextAt: startMs,
      fireAt: startMs,
    });
    abortRef.current.current = false;
    let firedUi = false;
    setRunning(true);
    await runSnipeBatch({
      chain,
      wallets: chosen,
      contract: info.addr,
      method: m,
      qtyPerWallet: qty,
      valuePerMintWei: valueWei,
      gasLimitOverride: gasOverride ? BigInt(gasOverride) : null,
      abortRef: abortRef.current,
      fireAt: startMs,
      isLive: () =>
        resolveSeaDrop(call, info.addr)
          .then((f) => f?.live === true)
          .catch(() => false),
      onEvent: (ev) => {
        if (ev.type === 'wallet-start' && !firedUi) {
          firedUi = true;
          setArmed(false);
          setArmStatus(null);
        }
        setLog((l) => [...l.slice(-300), { ...ev, ts: Date.now() }]);
      },
    });
    setRunning(false);
    setArmed(false);
    setArmStatus(null);
    armedRef.current = false;
  };

  // Immediate parallel fire for drops the arm loop finds already open (or
  // that opened with no schedule): the detector just produced a verified
  // method, so pre-warm nonces/fees/signatures and broadcast every wallet at
  // once instead of walking runBatch's sequential wallet-by-wallet loop.
  const fireAll = async (m) => {
    disarm();
    setMethod(m);
    setProbeMsg(
      `✓ ${m.sig} — firing ${chosen.length} wallet${chosen.length === 1 ? '' : 's'} at once` +
        `${m.warning ? ` · ${m.warning}` : ''}`,
    );
    abortRef.current.current = false;
    setRunning(true);
    await runSnipeBatch({
      chain,
      wallets: chosen,
      contract: info.addr,
      method: m,
      qtyPerWallet: qty,
      valuePerMintWei: valueWei,
      gasLimitOverride: gasOverride ? BigInt(gasOverride) : null,
      abortRef: abortRef.current,
      fireAt: Date.now(), // already live — broadcast as soon as pre-warm finishes
      onEvent: (ev) => setLog((l) => [...l.slice(-300), { ...ev, ts: Date.now() }]),
    });
    setRunning(false);
  };


  // The wait loop: poll the chain until the public mint is open, then fire.
  const arm = async () => {
    if (!info || !chosen.length) return;
    armedRef.current = true;
    setArmed(true);
    setArmStatus({ attempts: 0, reason: 'starting…', nextAt: Date.now() + pollSec * 1000 });
    const call = makeRpc(chain);
    const q = qty;
    const val = info.seadrop ? BigInt(info.seadrop.mintFee) : valueWei;
    const sig = customSig;
    let n = 0;

    while (armedRef.current) {
      n += 1;
      let live = false;
      let liveM = null;
      let reason = '';
      let sd = info?.seadrop || null;
      try {
        const fresh = await resolveSeaDrop(call, info.addr).catch(() => null);
        if (fresh) {
          sd = fresh;
          setInfo((p) => (p ? { ...p, seadrop: fresh } : p));
          if (fresh.live) {
            live = true;
            liveM = seadropMethod(fresh, q, info.addr);
          }
          else if (fresh.startTime && Date.now() < fresh.startTime * 1000)
            reason = `drop opens in ${fmtCountdown(fresh.startTime * 1000 - Date.now())}`;
          else if (fresh.endTime && Date.now() >= fresh.endTime * 1000)
            reason = 'drop window has ended — waiting in case it is extended';
          else reason = 'window open on paper — waiting for the creator to activate the drop';
        } else {
          // Non-SeaDrop: a passing estimate IS the "sale is open" signal. A
          // soft-pass from an underfunded prober says nothing — keep waiting.
          const from = probeSender();
          if (!from) {
            setArmStatus({ attempts: n, reason: 'no wallets — add one on the Wallets page', nextAt: 0 });
            disarm();
            return;
          }
          try {
            const m = await probeMintMethod(call, info.addr, from, q, val, sig, null);
            if (m.warning && /estimate skipped/i.test(m.warning)) {
              reason = 'probe sender underfunded — cannot tell if the sale is open (fund wallets or set the mint value)';
            } else {
              live = true;
              liveM = m;
            }
          } catch (err) {
            reason = decodeRevertReason(err) || err.message;
          }
        }
      } catch (err) {
        reason = err.message || String(err);
      }
      if (!armedRef.current) return;
      if (live && liveM) {
        // Found it open — fire every wallet at once (pre-warm + parallel
        // broadcast) instead of the sequential batch.
        await fireAll(liveM);
        return;
      }
      if (live) {
        await fire();
        return;
      }
      const startMs = sd?.startTime ? sd.startTime * 1000 : null;
      // Scheduled SeaDrop drop: hand off to the precision sniper ~30 s before
      // the start, and never let a slow poll overshoot the handoff moment.
      if (startMs != null && !customSig) {
        if (startMs - Date.now() <= SNIPER_PREWARM_MS) {
          await snipe(startMs, n, sd);
          return;
        }
      }
      const waitMs =
        startMs != null && !customSig
          ? Math.max(500, Math.min(pollSec * 1000, startMs - Date.now() - SNIPER_PREWARM_MS))
          : startMs != null && startMs - Date.now() <= FINAL_MINUTE_MS
            ? FAST_POLL_MS
            : pollSec * 1000;
      setArmStatus({
        attempts: n,
        reason:
          startMs != null && !customSig
            ? `${reason} · pre-signs at ${fmtWhen((startMs - SNIPER_PREWARM_MS) / 1000)}, fires at ${fmtWhen(sd.startTime)} sharp`
            : reason,
        nextAt: Date.now() + waitMs,
      });
      const till = Date.now() + waitMs;
      while (armedRef.current && Date.now() < till) await sleep(250);
    }
  };

  const toggle = (id) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const pingTone =
    rpcPing?.ms == null
      ? rpcPing?.err
        ? 'err'
        : ''
      : rpcPing.ms <= 350
        ? 'fast'
        : rpcPing.ms <= 900
          ? 'mid'
          : 'slow';

  const pill = drop
    ? drop.state === 'live'
      ? { cls: 'live', text: 'LIVE NOW' }
      : drop.state === 'upcoming'
        ? { cls: 'upcoming', text: `starts in ${fmtCountdown(drop.msLeft)}` }
        : drop.state === 'ended'
          ? { cls: 'ended', text: 'ended' }
          : { cls: 'pending', text: 'awaiting activation' }
    : null;

  return (
    <section className="osm">
      <div className="osm-row">
        <input
          className="osm-input grow"
          type="text"
          placeholder="OpenSea collection URL / slug / 0x… contract"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
        />
        <select
          className="osm-select"
          value={chainId}
          onChange={(e) => setChainId(e.target.value)}
          disabled={busy}
          title="Chain — auto-set when resolving a link"
        >
          {MINT_CHAINS.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={`osm-ping ${pingTone}`}
          onClick={pingRpc}
          disabled={pinging}
          title={
            rpcPing?.err
              ? `RPC error: ${rpcPing.err} — click to retry`
              : 'Round-trip of eth_blockNumber via the public RPCs minting will use (failover included). Click to re-test.'
          }
        >
          {pinging ? '⚡ …' : rpcPing == null ? '⚡ RPC' : rpcPing.ms != null ? `⚡ ${rpcPing.ms} ms` : '⚡ RPC ✗'}
        </button>
        <button className="osm-btn" onClick={() => resolve()} disabled={busy || !input.trim()}>
          {resolving ? 'Resolving…' : 'Resolve'}
        </button>
      </div>

      <div className="osm-row osm-key-row">
        <label
          className="osm-field"
          title="Free key from docs.opensea.io — rarely needed: collection lookups work without it and are then cached locally (skipping the API); a raw contract address never touches OpenSea. Paste one only for 401s/rate limits. Stored in this browser's localStorage, sent only to api.opensea.io."
        >
          <span>OpenSea API key</span>
          <input
            className="osm-input"
            type="password"
            placeholder="optional — links & slugs resolve without it"
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              saveApiKey(e.target.value.trim());
            }}
            disabled={busy}
          />
        </label>
        <a className="osm-link" href="https://docs.opensea.io/reference/api-keys" target="_blank" rel="noreferrer">
          get a free key ↗
        </a>
      </div>

      {(resolveMsg || probeMsg) && (
        <div className="osm-msgs">
          {resolveMsg && <div className="osm-msg">{resolveMsg}</div>}
          {probeMsg && (
            <div className={`osm-msg ${probeMsg.startsWith('✓') ? 'ok' : probeMsg.startsWith('✗') ? 'err' : ''}`}>
              {probeMsg}
            </div>
          )}
        </div>
      )}

      {info && (
        <div className="osm-card">
          {osMeta?.image && (
            <img
              className="osm-card-img"
              src={osMeta.image}
              alt=""
              referrerPolicy="no-referrer"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
          )}
          <div className="osm-card-main">
            <div className="osm-card-title">
              <strong>{osMeta?.name || info.name || 'Unnamed contract'}</strong>
              {info.symbol && <span className="mono osm-dim">${info.symbol}</span>}
              {pill && <span className={`osm-pill ${pill.cls}`}>{pill.text}</span>}
              {osMeta?.slug && (
                <a
                  className="osm-link"
                  href={`https://opensea.io/collection/${osMeta.slug}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  OpenSea ↗
                </a>
              )}
            </div>
            <div className="osm-card-sub mono">
              {chain.name} · {info.addr} <CopyBtn text={info.addr} />
            </div>
            <div className="osm-card-facts">
              <div>
                <span>price / NFT</span>
                <strong>
                  {info.seadrop
                    ? info.seadrop.mintFee === 0n
                      ? 'FREE'
                      : `${ethers.formatEther(info.seadrop.mintFee)} ${chain.native}`
                    : info.price != null
                      ? `${ethers.formatEther(info.price)} ${chain.native}`
                      : '—'}
                </strong>
              </div>
              <div>
                <span>max / wallet</span>
                <strong>{info.seadrop ? info.seadrop.maxPerWallet || '∞' : '—'}</strong>
              </div>
              <div>
                <span>public start</span>
                <strong>{info.seadrop?.startTime ? fmtWhen(info.seadrop.startTime) : 'unknown'}</strong>
              </div>
              <div>
                <span>public end</span>
                <strong>{info.seadrop?.endTime ? fmtWhen(info.seadrop.endTime) : '—'}</strong>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="osm-row">
        <label className="osm-field" title="NFTs per wallet">
          <span>qty / wallet</span>
          <input
            className="osm-input mono w80"
            type="number"
            min="1"
            max="100"
            value={qty}
            onChange={(e) => setQty(Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
            disabled={busy}
          />
        </label>
        <label
          className="osm-field"
          title={`Value sent per mint, in ${chain.native} — SeaDrop drops read the price from the router and ignore this`}
        >
          <span>value / mint ({chain.native})</span>
          <input
            className="osm-input mono w120"
            type="text"
            placeholder="0"
            value={valueStr}
            onChange={(e) => setValueStr(e.target.value)}
            disabled={busy}
          />
        </label>
        <label className="osm-field" title="Leave empty to auto-size from gas estimation (+50%)">
          <span>gas limit</span>
          <input
            className="osm-input mono w120"
            type="text"
            placeholder={method ? String((method.gas * 150n) / 100n) : 'auto'}
            value={gasOverride}
            onChange={(e) => setGasOverride(e.target.value.replace(/[^0-9]/g, ''))}
            disabled={busy}
          />
        </label>
        <label className="osm-field" title="Custom mint function, tried before the built-ins. e.g. publicMint(uint256)">
          <span>function</span>
          <input
            className="osm-input mono"
            type="text"
            placeholder={method ? method.sig : 'auto-detect'}
            value={customSig}
            onChange={(e) => setCustomSig(e.target.value)}
            disabled={busy}
          />
        </label>
        <label
          className="osm-field"
          title="How often the armed loop checks the drop while waiting (speeds up to 3s inside the final minute)"
        >
          <span>poll</span>
          <select
            className="osm-select"
            value={pollSec}
            onChange={(e) => setPollSec(Number(e.target.value))}
            disabled={busy}
          >
            {POLL_CHOICES.map((s) => (
              <option key={s} value={s}>
                {s}s
              </option>
            ))}
          </select>
        </label>
        {info && (
          <button
            className="osm-btn"
            onClick={() => probeNow(makeRpc(chain), info.addr, probeSender(), info)}
            disabled={busy || !wallets.length}
          >
            Re-probe
          </button>
        )}
      </div>

      <div className="osm-wallets">
        <div className="osm-wallets-head">
          <h4>Wallets</h4>
          <button
            className="osm-btn mini"
            onClick={() => setSelected(new Set(wallets.map((w) => w.id)))}
            disabled={busy || !wallets.length}
          >
            select all
          </button>
          <button className="osm-btn mini" onClick={() => setSelected(new Set())} disabled={busy}>
            none
          </button>
          <button className="osm-btn mini" onClick={refreshBalances} disabled={running || !wallets.length}>
            ⟲ balances
          </button>
          {wallets.length === 0 && <span className="osm-hint">no wallets yet — add some on the 👛 Wallets page</span>}
        </div>
        {wallets.map((w) => {
          const bal = balances[w.address];
          const low = bal != null && needEach > 0n && BigInt(bal) < needEach;
          return (
            <label key={w.id} className={`osm-wallet${selected.has(w.id) ? ' on' : ''}`}>
              <input type="checkbox" checked={selected.has(w.id)} onChange={() => toggle(w.id)} disabled={busy} />
              <span className="osm-wallet-label">{w.label}</span>
              <span className="mono osm-wallet-addr">{shortAddr(w.address)}</span>
              <span className={`mono osm-wallet-bal${low ? ' low' : ''}`}>
                {bal != null ? `${fmtNative(bal)} ${chain.native}` : '—'}
                {low ? ' ⚠' : ''}
              </span>
            </label>
          );
        })}
      </div>

      <div className="osm-row osm-actions">
        <button
          className="osm-btn primary"
          onClick={arm}
          disabled={busy || !info || !chosen.length}
          title="Wait for the public mint to open on-chain, then mint from every selected wallet"
        >
          {armed
            ? 'Armed — waiting…'
            : drop?.state === 'upcoming'
              ? `Arm & wait — ${fmtCountdown(drop.msLeft)}`
              : 'Arm & wait'}
        </button>
        {!armed && !running && (
          <button
            className="osm-btn"
            onClick={fire}
            disabled={!info || !chosen.length}
            title="Skip the wait — probe and mint right now"
          >
            Mint now — {chosen.length} wallet{chosen.length === 1 ? '' : 's'} × {qty}
            {totalValue > 0n ? ` (≈ ${ethers.formatEther(totalValue)} ${chain.native} + gas)` : ''}
          </button>
        )}
        {armed && (
          <button className="osm-btn danger" onClick={disarm}>
            ■ Disarm
          </button>
        )}
        {running && (
          <button className="osm-btn danger" onClick={() => (abortRef.current.current = true)}>
            ■ Abort after current tx
          </button>
        )}
        {armed && armStatus && (
          <span className="osm-arm-status">
            attempt {armStatus.attempts} · {armStatus.reason} · {armStatus.fireAt ? 'fires' : 'next check'}{' '}
            {armStatus.nextAt > now ? `in ${Math.max(0, Math.round((armStatus.nextAt - now) / 1000))}s` : '…'}
          </span>
        )}
      </div>

      {log.length > 0 && (
        <div className="osm-log mono" ref={logRef}>
          {log.map((ev, i) => (
            <div key={i} className={`osm-log-line ${ev.type}`}>
              {new Date(ev.ts).toLocaleTimeString(undefined, { hour12: false })}{' '}
              {ev.type === 'wallet-start' && `▶ ${shortAddr(ev.address)}`}
              {ev.type === 'warm' && `⚙ ${shortAddr(ev.address)} pre-signed ${ev.txs} tx — ready to fire`}
              {ev.type === 'tx-sent' && `  ↗ tx ${ev.hash.slice(0, 18)}… (mint ${ev.n + 1}/${ev.total})`}
              {ev.type === 'tx-mined' &&
                (ev.ok === true
                  ? `  ✓ confirmed ${ev.hash.slice(0, 18)}…`
                  : ev.ok === false
                    ? `  ✗ reverted on-chain ${ev.hash.slice(0, 18)}…`
                    : `  ⏳ still pending ${ev.hash.slice(0, 18)}…`)}
              {ev.type === 'tx-error' && `  ✗ ${shortAddr(ev.address)} — ${ev.error}`}
              {ev.type === 'done' && '■ batch finished'}
            </div>
          ))}
        </div>
      )}

      <p className="osm-note">
        Timing comes from the chain, not the website: SeaDrop windows are read from the canonical SeaDrop
        router, and scheduled starts are sniped — transactions are pre-signed ~30 s ahead and broadcast at
        the exact opening, aligned to the chain's clock (local clocks drift by seconds). Other contracts
        are probed with eth_estimateGas until the sale opens. The OpenSea key is
        optional — collection links and slugs resolve without one (then cache locally), and a pasted contract
        address skips OpenSea entirely (its chain is auto-detected). The key stays in this browser. Transactions
        are signed locally and broadcast via public RPCs — sequential per wallet; a ×qty function argument
        mints all N in a single tx. Gas estimation uses your best-funded wallet as sender.
      </p>



    </section>
  );
}

export default OpenseaMint;
