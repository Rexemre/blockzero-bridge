#!/usr/bin/env node
/**
 * Refund a burned unwrap as wBLOZ to the original BSC sender (unwrap whose bz1
 * target was invalid, so no BLOZ could ever be paid out).
 *
 * wBLOZ is burned inside BlozBridge.unwrap(), so there is no push path back —
 * the operator key is DEFAULT_ADMIN on wBLOZ but holds no MINTER_ROLE. This
 * script grants MINTER_ROLE to the operator, mints exactly the burned amount to
 * the unwrap sender and renounces the role again, so the hot key on the VPS
 * can not mint afterwards. The native BLOZ that backed the burned wBLOZ never
 * left the reserve, so the re-minted wBLOZ is backed by it.
 *
 * Safety: verifies the UnwrapRequested event on-chain (id, sender, amount) and
 * the DB row (status failed / refund_queued, no bloz_txid) before anything is
 * signed. Dry run by default (simulates every call); CONFIRM=1 broadcasts.
 *
 * Usage (on the VPS, from /opt/blockzero-bridge/relayer so bare imports resolve):
 *   BRIDGE_DB_PATH=/opt/blockzero-bridge/data/bridge.db UNWRAP_ID=24 BURN_BLOCK=121314611 \
 *     node ../deploy/refund-unwrap-mint.mjs            # dry run
 *   ... CONFIRM=1 node ../deploy/refund-unwrap-mint.mjs # broadcast
 */
import { createRequire } from "node:module";
import { config } from "../relayer/dist/config.js";
import { publicClient } from "../relayer/dist/bsc.js";
import { openDb } from "../relayer/dist/db.js";

const require = createRequire(new URL("../relayer/package.json", import.meta.url));
const viem = await import(require.resolve("viem"));
const { privateKeyToAccount } = await import(require.resolve("viem/accounts"));
const { createWalletClient, http, parseAbi, keccak256, toHex, decodeEventLog } = viem;

const UNWRAP_ID = BigInt(process.env.UNWRAP_ID ?? "");
const BURN_BLOCK = BigInt(process.env.BURN_BLOCK ?? "");
const CONFIRM = process.env.CONFIRM === "1";

const wAbi = parseAbi([
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function grantRole(bytes32 role, address account)",
  "function renounceRole(bytes32 role, address callerConfirmation)",
  "function mint(address to, uint256 amount)",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);
const bridgeAbi = parseAbi([
  "event UnwrapRequested(uint256 indexed unwrapId, address indexed user, uint256 amount, string bz1Address)",
]);
const MINTER = keccak256(toHex("MINTER_ROLE"));
const ADMIN = "0x0000000000000000000000000000000000000000000000000000000000000000";

const db = openDb(config.dbPath);
const row = db.prepare("SELECT * FROM unwrap_requests WHERE unwrap_id=?").get(Number(UNWRAP_ID));
if (!row) throw new Error(`unwrap ${UNWRAP_ID} not in DB`);
if (!["failed", "refund_queued"].includes(row.status) || row.bloz_txid) {
  throw new Error(`unwrap ${UNWRAP_ID} status=${row.status} bloz_txid=${row.bloz_txid} — refusing`);
}

// Find the burn on-chain: scan the given block for the UnwrapRequested event.
const block = await publicClient.getBlock({ blockNumber: BURN_BLOCK, includeTransactions: true });
let ev = null;
let burnTx = null;
for (const tx of block.transactions) {
  if (tx.to?.toLowerCase() !== config.bsc.bridgeAddress.toLowerCase()) continue;
  const rc = await publicClient.getTransactionReceipt({ hash: tx.hash });
  for (const log of rc.logs) {
    if (log.address.toLowerCase() !== config.bsc.bridgeAddress.toLowerCase()) continue;
    try {
      const d = decodeEventLog({ abi: bridgeAbi, data: log.data, topics: log.topics });
      if (d.args.unwrapId === UNWRAP_ID) { ev = d.args; burnTx = tx.hash; }
    } catch { /* other event */ }
  }
}
if (!ev) throw new Error(`UnwrapRequested ${UNWRAP_ID} not found in block ${BURN_BLOCK}`);
if (ev.user.toLowerCase() !== row.evm_address.toLowerCase()) throw new Error("sender mismatch DB vs chain");
if (ev.amount !== BigInt(row.amount_units)) throw new Error("amount mismatch DB vs chain");
if (ev.bz1Address !== row.bz1_address) throw new Error("bz1 mismatch DB vs chain");

const account = privateKeyToAccount(config.bsc.operatorKey);
const op = account.address;
const to = ev.user;
const amount = ev.amount;
const w = config.bsc.wBLOZAddress;
const read = (functionName, args = []) => publicClient.readContract({ address: w, abi: wAbi, functionName, args });

console.log(JSON.stringify({
  unwrapId: String(UNWRAP_ID), burnTx, to, amountUnits: String(amount), bz1: ev.bz1Address,
  operator: op, isAdmin: await read("hasRole", [ADMIN, op]), isMinter: await read("hasRole", [MINTER, op]),
  operatorBnb: String(await publicClient.getBalance({ address: op })),
  supplyBefore: String(await read("totalSupply")), userBalBefore: String(await read("balanceOf", [to])),
  mode: CONFIRM ? "BROADCAST" : "DRY RUN",
}, null, 1));

const wallet = createWalletClient({ account, chain: publicClient.chain, transport: http(config.bsc.rpcUrls[0]) });
const hashes = {};

async function step(name, functionName, args) {
  // simulate first; mint can only be simulated once the role is really granted
  if (!CONFIRM && functionName === "mint" && !(await read("hasRole", [MINTER, op]))) {
    console.log(`${name}: simulation skipped (needs MINTER_ROLE first)`);
    return;
  }
  const { request } = await publicClient.simulateContract({ account, address: w, abi: wAbi, functionName, args });
  const gas = await publicClient.estimateContractGas({ account, address: w, abi: wAbi, functionName, args });
  console.log(`${name}: simulation ok, gas ${gas}`);
  if (!CONFIRM) return;
  const hash = await wallet.writeContract(request);
  const rc = await publicClient.waitForTransactionReceipt({ hash, confirmations: 2 });
  if (rc.status !== "success") throw new Error(`${name} reverted: ${hash}`);
  hashes[name] = hash;
  console.log(`${name}: ${hash}`);
}

if (!(await read("hasRole", [MINTER, op]))) await step("grantRole", "grantRole", [MINTER, op]);
await step("mint", "mint", [to, amount]);
if (CONFIRM || (await read("hasRole", [MINTER, op]))) await step("renounceRole", "renounceRole", [MINTER, op]);

if (CONFIRM) {
  for (const [col, def] of [["refund_evm_txid", "TEXT"], ["refunded_at", "INTEGER"]]) {
    try { db.prepare(`SELECT ${col} FROM unwrap_requests LIMIT 1`).get(); }
    catch { db.exec(`ALTER TABLE unwrap_requests ADD COLUMN ${col} ${def}`); }
  }
  db.prepare(
    `UPDATE unwrap_requests SET status='refunded', refund_evm_txid=?, refunded_at=? WHERE unwrap_id=? AND bloz_txid IS NULL`
  ).run(hashes.mint, Date.now(), Number(UNWRAP_ID));
  console.log(JSON.stringify({
    hashes, isMinterAfter: await read("hasRole", [MINTER, op]),
    supplyAfter: String(await read("totalSupply")), userBalAfter: String(await read("balanceOf", [to])),
  }, null, 1));
}
