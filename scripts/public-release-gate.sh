#!/usr/bin/env bash
# ============================================================================
# Canvast — Public Release Gate / Canvast 源文件
# ============================================================================
# @file        scripts/public-release-gate.sh
# @brief       Fail-closed wrapper for public release gate verification.
# @description Captures and asserts the exact repository-owned OS process
#              baseline around verify-public-release without mutating processes.
# @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
# ============================================================================
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

RESOURCE_BASELINE="$PROJECT_DIR/.pi/resource-baseline.public-release-gate.$$.json"
RESOURCE_BASELINE_READY=0
VERIFIER_SCRIPT="${CANVAST_PUBLIC_RELEASE_GATE_VERIFIER:-$PROJECT_DIR/scripts/verify-public-release.mjs}"
RESOURCE_BASELINE_CAPTURE_FIXTURE="${CANVAST_RESOURCE_BASELINE_PROCESS_FIXTURE_CAPTURE:-${CANVAST_RESOURCE_BASELINE_PROCESS_FIXTURE:-}}"
RESOURCE_BASELINE_ASSERT_FIXTURE="${CANVAST_RESOURCE_BASELINE_PROCESS_FIXTURE_ASSERT:-${CANVAST_RESOURCE_BASELINE_PROCESS_FIXTURE:-}}"

if [ "${CANVAST_OWNED_HANDLE_SNAPSHOT+x}" = "x" ] \
  || [ "${CANVAST_OWNED_HANDLE_INVOCATION_ID+x}" = "x" ]; then
  echo "CANVAST_OWNED_HANDLE_SNAPSHOT and CANVAST_OWNED_HANDLE_INVOCATION_ID are reserved for the nested public runtime proof and must not be set in the public-release-gate environment" >&2
  exit 2
fi

if [ -n "$RESOURCE_BASELINE_CAPTURE_FIXTURE" ] || [ -n "$RESOURCE_BASELINE_ASSERT_FIXTURE" ]; then
  if [ "${NODE_ENV:-}" != "test" ]; then
    echo "CANVAST_RESOURCE_BASELINE_PROCESS_FIXTURE* is test-only and requires NODE_ENV=test" >&2
    exit 2
  fi
fi

resource_baseline_capture() {
  if [ -n "$RESOURCE_BASELINE_CAPTURE_FIXTURE" ]; then
    node scripts/assert-resource-baseline.mjs capture \
      --repo "$PROJECT_DIR" \
      --baseline "$RESOURCE_BASELINE" \
      --process-fixture "$RESOURCE_BASELINE_CAPTURE_FIXTURE"
  else
    node scripts/assert-resource-baseline.mjs capture \
      --repo "$PROJECT_DIR" \
      --baseline "$RESOURCE_BASELINE"
  fi
}

resource_baseline_assert() {
  local command=(
    node scripts/assert-resource-baseline.mjs assert
    --repo "$PROJECT_DIR"
    --baseline "$RESOURCE_BASELINE"
    --settle-ms "${CANVAST_RESOURCE_BASELINE_SETTLE_MS:-1000}"
    --poll-ms "${CANVAST_RESOURCE_BASELINE_POLL_MS:-100}"
  )
  if [ -n "$RESOURCE_BASELINE_ASSERT_FIXTURE" ]; then
    command+=(--process-fixture "$RESOURCE_BASELINE_ASSERT_FIXTURE")
  fi
  "${command[@]}"
}

resource_baseline_exit() {
  local original_status=$?
  local assertion_status=0
  trap - EXIT
  if [ "$RESOURCE_BASELINE_READY" = "1" ]; then
    resource_baseline_assert || assertion_status=$?
  fi
  rm -f "$RESOURCE_BASELINE" || true
  if [ "$original_status" -ne 0 ]; then
    exit "$original_status"
  fi
  exit "$assertion_status"
}

trap resource_baseline_exit EXIT
mkdir -p "$PROJECT_DIR/.pi"
resource_baseline_capture
RESOURCE_BASELINE_READY=1

node "$VERIFIER_SCRIPT" "$@"
