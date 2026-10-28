#!/usr/bin/env python3
"""List open wrap/unwrap/orphan ops vs reserve surplus."""
import json
import sqlite3
import urllib.request
from decimal import Decimal

DB = "/opt/blockzero-bridge/data/bridge.db"
FEE_BPS = Decimal("390")

st = json.load(urllib.request.urlopen("http://127.0.0.1:3010/api/status"))
bal = Decimal(str(st["bridgeBloz"]))
supply = Decimal(str(st["wBLOZSupply"]))
surplus = bal - supply

db = sqlite3.connect(DB)
db.row_factory = sqlite3.Row

print("=== RESERVE ===")
print(f"bridgeBloz:   {bal}")
print(f"wBLOZSupply:  {supply}")
print(f"surplus:      {surplus}")
print(f"backed:       {st['backed']}")
print(f"claimable UI: {st.get('claimableAwaitingBloz')} ({st.get('claimableAwaitingCount')} wraps)")

print("\n=== OPEN WRAPS (money at risk) ===")
open_wrap_bloz = Decimal(0)
for r in db.execute(
    """
    SELECT id, status, bloz_amount, bloz_txid, deposit_address, mint_tx_hash
    FROM wrap_requests
    WHERE status IN ('claimable', 'refunding')
    ORDER BY claimable_at DESC NULLS LAST
    """
):
    row = dict(r)
    amt = Decimal(str(row["bloz_amount"] or 0))
    open_wrap_bloz += amt
    print(row)

for r in db.execute(
    """
    SELECT id, status, bloz_amount, bloz_txid
    FROM wrap_requests WHERE status='pending' AND bloz_amount IS NOT NULL
    """
):
    row = dict(r)
    amt = Decimal(str(row["bloz_amount"] or 0))
    open_wrap_bloz += amt
    print("(pending with deposit)", row)

pending_slots = db.execute(
    "SELECT COUNT(*) FROM wrap_requests WHERE status='pending' AND bloz_amount IS NULL"
).fetchone()[0]
print(f"pending empty slots (no BLOZ yet): {pending_slots}")
print(f"SUM open wrap BLOZ (claimable/refunding/pending+amt): {open_wrap_bloz}")

print("\n=== OPEN UNWRAPS (wBLOZ burned, BLOZ not paid yet) ===")
open_unwrap_payout = Decimal(0)
open_unwrap_burned = Decimal(0)
rows = db.execute(
    """
    SELECT unwrap_id, status, amount_units, payout_bloz, bsc_tx_hash, bloz_txid, bz1_address
    FROM unwrap_requests
    WHERE status NOT IN ('sent', 'failed', 'cancelled')
    ORDER BY created_at DESC
    """
).fetchall()
if not rows:
    print("(none)")
else:
    for r in rows:
        row = dict(r)
        payout = Decimal(str(row["payout_bloz"] or 0))
        burned = Decimal(str(row["amount_units"] or 0)) / Decimal(1e8)
        if payout == 0 and burned > 0:
            payout = burned - Decimal("0.00001")
        open_unwrap_payout += payout
        open_unwrap_burned += burned
        print(row)
print("\n=== ALL UNWRAPS (summary) ===")
for r in db.execute(
    "SELECT status, COUNT(*), COALESCE(SUM(amount_units),0) FROM unwrap_requests GROUP BY status"
):
    units = Decimal(str(r[2])) / Decimal(1e8)
    print(f"  {r[0]}: {r[1]} rows, {units} wBLOZ units")

print(f"SUM unpaid unwrap payout BLOZ: {open_unwrap_payout}")
print(f"SUM burned wBLOZ (open, off supply): {open_unwrap_burned}")

print("\n=== ORPHAN DEPOSITS ===")
orphan = Decimal(0)
for r in db.execute(
    """
    SELECT txid, amount, status, reason FROM orphan_deposits
    WHERE status IN ('pending', 'failed')
  """
):
    row = dict(r)
    orphan += Decimal(str(row["amount"] or 0))
    print(row)
print(f"SUM orphan BLOZ: {orphan}")

print("\n=== UNSWEPT FEES (still in bridge wallet) ===")
unswept = Decimal(0)
for r in db.execute(
    """
    SELECT bloz_amount, fee_bloz FROM wrap_requests
    WHERE status='minted' AND fee_txid IS NULL AND bloz_amount IS NOT NULL
    """
):
    gross = Decimal(str(r["bloz_amount"]))
    if r["fee_bloz"]:
        unswept += Decimal(str(r["fee_bloz"]))
    else:
        unswept += (gross * FEE_BPS / Decimal(10000)).quantize(Decimal("0.00000001"))
print(f"unswept fee dust: {unswept} BLOZ")

accounted = open_wrap_bloz + unswept + orphan
print("\n=== RECONCILIATION ===")
print(f"open wraps:        {open_wrap_bloz}")
print(f"unswept fees:      {unswept}")
print(f"orphans:           {orphan}")
print(f"accounted surplus: {accounted}")
print(f"actual surplus:    {surplus}")
print(f"unexplained:       {surplus - accounted}")
