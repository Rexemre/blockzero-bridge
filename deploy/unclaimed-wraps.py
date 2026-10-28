#!/usr/bin/env python3
import datetime
import json
import sqlite3
import urllib.request

DB = "/opt/blockzero-bridge/data/bridge.db"
st = json.load(urllib.request.urlopen("http://127.0.0.1:3010/api/status"))
db = sqlite3.connect(DB)
db.row_factory = sqlite3.Row

print("API claimableAwaitingBloz:", st.get("claimableAwaitingBloz"))
print("API claimableAwaitingCount:", st.get("claimableAwaitingCount"))
print()

rows = db.execute(
    """
    SELECT id, evm_address, deposit_address, bloz_amount, bloz_txid,
           claimable_at, claim_expires_at, sender_bz1
    FROM wrap_requests WHERE status='claimable'
    ORDER BY claimable_at DESC
    """
).fetchall()

total = 0.0
for r in rows:
    d = dict(r)
    amt = float(d["bloz_amount"] or 0)
    total += amt
    print(f"  {amt:.8f} BLOZ")
    print(f"    deposit: {d['deposit_address']}")
    print(f"    from:    {d.get('sender_bz1') or '?'}")
    print(f"    wallet:  {d['evm_address']}")
    print(f"    bloz tx: {d['bloz_txid']}")
    for label, ts in [("claimable", d.get("claimable_at")), ("expires", d.get("claim_expires_at"))]:
        if ts:
            t = ts / 1000 if ts > 1e12 else ts
            print(f"    {label}: {datetime.datetime.utcfromtimestamp(t).strftime('%Y-%m-%d %H:%M UTC')}")

print(f"\nTOTAL unclaimed: {total:.8f} BLOZ ({len(rows)} wrap(s))")
