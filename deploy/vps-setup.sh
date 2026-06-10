#!/usr/bin/env bash
set -euo pipefail
ROOT=/opt/blockzero-bridge
WALLET_BIN=/opt/blockzero-wallet/bin
BRIDGE_DATA=/opt/bzero-bridge

echo "=== wallet-enabled bitcoind (rc9 release) ==="
mkdir -p "$WALLET_BIN" "$BRIDGE_DATA"
if [ ! -x "$WALLET_BIN/bitcoind" ]; then
  cd /tmp
  curl -fsSL -o bz-rc9.tar.gz https://github.com/Rexemre/blockzero-core/releases/download/v1.0.0-rc9/blockzero-v1.0.0-rc9-linux-x64.tar.gz
  rm -rf bz-rc9 && mkdir bz-rc9
  tar -xzf bz-rc9.tar.gz -C bz-rc9
  cp bz-rc9/blockzero-v1.0.0-rc9-linux-x64/bin/bitcoind bz-rc9/blockzero-v1.0.0-rc9-linux-x64/bin/bitcoin-cli "$WALLET_BIN/"
  chmod +x "$WALLET_BIN"/*
  echo "installed wallet binaries"
fi
"$WALLET_BIN/bitcoind" -version | head -1

echo "=== bridge node config ==="
if [ ! -f "$BRIDGE_DATA/bitcoin.conf" ]; then
  cat >"$BRIDGE_DATA/bitcoin.conf" <<'EOF'
server=1
# Full node (no prune) so refund sender resolution can walk deposit input txs.
txindex=1

[main]
listen=0
connect=127.0.0.1:8210
rpcbind=127.0.0.1
rpcallowip=127.0.0.1
rpcport=8334
EOF
fi

echo "=== bridge node systemd ==="
cat >/etc/systemd/system/blockzero-bridge-node.service <<EOF
[Unit]
Description=Block Zero bridge node (wallet-enabled, syncs from seed)
After=network-online.target blockzero-mainnet.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=$WALLET_BIN/bitcoind -datadir=$BRIDGE_DATA -printtoconsole
Restart=always
RestartSec=15

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable blockzero-bridge-node
systemctl restart blockzero-bridge-node
sleep 8

CLI="$WALLET_BIN/bitcoin-cli -datadir=$BRIDGE_DATA"
for i in $(seq 1 30); do
  if $CLI getblockcount >/dev/null 2>&1; then break; fi
  sleep 2
done
echo "bridge node height: $($CLI getblockcount 2>/dev/null || echo starting)"

echo "=== bridge wallet ==="
if ! $CLI listwallets 2>/dev/null | grep -q bridge; then
  $CLI createwallet bridge 2>/dev/null || $CLI loadwallet bridge
fi
echo "wallets: $($CLI listwallets)"

# Patch relayer .env paths
if [ -f "$ROOT/.env" ]; then
  sed -i "s|^BLOZ_CLI=.*|BLOZ_CLI=$WALLET_BIN/bitcoin-cli|" "$ROOT/.env"
  sed -i "s|^BLOZ_DATADIR=.*|BLOZ_DATADIR=$BRIDGE_DATA|" "$ROOT/.env"
fi

echo "=== relayer build ==="
cd "$ROOT/relayer"
npm install
npm run build

touch /var/log/caddy/blockzero-bridge.log
chown caddy:caddy /var/log/caddy/blockzero-bridge.log

cp "$ROOT/deploy/blockzero-bridge.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable blockzero-bridge

if grep -qE 'BSC_OPERATOR_PRIVATE_KEY=0x[0-9a-fA-F]{64}' "$ROOT/.env" 2>/dev/null \
   && grep -qE 'WBLOZ_ADDRESS=0x[0-9a-fA-F]{40}' "$ROOT/.env" 2>/dev/null; then
  systemctl restart blockzero-bridge
  sleep 2
  systemctl is-active blockzero-bridge
  curl -fsS http://127.0.0.1:3010/api/status | head -c 300
  echo ""
  echo "BRIDGE_RELAYER_OK"
else
  echo "SKIP relayer start: add BSC keys + contract addresses to $ROOT/.env then run deploy-and-sync.ps1"
fi

echo "VPS_SETUP_DONE"
