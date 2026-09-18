#!/usr/bin/env node
/**
 * ============================================================================
 * Canvast — Live Runtime Root Manager / Canvast source file
 * ============================================================================
 * @file        scripts/live-runtime-root.mjs
 * @brief       Owns one canonical-live temporary root and reaps stale roots.
 * @description Uses exact PID/birth/PGID/command ownership, an atomic active
 *              record, a free-space preflight, and bounded path validation.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * ============================================================================
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sampleProcessSnapshot } from "./process-snapshot-client.mjs";

export const LIVE_RUNTIME_SCHEMA_VERSION = 1;
export const LIVE_RUNTIME_OWNER_KIND = "canvast-live-runtime-owner";
export const LIVE_RUNTIME_ACTIVE_KIND = "canvast-live-runtime-active";
export const LIVE_RUNTIME_MARKER = ".canvast-live-runtime-owner.json";
export const LIVE_RUNTIME_ACTIVE_FILE = ".canvast-live-runtime-active.json";
export const DEFAULT_LIVE_MIN_FREE_BYTES = 24 * 1024 * 1024 * 1024;
const TOKEN_LENGTH = 48;
const TOKEN_CHARACTERS = new Set("0123456789abcdef");

function fail(message) {
  throw new Error(message);
}

function exactKeys(value, keys) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function validToken(value) {
  return typeof value === "string" && value.length === TOKEN_LENGTH
    && [...value].every(character => TOKEN_CHARACTERS.has(character));
}

function canonicalRootName(token) {
  if (!validToken(token)) fail("live runtime token must be 48 lowercase hexadecimal characters");
  return `canonical-${token}`;
}

function validatePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== String(value)) {
    fail(`${label} must be a canonical positive safe integer`);
  }
  return parsed;
}

function validateByteCount(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== String(value)) {
    fail(`${label} must be a canonical positive byte count`);
  }
  return parsed;
}

function ensureParent(parentPath) {
  if (typeof parentPath !== "string" || !path.isAbsolute(parentPath) || parentPath.includes("\0")) {
    fail("live runtime parent must be an absolute NUL-free path");
  }
  fs.mkdirSync(parentPath, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(parentPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail("live runtime parent must be a real directory, not a symlink");
  }
  return fs.realpathSync.native(parentPath);
}

function ownerFromRecord(record) {
  return {
    pid: record.pid,
    birth: record.birth,
    pgid: record.pgid,
    command: record.command,
  };
}

function ownerMatches(owner, records) {
  const current = records.find(record => record.pid === owner.pid);
  return Boolean(current) && current.birth === owner.birth && current.pgid === owner.pgid
    && current.command === owner.command;
}

function validateOwner(owner) {
  if (!exactKeys(owner, ["pid", "birth", "pgid", "command"])
    || !Number.isSafeInteger(owner.pid) || owner.pid < 1
    || !Number.isSafeInteger(owner.pgid) || owner.pgid < 1
    || typeof owner.birth !== "string" || !owner.birth
    || typeof owner.command !== "string" || !owner.command) {
    fail("live runtime owner identity is invalid");
  }
  return owner;
}

function readRegularJson(file, label) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`);
  const bytes = fs.readFileSync(file);
  const after = fs.lstatSync(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    fail(`${label} changed while being read`);
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function validateRecord(record, kind, parent, expectedToken) {
  if (!exactKeys(record, ["schemaVersion", "kind", "token", "root", "parent", "createdAt", "owner"])
    || record.schemaVersion !== LIVE_RUNTIME_SCHEMA_VERSION || record.kind !== kind
    || !validToken(record.token) || (expectedToken && record.token !== expectedToken)
    || typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))) {
    fail(`${kind} record is invalid`);
  }
  const expectedRoot = path.join(parent, canonicalRootName(record.token));
  if (record.parent !== parent || record.root !== expectedRoot) fail(`${kind} record escapes its managed parent`);
  validateOwner(record.owner);
  return record;
}

function markerRecord(root, parent, expectedToken) {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("managed live runtime root must be a real directory");
  const canonical = fs.realpathSync.native(root);
  if (canonical !== path.join(parent, canonicalRootName(expectedToken))) {
    fail("managed live runtime root path is not canonical");
  }
  return validateRecord(
    readRegularJson(path.join(canonical, LIVE_RUNTIME_MARKER), "live runtime owner marker"),
    LIVE_RUNTIME_OWNER_KIND, parent, expectedToken,
  );
}

function activeRecord(parent) {
  const file = path.join(parent, LIVE_RUNTIME_ACTIVE_FILE);
  if (!fs.existsSync(file)) return null;
  return validateRecord(readRegularJson(file, "live runtime active record"), LIVE_RUNTIME_ACTIVE_KIND, parent);
}

function writeExclusiveJson(file, value) {
  const descriptor = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function availableBytes(parent) {
  const stat = fs.statfsSync(parent, { bigint: true });
  const available = stat.bavail * stat.bsize;
  return available > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(available);
}

async function removeTree(root, label, log = console.error) {
  if (!fs.existsSync(root)) return;
  const started = Date.now();
  const heartbeat = setInterval(() => {
    log(`[live-runtime] cleanup heartbeat label=${label} elapsed_ms=${Date.now() - started}`);
  }, 5_000);
  heartbeat.unref?.();
  try {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
  } finally {
    clearInterval(heartbeat);
  }
  if (fs.existsSync(root)) fail(`managed live runtime cleanup did not remove ${label}`);
  log(`[live-runtime] cleaned label=${label} elapsed_ms=${Date.now() - started}`);
}

function allProcessRecords() {
  return sampleProcessSnapshot();
}

function currentOwner(ownerPid, records = allProcessRecords()) {
  const record = records.find(candidate => candidate.pid === ownerPid);
  if (!record) fail(`live runtime owner PID ${ownerPid} is not present in the exact process snapshot`);
  return ownerFromRecord(record);
}

async function reapRecord(record, parent, records, label, log) {
  if (ownerMatches(record.owner, records)) {
    fail(`another canonical live run is active: pid=${record.owner.pid} birth=${record.owner.birth}`);
  }
  if (fs.existsSync(record.root)) {
    const markerPath = path.join(record.root, LIVE_RUNTIME_MARKER);
    if (fs.existsSync(markerPath)) {
      const marker = markerRecord(record.root, parent, record.token);
      if (!exactKeys(marker.owner, Object.keys(record.owner))
        || JSON.stringify(marker.owner) !== JSON.stringify(record.owner)) {
        fail("stale live runtime marker does not match its active record");
      }
    } else {
      const stat = fs.lstatSync(record.root);
      if (!stat.isDirectory() || stat.isSymbolicLink()
        || fs.realpathSync.native(record.root) !== path.join(parent, canonicalRootName(record.token))) {
        fail("partially cleaned live runtime root is not a safe managed directory");
      }
    }
    await removeTree(record.root, label, log);
  }
}

async function reapStaleState(parent, records, log) {
  const activePath = path.join(parent, LIVE_RUNTIME_ACTIVE_FILE);
  const active = activeRecord(parent);
  if (active) {
    await reapRecord(active, parent, records, "stale-active-root", log);
    fs.rmSync(activePath, { force: false });
  }
  const entries = fs.readdirSync(parent, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("canonical-")) continue;
    const token = entry.name.slice("canonical-".length);
    if (!validToken(token)) fail(`unrecognized directory in managed live runtime namespace: ${entry.name}`);
    const root = path.join(parent, entry.name);
    const markerPath = path.join(root, LIVE_RUNTIME_MARKER);
    if (fs.existsSync(markerPath)) {
      const marker = markerRecord(root, parent, token);
      if (ownerMatches(marker.owner, records)) {
        fail(`an owner-matched canonical live root has no active record: pid=${marker.owner.pid}`);
      }
    } else {
      const stat = fs.lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()
        || fs.realpathSync.native(root) !== path.join(parent, canonicalRootName(token))) {
        fail("markerless live runtime root is not a safe managed directory");
      }
    }
    await removeTree(root, "stale-orphan-root", log);
  }
}

export async function allocateLiveRuntime(options) {
  const parent = ensureParent(options.parentPath);
  const ownerPid = validatePositiveInteger(options.ownerPid, "owner PID");
  const minimumFreeBytes = validateByteCount(options.minimumFreeBytes, "minimum free bytes");
  const token = options.token || randomBytes(TOKEN_LENGTH / 2).toString("hex");
  canonicalRootName(token);
  const records = options.processRecords || allProcessRecords();
  const owner = currentOwner(ownerPid, records);
  await reapStaleState(parent, records, options.log || console.error);
  const free = availableBytes(parent);
  if (free < minimumFreeBytes) {
    fail(`live runtime free-space preflight failed: available=${free} required=${minimumFreeBytes} parent=${parent}`);
  }
  const root = path.join(parent, canonicalRootName(token));
  const recordBase = {
    schemaVersion: LIVE_RUNTIME_SCHEMA_VERSION, token, root, parent,
    createdAt: new Date().toISOString(), owner,
  };
  const activePath = path.join(parent, LIVE_RUNTIME_ACTIVE_FILE);
  writeExclusiveJson(activePath, { ...recordBase, kind: LIVE_RUNTIME_ACTIVE_KIND });
  try {
    fs.mkdirSync(root, { mode: 0o700 });
    writeExclusiveJson(path.join(root, LIVE_RUNTIME_MARKER), {
      ...recordBase, kind: LIVE_RUNTIME_OWNER_KIND,
    });
  } catch (error) {
    if (fs.existsSync(root)) await removeTree(root, "failed-allocation-root", options.log || console.error);
    fs.rmSync(activePath, { force: true });
    throw error;
  }
  return { root, token, owner, availableBytes: free, minimumFreeBytes };
}

export async function cleanupLiveRuntime(options) {
  const parent = ensureParent(options.parentPath);
  const ownerPid = validatePositiveInteger(options.ownerPid, "owner PID");
  const token = options.token;
  canonicalRootName(token);
  const expectedRoot = path.join(parent, canonicalRootName(token));
  if (path.resolve(options.rootPath) !== expectedRoot) fail("cleanup root does not match the managed token path");
  const activePath = path.join(parent, LIVE_RUNTIME_ACTIVE_FILE);
  const active = activeRecord(parent);
  if (!active || active.token !== token || active.root !== expectedRoot || active.owner.pid !== ownerPid) {
    fail("cleanup request does not match the active live runtime record");
  }
  const records = options.processRecords || allProcessRecords();
  if (!ownerMatches(active.owner, records)) fail("cleanup owner no longer matches its exact process identity");
  const marker = markerRecord(expectedRoot, parent, token);
  if (JSON.stringify(marker.owner) !== JSON.stringify(active.owner)) {
    fail("cleanup owner marker does not match the active record");
  }
  await removeTree(expectedRoot, "current-root", options.log || console.error);
  const confirmed = activeRecord(parent);
  if (!confirmed || confirmed.token !== token) fail("active record changed during cleanup");
  fs.rmSync(activePath, { force: false });
}

function parseCli(argv) {
  const command = argv[0];
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || values.has(name)) fail("invalid live runtime CLI arguments");
    values.set(name, value);
  }
  const required = name => values.get(name) || fail(`missing ${name}`);
  if (command === "allocate") {
    return { command, parentPath: required("--parent"), ownerPid: required("--owner-pid"),
      token: required("--token"), minimumFreeBytes: required("--minimum-free-bytes") };
  }
  if (command === "cleanup") {
    return { command, parentPath: required("--parent"), rootPath: required("--root"),
      ownerPid: required("--owner-pid"), token: required("--token") };
  }
  fail("usage: live-runtime-root.mjs allocate|cleanup [options]");
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.command === "allocate") {
    const allocation = await allocateLiveRuntime(options);
    process.stdout.write(`${allocation.root}\n`);
    console.error(`[live-runtime] allocated root=${allocation.root} available_bytes=${allocation.availableBytes} required_bytes=${allocation.minimumFreeBytes}`);
    return;
  }
  await cleanupLiveRuntime(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch(error => {
    console.error(`live runtime root failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
