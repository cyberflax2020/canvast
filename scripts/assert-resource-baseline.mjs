#!/usr/bin/env node
/**
 * =============================================================================
 * Canvast — Assert Resource Baseline / Canvast 源文件
 * =============================================================================
 * @file        scripts/assert-resource-baseline.mjs
 * @brief       Captures and asserts an exact, read-only OS process baseline.
 * @description Prevents repository-owned process leaks without signalling or
 *              otherwise mutating any process on macOS and Linux.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROCESS_SNAPSHOT_SOURCE,
  sampleProcessSnapshot,
} from "./process-snapshot-client.mjs";

export const RESOURCE_BASELINE_SCHEMA_VERSION = 1;
export const RESOURCE_BASELINE_KIND = "canvast-os-process-baseline";
export const RESOURCE_PROCESS_FIXTURE_KIND = "canvast-os-process-fixture";
export const RESOURCE_BASELINE_MAX_SETTLE_MS = 30_000;
export const RESOURCE_BASELINE_MAX_POLL_MS = 5_000;
export const OWNED_HANDLE_REGISTRY_VERSION = 1;
export const OWNED_HANDLE_REGISTRY_KIND = "canvast-owned-handle-registry";
export const OWNED_HANDLE_SHUTDOWN_EVIDENCE_VERSION = 1;
export const OWNED_HANDLE_SHUTDOWN_EVIDENCE_KIND = "canvast-owned-handle-shutdown-evidence";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepo = path.resolve(path.dirname(scriptPath), "..");
const processKeys = Object.freeze([
  "pid",
  "ppid",
  "pgid",
  "birth",
  "lstart",
  "command",
  "cwd",
]);
const ownershipRules = Object.freeze([
  "cwd-within-repository",
  "exact-repository-path-in-full-command",
  "descendant-of-repository-owned-process",
  "same-process-group-as-repository-owned-process",
]);

export class ResourceBaselineError extends Error {
  constructor(message, code = "RESOURCE_BASELINE_ERROR") {
    super(message);
    this.name = "ResourceBaselineError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new ResourceBaselineError(message, code);
}

function exactKeys(value, expected) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function finiteInteger(value, minimum = 0) {
  return Number.isInteger(value) && value >= minimum;
}

function normalizeCommand(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail("process command must be a non-empty string without NUL", "INVALID_PROCESS_SAMPLE");
  }
  return value;
}

function normalizeOptionalCwd(value) {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !path.isAbsolute(value)) {
    fail("process cwd must be null or a non-empty string without NUL", "INVALID_PROCESS_SAMPLE");
  }
  return path.resolve(value);
}

export function normalizeProcessRecord(value) {
  if (!exactKeys(value, processKeys)) {
    fail(`process record keys must be exactly: ${processKeys.join(", ")}`, "INVALID_PROCESS_SAMPLE");
  }
  if (!finiteInteger(value.pid, 1)) fail("process pid must be a positive integer", "INVALID_PROCESS_SAMPLE");
  if (!finiteInteger(value.ppid)) fail("process ppid must be a non-negative integer", "INVALID_PROCESS_SAMPLE");
  if (!finiteInteger(value.pgid)) fail("process pgid must be a non-negative integer", "INVALID_PROCESS_SAMPLE");
  if (typeof value.birth !== "string" || value.birth.length === 0 || value.birth.includes("\0")) {
    fail("process birth must be a non-empty string without NUL", "INVALID_PROCESS_SAMPLE");
  }
  if (typeof value.lstart !== "string" || value.lstart.length === 0 || value.lstart.includes("\0")) {
    fail("process lstart must be a non-empty string without NUL", "INVALID_PROCESS_SAMPLE");
  }
  return Object.freeze({
    pid: value.pid,
    ppid: value.ppid,
    pgid: value.pgid,
    birth: value.birth,
    lstart: value.lstart,
    command: normalizeCommand(value.command),
    cwd: normalizeOptionalCwd(value.cwd),
  });
}

function compareProcesses(left, right) {
  return left.pid - right.pid || left.birth.localeCompare(right.birth) || left.command.localeCompare(right.command);
}

function identityKey(processRecord) {
  return `${processRecord.pid}\0${processRecord.birth}`;
}

function canonicalRepo(candidate) {
  const absolute = path.resolve(candidate);
  let real;
  try {
    real = fs.realpathSync(absolute);
  } catch (error) {
    fail(`repository root is unavailable: ${absolute}: ${error instanceof Error ? error.message : String(error)}`, "REPO_UNAVAILABLE");
  }
  let stat;
  try {
    stat = fs.statSync(real);
  } catch (error) {
    fail(`repository root cannot be inspected: ${real}: ${error instanceof Error ? error.message : String(error)}`, "REPO_UNAVAILABLE");
  }
  if (!stat.isDirectory()) fail(`repository root is not a directory: ${real}`, "REPO_UNAVAILABLE");
  return real;
}

function isInsideOrEqual(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isWhitespace(character) {
  return character === " " || character === "\t" || character === "\r"
    || character === "\n" || character === "\v" || character === "\f";
}

function isDecimal(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  for (const character of value) if (character < "0" || character > "9") return false;
  return true;
}

function commandContainsExactPath(command, repo) {
  let cursor = command.indexOf(repo);
  while (cursor >= 0) {
    const before = cursor === 0 ? "" : command[cursor - 1];
    const afterIndex = cursor + repo.length;
    const after = afterIndex >= command.length ? "" : command[afterIndex];
    const beforeBoundary = before === "" || before === "=" || before === ":" || before === "'"
      || before === '"' || before === "(" || isWhitespace(before);
    const afterBoundary = after === "" || after === path.sep || after === "'" || after === '"'
      || after === ")" || isWhitespace(after);
    if (beforeBoundary && afterBoundary) return true;
    cursor = command.indexOf(repo, cursor + 1);
  }
  return false;
}

/**
 * Select repository-owned OS processes. Opaque host unified-exec handles are
 * intentionally not input records: a handle is not an OS process identity.
 */
export function selectRepoOwnedProcesses(processes, repo, ignoredPids = []) {
  const canonical = path.resolve(repo);
  const ignored = new Set(ignoredPids);
  const byPid = new Map();
  for (const raw of processes) {
    const record = normalizeProcessRecord(raw);
    if (byPid.has(record.pid)) fail(`duplicate PID in one process sample: ${record.pid}`, "INVALID_PROCESS_SAMPLE");
    byPid.set(record.pid, record);
  }

  const owned = new Set();
  for (const record of byPid.values()) {
    if (ignored.has(record.pid)) continue;
    if ((record.cwd !== null && isInsideOrEqual(canonical, record.cwd))
      || commandContainsExactPath(record.command, canonical)) {
      owned.add(record.pid);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    const ownedGroups = new Set([...owned]
      .map(pid => byPid.get(pid))
      .filter(record => record?.pid === record?.pgid)
      .map(record => record?.pgid)
      .filter(pgid => finiteInteger(pgid, 1)));
    for (const record of byPid.values()) {
      if (!ignored.has(record.pid) && !owned.has(record.pid)
        && (owned.has(record.ppid) || ownedGroups.has(record.pgid))) {
        owned.add(record.pid);
        changed = true;
      }
    }
  }
  return [...owned].map(pid => byPid.get(pid)).sort(compareProcesses);
}

function macosCwdByPid() {
  const executable = fs.existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : "lsof";
  const result = spawnSync(executable, ["-n", "-P", "-d", "cwd", "-Fpn"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 10_000,
    env: { ...process.env, LC_ALL: "C" },
  });
  if (result.error || result.status !== 0 || !result.stdout) {
    const detail = result.error?.message || result.stderr?.trim() || `status ${String(result.status)}`;
    fail(`macOS cwd sampler is unavailable: ${detail}`, "PROCESS_SAMPLE_UNAVAILABLE");
  }
  const resultMap = new Map();
  let currentPid;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("p") && isDecimal(line.slice(1))) currentPid = Number.parseInt(line.slice(1), 10);
    else if (currentPid !== undefined && line.startsWith("n") && line.length > 1) {
      resultMap.set(currentPid, path.resolve(line.slice(1)));
    }
  }
  if (resultMap.size === 0) fail("macOS cwd sampler returned no process cwd records", "PROCESS_SAMPLE_UNAVAILABLE");
  return resultMap;
}

function linuxProcessMetadata(record) {
  let cwd = null;
  try {
    cwd = fs.realpathSync(`/proc/${record.pid}/cwd`);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    fail(`Linux /proc cwd metadata is unavailable for PID ${record.pid}: ${error instanceof Error ? error.message : String(error)}`, "PROCESS_SAMPLE_UNAVAILABLE");
  }
  return { ...record, cwd };
}

function sampleNativeProcesses() {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    fail(`unsupported OS process sampler platform: ${process.platform}`, "UNSUPPORTED_PLATFORM");
  }
  let snapshot;
  try {
    snapshot = sampleProcessSnapshot();
  } catch (error) {
    fail(`OS process sampler is unavailable: ${error instanceof Error ? error.message : String(error)}`, "PROCESS_SAMPLE_UNAVAILABLE");
  }
  const parsed = snapshot.map(record => ({
    pid: record.pid,
    ppid: record.ppid,
    pgid: record.pgid,
    birth: record.birth,
    lstart: record.birth,
    command: record.command,
    cwd: null,
  }));
  if (process.platform === "darwin") {
    const cwd = macosCwdByPid();
    return parsed.map(record => ({ ...record, cwd: cwd.get(record.pid) || null }));
  }
  return parsed.map(linuxProcessMetadata).filter(Boolean);
}

function readJsonNoFollow(file, label) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) fail(`${label} must be a regular file`, "INVALID_INPUT_FILE");
    return JSON.parse(fs.readFileSync(descriptor, "utf8"));
  } catch (error) {
    if (error instanceof ResourceBaselineError) throw error;
    fail(`${label} cannot be read as JSON: ${error instanceof Error ? error.message : String(error)}`, "INVALID_INPUT_FILE");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function validJsonValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(validJsonValue);
  return Boolean(value) && typeof value === "object"
    && Object.keys(value).every(key => key.length > 0 && !key.includes("\0") && validJsonValue(value[key]));
}

function validTimestamp(value) {
  if (typeof value !== "string" || value.length === 0 || !Number.isFinite(Date.parse(value))) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

export function validateRegistrySnapshot(value) {
  const topKeys = [
    "version", "kind", "capturedAt", "activeCount", "unconfirmedCount",
    "settlingCount", "admission", "boundary", "entries",
  ];
  if (!exactKeys(value, topKeys) || value.version !== OWNED_HANDLE_REGISTRY_VERSION
    || value.kind !== OWNED_HANDLE_REGISTRY_KIND || !validTimestamp(value.capturedAt)
    || !finiteInteger(value.activeCount) || !finiteInteger(value.unconfirmedCount)
    || !finiteInteger(value.settlingCount) || !Array.isArray(value.entries)) {
    fail("owned handle registry snapshot has an invalid top-level schema", "INVALID_REGISTRY_SNAPSHOT");
  }
  if (!exactKeys(value.admission, ["globallyFrozen", "frozenScopes"])
    || typeof value.admission.globallyFrozen !== "boolean" || !Array.isArray(value.admission.frozenScopes)
    || value.admission.frozenScopes.some(scope => typeof scope !== "string" || scope.length === 0 || scope.includes("\0"))
    || new Set(value.admission.frozenScopes).size !== value.admission.frozenScopes.length
    || JSON.stringify(value.admission.frozenScopes) !== JSON.stringify([...value.admission.frozenScopes].sort())) {
    fail("owned handle registry admission snapshot is invalid", "INVALID_REGISTRY_SNAPSHOT");
  }
  const hostBoundary = value.boundary?.hostUnifiedExec;
  if (!exactKeys(value.boundary, ["hostUnifiedExec"])
    || !exactKeys(hostBoundary, ["excluded", "observedAsOsProcess", "killAllowed", "reason"])
    || hostBoundary.excluded !== true || hostBoundary.observedAsOsProcess !== false
    || hostBoundary.killAllowed !== false
    || hostBoundary.reason !== "host-unified-exec-handles-are-not-owned-os-processes") {
    fail("owned handle registry host unified-exec boundary is invalid", "INVALID_REGISTRY_SNAPSHOT");
  }
  const entryKeys = [
    "id", "type", "state", "owner", "source", "scope", "registeredAt",
    "updatedAt", "unconfirmedReason", "process", "metadata",
  ];
  const types = new Set(["os-process", "sdk-session", "timer", "listener", "watcher", "server"]);
  const states = new Set(["active", "settling", "unconfirmed"]);
  const ids = new Set();
  for (const entry of value.entries) {
    if (!exactKeys(entry, entryKeys) || typeof entry.id !== "string" || entry.id.length === 0
      || ids.has(entry.id) || !types.has(entry.type) || !states.has(entry.state)
      || typeof entry.owner !== "string" || entry.owner.length === 0
      || typeof entry.source !== "string" || entry.source.length === 0
      || (entry.scope !== null && (typeof entry.scope !== "string" || entry.scope.length === 0))
      || !validTimestamp(entry.registeredAt) || !validTimestamp(entry.updatedAt)
      || (entry.unconfirmedReason !== null && (typeof entry.unconfirmedReason !== "string" || entry.unconfirmedReason.length === 0))
      || (entry.state === "unconfirmed") !== (entry.unconfirmedReason !== null)
      || !validJsonValue(entry.metadata) || Array.isArray(entry.metadata) || entry.metadata === null) {
      fail("owned handle registry snapshot contains an invalid entry", "INVALID_REGISTRY_SNAPSHOT");
    }
    if (entry.type === "os-process") {
      if (!exactKeys(entry.process, ["pid", "pgid", "birth"])
        || !finiteInteger(entry.process.pid, 1) || !finiteInteger(entry.process.pgid, 1)
        || typeof entry.process.birth !== "string" || entry.process.birth.length === 0) {
        fail("owned handle registry process identity is invalid", "INVALID_REGISTRY_SNAPSHOT");
      }
    } else if (entry.process !== null) {
      fail("non-process owned handle must have a null process identity", "INVALID_REGISTRY_SNAPSHOT");
    }
    ids.add(entry.id);
  }
  const count = state => value.entries.filter(entry => entry.state === state).length;
  if (value.activeCount !== count("active") || value.unconfirmedCount !== count("unconfirmed")
    || value.settlingCount !== count("settling")) {
    fail("owned handle registry counts do not match entries", "INVALID_REGISTRY_SNAPSHOT");
  }
  return value;
}

export function validateRegistryShutdownEvidence(value, expectedInvocationId) {
  if (typeof expectedInvocationId !== "string" || expectedInvocationId.length === 0
    || expectedInvocationId.includes("\0")) {
    fail("registry invocation id must be a non-empty string without NUL", "INVALID_REGISTRY_INVOCATION_ID");
  }
  if (!exactKeys(value, ["version", "kind", "invocationId", "shutdown", "registry"])
    || value.version !== OWNED_HANDLE_SHUTDOWN_EVIDENCE_VERSION
    || value.kind !== OWNED_HANDLE_SHUTDOWN_EVIDENCE_KIND
    || typeof value.invocationId !== "string" || value.invocationId.length === 0
    || value.invocationId.includes("\0")) {
    fail("owned handle shutdown evidence envelope has an invalid top-level schema", "INVALID_REGISTRY_EVIDENCE");
  }
  if (value.invocationId !== expectedInvocationId) {
    fail("owned handle shutdown evidence invocation id mismatch", "REGISTRY_INVOCATION_MISMATCH");
  }
  if (!exactKeys(value.shutdown, ["reason", "completedAt", "producerPid"])
    || value.shutdown.reason !== "quit" || !validTimestamp(value.shutdown.completedAt)
    || !Number.isSafeInteger(value.shutdown.producerPid) || value.shutdown.producerPid <= 0) {
    fail("owned handle shutdown evidence has invalid shutdown metadata", "INVALID_REGISTRY_EVIDENCE");
  }
  return { ...value, registry: validateRegistrySnapshot(value.registry) };
}

export function assertRegistrySnapshot(registrySnapshotPath, registryInvocationId) {
  const evidence = validateRegistryShutdownEvidence(readJsonNoFollow(
    path.resolve(registrySnapshotPath),
    "owned handle shutdown evidence",
  ), registryInvocationId);
  const snapshot = evidence.registry;
  if (snapshot.entries.length !== 0 || snapshot.activeCount !== 0
    || snapshot.settlingCount !== 0 || snapshot.unconfirmedCount !== 0) {
    fail(
      `owned handle registry is not clear: entries=${snapshot.entries.length} active=${snapshot.activeCount} settling=${snapshot.settlingCount} unconfirmed=${snapshot.unconfirmedCount}`,
      "OWNED_HANDLES_REMAIN",
    );
  }
  return evidence;
}

function createFixtureSampler(fixturePath) {
  if (process.env.NODE_ENV !== "test") {
    fail("--process-fixture is test-only and requires NODE_ENV=test", "FIXTURE_FORBIDDEN");
  }
  const fixture = readJsonNoFollow(path.resolve(fixturePath), "process fixture");
  if (!exactKeys(fixture, ["schemaVersion", "kind", "platform", "samples"])
    || fixture.schemaVersion !== 1 || fixture.kind !== RESOURCE_PROCESS_FIXTURE_KIND
    || !["darwin", "linux"].includes(fixture.platform) || !Array.isArray(fixture.samples)
    || fixture.samples.length === 0) {
    fail("process fixture has an invalid schema", "INVALID_PROCESS_FIXTURE");
  }
  let cursor = 0;
  return {
    platform: fixture.platform,
    source: "injected-fixture",
    sample() {
      const entry = fixture.samples[Math.min(cursor, fixture.samples.length - 1)];
      cursor += 1;
      if (!exactKeys(entry, entry?.error === undefined ? ["processes"] : ["error"])) {
        fail(`process fixture sample ${cursor} has invalid keys`, "INVALID_PROCESS_FIXTURE");
      }
      if (entry.error !== undefined) {
        if (typeof entry.error !== "string" || entry.error.length === 0) {
          fail(`process fixture sample ${cursor} has an invalid error`, "INVALID_PROCESS_FIXTURE");
        }
        fail(`OS process sampler is unavailable: ${entry.error}`, "PROCESS_SAMPLE_UNAVAILABLE");
      }
      if (!Array.isArray(entry.processes)) fail(`process fixture sample ${cursor} has no process list`, "INVALID_PROCESS_FIXTURE");
      return entry.processes.map(normalizeProcessRecord);
    },
  };
}

function createSampler(fixturePath) {
  if (fixturePath) return createFixtureSampler(fixturePath);
  return {
    platform: process.platform,
    source: PROCESS_SNAPSHOT_SOURCE,
    sample: sampleNativeProcesses,
  };
}

function processAncestry(processes, pid) {
  const byPid = new Map(processes.map(record => [record.pid, record]));
  const ancestry = new Set([pid]);
  let current = byPid.get(pid);
  while (current && current.ppid > 0 && !ancestry.has(current.ppid)) {
    ancestry.add(current.ppid);
    current = byPid.get(current.ppid);
  }
  return [...ancestry];
}

/**
 * Return every currently active OS process owned by one of the supplied roots.
 * The inspection process and its launcher ancestry are excluded because they
 * are the foreground gate itself, not residual Canvast work. This function is
 * read-only and deliberately does not inspect opaque host unified-exec handles.
 */
export function inspectActiveOwnedProcesses({
  roots = [defaultRepo], fixturePath, ignoredPids = [],
} = {}) {
  if (!Array.isArray(roots) || roots.length === 0) {
    fail("active resource inspection requires at least one root", "USAGE");
  }
  const canonicalRoots = roots.map(root => canonicalRepo(root));
  const sampler = createSampler(fixturePath);
  const allProcesses = sampler.sample();
  if (!Array.isArray(allProcesses) || allProcesses.length === 0) {
    fail("OS process sampler returned no records", "PROCESS_SAMPLE_UNAVAILABLE");
  }
  const ignored = new Set([...ignoredPids, ...processAncestry(allProcesses, process.pid)]);
  const byIdentity = new Map();
  for (const root of canonicalRoots) {
    for (const record of selectRepoOwnedProcesses(allProcesses, root, [...ignored])) {
      byIdentity.set(identityKey(record), record);
    }
  }
  return [...byIdentity.values()].sort(compareProcesses);
}

function resolveBaselineTarget(baselinePath) {
  const absolute = path.resolve(baselinePath);
  const parent = path.dirname(absolute);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const realParent = fs.realpathSync(parent);
  const target = path.join(realParent, path.basename(absolute));
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
    fail(`baseline target must not be a symbolic link: ${absolute}`, "UNSAFE_BASELINE_PATH");
  }
  return { parent: realParent, target };
}

function writeAtomicJson(baselinePath, value) {
  const { parent, target } = resolveBaselineTarget(baselinePath);
  const temporary = path.join(parent, `.${path.basename(target)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (process.env.NODE_ENV === "test" && process.env.CANVAST_RESOURCE_BASELINE_TEST_FAIL_BEFORE_RENAME === "1") {
      fail("forced interruption before resource baseline rename", "TEST_INTERRUPTION");
    }
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
      fail(`baseline target became a symbolic link: ${target}`, "UNSAFE_BASELINE_PATH");
    }
    fs.renameSync(temporary, target);
    const parentDescriptor = fs.openSync(parent, fs.constants.O_RDONLY);
    try { fs.fsyncSync(parentDescriptor); } finally { fs.closeSync(parentDescriptor); }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function baselineDocument(repo, sampler, processes) {
  return {
    schemaVersion: RESOURCE_BASELINE_SCHEMA_VERSION,
    kind: RESOURCE_BASELINE_KIND,
    capturedAt: new Date().toISOString(),
    repositoryRoot: repo,
    observation: {
      unit: "os-process",
      hostUnifiedExecHandles: "not-observed-not-process-identities",
      ownership: [...ownershipRules],
    },
    sampler: { platform: sampler.platform, source: sampler.source },
    identity: ["pid", "birth"],
    processes: [...processes].sort(compareProcesses),
  };
}

function validateBaseline(value, repo) {
  if (!exactKeys(value, [
    "schemaVersion", "kind", "capturedAt", "repositoryRoot", "observation", "sampler", "identity", "processes",
  ])) fail("baseline has non-canonical top-level keys", "INVALID_BASELINE");
  if (value.schemaVersion !== RESOURCE_BASELINE_SCHEMA_VERSION || value.kind !== RESOURCE_BASELINE_KIND) {
    fail(`unsupported resource baseline schema: ${String(value.schemaVersion)} ${String(value.kind)}`, "INVALID_BASELINE");
  }
  if (typeof value.capturedAt !== "string" || !Number.isFinite(Date.parse(value.capturedAt))) {
    fail("baseline capturedAt is invalid", "INVALID_BASELINE");
  }
  if (value.repositoryRoot !== repo) fail(`baseline repository mismatch: expected ${repo}, got ${String(value.repositoryRoot)}`, "INVALID_BASELINE");
  if (!exactKeys(value.observation, ["unit", "hostUnifiedExecHandles", "ownership"])
    || value.observation.unit !== "os-process"
    || value.observation.hostUnifiedExecHandles !== "not-observed-not-process-identities"
    || !Array.isArray(value.observation.ownership)
    || value.observation.ownership.join("\0") !== ownershipRules.join("\0")) {
    fail("baseline observation contract is invalid", "INVALID_BASELINE");
  }
  if (!exactKeys(value.sampler, ["platform", "source"]) || typeof value.sampler.platform !== "string"
    || typeof value.sampler.source !== "string") fail("baseline sampler is invalid", "INVALID_BASELINE");
  if (!Array.isArray(value.identity) || value.identity.join("\0") !== "pid\0birth") {
    fail("baseline identity must be [pid, birth]", "INVALID_BASELINE");
  }
  if (!Array.isArray(value.processes)) fail("baseline processes must be an array", "INVALID_BASELINE");
  const processes = value.processes.map(normalizeProcessRecord);
  const identities = new Set();
  for (const record of processes) {
    const key = identityKey(record);
    if (identities.has(key)) fail(`baseline contains duplicate process identity for PID ${record.pid}`, "INVALID_BASELINE");
    identities.add(key);
  }
  const sorted = [...processes].sort(compareProcesses);
  if (JSON.stringify(processes) !== JSON.stringify(sorted)) fail("baseline process records are not deterministically sorted", "INVALID_BASELINE");
  return { ...value, processes };
}

export function compareAgainstBaseline(baselineProcesses, currentOwnedProcesses) {
  const allowedIdentities = new Set(baselineProcesses.map(identityKey));
  const baselineByPid = new Map(baselineProcesses.map(record => [record.pid, record]));
  return currentOwnedProcesses
    .filter(record => !allowedIdentities.has(identityKey(record)))
    .map(record => ({
      reason: baselineByPid.has(record.pid) ? "pid_reused" : "new_process",
      baselineBirth: baselineByPid.get(record.pid)?.birth || null,
      process: record,
    }))
    .sort((left, right) => compareProcesses(left.process, right.process));
}

function sleep(milliseconds) {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function sampleLeaks(baseline, sampler, repo) {
  const allProcesses = sampler.sample();
  if (!Array.isArray(allProcesses) || allProcesses.length === 0) {
    fail("OS process sampler returned no records", "PROCESS_SAMPLE_UNAVAILABLE");
  }
  const currentOwned = selectRepoOwnedProcesses(allProcesses, repo, [process.pid]);
  return compareAgainstBaseline(baseline.processes, currentOwned);
}

export function captureBaseline({ repo = defaultRepo, baselinePath, fixturePath } = {}) {
  if (!baselinePath) fail("capture requires --baseline PATH", "USAGE");
  const canonical = canonicalRepo(repo);
  const sampler = createSampler(fixturePath);
  const allProcesses = sampler.sample();
  if (!Array.isArray(allProcesses) || allProcesses.length === 0) {
    fail("OS process sampler returned no records", "PROCESS_SAMPLE_UNAVAILABLE");
  }
  const owned = selectRepoOwnedProcesses(allProcesses, canonical, [process.pid]);
  const document = baselineDocument(canonical, sampler, owned);
  writeAtomicJson(baselinePath, document);
  return document;
}

export function assertBaseline({
  repo = defaultRepo, baselinePath, fixturePath, registrySnapshotPath, registryInvocationId,
  settleMs = 1_000, pollMs = 100,
} = {}) {
  if (!baselinePath) fail("assert requires --baseline PATH", "USAGE");
  if (Boolean(registrySnapshotPath) !== Boolean(registryInvocationId)) {
    fail("--registry-snapshot and --registry-invocation-id must be provided together", "USAGE");
  }
  if (!finiteInteger(settleMs) || settleMs > RESOURCE_BASELINE_MAX_SETTLE_MS
    || !finiteInteger(pollMs, 1) || pollMs > RESOURCE_BASELINE_MAX_POLL_MS) {
    fail(`settle-ms must be 0..${RESOURCE_BASELINE_MAX_SETTLE_MS} and poll-ms must be 1..${RESOURCE_BASELINE_MAX_POLL_MS}`, "USAGE");
  }
  const canonical = canonicalRepo(repo);
  const baseline = validateBaseline(readJsonNoFollow(path.resolve(baselinePath), "resource baseline"), canonical);
  const registrySnapshot = registrySnapshotPath
    ? assertRegistrySnapshot(registrySnapshotPath, registryInvocationId)
    : undefined;
  const sampler = createSampler(fixturePath);
  if (baseline.sampler.platform !== sampler.platform) {
    fail(`baseline sampler platform mismatch: captured ${baseline.sampler.platform}, asserting ${sampler.platform}`, "INVALID_BASELINE");
  }
  const deadline = Date.now() + settleMs;
  let previous = sampleLeaks(baseline, sampler, canonical);
  let samplesTaken = 1;
  while (Date.now() < deadline) {
    sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    previous = sampleLeaks(baseline, sampler, canonical);
    samplesTaken += 1;
  }
  sleep(pollMs);
  const current = sampleLeaks(baseline, sampler, canonical);
  samplesTaken += 1;
  const previousIdentities = new Set(previous.map(entry => identityKey(entry.process)));
  const stillLive = current.filter(entry => previousIdentities.has(identityKey(entry.process)));
  return { baseline, registrySnapshot, leaks: stillLive, samplesTaken, settleMs, pollMs };
}

function parseBoundedInteger(value, option, minimum, maximum) {
  if (!isDecimal(value || "")) fail(`${option} requires an integer >= ${minimum}`, "USAGE");
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail(`${option} requires an integer in ${minimum}..${maximum}`, "USAGE");
  }
  return parsed;
}

function parseArguments(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const command = argv[0];
  if (command !== "capture" && command !== "assert") fail("first argument must be capture or assert", "USAGE");
  const options = { command, repo: defaultRepo, settleMs: 1_000, pollMs: 100 };
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (!["--baseline", "--repo", "--process-fixture", "--registry-snapshot", "--registry-invocation-id", "--settle-ms", "--poll-ms"].includes(option)) {
      fail(`unknown option: ${option}`, "USAGE");
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${option} requires a value`, "USAGE");
    index += 1;
    if (option === "--baseline") options.baselinePath = value;
    else if (option === "--repo") options.repo = value;
    else if (option === "--process-fixture") options.fixturePath = value;
    else if (option === "--registry-snapshot") options.registrySnapshotPath = value;
    else if (option === "--registry-invocation-id") options.registryInvocationId = value;
    else if (option === "--settle-ms") {
      options.settleMs = parseBoundedInteger(value, option, 0, RESOURCE_BASELINE_MAX_SETTLE_MS);
    } else {
      options.pollMs = parseBoundedInteger(value, option, 1, RESOURCE_BASELINE_MAX_POLL_MS);
    }
  }
  if (!options.baselinePath) fail("--baseline PATH is required", "USAGE");
  if (command === "capture" && (argv.includes("--settle-ms") || argv.includes("--poll-ms"))) {
    fail("settling options are only valid for assert", "USAGE");
  }
  if (Boolean(options.registrySnapshotPath) !== Boolean(options.registryInvocationId)) {
    fail("--registry-snapshot and --registry-invocation-id must be provided together", "USAGE");
  }
  if (command === "capture" && options.registrySnapshotPath) {
    fail("registry evidence options are assert-only", "USAGE");
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/assert-resource-baseline.mjs capture --baseline PATH [--repo PATH]",
    "  node scripts/assert-resource-baseline.mjs assert --baseline PATH [--repo PATH] [--registry-snapshot PATH --registry-invocation-id ID] [--settle-ms 1000] [--poll-ms 100]",
    "",
    "The OS baseline observes processes only. Paired registry options assert exact shutdown evidence separately.",
    "Host unified-exec handles are not PIDs; host unified-exec is outside the registry and is never signalled.",
    "It never sends signals or terminates processes. --process-fixture is available only with NODE_ENV=test.",
  ].join("\n");
}

function runCli() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }
    if (options.command === "capture") {
      const baseline = captureBaseline(options);
      console.log(`Resource baseline captured: ${baseline.processes.length} repository-owned OS process(es); ${path.resolve(options.baselinePath)}`);
      return;
    }
    const result = assertBaseline(options);
    if (result.leaks.length === 0) {
      const registry = result.registrySnapshot
        ? " Owned handle registry passed: active=0 settling=0 unconfirmed=0; host unified-exec is outside the registry and was never signalled."
        : "";
      console.log(`Resource baseline passed after ${result.samplesTaken} OS process samples; no new still-live repository-owned processes.${registry}`);
      return;
    }
    console.error(`Resource baseline failed: ${result.leaks.length} new repository-owned OS process(es) remain live.`);
    for (const leak of result.leaks) {
      const record = leak.process;
      console.error(JSON.stringify({
        reason: leak.reason,
        pid: record.pid,
        ppid: record.ppid,
        pgid: record.pgid,
        birth: record.birth,
        baselineBirth: leak.baselineBirth,
        lstart: record.lstart,
        cwd: record.cwd,
        command: record.command,
      }));
    }
    process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`resource baseline check failed: ${message}`);
    if (error instanceof ResourceBaselineError && error.code === "USAGE") console.error(usage());
    process.exitCode = error instanceof ResourceBaselineError && error.code === "USAGE" ? 2 : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) runCli();
