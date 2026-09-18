#!/usr/bin/env bash
# ============================================================================
# Canvast — Notarize macOS App / Canvast 源文件
# ============================================================================
# @file        scripts/notarize-macos-app.sh
# @brief       Notarize, staple, verify, and atomically publish a macOS App ZIP.
# @description 公证、装订、验证并原子发布 macOS App ZIP。
# @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
# ============================================================================
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERIFY_SCRIPT="$PROJECT_DIR/scripts/verify-macos-app.sh"
ARCHIVE_HELPER="$PROJECT_DIR/scripts/macos-app-archive.mjs"
SOURCE_MANIFEST="$PROJECT_DIR/release/source-manifest.json"
BUNDLE_BUILDER="$PROJECT_DIR/scripts/build-macos-app.sh"
NODE_BIN="${CANVAST_NODE_BIN:-$(command -v node || true)}"
XCRUN_BIN="${CANVAST_XCRUN_BIN:-/usr/bin/xcrun}"
SPCTL_BIN="${CANVAST_SPCTL_BIN:-/usr/sbin/spctl}"
ZIP_BIN="${CANVAST_ZIP_BIN:-/usr/bin/zip}"
DITTO_BIN="${CANVAST_DITTO_BIN:-/usr/bin/ditto}"
UNAME_BIN="${CANVAST_UNAME_BIN:-/usr/bin/uname}"

INPUT_APP=""
OUTPUT_ZIP=""
EXPECTED_TEAM_ID=""
EXPECTED_SIGNER_CN=""
KEYCHAIN_PROFILE=""
API_KEY_FILE=""
API_KEY_ID=""
API_ISSUER=""

usage() {
  cat <<'USAGE'
Usage:
  scripts/notarize-macos-app.sh --input-app PATH/Canvast.app --output-zip PATH/Canvast.app.zip \
    --expected-team-id TEAMID --expected-signer-cn "Developer ID Application: ... (TEAMID)" \
    (--keychain-profile PROFILE | --api-key-file FILE --api-key-id ID --api-issuer ISSUER)

The input App must already be Developer ID signed. This command copies it into
an isolated transaction, submits a temporary ZIP with `notarytool --wait`,
staples and validates the staged App, verifies public distribution policy,
verifies the final ZIP through a clean extraction, and publishes without
overwriting an existing output.

输入 App 必须已使用 Developer ID 签名。本命令在隔离事务中复制 App，使用
`notarytool --wait` 提交临时 ZIP，装订并验证暂存 App，通过公开分发校验和
ZIP 洁净解包校验后，以不覆盖已有输出的方式发布。

Credentials are accepted only through explicit command-line arguments. This
script never reads credential values from environment variables or prints them.
凭据仅允许通过显式命令行参数传入；脚本不会从环境变量读取或打印凭据。
USAGE
}

fail() {
  printf 'notarize-macos-app: %s\n' "$1" >&2
  exit 1
}

require_value() {
  [ "$#" -ge 2 ] && [ -n "$2" ] || fail "$1 requires a value"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --input-app)
      require_value "$@"
      [ -z "$INPUT_APP" ] || fail "--input-app may be supplied only once"
      INPUT_APP="$2"
      shift 2
      ;;
    --output-zip)
      require_value "$@"
      [ -z "$OUTPUT_ZIP" ] || fail "--output-zip may be supplied only once"
      OUTPUT_ZIP="$2"
      shift 2
      ;;
    --expected-team-id)
      require_value "$@"
      [ -z "$EXPECTED_TEAM_ID" ] || fail "--expected-team-id may be supplied only once"
      EXPECTED_TEAM_ID="$2"
      shift 2
      ;;
    --expected-signer-cn)
      require_value "$@"
      [ -z "$EXPECTED_SIGNER_CN" ] || fail "--expected-signer-cn may be supplied only once"
      EXPECTED_SIGNER_CN="$2"
      shift 2
      ;;
    --keychain-profile)
      require_value "$@"
      [ -z "$KEYCHAIN_PROFILE" ] || fail "--keychain-profile may be supplied only once"
      KEYCHAIN_PROFILE="$2"
      shift 2
      ;;
    --api-key-file)
      require_value "$@"
      [ -z "$API_KEY_FILE" ] || fail "--api-key-file may be supplied only once"
      API_KEY_FILE="$2"
      shift 2
      ;;
    --api-key-id)
      require_value "$@"
      [ -z "$API_KEY_ID" ] || fail "--api-key-id may be supplied only once"
      API_KEY_ID="$2"
      shift 2
      ;;
    --api-issuer)
      require_value "$@"
      [ -z "$API_ISSUER" ] || fail "--api-issuer may be supplied only once"
      API_ISSUER="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

[ "$("$UNAME_BIN" -s)" = "Darwin" ] || fail "macOS is required"
[ -n "$INPUT_APP" ] || fail "--input-app is required"
[ -n "$OUTPUT_ZIP" ] || fail "--output-zip is required"
[ -n "$EXPECTED_TEAM_ID" ] || fail "--expected-team-id is required"
[ -n "$EXPECTED_SIGNER_CN" ] || fail "--expected-signer-cn is required"
[ -x "$VERIFY_SCRIPT" ] || fail "macOS verifier is unavailable"
[ -f "$ARCHIVE_HELPER" ] || fail "macOS archive verifier is unavailable"
[ -f "$SOURCE_MANIFEST" ] || fail "source manifest is unavailable"
[ -f "$BUNDLE_BUILDER" ] || fail "bundle builder is unavailable"
[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || fail "Node.js is unavailable"
[ -x "$XCRUN_BIN" ] || fail "xcrun is unavailable"
[ -x "$SPCTL_BIN" ] || fail "spctl is unavailable"
[ -x "$ZIP_BIN" ] || fail "zip is unavailable"
[ -x "$DITTO_BIN" ] || fail "ditto is unavailable"

case "$EXPECTED_TEAM_ID" in *[!A-Z0-9]*|'') fail "expected Team ID must contain only uppercase ASCII letters and digits" ;; esac
[ "${#EXPECTED_TEAM_ID}" -eq 10 ] || fail "expected Team ID must contain exactly 10 characters"
case "$EXPECTED_SIGNER_CN" in "Developer ID Application: "*"($EXPECTED_TEAM_ID)") ;; *) fail "expected signer CN must identify the expected Developer ID Team" ;; esac

if [ -n "$KEYCHAIN_PROFILE" ]; then
  [ -z "$API_KEY_FILE$API_KEY_ID$API_ISSUER" ] \
    || fail "keychain profile and App Store Connect API credentials are mutually exclusive"
  AUTH_ARGS=(--keychain-profile "$KEYCHAIN_PROFILE")
else
  [ -n "$API_KEY_FILE" ] && [ -n "$API_KEY_ID" ] && [ -n "$API_ISSUER" ] \
    || fail "supply either --keychain-profile or the complete App Store Connect API credential set"
  [ -f "$API_KEY_FILE" ] && [ ! -L "$API_KEY_FILE" ] \
    || fail "App Store Connect API key must be a regular non-symlink file"
  AUTH_ARGS=(--key "$API_KEY_FILE" --key-id "$API_KEY_ID" --issuer "$API_ISSUER")
fi

case "$INPUT_APP" in /*) ;; *) INPUT_APP="$(pwd)/$INPUT_APP" ;; esac
case "$OUTPUT_ZIP" in /*) ;; *) OUTPUT_ZIP="$(pwd)/$OUTPUT_ZIP" ;; esac
INPUT_APP="${INPUT_APP%/}"
[ "$(basename "$INPUT_APP")" = "Canvast.app" ] || fail "input must be named Canvast.app"
[ -d "$INPUT_APP" ] && [ ! -L "$INPUT_APP" ] || fail "input App must be a real directory"
[ "$(basename "$OUTPUT_ZIP")" = "Canvast.app.zip" ] || fail "output must be named Canvast.app.zip"

OUTPUT_PARENT="$(dirname "$OUTPUT_ZIP")"
mkdir -p "$OUTPUT_PARENT"
[ ! -L "$OUTPUT_PARENT" ] || fail "output parent must not be a symlink"
OUTPUT_PARENT="$(cd "$OUTPUT_PARENT" && pwd -P)"
OUTPUT_ZIP="$OUTPUT_PARENT/$(basename "$OUTPUT_ZIP")"
[ ! -e "$OUTPUT_ZIP" ] && [ ! -L "$OUTPUT_ZIP" ] || fail "refusing to overwrite existing output"

STAGING_ROOT="$(mktemp -d "$OUTPUT_PARENT/.canvast-notarize.XXXXXX")"
STAGED_APP="$STAGING_ROOT/Canvast.app"
SUBMISSION_ZIP="$STAGING_ROOT/Canvast.submit.zip"
FINAL_ZIP="$STAGING_ROOT/Canvast.app.zip"
RECEIPT="$STAGING_ROOT/notary-receipt.json"
PUBLIC_VERIFY_WRAPPER="$STAGING_ROOT/verify-public.sh"

cleanup() {
  rm -rf "$STAGING_ROOT"
}
trap cleanup EXIT INT TERM

COPYFILE_DISABLE=1 "$DITTO_BIN" --norsrc --noextattr --noqtn --noacl "$INPUT_APP" "$STAGED_APP"

"$VERIFY_SCRIPT" \
  --signing-policy trusted \
  --distribution-policy internal \
  --expected-team-id "$EXPECTED_TEAM_ID" \
  --expected-signer-cn "$EXPECTED_SIGNER_CN" \
  "$STAGED_APP"

(cd "$STAGING_ROOT" && COPYFILE_DISABLE=1 "$ZIP_BIN" -X -q -r -y "$(basename "$SUBMISSION_ZIP")" "$(basename "$STAGED_APP")")
[ -s "$SUBMISSION_ZIP" ] || fail "temporary notarization submission archive was not created"

if ! /usr/bin/env \
  -u AC_USERNAME -u AC_PASSWORD -u AC_TEAM_ID \
  -u APPLE_ID -u APPLE_APP_SPECIFIC_PASSWORD \
  -u APP_STORE_CONNECT_API_KEY -u APP_STORE_CONNECT_API_KEY_ID -u APP_STORE_CONNECT_API_ISSUER \
  -u ASC_KEY_ID -u ASC_ISSUER_ID -u ASC_PRIVATE_KEY \
  "$XCRUN_BIN" notarytool submit "$SUBMISSION_ZIP" --wait --output-format json "${AUTH_ARGS[@]}" \
  >"$RECEIPT" 2>"$STAGING_ROOT/notarytool.stderr"; then
  fail "Apple notarization submission failed"
fi
"$NODE_BIN" --input-type=module - "$RECEIPT" <<'NODE' \
  || fail "Apple notarization did not return an accepted result"
import fs from "node:fs";
const receipt = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (receipt?.status !== "Accepted" || typeof receipt?.id !== "string" || !receipt.id) process.exit(1);
NODE

"$XCRUN_BIN" stapler staple "$STAGED_APP" >/dev/null
"$XCRUN_BIN" stapler validate -v "$STAGED_APP" >/dev/null

"$VERIFY_SCRIPT" \
  --signing-policy trusted \
  --distribution-policy public \
  --expected-team-id "$EXPECTED_TEAM_ID" \
  --expected-signer-cn "$EXPECTED_SIGNER_CN" \
  "$STAGED_APP"
"$SPCTL_BIN" --assess --type execute --verbose=4 "$STAGED_APP" >/dev/null

rm -f "$SUBMISSION_ZIP"
(cd "$STAGING_ROOT" && COPYFILE_DISABLE=1 "$ZIP_BIN" -X -q -r -y "$(basename "$FINAL_ZIP")" "$(basename "$STAGED_APP")")
[ -s "$FINAL_ZIP" ] || fail "final notarized application archive was not created"

cat >"$PUBLIC_VERIFY_WRAPPER" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec /bin/bash '$VERIFY_SCRIPT' --distribution-policy public "\$@"
EOF
chmod 0755 "$PUBLIC_VERIFY_WRAPPER"

"$NODE_BIN" "$ARCHIVE_HELPER" verify \
  --archive "$FINAL_ZIP" \
  --source-manifest "$SOURCE_MANIFEST" \
  --bundle-builder "$BUNDLE_BUILDER" \
  --verifier "$PUBLIC_VERIFY_WRAPPER" \
  --signing-policy trusted \
  --expected-team-id "$EXPECTED_TEAM_ID" \
  --expected-signer-cn "$EXPECTED_SIGNER_CN"

ln "$FINAL_ZIP" "$OUTPUT_ZIP" || fail "output appeared during publication; refusing to overwrite it"
"$NODE_BIN" --input-type=module - "$OUTPUT_ZIP" "$OUTPUT_PARENT" <<'NODE'
import fs from "node:fs";
const [output, parent] = process.argv.slice(2);
const file = fs.openSync(output, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
try { fs.fsyncSync(file); } finally { fs.closeSync(file); }
const directory = fs.openSync(parent, fs.constants.O_RDONLY);
try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
NODE

printf 'Notarized macOS archive published: %s\n' "$OUTPUT_ZIP"
