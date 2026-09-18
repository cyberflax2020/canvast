#!/usr/bin/env bash
# ============================================================================
# Canvast — Verify macOS App / Canvast 源文件
# ============================================================================
# @file        scripts/verify-macos-app.sh
# @brief       Verify the Canvast macOS application bundle without opening it.
# @description 默认无窗口验证 Canvast macOS 应用包，并提供显式 GUI smoke 入口。
# @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
# ============================================================================
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CODESIGN_BIN="${CANVAST_CODESIGN_BIN:-/usr/bin/codesign}"
PLUTIL_BIN="${CANVAST_PLUTIL_BIN:-/usr/bin/plutil}"
PLIST_BUDDY="${CANVAST_PLIST_BUDDY:-/usr/libexec/PlistBuddy}"
LIPO_BIN="${CANVAST_LIPO_BIN:-/usr/bin/lipo}"
FIND_BIN="${CANVAST_FIND_BIN:-/usr/bin/find}"
XCRUN_BIN="${CANVAST_XCRUN_BIN:-/usr/bin/xcrun}"
SPCTL_BIN="${CANVAST_SPCTL_BIN:-/usr/sbin/spctl}"
FILE_BIN="${CANVAST_FILE_BIN:-/usr/bin/file}"
NODE_BIN="${CANVAST_NODE_BIN:-$(command -v node || true)}"
RUNTIME_HELPER="$PROJECT_DIR/scripts/product-runtime.mjs"
RESOURCE_BUNDLE_NAME="CanvastMacApp_CanvastApp.bundle"
RESOURCE_PROBE_NAME="CanvastResourceProbe"
RUNTIME_ROOT_NAME="CanvastRuntime"
APP_PATH=""
EXPECTED_ARCHS="${CANVAST_EXPECTED_ARCHS:-$(uname -m)}"
RUN_GUI_SMOKE=0
GUI_SMOKE_SECONDS="${CANVAST_GUI_SMOKE_SECONDS:-3}"
SIGNING_POLICY=""
DISTRIBUTION_POLICY="${CANVAST_DISTRIBUTION_POLICY:-internal}"
EXPECTED_TEAM_ID=""
EXPECTED_SIGNER_CN=""

usage() {
  cat <<'USAGE'
Usage: scripts/verify-macos-app.sh [options] PATH/Canvast.app

Options:
  --expected-arch ARCH     Required executable architecture; repeatable or comma-separated
  --signing-policy POLICY  Required signature policy: adhoc or trusted
  --distribution-policy P  Delivery policy: local, internal, or public
  --expected-team-id ID    Exact Apple Developer Team ID (required for trusted)
  --expected-signer-cn CN  Exact Developer ID Application certificate common name (trusted)
  --gui-smoke              Opt in to a bounded GUI process-liveness smoke
  --gui-smoke-seconds N    Liveness window in seconds (default: 3; implies --gui-smoke)
  -h, --help               Show this help

The default verification never launches the GUI or executes code from inside the
application bundle. It validates bundle structure, Info.plist, the SwiftPM resource
bundle, the selected signing policy, Mach-O arches, and the sealed runtime using
trusted host tooling.
`--distribution-policy public` additionally requires a stapled notarization
ticket, `codesign --check-notarization`, `xcrun stapler validate`, and
`spctl --assess --type execute` acceptance. Internal/local verification never
claims public-release eligibility.
USAGE
}

fail() {
  printf 'verify-macos-app: %s\n' "$1" >&2
  exit 1
}

say() {
  printf '\n==> %s\n' "$1"
}

append_expected_arch() {
  local next="$1"
  if [ -z "$EXPECTED_ARCHS" ]; then
    EXPECTED_ARCHS="$next"
  else
    EXPECTED_ARCHS="$EXPECTED_ARCHS,$next"
  fi
}

EXPECTED_ARCH_OPTION_SEEN=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --expected-arch)
      [ "$#" -ge 2 ] || fail "--expected-arch requires a value"
      if [ "$EXPECTED_ARCH_OPTION_SEEN" -eq 0 ]; then
        EXPECTED_ARCHS=""
        EXPECTED_ARCH_OPTION_SEEN=1
      fi
      append_expected_arch "$2"
      shift 2
      ;;
    --signing-policy)
      [ "$#" -ge 2 ] || fail "--signing-policy requires a value"
      [ -z "$SIGNING_POLICY" ] || fail "--signing-policy may be supplied only once"
      SIGNING_POLICY="$2"
      shift 2
      ;;
    --distribution-policy)
      [ "$#" -ge 2 ] || fail "--distribution-policy requires a value"
      [ "$DISTRIBUTION_POLICY" = "${CANVAST_DISTRIBUTION_POLICY:-internal}" ] || fail "--distribution-policy may be supplied only once"
      DISTRIBUTION_POLICY="$2"
      shift 2
      ;;
    --expected-team-id)
      [ "$#" -ge 2 ] || fail "--expected-team-id requires a value"
      [ -z "$EXPECTED_TEAM_ID" ] || fail "--expected-team-id may be supplied only once"
      EXPECTED_TEAM_ID="$2"
      shift 2
      ;;
    --expected-signer-cn)
      [ "$#" -ge 2 ] || fail "--expected-signer-cn requires a value"
      [ -z "$EXPECTED_SIGNER_CN" ] || fail "--expected-signer-cn may be supplied only once"
      EXPECTED_SIGNER_CN="$2"
      shift 2
      ;;
    --gui-smoke)
      RUN_GUI_SMOKE=1
      shift
      ;;
    --gui-smoke-seconds)
      [ "$#" -ge 2 ] || fail "--gui-smoke-seconds requires a value"
      GUI_SMOKE_SECONDS="$2"
      RUN_GUI_SMOKE=1
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      fail "unknown argument: $1"
      ;;
    *)
      [ -z "$APP_PATH" ] || fail "only one .app path may be supplied"
      APP_PATH="$1"
      shift
      ;;
  esac
done

[ "$(uname -s)" = "Darwin" ] || fail "macOS is required"
[ -n "$APP_PATH" ] || fail "a .app path is required"
[ -n "$SIGNING_POLICY" ] || fail "--signing-policy adhoc|trusted is required"
case "$DISTRIBUTION_POLICY" in
  local|internal)
    DISTRIBUTION_POLICY="internal"
    ;;
  public) ;;
  *) fail "distribution policy must be local, internal, or public" ;;
esac
case "$SIGNING_POLICY" in
  adhoc)
    [ -z "$EXPECTED_TEAM_ID" ] || fail "--expected-team-id is valid only with --signing-policy trusted"
    [ -z "$EXPECTED_SIGNER_CN" ] || fail "--expected-signer-cn is valid only with --signing-policy trusted"
    ;;
  trusted)
    [ -n "$EXPECTED_TEAM_ID" ] || fail "--expected-team-id is required with --signing-policy trusted"
    [ -n "$EXPECTED_SIGNER_CN" ] || fail "--expected-signer-cn is required with --signing-policy trusted"
    case "$EXPECTED_TEAM_ID" in *[!A-Z0-9]*|'') fail "expected Team ID must contain only uppercase ASCII letters and digits" ;; esac
    [ "${#EXPECTED_TEAM_ID}" -eq 10 ] || fail "expected Team ID must contain exactly 10 characters"
    case "$EXPECTED_SIGNER_CN" in "Developer ID Application: "*) ;; *) fail "expected signer CN must name a Developer ID Application certificate" ;; esac
    case "$EXPECTED_SIGNER_CN" in *"($EXPECTED_TEAM_ID)") ;; *) fail "expected signer CN must end with the expected Team ID" ;; esac
    case "$EXPECTED_SIGNER_CN" in *'"'*|*'\'*|*$'\n'*|*$'\r'*) fail "expected signer CN contains an unsafe character" ;; esac
    ;;
  *) fail "signing policy must be adhoc or trusted" ;;
esac
[ -x "$CODESIGN_BIN" ] || fail "codesign executable not found: $CODESIGN_BIN"
[ -x "$PLUTIL_BIN" ] || fail "plutil executable not found: $PLUTIL_BIN"
[ -x "$PLIST_BUDDY" ] || fail "PlistBuddy executable not found: $PLIST_BUDDY"
[ -x "$LIPO_BIN" ] || fail "lipo executable not found: $LIPO_BIN"
[ -x "$FIND_BIN" ] || fail "find executable not found: $FIND_BIN"
[ -x "$FILE_BIN" ] || fail "file executable not found: $FILE_BIN"
[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || fail "Node.js executable not found"
[ -f "$RUNTIME_HELPER" ] && [ ! -L "$RUNTIME_HELPER" ] \
  || fail "trusted runtime verifier must be a regular file: $RUNTIME_HELPER"
if [ "$DISTRIBUTION_POLICY" = "public" ]; then
  [ "$SIGNING_POLICY" = "trusted" ] || fail "public distribution requires --signing-policy trusted"
  [ -x "$XCRUN_BIN" ] || fail "xcrun executable not found: $XCRUN_BIN"
  [ -x "$SPCTL_BIN" ] || fail "spctl executable not found: $SPCTL_BIN"
fi
if ! [[ "$GUI_SMOKE_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  fail "GUI smoke duration must be a positive integer"
fi

case "$APP_PATH" in
  /*) ;;
  *) APP_PATH="$(pwd)/$APP_PATH" ;;
esac
APP_PATH="${APP_PATH%/}"
case "$(basename "$APP_PATH")" in
  *.app) ;;
  *) fail "bundle path must end in .app: $APP_PATH" ;;
esac
[ -d "$APP_PATH" ] && [ ! -L "$APP_PATH" ] || fail "application bundle must be a real directory: $APP_PATH"
APP_PATH="$(/bin/realpath "$APP_PATH" 2>/dev/null)" \
  || fail "unable to resolve application bundle path"
NODE_BIN_REAL="$(/bin/realpath "$NODE_BIN" 2>/dev/null)" \
  || fail "unable to resolve host Node.js executable: $NODE_BIN"
case "$NODE_BIN_REAL" in
  "$APP_PATH"|"$APP_PATH/"*) fail "host Node.js executable must be outside the application bundle" ;;
esac
NODE_BIN="$NODE_BIN_REAL"

CONTENTS="$APP_PATH/Contents"
INFO_PLIST="$CONTENTS/Info.plist"
RESOURCES="$CONTENTS/Resources"
RUNTIME_ROOT="$RESOURCES/$RUNTIME_ROOT_NAME"
BUNDLED_RUNTIME_VERIFIER="$RESOURCES/CanvastRuntimeVerifier.mjs"

say "Bundle structure and metadata"
[ -d "$CONTENTS/MacOS" ] || fail "missing Contents/MacOS"
[ -d "$RESOURCES" ] || fail "missing Contents/Resources"
[ -f "$INFO_PLIST" ] || fail "missing Contents/Info.plist"
"$PLUTIL_BIN" -lint "$INFO_PLIST" >/dev/null || fail "Info.plist is invalid"

plist_value() {
  "$PLIST_BUDDY" -c "Print :$1" "$INFO_PLIST" 2>/dev/null || true
}

EXECUTABLE_NAME="$(plist_value CFBundleExecutable)"
BUNDLE_TYPE="$(plist_value CFBundlePackageType)"
BUNDLE_ID="$(plist_value CFBundleIdentifier)"
DISPLAY_NAME="$(plist_value CFBundleDisplayName)"
SHORT_VERSION="$(plist_value CFBundleShortVersionString)"
BUILD_VERSION="$(plist_value CFBundleVersion)"
MINIMUM_SYSTEM="$(plist_value LSMinimumSystemVersion)"
ICON_FILE="$(plist_value CFBundleIconFile)"
ICON_NAME="$(plist_value CFBundleIconName)"

[ "$EXECUTABLE_NAME" = "CanvastApp" ] || fail "CFBundleExecutable must be CanvastApp, got: ${EXECUTABLE_NAME:-<empty>}"
[ "$BUNDLE_TYPE" = "APPL" ] || fail "CFBundlePackageType must be APPL, got: ${BUNDLE_TYPE:-<empty>}"
[ -n "$BUNDLE_ID" ] || fail "CFBundleIdentifier is empty"
[ -n "$DISPLAY_NAME" ] || fail "CFBundleDisplayName is empty"
[ -n "$SHORT_VERSION" ] || fail "CFBundleShortVersionString is empty"
[ -n "$BUILD_VERSION" ] || fail "CFBundleVersion is empty"
[ "$MINIMUM_SYSTEM" = "13.0" ] || fail "LSMinimumSystemVersion must match SwiftPM macOS 13 target, got: ${MINIMUM_SYSTEM:-<empty>}"
[ "$ICON_FILE" = "Canvast.icns" ] || fail "CFBundleIconFile must be Canvast.icns, got: ${ICON_FILE:-<empty>}"
[ "$ICON_NAME" = "Canvast" ] || fail "CFBundleIconName must be Canvast, got: ${ICON_NAME:-<empty>}"

EXECUTABLE="$CONTENTS/MacOS/$EXECUTABLE_NAME"
RESOURCE_PROBE="$CONTENTS/Helpers/$RESOURCE_PROBE_NAME"
[ -f "$EXECUTABLE" ] || fail "bundle executable not found: $EXECUTABLE"
[ -x "$EXECUTABLE" ] || fail "bundle executable is not executable: $EXECUTABLE"
[ -f "$RESOURCE_PROBE" ] || fail "resource probe not found: $RESOURCE_PROBE"
[ -x "$RESOURCE_PROBE" ] || fail "resource probe is not executable: $RESOURCE_PROBE"
[ -d "$RESOURCES/$RESOURCE_BUNDLE_NAME" ] || fail "missing SwiftPM resource bundle in Contents/Resources: $RESOURCE_BUNDLE_NAME"
[ -f "$RESOURCES/$RESOURCE_BUNDLE_NAME/CanvastLogo.svg" ] || fail "missing loadable CanvastLogo.svg resource"
[ -f "$RESOURCES/$ICON_FILE" ] || fail "missing Finder/Dock App icon: $ICON_FILE"
[ -s "$RESOURCES/$ICON_FILE" ] || fail "Finder/Dock App icon is empty: $ICON_FILE"
[ ! -L "$RESOURCES/$ICON_FILE" ] || fail "Finder/Dock App icon must be a regular file"
ICON_FORMAT="$("$FILE_BIN" -b "$RESOURCES/$ICON_FILE")" || fail "unable to inspect Finder/Dock App icon format"
case "$ICON_FORMAT" in
  *"Mac OS X icon"*) ;;
  *) fail "Finder/Dock App icon is not a valid ICNS file: $ICON_FORMAT" ;;
esac
[ -f "$RESOURCES/CanvastIconProvenance.json" ] || fail "missing App icon provenance"
"$NODE_BIN" --input-type=module - "$RESOURCES/$ICON_FILE" "$RESOURCES/CanvastIconProvenance.json" <<'NODE' \
  || fail "App icon provenance does not match the bundled ICNS"
import { createHash } from "node:crypto";
import fs from "node:fs";
const [iconPath, provenancePath] = process.argv.slice(2);
const icon = fs.readFileSync(iconPath);
const provenance = JSON.parse(fs.readFileSync(provenancePath, "utf8"));
const hash = createHash("sha256").update(icon).digest("hex");
if (provenance?.schemaVersion !== 1
  || provenance?.kind !== "canvast-macos-app-icon"
  || provenance?.icon?.path !== "Contents/Resources/Canvast.icns"
  || provenance?.icon?.size !== icon.length
  || provenance?.icon?.sha256 !== hash
  || provenance?.source?.path !== "assets/brand/canvast-logo.svg"
  || provenance?.source?.sha256 !== "76f690a3204b65bd47a926fe74b4734487c3e565dd155b57eae3ca32f58c12f8"
  || provenance?.source?.manifest !== "assets/brand/asset-manifest.json"
  || provenance?.source?.relation !== "deterministic-rasterization") process.exit(1);
NODE
[ -f "$RESOURCES/Legal/LICENSE" ] || fail "missing bundled LICENSE"
[ -f "$RESOURCES/Legal/NOTICE" ] || fail "missing bundled NOTICE"
say "Sealed product runtime structure"
[ -d "$RUNTIME_ROOT" ] && [ ! -L "$RUNTIME_ROOT" ] \
  || fail "sealed runtime must be a real directory: Contents/Resources/$RUNTIME_ROOT_NAME"
[ -f "$RUNTIME_ROOT/bin/node" ] && [ ! -L "$RUNTIME_ROOT/bin/node" ] && [ -x "$RUNTIME_ROOT/bin/node" ] \
  || fail "sealed runtime bundled Node must be an executable regular file"
[ -f "$RUNTIME_ROOT/bin/canvast" ] && [ ! -L "$RUNTIME_ROOT/bin/canvast" ] && [ -x "$RUNTIME_ROOT/bin/canvast" ] \
  || fail "sealed runtime launcher must be an executable regular file"
[ -f "$BUNDLED_RUNTIME_VERIFIER" ] && [ ! -L "$BUNDLED_RUNTIME_VERIFIER" ] \
  || fail "bundled runtime verifier must be a regular file"
echo "Bundle metadata: $DISPLAY_NAME $SHORT_VERSION ($BUILD_VERSION), $BUNDLE_ID, macOS $MINIMUM_SYSTEM+"

say "Executable and symbolic-link inventory"
while IFS= read -r -d '' bundle_link; do
  fail "application contains an unsupported symbolic link: $bundle_link"
done < <("$FIND_BIN" -s "$APP_PATH" -type l -print0)
while IFS= read -r -d '' bundle_file; do
  case "$bundle_file" in
    "$EXECUTABLE"|"$RESOURCE_PROBE"|"$RESOURCES/CanvastRuntimeVerifier.mjs"|"$RUNTIME_ROOT/"*) continue ;;
  esac
  [ ! -x "$bundle_file" ] || fail "application contains an unexpected executable: $bundle_file"
  if "$CODESIGN_BIN" -d --verbose=1 "$bundle_file" >/dev/null 2>&1; then
    fail "application contains an unexpected signed code object: $bundle_file"
  fi
done < <("$FIND_BIN" -s "$APP_PATH" -type f -print0)

say "Code signature"
"$CODESIGN_BIN" --verify --deep --strict --verbose=2 "$APP_PATH"
SIGNING_TARGETS=("$APP_PATH" "$EXECUTABLE" "$RESOURCE_PROBE" "$RUNTIME_ROOT/bin/node")
SIGNING_LABELS=("application bundle" "SwiftUI application" "resource probe" "sealed runtime Node")
for index in "${!SIGNING_TARGETS[@]}"; do
  signing_target="${SIGNING_TARGETS[$index]}"
  signing_label="${SIGNING_LABELS[$index]}"
  "$CODESIGN_BIN" --verify --strict --verbose=2 "$signing_target"
  sign_info="$("$CODESIGN_BIN" -d --verbose=4 "$signing_target" 2>&1)" \
    || fail "unable to inspect $signing_label signature"
  if [ "$SIGNING_POLICY" = "adhoc" ]; then
    case "$sign_info" in *"Signature=adhoc"*) ;; *) fail "$signing_label is not ad-hoc signed" ;; esac
  else
    case "$sign_info" in *"Signature=adhoc"*) fail "$signing_label uses an ad-hoc signature" ;; esac
    team_id="$(printf '%s\n' "$sign_info" | sed -n 's/^TeamIdentifier=//p' | head -n 1)"
    authority="$(printf '%s\n' "$sign_info" | sed -n 's/^Authority=//p' | head -n 1)"
    [ "$team_id" = "$EXPECTED_TEAM_ID" ] || fail "$signing_label TeamIdentifier mismatch"
    [ "$authority" = "$EXPECTED_SIGNER_CN" ] || fail "$signing_label signer identity mismatch"
    case "$sign_info" in *"flags="*"("*"runtime"*")"*) ;; *) fail "$signing_label is missing hardened runtime" ;; esac
    timestamp="$(printf '%s\n' "$sign_info" | sed -n 's/^Timestamp=//p')"
    [ -n "$timestamp" ] || fail "$signing_label is missing a secure signing timestamp"
    requirement="anchor apple generic and certificate leaf[subject.OU] = \"$EXPECTED_TEAM_ID\" and certificate leaf[subject.CN] = \"$EXPECTED_SIGNER_CN\""
    "$CODESIGN_BIN" --verify --strict --verbose=2 -R "=$requirement" "$signing_target" \
      || fail "$signing_label does not satisfy the required Developer ID signer"
  fi
done
if [ "$SIGNING_POLICY" = "adhoc" ]; then
  echo "Signing policy: ad-hoc (local/internal integrity only)"
else
  echo "Signing policy: trusted $EXPECTED_SIGNER_CN"
fi
if [ "$DISTRIBUTION_POLICY" = "public" ]; then
  say "Public distribution gate"
  "$CODESIGN_BIN" --verify --deep --strict --check-notarization --verbose=2 "$APP_PATH" \
    || fail "application bundle does not satisfy Apple notarization checks"
  stapler_output="$("$XCRUN_BIN" stapler validate -v "$APP_PATH" 2>&1)" \
    || fail "stapler validate failed for public distribution: ${stapler_output:-unknown stapler failure}"
  printf '%s\n' "$stapler_output"
  spctl_output="$("$SPCTL_BIN" --assess --type execute --verbose=4 "$APP_PATH" 2>&1)" \
    || fail "spctl assessment failed for public distribution: ${spctl_output:-unknown Gatekeeper failure}"
  printf '%s\n' "$spctl_output"
else
  echo "Distribution policy: internal/local only; notarization is not required or claimed."
fi

NORMALIZED_EXPECTED_ARCHS="$(printf '%s' "$EXPECTED_ARCHS" | tr ',' ' ')"
verify_architectures() {
  local label="$1"
  local binary="$2"
  local actual_archs
  local normalized_actual=""
  actual_archs="$("$LIPO_BIN" -archs "$binary" 2>/dev/null)" \
    || fail "unable to inspect $label Mach-O architectures"
  [ -n "$actual_archs" ] || fail "$label has no reported architecture"
  for actual_arch in $actual_archs; do
    case "$actual_arch" in
      arm64|arm64e) normalized_actual="$normalized_actual arm64" ;;
      x86_64|x86_64h) normalized_actual="$normalized_actual x86_64" ;;
      *) fail "unsupported $label architecture: $actual_arch" ;;
    esac
  done
  for expected_arch in $NORMALIZED_EXPECTED_ARCHS; do
    case "$expected_arch" in
      arm64|x86_64) ;;
      *) fail "unsupported expected architecture: $expected_arch" ;;
    esac
    case " $normalized_actual " in
      *" $expected_arch "*) ;;
      *) fail "required architecture $expected_arch not found in $label; executable has: $actual_archs" ;;
    esac
  done
  echo "$label architectures: $actual_archs"
}

say "Executable architecture"
verify_architectures "SwiftUI application" "$EXECUTABLE"
verify_architectures "resource probe" "$RESOURCE_PROBE"
verify_architectures "sealed runtime Node" "$RUNTIME_ROOT/bin/node"

say "Sealed product runtime integrity"
"$NODE_BIN" --input-type=module - "$RUNTIME_HELPER" "$BUNDLED_RUNTIME_VERIFIER" <<'NODE' \
  || fail "bundled runtime verifier does not match the trusted repository helper"
import fs from "node:fs";
const [trustedPath, bundledPath] = process.argv.slice(2);
if (!fs.readFileSync(trustedPath).equals(fs.readFileSync(bundledPath))) process.exit(1);
NODE
"$NODE_BIN" "$RUNTIME_HELPER" verify --root "$RUNTIME_ROOT" \
  || fail "sealed runtime exact-set/hash/license verification failed (including Mach-O closure)"

say "Packaged resource contract"
echo "Resource bundle layout verified statically; the bundled resource probe was not executed."

if [ "$RUN_GUI_SMOKE" -eq 0 ]; then
  say "GUI smoke: skipped (opt-in)"
  echo "Use --gui-smoke for a bounded launch check; default verification never opens a window."
else
  say "GUI smoke: bounded process-liveness check"
  GUI_LOG="$(mktemp "${TMPDIR:-/tmp}/canvast-gui-smoke.XXXXXX.log")"
  GUI_PID=""
  cleanup_gui() {
    if [ -n "$GUI_PID" ] && kill -0 "$GUI_PID" 2>/dev/null; then
      kill -TERM "$GUI_PID" 2>/dev/null || true
      sleep 1
      kill -KILL "$GUI_PID" 2>/dev/null || true
    fi
    rm -f "$GUI_LOG"
  }
  trap cleanup_gui EXIT INT TERM
  "$EXECUTABLE" --project-root "$PROJECT_DIR" >"$GUI_LOG" 2>&1 &
  GUI_PID=$!
  elapsed=0
  while [ "$elapsed" -lt "$GUI_SMOKE_SECONDS" ]; do
    if ! kill -0 "$GUI_PID" 2>/dev/null; then
      wait "$GUI_PID" || true
      printf '%s\n' "--- GUI smoke log ---" >&2
      sed -n '1,120p' "$GUI_LOG" >&2
      fail "GUI process exited before the ${GUI_SMOKE_SECONDS}s liveness window"
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  echo "GUI process remained alive for ${GUI_SMOKE_SECONDS}s."
  cleanup_gui
  trap - EXIT INT TERM
fi

say "macOS application verification complete"
echo "Verified: $APP_PATH"
