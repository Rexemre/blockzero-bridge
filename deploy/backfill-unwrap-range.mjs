#!/usr/bin/env node
/**
 * Targeted backfill: scan a bounded BSC block range for UnwrapRequested events
 * and queue any that are missing from the DB as pending. Does NOT touch the
 * last_unwrap_block cursor — the running relayer picks the rows up on its next
 * poll and pays out.
 *
 * Uses getBlock + receipts (like live polling) — public dataseeds refuse
 * eth_getLogs, so the getLogs path is not an option here. Only imports from
 * relayer/dist (deploy/ has no node_modules, bare imports don't resolve).
 *
 * Usage: BRIDGE_DB_PATH=/opt/blockzero-bridge/data/bridge.db \
 *        FROM=116413900 TO=116415200 node backfill-unwrap-range.mjs
 */
import { config } from "../relayer/dist/config.js";
import { publicClient } from "../relayer/dist/bsc.js";
import { openDb, upsertUnwrap } from "../relayer/dist/db.js";

const FROM = BigInt(process.env.FROM ?? "116413900");
const TO = BigInt(process.env.TO ?? "116415200");

// keccak256("UnwrapRequested(uint256,address,uint256,string)")
const UNWRAP_TOPIC = "0x701bb3db6c13ee3b1c0bcba15e84a4001cec946ad1334cf2b0c919571676d64f";

/** Decode non-indexed (uint256 amount, string bz1Address) from log data. */
function decodeUnwrapData(dataHex) {
  const d = dataHex.replace(/^0x/, "");
  const amount = BigInt("0x" + d.slice(0, 64));
  const offset = Number(BigInt("0x" + d.slice(64, 128))) * 2;
  const len = Number(BigInt("0x" + d.slice(offset, offset + 64))) * 2;
  const bz1Address = Buffer.from(d.slice(offset + 64, offset + 64 + len), "hex").toString("utf8");
  return { amount, bz1Address };
}

const next = await publicClient.readContract({
  address: config.bsc.bridgeAddress,
  abi: [
    {
      name: "nextUnwrapId",
      type: "function",
      stateMutability: "view",
      inputs: [],
      outputs: [{ type: "uint256" }],
    },
  ],
  functionName: "nextUnwrapId",
});
console.log("on-chain nextUnwrapId =", next.toString());

const db = openDb(config.dbPath);
console.log("db:", config.dbPath);
const have = new Set(
  db.prepare("SELECT unwrap_id FROM unwrap_requests").all().map((r) => r.unwrap_id)
);
console.log("ids in DB:", [...have].sort((a, b) => a - b).join(",") || "none");

const missing = [];
for (let i = 0n; i < next; i++) if (!have.has(Number(i))) missing.push(Number(i));
console.log("missing ids:", missing.join(",") || "none");
if (!missing.length) process.exit(0);

console.log(`scanning blocks ${FROM}..${TO} for unwrap txs…`);
const bridge = config.bsc.bridgeAddress.toLowerCase();
let queued = 0;
for (let b = FROM; b <= TO; b++) {
  const block = await publicClient.getBlock({ blockNumber: b, includeTransactions: true });
  for (const tx of block.transactions) {
    if (typeof tx === "string" || tx.to?.toLowerCase() !== bridge) continue;
    const receipt = await publicClient.getTransactionReceipt({ hash: tx.hash });
    if (receipt.status !== "success") continue;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== bridge) continue;
      if (log.topics[0]?.toLowerCase() !== UNWRAP_TOPIC) continue;
      const id = Number(BigInt(log.topics[1]));
      const user = "0x" + log.topics[2].slice(26);
      const { amount, bz1Address } = decodeUnwrapData(log.data);
      const state = have.has(id) ? "already in DB" : "QUEUED as pending";
      console.log(
        `  id=${id} user=${user} amount=${amount} -> ${bz1Address} (block ${b}, tx ${tx.hash}) [${state}]`
      );
      if (!have.has(id)) {
        upsertUnwrap(db, {
          unwrap_id: id,
          evm_address: user,
          bz1_address: bz1Address,
          amount_units: amount.toString(),
        });
        have.add(id);
        queued++;
      }
    }
  }
  if (b % 200n === 0n) console.log(`  …at block ${b}`);
}
console.log(`done — queued ${queued} unwrap(s)`);

const still = missing.filter((id) => !have.has(id));
if (still.length) console.log("STILL MISSING (widen FROM/TO):", still.join(","));
