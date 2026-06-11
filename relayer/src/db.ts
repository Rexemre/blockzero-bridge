import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export type WrapStatus =
  | "pending"
  | "claimable"
  | "minted"
  | "expired"
  | "refunding"
  | "refunded";
export type UnwrapStatus = "pending" | "sending" | "sent" | "failed";
export type OrphanReason =
  | "below_min"
  | "expired_address"
  | "duplicate_deposit"
  | "unknown_address"
  | "wrap_closed"
  | "unclaimed";
export type OrphanStatus = "pending" | "refunding" | "refunded" | "failed";

export interface WrapRequest {
  id: string;
  evm_address: string;
  deposit_address: string;
  status: WrapStatus;
  bloz_txid: string | null;
  bloz_amount: number | null;
  mint_tx_hash: string | null;
  created_at: number;
  expires_at: number;
  claimable_at: number | null;
  claim_expires_at: number | null;
  sender_bz1: string | null;
  refund_txid: string | null;
  refund_bz1: string | null;
  refund_amount: number | null;
  refund_attempt_count: number;
  refund_last_attempt_at: number | null;
  refund_last_error: string | null;
  fee_bloz: number | null;
  fee_txid: string | null;
}

export interface OrphanDeposit {
  txid: string;
  deposit_address: string;
  amount: number;
  sender_bz1: string | null;
  status: OrphanStatus;
  reason: OrphanReason;
  refund_txid: string | null;
  refund_amount: number | null;
  refund_attempt_count: number;
  refund_last_attempt_at: number | null;
  refund_last_error: string | null;
  created_at: number;
}

export interface UnwrapRequest {
  unwrap_id: number;
  evm_address: string;
  bz1_address: string;
  amount_units: string;
  status: UnwrapStatus;
  bloz_txid: string | null;
  payout_bloz: number | null;
  attempt_count: number;
  last_attempt_at: number | null;
  last_error: string | null;
  created_at: number;
  fee_bloz: number | null;
  fee_txid: string | null;
}

export function openDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS wrap_requests (
      id TEXT PRIMARY KEY,
      evm_address TEXT NOT NULL,
      deposit_address TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      bloz_txid TEXT,
      bloz_amount REAL,
      mint_tx_hash TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS unwrap_requests (
      unwrap_id INTEGER PRIMARY KEY,
      evm_address TEXT NOT NULL,
      bz1_address TEXT NOT NULL,
      amount_units TEXT NOT NULL,
      status TEXT NOT NULL,
      bloz_txid TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS relayer_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  try {
    db.prepare("SELECT payout_bloz FROM unwrap_requests LIMIT 1").get();
  } catch {
    db.exec("ALTER TABLE unwrap_requests ADD COLUMN payout_bloz REAL");
  }
  for (const [col, def] of [
    ["attempt_count", "INTEGER NOT NULL DEFAULT 0"],
    ["last_attempt_at", "INTEGER"],
    ["last_error", "TEXT"],
  ] as const) {
    try {
      db.prepare(`SELECT ${col} FROM unwrap_requests LIMIT 1`).get();
    } catch {
      db.exec(`ALTER TABLE unwrap_requests ADD COLUMN ${col} ${def}`);
    }
  }
  for (const [col, def] of [
    ["claimable_at", "INTEGER"],
    ["claim_expires_at", "INTEGER"],
    ["sender_bz1", "TEXT"],
    ["refund_txid", "TEXT"],
    ["refund_bz1", "TEXT"],
    ["refund_amount", "REAL"],
    ["refund_attempt_count", "INTEGER NOT NULL DEFAULT 0"],
    ["refund_last_attempt_at", "INTEGER"],
    ["refund_last_error", "TEXT"],
    ["fee_bloz", "REAL"],
    ["fee_txid", "TEXT"],
  ] as const) {
    try {
      db.prepare(`SELECT ${col} FROM wrap_requests LIMIT 1`).get();
    } catch {
      db.exec(`ALTER TABLE wrap_requests ADD COLUMN ${col} ${def}`);
    }
  }
  for (const [col, def] of [
    ["fee_bloz", "REAL"],
    ["fee_txid", "TEXT"],
  ] as const) {
    try {
      db.prepare(`SELECT ${col} FROM unwrap_requests LIMIT 1`).get();
    } catch {
      db.exec(`ALTER TABLE unwrap_requests ADD COLUMN ${col} ${def}`);
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS orphan_deposits (
      txid TEXT NOT NULL,
      deposit_address TEXT NOT NULL,
      amount REAL NOT NULL,
      sender_bz1 TEXT,
      status TEXT NOT NULL,
      reason TEXT NOT NULL,
      refund_txid TEXT,
      refund_amount REAL,
      refund_attempt_count INTEGER NOT NULL DEFAULT 0,
      refund_last_attempt_at INTEGER,
      refund_last_error TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (txid, deposit_address)
    );
  `);
  return db;
}

export function createWrapRequest(
  db: Database.Database,
  evmAddress: string,
  depositAddress: string,
  expiresAt: number,
  returnBz1: string | null = null
): WrapRequest {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO wrap_requests (id, evm_address, deposit_address, status, created_at, expires_at, sender_bz1)
     VALUES (?, ?, ?, 'pending', ?, ?, ?)`
  ).run(id, evmAddress.toLowerCase(), depositAddress, now, expiresAt, returnBz1);
  return getWrapById(db, id)!;
}

export function getWrapById(db: Database.Database, id: string): WrapRequest | undefined {
  return db.prepare("SELECT * FROM wrap_requests WHERE id = ?").get(id) as WrapRequest | undefined;
}

export function getWrapByDeposit(db: Database.Database, addr: string): WrapRequest | undefined {
  return db.prepare("SELECT * FROM wrap_requests WHERE deposit_address = ?").get(addr) as
    | WrapRequest
    | undefined;
}

export function listWrapsForEvm(db: Database.Database, evm: string, limit = 20): WrapRequest[] {
  return db
    .prepare(
      "SELECT * FROM wrap_requests WHERE evm_address = ? ORDER BY created_at DESC LIMIT ?"
    )
    .all(evm.toLowerCase(), limit) as WrapRequest[];
}

/** Pending deposit or unclaimed wrap — blocks creating another address for the same wallet. */
export function getActiveWrapForEvm(
  db: Database.Database,
  evm: string,
  now: number
): WrapRequest | undefined {
  return db
    .prepare(
      `SELECT * FROM wrap_requests
       WHERE evm_address = ?
         AND (
           status = 'claimable'
           OR (status = 'pending' AND expires_at > ?)
         )
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(evm.toLowerCase(), now) as WrapRequest | undefined;
}

export function markWrapClaimable(
  db: Database.Database,
  id: string,
  txid: string,
  amount: number,
  senderBz1: string | null,
  claimExpiresAt: number
): void {
  const now = Date.now();
  db.prepare(
    `UPDATE wrap_requests
     SET status='claimable', bloz_txid=?, bloz_amount=?, claimable_at=?, claim_expires_at=?, sender_bz1=COALESCE(?, sender_bz1)
     WHERE id=? AND status='pending'`
  ).run(txid, amount, now, claimExpiresAt, senderBz1, id);
}

export function markWrapMinted(
  db: Database.Database,
  id: string,
  txid: string,
  amount: number,
  mintTx: string
): void {
  db.prepare(
    `UPDATE wrap_requests SET status='minted', bloz_txid=?, bloz_amount=?, mint_tx_hash=? WHERE id=?`
  ).run(txid, amount, mintTx, id);
}

export function markWrapMintedFromClaim(db: Database.Database, id: string, mintTx: string): void {
  db.prepare(
    `UPDATE wrap_requests SET status='minted', mint_tx_hash=? WHERE id=? AND status IN ('claimable', 'refunding')`
  ).run(mintTx, id);
}

export function getMintedWrapsPendingFee(db: Database.Database): WrapRequest[] {
  return db
    .prepare(
      `SELECT * FROM wrap_requests
       WHERE status='minted' AND fee_txid IS NULL AND bloz_amount IS NOT NULL
       ORDER BY claimable_at ASC`
    )
    .all() as WrapRequest[];
}

export function setWrapFeeSent(
  db: Database.Database,
  id: string,
  feeBloz: number,
  feeTxid: string
): void {
  db.prepare(
    `UPDATE wrap_requests SET fee_bloz=?, fee_txid=? WHERE id=? AND fee_txid IS NULL`
  ).run(feeBloz, feeTxid, id);
}

/** On-chain claim detected while DB still shows claimable/refunding (e.g. before refund). */
export function markWrapMintedOnChain(db: Database.Database, id: string): void {
  db.prepare(
    `UPDATE wrap_requests SET status='minted' WHERE id=? AND status IN ('claimable', 'refunding')`
  ).run(id);
}

export function expireOldWraps(db: Database.Database, now: number): number {
  const r = db
    .prepare(`UPDATE wrap_requests SET status='expired' WHERE status='pending' AND expires_at < ?`)
    .run(now);
  return r.changes;
}

export function getWrapsNeedingRefund(db: Database.Database, now: number): WrapRequest[] {
  return db
    .prepare(
      `SELECT * FROM wrap_requests
       WHERE status='claimable'
         AND claim_expires_at IS NOT NULL
         AND claim_expires_at < ?
       ORDER BY claim_expires_at ASC`
    )
    .all(now) as WrapRequest[];
}

export function tryClaimWrapRefund(
  db: Database.Database,
  id: string,
  senderBz1: string | null,
  now: number,
  retryAfterMs: number
): boolean {
  const cutoff = now - retryAfterMs;
  const r = db
    .prepare(
      `UPDATE wrap_requests
       SET status='refunding', refund_bz1=COALESCE(?, refund_bz1), refund_attempt_count=refund_attempt_count+1,
           refund_last_attempt_at=?, refund_last_error=NULL
       WHERE id=?
         AND status='claimable'
         AND refund_txid IS NULL
         AND (refund_last_attempt_at IS NULL OR refund_last_attempt_at <= ?)`
    )
    .run(senderBz1, now, id, cutoff);
  return r.changes > 0;
}

export function markWrapRefunded(
  db: Database.Database,
  id: string,
  refundTxid: string,
  refundAmount: number,
  refundBz1: string
): void {
  db.prepare(
    `UPDATE wrap_requests
     SET status='refunded', refund_txid=?, refund_amount=?, refund_bz1=?
     WHERE id=? AND status='refunding'`
  ).run(refundTxid, refundAmount, refundBz1, id);
}

export function recordWrapRefundFailure(
  db: Database.Database,
  id: string,
  error: string,
  maxAttempts: number
): void {
  const row = db
    .prepare("SELECT refund_attempt_count, status FROM wrap_requests WHERE id=?")
    .get(id) as { refund_attempt_count: number; status: string } | undefined;
  if (!row || row.status !== "refunding") return;

  if (row.refund_attempt_count >= maxAttempts) {
    db.prepare(
      `UPDATE wrap_requests SET status='claimable', refund_last_error=? WHERE id=?`
    ).run(error.slice(0, 500), id);
    return;
  }
  db.prepare(
    `UPDATE wrap_requests SET status='claimable', refund_last_error=? WHERE id=? AND status='refunding' AND refund_txid IS NULL`
  ).run(error.slice(0, 500), id);
}

export function upsertOrphanDeposit(
  db: Database.Database,
  row: {
    txid: string;
    depositAddress: string;
    amount: number;
    reason: OrphanReason;
    senderBz1: string | null;
  }
): void {
  db.prepare(
    `INSERT INTO orphan_deposits (txid, deposit_address, amount, sender_bz1, status, reason, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)
     ON CONFLICT(txid, deposit_address) DO UPDATE SET
       sender_bz1=COALESCE(excluded.sender_bz1, orphan_deposits.sender_bz1),
       amount=excluded.amount
     WHERE orphan_deposits.status IN ('pending', 'failed')`
  ).run(
    row.txid,
    row.depositAddress,
    row.amount,
    row.senderBz1,
    row.reason,
    Date.now()
  );
}

export function getOrphansNeedingRefund(db: Database.Database): OrphanDeposit[] {
  return db
    .prepare(
      `SELECT * FROM orphan_deposits
       WHERE status IN ('pending', 'failed')
       ORDER BY created_at ASC`
    )
    .all() as OrphanDeposit[];
}

/** Deposit tx already credited to a successful wrap — never refund as orphan. */
export function isMintedWrapDepositTx(db: Database.Database, txid: string): boolean {
  const row = db
    .prepare(`SELECT 1 FROM wrap_requests WHERE bloz_txid=? AND status='minted' LIMIT 1`)
    .get(txid);
  return row != null;
}

/** Cancel orphan rows that wrongly target minted wrap deposits (e.g. after relayer restart bug). */
export function cancelErroneousOrphanDeposits(db: Database.Database): number {
  const r = db
    .prepare(
      `UPDATE orphan_deposits SET status='cancelled', refund_last_error='minted_wrap_deposit'
       WHERE status IN ('pending', 'failed')
         AND txid IN (SELECT bloz_txid FROM wrap_requests WHERE status='minted' AND bloz_txid IS NOT NULL)`
    )
    .run();
  return r.changes;
}

export function tryClaimOrphanRefund(
  db: Database.Database,
  txid: string,
  depositAddress: string,
  senderBz1: string | null,
  now: number,
  retryAfterMs: number
): boolean {
  const cutoff = now - retryAfterMs;
  const r = db
    .prepare(
      `UPDATE orphan_deposits
       SET status='refunding', sender_bz1=COALESCE(?, sender_bz1), refund_attempt_count=refund_attempt_count+1,
           refund_last_attempt_at=?, refund_last_error=NULL
       WHERE txid=? AND deposit_address=?
         AND status IN ('pending', 'failed')
         AND refund_txid IS NULL
         AND (refund_last_attempt_at IS NULL OR refund_last_attempt_at <= ?)`
    )
    .run(senderBz1, now, txid, depositAddress, cutoff);
  return r.changes > 0;
}

export function markOrphanRefunded(
  db: Database.Database,
  txid: string,
  depositAddress: string,
  refundTxid: string,
  refundAmount: number,
  refundBz1: string
): void {
  db.prepare(
    `UPDATE orphan_deposits
     SET status='refunded', refund_txid=?, refund_amount=?, sender_bz1=?
     WHERE txid=? AND deposit_address=? AND status='refunding'`
  ).run(refundTxid, refundAmount, refundBz1, txid, depositAddress);
}

export function recordOrphanRefundFailure(
  db: Database.Database,
  txid: string,
  depositAddress: string,
  error: string,
  maxAttempts: number
): void {
  const row = db
    .prepare(
      "SELECT refund_attempt_count, status FROM orphan_deposits WHERE txid=? AND deposit_address=?"
    )
    .get(txid, depositAddress) as { refund_attempt_count: number; status: string } | undefined;
  if (!row || row.status !== "refunding") return;

  const nextStatus = row.refund_attempt_count >= maxAttempts ? "failed" : "pending";
  db.prepare(
    `UPDATE orphan_deposits SET status=?, refund_last_error=? WHERE txid=? AND deposit_address=?`
  ).run(nextStatus, error.slice(0, 500), txid, depositAddress);
}

export function upsertUnwrap(
  db: Database.Database,
  row: Omit<
    UnwrapRequest,
    | "bloz_txid"
    | "payout_bloz"
    | "attempt_count"
    | "last_attempt_at"
    | "last_error"
    | "created_at"
    | "status"
    | "fee_bloz"
    | "fee_txid"
  > & { status?: UnwrapStatus }
): void {
  db.prepare(
    `INSERT OR IGNORE INTO unwrap_requests (unwrap_id, evm_address, bz1_address, amount_units, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    row.unwrap_id,
    row.evm_address.toLowerCase(),
    row.bz1_address,
    row.amount_units,
    row.status ?? "pending",
    Date.now()
  );
}

export function getUnwrapsNeedingPayout(db: Database.Database): UnwrapRequest[] {
  return db
    .prepare(
      `SELECT * FROM unwrap_requests
       WHERE status IN ('pending', 'sending')
       ORDER BY unwrap_id ASC`
    )
    .all() as UnwrapRequest[];
}

/** @deprecated use getUnwrapsNeedingPayout */
export function getPendingUnwraps(db: Database.Database): UnwrapRequest[] {
  return getUnwrapsNeedingPayout(db);
}

export function tryClaimUnwrapSend(
  db: Database.Database,
  unwrapId: number,
  payoutBloz: number,
  now: number,
  retryAfterMs: number
): boolean {
  const cutoff = now - retryAfterMs;
  const r = db
    .prepare(
      `UPDATE unwrap_requests
       SET status='sending', payout_bloz=?, attempt_count=attempt_count+1, last_attempt_at=?, last_error=NULL
       WHERE unwrap_id=?
         AND status IN ('pending', 'sending')
         AND bloz_txid IS NULL
         AND (last_attempt_at IS NULL OR last_attempt_at <= ?)`
    )
    .run(payoutBloz, now, unwrapId, cutoff);
  return r.changes > 0;
}

export function setUnwrapPayoutTxid(db: Database.Database, unwrapId: number, blozTxid: string): void {
  db.prepare(`UPDATE unwrap_requests SET bloz_txid=? WHERE unwrap_id=? AND status='sending'`).run(
    blozTxid,
    unwrapId
  );
}

export function finalizeUnwrapIfTxid(db: Database.Database, unwrapId: number): boolean {
  const r = db
    .prepare(
      `UPDATE unwrap_requests SET status='sent'
       WHERE unwrap_id=? AND status='sending' AND bloz_txid IS NOT NULL`
    )
    .run(unwrapId);
  return r.changes > 0;
}

export function setUnwrapFeeSent(
  db: Database.Database,
  unwrapId: number,
  feeBloz: number,
  feeTxid: string
): void {
  db.prepare(
    `UPDATE unwrap_requests SET fee_bloz=?, fee_txid=? WHERE unwrap_id=? AND fee_txid IS NULL`
  ).run(feeBloz, feeTxid, unwrapId);
}

export function getUnwrapsPendingFee(db: Database.Database): UnwrapRequest[] {
  return db
    .prepare(
      `SELECT * FROM unwrap_requests
       WHERE status='sent' AND fee_txid IS NULL
       ORDER BY unwrap_id ASC`
    )
    .all() as UnwrapRequest[];
}

export function recordUnwrapSendFailure(
  db: Database.Database,
  unwrapId: number,
  error: string,
  maxAttempts: number
): void {
  const row = db
    .prepare("SELECT attempt_count, status FROM unwrap_requests WHERE unwrap_id=?")
    .get(unwrapId) as { attempt_count: number; status: string } | undefined;
  if (!row || row.status !== "sending") return;

  if (row.attempt_count >= maxAttempts) {
    db.prepare(`UPDATE unwrap_requests SET status='failed', last_error=? WHERE unwrap_id=?`).run(
      error.slice(0, 500),
      unwrapId
    );
    return;
  }
  db.prepare(
    `UPDATE unwrap_requests SET status='pending', last_error=? WHERE unwrap_id=? AND status='sending' AND bloz_txid IS NULL`
  ).run(error.slice(0, 500), unwrapId);
}

export function listUnwrapsForEvm(db: Database.Database, evm: string, limit = 20): UnwrapRequest[] {
  return db
    .prepare(
      "SELECT * FROM unwrap_requests WHERE evm_address = ? ORDER BY created_at DESC LIMIT ?"
    )
    .all(evm.toLowerCase(), limit) as UnwrapRequest[];
}

export function markUnwrapSent(
  db: Database.Database,
  unwrapId: number,
  blozTxid: string,
  payoutBloz: number
): void {
  db.prepare(
    `UPDATE unwrap_requests SET status='sent', bloz_txid=?, payout_bloz=? WHERE unwrap_id=?`
  ).run(blozTxid, payoutBloz, unwrapId);
}

/** @deprecated use finalizeUnwrapIfTxid / recordUnwrapSendFailure */
export function markUnwrapFailed(db: Database.Database, unwrapId: number): void {
  db.prepare(`UPDATE unwrap_requests SET status='failed' WHERE unwrap_id=?`).run(unwrapId);
}

export function getState(db: Database.Database, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM relayer_state WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setState(db: Database.Database, key: string, value: string): void {
  db.prepare(
    "INSERT INTO relayer_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).run(key, value);
}
