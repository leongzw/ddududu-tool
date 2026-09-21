// Batch minting engine: resolve a collection from a pasted link/CA, probe its
// mint entrypoint + price, then sign and broadcast mints from many wallets.
//
// Read paths (eth_call / estimateGas / getBalance …) work on any public RPC;
// writes go through eth_sendRawTransaction — keys never leave the browser.
import { ethers } from 'ethers';
import { chainById as monitorChainById } from './chains.js';

// Chains the mint panel can send on. Independent from the monitor registry
// (CHAINS) — adding a chain here does NOT subscribe the monitor to it.
export const MINT_CHAINS = [
  {
    id: 'eth',
    chainId: 1,
    name: 'Ethereum',
    short: 'ETH',
    native: 'ETH',
    explorer: 'https://etherscan.io',
    rpcs: ['https://ethereum-rpc.publicnode.com', 'https://cloudflare-eth.com', 'https://rpc.ankr.com/eth'],
  },
  {
    id: 'bsc',
    chainId: 56,
    name: 'BNB Smart Chain',
    short: 'BSC',
    native: 'BNB',
    explorer: 'https://bscscan.com',
    rpcs: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org', 'https://bsc.drpc.org'],
  },
  {
    id: 'polygon',
    chainId: 137,
    name: 'Polygon PoS',
    short: 'Polygon',
    native: 'POL',
    explorer: 'https://polygonscan.com',
    rpcs: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org'],
  },
  {
    id: 'base',
    chainId: 8453,
    name: 'Base',
    short: 'Base',
    native: 'ETH',
    explorer: 'https://basescan.org',
    rpcs: ['https://base-rpc.publicnode.com', 'https://base.drpc.org'],
  },
  {
    id: 'rh',
    chainId: 4663,
    name: 'Robinhood Chain',
    short: 'Robinhood',
    native: 'ETH',
    explorer: 'https://robinhoodchain.blockscout.com',
    rpcs: null, // reuse the monitor registry's endpoints
  },
];

export const mintChainById = (id) => MINT_CHAINS.find((c) => c.id === id) || MINT_CHAINS[0];

const rpcsOf = (chain) => chain.rpcs || monitorChainById(chain.id).http || [];

// OpenSea URL chain slugs → MINT_CHAINS ids
const OS_CHAIN = {
  ethereum: 'eth',
  eth: 'eth',
  matic: 'polygon',
  polygon: 'polygon',
  base: 'base',
  binance: 'bsc',
  'binance-smart-chain': 'bsc',
  bsc: 'bsc',
};

const ADDR_RE = /0x[0-9a-fA-F]{40}/;

/**
 * Parse user input into a mint target. Accepts:
 *   - an OpenSea asset/item URL — chain + contract embedded, fully resolvable
 *   - an OpenSea collection URL — slug only (resolved via the OpenSea API,
 *     key optional, or the local slug cache on the opensea-mint page)
 *   - a bare collection slug, e.g. "ntrpygenesis"
 *   - a raw contract address (chain must be picked manually)
 */
export function parseMintTarget(input) {
  const s = String(input || '').trim();
  if (!s) return { kind: 'empty' };

  const addrMatch = s.match(ADDR_RE);
  if (addrMatch) {
    let chain = null;
    if (/opensea\.io/i.test(s)) {
      for (const [slug, id] of Object.entries(OS_CHAIN)) {
        if (s.toLowerCase().includes(`/${slug}`)) {
          chain = id;
          break;
        }
      }
    }
    return { kind: 'address', addr: addrMatch[0].toLowerCase(), chain };
  }

  const slug = s.match(/opensea\.io\/(?:[a-z-]+\/)?collection\/([a-z0-9-]+)/i);
  if (slug) return { kind: 'slug', slug: slug[1].toLowerCase() };

  // A bare token like "ntrpygenesis" — treat it as a collection slug.
  if (/^[a-z0-9][a-z0-9-]{1,63}$/i.test(s)) return { kind: 'slug', slug: s.toLowerCase() };

  return { kind: 'invalid' };
}

// ---------------------------------------------------------------------------
// Mint by tx replay
// ---------------------------------------------------------------------------
//
// Paste a mint TX — bare hash or explorer URL (…/tx/0x…) — and re-fire its
// exact calldata + value from your own wallets. The original signature is
// never (and cannot be) reused; only the *intent* (to, data, value) is copied
// and re-signed locally, exactly like the other mint paths.

// …host/(tx|transactions)/0x…64hex…
const TX_URL_RE = /^(?:https?:\/\/)?([^/?#\s]+)\/(?:tx|transactions?)\/(0x[0-9a-fA-F]{64})(?:[/?#][^\s]*)?$/;

/** Parse pasted input into { hash, chainId? } or null when it isn't a tx.
 *  chainId is derived from a known explorer host (robinhoodchain.blockscout.com
 *  → 'rh', bscscan.com → 'bsc', …); an unknown host leaves the chain as-is. */
export function parseTxHash(input) {
  const s = String(input || '').trim();
  let hash = null;
  let host = null;
  const url = s.match(TX_URL_RE);
  if (url) {
    host = url[1].toLowerCase();
    hash = url[2].toLowerCase();
  } else if (/^0x[0-9a-fA-F]{64}$/.test(s)) {
    hash = s.toLowerCase();
  } else {
    return null;
  }
  let chainId = null;
  for (const c of MINT_CHAINS) {
    try {
      if (new URL(c.explorer).host === host) {
        chainId = c.id;
        break;
      }
    } catch {
      /* explorer entry without a URL — skip */
    }
  }
  return { hash, chainId };
}

// Log topics for mint detection (keccak of the signatures — exact event ids).
const T_TRANSFER = ethers.id('Transfer(address,address,uint256)');
const T_SINGLE = ethers.id('TransferSingle(address,address,address,uint256,uint256)');
const T_BATCH = ethers.id('TransferBatch(address,address,address,uint256[],uint256[])');
const padAddr = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const wordOf = (data, i) => String(data || '').slice(2 + i * 64, 2 + (i + 1) * 64); // 32-byte word, hex

/** Count NFTs minted by a tx from its receipt logs: ERC-721 Transfers from the
 *  zero address (1 each) + ERC-1155 TransferSingle/TransferBatch values.
 *  null = no mint-shaped log found (couldn't tell). */
function countMinted(logs) {
  let n = 0n;
  let seen = false;
  for (const lg of logs || []) {
    const topics = lg.topics || [];
    if (topics[0] === T_TRANSFER && topics.length === 4 && topics[1] === padAddr(ethers.ZeroAddress)) {
      n += 1n;
      seen = true;
    } else if (topics[0] === T_SINGLE && topics[2] === padAddr(ethers.ZeroAddress)) {
      n += BigInt(`0x${wordOf(lg.data, 1)}`);
      seen = true;
    } else if (topics[0] === T_BATCH && topics[2] === padAddr(ethers.ZeroAddress)) {
      try {
        const off = Number(BigInt(`0x${wordOf(lg.data, 1)}`)) / 32; // values[] offset
        const len = Number(BigInt(`0x${wordOf(lg.data, off)}`));
        for (let i = 0; i < len; i++) n += BigInt(`0x${wordOf(lg.data, off + 1 + i)}`);
        seen = true;
      } catch {
        /* malformed data — ignore this log */
      }
    }
  }
  return seen ? n : null;
}

/** Fetch a pasted mint tx and shape it for replay. Throws a human message on
 *  anything unusable (not found on that chain, contract creation, plain transfer). */
export async function fetchMintTx(chain, hash) {
  const call = makeRpc(chain);
  const tx = await call('eth_getTransactionByHash', [hash]);
  if (!tx) throw new Error(`tx ${hash.slice(0, 18)}… not found on ${chain.name} — check the chain selector`);
  if (!tx.to) throw new Error('that tx is a contract creation — there is nothing to replay');
  if (!tx.input || tx.input === '0x') throw new Error('that tx is a plain transfer (no calldata) — not a mint call');
  const receipt = await call('eth_getTransactionReceipt', [hash]).catch(() => null);
  const from = (tx.from || '').toLowerCase();
  return {
    hash,
    to: tx.to.toLowerCase(),
    calldata: tx.input,
    valueWei: BigInt(tx.value || 0),
    from,
    selector: tx.input.slice(0, 10),
    ok: receipt ? Number(receipt.status) === 1 : null, // null = still pending
    mintedQty: receipt ? countMinted(receipt.logs) : null,
    // The classic replay trap: calldata that embeds the ORIGINAL sender
    // (mintTo style) would keep minting to that address, not to your wallets.
    embedsSender: Boolean(from) && tx.input.toLowerCase().includes(padAddr(from)),
  };
}

/** Gas-probe an exact replay call. Mirrors probeMintMethod's soft-pass on the
 *  geth balance precheck: a broke probing wallet gets fallback gas + a warning
 *  instead of a dead end; a real revert still throws. */
export async function probeReplay(call, replay, from, valueWei) {
  const base = { sig: `replay ${replay.selector}`, to: replay.to, hasQty: true, replay };
  try {
    const gas = await call('eth_estimateGas', [
      { from, to: replay.to, data: replay.calldata, value: `0x${BigInt(valueWei).toString(16)}` },
    ]);
    return { ...base, gas: BigInt(gas) };
  } catch (err) {
    if (insufficientFunds(err)) {
      return {
        ...base,
        gas: 250_000n,
        warning:
          'estimate skipped — the probing wallet has no funds for value + gas. Fund the wallets before minting.',
      };
    }
    throw err; // real revert (sale over, wrong value, allowlist…) — surface it
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC helper with endpoint rotation
// ---------------------------------------------------------------------------

export function makeRpc(chain) {
  const urls = rpcsOf(chain);
  let idx = 0;
  const call = async (method, params) => {
    let lastErr;
    for (let attempt = 0; attempt < urls.length; attempt++) {
      const url = urls[(idx + attempt) % urls.length];
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
        });
        const json = await res.json();
        if (json.error) {
          const err = new Error(json.error.message || 'RPC error');
          err.rpcError = json.error;
          throw err;
        }
        idx = (idx + attempt) % urls.length; // stick to the healthy endpoint
        return json.result;
      } catch (e) {
        lastErr = e;
        if (e.rpcError) throw e; // node answered: don't rotate, surface it
      }
    }
    throw lastErr || new Error('all RPC endpoints failed');
  };
  call.chain = chain;
  // Batched JSON-RPC (spec-optional — support varies by endpoint): one POST
  // for many calls. Returns one { ok, value } | { ok: false, error } per
  // entry, in request order (responses are matched by id — servers may
  // reorder). Throws on transport failure or non-array reply so callers can
  // fall back to individual calls. Deliberately does NOT rotate endpoints —
  // it exists for time-critical volleys where one round trip matters.
  call.batch = async (entries) => {
    const url = urls[idx % urls.length];
    const reqs = entries.map((e, i) => ({ jsonrpc: '2.0', id: i + 1, method: e.method, params: e.params }));
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(reqs),
    });
    const json = await res.json();
    if (!Array.isArray(json)) {
      const err = new Error(json?.error?.message || 'endpoint rejected batched JSON-RPC');
      err.rpcError = json?.error || null;
      throw err;
    }
    const byId = new Map(json.map((r) => [r.id, r]));
    return reqs.map((req) => {
      const r = byId.get(req.id);
      if (r && r.error) {
        const err = new Error(r.error.message || 'RPC error');
        err.rpcError = r.error;
        return { ok: false, error: err };
      }
      return { ok: true, value: r ? r.result : undefined };
    });
  };
  return call;
}

// ---------------------------------------------------------------------------
// Collection probing
// ---------------------------------------------------------------------------

const SEL = {
  name: '0x06fdde03',
  symbol: '0x95d89b41',
};

const decodeStringReturn = (hex) => {
  if (!hex || hex === '0x' || hex.length < 128) return null;
  try {
    return ethers.AbiCoder.defaultAbiCoder().decode(['string'], hex)[0];
  } catch {
    return null;
  }
};

const decodeUintReturn = (hex) => {
  if (!hex || hex === '0x' || hex.length < 66) return null;
  try {
    return BigInt(ethers.AbiCoder.defaultAbiCoder().decode(['uint256'], hex)[0]);
  } catch {
    return null;
  }
};

/** Pull revert reason ("Error(string)") out of a failed eth_call/estimateGas. */
export function decodeRevertReason(err) {
  const data = err?.rpcError?.data;
  const hex = typeof data === 'string' ? data : data?.data ?? data?.originalError?.data;
  if (typeof hex === 'string' && hex.startsWith('0x') && hex.length >= 138) {
    try {
      const reason = decodeStringReturn(hex.slice(10)); // skip Error(string) selector
      if (reason) return reason;
    } catch {
      /* fall through */
    }
  }
  const msg = String(err?.message || err?.rpcError?.message || '');
  const m = msg.match(/execution reverted[^"']{0,120}/i);
  return m ? m[0] : msg.slice(0, 160) || 'transaction reverted';
}

/**
 * True when an eth_estimateGas failure is the node's balance precheck
 * ("insufficient funds for gas * price + value: … have X want Y"). geth-style
 * nodes run it BEFORE executing anything, so it says nothing about whether the
 * calldata is valid — a broke sender fails every value-bearing estimate.
 */
export const insufficientFunds = (err) =>
  /insufficient funds/i.test(String(err?.message || err?.rpcError?.message || ''));

// ---------------------------------------------------------------------------
// SeaDrop drops (Project Sea standard)
// ---------------------------------------------------------------------------
// ERC721SeaDrop tokens have NO public mint()/publicMint() — that's why the
// standard battery reverts on them. Public mints are routed through the
// canonical SeaDrop contract, which calls mintSeaDrop() back on the token.
// Drop state (price/window/wallet cap) also lives on the router, keyed by
// the nft contract address.
const SEADROP_ROUTER = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5';

const SEADROP_IFACE = new ethers.Interface([
  'function getPublicDrop(address) view returns (tuple(uint80 mintFee, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool active))',
  'function getAllowedFeeRecipients(address) view returns (address[])',
  'function mintPublic(address nftContract, address feeRecipient, address minterIfForMint, uint256 quantity)',
]);

/** Returns drop params + fee recipient, or null when the nft is not a SeaDrop drop. */
export async function resolveSeaDrop(call, addr) {
  try {
    const hex = await call('eth_call', [
      { to: SEADROP_ROUTER, data: SEADROP_IFACE.encodeFunctionData('getPublicDrop', [addr]) },
      'latest',
    ]);
    if (!hex || hex === '0x') return null;
    const drop = SEADROP_IFACE.decodeFunctionResult('getPublicDrop', hex)[0];
    const startTime = Number(drop.startTime ?? 0);
    const endTime = Number(drop.endTime ?? 0);
    const now = Date.now();
    // The router returns a zeroed struct (not a revert) for tokens it doesn't
    // manage — only treat as a SeaDrop drop when something is actually set.
    const mintFee = BigInt(drop.mintFee ?? 0);
    const maxPerWallet = Number(drop.maxTotalMintableByWallet ?? 0);
    const active = Boolean(drop.active);
    if (mintFee === 0n && startTime === 0 && endTime === 0 && maxPerWallet === 0 && !active) {
      return null;
    }
    let feeRecipient = ethers.ZeroAddress;
    const frHex = await call('eth_call', [
      { to: SEADROP_ROUTER, data: SEADROP_IFACE.encodeFunctionData('getAllowedFeeRecipients', [addr]) },
      'latest',
    ]).catch(() => null);
    if (frHex && frHex !== '0x') {
      try {
        const list = SEADROP_IFACE.decodeFunctionResult('getAllowedFeeRecipients', frHex)[0];
        if (Array.isArray(list) && list.length) feeRecipient = list[0];
      } catch {
        /* zero address is valid for fee-free drops */
      }
    }
    return {
      router: SEADROP_ROUTER,
      feeRecipient,
      mintFee,
      startTime,
      endTime,
      maxPerWallet,
      active,
      live: active && (startTime === 0 || startTime * 1000 <= now) && (endTime === 0 || now < endTime * 1000),
    };
  } catch {
    return null; // getPublicDrop reverted — not a SeaDrop drop
  }
}

/** name()/symbol() + a battery of common price getters. */
export async function resolveCollectionInfo(call, addr) {
  const info = { addr, name: null, symbol: null, price: null };
  const [nameHex, symbolHex] = await Promise.all([
    call('eth_call', [{ to: addr, data: SEL.name }, 'latest']).catch(() => null),
    call('eth_call', [{ to: addr, data: SEL.symbol }, 'latest']).catch(() => null),
  ]);
  info.name = decodeStringReturn(nameHex);
  info.symbol = decodeStringReturn(symbolHex);

  const priceSigs = [
    'price()', 'MINT_PRICE()', 'mintPrice()', 'cost()', 'publicMintPrice()',
    'salePrice()', 'PRICE()', 'mintCost()', 'mintRate()', 'getPrice()',
  ];
  const iface = new ethers.Interface(priceSigs.map((s) => `function ${s} view returns (uint256)`));
  for (const sig of priceSigs) {
    const data = iface.encodeFunctionData(sig.replace('()', ''));
    const hex = await call('eth_call', [{ to: addr, data }, 'latest']).catch(() => null);
    const v = decodeUintReturn(hex);
    if (v != null && v < 10n ** 20n) {
      info.price = v; // first sane-looking getter wins
      break;
    }
  }

  // SeaDrop drops keep their price on the router, not the token.
  info.seadrop = await resolveSeaDrop(call, addr);
  if (info.price == null && info.seadrop) info.price = info.seadrop.mintFee;
  return info;
}

// Candidate mint entrypoints, most common first. `q` marks the quantity
// argument, `a` an address argument (filled with the minting wallet).
const MINT_SIGS = [
  'mint()',
  'mint(uint256 q)',
  'publicMint(uint256 q)',
  'publicSaleMint(uint256 q)',
  'freeMint(uint256 q)',
  'claim()',
  'claim(uint256 q)',
  'mintTo(address a, uint256 q)',
  'mintFor(address a, uint256 q)',
  'safeMint(address a)',
  'safeMint(address a, uint256 q)',
  'mint(address a, uint256 q)',
  'purchase(uint256 q)',
  'mint(uint256 q, address a)',
];

/** Strip the inline param-name hints so ethers can parse the signature. */
const cleanSig = (sig) => sig.replace(/\s*\b(?:q|a)\b/g, '');

/** Encode a mint call for a specific wallet + quantity. */
export function encodeMintCall(sig, qty, fromAddress) {
  const iface = new ethers.Interface([`function ${cleanSig(sig)}`]);
  const fn = Object.values(iface.fragments)[0];
  const args = fn.inputs.map((p) => (p.type === 'address' ? fromAddress : BigInt(qty)));
  return {
    data: iface.encodeFunctionData(fn.name, args),
    hasQty: fn.inputs.some((p) => p.type === 'uint256'),
  };
}

/**
 * Find a working mint call. Returns { sig, data, gas, hasQty, to?, encode?, valuePerMintWei? }
 * or throws with the most informative revert reason found (sale closed, wrong
 * value, …). `seadrop` (from resolveCollectionInfo) routes public drops of
 * ERC721SeaDrop tokens through the canonical SeaDrop contract.
 */
export async function probeMintMethod(call, addr, from, qty, valueWei, customSig, seadrop) {
  let seadropReason = null;

  if (seadrop && !customSig) {
    // mintPublic sends N in one tx and requires the exact drop fee — the
    // configured mintFee overrides whatever the value field says. encode
    // must return { data, hasQty } like encodeMintCall does below.
    const encode = (q) => ({
      data: SEADROP_IFACE.encodeFunctionData('mintPublic', [
        addr,
        seadrop.feeRecipient,
        ethers.ZeroAddress,
        BigInt(q),
      ]),
      hasQty: true,
    });
    const value = BigInt(seadrop.mintFee) * BigInt(qty);
    try {
      const encoded = encode(qty);
      const gas = await call('eth_estimateGas', [
        { from, to: SEADROP_ROUTER, data: encoded.data, value: `0x${value.toString(16)}` },
      ]);
      return {
        sig: 'mintPublic(address,address,address,uint256)',
        gas: BigInt(gas),
        hasQty: true,
        to: SEADROP_ROUTER,
        encode,
        valuePerMintWei: BigInt(seadrop.mintFee),
      };
    } catch (err) {
      if (insufficientFunds(err)) {
        // Balance precheck fired before execution — the canonical mintPublic
        // encoding is fine; the sender just can't cover value + gas. Soft-pass
        // with a generous scaled fallback gas; the UI warns to fund wallets.
        return {
          sig: 'mintPublic(address,address,address,uint256)',
          gas: 250_000n + 80_000n * BigInt(Math.max(1, qty)),
          hasQty: true,
          to: SEADROP_ROUTER,
          encode,
          valuePerMintWei: BigInt(seadrop.mintFee),
          warning:
            `estimate skipped — the probing wallet can't cover ${ethers.formatEther(value)} ` +
            `${call.chain?.native || 'ETH'} value + gas. Fund the wallets before minting.`,
        };
      }
      seadropReason = `mintPublic: ${decodeRevertReason(err)}`;
    }
  }

  const sigs = customSig && customSig.trim() ? [customSig.trim(), ...MINT_SIGS] : [...MINT_SIGS];
  let bestReason = null;
  let noFunds = null; // first candidate rejected only by the balance precheck

  for (const sig of sigs) {
    let encoded;
    try {
      encoded = encodeMintCall(sig, qty, from);
    } catch {
      continue; // unencodable signature — skip
    }
    try {
      const gas = await call('eth_estimateGas', [
        { from, to: addr, data: encoded.data, value: `0x${BigInt(valueWei).toString(16)}` },
      ]);
      return { sig, data: encoded.data, gas: BigInt(gas), hasQty: encoded.hasQty };
    } catch (err) {
      if (!bestReason) bestReason = `${sig}: ${decodeRevertReason(err)}`;
      if (insufficientFunds(err)) {
        // The precheck fails identically for every signature from a broke
        // wallet, so stop trying — soft-pass this one with fallback gas
        // instead of failing with a misleading "no mint function" error.
        noFunds = {
          sig,
          hasQty: encoded.hasQty,
          gas: encoded.hasQty ? 150_000n + 80_000n * BigInt(Math.max(1, qty)) : 200_000n,
        };
        break;
      }
    }
  }
  if (noFunds) {
    return {
      sig: noFunds.sig,
      gas: noFunds.gas,
      hasQty: noFunds.hasQty,
      warning:
        'estimate skipped — the probing wallet has no funds for value + gas, so the signature ' +
        'could not be verified. Fund the wallets (and double-check the function) before minting.',
    };
  }
  throw new Error(
    `No mint function passed gas estimation — last reason: ${seadropReason || bestReason || 'unknown'}. ` +
      'Check the sale is live, the mint value matches, or set a custom function signature.',
  );
}

// ---------------------------------------------------------------------------
// Fees
// ---------------------------------------------------------------------------

export async function feePlan(call, chain) {
  const [feeHist, gasPrice] = await Promise.all([
    call('eth_feeHistory', ['2', 'latest', []]).catch(() => null),
    call('eth_gasPrice', []).catch(() => null),
  ]);
  let maxPriority = 2n * 10n ** 9n;
  if (chain.id === 'bsc') maxPriority = 3n * 10n ** 9n; // BSC validators want ≥3 gwei tips
  let maxFee = gasPrice ? (BigInt(gasPrice) * 130n) / 100n : 30n * 10n ** 9n;
  if (feeHist?.baseFeePerGas?.length) {
    const base = BigInt(feeHist.baseFeePerGas[feeHist.baseFeePerGas.length - 1]);
    maxFee = base * 2n + maxPriority;
  }
  const legacyGas = gasPrice ? (BigInt(gasPrice) * 125n) / 100n : null;
  return { maxFee, maxPriority, legacyGas };
}

// ---------------------------------------------------------------------------
// Batch runner
// ---------------------------------------------------------------------------
//
// onEvent({ type, ... }) receives:
//   'wallet-start' { address }           'tx-sent' { address, hash, n, total }
//   'tx-mined'     { address, hash, ok } 'tx-error' { address, error, fatal }
//
// Wallets run sequentially (public RPCs rate-limit aggressively). The returned
// promise resolves when the whole batch settles. abortRef = { current: false }
// flipped by the UI to stop after the current transaction.
export async function runBatch({
  chain,
  wallets,
  contract,
  method,
  qtyPerWallet,
  valuePerMintWei,
  gasLimitOverride,
  onEvent,
  abortRef,
}) {
  const call = makeRpc(chain);
  const chainId = chain.chainId;

  for (const wallet of wallets) {
    if (abortRef.current) break;
    onEvent({ type: 'wallet-start', address: wallet.address });

    const signer = new ethers.Wallet(wallet.key);
    let nonce;
    try {
      nonce = BigInt(await call('eth_getTransactionCount', [wallet.address, 'pending']));
    } catch (err) {
      onEvent({ type: 'tx-error', address: wallet.address, error: `nonce fetch failed: ${err.message}`, fatal: true });
      continue;
    }

    // Pre-flight balance: skip broke wallets with a clear message instead of
    // letting every broadcast bounce with the node's raw insufficient-funds error.
    let balance = null;
    try {
      balance = BigInt(await call('eth_getBalance', [wallet.address, 'latest']));
    } catch {
      /* best effort — the node will reject the broadcast if truly broke */
    }

    // Re-encode per wallet: address-arg functions (mintTo/safeMint) must mint
    // to THIS wallet, and the quantity must match the run (not the probe).
    // SeaDrop methods carry their own router target + encoder + exact fee.
    const encoded = method.encode
      ? method.encode(qtyPerWallet)
      : encodeMintCall(method.sig, qtyPerWallet, wallet.address);
    const txCount = encoded.hasQty ? 1 : qtyPerWallet; // qty-arg methods mint N in one tx
    const perMint =
      method.valuePerMintWei != null ? BigInt(method.valuePerMintWei) : BigInt(valuePerMintWei);
    const valuePerTx = encoded.hasQty ? perMint * BigInt(qtyPerWallet) : perMint;
    const gasLimit = gasLimitOverride ? BigInt(gasLimitOverride) : (method.gas * 150n) / 100n;

    for (let n = 0; n < txCount; n++) {
      if (abortRef.current) break;
      try {
        const fees = await feePlan(call, chain);
        if (balance != null && balance < valuePerTx + gasLimit * fees.maxFee) {
          onEvent({
            type: 'tx-error',
            address: wallet.address,
            error:
              `skipped — insufficient funds: have ${ethers.formatEther(balance)} ${chain.native}, ` +
              `need ≈ ${ethers.formatEther(valuePerTx + gasLimit * fees.maxFee)} (value + max gas)`,
            fatal: true,
          });
          break;
        }
        const base = {
          to: method.to || contract,
          data: encoded.data,
          nonce: nonce + BigInt(n),
          chainId,
          gasLimit,
          value: valuePerTx,
        };
        let signed;
        try {
          signed = await signer.signTransaction({
            ...base,
            type: 2,
            maxFeePerGas: fees.maxFee,
            maxPriorityFeePerGas: fees.maxPriority,
          });
        } catch {
          signed = await signer.signTransaction({ ...base, type: 0, gasPrice: fees.legacyGas || 30n * 10n ** 9n });
        }

        const localHash = ethers.keccak256(ethers.getBytes(signed));
        const hash = (await call('eth_sendRawTransaction', [signed])) || localHash;
        onEvent({ type: 'tx-sent', address: wallet.address, hash, n, total: txCount });

        // Poll the receipt for up to ~5 minutes.
        let receipt = null;
        for (let i = 0; i < 100 && !receipt; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          if (abortRef.current) break;
          receipt = await call('eth_getTransactionReceipt', [hash]).catch(() => null);
        }
        onEvent({
          type: 'tx-mined',
          address: wallet.address,
          hash,
          ok: receipt ? Number(receipt.status) === 1 : null,
        });
      } catch (err) {
        onEvent({ type: 'tx-error', address: wallet.address, error: decodeRevertReason(err), fatal: true });
        break; // stop this wallet — likely a nonce/balance/allowance issue
      }
    }
  }
  onEvent({ type: 'done' });
}
// ---------------------------------------------------------------------------
// Precision sniper
// ---------------------------------------------------------------------------
//
// The poll loop above can only *notice* a sale opened — up to a full interval
// late — and fire()'s probe/nonce/fee RPCs then add more delay. For drops with
// a known start, runSnipeBatch does every slow thing BEFORE T (skew probe,
// nonce, balance, fees, signing), waits, and at T only broadcasts. The wait is
// aligned to the chain's clock: local clocks drift by seconds, and a tx that
// lands one block early reverts — so a nonce+1 retry backs up the timing.

/** Local↔chain clock offset in ms (positive = chain ahead), from block
 *  timestamps. Uses the freshest of several samples because timestamps are
 *  floored to whole seconds. */
export async function chainSkewMs(call) {
  const samples = [];
  for (let i = 0; i < 5; i++) {
    try {
      const blk = await call('eth_getBlockByNumber', ['latest', false]);
      if (blk?.timestamp) samples.push(Number(BigInt(blk.timestamp) * 1000n) - Date.now());
    } catch {
      /* RPC hiccup — remaining samples carry it */
    }
    if (i < 4) await new Promise((r) => setTimeout(r, 350));
  }
  if (!samples.length) return 0;
  return Math.max(-15_000, Math.min(15_000, Math.max(...samples)));
}

/** Static SeaDrop mintPublic method — encodable before the drop opens, so the
 *  sniper can pre-sign without a (reverting) gas estimate. Mirrors the
 *  probeMintMethod SeaDrop branch; gas is a generous scaled fallback. */
export function seadropMethod(seadrop, qty, addr) {
  const encode = (q) => ({
    data: SEADROP_IFACE.encodeFunctionData('mintPublic', [
      addr,
      seadrop.feeRecipient,
      ethers.ZeroAddress,
      BigInt(q),
    ]),
    hasQty: true,
  });
  return {
    sig: 'mintPublic(address,address,address,uint256)',
    gas: 250_000n + 80_000n * BigInt(Math.max(1, qty)),
    hasQty: true,
    to: SEADROP_ROUTER,
    encode,
    valuePerMintWei: BigInt(seadrop.mintFee),
  };
}


export async function runSnipeBatch({
  chain,
  wallets,
  contract,
  method,
  qtyPerWallet,
  valuePerMintWei,
  gasLimitOverride,
  onEvent,
  abortRef,
  fireAt, // epoch ms of the drop start, in *chain* time
  isLive = null, // optional async () => boolean — fire early if the drop opens early
}) {
  const call = makeRpc(chain);
  const chainId = chain.chainId;
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- Phase 1 · pre-warm: everything slow happens now, not at T. ----
  const fees = await feePlan(call, chain).catch(() => ({
    maxFee: 30n * 10n ** 9n,
    maxPriority: 2n * 10n ** 9n,
    legacyGas: null,
  }));
  const maxFee = (fees.maxFee * 3n) / 2n; // fees are set up to a minute early — extra headroom
  // Batched-send support is endpoint-specific (e.g. the backup Robinhood RPC
  // rejects arrays). Probe it here, during warm, where a round trip is free —
  // at T we then ship every tx in ONE request, or fan out individually.
  const batchOk = await call
    .batch([
      { method: 'eth_chainId', params: [] },
      { method: 'eth_blockNumber', params: [] },
    ])
    .then((rs) => rs.every((r) => r.ok))
    .catch(() => false);
  // Skip clock alignment when firing immediately (drop already open) — the
  // ~1.5 s skew sampler would only add delay.
  const align = fireAt - Date.now() > 2500;
  const skewMs = align ? await chainSkewMs(call) : 0;
  // Fire when the chain's clock actually reaches the start (+300 ms pad so a
  // floored block timestamp can't make us land one block early).
  const fireAtLocal = fireAt - skewMs + (align ? 300 : 0);

  // Pre-warm all wallets in parallel (nonce + balance + signing) so an
  // N-wallet batch costs ~one round trip, not N sequential ones.
  const warmed = await Promise.all(
    wallets.map(async (wallet) => {
      if (abortRef.current) return null;
      const signer = new ethers.Wallet(wallet.key);
      let nonce;
      try {
        nonce = BigInt(await call('eth_getTransactionCount', [wallet.address, 'pending']));
      } catch (err) {
        return { wallet, error: `nonce fetch failed: ${err.message}` };
      }
      let balance = null;
      try {
        balance = BigInt(await call('eth_getBalance', [wallet.address, 'latest']));
      } catch {
        /* best effort — the node will reject the broadcast if truly broke */
      }

      const encoded = method.encode
        ? method.encode(qtyPerWallet)
        : encodeMintCall(method.sig, qtyPerWallet, wallet.address);
      const txCount = encoded.hasQty ? 1 : qtyPerWallet;
      const perMint =
        method.valuePerMintWei != null ? BigInt(method.valuePerMintWei) : BigInt(valuePerMintWei);
      const valuePerTx = encoded.hasQty ? perMint * BigInt(qtyPerWallet) : perMint;
      const gasLimit = gasLimitOverride ? BigInt(gasLimitOverride) : (method.gas * 150n) / 100n;
      const to = method.to || contract;

      if (balance != null && balance < valuePerTx + gasLimit * maxFee) {
        return {
          wallet,
          error:
            `skipped — insufficient funds: have ${ethers.formatEther(balance)} ${chain.native}, ` +
            `need ≈ ${ethers.formatEther(valuePerTx + gasLimit * maxFee)} (value + max gas)`,
        };
      }

      const txs = [];
      for (let n = 0; n < txCount; n++) {
        const base = { to, data: encoded.data, nonce: nonce + BigInt(n), chainId, gasLimit, value: valuePerTx };
        let signed;
        try {
          signed = await signer.signTransaction({
            ...base,
            type: 2,
            maxFeePerGas: maxFee,
            maxPriorityFeePerGas: fees.maxPriority,
          });
        } catch {
          signed = await signer.signTransaction({ ...base, type: 0, gasPrice: fees.legacyGas || 30n * 10n ** 9n });
        }
        txs.push({ signed, hash: ethers.keccak256(ethers.getBytes(signed)), nonce: nonce + BigInt(n) });
      }
      return { wallet, signer, to, data: encoded.data, valuePerTx, gasLimit, txs };
    }),
  );

  const jobs = [];
  for (const r of warmed) {
    if (!r) continue; // skipped after abort
    if (r.error) {
      onEvent({ type: 'tx-error', address: r.wallet.address, error: r.error, fatal: true });
      continue;
    }
    jobs.push(r);
    onEvent({ type: 'warm', address: r.wallet.address, txs: r.txs.length });
  }


  // ---- Phase 2 · precise wait (abort-responsive; early-fire if it opens early). ----
  let lastLiveCheck = 0;
  while (!abortRef.current && Date.now() < fireAtLocal) {
    if (isLive && Date.now() - lastLiveCheck > 2000) {
      lastLiveCheck = Date.now();
      if (await isLive().catch(() => false)) break;
    }
    await nap(50);
  }
  if (abortRef.current) {
    onEvent({ type: 'done' });
    return;
  }

  // ---- Phase 3 · fire: every wallet's broadcasts go out together. ----
  for (const job of jobs) onEvent({ type: 'wallet-start', address: job.wallet.address });
  const sends = [];
  for (const job of jobs) for (let i = 0; i < job.txs.length; i++) sends.push({ job, t: job.txs[i], i });
  // 0 = pending, 1 = broadcast, 2 = definitively rejected by the node
  const state = new Array(sends.length).fill(0);
  if (batchOk && sends.length > 1 && !abortRef.current) {
    // One request for the whole volley: a single RTT and all txs land in the
    // node's mempool together — no browser per-host connection queuing.
    try {
      const rs = await call.batch(sends.map(({ t }) => ({ method: 'eth_sendRawTransaction', params: [t.signed] })));
      sends.forEach((s, k) => {
        const r = rs[k];
        if (r.ok && r.value) {
          state[k] = 1;
          s.t.sent = true;
          onEvent({ type: 'tx-sent', address: s.job.wallet.address, hash: r.value, n: s.i, total: s.job.txs.length });
        } else if (!r.ok) {
          state[k] = 2; // node answered with a per-entry error — resending won't change it
          onEvent({ type: 'tx-error', address: s.job.wallet.address, error: decodeRevertReason(r.error) || r.error.message, fatal: true });
        }
        // ok-but-no-hash entries stay pending → individually resent below
      });
    } catch {
      /* transport-level failure — everything stays pending for the fan-out */
    }
  }
  await Promise.all(
    sends.map(async (s, k) => {
      if (state[k] !== 0 || abortRef.current) return;
      try {
        const hash = (await call('eth_sendRawTransaction', [s.t.signed])) || s.t.hash;
        s.t.sent = true;
        onEvent({ type: 'tx-sent', address: s.job.wallet.address, hash, n: s.i, total: s.job.txs.length });
      } catch (err) {
        onEvent({ type: 'tx-error', address: s.job.wallet.address, error: decodeRevertReason(err) || err.message, fatal: true });
      }
    }),
  );

  // ---- Phase 4 · receipts (+ one nonce+1 retry for a tx that raced the opening block). ----
  const awaitReceipt = async (hash) => {
    for (let k = 0; k < 100; k++) {
      await nap(3000);
      if (abortRef.current) return null;
      const r = await call('eth_getTransactionReceipt', [hash]).catch(() => null);
      if (r) return r;
    }
    return null;
  };
  await Promise.all(
    jobs.map(async (job) => {
      for (let i = 0; i < job.txs.length; i++) {
        if (abortRef.current) break;
        const t = job.txs[i];
        if (!t.sent) continue; // never made it to the mempool — nothing to wait for
        let hash = t.hash;
        let receipt = await awaitReceipt(t.hash);
        let ok = receipt ? Number(receipt.status) === 1 : null;
        if (ok === false && !abortRef.current) {
          onEvent({
            type: 'tx-error',
            address: job.wallet.address,
            error: 'reverted on-chain (raced the opening block?) — retrying once with the next nonce',
            fatal: false,
          });
          try {
            const fresh = await feePlan(call, chain);
            const retry = await job.signer.signTransaction({
              to: job.to,
              data: job.data,
              nonce: t.nonce + 1n,
              chainId,
              gasLimit: job.gasLimit,
              value: job.valuePerTx,
              type: 2,
              maxFeePerGas: fresh.maxFee,
              maxPriorityFeePerGas: fresh.maxPriority,
            });
            hash = (await call('eth_sendRawTransaction', [retry])) || ethers.keccak256(ethers.getBytes(retry));
            onEvent({ type: 'tx-sent', address: job.wallet.address, hash, n: i, total: job.txs.length });
            receipt = await awaitReceipt(hash);
            ok = receipt ? Number(receipt.status) === 1 : null;
          } catch (err) {
            onEvent({ type: 'tx-error', address: job.wallet.address, error: `retry failed: ${decodeRevertReason(err) || err.message}`, fatal: false });
          }
        }
        onEvent({ type: 'tx-mined', address: job.wallet.address, hash, ok });
      }
    }),
  );
  onEvent({ type: 'done' });
}
