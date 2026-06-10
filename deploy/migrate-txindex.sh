#!/usr/bin/env bash
# One-time: enable txindex (drop prune) so refund sender resolution works.
# Safe while chain is small — re-syncs from seed.
set -euo pipefail
BRIDGE_DATA=/opt/bzero-bridge
WALLET_BIN=/opt/blockzero-wallet/bin

echo "Stopping bridge services…"
systemctl stop blockzero-bridge blockzero-bridge-node 2>/dev/null || true

echo "Updating bitcoin.conf…"
cat >"$BRIDGE_DATA/bitcoin.conf" <<'EOF'
server=1
txindex=1

[main]
listen=0
connect=127.0.0.1:8210
rpcbind=127.0.0.1
rpcallowip=127.0.0.1
rpcport=8334
EOF

echo "Removing pruned chain data (wallets preserved)…"
rm -rf "$BRIDGE_DATA/blocks" "$BRIDGE_DATA/chainstate" "$BRIDGE_DATA/indexes"

systemctl start blockzero-bridge-node
echo "Re-syncing from seed (height 0 → tip)…"
CLI="$WALLET_BIN/bitcoin-cli -datadir=$BRIDGE_DATA"
for i in $(seq 1 120); do
  if $CLI getblockcount >/dev/null 2>&1; then
    H=$($CLI getblockcount)
    echo "height $H"
    [ "$H" -gt 100 ] && break
  fi
  sleep 5
done

systemctl restart blockzero-bridge
echo "MIGRATE_TXINDEX_DONE"
