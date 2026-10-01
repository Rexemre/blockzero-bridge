import cors from "cors";
import express from "express";
import path from "node:path";
import fs from "node:fs";
import { config } from "./config.js";
import { openDb, cancelErroneousOrphanDeposits } from "./db.js";
import { registerApi } from "./api.js";
import { getLatestBlock } from "./bsc.js";
import { initBridgeWallet, startWatchers } from "./watcher.js";

async function initBscLogCursors(db: ReturnType<typeof openDb>): Promise<void> {
  const tip = (await getLatestBlock()).toString();
  const { getState, setState } = await import("./db.js");

  if (!getState(db, "last_claim_block")) {
    setState(db, "last_claim_block", tip);
    console.warn(`Initialized last_claim_block to BSC tip ${tip} (wrap claims already tracked in DB)`);
  }

  if (!getState(db, "last_unwrap_block")) {
    setState(db, "last_unwrap_block", tip);
    console.warn(
      `Initialized last_unwrap_block to BSC tip ${tip} — run deploy/backfill-unwrap-once.mjs if historical unwraps were missed`
    );
  }
}

async function main() {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

  const db = openDb(config.dbPath);
  const cancelled = cancelErroneousOrphanDeposits(db);
  if (cancelled > 0) {
    console.warn(`Cancelled ${cancelled} erroneous orphan deposit(s) (minted wrap txs)`);
  }

  await initBridgeWallet(db);
  await initBscLogCursors(db);

  const app = express();
  app.use(cors({ origin: true }));
  app.use(express.json());

  registerApi(app, db);

  if (fs.existsSync(config.webDir)) {
    app.use(express.static(config.webDir));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(config.webDir, "index.html"));
    });
  }

  startWatchers(db);

  app.listen(config.port, () => {
    console.log(`Block Zero bridge relayer on :${config.port}`);
    console.log(`wBLOZ ${config.bsc.wBLOZAddress} | bridge ${config.bsc.bridgeAddress}`);
  });
}

process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection (continuing):", reason);
});

process.on("uncaughtException", (err) => {
  console.error("uncaughtException (continuing):", err);
});

main().catch((err) => {
  console.error("fatal startup error:", err);
  process.exit(1);
});
