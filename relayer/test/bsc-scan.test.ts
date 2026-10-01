// Run: npm test   (node --import tsx --test test/*.test.ts)
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BlockNotFoundError,
  HttpRequestError,
  TimeoutError,
  TransactionReceiptNotFoundError,
  type Hex,
  type TransactionReceipt,
} from "viem";

import {
  RpcPool,
  RpcPoolExhausted,
  StallGate,
  classifyRpcIssue,
  mergeRpcUrls,
  rpcLabel,
  scanBlockRange,
  scanTarget,
  type BlockVisitor,
  type ScanRpc,
  type ScanTx,
} from "../src/bsc-scan.js";

// Same rule as deploy/bridge-health.py check_logs(): these words make a line an "error line".
const HEALTH_ERROR_WORDS = ["error", "failed", "fatal", "unhandled"];
const isHealthErrorLine = (l: string) => HEALTH_ERROR_WORDS.some((w) => l.toLowerCase().includes(w));

const BRIDGE = "0x00000000000000000000000000000000000000b1";

/** Fake chain: block n holds one "unwrap" tx when n is in `eventBlocks`. */
function fakeChain(eventBlocks: bigint[]) {
  const txOf = (b: bigint): ScanTx[] =>
    eventBlocks.includes(b) ? [{ hash: `0x${b.toString(16).padStart(64, "0")}` as Hex, to: BRIDGE, input: "0x307cf63f" }] : [];
  return { txOf };
}

/** Endpoint serving blocks up to `served()`; anything newer → BlockNotFound like a lagging backend. */
function fakeRpc(
  name: string,
  chain: ReturnType<typeof fakeChain>,
  tip: () => bigint,
  served: () => bigint,
  opts: { receiptMissing?: Set<bigint> } = {}
): ScanRpc & { calls: number } {
  const rpc = {
    name,
    calls: 0,
    blockNumber: async () => {
      rpc.calls++;
      return tip();
    },
    blockTxs: async (n: bigint) => {
      rpc.calls++;
      if (n > served()) throw new BlockNotFoundError({ blockNumber: n });
      return chain.txOf(n);
    },
    receipt: async (hash: Hex) => {
      rpc.calls++;
      const b = BigInt(hash);
      if (opts.receiptMissing?.has(b)) throw new TransactionReceiptNotFoundError({ hash });
      return { blockNumber: b, logs: [] } as unknown as TransactionReceipt;
    },
  };
  return rpc;
}

/** Visitor that turns each matching tx into an event (needs the receipt like the real one). */
const visit: BlockVisitor<bigint> = async (pool, b, txs) => {
  const out: bigint[] = [];
  for (const tx of txs) {
    if (tx.to !== BRIDGE) continue;
    await pool.call(`receipt ${tx.hash}`, (rpc) => rpc.receipt(tx.hash));
    out.push(b);
  }
  return out;
};

const noSleep = async () => {};

test("classifyRpcIssue maps real viem errors to short codes without health trigger words", () => {
  const cases: [unknown, string][] = [
    [new BlockNotFoundError({ blockNumber: 125060575n }), "block-not-found"],
    [new TransactionReceiptNotFoundError({ hash: "0x01" }), "receipt-not-found"],
    [new TimeoutError({ body: {}, url: "https://x" }), "timeout"],
    [new HttpRequestError({ url: "https://x", status: 429, details: "rate limit" }), "rate-limited"],
    [new HttpRequestError({ url: "https://x", details: "fetch failed" }), "http"],
    [new Error("Unauthorized: You must authenticate your request with an API key"), "unauthorized"],
    [new Error("something odd"), "rpc"],
  ];
  for (const [err, code] of cases) {
    assert.equal(classifyRpcIssue(err), code);
    assert.ok(!isHealthErrorLine(code));
  }
});

test("RpcPool rotates past an endpoint that does not have the block yet and sticks to the good one", async () => {
  const chain = fakeChain([]);
  const lagging = fakeRpc("lagging", chain, () => 110n, () => 105n);
  const good = fakeRpc("good", chain, () => 110n, () => 110n);
  const pool = new RpcPool([lagging, good]);

  await pool.call("block 108", (r) => r.blockTxs(108n));
  assert.equal(pool.current, "good");
  const before = lagging.calls;
  await pool.call("block 109", (r) => r.blockTxs(109n));
  assert.equal(lagging.calls, before, "sticky: lagging endpoint not asked again");
});

test("RpcPool throws RpcPoolExhausted when no endpoint serves the block; reason is health-safe", async () => {
  const chain = fakeChain([]);
  const pool = new RpcPool([
    fakeRpc("a.example", chain, () => 110n, () => 100n),
    fakeRpc("b.example", chain, () => 110n, () => 100n),
  ]);
  await assert.rejects(pool.call("block 105", (r) => r.blockTxs(105n)), (err: unknown) => {
    assert.ok(err instanceof RpcPoolExhausted);
    assert.equal(err.reason, "a.example:block-not-found, b.example:block-not-found");
    assert.ok(!isHealthErrorLine(err.reason));
    return true;
  });
});

test("scanBlockRange stops before the first unservable block — never past it", async () => {
  const chain = fakeChain([101n, 104n]);
  const pool = new RpcPool([fakeRpc("a", chain, () => 110n, () => 103n), fakeRpc("b", chain, () => 110n, () => 102n)]);
  const res = await scanBlockRange(pool, 100n, 106n, visit, 0, noSleep);
  assert.equal(res.scanEnd, 103n);
  assert.equal(res.stalledAt, 104n);
  assert.deepEqual(res.events, [101n], "event in block 104 must wait for the next poll, not be dropped");
});

test("scanBlockRange is atomic per block: a missing receipt keeps that block for the next poll", async () => {
  const chain = fakeChain([101n, 102n]);
  const missing = new Set([102n]);
  const pool = new RpcPool([fakeRpc("a", chain, () => 110n, () => 110n, { receiptMissing: missing })]);
  const res = await scanBlockRange(pool, 100n, 105n, visit, 0, noSleep);
  assert.equal(res.scanEnd, 101n);
  assert.equal(res.stalledAt, 102n);
  assert.deepEqual(res.events, [101n]);
});

test("scanBlockRange with nothing servable returns scanEnd = fromBlock - 1 (cursor untouched)", async () => {
  const chain = fakeChain([]);
  const pool = new RpcPool([fakeRpc("a", chain, () => 110n, () => 99n)]);
  const res = await scanBlockRange(pool, 100n, 105n, visit, 0, noSleep);
  assert.equal(res.scanEnd, 99n);
  assert.deepEqual(res.events, []);
});

test("scanBlockRange rethrows non-RPC bugs instead of hiding them as a stall", async () => {
  const chain = fakeChain([100n]);
  const pool = new RpcPool([fakeRpc("a", chain, () => 110n, () => 110n)]);
  const boom: BlockVisitor<bigint> = async () => {
    throw new TypeError("decoder bug");
  };
  await assert.rejects(scanBlockRange(pool, 100n, 101n, boom, 0, noSleep), TypeError);
});

test("scanTarget stays lagBlocks behind the tip", async () => {
  const chain = fakeChain([]);
  const pool = new RpcPool([fakeRpc("a", chain, () => 1000n, () => 1000n)]);
  assert.equal(await scanTarget(pool, 5n), 995n);
  assert.equal(await scanTarget(pool, 5000n), 0n);
});

test("poll loop with flaky endpoints: every event delivered exactly once, cursor never skips", async () => {
  process.env.BLOZ_DATADIR ??= "/tmp/none";
  process.env.BSC_OPERATOR_PRIVATE_KEY ??= `0x${"11".repeat(32)}`;
  process.env.WBLOZ_ADDRESS ??= "0x0000000000000000000000000000000000000001";
  process.env.BRIDGE_ADDRESS ??= BRIDGE;
  const { openDb, getState, setState } = await import("../src/db.js");
  const { advanceLogCursor, resolveLogFromBlock } = await import("../src/bsc-log-cursor.js");
  const db = openDb(":memory:");
  setState(db, "last_unwrap_block", "999");

  const eventBlocks = [1001n, 1002n, 1007n, 1013n, 1020n, 1021n, 1030n];
  const chain = fakeChain(eventBlocks);
  let tip = 1000n;
  // Load-balanced backends: the tip is reported by the freshest one, others are 0-8 blocks behind.
  const lagA = [0n, 3n, 8n, 1n, 6n, 0n, 7n];
  const lagB = [5n, 0n, 2n, 8n, 0n, 4n, 1n];
  let round = 0;
  const pool = new RpcPool([
    fakeRpc("a", chain, () => tip, () => tip - lagA[round % lagA.length], {}),
    fakeRpc("b", chain, () => tip, () => tip - lagB[round % lagB.length], {}),
  ]);

  const seen: bigint[] = [];
  let lastCursor = 999n;
  for (round = 0; round < 60; round++) {
    tip += 1n;
    const { fromBlock, last } = await resolveLogFromBlock(db, "last_unwrap_block");
    const target = await scanTarget(pool, 2n);
    const res = await scanBlockRange(pool, fromBlock, target, visit, 0, noSleep);
    seen.push(...res.events);
    await advanceLogCursor(db, "last_unwrap_block", last ?? null, res.events, res.scanEnd);

    const cur = BigInt(getState(db, "last_unwrap_block")!);
    assert.ok(cur >= lastCursor, "cursor never moves backwards");
    assert.ok(cur <= res.scanEnd || cur === lastCursor, "cursor never ahead of what was scanned");
    lastCursor = cur;
  }
  assert.deepEqual(seen, eventBlocks, "all unwraps found once, in order");
  assert.ok(lastCursor >= 1030n);
  db.close();
});

test("StallGate: exponential backoff, throttled warnings, escalation, reset", () => {
  let now = 0;
  const lines: { level: string; msg: string }[] = [];
  const gate = new StallGate("unwrap", {
    baseDelayMs: 12_000,
    maxDelayMs: 120_000,
    escalateAfterMs: 600_000,
    now: () => now,
    log: {
      warn: (msg) => lines.push({ level: "warn", msg }),
      error: (msg) => lines.push({ level: "error", msg }),
      info: (msg) => lines.push({ level: "info", msg }),
    },
  });

  assert.equal(gate.ready(), true);
  gate.onStall(125060575n, "a:block-not-found", false);
  assert.equal(gate.ready(), false);
  now += 12_000;
  assert.equal(gate.ready(), true);

  // Backoff doubles up to the cap.
  const delays: number[] = [];
  for (let i = 0; i < 6; i++) {
    gate.onStall(125060575n, "a:block-not-found", false);
    let d = 0;
    while (!gate.ready()) {
      now += 1_000;
      d += 1_000;
    }
    delays.push(d);
  }
  assert.deepEqual(delays, [24_000, 48_000, 96_000, 120_000, 120_000, 120_000]);

  // Under 10 min: only throttled warnings, none counted by bridge-health.
  assert.ok(lines.every((l) => l.level === "warn"));
  assert.ok(lines.length <= 6, `at most ~1 warning per minute, got ${lines.length}`);
  assert.ok(lines.every((l) => !isHealthErrorLine(l.msg)), lines.map((l) => l.msg).join("\n"));
  assert.match(lines[0].msg, /unwrap scan paused at block 125060575/);

  // Past 10 min continuous stall: one error line (the cursor really is stuck).
  now += 600_000;
  gate.onStall(125060575n, "a:timeout", false);
  assert.equal(lines.at(-1)!.level, "error");
  assert.ok(isHealthErrorLine(lines.at(-1)!.msg));

  gate.onSuccess();
  assert.equal(gate.ready(), true);
  assert.equal(gate.stalled, false);
  assert.match(lines.at(-1)!.msg, /unwrap scan resumed after \d+s/);
});

test("StallGate: partial progress only waits one poll and restarts the stall clock", () => {
  let now = 0;
  const lines: string[] = [];
  const gate = new StallGate("claim", {
    baseDelayMs: 12_000,
    maxDelayMs: 120_000,
    escalateAfterMs: 600_000,
    now: () => now,
    log: { warn: (m) => lines.push(m), error: (m) => lines.push(`E:${m}`), info: () => {} },
  });
  for (let i = 0; i < 100; i++) {
    gate.onStall(BigInt(1000 + i), "a:block-not-found", true);
    now += 12_000;
    assert.equal(gate.ready(), true);
  }
  assert.ok(lines.every((l) => !l.startsWith("E:")), "progressing scans never escalate");
});

test("1 h of the old failure pattern produces far fewer than 30 health error lines per 10 min", () => {
  let now = 0;
  const lines: string[] = [];
  const gate = new StallGate("unwrap", {
    baseDelayMs: 12_000,
    maxDelayMs: 120_000,
    escalateAfterMs: 600_000,
    now: () => now,
    log: { warn: (m) => lines.push(m), error: (m) => lines.push(m), info: (m) => lines.push(m) },
  });
  // Every second poll hits a fresh-block miss (old behaviour: ~36 error lines / 10 min).
  for (let poll = 0; poll < 300; poll++, now += 12_000) {
    if (!gate.ready()) continue;
    if (poll % 2 === 0) gate.onStall(BigInt(poll), "a:block-not-found", true);
    else gate.onSuccess();
  }
  assert.equal(lines.filter(isHealthErrorLine).length, 0);
});

test("mergeRpcUrls keeps configured order, appends fallbacks, drops duplicates", () => {
  assert.deepEqual(
    mergeRpcUrls(
      ["https://bsc.publicnode.com", "https://bsc-dataseed1.binance.org/"],
      ["https://bsc-dataseed1.binance.org", "https://BSC.publicnode.com/", "https://bsc-dataseed.bnbchain.org", " "]
    ),
    ["https://bsc.publicnode.com", "https://bsc-dataseed1.binance.org/", "https://bsc-dataseed.bnbchain.org"]
  );
});

test("rpcLabel never leaks API keys in paths or queries", () => {
  assert.equal(rpcLabel("https://bsc-mainnet.example.com/v1/SECRETKEY?key=abc"), "bsc-mainnet.example.com");
  assert.equal(rpcLabel("not a url"), "rpc");
});
