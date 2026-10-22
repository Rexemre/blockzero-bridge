// Invalid bz1 targets (unwrap 24 + 43): offline check, node error detection, refund queue.
// Run: npm test
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { checkBz1Address, isValidBz1Address } from "../src/bz1.js";
import { getUnwrapsNeedingPayout, openDb, queueUnwrapRefund, upsertUnwrap } from "../src/db.js";

// Real bridge payouts (sent on mainnet) and the two burned unwraps with a typo'd target.
const VALID = [
  "bz1q7cgsct9rkyeqlppjjst0ysk9hedgarugqu0v7x",
  "bz1qr64fvk9yxvy5v0wtpfe4lv5madsqwf002ztspw",
  "bz1qgs6pay02fumgdt5p7tyvulvdst8evlx7ytrgwe",
];
const UNWRAP_24 = "bz1qmujpeg3pjsu51e6mtxun1umchwp7uv8t6gyjdp";
const UNWRAP_43 = "bz1q9su732atyq8mgwt21r8dqd2ckvp4z0242tk9sa";

test("real payout addresses pass the offline check", () => {
  for (const a of VALID) assert.equal(isValidBz1Address(a), true, a);
});

test("unwrap 24 and 43 targets are rejected ('1' in the data part)", () => {
  for (const a of [UNWRAP_24, UNWRAP_43]) {
    const r = checkBz1Address(a);
    assert.equal(r.valid, false, a);
  }
});

test("other malformed inputs are rejected", () => {
  for (const a of ["", "bz1", "bc1q7cgsct9rkyeqlppjjst0ysk9hedgarugqu0v7x", "bz1q7cgsct9rkyeqlppjjst0ysk9hedgarugqu0v7y",
    "BZ1Q7CGSCT9RKYEQLPPJJST0YSK9HEDGARUGQU0V7x", " bz1q7cgsct9rkyeqlppjjst0ysk9hedgarugqu0v7x"]) {
    assert.equal(isValidBz1Address(a), false, JSON.stringify(a));
  }
});

test("node 'Invalid Bitcoin address' error is recognised", async () => {
  const { isInvalidAddressError } = await import("../src/bloz.js");
  const msg = `Command failed: bitcoin-cli ... sendtoaddress address=${UNWRAP_43}\nerror code: -5\nerror message:\nInvalid Bitcoin address: ${UNWRAP_43}`;
  assert.equal(isInvalidAddressError(msg), true);
  assert.equal(isInvalidAddressError("error code: -6\nerror message:\nInsufficient funds"), false);
  assert.equal(isInvalidAddressError("error code: -28\nLoading wallet..."), false);
});

test("queueUnwrapRefund parks failed/pending unwraps, never paid ones; queue skips them", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bridge-refundq-"));
  try {
    const db = openDb(path.join(dir, "bridge.db"));
    const cols = (db.prepare("PRAGMA table_info(unwrap_requests)").all() as { name: string }[]).map((c) => c.name);
    assert.ok(cols.includes("refund_evm_txid") && cols.includes("refunded_at"), "refund columns on unwrap_requests");
    const base = { evm_address: "0x89f6907d6fecd6fd6382d770fab61c0ddc436c1d", amount_units: "2000000000" };
    upsertUnwrap(db, { unwrap_id: 43, bz1_address: UNWRAP_43, ...base });
    upsertUnwrap(db, { unwrap_id: 44, bz1_address: VALID[0], ...base });
    db.prepare("UPDATE unwrap_requests SET status='failed' WHERE unwrap_id=43").run();
    db.prepare("UPDATE unwrap_requests SET status='sent', bloz_txid='ab' WHERE unwrap_id=44").run();

    assert.equal(queueUnwrapRefund(db, 43, "invalid bz1 address"), true);
    assert.equal(queueUnwrapRefund(db, 43, "again"), false, "idempotent");
    assert.equal(queueUnwrapRefund(db, 44, "paid"), false, "paid unwrap untouched");
    const row = db.prepare("SELECT status, last_error FROM unwrap_requests WHERE unwrap_id=43").get() as {
      status: string;
      last_error: string;
    };
    assert.equal(row.status, "refund_queued");
    assert.equal(getUnwrapsNeedingPayout(db).length, 0, "refund_queued is never retried as payout");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
