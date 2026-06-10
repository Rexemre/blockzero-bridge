#!/usr/bin/env bash
# Stufe 1: BscScan contract verification (no redeploy, wBLOZ address unchanged).
set -euo pipefail
ROOT=/opt/blockzero-bridge
cd "$ROOT"

if ! grep -qE '^BSCSCAN_API_KEY=.' "$ROOT/.env" 2>/dev/null; then
  echo "BLOCKER: Add BSCSCAN_API_KEY to $ROOT/.env"
  echo "Get one free: https://bscscan.com/myapikey (account → API Keys → Add)"
  echo "Then: echo 'BSCSCAN_API_KEY=YOUR_KEY' >> $ROOT/.env"
  exit 1
fi

if [ ! -f "$ROOT/deployments.json" ]; then
  echo "BLOCKER: missing deployments.json"
  exit 1
fi

set -a
# shellcheck disable=SC1091
source "$ROOT/.env"
set +a

echo "=== Compiling (must match deployed bytecode) ==="
npm run compile

echo "=== Submitting to BscScan ==="
npm run verify:bsc

echo ""
echo "Check:"
echo "  https://bscscan.com/address/$(jq -r .wBLOZ deployments.json)#code"
echo "  https://bscscan.com/address/$(jq -r .bridge deployments.json)#code"
echo "  https://bscscan.com/address/$(jq -r .wrapClaim deployments.json)#code"
echo "STEP1_VERIFY_DONE"
