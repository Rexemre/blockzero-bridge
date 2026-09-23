#!/usr/bin/env bash
# Offline regression test for bridge-health.py on the VPS: works on a COPY of bridge.db in /tmp,
# no Telegram (empty env), no restart (dry-run for the restart case). Never touches the live DB.
set -euo pipefail
T=$(mktemp -d /tmp/bh-test.XXXX); trap 'rm -rf "$T"' EXIT
H=/opt/blockzero-bridge/deploy/bridge-health.py
sqlite3 /opt/blockzero-bridge/data/bridge.db ".backup $T/bridge.db"
export BRIDGE_HEALTH_ENV=/dev/null TELEGRAM_BOT_TOKEN= STATE_DIR=$T/state BRIDGE_DB_PATH=$T/bridge.db
fail=0; expect() { if grep -q "$2" "$T/out"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }

# 1) Aug-2026 cursor bug: an unwrap burned on-chain is missing in the DB -> crit after the 2nd run
sqlite3 "$T/bridge.db" "DELETE FROM unwrap_requests WHERE unwrap_id=3"
python3 $H > /dev/null; python3 $H --dry-run > "$T/out"
expect "missing unwrap id detected" '"cursorbug:missing_unwraps"'

# 2) cursor jumped ahead of the chain head
sqlite3 "$T/bridge.db" "UPDATE relayer_state SET value=CAST(value AS INTEGER)+100000 WHERE key='last_unwrap_block'"
python3 $H --dry-run > "$T/out"; expect "cursor ahead of head" '"cursorbug:ahead"'

# 3) cursor stuck for 20 min while behind -> restart (dry-run only)
sqlite3 "$T/bridge.db" "UPDATE relayer_state SET value=CAST(value AS INTEGER)-100500 WHERE key='last_unwrap_block'"
python3 $H > /dev/null
python3 - "$T/state/state.json" <<'PY'
import json, sys, time
p = sys.argv[1]; s = json.load(open(p))
for c in s["cursors"].values(): c["changed_at"] = time.time() - 1200
json.dump(s, open(p, "w"))
PY
python3 $H --dry-run > "$T/out"; expect "stuck cursor triggers restart" 'wuerde blockzero-bridge neu starten'

# 4) stuck unwrap payout
sqlite3 "$T/bridge.db" "UPDATE unwrap_requests SET status='pending', created_at=created_at WHERE unwrap_id=42"
python3 $H --dry-run > "$T/out"; expect "open unwrap older than threshold" '"transfers:unwrap_open"'
exit $fail
