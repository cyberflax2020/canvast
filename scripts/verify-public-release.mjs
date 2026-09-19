#!/usr/bin/env node
/**
 * =============================================================================
 * Canvast — Verify Public Release / Canvast source file
 * =============================================================================
 * @file        scripts/verify-public-release.mjs
 * @brief       Validates public-tree provenance and canonical payload bytes.
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

import {
  authoredPublicMarkdownEntries,
  expandAllowedFiles,
  forbiddenBasenames,
  forbiddenGeneratedSegments,
  forbiddenRelativePaths,
  forbiddenRelativePrefixes,
  npmFileEntries,
  publicDirectoryEntries,
  publicEvidenceEntries,
  publicFileEntries,
  publicPackageScripts,
  publicRuntimeDependencies,
  projectPublicSource,
  publicSourceTransformations,
} from "./public-repo-policy.mjs";
import {
  assertPublicPackageRuntimeClosure,
  createLicenseInventory,
  licenseInventoryPolicyErrors,
  publicDocumentPolicyErrors,
  publicRuntimePolicyErrors,
  scanPublicReleaseFile,
  thirdPartyNoticePolicyErrors,
} from "./public-release-guards.mjs";
import { verifyPublicReleaseLocalImportClosure } from "./verify-public-release-import-closure.mjs";
import { runPublicRuntimeShutdownProbe } from "./public-runtime-shutdown-probe.mjs";
import { validateMacosUiImpactEvidence } from "./release-impact-evidence.mjs";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = parseArguments(process.argv.slice(2));
const root = path.resolve(cli.target || process.cwd());
const sourceRoot = path.resolve(cli.sourceRoot || scriptRoot);
const authoredPublicMarkdownSet = new Set(authoredPublicMarkdownEntries);
const markerRelative = ".canvast-public-tree";
const manifestRelative = "release/public-tree-manifest.json";
const markerPath = path.join(root, markerRelative);
const manifestPath = path.join(root, manifestRelative);
const errors = [...cli.errors];
const specialManifestFiles = new Set([markerRelative, manifestRelative]);
const portableTitle = "Canvas Surface Proof";
const portableDirectory = "release/artifacts/canvas-portable";
const portableFixturePath = `${portableDirectory}/fixture-input.json`;
const portableOutputs = Object.freeze([
  { path: `${portableDirectory}/canvas-graph-export.json`, mediaType: "application/json" },
  { path: `${portableDirectory}/canvas-report.md`, mediaType: "text/markdown" },
  { path: `${portableDirectory}/canvas-graph.mmd`, mediaType: "text/vnd.mermaid" },
  { path: `${portableDirectory}/canvas-graph.svg`, mediaType: "image/svg+xml" },
  { path: `${portableDirectory}/canvas-graph.html`, mediaType: "text/html" },
]);
const portableEntry = `npm run export:canvas -- --input ${portableFixturePath} --out ${portableDirectory} --title "${portableTitle}"`;
const portableVerificationCommand = `node scripts/export-canvas.mjs --input ${portableFixturePath} --out ${portableDirectory} --title "${portableTitle}"`;
const portableAssertions = Object.freeze([
  "The real CLI produces exactly JSON, Markdown, Mermaid, standalone SVG, and interactive HTML.",
  "All formats preserve the four Canvas node types and four traceability edges after credential and personal-home redaction.",
  "SVG has no runtime dependency; HTML declares its pinned https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js dependency and links the offline SVG fallback.",
]);
const d3CdnUrl = "https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js";

function parseArguments(args) {
  const result = {
    target: undefined,
    sourceRoot: undefined,
    runCommands: false,
    standalone: false,
    releaseAssets: false,
    expectedTeamId: undefined,
    expectedSignerCn: undefined,
    errors: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--run-commands") result.runCommands = true;
    else if (argument === "--standalone") result.standalone = true;
    else if (argument === "--release-assets") result.releaseAssets = true;
    else if (argument === "--expected-team-id" || argument === "--expected-signer-cn") {
      index += 1;
      if (!args[index] || args[index].startsWith("--")) result.errors.push(`${argument} requires a value`);
      else if (argument === "--expected-team-id") result.expectedTeamId = args[index];
      else result.expectedSignerCn = args[index];
    }
    else if (argument === "--source-root") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) result.errors.push("--source-root requires a path");
      else {
        result.sourceRoot = value;
        index += 1;
      }
    } else if (argument.startsWith("--")) result.errors.push(`unknown option: ${argument}`);
    else if (result.target === undefined) result.target = argument;
    else result.errors.push(`unexpected positional argument: ${argument}`);
  }
  if (result.standalone && result.sourceRoot !== undefined) result.errors.push("--standalone cannot be combined with --source-root");
  if (result.standalone && result.releaseAssets) result.errors.push("--release-assets requires trusted-source verification and cannot be combined with --standalone");
  if (result.releaseAssets && !result.expectedTeamId) result.errors.push("--release-assets requires --expected-team-id");
  if (result.releaseAssets && !result.expectedSignerCn) result.errors.push("--release-assets requires --expected-signer-cn");
  if (!result.releaseAssets && (result.expectedTeamId || result.expectedSignerCn)) result.errors.push("macOS signer options require --release-assets");
  return result;
}

function normalize(value) { return value.split(path.sep).join("/"); }
function relative(file) { return normalize(path.relative(root, file)); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function isSha256(value) {
  if (typeof value !== "string" || value.length !== 64) return false;
  for (const character of value) if (!(character >= "0" && character <= "9") && !(character >= "a" && character <= "f")) return false;
  return true;
}
function validRelative(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\0") || value.includes("\n") || value.includes("\r") || path.posix.isAbsolute(value)) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value && value !== ".." && !value.startsWith("../");
}
function forbidden(relativePath, base = path.posix.basename(relativePath)) {
  const segments = relativePath.split("/");
  return forbiddenRelativePaths.has(relativePath)
    || segments.some(segment => forbiddenGeneratedSegments.has(segment))
    || [...forbiddenRelativePrefixes].some(prefix => relativePath === prefix || relativePath.startsWith(`${prefix}/`))
    || forbiddenBasenames.has(base)
    || base.endsWith(".pyc")
    || base.endsWith(".log")
    || base.endsWith(".zip");
}
function walkFiles(directory, destination = [], relativeTo = root) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(directory, entry.name);
    const candidate = normalize(path.relative(relativeTo, absolute));
    if (relativeTo === root && candidate === ".git" && entry.isDirectory()) continue;
    if (entry.isSymbolicLink()) { errors.push(`symlink is forbidden: ${candidate}`); continue; }
    if (relativeTo === root && forbidden(candidate, entry.name)) errors.push(`local or internal path is forbidden: ${candidate}`);
    if (entry.isDirectory()) walkFiles(absolute, destination, relativeTo);
    else if (entry.isFile()) destination.push(absolute);
    else errors.push(`unsupported filesystem entry: ${candidate}`);
  }
  return destination;
}
function fileRecords(base, paths) {
  return paths.slice().sort((left, right) => left.localeCompare(right)).map(filePath => {
    const bytes = fs.readFileSync(path.join(base, filePath));
    return { path: filePath, size: bytes.length, sha256: sha256(bytes) };
  });
}
function treeHash(files) { return sha256(files.map(file => `${file.sha256} ${file.size} ${file.path}\n`).join("")); }
function normalizeMode(mode) { return mode & 0o777; }
function sourceTreeHash(files) { return sha256(files.map(file => `${file.sha256} ${file.size} ${file.mode} ${file.path}\n`).join("")); }
function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { errors.push(`${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`); return undefined; }
}
function arraysEqual(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}
function exactKeys(value, expected) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && arraysEqual(Object.keys(value).sort(), expected.slice().sort());
}
function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalJson(value[key])]));
}
function jsonEqual(left, right) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}
function evidenceSourceManifest(document) {
  if (document?.sourceManifest && typeof document.sourceManifest === "object") {
    return document.sourceManifest;
  }
  if (document?.inputs?.sourceManifest && typeof document.inputs.sourceManifest === "object") {
    return document.inputs.sourceManifest;
  }
  return undefined;
}
let cachedMacosUiImpact;
function macosUiImpactSource(current) {
  if (!cachedMacosUiImpact) {
    try {
      cachedMacosUiImpact = validateMacosUiImpactEvidence(root, {
        currentManifest: {
          path: "release/source-manifest.json",
          rawSha256: current.sha256,
          generatedAt: current.generatedAt,
          sourceTreeSha256: current.sourceTreeSha256,
          document: current.document,
        },
      });
    } catch (error) {
      errors.push(`macOS UI impact evidence is invalid: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }
  return cachedMacosUiImpact.evaluationSource;
}
let cachedMacosUiImpactAssessment;
function macosUiImpactAssessment() {
  if (cachedMacosUiImpactAssessment === undefined) {
    try {
      const impact = readJson(path.join(root, "release/artifacts/macos-ui-impact.json"), "macOS UI impact");
      cachedMacosUiImpactAssessment = impact && typeof impact === "object"
        && impact.impactAssessment && typeof impact.impactAssessment === "object"
        ? impact.impactAssessment
        : {};
    } catch {
      cachedMacosUiImpactAssessment = {};
    }
  }
  return cachedMacosUiImpactAssessment;
}
function canonicalPortableGraph() {
  return {
    nodes: [
      { id: "plan-release", type: "plan", properties: { goal: "Verify Canvas portable artifact", status: "in_progress" } },
      { id: "decision-offline", type: "decision", properties: { chosen: "Keep SVG standalone and disclose the HTML CDN" } },
      { id: "file-export", type: "file", properties: { path: "scripts/export-canvas.mjs", stale: false } },
      { id: "agent-proof", type: "agent_run", properties: { task: "Run the Canvas portable proof", status: "completed" } },
    ],
    edges: [
      { id: "edge-1", type: "MOTIVATED_BY", fromNodeId: "plan-release", toNodeId: "decision-offline" },
      { id: "edge-2", type: "PRODUCED_BY", fromNodeId: "file-export", toNodeId: "agent-proof" },
      { id: "edge-3", type: "DECOMPOSES_INTO", fromNodeId: "plan-release", toNodeId: "file-export" },
      { id: "edge-4", type: "EXECUTED_BY", fromNodeId: "plan-release", toNodeId: "agent-proof" },
    ],
  };
}
function policyKey(entry) {
  return typeof entry === "string" && entry.endsWith("/") ? entry.slice(0, -1) : entry;
}
function validatePolicyEntries() {
  const groups = [
    ["publicDirectoryEntries", publicDirectoryEntries],
    ["publicFileEntries", publicFileEntries],
    ["publicEvidenceEntries", publicEvidenceEntries],
    ["npmFileEntries", npmFileEntries],
  ];
  for (const [label, entries] of groups) {
    const keys = entries.map(policyKey);
    if (new Set(keys).size !== keys.length) errors.push(`${label} contains duplicate policy roots`);
    for (const [index, key] of keys.entries()) if (!validRelative(key)) errors.push(`${label}[${index}] is not a canonical relative path: ${String(entries[index])}`);
  }
  const publicRoots = [...publicDirectoryEntries, ...publicFileEntries, ...publicEvidenceEntries].map(policyKey);
  if (new Set(publicRoots).size !== publicRoots.length) errors.push("public policy roots overlap by exact path");
  const publicDirectoryRoots = new Set(publicDirectoryEntries.map(policyKey));
  for (let left = 0; left < publicRoots.length; left += 1) {
    for (let right = left + 1; right < publicRoots.length; right += 1) {
      const leftRoot = publicRoots[left];
      const rightRoot = publicRoots[right];
      if ((publicDirectoryRoots.has(leftRoot) && rightRoot.startsWith(`${leftRoot}/`))
        || (publicDirectoryRoots.has(rightRoot) && leftRoot.startsWith(`${rightRoot}/`))) {
        errors.push(`public policy roots overlap recursively: ${leftRoot} and ${rightRoot}`);
      }
    }
  }
  for (const entry of npmFileEntries.map(policyKey)) {
    const allowed = publicRoots.some(rootEntry => entry === rootEntry || (publicDirectoryRoots.has(rootEntry) && entry.startsWith(`${rootEntry}/`)));
    if (!allowed) errors.push(`npm payload root is outside the public policy: ${entry}`);
  }
  errors.push(...publicRuntimePolicyErrors({
    root,
    publicDirectoryEntries,
    publicFileEntries,
    publicEvidenceEntries,
    npmFileEntries,
    publicPackageScripts,
    publicRuntimeDependencies,
    isForbiddenPublicPath: relativePath => forbidden(relativePath),
  }));
}
function cleanEnvironment(overrides = {}) {
  const env = { ...process.env, ...overrides };
  delete env.CANVAST_SOURCE_MANIFEST;
  delete env.CANVAST_LICENSE_INVENTORY;
  return env;
}
function command(label, executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd || root,
    encoding: "utf8",
    stdio: "pipe",
    env: cleanEnvironment(options.env),
  });
  if (result.status !== 0) errors.push(`${label} failed (${String(result.status)}):\n${result.stdout || ""}${result.stderr || ""}`);
  else console.log(`PASS ${label}`);
  return result;
}
function swiftBuildArguments() {
  const buildRoot = path.join(root, "macos-app", ".build");
  return [
    "build",
    "--package-path", path.join(root, "macos-app"),
    "--scratch-path", buildRoot,
    "--cache-path", path.join(buildRoot, "swiftpm-cache"),
    "--config-path", path.join(buildRoot, "swiftpm-config"),
    "--security-path", path.join(buildRoot, "swiftpm-security"),
    "--disable-sandbox",
  ];
}
function removeGeneratedCommandOutput() {
  for (const candidate of ["node_modules", "macos-app/.build", "coverage", "dist", ".runtime", ".pi"]) {
    fs.rmSync(path.join(root, candidate), { recursive: true, force: true });
  }
}

function markdownTargets(text) {
  const targets = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) { fenced = !fenced; continue; }
    if (fenced) continue;
    let cursor = 0;
    while (cursor < line.length) {
      const open = line.indexOf("](", cursor);
      if (open < 0) break;
      const close = line.indexOf(")", open + 2);
      if (close < 0) break;
      let target = line.slice(open + 2, close).trim();
      if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
      const titleSeparator = target.indexOf(" \"");
      if (titleSeparator >= 0) target = target.slice(0, titleSeparator);
      targets.push(target);
      cursor = close + 1;
    }
    const colon = line.indexOf("]:");
    if (line.startsWith("[") && colon > 1) {
      const target = line.slice(colon + 2).trim().split(" " )[0];
      if (target) targets.push(target);
    }
  }
  return targets;
}
function checkMarkdownLinks(file, text) {
  for (const rawTarget of markdownTargets(text)) {
    if (!rawTarget || rawTarget.startsWith("#") || rawTarget.startsWith("https://") || rawTarget.startsWith("http://") || rawTarget.startsWith("mailto:") || rawTarget.startsWith("data:")) continue;
    const withoutFragment = rawTarget.split("#")[0].split("?")[0];
    if (!withoutFragment) continue;
    let decoded = withoutFragment;
    try { decoded = decodeURIComponent(withoutFragment); } catch { errors.push(`invalid encoded Markdown link in ${relative(file)}: ${rawTarget}`); continue; }
    const resolved = path.resolve(path.dirname(file), decoded);
    const resolvedRelative = relative(resolved);
    if (!validRelative(resolvedRelative) || !fs.existsSync(resolved)) errors.push(`broken or escaping Markdown link in ${relative(file)}: ${rawTarget}`);
  }
}
function checkSensitiveFile(file) {
  const candidate = relative(file);
  const result = scanPublicReleaseFile(fs.readFileSync(file));
  for (const finding of result.findings) errors.push(`possible secret in ${candidate}: ${finding}`);
  return result;
}
function validateManifestFiles(document, label) {
  if (!Array.isArray(document?.files)) { errors.push(`${label} files must be an array`); return []; }
  const paths = document.files.map(file => file?.path);
  if (new Set(paths).size !== paths.length) errors.push(`${label} contains duplicate paths`);
  if (!arraysEqual(paths, paths.slice().sort((left, right) => String(left).localeCompare(String(right))))) errors.push(`${label} paths must be sorted`);
  for (const [index, file] of document.files.entries()) {
    if (!file || !validRelative(file.path)) errors.push(`${label} contains invalid path: ${String(file?.path)}`);
    if (!Number.isInteger(file?.size) || file.size < 0) errors.push(`${label} files[${index}].size must be a non-negative integer`);
    if (!isSha256(file?.sha256)) errors.push(`${label} files[${index}].sha256 must be a lowercase SHA-256 digest`);
  }
  return document.files;
}
function validateSourceManifestFiles(document, label) {
  if (!Array.isArray(document?.files)) { errors.push(`${label} files must be an array`); return []; }
  const paths = document.files.map(file => file?.path);
  if (new Set(paths).size !== paths.length) errors.push(`${label} contains duplicate paths`);
  if (!arraysEqual(paths, paths.slice().sort((left, right) => String(left).localeCompare(String(right))))) errors.push(`${label} paths must be sorted`);
  for (const [index, file] of document.files.entries()) {
    if (!exactKeys(file, ["mode", "path", "sha256", "size"])) {
      errors.push(`${label} files[${index}] must contain exactly path, size, mode, and sha256`);
      continue;
    }
    if (!file || !validRelative(file.path)) errors.push(`${label} contains invalid path: ${String(file?.path)}`);
    if (!Number.isInteger(file?.size) || file.size < 0) errors.push(`${label} files[${index}].size must be a non-negative integer`);
    if (file?.mode !== 420 && file?.mode !== 493) errors.push(`${label} files[${index}].mode must be 420 or 493`);
    if (!isSha256(file?.sha256)) errors.push(`${label} files[${index}].sha256 must be a lowercase SHA-256 digest`);
  }
  return document.files;
}
function compareProjection(actualFiles, declaredFiles, label) {
  const actualByPath = new Map(actualFiles.map(file => [file.path, file]));
  const declaredByPath = new Map(declaredFiles.map(file => [file?.path, file]));
  for (const file of actualFiles) {
    const declared = declaredByPath.get(file.path);
    if (!declared) errors.push(`${label} is missing policy file: ${file.path}`);
    else if (declared.size !== file.size || declared.sha256 !== file.sha256) errors.push(`${label} file hash mismatch: ${file.path}`);
  }
  for (const file of declaredFiles) if (!actualByPath.has(file?.path)) errors.push(`${label} contains non-policy file: ${String(file?.path)}`);
}
function checkAggregate(document, actualFiles, label) {
  if (document?.fileCount !== actualFiles.length) errors.push(`${label} fileCount mismatch: expected ${actualFiles.length}, got ${String(document?.fileCount)}`);
  if (document?.totalBytes !== actualFiles.reduce((sum, file) => sum + file.size, 0)) errors.push(`${label} totalBytes mismatch`);
  if (document?.treeSha256 !== treeHash(actualFiles)) errors.push(`${label} aggregate hash mismatch`);
}
function canonicalPackageBytes() {
  const sourcePackagePath = path.join(sourceRoot, "package.json");
  if (!fs.existsSync(sourcePackagePath)) { errors.push("trusted source package.json is missing"); return undefined; }
  try {
    const value = JSON.parse(fs.readFileSync(sourcePackagePath, "utf8"));
    value.private = false;
    value.scripts = { ...publicPackageScripts };
    value.files = [...npmFileEntries];
    return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  } catch (error) {
    errors.push(`trusted source package.json is invalid: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}
function canonicalPublicBytes(filePath) {
  const sourceFile = path.join(sourceRoot, filePath);
  return projectPublicSource(filePath, fs.readFileSync(sourceFile));
}
function canonicalPublicMode(filePath) {
  const sourceFile = path.join(sourceRoot, filePath);
  if (!fs.existsSync(sourceFile)) {
    errors.push(`trusted source file is missing or not regular: ${filePath}`);
    return undefined;
  }
  const stat = fs.lstatSync(sourceFile);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    errors.push(`trusted source file is missing or not regular: ${filePath}`);
    return undefined;
  }
  const mode = normalizeMode(stat.mode);
  if (mode !== 0o644 && mode !== 0o755) {
    errors.push(`trusted source file mode must be 0644 or 0755: ${filePath}`);
    return undefined;
  }
  return mode;
}
function verifyPortableSurfaceAssertions(outputBytes) {
  const svg = outputBytes.get(`${portableDirectory}/canvas-graph.svg`)?.toString("utf8");
  if (typeof svg !== "string"
    || !svg.startsWith("<svg ")
    || svg.toLowerCase().includes("<script")
    || svg.toLowerCase().includes("href=")) {
    errors.push("release/artifacts/canvas-portable.json SVG is not standalone");
  }
  const html = outputBytes.get(`${portableDirectory}/canvas-graph.html`)?.toString("utf8");
  if (typeof html !== "string"
    || !html.includes(d3CdnUrl)
    || !html.includes("network required")
    || !html.includes("canvas-graph.svg")) {
    errors.push("release/artifacts/canvas-portable.json HTML dependency disclosure is stale");
  }
}
function verifyCanonicalPortableBytes(outputBytes) {
  const exporterRelative = "scripts/export-canvas.mjs";
  const exporter = path.join(root, exporterRelative);
  if (!fs.existsSync(exporter) || !fs.lstatSync(exporter).isFile() || fs.lstatSync(exporter).isSymbolicLink()) {
    errors.push(`embedded Canvas exporter is missing or not regular: ${exporterRelative}`);
    return;
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "canvast-portable-standalone-"));
  try {
    const input = path.join(temporary, "fixture-input.json");
    const output = path.join(temporary, "rendered");
    fs.writeFileSync(input, `${JSON.stringify(canonicalPortableGraph(), null, 2)}\n`);
    const rendered = spawnSync(process.execPath, [
      exporter,
      "--input", input,
      "--out", output,
      "--title", portableTitle,
      "--no-scan",
    ], {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
      env: cleanEnvironment(),
    });
    if (rendered.status !== 0) {
      errors.push(`canonical Canvas portable rerender failed (${String(rendered.status)}):\n${rendered.stdout || ""}${rendered.stderr || ""}`);
      return;
    }
    for (const expected of portableOutputs) {
      const published = outputBytes.get(expected.path);
      const canonicalPath = path.join(output, path.posix.basename(expected.path));
      if (!published || !fs.existsSync(canonicalPath) || !published.equals(fs.readFileSync(canonicalPath))) {
        errors.push(`release/artifacts/canvas-portable.json canonical byte mismatch: ${expected.path}`);
      }
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
function verifyPortableEvidenceBindings(sourceManifestHash, sourceTreeHash, sourceGeneratedAt) {
  const artifactPath = path.join(root, "release/artifacts/canvas-portable.json");
  const document = readJson(artifactPath, "release/artifacts/canvas-portable.json");
  if (!document) return;
  if (document.schemaVersion !== 1 || document.kind !== "canvast-canvas-portable-release") {
    errors.push("release/artifacts/canvas-portable.json has an invalid schema or kind");
    return;
  }
  if (!exactKeys(document, [
    "schemaVersion", "kind", "generatedAt", "sourceManifest", "entry",
    "verificationCommand", "fixture", "outputs", "assertions",
  ])) {
    errors.push("release/artifacts/canvas-portable.json portable manifest schema is not canonical");
  }
  if (typeof document.generatedAt !== "string" || !Number.isFinite(Date.parse(document.generatedAt))) {
    errors.push("release/artifacts/canvas-portable.json generatedAt is invalid");
  } else if (typeof sourceGeneratedAt === "string" && Date.parse(document.generatedAt) < Date.parse(sourceGeneratedAt)) {
    errors.push("release/artifacts/canvas-portable.json predates the source manifest");
  }
  if (
    !exactKeys(document.sourceManifest, ["path", "status", "sourceTreeSha256", "manifestSha256"]) ||
    document.sourceManifest?.path !== "release/source-manifest.json" ||
    document.sourceManifest?.manifestSha256 !== sourceManifestHash ||
    document.sourceManifest?.sourceTreeSha256 !== sourceTreeHash ||
    document.sourceManifest?.status !== "verified"
  ) {
    errors.push("release/artifacts/canvas-portable.json does not bind the public source tree");
  }
  if (document.entry !== portableEntry) {
    errors.push("release/artifacts/canvas-portable.json entry is not canonical");
  }
  if (document.verificationCommand !== portableVerificationCommand) {
    errors.push("release/artifacts/canvas-portable.json verificationCommand is not canonical");
  }
  if (!arraysEqual(document.assertions, portableAssertions)) {
    errors.push("release/artifacts/canvas-portable.json functional assertions are not canonical");
  }
  if (
    !exactKeys(document.fixture, ["kind", "path", "nodes", "edges", "sha256"]) ||
    document.fixture?.kind !== "persisted-canvas-graph" ||
    document.fixture?.path !== portableFixturePath ||
    document.fixture?.nodes !== 4 ||
    document.fixture?.edges !== 4 ||
    !isSha256(document.fixture?.sha256)
  ) {
    errors.push("release/artifacts/canvas-portable.json fixture metadata is invalid");
  }
  if (!Array.isArray(document.outputs) || document.outputs.length !== 5) {
    errors.push("release/artifacts/canvas-portable.json must declare exactly five outputs");
    return;
  }
  const expectedFileNames = [
    path.posix.basename(portableFixturePath),
    ...portableOutputs.map(output => path.posix.basename(output.path)),
  ].sort((left, right) => left.localeCompare(right));
  const portablePath = path.join(root, portableDirectory);
  if (!fs.existsSync(portablePath) || !fs.lstatSync(portablePath).isDirectory() || fs.lstatSync(portablePath).isSymbolicLink()) {
    errors.push("release/artifacts/canvas-portable must be a regular directory");
  } else if (!arraysEqual(
    fs.readdirSync(portablePath).sort((left, right) => left.localeCompare(right)),
    expectedFileNames,
  )) {
    errors.push("release/artifacts/canvas-portable file set is not canonical");
  }
  const outputBytes = new Map();
  for (const [index, entry] of document.outputs.entries()) {
    const expected = portableOutputs[index];
    if (
      !exactKeys(entry, ["path", "mediaType", "bytes", "sha256"]) ||
      !validRelative(entry?.path) ||
      entry.path !== expected.path
    ) {
      errors.push(`release/artifacts/canvas-portable.json outputs[${index}] path is invalid`);
      continue;
    }
    if (entry.mediaType !== expected.mediaType) {
      errors.push(`release/artifacts/canvas-portable.json media type mismatch: ${entry.path}`);
    }
    if (!Number.isInteger(entry.bytes) || entry.bytes < 0) {
      errors.push(`release/artifacts/canvas-portable.json bytes metadata is invalid: ${entry.path}`);
    }
    if (!isSha256(entry.sha256)) {
      errors.push(`release/artifacts/canvas-portable.json sha256 metadata is invalid: ${entry.path}`);
    }
    const absolute = path.join(root, entry.path);
    if (!fs.existsSync(absolute) || !fs.lstatSync(absolute).isFile() || fs.lstatSync(absolute).isSymbolicLink()) {
      errors.push(`release/artifacts/canvas-portable.json output is missing: ${entry.path}`);
      continue;
    }
    const raw = fs.readFileSync(absolute);
    outputBytes.set(entry.path, raw);
    if (entry.bytes !== raw.length) errors.push(`release/artifacts/canvas-portable.json bytes mismatch: ${entry.path}`);
    if (entry.sha256 !== sha256(raw)) errors.push(`release/artifacts/canvas-portable.json sha256 mismatch: ${entry.path}`);
  }
  const fixturePath = path.join(root, portableFixturePath);
  if (!fs.existsSync(fixturePath) || !fs.lstatSync(fixturePath).isFile() || fs.lstatSync(fixturePath).isSymbolicLink()) {
    errors.push(`${portableFixturePath} is missing`);
  } else {
    const fixtureBytes = fs.readFileSync(fixturePath);
    if (document.fixture?.sha256 !== sha256(fixtureBytes)) {
      errors.push("release/artifacts/canvas-portable.json fixture sha256 mismatch");
    }
    let fixtureGraph;
    try { fixtureGraph = JSON.parse(fixtureBytes.toString("utf8")); }
    catch (error) {
      errors.push(`${portableFixturePath} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const canonicalFixtureBytes = Buffer.from(`${JSON.stringify(canonicalPortableGraph(), null, 2)}\n`);
    if (!jsonEqual(fixtureGraph, canonicalPortableGraph()) || !fixtureBytes.equals(canonicalFixtureBytes)) {
      errors.push("release/artifacts/canvas-portable.json fixture graph does not match the canonical contract");
    }
  }
  verifyPortableSurfaceAssertions(outputBytes);
  verifyCanonicalPortableBytes(outputBytes);
}
function verifyTrustedSource(expectedPaths) {
  const canonicalRoot = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);
  const canonicalSourceRoot = fs.existsSync(sourceRoot) ? fs.realpathSync(sourceRoot) : path.resolve(sourceRoot);
  if (canonicalRoot === canonicalSourceRoot) {
    errors.push("default verification requires an independent trusted source root; use --standalone only for published-checkout self-consistency");
    return;
  }
  const trustedChecks = [
    ["canonical source manifest", "scripts/source-manifest.mjs", ["verify"]],
    ["canonical license inventory", "scripts/license-inventory.mjs", ["verify"]],
    ["canonical canvas portable artifact", "scripts/export-canvas.mjs", ["portable-artifact", "verify"]],
    ["canonical public source evidence", "scripts/release-artifacts.mjs", ["verify-public-source"]],
    [
      "canonical effectiveness evidence",
      "scripts/generate-effectiveness-evidence.mjs",
      ["verify", "--readme", path.join(root, "README.md")],
    ],
  ];
  for (const [label, relativeScript] of trustedChecks) {
    const script = path.join(sourceRoot, relativeScript);
    if (!fs.existsSync(script) || !fs.lstatSync(script).isFile() || fs.lstatSync(script).isSymbolicLink()) {
      errors.push(`${label} verifier is missing or not regular: ${relativeScript}`);
      return;
    }
  }
  let sourceExpectedPaths = [];
  try {
    sourceExpectedPaths = expandAllowedFiles(sourceRoot, [...publicDirectoryEntries, ...publicFileEntries, ...publicEvidenceEntries]);
  } catch (error) {
    errors.push(`cannot expand trusted source policy: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const targetPaths = new Set(expectedPaths);
  const sourcePaths = new Set(sourceExpectedPaths);
  for (const filePath of sourceExpectedPaths) if (!targetPaths.has(filePath)) errors.push(`trusted source file is missing from public tree: ${filePath}`);
  for (const filePath of expectedPaths) if (!sourcePaths.has(filePath)) errors.push(`public tree file has no trusted source: ${filePath}`);
  for (const [label, relativeScript, args] of trustedChecks) {
    const script = path.join(sourceRoot, relativeScript);
    command(label, process.execPath, [script, ...args], { cwd: sourceRoot });
  }
  const packageBytes = canonicalPackageBytes();
  for (const filePath of sourceExpectedPaths) {
    const targetFile = path.join(root, filePath);
    if (!fs.existsSync(targetFile)) continue;
    if (filePath === "package.json") {
      if (packageBytes && !fs.readFileSync(targetFile).equals(packageBytes)) errors.push("package.json differs from canonical public projection");
      const expectedMode = canonicalPublicMode(filePath);
      if (expectedMode !== undefined && normalizeMode(fs.statSync(targetFile).mode) !== expectedMode) {
        errors.push("package.json mode differs from canonical public projection");
      }
      continue;
    }
    const sourceFile = path.join(sourceRoot, filePath);
    if (!fs.existsSync(sourceFile) || !fs.lstatSync(sourceFile).isFile() || fs.lstatSync(sourceFile).isSymbolicLink()) {
      errors.push(`trusted source file is missing or not regular: ${filePath}`);
    } else {
      if (!fs.readFileSync(targetFile).equals(canonicalPublicBytes(filePath))) {
        errors.push(`trusted source byte mismatch: ${filePath}`);
      }
      const expectedMode = canonicalPublicMode(filePath);
      if (expectedMode !== undefined && normalizeMode(fs.statSync(targetFile).mode) !== expectedMode) {
        errors.push(`trusted source mode mismatch: ${filePath}`);
      }
    }
  }
}
function verifyTrustedReleaseAssets() {
  const releaseVerifierRelative = "scripts/release-artifacts.mjs";
  const releaseVerifier = path.join(sourceRoot, releaseVerifierRelative);
  if (!fs.existsSync(releaseVerifier) || !fs.lstatSync(releaseVerifier).isFile() || fs.lstatSync(releaseVerifier).isSymbolicLink()) {
    errors.push(`canonical release evidence verifier is missing or not regular: ${releaseVerifierRelative}`);
    return;
  }
  const releaseResult = command(
    "canonical release evidence",
    process.execPath,
    [releaseVerifier, "verify-release"],
    { cwd: sourceRoot },
  );
  if (releaseResult.status !== 0) return;
  const verifierRelative = "scripts/release-ui-attestation.mjs";
  const verifier = path.join(sourceRoot, verifierRelative);
  if (!fs.existsSync(verifier) || !fs.lstatSync(verifier).isFile() || fs.lstatSync(verifier).isSymbolicLink()) {
    errors.push(`canonical GitHub Release asset verifier is missing or not regular: ${verifierRelative}`);
    return;
  }
  command("canonical GitHub Release assets", process.execPath, [
    verifier,
    "github-release-assets",
    "verify",
    "--manifest",
    "dist/canvast-release-assets.json",
    "--expected-team-id",
    cli.expectedTeamId,
    "--expected-signer-cn",
    cli.expectedSignerCn,
  ], { cwd: sourceRoot });
}
function verifyStandaloneEvidenceBindings(sourceManifestHash, sourceTreeHash, sourceGeneratedAt, sourceDocument) {
  const currentSource = {
    sha256: sourceManifestHash,
    sourceTreeSha256: sourceTreeHash,
    generatedAt: sourceGeneratedAt,
    document: sourceDocument,
  };
  for (const evidencePath of publicEvidenceEntries) {
    if (evidencePath === "release/artifacts/canvas-portable.json"
      || evidencePath === "release/artifacts/macos-ui-impact.json") continue;
    const document = readJson(path.join(root, evidencePath), evidencePath);
    if (!document) continue;
    if (document.status !== "passed") errors.push(`${evidencePath} status must be passed`);
    if (typeof document.generatedAt !== "string" || !Number.isFinite(Date.parse(document.generatedAt))) {
      errors.push(`${evidencePath} generatedAt is invalid`);
    }
    const sourceManifest = evidenceSourceManifest(document);
    const directlyBound = sourceManifest?.path === "release/source-manifest.json" && sourceManifest?.sha256 === sourceManifestHash;
    let inheritedBound = false;
    if (!directlyBound) {
      const impactSource = sourceDocument ? macosUiImpactSource(currentSource) : undefined;
      const boundToEvaluation = Boolean(impactSource
        && sourceManifest?.path === "release/source-manifest.json"
        && sourceManifest?.sha256 === impactSource.sha256);
      if (boundToEvaluation) {
        if (evidencePath === "release/artifacts/screenshots.json") {
          const assessment = macosUiImpactAssessment();
          inheritedBound = assessment.macosUiAffected === false && assessment.installedAppAffected === false;
        } else if (evidencePath === "release/artifacts/effectiveness-summary.json"
          || evidencePath === "release/artifacts/model-backend-attestation.json") {
          inheritedBound = true;
        }
      }
    }
    if (!directlyBound && !inheritedBound) {
      errors.push(`${evidencePath} does not bind the public source manifest`);
    } else if (directlyBound
      && typeof sourceGeneratedAt === "string"
      && Date.parse(document.generatedAt) < Date.parse(sourceGeneratedAt)) {
      errors.push(`${evidencePath} predates the source manifest`);
    }
  }
  verifyPortableEvidenceBindings(sourceManifestHash, sourceTreeHash, sourceGeneratedAt);
}
function verifyStandaloneEffectivenessEvidence() {
  const verifierRelative = "scripts/generate-effectiveness-evidence.mjs";
  const verifier = path.join(root, verifierRelative);
  if (!fs.existsSync(verifier) || !fs.lstatSync(verifier).isFile() || fs.lstatSync(verifier).isSymbolicLink()) {
    errors.push(`embedded effectiveness verifier is missing or not regular: ${verifierRelative}`);
    return;
  }
  command("embedded effectiveness evidence", process.execPath, [
    verifier,
    "verify",
    "--embedded-source-snapshot",
    "--readme",
    path.join(root, "README.md"),
  ], { cwd: root });
}
function verifyStandaloneLicenseInventory() {
  const lockfile = path.join(root, "package-lock.json");
  const inventoryFile = path.join(root, "release/license-inventory.json");
  const lock = readJson(lockfile, "package-lock.json");
  const inventory = readJson(inventoryFile, "license inventory");
  if (!lock || !inventory) return;
  if (typeof inventory.generatedAt !== "string" || !Number.isFinite(Date.parse(inventory.generatedAt))) errors.push("license inventory generatedAt is invalid");
  let expected;
  try { expected = createLicenseInventory(fs.readFileSync(lockfile), inventory.generatedAt); }
  catch (error) { errors.push(`cannot create license inventory: ${error instanceof Error ? error.message : String(error)}`); return; }
  if (JSON.stringify(inventory) !== JSON.stringify(expected)) errors.push("license inventory is stale or does not match package-lock.json");
  errors.push(...licenseInventoryPolicyErrors(expected).map(error => `license inventory ${error}`));
  const packageJson = readJson(path.join(root, "package.json"), "package.json for third-party notice");
  const noticeFile = path.join(root, "THIRD_PARTY_NOTICES.md");
  if (!packageJson || !fs.existsSync(noticeFile)) {
    if (!fs.existsSync(noticeFile)) errors.push("THIRD_PARTY_NOTICES.md is missing");
    return;
  }
  errors.push(...thirdPartyNoticePolicyErrors(
    fs.readFileSync(noticeFile, "utf8"),
    inventory,
    fs.readFileSync(inventoryFile),
    packageJson,
    lock,
  ));
}

function verifyNpmPackageBytes(expectedFiles) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "canvast-npm-pack-"));
  try {
    const pack = spawnSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary], {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
      env: cleanEnvironment({ npm_config_cache: path.join(temporary, "npm-cache") }),
    });
    if (pack.status !== 0) { errors.push(`npm pack failed (${String(pack.status)}):\n${pack.stdout || ""}${pack.stderr || ""}`); return; }
    const archives = fs.readdirSync(temporary).filter(name => name.endsWith(".tgz"));
    if (archives.length !== 1) { errors.push(`npm pack produced ${archives.length} tarballs instead of one`); return; }
    const archive = path.join(temporary, archives[0]);
    const listing = spawnSync("tar", ["-tzf", archive], { encoding: "utf8", stdio: "pipe" });
    if (listing.status !== 0) { errors.push(`cannot list npm tarball: ${listing.stderr || listing.stdout || "unknown tar error"}`); return; }
    const verboseListing = spawnSync("tar", ["-tvzf", archive], { encoding: "utf8", stdio: "pipe" });
    if (verboseListing.status !== 0) { errors.push(`cannot inspect npm tarball entry types: ${verboseListing.stderr || verboseListing.stdout || "unknown tar error"}`); return; }
    for (const line of verboseListing.stdout.split("\n").filter(Boolean)) {
      const entryType = line[0];
      if (entryType !== "-" && entryType !== "d") errors.push(`npm tar contains a non-regular entry of type ${entryType}`);
    }
    if (errors.some(error => error.startsWith("npm tar contains a non-regular entry"))) return;
    const listedFiles = [];
    const seen = new Set();
    for (const archivePath of listing.stdout.split("\n").filter(Boolean)) {
      if (!archivePath.startsWith("package/")) { errors.push(`npm tar entry escapes package root: ${archivePath}`); continue; }
      if (archivePath.endsWith("/")) continue;
      const filePath = archivePath.slice("package/".length);
      if (!validRelative(filePath)) { errors.push(`npm tar contains invalid path: ${archivePath}`); continue; }
      if (seen.has(filePath)) errors.push(`npm tar contains duplicate file: ${filePath}`);
      seen.add(filePath);
      listedFiles.push(filePath);
    }
    const extraction = path.join(temporary, "unpacked");
    fs.mkdirSync(extraction);
    const extracted = spawnSync("tar", ["-xzf", archive, "-C", extraction], { encoding: "utf8", stdio: "pipe" });
    if (extracted.status !== 0) { errors.push(`cannot extract npm tarball: ${extracted.stderr || extracted.stdout || "unknown tar error"}`); return; }
    const packageRoot = path.join(extraction, "package");
    const actualPaths = [];
    function visit(directory) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        const filePath = normalize(path.relative(packageRoot, absolute));
        if (entry.isSymbolicLink()) errors.push(`npm tar contains symlink: ${filePath}`);
        else if (entry.isDirectory()) visit(absolute);
        else if (entry.isFile()) actualPaths.push(filePath);
        else errors.push(`npm tar contains non-regular entry: ${filePath}`);
      }
    }
    if (!fs.existsSync(packageRoot)) errors.push("npm tarball is missing package root");
    else visit(packageRoot);
    if (new Set(listedFiles).size !== actualPaths.length || listedFiles.length !== actualPaths.length) errors.push("npm tar listing does not match extracted regular-file set");
    const actualFiles = fileRecords(packageRoot, actualPaths);
    compareProjection(expectedFiles, actualFiles, "npm package");
    if (!errors.some(error => error.startsWith("npm ") || error.includes("npm tar"))) console.log(`PASS npm package bytes (${actualFiles.length} exact files)`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

validatePolicyEntries();
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) errors.push(`public root is missing: ${root}`);
if (!fs.existsSync(markerPath) || !fs.lstatSync(markerPath).isFile() || fs.lstatSync(markerPath).isSymbolicLink()) errors.push("missing regular generated-tree marker");
if (!fs.existsSync(manifestPath) || !fs.lstatSync(manifestPath).isFile() || fs.lstatSync(manifestPath).isSymbolicLink()) errors.push(`missing regular ${manifestRelative}`);

const allFiles = fs.existsSync(root) ? walkFiles(root, []) : [];
const actualPaths = allFiles.map(file => relative(file)).filter(file => !specialManifestFiles.has(file)).sort((left, right) => left.localeCompare(right));
let expectedPaths = [];
try { expectedPaths = expandAllowedFiles(root, [...publicDirectoryEntries, ...publicFileEntries, ...publicEvidenceEntries]); }
catch (error) { errors.push(`cannot expand public policy: ${error instanceof Error ? error.message : String(error)}`); }
const expectedPathSet = new Set(expectedPaths);
for (const filePath of actualPaths) if (!expectedPathSet.has(filePath)) errors.push(`public tree file is not allowed by public policy: ${filePath}`);
for (const filePath of expectedPaths) if (!actualPaths.includes(filePath)) errors.push(`allowlisted file is missing: ${filePath}`);
const publicFiles = fileRecords(root, actualPaths);

const publicManifest = fs.existsSync(manifestPath) ? readJson(manifestPath, "public tree manifest") : undefined;
let sourceManifestHash;
let sourceManifestTreeHash;
let sourceManifestGeneratedAt;
let sourceManifest;
if (publicManifest) {
  if (publicManifest.schemaVersion !== 2 || publicManifest.kind !== "canvast-public-tree" || publicManifest.algorithm !== "sha256") errors.push("public tree manifest schema/kind/algorithm is invalid");
  if (typeof publicManifest.generatedAt !== "string" || !Number.isFinite(Date.parse(publicManifest.generatedAt))) errors.push("public tree manifest generatedAt is invalid");
  if (publicManifest.completeness?.status !== "complete") errors.push("manifest completeness status must be complete");
  if (!arraysEqual(publicManifest.completeness?.requiredEvidence, publicEvidenceEntries)) errors.push("manifest completeness requiredEvidence differs from policy");
  if (Object.prototype.hasOwnProperty.call(publicManifest.completeness || {}, "missingEvidence")) errors.push("complete manifest must not declare missingEvidence");
  for (const evidence of publicEvidenceEntries) if (!fs.existsSync(path.join(root, evidence))) errors.push(`required evidence is missing: ${evidence}`);
  const expectedTransformations = [
    { path: "package.json", kind: "public-package-metadata" },
    ...publicSourceTransformations,
  ];
  if (JSON.stringify(publicManifest.transformations) !== JSON.stringify(expectedTransformations)) errors.push("public tree manifest transformations are invalid");

  const manifestFiles = validateManifestFiles(publicManifest, "public tree manifest");
  compareProjection(publicFiles, manifestFiles, "public tree manifest");
  checkAggregate(publicManifest, publicFiles, "public tree");

  const policyFile = path.join(root, "scripts/public-repo-policy.mjs");
  if (publicManifest.policy?.path !== "scripts/public-repo-policy.mjs" || !fs.existsSync(policyFile) || publicManifest.policy.sha256 !== sha256(fs.readFileSync(policyFile))) errors.push("public policy hash mismatch");
  const sourceManifestFile = path.join(root, "release/source-manifest.json");
  if (fs.existsSync(sourceManifestFile)) sourceManifestHash = sha256(fs.readFileSync(sourceManifestFile));
  if (publicManifest.sourceManifest?.path !== "release/source-manifest.json" || !sourceManifestHash || publicManifest.sourceManifest.sha256 !== sourceManifestHash) errors.push("source manifest hash mismatch in public tree manifest");
  sourceManifest = fs.existsSync(sourceManifestFile) ? readJson(sourceManifestFile, "source manifest") : undefined;
  sourceManifestTreeHash = sourceManifest?.sourceTreeSha256;
  sourceManifestGeneratedAt = sourceManifest?.generatedAt;
  if (sourceManifest && (sourceManifest.schemaVersion !== 2 || sourceManifest.kind !== "canvast-source-snapshot" || sourceManifest.algorithm !== "sha256" || !isSha256(sourceManifest.sourceTreeSha256) || !Array.isArray(sourceManifest.files))) errors.push("source manifest schema is invalid");
  if (sourceManifest?.files) {
    if (typeof sourceManifest.generatedAt !== "string" || !Number.isFinite(Date.parse(sourceManifest.generatedAt))) errors.push("source manifest generatedAt is invalid");
    const sourceFiles = validateSourceManifestFiles(sourceManifest, "source manifest");
    if (sourceManifest.fileCount !== sourceFiles.length) errors.push("source manifest fileCount mismatch");
    if (sourceManifest.totalBytes !== sourceFiles.reduce((sum, file) => sum + file.size, 0)) errors.push("source manifest totalBytes mismatch");
    if (sourceManifest.sourceTreeSha256 !== sourceTreeHash(sourceFiles)) errors.push("source manifest aggregate hash mismatch");
    const releasePolicy = path.join(root, "scripts/release-source-policy.mjs");
    if (sourceManifest.policy?.path !== "scripts/release-source-policy.mjs" || !fs.existsSync(releasePolicy) || sourceManifest.policy.sha256 !== sha256(fs.readFileSync(releasePolicy))) errors.push("source manifest policy hash mismatch");
    if (cli.standalone) {
      const publicByPath = new Map(publicFiles.map(file => [file.path, file]));
      for (const sourceFile of sourceFiles) {
        const publicFile = publicByPath.get(sourceFile.path);
        const transformed = publicSourceTransformations.some(entry => entry.path === sourceFile.path);
        if (publicFile && sourceFile.path !== "package.json" && !transformed) {
          if (publicFile.size !== sourceFile.size || publicFile.sha256 !== sourceFile.sha256) {
            errors.push(`public file differs from embedded source snapshot: ${sourceFile.path}`);
          }
          const actualMode = normalizeMode(fs.statSync(path.join(root, sourceFile.path)).mode);
          if (actualMode !== sourceFile.mode) {
            errors.push(`public file mode differs from embedded source snapshot: ${sourceFile.path}`);
          }
        }
      }
    }
  }
  if (sourceManifest && Number.isFinite(Date.parse(publicManifest.generatedAt)) && Date.parse(publicManifest.generatedAt) < Date.parse(sourceManifest.generatedAt)) errors.push("public tree manifest predates source manifest");

  let payloadPaths = [];
  try { payloadPaths = [...new Set(["package.json", ...expandAllowedFiles(root, npmFileEntries)])].sort((left, right) => left.localeCompare(right)); }
  catch (error) { errors.push(`cannot expand canonical payload policy: ${error instanceof Error ? error.message : String(error)}`); }
  const payloadFiles = fileRecords(root, payloadPaths);
  for (const payloadFile of payloadFiles) if (!expectedPathSet.has(payloadFile.path)) errors.push(`payload file is outside expanded public policy: ${payloadFile.path}`);
  const declaredPayloadFiles = validateManifestFiles(publicManifest.payload, "payload manifest");
  compareProjection(payloadFiles, declaredPayloadFiles, "payload manifest");
  checkAggregate(publicManifest.payload, payloadFiles, "payload");
  for (const payloadFile of payloadFiles) {
    const publicEntry = manifestFiles.find(file => file?.path === payloadFile.path);
    if (!publicEntry || publicEntry.size !== payloadFile.size || publicEntry.sha256 !== payloadFile.sha256) errors.push(`payload file differs from public tree projection: ${payloadFile.path}`);
  }
  if (cli.runCommands && errors.length === 0) verifyNpmPackageBytes(payloadFiles);
}

for (const absolute of allFiles) {
  const filePath = relative(absolute);
  const scan = checkSensitiveFile(absolute);
  if (authoredPublicMarkdownSet.has(filePath) && scan.text !== undefined) {
    checkMarkdownLinks(absolute, scan.text);
    errors.push(...publicDocumentPolicyErrors(filePath, scan.text));
  }
}
for (const error of verifyPublicReleaseLocalImportClosure(
  expectedPathSet,
  importer => fs.readFileSync(path.join(root, importer), "utf8"),
  validRelative,
)) {
  errors.push(error);
}

const pkgPath = path.join(root, "package.json");
if (fs.existsSync(pkgPath)) {
  const pkg = readJson(pkgPath, "package.json");
  if (pkg) {
    if (pkg.license !== "Apache-2.0") errors.push(`package license must be Apache-2.0, got ${String(pkg.license)}`);
    if (pkg.private !== false) errors.push("package.json private must be false");
    if (JSON.stringify(pkg.files) !== JSON.stringify(npmFileEntries)) errors.push("package.json files differs from shared npm allowlist");
    errors.push(...assertPublicPackageRuntimeClosure(pkg, publicPackageScripts, publicRuntimeDependencies));
  }
}

if (cli.standalone) {
  if (sourceManifestHash) verifyStandaloneEvidenceBindings(
    sourceManifestHash,
    sourceManifestTreeHash,
    sourceManifestGeneratedAt,
    sourceManifest,
  );
  verifyStandaloneLicenseInventory();
  verifyStandaloneEffectivenessEvidence();
} else if (expectedPaths.length > 0) {
  verifyTrustedSource(expectedPaths);
}
if (cli.releaseAssets && !cli.standalone && errors.length === 0) verifyTrustedReleaseAssets();

if (cli.runCommands && errors.length === 0) {
  const temporaryCache = fs.mkdtempSync(path.join(os.tmpdir(), "canvast-npm-ci-"));
  try {
    const installed = command("npm install from lockfile", "npm", ["ci", "--ignore-scripts", "--include=optional"], {
      env: {
        npm_config_cache: temporaryCache,
        npm_config_include: "optional",
        npm_config_omit: "",
        npm_config_optional: "true",
      },
    }).status === 0;
    if (installed) {
      try {
        runPublicRuntimeShutdownProbe(root);
        console.log("PASS public runtime owned-handle shutdown");
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      command("TypeScript build check", "npm", ["run", "typecheck"]);
      command("macOS full-text UI guard", "npm", ["run", "guard:macos-ui-full-text"]);
      command("bundled skill verification", "npm", ["run", "verify:skills"]);
      if (process.platform === "darwin" && fs.existsSync(path.join(root, "macos-app"))) command("Swift build", "swift", swiftBuildArguments());
    }
  } finally {
    removeGeneratedCommandOutput();
    fs.rmSync(temporaryCache, { recursive: true, force: true });
  }
}
if (errors.length) { console.error(errors.map(error => `FAIL ${error}`).join("\n")); process.exit(1); }
const trust = cli.standalone ? "standalone self-consistency" : `trusted source ${sourceRoot}`;
console.log(`Public release gate passed: ${publicFiles.length} manifest-bound files checked (${trust}) in ${root}`);
