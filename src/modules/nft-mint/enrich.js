// Collection enrichment: classify minting contracts (NFT vs fungible token),
// resolve names/symbols and best-effort artwork, cached in localStorage per chain
// (the same address can denote different contracts on different chains).

import { decodeAbiString, pad32Hex, toHttpUri, ipfsUrlToHttp, swapIpfsGateway } from './rpc.js';

const SEL_NAME = '0x06fdde03';          // name()
const SEL_SYMBOL = '0x95d89b41';        // symbol()
const SEL_TOKEN_URI = '0xc87b56dd';     // tokenURI(uint256)
const SEL_URI_1155 = '0x0e89341c';      // uri(uint256)
const SEL_CONTRACT_URI = '0xe8a3d485';  // contractURI() — OpenSea-style collection metadata

// Token IDs below this bound are treated as NFT ids without any RPC probe;
// fungible mint amounts (18-decimal style) are almost always far larger.
export const NFT_ID_MAX = 10n ** 12n;

// Bumped from v1: the image pipeline gained gateway rotation, contractURI
// probing and a CORS fallback — old negative caches must be re-probed.
const LS_PREFIX = 'nft-mint-meta-v2-';
const LS_CAP = 1500;
const FETCH_TIMEOUT_MS = 7000;

// Last-resort proxy for metadata hosts that serve no CORS headers (most
// project-owned api.example.com endpoints). Remove this line to disable.
const corsProxy = (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`;

export function loadMetaMap(chainId) {
  const map = new Map();
  try {
    const raw = localStorage.getItem(LS_PREFIX + chainId);
    if (!raw) return map;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      for (const [addr, meta] of Object.entries(parsed)) {
        if (typeof meta === 'object' && meta !== null) map.set(addr, { ...meta });
      }
    }
  } catch {
    /* corrupted cache — start fresh */
  }
  return map;
}

export function saveMetaMap(chainId, map) {
  try {
    const entries = [...map.entries()]
      .filter(([, m]) => m.std || m.name != null)
      .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
      .slice(0, LS_CAP);
    localStorage.setItem(LS_PREFIX + chainId, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* storage full or unavailable — cache is best-effort */
  }
}

const latest = (events) => (events && events.length ? events[events.length - 1] : null);

const safeCall = async (call, to, data) => {
  const hex = await call('eth_call', [{ to, data }, 'latest']);
  return hex && hex !== '0x' ? hex : null;
};

// Decide whether a minting contract is an NFT collection. Mutates + returns meta:
//   std: 'erc721' | 'erc1155' | 'token' (fungible — excluded) | undefined (retry later)
// Also fills name/symbol/uri once resolved.
export async function classifyCollection(call, address, events, meta) {
  const last = latest(events);
  if (!last) return meta;

  if (!meta.std) {
    if (last.standard === 'erc1155') {
      meta.std = 'erc1155';
      meta.at = Date.now();
    } else if (last.idIndexed || last.tokenId < NFT_ID_MAX) {
      // Indexed tokenId (4 topics) is unambiguous; small sequential ids are
      // safe to trust because fungible mint amounts are far larger.
      meta.std = 'erc721';
      meta.at = Date.now();
    } else {
      // Ambiguous (ERC-20 mints share the Transfer signature): probe tokenURI.
      try {
        const uriHex = await safeCall(call, address, SEL_TOKEN_URI + pad32Hex(last.tokenId));
        const uri = decodeAbiString(uriHex);
        meta.std = uri != null ? 'erc721' : 'token';
        if (uri) meta.uri = uri;
        meta.at = Date.now();
      } catch (err) {
        if (/revert/i.test(String(err?.message))) {
          meta.std = 'token';
          meta.at = Date.now();
        }
        // otherwise leave undefined and retry on a later tick
      }
    }
  }

  if ((meta.std === 'erc721' || meta.std === 'erc1155') && meta.named === undefined) {
    // undefined = transport failure (retry on a later tick via the queue);
    // null = the node answered — the contract simply has no name/symbol.
    const probeStr = async (sel) => {
      try {
        return decodeAbiString(await safeCall(call, address, sel));
      } catch (err) {
        if (/revert/i.test(String(err?.message))) return null;
        return undefined;
      }
    };
    const [name, symbol] = await Promise.all([probeStr(SEL_NAME), probeStr(SEL_SYMBOL)]);
    if (name !== undefined && symbol !== undefined) {
      meta.name = name;
      meta.symbol = symbol;
      meta.named = true;
      meta.at = Date.now();
    }
    // otherwise leave meta.named undefined — the queue will retry this address
  }

  return meta;
}

function pickImage(json) {
  if (!json || typeof json !== 'object') return null;
  const keys = ['image', 'image_url', 'imageUrl', 'img', 'media_url', 'animation_url'];
  for (const key of keys) {
    let v = json[key];
    if (Array.isArray(v)) v = typeof v[0] === 'object' && v[0] ? v[0].url : v[0];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function parseInlineDataUri(uri) {
  try {
    const b64 = uri.indexOf('base64,');
    if (b64 !== -1) return JSON.parse(atob(uri.slice(b64 + 'base64,'.length)));
    // Non-base64 form: data:application/json;utf8,{...} (raw or URL-encoded)
    const comma = uri.indexOf(',');
    if (comma !== -1 && /json/i.test(uri.slice(0, comma))) {
      return JSON.parse(decodeURIComponent(uri.slice(comma + 1)));
    }
    return null;
  } catch {
    return null;
  }
}

// Fetch a metadata JSON document, trying in order: the URL as given, an
// alternate IPFS gateway (when gateway-served), then a CORS proxy. Returns
// null when every candidate fails (offline, 404, timeout, …).
async function fetchMetadataJson(url) {
  const candidates = [url];
  const alt = swapIpfsGateway(url, 1);
  if (alt && alt !== url) candidates.push(alt);
  candidates.push(corsProxy(url));
  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.ok) return await res.json();
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

// Best-effort artwork: resolves tokenURI/uri (token-level) and contractURI
// (collection-level) metadata, extracts an image URL from whichever answers
// first. Sets meta.img to a URL string, or false when every source failed
// (negative cache — never retried).
export async function fetchCollectionImage(call, address, events, meta) {
  if (meta.img !== undefined) return meta;
  const last = latest(events);
  const tokenId = last ? last.tokenId : 1n;

  const uris = [];
  if (meta.uri) {
    uris.push(meta.uri);
  } else {
    try {
      const sel = meta.std === 'erc1155' ? SEL_URI_1155 : SEL_TOKEN_URI;
      const uri = decodeAbiString(await safeCall(call, address, sel + pad32Hex(tokenId)));
      if (uri) {
        meta.uri = uri;
        uris.push(uri);
      }
    } catch {
      /* contract may not implement token-level uri */
    }
  }

  // Collection-level metadata (contractURI) often carries a logo even when
  // per-token art is gated, unrevealed or served without CORS.
  try {
    const contractUri = decodeAbiString(await safeCall(call, address, SEL_CONTRACT_URI));
    if (contractUri && !uris.includes(contractUri)) uris.push(contractUri);
  } catch {
    /* contractURI is optional */
  }

  let img = null;
  for (const uri of uris) {
    const http = toHttpUri(uri, tokenId);
    if (!http) continue;
    let json = null;
    if (http.startsWith('data:')) {
      json = parseInlineDataUri(http);
    } else {
      json = await fetchMetadataJson(http);
    }
    img = pickImage(json);
    if (img) break;
  }

  meta.img = img ? ipfsUrlToHttp(img) : false;
  meta.at = Date.now();
  return meta;
}
