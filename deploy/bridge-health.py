#!/usr/bin/env python3
"""BLOZ bridge health check — runs every 5 min via bridge-health.timer (stdlib only).

Checks (severity crit > warn > ok):
  service      blockzero-bridge + blockzero-bridge-node active, /api/status answers
  cursor       BSC log cursors (last_unwrap_block / last_claim_block) lag vs chain head and keep moving
  cursorbug    regression guard for the Aug-2026 cursor-skip bug: on-chain nextUnwrapId() must match the
               unwrap ids in the DB (no gaps), cursor never ahead of the chain head, and no wrap still
               'claimable' although claimed(wrapId) is already true on-chain
  transfers    no unwrap/refund/orphan stuck open longer than the thresholds, no new 'failed' rows
  reserve      bridge BLOZ wallet >= wBLOZ supply (backed), BLOZ node synced and peered
  logs         error rate in the relayer journal
  system       disk / RAM

Actions: restarts blockzero-bridge only when that is safe (service down, API dead, or cursor stuck while
the BSC RPC itself works) and at most once per RESTART_COOLDOWN. It never sends funds, never touches
cursors or DB rows. Everything else becomes an alarm.

Outputs (STATE_DIR, default /var/lib/bridge-health):
  status.json   latest full result — Jarvis (tools/bridgecheck.py) reads this over SSH
  events.jsonl  alarm opened / escalated / resolved / restart events (append-only)
  state.json    internal memory between runs (previous cursors, open alarms, restart times)
Telegram: optional, TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID from /etc/bridge-health.env — sent on new alarm,
escalation, every REMIND_HOURS while an alarm persists, and when it is resolved.

Known/accepted problems can be silenced in /etc/bridge-health.env, e.g. ACK_FAILED_UNWRAPS=24 (comma list),
ACK_REFUND_QUEUED_UNWRAPS=43 (invalid bz1 target, wBLOZ refund to the BSC sender pending).

  python3 bridge-health.py            # normal run (timer)
  python3 bridge-health.py --dry-run  # no restart, no Telegram, no state write; prints status
"""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


def load_env(path: str) -> dict:
    out = {}
    try:
        for line in Path(path).read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return out


BRIDGE_ENV = load_env("/opt/blockzero-bridge/.env")
CFG = {**BRIDGE_ENV, **load_env(os.environ.get("BRIDGE_HEALTH_ENV", "/etc/bridge-health.env")), **os.environ}


def cfg(name: str, default):
    v = CFG.get(name)
    if v is None or v == "":
        return default
    return type(default)(v) if not isinstance(default, str) else v


STATE_DIR = Path(cfg("STATE_DIR", "/var/lib/bridge-health"))
DB_PATH = cfg("BRIDGE_DB_PATH", "/opt/blockzero-bridge/data/bridge.db")
API = f"http://127.0.0.1:{cfg('BRIDGE_PORT', 3010)}/api/status"
SERVICE = "blockzero-bridge"
NODE_SERVICE = "blockzero-bridge-node"
BLOZ_CLI = [cfg("BLOZ_CLI", "/opt/blockzero-wallet/bin/bitcoin-cli"), f"-datadir={cfg('BLOZ_DATADIR', '/opt/bzero-bridge')}"]
RPCS = [u.strip() for u in cfg("BSC_RPC_URL", "https://bsc.publicnode.com").split(",") if u.strip()]
BRIDGE_ADDR = cfg("BRIDGE_ADDRESS", "0xA7f3bEe62b20F041358062d890eF60b4E12464b7")
CLAIM_ADDR = cfg("WRAP_CLAIM_ADDRESS", "")

SEL_NEXT_UNWRAP_ID = "0x829d94ae"   # nextUnwrapId()
SEL_CLAIMED = "0xcc3c0f06"          # claimed(bytes32)

# Thresholds (override in /etc/bridge-health.env). BSC makes ~1.3 blocks/s (0.75 s block time).
LAG_WARN = cfg("LAG_WARN_BLOCKS", 800)          # ~10 min behind
LAG_CRIT = cfg("LAG_CRIT_BLOCKS", 4000)         # ~50 min behind
STUCK_MIN = cfg("CURSOR_STUCK_MIN", 15)         # cursor unchanged while head moves -> restart
UNWRAP_OPEN_MIN = cfg("UNWRAP_OPEN_MIN", 30)    # pending/sending unwrap older than this
REFUND_OPEN_MIN = cfg("REFUND_OPEN_MIN", 90)    # orphan/wrap refund stuck
RESERVE_TOL = cfg("RESERVE_TOLERANCE_BLOZ", 0.001)
BLOZ_TIP_AGE_WARN_MIN = cfg("BLOZ_TIP_AGE_WARN_MIN", 90)
ERR_WARN_PER_10MIN = cfg("LOG_ERRORS_WARN", 30)
DISK_WARN, DISK_CRIT = cfg("DISK_WARN_PCT", 85), cfg("DISK_CRIT_PCT", 95)
MEM_WARN_MB = cfg("MEM_AVAILABLE_WARN_MB", 400)
RESTART_COOLDOWN_MIN = cfg("RESTART_COOLDOWN_MIN", 30)
REMIND_HOURS = cfg("REMIND_HOURS", 6)
ACK_FAILED_UNWRAPS = {int(x) for x in cfg("ACK_FAILED_UNWRAPS", "").split(",") if x.strip().isdigit()}
ACK_REFUND_QUEUED = {int(x) for x in cfg("ACK_REFUND_QUEUED_UNWRAPS", "").split(",") if x.strip().isdigit()}
ACK_RESERVE_DEFICIT = cfg("ACK_RESERVE_DEFICIT_BLOZ", 0.0)   # accept a known deficit up to this amount

DRY = "--dry-run" in sys.argv
NOW = time.time()


def iso(ts: float | None = None) -> str:
    return datetime.fromtimestamp(ts or NOW, timezone.utc).isoformat(timespec="seconds")


def sh(cmd: list[str], timeout: int = 20) -> tuple[int, str]:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except Exception as e:  # noqa: BLE001
        return 99, str(e)


def rpc(method: str, params: list):
    last = None
    for url in RPCS:
        try:
            body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
            req = urllib.request.Request(url, body, {"content-type": "application/json", "user-agent": "bridge-health"})
            res = json.load(urllib.request.urlopen(req, timeout=10))
            if "result" in res:
                return res["result"]
            last = res.get("error")
        except Exception as e:  # noqa: BLE001
            last = e
    raise RuntimeError(f"all BSC RPCs failed: {last}")


def eth_call(to: str, data: str) -> str:
    return rpc("eth_call", [{"to": to, "data": data}, "latest"])


class Result:
    def __init__(self):
        self.checks: dict[str, dict] = {}
        self.metrics: dict = {}
        self.actions: list[str] = []

    def add(self, key: str, severity: str, msg: str, restartable: bool = False):
        """One finding per key; the worse severity wins."""
        rank = {"ok": 0, "warn": 1, "crit": 2}
        cur = self.checks.get(key)
        if cur is None or rank[severity] > rank[cur["severity"]]:
            self.checks[key] = {"severity": severity, "msg": msg, "restartable": restartable}


def load_state() -> dict:
    try:
        return json.loads((STATE_DIR / "state.json").read_text())
    except Exception:  # noqa: BLE001
        return {}


def db_conn():
    # read-only: the monitor must never write into the relayer DB
    return sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, timeout=10)


# ---------------------------------------------------------------- checks

def check_service(r: Result):
    for svc in (SERVICE, NODE_SERVICE):
        rc, out = sh(["systemctl", "is-active", svc])
        state = out.strip()
        r.metrics[f"{svc}_state"] = state
        if state != "active":
            r.add(f"service:{svc}", "crit", f"Dienst {svc} ist {state or 'unbekannt'}", restartable=(svc == SERVICE))
    _, out = sh(["systemctl", "show", SERVICE, "-p", "NRestarts", "-p", "ActiveEnterTimestamp"])
    for line in out.splitlines():
        if line.startswith("NRestarts="):
            r.metrics["systemd_restarts"] = int(line.split("=", 1)[1] or 0)
        if line.startswith("ActiveEnterTimestamp="):
            r.metrics["active_since"] = line.split("=", 1)[1]
    try:
        st = json.load(urllib.request.urlopen(API, timeout=15))
        r.metrics["api_ok"] = bool(st.get("ok"))
        return st
    except Exception as e:  # noqa: BLE001
        r.metrics["api_ok"] = False
        r.add("api", "crit", f"Bridge-API antwortet nicht ({str(e)[:80]})", restartable=True)
        return None


def check_cursor(r: Result, db, prev: dict):
    try:
        head = int(rpc("eth_blockNumber", []), 16)
        r.metrics["bsc_head"] = head
    except Exception as e:  # noqa: BLE001
        r.add("bsc_rpc", "warn", f"BSC-RPC nicht erreichbar, Cursor nicht pruefbar ({str(e)[:80]})")
        return None
    state = dict(db.execute("SELECT key, value FROM relayer_state").fetchall())
    for key in ("last_unwrap_block", "last_claim_block"):
        cur = int(state.get(key) or 0)
        lag = head - cur
        r.metrics[key] = cur
        r.metrics[f"{key}_lag"] = lag
        # cursorbug: a cursor ahead of the head means it jumped over unscanned blocks
        if cur > head + 50:
            r.add("cursorbug:ahead", "crit", f"Cursor {key} ({cur}) liegt vor dem Chain-Head ({head}) — Sprung wie beim August-Bug")
        if lag > LAG_CRIT:
            r.add(f"cursor:{key}", "crit", f"Cursor {key} {lag} Bloecke hinter BSC")
        elif lag > LAG_WARN:
            r.add(f"cursor:{key}", "warn", f"Cursor {key} {lag} Bloecke hinter BSC")
        # moving? remember when the cursor last changed
        p = prev.get("cursors", {}).get(key, {})
        changed_at = NOW if p.get("value") != cur else p.get("changed_at", NOW)
        prev.setdefault("cursors", {})[key] = {"value": cur, "changed_at": changed_at}
        if p.get("value") is not None and cur < p["value"]:
            r.add("cursorbug:backwards", "warn", f"Cursor {key} ist zurueckgesprungen ({p['value']} -> {cur})")
        stuck_min = (NOW - changed_at) / 60
        r.metrics[f"{key}_unchanged_min"] = round(stuck_min, 1)
        if stuck_min >= STUCK_MIN and lag > 100:
            r.add(f"cursor_stuck:{key}", "crit",
                  f"Cursor {key} bewegt sich seit {stuck_min:.0f} min nicht (Lag {lag})", restartable=True)
    return head


def check_cursorbug(r: Result, db, prev: dict):
    """Regression guard for the Aug-2026 bug (cursor jumped past unscanned blocks, unwraps 3+4 lost)."""
    try:
        next_id = int(eth_call(BRIDGE_ADDR, SEL_NEXT_UNWRAP_ID), 16)
    except Exception as e:  # noqa: BLE001
        r.add("bsc_rpc", "warn", f"nextUnwrapId() nicht lesbar ({str(e)[:80]})")
        return
    have = {row[0] for row in db.execute("SELECT unwrap_id FROM unwrap_requests")}
    missing = sorted(set(range(next_id)) - have)
    r.metrics["onchain_next_unwrap_id"] = next_id
    r.metrics["db_unwrap_count"] = len(have)
    # A burn in the last few blocks may not be scanned yet: only alarm if the gap survives one full run.
    prev_missing = set(prev.get("missing_unwraps", []))
    prev["missing_unwraps"] = missing
    confirmed = [m for m in missing if m in prev_missing]
    if confirmed:
        r.add("cursorbug:missing_unwraps", "crit",
              f"Unwrap-ID(s) {confirmed[:10]} on-chain verbrannt, aber nicht in der DB — Cursor hat Bloecke "
              f"uebersprungen. Nachholen mit deploy/backfill-unwrap-range.mjs (FROM/TO).")
    elif missing:
        r.metrics["unwraps_awaiting_scan"] = missing

    if CLAIM_ADDR:
        rows = db.execute(
            "SELECT id, claimable_at FROM wrap_requests WHERE status IN ('claimable','refunding') LIMIT 25").fetchall()
        missed = []
        for wid, _ in rows:
            try:
                hexid = wid.replace("-", "").lower().rjust(64, "0")
                if int(eth_call(CLAIM_ADDR, SEL_CLAIMED + hexid), 16) == 1:
                    missed.append(wid)
            except Exception:  # noqa: BLE001
                pass
        prev_missed = set(prev.get("missed_claims", []))
        prev["missed_claims"] = missed
        confirmed = [m for m in missed if m in prev_missed]
        if confirmed:
            r.add("cursorbug:missed_claims", "crit",
                  f"{len(confirmed)} Wrap(s) on-chain geclaimt, DB steht noch auf claimable — Claim-Event verpasst "
                  f"(Refund-Gefahr!): {confirmed[:3]}")


def check_transfers(r: Result, db):
    ms = NOW * 1000
    rows = db.execute(
        "SELECT unwrap_id, status, created_at, attempt_count, last_error FROM unwrap_requests "
        "WHERE status IN ('pending','sending')").fetchall()
    old = [(u, s, (ms - c) / 60000) for u, s, c, _, _ in rows if (ms - c) / 60000 > UNWRAP_OPEN_MIN]
    r.metrics["unwraps_open"] = len(rows)
    if old:
        r.add("transfers:unwrap_open", "crit" if any(a > 180 for *_, a in old) else "warn",
              f"{len(old)} Unwrap(s) seit ueber {UNWRAP_OPEN_MIN} min offen (IDs {[u for u, *_ in old][:10]})")
    failed = [u for (u,) in db.execute("SELECT unwrap_id FROM unwrap_requests WHERE status='failed'")]
    r.metrics["unwraps_failed"] = failed
    new_failed = [u for u in failed if u not in ACK_FAILED_UNWRAPS]
    if new_failed:
        r.add("transfers:unwrap_failed", "crit",
              f"Unwrap(s) {new_failed} endgueltig fehlgeschlagen — wBLOZ verbrannt, BLOZ nicht ausgezahlt")
    # refund_queued: relayer found the bz1 target invalid — BLOZ can never be paid, the burned
    # wBLOZ must be re-minted to the BSC sender (deploy/refund-unwrap-mint.mjs, needs Marlon's ok).
    queued = [u for (u,) in db.execute("SELECT unwrap_id FROM unwrap_requests WHERE status='refund_queued'")]
    r.metrics["unwraps_refund_queued"] = queued
    new_queued = [u for u in queued if u not in ACK_REFUND_QUEUED]
    if new_queued:
        r.add("transfers:unwrap_refund_queued", "warn",
              f"Unwrap(s) {new_queued} mit ungueltiger bz1-Adresse — wBLOZ verbrannt, Rueckerstattung als wBLOZ "
              f"an den BSC-Absender offen (refund-unwrap-mint.mjs)")
    orphan = db.execute(
        "SELECT COUNT(*), MIN(created_at) FROM orphan_deposits WHERE status IN ('pending','refunding','failed')").fetchone()
    r.metrics["orphans_open"] = orphan[0]
    if orphan[0] and (ms - orphan[1]) / 60000 > REFUND_OPEN_MIN:
        r.add("transfers:orphan_open", "warn", f"{orphan[0]} Fehl-Einzahlung(en) seit ueber {REFUND_OPEN_MIN} min nicht zurueckerstattet")
    refunding = db.execute("SELECT COUNT(*) FROM wrap_requests WHERE status='refunding'").fetchone()[0]
    claimable = db.execute("SELECT COUNT(*) FROM wrap_requests WHERE status='claimable'").fetchone()[0]
    r.metrics["wraps_refunding"] = refunding
    r.metrics["wraps_claimable"] = claimable
    if refunding:
        r.add("transfers:wrap_refunding", "warn", f"{refunding} Wrap-Rueckerstattung(en) haengen im Status refunding")


def check_reserve(r: Result, st: dict | None, prev: dict):
    if st:
        bal = float(st.get("bridgeBloz") or 0)
        supply = float(st.get("wBLOZSupply") or 0)
        deficit = supply - bal
        r.metrics.update(bridge_bloz=bal, wbloz_supply=supply, reserve_deficit=round(deficit, 8))
        if deficit > max(RESERVE_TOL, ACK_RESERVE_DEFICIT + RESERVE_TOL):
            r.add("reserve:deficit", "warn" if deficit < 100 else "crit",
                  f"Reserve {bal:.2f} BLOZ liegt {deficit:.2f} BLOZ unter dem wBLOZ-Umlauf {supply:.2f} (backed=false)")
    rc, out = sh(BLOZ_CLI + ["getblockchaininfo"])
    if rc != 0:
        r.add("bloz_node", "crit", f"BLOZ-Node antwortet nicht ({out.strip()[:80]})")
        return
    info = json.loads(out)
    r.metrics["bloz_height"] = info.get("blocks")
    r.metrics["bloz_ibd"] = info.get("initialblockdownload")
    rc, out = sh(BLOZ_CLI + ["getconnectioncount"])
    peers = int(out.strip()) if rc == 0 and out.strip().isdigit() else 0
    r.metrics["bloz_peers"] = peers
    if peers == 0:
        r.add("bloz_node:peers", "warn", "BLOZ-Node hat keine Peers")
    rc, out = sh(BLOZ_CLI + ["getblockheader", info.get("bestblockhash", "")])
    if rc == 0:
        age = (NOW - json.loads(out)["time"]) / 60
        r.metrics["bloz_tip_age_min"] = round(age, 1)
        if age > BLOZ_TIP_AGE_WARN_MIN:
            r.add("bloz_node:tip", "warn", f"Letzter BLOZ-Block ist {age:.0f} min alt (Node haengt oder Chain steht)")


def check_logs(r: Result):
    rc, out = sh(["journalctl", "-u", SERVICE, "--since", "-10min", "--no-pager", "-o", "cat"])
    lines = out.splitlines() if rc == 0 else []
    errs = [l for l in lines if any(w in l.lower() for w in ("error", "failed", "fatal", "unhandled"))]
    r.metrics["log_errors_10min"] = len(errs)
    if len(errs) > ERR_WARN_PER_10MIN:
        r.add("logs", "warn", f"{len(errs)} Fehlerzeilen in 10 min, z.B.: {errs[-1][:120]}")


def check_system(r: Result):
    du = shutil.disk_usage("/")
    pct = du.used * 100 / du.total
    r.metrics["disk_pct"] = round(pct, 1)
    if pct >= DISK_CRIT:
        r.add("system:disk", "crit", f"Festplatte {pct:.0f} % voll")
    elif pct >= DISK_WARN:
        r.add("system:disk", "warn", f"Festplatte {pct:.0f} % voll")
    mem = {l.split(":")[0]: int(l.split()[1]) for l in Path("/proc/meminfo").read_text().splitlines()}
    avail = mem.get("MemAvailable", 0) // 1024
    r.metrics["mem_available_mb"] = avail
    if avail < MEM_WARN_MB:
        r.add("system:ram", "warn", f"Nur noch {avail} MB RAM frei")


# ---------------------------------------------------------------- actions / alarms

def event(ev: dict):
    ev = {"ts": iso(), **ev}
    print("EVENT", json.dumps(ev, ensure_ascii=False))
    if not DRY:
        with open(STATE_DIR / "events.jsonl", "a") as f:
            f.write(json.dumps(ev, ensure_ascii=False) + "\n")


def telegram(text: str):
    token, chat = CFG.get("TELEGRAM_BOT_TOKEN"), CFG.get("TELEGRAM_CHAT_ID")
    if DRY or not token or not chat:
        return
    try:
        data = urllib.parse.urlencode({"chat_id": chat, "text": text[:3900], "disable_web_page_preview": "true"}).encode()
        urllib.request.urlopen(f"https://api.telegram.org/bot{token}/sendMessage", data, timeout=15)
    except Exception as e:  # noqa: BLE001
        print("telegram failed:", e)


def maybe_restart(r: Result, prev: dict, rpc_ok: bool):
    reasons = [k for k, c in r.checks.items() if c.get("restartable") and c["severity"] == "crit"]
    if not reasons:
        return
    # a stuck cursor is only the relayer's fault if the RPC itself answers
    if all(k.startswith("cursor_stuck") for k in reasons) and not rpc_ok:
        return
    last = prev.get("last_restart", 0)
    if NOW - last < RESTART_COOLDOWN_MIN * 60:
        r.add("restart:cooldown", "crit",
              f"Neustart vor {(NOW - last) / 60:.0f} min hat nicht geholfen ({', '.join(reasons)}) — braucht Handarbeit")
        return
    if DRY:
        r.actions.append(f"(dry-run) wuerde {SERVICE} neu starten: {reasons}")
        return
    rc, out = sh(["systemctl", "restart", SERVICE], timeout=60)
    prev["last_restart"] = NOW
    prev.setdefault("restarts", []).append({"ts": iso(), "reasons": reasons, "rc": rc})
    prev["restarts"] = prev["restarts"][-50:]
    r.actions.append(f"{SERVICE} neu gestartet ({', '.join(reasons)}), rc={rc}")
    event({"type": "restart", "reasons": reasons, "rc": rc, "out": out.strip()[:200]})
    telegram(f"🔄 BLOZ-Bridge automatisch neu gestartet\nGrund: {', '.join(r.checks[k]['msg'] for k in reasons)}")


def process_alarms(r: Result, prev: dict):
    open_alarms: dict = prev.get("alarms", {})
    rank = {"warn": 1, "crit": 2}
    now_keys = set()
    for key, c in r.checks.items():
        if c["severity"] == "ok":
            continue
        now_keys.add(key)
        a = open_alarms.get(key)
        if a is None:
            open_alarms[key] = {"severity": c["severity"], "msg": c["msg"], "since": iso(), "notified": NOW}
            event({"type": "alarm", "key": key, "severity": c["severity"], "msg": c["msg"]})
            telegram(f"{'🚨' if c['severity'] == 'crit' else '⚠️'} BLOZ-Bridge: {c['msg']}")
        else:
            escalated = rank[c["severity"]] > rank[a["severity"]]
            a.update(severity=c["severity"], msg=c["msg"])
            if escalated:
                a["notified"] = NOW
                event({"type": "escalated", "key": key, "severity": c["severity"], "msg": c["msg"]})
                telegram(f"🚨 BLOZ-Bridge (verschaerft): {c['msg']}")
            elif NOW - a.get("notified", 0) > REMIND_HOURS * 3600:
                a["notified"] = NOW
                telegram(f"⏰ BLOZ-Bridge, weiterhin offen seit {a['since']}: {c['msg']}")
    for key in list(open_alarms):
        if key not in now_keys:
            a = open_alarms.pop(key)
            event({"type": "resolved", "key": key, "msg": a["msg"], "since": a["since"]})
            telegram(f"✅ BLOZ-Bridge wieder ok: {a['msg']}")
    prev["alarms"] = open_alarms
    return open_alarms


def main() -> int:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    prev = load_state()
    r = Result()
    st = check_service(r)
    head = None
    try:
        db = db_conn()
        head = check_cursor(r, db, prev)
        check_cursorbug(r, db, prev)
        check_transfers(r, db)
        db.close()
    except Exception as e:  # noqa: BLE001
        r.add("db", "crit", f"Bridge-DB nicht lesbar ({str(e)[:100]})")
    check_reserve(r, st, prev)
    check_logs(r)
    check_system(r)
    maybe_restart(r, prev, rpc_ok=head is not None)
    alarms = process_alarms(r, prev)

    worst = max((c["severity"] for c in r.checks.values()), key=lambda s: {"ok": 0, "warn": 1, "crit": 2}[s], default="ok")
    status = {
        "ts": iso(),
        "overall": worst,
        "alarms": [{"key": k, **v} for k, v in sorted(alarms.items())],
        "checks": r.checks,
        "actions": r.actions,
        "metrics": r.metrics,
        "acknowledged": {"failed_unwraps": sorted(ACK_FAILED_UNWRAPS), "refund_queued_unwraps": sorted(ACK_REFUND_QUEUED), "reserve_deficit_bloz": ACK_RESERVE_DEFICIT},
        "restarts_7d": [x for x in prev.get("restarts", []) if x["ts"] >= iso(NOW - 7 * 86400)],
        "telegram": bool(CFG.get("TELEGRAM_BOT_TOKEN") and CFG.get("TELEGRAM_CHAT_ID")),
    }
    if DRY:
        print(json.dumps(status, indent=2, ensure_ascii=False))
        return 0
    tmp = STATE_DIR / "status.json.tmp"
    tmp.write_text(json.dumps(status, indent=2, ensure_ascii=False))
    tmp.replace(STATE_DIR / "status.json")
    (STATE_DIR / "state.json").write_text(json.dumps(prev, indent=2))
    print(f"overall={worst} alarms={len(alarms)} actions={r.actions}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
