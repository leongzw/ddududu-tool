// Bundle Radar engine — reconstructs a token's full trade history from public
// RPC Transfer logs and clusters wallets that act in coordination (bundled
// snipers at launch, 莊家 groups that 建倉 → dump the top → rebuy the retrace).
//
// Pipeline (see analyzeToken):
//   1. auto-detect the token's creation block (binary search on eth_getCode)
//      and its deployer (creation-tx receipt)
//   2. ranged eth_getLogs for every Transfer since creation (adaptive window)
//   3. per-block timestamps (concurrency-limited eth_getBlockByNumber)
//   4. pool detection: addresses that swap with many distinct counterparties
//      in BOTH directions (DEX pairs; CEX hot wallets land here too, which is
//      fine — deposits are effectively sells)
//   5. classify each transfer: buy / sell / wallet↔wallet move / mint / burn
//   6. coordinated events: many wallets buying or selling in the same tx
//      (strongest) or the same block, at ANY point in the token's life
//   7. union-find clustering on repeated co-action → wallet groups
//
// The heavy RPC phase (steps 1–3) runs once per token; buildReport() re-runs
// the cheap phases (4–7) whenever thresholds or pool overrides change.
// All amounts are normalized to plain Numbers (token units) in the report.

import { ethers } from 'ethers';

export const TOPIC_TRANSFER = ethers.id('Transfer(address,address,uint256)');
const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dead';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hexQty = (n) => '0x' + n.toString(16);
const hexBig = (h) => (h && h !== '0x' ? BigInt(h) : 0n);

// ---------------------------------------------------------------- rpc client

// Minimal JSON-RPC client with endpoint rotation — mirrors nft-mint's httpRpc
// conventions but keeps everything self-contained in this module.
export class RpcClient {
  constructor(urls) {
    this.urls = (urls || []).filter(Boolean);
    this.idx = 0;
    this.cooldown = new Map(); // url -> timestamp when it may be retried
    if (!this.urls.length) throw new Error('no RPC endpoints configured');
  }
  get url() {
    return this.urls[this.idx % this.urls.length];
  }
  // Batched JSON-RPC (one round trip for many calls). Response items keep the
  // request order via positional ids; endpoints that don't support batches
  // throw and the caller falls back to single calls.
  async callBatch(method, paramsList, timeoutMs = 30000) {
    let lastErr = null;
    const attempts = this.urls.length + 1;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await this.rotate();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(this.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(paramsList.map((p, idx) => ({ jsonrpc: '2.0', id: idx, method, params: p }))),
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!Array.isArray(json)) throw new Error('batch not supported');
        const out = new Array(paramsList.length);
        for (const r of json) if (r && typeof r.id === 'number') out[r.id] = r;
        this.cooldown.delete(this.url);
        return out;
      } catch (err) {
        lastErr = err;
        const msg = String(err?.message || err).toLowerCase();
        const isRate =
          msg.includes('rate') || msg.includes('429') || msg.includes('403') || msg.includes('too many') || msg.includes('limit');
        this.cooldown.set(this.url, Date.now() + (isRate ? 75000 : 25000));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr || new Error('batch failed');
  }
  // Advance to the next endpoint not in cooldown; if every endpoint is cooling
  // down (free tiers throttling a heavy backfill), sleep until the soonest one
  // clears instead of hammering it and extending the ban.
  async rotate() {
    const now = Date.now();
    const n = this.urls.length;
    for (let k = 1; k <= n; k++) {
      const i = (this.idx + k) % n;
      if ((this.cooldown.get(this.urls[i]) || 0) <= now) {
        this.idx = i;
        return;
      }
    }
    let bestIdx = 0;
    let bestUntil = Infinity;
    for (let i = 0; i < n; i++) {
      const until = this.cooldown.get(this.urls[i]) || 0;
      if (until < bestUntil) {
        bestUntil = until;
        bestIdx = i;
      }
    }
    const wait = Math.min(90000, bestUntil - now + 200);
    if (wait > 0) await sleep(wait);
    this.idx = bestIdx;
  }
  async call(method, params = [], timeoutMs = 20000) {
    let lastErr = null;
    const attempts = this.urls.length * 3;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await this.rotate();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(this.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: ctrl.signal,
        });
        if (res.status === 429) throw new Error('rate limited (HTTP 429)');
        if (res.status === 403) throw new Error('blocked (HTTP 403)');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (json.error) throw new Error(json.error.message || `rpc error ${json.error.code}`);
        this.cooldown.delete(this.url);
        return json.result;
      } catch (err) {
        lastErr = err;
        // Rate-limit style failures cool down much longer than plain errors —
        // hammering a throttling endpoint only extends the penalty window.
        const msg = String(err?.message || err).toLowerCase();
        const isRate =
          msg.includes('rate') || msg.includes('429') || msg.includes('403') || msg.includes('too many') || msg.includes('limit');
        this.cooldown.set(this.url, Date.now() + (isRate ? 75000 : 25000));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr || new Error(`${method} failed`);
  }
}

// ------------------------------------------------------------- log parsing

function parseTransferLog(log) {
  if (log.removed || !log.topics || log.topics.length < 3) return null;
  try {
    return {
      block: Number(BigInt(log.blockNumber)),
      txHash: (log.transactionHash || '').toLowerCase(),
      logIndex: Number(BigInt(log.logIndex || '0x0')),
      from: log.topics[1].slice(26).toLowerCase(),
      to: log.topics[2].slice(26).toLowerCase(),
      value: hexBig(log.data),
    };
  } catch {
    return null;
  }
}

// Decode an ABI-encoded `string` return (e.g. symbol()); tolerates junk.
function decodeAbiString(hex) {
  if (!hex || hex.length < 4) return null;
  try {
    const d = hex.slice(2);
    if (d.length >= 128) {
      const len = Number(BigInt('0x' + d.slice(64, 128)));
      if (len > 0 && 128 + len * 2 <= d.length) {
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = parseInt(d.slice(128 + i * 2, 130 + i * 2), 16);
        return new TextDecoder().decode(bytes).replace(/[^\x20-\x7e]/g, '').trim() || null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- fetch phases

// Binary search the first block where the contract code exists. Returns null
// when historical eth_getCode is unsupported (non-archive node) — caller falls
// back to a user-supplied start block.
async function findCreationBlock(client, address, latest) {
  try {
    const codeNow = await client.call('eth_getCode', [address, 'latest']);
    if (!codeNow || codeNow === '0x') return null;
  } catch {
    return null;
  }
  let lo = 1;
  let hi = latest;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      const code = await client.call('eth_getCode', [address, hexQty(mid)]);
      if (!code || code === '0x') lo = mid + 1;
      else hi = mid;
    } catch {
      return null; // historical state queries unsupported
    }
  }
  return lo;
}

// Deployer = `from` of the contract-creation tx (receipt.contractAddress match).
// Tokens deployed through factories report the factory here — accepted
// limitation; the EOA behind it usually shows up in the cluster anyway.
async function findDeployer(client, address, creationBlock) {
  try {
    const block = await client.call('eth_getBlockByNumber', [hexQty(creationBlock), true]);
    const txs = (block && block.transactions) || [];
    for (const tx of txs) {
      if (tx.to !== null && tx.to !== undefined) continue;
      const rcpt = await client.call('eth_getTransactionReceipt', [tx.hash]);
      if (rcpt && (rcpt.contractAddress || '').toLowerCase() === address.toLowerCase()) {
        return (tx.from || '').toLowerCase();
      }
    }
  } catch {
    /* best-effort */
  }
  return null;
}

// Backward ranged eth_getLogs with an adaptive window: shrink on error or when
// a response looks node-capped, grow back after quiet windows. Dedupes across
// overlapping retries by txHash:logIndex.
//
// startBlock === null enables SEEK MODE for full nodes without archive state
// (publicnode BSC et al. reject historical eth_getCode but serve getLogs):
// walk backwards until `silenceBlocks` consecutive empty blocks are crossed
// below the earliest event found — that boundary is the de-facto creation.
// Returns { transfers, startBlock } where startBlock is the earliest block
// with token activity (null when nothing was found).
export async function fetchAllTransfers(
  client,
  token,
  startBlock,
  latestBlock,
  { onProgress, isCancelled, maxWindow = 4900, maxLogs = 900, paceMs = 120, silenceBlocks = 150_000, seek = false } = {},
) {
  const out = [];
  const seen = new Set();
  const hardStart = seek ? 1 : startBlock;
  const total = latestBlock - hardStart + 1;
  let window = 2500;
  let cursor = latestBlock;
  let earliest = null;
  let silence = 0;
  let failStreak = 0;
  while (cursor >= hardStart) {
    if (isCancelled && isCancelled()) throw new Error('cancelled');
    if (seek && latestBlock - cursor > 3_000_000) break; // safety: no events in 3M blocks
    const to = cursor;
    const from = Math.max(hardStart, cursor - window + 1);
    let logs;
    try {
      logs = await client.call(
        'eth_getLogs',
        [{ address: token, fromBlock: hexQty(from), toBlock: hexQty(to), topics: [TOPIC_TRANSFER] }],
        30000,
      );
      if (!Array.isArray(logs) || logs.length > maxLogs) throw new Error('response capped');
    } catch (err) {
      failStreak += 1;
      if (failStreak > 40) {
        throw new Error(
          `public RPCs can't serve this scan (${err?.message || err}) — set an Etherscan V2 key for full history, ` +
            'use a custom archive RPC, or scan a recent block window',
        );
      }
      window = Math.max(150, Math.floor(window / 2));
      await sleep(400 + Math.random() * 400);
      continue;
    }
    failStreak = 0;
    let found = 0;
    for (const l of logs) {
      const t = parseTransferLog(l);
      if (!t) continue;
      const key = `${t.txHash}:${t.logIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
      found += 1;
      if (earliest === null || t.block < earliest) earliest = t.block;
    }
    if (onProgress) onProgress({ scanned: latestBlock - from + 1, total, logs: out.length, from, to });
    if (found > 0) {
      silence = 0;
      window = Math.min(maxWindow, Math.ceil(window * 1.4));
    } else {
      silence += to - from + 1;
      if (seek && earliest !== null && silence >= silenceBlocks) break; // crossed creation
      window = Math.min(maxWindow, window * 3); // leap across empty spans
    }
    cursor = from - 1;
    await sleep(paceMs); // pacing: stay under the public endpoints' rate radars
  }
  out.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  return { transfers: out, startBlock: seek ? earliest : startBlock };
}

// Timestamps for blocks seen in transfers. Exact headers are fetched in BATCHED
// JSON-RPC calls (~40/call) for anchor blocks spread over the token's whole
// history plus its most recent blocks; everything else is interpolated
// piecewise-linearly between anchors (block times are near-constant between
// hardforks, so the error stays in the seconds range — fine for day buckets).
async function loadTimestamps(client, blocks, onProgress, isCancelled) {
  const uniq = [...new Set(blocks)].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const map = new Map();
  if (!uniq.length) return map;
  const recent = uniq.slice(-240); // exact times where precision matters most
  const step = Math.max(25, Math.ceil(uniq.length / 240));
  const anchors = uniq.filter((_, i) => i % step === 0);
  const want = [...new Set([...anchors, ...recent])].sort((a, b) => a - b);

  const BATCH = 40;
  for (let i = 0; i < want.length; i += BATCH) {
    if (isCancelled && isCancelled()) break;
    const chunk = want.slice(i, i + BATCH);
    try {
      const results = await client.callBatch(
        'eth_getBlockByNumber',
        chunk.map((b) => [hexQty(b), false]),
        30000,
      );
      chunk.forEach((b, idx) => {
        const blk = results?.[idx]?.result;
        if (blk?.timestamp) map.set(b, Number(BigInt(blk.timestamp)) * 1000);
      });
    } catch {
      // endpoint rejected the batch — fall back to single calls
      for (const b of chunk) {
        try {
          const blk = await client.call('eth_getBlockByNumber', [hexQty(b), false]);
          if (blk?.timestamp) map.set(b, Number(BigInt(blk.timestamp)) * 1000);
        } catch {
          /* leave missing */
        }
      }
    }
    if (onProgress) onProgress({ done: Math.min(i + BATCH, want.length), total: want.length });
  }

  // Interpolate the remaining blocks between known anchors.
  const known = [...map.keys()].sort((a, b) => a - b);
  if (known.length) {
    for (const b of uniq) {
      if (map.has(b)) continue;
      let lo = 0;
      let hi = known.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (known[mid] <= b) lo = mid;
        else hi = mid - 1;
      }
      const b1 = known[lo];
      const b2 = known[Math.min(lo + 1, known.length - 1)];
      const t1 = map.get(b1);
      const t2 = map.get(b2);
      if (b2 > b1 && t1 && t2) {
        map.set(b, Math.round(t1 + ((b - b1) * (t2 - t1)) / (b2 - b1)));
      } else if (t1) {
        // single anchor or extrapolate with BSC-ish ~0.75-3s blocks — only
        // reachable at the range edges, clamped to a sane slope
        map.set(b, Math.round(t1 + (b - b1) * 1500));
      }
    }
  }
  return map;
}

// ------------------------------------------------- etherscan v2 (fast lane)
// Optional: an Etherscan V2 API key (https://etherscan.io/apidocs) hands us the
// COMPLETE transfer history + per-tx timestamps + the deployer in a handful of
// paginated calls. NOTE: the FREE plan only covers Ethereum mainnet — BSC/Base
// etc. need a paid plan, so on those chains the RPC scan below remains the
// default (BSC leans on NodeReal's archive demo endpoint, see chains.js).
async function etherscanV2(apiKey, params, timeoutMs = 25000) {
  const url = new URL('https://api.etherscan.io/v2/api');
  url.searchParams.set('apikey', apiKey);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.status === '0' && /rate limit/i.test(String(json.result || ''))) throw new Error('etherscan rate limited');
      if (json.status === '0') throw new Error(String(json.result || 'etherscan error'));
      return json.result;
    } catch (err) {
      lastErr = err;
      await sleep(1200 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

async function fetchEtherscanHistory({ chain, token, apiKey, fromBlock, onProgress, isCancelled }) {
  const common = { chainid: chain.etherscanChainId, contractaddress: token };
  onProgress({ phase: 'scan', detail: 'etherscan: fetching full transfer history…' });
  const transfers = [];
  const timestamps = new Map();
  const seen = new Set();
  let symbol = null;
  let decimals = null;
  let creationBlock = null;
  const OFFSET = 5000;
  for (let page = 1; page <= 40; page++) {
    if (isCancelled && isCancelled()) throw new Error('cancelled');
    const rows = await etherscanV2(apiKey, {
      ...common,
      module: 'account',
      action: 'tokentx',
      startblock: fromBlock > 0 ? fromBlock : 0,
      endblock: 99999999,
      page,
      offset: OFFSET,
      sort: 'asc',
    });
    for (const r of rows) {
      const key = `${r.hash}:${r.from}:${r.to}:${r.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const block = Number(r.blockNumber);
      transfers.push({
        block,
        txHash: String(r.hash).toLowerCase(),
        logIndex: transfers.length, // stable ordering (tokentx rows arrive in log order)
        from: String(r.from).toLowerCase(),
        to: String(r.to).toLowerCase(),
        value: BigInt(r.value || '0'),
      });
      const ts = Number(r.timeStamp) * 1000;
      if (ts > 0) timestamps.set(block, ts);
      if (creationBlock === null || block < creationBlock) creationBlock = block;
      if (symbol === null && r.tokenSymbol) symbol = r.tokenSymbol;
      if (decimals === null && r.tokenDecimal !== undefined && r.tokenDecimal !== '') decimals = Number(r.tokenDecimal);
    }
    onProgress({ phase: 'scan', detail: `etherscan: ${transfers.length} transfers…` });
    if (rows.length < OFFSET) break;
    await sleep(350); // free tier ≈ 5 calls/s
  }
  let deployer = null;
  try {
    const info = await etherscanV2(apiKey, { ...common, module: 'contract', action: 'getcontractcreation' });
    deployer = Array.isArray(info) && info[0] ? String(info[0].contractCreator || '').toLowerCase() || null : null;
  } catch {
    /* optional */
  }
  return { transfers, timestamps, creationBlock, symbol, decimals, deployer };
}

/**
 * Heavy phase: fetch everything needed for a token's report.
 * Returns a raw dataset that buildReport() can (re)process at will.
 */
export async function analyzeToken({ chain, token, customRpc, fromBlock, explorerKey, onProgress, isCancelled }) {
  const tokenCs = ethers.getAddress(token); // validates the address
  const tokenLc = tokenCs.toLowerCase();
  const client = new RpcClient(customRpc ? [customRpc, ...chain.http] : chain.http);

  onProgress({ phase: 'scan', detail: 'fetching latest block…' });
  const latest = Number(BigInt(await client.call('eth_blockNumber')));

  let decimals = 18;
  let symbol = null;
  try {
    decimals = Number(BigInt(await client.call('eth_call', [{ to: tokenLc, data: '0x313ce567' }, 'latest'])));
  } catch {
    /* default 18 */
  }
  try {
    symbol = decodeAbiString(await client.call('eth_call', [{ to: tokenLc, data: '0x95d89b41' }, 'latest']));
  } catch {
    /* optional */
  }

  // Fast lane: Etherscan V2 (optional key) — complete history with timestamps,
  // immune to the public RPCs' recent-blocks-only getLogs limits.
  if (explorerKey && chain.etherscanChainId) {
    try {
      const es = await fetchEtherscanHistory({ chain, token: tokenLc, apiKey: explorerKey, fromBlock, onProgress, isCancelled });
      if (!es.transfers.length) throw new Error('etherscan returned no transfers');
      let deployer = es.deployer;
      if (!deployer) {
        onProgress({ phase: 'cluster', detail: 'finding deployer…' });
        deployer = await findDeployer(client, tokenLc, es.creationBlock);
      }
      onProgress({ phase: 'index', detail: 'history loaded ✓' });
      return {
        chain,
        token: tokenCs,
        symbol: es.symbol || symbol,
        decimals: es.decimals ?? decimals,
        creationBlock: es.creationBlock,
        latestBlock: latest,
        deployer,
        transfers: es.transfers,
        timestamps: es.timestamps,
      };
    } catch (err) {
      if (err?.message === 'cancelled') throw err;
      onProgress({ phase: 'scan', detail: `etherscan failed (${err?.message || err}) — falling back to RPC scan…` });
    }
  }

  let creationBlock = null;
  let useSeek = false;
  if (fromBlock > 0) {
    creationBlock = fromBlock;
  } else {
    onProgress({ phase: 'scan', detail: 'locating creation block…' });
    const codeNow = await client.call('eth_getCode', [tokenLc, 'latest']);
    if (!codeNow || codeNow === '0x') {
      throw new Error(`address has no contract code on ${chain.name} — wrong chain or CA?`);
    }
    creationBlock = await findCreationBlock(client, tokenLc, latest);
    if (!creationBlock) {
      // No archive state on these endpoints — fall back to walking getLogs
      // backwards until the pre-creation silence (SEEK MODE, see above).
      useSeek = true;
      creationBlock = null;
      onProgress({ phase: 'scan', detail: 'no archive state on this RPC — seeking first activity via logs…' });
    }
  }

  onProgress({
    phase: 'scan',
    detail: useSeek ? 'seeking full history backwards…' : `scanning transfers since block ${creationBlock}…`,
  });
  const { transfers, startBlock } = await fetchAllTransfers(
    client,
    tokenLc,
    useSeek ? null : creationBlock,
    latest,
    {
      onProgress: (p) => onProgress({ phase: 'scan', ...p }),
      isCancelled,
      maxWindow: chain.scan?.maxWindow,
      maxLogs: chain.scan?.maxLogs,
      paceMs: chain.scan?.paceMs,
      seek: useSeek,
    },
  );
  if (useSeek) {
    if (!startBlock) {
      throw new Error(`no Transfer events found for this token on ${chain.name} — wrong chain or CA?`);
    }
    creationBlock = startBlock;
  }

  const nBlocks = new Set(transfers.map((t) => t.block)).size;
  onProgress({ phase: 'index', detail: `indexing timestamps for ${nBlocks.toLocaleString()} blocks…` });
  const timestamps = await loadTimestamps(
    client,
    transfers.map((t) => t.block),
    (p) => onProgress({ phase: 'index', ...p }),
    isCancelled,
  );

  onProgress({ phase: 'cluster', detail: 'finding deployer…' });
  const deployer = await findDeployer(client, tokenLc, creationBlock);

  return {
    chain,
    token: tokenCs,
    symbol,
    decimals,
    creationBlock,
    latestBlock: latest,
    deployer,
    transfers,
    timestamps,
  };
}

// ---------------------------------------------------------- report building

// Addresses swapping with many distinct counterparties in BOTH directions are
// DEX pools (or CEX hot wallets — effectively the same for classification).
export function detectPools(transfers, minDistinct) {
  const info = new Map();
  const touch = (a) => {
    let x = info.get(a);
    if (!x) {
      x = { inCp: new Set(), outCp: new Set(), txs: new Set() };
      info.set(a, x);
    }
    return x;
  };
  for (const t of transfers) {
    if (t.from === t.to) continue;
    const f = touch(t.from);
    f.outCp.add(t.to);
    f.txs.add(t.txHash);
    const o = touch(t.to);
    o.inCp.add(t.from);
    o.txs.add(t.txHash);
  }
  const pools = [];
  for (const [addr, x] of info) {
    if (addr === ZERO || addr === DEAD) continue;
    if (x.inCp.size >= minDistinct && x.outCp.size >= minDistinct) {
      pools.push({ address: addr, inCp: x.inCp.size, outCp: x.outCp.size, txCount: x.txs.size });
    }
  }
  pools.sort((a, b) => b.txCount - a.txCount);
  return pools;
}

class UnionFind {
  constructor() {
    this.parent = new Map();
  }
  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur);
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Cheap phase: classify transfers, find coordinated events, cluster wallets.
 * Safe to re-run whenever options change.
 */
export function buildReport(dataset, opts = {}) {
  const { minWallets = 3, minCoEvents = 2, linkMoves = true, poolMinDistinct = 8 } = opts;
  const extraPools = new Set((opts.extraPools || []).map((a) => a.toLowerCase()));
  const notPools = new Set((opts.notPools || []).map((a) => a.toLowerCase()));
  const { transfers, timestamps, decimals, deployer } = dataset;
  const div = 10 ** decimals;
  const toNum = (big) => Number(big) / div;
  const ts = (block) => timestamps.get(block) || null;

  // ---- pools ----
  const poolList = detectPools(transfers, poolMinDistinct).filter((p) => !notPools.has(p.address));
  const poolSet = new Set(poolList.map((p) => p.address));
  for (const a of extraPools) poolSet.add(a);
  const isPool = (a) => poolSet.has(a);

  // ---- balances & classification ----
  const balances = new Map();
  const bump = (a, v) => balances.set(a, (balances.get(a) || 0n) + v);
  let minted = 0n;
  let burned = 0n;
  const trades = []; // {block, txHash, dir, wallet, pool, value}
  const moves = []; // wallet↔wallet transfers (potential cluster links)
  for (const t of transfers) {
    if (t.from === ZERO) {
      minted += t.value;
      bump(t.to, t.value);
      continue;
    }
    bump(t.from, -t.value);
    if (t.to === ZERO || t.to === DEAD) {
      burned += t.value;
      continue;
    }
    bump(t.to, t.value);
    const fp = isPool(t.from);
    const tp = isPool(t.to);
    if (fp && tp) continue; // pool↔pool (migrations) — ignore
    if (fp) trades.push({ block: t.block, txHash: t.txHash, dir: 'buy', wallet: t.to, pool: t.from, value: t.value });
    else if (tp) trades.push({ block: t.block, txHash: t.txHash, dir: 'sell', wallet: t.from, pool: t.to, value: t.value });
    else moves.push(t);
  }
  const supply = toNum(minted - burned);

  // ---- per-wallet stats ----
  const wallets = new Map();
  const wInfo = (a) => {
    let w = wallets.get(a);
    if (!w) {
      w = { address: a, bought: 0n, sold: 0n, buys: 0, sells: 0, firstBlock: null, lastBlock: null };
      wallets.set(a, w);
    }
    return w;
  };
  for (const tr of trades) {
    const w = wInfo(tr.wallet);
    if (tr.dir === 'buy') {
      w.bought += tr.value;
      w.buys += 1;
    } else {
      w.sold += tr.value;
      w.sells += 1;
    }
    w.firstBlock = w.firstBlock === null ? tr.block : Math.min(w.firstBlock, tr.block);
    w.lastBlock = w.lastBlock === null ? tr.block : Math.max(w.lastBlock, tr.block);
  }

  // ---- coordinated events ----
  // Same-tx events (multicall bundles) are the strongest signal; same-block
  // events with many wallets are the 建倉/dump fingerprints at any point.
  const byTx = new Map();
  const byBlock = new Map();
  for (const tr of trades) {
    let e = byTx.get(tr.txHash);
    if (!e) {
      e = { block: tr.block, buy: new Map(), sell: new Map() };
      byTx.set(tr.txHash, e);
    }
    e[tr.dir].set(tr.wallet, (e[tr.dir].get(tr.wallet) || 0n) + tr.value);
    let b = byBlock.get(tr.block);
    if (!b) {
      b = { buy: new Map(), sell: new Map() };
      byBlock.set(tr.block, b);
    }
    b[tr.dir].set(tr.wallet, (b[tr.dir].get(tr.wallet) || 0n) + tr.value);
  }
  const events = [];
  for (const [txHash, e] of byTx) {
    for (const dir of ['buy', 'sell']) {
      const ws = [...e[dir].keys()];
      if (ws.length < 2) continue;
      let tokens = 0n;
      for (const v of e[dir].values()) tokens += v;
      events.push({ block: e.block, time: ts(e.block), kind: 'tx', dir, wallets: ws, tokens, txHash });
    }
  }
  for (const [block, b] of byBlock) {
    for (const dir of ['buy', 'sell']) {
      const ws = [...b[dir].keys()];
      if (ws.length < minWallets) continue;
      let tokens = 0n;
      for (const v of b[dir].values()) tokens += v;
      events.push({ block, time: ts(block), kind: 'block', dir, wallets: ws, tokens, txHash: null });
    }
  }
  events.sort((a, b) => a.block - b.block);

  // ---- clustering ----
  const uf = new UnionFind();
  for (const ev of events) {
    if (ev.kind !== 'tx') continue;
    for (let i = 1; i < ev.wallets.length; i++) uf.union(ev.wallets[0], ev.wallets[i]);
  }
  const co = new Map(); // pair → shared same-block events
  for (const ev of events) {
    if (ev.kind !== 'block' || ev.wallets.length > 30) continue; // huge viral blocks aren't clusters
    const ws = ev.wallets;
    for (let i = 0; i < ws.length; i++) {
      for (let j = i + 1; j < ws.length; j++) {
        const k = pairKey(ws[i], ws[j]);
        co.set(k, (co.get(k) || 0) + 1);
      }
    }
  }
  for (const [k, n] of co) {
    if (n < minCoEvents) continue;
    const [a, b] = k.split('|');
    uf.union(a, b);
  }
  if (linkMoves) {
    // Move-hubs (many distinct move counterparties) behave like unclassified
    // pools or CEX deposit addresses — linking through them chains strangers
    // into one mega-group, so skip any pair touching a hub. Real cluster
    // rebalances stay linked: intra-cluster move-degree stays low.
    const moveCp = new Map();
    const addCp = (a, b) => {
      let s = moveCp.get(a);
      if (!s) {
        s = new Set();
        moveCp.set(a, s);
      }
      s.add(b);
    };
    for (const m of moves) {
      addCp(m.from, m.to);
      addCp(m.to, m.from);
    }
    const isMoveHub = (a) => (moveCp.get(a)?.size || 0) >= poolMinDistinct;
    const moveSeen = new Set();
    for (const m of moves) {
      if (!wallets.has(m.from) || !wallets.has(m.to)) continue;
      if (isMoveHub(m.from) || isMoveHub(m.to)) continue;
      const k = pairKey(m.from, m.to);
      if (moveSeen.has(k)) continue; // one link per pair is enough
      moveSeen.add(k);
      uf.union(m.from, m.to);
    }
  }

  // ---- groups ----
  const comps = new Map();
  for (const addr of wallets.keys()) {
    const root = uf.find(addr);
    let arr = comps.get(root);
    if (!arr) {
      arr = [];
      comps.set(root, arr);
    }
    arr.push(addr);
  }
  const groups = [];
  const groupByWallet = new Map();
  for (const members of comps.values()) {
    if (members.length < 2) continue;
    let bag = 0n;
    let bought = 0n;
    let sold = 0n;
    const memberSet = new Set(members);
    for (const a of members) {
      const w = wallets.get(a);
      bag += balances.get(a) || 0n;
      bought += w.bought;
      sold += w.sold;
    }
    const gEvents = events
      .filter((ev) => ev.wallets.filter((w) => memberSet.has(w)).length >= 2)
      .slice(-150)
      .map((ev) => ({
        block: ev.block,
        time: ev.time,
        kind: ev.kind,
        dir: ev.dir,
        txHash: ev.txHash,
        nWallets: ev.wallets.length,
        tokens: toNum(ev.tokens),
      }));
    const timeline = new Map(); // dayKey → net tokens (buys − sells): the 建倉/dump/rebuy view
    for (const tr of trades) {
      if (!memberSet.has(tr.wallet)) continue;
      const t = ts(tr.block);
      const key = t ? new Date(t).toISOString().slice(0, 10) : `#${tr.block}`;
      timeline.set(key, (timeline.get(key) || 0) + (tr.dir === 'buy' ? 1 : -1) * (Number(tr.value) / div));
    }
    const isDev = deployer ? members.includes(deployer) : false;
    const g = {
      id: null,
      label: null,
      colorIdx: 0,
      isDev,
      nWallets: members.length,
      bagTokens: toNum(bag),
      bagPct: supply > 0 ? (Number(bag) / div / supply) * 100 : 0,
      boughtTokens: toNum(bought),
      soldTokens: toNum(sold),
      events: gEvents,
      timeline: [...timeline.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, net]) => ({ day, net })),
      wallets: members
        .map((a) => {
          const w = wallets.get(a);
          return {
            address: a,
            isDev: deployer === a,
            bought: toNum(w.bought),
            sold: toNum(w.sold),
            bag: toNum(balances.get(a) || 0n),
            buys: w.buys,
            sells: w.sells,
            firstBlock: w.firstBlock,
            lastBlock: w.lastBlock,
          };
        })
        .sort((a, b) => b.bag - a.bag),
    };
    groups.push(g);
    for (const a of members) groupByWallet.set(a, g);
  }
  groups.sort((a, b) => b.bagTokens - a.bagTokens);
  groups.forEach((g, i) => {
    g.id = `G${i + 1}`;
    g.label = g.isDev ? 'DEV' : `G${i + 1}`;
    g.colorIdx = g.isDev ? 9 : i % 8;
  });

  // ---- ungrouped notable holders ----
  const ungroupedTop = [...wallets.values()]
    .filter((w) => !groupByWallet.has(w.address) && !isPool(w.address))
    .sort((a, b) => (b.bought - b.sold > a.bought - a.sold ? 1 : -1))
    .slice(0, 12)
    .map((w) => ({
      address: w.address,
      isDev: deployer === w.address,
      bag: toNum(balances.get(w.address) || 0n),
      bagPct: supply > 0 ? (Number(balances.get(w.address) || 0n) / div / supply) * 100 : 0,
      buys: w.buys,
      sells: w.sells,
    }));

  const txCount = new Set(transfers.map((t) => t.txHash)).size;
  return {
    meta: {
      chain: dataset.chain,
      token: dataset.token,
      symbol: dataset.symbol,
      decimals,
      supply,
      creationBlock: dataset.creationBlock,
      latestBlock: dataset.latestBlock,
      deployer,
    },
    stats: {
      transfers: transfers.length,
      txs: txCount,
      wallets: wallets.size,
      buys: trades.filter((t) => t.dir === 'buy').length,
      sells: trades.filter((t) => t.dir === 'sell').length,
      moves: moves.length,
    },
    pools: poolList,
    groups,
    groupByWallet,
    poolSet,
    ungroupedTop,
    events: events.slice(-300).map((ev) => ({
      block: ev.block,
      time: ev.time,
      kind: ev.kind,
      dir: ev.dir,
      txHash: ev.txHash,
      nWallets: ev.wallets.length,
      tokens: toNum(ev.tokens),
    })),
  };
}

// --------------------------------------------------------------- live feed

/**
 * Live monitor: polls new Transfer logs for the token from `startBlock`.
 * Emits parsed transfers to onEvents(transfers, latestBlock); classification
 * and group tagging stay in the UI so re-clustering applies instantly.
 */
export function createLiveMonitor({ chain, customRpc, token, startBlock, onEvents, onError, isCancelled }) {
  const client = new RpcClient(customRpc ? [customRpc, ...chain.http] : chain.http);
  let timer = null;
  let stopped = false;
  let last = startBlock;
  let busy = false;

  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const latest = Number(BigInt(await client.call('eth_blockNumber')));
      const from = last + 1;
      if (latest >= from) {
        const to = Math.min(latest, from + chain.scanBlocks * 2);
        const logs = await client.call(
          'eth_getLogs',
          [{ address: token, fromBlock: hexQty(from), toBlock: hexQty(to), topics: [TOPIC_TRANSFER] }],
          30000,
        );
        const parsed = (logs || []).map(parseTransferLog).filter(Boolean);
        if (parsed.length && !stopped) onEvents(parsed, latest);
        last = to;
      }
    } catch (err) {
      if (!stopped) onError(err);
    } finally {
      busy = false;
    }
  };

  tick();
  timer = setInterval(() => {
    if (isCancelled && isCancelled()) {
      stop();
      return;
    }
    tick();
  }, chain.pollMs);

  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  }
  return {
    stop,
    get lastBlock() {
      return last;
    },
  };
}






