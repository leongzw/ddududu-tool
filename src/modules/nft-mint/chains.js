// Chain registry for the NFT mint monitor.
//
// Two transports are supported:
//   'ws'   — public RPC exposes WebSocket subscriptions (eth_subscribe); the node
//            pushes mint logs the moment they are mined.
//   'poll' — HTTP-only RPC; mint logs are pulled with ranged eth_getLogs queries
//            (window capped because nodes limit logs per response).
export const CHAINS = [
  {
    id: 'bsc',
    chainId: 56,
    name: 'BNB Smart Chain',
    short: 'BSC',
    transport: 'ws',
    ws: ['wss://bsc.publicnode.com', 'wss://bsc-ws-node.nariox.org', 'wss://bsc.drpc.org'],
    standards: ['erc721'], // ERC-1155 mints on BSC are dominated by game/airdrop noise
    explorer: 'https://bscscan.com',
    native: 'BNB',
  },
  {
    id: 'rh',
    chainId: 4663,
    name: 'Robinhood Chain',
    short: 'Robinhood',
    transport: 'poll',
    http: ['https://rpc.mainnet.chain.robinhood.com', 'https://rpc.arrowrpc.com'],
    explorer: 'https://robinhoodchain.blockscout.com',
    native: 'ETH',
    poll: { pollMs: 4000, maxWindowBlocks: 300, bootstrapBlocks: 150, blockSampleEvery: 10 },
  },
];

export const chainById = (id) => CHAINS.find((c) => c.id === id) || CHAINS[0];

export const explorerTokenUrl = (chain, addr) => `${chain.explorer}/token/${addr}`;
export const explorerTxUrl = (chain, hash) => `${chain.explorer}/tx/${hash}`;
