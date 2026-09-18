/**
 * =============================================================================
 * Canvast — Safe JSON File / 安全 JSON 文件
 * =============================================================================
 * @file        src/harness/safe-json-file.ts
 * @brief       Crash-safe and symlink-safe JSON persistence primitives.
 * @description Serializes writers with an interprocess directory lock and
 *              publishes fsynced JSON through an atomic rename.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

export type SafeJsonRead<T> =
  | { status: "missing" }
  | { status: "ok"; value: T; source: "primary" | "last-known-good" }
  | { status: "corrupt"; error: string; quarantinedPath?: string };

function uniqueSuffix(): string {
  return `${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`;
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readNoFollow(file: string): string {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()) throw new Error("JSON state is not a regular file");
    const content = fs.readFileSync(descriptor, "utf-8");
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error("JSON state identity changed while reading");
    }
    return content;
  } finally {
    fs.closeSync(descriptor);
  }
}

function quarantineCorrupt(file: string): string | undefined {
  const quarantined = `${file}.corrupt-${uniqueSuffix()}`;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    fs.renameSync(file, quarantined);
    fsyncDirectory(path.dirname(file));
    return quarantined;
  } catch {
    return undefined;
  }
}

export function readSafeJson<T>(file: string, useLastKnownGood = false): SafeJsonRead<T> {
  try {
    const state = fs.lstatSync(file);
    if (!state.isFile() || state.isSymbolicLink()) {
      return { status: "corrupt", error: "JSON state must be a regular non-symlink file" };
    }
  } catch (error) {
    const code = isErrnoException(error) ? error.code : undefined;
    if (code === "ENOENT") return { status: "missing" };
    return { status: "corrupt", error: error instanceof Error ? error.message : String(error) };
  }
  try {
    return { status: "ok", value: JSON.parse(readNoFollow(file)) as T, source: "primary" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const quarantinedPath = quarantineCorrupt(file);
    const backup = `${file}.lkg`;
    if (useLastKnownGood && fs.existsSync(backup)) {
      try {
        return { status: "ok", value: JSON.parse(readNoFollow(backup)) as T, source: "last-known-good" };
      } catch {
        // Preserve the primary failure as the health signal.
      }
    }
    return { status: "corrupt", error: message, quarantinedPath };
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function atomicReplace(file: string, content: string, mode = 0o600): void {
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.${path.basename(file)}.${uniqueSuffix()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      mode,
    );
    fs.fchmodSync(descriptor, mode);
    fs.writeFileSync(descriptor, content, "utf-8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
    fsyncDirectory(directory);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch { /* already published or absent */ }
  }
}

export function writeSafeJson(
  file: string,
  value: unknown,
  keepLastKnownGood = false,
  mode = 0o600,
): void {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const lock = `${file}.lock`;
  try {
    fs.mkdirSync(lock);
  } catch {
    throw new Error(`Persistence lock is held or requires recovery: ${lock}`);
  }
  try {
    const content = `${JSON.stringify(value, null, 2)}\n`;
    let previousContent: string | undefined;
    if (keepLastKnownGood) {
      try { previousContent = readNoFollow(file); } catch { /* first write or unhealthy primary */ }
      if (previousContent !== undefined) atomicReplace(`${file}.lkg`, previousContent, mode);
      else atomicReplace(`${file}.lkg`, content, mode);
    }
    atomicReplace(file, content, mode);
  } finally {
    fs.rmdirSync(lock);
    fsyncDirectory(directory);
  }
}
