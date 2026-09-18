#!/usr/bin/env python3
"""Lightweight heartbeat watchdog for long-running project-contract-harness work."""

from __future__ import annotations

import argparse
import json
import os
import signal
import time
from datetime import datetime, timezone
from pathlib import Path


CONTRACT_DIR = ".project-contract-harness"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def default_state_path(project_root: Path) -> Path:
    return project_root / CONTRACT_DIR / "watchdog-state.json"


def write_state(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(path)


def load_state(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def run_watch(project_root: Path, interval: float, state_path: Path, label: str) -> int:
    stopped = False

    def stop(_signum, _frame) -> None:
        nonlocal stopped
        stopped = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    payload = {
        "version": 1,
        "status": "running",
        "label": label,
        "pid": os.getpid(),
        "project_root": ".",
        "started_at": utc_now(),
        "last_heartbeat": utc_now(),
        "interval_seconds": interval,
    }
    while not stopped:
        payload["last_heartbeat"] = utc_now()
        write_state(state_path, payload)
        time.sleep(interval)

    payload["status"] = "stopped"
    payload["stopped_at"] = utc_now()
    write_state(state_path, payload)
    return 0


def check_state(state_path: Path, max_age: float) -> int:
    if not state_path.exists():
        print(f"Watchdog check failed: missing state file: {state_path}")
        return 2
    try:
        payload = load_state(state_path)
    except Exception as exc:  # noqa: BLE001 - CLI should report parse errors.
        print(f"Watchdog check failed: invalid state file: {exc}")
        return 2

    heartbeat = payload.get("last_heartbeat")
    if not heartbeat:
        print("Watchdog check failed: missing last_heartbeat")
        return 2
    try:
        heartbeat_time = datetime.fromisoformat(str(heartbeat))
    except ValueError:
        print(f"Watchdog check failed: invalid last_heartbeat: {heartbeat}")
        return 2
    age = datetime.now(timezone.utc).timestamp() - heartbeat_time.timestamp()
    status = payload.get("status")
    if status != "running":
        print(f"Watchdog check failed: status is {status!r}")
        return 1
    if age > max_age:
        print(f"Watchdog check failed: heartbeat age {age:.1f}s > {max_age:.1f}s")
        return 1
    print(f"Watchdog check passed: heartbeat age {age:.1f}s")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    watch = sub.add_parser("watch", help="write heartbeat state until interrupted")
    watch.add_argument("--project-root", default=".")
    watch.add_argument("--state-file", default="")
    watch.add_argument("--interval", type=float, default=5.0)
    watch.add_argument("--label", default="project-contract-harness")

    check = sub.add_parser("check", help="check heartbeat freshness")
    check.add_argument("--project-root", default=".")
    check.add_argument("--state-file", default="")
    check.add_argument("--max-age", type=float, default=20.0)

    args = parser.parse_args()
    root = Path(args.project_root).resolve()
    state_path = Path(args.state_file).resolve() if args.state_file else default_state_path(root)

    if args.command == "watch":
        return run_watch(root, max(0.5, args.interval), state_path, args.label)
    if args.command == "check":
        return check_state(state_path, max(1.0, args.max_age))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
