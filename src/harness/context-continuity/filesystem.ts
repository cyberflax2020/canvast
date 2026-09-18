/**
 * =============================================================================
 * Canvast — Context Continuity Filesystem / Canvast source file
 * =============================================================================
 * @file        src/harness/context-continuity/filesystem.ts
 * @brief       Hardened filesystem primitives for continuity state and locks.
 * @description Validates canonical state roots without symlink segments, pins
 *              file identity across no-follow opens, performs durable atomic
 *              replacement writes, and manages owner-verified file locks.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const O_DIRECTORY = fs.constants.O_DIRECTORY ?? 0;
const LOCK_OWNER_RECHECK_MS = 100;
const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));
const ACTIVE_LOCKS = new Set<string>();

export interface OwnedLockRecord {
  version: 1;
  pid: number;
  birthIdentity: string;
  token: string;
  createdAt: string;
  heartbeatAt: string;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

interface OpenPinnedFile {
  fd: number;
  identity: FileIdentity;
}

interface ProcessOwnerRecord {
  version: 1;
  pid: number;
  birthIdentity: string;
  heartbeatAt: string;
}

let cachedCurrentProcessBirthIdentity: string | undefined;

function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(SLEEP_ARRAY, 0, 0, ms);
}

function normalizeResolvedPath(value: string): string {
  let normalized = path.resolve(value);
  while (normalized.length > 1 && normalized.endsWith(path.sep)) normalized = normalized.slice(0, -1);
  return normalized;
}

function canonicalExistingDirectory(dirPath: string): string {
  return normalizeResolvedPath(fs.realpathSync.native(dirPath));
}

function isLexicallyWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function canonicalizeTrustedDirectoryPrefix(dirPath: string): string {
  const absolute = normalizeResolvedPath(dirPath);
  const lexicalTempRoot = normalizeResolvedPath(tmpdir());
  if (!isLexicallyWithin(lexicalTempRoot, absolute)) return absolute;
  const canonicalTempRoot = canonicalExistingDirectory(lexicalTempRoot);
  return normalizeResolvedPath(path.join(canonicalTempRoot, path.relative(lexicalTempRoot, absolute)));
}

function ensureDirectorySymlinkFree(dirPath: string, createMissing: boolean): string {
  const absolute = canonicalizeTrustedDirectoryPrefix(dirPath);
  const parsed = path.parse(absolute);
  let current = normalizeResolvedPath(parsed.root);
  const rootReal = normalizeResolvedPath(fs.realpathSync.native(current));
  const rootStats = fs.lstatSync(current);
  if (rootStats.isSymbolicLink()) throw new Error(`Refusing state root with symlink segment: ${current}`);
  if (!rootStats.isDirectory()) throw new Error(`Refusing non-directory state root segment: ${current}`);
  if (rootReal !== current) throw new Error(`Refusing non-canonical state root segment: ${current}`);

  const suffix = absolute.slice(parsed.root.length);
  const segments = suffix.split(path.sep).filter(Boolean);
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stats = fs.lstatSync(current);
      if (stats.isSymbolicLink()) throw new Error(`Refusing state root with symlink segment: ${current}`);
      if (!stats.isDirectory()) throw new Error(`Refusing non-directory state root segment: ${current}`);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      if (!createMissing) throw error;
      fs.mkdirSync(current);
    }
    const real = normalizeResolvedPath(fs.realpathSync.native(current));
    if (real !== current) throw new Error(`Refusing non-canonical state root segment: ${current}`);
  }
  return current;
}

function resolveProtectedStateFile(targetFile: string, createDirectory: boolean): string {
  const absolute = normalizeResolvedPath(targetFile);
  const directory = ensureDirectorySymlinkFree(path.dirname(absolute), createDirectory);
  return path.join(directory, path.basename(absolute));
}

function fileIdentity(stats: fs.Stats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function ensureRegularFile(stats: fs.Stats, targetFile: string): void {
  if (!stats.isFile()) throw new Error(`Refusing non-file state target: ${targetFile}`);
}

function assertPinnedIdentity(targetFile: string, expected: FileIdentity): void {
  const currentStats = fs.lstatSync(targetFile);
  if (currentStats.isSymbolicLink()) throw new Error(`Refusing symlink state target: ${targetFile}`);
  ensureRegularFile(currentStats, targetFile);
  if (!sameIdentity(fileIdentity(currentStats), expected)) {
    throw new Error(`Refusing state target because file identity changed during access: ${targetFile}`);
  }
}

function openPinnedExistingFile(targetFile: string): OpenPinnedFile | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(targetFile, fs.constants.O_RDONLY | O_NOFOLLOW);
    const openedStats = fs.fstatSync(fd);
    ensureRegularFile(openedStats, targetFile);
    const identity = fileIdentity(openedStats);
    assertPinnedIdentity(targetFile, identity);
    return { fd, identity };
  } catch (error: any) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Best-effort cleanup only.
      }
    }
    if (error?.code === "ENOENT") return undefined;
    if (error?.code === "ELOOP") throw new Error(`Refusing symlink state target: ${targetFile}`);
    throw error;
  }
}

function writeAllSync(fd: number, content: string): void {
  const buffer = Buffer.from(content, "utf8");
  let offset = 0;
  while (offset < buffer.length) offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
}

function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | O_DIRECTORY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function processRegistryFile(pid: number): string {
  const registryBase = canonicalExistingDirectory(tmpdir());
  const registryDir = ensureDirectorySymlinkFree(path.join(registryBase, "canvast-context-continuity-processes"), true);
  return path.join(registryDir, `${pid}.json`);
}

function parseProcessOwnerRecord(raw: string, ownerFile: string): ProcessOwnerRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as Partial<ProcessOwnerRecord>).version !== 1 ||
    !Number.isInteger((parsed as Partial<ProcessOwnerRecord>).pid) ||
    (parsed as Partial<ProcessOwnerRecord>).pid! <= 0 ||
    typeof (parsed as Partial<ProcessOwnerRecord>).birthIdentity !== "string" ||
    (parsed as Partial<ProcessOwnerRecord>).birthIdentity!.length === 0 ||
    typeof (parsed as Partial<ProcessOwnerRecord>).heartbeatAt !== "string" ||
    (parsed as Partial<ProcessOwnerRecord>).heartbeatAt!.length === 0
  ) {
    throw new Error(`Serialized state process owner record is invalid: ${ownerFile}`);
  }
  return parsed as ProcessOwnerRecord;
}

function readProcessOwnerRecord(pid: number): ProcessOwnerRecord | undefined {
  const ownerFile = processRegistryFile(pid);
  const raw = readProtectedTextFile(ownerFile);
  if (raw === undefined) return undefined;
  return parseProcessOwnerRecord(raw, ownerFile);
}

function writeCurrentProcessOwnerHeartbeat(birthIdentity: string, heartbeatAt = new Date().toISOString()): void {
  writeProtectedTextFileAtomic(processRegistryFile(process.pid), JSON.stringify({
    version: 1,
    pid: process.pid,
    birthIdentity,
    heartbeatAt,
  }));
}

function currentProcessBirthIdentity(): string {
  if (!cachedCurrentProcessBirthIdentity) cachedCurrentProcessBirthIdentity = randomUUID();
  writeCurrentProcessOwnerHeartbeat(cachedCurrentProcessBirthIdentity);
  return cachedCurrentProcessBirthIdentity;
}

function ownedLockSnapshot(owner: Omit<OwnedLockRecord, "heartbeatAt">, heartbeatAt = new Date().toISOString()): OwnedLockRecord {
  return { ...owner, heartbeatAt };
}

export function currentLockOwnerIdentity(): { pid: number; birthIdentity: string } {
  const birthIdentity = currentProcessBirthIdentity();
  return { pid: process.pid, birthIdentity };
}

function parseOwnedLockRecord(raw: string, lockFile: string): OwnedLockRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Serialized state lock is unreadable JSON: ${lockFile}`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as Partial<OwnedLockRecord>).version !== 1 ||
    !Number.isInteger((parsed as Partial<OwnedLockRecord>).pid) ||
    (parsed as Partial<OwnedLockRecord>).pid! <= 0 ||
    typeof (parsed as Partial<OwnedLockRecord>).birthIdentity !== "string" ||
    (parsed as Partial<OwnedLockRecord>).birthIdentity!.length === 0 ||
    typeof (parsed as Partial<OwnedLockRecord>).token !== "string" ||
    (parsed as Partial<OwnedLockRecord>).token!.length === 0 ||
    typeof (parsed as Partial<OwnedLockRecord>).createdAt !== "string" ||
    (parsed as Partial<OwnedLockRecord>).createdAt!.length === 0
  ) {
    throw new Error(`Serialized state lock is missing an owner identity: ${lockFile}`);
  }
  const heartbeatAt = typeof (parsed as Partial<OwnedLockRecord>).heartbeatAt === "string" &&
    (parsed as Partial<OwnedLockRecord>).heartbeatAt!.length > 0
    ? (parsed as Partial<OwnedLockRecord>).heartbeatAt!
    : (parsed as Partial<OwnedLockRecord>).createdAt!;
  return { ...(parsed as Omit<OwnedLockRecord, "heartbeatAt">), heartbeatAt };
}

function readOwnedLockRecord(lockFile: string): OwnedLockRecord | undefined {
  const raw = readProtectedTextFile(lockFile);
  return raw === undefined ? undefined : parseOwnedLockRecord(raw, lockFile);
}

function ownedLockStatus(record: OwnedLockRecord): "alive" | "dead" | "unknown" {
  try {
    process.kill(record.pid, 0);
  } catch (error: any) {
    if (error?.code === "ESRCH") return "dead";
    if (error?.code !== "EPERM") return "unknown";
  }
  const observedOwner = readProcessOwnerRecord(record.pid);
  if (!observedOwner) return "unknown";
  return observedOwner.birthIdentity === record.birthIdentity ? "alive" : "dead";
}

function createOwnedLock(lockFile: string, owner: OwnedLockRecord): void {
  let fd: number | undefined;
  let created = false;
  try {
    fd = fs.openSync(lockFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | O_NOFOLLOW, 0o600);
    created = true;
    writeAllSync(fd, JSON.stringify(owner));
    fs.fsyncSync(fd);
  } catch (error: any) {
    if (error?.code === "EEXIST") throw error;
    if (error?.code === "ELOOP") throw new Error(`Refusing symlink serialized state lock: ${lockFile}`);
    throw error;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Best-effort cleanup only.
      }
    }
    if (!created) return;
    try {
      syncDirectory(path.dirname(lockFile));
    } catch (error) {
      try {
        fs.unlinkSync(lockFile);
      } catch {
        // Best-effort cleanup only.
      }
      throw error;
    }
  }
}

function refreshOwnedLockHeartbeat(lockFile: string, owner: OwnedLockRecord): void {
  const current = readOwnedLockRecord(lockFile);
  if (!current) return;
  if (current.pid !== owner.pid) return;
  if (current.birthIdentity !== owner.birthIdentity) return;
  if (current.token !== owner.token) return;
  const heartbeatAt = new Date().toISOString();
  writeCurrentProcessOwnerHeartbeat(owner.birthIdentity, heartbeatAt);
  writeProtectedTextFileAtomic(lockFile, JSON.stringify(ownedLockSnapshot(owner, heartbeatAt)));
}

function releaseOwnedLock(lockFile: string, owner: OwnedLockRecord): void {
  try {
    const current = readOwnedLockRecord(lockFile);
    if (!current) return;
    if (current.pid !== owner.pid) return;
    if (current.birthIdentity !== owner.birthIdentity) return;
    if (current.token !== owner.token) return;
    fs.unlinkSync(lockFile);
    syncDirectory(path.dirname(lockFile));
  } catch {
    // Best-effort cleanup only.
  }
}

function reclaimDeadOwnedLock(lockFile: string): boolean {
  const observed = readOwnedLockRecord(lockFile);
  if (!observed) return false;
  if (ownedLockStatus(observed) !== "dead") return false;
  const confirmed = readOwnedLockRecord(lockFile);
  if (!confirmed) return false;
  if (confirmed.pid !== observed.pid) return false;
  if (confirmed.birthIdentity !== observed.birthIdentity) return false;
  if (confirmed.token !== observed.token) return false;
  fs.unlinkSync(lockFile);
  syncDirectory(path.dirname(lockFile));
  return true;
}

export function readProtectedTextFile(targetFile: string): string | undefined {
  let protectedTarget: string;
  try {
    protectedTarget = resolveProtectedStateFile(targetFile, false);
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  const opened = openPinnedExistingFile(protectedTarget);
  if (!opened) return undefined;
  try {
    return fs.readFileSync(opened.fd, "utf8");
  } finally {
    fs.closeSync(opened.fd);
  }
}

export function writeProtectedTextFileAtomic(targetFile: string, content: string): void {
  const protectedTarget = resolveProtectedStateFile(targetFile, true);
  const protectedDirectory = path.dirname(protectedTarget);
  const existing = openPinnedExistingFile(protectedTarget);
  const temporary = path.join(
    protectedDirectory,
    `.${path.basename(protectedTarget)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  let tempFd: number | undefined;
  try {
    tempFd = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | O_NOFOLLOW,
      0o600,
    );
    writeAllSync(tempFd, content);
    fs.fsyncSync(tempFd);
    fs.closeSync(tempFd);
    tempFd = undefined;
    if (existing) assertPinnedIdentity(protectedTarget, existing.identity);
    fs.renameSync(temporary, protectedTarget);
    syncDirectory(protectedDirectory);
  } catch (error) {
    if (tempFd !== undefined) {
      try {
        fs.closeSync(tempFd);
      } catch {
        // Best-effort cleanup only.
      }
    }
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Best-effort cleanup only.
    }
    throw error;
  } finally {
    if (existing) {
      try {
        fs.closeSync(existing.fd);
      } catch {
        // Best-effort cleanup only.
      }
    }
  }
}

export function withOwnedFileLock<T>(
  targetFile: string,
  input: { timeoutMs: number; retryMs: number },
  work: () => T,
): T {
  const protectedTarget = resolveProtectedStateFile(targetFile, true);
  const lockFile = `${protectedTarget}.lock`;
  if (ACTIVE_LOCKS.has(lockFile)) throw new Error(`Serialized state lock already held by this process: ${lockFile}`);
  const owner: OwnedLockRecord = {
    version: 1,
    pid: process.pid,
    birthIdentity: currentProcessBirthIdentity(),
    token: randomUUID(),
    createdAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  };
  const deadline = Date.now() + input.timeoutMs;
  let nextOwnerCheckAt = 0;
  while (true) {
    try {
      createOwnedLock(lockFile, owner);
      break;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const now = Date.now();
      if (now >= nextOwnerCheckAt) {
        if (reclaimDeadOwnedLock(lockFile)) {
          nextOwnerCheckAt = 0;
          continue;
        }
        nextOwnerCheckAt = now + LOCK_OWNER_RECHECK_MS;
      }
      if (now >= deadline) throw new Error(`Timed out waiting for serialized state lock: ${lockFile}`);
      sleepSync(input.retryMs);
    }
  }
  try {
    ACTIVE_LOCKS.add(lockFile);
    refreshOwnedLockHeartbeat(lockFile, owner);
    return work();
  } finally {
    ACTIVE_LOCKS.delete(lockFile);
    releaseOwnedLock(lockFile, owner);
  }
}
