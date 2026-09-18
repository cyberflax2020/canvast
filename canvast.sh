#!/usr/bin/env bash
# ============================================================================
# Canvast — Canvast / Canvast 源文件
# ============================================================================
# @file        canvast.sh
# @brief       Canvast-owned source file.
# @description Part of the Canvast product codebase. Keep provenance and
#              license headers explicit for commercial redistribution.
# @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
# ============================================================================
# Launch Script / 启动脚本
# pi agent + Canvast extensions. Works from any directory.
# 通用启动命令，从任意目录执行。
#
# Usage:
#   ./canvast.sh                        # Interactive / 交互模式
#   ./canvast.sh "Fix the auth bug"     # Single task / 单次执行
#   ./canvast.sh -p "Hello"             # Print mode / 打印模式
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export CANVAST_INSTALL_DIR="${CANVAST_INSTALL_DIR:-$PROJECT_DIR}"
CANVAST_WORKING_DIR="${CANVAST_WORKING_DIR:-$PWD}"
export CANVAST_WORKING_DIR
if [ -z "${CANVAST_PROJECT_ROOT:-}" ]; then
  CANVAST_PROJECT_ROOT="$(node -e 'const fs=require("fs"); const path=require("path"); let dir=path.resolve(process.env.CANVAST_WORKING_DIR || process.cwd()); const markers=[".git","package.json","pyproject.toml","go.mod","Cargo.toml","pnpm-workspace.yaml"]; for (;;) { if (markers.some(m=>fs.existsSync(path.join(dir,m)))) { process.stdout.write(dir); break; } const parent=path.dirname(dir); if (parent===dir) { process.stdout.write(path.resolve(process.env.CANVAST_WORKING_DIR || process.cwd())); break; } dir=parent; }')"
fi
export CANVAST_PROJECT_ROOT
export CANVAST_HOME="${CANVAST_HOME:-${HOME:-/tmp}/.canvast}"
export CANVAST_COMPONENTS_DIR="${CANVAST_COMPONENTS_DIR:-$PROJECT_DIR/components}"
export CANVAST_COMPONENT_BIN_DIR="${CANVAST_COMPONENT_BIN_DIR:-$CANVAST_COMPONENTS_DIR/bin}"
if [ -d "$CANVAST_COMPONENT_BIN_DIR" ]; then
  case ":${PATH:-}:" in
    *":$CANVAST_COMPONENT_BIN_DIR:"*) ;;
    *) export PATH="$CANVAST_COMPONENT_BIN_DIR:${PATH:-}" ;;
  esac
fi

# Canvast ships a baseline component pack and does not let upstream pi silently
# download missing managed tools at startup. Users can opt into the original
# auto-download behavior explicitly, or run scripts/update-components.sh.
if [ -z "${PI_OFFLINE:-}" ] && [ "${CANVAST_ALLOW_COMPONENT_AUTO_DOWNLOAD:-0}" != "1" ]; then
  export PI_OFFLINE=1
fi

# API keys — explicit env wins, then local secret, then legacy .env.
# API 密钥 — 显式环境变量优先，其次本地 secret，最后兼容 legacy .env。
# shellcheck disable=SC1091
. "$PROJECT_DIR/scripts/live-env.sh"
canvast_load_live_env "$PROJECT_DIR"

if [ -z "${DEEPSEEK_API_KEY:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "Error: No API key found. Set DEEPSEEK_API_KEY or ANTHROPIC_API_KEY."
  echo "错误: 未找到 API 密钥。请设置 DEEPSEEK_API_KEY 或 ANTHROPIC_API_KEY 环境变量。"
  echo "Add the key to the local .env file copied from .env.example, or export it in this process."
  echo "请将密钥写入由 .env.example 复制的本地 .env 文件，或在当前进程中导出环境变量。"
  exit 1
fi

# Session and Canvas state are user-level and project-scoped by default.
# Single-run no-session mode uses a process-scoped temporary state directory.
PROJECT_KEY="$(node -e 'const crypto=require("crypto"); const path=require("path"); const root=path.resolve(process.env.CANVAST_PROJECT_ROOT || process.cwd()); const base=(path.basename(root)||"project").replace(/[^A-Za-z0-9._-]/g,"_").slice(0,48)||"project"; const hash=crypto.createHash("sha256").update(root).digest("hex").slice(0,12); process.stdout.write(`${base}-${hash}`);')"
NO_SESSION=0
HAS_PROVIDER=0
HAS_MODEL=0
HAS_THINKING=0
HAS_JSON_MODE=0
MODEL_HAS_PROVIDER=0
FORWARDED_ARGS=()
CANVAST_SKILL_REQUESTS=()
CANVAST_SKILL_REQUEST_COUNT=0
FORWARDED_NO_SESSION=0
MODE_EXPECTS_VALUE=0
OWNED_HANDLE_SNAPSHOT_COUNT=0
OWNED_HANDLE_INVOCATION_ID_COUNT=0
normalize_canvast_mode() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  value="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
  case "$value" in
    enhanced|on|true|1|plus|canvast|canvest|super) printf '%s' "enhanced" ;;
    parity|off|false|0|baseline|compat|compatible) printf '%s' "parity" ;;
    *) return 1 ;;
  esac
}
validate_owned_handle_invocation_id() {
  node -e 'const value=process.argv[1]; process.exit(value.length > 0 && value.length <= 256 && /^[\x20-\x7e]+$/.test(value) ? 0 : 1)' "$1"
}

while [ "$#" -gt 0 ]; do
  arg="$1"
  if [ "$MODE_EXPECTS_VALUE" -eq 1 ]; then
    [ "$arg" = "json" ] && HAS_JSON_MODE=1
    MODE_EXPECTS_VALUE=0
  fi
  case "$arg" in
    --canvast-owned-handle-snapshot)
      if [ "$OWNED_HANDLE_SNAPSHOT_COUNT" -ne 0 ]; then
        echo "Error: $arg may only be specified once." >&2
        exit 2
      fi
      if [ "$#" -lt 2 ] || [[ "$2" == --* ]]; then
        echo "Error: $arg requires an absolute path without NUL." >&2
        exit 2
      fi
      case "$2" in
        /*) export CANVAST_OWNED_HANDLE_SNAPSHOT="$2" ;;
        *) echo "Error: $arg requires an absolute path without NUL." >&2; exit 2 ;;
      esac
      OWNED_HANDLE_SNAPSHOT_COUNT=1
      shift
      ;;
    --canvast-owned-handle-snapshot=*)
      if [ "$OWNED_HANDLE_SNAPSHOT_COUNT" -ne 0 ]; then
        echo "Error: --canvast-owned-handle-snapshot may only be specified once." >&2
        exit 2
      fi
      owned_handle_snapshot="${arg#*=}"
      case "$owned_handle_snapshot" in
        /*) export CANVAST_OWNED_HANDLE_SNAPSHOT="$owned_handle_snapshot" ;;
        *) echo "Error: --canvast-owned-handle-snapshot requires an absolute path without NUL." >&2; exit 2 ;;
      esac
      OWNED_HANDLE_SNAPSHOT_COUNT=1
      ;;
    --canvast-owned-handle-invocation-id)
      if [ "$OWNED_HANDLE_INVOCATION_ID_COUNT" -ne 0 ]; then
        echo "Error: $arg may only be specified once." >&2
        exit 2
      fi
      if [ "$#" -lt 2 ] || [[ "$2" == --* ]] || ! validate_owned_handle_invocation_id "$2"; then
        echo "Error: $arg must be a printable string of at most 256 characters." >&2
        exit 2
      fi
      export CANVAST_OWNED_HANDLE_INVOCATION_ID="$2"
      OWNED_HANDLE_INVOCATION_ID_COUNT=1
      shift
      ;;
    --canvast-owned-handle-invocation-id=*)
      if [ "$OWNED_HANDLE_INVOCATION_ID_COUNT" -ne 0 ]; then
        echo "Error: --canvast-owned-handle-invocation-id may only be specified once." >&2
        exit 2
      fi
      owned_handle_invocation_id="${arg#*=}"
      if ! validate_owned_handle_invocation_id "$owned_handle_invocation_id"; then
        echo "Error: --canvast-owned-handle-invocation-id must be a printable string of at most 256 characters." >&2
        exit 2
      fi
      export CANVAST_OWNED_HANDLE_INVOCATION_ID="$owned_handle_invocation_id"
      OWNED_HANDLE_INVOCATION_ID_COUNT=1
      ;;
    --no-session|--no-session-persistence|--canvast-no-session-persistence)
      NO_SESSION=1
      if [ "$FORWARDED_NO_SESSION" -eq 0 ]; then
        FORWARDED_ARGS+=("--no-session")
        FORWARDED_NO_SESSION=1
      fi
      ;;
    --canvast-mode|--canvest-mode)
      if [ "$#" -lt 2 ]; then
        echo "Error: $arg requires parity or enhanced." >&2
        exit 2
      fi
      if ! canvast_mode="$(normalize_canvast_mode "$2")"; then
        echo "Error: $arg must be parity or enhanced." >&2
        exit 2
      fi
      export CANVAST_MODE="$canvast_mode"
      export CANVAST_MODE_SOURCE="argv"
      shift
      ;;
    --canvast-mode=*|--canvest-mode=*)
      if ! canvast_mode="$(normalize_canvast_mode "${arg#*=}")"; then
        echo "Error: ${arg%%=*} must be parity or enhanced." >&2
        exit 2
      fi
      export CANVAST_MODE="$canvast_mode"
      export CANVAST_MODE_SOURCE="argv"
      ;;
    --canvast-enhanced|--canvest-enhanced)
      export CANVAST_MODE="enhanced"
      export CANVAST_MODE_SOURCE="argv"
      ;;
    --no-canvast-enhanced|--no-canvest-enhanced|--canvast-parity|--canvest-parity)
      export CANVAST_MODE="parity"
      export CANVAST_MODE_SOURCE="argv"
      ;;
    --canvast-sandbox|--canvest-sandbox)
      if [ "$#" -lt 2 ]; then
        echo "Error: $arg requires read-only, workspace-write, or full-access." >&2
        exit 2
      fi
      export CANVAST_SANDBOX="$2"
      shift
      ;;
    --canvast-sandbox=*|--canvest-sandbox=*)
      export CANVAST_SANDBOX="${arg#*=}"
      ;;
    --canvast-unattended|--canvest-unattended)
      export CANVAST_UNATTENDED=1
      ;;
    --no-canvast-unattended|--no-canvest-unattended)
      export CANVAST_UNATTENDED=0
      ;;
    --canvast-skill|--canvest-skill)
      if [ "$#" -lt 2 ]; then
        echo "Error: $arg requires a skill name from skills/manifest.json." >&2
        exit 2
      fi
      CANVAST_SKILL_REQUESTS+=("$2")
      CANVAST_SKILL_REQUEST_COUNT=$((CANVAST_SKILL_REQUEST_COUNT + 1))
      shift
      ;;
    --canvast-skill=*|--canvest-skill=*)
      CANVAST_SKILL_REQUESTS+=("${arg#*=}")
      CANVAST_SKILL_REQUEST_COUNT=$((CANVAST_SKILL_REQUEST_COUNT + 1))
      ;;
    --provider)
      HAS_PROVIDER=1
      FORWARDED_ARGS+=("$arg")
      ;;
    --provider=*)
      HAS_PROVIDER=1
      FORWARDED_ARGS+=("$arg")
      ;;
    --model)
      HAS_MODEL=1
      if [ "$#" -ge 2 ] && [[ "$2" == */* ]]; then
        MODEL_HAS_PROVIDER=1
      fi
      FORWARDED_ARGS+=("$arg")
      ;;
    --model=*)
      HAS_MODEL=1
      model_value="${arg#*=}"
      if [[ "$model_value" == */* ]]; then
        MODEL_HAS_PROVIDER=1
      fi
      FORWARDED_ARGS+=("$arg")
      ;;
    --thinking)
      HAS_THINKING=1
      FORWARDED_ARGS+=("$arg")
      ;;
    --thinking=*)
      HAS_THINKING=1
      FORWARDED_ARGS+=("$arg")
      ;;
    --mode)
      MODE_EXPECTS_VALUE=1
      FORWARDED_ARGS+=("$arg")
      ;;
    --mode=json)
      HAS_JSON_MODE=1
      FORWARDED_ARGS+=("$arg")
      ;;
    *)
      FORWARDED_ARGS+=("$arg")
      ;;
  esac
  shift
done

if [ "$OWNED_HANDLE_SNAPSHOT_COUNT" -ne "$OWNED_HANDLE_INVOCATION_ID_COUNT" ]; then
  echo "Error: --canvast-owned-handle-snapshot and --canvast-owned-handle-invocation-id must be provided together." >&2
  exit 2
fi

if [ "$NO_SESSION" -eq 1 ] || [[ "${CANVAST_NO_SESSION_PERSISTENCE:-}" =~ ^(1|true|yes|on)$ ]] || [[ "${CANVAST_EPHEMERAL:-}" =~ ^(1|true|yes|on)$ ]]; then
  export CANVAST_PERSISTENCE_MODE="ephemeral"
  export PI_CODING_AGENT_DIR="${CANVAST_AGENT_DIR:-${CANVAST_TMPDIR:-${TMPDIR:-/tmp}}/canvast/ephemeral/${PROJECT_KEY}-$$/state}"
  unset PI_CODING_AGENT_SESSION_DIR
else
  export CANVAST_PERSISTENCE_MODE="persistent"
  export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-${CANVAST_AGENT_DIR:-$CANVAST_HOME/projects/$PROJECT_KEY/state}}"
  export PI_CODING_AGENT_SESSION_DIR="${PI_CODING_AGENT_SESSION_DIR:-${CANVAST_SESSION_DIR:-$CANVAST_HOME/projects/$PROJECT_KEY/sessions}}"
  mkdir -p "$PI_CODING_AGENT_SESSION_DIR"
fi
mkdir -p "$PI_CODING_AGENT_DIR"

# Canvast extensions / Canvast 扩展
# Keep this list in sync with CANVAST_EXTENSION_FILES in src/cli.ts.
# canvast-core.ts MUST be first — it provides the Canvas foundation.
# canvast-harness.ts wires the control planes (scoping / plan constraints / budget / capOrSpill).
EXTENSIONS=(
  "$PROJECT_DIR/extensions/canvast-core.ts"
  "$PROJECT_DIR/extensions/canvast-harness.ts"
  "$PROJECT_DIR/extensions/canvast-tui.ts"
  "$PROJECT_DIR/extensions/product-closure.ts"
  "$PROJECT_DIR/extensions/sandbox-bash.ts"
  "$PROJECT_DIR/extensions/canvast-permissions.ts"
  "$PROJECT_DIR/extensions/desktop-action.ts"
  "$PROJECT_DIR/extensions/plan-mode.ts"
  "$PROJECT_DIR/extensions/task-manager.ts"
  "$PROJECT_DIR/extensions/web-tools.ts"
  "$PROJECT_DIR/extensions/sub-agent.ts"
  "$PROJECT_DIR/extensions/code-review.ts"
  "$PROJECT_DIR/extensions/ask-user.ts"
  "$PROJECT_DIR/extensions/mcp-bridge.ts"
  "$PROJECT_DIR/extensions/git-tools.ts"
  "$PROJECT_DIR/extensions/token-tracker.ts"
  "$PROJECT_DIR/extensions/background-task.ts"
  "$PROJECT_DIR/extensions/canvas-repomap.ts"
  "$PROJECT_DIR/extensions/notebook-edit.ts"
  "$PROJECT_DIR/extensions/lsp-tools.ts"
  "$PROJECT_DIR/extensions/workflow.ts"
  "$PROJECT_DIR/extensions/cron-scheduler.ts"
  "$PROJECT_DIR/extensions/worktree.ts"
  "$PROJECT_DIR/extensions/artifact.ts"
  "$PROJECT_DIR/extensions/agent-comms.ts"
  "$PROJECT_DIR/extensions/report-findings.ts"
  "$PROJECT_DIR/extensions/monitor.ts"
  "$PROJECT_DIR/extensions/owned-handle-diagnostics.ts"
)

EXT_ARGS=()
for ext in "${EXTENSIONS[@]}"; do
  [ -f "$ext" ] && EXT_ARGS+=("--extension" "$ext")
done

SKILL_ARGS=()
if [ "$CANVAST_SKILL_REQUEST_COUNT" -gt 0 ]; then
  for skill_request in "${CANVAST_SKILL_REQUESTS[@]}"; do
    skill_output="$(node "$PROJECT_DIR/scripts/resolve-canvast-skill.mjs" "$PROJECT_DIR" "$skill_request")"
    while IFS= read -r skill_path; do
      [ -n "$skill_path" ] && SKILL_ARGS+=("--skill" "$skill_path")
    done <<< "$skill_output"
  done
fi

MODEL_ARGS=()
if [ "$HAS_PROVIDER" -eq 0 ] && [ "$MODEL_HAS_PROVIDER" -eq 0 ]; then
  MODEL_ARGS+=("--provider" "${CANVAST_PROVIDER:-${CANVAST_DEFAULT_PROVIDER:-deepseek}}")
fi
if [ "$HAS_MODEL" -eq 0 ]; then
  MODEL_ARGS+=("--model" "${CANVAST_MODEL:-${CANVAST_DEFAULT_MODEL:-deepseek-v4-pro}}")
fi
if [ "$HAS_THINKING" -eq 0 ]; then
  MODEL_ARGS+=("--thinking" "${CANVAST_THINKING:-high}")
fi

# Run pi agent with Canvast extensions. Bash 3.2 treats an empty
# "${array[@]}" as unbound under set -u, so append arrays only when non-empty.
PI_ARGS=("$PROJECT_DIR/node_modules/@earendil-works/pi-coding-agent/dist/cli.js")
if [ "${#MODEL_ARGS[@]}" -gt 0 ]; then
  PI_ARGS+=("${MODEL_ARGS[@]}")
fi
if [ "${#EXT_ARGS[@]}" -gt 0 ]; then
  PI_ARGS+=("${EXT_ARGS[@]}")
fi
if [ "${#SKILL_ARGS[@]}" -gt 0 ]; then
  PI_ARGS+=("${SKILL_ARGS[@]}")
fi
if [ "${#FORWARDED_ARGS[@]}" -gt 0 ]; then
  PI_ARGS+=("${FORWARDED_ARGS[@]}")
fi
if [ "$HAS_JSON_MODE" -eq 1 ] && [ "${CANVAST_EXPOSE_THINKING:-0}" != "1" ]; then
  JSON_PIPE_DIR="${CANVAST_TMPDIR:-${TMPDIR:-/tmp}}"
  JSON_PIPE="$JSON_PIPE_DIR/canvast-json-filter-$$.fifo"
  JSON_PI_PID=""
  JSON_FILTER_PID=""
  JSON_SIGNAL_STATUS=0
  JSON_FILTER_FORCED=0

  json_cleanup() {
    [ -z "${JSON_PIPE:-}" ] || rm -f "$JSON_PIPE"
  }
  json_signal() {
    case "$1" in
      INT) JSON_SIGNAL_STATUS=130 ;;
      TERM) JSON_SIGNAL_STATUS=143 ;;
      *) JSON_SIGNAL_STATUS=129 ;;
    esac
    if [ -n "$JSON_PI_PID" ] && kill -0 "$JSON_PI_PID" 2>/dev/null; then
      kill -"$1" "$JSON_PI_PID" 2>/dev/null || true
    fi
  }
  json_wait() {
    local pid="$1" status=0
    while :; do
      wait "$pid"
      status=$?
      if [ "$JSON_SIGNAL_STATUS" -ne 0 ] && kill -0 "$pid" 2>/dev/null; then
        continue
      fi
      return "$status"
    done
  }
  json_filter_running() {
    local job_pid
    while IFS= read -r job_pid; do
      [ "$job_pid" = "$JSON_FILTER_PID" ] && return 0
    done <<EOF
$(jobs -pr)
EOF
    return 1
  }
  json_wait_filter_after_pi() {
    local attempts="${CANVAST_JSON_FILTER_DRAIN_ATTEMPTS:-10}"
    local delay="${CANVAST_JSON_FILTER_DRAIN_DELAY:-0.1}"
    local i=0 status=0
    while [ "$i" -lt "$attempts" ]; do
      if ! json_filter_running; then
        wait "$JSON_FILTER_PID"
        return "$?"
      fi
      sleep "$delay"
      i=$((i + 1))
    done
    if json_filter_running; then
      JSON_FILTER_FORCED=1
      kill -TERM "$JSON_FILTER_PID" 2>/dev/null || true
    fi
    i=0
    while [ "$i" -lt 10 ]; do
      if ! json_filter_running; then
        wait "$JSON_FILTER_PID"
        return "$?"
      fi
      sleep 0.1
      i=$((i + 1))
    done
    if json_filter_running; then
      kill -KILL "$JSON_FILTER_PID" 2>/dev/null || true
    fi
    wait "$JSON_FILTER_PID" 2>/dev/null
    status=$?
    return "$status"
  }

  trap json_cleanup EXIT
  trap 'json_signal INT' INT
  trap 'json_signal TERM' TERM
  rm -f "$JSON_PIPE"
  mkfifo -m 600 "$JSON_PIPE"
  node "$PROJECT_DIR/scripts/filter-json-output.mjs" < "$JSON_PIPE" &
  JSON_FILTER_PID=$!
  node "${PI_ARGS[@]}" > "$JSON_PIPE" &
  JSON_PI_PID=$!
  set +e
  json_wait "$JSON_PI_PID"
  JSON_PI_STATUS=$?
  json_wait_filter_after_pi
  JSON_FILTER_STATUS=$?
  set -e
  json_cleanup
  trap - EXIT INT TERM
  if [ "$JSON_PI_STATUS" -ne 0 ]; then
    exit "$JSON_PI_STATUS"
  fi
  if [ "$JSON_FILTER_FORCED" -eq 1 ]; then
    exit 0
  fi
  exit "$JSON_FILTER_STATUS"
fi
exec node "${PI_ARGS[@]}"
