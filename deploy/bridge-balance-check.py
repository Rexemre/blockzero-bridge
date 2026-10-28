#!/usr/bin/env python3
"""Quick bridge reserve / wrap in-flight diagnostic."""
import json
import sqlite3
import urllib.request
from decimal import Decimal

DB = "/opt/blockzero-bridge/data/bridge.db"
st = json.load(urllib.request.urlopen("http://127.0.0.1:3010/api/status"))
bal = Decimal(str(st["bridgeBloz"]))
supply = Decimal(str(st["wBLOZSupply"]))

print("=== STATUS ===")
print(f"bridgeBloz   = {bal}")
print(f"wBLOZSupply  = {supply}")
print(f"surplus      = {bal - supply}")
print(f"backed       = {st['backed']}")
print(f"publicReserve= {st.get('publicReserveBz1')}")
print()

db = sqlite3.connect(DB)
db.row_factory = sqlite3.Row

print("=== IN-FLIGHT WRAPS ===")
for r in db.execute(
    """
    SELECT id, status, bloz_amount, fee_bloz, fee_txid, bloz_txid, debt_withheld_bloz
    FROM wrap_requests
    WHERE status NOT IN ('minted', 'expired', 'cancelled')
    ORDER BY id DESC LIMIT 20
    """
):
    print(dict(r))

print()
print("=== RECENT MINTED ===")
for r in db.execute(
    """
    SELECT id, bloz_amount, fee_bloz, fee_txid, debt_withheld_bloz
    FROM wrap_requests WHERE status='minted' ORDER BY id DESC LIMIT 10
    """
):
    print(dict(r))

pf = db.execute(
    "SELECT COUNT(*), COALESCE(SUM(bloz_amount),0) FROM wrap_requests WHERE status='minted' AND fee_txid IS NULL"
).fetchone()
print()
print(f"minted, fee not swept yet: {pf[0]} wraps, gross {pf[1]} BLOZ")

cl = db.execute(
    "SELECT COUNT(*), COALESCE(SUM(bloz_amount),0) FROM wrap_requests WHERE status='claimable'"
).fetchone()
print(f"claimable (BLOZ in, wBLOZ not minted): {cl[0]} wraps, {cl[1]} BLOZ")

pending = db.execute("SELECT COUNT(*) FROM wrap_requests WHERE status='pending'").fetchone()[0]
print(f"pending (awaiting deposit): {pending}")

# Fee math check on recent minted
print()
print("=== FEE MATH (last 5 minted) ===")
BPS = Decimal("0") / Decimal("10000")
for r in db.execute(
    "SELECT id, bloz_amount, fee_bloz FROM wrap_requests WHERE status='minted' AND bloz_amount IS NOT NULL ORDER BY id DESC LIMIT 5"
):
    gross = Decimal(str(r["bloz_amount"]))
    expected_net = (gross * (1 - BPS)).quantize(Decimal("0.00000001"))
    expected_fee = gross - expected_net
    fee = Decimal(str(r["fee_bloz"] or 0)) if r["fee_bloz"] else None
    print(
        f"wrap {r['id']}: gross={gross} expected_mint={expected_net} "
        f"fee_swept={fee} expected_fee={expected_fee}"
    )

print()
print("=== PUBLIC RESERVE ADDRESS BALANCE ===")
import subprocess
pub = st.get("publicReserveBz1")
if pub:
    out = subprocess.check_output([
        "/opt/blockzero-bridge/bin/bitcoin-cli",
        "-datadir=/opt/blockzero-bridge/data/bloz",
        "-rpcwallet=bridge",
        "getreceivedbyaddress", pub, "0"
    ], text=True).strip()
    print(f"getreceivedbyaddress {pub} = {out} (received total, not spendable balance)")
