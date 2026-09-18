/**
 * =============================================================================
 * Canvast — Background Task Management / 后台任务管理
 * =============================================================================
 * @file        extensions/background-task.ts
 * @brief       Run shell commands in background with status tracking
 * @description Ported from Tallow/background-task-tool (MIT, 2020 lines).
 *              Provides bg_bash, task_status, task_output tools.
 *              从 Tallow 后台任务 (MIT) 移植。
 *
 *              Resource-safety hardening (2026-08-15):
 *              - MAX_BG_RUNNING concurrent tasks cap (default 4): unbounded
 *                background fan-out is how dev machines get saturated.
 *              - Per-stream output cap with head+tail retention (512 KiB):
 *                a runaway command can no longer grow host memory without bound.
 *              - Timeout kills the whole PROCESS GROUP (detached spawn,
 *                SIGTERM → 2s grace → SIGKILL), so grandchildren cannot survive
 *                the timeout and keep burning CPU.
 *              - Ambient provider credentials from other clients are scrubbed
 *                from the child env so the configured Canvast provider remains
 *                authoritative.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * Changes: [2026-08-08] Initial — from Tallow/background-task-tool (MIT)
 *          [2026-08-15] Resource hardening: concurrency cap, output cap,
 *                       process-group kill ladder, env scrub
 * =============================================================================
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn, type ChildProcess } from "child_process";
import {
  captureProcessIdentity,
  processTreeGone,
  signalProcessGroupVerified,
  type ProcessStartIdentity,
} from "../src/utils/bounded-lifecycle.js";
import {
  getOwnedHandleRegistry,
  type OwnedHandleLease,
} from "../src/utils/owned-handle-registry.js";
import {
  createSandboxController,
  type SandboxDecision,
  type SandboxGrantScope,
} from "../src/harness/sandbox.js";
import { PROCESS_SNAPSHOT_SOURCE } from "../scripts/process-snapshot-client.mjs";

const MAX_BG_RUNNING = 4;
const STREAM_CAP = 512 * 1024;   // bytes kept per stream (head + tail)
const HEAD_KEEP = 128 * 1024;    // head bytes retained when capping
const TAIL_KEEP = 128 * 1024;    // tail bytes retained when capping
const KILL_GRACE_MS = 2_000;
const KILL_WATCHDOG_MS = 1_000;
const SESSION_SHUTDOWN_DEADLINE_MS = KILL_GRACE_MS + KILL_WATCHDOG_MS;
const MAX_HISTORY = 32;
const OWNED_PROCESS_SCOPE = "extension-background-task";

type BgTerminalCause = "failed" | "timeout" | "cancelled";

interface BgTask {
  id: string;
  command: string;
  status: "running" | "completed" | "failed" | "timeout" | "cancelled";
  terminalCause?: BgTerminalCause;
  requestedTerminalStatus?: BgTerminalCause;
  cleanupFailed: boolean;
  outcomeUnknown: boolean;
  cleanupFailure?: string;
  startTime: string;
  endTime?: string;
  stdout: string;
  stderr: string;
  stdoutDropped: number; // chars discarded between head and tail
  stderrDropped: number;
  exitCode?: number;
  process?: ChildProcess;
  processIdentity?: ProcessStartIdentity;
  ownedHandle?: OwnedHandleLease;
  settled: boolean;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  killTimer?: ReturnType<typeof setTimeout>;
  watchdogTimer?: ReturnType<typeof setTimeout>;
  completion: Promise<void>;
  resolveCompletion: () => void;
  terminate?: () => void;
  finishLocalTerminal?: (status: BgTask["status"], code?: number) => void;
}

/**
 * Head+tail capped buffer: keeps the first HEAD_KEEP and the last TAIL_KEEP
 * bytes once the stream exceeds STREAM_CAP, discarding (and counting) the
 * middle. Ensures "command start + most recent output" stays visible without
 * unbounded growth (pattern: Codex HeadTailBuffer).
 */
function cappedAppend(current: string, chunk: string, dropped: number): { value: string; dropped: number } {
  const value = current + chunk;
  if (dropped === 0 && value.length <= STREAM_CAP) return { value, dropped };
  if (dropped === 0) {
    // First overflow: split into head + tail
    const head = value.slice(0, HEAD_KEEP);
    const tail = value.slice(value.length - TAIL_KEEP);
    dropped = value.length - HEAD_KEEP - TAIL_KEEP;
    return { value: head + tail, dropped };
  }
  // Already capped: keep head fixed, roll the tail window
  const head = current.slice(0, HEAD_KEEP);
  const tailPart = current.slice(HEAD_KEEP) + chunk;
  const newTail = tailPart.slice(-TAIL_KEEP);
  dropped += Math.max(0, tailPart.length - newTail.length);
  return { value: head + newTail, dropped };
}

function buildChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  return env;
}

function normalizedTimeoutSeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 300;
  return Math.max(1, Math.min(86_400, Math.floor(value)));
}

function sandboxDecisionSummary(decision: SandboxDecision): string {
  return [
    decision.reason,
    decision.categories.length ? `Categories: ${decision.categories.join(", ")}` : "",
    decision.missingGrants.length
      ? `Required grants: ${decision.missingGrants.map(grant => `${grant.kind}:${grant.value}`).join(", ")}`
      : "",
  ].filter(Boolean).join("\n");
}

function grantScope(choice: string | undefined): SandboxGrantScope | undefined {
  if (choice === "Allow once") return "once";
  if (choice === "Allow for session") return "session";
  if (choice === "Allow for project") return "project";
  return undefined;
}

export default function (pi: ExtensionAPI) {
  const tasks = new Map<string, BgTask>();
  const sandbox = createSandboxController();
  let taskCounter = 0;
  let shuttingDown = false;
  let pendingLaunches = 0;

  const runningCount = () => Array.from(tasks.values())
    .filter(t => !t.settled).length;

  function signalTask(
    proc: ChildProcess,
    identity: ProcessStartIdentity | undefined,
    signal: NodeJS.Signals,
  ): "sent" | "gone" | "identity_mismatch" | "unverifiable" | "failed" {
    return signalProcessGroupVerified(proc.pid, identity, signal);
  }

  function pruneHistory(): void {
    if (tasks.size <= MAX_HISTORY) return;
    for (const [id, task] of tasks) {
      if (tasks.size <= MAX_HISTORY) break;
      if (task.settled) tasks.delete(id);
    }
  }

  function markCleanupFailed(task: BgTask, proc: ChildProcess, reason: string): void {
    if (task.settled) return;
    if (!task.cleanupFailure) {
      task.cleanupFailure = reason;
      const appended = cappedAppend(task.stderr, reason, task.stderrDropped);
      task.stderr = appended.value;
      task.stderrDropped = appended.dropped;
    }
    task.cleanupFailed = true;
    task.outcomeUnknown = true;
    task.finishLocalTerminal?.(resolveTerminalStatus(task, "failed"));
  }

  function registerOwnedTask(task: BgTask, identity: ProcessStartIdentity | undefined): void {
    if (!identity || task.ownedHandle) return;
    try {
      task.ownedHandle = getOwnedHandleRegistry().register({
        type: "os-process",
        owner: "background-task-extension",
        source: PROCESS_SNAPSHOT_SOURCE,
        scope: OWNED_PROCESS_SCOPE,
        pid: identity.pid,
        pgid: identity.pgid,
        birth: identity.birth,
        metadata: { taskId: task.id },
      });
    } catch {
      // A concurrent admission freeze can win after the pre-spawn check. The
      // existing task lifecycle still owns and drains the already-created child.
    }
  }

  function markOwnedTaskSettling(task: BgTask): void {
    if (task.ownedHandle?.snapshot().state === "active") task.ownedHandle.markSettling();
  }

  function settleOwnedTask(task: BgTask): void {
    const lease = task.ownedHandle;
    if (!lease) return;
    task.ownedHandle = undefined;
    if (task.cleanupFailed || task.outcomeUnknown) {
      lease.markUnconfirmed(task.cleanupFailure || `Cleanup outcome unknown for background task ${task.id}.`);
      return;
    }
    lease.release();
  }

  function watchForTaskExit(task: BgTask, proc: ChildProcess, knownGone = false): void {
    task.watchdogTimer = setTimeout(() => {
      task.watchdogTimer = undefined;
      if (task.settled) return;
      if (knownGone || proc.pid === undefined || processTreeGone(proc.pid)) {
        task.outcomeUnknown = false;
        task.terminate?.();
        return;
      }
      markCleanupFailed(task, proc, `SIGKILL cleanup not confirmed for PID/PGID ${proc.pid}`);
    }, KILL_WATCHDOG_MS);
    task.watchdogTimer.unref?.();
  }

  /** Kill the task's whole process group: SIGTERM → grace → SIGKILL. */
  function killTask(task: BgTask): void {
    const proc = task.process;
    if (!proc || task.settled) return;
    if (task.killTimer || task.watchdogTimer) return;
    markOwnedTaskSettling(task);
    const identity = task.processIdentity ?? captureProcessIdentity(proc.pid);
    const signalResult = signalTask(proc, identity, "SIGTERM");
    if (signalResult === "gone" || proc.pid === undefined || processTreeGone(proc.pid)) {
      task.outcomeUnknown = false;
      task.terminate?.();
      return;
    }
    if (signalResult !== "sent") {
      markCleanupFailed(
        task,
        proc,
        `SIGTERM fail-closed for PID/PGID ${proc.pid ?? "unknown"}: ${describeSignalFailure(signalResult)}`,
      );
      return;
    }
    task.killTimer = setTimeout(() => {
      task.killTimer = undefined;
      if (task.settled) return;
      const result = signalTask(proc, identity, "SIGKILL");
      if (result !== "sent" && result !== "gone") {
        markCleanupFailed(
          task,
          proc,
          `SIGKILL fail-closed for PID/PGID ${proc.pid ?? "unknown"}: ${describeSignalFailure(result)}`,
        );
        return;
      }
      if (result === "gone") task.outcomeUnknown = false;
      watchForTaskExit(task, proc, result === "gone");
    }, KILL_GRACE_MS);
    task.killTimer.unref?.();
  }

  function latchTerminalCause(task: BgTask, cause: BgTerminalCause): BgTerminalCause {
    if (!task.terminalCause) task.terminalCause = cause;
    if (!task.requestedTerminalStatus) task.requestedTerminalStatus = cause;
    return task.terminalCause;
  }

  function resolveTerminalStatus(
    task: BgTask,
    fallback: BgTerminalCause,
  ): Extract<BgTask["status"], "failed" | "timeout" | "cancelled"> {
    return task.terminalCause ?? task.requestedTerminalStatus ?? fallback;
  }

  function forceShutdownFinalize(task: BgTask, reason: string): void {
    if (task.settled) return;
    if (!task.cleanupFailure) {
      task.cleanupFailure = reason;
      const appended = cappedAppend(task.stderr, reason, task.stderrDropped);
      task.stderr = appended.value;
      task.stderrDropped = appended.dropped;
    }
    task.cleanupFailed = true;
    task.outcomeUnknown = true;
    task.finishLocalTerminal?.(resolveTerminalStatus(task, "cancelled"));
  }

  async function waitForShutdownDrain(active: BgTask[]): Promise<boolean> {
    if (active.length === 0) return false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(active.map(task => task.completion)),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, SESSION_SHUTDOWN_DEADLINE_MS);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    return timedOut;
  }

  // ─── bg_bash ──────────────────────────────────────
  pi.registerTool({
    name: "bg_bash",
    label: "Background Bash / 后台命令",
    description: `Run a shell command in the background. Returns a task ID immediately.
Use task_status to check progress and task_output to get results.
Limits: at most ${MAX_BG_RUNNING} concurrently RUNNING tasks; per-stream output capped at ${STREAM_CAP / 1024} KiB (head+tail kept);
timeout kills the entire process group. Ambient external-provider credentials are not inherited.`,
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to run / 要执行的命令" }),
      timeout_seconds: Type.Optional(Type.Number({ description: "Timeout / 超时(秒)", default: 300 })),
    }),
    async execute(_id: string, params: any, signal?: AbortSignal, _onUpdate?: unknown, ctx?: any): Promise<any> {
      const { command } = params;
      const timeoutSeconds = normalizedTimeoutSeconds(params.timeout_seconds);
      const cwd = ctx?.cwd || process.cwd();

      if (shuttingDown || signal?.aborted) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: shuttingDown
            ? "Background task launch refused because the session is shutting down."
            : "Background task launch cancelled before spawn." }],
          details: undefined,
        };
      }
      if (runningCount() + pendingLaunches >= MAX_BG_RUNNING) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Background task limit reached (${MAX_BG_RUNNING} running). Wait for tasks to finish or check them with task_status.` }],
          details: undefined,
        };
      }
      pendingLaunches++;

      try {
      let decision = sandbox.decideBash(command, cwd);
      if (decision.action === "block") {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Canvast sandbox blocked background command.\n${sandboxDecisionSummary(decision)}` }],
          details: { decision },
        };
      }
      if (decision.action === "confirm") {
        let scope: SandboxGrantScope | undefined;
        if (sandbox.permissionMode() === "auto") {
          const resolution = sandbox.resolveAutoDecision(decision);
          if (resolution.action === "block" || !resolution.scope) {
            return {
              isError: true,
              content: [{ type: "text" as const, text: `Canvast sandbox permission blocked background command.\n${resolution.reason}\n${sandboxDecisionSummary(decision)}` }],
              details: { decision },
            };
          }
          scope = resolution.scope;
        } else if (!sandbox.isUnattended() && ctx?.hasUI) {
          const choice = await ctx.ui.select(
            `Sandbox permission\n\n${sandboxDecisionSummary(decision)}`,
            ["Deny", "Allow once", "Allow for session", "Allow for project"],
            { timeout: 30_000 },
          );
          scope = grantScope(choice);
        }
        if (shuttingDown || signal?.aborted) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: shuttingDown
              ? "Background task launch refused because the session is shutting down."
              : "Background task launch cancelled during permission approval." }],
            details: { decision },
          };
        }
        if (!scope) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `Canvast sandbox permission required for background command.\n${sandboxDecisionSummary(decision)}` }],
            details: { decision },
          };
        }
        sandbox.rememberApproval(decision, scope, "Approved for background command.");
        decision = sandbox.decideBash(command, cwd);
      }

      let sandboxedCommand: string;
      try {
        sandboxedCommand = sandbox.buildSandboxedCommand(command, cwd).command;
      } catch (error: any) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Canvast sandbox blocked background command: ${error?.message || String(error)}` }],
          details: { decision },
        };
      }
      if (!getOwnedHandleRegistry().accepting(OWNED_PROCESS_SCOPE)) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: "Background task launch refused because process admission is frozen." }],
          details: undefined,
        };
      }

      taskCounter++;
      const taskId = `bg_${taskCounter}`;
      const now = new Date().toISOString();

      let resolveCompletion!: () => void;
      const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
      const task: BgTask = {
        id: taskId, command, status: "running", startTime: now,
        stdout: "", stderr: "", stdoutDropped: 0, stderrDropped: 0,
        cleanupFailed: false,
        outcomeUnknown: false,
        settled: false, completion, resolveCompletion,
      };
      tasks.set(taskId, task);

      try {
        const proc = spawn("bash", ["-c", sandboxedCommand], {
          cwd,
          env: sandbox.dependencyInstallEnv(buildChildEnv()),
          detached: true, // own process group → group-kill on timeout
          stdio: ["ignore", "pipe", "pipe"],
        });

        task.process = proc;
        task.processIdentity = captureProcessIdentity(proc.pid);
        registerOwnedTask(task, task.processIdentity);
        sandbox.markCommandExecuted(command, cwd);
        let observedExitCode: number | null | undefined;

        const onStdout = (data: Buffer) => {
          const r = cappedAppend(task.stdout, data.toString(), task.stdoutDropped);
          task.stdout = r.value; task.stdoutDropped = r.dropped;
        };
        const onStderr = (data: Buffer) => {
          const r = cappedAppend(task.stderr, data.toString(), task.stderrDropped);
          task.stderr = r.value; task.stderrDropped = r.dropped;
        };
        const finish = (status: BgTask["status"], code?: number): void => {
          if (task.settled) return;
          task.settled = true;
          task.status = status;
          if (code !== undefined) task.exitCode = code;
          task.endTime ??= new Date().toISOString();
          if (task.timeoutTimer) clearTimeout(task.timeoutTimer);
          if (task.killTimer) clearTimeout(task.killTimer);
          if (task.watchdogTimer) clearTimeout(task.watchdogTimer);
          task.timeoutTimer = task.killTimer = task.watchdogTimer = undefined;
          proc.removeListener("close", onClose);
          proc.removeListener("error", onError);
          proc.removeListener("exit", onExit);
          proc.stdout?.removeListener("data", onStdout);
          proc.stderr?.removeListener("data", onStderr);
          proc.stdout?.destroy();
          proc.stderr?.destroy();
          proc.unref();
          settleOwnedTask(task);
          task.process = undefined;
          task.terminate = undefined;
          task.finishLocalTerminal = undefined;
          task.resolveCompletion();
          pruneHistory();
        };
        task.finishLocalTerminal = finish;
        const onExit = (code: number | null) => {
          observedExitCode = code;
        };
        const onClose = (code: number | null) => {
          const terminalStatus = task.terminalCause
            ? resolveTerminalStatus(task, "failed")
            : code === 0 ? "completed" : "failed";
          finish(terminalStatus, code ?? observedExitCode ?? undefined);
        };
        const onError = (err: Error) => {
          const r = cappedAppend(task.stderr, err.message, task.stderrDropped);
          task.stderr = r.value; task.stderrDropped = r.dropped;
          latchTerminalCause(task, "failed");
          markOwnedTaskSettling(task);
          const identity = task.processIdentity ?? captureProcessIdentity(proc.pid);
          const signalResult = signalTask(proc, identity, "SIGKILL");
          if (signalResult === "gone" || proc.pid === undefined || processTreeGone(proc.pid)) {
            task.outcomeUnknown = false;
            finish("failed");
          } else if (signalResult !== "sent") {
            markCleanupFailed(
              task,
              proc,
              `SIGKILL fail-closed for PID/PGID ${proc.pid ?? "unknown"}: ${describeSignalFailure(signalResult)}`,
            );
          } else {
            watchForTaskExit(task, proc);
          }
        };
        task.terminate = () => finish(
          resolveTerminalStatus(
            task,
            task.status === "timeout" || task.status === "cancelled" ? task.status : "failed",
          ),
        );
        proc.stdout?.on("data", onStdout);
        proc.stderr?.on("data", onStderr);
        proc.once("close", onClose);
        proc.once("error", onError);
        proc.once("exit", onExit);

        task.timeoutTimer = setTimeout(() => {
          task.timeoutTimer = undefined;
          if (!task.settled) {
            latchTerminalCause(task, "timeout");
            task.status = "timeout";
            task.endTime = new Date().toISOString();
            killTask(task);
          }
        }, timeoutSeconds * 1000);
        task.timeoutTimer.unref?.();
      } catch (err: any) {
        task.status = "failed";
        task.stderr = err.message;
        task.endTime = new Date().toISOString();
        task.settled = true;
        task.resolveCompletion();
        pruneHistory();
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Failed to start background task ${taskId}: ${err.message}` }],
          details: { taskId, command },
        };
      }

      return {
        content: [{ type: "text" as const, text: `✅ Background task started: **${taskId}**\nCommand: \`${command}\`\nTimeout: ${timeoutSeconds}s (kills process group)\nUse task_status ${taskId} to check progress.` }],
        details: { taskId, command },
      };
      } finally {
        pendingLaunches = Math.max(0, pendingLaunches - 1);
      }
    },
  });

  pi.registerTool({
    name: "task_stop",
    label: "Stop Background Task / 停止后台任务",
    description: "Stop a running background task and its process group.",
    parameters: Type.Object({
      task_id: Type.String({ description: "Task ID from bg_bash" }),
    }),
    async execute(_id: string, params: any) {
      const task = tasks.get(params.task_id);
      if (!task) return { isError: true, content: [{ type: "text" as const, text: `Task ${params.task_id} not found.` }], details: undefined };
      if (task.settled) return { content: [{ type: "text" as const, text: `Task ${task.id} already finished with status ${task.status}.` }], details: { taskId: task.id, status: task.status } };
      latchTerminalCause(task, "cancelled");
      task.status = "cancelled";
      task.endTime = new Date().toISOString();
      if (task.timeoutTimer) clearTimeout(task.timeoutTimer);
      task.timeoutTimer = undefined;
      killTask(task);
      return { content: [{ type: "text" as const, text: `Stopping background task ${task.id}.` }], details: { taskId: task.id, status: task.status } };
    },
  });

  // ─── task_status ──────────────────────────────────
  pi.registerTool({
    name: "task_status",
    label: "Task Status / 任务状态",
    description: "Check the status of a background task.",
    parameters: Type.Object({
      task_id: Type.String({ description: "Task ID from bg_bash" }),
    }),
    async execute(_id: string, params: any) {
      const task = tasks.get(params.task_id);
      if (!task) return { isError: true, content: [{ type: "text" as const, text: `Task ${params.task_id} not found.` }], details: undefined };

      const icon = task.status === "running" ? "🔄" : task.status === "completed" ? "✅" : task.status === "timeout" ? "⏱️" : task.status === "cancelled" ? "🛑" : "❌";
      const runtime = task.endTime
        ? `${(new Date(task.endTime).getTime() - new Date(task.startTime).getTime()) / 1000}s`
        : `${(Date.now() - new Date(task.startTime).getTime()) / 1000}s (running)`;

      return {
        content: [{
          type: "text" as const,
          text: `${icon} **${task.id}** [${task.status}]\nCommand: \`${task.command}\`\nRuntime: ${runtime}\nStdout: ${task.stdout.length} chars${task.stdoutDropped ? ` (${task.stdoutDropped} dropped middle)` : ""} | Stderr: ${task.stderr.length} chars${task.cleanupFailure ? `\nCleanup failed: ${task.cleanupFailure}` : ""}${task.outcomeUnknown ? "\nOutcome: unknown (OS cleanup unconfirmed)" : ""}`,
        }],
        details: {
          taskId: task.id,
          status: task.status,
          terminalCause: task.terminalCause,
          cleanupFailed: task.cleanupFailed,
          outcomeUnknown: task.outcomeUnknown,
          runtime,
          cleanupFailure: task.cleanupFailure,
        },
      };
    },
  });

  // ─── task_output ──────────────────────────────────
  pi.registerTool({
    name: "task_output",
    label: "Task Output / 任务输出",
    description: "Get the output of a background task (head+tail of a capped buffer).",
    parameters: Type.Object({
      task_id: Type.String({ description: "Task ID" }),
    }),
    async execute(_id: string, params: any) {
      const task = tasks.get(params.task_id);
      if (!task) return { isError: true, content: [{ type: "text" as const, text: `Task ${params.task_id} not found.` }], details: undefined };

      if (!task.settled) {
        return { content: [{ type: "text" as const, text: `Task ${task.id} is still active (${task.status}). Current tail:\n\`\`\`\n${task.stdout.slice(-5000)}\n\`\`\`` }], details: undefined };
      }

      const dropNote = task.stdoutDropped
        ? `\n> Note: ${task.stdoutDropped} middle chars dropped by output cap (head+tail retained).\n`
        : "";
      const output = [
        `# Task Output: ${task.id}`,
        `Status: ${task.status} | Exit: ${task.exitCode ?? "n/a"}`,
        task.cleanupFailed ? `Cleanup failed: ${task.cleanupFailure || "unknown"}` : "",
        task.outcomeUnknown ? "Outcome: unknown (OS cleanup unconfirmed)" : "",
        dropNote + "```",
        task.stdout.slice(-10000) || "(no stdout)",
        "```",
      ].filter(Boolean);
      if (task.stderr) output.push("## Stderr", "```", task.stderr.slice(-2000), "```");

      return { content: [{ type: "text" as const, text: output.join("\n") }], details: undefined };
    },
  });

  // ─── task_list_bg ─────────────────────────────────────
  pi.registerTool({
    name: "task_list_bg",
    label: "List Background Tasks",
    description: "List all background tasks.",
    parameters: Type.Object({}),
    async execute() {
      if (tasks.size === 0) return { content: [{ type: "text" as const, text: "No background tasks." }], details: undefined };
      const list = Array.from(tasks.values()).map(t => {
        const icon = t.status === "running" ? "🔄" : t.status === "completed" ? "✅" : t.status === "timeout" ? "⏱️" : t.status === "cancelled" ? "🛑" : "❌";
        return `${icon} **${t.id}** [${t.status}${t.cleanupFailed ? ", cleanup_failed" : ""}] \`${t.command.slice(0, 80)}\``;
      }).join("\n");
      return { content: [{ type: "text" as const, text: `# Background Tasks / 后台任务 (${tasks.size}, ${runningCount()} running, cap ${MAX_BG_RUNNING})\n\n${list}` }], details: undefined };
    },
  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    const freeze = getOwnedHandleRegistry().freezeAdmission(OWNED_PROCESS_SCOPE);
    try {
      const active = Array.from(tasks.values()).filter(task => !task.settled);
      const shutdownDrain = waitForShutdownDrain(active);
      for (const task of active) {
        latchTerminalCause(task, "cancelled");
        task.status = "cancelled";
        task.endTime = new Date().toISOString();
        if (task.timeoutTimer) clearTimeout(task.timeoutTimer);
        task.timeoutTimer = undefined;
        killTask(task);
      }
      const deadlineHit = await shutdownDrain;
      if (deadlineHit) {
        for (const task of active) {
          forceShutdownFinalize(
            task,
            "Session shutdown deadline exceeded before background task cleanup completed.",
          );
        }
      }
    } finally {
      freeze.release();
    }
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
