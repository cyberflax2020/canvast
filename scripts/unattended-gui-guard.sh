#!/bin/bash
# ============================================================================
# Canvast — Unattended Gui Guard / Canvast 源文件
# ============================================================================
# @file        scripts/unattended-gui-guard.sh
# @brief       Canvast-owned source file.
# @description Part of the Canvast product codebase. Keep provenance and
#              license headers explicit for commercial redistribution.
# @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
# ============================================================================
# ============================================================================
# unattended-gui-guard.sh -- scoped guard for unattended frontend test runs.
# ----------------------------------------------------------------------------
# This guard is strictly monitor-only. It records GUI/browser launchers tied to
# this checkout; only the exact-owning safe-run layer may signal workloads.
#
# Usage:
#   scripts/unattended-gui-guard.sh --once
#   scripts/unattended-gui-guard.sh
#
# Tunables:
#   POLL=2
#   DRY_RUN=1
# ============================================================================
set -u

POLL="${POLL:-2}"
DRY_RUN="${DRY_RUN:-0}"
CANVAST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${CANVAST_RESOURCE_STATE_DIR:-$CANVAST_DIR/.pi}"
RUN_DIR="$STATE_DIR/.gui-guard-run"
LOG_FILE="$STATE_DIR/gui-guard.log"
PIDFILE="$STATE_DIR/gui-guard.pid"
SELF_PID=$$
case "$STATE_DIR" in /*) ;; *) echo "unattended-gui-guard: CANVAST_RESOURCE_STATE_DIR must be absolute" >&2; exit 2 ;; esac

# Keep the sliced foreground sleep bounded and valid under macOS Bash 3.2.
# Canonical decimal input also avoids octal parsing surprises such as 08.
case "$POLL" in
  ""|0*|*[!0-9]*)
    echo "unattended-gui-guard: POLL must be a positive integer from 1 to 3600 seconds" >&2
    exit 2
    ;;
esac
if [ "${#POLL}" -gt 4 ] || [ "$POLL" -gt 3600 ]; then
  echo "unattended-gui-guard: POLL must be a positive integer from 1 to 3600 seconds" >&2
  exit 2
fi

mkdir -p "$RUN_DIR"

log() {
  if [ -f "$LOG_FILE" ] && [ "$(wc -c < "$LOG_FILE" 2>/dev/null || echo 0)" -gt 1048576 ]; then
    mv -f "$LOG_FILE" "$LOG_FILE.old" 2>/dev/null
  fi
  line="[$(date '+%F %T')] $*"
  echo "$line" >> "$LOG_FILE"
  if [ "$DRY_RUN" = "1" ]; then echo "[DRY-RUN] $line"; else echo "$line"; fi
}

is_gui_launcher() {
  case "$1" in
    *"/usr/bin/open "*|*" open "*|*"/usr/bin/osascript"*|*" osascript "*) return 0 ;;
    *"Chromium.app"*|*"Google Chrome.app"*|*"Safari.app"*|*"Electron.app"*) return 0 ;;
    *"playwright"*|*"chromium"*|*"WebKit"*|*"webdriver"*|*"CanvastApp.app"*) return 0 ;;
    *.app/*) return 0 ;;
  esac
  return 1
}

is_scoped_target() {
  cmd="$1"; pid="$2"
  [ "$pid" = "$SELF_PID" ] && return 1
  case "$cmd" in
    *unattended-gui-guard.sh*|*resource-watchdog.sh*) return 1 ;;
  esac
  is_gui_launcher "$cmd" || return 1

  # Scope guard: only Canvast checkout paths or explicit unattended test marker.
  case "$cmd" in
    *"$CANVAST_DIR"/*|*CANVAST_UNATTENDED_GUI_TEST=1*) return 0 ;;
  esac
  return 1
}

record_scoped() {
  target_pid="$1"; reason="$2"
  target_cmd=$(ps -o command= -p "$target_pid" 2>/dev/null | cut -c1-180)
  target_birth=$(ps -o lstart= -p "$target_pid" 2>/dev/null | sed 's/^ *//')
  [ -n "$target_birth" ] || target_birth=unobservable
  log "monitor-only pid=$target_pid birth=$target_birth reason=[$reason] cmd=$target_cmd; no signal sent"
}

scan_once() {
  raw=$(ps -eo pid=,command= 2>/dev/null || true)
  count=0
  if [ -n "$raw" ]; then
    echo "$raw" | while read -r pid cmd; do
      [ -z "$pid" ] && continue
      if is_scoped_target "$cmd" "$pid"; then
        count=$((count + 1))
        record_scoped "$pid" "unattended GUI/browser launcher observed"
      fi
    done
  fi
  log "scan complete"
}

guard_sleep() {
  # Bash may defer TERM traps while it waits for an external foreground
  # command. Short foreground slices bound that delay without creating a
  # background sleeper that would need separate PID/birth ownership.
  local slices=$((POLL * 20))
  while [ "$slices" -gt 0 ]; do
    /bin/sleep 0.05 || return 1
    slices=$((slices - 1))
  done
  return 0
}

if [ "${1:-}" != "--once" ]; then
  if [ -f "$PIDFILE" ]; then
    old_pid=$(cat "$PIDFILE" 2>/dev/null || echo "")
    if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
      old_cmd=$(ps -o command= -p "$old_pid" 2>/dev/null || echo "")
      case "$old_cmd" in
        *unattended-gui-guard.sh*)
          log "gui guard already running pid=$old_pid"
          exit 0 ;;
      esac
    fi
  fi
  echo "$SELF_PID" > "$PIDFILE"
  trap 'rm -f "$PIDFILE"; log "gui guard stopped"; exit 0' TERM INT
fi

log "gui guard started pid=$SELF_PID dry_run=$DRY_RUN scope=$CANVAST_DIR"

if [ "${1:-}" = "--once" ]; then
  scan_once
  exit 0
fi

while true; do
  scan_once
  guard_sleep || exit 1
done
