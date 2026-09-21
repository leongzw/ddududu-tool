// Smoke test for the Bundle Radar engine (run from repo root):
//   node scripts/br-smoke.mjs [token] [chainId] [windowBlocks|auto]
// `auto` locates the token's creation itself (binary search, or SEEK MODE
// backwards log-walk on RPCs without archive state). Set ETHERSCAN_API_KEY in
// the env to use the Etherscan V2 fast lane (full history + timestamps).
// Defaults to a 3000-block window of ETH (Binance-pegged) on BSC.
import { analyzeToken, buildReport } from '../src/modules/bundle-radar/engine.js';
import { chainById } from '../src/modules/bundle-radar/chains.js';

const token = (process.argv[2] || '0x2170ed0880ac9a755fd29b2688956bd959f933f8').toLowerCase();
const chain = chainById(process.argv[3] || 'bsc');
const auto = (process.argv[4] || '3000') === 'auto';
const windowBlocks = Number(process.argv[4] || 3000);

const rpc = async (method, params) => {
  const res = await fetch(chain.http[0], {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
};

let fromBlock = 0;
if (!auto) {
  const latest = Number(BigInt(await rpc('eth_blockNumber', [])));
  fromBlock = latest - windowBlocks;
  console.log(`chain=${chain.name} latest=${latest} window=${fromBlock}..${latest}`);
} else {
  console.log(`chain=${chain.name} auto mode (creation discovery)`);
}

const t0 = Date.now();
const dataset = await analyzeToken({
  chain,
  token,
  fromBlock,
  explorerKey: process.env.ETHERSCAN_API_KEY || null,
  onProgress: (p) => {
    if (p.phase === 'scan' && p.scanned !== undefined) {
      process.stdout.write(`\rscan ${((p.scanned / p.total) * 100).toFixed(0)}% · ${p.logs} transfers   `);
    } else if (p.detail) {
      process.stdout.write(`\r${p.detail}                    \n`);
    }
  },
});
console.log(
  `\nfetched ${dataset.transfers.length} transfers since block ${dataset.creationBlock} in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
);

const report = buildReport(dataset, { minWallets: 3, minCoEvents: 2, linkMoves: true, poolMinDistinct: 8 });
console.log('stats:', report.stats);
console.log(
  'pools:',
  report.pools.slice(0, 3).map((p) => `${p.address.slice(0, 10)}… txs=${p.txCount} in=${p.inCp} out=${p.outCp}`),
);
console.log(`groups: ${report.groups.length}`);
for (const g of report.groups.slice(0, 3)) {
  console.log(
    `  ${g.label}: ${g.nWallets} wallets · bag ${g.bagTokens.toFixed(0)} (${g.bagPct.toFixed(2)}% supply) · ` +
      `bought ${g.boughtTokens.toFixed(0)} · sold ${g.soldTokens.toFixed(0)} · ${g.events.length} events`,
  );
  for (const ev of g.events.slice(-3)) {
    console.log(`    ${ev.time ? new Date(ev.time).toISOString().slice(5, 16) : '#' + ev.block} ${ev.dir} ${ev.kind} ${ev.nWallets}w ${ev.tokens.toFixed(0)}`);
  }
}
console.log('ungroupedTop:', report.ungroupedTop.slice(0, 3).map((w) => `${w.address.slice(0, 10)}… ${w.bag.toFixed(0)}`));
console.log('OK');
