/**
 * =============================================================================
 * Canvast — Desktop Canvas Export Handler / 桌面 Canvas 导出处理器
 * =============================================================================
 * @file        src/desktop-action/canvas-export-handler.ts
 * @brief       Safely publishes canonical five-format Canvas exports.
 * @description Executes the canonical Node exporter in a bounded staging
 *              directory and atomically publishes only verified outputs.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  captureProcessIdentity, processTreeGone, settleWithin, signalProcessGroupVerified, type ProcessStartIdentity,
} from "../utils/bounded-lifecycle.js";
import {
  getOwnedHandleRegistry, type OwnedHandleLease,
} from "../utils/owned-handle-registry.js";
import { PROCESS_SNAPSHOT_SOURCE } from "../../scripts/process-snapshot-client.mjs";
import { isSafeCanvasExportName } from "./protocol.js";
import { DesktopActionHandlerError } from "./tool-bridge.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;
const DEFAULT_KILL_CONFIRMATION_MS = 1_000;
const MAX_TERMINATION_PHASE_MS = 10_000;
const MAX_CAPTURE_BYTES = 64 * 1024;
const EXPORT_REGISTRY_SCOPE = "desktop-canvas-export";
const DEFAULT_SHUTDOWN_DRAIN_MS = 3_100;
const EXPORT_FILES = [
  { format: "json", name: "canvas-graph-export.json" },
  { format: "markdown", name: "canvas-report.md" },
  { format: "mermaid", name: "canvas-graph.mmd" },
  { format: "svg", name: "canvas-graph.svg" },
  { format: "html", name: "canvas-graph.html" },
] as const;

interface ActiveExport {
  child: ChildProcess;
  identity?: ProcessStartIdentity;
  ownedHandle?: OwnedHandleLease;
  reason?: "cancelled" | "timeout" | "output_limit";
  done: Promise<void>;
  requestTermination(reason: NonNullable<ActiveExport["reason"]>): void;
  forceFinalize(reason: string): void;
}

const activeExports = new Map<string, ActiveExport>();

export interface DesktopCanvasExportOptions {
  requestId: string;
  outputName: string;
  agentDir: string;
  projectRoot: string;
  signal?: AbortSignal;
  exporterScript?: string;
  timeoutMilliseconds?: number;
  terminationGraceMilliseconds?: number;
  killConfirmationMilliseconds?: number;
}

export function validateCanvasExportName(value: unknown): string {
  if (!isSafeCanvasExportName(value)) {
    throw new DesktopActionHandlerError(
      "invalid_arguments",
      "Canvas export outputName must be a safe basename of 1-96 letters, digits, hyphens, or underscores.",
    );
  }
  return value;
}

function regularFile(file: string, code: string, message: string): void {
  if (!existsSync(file)) throw new DesktopActionHandlerError(code, message);
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new DesktopActionHandlerError(code, message);
}

function realDirectory(directory: string, code: string, message: string): string {
  if (!existsSync(directory)) throw new DesktopActionHandlerError(code, message);
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new DesktopActionHandlerError(code, message);
  return realpathSync.native(directory);
}

function exporterPath(override?: string): string {
  return override || fileURLToPath(new URL("../../scripts/export-canvas.mjs", import.meta.url));
}

function appendBounded(current: Uint8Array, chunk: Uint8Array, job: ActiveExport): Uint8Array {
  if (current.length + chunk.length > MAX_CAPTURE_BYTES) {
    job.requestTermination("output_limit");
    return current;
  }
  const joined = new Uint8Array(current.length + chunk.length);
  joined.set(current);
  joined.set(chunk, current.length);
  return joined;
}

function describeSignalFailure(
  result: "identity_mismatch" | "unverifiable" | "failed",
): string {
  switch (result) {
  case "identity_mismatch": return "process identity changed before signalling";
  case "unverifiable": return "process identity could not be verified";
  case "failed": return "signal delivery failed";
  }
}

function runCanonicalExporter(
  options: DesktopCanvasExportOptions, input: string, staging: string, script: string,
): Promise<{ stdout: string; stderr: string }> {
  if (options.signal?.aborted) {
    throw new DesktopActionHandlerError("cancelled", "Canvas export was cancelled before it started.");
  }
  if (activeExports.has(options.requestId)) {
    throw new DesktopActionHandlerError("request_in_progress", "A Canvas export already uses this request id.");
  }
  const registry = getOwnedHandleRegistry();
  if (!registry.accepting(EXPORT_REGISTRY_SCOPE)) {
    throw new DesktopActionHandlerError(
      "export_unavailable", "Canvas export admission is frozen during shutdown.",
    );
  }
  const child = spawn(process.execPath, [
    script, "--input", input, "--out", staging,
    "--title", "Canvast Project Canvas", "--no-scan",
  ], { cwd: options.projectRoot, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  let identity: ProcessStartIdentity | undefined;
  const executionTimeout = Math.min(
    MAX_TIMEOUT_MS, Math.max(1, Math.floor(options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MS)),
  );
  const terminationGrace = Math.min(
    MAX_TERMINATION_PHASE_MS,
    Math.max(1, Math.floor(options.terminationGraceMilliseconds ?? DEFAULT_TERMINATION_GRACE_MS)),
  );
  const killConfirmation = Math.min(
    MAX_TERMINATION_PHASE_MS,
    Math.max(1, Math.floor(options.killConfirmationMilliseconds ?? DEFAULT_KILL_CONFIRMATION_MS)),
  );
  return new Promise((resolve, reject) => {
    let stdout: Uint8Array<ArrayBufferLike> = new Uint8Array();
    let stderr: Uint8Array<ArrayBufferLike> = new Uint8Array();
    let settled = false;
    let spawnConfirmed = false;
    let terminationStarted = false;
    let processGroupOwnershipVerified = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let killConfirmationTimer: ReturnType<typeof setTimeout> | undefined;
    let resolveDone!: () => void;
    const done = new Promise<void>(doneResolve => { resolveDone = doneResolve; });
    const terminationError = (cleanupFailure?: string): DesktopActionHandlerError => {
      if (cleanupFailure) {
        return new DesktopActionHandlerError(
          "export_cleanup_failed", cleanupFailure,
          { terminalCause: job.reason ?? "unknown", requestId: options.requestId },
        );
      }
      if (job.reason === "cancelled") {
        return new DesktopActionHandlerError("cancelled", "Canvas export was cancelled.");
      }
      if (job.reason === "timeout") {
        return new DesktopActionHandlerError("export_timeout", "Canvas export exceeded its bounded runtime.");
      }
      return new DesktopActionHandlerError(
        "export_failed", "Canvas exporter exceeded its diagnostic output limit.",
      );
    };
    const finish = (error?: Error, cleanupFailure?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(runtimeTimer);
      if (killTimer) clearTimeout(killTimer);
      if (killConfirmationTimer) clearTimeout(killConfirmationTimer);
      options.signal?.removeEventListener("abort", abort);
      if (activeExports.get(options.requestId) === job) activeExports.delete(options.requestId);
      if (job.ownedHandle) {
        if (cleanupFailure) job.ownedHandle.markUnconfirmed(cleanupFailure);
        else job.ownedHandle.release();
        job.ownedHandle = undefined;
      }
      resolveDone();
      if (error) reject(error);
      else resolve({ stdout: Buffer.from(stdout).toString("utf8"), stderr: Buffer.from(stderr).toString("utf8") });
    };
    const signalExporter = (signal: NodeJS.Signals, useVerifiedGroup = false) => {
      if (process.platform === "win32") return child.kill(signal) ? "sent" as const : "failed" as const;
      if (!useVerifiedGroup) return signalProcessGroupVerified(child.pid, identity, signal);
      if (!processGroupOwnershipVerified || child.pid === undefined) return "unverifiable" as const;
      try {
        process.kill(-child.pid, signal);
        return "sent" as const;
      } catch (error: any) {
        return error?.code === "ESRCH" && processTreeGone(child.pid)
          ? "gone" as const : "failed" as const;
      }
    };
    const requestTermination = (reason: NonNullable<ActiveExport["reason"]>) => {
      if (settled) return;
      job.reason ??= reason;
      if (terminationStarted) return;
      // `spawn()` assigns a PID before the OS has necessarily made its start
      // identity observable. Latch cancellation now, then signal only after
      // Node confirms the child was spawned so an immediate AbortSignal cannot
      // be misreported as an unverifiable cleanup failure.
      if (!spawnConfirmed) return;
      terminationStarted = true;
      job.ownedHandle?.markSettling();
      clearTimeout(runtimeTimer);
      const termResult = signalExporter("SIGTERM");
      processGroupOwnershipVerified = process.platform !== "win32" && termResult === "sent";
      if (termResult === "gone" || processTreeGone(child.pid)) {
        finish(terminationError());
        return;
      }
      if (termResult !== "sent") {
        const failure = `Canvas exporter SIGTERM failed: ${describeSignalFailure(termResult)}.`;
        finish(terminationError(failure), failure);
        return;
      }
      killTimer = setTimeout(() => {
        killTimer = undefined;
        if (settled) return;
        const leaderStillMatches = child.pid !== undefined && identity !== undefined &&
          captureProcessIdentity(child.pid)?.startKey === identity.startKey;
        const killResult = signalExporter("SIGKILL", !leaderStillMatches);
        if (killResult === "gone" || processTreeGone(child.pid)) {
          finish(terminationError());
          return;
        }
        if (killResult !== "sent") {
          const failure = `Canvas exporter SIGKILL failed: ${describeSignalFailure(killResult)}.`;
          finish(terminationError(failure), failure);
          return;
        }
        killConfirmationTimer = setTimeout(() => {
          killConfirmationTimer = undefined;
          if (settled) return;
          if (processTreeGone(child.pid)) {
            finish(terminationError());
            return;
          }
          const failure = `Canvas exporter did not confirm exit within ${killConfirmation}ms after SIGKILL.`;
          finish(terminationError(failure), failure);
        }, killConfirmation);
        killConfirmationTimer.unref?.();
      }, terminationGrace);
      killTimer.unref?.();
    };
    const forceFinalize = (reason: string) => {
      if (settled) return;
      job.reason ??= "cancelled";
      job.ownedHandle?.markSettling();
      const result = signalExporter("SIGKILL", processGroupOwnershipVerified);
      if (result === "gone" || processTreeGone(child.pid)) {
        finish(terminationError());
        return;
      }
      finish(terminationError(reason), reason);
    };
    const job: ActiveExport = { child, identity, done, requestTermination, forceFinalize };
    activeExports.set(options.requestId, job);
    const abort = () => requestTermination("cancelled");
    const runtimeTimer = setTimeout(() => requestTermination("timeout"), executionTimeout);
    runtimeTimer.unref?.();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.once("spawn", () => {
      spawnConfirmed = true;
      identity = captureProcessIdentity(child.pid);
      job.identity = identity;
      if (identity?.pgid && identity.birth) {
        try {
          job.ownedHandle = registry.register({
            type: "os-process", owner: "canvas-exporter", source: PROCESS_SNAPSHOT_SOURCE,
            scope: EXPORT_REGISTRY_SCOPE, pid: identity.pid, pgid: identity.pgid, birth: identity.birth,
            metadata: { requestId: options.requestId },
          });
        } catch {
          job.reason ??= "cancelled";
        }
      } else {
        job.reason ??= "cancelled";
      }
      if (job.reason) requestTermination(job.reason);
    });
    child.stdout?.on("data", (chunk: Buffer) => { stdout = appendBounded(stdout, chunk, job); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = appendBounded(stderr, chunk, job); });
    child.once("error", error => finish(job.reason
      ? terminationError()
      : new DesktopActionHandlerError(
        "export_unavailable", `Canonical Canvas exporter could not start: ${error.message}`,
      )));
    child.once("close", code => {
      if (job.reason) {
        if (processTreeGone(child.pid)) finish(terminationError());
      } else if (code !== 0) {
        finish(new DesktopActionHandlerError(
          "export_failed", "Canonical Canvas export failed.",
          { exitCode: code ?? -1, diagnostic: Buffer.from(stderr).toString("utf8").trim().slice(0, 2_000) },
        ));
      } else {
        finish();
      }
    });
  });
}

function receipt(staging: string, outputName: string, stdout: string): Record<string, unknown> {
  const actual = readdirSync(staging).sort();
  const expected = EXPORT_FILES.map(file => file.name).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new DesktopActionHandlerError("invalid_export", "Canonical Canvas export produced an unexpected file set.");
  }
  let summary: unknown;
  try { summary = JSON.parse(stdout); } catch {
    throw new DesktopActionHandlerError("invalid_export", "Canonical Canvas exporter returned an invalid receipt.");
  }
  const stats = typeof summary === "object" && summary !== null
    ? (summary as { stats?: { nodes?: unknown; edges?: unknown } }).stats : undefined;
  if (!stats || !Number.isSafeInteger(stats.nodes) || !Number.isSafeInteger(stats.edges)) {
    throw new DesktopActionHandlerError("invalid_export", "Canonical Canvas exporter omitted graph counts.");
  }
  const files = EXPORT_FILES.map(({ format, name }) => {
    const file = path.join(staging, name);
    regularFile(file, "invalid_export", `Canvas export output is not a regular file: ${name}.`);
    const bytes = readFileSync(file);
    return { format, name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  return {
    message: `Exported ${files.length} Canvas files to canvas-exports/${outputName}.`,
    receiptType: "canvas-export",
    outputDirectory: `canvas-exports/${outputName}`,
    files, nodeCount: stats.nodes as number, edgeCount: stats.edges as number,
  };
}

export async function exportCanvasForDesktop(
  options: DesktopCanvasExportOptions,
): Promise<Record<string, unknown>> {
  const outputName = validateCanvasExportName(options.outputName);
  const projectRoot = realDirectory(
    options.projectRoot, "invalid_project_root", "Canvas export requires a real project directory.",
  );
  const graphFile = path.join(options.agentDir, "canvas-graph.json");
  regularFile(graphFile, "canvas_unavailable", "The persisted Canvas graph is unavailable.");
  const script = exporterPath(options.exporterScript);
  regularFile(script, "export_unavailable", "The canonical Canvas exporter is unavailable.");
  const outputRoot = path.join(projectRoot, "canvas-exports");
  if (existsSync(outputRoot)) {
    realDirectory(outputRoot, "unsafe_output_root", "Canvas export root must be a real directory.");
  } else {
    mkdirSync(outputRoot, { mode: 0o755 });
  }
  const destination = path.join(outputRoot, outputName);
  if (existsSync(destination)) {
    throw new DesktopActionHandlerError("destination_exists", "Canvas export destination already exists.");
  }
  const staging = mkdtempSync(path.join(outputRoot, ".canvas-export-"));
  let published = false;
  try {
    const completed = await runCanonicalExporter(options, graphFile, staging, script);
    const result = receipt(staging, outputName, completed.stdout);
    if (existsSync(destination)) {
      throw new DesktopActionHandlerError("destination_exists", "Canvas export destination already exists.");
    }
    renameSync(staging, destination);
    published = true;
    return result;
  } finally {
    if (!published) rmSync(staging, { recursive: true, force: true });
  }
}

export function cancelCanvasExport(targetRequestId: string): Record<string, unknown> {
  const job = activeExports.get(targetRequestId);
  if (!job) {
    throw new DesktopActionHandlerError("not_found", "The requested Canvas export is not active.", { targetRequestId });
  }
  job.requestTermination("cancelled");
  return {
    message: "Canvas export cancellation requested.", targetRequestId, cancelled: true,
  };
}

export async function shutdownCanvasExports(
  timeoutMilliseconds = DEFAULT_SHUTDOWN_DRAIN_MS,
): Promise<{ requested: number; drained: boolean }> {
  const registry = getOwnedHandleRegistry();
  const freeze = registry.freezeAdmission(EXPORT_REGISTRY_SCOPE);
  const jobs = Array.from(activeExports.values());
  try {
    for (const job of jobs) job.requestTermination("cancelled");
    const drain = await settleWithin(
      "canvas export shutdown drain", timeoutMilliseconds,
      Promise.allSettled(jobs.map(job => job.done)),
    );
    if (!drain.ok) {
      for (const job of jobs) {
        job.forceFinalize("Canvas export cleanup was not confirmed before session shutdown.");
      }
      await Promise.allSettled(jobs.map(job => job.done));
    }
    return { requested: jobs.length, drained: drain.ok };
  } finally {
    freeze.release();
  }
}
