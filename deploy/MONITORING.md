# Bridge monitoring (bridge-health)

`deploy/bridge-health.py` runs on the relayer host every 5 minutes (`bridge-health.timer` → `bridge-health.service`,
Python stdlib only, reads the DB read-only). It never sends funds and never touches cursors or DB rows.

## What it checks

| Check | Alarm | Auto action |
|---|---|---|
| `blockzero-bridge` / `blockzero-bridge-node` active, `/api/status` answers | crit | restart relayer |
| BSC log cursors (`last_unwrap_block`, `last_claim_block`) lag vs chain head | warn > 800, crit > 4000 blocks | – |
| Cursor unchanged ≥ 15 min while behind (and BSC RPC reachable) | crit | restart relayer |
| **Cursor-bug guard (Aug 2026)**: on-chain `nextUnwrapId()` vs unwrap ids in DB (no gaps, confirmed over 2 runs) | crit | – (backfill with `backfill-unwrap-range.mjs`) |
| Cursor ahead of chain head / cursor moving backwards | crit / warn | – |
| Wrap still `claimable` although `claimed(wrapId)` is true on-chain (missed claim event → refund risk) | crit | – |
| Unwrap `pending`/`sending` > 30 min (crit > 3 h), new `failed` unwraps | warn / crit | – |
| Orphan refunds open > 90 min, wraps stuck in `refunding` | warn | – |
| Reserve: bridge wallet BLOZ < wBLOZ supply | warn (crit ≥ 100 BLOZ) | – |
| BLOZ node: RPC, peers, age of best block > 90 min | crit / warn | – |
| Relayer journal: > 30 error lines in 10 min | warn | – |
| Disk ≥ 85 / 95 %, MemAvailable < 400 MB | warn / crit | – |

Restarts happen at most once per 30 min; if a restart did not help, the next run raises
`restart:cooldown` (crit) instead of restart-looping.

## Outputs

- `/var/lib/bridge-health/status.json` — latest result (overall, open alarms, metrics). Polled by the operator's
  assistant over SSH.
- `/var/lib/bridge-health/events.jsonl` — alarm / escalated / resolved / restart events.
- Telegram (optional): new alarm, escalation, reminder every 6 h while open, resolved, auto-restart.

## Config

`/etc/bridge-health.env` (chmod 600, template `bridge-health.env.example`): Telegram token/chat, thresholds, and
known/accepted issues (`ACK_FAILED_UNWRAPS`, `ACK_RESERVE_DEFICIT_BLOZ`) so they don't alarm forever — anything
worse than the acknowledged state still alarms.

## Install / update

```sh
scp deploy/bridge-health.py deploy/bridge-health.service deploy/bridge-health.timer HOST:/opt/blockzero-bridge/deploy/
ssh HOST 'cp /opt/blockzero-bridge/deploy/bridge-health.{service,timer} /etc/systemd/system/ &&
  systemctl daemon-reload && systemctl enable --now bridge-health.timer'
ssh HOST 'python3 /opt/blockzero-bridge/deploy/bridge-health.py --dry-run'   # prints status, no side effects
ssh HOST 'bash /opt/blockzero-bridge/deploy/test-bridge-health.sh'           # regression tests on a DB copy
```
