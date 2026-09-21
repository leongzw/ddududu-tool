// Live NFT mint streams over public JSON-RPC endpoints for any configured chain.
// Watches ERC-721 / ERC-1155 Transfer events emitted from the zero address (mints).
//
// Two transports (see chains.js):
//   WebSocket — the node pushes mint logs via eth_subscribe (no CORS restrictions).
//   HTTP poll — ranged eth_getLogs queries against HTTP-only RPCs; windows are
//               kept small because nodes cap logs per response.
// No API keys required.

export const TOPIC_ERC721_TRANSFER =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const TOPIC_ERC1155_SINGLE =
  '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
export const TOPIC_ERC1155_BATCH =
  '0x4a39dc06d4c0dbc64b70a5b0d3c8b0e4e2b6e1b0f8ff8a89ff3d1c6c1b8d0e4c';

const ZERO_ADDRESS_TOPIC =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

// Per-chain mint standards (see chains.js); defaults to tracking both.
const standardsOf = (chain) => (chain.standards?.length ? chain.standards : ['erc721', 'erc1155']);

// Subscription filters — one per event signature (WebSocket transports).
export function subscriptionFilters(chain) {
  const std = standardsOf(chain);
  const filters = [];
  if (std.includes('erc721')) filters.push([TOPIC_ERC721_TRANSFER, ZERO_ADDRESS_TOPIC]);
  if (std.includes('erc1155')) {
    filters.push([TOPIC_ERC1155_SINGLE, null, ZERO_ADDRESS_TOPIC]);
    filters.push([TOPIC_ERC1155_BATCH, null, ZERO_ADDRESS_TOPIC]);
  }
  return filters;
}

// Merged getLogs filters — 1155 single+batch share the same topic layout and
// the zero address sits one position later than in ERC-721 (HTTP transports).
export function getLogsFilters(chain) {
  const std = standardsOf(chain);
  const filters = [];
  if (std.includes('erc721')) filters.push([TOPIC_ERC721_TRANSFER, ZERO_ADDRESS_TOPIC]);
  if (std.includes('erc1155')) filters.push([[TOPIC_ERC1155_SINGLE, TOPIC_ERC1155_BATCH], null, ZERO_ADDRESS_TOPIC]);
  return filters;
}

const CALL_TIMEOUT_MS = 12000;
const HEARTBEAT_INTERVAL_MS = 15000;
const STALE_SOCKET_MS = 45000;

const utf8Decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

export const hexToBigint = (h) => (h && h !== '0x' ? BigInt(h) : 0n);

// Block timestamp (hex seconds) → epoch ms. Returns null when the field is
// missing, unparsable, or zero: Arbitrum Orbit nodes (Robinhood Chain) carry
// blockTimestamp in eth_getLogs but always report it as "0x0", so callers must
// fall back to wall-clock time instead of rendering the 1970 epoch.
export const stampMs = (hex) => {
  try {
    if (typeof hex !== 'string' || !/^0x[0-9a-f]+$/i.test(hex)) return null;
    const s = Number(BigInt(hex));
    return s > 0 ? s * 1000 : null;
  } catch {
    return null;
  }
};

export const pad32Hex = (value) => {
  const h = typeof value === 'bigint' ? value.toString(16) : String(value).replace(/^0x/i, '');
  return h.padStart(64, '0');
};

export const topicToAddress = (topic) => '0x' + topic.slice(26);

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Decode an ABI-encoded `string` return value; tolerates some non-standard
// contracts that return fixed bytes instead.
export function decodeAbiString(hex) {
  if (!hex || hex === '0x' || hex.length < 2) return null;
  const d = hex.slice(2);
  try {
    if (d.length >= 128) {
      const len = Number(BigInt('0x' + d.slice(64, 128)));
      if (len > 0 && 128 + len * 2 <= d.length) {
        return sanitizeUtf8(hexToBytes(d.slice(128, 128 + len * 2)));
      }
    }
    return sanitizeUtf8(hexToBytes(d));
  } catch {
    return null;
  }
}

function sanitizeUtf8(bytes) {
  if (!utf8Decoder) return null;
  const decoded = utf8Decoder.decode(bytes);
  let s = '';
  for (const ch of decoded) {
    const code = ch.charCodeAt(0);
    if (code >= 32 && code !== 127) s += ch;
  }
  s = s.trim();
  if (!s) return null;
  let printable = 0;
  for (const ch of s) if (ch.charCodeAt(0) >= 32) printable++;
  return printable / [...s].length >= 0.7 ? s : null;
}

// Parse a raw subscription/poll log into a normalized mint event (or null).
export function parseMintLog(log) {
  if (log.removed) return null; // reorg-removed log (poll transports)
  const topic = log.topics?.[0];
  const address = log.address?.toLowerCase();
  if (!topic || !address) return null;
  const tsMs = stampMs(log.blockTimestamp) ?? Date.now();
  const blockNumber = log.blockNumber ? parseInt(log.blockNumber, 16) : 0;
  const txHash = log.transactionHash || '';
  const logIndex = log.logIndex || '0x0';

  if (topic === TOPIC_ERC721_TRANSFER && log.topics.length >= 3) {
    // Standard ERC-721 indexes tokenId (4 topics, empty data); some non-standard
    // contracts emit it unindexed in data (3 topics) — that form is ambiguous
    // with ERC-20 mints and gets resolved by the classifier instead.
    const idIndexed = log.topics.length >= 4;
    return {
      standard: 'erc721', address, tsMs, blockNumber, txHash, logIndex,
      minter: topicToAddress(log.topics[2]),
      tokenId: idIndexed ? hexToBigint(log.topics[3]) : hexToBigint(log.data),
      idIndexed,
      amount: 1,
    };
  }
  if (topic === TOPIC_ERC1155_SINGLE && log.topics.length >= 4) {
    const d = (log.data || '0x').slice(2).padEnd(128, '0');
    return {
      standard: 'erc1155', address, tsMs, blockNumber, txHash, logIndex,
      minter: topicToAddress(log.topics[3]),
      tokenId: BigInt('0x' + d.slice(0, 64)),
      amount: Number(BigInt('0x' + d.slice(64, 128))),
    };
  }
  if (topic === TOPIC_ERC1155_BATCH && log.topics.length >= 4) {
    const d = (log.data || '0x').slice(2);
    const words = Math.floor(d.length / 64);
    const word = (i) => '0x' + d.slice(i * 64, i * 64 + 64);
    // Hostile/malformed logs can claim absurd array offsets and lengths —
    // bounds-check every index against the actual data and cap the id count
    // so decoding can never spin (real mint batches to the zero address are
    // tiny). Anything that fails the checks is treated as a non-mint log.
    const idsOffset = Number(hexToBigint(word(0))) / 32;
    if (!Number.isInteger(idsOffset) || idsOffset < 0 || idsOffset >= words) return null;
    const idsLen = Number(hexToBigint(word(idsOffset)));
    const valuesOffset = idsOffset + 1 + idsLen;
    if (!Number.isInteger(valuesOffset) || valuesOffset < 0 || valuesOffset >= words) return null;
    const valuesLen = Number(hexToBigint(word(valuesOffset)));
    const n = Math.max(0, Math.min(idsLen, valuesLen, 256));
    let sum = 0n;
    for (let i = 0; i < n; i++) sum += hexToBigint(word(valuesOffset + 1 + i));
    return {
      standard: 'erc1155', address, tsMs, blockNumber, txHash, logIndex,
      minter: topicToAddress(log.topics[3]),
      tokenId: hexToBigint(word(idsOffset + 1)),
      amount: Number(sum),
      batchIds: n,
    };
  }
  return null;
}

// Convert common NFT metadata URI forms into something a browser can fetch.
// ERC-1155 `uri()` templates must substitute {id} with the 64-char lowercase
// hex encoding of the token id (ERC-1155 spec) — decimal ids 404 on most hosts.
export function toHttpUri(uri, tokenId) {
  if (!uri) return null;
  let u = uri.trim();
  if (u.includes('{id}')) {
    const hexId = tokenId != null ? BigInt(tokenId).toString(16).padStart(64, '0') : '0'.repeat(64);
    u = u.replace(/\{id\}/g, hexId);
  }
  if (u.startsWith('ipfs://')) {
    return ipfsUrlToHttp(u);
  }
  if (u.startsWith('//')) return 'https:' + u;
  if (/^https?:\/\//i.test(u)) return u;
  return null; // id-based baseURI or unknown scheme — not fetchable
}

// Public IPFS gateways (all serve CORS *); rotated on failures/429s.
export const IPFS_GATEWAYS = [
  'https://ipfs.io/ipfs/',
  'https://dweb.link/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
];

export function ipfsUrlToHttp(url, gateway = 0) {
  if (typeof url === 'string' && url.startsWith('ipfs://')) {
    return IPFS_GATEWAYS[gateway % IPFS_GATEWAYS.length] + url.slice(7).replace(/^ipfs\//, '');
  }
  return url;
}

// Rewrite an already-HTTP gateway URL to a different public gateway; returns
// null when the URL is not gateway-served (nothing to fall back to).
export function swapIpfsGateway(url, gateway = 1) {
  const m = typeof url === 'string' ? url.match(/^https?:\/\/[^/]+\/ipfs\/(.+)$/i) : null;
  return m ? IPFS_GATEWAYS[gateway % IPFS_GATEWAYS.length] + m[1] : null;
}

// WebSocket transport: the node pushes new heads + mint logs via eth_subscribe.
// Handlers: { onMint, onHead, onStatus }. Returns { close, call } where
// call(method, params) issues JSON-RPC requests over the active socket.
export function createWsStream(chain, { onMint, onHead, onStatus }) {
  const endpoints = chain.ws;
  const filters = subscriptionFilters(chain);
  let ws = null;
  let closed = false;
  let endpointIdx = 0;
  let attempt = 0;
  let msgId = 0;
  let lastMessageAt = 0;
  const pending = new Map();

  const currentUrl = () => endpoints[endpointIdx % endpoints.length];

  const emitStatus = (state) => {
    try {
      onStatus?.({ state, url: currentUrl() });
    } catch {
      /* handler errors must not break the stream */
    }
  };

  const rawCall = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++msgId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('request timeout'));
      }, CALL_TIMEOUT_MS);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      }
    });

  async function setupSubscriptions() {
    await rawCall('eth_subscribe', ['newHeads']);
    for (const topics of filters) {
      await rawCall('eth_subscribe', ['logs', { topics }]);
    }
  }

  function scheduleReconnect() {
    if (closed) return;
    const delay = Math.min(30000, 2000 * 2 ** attempt);
    attempt += 1;
    endpointIdx += 1;
    emitStatus('reconnecting');
    setTimeout(connect, delay);
  }

  function connect() {
    if (closed) return;
    emitStatus(attempt === 0 ? 'connecting' : 'reconnecting');
    let socket;
    try {
      socket = new WebSocket(currentUrl());
    } catch {
      scheduleReconnect();
      return;
    }
    ws = socket;
    lastMessageAt = Date.now();
    socket.onopen = () => {
      attempt = 0;
      emitStatus('connected');
      setupSubscriptions().catch(() => {
        try { socket.close(); } catch { /* ignore */ }
      });
    };
    socket.onmessage = (ev) => {
      lastMessageAt = Date.now();
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || 'rpc error'));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'eth_subscription' && msg.params?.result) {
        const data = msg.params.result;
        if (data.number != null) {
          onHead?.(data);
          return;
        }
        const mint = parseMintLog(data);
        if (mint) onMint?.(mint);
      }
    };
    socket.onerror = () => {
      /* onclose handler performs the reconnect */
    };
    socket.onclose = () => {
      if (ws === socket) {
        ws = null;
        scheduleReconnect();
      }
    };
  }

  const heartbeat = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN && Date.now() - lastMessageAt > STALE_SOCKET_MS) {
      try { ws.close(); } catch { /* ignore */ }
    }
  }, HEARTBEAT_INTERVAL_MS);

  connect();

  return {
    call(method, params) {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error('socket not open'));
      }
      return rawCall(method, params);
    },
    close() {
      closed = true;
      clearInterval(heartbeat);
      try { ws?.close(); } catch { /* ignore */ }
      ws = null;
    },
  };
}

// HTTP polling transport for chains whose public RPC has no WebSocket support
// (e.g. Robinhood Chain). Pulls ranged eth_getLogs for the mint topic filters
// every pollMs, adapting the window when nodes cap the response, deduping
// across overlapping retries and skipping reorg-removed logs.
export function createPollStream(chain, { onMint, onHead, onStatus }) {
  const cfg = {
    pollMs: 4000,
    maxWindowBlocks: 300,
    bootstrapBlocks: 150,
    blockSampleEvery: 10,
    ...chain.poll,
  };
  const endpoints = chain.http;
  const logFilters = getLogsFilters(chain);
  let closed = false;
  let endpointIdx = 0;
  let failures = 0;
  let timer = null;
  let pollCount = 0;
  let lastProcessed = -1; // highest block whose logs were fetched
  const recentLogs = new Map(); // 'txHash:logIndex' -> 1, guards duplicate delivery

  const currentUrl = () => endpoints[endpointIdx % endpoints.length];

  const emitStatus = (state) => {
    try {
      onStatus?.({ state, url: currentUrl() });
    } catch {
      /* handler errors must not break the stream */
    }
  };

  const httpRpc = async (url, method, params) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (res.status === 429) {
      const err = new Error('rate limited');
      err.rateLimited = true;
      throw err;
    }
    if (!res.ok) throw new Error(`http ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || 'rpc error');
    return json.result;
  };

  function markSeen(key) {
    if (recentLogs.size > 40000) {
      let drop = 20000;
      for (const k of recentLogs.keys()) {
        if (drop-- <= 0) break;
        recentLogs.delete(k);
      }
    }
    recentLogs.set(key, 1);
  }

  // Fetch both mint filters over [from, to]. If the node rejects the range
  // ("logs matched by query exceeds limit"), shrink the window and retry.
  async function fetchLogs(from, to) {
    let window = to - from + 1;
    for (;;) {
      const start = Math.max(0, to - window + 1);
      const range = {
        fromBlock: '0x' + start.toString(16),
        toBlock: '0x' + to.toString(16),
      };
      try {
        const url = currentUrl();
        const batches = await Promise.all(
          logFilters.map((topics) => httpRpc(url, 'eth_getLogs', [{ ...range, topics }])),
        );
        return batches.flat();
      } catch (err) {
        const limitHit = /exceeds limit|too many|limit of/i.test(String(err?.message));
        if (limitHit && window > 50) {
          window = Math.max(50, window >> 1);
          continue;
        }
        throw err;
      }
    }
  }

  async function pollCycle() {
    const url = currentUrl();
    const headHex = await httpRpc(url, 'eth_blockNumber', []);
    const head = parseInt(headHex, 16);
    pollCount += 1;

    // Sampled block timestamps keep the "~s/block" stat alive on poll chains.
    if (pollCount % cfg.blockSampleEvery === 1) {
      try {
        const block = await httpRpc(url, 'eth_getBlockByNumber', [headHex, false]);
        if (block?.timestamp) onHead?.({ number: headHex, timestamp: block.timestamp });
        else onHead?.({ number: headHex });
      } catch {
        onHead?.({ number: headHex });
      }
    } else {
      onHead?.({ number: headHex });
    }

    let from = lastProcessed < 0 ? head - cfg.bootstrapBlocks : lastProcessed + 1;
    if (head - from > cfg.maxWindowBlocks) from = head - cfg.maxWindowBlocks;
    if (from < 0) from = 0;
    if (from > head) return; // no new blocks yet

    const logs = await fetchLogs(from, head);
    lastProcessed = head;

    const mints = [];
    for (const log of logs) {
      const key = `${log.transactionHash || ''}:${log.logIndex || '0x0'}`;
      if (recentLogs.has(key)) continue;
      markSeen(key);
      const mint = parseMintLog(log);
      if (mint) mints.push(mint);
    }
    mints.sort(
      (a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex,
    );
    for (const mint of mints) {
      try {
        onMint?.(mint);
      } catch {
        /* handler errors must not break the stream */
      }
    }
  }

  const schedule = (delay) => {
    timer = setTimeout(tick, delay);
  };

  async function tick() {
    if (closed) return;
    try {
      await pollCycle();
      failures = 0;
      emitStatus('connected');
      schedule(cfg.pollMs);
    } catch {
      failures += 1;
      endpointIdx += 1; // rotate to the failover RPC (429s, timeouts, …)
      emitStatus('reconnecting');
      schedule(Math.min(30000, cfg.pollMs * 2 ** Math.min(failures, 4)));
    }
  }

  emitStatus('connecting');
  tick();

  return {
    call(method, params) {
      // eth_call for name/symbol/tokenURI probes; one endpoint rotation on failure.
      return httpRpc(currentUrl(), method, params).catch((err) => {
        if (err?.rateLimited) {
          endpointIdx += 1;
          return httpRpc(currentUrl(), method, params);
        }
        throw err;
      });
    },
    close() {
      closed = true;
      clearTimeout(timer);
    },
  };
}

// Create the right transport for a chain config (see chains.js).
export function createChainStream(chain, handlers) {
  return chain.transport === 'ws' ? createWsStream(chain, handlers) : createPollStream(chain, handlers);
}





