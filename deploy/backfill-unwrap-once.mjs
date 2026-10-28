#!/usr/bin/env node
/** One-time: scan all UnwrapRequested events from deploy block and queue payouts. */
import { config } from "../relayer/dist/config.js";
import { fetchUnwrapEvents } from "../relayer/dist/bsc.js";
import { deployBlockFor } from "../relayer/dist/bsc-log-cursor.js";
import { openDb, upsertUnwrap } from "../relayer/dist/db.js";
import { pollUnwrapEvents } from "../relayer/dist/watcher.js";

const db = openDb(config.dbPath);

async function main() {
  const from = deployBlockFor("last_unwrap_block");
  console.log(`Backfilling unwrap events from block ${from}…`);
  const res = await fetchUnwrapEvents(from);
  const events = Array.isArray(res) ? res : res.events;
  console.log(`Found ${events.length} unwrap event(s)`);
  for (const ev of events) {
    upsertUnwrap(db, {
      unwrap_id: Number(ev.unwrapId),
      evm_address: ev.user,
      bz1_address: ev.bz1Address,
      amount_units: ev.amount.toString(),
    });
    console.log(`  id=${ev.unwrapId} ${ev.bz1Address} amount=${ev.amount}`);
  }
  if (events.length > 0) {
    const maxBlock = events.reduce((m, e) => (e.blockNumber > m ? e.blockNumber : m), 0n);
    db.prepare(
      "INSERT INTO relayer_state (key, value) VALUES ('last_unwrap_block', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    ).run(maxBlock.toString());
  }
  console.log("Processing payouts…");
  await pollUnwrapEvents(db);
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
