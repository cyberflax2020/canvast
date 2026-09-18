#!/bin/bash
# Canvast — Resource Watchdog / Canvast 源文件
# @file        scripts/resource-watchdog.sh
# @brief       Canvast-owned process monitor and diagnostic ledger.
# @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
# Samples Canvast-owned targets and records lifecycle/resource-pressure evidence.
# Exact PID/birth/group anchors enrich diagnostics. Only safe-run may signal
# workloads; this bash-3.2-compatible watchdog never does.
# Usage:
#   resource-watchdog.sh            # monitor continuously / 持续监控
#   DRY_RUN=1 resource-watchdog.sh  # also mirror logs to stdout / 同时输出日志到终端
#   resource-watchdog.sh --once     # one scan then exit / 采样一轮即退出（巡检）
#   resource-watchdog.sh --status   # read-only verified status / 只读核验状态
#   resource-watchdog.sh --stop     # stop the exact recorded owner / 精确停止已登记实例
# Tunables are the default-valued variables immediately below.
set -u
POLL="${POLL:-5}"
MAX_PI_PROCS="${MAX_PI_PROCS:-4}"
HARD_PI_PROCS="${HARD_PI_PROCS:-8}"
HOT_CPU_PCT="${HOT_CPU_PCT:-95}"
HOT_SECONDS="${HOT_SECONDS:-45}"
RSS_WARN_MB="${RSS_WARN_MB:-6144}"
PRESSURE_AVAIL_MB="${PRESSURE_AVAIL_MB:-4096}"
MAX_TOTAL_RSS_HARD_MB="${MAX_TOTAL_RSS_HARD_MB:-0}"
RSS_PRESSURE_SAMPLES="${RSS_PRESSURE_SAMPLES:-2}"
RSS_HARD_SAMPLES="${RSS_HARD_SAMPLES:-3}"
RSS_WARN_INTERVAL="${RSS_WARN_INTERVAL:-60}"
MIN_AVAIL_MB="${MIN_AVAIL_MB:-512}"
LOAD_CEILING="${LOAD_CEILING:-28}"
DRY_RUN="${DRY_RUN:-0}"
# Resolve the project root from this script, without personal paths.
CANVAST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${CANVAST_RESOURCE_STATE_DIR:-$CANVAST_DIR/.pi}"
PROCESS_SNAPSHOT="$CANVAST_DIR/scripts/process-snapshot.py"
PROCESS_SNAPSHOT_PYTHON="${CANVAST_PROCESS_SNAPSHOT_PYTHON:-/usr/bin/python3}"
PROCESS_SNAPSHOT_FORCE_HELPER="${CANVAST_PROCESS_SNAPSHOT_FORCE_HELPER:-0}"
RUN_DIR="$STATE_DIR/.watchdog-run"
LOG_FILE="$STATE_DIR/watchdog.log"
STATUS_FILE="$STATE_DIR/watchdog.status"
PIDFILE="$STATE_DIR/watchdog.pid"
LOCK_DIR="$STATE_DIR/watchdog.lock"
SELF_PID=$$
WATCHDOG_MODE="daemon"
WATCHDOG_ACTION="daemon"
PARENT_PID="${CANVAST_WATCHDOG_PARENT_PID:-}"
PARENT_BIRTH="${CANVAST_WATCHDOG_PARENT_BIRTH:-}"
OWNER_TOKEN="${CANVAST_WATCHDOG_OWNER_TOKEN:-watchdog-${SELF_PID}-$(date +%s)}"
LOCK_OWNED=0
STOPPING=0
ONCE_MODE=0
WATCHDOG_SLEEP_PID=""
WATCHDOG_SLEEP_BIRTH=""
watchdog_usage() {
  echo "Usage: resource-watchdog.sh [--once|--status|--stop]" >&2
}
if [ "$#" -gt 1 ]; then
  watchdog_usage
  exit 2
fi
case "$STATE_DIR" in /*) ;; *) echo "resource-watchdog: CANVAST_RESOURCE_STATE_DIR must be absolute" >&2; exit 2 ;; esac
case "${1:-}" in
  "") WATCHDOG_ACTION="daemon" ;;
  --once)
    WATCHDOG_ACTION="once"
    ONCE_MODE=1
    # A diagnostic scan must never impersonate or overwrite the canonical
    # heartbeat or mutable tracking state owned by the persistent daemon.
    STATUS_FILE="${CANVAST_WATCHDOG_ONCE_STATUS:-$STATE_DIR/watchdog.once.${SELF_PID}.status}"
    RUN_DIR="$STATE_DIR/.watchdog-once.${SELF_PID}"
    ;;
  --status) WATCHDOG_ACTION="status" ;;
  --stop) WATCHDOG_ACTION="stop" ;;
  -h|--help) watchdog_usage; exit 0 ;;
  *)
    echo "resource-watchdog: unknown argument: ${1:-}" >&2
    watchdog_usage
    exit 2
    ;;
esac
if [ -n "$PARENT_PID" ]; then
  WATCHDOG_MODE="owned"
fi
snapshot_record() {
  local snapshot_pid="$1"
  # Production uses the helper; shell-function mocks support lifecycle tests.
  local ps_path
  ps_path=$(command -v ps 2>/dev/null || echo "")
  if [ "$PROCESS_SNAPSHOT_FORCE_HELPER" != "1" ] && { type ps 2>/dev/null | grep -q 'function' || { [ -n "$ps_path" ] && [ "$ps_path" != "/bin/ps" ] && [ "$ps_path" != "/usr/bin/ps" ]; }; }; then
    local direct_birth direct_pgid direct_command
    direct_birth=$(ps -o lstart= -p "$snapshot_pid" 2>/dev/null | sed 's/^ *//; s/  */_/g')
    direct_pgid=$(ps -o pgid= -p "$snapshot_pid" 2>/dev/null | tr -d ' ')
    direct_command=$(ps -o command= -p "$snapshot_pid" 2>/dev/null)
    [ -n "$direct_birth" ] && [ -n "$direct_pgid" ] && [ -n "$direct_command" ] || return 1
    printf '%s|%s|%s\n' "$direct_birth" "$direct_pgid" "$direct_command"
    return 0
  fi
  [ -f "$PROCESS_SNAPSHOT" ] || return 1
  local fallback
  fallback=$("$PROCESS_SNAPSHOT_PYTHON" "$PROCESS_SNAPSHOT" --pid "$snapshot_pid" 2>/dev/null) || return 1
  printf '%s\n' "$fallback" | awk -F '\t' -v pid="$snapshot_pid" '
    NR == 1 { if ($0 != "CANVAST_PROCESS_SNAPSHOT_V1") exit 1; next }
    NR == 2 { if ($0 != "pid\tppid\tpgid\tstart_sec\tstart_usec\trss_bytes\tcpu_usec\tcommand") exit 1; next }
    $1 == pid && $1 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ && $4 ~ /^[0-9]+$/ && $5 ~ /^[0-9]+$/ {
      command=$8; for (i=9; i<=NF; i++) command=command "\t" $i;
      printf "%s.%06d|%s|%s\n", $4, $5, $3, command;
      found=1
    }
    END { if (!found) exit 1 }
  '
}
process_birth() { snapshot_record "$1" | cut -d'|' -f1; }
process_pgid() { snapshot_record "$1" | cut -d'|' -f2; }
process_command() { snapshot_record "$1" | cut -d'|' -f3-; }
snapshot_all_protocol_rows() { local protocol
  [ -f "$PROCESS_SNAPSHOT" ] || return 1; protocol=$("$PROCESS_SNAPSHOT_PYTHON" "$PROCESS_SNAPSHOT" --all 2>/dev/null) || return 1; [ -n "$protocol" ] || return 1
  printf '%s\n' "$protocol" | awk -F '\t' 'function d(v){return v~/^(0|[1-9][0-9]*)$/} NR==1{h=$0=="CANVAST_PROCESS_SNAPSHOT_V1";next} NR==2{f=$0=="pid\tppid\tpgid\tstart_sec\tstart_usec\trss_bytes\tcpu_usec\tcommand";next} NR>2{if(!h||!f||NF!=8||!d($1)||$1=="0"||!d($2)||!d($3)||!d($4)||!d($5)||length($5)>6||(length($5)==6&&$5>"999999")||!d($6)||!d($7)||index($0,"\r")||seen[$1]++){bad=1;next} print;rows++} END{if(!h||!f||bad||rows<1||NR!=rows+2)exit 1}'
}
snapshot_pid_explicitly_absent() { local rows; rows=$(snapshot_all_protocol_rows) || return 1; printf '%s\n' "$rows" | awk -F '\t' -v pid="$1" '$1 == pid { found=1 } END { exit found ? 1 : 0 }'; }
snapshot_all_ps() {
  ps -eo pid=,rss=,time=,ppid=,command= 2>/dev/null
}
snapshot_all_fallback() {
  local rows
  rows=$(snapshot_all_protocol_rows) || return 1
  printf '%s\n' "$rows" | awk -F '\t' '{
      command=$8; for (i=9; i<=NF; i++) command=command "\t" $i;
      total_seconds=$7 / 1000000;
      hours=int(total_seconds / 3600);
      minutes=int((total_seconds - hours * 3600) / 60);
      seconds=total_seconds - hours * 3600 - minutes * 60;
      printf "%d %d %d:%02d:%05.2f %d %s\n", $1, int($6 / 1024), hours, minutes, seconds, $2, command;
    }
  '
}

snapshot_all() {
  local ps_path
  ps_path=$(command -v ps 2>/dev/null || echo "")
  if [ "$PROCESS_SNAPSHOT_FORCE_HELPER" != "1" ] && { type ps 2>/dev/null | grep -q 'function' || { [ -n "$ps_path" ] && [ "$ps_path" != "/bin/ps" ] && [ "$ps_path" != "/usr/bin/ps" ]; }; }; then
    snapshot_all_ps
    return $?
  fi
  snapshot_all_fallback
}

SELF_BIRTH=$(process_birth "$SELF_PID")
# ── Target matching / 目标匹配 ──────────────────────────────────────────────
# Match this checkout's pi, vitest/vite-node, and node processes; exclude the
# watchdog, Claude, and system/IDE processes.
is_target() {
  cmd="$1"; pid="$2"
  case "$cmd" in
    *claude*|*resource-watchdog*|*WindowServer*|*launchd*|*Trae*|*kernel_task*|*loginwindow*) return 1 ;;
  esac
  [ "$pid" = "$SELF_PID" ] && return 1
  case "$cmd" in
    *"$CANVAST_DIR"/node_modules/.bin/pi*) return 0 ;;
    *vitest*"$CANVAST_DIR"/*|*"$CANVAST_DIR"/*vitest*) return 0 ;;
    *vite-node*"$CANVAST_DIR"/*|*"$CANVAST_DIR"/*vite-node*) return 0 ;;
    node*"$CANVAST_DIR"/*) return 0 ;;
  esac
  return 1
}
is_pi_proc() {
  case "$1" in *"$CANVAST_DIR"/node_modules/.bin/pi*) return 0 ;; esac
  return 1
}

log() {
  # Rotate BEFORE writing so the triggering line always lands in the new file.
  # 先轮转后写入，避免竞争。
  if [ -f "$LOG_FILE" ] && [ "$(wc -c < "$LOG_FILE" 2>/dev/null || echo 0)" -gt 1048576 ]; then
    mv -f "$LOG_FILE" "$LOG_FILE.old" 2>/dev/null
  fi
  line="[$(date '+%F %T')] $*"
  echo "$line" >> "$LOG_FILE"
  if [ "$DRY_RUN" = "1" ]; then echo "[DRY-RUN] $line"; else echo "$line"; fi
}

# ── Monitor-only diagnostics / 仅监控诊断 ─────────────────────────────────
is_decimal() {
  case "${1:-}" in ''|*[!0-9]*) return 1 ;; esac
}

is_process_id() {
  is_decimal "${1:-}" && [ "$1" -gt 1 ]
}

is_ledger_text() {
  [ -n "${1:-}" ] || return 1
  case "$1" in *'|'*|*$'\n'*) return 1 ;; esac
}

# Persist exact identity and safe-run-owned anchors for monitor-only diagnosis.
record_target_diagnostic() {
  local target_pid="$1" reason="$2" target_command target_birth target_pgid
  local observed_at anchor_record anchor_pid="" anchor_birth="" extra=""
  local ledger ledger_tmp
  if ! is_process_id "$target_pid"; then
    log "监控目标 PID 非法，拒绝写入诊断 ledger: ${target_pid:-empty}"
    return 1
  fi
  target_command=$(process_command "$target_pid" 2>/dev/null | cut -c1-100)
  target_birth=$(process_birth "$target_pid" 2>/dev/null || echo "")
  target_pgid=$(process_pgid "$target_pid" 2>/dev/null || echo "")
  observed_at=$(date +%s)
  is_decimal "$observed_at" && is_ledger_text "$target_birth" || {
    log "无法确认 pid=$target_pid 的启动身份，拒绝写入诊断 ledger"
    return 1
  }
  if [ -n "$target_pgid" ] && ! is_process_id "$target_pgid"; then
    log "监控目标 PGID 非法，拒绝写入诊断 ledger pid=$target_pid pgid=$target_pgid"
    return 1
  fi
  if [ "$target_pgid" = "$target_pid" ]; then
    anchor_record=$(capture_group_anchor "$target_pgid" "$target_pid" 2>/dev/null || echo "")
    if [ -n "$anchor_record" ]; then
      IFS='|' read -r anchor_pid anchor_birth extra <<< "$anchor_record"
      is_process_id "$anchor_pid" && is_ledger_text "$anchor_birth" && [ -z "$extra" ] || {
        anchor_pid=""
        anchor_birth=""
      }
    fi
  fi
  ledger="$RUN_DIR/diagnostic_$target_pid"
  ledger_tmp="$ledger.${SELF_PID}.tmp"
  if ! printf 'v1|%s|%s|%s|%s|%s|%s\n' \
      "$observed_at" "$target_pid" "$target_birth" "$target_pgid" "$anchor_pid" "$anchor_birth" > "$ledger_tmp" ||
     ! mv -f "$ledger_tmp" "$ledger"; then
    rm -f "$ledger_tmp"
    log "无法持久化 monitor-only 诊断 ledger pid=$target_pid"
    return 1
  fi
  log "monitor-only 记录 pid=$target_pid 原因=[$reason] cmd=${target_command}；未发送终止信号"
  return 0
}

safe_run_lock_field() {
  sed -n "s/^$1=//p" "$STATE_DIR/safe-run.lock/owner" 2>/dev/null | head -1
}

# Trust only the dedicated anchor published before the child start gate opens.
capture_group_anchor() {
  local candidate_pgid="$1" leader_pid="$2"
  local owner_pid owner_birth owner_token record_path record rest
  local anchor_pid anchor_birth anchor_pgid extra current_anchor_pgid
  owner_pid=$(safe_run_lock_field pid)
  owner_birth=$(safe_run_lock_field birth)
  owner_token=$(safe_run_lock_field token)
  is_process_id "$owner_pid" && is_process_id "$candidate_pgid" && is_process_id "$leader_pid" || return 1
  case "$owner_token" in ''|*[!A-Za-z0-9._-]*) return 1 ;; esac
  [ -n "$owner_birth" ] && [ "$(process_birth "$owner_pid" 2>/dev/null || echo "")" = "$owner_birth" ] || return 1
  record_path="$STATE_DIR/safe-run-child-member.${owner_pid}.${owner_token}"
  record=$(sed -n '1p' "$record_path" 2>/dev/null) || return 1
  IFS='|' read -r anchor_pid anchor_birth anchor_pgid extra <<< "$record"
  is_process_id "$anchor_pid" && is_process_id "$anchor_pgid" || return 1
  [ -z "${extra:-}" ] && is_ledger_text "$anchor_birth" || return 1
  [ "$anchor_pid" != "$leader_pid" ] && [ "$anchor_pgid" = "$candidate_pgid" ] || return 1
  [ "$(process_birth "$anchor_pid" 2>/dev/null || echo "")" = "$anchor_birth" ] || return 1
  current_anchor_pgid=$(process_pgid "$anchor_pid" 2>/dev/null || echo "")
  [ "$current_anchor_pgid" = "$candidate_pgid" ] || return 1
  printf '%s|%s' "$anchor_pid" "$anchor_birth"
}

# Old TERM ledgers predate the monitor-only boundary. Parse every numeric field
# strictly so diagnostics distinguish legacy records from corrupt input, then
# atomically quarantine both classes without probing or signaling any PID/PGID.
classify_legacy_term_ledger() {
  local ledger_path="$1" target_pid record sent target_birth target_pgid
  local member_pid member_birth extra
  target_pid="${ledger_path##*/term_}"
  record=$(cat "$ledger_path" 2>/dev/null || echo "")
  case "$record" in *$'\n'*) return 1 ;; esac
  IFS='|' read -r sent target_birth target_pgid member_pid member_birth extra <<< "$record"
  is_process_id "$target_pid" && is_decimal "$sent" && is_ledger_text "$target_birth" || return 1
  [ -z "${extra:-}" ] || return 1
  if [ -n "$target_pgid" ]; then
    is_process_id "$target_pgid" && [ "$target_pgid" = "$target_pid" ] || return 1
  fi
  if [ -n "${member_pid:-}" ] || [ -n "${member_birth:-}" ]; then
    is_process_id "${member_pid:-}" && is_ledger_text "${member_birth:-}" || return 1
    [ "$member_pid" != "$target_pid" ] && [ -n "$target_pgid" ] || return 1
  fi
  return 0
}

quarantine_term_ledger() {
  local ledger_path="$1" classification="$2" quarantine_dir destination stamp
  quarantine_dir="$RUN_DIR/quarantine"
  mkdir -p "$quarantine_dir" || return 1
  stamp=$(date +%s)
  is_decimal "$stamp" || return 1
  destination="$quarantine_dir/${ledger_path##*/}.${classification}.${stamp}.${SELF_PID}"
  mv -f "$ledger_path" "$destination" || return 1
  log "TERM ledger 已隔离 classification=$classification path=${destination}；未调用 kill"
}

reap_pending() {
  local unresolved=0
  for tf in "$RUN_DIR"/term_*; do
    [ -f "$tf" ] || continue
    classification=malformed
    classify_legacy_term_ledger "$tf" && classification=legacy
    quarantine_term_ledger "$tf" "$classification" || unresolved=1
  done
  [ "$unresolved" = "0" ]
}

# ── System metrics / 系统指标 ────────────────────────────────────────────────
# Available memory = free + inactive (macOS keeps "free" tiny; inactive is the
# reclaimable bulk). 可用内存 = free + inactive。
avail_mem_mb() {
  local raw
  raw=$(vm_stat 2>/dev/null) || return 1
  [ -n "$raw" ] || return 1
  echo "$raw" | awk '
    /page size of/   {ps=$8}
    /Pages free/     {gsub(/\./,""); f=$3; have_f=1}
    /Pages inactive/ {gsub(/\./,""); i=$3; have_i=1}
    END {
      if (ps !~ /^[0-9]+$/ || !have_f || !have_i) exit 1;
      print int((f+i)*ps/1048576)
    }'
}

load1() {
  local value
  value=$(sysctl -n vm.loadavg 2>/dev/null | awk '{gsub(/[{}]/,""); print $1}')
  if [ -n "$value" ]; then
    echo "$value"
    return
  fi
  value=$(uptime 2>/dev/null | sed -n 's/.*load averages*: \([0-9.]*\).*/\1/p')
  [ -n "$value" ] || return 1
  echo "$value"
}

# CPU time → seconds. Handles M:SS.hh, H:MM:SS.hh and DD-HH:MM:SS.hh.
# CPU 时间转秒，兼容三种 ps 时长格式。
cputime_sec() {
  echo "$1" | awk -F'[:-]' '{
    if (NF==4)      printf "%.2f", ($1*24+$2)*3600+$3*60+$4;
    else if (NF==3) printf "%.2f", $1*3600+$2*60+$3;
    else            printf "%.2f", $1*60+$2;
  }'
}

LOAD_HOT_COUNT=0
MEM_HOT_COUNT=0
RSS_PRESSURE_COUNT=0
RSS_HARD_COUNT=0
RSS_LAST_WARN_EPOCH=0
# Backward-compatible status field. Workload signaling was removed; this value
# therefore remains zero while diagnostics count actual threshold observations.
TOTAL_KILLS=0
TOTAL_DIAGNOSTICS=0
PREV_TARGET_COUNT=0
SECONDS=0

scan_once() {
  now_free=$(avail_mem_mb 2>/dev/null || echo "")
  now_load=$(load1 2>/dev/null || echo "")

  # Sample target processes → pid|cpusec|rss_mb|ppid|cmd
  # ps failure / empty output: KEEP all tracking state and skip target rules
  # (a transient ps hiccup must not reset hot streaks or drop grace timers).
  # ps 失败或空输出：保留全部追踪状态、跳过目标规则——瞬时故障不得重置熔断状态。
  local ps_ok=1
  local sample_ok=1
  local sample_error=none
  local raw
  raw=$(snapshot_all 2>/dev/null) || ps_ok=0

  if [ "$ps_ok" != "1" ]; then
    sample_ok=0
    sample_error=ps_failed
  elif [ -z "$raw" ]; then
    sample_ok=0
    sample_error=ps_empty
  fi
  case "${now_free:-}" in
    ''|*[!0-9]*) sample_ok=0; sample_error=memory_sample_failed ;;
  esac
  if ! awk -v value="${now_load:-}" 'BEGIN { exit !(value ~ /^[0-9]+([.][0-9]+)?$/) }'; then
    sample_ok=0
    sample_error=load_sample_failed
  fi

  local next_now="$RUN_DIR/now.${SELF_PID}.tmp"
  local next_seen="$RUN_DIR/seen.${SELF_PID}.tmp"
  : > "$next_now"
  : > "$next_seen"
  if [ "$ps_ok" = "1" ] && [ -n "$raw" ]; then
    echo "$raw" | while read -r pid rss t ppid cmd; do
      [ -z "$pid" ] && continue
      if is_target "$cmd" "$pid"; then
        cs=$(cputime_sec "$t")
        printf '%s|%s|%s|%s|%s\n' "$pid" "$cs" "$((rss / 1024))" "$ppid" "$cmd" >> "$next_now"
        echo "$pid" >> "$next_seen"
      fi
    done
    mv -f "$next_now" "$RUN_DIR/now.txt"
    mv -f "$next_seen" "$RUN_DIR/seen.txt"
  else
    log "⚠ ps 采样失败/为空，保留追踪状态，本轮跳过目标规则"
    rm -f "$next_now" "$next_seen"
  fi
  [ -f "$RUN_DIR/now.txt" ] || : > "$RUN_DIR/now.txt"
  [ -f "$RUN_DIR/seen.txt" ] || : > "$RUN_DIR/seen.txt"

  n_targets=$(wc -l < "$RUN_DIR/now.txt" | tr -d ' ')
  pi_pids=""
  n_pi=0
  total_rss_mb=0
  while IFS='|' read -r pid cs rss ppid cmd; do
    total_rss_mb=$((total_rss_mb + rss))
    if is_pi_proc "$cmd"; then
      pi_pids="$pi_pids $pid"
      n_pi=$((n_pi + 1))
    fi
  done < "$RUN_DIR/now.txt"

  local status_tmp="$STATUS_FILE.${SELF_PID}.tmp"
  if ! echo "alive=$(date +%s) sample_ok=$sample_ok sample_error=$sample_error state=running watchdog_pid=$SELF_PID watchdog_birth=${SELF_BIRTH:-unknown} owner_mode=$WATCHDOG_MODE owner_token=$OWNER_TOKEN targets=$n_targets pi=$n_pi avail_mb=${now_free:-unknown} load1=${now_load:-unknown} kills=$TOTAL_KILLS diagnostics=$TOTAL_DIAGNOSTICS dry_run=$DRY_RUN" > "$status_tmp" || ! mv -f "$status_tmp" "$STATUS_FILE" || [ "$(status_field state)" != running ] || [ "$(status_field watchdog_pid)" != "$SELF_PID" ] || [ "$(status_field watchdog_birth)" != "${SELF_BIRTH:-unknown}" ] || [ "$(status_field owner_token)" != "$OWNER_TOKEN" ] || [ "$(status_field sample_ok)" != "$sample_ok" ]; then
    rm -f "$status_tmp" 2>/dev/null || true; return 125
  fi

  if [ "$sample_ok" != "1" ]; then
    reap_pending
    return 1
  fi

  if [ "$ps_ok" = "1" ] && [ -n "$raw" ]; then

    # ── Rule 1: orphaned pi (PPID=1) recorded on sight ──
    # 规则1：发现孤儿 pi（PPID=1）立即记录，终止权仍归 safe-run owner。
    while IFS='|' read -r pid cs rss ppid cmd; do
      if is_pi_proc "$cmd" && [ "$ppid" = "1" ]; then
        record_target_diagnostic "$pid" "孤儿pi进程 PPID=1" && TOTAL_DIAGNOSTICS=$((TOTAL_DIAGNOSTICS + 1))
      fi
    done < "$RUN_DIR/now.txt"

    # ── Rule 2: pi count caps / 规则2：pi 数量超限 ──
    if [ "$n_pi" -gt "$HARD_PI_PROCS" ]; then
      log "pi 进程数 $n_pi 超硬上限 ${HARD_PI_PROCS}，记录全部目标供 owner 诊断"
      for pid in $pi_pids; do
        record_target_diagnostic "$pid" "pi数量硬上限" && TOTAL_DIAGNOSTICS=$((TOTAL_DIAGNOSTICS + 1))
      done
    elif [ "$n_pi" -gt "$MAX_PI_PROCS" ]; then
      excess=$((n_pi - MAX_PI_PROCS))
      log "pi 进程数 $n_pi 超上限 ${MAX_PI_PROCS}，记录最新的 $excess 个供 owner 诊断"
      for pid in $(printf '%s\n' $pi_pids | sort -rn | head -n "$excess"); do
        record_target_diagnostic "$pid" "pi数量上限" && TOTAL_DIAGNOSTICS=$((TOTAL_DIAGNOSTICS + 1))
      done
    fi

    # ── Rule 3: sustained per-process heat warning / 规则3：单进程持续高温告警 ──
    # CPU saturation alone is normal for compilers, packagers, and Vitest.
    # It is therefore observable but never destructive. All threshold rules
    # below are monitor-only; safe-run exclusively owns workload lifecycle.
    # 编译、打包和 Vitest 占满 CPU 属于正常吞吐，因此这里只做可观测告警。
    # 以下所有阈值规则均只记录诊断；workload 生命周期仅由 safe-run 管理。
    while IFS='|' read -r pid cs rss ppid cmd; do
      cpu_pct=0
      if [ -f "$RUN_DIR/cpu_$pid" ]; then
        prev=$(cat "$RUN_DIR/cpu_$pid")
        cpu_pct=$(awk -v c="$cs" -v p="$prev" -v poll="$POLL" 'BEGIN{ d=c-p; if(d<0)d=0; printf "%d", d*100/poll }')
      fi
      echo "$cs" > "$RUN_DIR/cpu_$pid"
      if [ "$cpu_pct" -ge "$HOT_CPU_PCT" ]; then
        streak=$(( $(cat "$RUN_DIR/hot_$pid" 2>/dev/null || echo 0) + POLL ))
        echo "$streak" > "$RUN_DIR/hot_$pid"
        if [ "$streak" -ge "$HOT_SECONDS" ]; then
          log "CPU 热度仅告警 pid=$pid cpu=${cpu_pct}% 持续=${streak}s；未发现独立资源压力，不发送终止信号"
          echo 0 > "$RUN_DIR/hot_$pid"
        fi
      else
        echo 0 > "$RUN_DIR/hot_$pid"
      fi
    done < "$RUN_DIR/now.txt"

    # Clean state files of vanished processes — ONLY when this scan actually
    # saw processes (never on empty/failed ps).
    # 仅在本次采样真实非空时清理消失进程的状态文件。
    if [ "$n_targets" -gt 0 ] || [ "$PREV_TARGET_COUNT" -eq 0 ]; then
      for sf in "$RUN_DIR"/cpu_* "$RUN_DIR"/hot_*; do
        [ -f "$sf" ] || continue
        spid="${sf##*/}"; spid="${spid#cpu_}"; spid="${spid#hot_}"
        if ! grep -qx "$spid" "$RUN_DIR/seen.txt" 2>/dev/null; then
          rm -f "$RUN_DIR/cpu_$spid" "$RUN_DIR/hot_$spid"
        fi
      done
    fi

  fi

  # Update host-pressure streaks before selecting RSS diagnostics. The
  # emergency Rule 5 observation has priority so the same target is not
  # recorded redundantly by both Rule 4 and Rule 5 in one scan.
  # 先更新主机压力连续计数；Rule 5 紧急观测优先，避免同轮重复记录。
  if [ "${now_free:-9999}" -lt "$MIN_AVAIL_MB" ]; then
    MEM_HOT_COUNT=$((MEM_HOT_COUNT + 1))
  else
    MEM_HOT_COUNT=0
  fi
  if awk -v l="$now_load" -v c="$LOAD_CEILING" 'BEGIN{exit !(l>c)}'; then
    LOAD_HOT_COUNT=$((LOAD_HOT_COUNT + 1))
  else
    LOAD_HOT_COUNT=0
  fi

  emergency_sweep=0
  if [ "$MEM_HOT_COUNT" -ge 2 ] || [ "$LOAD_HOT_COUNT" -ge 3 ]; then
    emergency_sweep=1
  fi

  # ── Rule 4: RSS and host-pressure diagnostics / RSS 与主机压力诊断 ──
  if [ "$total_rss_mb" -gt "$RSS_WARN_MB" ] && [ "$n_targets" -gt 0 ]; then
    warn_epoch=$(date +%s)
    if [ "$RSS_WARN_INTERVAL" -eq 0 ] || [ $((warn_epoch - RSS_LAST_WARN_EPOCH)) -ge "$RSS_WARN_INTERVAL" ]; then
      log "RSS 告警 targets=$n_targets total=${total_rss_mb}MB>${RSS_WARN_MB}MB avail=${now_free}MB load1=${now_load}；健康主机不发送终止信号"
      RSS_LAST_WARN_EPOCH=$warn_epoch
    fi
  fi

  if [ "$total_rss_mb" -gt "$RSS_WARN_MB" ] && [ "${now_free:-9999}" -lt "$PRESSURE_AVAIL_MB" ]; then
    RSS_PRESSURE_COUNT=$((RSS_PRESSURE_COUNT + 1))
  else
    RSS_PRESSURE_COUNT=0
  fi
  if [ "$MAX_TOTAL_RSS_HARD_MB" -gt 0 ] && [ "$total_rss_mb" -gt "$MAX_TOTAL_RSS_HARD_MB" ]; then
    RSS_HARD_COUNT=$((RSS_HARD_COUNT + 1))
  else
    RSS_HARD_COUNT=0
  fi

  if [ "$emergency_sweep" = "0" ] && [ "$n_targets" -gt 0 ]; then
    rss_reason=""
    if [ "$MAX_TOTAL_RSS_HARD_MB" -gt 0 ] && [ "$RSS_HARD_COUNT" -ge "$RSS_HARD_SAMPLES" ]; then
      rss_reason="总RSS ${total_rss_mb}MB 连续 ${RSS_HARD_COUNT} 次超过硬上限 ${MAX_TOTAL_RSS_HARD_MB}MB"
    elif [ "$RSS_PRESSURE_COUNT" -ge "$RSS_PRESSURE_SAMPLES" ]; then
      rss_reason="总RSS ${total_rss_mb}MB 且可用内存 ${now_free}MB<${PRESSURE_AVAIL_MB}MB 持续 ${RSS_PRESSURE_COUNT} 次"
    fi
    if [ -n "$rss_reason" ]; then
      biggest=$(sort -t'|' -k3 -rn "$RUN_DIR/now.txt" | head -1)
      bpid=$(echo "$biggest" | cut -d'|' -f1)
      record_target_diagnostic "$bpid" "${rss_reason}；记录最大目标" && TOTAL_DIAGNOSTICS=$((TOTAL_DIAGNOSTICS + 1))
      RSS_PRESSURE_COUNT=0
      RSS_HARD_COUNT=0
    fi
  fi

  # ── Rule 5: system pressure → record all targets / 规则5：系统压力全量诊断 ──
  if [ "$emergency_sweep" = "1" ]; then
    why="系统压力"
    [ "$MEM_HOT_COUNT" -ge 2 ] && why="$why 可用内存${now_free}MB<${MIN_AVAIL_MB}MB"
    [ "$LOAD_HOT_COUNT" -ge 3 ] && why="$why load1=${now_load}>${LOAD_CEILING}"
    log "$why → 记录全部 $n_targets 个目标进程供 owner 诊断"
    while IFS='|' read -r pid cs rss ppid cmd; do
      record_target_diagnostic "$pid" "$why" && TOTAL_DIAGNOSTICS=$((TOTAL_DIAGNOSTICS + 1))
    done < "$RUN_DIR/now.txt"
    MEM_HOT_COUNT=0; LOAD_HOT_COUNT=0
    RSS_PRESSURE_COUNT=0; RSS_HARD_COUNT=0
  fi

  reap_pending
  PREV_TARGET_COUNT=$n_targets
  if [ "$n_targets" -gt 0 ] || [ "$((SECONDS % 60))" -lt "$POLL" ]; then
    log "巡检 targets=$n_targets pi=$n_pi rss=${total_rss_mb}MB avail=${now_free}MB load1=$now_load"
  fi
  return 0
}
lock_field() {
  sed -n "s/^$1=//p" "$LOCK_DIR/owner" 2>/dev/null | head -1
}
status_field() {
  sed -n "s/.*$1=\([^ ]*\).*/\1/p" "$STATUS_FILE" 2>/dev/null | head -1
}
identity_alive() {
  local candidate_pid="$1" candidate_birth="$2" candidate_pgid="${3:-}" observed observed_birth observed_pgid probe_error; IDENTITY_PGID=""
  case "$candidate_pid" in ''|*[!0-9]*) return 2 ;; esac; [ -n "$candidate_birth" ] || return 2
  probe_error=$(kill -0 "$candidate_pid" 2>&1) || { case "$probe_error" in *"No such process"*|*ESRCH*) return 1 ;; *"Operation not permitted"*|*"Permission denied"*|*EPERM*) return 2 ;; esac; snapshot_pid_explicitly_absent "$candidate_pid" || return 2; return 1; }
  observed=$(snapshot_record "$candidate_pid" 2>/dev/null) || return 2
  observed_birth=${observed%%|*}; observed=${observed#*|}; observed_pgid=${observed%%|*}
  case "$observed_pgid" in ''|*[!0-9]*) return 2 ;; esac; IDENTITY_PGID="$observed_pgid"
  [ "$observed_birth" = "$candidate_birth" ] || return 3; [ -z "$candidate_pgid" ] || [ "$observed_pgid" = "$candidate_pgid" ] || return 3
  return 0
}
write_lifecycle_status() {
  local state="$1" error="$2" status_pid="$3" status_birth="$4"
  local status_mode="$5" status_owner="$6" stop_token="$7"
  local status_tmp="$STATUS_FILE.${SELF_PID}.tmp"
  if ! printf 'alive=%s sample_ok=0 sample_error=%s state=%s watchdog_pid=%s watchdog_birth=%s owner_mode=%s owner_token=%s stop_token=%s targets=unknown pi=unknown avail_mb=unknown load1=unknown kills=%s dry_run=%s\n' \
      "$(date +%s)" "$error" "$state" "$status_pid" "$status_birth" "$status_mode" \
      "$status_owner" "$stop_token" "$TOTAL_KILLS" "$DRY_RUN" > "$status_tmp" ||
     ! mv -f "$status_tmp" "$STATUS_FILE"; then
    rm -f "$status_tmp" 2>/dev/null || true
    return 1
  fi
  [ "$(status_field state)" = "$state" ] &&
    [ "$(status_field watchdog_pid)" = "$status_pid" ] &&
    [ "$(status_field watchdog_birth)" = "$status_birth" ] &&
    [ "$(status_field owner_token)" = "$status_owner" ] &&
    [ "$(status_field stop_token)" = "$stop_token" ]
}
write_unhealthy_status() {
  write_lifecycle_status unhealthy "$1" "$SELF_PID" "${SELF_BIRTH:-unknown}" \
    "$WATCHDOG_MODE" "$OWNER_TOKEN" none
}
reap_zombie_child() {
  case "$(/bin/ps -o stat= -p "$1" 2>/dev/null | tr -d ' ')" in Z*) wait "$1" 2>/dev/null || true; ! kill -0 "$1" 2>/dev/null; return ;; esac
  return 1
}
recorded_identity_is_consistent() {
  RECORDED_PID=$(lock_field pid)
  RECORDED_BIRTH=$(lock_field birth)
  RECORDED_TOKEN=$(lock_field token)
  RECORDED_MODE=$(lock_field mode)
  case "$RECORDED_PID" in ''|*[!0-9]*) return 1 ;; esac
  [ -n "$RECORDED_BIRTH" ] && [ -n "$RECORDED_TOKEN" ] || return 1
  [ "$(cat "$PIDFILE" 2>/dev/null || echo '')" = "$RECORDED_PID" ] || return 1
  [ "$(status_field watchdog_pid)" = "$RECORDED_PID" ] || return 1
  [ "$(status_field watchdog_birth)" = "$RECORDED_BIRTH" ] || return 1
  [ "$(status_field owner_token)" = "$RECORDED_TOKEN" ] || return 1
  return 0
}
show_verified_status() {
  if [ ! -f "$LOCK_DIR/owner" ]; then
    if [ -d "$LOCK_DIR" ]; then
      echo "state=unknown verified=0 reason=ownerless_lock"
      return 4
    fi
    if [ -f "$PIDFILE" ] || [ "$(status_field state)" = "running" ]; then
      echo "state=unknown verified=0 reason=ownership_files_disagree"
      return 4
    fi
    echo "state=stopped verified=1 reason=no_owner"
    return 3
  fi
  if ! recorded_identity_is_consistent; then
    echo "state=unknown verified=0 reason=identity_mismatch"
    return 4
  fi
  local identity_state
  identity_alive "$RECORDED_PID" "$RECORDED_BIRTH"; identity_state=$?
  case "$identity_state" in
    1) echo "state=stale verified=0 reason=owner_not_alive watchdog_pid=$RECORDED_PID owner_token=$RECORDED_TOKEN"; return 3 ;;
    2) echo "state=unknown verified=0 reason=identity_unobservable watchdog_pid=$RECORDED_PID owner_token=$RECORDED_TOKEN"; return 4 ;;
    3) echo "state=unknown verified=0 reason=identity_mismatch watchdog_pid=$RECORDED_PID owner_token=$RECORDED_TOKEN"; return 4 ;;
  esac

  local alive now age sample_ok state
  alive=$(status_field alive)
  sample_ok=$(status_field sample_ok)
  state=$(status_field state)
  case "$alive" in ''|*[!0-9]*)
    echo "state=unknown verified=0 reason=invalid_heartbeat watchdog_pid=$RECORDED_PID owner_token=$RECORDED_TOKEN"
    return 4
    ;;
  esac
  now=$(date +%s)
  age=$((now - alive))
  if [ "$state" != "running" ] || [ "$sample_ok" != "1" ] || [ "$age" -lt 0 ] || [ "$age" -gt "${WATCHDOG_MAX_AGE:-30}" ]; then
    echo "state=stale verified=0 reason=unhealthy_heartbeat watchdog_pid=$RECORDED_PID owner_token=$RECORDED_TOKEN heartbeat_age=$age"
    return 3
  fi
  echo "state=running verified=1 watchdog_pid=$RECORDED_PID watchdog_birth=$RECORDED_BIRTH owner_mode=${RECORDED_MODE:-unknown} owner_token=$RECORDED_TOKEN heartbeat_age=$age"
  return 0
}; stopped_proof_matches() {
  [ ! -f "$LOCK_DIR/owner" ] && [ ! -f "$PIDFILE" ] && [ "$(status_field state)" = stopped ] && [ "$(status_field watchdog_pid)" = "$1" ] && [ "$(status_field watchdog_birth)" = "$2" ] && [ "$(status_field owner_token)" = "$3" ] && [ "$(status_field stop_token)" = "$4" ]
}
stop_recorded_watchdog() {
  if [ ! -f "$LOCK_DIR/owner" ]; then
    if [ -d "$LOCK_DIR" ]; then
      echo "state=unknown verified=0 reason=ownerless_lock; refusing_to_signal=1" >&2
      return 4
    fi
    if [ -f "$PIDFILE" ] || [ "$(status_field state)" = "running" ]; then
      echo "state=unknown verified=0 reason=ownership_files_disagree; refusing_to_signal=1" >&2
      return 4
    fi
    echo "state=stopped verified=1 reason=no_owner"
    return 0
  fi
  if ! recorded_identity_is_consistent; then
    echo "state=unknown verified=0 reason=identity_mismatch; refusing_to_signal=1" >&2
    return 4
  fi
  if [ -n "${CANVAST_WATCHDOG_EXPECTED_PID:-}${CANVAST_WATCHDOG_EXPECTED_BIRTH:-}${CANVAST_WATCHDOG_EXPECTED_OWNER_TOKEN:-}" ] &&
     { [ "$RECORDED_PID" != "${CANVAST_WATCHDOG_EXPECTED_PID:-}" ] || [ "$RECORDED_BIRTH" != "${CANVAST_WATCHDOG_EXPECTED_BIRTH:-}" ] || [ "$RECORDED_TOKEN" != "${CANVAST_WATCHDOG_EXPECTED_OWNER_TOKEN:-}" ]; }; then
    echo "state=unknown verified=0 reason=owner_changed; refusing_to_signal=1" >&2; return 4
  fi
  local stop_pid="$RECORDED_PID" stop_birth="$RECORDED_BIRTH" owner_token="$RECORDED_TOKEN"
  local stop_token="stop-${SELF_PID}-$(date +%s)-${RANDOM}" request="$LOCK_DIR/stop-request"
  local request_tmp="$request.${SELF_PID}.tmp" attempt=0 identity_state stop_pgid
  identity_alive "$stop_pid" "$stop_birth"; identity_state=$?; stop_pgid="${IDENTITY_PGID:-}"
  case "$identity_state" in
    2) echo "state=unknown verified=0 reason=identity_unobservable; refusing_to_signal=1" >&2; return 4 ;;
    3) echo "state=unknown verified=0 reason=identity_mismatch; refusing_to_signal=1" >&2; return 4 ;;
  esac
  if [ ! -f "$request" ]; then
    printf 'pid=%s\nbirth=%s\nowner_token=%s\nstop_token=%s\n' \
      "$stop_pid" "$stop_birth" "$owner_token" "$stop_token" > "$request_tmp" || return 125
    ln "$request_tmp" "$request" 2>/dev/null || true
    rm -f "$request_tmp" || return 125
  fi
  if stopped_proof_matches "$stop_pid" "$stop_birth" "$owner_token" "$stop_token"; then
    echo "state=stopped verified=1 watchdog_pid=$stop_pid owner_token=$owner_token stop_token=$stop_token"; return 0
  fi
  local request_pid request_birth request_owner request_token proof_token
  request_pid=$(sed -n 's/^pid=//p' "$request" 2>/dev/null | head -1)
  request_birth=$(sed -n 's/^birth=//p' "$request" 2>/dev/null | head -1)
  request_owner=$(sed -n 's/^owner_token=//p' "$request" 2>/dev/null | head -1)
  request_token=$(sed -n 's/^stop_token=//p' "$request" 2>/dev/null | head -1)
  if [ "$request_pid" != "$stop_pid" ] || [ "$request_birth" != "$stop_birth" ] ||
     [ "$request_owner" != "$owner_token" ]; then
    proof_token=$(status_field stop_token)
    case "$proof_token" in stop-[A-Za-z0-9._-]*)
      stopped_proof_matches "$stop_pid" "$stop_birth" "$owner_token" "$proof_token" &&
        { echo "state=stopped verified=1 watchdog_pid=$stop_pid owner_token=$owner_token stop_token=$proof_token"; return 0; }
      ;;
    esac
    echo "state=unknown verified=0 reason=owner_changed; refusing_to_signal=1" >&2; return 4
  fi
  case "$request_token" in stop-[A-Za-z0-9._-]*) stop_token="$request_token" ;; *) return 125 ;; esac
  if [ "$identity_state" = 0 ]; then
    while [ "$attempt" -lt 80 ]; do
      identity_alive "$stop_pid" "$stop_birth" "$stop_pgid"; identity_state=$?
      [ "$identity_state" = 0 ] || break
      if stopped_proof_matches "$stop_pid" "$stop_birth" "$owner_token" "$stop_token"; then
        echo "state=stopped verified=1 watchdog_pid=$stop_pid owner_token=$owner_token stop_token=$stop_token"; return 0
      fi
      if ! recorded_identity_is_consistent || [ "$RECORDED_TOKEN" != "$owner_token" ]; then
        if stopped_proof_matches "$stop_pid" "$stop_birth" "$owner_token" "$stop_token"; then
          echo "state=stopped verified=1 watchdog_pid=$stop_pid owner_token=$owner_token stop_token=$stop_token"; return 0
        fi
        echo "state=unknown verified=0 reason=owner_changed; refusing_to_escalate=1" >&2; return 4
      fi
      /bin/sleep 0.05; attempt=$((attempt + 1))
    done
    if [ "$identity_state" = 0 ]; then
      echo "state=unknown verified=0 reason=cooperative_stop_timeout watchdog_pid=$stop_pid owner_token=$owner_token" >&2
      return 1
    fi
  fi
  if [ "$identity_state" = 2 ]; then
    attempt=0
    while [ "$attempt" -lt 20 ] && ! stopped_proof_matches "$stop_pid" "$stop_birth" "$owner_token" "$stop_token"; do /bin/sleep 0.05; attempt=$((attempt + 1)); done
  fi
  if stopped_proof_matches "$stop_pid" "$stop_birth" "$owner_token" "$stop_token"; then
    echo "state=stopped verified=1 watchdog_pid=$stop_pid owner_token=$owner_token stop_token=$stop_token"; return 0
  fi
  case "$identity_state" in
    0) echo "state=unknown verified=0 reason=owner_still_alive watchdog_pid=$stop_pid owner_token=$owner_token" >&2; return 1 ;;
    1) echo "state=unknown verified=0 reason=owner_died_without_stop_ack watchdog_pid=$stop_pid owner_token=$owner_token; ownership_preserved=1" >&2; return 4 ;;
    2) echo "state=unknown verified=0 reason=identity_unobservable; refusing_to_escalate=1" >&2; return 4 ;;
    3) echo "state=unknown verified=0 reason=owner_changed; refusing_to_escalate=1" >&2; return 4 ;;
  esac
  return 4
}
acquire_lock() {
  local old_pid old_birth identity_state stale_lock owner_tmp pid_tmp stale_index=0
  [ -n "$SELF_BIRTH" ] || { log "watchdog 无法确认自身启动身份，拒绝取得锁"; return 1; }
  exec 9>>"$STATE_DIR/watchdog-recovery.lock" || return 125
  if ! /usr/bin/lockf -s -t 0 9; then
    exec 9>&-; log "watchdog stale-lock recovery 已由另一 contender 执行"; return 3
  fi
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    if [ -f "$LOCK_DIR/owner" ]; then
      old_pid=$(lock_field pid); old_birth=$(lock_field birth)
      identity_alive "$old_pid" "$old_birth"; identity_state=$?
      if [ "$identity_state" != 1 ] && [ "$identity_state" != 3 ]; then
        exec 9>&-
        if [ "$identity_state" = 0 ]; then log "已有 watchdog 在运行 (pid=${old_pid})，本实例退出"
        else log "watchdog owner 身份不可安全回收 (pid=${old_pid:-unknown} state=$identity_state)，本实例退出"; fi
        return 3
      fi
    else
      old_pid=""
    fi
    stale_lock="$STATE_DIR/watchdog.lock.stale.${SELF_PID}.${stale_index}"
    while [ -e "$stale_lock" ]; do stale_index=$((stale_index + 1)); stale_lock="$STATE_DIR/watchdog.lock.stale.${SELF_PID}.${stale_index}"; done
    mv "$LOCK_DIR" "$stale_lock" 2>/dev/null || { exec 9>&-; return 125; }
    if [ -z "$old_pid" ] || [ "$(cat "$PIDFILE" 2>/dev/null || echo '')" = "$old_pid" ]; then
      rm -f "$PIDFILE" || { exec 9>&-; return 125; }
    fi
    rm -f "$stale_lock"/* 2>/dev/null || true
    rmdir "$stale_lock" 2>/dev/null || true
    mkdir "$LOCK_DIR" 2>/dev/null || { exec 9>&-; return 125; }
  fi
  owner_tmp="$LOCK_DIR/owner.${SELF_PID}.tmp"; pid_tmp="$PIDFILE.${SELF_PID}.tmp"
  if ! printf 'pid=%s\nbirth=%s\ntoken=%s\nmode=%s\n' \
      "$SELF_PID" "$SELF_BIRTH" "$OWNER_TOKEN" "$WATCHDOG_MODE" > "$owner_tmp" ||
     ! mv "$owner_tmp" "$LOCK_DIR/owner" || ! printf '%s\n' "$SELF_PID" > "$pid_tmp" ||
     ! mv "$pid_tmp" "$PIDFILE" || [ "$(lock_field pid)" != "$SELF_PID" ] ||
     [ "$(lock_field birth)" != "$SELF_BIRTH" ] || [ "$(lock_field token)" != "$OWNER_TOKEN" ] ||
     [ "$(cat "$PIDFILE" 2>/dev/null || echo '')" != "$SELF_PID" ]; then
    rm -f "$owner_tmp" "$pid_tmp" "$LOCK_DIR/owner" "$PIDFILE" 2>/dev/null || true
    rmdir "$LOCK_DIR" 2>/dev/null || true
    LOCK_OWNED=0; exec 9>&-; log "watchdog 锁发布未完成，已回滚"; return 125
  fi
  LOCK_OWNED=1; exec 9>&-; return 0
}
write_stopped_status() {
  local stop_token=none request="$LOCK_DIR/stop-request" req_pid req_birth req_owner
  [ "$(status_field owner_token)" = "$OWNER_TOKEN" ] || return 125
  if [ "$(status_field state)" = unhealthy ] &&
     [ "$(status_field sample_error)" = parent_identity_unobservable ]; then
    return 0
  fi
  if [ -f "$request" ]; then
    req_pid=$(sed -n 's/^pid=//p' "$request" 2>/dev/null | head -1)
    req_birth=$(sed -n 's/^birth=//p' "$request" 2>/dev/null | head -1)
    req_owner=$(sed -n 's/^owner_token=//p' "$request" 2>/dev/null | head -1)
    stop_token=$(sed -n 's/^stop_token=//p' "$request" 2>/dev/null | head -1)
    [ "$req_pid" = "$SELF_PID" ] && [ "$req_birth" = "$SELF_BIRTH" ] &&
      [ "$req_owner" = "$OWNER_TOKEN" ] || return 125
    case "$stop_token" in stop-[A-Za-z0-9._-]*) ;; *) return 125 ;; esac
  fi
  write_lifecycle_status stopped watchdog_stopped "$SELF_PID" "$SELF_BIRTH" \
    "$WATCHDOG_MODE" "$OWNER_TOKEN" "$stop_token"
}
detach_owned_lock() {
  local expected_pid="$1" expected_birth="$2" expected_token="$3" lifecycle="$4" stop_token="$5"
  local current_pid current_birth current_token isolated index=0 cleanup_rc=0
  exec 9>>"$STATE_DIR/watchdog-recovery.lock" || return 125
  if ! /usr/bin/lockf -s -t 0 9; then exec 9>&-; return 3; fi
  current_pid=$(lock_field pid); current_birth=$(lock_field birth); current_token=$(lock_field token)
  if [ "$current_pid" != "$expected_pid" ] || [ "$current_birth" != "$expected_birth" ] ||
     [ "$current_token" != "$expected_token" ]; then exec 9>&-; return 4; fi
  [ "$(cat "$PIDFILE" 2>/dev/null || echo '')" = "$expected_pid" ] || { exec 9>&-; return 4; }
  if [ "$lifecycle" = stopped ]; then
    identity_alive "$expected_pid" "$expected_birth"; [ "$?" = 1 ] || { exec 9>&-; return 4; }
    write_lifecycle_status stopped watchdog_stopped "$expected_pid" "$expected_birth" \
      "${RECORDED_MODE:-unknown}" "$expected_token" "$stop_token" || { exec 9>&-; return 125; }
  fi
  isolated="$STATE_DIR/watchdog.lock.released.${SELF_PID}.${index}"
  while [ -e "$isolated" ]; do index=$((index + 1)); isolated="$STATE_DIR/watchdog.lock.released.${SELF_PID}.${index}"; done
  mv "$LOCK_DIR" "$isolated" 2>/dev/null || { exec 9>&-; return 125; }
  rm -f "$PIDFILE" || cleanup_rc=125
  [ ! -e "$PIDFILE" ] || cleanup_rc=125
  rm -f "$isolated"/* 2>/dev/null || cleanup_rc=125
  rmdir "$isolated" 2>/dev/null || cleanup_rc=125
  exec 9>&-
  return "$cleanup_rc"
}
release_lock() {
  [ "$LOCK_OWNED" = "1" ] || return 0
  local current_pid current_birth current_token
  current_pid=$(lock_field pid)
  current_birth=$(lock_field birth)
  current_token=$(lock_field token)
  if [ "$current_pid" != "$SELF_PID" ] || [ "$current_birth" != "$SELF_BIRTH" ] ||
     [ "$current_token" != "$OWNER_TOKEN" ]; then LOCK_OWNED=0; return 0; fi
  if [ -f "$LOCK_DIR/stop-request" ]; then
    [ "$(sed -n 's/^pid=//p' "$LOCK_DIR/stop-request" 2>/dev/null | head -1)" = "$SELF_PID" ] &&
      [ "$(sed -n 's/^owner_token=//p' "$LOCK_DIR/stop-request" 2>/dev/null | head -1)" = "$OWNER_TOKEN" ] || return 125
  fi
  detach_owned_lock "$SELF_PID" "$SELF_BIRTH" "$OWNER_TOKEN" none none
  local detach_rc=$?
  [ "$detach_rc" = 0 ] || return 125
  LOCK_OWNED=0
  return 0
}
watchdog_cleanup() {
  [ "$STOPPING" = "0" ] || return 0
  STOPPING=1
  trap - EXIT
  trap '' HUP INT QUIT TERM
  if [ -n "$WATCHDOG_SLEEP_PID" ]; then
    local sleep_state sleep_attempt=0
    reap_zombie_child "$WATCHDOG_SLEEP_PID" || true
    identity_alive "$WATCHDOG_SLEEP_PID" "$WATCHDOG_SLEEP_BIRTH"; sleep_state=$?
    if [ "$sleep_state" = 0 ]; then
      kill -TERM "$WATCHDOG_SLEEP_PID" 2>/dev/null || true
      while [ "$sleep_attempt" -lt 20 ] && [ "$sleep_state" = 0 ]; do
        reap_zombie_child "$WATCHDOG_SLEEP_PID" || /bin/sleep 0.05
        identity_alive "$WATCHDOG_SLEEP_PID" "$WATCHDOG_SLEEP_BIRTH"; sleep_state=$?
        sleep_attempt=$((sleep_attempt + 1))
      done
      if [ "$sleep_state" = 0 ]; then
        kill -KILL "$WATCHDOG_SLEEP_PID" 2>/dev/null || true
        sleep_attempt=0
        while [ "$sleep_attempt" -lt 20 ] && [ "$sleep_state" = 0 ]; do
          reap_zombie_child "$WATCHDOG_SLEEP_PID" || /bin/sleep 0.05
          identity_alive "$WATCHDOG_SLEEP_PID" "$WATCHDOG_SLEEP_BIRTH"; sleep_state=$?
          sleep_attempt=$((sleep_attempt + 1))
        done
      fi
    fi
    if [ "$sleep_state" = 1 ]; then wait "$WATCHDOG_SLEEP_PID" 2>/dev/null || true; else
      log "watchdog 等待子进程未在有界 TERM→KILL 后退出 pid=$WATCHDOG_SLEEP_PID"
      return 125
    fi
    WATCHDOG_SLEEP_PID=""
    WATCHDOG_SLEEP_BIRTH=""
  fi
  write_stopped_status || return 125
  release_lock || return 125
  log "watchdog 退出 pid=$SELF_PID mode=$WATCHDOG_MODE"
  return 0
}
on_watchdog_signal() {
  exit "$1"
}
parent_alive() {
  [ "$WATCHDOG_MODE" = "owned" ] || return 0
  identity_alive "$PARENT_PID" "$PARENT_BIRTH"
}
sweep_after_parent_loss() {
  scan_once >/dev/null 2>&1 || return 125
  while IFS='|' read -r pid cs rss ppid cmd; do
    [ -n "$pid" ] || continue
    if is_target "$cmd" "$pid"; then
      record_target_diagnostic "$pid" "safe-run owner disappeared" || return 125
    fi
  done < "$RUN_DIR/now.txt"
  return 0
}
watchdog_sleep() {
  # Short foreground slices make cooperative stop prompt without leaving a
  # poll sleeper for cleanup to signal across macOS PID-reuse boundaries.
  local slices=$((POLL * 20))
  while [ "$slices" -gt 0 ]; do
    stop_requested && exit 0
    /bin/sleep 0.05 || return 1
    slices=$((slices - 1))
  done
  return 0
}
stop_requested() {
  local request="$LOCK_DIR/stop-request" stop_token
  [ -f "$request" ] || return 1
  stop_token=$(sed -n 's/^stop_token=//p' "$request" 2>/dev/null | head -1)
  case "$stop_token" in stop-[A-Za-z0-9._-]*) ;; *) return 1 ;; esac
  [ "$(sed -n 's/^pid=//p' "$request" 2>/dev/null | head -1)" = "$SELF_PID" ] &&
    [ "$(sed -n 's/^birth=//p' "$request" 2>/dev/null | head -1)" = "$SELF_BIRTH" ] &&
    [ "$(sed -n 's/^owner_token=//p' "$request" 2>/dev/null | head -1)" = "$OWNER_TOKEN" ]
}
if [ "$WATCHDOG_ACTION" = "status" ]; then
  show_verified_status
  exit $?
fi
if [ "$WATCHDOG_ACTION" = "stop" ]; then
  stop_recorded_watchdog
  exit $?
fi
mkdir -p "$STATE_DIR" "$RUN_DIR"
log "════ watchdog 启动 pid=$SELF_PID mode=$WATCHDOG_MODE dry_run=$DRY_RUN poll=${POLL}s 阈值: pi≤${MAX_PI_PROCS}/${HARD_PI_PROCS} cpu_warn≥${HOT_CPU_PCT}%×${HOT_SECONDS}s rss_warn>${RSS_WARN_MB}MB pressure_avail<${PRESSURE_AVAIL_MB}MB rss_hard=${MAX_TOTAL_RSS_HARD_MB}MB emergency_avail≥${MIN_AVAIL_MB}MB load≤$LOAD_CEILING ════"

if [ "$ONCE_MODE" != "1" ]; then
  acquire_lock; acquire_rc=$?
  [ "$acquire_rc" = 0 ] || { [ "$acquire_rc" = 3 ] && exit 0; exit 125; }
  trap 'watchdog_cleanup || { trap - EXIT; exit 125; }' EXIT
  trap 'on_watchdog_signal 129' HUP
  trap 'on_watchdog_signal 130' INT
  trap 'on_watchdog_signal 131' QUIT
  trap 'on_watchdog_signal 143' TERM
  # Volatile sampling state may be reset by the new owner. Any pre-monitor-only
  # TERM ledgers are untrusted input and are quarantined before normal polling.
  rm -f "$RUN_DIR"/cpu_* "$RUN_DIR"/hot_* 2>/dev/null
  reap_pending || log "存在无法隔离的旧 TERM ledger；后续轮询将重试"
fi
if [ "$ONCE_MODE" = "1" ]; then
  once_rc=0
  scan_once || once_rc=$?
  # A one-shot scan owns an isolated diagnostic directory. Quarantine any old
  # TERM ledgers without inheriting their historical signaling authority.
  once_pending=0
  for once_marker in "$RUN_DIR"/term_*; do [ -f "$once_marker" ] && { once_pending=1; break; }; done
  [ "$once_pending" = "0" ] || reap_pending || once_rc=125
  once_pending=0
  for once_marker in "$RUN_DIR"/term_*; do [ -f "$once_marker" ] && { once_pending=1; break; }; done
  [ "$once_pending" = "0" ] || once_rc=125
  rm -f "$RUN_DIR"/now.txt "$RUN_DIR"/seen.txt "$RUN_DIR"/cpu_* "$RUN_DIR"/hot_* 2>/dev/null
  [ "$once_pending" = "1" ] || rmdir "$RUN_DIR" 2>/dev/null || true
  exit "$once_rc"
fi
while true; do
  stop_requested && exit 0
  parent_alive; parent_state=$?
  if [ "$parent_state" = 2 ]; then
    write_unhealthy_status parent_identity_unobservable || exit 125
    log "safe-run owner 身份不可观测，拒绝误判为消失"
    watchdog_sleep || exit 1
    continue
  fi
  if [ "$parent_state" != 0 ]; then
    log "safe-run owner 已消失或身份变化，执行有界清扫后退出"
    sweep_after_parent_loss || { log "safe-run owner 消失后的有界清扫未完成"; exit 125; }
    exit 0
  fi
  scan_once || exit 125
  watchdog_sleep || exit 1
done
