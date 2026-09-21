// Native-balance transfers between saved wallets: one source → many
// recipients (disperse) or many sources → one destination (collect/sweep).
// Same trust model as batch minting — keys sign locally in the page, raw txs
// go out through the shared public-RPC pool (makeRpc/feePlan in mint.js).
import { ethers } from 'ethers';
import { makeRpc, feePlan } from '../nft-mint/mint.js';

// Shared with the whitelist-curator module (same plain-send machinery).
export const sendTransfer = sendTransferImpl;
export const transferGasLimit = transferGasLimitImpl;

// A plain native-token send is 21k gas on vanilla EVM chains, but Arbitrum
// Orbit rollups (Robinhood, Arbitrum) add a fluctuating L1-data component to
// the intrinsic cost — signing with exactly 21k there fails with
// "intrinsic gas too low". So we ask the node instead of hardcoding.
const TRANSFER_GAS = 21_000n;
const TRANSFER_GAS_FALLBACK = 250_000n;

/**
 * Gas limit for one native send. Without calldata, estimate with value 0
 * (value doesn't affect gas for plain sends, and 0 keeps the estimate
 * independent of the sender's balance). With `data` (a contract call such as
 * the curator's deposit()) pass a representative `valueWei` — the amount can
 * change what the contract executes. 21k exactly → vanilla plain send, keep
 * it; anything higher → take 2× headroom since costs drift between estimate
 * and inclusion (Orbit's L1 component, contract state, …). Unused gas is
 * refunded, so overestimating only loosens the worst-case balance precheck.
 * If the RPC can't estimate at all, fall back to a generous constant.
 */
async function transferGasLimitImpl(call, from, to, data, valueWei) {
  const tx = { from, to, value: valueWei != null ? `0x${BigInt(valueWei).toString(16)}` : '0x0' };
  if (data) tx.data = data;
  let est;
  try {
    est = BigInt(await call('eth_estimateGas', [tx]));
  } catch {
    return TRANSFER_GAS_FALLBACK;
  }
  if (!data && est <= TRANSFER_GAS) return TRANSFER_GAS;
  return est * 2n;
}

/**
 * Sign + broadcast one transfer, then wait up to ~5 min for the receipt
 * (mirrors runBatch's polling so the log reads the same way). Returns true
 * when confirmed, false when reverted/still-pending. Throws on RPC failure.
 */
async function sendTransferImpl(call, chain, signer, { to, valueWei, nonce, gasLimit, data, onEvent, abortRef }) {
  const fees = await feePlan(call, chain);
  const base = { to, value: valueWei, nonce, chainId: chain.chainId, gasLimit: gasLimit || TRANSFER_GAS };
  if (data) base.data = data; // optional calldata (curator deposit()); plain sends stay plain
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
  onEvent({ type: 'tx-sent', address: signer.address, to, hash, valueWei });

  let receipt = null;
  for (let i = 0; i < 100 && !receipt; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    if (abortRef.current) break;
    receipt = await call('eth_getTransactionReceipt', [hash]).catch(() => null);
  }
  const ok = receipt ? Number(receipt.status) === 1 : null;
  onEvent({ type: 'tx-mined', address: signer.address, hash, ok });
  return ok;
}

/**
 * Disperse: send `amountPerWei` from ONE source wallet to each recipient,
 * sequentially, waiting for each receipt (nonce fetched once, incremented
 * per tx). Aborts cleanly between transfers. onEvent shape matches runBatch.
 */
export async function disperseBalances({ chain, source, recipients, amountPerWei, onEvent, abortRef }) {
  if (recipients.length === 0) {
    onEvent({ type: 'done' });
    return;
  }
  const call = makeRpc(chain);
  const signer = new ethers.Wallet(source.key);
  onEvent({ type: 'wallet-start', address: signer.address });

  let nonce;
  let balance = null;
  let fees = null;
  try {
    nonce = BigInt(await call('eth_getTransactionCount', [source.address, 'pending']));
    balance = BigInt(await call('eth_getBalance', [source.address, 'latest']));
    fees = await feePlan(call, chain);
  } catch (err) {
    onEvent({ type: 'tx-error', address: source.address, error: `setup failed: ${err.message}`, fatal: true });
    onEvent({ type: 'done' });
    return;
  }

  // Conservative precheck: the whole batch could burn gasLimit × maxFee per tx.
  const gasLimit = await transferGasLimit(call, source.address, recipients[0].address);
  const n = BigInt(recipients.length);
  const need = amountPerWei * n + gasLimit * fees.maxFee * n;
  if (balance < need) {
    onEvent({
      type: 'tx-error',
      address: source.address,
      fatal: true,
      error:
        `source can't cover the batch: have ${ethers.formatEther(balance)} ${chain.native}, ` +
        `need ≈ ${ethers.formatEther(need)} (value + max gas for ${recipients.length} txs)`,
    });
    onEvent({ type: 'done' });
    return;
  }

  for (const rcpt of recipients) {
    if (abortRef.current) break;
    try {
      await sendTransfer(call, chain, signer, { to: rcpt.address, valueWei: amountPerWei, nonce, gasLimit, onEvent, abortRef });
      nonce += 1n;
    } catch (err) {
      onEvent({ type: 'tx-error', address: source.address, error: err?.message || String(err), fatal: true });
      break; // stop — likely a nonce/balance issue; later txs would fail too
    }
  }
  onEvent({ type: 'done' });
}

/**
 * Collect: sweep each source wallet's balance to one destination. Each source
 * sends balance − gasLimit×maxFee − keepForGasWei (gasLimit is node-estimated —
 * 21k on vanilla chains, more on Orbit rollups; the max-fee overestimate stays
 * behind as dust when actual gas is cheaper). Broke sources are skipped with
 * a clear message; one bad wallet never stops the rest.
 */
export async function collectBalances({ chain, sources, toAddress, keepForGasWei, onEvent, abortRef }) {
  const call = makeRpc(chain);
  for (const w of sources) {
    if (abortRef.current) break;
    onEvent({ type: 'wallet-start', address: w.address });
    try {
      const balance = BigInt(await call('eth_getBalance', [w.address, 'latest']));
      const fees = await feePlan(call, chain);
      const gasLimit = await transferGasLimit(call, w.address, toAddress);
      const gasCap = gasLimit * fees.maxFee;
      const sweep = balance - gasCap - keepForGasWei;
      if (sweep <= 0n) {
        onEvent({
          type: 'tx-error',
          address: w.address,
          error:
            `skipped — balance ${ethers.formatEther(balance)} ${chain.native} ≤ gas cap ` +
            `${ethers.formatEther(gasCap)}` +
            (keepForGasWei > 0n ? ` + keep ${ethers.formatEther(keepForGasWei)}` : ''),
        });
        continue;
      }
      const nonce = BigInt(await call('eth_getTransactionCount', [w.address, 'pending']));
      await sendTransfer(call, chain, new ethers.Wallet(w.key), {
        to: toAddress,
        valueWei: sweep,
        nonce,
        onEvent,
        abortRef,
      });
    } catch (err) {
      onEvent({ type: 'tx-error', address: w.address, error: err?.message || String(err) });
    }
  }
  onEvent({ type: 'done' });
}