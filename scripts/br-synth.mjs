// Synthetic validation for the Bundle Radar clustering logic:
//   - a 6-wallet same-tx launch bundle
//   - a 5-wallet 莊家 group that 建倉 (block 100) → dumps the top (block 200)
//     → rebuys the retrace (block 300)
//   - 4 uncorrelated retail wallets that must stay ungrouped
// Expected: 2 groups (+ bundle), group A timeline shows +/−/+ daily net flow.
import { buildReport } from '../src/modules/bundle-radar/engine.js';

const DAY = 86400_000;
const P = '0x' + 'aa'.repeat(20); // pool
const D = '0x' + 'dd'.repeat(20); // deployer (mint receiver)
const w = (i) => '0x' + (1000 + i).toString(16).padStart(40, '0');
const BUNDLE = [1, 2, 3, 4, 5, 6].map(w); // same-tx buyers
const CREW = [11, 12, 13, 14, 15].map(w); // 建倉→dump→rebuy crew
const RETAIL = [21, 22, 23, 24].map(w); // randoms
const UNIT = 1_000_000_000_000_000_000n;

const transfers = [];
const push = (from, to, value, block, txHash) => transfers.push({ from, to, value, block, txHash, logIndex: transfers.length });

push('0x' + '00'.repeat(20), D, 1000n * UNIT, 1, '0xmint');

// launch bundle: 6 wallets buy inside ONE transaction
BUNDLE.forEach((x) => push(P, x, 10n * UNIT, 50, '0xbundletx'));

// crew 建倉 together (same block, own txs)
CREW.forEach((x, i) => push(P, x, 20n * UNIT, 100, `0xbuy${i}`));
// crew dumps the top together
CREW.forEach((x, i) => push(x, P, 15n * UNIT, 200, `0xsell${i}`));
// crew rebuys the retrace together
CREW.forEach((x, i) => push(P, x, 8n * UNIT, 300, `0xrebuy${i}`));
// internal rebalance within the crew
push(CREW[0], CREW[1], 5n * UNIT, 310, '0xmove');

// uncorrelated retail activity
RETAIL.forEach((x, i) => {
  push(P, x, 5n * UNIT, 120 + i, `0xrb${i}`);
  push(x, P, 2n * UNIT, 220 + i, `0xrs${i}`);
});

const timestamps = new Map([
  [50, Date.now() - 3 * DAY],
  [100, Date.now() - 2 * DAY],
  [120, Date.now() - 2 * DAY + 3600_000],
  [200, Date.now() - 1 * DAY],
  [220, Date.now() - 1 * DAY + 3600_000],
  [300, Date.now()],
  [310, Date.now() + 60_000],
]);
transfers.forEach((t) => {
  if (!timestamps.has(t.block)) timestamps.set(t.block, Date.now() - 2 * DAY);
});

const dataset = {
  chain: { id: 'test', name: 'Test', http: [], explorer: 'https://x' },
  token: '0x' + 'ee'.repeat(20),
  symbol: 'TEST',
  decimals: 18,
  creationBlock: 1,
  latestBlock: 310,
  deployer: D,
  transfers,
  timestamps,
};

const report = buildReport(dataset, { minWallets: 3, minCoEvents: 2, linkMoves: true, poolMinDistinct: 2 });
console.log('stats:', report.stats);
console.log('pools:', report.pools.map((p) => p.address.slice(0, 8)));
console.log(`groups: ${report.groups.length}`);
for (const g of report.groups) {
  const members = g.wallets.map((x) => x.address.slice(2, 6)).join(',');
  console.log(`  ${g.label} (${g.nWallets}w): [${members}] bag=${g.bagTokens} pct=${g.bagPct.toFixed(1)}%`);
  console.log(`    timeline: ${g.timeline.map((t) => `${t.day.slice(5)}:${t.net >= 0 ? '+' : ''}${t.net}`).join(' ')}`);
  console.log(`    events: ${g.events.map((e) => `${e.kind}/${e.dir}/${e.nWallets}w@${e.block}`).join(' ')}`);
}
console.log('ungrouped:', report.ungroupedTop.map((u) => u.address.slice(2, 6)));

const ok =
  report.groups.length === 2 &&
  report.groups.some((g) => g.nWallets === 6 && g.wallets.every((x) => BUNDLE.includes(x.address))) &&
  report.groups.some(
    (g) =>
      g.nWallets === 5 &&
      g.wallets.every((x) => CREW.includes(x.address)) &&
      g.timeline.length === 3 &&
      g.timeline[0].net === 100 &&
      g.timeline[1].net === -75 &&
      g.timeline[2].net === 40, // rebuys; the +5 internal move only affects balances, not the trade timeline
  ) &&
  !report.ungroupedTop.some((u) => CREW.includes(u.address) || BUNDLE.includes(u.address));
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
