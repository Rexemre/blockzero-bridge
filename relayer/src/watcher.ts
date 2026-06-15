import type Database from "better-sqlite3";

import { config } from "./config.js";

import {
  ensureBridgeWallet,
  ensurePublicReserveAddress,
  bridgeFeeBloz,
  feeBz1Address,
  findRecentPayoutSend,
  getBridgeBalance,
  getDepositSenderBz1,
  isBridgeReserveAddress,
  listRecentReceives,
  sendBridgeFee,
  sendBloz,
  unitsToBloz,
  unwrapNetworkFeeBloz,
  unwrapPayoutBloz,
  wrapMintBloz,
} from "./bloz.js";

import {
  fetchClaimEvents,
  fetchUnwrapEvents,
  getLatestBlock,
  getWBLOZTotalSupply,
} from "./bsc.js";

import {
  expireOldWraps,
  finalizeUnwrapIfTxid,
  getMintedWrapsPendingFee,
  getState,
  getUnwrapsNeedingPayout,
  getUnwrapsPendingFee,
  getWrapByDeposit,
  markWrapClaimable,
  markWrapMintedFromClaim,
  recordUnwrapSendFailure,
  setState,
  setUnwrapFeeSent,
  setUnwrapPayoutTxid,
  setWrapFeeSent,
  tryClaimUnwrapSend,
  upsertUnwrap,
} from "./db.js";
import { classifyDepositForWrap, pollRefunds, queueOrphanDeposit } from "./refund.js";

const processedDeposits = new Set<string>();

export async function initBridgeWallet(db: Database.Database): Promise<void> {
  await ensureBridgeWallet();
  const addr = await ensurePublicReserveAddress();
  setState(db, "public_reserve_bz1", addr);
}

export async function pollWrapDeposits(db: Database.Database): Promise<void> {
  expireOldWraps(db, Date.now());
  const receives = await listRecentReceives();
  const min = Number(config.bloz.minWrapBloz);
  const claimExpiresAt = Date.now() + config.bloz.claimExpiryHours * 3600 * 1000;

  for (const tx of receives) {
    const key = `${tx.txid}:${tx.address}`;
    if (processedDeposits.has(key)) continue;
    if (tx.confirmations < config.bloz.confirmations) continue;

    if (await isBridgeReserveAddress(tx.address)) {
      processedDeposits.add(key);
      console.log(`Reserve top-up: ${tx.amount} BLOZ @ ${tx.address} (${tx.txid})`);
      continue;
    }

    const wrap = getWrapByDeposit(db, tx.address);
    const decision = classifyDepositForWrap(wrap, tx, min);

    if (decision === "skip") {
      processedDeposits.add(key);
      continue;
    }

    if (decision !== "assign") {
      await queueOrphanDeposit(db, decision);
      processedDeposits.add(key);
      continue;
    }

    if (!wrap || wrap.status !== "pending") continue;

    const sender = await getDepositSenderBz1(tx.txid);
    markWrapClaimable(db, wrap.id, tx.txid, tx.amount, sender, claimExpiresAt);
    processedDeposits.add(key);
    let mintable = tx.amount;
    try {
      mintable = wrapMintBloz(tx.amount);
    } catch {
      /* below fee threshold — claim endpoint will reject with a clear error */
    }
    console.log(
      `Claimable ${mintable} wBLOZ (deposit ${tx.amount} BLOZ, after bridge fee) for ${wrap.evm_address} (wrap ${wrap.id})`
    );
  }
}

export async function pollClaimEvents(db: Database.Database): Promise<void> {
  try {
    if (!config.bsc.wrapClaimAddress) return;

    const last = getState(db, "last_claim_block");
    let fromBlock = last ? BigInt(last) + 1n : (await getLatestBlock()) - 5000n;
    if (fromBlock < 0n) fromBlock = 0n;

    const events = await fetchClaimEvents(fromBlock);
    for (const ev of events) {
      markWrapMintedFromClaim(db, ev.wrapId, ev.txHash);
      console.log(`Claim confirmed on-chain for wrap ${ev.wrapId} (${ev.txHash})`);
    }

    if (events.length > 0) {
      const maxBlock = events.reduce((m, e) => (e.blockNumber > m ? e.blockNumber : m), 0n);
      setState(db, "last_claim_block", maxBlock.toString());
    } else if (last) {
      // Advance cursor when idle so a long outage does not create one huge getLogs range.
      const tip = await getLatestBlock();
      if (tip > BigInt(last)) setState(db, "last_claim_block", tip.toString());
    }
  } catch (err) {
    console.error("claim event poll failed:", err);
  } finally {
    // Always sweep wrap fees — must not depend on BSC RPC succeeding.
    await processWrapFees(db);
  }
}

async function processWrapFees(db: Database.Database): Promise<void> {
  if (!feeBz1Address()) return;

  for (const wrap of getMintedWrapsPendingFee(db)) {
    if (!wrap.bloz_amount) continue;
    const sinceMs = wrap.claimable_at ?? wrap.created_at;

    const fee = bridgeFeeBloz(wrap.bloz_amount);
    const bal = await getBridgeBalance();
    if (bal < fee) {
      console.warn(`Insufficient bridge BLOZ for wrap fee ${wrap.id} (need ${fee}, have ${bal})`);
      continue;
    }

    try {
      const result = await sendBridgeFee(wrap.bloz_amount, `wrap ${wrap.id}`, sinceMs);
      if (result) {
        setWrapFeeSent(db, wrap.id, result.feeBloz, result.txid);
      }
    } catch (err) {
      console.error(`Wrap fee failed ${wrap.id}:`, err);
    }
  }
}

async function recoverInFlightUnwrap(
  db: Database.Database,
  req: ReturnType<typeof getUnwrapsNeedingPayout>[number],
  payout: number
): Promise<boolean> {
  if (req.bloz_txid) {
    if (finalizeUnwrapIfTxid(db, req.unwrap_id)) {
      console.log(`Unwrap ${req.unwrap_id}: recovered sent state (${req.bloz_txid})`);
      return true;
    }
  }

  if (req.status !== "sending" || req.bloz_txid) return false;

  const sinceMs = req.last_attempt_at ?? req.created_at;
  const found = await findRecentPayoutSend(req.bz1_address, payout, sinceMs);
  if (!found) return false;

  setUnwrapPayoutTxid(db, req.unwrap_id, found);
  if (finalizeUnwrapIfTxid(db, req.unwrap_id)) {
    console.log(`Unwrap ${req.unwrap_id}: recovered on-chain payout (${found})`);
    return true;
  }
  return false;
}

async function processUnwrapPayouts(db: Database.Database): Promise<void> {
  const now = Date.now();
  const retryMs = config.bloz.unwrapRetryDelayMs;
  const maxAttempts = config.bloz.unwrapMaxAttempts;
  const queue = getUnwrapsNeedingPayout(db);

  for (const req of queue) {
    let payout: number;
    try {
      payout = unwrapPayoutBloz(unitsToBloz(BigInt(req.amount_units)));
    } catch (err) {
      console.error(`Unwrap ${req.unwrap_id}: invalid payout amount`, err);
      db.prepare(`UPDATE unwrap_requests SET status='failed', last_error=? WHERE unwrap_id=?`).run(
        String(err).slice(0, 500),
        req.unwrap_id
      );
      continue;
    }

    if (await recoverInFlightUnwrap(db, req, payout)) continue;

    if (req.status === "sending" || req.status === "pending") {
      if (req.last_attempt_at && now - req.last_attempt_at < retryMs) continue;
    }

    const bal = await getBridgeBalance();
    const fee = feeBz1Address() ? bridgeFeeBloz(unitsToBloz(BigInt(req.amount_units))) : 0;
    if (bal < payout + fee) {
      console.warn(
        `Insufficient bridge BLOZ for unwrap ${req.unwrap_id} (need ${payout}${fee > 0 ? ` + ${fee} fee` : ""}, have ${bal})`
      );
      continue;
    }

    if (!tryClaimUnwrapSend(db, req.unwrap_id, payout, now, retryMs)) continue;

    try {
      const txid = await sendBloz(req.bz1_address, payout);
      setUnwrapPayoutTxid(db, req.unwrap_id, txid);
      if (!finalizeUnwrapIfTxid(db, req.unwrap_id)) {
        throw new Error("Could not finalize unwrap after broadcast");
      }
      const burned = unitsToBloz(BigInt(req.amount_units));
      console.log(
        `Unwrap ${req.unwrap_id}: sent ${payout} BLOZ -> ${req.bz1_address} (burned ${burned}, bridge fee + network fee ${unwrapNetworkFeeBloz()}) (${txid})`
      );

      if (feeBz1Address()) {
        try {
          const feeResult = await sendBridgeFee(
            burned,
            `unwrap ${req.unwrap_id}`,
            req.last_attempt_at ?? req.created_at
          );
          if (feeResult) {
            setUnwrapFeeSent(db, req.unwrap_id, feeResult.feeBloz, feeResult.txid);
          }
        } catch (err) {
          console.error(`Unwrap fee failed ${req.unwrap_id}:`, err);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Unwrap payout attempt failed ${req.unwrap_id}:`, msg);
      recordUnwrapSendFailure(db, req.unwrap_id, msg, maxAttempts);
    }
  }
}

export async function pollUnwrapEvents(db: Database.Database): Promise<void> {
  try {
    const last = getState(db, "last_unwrap_block");
    let fromBlock = last ? BigInt(last) + 1n : (await getLatestBlock()) - 5000n;
    if (fromBlock < 0n) fromBlock = 0n;

    const events = await fetchUnwrapEvents(fromBlock);
    for (const ev of events) {
      upsertUnwrap(db, {
        unwrap_id: Number(ev.unwrapId),
        evm_address: ev.user,
        bz1_address: ev.bz1Address,
        amount_units: ev.amount.toString(),
      });
    }

    if (events.length > 0) {
      const maxBlock = events.reduce((m, e) => (e.blockNumber > m ? e.blockNumber : m), 0n);
      setState(db, "last_unwrap_block", maxBlock.toString());
    } else if (last) {
      const tip = await getLatestBlock();
      if (tip > BigInt(last)) setState(db, "last_unwrap_block", tip.toString());
    }
  } catch (err) {
    console.error("unwrap event poll failed:", err);
  }

  try {
    await processUnwrapPayouts(db);
  } finally {
    await processUnwrapFees(db);
  }
}

async function processUnwrapFees(db: Database.Database): Promise<void> {
  if (!feeBz1Address()) return;

  for (const req of getUnwrapsPendingFee(db)) {
    const burned = unitsToBloz(BigInt(req.amount_units));
    const fee = bridgeFeeBloz(burned);
    const bal = await getBridgeBalance();
    if (bal < fee) {
      console.warn(`Insufficient bridge BLOZ for unwrap fee ${req.unwrap_id} (need ${fee}, have ${bal})`);
      continue;
    }

    try {
      const result = await sendBridgeFee(
        burned,
        `unwrap ${req.unwrap_id}`,
        req.last_attempt_at ?? req.created_at
      );
      if (result) {
        setUnwrapFeeSent(db, req.unwrap_id, result.feeBloz, result.txid);
      }
    } catch (err) {
      console.error(`Unwrap fee retry failed ${req.unwrap_id}:`, err);
    }
  }
}

export async function getReserveStats(db: Database.Database): Promise<{
  bridgeBloz: number;
  wBLOZSupply: string;
  backed: boolean;
  publicReserveBz1: string | null;
  updatedAt: string;
}> {
  const [bridgeBloz, supply] = await Promise.all([getBridgeBalance(), getWBLOZTotalSupply()]);
  const supplyBloz = unitsToBloz(supply);
  return {
    bridgeBloz,
    wBLOZSupply: supplyBloz.toFixed(8),
    backed: bridgeBloz + 1e-8 >= supplyBloz,
    publicReserveBz1: getState(db, "public_reserve_bz1") ?? null,
    updatedAt: new Date().toISOString(),
  };
}

export function startWatchers(db: Database.Database): void {
  setInterval(() => {
    pollWrapDeposits(db).catch((e) => console.error("wrap poll", e));
    processWrapFees(db).catch((e) => console.error("wrap fee sweep", e));
  }, config.bsc.blozPollMs);

  setInterval(() => {
    pollClaimEvents(db).catch((e) => console.error("claim poll", e));
    pollUnwrapEvents(db).catch((e) => console.error("unwrap poll", e));
    pollRefunds(db).catch((e) => console.error("refund poll", e));
  }, config.bsc.pollMs);
}
