#!/usr/bin/env bash
# ============================================================================
# Canvast — Live Env / Canvast 源文件
# ============================================================================
# @file        scripts/live-env.sh
# @brief       Canvast-owned source file.
# @description Part of the Canvast product codebase. Keep provenance and
#              license headers explicit for commercial redistribution.
# @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
# ============================================================================
# live environment loader / Canvast live 环境加载器
# Source this file from launch/verification scripts, then call:
#
#   canvast_load_live_env "$PROJECT_DIR"
#
# Precedence:
#   1. Already exported process environment values
#   2. Local gitignored secret file: .canvast-secrets/live.env
#   3. Legacy project .env
#
# Secret values are never printed here. The local secret file is intentionally
# separate from .env so eval cases cannot accidentally overwrite durable live
# credentials.
canvast_env_name_allowed() {
  local name="$1"
  case "$name" in
    ""|[0-9]*|*[!A-Za-z0-9_]*)
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}

canvast_secret_name_allowed() {
  local name="$1"
  case "$name" in
    DEEPSEEK_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

canvast_env_was_originally_set() {
  local name="$1"
  local item
  for item in ${CANVAST_LIVE_ORIGINAL_ENV_NAMES:-}; do
    if [ "$item" = "$name" ]; then
      return 0
    fi
  done
  return 1
}

canvast_assign_env_value() {
  local name="$1"
  local value="$2"
  local source_kind="$3"

  if ! canvast_env_name_allowed "$name"; then
    return 0
  fi

  if [ "$source_kind" = "secret" ] && ! canvast_secret_name_allowed "$name"; then
    return 0
  fi

  if [ "$source_kind" = "legacy" ] && [ -n "${!name+x}" ]; then
    return 0
  fi

  if [ "$source_kind" = "secret" ] && canvast_env_was_originally_set "$name"; then
    return 0
  fi

  export "$name=$value"
}

canvast_source_env_file() {
  local env_file="$1"
  local source_kind="${2:-legacy}"
  local line name value

  if [ ! -f "$env_file" ]; then
    return 0
  fi

  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ""|\#*)
        continue
        ;;
      export\ *)
        line="${line#export }"
        ;;
    esac

    case "$line" in
      *=*) ;;
      *) continue ;;
    esac

    name="${line%%=*}"
    value="${line#*=}"
    case "$value" in
      \"*\")
        value="${value#\"}"
        value="${value%\"}"
        ;;
      \'*\')
        value="${value#\'}"
        value="${value%\'}"
        ;;
    esac

    canvast_assign_env_value "$name" "$value" "$source_kind"
  done < "$env_file"
}

canvast_load_live_env() {
  local project_dir="${1:-${PROJECT_DIR:-$(pwd)}}"
  local secret_file="${CANVAST_LIVE_SECRET_FILE:-$project_dir/.canvast-secrets/live.env}"
  local names=(DEEPSEEK_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY)
  local name
  local original_names=""

  for name in "${names[@]}"; do
    if [ -n "${!name+x}" ]; then
      original_names="${original_names}${original_names:+ }${name}"
    fi
  done

  CANVAST_LIVE_ORIGINAL_ENV_NAMES="$original_names"
  canvast_source_env_file "$project_dir/.env" legacy
  canvast_source_env_file "$secret_file" secret
  unset CANVAST_LIVE_ORIGINAL_ENV_NAMES

  if [ -f "$secret_file" ]; then
    export CANVAST_LIVE_SECRET_FILE_LOADED="$secret_file"
  fi
}
