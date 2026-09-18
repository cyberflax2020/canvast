#!/usr/bin/env node
/**
 * =============================================================================
 * Canvast — Shared Process Snapshot Client / 共享进程快照客户端
 * =============================================================================
 * @file        scripts/process-snapshot-client.mjs
 * @brief       Strict Node client for the process-snapshot.py V1 protocol.
 * @description Gives TypeScript and Node scripts one fail-closed parser and
 *              process identity representation across ps and libproc.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROCESS_SNAPSHOT_SOURCE = "shared-process-snapshot-v1";
export const PROCESS_SNAPSHOT_HEADER = "CANVAST_PROCESS_SNAPSHOT_V1";
export const PROCESS_SNAPSHOT_FIELDS = "pid\tppid\tpgid\tstart_sec\tstart_usec\trss_bytes\tcpu_usec\tcommand";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultHelperPath = path.join(moduleDirectory, "process-snapshot.py");
const numericFields = Object.freeze([
  ["pid", 1, Number.MAX_SAFE_INTEGER],
  ["ppid", 0, Number.MAX_SAFE_INTEGER],
  ["pgid", 0, Number.MAX_SAFE_INTEGER],
  ["start_sec", 1, Number.MAX_SAFE_INTEGER],
  ["start_usec", 0, 999_999],
  ["rss_bytes", 0, Number.MAX_SAFE_INTEGER],
  ["cpu_usec", 0, Number.MAX_SAFE_INTEGER],
]);

export class ProcessSnapshotError extends Error {
  constructor(message, code = "INVALID_PROCESS_SNAPSHOT") {
    super(message);
    this.name = "ProcessSnapshotError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new ProcessSnapshotError(message, code);
}

function parseCanonicalInteger(value, field, minimum, maximum, row) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`process snapshot row ${row} has an empty ${field}`);
  }
  if (value !== "0" && value[0] === "0") {
    fail(`process snapshot row ${row} has a non-canonical ${field}`);
  }
  for (const character of value) {
    if (character < "0" || character > "9") {
      fail(`process snapshot row ${row} has a non-decimal ${field}`);
    }
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail(`process snapshot row ${row} has an out-of-range ${field}`);
  }
  return parsed;
}

export function formatProcessSnapshotBirth(startSec, startUsec) {
  if (!Number.isSafeInteger(startSec) || startSec < 1
    || !Number.isSafeInteger(startUsec) || startUsec < 0 || startUsec > 999_999) {
    fail("process snapshot birth components are invalid");
  }
  return `${startSec}.${String(startUsec).padStart(6, "0")}`;
}

export function parseProcessSnapshotV1(stdout, options = {}) {
  if (typeof stdout !== "string" || stdout.includes("\0") || stdout.includes("\r")) {
    fail("process snapshot must be NUL-free LF-delimited text");
  }
  const requestedPid = options.requestedPid;
  if (requestedPid !== undefined && (!Number.isSafeInteger(requestedPid) || requestedPid < 1)) {
    fail("requested process PID must be a positive safe integer", "INVALID_PROCESS_SNAPSHOT_REQUEST");
  }
  const body = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  const lines = body.split("\n");
  if (lines[0] !== PROCESS_SNAPSHOT_HEADER || lines[1] !== PROCESS_SNAPSHOT_FIELDS) {
    fail("process snapshot header or field contract is not exact V1");
  }
  if (lines.length < 3 || lines.some((line, index) => index >= 2 && line.length === 0)) {
    fail("process snapshot contains no records or an empty row");
  }

  const seenPids = new Set();
  const records = lines.slice(2).map((line, index) => {
    const row = index + 3;
    const fields = line.split("\t");
    if (fields.length !== 8) fail(`process snapshot row ${row} must contain exactly 8 fields`);
    const values = numericFields.map(([field, minimum, maximum], fieldIndex) =>
      parseCanonicalInteger(fields[fieldIndex], field, minimum, maximum, row));
    const [pid, ppid, pgid, startSec, startUsec, rssBytes, cpuUsec] = values;
    const command = fields[7];
    if (command.length === 0 || command.includes("\0") || command.includes("\r") || command.includes("\n")) {
      fail(`process snapshot row ${row} has an empty or invalid command`);
    }
    if (seenPids.has(pid)) fail(`process snapshot contains duplicate PID ${pid}`);
    seenPids.add(pid);
    return Object.freeze({
      pid, ppid, pgid, startSec, startUsec, rssBytes, cpuUsec,
      birth: formatProcessSnapshotBirth(startSec, startUsec),
      command,
    });
  });

  if (requestedPid !== undefined && (records.length !== 1 || records[0].pid !== requestedPid)) {
    fail(`process snapshot did not return exactly requested PID ${requestedPid}`);
  }
  return Object.freeze(records);
}

export function sampleProcessSnapshot(options = {}) {
  const requestedPid = options.pid;
  if (requestedPid !== undefined && (!Number.isSafeInteger(requestedPid) || requestedPid < 1)) {
    fail("process snapshot PID must be a positive safe integer", "INVALID_PROCESS_SNAPSHOT_REQUEST");
  }
  const helperPath = path.resolve(options.helperPath || defaultHelperPath);
  let helperStat;
  try { helperStat = fs.lstatSync(helperPath); } catch (error) {
    fail(`process snapshot helper is unavailable: ${error instanceof Error ? error.message : String(error)}`, "PROCESS_SNAPSHOT_UNAVAILABLE");
  }
  if (!helperStat.isFile() || helperStat.isSymbolicLink()) {
    fail("process snapshot helper must be a regular non-symbolic-link file", "PROCESS_SNAPSHOT_UNAVAILABLE");
  }
  const pythonBin = options.pythonBin
    || process.env.CANVAST_PROCESS_SNAPSHOT_PYTHON
    || (fs.existsSync("/usr/bin/python3") ? "/usr/bin/python3" : "python3");
  const run = options.spawnSyncImpl || spawnSync;
  const result = run(pythonBin, [helperPath, requestedPid === undefined ? "--all" : "--pid", ...(requestedPid === undefined ? [] : [String(requestedPid)])], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 10_000,
    env: { ...process.env, ...options.env, LC_ALL: "C" },
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    const detail = result.error?.message || String(result.stderr || "").trim() || `status ${String(result.status)}`;
    fail(`process snapshot helper failed: ${detail}`, "PROCESS_SNAPSHOT_UNAVAILABLE");
  }
  const records = parseProcessSnapshotV1(result.stdout, { requestedPid });
  if (requestedPid !== undefined || !Number.isSafeInteger(result.pid) || result.pid < 1) {
    return records;
  }
  return Object.freeze(records.filter(record => record.pid !== result.pid));
}
