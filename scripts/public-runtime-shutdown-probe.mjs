#!/usr/bin/env node
/**
 * =============================================================================
 * Canvast — Public Runtime Shutdown Probe / Canvast 源文件
 * =============================================================================
 * @file        scripts/public-runtime-shutdown-probe.mjs
 * @brief       Proves the shipped public launcher quits with no owned handles.
 * @description Runs one prompt-free, offline, isolated public runtime and
 *              validates its invocation-bound shutdown evidence fail-closed.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assertRegistrySnapshot } from "./assert-resource-baseline.mjs";

const PROBE_TIMEOUT_MS = 120_000;
const PROBE_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const DUMMY_DEEPSEEK_API_KEY = "dummy";

function failure(message) {
  throw new Error(`public runtime owned-handle shutdown probe failed: ${message}`);
}

function regularExecutable(file) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    failure(`launcher is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) failure("launcher must be a regular non-symbolic-link file");
  if ((stat.mode & 0o111) === 0) failure("launcher must be executable");
}

function isolatedEnvironment(temporaryRoot, inherited = process.env) {
  const environment = {};
  for (const name of [
    "PATH", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ",
    "SystemRoot", "COMSPEC", "PATHEXT", "WINDIR",
    // Fixture-only observability. The real launcher does not consume these.
    "PUBLIC_RUNTIME_PROBE_LOG", "PUBLIC_RUNTIME_PROBE_EVIDENCE_MODE",
  ]) {
    if (inherited[name] !== undefined) environment[name] = inherited[name];
  }

  const home = path.join(temporaryRoot, "home");
  const canvastHome = path.join(temporaryRoot, "canvast-home");
  const canvastTmp = path.join(temporaryRoot, "canvast-tmp");
  const agentDir = path.join(temporaryRoot, "pi-coding-agent");
  const workspace = path.join(temporaryRoot, "workspace");
  for (const directory of [home, canvastHome, canvastTmp, agentDir, workspace]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  return {
    ...environment,
    HOME: home,
    TMPDIR: canvastTmp,
    CANVAST_HOME: canvastHome,
    CANVAST_TMPDIR: canvastTmp,
    CANVAST_AGENT_DIR: agentDir,
    PI_CODING_AGENT_DIR: agentDir,
    CANVAST_PROJECT_ROOT: workspace,
    CANVAST_WORKING_DIR: workspace,
    CANVAST_LIVE_SECRET_FILE: path.join(temporaryRoot, "no-live-secrets.env"),
    PI_OFFLINE: "1",
    DEEPSEEK_API_KEY: DUMMY_DEEPSEEK_API_KEY,
  };
}

function runtimeFailureDetail(result) {
  if (result.error) return result.error.message;
  const termination = result.signal ? `signal ${result.signal}` : `status ${String(result.status)}`;
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  return output ? `${termination}:\n${output}` : termination;
}

/**
 * Run the public launcher itself in prompt-free print mode and require exact,
 * invocation-bound evidence that its quit-time owned-handle registry is empty.
 */
export function runPublicRuntimeShutdownProbe(publicRoot) {
  let canonicalRoot;
  try { canonicalRoot = fs.realpathSync(path.resolve(publicRoot)); }
  catch (error) {
    failure(`public root is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const launcher = path.join(canonicalRoot, "canvast.sh");
  regularExecutable(launcher);

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "canvast-public-runtime-shutdown-"));
  try {
    const invocationId = `public-runtime-shutdown-${randomBytes(24).toString("hex")}`;
    const evidencePath = path.join(temporaryRoot, "shutdown-evidence.json");
    if (!path.isAbsolute(evidencePath)) failure("owned-handle evidence path must be absolute");
    const environment = isolatedEnvironment(temporaryRoot);
    const result = spawnSync(launcher, [
      "--canvast-owned-handle-snapshot", evidencePath,
      "--canvast-owned-handle-invocation-id", invocationId,
      "--no-session",
      "-p",
    ], {
      cwd: environment.CANVAST_WORKING_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: environment,
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: PROBE_MAX_BUFFER_BYTES,
    });
    if (result.status !== 0 || result.error) failure(`launcher did not quit cleanly (${runtimeFailureDetail(result)})`);
    try {
      return assertRegistrySnapshot(evidencePath, invocationId);
    } catch (error) {
      failure(error instanceof Error ? error.message : String(error));
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
