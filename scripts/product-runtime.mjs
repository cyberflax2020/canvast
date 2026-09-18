#!/usr/bin/env node
/**
 * =============================================================================
 * Canvast — Sealed Product Runtime / Canvast source file
 * =============================================================================
 * @file        scripts/product-runtime.mjs
 * @brief       Build and verify the self-contained application runtime.
 * @description Produces an exact, hash-bound runtime from explicit product
 *              inputs and a clean production dependency install.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RUNTIME_MANIFEST = "CanvastRuntimeManifest.json";
export const productRuntimeEntries = Object.freeze([
  "assets/brand/asset-manifest.json",
  "assets/brand/canvast-logo.svg",
  "assets/brand/canvast-logo.tui.txt",
  "components/",
  "config-templates/",
  "extensions/",
  "src/",
  "scripts/export-canvas.mjs",
  "scripts/canvas-export-portable-artifact.mjs",
  "scripts/canvas-portable-release-artifact.mjs",
  "scripts/canvas-surface-artifact.mjs",
  "scripts/process-snapshot-client.d.mts",
  "scripts/process-snapshot-client.mjs",
  "scripts/process-snapshot.py",
  "scripts/resolve-canvast-skill.mjs",
  "skills/",
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
  "VERSION",
]);

const FORBIDDEN_SEGMENTS = new Set([
  "test", "tests", "__tests__", "fixture", "fixtures", "example", "examples",
  ".canvast-secrets", ".pi", ".runtime", "pi-data", "coverage", "__pycache__",
]);
const FORBIDDEN_BASENAMES = new Set([".env", ".env.local", ".ds_store"]);
const FORBIDDEN_RUNTIME_DEPENDENCY_BASENAMES = new Set([
  "CHANGELOG", "CHANGELOG.md", "HISTORY", "HISTORY.md", "README", "README.md",
  "SECURITY", "SECURITY.md",
]);
const FORBIDDEN_TEST_BASENAMES = new Set([
  "test.js", "test.cjs", "test.mjs", "test.ts", "test.tsx",
  "spec.js", "spec.cjs", "spec.mjs", "spec.ts", "spec.tsx",
]);
const FORBIDDEN_TEST_NAME_MARKERS = Object.freeze([".test.", ".spec.", "-test.", "-spec."]);
const CORE_ENTRYPOINT = "package/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
const PRODUCT_EXTENSION_FILES = Object.freeze([
  "canvast-core.ts", "canvast-harness.ts", "canvast-tui.ts", "product-closure.ts",
  "sandbox-bash.ts", "canvast-permissions.ts", "desktop-action.ts", "plan-mode.ts",
  "task-manager.ts", "web-tools.ts", "sub-agent.ts", "code-review.ts", "ask-user.ts",
  "mcp-bridge.ts", "git-tools.ts", "token-tracker.ts", "background-task.ts",
  "canvas-repomap.ts", "notebook-edit.ts", "lsp-tools.ts", "workflow.ts",
  "cron-scheduler.ts", "worktree.ts", "artifact.ts", "agent-comms.ts",
  "report-findings.ts", "monitor.ts", "owned-handle-diagnostics.ts",
].map(file => `package/extensions/${file}`));

function fail(message) { throw new Error(message); }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function posix(value) { return value.split(path.sep).join("/"); }
function isLowerHexCharacter(character) {
  return (character >= "0" && character <= "9") || (character >= "a" && character <= "f");
}
function isSha256(value) {
  if (typeof value !== "string" || value.length !== 64) return false;
  for (const character of value) {
    if (!isLowerHexCharacter(character)) return false;
  }
  return true;
}
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function safeRelative(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\") || path.posix.isAbsolute(value)) return false;
  return path.posix.normalize(value) === value && value.split("/").every(segment => segment && segment !== "." && segment !== "..");
}
export function isForbiddenRuntimePath(relative) {
  const segments = posix(relative).split("/");
  const basename = segments.at(-1).toLocaleLowerCase("en-US");
  return segments.some(segment => FORBIDDEN_SEGMENTS.has(segment.toLocaleLowerCase("en-US")))
    || FORBIDDEN_BASENAMES.has(basename) || basename.startsWith(".env.")
    || FORBIDDEN_TEST_BASENAMES.has(basename)
    || FORBIDDEN_TEST_NAME_MARKERS.some(marker => basename.includes(marker))
    || basename.endsWith(".log") || basename.endsWith(".pyc") || basename.endsWith(".map");
}

export function isForbiddenRuntimeDependencyPath(relative) {
  const segments = posix(relative).split("/");
  const basenameRaw = segments.at(-1);
  const basename = basenameRaw.toLocaleLowerCase("en-US");
  return isForbiddenRuntimePath(relative)
    || FORBIDDEN_RUNTIME_DEPENDENCY_BASENAMES.has(basenameRaw)
    || basename.endsWith(".d.ts") || basename.endsWith(".d.mts") || basename.endsWith(".d.cts")
    || basename.endsWith(".ts") || basename.endsWith(".tsx")
    || basename.endsWith(".mts") || basename.endsWith(".cts")
    || basename.endsWith(".tsbuildinfo");
}

function listTree(root, omitManifest = true) {
  const files = [];
  function visit(directory) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, item.name);
      const relative = posix(path.relative(root, absolute));
      if (omitManifest && relative === RUNTIME_MANIFEST) continue;
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) fail(`runtime contains symbolic link: ${relative}`);
      if (stat.isDirectory()) { visit(absolute); continue; }
      if (!stat.isFile()) fail(`runtime contains special file: ${relative}`);
      const bytes = fs.readFileSync(absolute);
      files.push({ path: relative, type: "file", size: bytes.length, sha256: sha256(bytes), mode: stat.mode & 0o777 });
    }
  }
  visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function sameFileRecords(left, right) {
  if (left.length !== right.length) return false;
  return left.every((record, index) => {
    const other = right[index];
    return record.path === other.path && record.type === other.type && record.size === other.size
      && record.sha256 === other.sha256 && record.mode === other.mode;
  });
}

function copyFile(source, destination, mode) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`runtime source must be a regular file: ${source}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, mode ?? (stat.mode & 0o111 ? 0o755 : 0o644));
}

function command(binary, args, label) {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 120_000 });
  if (result.error || result.status !== 0) fail(`${label}: ${result.error?.message || result.stderr || result.stdout || `status ${String(result.status)}`}`.trim());
  return result.stdout;
}

export function parseMachoDependencies(output) {
  return output.split("\n").filter(line => line[0] === "\t" || line[0] === " ").map(line => {
    const dependency = line.trim();
    const metadata = dependency.indexOf(" (compatibility version ");
    return metadata >= 0 ? dependency.slice(0, metadata) : dependency.split(" " )[0];
  }).filter(Boolean);
}

function machoDependencies(file) {
  const output = command("/usr/bin/otool", ["-L", file], `unable to inspect Node dependency closure for ${file}`);
  return parseMachoDependencies(output);
}

function regularFile(file) {
  if (!fs.existsSync(file)) return false;
  const stat = fs.lstatSync(file);
  return stat.isFile() && !stat.isSymbolicLink();
}

function runtimeLibraries(runtimeRoot) {
  const libraryRoot = path.join(runtimeRoot, "lib");
  if (!fs.existsSync(libraryRoot)) return [];
  const rootStat = fs.lstatSync(libraryRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail(`sealed runtime library root must be a real directory: ${libraryRoot}`);
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) fail(`sealed runtime library must not be a symbolic link: ${absolute}`);
      if (stat.isDirectory()) { visit(absolute); continue; }
      if (!stat.isFile()) fail(`sealed runtime library must be a regular file: ${absolute}`);
      files.push(absolute);
    }
  }
  visit(libraryRoot);
  return files;
}

export function verifyMachoRuntimeClosure(runtimeDir, options = {}) {
  if (process.platform !== "darwin" && options.force !== true) return [];
  const root = fs.realpathSync(path.resolve(runtimeDir));
  const node = path.join(root, "bin", "node");
  if (!regularFile(node)) fail(`sealed runtime Node must be a regular file: ${node}`);
  const inspect = options.inspect ?? (file => {
    const output = command("/usr/bin/otool", ["-L", file], `unable to inspect sealed runtime Mach-O dependency closure for ${file}`);
    return parseMachoDependencies(output);
  });
  const queue = [node, ...runtimeLibraries(root)];
  const inspected = new Set();
  for (let index = 0; index < queue.length; index += 1) {
    const current = fs.realpathSync(queue[index]);
    if (!inside(root, current)) fail(`sealed runtime Mach-O escapes runtime root: ${queue[index]}`);
    if (inspected.has(current)) continue;
    inspected.add(current);
    for (const dependency of inspect(current)) {
      const normalizedDependency = path.posix.normalize(dependency);
      const systemDependency = normalizedDependency === dependency
        && (dependency.startsWith("/System/") || dependency.startsWith("/usr/lib/"));
      if (systemDependency) continue;
      if (!dependency.startsWith("@loader_path/")) {
        fail(`sealed runtime Mach-O dependency must use @loader_path: ${dependency} (from ${current})`);
      }
      const resolved = path.resolve(path.dirname(current), dependency.slice("@loader_path/".length));
      if (!inside(root, resolved)) fail(`sealed runtime Mach-O dependency escapes runtime root: ${dependency} (from ${current})`);
      if (!regularFile(resolved)) fail(`sealed runtime Mach-O dependency is missing: ${dependency} (from ${current})`);
      const canonicalDependency = fs.realpathSync(resolved);
      if (!inside(root, canonicalDependency)) fail(`sealed runtime Mach-O dependency escapes runtime root: ${dependency} (from ${current})`);
      if (canonicalDependency === current) continue;
      queue.push(canonicalDependency);
    }
  }
  return [...inspected];
}

export function bundleNodeRuntime(sourceNode, staging, options = {}) {
  const realNode = fs.realpathSync(sourceNode);
  const destinationNode = path.join(staging, "bin", "node");
  copyFile(realNode, destinationNode, 0o755);
  if ((options.platform ?? process.platform) !== "darwin") return;
  const inspect = options.inspect ?? machoDependencies;
  const runCommand = options.command ?? command;
  const libDir = path.join(staging, "lib");
  fs.mkdirSync(libDir);
  const sourceByName = new Map();
  const queue = [{ source: realNode, destination: destinationNode, loader: path.dirname(realNode) }];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    for (const dependency of inspect(current.source)) {
      if (dependency.startsWith("/System/") || dependency.startsWith("/usr/lib/")) continue;
      let resolved = dependency;
      if (dependency.startsWith("@rpath/")) resolved = path.resolve(current.loader, "..", "lib", path.basename(dependency));
      else if (dependency.startsWith("@loader_path/")) resolved = path.resolve(current.loader, dependency.slice("@loader_path/".length));
      if (!fs.existsSync(resolved)) fail(`Node dependency is not available for bundling: ${dependency}`);
      resolved = fs.realpathSync(resolved);
      const name = path.basename(resolved);
      const previous = sourceByName.get(name);
      if (previous && previous !== resolved) fail(`Node dependency basename collision: ${name}`);
      const destination = path.join(libDir, name);
      if (!previous) {
        copyFile(resolved, destination, 0o755);
        runCommand("/usr/bin/install_name_tool", ["-id", `@loader_path/${name}`, destination], `unable to make Node library install name relocatable: ${name}`);
        sourceByName.set(name, resolved);
        queue.push({ source: resolved, destination, loader: path.dirname(resolved) });
      }
      const replacement = current.destination === destinationNode ? `@loader_path/../lib/${name}` : `@loader_path/${name}`;
      runCommand("/usr/bin/install_name_tool", ["-change", dependency, replacement, current.destination], `unable to make Node dependency relocatable: ${dependency}`);
    }
  }
}

function copyTree(sourceRoot, destinationRoot, filter = () => true) {
  function visit(source, destination, relative) {
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) fail(`runtime source contains symbolic link: ${relative}`);
    if (stat.isFile()) {
      if (filter(relative, stat)) copyFile(source, destination);
      return;
    }
    if (!stat.isDirectory()) fail(`runtime source contains special file: ${relative}`);
    for (const name of fs.readdirSync(source).sort((a, b) => a.localeCompare(b))) {
      const child = relative ? `${relative}/${name}` : name;
      if (!filter(child, fs.lstatSync(path.join(source, name)))) continue;
      visit(path.join(source, name), path.join(destination, name), child);
    }
  }
  visit(sourceRoot, destinationRoot, "");
}

function copyProductEntry(projectDir, productDir, entry) {
  const clean = entry.endsWith("/") ? entry.slice(0, -1) : entry;
  const source = path.join(projectDir, clean);
  if (!fs.existsSync(source)) fail(`required runtime product entry is missing: ${entry}`);
  const stat = fs.lstatSync(source);
  if (stat.isDirectory()) {
    copyTree(source, path.join(productDir, clean), relative => !isForbiddenRuntimePath(relative));
  } else {
    if (isForbiddenRuntimePath(clean)) fail(`runtime product entry is forbidden: ${entry}`);
    copyFile(source, path.join(productDir, clean));
  }
}

function runtimePackage(projectPackage) {
  return {
    name: projectPackage.name, version: projectPackage.version, private: true, type: "module",
    license: projectPackage.license, dependencies: projectPackage.dependencies || {},
    engines: projectPackage.engines || {},
  };
}

function copyProductionDependencies(projectDir, productDir) {
  const sourceModules = path.join(projectDir, "node_modules");
  if (!fs.existsSync(sourceModules) || !fs.lstatSync(sourceModules).isDirectory()) fail(`installed dependency root is unavailable: ${sourceModules}`);
  const lock = JSON.parse(fs.readFileSync(path.join(projectDir, "package-lock.json"), "utf8"));
  if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== "object") fail("package-lock.json must contain a lockfileVersion 3 package map");
  const platformMatches = metadata => (!Array.isArray(metadata.os) || metadata.os.includes(process.platform))
    && (!Array.isArray(metadata.cpu) || metadata.cpu.includes(process.arch));
  const records = Object.entries(lock.packages)
    .filter(([relative, metadata]) => relative.startsWith("node_modules/") && metadata && metadata.dev !== true && metadata.link !== true && platformMatches(metadata))
    .sort(([left], [right]) => left.localeCompare(right));
  if (records.length === 0) fail("package-lock.json contains no production dependency closure");
  console.log(`Copying ${records.length} locked production packages from verified local inputs`);
  for (const [relative, metadata] of records) {
    const source = path.join(projectDir, relative);
    if (!fs.existsSync(source) || !fs.lstatSync(source).isDirectory() || fs.lstatSync(source).isSymbolicLink()) fail(`locked production dependency is unavailable: ${relative}`);
    const packageDocument = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
    if (packageDocument.name !== metadata.name && metadata.name !== undefined) fail(`production dependency name mismatch: ${relative}`);
    if (packageDocument.version !== metadata.version) fail(`production dependency version mismatch: ${relative}`);
    copyTree(source, path.join(productDir, relative), child => {
      if (child === "node_modules" || child.startsWith("node_modules/")) return false;
      return !isForbiddenRuntimeDependencyPath(child);
    });
  }
}

function dependencyLicenses(productDir) {
  const records = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.name.startsWith("@")) { visit(absolute); continue; }
      const packageFile = path.join(absolute, "package.json");
      if (!fs.existsSync(packageFile)) continue;
      const document = JSON.parse(fs.readFileSync(packageFile, "utf8"));
      if (!document.name || !document.version || !document.license) fail(`dependency lacks name/version/license: ${packageFile}`);
      records.push({ name: document.name, version: document.version, license: document.license, path: posix(path.relative(productDir, absolute)) });
      const nested = path.join(absolute, "node_modules");
      if (fs.existsSync(nested)) visit(nested);
    }
  }
  visit(path.join(productDir, "node_modules"));
  return records.sort((a, b) => a.path.localeCompare(b.path));
}

function writeManifest(runtimeDir, dependencies) {
  const files = listTree(runtimeDir);
  const document = {
    schemaVersion: 1, kind: "canvast-sealed-runtime", algorithm: "sha256",
    layout: { launcher: "bin/canvast", node: "bin/node", product: "package", productionDependencies: "package/node_modules", licenses: "package/licenses" },
    files, dependencies,
    treeSha256: sha256(files.map(file => `${file.sha256} ${file.size} ${file.path}\n`).join("")),
  };
  const manifestPath = path.join(runtimeDir, RUNTIME_MANIFEST);
  const temporary = `${manifestPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  fs.renameSync(temporary, manifestPath);
  return document;
}

function validateManifest(runtimeDir) {
  const manifestPath = path.join(runtimeDir, RUNTIME_MANIFEST);
  const stat = fs.lstatSync(manifestPath);
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`runtime manifest must be a regular file: ${manifestPath}`);
  const document = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (document.schemaVersion !== 1 || document.kind !== "canvast-sealed-runtime" || document.algorithm !== "sha256") fail("runtime manifest schema/kind/algorithm is invalid");
  if (!Array.isArray(document.files) || document.files.length === 0) fail("runtime manifest file allowlist is empty");
  const declared = document.files.map(record => {
    if (!record || !safeRelative(record.path) || record.type !== "file" || !Number.isSafeInteger(record.size) || record.size < 0 || !isSha256(record.sha256)) fail("runtime manifest contains an invalid file record");
    return record;
  }).sort((a, b) => a.path.localeCompare(b.path));
  const unique = new Set(declared.map(record => record.path));
  if (unique.size !== declared.length) fail("runtime manifest repeats a file path");
  for (const required of [
    "bin/canvast", "bin/node", CORE_ENTRYPOINT, "package/package.json",
    "package/licenses/dependencies.json",
    "package/config-templates/sealed-runtime-environment.txt",
    "package/config-templates/openssl.cnf",
    "package/scripts/resolve-canvast-skill.mjs",
    ...PRODUCT_EXTENSION_FILES,
  ]) {
    if (!unique.has(required)) fail(`runtime manifest omits required file: ${required}`);
  }
  const actual = listTree(runtimeDir);
  if (!sameFileRecords(actual, declared)) fail("runtime exact file set, hash, size, or mode does not match its manifest");
  const treeHash = sha256(actual.map(file => `${file.sha256} ${file.size} ${file.path}\n`).join(""));
  if (document.treeSha256 !== treeHash) fail("runtime manifest tree hash does not match");
  if (!Array.isArray(document.dependencies) || document.dependencies.length === 0) fail("runtime dependency license inventory is empty");
  const launcher = path.join(runtimeDir, "bin", "canvast");
  const node = path.join(runtimeDir, "bin", "node");
  if ((fs.statSync(launcher).mode & 0o111) === 0 || (fs.statSync(node).mode & 0o111) === 0) fail("runtime launchers must be executable");
  return document;
}

export function verifyProductRuntime(runtimeDir, options = {}) {
  const root = path.resolve(runtimeDir);
  if (!fs.existsSync(root) || !fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) fail(`runtime root must be a real directory: ${root}`);
  const document = validateManifest(root);
  verifyMachoRuntimeClosure(root, options.macho);
  return document;
}

export function sealProductRuntime(runtimeDir) {
  const root = path.resolve(runtimeDir);
  const inventoryPath = path.join(root, "package", "licenses", "dependencies.json");
  const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
  if (inventory.schemaVersion !== 1 || !Array.isArray(inventory.dependencies)) fail("runtime dependency license inventory is invalid");
  writeManifest(root, inventory.dependencies);
  return verifyProductRuntime(root);
}

export function buildProductRuntime(options) {
  const projectDir = fs.realpathSync(path.resolve(options.projectDir));
  const destination = path.resolve(options.output);
  const parent = path.dirname(destination);
  if (inside(projectDir, destination) || inside(destination, projectDir)) fail("runtime output must be isolated from the source repository");
  if (!fs.existsSync(parent) || !fs.lstatSync(parent).isDirectory() || fs.lstatSync(parent).isSymbolicLink()) fail(`runtime output parent must be a real directory: ${parent}`);
  const canonicalParent = fs.realpathSync(parent);
  const canonicalDestination = path.join(canonicalParent, path.basename(destination));
  if (inside(projectDir, canonicalDestination) || inside(canonicalDestination, projectDir)) fail("runtime output must be isolated from the source repository");
  if (fs.existsSync(destination)) fail(`runtime output already exists: ${destination}`);
  const staging = fs.mkdtempSync(path.join(parent, ".canvast-runtime."));
  try {
    const binDir = path.join(staging, "bin");
    const productDir = path.join(staging, "package");
    fs.mkdirSync(binDir); fs.mkdirSync(productDir);
    copyFile(path.join(projectDir, "bin", "canvast"), path.join(binDir, "canvast"), 0o755);
    bundleNodeRuntime(options.nodeBin, staging);
    const packageDocument = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8"));
    fs.writeFileSync(path.join(productDir, "package.json"), `${JSON.stringify(runtimePackage(packageDocument), null, 2)}\n`, { flag: "wx", mode: 0o644 });
    for (const entry of productRuntimeEntries) copyProductEntry(projectDir, productDir, entry);
    copyProductionDependencies(projectDir, productDir);
    const dependencies = dependencyLicenses(productDir);
    fs.mkdirSync(path.join(productDir, "licenses"));
    fs.writeFileSync(path.join(productDir, "licenses", "dependencies.json"), `${JSON.stringify({ schemaVersion: 1, dependencies }, null, 2)}\n`, { flag: "wx", mode: 0o644 });
    writeManifest(staging, dependencies);
    verifyProductRuntime(staging);
    fs.renameSync(staging, destination);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return verifyProductRuntime(destination);
}

function parseCli(argv) {
  const command = argv[0];
  if (!["build", "seal", "verify"].includes(command)) fail("usage: product-runtime.mjs <build|seal|verify> --root PATH [--output PATH --node PATH]");
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const option = argv[index]; const value = argv[index + 1];
    if (!["--root", "--output", "--node"].includes(option) || !value || values[option]) fail(`invalid runtime argument: ${String(option)}`);
    values[option] = value;
  }
  if (!values["--root"]) fail("missing runtime argument: --root");
  if (command === "build" && (!values["--output"] || !values["--node"])) fail("runtime build requires --output and --node");
  return { command, values };
}

function main() {
  const { command, values } = parseCli(process.argv.slice(2));
  if (command !== "build") {
    const document = command === "seal" ? sealProductRuntime(values["--root"]) : verifyProductRuntime(values["--root"]);
    console.log(`Canvast sealed runtime ${command === "seal" ? "sealed" : "verified"}: ${document.files.length} files`);
    return;
  }
  const document = buildProductRuntime({ projectDir: values["--root"], output: values["--output"], nodeBin: values["--node"] });
  console.log(`Canvast sealed runtime built: ${document.files.length} files`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try { main(); } catch (error) { console.error(`product-runtime: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); }
}
