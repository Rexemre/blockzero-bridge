import assert from "node:assert/strict";
import { test } from "node:test";

process.env.BLOZ_DATADIR ??= "/tmp/none";
const { isReserveLabel } = await import("../src/bloz.js");

test("reserve labels are exempt from orphan refunds", () => {
  assert.equal(isReserveLabel("reserve-topup-devfund-20261022"), true);
  assert.equal(isReserveLabel("bridge-reserve-funding"), true);
  assert.equal(isReserveLabel("bridge-reserve-public"), true);
});

test("user wrap deposit labels and others are not exempt", () => {
  assert.equal(isReserveLabel("wrap-1792655924981"), false);
  assert.equal(isReserveLabel(""), false);
  assert.equal(isReserveLabel("my-reserve-topup"), false);
  assert.equal(isReserveLabel(undefined), false);
});
