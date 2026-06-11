import type Database from "better-sqlite3";

import { config } from "./config.js";
import {
  findRecentPayoutSend,
  getDepositSenderBz1,
  getBridgeBalance,
  refundPayoutBloz,
  sendBloz,
  unwrapNetworkFeeBloz,
} from "./bloz.js";
import {
  applyDebtRecovery,
  getOutstandingDebtFor,
  getOrphansNeedingRefund,
  getWrapsNeedingRefund,
  isMintedWrapDepositTx,
  cancelErroneousOrphanDeposits,
  markOrphanRefunded,
  markWrapMintedOnChain,
  markWrapRefunded,
  recordOrphanRefundFailure,
  recordWrapRefundFailure,
  tryClaimOrphanRefund,
  tryClaimWrapRefund,
  upsertOrphanDeposit,
  type OrphanReason,
  type WrapRequest,
} from "./db.js";
import { isWrapClaimedOnChain } from "./bsc.js";
import type { BlozTx } from "./bloz.js";

export type OrphanDepositInput = {
  txid: string;
  depositAddress: string;
  amount: number;
  reason: OrphanReason;
};

export function classifyDepositForWrap(
  wrap: WrapRequest | undefined,
  tx: BlozTx,
  minWrap: number
): "assign" | OrphanDepositInput | "skip" {
  if (!wrap) {
    return {
      txid: tx.txid,
      depositAddress: tx.address,
      amount: tx.amount,
      reason: "unknown_address",
    };
  }

  if (wrap.status === "minted" || wrap.status === "refunded" || wrap.status === "refunding") {
    // Already processed wrap deposit — do not re-queue on relayer restart (poll sees old receives).
    if (wrap.bloz_txid === tx.txid) return "skip";
    return {
      txid: tx.txid,
      depositAddress: tx.address,
      amount: tx.amount,
      reason: "wrap_closed",
    };
  }

  if (wrap.status === "expired") {
    return {
      txid: tx.txid,
      depositAddress: tx.address,
      amount: tx.amount,
      reason: "expired_address",
    };
  }

  if (wrap.status === "claimable") {
    if (wrap.bloz_txid === tx.txid) return "skip";
    return {
      txid: tx.txid,
      depositAddress: tx.address,
      amount: tx.amount,
      reason: "duplicate_deposit",
    };
  }

  if (wrap.status !== "pending") return "skip";

  if (wrap.bloz_txid === tx.txid) return "skip";

  if (wrap.bloz_txid && wrap.bloz_txid !== tx.txid) {
    return {
      txid: tx.txid,
      depositAddress: tx.address,
      amount: tx.amount,
      reason: "duplicate_deposit",
    };
  }

  if (tx.amount < minWrap) {
    return {
      txid: tx.txid,
      depositAddress: tx.address,
      amount: tx.amount,
      reason: "below_min",
    };
  }

  return "assign";
}

export async function queueOrphanDeposit(
  db: Database.Database,
  orphan: OrphanDepositInput
): Promise<void> {
  const sender = await getDepositSenderBz1(orphan.txid);
  upsertOrphanDeposit(db, { ...orphan, senderBz1: sender });
  console.log(
    `Orphan deposit queued for refund (${orphan.reason}): ${orphan.amount} BLOZ @ ${orphan.depositAddress} (${orphan.txid})`
  );
}

async function resolveSenderBz1(
  db: Database.Database,
  txid: string,
  cached: string | null | undefined
): Promise<string | null> {
  if (cached) return cached;
  const sender = await getDepositSenderBz1(txid);
  if (sender) {
    db.prepare("UPDATE orphan_deposits SET sender_bz1=? WHERE txid=?").run(sender, txid);
    return sender;
  }
  return null;
}

async function executeRefund(
  db: Database.Database,
  opts: {
    kind: "wrap" | "orphan";
    id: string;
    txid: string;
    amount: number;
    senderBz1: string | null;
    markRefunding: () => boolean;
    markRefunded: (refundTxid: string, payout: number, sender: string) => void;
    markFailed: (msg: string) => void;
    recoverSinceMs: number;
  }
): Promise<void> {
  const fee = unwrapNetworkFeeBloz();
  let payout: number;
  try {
    payout = refundPayoutBloz(opts.amount);
  } catch (err) {
    opts.markFailed(String(err));
    return;
  }

  if (!opts.senderBz1) {
    console.warn(`Refund ${opts.kind} ${opts.id}: sender bz1 unknown for ${opts.txid}, retry later`);
    return;
  }

  // Debt netting: refunds to addresses that owe the bridge are reduced by the
  // outstanding debt (withheld BLOZ stays in the reserve as recovery).
  const debt = getOutstandingDebtFor(db, [opts.senderBz1]);
  if (debt) {
    const withheld = Math.round(Math.min(payout, debt.outstanding) * 1e8) / 1e8;
    const reduced = Math.round((payout - withheld) * 1e8) / 1e8;
    if (!opts.markRefunding()) return;
    if (reduced <= 0) {
      opts.markRefunded("debt-recovery", 0, opts.senderBz1);
      const applied = applyDebtRecovery(db, debt.groupId, withheld);
      console.warn(
        `Refund ${opts.kind} ${opts.id}: fully withheld ${applied} BLOZ against debt (group ${debt.groupId})`
      );
      return;
    }
    try {
      const refundTxid = await sendBloz(opts.senderBz1, reduced);
      opts.markRefunded(refundTxid, reduced, opts.senderBz1);
      const applied = applyDebtRecovery(db, debt.groupId, withheld);
      console.warn(
        `Refund ${opts.kind} ${opts.id}: withheld ${applied} BLOZ against debt (group ${debt.groupId}), paid ${reduced} (${refundTxid})`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Refund ${opts.kind} ${opts.id} failed:`, msg);
      opts.markFailed(msg);
    }
    return;
  }

  const recovered = await findRecentPayoutSend(opts.senderBz1, payout, opts.recoverSinceMs);
  if (recovered) {
    opts.markRefunded(recovered, payout, opts.senderBz1);
    console.log(`Refund ${opts.kind} ${opts.id}: recovered prior payout (${recovered})`);
    return;
  }

  const bal = await getBridgeBalance();
  if (bal < payout) {
    console.warn(`Refund ${opts.kind} ${opts.id}: insufficient bridge BLOZ (need ${payout}, have ${bal})`);
    return;
  }

  if (!opts.markRefunding()) return;

  try {
    const refundTxid = await sendBloz(opts.senderBz1, payout);
    opts.markRefunded(refundTxid, payout, opts.senderBz1);
    console.log(
      `Refund ${opts.kind} ${opts.id}: sent ${payout} BLOZ -> ${opts.senderBz1} ` +
        `(from ${opts.amount}, fee ${fee}) (${refundTxid})`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Refund ${opts.kind} ${opts.id} failed:`, msg);
    opts.markFailed(msg);
  }
}

export async function processWrapRefunds(db: Database.Database): Promise<void> {
  const now = Date.now();
  const retryMs = config.bloz.refundRetryDelayMs;
  const maxAttempts = config.bloz.refundMaxAttempts;
  const sigGraceMs = config.bloz.claimSigTtlSec * 1000;

  for (const wrap of getWrapsNeedingRefund(db, now)) {
    const amount = wrap.bloz_amount;
    const txid = wrap.bloz_txid;
    if (amount == null || !txid) continue;

    if (wrap.claim_expires_at && now < wrap.claim_expires_at + sigGraceMs) {
      continue;
    }

    if (await isWrapClaimedOnChain(wrap.id)) {
      markWrapMintedOnChain(db, wrap.id);
      console.log(`Wrap ${wrap.id}: already claimed on-chain — skip refund`);
      continue;
    }

    const sender =
      wrap.refund_bz1 ??
      wrap.sender_bz1 ??
      (await getDepositSenderBz1(txid));

    await executeRefund(db, {
      kind: "wrap",
      id: wrap.id,
      txid,
      amount,
      senderBz1: sender,
      recoverSinceMs: wrap.claimable_at ?? wrap.created_at,
      markRefunding: () => tryClaimWrapRefund(db, wrap.id, sender, now, retryMs),
      markRefunded: (refundTxid, payout, refundBz1) =>
        markWrapRefunded(db, wrap.id, refundTxid, payout, refundBz1),
      markFailed: (msg) => recordWrapRefundFailure(db, wrap.id, msg, maxAttempts),
    });
  }
}

export async function processOrphanRefunds(db: Database.Database): Promise<void> {
  const now = Date.now();
  const retryMs = config.bloz.refundRetryDelayMs;
  const maxAttempts = config.bloz.refundMaxAttempts;

  for (const row of getOrphansNeedingRefund(db)) {
    if (isMintedWrapDepositTx(db, row.txid)) {
      console.warn(
        `Skip orphan refund ${row.txid}: deposit already belongs to a minted wrap`
      );
      continue;
    }

    const sender = await resolveSenderBz1(db, row.txid, row.sender_bz1);

    await executeRefund(db, {
      kind: "orphan",
      id: `${row.txid}:${row.deposit_address}`,
      txid: row.txid,
      amount: row.amount,
      senderBz1: sender,
      recoverSinceMs: row.created_at,
      markRefunding: () => tryClaimOrphanRefund(db, row.txid, row.deposit_address, sender, now, retryMs),
      markRefunded: (refundTxid, payout, refundBz1) =>
        markOrphanRefunded(db, row.txid, row.deposit_address, refundTxid, payout, refundBz1),
      markFailed: (msg) =>
        recordOrphanRefundFailure(db, row.txid, row.deposit_address, msg, maxAttempts),
    });
  }
}

export async function pollRefunds(db: Database.Database): Promise<void> {
  await processWrapRefunds(db);
  await processOrphanRefunds(db);
}
