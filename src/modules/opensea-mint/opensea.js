// OpenSea API v2 glue for the Opensea auto-mint page.
//
// The opensea.io *website* cannot be read from the browser (Cloudflare + no
// CORS headers), but api.opensea.io serves browsers — and answers collection
// lookups without any key in practice (paste a free one only if you start
// seeing 401s / rate limits: https://docs.opensea.io/reference/api-keys).
// The key lives in localStorage and is only ever sent to api.opensea.io.
//
// What we use it for: turning a collection slug into the on-chain contract
// (address + chain) plus name/artwork. Everything after that — price, mint
// window, per-wallet cap — is read straight from the chain via mint.js, which
// is also what actually enforces the schedule.

const KEY_LS = 'opensea-mint-api-key';

export const loadApiKey = () => {
  try {
    return localStorage.getItem(KEY_LS) || '';
  } catch {
    return '';
  }
};

export const saveApiKey = (key) => {
  try {
    if (key) localStorage.setItem(KEY_LS, key);
    else localStorage.removeItem(KEY_LS);
  } catch {
    /* storage unavailable — key just won't persist */
  }
};

// Slug → { addr, chainId, name, image, ts } cache. Once a collection URL has
// been resolved, it never needs OpenSea again — the page reads the cache and
// goes straight to the chain. Keyless resolves are cache-first; a pasted key
// bypasses the cache and refreshes it.
const CACHE_LS = 'opensea-mint-slug-cache';

export const loadSlugCache = () => {
  try {
    return JSON.parse(localStorage.getItem(CACHE_LS) || '{}');
  } catch {
    return {};
  }
};

export const saveSlugEntry = (slug, entry) => {
  try {
    const all = loadSlugCache();
    all[String(slug).toLowerCase()] = entry;
    localStorage.setItem(CACHE_LS, JSON.stringify(all));
  } catch {
    /* storage unavailable — cache just won't persist */
  }
};

// OpenSea API chain identifiers → mint.js chain ids (same set the monitor's
// link parser understands, plus Robinhood — where quite a few OpenSea-native
// collections like NTRPY Genesis actually live).
const OS_API_CHAIN = {
  ethereum: 'eth',
  eth: 'eth',
  matic: 'polygon',
  polygon: 'polygon',
  base: 'base',
  binance: 'bsc',
  'binance-smart-chain': 'bsc',
  bsc: 'bsc',
  robinhood: 'rh',
};

/**
 * Fetch a collection by slug. Returns
 *   { slug, name, description, image, contracts: [{addr, chainId}], contract }
 * where `contract` is the pick we can mint on (Ethereum preferred). Throws
 * human-readable errors for a bad key, unknown slug, wrong chain, etc.
 */
export async function fetchOsCollection(slug, apiKey) {
  let res;
  try {
    // The key is optional in practice: collection lookups usually answer
    // without one (rate limits aside) — send it only when present.
    res = await fetch(`https://api.opensea.io/api/v2/collections/${encodeURIComponent(slug)}`, {
      headers: apiKey ? { 'x-api-key': apiKey } : {},
    });
  } catch (err) {
    throw new Error(`could not reach api.opensea.io: ${err.message}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error('OpenSea wants an API key for this call — paste a free one (docs.opensea.io → Request an API key)');
  }
  if (res.status === 404) throw new Error(`no OpenSea collection for slug "${slug}"`);
  if (!res.ok) throw new Error(`OpenSea API error ${res.status}`);

  const j = await res.json();
  const contracts = (j.contracts || [])
    .map((c) => ({
      addr: String(c.address || '').toLowerCase(),
      chainId: OS_API_CHAIN[String(c.chain || '').toLowerCase()] || null,
    }))
    .filter((c) => c.addr);
  const usable = contracts.filter((c) => c.chainId);
  if (!usable.length) {
    throw new Error(
      contracts.length
        ? 'this collection lives on a chain the mint engine does not support yet — paste the contract address on a supported chain instead'
        : 'the API exposes no on-chain contract for this slug — paste the contract address instead',
    );
  }
  return {
    slug,
    name: j.name || null,
    description: j.description || null,
    image: j.image_url || null,
    contracts: usable,
    contract: usable.find((c) => c.chainId === 'eth') || usable[0],
  };
}
