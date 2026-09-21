// Chain registry for the Bundle Radar (莊家 wallet-cluster analysis).
//
// History is pulled with ranged eth_getLogs over plain HTTP public endpoints —
// no API keys. `scan.maxWindow` / `scan.maxLogs` encode each provider family's
// getLogs limits (e.g. publicnode BSC accepts ≤5k-block ranges but rejects
// historical eth_getCode, which triggers SEEK MODE in the engine); windows
// still adapt down when a node disagrees. `pollMs` is the live cadence.
export const CHAINS = [
  {
    id: 'bsc',
    chainId: 56,
    name: 'BNB Smart Chain',
    short: 'BSC',
    etherscanChainId: 56,
    // NodeReal's shared demo endpoint (published in their public docs) is a full
    // ARCHIVE node — the only keyless source of deep BSC getLogs/getCode, since
    // publicnode only serves the last ~10k blocks and dataseed/drpc reject logs.
    // Replace with your own nodereal key via "custom RPC" if the demo throttles.
    http: ['https://bsc-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3', 'https://bsc.publicnode.com', 'https://bsc.rpc.blxrbdn.com'],
    explorer: 'https://bscscan.com',
    scanBlocks: 1500,
    pollMs: 3000,
    scan: { maxWindow: 4900, maxLogs: 4000, paceMs: 400 },
  },
  {
    id: 'base',
    chainId: 8453,
    name: 'Base',
    short: 'Base',
    etherscanChainId: 8453,
    http: ['https://base.publicnode.com', 'https://mainnet.base.org', 'https://base.drpc.org'],
    explorer: 'https://basescan.org',
    scanBlocks: 2500,
    pollMs: 2000,
    scan: { maxWindow: 9000, maxLogs: 2500, paceMs: 250 },
  },
  {
    id: 'eth',
    chainId: 1,
    name: 'Ethereum',
    short: 'Ethereum',
    etherscanChainId: 1,
    http: ['https://ethereum.publicnode.com', 'https://eth.llamarpc.com', 'https://eth.drpc.org'],
    explorer: 'https://etherscan.io',
    scanBlocks: 1000,
    pollMs: 12000,
    scan: { maxWindow: 2000, maxLogs: 1500, paceMs: 250 },
  },
  {
    id: 'rh',
    chainId: 4663,
    name: 'Robinhood Chain',
    short: 'Robinhood',
    http: ['https://rpc.mainnet.chain.robinhood.com', 'https://rpc.arrowrpc.com'],
    explorer: 'https://robinhoodchain.blockscout.com',
    scanBlocks: 600,
    pollMs: 4000,
    scan: { maxWindow: 500, maxLogs: 900, paceMs: 150 },
  },
];

export const chainById = (id) => CHAINS.find((c) => c.id === id) || CHAINS[0];

export const explorerAddressUrl = (chain, addr) => `${chain.explorer}/address/${addr}`;
export const explorerTxUrl = (chain, hash) => `${chain.explorer}/tx/${hash}`;
