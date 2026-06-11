import cors from "cors";
import express from "express";
import path from "node:path";
import fs from "node:fs";
import { config } from "./config.js";
import { openDb, cancelErroneousOrphanDeposits } from "./db.js";
import { registerApi } from "./api.js";
import { initBridgeWallet, startWatchers } from "./watcher.js";

async function main() {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

  const db = openDb(config.dbPath);
  const cancelled = cancelErroneousOrphanDeposits(db);
  if (cancelled > 0) {
    console.warn(`Cancelled ${cancelled} erroneous orphan deposit(s) (minted wrap txs)`);
  }
  await initBridgeWallet(db);

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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
