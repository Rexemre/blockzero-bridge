import cors from "cors";
import express from "express";
import path from "node:path";
import fs from "node:fs";
import { config } from "./config.js";
import { openDb, cancelErroneousOrphanDeposits, seedDebtGroup, listDebtGroups } from "./db.js";
import { registerApi } from "./api.js";
import { initBridgeWallet, startWatchers } from "./watcher.js";

async function main() {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

  const db = openDb(config.dbPath);
  const cancelled = cancelErroneousOrphanDeposits(db);
  if (cancelled > 0) {
    console.warn(`Cancelled ${cancelled} erroneous orphan deposit(s) (minted wrap txs)`);
  }

  // June 2026 refund-bug recipients: they received native BLOZ refunds for
  // already-minted wraps and still hold the wBLOZ. Future wraps/unwraps/refunds
  // by these addresses are netted against this debt until fully recovered.
  seedDebtGroup(
    db,
    "refund-bug-2026-06",
    2184.99994,
    "Erroneous orphan refunds for minted wraps (relayer restart bug, June 2026)",
    [
      "bz1q276juzwk4qs99nmjq5tcxmqqv7e2p4xgmeqtm4",
      "bz1qcyg36zx3dp30jgu82ae5zvlzxmc8d3yfg7fr0g",
      "bz1qn68v9mstuq3hrw55q63tj2swlvlx9aak3uvcnr",
      "0xe6f35f0b021bb7a946e8d46be4d06769bb2bd7c9",
    ]
  );
  for (const g of listDebtGroups(db)) {
    const open = Math.round((g.debt_bloz - g.recovered_bloz) * 1e8) / 1e8;
    if (open > 0) console.warn(`Debt group ${g.id}: ${open} BLOZ outstanding (${g.reason})`);
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
