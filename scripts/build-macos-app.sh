#!/usr/bin/env bash
# ============================================================================
# Canvast — Build macOS App / Canvast 源文件
# ============================================================================
# @file        scripts/build-macos-app.sh
# @brief       Build and sign the Canvast macOS application bundle.
# @description 构建并签名 Canvast macOS 应用包。
# @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
# ============================================================================
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_DIR="$PROJECT_DIR/macos-app"
CONFIG_PLIST="$PACKAGE_DIR/Config/Info.plist"
RESOURCE_PROBE="$PACKAGE_DIR/Config/ResourceBundleProbe.swift"
LOGO_SOURCE="$PACKAGE_DIR/Sources/CanvastApp/Resources/Assets.xcassets/CanvastLogo.imageset/canvast-logo.svg"
APP_RESOURCE_SOURCE="$PACKAGE_DIR/Sources/CanvastApp/Resources"
ICON_GENERATOR="$PROJECT_DIR/scripts/generate-macos-app-icon.mjs"
VERIFY_SCRIPT="$PROJECT_DIR/scripts/verify-macos-app.sh"
ARCHIVE_HELPER="$PROJECT_DIR/scripts/macos-app-archive.mjs"
RUNTIME_HELPER="$PROJECT_DIR/scripts/product-runtime.mjs"
RUNTIME_VERIFIER_NAME="CanvastRuntimeVerifier.mjs"
SOURCE_MANIFEST="$PROJECT_DIR/release/source-manifest.json"
NODE_BIN="${CANVAST_NODE_BIN:-$(command -v node || true)}"
SWIFT_BIN="${CANVAST_SWIFT_BIN:-/usr/bin/swift}"
SWIFTC_BIN="${CANVAST_SWIFTC_BIN:-/usr/bin/swiftc}"
CODESIGN_BIN="${CANVAST_CODESIGN_BIN:-/usr/bin/codesign}"
DITTO_BIN="${CANVAST_DITTO_BIN:-/usr/bin/ditto}"
ZIP_BIN="${CANVAST_ZIP_BIN:-/usr/bin/zip}"
XATTR_BIN="${CANVAST_XATTR_BIN:-/usr/bin/xattr}"
FIND_BIN="${CANVAST_FIND_BIN:-/usr/bin/find}"
STRIP_BIN="${CANVAST_STRIP_BIN:-/usr/bin/strip}"
PLUTIL_BIN="${CANVAST_PLUTIL_BIN:-/usr/bin/plutil}"
PLIST_BUDDY="${CANVAST_PLIST_BUDDY:-/usr/libexec/PlistBuddy}"
PRODUCT_NAME="CanvastApp"
RESOURCE_PROBE_NAME="CanvastResourceProbe"
RESOURCE_BUNDLE_NAME="CanvastMacApp_CanvastApp.bundle"
OUTPUT_PATH="$PROJECT_DIR/dist/Canvast.app"
SIGN_IDENTITY="${CANVAST_CODESIGN_IDENTITY:--}"
APP_VERSION="${CANVAST_APP_VERSION:-$(tr -d '[:space:]' < "$PROJECT_DIR/VERSION")}"
BUILD_VERSION="${CANVAST_BUILD_VERSION:-1}"
BUNDLE_ID="${CANVAST_BUNDLE_ID:-com.canvast.desktop}"
RUN_GUI_SMOKE=0
EXPECTED_TEAM_ID="${CANVAST_RELEASE_TEAM_ID:-}"
EXPECTED_SIGNER_CN="${CANVAST_RELEASE_SIGNER_CN:-}"
DISTRIBUTION_POLICY="${CANVAST_DISTRIBUTION_POLICY:-internal}"

usage() {
  cat <<'USAGE'
Usage: scripts/build-macos-app.sh [options]

Builds the SwiftPM CanvastApp product in release mode, assembles Canvast.app,
signs it, and atomically publishes a verified Canvast.app.zip beside the App.

Options:
  --output PATH             Destination .app (default: dist/Canvast.app)
  --sign-identity ID        codesign identity (default: "-" for ad-hoc)
  --distribution-policy P   Build policy: local or internal
  --expected-team-id ID     Exact Team ID required for identity-signed builds
  --expected-signer-cn CN   Exact Developer ID Application certificate common name
  --gui-smoke               Opt in to a bounded GUI launch smoke after build
  -h, --help                Show this help

Environment overrides:
  CANVAST_APP_VERSION       CFBundleShortVersionString (default: VERSION file)
  CANVAST_BUILD_VERSION     Numeric CFBundleVersion (default: 1)
  CANVAST_BUNDLE_ID         CFBundleIdentifier (default: com.canvast.desktop)
  CANVAST_CODESIGN_IDENTITY Same as --sign-identity; CLI option wins
  CANVAST_DISTRIBUTION_POLICY Same as --distribution-policy; CLI option wins
  CANVAST_RELEASE_TEAM_ID   Same as --expected-team-id; CLI option wins
  CANVAST_RELEASE_SIGNER_CN Same as --expected-signer-cn; CLI option wins

Signing policy:
  The default "-" identity is an explicit ad-hoc signature for local/internal
  integrity checks. Identity-signed output from this script is a trusted
  pre-notarization input only. Use scripts/notarize-macos-app.sh to submit,
  staple, verify, and publish a public-distribution ZIP.
USAGE
}

fail() {
  printf 'build-macos-app: %s\n' "$1" >&2
  exit 1
}

say() {
  printf '\n==> %s\n' "$1"
}

copy_without_metadata() {
  COPYFILE_DISABLE=1 "$DITTO_BIN" --norsrc --noextattr --noqtn --noacl "$1" "$2"
}

archive_fingerprint() {
  local archive_path="$1"
  [ -f "$archive_path" ] && [ ! -L "$archive_path" ] \
    || fail "application archive must be a non-empty regular file: $archive_path"
  "$NODE_BIN" --input-type=module - "$archive_path" <<'NODE'
import { createHash } from "node:crypto";
import { createReadStream, lstatSync } from "node:fs";
const archivePath = process.argv[2];
const before = lstatSync(archivePath);
if (!before.isFile() || before.isSymbolicLink() || before.size <= 0) process.exit(1);
const hash = createHash("sha256");
for await (const chunk of createReadStream(archivePath)) hash.update(chunk);
const after = lstatSync(archivePath);
if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino
  || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) process.exit(1);
process.stdout.write(`${String(after.size)}:${hash.digest("hex")}`);
NODE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --output)
      [ "$#" -ge 2 ] || fail "--output requires a path"
      OUTPUT_PATH="$2"
      shift 2
      ;;
    --sign-identity)
      [ "$#" -ge 2 ] || fail "--sign-identity requires an identity"
      SIGN_IDENTITY="$2"
      shift 2
      ;;
    --distribution-policy)
      [ "$#" -ge 2 ] || fail "--distribution-policy requires a value"
      DISTRIBUTION_POLICY="$2"
      shift 2
      ;;
    --expected-team-id)
      [ "$#" -ge 2 ] || fail "--expected-team-id requires a value"
      EXPECTED_TEAM_ID="$2"
      shift 2
      ;;
    --expected-signer-cn)
      [ "$#" -ge 2 ] || fail "--expected-signer-cn requires a value"
      EXPECTED_SIGNER_CN="$2"
      shift 2
      ;;
    --gui-smoke)
      RUN_GUI_SMOKE=1
      shift
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

case "$DISTRIBUTION_POLICY" in
  local|internal)
    DISTRIBUTION_POLICY="internal"
    ;;
  public) fail "public distribution is a separate notarization transaction; use scripts/notarize-macos-app.sh" ;;
  *) fail "distribution policy must be local or internal" ;;
esac

[ "$(uname -s)" = "Darwin" ] || fail "macOS is required"
[ -x "$SWIFT_BIN" ] || fail "Swift executable not found: $SWIFT_BIN"
[ -x "$SWIFTC_BIN" ] || fail "Swift compiler not found: $SWIFTC_BIN"
[ -x "$CODESIGN_BIN" ] || fail "codesign executable not found: $CODESIGN_BIN"
[ -x "$DITTO_BIN" ] || fail "ditto executable not found: $DITTO_BIN"
[ -x "$ZIP_BIN" ] || fail "zip executable not found: $ZIP_BIN"
[ -x "$XATTR_BIN" ] || fail "xattr executable not found: $XATTR_BIN"
[ -x "$FIND_BIN" ] || fail "find executable not found: $FIND_BIN"
[ -x "$STRIP_BIN" ] || fail "strip executable not found: $STRIP_BIN"
[ -x "$PLUTIL_BIN" ] || fail "plutil executable not found: $PLUTIL_BIN"
[ -x "$PLIST_BUDDY" ] || fail "PlistBuddy executable not found: $PLIST_BUDDY"
[ -f "$CONFIG_PLIST" ] || fail "Info.plist template not found: $CONFIG_PLIST"
[ -f "$RESOURCE_PROBE" ] || fail "resource probe not found: $RESOURCE_PROBE"
[ -f "$LOGO_SOURCE" ] || fail "brand resource not found: $LOGO_SOURCE"
[ -d "$APP_RESOURCE_SOURCE" ] || fail "App resource source directory not found: $APP_RESOURCE_SOURCE"
[ -f "$ICON_GENERATOR" ] || fail "App icon generator not found: $ICON_GENERATOR"
[ -x "$VERIFY_SCRIPT" ] || fail "verifier is not executable: $VERIFY_SCRIPT"
[ -f "$ARCHIVE_HELPER" ] || fail "archive verifier is missing: $ARCHIVE_HELPER"
[ -f "$RUNTIME_HELPER" ] || fail "sealed runtime builder is missing: $RUNTIME_HELPER"
[ -f "$SOURCE_MANIFEST" ] || fail "source manifest is missing: $SOURCE_MANIFEST"
[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || fail "Node.js executable not found"
[ -n "$SIGN_IDENTITY" ] || fail "signing identity cannot be empty; use '-' for ad-hoc signing"
if [ "$SIGN_IDENTITY" = "-" ]; then
  [ -z "$EXPECTED_TEAM_ID" ] || fail "--expected-team-id cannot be used with ad-hoc signing"
  [ -z "$EXPECTED_SIGNER_CN" ] || fail "--expected-signer-cn cannot be used with ad-hoc signing"
  SIGNING_POLICY="adhoc"
else
  [ -n "$EXPECTED_TEAM_ID" ] || fail "identity-signed builds require --expected-team-id"
  [ -n "$EXPECTED_SIGNER_CN" ] || fail "identity-signed builds require --expected-signer-cn"
  SIGNING_POLICY="trusted"
fi

if ! [[ "$BUILD_VERSION" =~ ^[0-9]+([.][0-9]+){0,2}$ ]]; then
  fail "CANVAST_BUILD_VERSION must contain one to three numeric components"
fi

case "$OUTPUT_PATH" in
  /*) ;;
  *) OUTPUT_PATH="$PROJECT_DIR/$OUTPUT_PATH" ;;
esac
OUTPUT_PATH="${OUTPUT_PATH%/}"
[ "$(basename "$OUTPUT_PATH")" = "Canvast.app" ] || fail "--output must be named Canvast.app: $OUTPUT_PATH"

OUTPUT_PARENT="$(dirname "$OUTPUT_PATH")"
mkdir -p "$OUTPUT_PARENT"
OUTPUT_PARENT="$(cd "$OUTPUT_PARENT" && pwd -P)"
OUTPUT_PATH="$OUTPUT_PARENT/$(basename "$OUTPUT_PATH")"
OUTPUT_ARCHIVE="$OUTPUT_PATH.zip"
SWIFTPM_BUILD_DIR="${CANVAST_SWIFTPM_BUILD_DIR:-$PACKAGE_DIR/.build}"
SOURCE_RESOURCE_BUNDLE_OVERRIDE="${CANVAST_SOURCE_RESOURCE_BUNDLE:-}"
SWIFT_SOURCE_PREFIX_MAP="$PROJECT_DIR=/canvast/source"
SWIFT_BUILD_PRIVACY_FLAGS=(
  -Xswiftc -file-prefix-map
  -Xswiftc "$SWIFT_SOURCE_PREFIX_MAP"
  -Xswiftc -debug-prefix-map
  -Xswiftc "$SWIFT_SOURCE_PREFIX_MAP"
)
SWIFTC_PRIVACY_FLAGS=(
  -file-prefix-map "$SWIFT_SOURCE_PREFIX_MAP"
  -debug-prefix-map "$SWIFT_SOURCE_PREFIX_MAP"
)
SWIFTPM_FLAGS=(
  --package-path "$PACKAGE_DIR"
  --scratch-path "$SWIFTPM_BUILD_DIR"
  --cache-path "$SWIFTPM_BUILD_DIR/swiftpm-cache"
  --config-path "$SWIFTPM_BUILD_DIR/swiftpm-config"
  --security-path "$SWIFTPM_BUILD_DIR/swiftpm-security"
  --disable-sandbox
)

say "SwiftPM release build: $PRODUCT_NAME"
"$SWIFT_BIN" build "${SWIFTPM_FLAGS[@]}" "${SWIFT_BUILD_PRIVACY_FLAGS[@]}" --configuration release --product "$PRODUCT_NAME"
BIN_PATH="$("$SWIFT_BIN" build "${SWIFTPM_FLAGS[@]}" "${SWIFT_BUILD_PRIVACY_FLAGS[@]}" --configuration release --show-bin-path)"
SOURCE_EXECUTABLE="$BIN_PATH/$PRODUCT_NAME"
if [ -n "$SOURCE_RESOURCE_BUNDLE_OVERRIDE" ]; then
  SOURCE_RESOURCE_BUNDLE="$SOURCE_RESOURCE_BUNDLE_OVERRIDE"
else
  SOURCE_RESOURCE_BUNDLE="$BIN_PATH/$RESOURCE_BUNDLE_NAME"
fi
[ -f "$SOURCE_EXECUTABLE" ] || fail "release executable not found: $SOURCE_EXECUTABLE"
if [ -z "$SOURCE_RESOURCE_BUNDLE_OVERRIDE" ]; then
  rm -rf "$SOURCE_RESOURCE_BUNDLE"
  mkdir -p "$SOURCE_RESOURCE_BUNDLE"
  copy_without_metadata "$APP_RESOURCE_SOURCE/." "$SOURCE_RESOURCE_BUNDLE"
fi
[ -d "$SOURCE_RESOURCE_BUNDLE" ] || fail "App resource bundle not found: $SOURCE_RESOURCE_BUNDLE"

STAGING_ROOT=""
STAGING_APP=""
STAGING_ARCHIVE=""
BACKUP_APP=""
BACKUP_ARCHIVE=""
RUNTIME_STAGING_ROOT=""
RUNTIME_STAGING_OUTPUT=""
PUBLISH_STARTED=0
COMMITTED=0
ARCHIVE_VERIFY_SCRIPT="$VERIFY_SCRIPT"

cleanup() {
  if [ "$COMMITTED" -eq 0 ] && [ "$PUBLISH_STARTED" -eq 1 ]; then
    rm -rf "$OUTPUT_PATH"
    rm -f "$OUTPUT_ARCHIVE"
    if [ -e "$BACKUP_APP" ]; then mv "$BACKUP_APP" "$OUTPUT_PATH"; fi
    if [ -e "$BACKUP_ARCHIVE" ]; then mv "$BACKUP_ARCHIVE" "$OUTPUT_ARCHIVE"; fi
  fi
  [ -z "$RUNTIME_STAGING_ROOT" ] || rm -rf "$RUNTIME_STAGING_ROOT"
  [ -z "$STAGING_ROOT" ] || rm -rf "$STAGING_ROOT"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

STAGING_ROOT="$(mktemp -d "$OUTPUT_PARENT/.canvast-app-build.XXXXXX")"
STAGING_APP="$STAGING_ROOT/$(basename "$OUTPUT_PATH")"
STAGING_ARCHIVE="$STAGING_ROOT/$(basename "$OUTPUT_ARCHIVE")"
BACKUP_APP="$STAGING_ROOT/previous.app"
BACKUP_ARCHIVE="$STAGING_ROOT/previous.app.zip"
RUNTIME_STAGING_ROOT="$(mktemp -d /private/tmp/canvast-app-runtime.XXXXXX)"
RUNTIME_STAGING_OUTPUT="$RUNTIME_STAGING_ROOT/CanvastRuntime"

say "Assembling standard application bundle"
mkdir -p "$STAGING_APP/Contents/MacOS" "$STAGING_APP/Contents/Helpers" "$STAGING_APP/Contents/Resources/Legal"
mkdir -p "$SWIFTPM_BUILD_DIR/resource-probe-module-cache"
copy_without_metadata "$SOURCE_EXECUTABLE" "$STAGING_APP/Contents/MacOS/$PRODUCT_NAME"
chmod 0755 "$STAGING_APP/Contents/MacOS/$PRODUCT_NAME"
"$SWIFTC_BIN" -O \
  -parse-as-library \
  "${SWIFTC_PRIVACY_FLAGS[@]}" \
  -module-cache-path "$SWIFTPM_BUILD_DIR/resource-probe-module-cache" \
  -target "$(uname -m)-apple-macosx13.0" \
  "$RESOURCE_PROBE" \
  -o "$STAGING_APP/Contents/Helpers/$RESOURCE_PROBE_NAME"
chmod 0755 "$STAGING_APP/Contents/Helpers/$RESOURCE_PROBE_NAME"
copy_without_metadata "$SOURCE_RESOURCE_BUNDLE" "$STAGING_APP/Contents/Resources/$RESOURCE_BUNDLE_NAME"
copy_without_metadata "$LOGO_SOURCE" "$STAGING_APP/Contents/Resources/$RESOURCE_BUNDLE_NAME/CanvastLogo.svg"
"$NODE_BIN" "$ICON_GENERATOR" \
  --output "$STAGING_APP/Contents/Resources/Canvast.icns" \
  --provenance "$STAGING_APP/Contents/Resources/CanvastIconProvenance.json"
copy_without_metadata "$CONFIG_PLIST" "$STAGING_APP/Contents/Info.plist"
copy_without_metadata "$PROJECT_DIR/LICENSE" "$STAGING_APP/Contents/Resources/Legal/LICENSE"
copy_without_metadata "$PROJECT_DIR/NOTICE" "$STAGING_APP/Contents/Resources/Legal/NOTICE"
if [ -f "$PROJECT_DIR/THIRD_PARTY_NOTICES.md" ]; then
  copy_without_metadata "$PROJECT_DIR/THIRD_PARTY_NOTICES.md" "$STAGING_APP/Contents/Resources/Legal/THIRD_PARTY_NOTICES.md"
fi
say "Building sealed product runtime"
"$NODE_BIN" "$RUNTIME_HELPER" build \
  --root "$PROJECT_DIR" \
  --output "$RUNTIME_STAGING_OUTPUT" \
  --node "$NODE_BIN"
copy_without_metadata "$RUNTIME_STAGING_OUTPUT" "$STAGING_APP/Contents/Resources/CanvastRuntime"
copy_without_metadata "$RUNTIME_HELPER" "$STAGING_APP/Contents/Resources/$RUNTIME_VERIFIER_NAME"
chmod 0644 "$STAGING_APP/Contents/Resources/$RUNTIME_VERIFIER_NAME"
"$NODE_BIN" "$ARCHIVE_HELPER" write-provenance \
  --output "$STAGING_APP/Contents/Resources/CanvastBuildProvenance.json" \
  --source-manifest "$SOURCE_MANIFEST" \
  --bundle-builder "$PROJECT_DIR/scripts/build-macos-app.sh"

"$PLIST_BUDDY" -c "Set :CFBundleIdentifier $BUNDLE_ID" "$STAGING_APP/Contents/Info.plist"
"$PLIST_BUDDY" -c "Set :CFBundleShortVersionString $APP_VERSION" "$STAGING_APP/Contents/Info.plist"
"$PLIST_BUDDY" -c "Set :CFBundleVersion $BUILD_VERSION" "$STAGING_APP/Contents/Info.plist"
"$PLUTIL_BIN" -lint "$STAGING_APP/Contents/Info.plist" >/dev/null

say "Removing compiler debug symbols from bundle executables"
"$STRIP_BIN" -S -x "$STAGING_APP/Contents/MacOS/$PRODUCT_NAME" \
  || fail "unable to strip debug symbols from App executable"
"$STRIP_BIN" -S -x "$STAGING_APP/Contents/Helpers/$RESOURCE_PROBE_NAME" \
  || fail "unable to strip debug symbols from resource probe"

say "Removing inherited extended attributes before signing"
while IFS= read -r -d '' staged_link; do
  fail "staged application contains an unsupported symbolic link: $staged_link"
done < <("$FIND_BIN" -s "$STAGING_APP" -type l -print0)
STAGED_PATH_COUNT="$("$FIND_BIN" "$STAGING_APP" -print | wc -l | tr -d '[:space:]')"
echo "Extended attribute cleanup: $STAGED_PATH_COUNT staged paths (single recursive pass)"
"$XATTR_BIN" -crs "$STAGING_APP" || fail "unable to clear extended attributes from staged application"
remaining_xattrs="$("$XATTR_BIN" -rs "$STAGING_APP")" \
  || fail "unable to recursively inspect staged application extended attributes"
while IFS= read -r attribute_line; do
  [ -z "$attribute_line" ] && continue
  case "$attribute_line" in
    *": com.apple.provenance") ;;
    *) fail "staged application still contains forbidden extended attribute: $attribute_line" ;;
  esac
done <<EOF
$remaining_xattrs
EOF
echo "Extended attribute audit complete: no forbidden attributes remain"

say "Code signing application bundle"
if [ "$SIGN_IDENTITY" = "-" ]; then
  while IFS= read -r -d '' runtime_library; do
    "$CODESIGN_BIN" --force --sign - --timestamp=none "$runtime_library"
  done < <("$FIND_BIN" -s "$STAGING_APP/Contents/Resources/CanvastRuntime/lib" -type f -print0)
  "$CODESIGN_BIN" --force --sign - --timestamp=none "$STAGING_APP/Contents/Resources/CanvastRuntime/bin/node"
  "$NODE_BIN" "$RUNTIME_HELPER" seal --root "$STAGING_APP/Contents/Resources/CanvastRuntime"
  "$CODESIGN_BIN" --force --sign - --timestamp=none "$STAGING_APP/Contents/Helpers/$RESOURCE_PROBE_NAME"
  "$CODESIGN_BIN" --force --sign - --timestamp=none "$STAGING_APP/Contents/MacOS/$PRODUCT_NAME"
  "$CODESIGN_BIN" --force --deep --sign - --timestamp=none "$STAGING_APP"
  echo "Signing mode: ad-hoc (local/internal integrity only)"
else
  while IFS= read -r -d '' runtime_library; do
    "$CODESIGN_BIN" --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$runtime_library"
  done < <("$FIND_BIN" -s "$STAGING_APP/Contents/Resources/CanvastRuntime/lib" -type f -print0)
  "$CODESIGN_BIN" --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$STAGING_APP/Contents/Resources/CanvastRuntime/bin/node"
  "$NODE_BIN" "$RUNTIME_HELPER" seal --root "$STAGING_APP/Contents/Resources/CanvastRuntime"
  "$CODESIGN_BIN" --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$STAGING_APP/Contents/Helpers/$RESOURCE_PROBE_NAME"
  "$CODESIGN_BIN" --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$STAGING_APP/Contents/MacOS/$PRODUCT_NAME"
  "$CODESIGN_BIN" --force --deep --options runtime --timestamp --sign "$SIGN_IDENTITY" "$STAGING_APP"
  echo "Signing mode: explicit identity '$SIGN_IDENTITY' with hardened runtime"
fi
echo "Notarization status: NOT notarized; this build workflow does not submit or staple."

EXPECTED_ARCH="$(uname -m)"
case "$EXPECTED_ARCH" in
  arm64|x86_64) ;;
  *) fail "unsupported build host architecture: $EXPECTED_ARCH" ;;
esac

say "Verifying staged application bundle"
VERIFY_SIGNING_ARGS=(--signing-policy "$SIGNING_POLICY" --distribution-policy "$DISTRIBUTION_POLICY")
ARCHIVE_SIGNING_ARGS=(--signing-policy "$SIGNING_POLICY")
if [ "$SIGNING_POLICY" = "trusted" ]; then
  VERIFY_SIGNING_ARGS+=(--expected-team-id "$EXPECTED_TEAM_ID" --expected-signer-cn "$EXPECTED_SIGNER_CN")
  ARCHIVE_SIGNING_ARGS+=(--expected-team-id "$EXPECTED_TEAM_ID" --expected-signer-cn "$EXPECTED_SIGNER_CN")
fi
"$VERIFY_SCRIPT" --expected-arch "$EXPECTED_ARCH" "${VERIFY_SIGNING_ARGS[@]}" "$STAGING_APP"

say "Creating and verifying staged application archive"
(cd "$STAGING_ROOT" && COPYFILE_DISABLE=1 "$ZIP_BIN" -X -q -r -y "$(basename "$STAGING_ARCHIVE")" "$(basename "$STAGING_APP")")
[ -s "$STAGING_ARCHIVE" ] || fail "application archive was not created: $STAGING_ARCHIVE"
"$NODE_BIN" "$ARCHIVE_HELPER" verify \
  --archive "$STAGING_ARCHIVE" \
  --source-manifest "$SOURCE_MANIFEST" \
  --bundle-builder "$PROJECT_DIR/scripts/build-macos-app.sh" \
  --verifier "$ARCHIVE_VERIFY_SCRIPT" \
  "${ARCHIVE_SIGNING_ARGS[@]}"
STAGED_ARCHIVE_FINGERPRINT="$(archive_fingerprint "$STAGING_ARCHIVE")" \
  || fail "unable to fingerprint verified staged archive"

if { [ -e "$OUTPUT_PATH" ] || [ -L "$OUTPUT_PATH" ]; } && { [ -L "$OUTPUT_PATH" ] || [ ! -d "$OUTPUT_PATH" ]; }; then
  fail "existing App output must be a real directory: $OUTPUT_PATH"
fi
if [ -e "$OUTPUT_ARCHIVE" ] || [ -L "$OUTPUT_ARCHIVE" ]; then
  [ -f "$OUTPUT_ARCHIVE" ] && [ ! -L "$OUTPUT_ARCHIVE" ] \
    || fail "existing archive output must be a regular file: $OUTPUT_ARCHIVE"
fi

say "Publishing application bundle and archive"
PUBLISH_STARTED=1
if [ -e "$OUTPUT_PATH" ]; then
  mv "$OUTPUT_PATH" "$BACKUP_APP"
fi
if [ -e "$OUTPUT_ARCHIVE" ]; then
  mv "$OUTPUT_ARCHIVE" "$BACKUP_ARCHIVE"
fi
mv "$STAGING_APP" "$OUTPUT_PATH"
mv "$STAGING_ARCHIVE" "$OUTPUT_ARCHIVE"

VERIFY_ARGS=(--expected-arch "$EXPECTED_ARCH")
VERIFY_ARGS+=("${VERIFY_SIGNING_ARGS[@]}")
if [ "$RUN_GUI_SMOKE" -eq 1 ]; then
  VERIFY_ARGS+=(--gui-smoke)
fi
if ! "$VERIFY_SCRIPT" "${VERIFY_ARGS[@]}" "$OUTPUT_PATH"; then
  fail "published bundle verification failed; previous App and ZIP will be restored when available"
fi
[ -f "$OUTPUT_ARCHIVE" ] && [ ! -L "$OUTPUT_ARCHIVE" ] \
  || fail "published archive is not a regular file; previous App and ZIP will be restored when available"
PUBLISHED_ARCHIVE_FINGERPRINT="$(archive_fingerprint "$OUTPUT_ARCHIVE")" \
  || fail "published archive fingerprint failed; previous App and ZIP will be restored when available"
[ "$PUBLISHED_ARCHIVE_FINGERPRINT" = "$STAGED_ARCHIVE_FINGERPRINT" ] \
  || fail "published archive differs from verified staged archive; previous App and ZIP will be restored when available"
COMMITTED=1

say "macOS application ready"
echo "Bundle: $OUTPUT_PATH"
echo "Archive: $OUTPUT_ARCHIVE"
if [ "$SIGN_IDENTITY" = "-" ]; then
  echo "Delivery: internal ad-hoc signed build; NOT notarized"
else
  echo "Delivery: trusted pre-notarization build; run scripts/notarize-macos-app.sh for public distribution"
fi
