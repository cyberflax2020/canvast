/**
 * =============================================================================
 * Canvast — Source Manifest Validation / Canvast source file
 * =============================================================================
 * @file        scripts/source-manifest-validation.mjs
 * @brief       Validates canonical source snapshot documents at consumer edges.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import { createHash } from "node:crypto";
import path from "node:path";

const SOURCE_FILE_MODES = new Set([0o644, 0o755]);
const SOURCE_FILE_KEYS = Object.freeze(["mode", "path", "sha256", "size"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isLowerSha256(value) {
  return typeof value === "string" && value.length === 64
    && [...value].every(character => "0123456789abcdef".includes(character));
}

function canonicalTimestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new Error(`${label} must be a canonical UTC ISO-8601 timestamp`);
  }
  return value;
}

function canonicalSourcePath(value, label) {
  if (typeof value !== "string" || value.length === 0
    || value.includes("\\") || value.includes("\0")
    || value.includes("\n") || value.includes("\r")
    || path.posix.isAbsolute(value) || path.win32.parse(value).root !== ""
    || path.posix.normalize(value) !== value
    || value.split("/").some(segment => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label} must be a canonical portable relative path`);
  }
  return value;
}

export function isSourceFileMode(value) {
  return Number.isInteger(value) && SOURCE_FILE_MODES.has(value);
}

export function sourceManifestTreeSha256(files) {
  const payload = files
    .map(file => `${file.sha256} ${file.size} ${file.mode} ${file.path}\n`)
    .join("");
  return createHash("sha256").update(payload).digest("hex");
}

export function validateSourceManifestDocument(document) {
  if (!isRecord(document) || document.schemaVersion !== 2
    || document.kind !== "canvast-source-snapshot" || document.algorithm !== "sha256") {
    throw new Error("source manifest must use canvast-source-snapshot schemaVersion 2 with sha256");
  }
  const generatedAt = canonicalTimestamp(document.generatedAt, "source manifest generatedAt");
  if (!isLowerSha256(document.sourceTreeSha256)) {
    throw new Error("source manifest sourceTreeSha256 must be a lowercase SHA-256 digest");
  }
  if (!Array.isArray(document.files) || document.files.length === 0) {
    throw new Error("source manifest files must be a non-empty array");
  }
  const files = document.files.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`source manifest files[${index}] must be an object`);
    if (!isSourceFileMode(entry.mode)) {
      throw new Error(`source manifest files[${index}].mode must be 0644 or 0755`);
    }
    const keys = Object.keys(entry).sort();
    if (keys.length !== SOURCE_FILE_KEYS.length
      || !keys.every((key, keyIndex) => key === SOURCE_FILE_KEYS[keyIndex])) {
      throw new Error(`source manifest files[${index}] must contain exactly path, size, mode, and sha256`);
    }
    const entryPath = canonicalSourcePath(entry.path, `source manifest files[${index}].path`);
    if (!Number.isInteger(entry.size) || entry.size < 0) {
      throw new Error(`source manifest files[${index}].size must be a non-negative integer`);
    }
    if (!isLowerSha256(entry.sha256)) {
      throw new Error(`source manifest files[${index}].sha256 must be a lowercase SHA-256 digest`);
    }
    return { path: entryPath, size: entry.size, mode: entry.mode, sha256: entry.sha256 };
  });
  const paths = files.map(file => file.path);
  const sortedPaths = [...paths].sort((left, right) => left.localeCompare(right));
  if (!paths.every((value, index) => value === sortedPaths[index])) {
    throw new Error("source manifest files must be sorted by path");
  }
  if (new Set(paths).size !== paths.length) {
    throw new Error("source manifest files contains duplicate paths");
  }
  if (document.fileCount !== files.length) {
    throw new Error(`source manifest fileCount mismatch: expected ${files.length}, got ${String(document.fileCount)}`);
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (document.totalBytes !== totalBytes) {
    throw new Error(`source manifest totalBytes mismatch: expected ${totalBytes}, got ${String(document.totalBytes)}`);
  }
  const expectedTreeSha256 = sourceManifestTreeSha256(files);
  if (document.sourceTreeSha256 !== expectedTreeSha256) {
    throw new Error("source manifest sourceTreeSha256 does not match files");
  }
  return { generatedAt, sourceTreeSha256: document.sourceTreeSha256, files };
}
