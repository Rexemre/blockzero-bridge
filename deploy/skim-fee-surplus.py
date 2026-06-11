#!/usr/bin/env python3
"""One-time: send bridge BLOZ surplus (balance minus wBLOZ supply) to BRIDGE_FEE_BZ1_ADDRESS."""
import json
import subprocess
import sys
import urllib.request

CLI = ["/opt/blockzero-wallet/bin/bitcoin-cli", "-datadir=/opt/bzero-bridge", "-rpcwallet=bridge"]
FEE = "bz1qcunyqhyv0veuf86u0xhkpf7kslpuuy3zvdfymn"
STATUS_URL = "http://127.0.0.1:3010/api/status"


def run_cli(args: list[str]) -> str:
    return subprocess.check_output(CLI + args, text=True).strip()


def main() -> int:
    bal = float(run_cli(["getbalance"]))
    status = json.load(urllib.request.urlopen(STATUS_URL))
    supply = float(status["wBLOZSupply"])
    surplus = round(bal - supply, 8)

    print(f"Bridge balance: {bal:.8f} BLOZ")
    print(f"wBLOZ supply:   {supply:.8f} BLOZ")
    print(f"Surplus to skim: {surplus:.8f} BLOZ")
    print(f"Fee address:    {FEE}")

    if surplus <= 0.00000001:
        print("No surplus to skim.")
        return 0

    txid = run_cli(
        [
            "-named",
            "sendtoaddress",
            f"address={FEE}",
            f"amount={surplus:.8f}",
            "fee_rate=1",
            "replaceable=true",
        ]
    )
    print(f"Sent {surplus:.8f} BLOZ -> {FEE}")
    print(f"txid: {txid}")

    bal2 = float(run_cli(["getbalance"]))
    status2 = json.load(urllib.request.urlopen(STATUS_URL))
    print(
        f"After: bridge={bal2:.8f} wBLOZ={status2['wBLOZSupply']} backed={status2['backed']}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
