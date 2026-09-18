#!/bin/bash
# Canvast — Safe Run / Canvast 源文件
# @file        scripts/safe-run.sh
# @brief       Canvast-owned source file.
# @description Part of the Canvast product codebase. Keep provenance and
#              license headers explicit for commercial redistribution.
# @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
# safe-run.sh — preflight risk assessment + resource fence / 启动前风险评估 + 资源围栏
# Commands that spawn workers pass through preflight, a private process group,
# bounded cleanup, and watchdog lifecycle.
# Usage: safe-run.sh [--protocol-stdout-jsonl] [--timeout seconds] -- command...
set -u
TIMEOUT=300; PROTOCOL_STDOUT_JSONL=0; REQUIRE_EXTERNAL_WATCHDOG=0
usage() { echo "用法: safe-run.sh [--timeout 秒] -- 命令..." >&2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --protocol-stdout-jsonl) PROTOCOL_STDOUT_JSONL=1; shift ;;
    --require-external-watchdog) REQUIRE_EXTERNAL_WATCHDOG=1; shift ;;
    --timeout)
      case "${2:-}" in ''|*[!0-9]*) usage; exit 2 ;; esac
      [ "$2" -gt 0 ] || { usage; exit 2; }
      TIMEOUT="$2"; shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done
# Protocol mode keeps wrapper messages on stderr and child stdout untouched.
wrapper_log() {
  if [ "$PROTOCOL_STDOUT_JSONL" = "1" ]; then
    printf '%s\n' "$*" >&2
  else
    printf '%s\n' "$*"
  fi
}
# macOS 的 "free" 常年极低，可用内存按 free+inactive 计
avail_mem_mb() {
  local raw
  raw=$(vm_stat 2>/dev/null) || return 1
  [ -n "$raw" ] || return 1
  echo "$raw" | awk '/page size of/ {ps=$8}
    /Pages free/     {gsub(/\./,""); f=$3; have_f=1}
    /Pages inactive/ {gsub(/\./,""); i=$3; have_i=1}
    END {
      if (ps !~ /^[0-9]+$/ || !have_f || !have_i) exit 1;
      print int((f+i)*ps/1048576)
    }'
}
[ $# -gt 0 ] || { usage; exit 2; }
CANVAST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${CANVAST_RESOURCE_STATE_DIR:-$CANVAST_DIR/.pi}"
STATUS_FILE="$STATE_DIR/watchdog.status"; WATCHDOG="$CANVAST_DIR/scripts/resource-watchdog.sh"
WATCHDOG_LOCK="$STATE_DIR/watchdog.lock"
SAFE_RUN_LOCK="$STATE_DIR/safe-run.lock"
GUI_GUARD="$CANVAST_DIR/scripts/unattended-gui-guard.sh"
PROCESS_SNAPSHOT="$CANVAST_DIR/scripts/process-snapshot.py"
OWNED_HANDLE_FALLBACK_WRITER="$CANVAST_DIR/scripts/write-owned-handle-fallback.mjs"
PROCESS_SNAPSHOT_PYTHON="${CANVAST_PROCESS_SNAPSHOT_PYTHON:-/usr/bin/python3}"
PROCESS_SNAPSHOT_FORCE_HELPER="${CANVAST_PROCESS_SNAPSHOT_FORCE_HELPER:-0}"
MAX_PRE_PI=2          # 启动前允许的现存 pi 进程数
MAX_PRE_LOAD=10       # 启动前允许的 load1
MIN_PRE_AVAIL_MB=2048 # 启动前要求的最低可用内存（free+inactive）
WATCHDOG_MAX_AGE=30
WATCHDOG_START_ATTEMPTS="${CANVAST_WATCHDOG_START_ATTEMPTS:-50}"
CHILD_TERM_GRACE_ATTEMPTS="${CANVAST_SAFE_RUN_CHILD_TERM_GRACE_ATTEMPTS:-120}"
OWNED_WATCHDOG_PID=""; OWNED_WATCHDOG_BIRTH=""; OWNED_WATCHDOG_PGID=""
OWNED_WATCHDOG_GROUP_OWNED=0
OWNED_WATCHDOG_MEMBER_PID=""; OWNED_WATCHDOG_MEMBER_BIRTH=""; OWNED_WATCHDOG_MEMBER_PGID=""
OWNED_WATCHDOG_MEMBER_RECORD=""
OWNED_WATCHDOG_START_GATE=""
OWNED_WATCHDOG_CONTINUITY_REQUIRED=0
OWNED_WATCHDOG_TOKEN=""
GUI_GUARD_PID=""; GUI_GUARD_BIRTH=""; GUI_GUARD_PGID=""; GUI_GUARD_UNCONFIRMED=0
CHILD=""; CHILD_BIRTH=""; CHILD_PGID=""; CHILD_UNCONFIRMED=0
CHILD_GROUP_OWNED=0
CHILD_MEMBER_PID=""; CHILD_MEMBER_BIRTH=""; CHILD_MEMBER_PGID=""
CHILD_MEMBER_RECORD=""
CHILD_START_GATE=""
CHILD_START_GATE_TIMEOUT="${CANVAST_CHILD_START_GATE_TIMEOUT:-10}"
TIMER=""; TIMER_BIRTH=""; TIMER_PGID=""; TIMER_UNCONFIRMED=0; TIMER_CONTROL=""; TIMEOUT_PENDING=""; UNCONFIRMED_DIAGNOSTIC=""; CHILD_OWNED_HANDLE_SNAPSHOT=""; CHILD_OWNED_HANDLE_INVOCATION_ID=""; CHILD_TERMINATION_REQUESTED=0
CLEANED=0
SAFE_RUN_PID=$$
SAFE_RUN_BIRTH=""; SAFE_RUN_PGID=""
SAFE_RUN_OWNER_TOKEN=""; SAFE_RUN_OWNER_COMMAND=""
SAFE_RUN_LOCK_OWNED=0
case "$STATE_DIR" in /*) ;; *) wrapper_log "✗ CANVAST_RESOURCE_STATE_DIR must be absolute" >&2; exit 2 ;; esac
mkdir -p "$STATE_DIR"
case "$CHILD_START_GATE_TIMEOUT" in
  ''|*[!0-9]*) CHILD_START_GATE_TIMEOUT=10 ;;
esac
[ "$CHILD_START_GATE_TIMEOUT" -gt 0 ] || CHILD_START_GATE_TIMEOUT=10
case "$CHILD_TERM_GRACE_ATTEMPTS" in ''|*[!0-9]*) CHILD_TERM_GRACE_ATTEMPTS=120 ;; esac
[ "$CHILD_TERM_GRACE_ATTEMPTS" -gt 0 ] || CHILD_TERM_GRACE_ATTEMPTS=120

snapshot_record() {
  local snapshot_pid="$1"
  # Existing shell-function mocks remain useful for isolated lifecycle tests.
  # Production always goes through the helper so ps and libproc emit the same
  # exact start_sec.start_usec identity representation.
  local ps_path
  ps_path=$(command -v ps 2>/dev/null || echo "")
  if [ "$PROCESS_SNAPSHOT_FORCE_HELPER" != "1" ] && type ps 2>/dev/null | grep -q 'function'; then
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
snapshot_all_protocol_rows() { local protocol
  [ -f "$PROCESS_SNAPSHOT" ] || return 1; protocol=$("$PROCESS_SNAPSHOT_PYTHON" "$PROCESS_SNAPSHOT" --all 2>/dev/null) || return 1; [ -n "$protocol" ] || return 1
  printf '%s\n' "$protocol" | awk -F '\t' 'function d(v){return v~/^(0|[1-9][0-9]*)$/} NR==1{h=$0=="CANVAST_PROCESS_SNAPSHOT_V1";next} NR==2{f=$0=="pid\tppid\tpgid\tstart_sec\tstart_usec\trss_bytes\tcpu_usec\tcommand";next} NR>2{if(!h||!f||NF!=8||!d($1)||$1=="0"||!d($2)||!d($3)||!d($4)||!d($5)||length($5)>6||(length($5)==6&&$5>"999999")||!d($6)||!d($7)||index($0,"\r")||seen[$1]++){bad=1;next} print;rows++} END{if(!h||!f||bad||rows<1||NR!=rows+2)exit 1}'
}
snapshot_pid_explicitly_absent() { local rows; rows=$(snapshot_all_protocol_rows) || return 1; printf '%s\n' "$rows" | awk -F '\t' -v pid="$1" '$1 == pid { found=1 } END { exit found ? 1 : 0 }'; }
snapshot_all_commands() {
  local ps_path
  ps_path=$(command -v ps 2>/dev/null || echo "")
  if [ "$PROCESS_SNAPSHOT_FORCE_HELPER" != "1" ] && { type ps 2>/dev/null | grep -q 'function' || { [ -n "$ps_path" ] && [ "$ps_path" != "/bin/ps" ] && [ "$ps_path" != "/usr/bin/ps" ]; }; }; then
    ps -eo command= 2>/dev/null
    return $?
  fi
  local rows
  rows=$(snapshot_all_protocol_rows) || return 1
  printf '%s\n' "$rows" | awk -F '\t' '{
      command=$8; for (i=9; i<=NF; i++) command=command "\t" $i;
      print command
    }
  '
}
process_identity_state() {
  local pid="$1" birth="$2" expected_pgid="${3:-}" observed current_birth current_pgid probe_error
  case "$pid" in ''|*[!0-9]*) return 2 ;; esac; [ "$pid" -gt 1 ] || return 2
  [ -n "$birth" ] || return 2
  probe_error=$(kill -0 "$pid" 2>&1) || { case "$probe_error" in *"No such process"*|*ESRCH*) return 1 ;; *"Operation not permitted"*|*"Permission denied"*|*EPERM*) return 2 ;; esac; snapshot_pid_explicitly_absent "$pid" || return 2; return 1; }
  observed=$(snapshot_record "$pid" 2>/dev/null) || return 2; current_birth=${observed%%|*}; [ -n "$current_birth" ] || return 2; [ "$current_birth" = "$birth" ] || return 3
  [ "$#" -lt 3 ] && return 0
  case "$expected_pgid" in ''|*[!0-9]*) return 2 ;; esac; [ "$expected_pgid" -gt 1 ] || return 2
  observed=${observed#*|}; current_pgid=${observed%%|*}
  [ -n "$current_pgid" ] || return 2; [ "$current_pgid" = "$expected_pgid" ] || return 3
}
process_identity_matches() { process_identity_state "$@"; }
reap_zombie_child() {
  case "$(/bin/ps -o stat= -p "$1" 2>/dev/null | tr -d ' ')" in Z*) wait "$1" 2>/dev/null || true; ! kill -0 "$1" 2>/dev/null; return ;; esac
  return 1
}
trusted_snapshot_backend() { PROCESS_SNAPSHOT_FORCE_HELPER=1 snapshot_record "$SAFE_RUN_PID" >/dev/null 2>&1; }
# Keep one exact inert member so an owned PGID cannot disappear and be reused.
group_continuity_member() {
  local gate_path="$1"
  local parent_pid="$2"
  local parent_birth="$3"
  local gate_deadline=$((SECONDS + CHILD_START_GATE_TIMEOUT))
  trap 'exit 125' HUP INT QUIT
  trap '' TERM
  while [ ! -f "$gate_path" ]; do
    process_identity_matches "$parent_pid" "$parent_birth" || exit 125
    [ "$SECONDS" -lt "$gate_deadline" ] || exit 125
    /bin/sleep 0.01
  done
  process_identity_matches "$parent_pid" "$parent_birth" || exit 125
  exec /bin/sleep 2147483647
}

# Atomically bind the continuity member to its exact birth and PGID.
create_group_member_record() {
  local record_path="$1"
  local gate_path="$2"
  local record_tmp member_pid member_birth member_pgid
  # The outer launcher enables job control only to give the managed leader a
  # private PGID. Disable it inside that leader before forking the continuity
  # member; otherwise Bash may put the member in a second process group.
  set +m
  group_continuity_member \
    "$gate_path" "$SAFE_RUN_PID" "$SAFE_RUN_BIRTH" \
    >/dev/null 2>&1 < /dev/null &
  member_pid=$!
  member_birth=$(process_birth "$member_pid" 2>/dev/null || echo "")
  member_pgid=$(process_pgid "$member_pid" 2>/dev/null || echo "")
  if ! process_identity_matches "$member_pid" "$member_birth" || [ -z "$member_pgid" ]; then
    kill -KILL "$member_pid" 2>/dev/null || true
    wait "$member_pid" 2>/dev/null || true
    return 1
  fi
  record_tmp="${record_path}.${member_pid}.tmp"
  if ! printf '%s|%s|%s\n' "$member_pid" "$member_birth" "$member_pgid" > "$record_tmp" ||
     ! mv -f "$record_tmp" "$record_path"; then
    rm -f "$record_tmp"
    kill -KILL "$member_pid" 2>/dev/null || true
    wait "$member_pid" 2>/dev/null || true
    return 1
  fi
  return 0
}

capture_group_member_record() {
  local leader_pid="$1"
  local leader_birth="$2"
  local expected_pgid="$3"
  local record_path="$4"
  local deadline=$((SECONDS + CHILD_START_GATE_TIMEOUT))
  local record rest member_pid member_birth member_pgid current_member_pgid
  CAPTURED_MEMBER_PID=""
  CAPTURED_MEMBER_BIRTH=""
  CAPTURED_MEMBER_PGID=""
  while [ ! -s "$record_path" ]; do
    process_identity_matches "$leader_pid" "$leader_birth" || return 1
    [ "$SECONDS" -lt "$deadline" ] || return 1
    /bin/sleep 0.01
  done
  record=$(sed -n '1p' "$record_path" 2>/dev/null) || return 1
  member_pid=${record%%|*}
  rest=${record#*|}
  [ "$rest" != "$record" ] || return 1
  member_birth=${rest%%|*}
  member_pgid=${rest#*|}
  [ "$member_pgid" != "$rest" ] || return 1
  case "$member_pid:$member_pgid:$expected_pgid" in
    *[!0-9:]*|:*|*:) return 1 ;;
  esac
  [ -n "$member_birth" ] && [ "$member_pid" != "$leader_pid" ] || return 1
  process_identity_matches "$member_pid" "$member_birth" || return 1
  current_member_pgid=$(process_pgid "$member_pid" 2>/dev/null || echo "")
  [ "$member_pgid" = "$expected_pgid" ] &&
    [ "$current_member_pgid" = "$expected_pgid" ] || return 1
  CAPTURED_MEMBER_PID="$member_pid"
  CAPTURED_MEMBER_BIRTH="$member_birth"
  CAPTURED_MEMBER_PGID="$member_pgid"
  return 0
}

status_field() {
  sed -n "s/.*$1=\([^ ]*\).*/\1/p" "$STATUS_FILE" 2>/dev/null | head -1
}

lock_field() {
  sed -n "s/^$1=//p" "$WATCHDOG_LOCK/owner" 2>/dev/null | head -1
}

watchdog_health() {
  [ -f "$STATUS_FILE" ] && [ -f "$WATCHDOG_LOCK/owner" ] || return 1
  local alive sample_ok state watchdog_pid watchdog_birth owner_token age now
  alive=$(status_field alive)
  sample_ok=$(status_field sample_ok)
  state=$(status_field state)
  watchdog_pid=$(status_field watchdog_pid)
  watchdog_birth=$(status_field watchdog_birth)
  owner_token=$(status_field owner_token)
  case "$alive" in ''|*[!0-9]*) return 1 ;; esac
  [ "$sample_ok" = "1" ] && [ "$state" = "running" ] || return 1
  [ "$(lock_field pid)" = "$watchdog_pid" ] || return 1
  [ "$(lock_field birth)" = "$watchdog_birth" ] || return 1
  [ "$(lock_field token)" = "$owner_token" ] || return 1
  now=$(date +%s)
  age=$((now - alive))
  [ "$age" -ge 0 ] && [ "$age" -le "$WATCHDOG_MAX_AGE" ] || return 1
  process_identity_matches "$watchdog_pid" "$watchdog_birth"
}

safe_run_lock_field() {
  sed -n "s/^$1=//p" "$SAFE_RUN_LOCK/owner" 2>/dev/null | head -1
}

command_fingerprint() {
  if [ $# -eq 0 ]; then
    echo "empty"
    return 0
  fi
  local joined="$1"
  shift
  while [ $# -gt 0 ]; do
    joined="$joined"$'\037'"$1"
    shift
  done
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$joined" | shasum -a 256 | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    printf '%s' "$joined" | openssl dgst -sha256 -r | awk '{print $1}'
  else
    printf '%s' "$joined" | cksum | awk '{print $1 "-" $2}'
  fi
}

random_token() {
  local token=""
  if command -v openssl >/dev/null 2>&1; then
    token=$(openssl rand -hex 12 2>/dev/null || true)
  fi
  if [ -z "$token" ]; then
    token="${SAFE_RUN_PID}-$(date +%s)-$RANDOM-$RANDOM"
  fi
  echo "$token"
}
managed_owned_handle_snapshot() { while [ "$#" -gt 0 ]; do case "$1" in --canvast-owned-handle-snapshot) shift; case "${1:-}" in /*) printf '%s\n' "$1"; return 0 ;; *) return 1 ;; esac ;; --canvast-owned-handle-snapshot=/*) printf '%s\n' "${1#*=}"; return 0 ;; esac; shift; done; return 1; }
managed_owned_handle_invocation_id() { while [ "$#" -gt 0 ]; do case "$1" in --canvast-owned-handle-invocation-id) shift; [ -n "${1:-}" ] || return 1; printf '%s\n' "$1"; return 0 ;; --canvast-owned-handle-invocation-id=*) value="${1#*=}"; [ -n "$value" ] || return 1; printf '%s\n' "$value"; return 0 ;; esac; shift; done; return 1; }
owned_handle_snapshot_ready() { [ -n "${CHILD_OWNED_HANDLE_SNAPSHOT:-}" ] && [ -s "$CHILD_OWNED_HANDLE_SNAPSHOT" ]; }
write_owned_handle_fallback_snapshot() {
  [ "$CHILD_TERMINATION_REQUESTED" = "1" ] || return 0
  [ -n "${CHILD_OWNED_HANDLE_SNAPSHOT:-}" ] || return 0
  [ -n "${CHILD_OWNED_HANDLE_INVOCATION_ID:-}" ] || return 0
  [ ! -s "$CHILD_OWNED_HANDLE_SNAPSHOT" ] || return 0
  node "$OWNED_HANDLE_FALLBACK_WRITER" "$CHILD_OWNED_HANDLE_SNAPSHOT" "$CHILD_OWNED_HANDLE_INVOCATION_ID" "$SAFE_RUN_PID" || return 1
}

safe_run_release_lock() {
  [ "$SAFE_RUN_LOCK_OWNED" = "1" ] || return 0
  if [ "$(safe_run_lock_field token)" != "$SAFE_RUN_OWNER_TOKEN" ] ||
     [ "$(safe_run_lock_field pid)" != "$SAFE_RUN_PID" ] ||
     [ "$(safe_run_lock_field birth)" != "$SAFE_RUN_BIRTH" ] ||
     [ "$(safe_run_lock_field pgid)" != "$SAFE_RUN_PGID" ] ||
     ! process_identity_state "$SAFE_RUN_PID" "$SAFE_RUN_BIRTH" "$SAFE_RUN_PGID"; then
    wrapper_log "⚠ safe-run lock ownership 无法精确确认；保留 lock" >&2; return 125
  fi
  if ! rm -f "$SAFE_RUN_LOCK/owner" || [ -e "$SAFE_RUN_LOCK/owner" ] ||
     ! rmdir "$SAFE_RUN_LOCK" 2>/dev/null || [ -e "$SAFE_RUN_LOCK" ]; then
    wrapper_log "⚠ safe-run lock 删除或回读失败；保留 ownership 状态" >&2; return 125
  fi
  SAFE_RUN_LOCK_OWNED=0
}
safe_run_adopt_lock() {
  local owner_tmp="$SAFE_RUN_LOCK/owner.${SAFE_RUN_PID}.tmp"
  mkdir "$SAFE_RUN_LOCK" 2>/dev/null || return 1
  printf 'pid=%s\nbirth=%s\npgid=%s\ntoken=%s\ncommand=%s\n' \
    "$SAFE_RUN_PID" "${SAFE_RUN_BIRTH:-unknown}" "$SAFE_RUN_PGID" "$SAFE_RUN_OWNER_TOKEN" "$SAFE_RUN_OWNER_COMMAND" > "$owner_tmp" || {
    rm -f "$owner_tmp"
    rmdir "$SAFE_RUN_LOCK" 2>/dev/null || true
    return 1
  }
  mv -f "$owner_tmp" "$SAFE_RUN_LOCK/owner" || {
    rm -f "$owner_tmp"
    rmdir "$SAFE_RUN_LOCK" 2>/dev/null || true
    return 1
  }
  SAFE_RUN_LOCK_OWNED=1
  return 0
}
ensure_single_flight_lock() {
  local owner_pid owner_birth owner_pgid owner_command birth_state owner_state stale_lock
  exec 9>>"$STATE_DIR/safe-run-recovery.lock" || return 125
  if ! /usr/bin/lockf -s -t 0 9; then
    exec 9>&-; wrapper_log "✗ safe-run stale-lock recovery 已由另一 contender 执行"; return 1
  fi
  if safe_run_adopt_lock; then
    exec 9>&-; wrapper_log "✓ 获取 safe-run single-flight lock"; return 0
  fi
  owner_pid=$(safe_run_lock_field pid); owner_birth=$(safe_run_lock_field birth)
  owner_pgid=$(safe_run_lock_field pgid); owner_command=$(safe_run_lock_field command)
  process_identity_state "$owner_pid" "$owner_birth"; birth_state=$?
  owner_state=$birth_state
  [ "$birth_state" != 0 ] || {
    process_identity_state "$owner_pid" "$owner_birth" "$owner_pgid"; owner_state=$?
  }
  if [ "$birth_state" = 2 ] || { [ "$birth_state" = 0 ] && [ "$owner_state" != 1 ]; }; then
    exec 9>&-
    wrapper_log "✗ safe-run single-flight lock 已被持有或身份不可观测 pid=${owner_pid:-unknown} command=${owner_command:-unknown}"
    return 1
  fi
  stale_lock="$STATE_DIR/safe-run.lock.stale.${SAFE_RUN_PID}.0"
  if ! mv "$SAFE_RUN_LOCK" "$stale_lock" 2>/dev/null; then
    exec 9>&-; wrapper_log "✗ safe-run single-flight lock 恢复失败"; return 1
  fi
  wrapper_log "⚠ 检测到 stale safe-run lock，已隔离到 $(basename "$stale_lock") 并尝试恢复"
  rm -f "$stale_lock/owner" && rmdir "$stale_lock" 2>/dev/null || { exec 9>&-; return 125; }
  safe_run_adopt_lock || { exec 9>&-; return 125; }
  exec 9>&-; wrapper_log "✓ 获取 safe-run single-flight lock"; return 0
}

stop_owned_watchdog() {
  [ -n "$OWNED_WATCHDOG_PID" ] || return 0
  local stop_output="" stop_status=0 running=0 attempt=0 active_job
  if [ "$(lock_field token)" = "$OWNED_WATCHDOG_TOKEN" ] && \
     [ "$(lock_field pid)" = "$OWNED_WATCHDOG_PID" ] && \
     [ "$(lock_field birth)" = "$OWNED_WATCHDOG_BIRTH" ]; then
    stop_output=$(CANVAST_PROCESS_SNAPSHOT_FORCE_HELPER=1 \
      CANVAST_WATCHDOG_EXPECTED_PID="$OWNED_WATCHDOG_PID" \
      CANVAST_WATCHDOG_EXPECTED_BIRTH="$OWNED_WATCHDOG_BIRTH" \
      CANVAST_WATCHDOG_EXPECTED_OWNER_TOKEN="$OWNED_WATCHDOG_TOKEN" \
      "$WATCHDOG" --stop 2>&1) || stop_status=$?
    case "$stop_status:$stop_output" in
      0:*"state=stopped verified=1 watchdog_pid=$OWNED_WATCHDOG_PID owner_token=$OWNED_WATCHDOG_TOKEN stop_token=stop-"*) ;;
      *) wrapper_log "⚠ owned watchdog cooperative stop 未获确认: ${stop_output:-exit=$stop_status}" >&2; return 1 ;;
    esac
  fi
  running=1
  while [ "$attempt" -lt 20 ] && [ "$running" = 1 ]; do
    running=0
    for active_job in $(jobs -rp 2>/dev/null); do [ "$active_job" != "$OWNED_WATCHDOG_PID" ] || running=1; done
    [ "$running" != 1 ] || { /bin/sleep 0.05; attempt=$((attempt + 1)); }
  done
  [ "$running" != 1 ] || { wrapper_log "⚠ owned watchdog 未在协作停止后退出；保留诊断状态" >&2; return 1; }
  wait "$OWNED_WATCHDOG_PID" 2>/dev/null || true
  if [ "$(lock_field token)" = "$OWNED_WATCHDOG_TOKEN" ] || [ "$(lock_field pid)" = "$OWNED_WATCHDOG_PID" ]; then
    wrapper_log "⚠ owned watchdog 已退出但 ownership 未释放；保留诊断状态" >&2; return 1
  fi
  if [ "$OWNED_WATCHDOG_GROUP_OWNED" = 1 ]; then
    [ -n "$OWNED_WATCHDOG_MEMBER_PID" ] && [ -n "$OWNED_WATCHDOG_MEMBER_BIRTH" ] || return 1
    bounded_stop_process "$OWNED_WATCHDOG_MEMBER_PID" "$OWNED_WATCHDOG_MEMBER_BIRTH" "$OWNED_WATCHDOG_MEMBER_PGID" || return 1
  fi
  OWNED_WATCHDOG_PID=""; OWNED_WATCHDOG_BIRTH=""; OWNED_WATCHDOG_PGID=""
  OWNED_WATCHDOG_GROUP_OWNED=0
  OWNED_WATCHDOG_MEMBER_PID=""; OWNED_WATCHDOG_MEMBER_BIRTH=""; OWNED_WATCHDOG_MEMBER_PGID=""
  [ -z "$OWNED_WATCHDOG_MEMBER_RECORD" ] || rm -f "$OWNED_WATCHDOG_MEMBER_RECORD"
  OWNED_WATCHDOG_MEMBER_RECORD=""
  [ -z "$OWNED_WATCHDOG_START_GATE" ] || rm -f "$OWNED_WATCHDOG_START_GATE"
  OWNED_WATCHDOG_START_GATE=""
  return 0
}

ensure_watchdog() {
  if watchdog_health; then
    wrapper_log "✓ 复用健康 watchdog: $(cat "$STATUS_FILE")"
    return 0
  fi
  if [ "$REQUIRE_EXTERNAL_WATCHDOG" = "1" ]; then
    wrapper_log "✗ 未发现健康外部 watchdog（要求 fresh + sample_ok=1 + live identity）"
    return 1
  fi
  [ -x "$WATCHDOG" ] || { wrapper_log "✗ watchdog 不可执行: $WATCHDOG"; return 1; }

  local safe_run_birth
  safe_run_birth=$(process_birth "$SAFE_RUN_PID")
  [ -n "$safe_run_birth" ] || { wrapper_log "✗ 无法确认 safe-run 进程身份"; return 1; }
  OWNED_WATCHDOG_TOKEN="safe-run-${SAFE_RUN_PID}-$(date +%s)"
  OWNED_WATCHDOG_START_GATE="$STATE_DIR/watchdog-start.${SAFE_RUN_PID}.${OWNED_WATCHDOG_TOKEN}"
  OWNED_WATCHDOG_MEMBER_RECORD="$STATE_DIR/watchdog-member.${SAFE_RUN_PID}.${OWNED_WATCHDOG_TOKEN}"
  OWNED_WATCHDOG_CONTINUITY_REQUIRED=0
  trusted_snapshot_backend && OWNED_WATCHDOG_CONTINUITY_REQUIRED=1
  rm -f "$OWNED_WATCHDOG_START_GATE" "$OWNED_WATCHDOG_MEMBER_RECORD"
  # Job control gives the owned watchdog a dedicated process group. Its poll
  # sleeper inherits that group, so a forced cleanup cannot orphan it.
  set -m
  (
    trap 'exit 125' HUP INT QUIT TERM
    if [ "$OWNED_WATCHDOG_CONTINUITY_REQUIRED" = "1" ]; then
      create_group_member_record "$OWNED_WATCHDOG_MEMBER_RECORD" "$OWNED_WATCHDOG_START_GATE" || exit 125
    fi
    local_gate_deadline=$((SECONDS + CHILD_START_GATE_TIMEOUT))
    while [ ! -f "$OWNED_WATCHDOG_START_GATE" ]; do
      process_identity_matches "$SAFE_RUN_PID" "$SAFE_RUN_BIRTH" || exit 125
      [ "$SECONDS" -lt "$local_gate_deadline" ] || exit 125
      /bin/sleep 0.01
    done
    process_identity_matches "$SAFE_RUN_PID" "$SAFE_RUN_BIRTH" || exit 125
    CANVAST_WATCHDOG_PARENT_PID="$SAFE_RUN_PID" \
    CANVAST_WATCHDOG_PARENT_BIRTH="$safe_run_birth" \
    CANVAST_WATCHDOG_OWNER_TOKEN="$OWNED_WATCHDOG_TOKEN" \
    POLL=1 CANVAST_PROCESS_SNAPSHOT_FORCE_HELPER=1 exec "$WATCHDOG"
  ) >/dev/null 2>&1 < /dev/null &
  OWNED_WATCHDOG_PID=$!
  set +m
  OWNED_WATCHDOG_BIRTH=$(process_birth "$OWNED_WATCHDOG_PID")
  OWNED_WATCHDOG_PGID=$(process_pgid "$OWNED_WATCHDOG_PID")
  if process_identity_matches "$OWNED_WATCHDOG_PID" "$OWNED_WATCHDOG_BIRTH" && \
     [ "$OWNED_WATCHDOG_PGID" = "$OWNED_WATCHDOG_PID" ] && \
     [ "$OWNED_WATCHDOG_PGID" != "$SAFE_RUN_PGID" ]; then
    if [ "$OWNED_WATCHDOG_CONTINUITY_REQUIRED" = "1" ]; then
      if ! capture_group_member_record \
        "$OWNED_WATCHDOG_PID" "$OWNED_WATCHDOG_BIRTH" "$OWNED_WATCHDOG_PGID" \
        "$OWNED_WATCHDOG_MEMBER_RECORD"; then
        wrapper_log "✗ owned watchdog 无法建立可信进程组 continuity；拒绝继续"
        abort_pre_gate_group \
          "$OWNED_WATCHDOG_PID" "$OWNED_WATCHDOG_BIRTH" \
          "$OWNED_WATCHDOG_PGID" "owned watchdog" || true
        return 1
      fi
      OWNED_WATCHDOG_MEMBER_PID="$CAPTURED_MEMBER_PID"
      OWNED_WATCHDOG_MEMBER_BIRTH="$CAPTURED_MEMBER_BIRTH"
      OWNED_WATCHDOG_MEMBER_PGID="$CAPTURED_MEMBER_PGID"
    fi
[ "$OWNED_WATCHDOG_CONTINUITY_REQUIRED" = "1" ] && [ -n "$OWNED_WATCHDOG_MEMBER_PID" ] && [ -n "$OWNED_WATCHDOG_MEMBER_BIRTH" ] && [ -n "$OWNED_WATCHDOG_MEMBER_PGID" ] && OWNED_WATCHDOG_GROUP_OWNED=1
    : > "$OWNED_WATCHDOG_START_GATE" || return 1
  elif process_identity_matches "$OWNED_WATCHDOG_PID" "$OWNED_WATCHDOG_BIRTH"; then
    wrapper_log "✗ owned watchdog 未取得独立进程组，拒绝继续"
    kill -TERM "$OWNED_WATCHDOG_PID" 2>/dev/null || true
    wait "$OWNED_WATCHDOG_PID" 2>/dev/null || true
    OWNED_WATCHDOG_PID=""
    OWNED_WATCHDOG_BIRTH=""
    OWNED_WATCHDOG_PGID=""
    OWNED_WATCHDOG_GROUP_OWNED=0
    return 1
  fi

  local attempt=0
  while [ "$attempt" -lt "$WATCHDOG_START_ATTEMPTS" ]; do
    if watchdog_health; then
      if [ "$(status_field owner_token)" = "$OWNED_WATCHDOG_TOKEN" ] && \
         [ "$(status_field watchdog_pid)" = "$OWNED_WATCHDOG_PID" ]; then
        wrapper_log "✓ safe-run 已启动并拥有健康 watchdog (pid=$OWNED_WATCHDOG_PID)"
      else
        if ! stop_owned_watchdog; then
          wrapper_log "✗ 外部 watchdog 已接管，但本次 candidate 组未能确认清空；拒绝继续" >&2
          return 125
        fi
        wrapper_log "✓ 并发外部 watchdog 已接管，复用健康实例"
      fi
      return 0
    fi
    sleep 0.1
    attempt=$((attempt + 1))
  done
  wrapper_log "✗ watchdog 首次健康采样超时或失败"
  stop_owned_watchdog
  return 1
}
owned_group_state() {
  local leader_pid="$1"
  local leader_birth="$2"
  local group_pgid="$3"
  local group_owned="$4"
  local member_pid="$5"
  local member_birth="$6"
  local member_pgid="$7"
  [ "$group_owned" = "1" ] || return 1
  case "$leader_pid:$group_pgid" in
    *[!0-9:]*|:*|*:) return 2 ;;
  esac
  [ "$leader_pid" = "$group_pgid" ] || return 2
  kill -0 -- "-$group_pgid" 2>/dev/null || return 1

  local current_leader_birth current_leader_pgid current_member_pgid
  current_leader_birth=$(process_birth "$leader_pid" 2>/dev/null || echo "")
  if [ -n "$current_leader_birth" ]; then
    if [ -n "$leader_birth" ] && [ "$current_leader_birth" = "$leader_birth" ]; then
      current_leader_pgid=$(process_pgid "$leader_pid" 2>/dev/null || echo "")
      [ "$current_leader_pgid" = "$group_pgid" ] || return 2
      return 0
    fi
  fi

  # The leader is absent, uninspectable, or its PID has been reused. A live
  # exact member in the frozen group is now the sole authority for group
  # signalling; a bare PGID or the reused leader identity is never sufficient.
  case "$member_pid:$member_pgid" in *[!0-9:]*|:*|*:) return 2 ;; esac
  [ "$member_pid" != "$leader_pid" ] &&
    [ "$member_pgid" = "$group_pgid" ] &&
    [ -n "$member_birth" ] || return 2
  process_identity_matches "$member_pid" "$member_birth" || return 2
  current_member_pgid=$(process_pgid "$member_pid" 2>/dev/null || echo "")
  [ "$current_member_pgid" = "$group_pgid" ] || return 2
  return 0
}
bounded_stop_owned_group() {
  local leader_pid="$1" leader_birth="$2" group_pgid="$3" group_owned="$4"
  local member_pid="$5" member_birth="$6" member_pgid="$7" label="$8"
  local state attempt term_grace_attempts timeout_cleanup

  owned_group_state "$leader_pid" "$leader_birth" "$group_pgid" "$group_owned" \
    "$member_pid" "$member_birth" "$member_pgid"
  state=$?
  if [ "$state" = "2" ]; then
    wrapper_log "⚠ $label pgid=$group_pgid 的 leader identity 已变化；拒绝组信号" >&2
    return 1
  fi
  [ "$state" = "0" ] || return 0

  term_grace_attempts=20; timeout_cleanup=0
  [ -z "${TIMEOUT_PENDING:-}" ] || [ ! -f "$TIMEOUT_PENDING" ] || { term_grace_attempts="$CHILD_TERM_GRACE_ATTEMPTS"; timeout_cleanup=1; }
  kill -TERM -- "-$group_pgid" 2>/dev/null || true
  attempt=0
  while [ "$attempt" -lt "$term_grace_attempts" ] && kill -0 -- "-$group_pgid" 2>/dev/null; do
    if [ "$timeout_cleanup" = "1" ] && [ -n "${CHILD_OWNED_HANDLE_SNAPSHOT:-}" ]; then
      owned_handle_snapshot_ready && break
      owned_group_state "$leader_pid" "$leader_birth" "$group_pgid" "$group_owned" \
        "$member_pid" "$member_birth" "$member_pgid"; state=$?
      [ "$state" = "0" ] || break
    else
      process_identity_state "$leader_pid" "$leader_birth" "$group_pgid"; [ "$?" = "0" ] || break
    fi
    reap_zombie_child "$leader_pid" || /bin/sleep 0.1
    attempt=$((attempt + 1))
  done
  if ! kill -0 -- "-$group_pgid" 2>/dev/null; then
    wait "$leader_pid" 2>/dev/null || true
    return 0
  fi
  owned_group_state "$leader_pid" "$leader_birth" "$group_pgid" "$group_owned" \
    "$member_pid" "$member_birth" "$member_pgid"
  state=$?
  if [ "$state" = "2" ]; then
    wrapper_log "⚠ $label pgid=$group_pgid 在 TERM 宽限期发生 identity 冲突；拒绝升级" >&2
    return 1
  fi
  if [ "$state" = "0" ]; then
    kill -KILL -- "-$group_pgid" 2>/dev/null || true
    attempt=0
    while [ "$attempt" -lt 20 ] && kill -0 -- "-$group_pgid" 2>/dev/null; do
      reap_zombie_child "$leader_pid" || /bin/sleep 0.05
      attempt=$((attempt + 1))
    done
  fi
  if ! kill -0 -- "-$group_pgid" 2>/dev/null; then
    wait "$leader_pid" 2>/dev/null || true
    return 0
  fi
  wrapper_log "⚠ $label pid=$leader_pid pgid=$group_pgid 在有界 TERM→KILL 后仍未确认清空" >&2
  return 1
}
# Before the private start gate opens, the group can contain only Canvast's
# launcher and continuity anchor. If the anchor record cannot be captured, use
# the still-live exact leader as the one-time authority to stop that leader and
# wait for the unopened-gate anchor to leave by itself. Never use this path
# after the workload gate has opened, and never signal an unanchored PGID.
abort_pre_gate_group() {
  local leader_pid="$1" leader_birth="$2" group_pgid="$3" label="$4"
  local current_pgid attempt=0
  case "$leader_pid:$group_pgid" in *[!0-9:]*|:*|*:) return 1 ;; esac
  [ "$leader_pid" = "$group_pgid" ] || return 1
  process_identity_matches "$leader_pid" "$leader_birth" || return 1
  current_pgid=$(process_pgid "$leader_pid" 2>/dev/null || echo "")
  [ "$current_pgid" = "$group_pgid" ] || return 1

  # Capture failed, so there is no durable member identity authorizing a
  # negative-PGID signal. Kill only the freshly verified leader. The unopened
  # gate prevents user work from starting. Any private anchor has no inherited
  # output descriptors and exits as soon as this safe-run parent exits.
  kill -KILL "$leader_pid" 2>/dev/null || true
  while [ "$attempt" -lt 20 ] && process_identity_matches "$leader_pid" "$leader_birth"; do
    reap_zombie_child "$leader_pid" || /bin/sleep 0.05
    attempt=$((attempt + 1))
  done
  if process_identity_matches "$leader_pid" "$leader_birth"; then
    wrapper_log "⚠ $label pid=$leader_pid 门前中止后仍存活" >&2
    return 1
  fi
  wait "$leader_pid" 2>/dev/null || true
  return 0
}
bounded_stop_process() { local pid="$1" birth="$2" expected_pgid="${3:-}" role="${4:-process}" direct_child="${5:-0}" state attempt signal active_job job_state=not_checked
  [ -z "$pid" ] && return 0; case "$pid" in *[!0-9]*) return 125 ;; esac; [ "$pid" -gt 1 ] || return 125
  case "$direct_child:$role" in 1:timeout_timer) [ "$pid" = "${TIMER:-}" ] || { direct_child=0; job_state=unregistered; } ;; 1:gui_guard) [ "$pid" = "${GUI_GUARD_PID:-}" ] || { direct_child=0; job_state=unregistered; } ;; 1:*) direct_child=0; job_state=unregistered ;; *) direct_child=0 ;; esac
  reap_zombie_child "$pid" && return 0
  process_identity_state "$pid" "$birth" "$expected_pgid"; state=$?
  if [ "$state" = "2" ] && [ "$direct_child" = "1" ]; then attempt=0
    while [ "$attempt" -lt 20 ] && [ "$state" = "2" ]; do job_state=completed; for active_job in $(jobs -rp 2>/dev/null); do [ "$active_job" != "$pid" ] || job_state=running; done; if [ "$job_state" = "completed" ]; then for active_job in $(jobs -sp 2>/dev/null); do [ "$active_job" != "$pid" ] || job_state=stopped; done; fi; [ "$job_state" != "completed" ] || { wait "$pid" 2>/dev/null || true; return 0; }; [ "$job_state" = "running" ] || break; /bin/sleep 0.05; reap_zombie_child "$pid" && return 0; process_identity_state "$pid" "$birth" "$expected_pgid"; state=$?; attempt=$((attempt + 1)); done; fi
  if [ "$state" = "0" ]; then for signal in TERM KILL; do
      kill "-$signal" "$pid" 2>/dev/null || true; attempt=0
      while [ "$attempt" -lt 20 ]; do reap_zombie_child "$pid" && return 0
        process_identity_state "$pid" "$birth" "$expected_pgid"; state=$?
        [ "$state" = "0" ] || break
        /bin/sleep 0.05; attempt=$((attempt + 1))
      done
      [ "$attempt" != "20" ] || { reap_zombie_child "$pid" && return 0; process_identity_state "$pid" "$birth" "$expected_pgid"; state=$?; }
      [ "$state" = "0" ] || break
    done; fi
  if { [ "$state" = "2" ] || [ "$state" = "3" ]; } && [ "$direct_child" = "1" ]; then job_state=completed
    for active_job in $(jobs -rp 2>/dev/null); do [ "$active_job" != "$pid" ] || job_state=running; done
    if [ "$job_state" = "completed" ]; then for active_job in $(jobs -sp 2>/dev/null); do [ "$active_job" != "$pid" ] || job_state=stopped; done; fi
    [ "$job_state" != "completed" ] || { wait "$pid" 2>/dev/null || true; return 0; }; fi
  case "$state" in
    1) wait "$pid" 2>/dev/null || true; return 0 ;;
    2) wrapper_log "⚠ pid=$pid 身份不可观测，拒绝等待 role=$role direct_child=$direct_child job_state=$job_state" >&2; return 125 ;;
    3) wrapper_log "⚠ pid=$pid 身份已变化，拒绝信号和等待 role=$role direct_child=$direct_child job_state=$job_state" >&2; return 125 ;;
    *) wrapper_log "⚠ pid=$pid 在有界 TERM→KILL 后仍存活，停止等待 role=$role direct_child=$direct_child job_state=$job_state" >&2; return 125 ;;
  esac
}
bounded_stop_spawned_child() {
  wrapper_log "⚠ $2 pid=$1 缺少首次 PID/birth/PGID 身份锚；拒绝信号和等待" >&2
  return 1
}
close_timeout_timer_channel() { [ -z "$TIMER_CONTROL" ] || { exec 7>&-; rm -f "$TIMER_CONTROL"; TIMER_CONTROL=""; }; }
stop_timeout_timer() { local attempt=0 active_job job_state rc=0; [ -n "$TIMER" ] || { close_timeout_timer_channel; return 0; }
  if [ -n "$TIMER_CONTROL" ] && [ -p "$TIMER_CONTROL" ] && printf '%s\n' "$SAFE_RUN_OWNER_TOKEN" >&7; then while [ "$attempt" -lt 40 ]; do job_state=completed
      for active_job in $(jobs -rp 2>/dev/null); do [ "$active_job" != "$TIMER" ] || job_state=running; done
      if [ "$job_state" = completed ]; then for active_job in $(jobs -sp 2>/dev/null); do [ "$active_job" != "$TIMER" ] || job_state=stopped; done; fi
      [ "$job_state" != completed ] || { wait "$TIMER" 2>/dev/null || rc=$?; TIMER=""; close_timeout_timer_channel; [ "$rc" = 0 ]; return; }
      [ "$job_state" = running ] || break; /bin/sleep 0.05; attempt=$((attempt + 1))
    done; fi
  if bounded_stop_process "$TIMER" "$TIMER_BIRTH" "${TIMER_PGID:-}" "timeout_timer" 1; then TIMER=""; else rc=125; fi; close_timeout_timer_channel; return "$rc"
}
preserve_unconfirmed_spawn() {
  local pid="$1" label="$2" record tmp
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  record="$STATE_DIR/safe-run-unconfirmed-${SAFE_RUN_PID}-${pid}"
  tmp="${record}.${SAFE_RUN_OWNER_TOKEN}.tmp"
  UNCONFIRMED_DIAGNOSTIC="$record"
  printf 'kind=%s\npid=%s\nparent_pid=%s\nparent_birth=%s\nowner_token=%s\ncleanup=unconfirmed\n' \
    "$label" "$pid" "$SAFE_RUN_PID" "$SAFE_RUN_BIRTH" "$SAFE_RUN_OWNER_TOKEN" > "$tmp" &&
    mv -f "$tmp" "$record" || { rm -f "$tmp"; return 1; }
  wrapper_log "⚠ $label pid=$pid 未确认清空；保留诊断记录 $record" >&2
}
terminate_child_tree() {
  [ "$CHILD_UNCONFIRMED" != "1" ] || return 1
  [ -n "$CHILD" ] || return 0
  if [ "$CHILD_GROUP_OWNED" = "1" ]; then
    bounded_stop_owned_group \
      "$CHILD" "$CHILD_BIRTH" "$CHILD_PGID" "$CHILD_GROUP_OWNED" \
      "$CHILD_MEMBER_PID" "$CHILD_MEMBER_BIRTH" "$CHILD_MEMBER_PGID" \
      "child process group" || return 1
  else
    bounded_stop_process "$CHILD" "$CHILD_BIRTH" "$CHILD_PGID" || return $?
  fi
  if ! process_identity_matches "$CHILD" "$CHILD_BIRTH"; then
    wait "$CHILD" 2>/dev/null || true
    return 0
  fi
  wrapper_log "⚠ child pid=$CHILD pgid=$CHILD_PGID 在 TERM→KILL 后仍存活，停止等待" >&2
  return 1
}
cleanup() {
  local original_status=$?
  local cleanup_status=0
  [ "$CLEANED" = "0" ] || return "$original_status"
  CLEANED=1
  trap - EXIT
  trap '' HUP INT QUIT TERM USR1
  terminate_child_tree || cleanup_status=125
  if [ "$TIMER_UNCONFIRMED" = "1" ]; then cleanup_status=125
  else stop_timeout_timer || cleanup_status=125; fi
  [ "$GUI_GUARD_UNCONFIRMED" != "1" ] &&
    bounded_stop_process "$GUI_GUARD_PID" "$GUI_GUARD_BIRTH" "${GUI_GUARD_PGID:-}" "gui_guard" 1 || cleanup_status=125
  stop_owned_watchdog || cleanup_status=125
  [ "$cleanup_status" != "0" ] || write_owned_handle_fallback_snapshot || cleanup_status=125
  [ "$cleanup_status" != "0" ] || safe_run_release_lock || cleanup_status=125
  if [ "$cleanup_status" = "0" ]; then
    [ -z "$CHILD_START_GATE" ] || rm -f "$CHILD_START_GATE"
    [ -z "$CHILD_MEMBER_RECORD" ] || rm -f "$CHILD_MEMBER_RECORD"
    [ -z "${TIMEOUT_PENDING:-}" ] || rm -f "$TIMEOUT_PENDING"
    rm -f "$STATE_DIR/safe-run-ps.${SAFE_RUN_PID}.tmp"
  else
    wrapper_log "✗ safe-run 退出清理未完成；保留身份记录并以 125 失败关闭" >&2
    exit 125
  fi
  return "$original_status"
}

on_signal() { CHILD_TERMINATION_REQUESTED=1; wrapper_log "⚠ safe-run 收到信号 $1，终止受管进程并退出" >&2; exit "$2"; }
on_timeout() { CHILD_TERMINATION_REQUESTED=1; wrapper_log "⏱ 超时 ${TIMEOUT}s，终止受管进程" >&2; exit 124; }

SAFE_RUN_BIRTH=$(process_birth "$SAFE_RUN_PID")
SAFE_RUN_PGID=$(process_pgid "$SAFE_RUN_PID")
SAFE_RUN_OWNER_TOKEN="safe-run-${SAFE_RUN_PID}-$(random_token)"
TIMEOUT_PENDING="$STATE_DIR/safe-run-timeout-pending-${SAFE_RUN_OWNER_TOKEN}"
TIMER_CONTROL="$STATE_DIR/safe-run-timer-control-${SAFE_RUN_OWNER_TOKEN}"
SAFE_RUN_OWNER_COMMAND=$(command_fingerprint "$@")
CHILD_OWNED_HANDLE_SNAPSHOT=$(managed_owned_handle_snapshot "$@" 2>/dev/null || true)
CHILD_OWNED_HANDLE_INVOCATION_ID=$(managed_owned_handle_invocation_id "$@" 2>/dev/null || true)
if [ -z "$SAFE_RUN_BIRTH" ] || [ -z "$SAFE_RUN_PGID" ]; then
  wrapper_log "✗ 无法确认 safe-run 自身 lstart/pgid；拒绝继续"
  exit 125
fi
trap cleanup EXIT
trap 'on_signal HUP 129' HUP
trap 'on_signal INT 130' INT
trap 'on_signal QUIT 131' QUIT
trap 'on_signal TERM 143' TERM
trap on_timeout USR1

load1() { local value
  value=$(sysctl -n vm.loadavg 2>/dev/null | awk '{gsub(/[{}]/,""); print $1}')
  [ -n "$value" ] && { echo "$value"; return; }
  value=$(uptime | sed -n 's/.*load averages*: \([0-9.]*\).*/\1/p')
  [ -n "$value" ] && { echo "$value"; return; }
  watchdog_health && status_field load1
}

wrapper_log "── 起飞前风险评估 ─────────────────────────────"
FAIL=0
HARD_FAIL=0

if ! ensure_single_flight_lock; then
  # Admission failed before this invocation owns any runnable work. Do not
  # start or probe another watchdog: a rejected contender must create no
  # background resources of its own.
  wrapper_log "═══ single-flight 准入失败，未启动任何后台资源 ═══"
  exit 3
fi

# 1. watchdog: start one we own, or reuse a verified external instance.
ensure_watchdog; WATCHDOG_STATUS=$?
if [ "$WATCHDOG_STATUS" != "0" ]; then
  [ "$WATCHDOG_STATUS" != "125" ] || exit 125
  FAIL=1
  HARD_FAIL=1
fi

# 2. 现存 pi 进程
PS_SNAPSHOT="$STATE_DIR/safe-run-ps.${SAFE_RUN_PID}.tmp"
if snapshot_all_commands > "$PS_SNAPSHOT" 2>/dev/null && [ -s "$PS_SNAPSHOT" ]; then
  PI_COUNT=$(awk -v root="$CANVAST_DIR" '
  index($0, root "/node_modules/.bin/pi") > 0 { count++ }
  END { print count + 0 }
' "$PS_SNAPSHOT")
else
  PI_COUNT=""
fi
rm -f "$PS_SNAPSHOT"
if [ -n "$PI_COUNT" ] && [ "$PI_COUNT" -le "$MAX_PRE_PI" ]; then
  wrapper_log "✓ 现存 pi 进程 $PI_COUNT ≤ $MAX_PRE_PI"
elif [ -z "$PI_COUNT" ]; then
  wrapper_log "✗ ps 采样失败/为空，禁止把未知状态当作 0 个进程"
  FAIL=1
  HARD_FAIL=1
else
  wrapper_log "✗ 现存 pi 进程 $PI_COUNT > ${MAX_PRE_PI}（可能有泄漏残留，先清理）"
  FAIL=1
fi

# 3. 系统负载
LOAD1=$(load1)
if [ -n "$LOAD1" ] && awk -v l="$LOAD1" -v m="$MAX_PRE_LOAD" 'BEGIN{exit !(l<=m)}'; then
  wrapper_log "✓ load1=$LOAD1 ≤ $MAX_PRE_LOAD"
else
  if [ -n "$LOAD1" ]; then
    wrapper_log "✗ load1=$LOAD1 > ${MAX_PRE_LOAD}（系统繁忙，稍后再试）"
  else
    wrapper_log "✗ load1 无法读取（sysctl 被拦且无新鲜 watchdog 心跳）"
  fi
  FAIL=1
fi

# 4. 可用内存（free+inactive）
AVAIL_MB=$(avail_mem_mb 2>/dev/null || echo "")
if [ -n "$AVAIL_MB" ] && [ "$AVAIL_MB" -ge "$MIN_PRE_AVAIL_MB" ]; then
  wrapper_log "✓ 可用内存 ${AVAIL_MB}MB ≥ ${MIN_PRE_AVAIL_MB}MB"
elif [ -z "$AVAIL_MB" ]; then
  wrapper_log "✗ 可用内存采样失败，拒绝启动"
  FAIL=1
  HARD_FAIL=1
else
  wrapper_log "✗ 可用内存 ${AVAIL_MB}MB < ${MIN_PRE_AVAIL_MB}MB"
  FAIL=1
fi

if [ "$FAIL" = "1" ]; then
  if [ "$HARD_FAIL" = "1" ]; then
    wrapper_log "═══ 关键采样或守卫不可信，拒绝启动（FORCE 不可绕过）═══"
    exit 3
  elif [ "${FORCE:-0}" = "1" ] && [ -n "${CANVAST_FORCE_REASON:-}" ]; then
    wrapper_log "⚠ 检查未通过但 FORCE=1，强行起飞"
    # Audit trail for forced launches / 强行起飞留审计痕迹
    echo "[$(date '+%F %T')] FORCE=1 override by $(whoami) reason=$CANVAST_FORCE_REASON command=$*" >> "$STATE_DIR/force-launch.log"
  else
    wrapper_log "═══ 评估不通过，拒绝启动（覆盖需 FORCE=1 + CANVAST_FORCE_REASON）═══"
    exit 3
  fi
fi
wrapper_log "──────────────────────────────────────────────"

# Frontend/desktop tests must remain unattended: no browser/app launchers, no
# AppleScript automation, no system-permission popups. The guard is scoped to
# processes tied to this checkout only and will not manage the user's desktop.
GUI_GUARD_PID=""
if [ -x "$GUI_GUARD" ]; then
  "$GUI_GUARD" >/dev/null 2>&1 &
  GUI_GUARD_PID=$!
  GUI_GUARD_BIRTH=$(process_birth "$GUI_GUARD_PID"); GUI_GUARD_PGID=$(process_pgid "$GUI_GUARD_PID")
  if ! process_identity_state "$GUI_GUARD_PID" "$GUI_GUARD_BIRTH" "$GUI_GUARD_PGID"; then
    wrapper_log "✗ GUI guard 已启动但无法确认 birth；立即有界清理并拒绝继续" >&2
    if bounded_stop_spawned_child "$GUI_GUARD_PID" "GUI guard"; then GUI_GUARD_PID=""
    else
      GUI_GUARD_UNCONFIRMED=1
      preserve_unconfirmed_spawn "$GUI_GUARD_PID" "gui_guard" ||
        wrapper_log "✗ GUI guard pid=$GUI_GUARD_PID diagnostic persistence failed: ${UNCONFIRMED_DIAGNOSTIC:-$STATE_DIR/safe-run-unconfirmed-${SAFE_RUN_PID}-${GUI_GUARD_PID}}" >&2
    fi
    exit 125
  fi
fi
# ── 进程组围栏 ──────────────────────────────────────────────────────────────
# Hold the group leader behind a private gate until its PID/birth/PGID tuple is
# recorded. This closes the fast-leader-exit race without changing command argv.
CHILD_START_GATE="$STATE_DIR/safe-run-child-start.${SAFE_RUN_PID}.${SAFE_RUN_OWNER_TOKEN}"
CHILD_MEMBER_RECORD="$STATE_DIR/safe-run-child-member.${SAFE_RUN_PID}.${SAFE_RUN_OWNER_TOKEN}"
CHILD_CONTINUITY_REQUIRED=0
trusted_snapshot_backend && CHILD_CONTINUITY_REQUIRED=1
[ "$CHILD_CONTINUITY_REQUIRED" = "1" ] || { wrapper_log "✗ 无可信进程快照后端，无法建立 child continuity；拒绝启动"; exit 125; }
rm -f "$CHILD_START_GATE" "$CHILD_MEMBER_RECORD"
set -m  # job control：后台命令自成进程组，方便整组杀
(
  trap 'exit 125' HUP INT QUIT TERM
  if [ "$CHILD_CONTINUITY_REQUIRED" = "1" ]; then
    create_group_member_record "$CHILD_MEMBER_RECORD" "$CHILD_START_GATE" || exit 125
  fi
  gate_deadline=$((SECONDS + CHILD_START_GATE_TIMEOUT))
  while [ ! -f "$CHILD_START_GATE" ]; do
    process_identity_matches "$SAFE_RUN_PID" "$SAFE_RUN_BIRTH" || exit 125
    [ "$SECONDS" -lt "$gate_deadline" ] || exit 125
    /bin/sleep 0.01
  done
  process_identity_matches "$SAFE_RUN_PID" "$SAFE_RUN_BIRTH" || exit 125
  exec "$@"
) &
CHILD=$!
set +m
CHILD_BIRTH=$(process_birth "$CHILD")
CHILD_PGID=$(process_pgid "$CHILD")
if ! process_identity_matches "$CHILD" "$CHILD_BIRTH" || \
   [ "$CHILD_PGID" != "$CHILD" ] || [ "$CHILD_PGID" = "$SAFE_RUN_PGID" ]; then
  wrapper_log "✗ child 已启动但无法确认 lstart/pgid；立即终止并拒绝继续"
  if bounded_stop_spawned_child "$CHILD" "child"; then CHILD=""
  else
    CHILD_UNCONFIRMED=1
    preserve_unconfirmed_spawn "$CHILD" "workload_child" ||
      wrapper_log "✗ child pid=$CHILD diagnostic persistence failed: ${UNCONFIRMED_DIAGNOSTIC:-$STATE_DIR/safe-run-unconfirmed-${SAFE_RUN_PID}-${CHILD}}" >&2
  fi
  rm -f "$CHILD_START_GATE"
  CHILD_START_GATE=""
  exit 125
fi
if [ "$CHILD_CONTINUITY_REQUIRED" = "1" ]; then
  if ! capture_group_member_record \
    "$CHILD" "$CHILD_BIRTH" "$CHILD_PGID" "$CHILD_MEMBER_RECORD"; then
    wrapper_log "✗ child 无法建立可信进程组 continuity；立即清理并拒绝继续"
    abort_pre_gate_group "$CHILD" "$CHILD_BIRTH" "$CHILD_PGID" \
      "child process group" || true
    exit 125
  fi
  CHILD_MEMBER_PID="$CAPTURED_MEMBER_PID"
  CHILD_MEMBER_BIRTH="$CAPTURED_MEMBER_BIRTH"
  CHILD_MEMBER_PGID="$CAPTURED_MEMBER_PGID"
fi
[ "$CHILD_CONTINUITY_REQUIRED" = "1" ] && [ -n "$CHILD_MEMBER_PID" ] && [ -n "$CHILD_MEMBER_BIRTH" ] && [ -n "$CHILD_MEMBER_PGID" ] && CHILD_GROUP_OWNED=1
if ! : > "$CHILD_START_GATE"; then
  wrapper_log "✗ 无法释放 child 启动门；立即清理并拒绝继续"
  exit 125
fi

SWEEP() {
  local sweep_status=0
  terminate_child_tree || sweep_status=1
  bounded_stop_process "$GUI_GUARD_PID" "$GUI_GUARD_BIRTH" "${GUI_GUARD_PGID:-}" "gui_guard" 1 || sweep_status=1
  if [ "$sweep_status" = "0" ]; then
    CHILD=""; GUI_GUARD_PID=""
    rm -f "$CHILD_START_GATE" "$CHILD_MEMBER_RECORD"
    CHILD_START_GATE=""; CHILD_MEMBER_RECORD=""
  fi
  return "$sweep_status"
}
# Normal completion uses an owner-token FIFO and reaps the direct timer child.
rm -f "$TIMER_CONTROL"; mkfifo -m 600 "$TIMER_CONTROL" || { wrapper_log "✗ 无法创建 timeout timer control channel" >&2; exit 125; }
exec 7<>"$TIMER_CONTROL" || { wrapper_log "✗ 无法打开 timeout timer control channel" >&2; exit 125; }
(
  TIMER_MESSAGE=""
  if IFS= read -r -t "$TIMEOUT" TIMER_MESSAGE <&7; then
    [ "$TIMER_MESSAGE" = "$SAFE_RUN_OWNER_TOKEN" ] && exit 0
    exit 125
  fi
  timeout_pending="${TIMEOUT_PENDING:-}"; timeout_tmp="${timeout_pending}.${SAFE_RUN_PID}.tmp"; deadline_attempt=0
  while [ "$deadline_attempt" -lt 3 ]; do
    process_identity_state "$CHILD" "$CHILD_BIRTH" "$CHILD_PGID"; child_state=$?; process_identity_state "$SAFE_RUN_PID" "$SAFE_RUN_BIRTH" "$SAFE_RUN_PGID"; owner_state=$?
    case "$child_state:$owner_state" in 0:0|2:0) printf 'state=timeout_pending child_state=%s owner_state=0\n' "$child_state" > "$timeout_tmp" 2>/dev/null && mv -f "$timeout_tmp" "$timeout_pending" 2>/dev/null && break; rm -f "$timeout_tmp"; exit 125 ;; 1:*|3:*) rm -f "$timeout_tmp" "$timeout_pending"; break ;; esac
    if ! printf 'state=timeout_pending child_state=%s owner_state=%s\n' "$child_state" "$owner_state" > "$timeout_tmp" 2>/dev/null || ! mv -f "$timeout_tmp" "$timeout_pending" 2>/dev/null; then rm -f "$timeout_tmp"; [ "$child_state" != "0" ] || bounded_stop_process "$CHILD" "$CHILD_BIRTH" "$CHILD_PGID" || true; exit 125; fi
    deadline_attempt=$((deadline_attempt + 1)); [ "$deadline_attempt" -ge 3 ] || /bin/sleep 0.05
  done
  [ "$deadline_attempt" -lt 3 ] || [ "$child_state" != "0" ] || bounded_stop_process "$CHILD" "$CHILD_BIRTH" "$CHILD_PGID" || true
) >/dev/null 2>/dev/null < /dev/null &
TIMER=$!
TIMER_BIRTH=$(process_birth "$TIMER"); TIMER_PGID=$(process_pgid "$TIMER")
if ! process_identity_state "$TIMER" "$TIMER_BIRTH" "$TIMER_PGID"; then
  wrapper_log "✗ timeout timer 已启动但无法确认 birth；立即有界清理并拒绝继续" >&2
  if ! stop_timeout_timer; then
    TIMER_UNCONFIRMED=1
    preserve_unconfirmed_spawn "$TIMER" "timeout_timer" ||
      wrapper_log "✗ timeout timer pid=$TIMER diagnostic persistence failed: ${UNCONFIRMED_DIAGNOSTIC:-$STATE_DIR/safe-run-unconfirmed-${SAFE_RUN_PID}-${TIMER}}" >&2
  fi
  exit 125
fi

EXITCODE=0
while :; do
  [ -z "${TIMEOUT_PENDING:-}" ] || [ ! -f "$TIMEOUT_PENDING" ] || on_timeout
  CHILD_RUNNING=0; TIMER_RUNNING=0
  for ACTIVE_JOB_PID in $(jobs -rp 2>/dev/null); do [ "$ACTIVE_JOB_PID" != "$CHILD" ] || CHILD_RUNNING=1; [ -z "$TIMER" ] || [ "$ACTIVE_JOB_PID" != "$TIMER" ] || TIMER_RUNNING=1; done
  if [ -n "$TIMER" ] && [ "$TIMER_RUNNING" != "1" ]; then
    TIMER_EXITCODE=0; wait "$TIMER" || TIMER_EXITCODE=$?; TIMER=""
    [ -z "${TIMEOUT_PENDING:-}" ] || [ ! -f "$TIMEOUT_PENDING" ] || on_timeout
    [ "$TIMER_EXITCODE" = "0" ] && [ "$CHILD_RUNNING" != "1" ] || { wrapper_log "✗ timeout timer 提前退出或 enforcement 失败；以 125 失败关闭" >&2; exit 125; }
  fi
  [ "$CHILD_RUNNING" = "1" ] || break
  /bin/sleep 0.05
done
wait "$CHILD" || EXITCODE=$?
SWEEP_RESULT=0
stop_timeout_timer || SWEEP_RESULT=1

# Sweep once after normal exit too — zero leftovers.
# 正常退出后也做一次清扫，确保无残留。
SWEEP 2>/dev/null || SWEEP_RESULT=$?
stop_owned_watchdog || SWEEP_RESULT=1
if [ "$SWEEP_RESULT" = "0" ]; then
  wrapper_log "── 运行结束 exit=${EXITCODE}，已清扫残留进程 ──"
else
  wrapper_log "✗ 运行结束 exit=${EXITCODE}，但未能确认受管进程组已清空" >&2
  [ "$EXITCODE" = "0" ] && EXITCODE=125
fi
exit "$EXITCODE"
