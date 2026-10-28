#!/usr/bin/env python3
"""Set BSC_RPC_URL to public endpoints that tolerate getLogs better."""
import pathlib

ENV = pathlib.Path("/opt/blockzero-bridge/.env")
RPC = (
    "https://bsc.publicnode.com,"
    "https://bsc-dataseed1.binance.org/,"
    "https://bsc-dataseed2.binance.org/"
)
text = ENV.read_text()
lines = [ln for ln in text.splitlines() if not ln.startswith("BSC_RPC_URL=")]
lines.append(f"BSC_RPC_URL={RPC}")
ENV.write_text("\n".join(lines) + "\n")
print("Updated BSC_RPC_URL")
