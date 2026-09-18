#!/usr/bin/env node
/**
 * =============================================================================
 * Canvast — Brand Asset Verifier / Canvast source file
 * =============================================================================
 * @file        scripts/verify-brand-assets.mjs
 * @brief       Verifies the exact licensed Canvast brand asset set.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  npmFileEntries,
  publicDirectoryEntries,
  publicFileEntries,
} from "./public-repo-policy.mjs";
import { sourceSnapshotEntries } from "./release-source-policy.mjs";

const defaultProjectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectDir = path.resolve(process.env.CANVAST_BRAND_VERIFY_ROOT || defaultProjectDir);
const brandDir = path.join(projectDir, "assets", "brand");
const manifestPath = path.join(brandDir, "asset-manifest.json");
const packagePath = path.join(projectDir, "package.json");
const expectedBrandFiles = Object.freeze([
  "asset-manifest.json",
  "canvast-hero.svg",
  "canvast-logo.svg",
  "canvast-logo.tui.txt",
  "README.md",
]);
const publishedBrandFiles = Object.freeze([
  "assets/brand/README.md",
  "assets/brand/asset-manifest.json",
  "assets/brand/canvast-hero.svg",
  "assets/brand/canvast-logo.svg",
  "assets/brand/canvast-logo.tui.txt",
]);

function fail(message) {
  throw new Error(`brand asset verification failed: ${message}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readRegularFile(file, label) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) fail(`${label} must be a regular non-symlink file`);
  const bytes = fs.readFileSync(file);
  return { bytes, size: bytes.length, sha256: sha256(bytes) };
}

function readJson(file, label) {
  const record = readRegularFile(file, label);
  try {
    return { document: JSON.parse(record.bytes.toString("utf8")), record };
  } catch (error) {
    fail(`${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertExactBrandDirectory() {
  const stat = fs.lstatSync(brandDir, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) fail("assets/brand must be a non-symlink directory");
  const actual = fs.readdirSync(brandDir).sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(actual) !== JSON.stringify(expectedBrandFiles)) {
    fail(`assets/brand exact file set mismatch: ${actual.join(", ")}`);
  }
  for (const name of expectedBrandFiles) readRegularFile(path.join(brandDir, name), `assets/brand/${name}`);
}

function assertAssetRecord(asset, expectedPath) {
  if (!asset || asset.path !== expectedPath) fail(`missing canonical asset record for ${expectedPath}`);
  const actual = readRegularFile(path.join(projectDir, expectedPath), expectedPath);
  if (asset.size !== actual.size || asset.sha256 !== actual.sha256) {
    fail(`hash or size mismatch for ${expectedPath}`);
  }
  if (!Array.isArray(asset.purpose) || asset.purpose.length === 0) fail(`purpose is missing for ${expectedPath}`);
}

function assertManifest() {
  const { document } = readJson(manifestPath, "brand asset manifest");
  if (document.schemaVersion !== 1 || document.kind !== "canvast-brand-assets") fail("brand asset manifest schema is invalid");
  const publisher = document.publisher;
  if (publisher?.project !== "Canvast"
    || publisher?.name !== "Canvast Contributors"
    || publisher?.license !== "Apache-2.0"
    || publisher?.licenseFile !== "LICENSE"
    || typeof publisher?.provenance !== "string"
    || !publisher.provenance.includes("Canvast-specific")) {
    fail("brand asset license or project provenance is invalid");
  }
  if (document.directoryPolicy?.canonicalDirectory !== "assets/brand"
    || document.directoryPolicy?.developmentMaterialsAllowed !== false
    || JSON.stringify(document.directoryPolicy?.exactFiles) !== JSON.stringify(expectedBrandFiles)) {
    fail("brand asset exact-directory policy is invalid");
  }
  if (!Array.isArray(document.canonicalAssets) || document.canonicalAssets.length !== 3) {
    fail("brand asset manifest must declare exactly three canonical assets");
  }
  const canonical = new Map(document.canonicalAssets.map(asset => [asset?.path, asset]));
  for (const relative of publishedBrandFiles.slice(2)) assertAssetRecord(canonical.get(relative), relative);

  if (!Array.isArray(document.derivedCopies) || document.derivedCopies.length !== 1) {
    fail("brand asset manifest must declare exactly one derived copy");
  }
  const derived = document.derivedCopies[0];
  const derivedPath = "macos-app/Sources/CanvastApp/Resources/Assets.xcassets/CanvastLogo.imageset/canvast-logo.svg";
  if (derived?.path !== derivedPath
    || derived?.source !== "assets/brand/canvast-logo.svg"
    || derived?.relation !== "exact-byte-copy") {
    fail("macOS logo derived-copy relation is invalid");
  }
  const canonicalBytes = readRegularFile(path.join(projectDir, derived.source), derived.source);
  const derivedBytes = readRegularFile(path.join(projectDir, derived.path), derived.path);
  if (derived.size !== derivedBytes.size || derived.sha256 !== derivedBytes.sha256
    || canonicalBytes.size !== derivedBytes.size || canonicalBytes.sha256 !== derivedBytes.sha256) {
    fail("macOS logo is not an exact canonical asset copy");
  }
}

function assertExactPolicy(label, entries, expectedEntries) {
  const broad = entries.filter(entry => entry === "assets/brand" || entry === "assets/brand/");
  if (broad.length > 0) fail(`${label} contains a broad assets/brand directory`);
  for (const expected of expectedEntries) {
    if (!entries.includes(expected)) fail(`${label} is missing ${expected}`);
  }
}

function assertPublicationPolicies() {
  assertExactPolicy("publicDirectoryEntries", publicDirectoryEntries, []);
  assertExactPolicy("publicFileEntries", publicFileEntries, publishedBrandFiles);
  assertExactPolicy("npmFileEntries", npmFileEntries, publishedBrandFiles);
  assertExactPolicy("sourceSnapshotEntries", sourceSnapshotEntries, publishedBrandFiles);
  const packageJson = readJson(packagePath, "package.json").document;
  if (!Array.isArray(packageJson.files)) fail("package.json files must be an array");
  assertExactPolicy("package.json files", packageJson.files, publishedBrandFiles);
}

try {
  assertExactBrandDirectory();
  assertManifest();
  assertPublicationPolicies();
  console.log("Brand assets verified: exact files, Apache-2.0 provenance, hashes, copies, and publication policies.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
