import type Database from "better-sqlite3";

import { config } from "./config.js";
import { getState, setState } from "./db.js";

/** First block to scan when no cursor exists (BSC mainnet bridge deploy ~2026-06-08). */
export function deployBlockFor(stateKey: "last_unwrap_block" | "last_claim_block"): bigint {
  const specific =
    stateKey === "last_unwrap_block"
      ? config.bsc.bridgeDeployBlock
      : config.bsc.wrapClaimDeployBlock;
  return specific ?? config.bsc.defaultDeployBlock;
}

export async function resolveLogFromBlock(
  db: Database.Database,
  stateKey: "last_unwrap_block" | "last_claim_block"
): Promise<{ fromBlock: bigint; last: string | null }> {
  const last = getState(db, stateKey);
  if (last) {
    const n = BigInt(last) + 1n;
    return { fromBlock: n >= 0n ? n : 0n, last };
  }

  const from = deployBlockFor(stateKey);
  console.warn(
    `${stateKey} unset — backfilling BSC logs from deploy block ${from} (not 5000-block lookback)`
  );
  return { fromBlock: from >= 0n ? from : 0n, last: null };
}

export async function advanceLogCursor(
  db: Database.Database,
  stateKey: "last_unwrap_block" | "last_claim_block",
  last: string | null,
  eventBlocks: bigint[],
  scanEnd: bigint
): Promise<void> {
  // Advance only to the end of the range that was actually scanned. Never
  // re-fetch the tip here: by now the chain has moved past scanEnd, and
  // jumping to the fresh tip skips the blocks in between unscanned — any
  // event there is lost permanently (this is how unwraps 3+4 went missing).
  let target = scanEnd;
  for (const b of eventBlocks) if (b > target) target = b;

  const cursor = last ? BigInt(last) : 0n;
  if (target > cursor) {
    setState(db, stateKey, target.toString());
  }
}
