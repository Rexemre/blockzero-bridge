#!/usr/bin/env python3
import sqlite3
import subprocess

DB = "/opt/blockzero-bridge/data/bridge.db"
TIP = subprocess.check_output(
    [
        "node",
        "--input-type=module",
        "-e",
        "import { getLatestBlock } from '/opt/blockzero-bridge/relayer/dist/bsc.js'; console.log((await getLatestBlock()).toString());",
    ],
    text=True,
).strip()
db = sqlite3.connect(DB)
db.execute("INSERT OR REPLACE INTO relayer_state(key,value) VALUES(?,?)", ("last_claim_block", TIP))
db.execute("INSERT OR REPLACE INTO relayer_state(key,value) VALUES(?,?)", ("last_unwrap_block", TIP))
db.commit()
print("cursors set to", TIP)
for row in db.execute("SELECT key,value FROM relayer_state"):
    print(row)
