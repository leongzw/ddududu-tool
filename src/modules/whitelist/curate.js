// Whitelist-curator engine: repeatedly call deposit() on a whitelist/points
// contract from each selected wallet, with human-looking growing ETH values.
//   · send #1: random in [firstMin, firstMax] ETH, never below 0.05 (game floor)
//   · send n:  previous × (1 + random [growMinPct, growMaxPct]%) + 0.1 — the
//     guaranteed minimum growth (e.g. from 0.05: 0.155–0.165 → 0.27–0.31 → …)
//   · repeat until the next amount no longer fits the balance momentarily,
//     or the hard send cap.
// The contract refunds each deposit (same tx), so a wallet only spends gas —
// but the amount still needs momentary balance coverage to be sent at all.
// Signed locally, sequential and receipt-confirmed, same machinery as the
// Balance Transfers panel.
import { ethers } from 'ethers';
import { makeRpc, feePlan } from '../nft-mint/mint.js';
import { sendTransfer, transferGasLimit } from '../wallets/transfer.js';

// deposit() — the curator game's method (reference tx 0xaa1b…95cd3). No
// arguments; the ETH amount rides on the tx value and the contract refunds it
// in the same tx, so a wallet only spends gas per send.
export const DEPOSIT_DATA = '0xd0e30db0';
// The game's contract, prefilled in the UI (still editable there). Checksummed
// so decoded/derived forms compare equal.
export const DEFAULT_CONTRACT = '0xcB0b0531e86A9aC36Fa865cA8e3dbccF047FDA91';
// Hard stop per wallet regardless of balance — safety valve, not a feature.
export const MAX_SENDS_PER_WALLET = 50;
// Pause after each confirmed send — receipts landing back-to-back within a
// block or two look botty; 5s paces the run like a human.
const SEND_PAUSE_MS = 5000;

// Game floor: every deposit must be ≥ 0.05 ETH. Amounts only grow, so the
// first send is the smallest — flooring it floors the whole sequence.
export const MIN_FIRST_ETH = 0.05;

// Guaranteed minimum growth: every next send adds ≥ 0.1 ETH on top of the
// random % growth (tx1 0.05 → tx2 ≥ 0.155, still randomized above that).
export const MIN_GROW_ETH = 0.1;

export const DEFAULT_PARAMS = { firstMin: MIN_FIRST_ETH, firstMax: 0.1, growMinPct: 10, growMaxPct: 30 };

const randBetween = (min, max) => min + Math.random() * (max - min);
// 3–4 decimal places (0.064 / 0.0745 style) so amounts don't look generated.
const humanize = (v) => Number(v.toFixed(Math.random() < 0.5 ? 3 : 4));

/** First send: random in [firstMin, firstMax], never below MIN_FIRST_ETH
 *  (0.05 game floor), human-rounded. BigInt wei. */
export function randomFirstWei(params) {
  const lo = Math.max(Math.min(params.firstMin, params.firstMax), MIN_FIRST_ETH);
  const hi = Math.max(params.firstMin, params.firstMax, lo);
  const v = Math.min(Math.max(humanize(randBetween(lo, hi)), lo), hi);
  return ethers.parseEther(v.toFixed(6)); // toFixed → never scientific notation
}

/** Next send: previous grown by a random [growMinPct, growMaxPct]% plus a
 *  guaranteed MIN_GROW_ETH on top, human-rounded. The clamp keeps the +0.1
 *  promise exact even when rounding shaves a fraction of a milli-ETH. */
export function randomNextWei(prevWei, params) {
  const lo = Math.min(params.growMinPct, params.growMaxPct);
  const hi = Math.max(params.growMinPct, params.growMaxPct);
  const prev = Number(ethers.formatEther(prevWei));
  const grown = prev * (1 + randBetween(lo, hi) / 100) + MIN_GROW_ETH;
  // toFixed() goes exponential ≥1e21 — clamp far beyond any real balance so
  // parseEther always gets plain decimal notation.
  const v = Math.min(Math.max(humanize(grown), prev + MIN_GROW_ETH), 1e15);
  return ethers.parseEther(v.toFixed(6));
}

/** Simulate one wallet's full send sequence (preview + tests). `gasCostWei` is
 *  the worst-case gas per tx (gasLimit × maxFee). Each deposit is refunded, so
 *  a send only burns gas — but its amount must still fit the balance
 *  momentarily to be sent at all. Returns { sends: BigInt[], leftoverWei,
 *  stopped } where stopped ∈ 'next-doesnt-fit' | 'cant-start' | 'cap' | 'empty'. */
export function planSends(balanceWei, gasCostWei, params) {
  const sends = [];
  let avail = balanceWei;
  let prev = 0n;
  let stopped = 'empty';
  while (sends.length < MAX_SENDS_PER_WALLET) {
    const amount = sends.length === 0 ? randomFirstWei(params) : randomNextWei(prev, params);
    if (amount + gasCostWei <= avail) {
      sends.push(amount);
      avail -= gasCostWei; // deposit comes back — only gas leaves the wallet
      prev = amount;
      continue;
    }
    stopped = sends.length === 0 ? 'cant-start' : 'next-doesnt-fit';
    break;
  }
  if (sends.length >= MAX_SENDS_PER_WALLET) stopped = 'cap';
  return { sends, leftoverWei: avail, stopped };
}

/** Expected per-tx amount bands for the page list: row n is the min–max ETH
 *  tx n can carry (all-min vs all-max growth path; first band floored at
 *  MIN_FIRST_ETH, each next = previous ×p% + MIN_GROW_ETH). Rows stop when
 *  even the min path couldn't fit `balanceWei` momentarily (amount + gas) or
 *  at the send cap. `maybeLast` = a max-draw amount might already not fit. */
export function expectedSends(params, balanceWei, gasCostWei) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const loPct = Math.min(p.growMinPct, p.growMaxPct) / 100;
  const hiPct = Math.max(p.growMinPct, p.growMaxPct) / 100;
  let lo = Math.max(Math.min(p.firstMin, p.firstMax), MIN_FIRST_ETH);
  let hi = Math.max(p.firstMin, p.firstMax, lo);
  const rows = [];
  for (let i = 1; i <= MAX_SENDS_PER_WALLET; i++) {
    const minWei = ethers.parseEther(lo.toFixed(6));
    const maxWei = ethers.parseEther(hi.toFixed(6));
    if (minWei + gasCostWei > balanceWei) break;
    rows.push({ i, minWei, maxWei, maybeLast: maxWei + gasCostWei > balanceWei });
    lo = lo * (1 + loPct) + MIN_GROW_ETH;
    hi = hi * (1 + hiPct) + MIN_GROW_ETH;
  }
  return rows;
}

/**
 * Run the curation for each wallet sequentially. Per wallet: fetch live
 * balance + fees + a deposit() gas estimate once, then send the growing
 * sequence one tx at a time (receipt-confirmed, nonce incremented locally,
 * 5s human-pacing pause after each confirmation),
 * re-reading the exact balance after every send — the contract refunds each
 * deposit, so that balance only drops by gas. A reverted / stuck-pending tx
 * stops THAT wallet (don't pile on a suspect nonce) but never blocks the
 * others.
 * onEvent: 'wallet-start' | 'tx-sent' | 'tx-mined' | 'tx-error' | 'info' |
 * 'wallet-done' { sent } | 'done' — same shape as the transfer panel plus info.
 */
export async function runCuration({ chain, wallets, contractAddress, params, onEvent, abortRef }) {
  const call = makeRpc(chain);
  const p = { ...DEFAULT_PARAMS, ...params };
  const minFirst = ethers.parseEther(String(Math.max(Math.min(p.firstMin, p.firstMax), MIN_FIRST_ETH)));

  for (const w of wallets) {
    if (abortRef.current) break;
    onEvent({ type: 'wallet-start', address: w.address });
    let sent = 0;
    try {
      const signer = new ethers.Wallet(w.key);
      const fees = await feePlan(call, chain);
      const gasLimit = await transferGasLimit(call, w.address, contractAddress, DEPOSIT_DATA, minFirst);
      const gasCost = gasLimit * fees.maxFee;
      let balance = BigInt(await call('eth_getBalance', [w.address, 'latest']));

      if (balance < gasCost + minFirst) {
        onEvent({
          type: 'tx-error',
          address: w.address,
          error:
            `skipped — balance ${ethers.formatEther(balance)} ${chain.native} is below ` +
            `first deposit + gas (needs ≥ ${ethers.formatEther(gasCost + minFirst)})`,
        });
        onEvent({ type: 'wallet-done', address: w.address, sent: 0 });
        continue;
      }

      let nonce = BigInt(await call('eth_getTransactionCount', [w.address, 'pending']));
      let prev = 0n;

      for (let i = 0; i < MAX_SENDS_PER_WALLET && !abortRef.current; i++) {
        const amount = prev === 0n ? randomFirstWei(p) : randomNextWei(prev, p);

        if (amount + gasCost > balance) {
          // The deposit is refunded, but the tx still needs momentary coverage
          // of value + gas — once the next amount outgrows the balance, stop.
          if (prev !== 0n) {
            onEvent({
              type: 'info',
              address: w.address,
              note: `next ${ethers.formatEther(amount)} ${chain.native} wouldn't fit — stopping, ≈ ${ethers.formatEther(balance)} left`,
            });
          }
          break;
        }

        const ok = await sendTransfer(call, chain, signer, {
          to: contractAddress,
          valueWei: amount,
          data: DEPOSIT_DATA,
          nonce,
          gasLimit,
          onEvent,
          abortRef,
        });
        if (ok !== true) break; // reverted / stuck pending — don't stack txs on a suspect nonce
        sent += 1;
        nonce += 1n;
        prev = amount;
        // Pace like a human: 5s after each confirmation before anything next
        // (next deposit, or the next wallet's first). Skipped on abort.
        if (!abortRef.current) await new Promise((r) => setTimeout(r, SEND_PAUSE_MS));
        balance = BigInt(await call('eth_getBalance', [w.address, 'latest'])); // exact remaining (gas-only drop)
      }
    } catch (err) {
      onEvent({ type: 'tx-error', address: w.address, error: err?.message || String(err) });
    }
    onEvent({ type: 'wallet-done', address: w.address, sent });
  }
  onEvent({ type: 'done' });
}
