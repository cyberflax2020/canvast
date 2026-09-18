#!/usr/bin/env node
/**
 * =============================================================================
 * Canvast — Generate macOS App Icon / Canvast source file
 * =============================================================================
 * @file        scripts/generate-macos-app-icon.mjs
 * @brief       Generate a macOS ICNS from the canonical Canvast SVG.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const CANONICAL_SOURCE = path.join(REPO_ROOT, "assets/brand/canvast-logo.svg");
const BRAND_MANIFEST = path.join(REPO_ROOT, "assets/brand/asset-manifest.json");
const RENDERER = path.join(REPO_ROOT, "scripts/render-macos-app-icon.swift");
const SOURCE_RELATIVE_PATH = "assets/brand/canvast-logo.svg";
const ICON_NAME = "Canvast.icns";
const ICONSET_FILES = Object.freeze([
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
]);
const ICNS_REPRESENTATIONS = Object.freeze([
  ["icp4", "icon_16x16.png"],
  ["icp5", "icon_32x32.png"],
  ["icp6", "icon_32x32@2x.png"],
  ["ic07", "icon_128x128.png"],
  ["ic08", "icon_256x256.png"],
  ["ic09", "icon_512x512.png"],
  ["ic10", "icon_512x512@2x.png"],
]);

function fail(message) {
  process.stderr.write(`generate-macos-app-icon: ${message}\n`);
  process.exit(1);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function run(tool, args, label) {
  const result = spawnSync(tool, args, { encoding: "utf8" });
  if (result.status !== 0) {
    fail(`${label} failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  }
}

function icnsChunk(type, bytes) {
  const chunk = Buffer.allocUnsafe(bytes.length + 8);
  chunk.write(type, 0, 4, "ascii");
  chunk.writeUInt32BE(chunk.length, 4);
  bytes.copy(chunk, 8);
  return chunk;
}

function assembleIcns(iconsetPath) {
  const chunks = ICNS_REPRESENTATIONS.map(([type, filename]) => {
    const bytes = fs.readFileSync(path.join(iconsetPath, filename));
    if (bytes.length < 8 || bytes.subarray(1, 4).toString("ascii") !== "PNG") {
      fail(`renderer did not produce a valid PNG representation: ${filename}`);
    }
    return icnsChunk(type, bytes);
  });
  const header = Buffer.allocUnsafe(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}

function usage() {
  process.stdout.write(
    "Usage: scripts/generate-macos-app-icon.mjs --output PATH [--provenance PATH]\n"
    + "\nGenerates Canvast.icns from the hash-bound canonical Canvast SVG.\n",
  );
}

let outputPath = "";
let provenancePath = "";
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--output") outputPath = process.argv[++index] ?? "";
  else if (argument === "--provenance") provenancePath = process.argv[++index] ?? "";
  else if (argument === "--help" || argument === "-h") {
    usage();
    process.exit(0);
  } else fail(`unknown argument: ${argument}`);
}
if (!outputPath) fail("--output is required");
outputPath = path.resolve(outputPath);
provenancePath = provenancePath
  ? path.resolve(provenancePath)
  : path.join(path.dirname(outputPath), `${path.basename(outputPath)}.provenance.json`);
if (path.basename(outputPath) !== ICON_NAME) fail(`output must be named ${ICON_NAME}`);
if (outputPath === provenancePath) fail("output and provenance paths must differ");
if (process.platform !== "darwin") fail("macOS is required");

const swift = process.env.CANVAST_ICON_SWIFT_BIN || "/usr/bin/swift";
for (const [tool, label] of [[swift, "Swift"]]) {
  try {
    fs.accessSync(tool, fs.constants.X_OK);
  } catch {
    fail(`${label} executable not found: ${tool}`);
  }
}
if (!fs.statSync(RENDERER).isFile()) fail(`icon renderer not found: ${RENDERER}`);

const manifest = JSON.parse(fs.readFileSync(BRAND_MANIFEST, "utf8"));
const canonicalEntry = manifest.canonicalAssets?.find(entry => entry.path === SOURCE_RELATIVE_PATH);
if (!canonicalEntry || typeof canonicalEntry.sha256 !== "string" || typeof canonicalEntry.size !== "number") {
  fail(`brand manifest does not declare ${SOURCE_RELATIVE_PATH}`);
}
const sourceBytes = fs.readFileSync(CANONICAL_SOURCE);
const sourceHash = sha256(sourceBytes);
if (sourceBytes.length !== canonicalEntry.size || sourceHash !== canonicalEntry.sha256) {
  fail("canonical SVG does not match its brand manifest size and SHA-256");
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.mkdirSync(path.dirname(provenancePath), { recursive: true });
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "canvast-icon-"));
const iconsetPath = path.join(temporaryRoot, "Canvast.iconset");
try {
  run(swift, [RENDERER, CANONICAL_SOURCE, iconsetPath], "iconset rendering");
  const iconBytes = assembleIcns(iconsetPath);
  if (iconBytes.length < 8 || iconBytes.subarray(0, 4).toString("ascii") !== "icns") {
    fail("generated output is not a non-empty ICNS file");
  }
  fs.writeFileSync(outputPath, iconBytes, { mode: 0o644 });
  const provenance = {
    schemaVersion: 1,
    kind: "canvast-macos-app-icon",
    icon: {
      path: `Contents/Resources/${ICON_NAME}`,
      size: iconBytes.length,
      sha256: sha256(iconBytes),
    },
    source: {
      path: SOURCE_RELATIVE_PATH,
      size: sourceBytes.length,
      sha256: sourceHash,
      manifest: "assets/brand/asset-manifest.json",
      relation: "deterministic-rasterization",
    },
    generator: {
      path: "scripts/generate-macos-app-icon.mjs",
      iconsetFiles: ICONSET_FILES.map(([filename, pixels]) => ({ filename, pixels })),
      renderer: "scripts/render-macos-app-icon.swift",
      format: "Apple Icon Image format",
      representations: ICNS_REPRESENTATIONS.map(([type, filename]) => ({ type, filename })),
      tools: ["AppKit"],
    },
  };
  fs.writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, { mode: 0o644 });
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

process.stdout.write(`Generated ${outputPath} from ${SOURCE_RELATIVE_PATH} (${sourceHash}).\n`);
