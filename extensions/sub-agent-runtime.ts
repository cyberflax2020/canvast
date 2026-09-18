/**
 * =============================================================================
 * Canvast — Sub-Agent Runtime Helpers / 子Agent 运行时辅助
 * =============================================================================
 * @file        extensions/sub-agent-runtime.ts
 * @brief       Shared child-process lifecycle helpers for sub-agent execution
 * @description Owns the pi child spawn, bounded TERM→KILL teardown, and
 *              verified PID/start-identity signalling used by sub-agent tools.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import * as fs from "fs";
import { spawn } from "child_process";
import * as path from "path";
import {
  captureProcessIdentity,
  createTerminalCauseLatch,
  processTreeGone,
  signalProcessGroupVerified,
  type ProcessStartIdentity,
} from "../src/utils/bounded-lifecycle.js";
import {
  getOwnedHandleRegistry,
  type OwnedHandleLease,
} from "../src/utils/owned-handle-registry.js";
import { resolveProviderModelArgs } from "../src/harness/model-capabilities.js";
import { PROCESS_SNAPSHOT_SOURCE } from "../scripts/process-snapshot-client.mjs";

const OUTPUT_CAP = 50_000;
const KILL_GRACE_MS = 2_000;
const KILL_WATCHDOG_MS = 1_000;
const OWNED_PROCESS_SCOPE = "extension-sub-agent";

let childSeq = 0;

export interface RunResult {
  success: boolean;
  output: string;
  durationMs: number;
  timedOut: boolean;
  cleanupFailed?: boolean;
  outcomeUnknown?: boolean;
  terminalCause?: "timeout" | "cancelled" | "failed";
  engine?: "deterministic_local_scan" | "deterministic_local_file_write" | "pi_llm";
  evidence?: Record<string, unknown>;
  permissionEvidence?: Record<string, unknown>;
}

export interface ActiveChildRun {
  terminate: () => void;
  markDetachedUnconfirmed?: (reason: string) => void;
  done: Promise<void>;
}

export interface SubagentLifecycleHooks {
  register: (child: ReturnType<typeof spawn>, run: ActiveChildRun) => void;
  unregister: (child: ReturnType<typeof spawn>) => void;
}

export interface PiSubagentRunOptions {
  /** Restrict the child to Pi's built-in read-only tools and disable resource discovery. */
  readOnly?: boolean;
}

export function nextSubagentSequence(): number {
  childSeq += 1;
  return childSeq;
}

/** Child env: parent env minus ambient external-provider credentials. */
export function buildChildEnv(dataDir: string): NodeJS.ProcessEnv {
  const resolvedDataDir = path.resolve(dataDir);
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  env.PI_CODING_AGENT_DIR = resolvedDataDir;
  env.CANVAST_RESOURCE_STATE_DIR = path.join(resolvedDataDir, "resource-state");
  return env;
}

function resolveSubagentModelArgs(): { provider: string; model: string; thinking: string } {
  const resolved = resolveProviderModelArgs({
    provider: process.env.CANVAST_SUBAGENT_PROVIDER ||
      process.env.CANVAST_PROVIDER ||
      process.env.CANVAST_DEFAULT_PROVIDER,
    model: process.env.CANVAST_SUBAGENT_MODEL ||
      process.env.CANVAST_MODEL ||
      process.env.CANVAST_DEFAULT_MODEL ||
      "deepseek-v4-pro",
  });
  return { ...resolved, thinking: process.env.CANVAST_SUBAGENT_THINKING || resolved.thinking };
}

function normalizedTimeoutSeconds(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.min(86_400, Math.floor(value)));
}

/** Run one pi sub-agent. Never throws; always resolves with a RunResult. */
export function runPiSubagent(
  task: string,
  requestedTimeoutSeconds: number,
  lifecycle?: SubagentLifecycleHooks,
  abortSignal?: AbortSignal,
  options: PiSubagentRunOptions = {},
): Promise<RunResult> {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  return new Promise((resolve) => {
    const start = Date.now();
    const piBin = path.join(__dirname, "..", "node_modules", ".bin", "pi");
    const safeRun = path.join(__dirname, "..", "scripts", "safe-run.sh");
    const baseDir = process.env.PI_CODING_AGENT_DIR || path.join(__dirname, "..", "pi-data", "agent");
    const dataDir = path.join(baseDir, "subagents", `child-${nextSubagentSequence()}`);
    const modelArgs = resolveSubagentModelArgs();
    const timeoutSeconds = normalizedTimeoutSeconds(requestedTimeoutSeconds, 120);
    const childTimeout = Math.max(5, timeoutSeconds);
    const hasSafeRun = fs.existsSync(safeRun);
    const executable = hasSafeRun ? safeRun : piBin;
    const resourceArgs = options.readOnly
      ? [
          "--tools", "read,grep,find,ls",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "--no-context-files",
        ]
      : ["--no-context-files"];
    const piArgs = [
      "--provider", modelArgs.provider,
      "--model", modelArgs.model,
      "--thinking", modelArgs.thinking,
      "--no-session",
      ...resourceArgs,
      "-p", task,
    ];
    const args = hasSafeRun
      ? [
          "--timeout", String(childTimeout),
          "--",
          piBin,
          ...piArgs,
        ]
      : piArgs;
    const registry = getOwnedHandleRegistry();
    if (!registry.accepting(OWNED_PROCESS_SCOPE)) {
      resolveDone();
      resolve({
        success: false,
        output: "Sub-agent launch refused because process admission is frozen.",
        durationMs: Date.now() - start,
        timedOut: false,
        terminalCause: "cancelled",
        engine: "pi_llm",
      });
      return;
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, args, {
        cwd: process.cwd(),
        env: buildChildEnv(dataDir),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error: any) {
      resolveDone();
      resolve({
        success: false,
        output: `Failed to start sub-agent: ${error?.message || String(error)}`,
        durationMs: Date.now() - start,
        timedOut: false,
        engine: "pi_llm",
      });
      return;
    }

    let out = "";
    let settled = false;
    let observedExitCode: number | null | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let watchdogTimer: NodeJS.Timeout | undefined;
    let childIdentity: ProcessStartIdentity | undefined = captureProcessIdentity(child.pid);
    let ownedHandle: OwnedHandleLease | undefined;
    if (childIdentity) {
      try {
        ownedHandle = registry.register({
          type: "os-process",
          owner: "sub-agent-extension",
          source: PROCESS_SNAPSHOT_SOURCE,
          scope: OWNED_PROCESS_SCOPE,
          pid: childIdentity.pid,
          pgid: childIdentity.pgid,
          birth: childIdentity.birth,
          metadata: { sequence: childSeq },
        });
      } catch {
        // A concurrent admission freeze can win after spawn. Existing cleanup
        // remains responsible for the child that has already been created.
      }
    }
    const terminal = createTerminalCauseLatch<"timeout" | "cancelled" | "failed">();

    const append = (chunk: Buffer) => {
      const next = out + chunk.toString("utf-8");
      if (next.length <= OUTPUT_CAP) {
        out = next;
        return;
      }
      const marker = "\n...(output truncated)...\n";
      const half = Math.floor((OUTPUT_CAP - marker.length) / 2);
      out = next.slice(0, half) + marker + next.slice(-(OUTPUT_CAP - marker.length - half));
    };
    const release = () => {
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (watchdogTimer) clearTimeout(watchdogTimer);
      timeout = killTimer = watchdogTimer = undefined;
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("data", append);
      child.stderr?.removeListener("data", append);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      abortSignal?.removeEventListener("abort", onAbort);
      lifecycle?.unregister(child);
      resolveDone();
    };
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      if (ownedHandle) {
        if (result.cleanupFailed || result.outcomeUnknown) {
          ownedHandle.markUnconfirmed(result.output || "Sub-agent cleanup outcome is unknown.");
        } else {
          ownedHandle.release();
        }
        ownedHandle = undefined;
      }
      release();
      resolve(result);
    };
    const terminalResult = (fallback?: string): RunResult => {
      const state = terminal.current();
      const cause = state.cause ?? "failed";
      const defaultOutput = cause === "cancelled"
        ? "(cancelled, no output)"
        : cause === "timeout"
          ? `(no output; killed after ${timeoutSeconds}s timeout)`
          : "(terminated, no output)";
      return {
        success: false,
        output: fallback || out || defaultOutput,
        durationMs: Date.now() - start,
        timedOut: cause === "timeout",
        cleanupFailed: state.cleanupFailed || undefined,
        outcomeUnknown: state.outcomeUnknown || undefined,
        terminalCause: cause,
        engine: "pi_llm",
      };
    };
    const cleanupFailedResult = (reason: string): RunResult => {
      terminal.markCleanupFailed();
      terminal.markOutcomeUnknown();
      const message = out ? `${out}\n${reason}` : reason;
      return terminalResult(message);
    };
    const signalChild = (
      signal: NodeJS.Signals,
    ): "sent" | "gone" | "identity_mismatch" | "unverifiable" | "failed" => {
      childIdentity ??= captureProcessIdentity(child.pid);
      return signalProcessGroupVerified(child.pid, childIdentity, signal);
    };
    const watchForExit = (knownGone = false) => {
      watchdogTimer = setTimeout(() => {
        watchdogTimer = undefined;
        if (settled) return;
        if (knownGone || child.pid === undefined || processTreeGone(child.pid)) {
          finish(terminalResult());
          return;
        }
        finish(cleanupFailedResult(`SIGKILL cleanup not confirmed for PID/PGID ${child.pid ?? "unknown"}`));
      }, KILL_WATCHDOG_MS);
      watchdogTimer.unref?.();
    };
    const markDetachedUnconfirmed = (reason: string) => {
      if (!ownedHandle) return;
      if (ownedHandle.snapshot().state === "active") ownedHandle.markSettling();
      ownedHandle.markUnconfirmed(reason);
      ownedHandle = undefined;
    };
    const terminate = () => {
      if (settled || killTimer || watchdogTimer) return;
      terminal.latch("cancelled");
      if (ownedHandle?.snapshot().state === "active") ownedHandle.markSettling();
      const signalResult = signalChild("SIGTERM");
      if (signalResult === "gone" || child.pid === undefined || processTreeGone(child.pid)) {
        finish(terminalResult());
        return;
      }
      if (signalResult !== "sent") {
        finish(cleanupFailedResult(
          `SIGTERM fail-closed for PID/PGID ${child.pid ?? "unknown"}: ${describeSignalFailure(signalResult)}`,
        ));
        return;
      }
      killTimer = setTimeout(() => {
        killTimer = undefined;
        if (settled) return;
        const killResult = signalChild("SIGKILL");
        if (killResult === "gone" || child.pid === undefined || processTreeGone(child.pid)) {
          finish(terminalResult());
          return;
        }
        if (killResult !== "sent") {
          finish(cleanupFailedResult(
            `SIGKILL fail-closed for PID/PGID ${child.pid ?? "unknown"}: ${describeSignalFailure(killResult)}`,
          ));
          return;
        }
        watchForExit();
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    };
    const onError = (err: Error) => {
      terminal.latch("failed");
      if (ownedHandle?.snapshot().state === "active") ownedHandle.markSettling();
      const signalResult = signalChild("SIGKILL");
      const startFailure = terminalResult(`Failed to start sub-agent: ${err.message}`);
      if (signalResult === "gone" || child.pid === undefined || processTreeGone(child.pid)) {
        finish(startFailure);
        return;
      }
      if (signalResult !== "sent") {
        finish(cleanupFailedResult(
          `Failed to start sub-agent: ${err.message}\nSIGKILL fail-closed for PID/PGID ${child.pid ?? "unknown"}: ${describeSignalFailure(signalResult)}`,
        ));
        return;
      }
      watchForExit();
    };
    const onExit = (code: number | null) => {
      observedExitCode = code;
    };
    const onAbort = () => {
      terminal.latch("cancelled");
      terminate();
    };
    const onClose = (code: number | null) => {
      const durationMs = Date.now() - start;
      const cause = terminal.current().cause;
      if (cause) {
        finish({ ...terminalResult(), durationMs });
        return;
      }
      if ((code ?? observedExitCode) === 0) {
        finish({ success: true, output: out || "(no output)", durationMs, timedOut: false, engine: "pi_llm" });
      } else {
        terminal.latch("failed");
        finish({
          ...terminalResult(out || `(exit code ${code ?? observedExitCode ?? "unknown"}, no output)`),
          durationMs,
          timedOut: false,
        });
      }
    };

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
    lifecycle?.register(child, { terminate, markDetachedUnconfirmed, done });
    if (abortSignal?.aborted) onAbort();
    else abortSignal?.addEventListener("abort", onAbort, { once: true });

    timeout = setTimeout(() => {
      terminal.latch("timeout");
      terminate();
    }, timeoutSeconds * 1000);
    timeout.unref?.();
  });
}

function describeSignalFailure(
  result: "identity_mismatch" | "unverifiable" | "failed",
): string {
  switch (result) {
    case "identity_mismatch":
      return "process identity changed before signalling";
    case "unverifiable":
      return "process identity could not be verified";
    case "failed":
      return "signal delivery failed";
  }
}
