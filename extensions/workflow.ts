/**
 * =============================================================================
 * Canvast — Workflow / 工作流编排
 * =============================================================================
 * @file        extensions/workflow.ts
 * @brief       Multi-step workflow orchestration — sequential / parallel / DAG
 * @description Combines pi-vs-claude-code/agent-chain.ts (pipeline, MIT),
 *              agent-team.ts (team coordination, MIT), and pi-mono/subagent
 *              patterns.
 *
 *              Correctness & resource hardening (2026-08-15):
 *              - The former "parallel" branch was byte-identical to the
 *                sequential one (audit finding: parallel == serial). Now:
 *                a real bounded worker pool (MAX_CONCURRENT steps at once).
 *              - Steps run via spawn with an ARGUMENT ARRAY (no shell →
 *                no injection surface); API key travels via env only;
 *                ambient external-provider credentials are scrubbed.
 *              - Timeout kills the step's whole process group (TERM → 2s → KILL).
 *              - Per-step output capped (50 KB kept, 5 KB shown per step).
 *              - DAG cycles cannot spin forever: bounded rounds + blocked-step
 *                detection with an explicit report.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * Changes: [2026-08-08] Initial — merged 3 source projects
 *          [2026-08-15] Real bounded parallelism; spawn+argv; env scrub;
 *                       process-group kill ladder; cycle/blocked detection
 * =============================================================================
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  captureProcessIdentity,
  createTerminalCauseLatch,
  processTreeGone,
  settleWithin,
  signalProcessGroupVerified,
  type ProcessStartIdentity,
} from "../src/utils/bounded-lifecycle.js";
import {
  getOwnedHandleRegistry,
  type OwnedHandleLease,
} from "../src/utils/owned-handle-registry.js";
import { resolveProviderModelArgs } from "../src/harness/model-capabilities.js";
import { registerDesktopActionTool } from "../src/desktop-action/tool-bridge.js";
import {
  createOrchestrationCancellation,
  OrchestrationRunRegistry,
} from "../src/desktop-action/orchestration-control.js";
import { publishExtensionRuntimeCheckpoint } from "../src/harness/runtime-safe-checkpoint.js";
import { PROCESS_SNAPSHOT_SOURCE } from "../scripts/process-snapshot-client.mjs";

const MAX_CONCURRENT = Math.max(1, Math.min(2, Number(process.env.CANVAST_WORKFLOW_MAX_CONCURRENT || 2)));
const OUTPUT_CAP = 50_000;     // chars kept per step result
const KILL_GRACE_MS = 2_000;
const KILL_WATCHDOG_MS = 1_000;
const SHUTDOWN_DRAIN_MS = KILL_GRACE_MS + KILL_WATCHDOG_MS + 100;
const SHUTDOWN_FINALIZE_MS = 150;
const OWNED_PROCESS_SCOPE = "extension-workflow";

interface WorkflowStep { name: string; task: string; dependsOn?: string[]; timeout?: number; }
interface StepResult {
  step: string;
  success: boolean;
  output: string;
  durationMs: number;
  timedOut?: boolean;
  cancelled?: boolean;
  cleanupFailed?: boolean;
  outcomeUnknown?: boolean;
  terminalCause?: "timeout" | "cancelled" | "failed";
}
interface ActiveRun {
  cancel(): void;
  forceFinalize(reason: string): void;
  done: Promise<void>;
}
interface ActiveWorkflow {
  cancel(): boolean;
  done: Promise<void>;
}

interface RunLifecycle {
  register(run: ActiveRun): void;
  unregister(run: ActiveRun): void;
}

type ReleaseSlot = () => void;

interface SlotWaiter {
  settled: boolean;
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve(release: ReleaseSlot | undefined): void;
}

/** One extension-wide FIFO protects the aggregate child-process budget. */
class BoundedFifoSlots {
  private active = 0;
  private stopped = false;
  private readonly waiters: SlotWaiter[] = [];

  constructor(private readonly limit: number) {}

  acquire(signal?: AbortSignal): Promise<ReleaseSlot | undefined> {
    if (this.stopped || signal?.aborted) return Promise.resolve(undefined);
    return new Promise(resolve => {
      const waiter: SlotWaiter = { settled: false, signal, resolve };
      waiter.onAbort = () => {
        if (waiter.settled) return;
        waiter.settled = true;
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        signal?.removeEventListener("abort", waiter.onAbort!);
        resolve(undefined);
        this.drain();
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.push(waiter);
      this.drain();
    });
  }

  stop(): void {
    this.stopped = true;
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.settled) continue;
      waiter.settled = true;
      waiter.signal?.removeEventListener("abort", waiter.onAbort!);
      waiter.resolve(undefined);
    }
  }

  private drain(): void {
    if (this.stopped) return;
    while (this.active < this.limit && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      if (waiter.settled) continue;
      if (waiter.signal?.aborted) {
        waiter.onAbort?.();
        continue;
      }
      waiter.settled = true;
      waiter.signal?.removeEventListener("abort", waiter.onAbort!);
      this.active++;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.active = Math.max(0, this.active - 1);
        this.drain();
      });
    }
  }
}

function resolveWorkflowModelArgs(): { provider: string; model: string; thinking: string } {
  const resolved = resolveProviderModelArgs({
    provider: process.env.CANVAST_WORKFLOW_PROVIDER ||
      process.env.CANVAST_SUBAGENT_PROVIDER ||
      process.env.CANVAST_PROVIDER ||
      process.env.CANVAST_DEFAULT_PROVIDER,
    model: process.env.CANVAST_WORKFLOW_MODEL ||
      process.env.CANVAST_SUBAGENT_MODEL ||
      process.env.CANVAST_MODEL ||
      process.env.CANVAST_DEFAULT_MODEL ||
      "deepseek-v4-flash",
  });
  return {
    provider: resolved.provider,
    model: resolved.model,
    thinking: process.env.CANVAST_WORKFLOW_THINKING ||
      process.env.CANVAST_SUBAGENT_THINKING ||
      resolved.thinking,
  };
}

function runStep(
  step: WorkflowStep,
  seq: number,
  abortSignal?: AbortSignal,
  lifecycle?: RunLifecycle,
  releaseSlot?: ReleaseSlot,
): Promise<StepResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const piBin = path.join(__dirname, "..", "node_modules", ".bin", "pi");
    const safeRun = path.join(__dirname, "..", "scripts", "safe-run.sh");
    const baseDir = process.env.PI_CODING_AGENT_DIR || path.join(__dirname, "..", "pi-data", "agent");
    const modelArgs = resolveWorkflowModelArgs();
    const stepTimeout = Math.max(5, Math.floor(step.timeout || 120));
    const hasSafeRun = fs.existsSync(safeRun);
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_API_KEY;
    const stepDataDir = path.resolve(path.join(baseDir, "workflow", `step-${seq}`));
    env.PI_CODING_AGENT_DIR = stepDataDir;
    env.CANVAST_RESOURCE_STATE_DIR = path.join(env.PI_CODING_AGENT_DIR, "resource-state");
    const piArgs = [
      "--provider", modelArgs.provider,
      "--model", modelArgs.model,
      "--thinking", modelArgs.thinking,
      "--no-session",
      "--no-context-files",
      "-p", step.task,
    ];
    const executable = hasSafeRun ? safeRun : piBin;
    const args = hasSafeRun ? ["--timeout", String(stepTimeout), "--", piBin, ...piArgs] : piArgs;
    const registry = getOwnedHandleRegistry();
    if (!registry.accepting(OWNED_PROCESS_SCOPE)) {
      releaseSlot?.();
      resolve({
        step: step.name,
        success: false,
        output: "Workflow step launch refused because process admission is frozen.",
        durationMs: Date.now() - start,
        cancelled: true,
        terminalCause: "cancelled",
      });
      return;
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        executable,
        args,
        { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"], detached: true },
      );
    } catch (error: any) {
      releaseSlot?.();
      resolve({
        step: step.name,
        success: false,
        output: `Failed to start step: ${error?.message || String(error)}`,
        durationMs: Date.now() - start,
      });
      return;
    }

    let out = "";
    let released = false;
    let resultSettled = false;
    let terminationStarted = false;
    let timeout: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let watchdogTimer: NodeJS.Timeout | undefined;
    let childIdentity: ProcessStartIdentity | undefined = captureProcessIdentity(child.pid);
    let ownedHandle: OwnedHandleLease | undefined;
    if (childIdentity) {
      try {
        ownedHandle = registry.register({
          type: "os-process",
          owner: "workflow-extension",
          source: PROCESS_SNAPSHOT_SOURCE,
          scope: OWNED_PROCESS_SCOPE,
          pid: childIdentity.pid,
          pgid: childIdentity.pgid,
          birth: childIdentity.birth,
          metadata: { step: step.name, sequence: seq },
        });
      } catch {
        // A concurrent admission freeze can win after spawn. Existing cleanup
        // remains responsible for the child that has already been created.
      }
    }
    const terminal = createTerminalCauseLatch<"timeout" | "cancelled" | "failed">();
    let resolveDone!: () => void;
    const done = new Promise<void>(doneResolve => {
      resolveDone = doneResolve;
    });
    const append = (c: Buffer) => {
      if (out.length <= OUTPUT_CAP) out += c.toString("utf-8");
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const cappedOutput = () =>
      out.length > OUTPUT_CAP ? out.slice(0, OUTPUT_CAP) + "\n...(truncated)" : out;
    const terminalResult = (fallback?: string): StepResult => {
      const state = terminal.current();
      const cause = state.cause ?? "failed";
      const defaultOutput = cause === "cancelled"
        ? "(cancelled, no output)"
        : cause === "timeout"
          ? "(timeout, no output)"
          : "(terminated, no output)";
      return {
        step: step.name,
        success: false,
        output: fallback || cappedOutput() || defaultOutput,
        durationMs: Date.now() - start,
        timedOut: cause === "timeout",
        cancelled: cause === "cancelled",
        cleanupFailed: state.cleanupFailed || undefined,
        outcomeUnknown: state.outcomeUnknown || undefined,
        terminalCause: cause,
      };
    };
    const cleanupFailedResult = (reason: string, outcomeUnknown: boolean): StepResult => {
      terminal.markCleanupFailed();
      if (outcomeUnknown) terminal.markOutcomeUnknown();
      const current = cappedOutput();
      const output = current ? `${current}\n${reason}` : reason;
      return terminalResult(output);
    };
    const signalChild = (
      signal: NodeJS.Signals,
    ): "sent" | "gone" | "identity_mismatch" | "unverifiable" | "failed" => {
      childIdentity ??= captureProcessIdentity(child.pid);
      return signalProcessGroupVerified(child.pid, childIdentity, signal);
    };
    const publish = (result: StepResult) => {
      if (resultSettled) return;
      resultSettled = true;
      resolve(result);
    };

    const release = () => {
      if (released) return;
      released = true;
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (watchdogTimer) clearTimeout(watchdogTimer);
      timeout = killTimer = watchdogTimer = undefined;
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("data", append);
      child.stderr?.removeListener("data", append);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      abortSignal?.removeEventListener("abort", onAbort);
      lifecycle?.unregister(activeRun);
      releaseSlot?.();
      resolveDone();
    };
    const finish = (result: StepResult) => {
      if (released) return;
      if (ownedHandle) {
        if (result.cleanupFailed || result.outcomeUnknown) {
          ownedHandle.markUnconfirmed(result.output || `Cleanup outcome unknown for workflow step ${step.name}.`);
        } else {
          ownedHandle.release();
        }
        ownedHandle = undefined;
      }
      publish(result);
      release();
    };
    const confirmCleanup = () => {
      watchdogTimer = undefined;
      if (released) return;
      if (child.pid === undefined || processTreeGone(child.pid)) {
        finish(terminalResult());
        return;
      }
      finish(cleanupFailedResult(
        `SIGKILL cleanup not confirmed for PID/PGID ${child.pid ?? "unknown"}`,
        true,
      ));
    };
    const forceKill = () => {
      if (ownedHandle?.snapshot().state === "active") ownedHandle.markSettling();
      const signalResult = signalChild("SIGKILL");
      if (signalResult === "gone" || child.pid === undefined || processTreeGone(child.pid)) {
        finish(terminalResult());
        return;
      }
      if (signalResult !== "sent") {
        finish(cleanupFailedResult(
          `SIGKILL fail-closed for PID/PGID ${child.pid ?? "unknown"}: ${describeSignalFailure(signalResult)}`,
          true,
        ));
        return;
      }
      watchdogTimer = setTimeout(confirmCleanup, KILL_WATCHDOG_MS);
      watchdogTimer.unref?.();
    };
    const terminate = () => {
      if (released || terminationStarted) return;
      terminationStarted = true;
      if (ownedHandle?.snapshot().state === "active") ownedHandle.markSettling();
      const signalResult = signalChild("SIGTERM");
      if (signalResult === "gone" || child.pid === undefined || processTreeGone(child.pid)) {
        finish(terminalResult());
        return;
      }
      if (signalResult !== "sent") {
        finish(cleanupFailedResult(
          `SIGTERM fail-closed for PID/PGID ${child.pid ?? "unknown"}: ${describeSignalFailure(signalResult)}`,
          true,
        ));
        return;
      }
      killTimer = setTimeout(() => {
        killTimer = undefined;
        if (released) return;
        forceKill();
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    };
    const cancel = () => {
      terminal.latch("cancelled");
      terminate();
    };
    const forceFinalize = (reason: string) => {
      if (released) return;
      terminal.latch("cancelled");
      if (ownedHandle?.snapshot().state === "active") ownedHandle.markSettling();
      const signalResult = signalChild("SIGKILL");
      if (signalResult === "gone" || child.pid === undefined || processTreeGone(child.pid)) {
        finish(terminalResult());
        return;
      }
      const signalDetail = signalResult === "sent"
        ? "final SIGKILL sent but exit was not confirmed"
        : describeSignalFailure(signalResult);
      finish(cleanupFailedResult(
        `${reason} for PID/PGID ${child.pid ?? "unknown"}: ${signalDetail}`,
        true,
      ));
    };
    const activeRun: ActiveRun = { cancel, forceFinalize, done };
    const onAbort = cancel;
    const onError = (err: Error) => {
      if (released || terminationStarted) return;
      terminal.latch("failed");
      terminationStarted = true;
      if (ownedHandle?.snapshot().state === "active") ownedHandle.markSettling();
      const signalResult = signalChild("SIGKILL");
      const startFailure = terminalResult(`Failed to start step: ${err.message}`);
      if (signalResult === "gone" || child.pid === undefined || processTreeGone(child.pid)) {
        finish(startFailure);
        return;
      }
      if (signalResult !== "sent") {
        finish(cleanupFailedResult(
          `Failed to start step: ${err.message}\nSIGKILL fail-closed for PID/PGID ${child.pid ?? "unknown"}: ${describeSignalFailure(signalResult)}`,
          true,
        ));
        return;
      }
      watchdogTimer = setTimeout(confirmCleanup, KILL_WATCHDOG_MS);
      watchdogTimer.unref?.();
    };
    const onClose = (code: number | null) => {
      const durationMs = Date.now() - start;
      const capped = cappedOutput();
      const cause = terminal.current().cause;
      if (cause === "cancelled" || cause === "timeout") {
        finish({
          ...terminalResult(capped || undefined),
          durationMs,
        });
        return;
      }
      if ((code ?? 0) === 0) finish({ step: step.name, success: true, output: capped || "(no output)", durationMs });
      else finish({ step: step.name, success: code === 0, output: capped || "(no output)", durationMs });
    };

    timeout = setTimeout(() => {
      terminal.latch("timeout");
      terminate();
    }, stepTimeout * 1000);
    timeout.unref?.();
    child.once("error", onError);
    child.once("close", onClose);
    lifecycle?.register(activeRun);
    if (abortSignal?.aborted) onAbort();
    else abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

export default function (pi: ExtensionAPI) {
  const activeRuns = new Set<ActiveRun>();
  const activeWorkflows = new Set<ActiveWorkflow>();
  const runRegistry = new OrchestrationRunRegistry("workflow");
  runRegistry.registerHandlers(pi);
  const slots = new BoundedFifoSlots(MAX_CONCURRENT);
  let shuttingDown = false;
  let stepSequence = 0;
  const lifecycle: RunLifecycle = {
    register: run => activeRuns.add(run),
    unregister: run => activeRuns.delete(run),
  };
  const runWithSlot = async (step: WorkflowStep, signal?: AbortSignal): Promise<StepResult> => {
    const releaseSlot = await slots.acquire(signal);
    if (!releaseSlot) {
      return {
        step: step.name,
        success: false,
        output: shuttingDown
          ? "Workflow step cancelled because the session is shutting down."
          : "Workflow step cancelled before acquiring a concurrency slot.",
        durationMs: 0,
        cancelled: true,
        terminalCause: "cancelled",
      };
    }
    if (shuttingDown || signal?.aborted) {
      releaseSlot();
      return {
        step: step.name,
        success: false,
        output: shuttingDown
          ? "Workflow step cancelled because the session is shutting down."
          : "Workflow step cancelled before start.",
        durationMs: 0,
        cancelled: true,
        terminalCause: "cancelled",
      };
    }
    try {
      return await runStep(step, ++stepSequence, signal, lifecycle, releaseSlot);
    } catch (error: any) {
      releaseSlot();
      return {
        step: step.name,
        success: false,
        output: `Workflow step failed before launch: ${error?.message || String(error)}`,
        durationMs: 0,
      };
    }
  };

  registerDesktopActionTool(pi, {
    name: "run_workflow",
    label: "Run Workflow / 运行工作流",
    description: `Execute a multi-step workflow with sequential / parallel / DAG orchestration.
Each step runs an isolated pi process (no extensions). Steps with depends_on wait for their dependencies.
At most ${MAX_CONCURRENT} steps run concurrently. Cycles or unsatisfiable dependencies are reported, not spun on.`,
    parameters: Type.Object({
      name: Type.String({ description: "Workflow name / 工作流名称" }),
      steps: Type.Array(Type.Object({
        name: Type.String({ description: "Step name" }),
        task: Type.String({ description: "Task for this step" }),
        depends_on: Type.Optional(Type.Array(Type.String({ description: "Steps this depends on" }))),
        timeout_seconds: Type.Optional(Type.Number({ description: "Timeout per step / 每步超时", default: 120 })),
      })),
      mode: Type.Optional(Type.Union([Type.Literal("sequential"), Type.Literal("parallel"), Type.Literal("dag")])),
    }),
    async execute(id: string, params: any, signal?: AbortSignal) {
      if (shuttingDown) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: "Workflow unavailable: session is shutting down." }],
          details: undefined,
        };
      }
      const { name, mode = "dag" } = params;
      const steps: WorkflowStep[] = (params.steps || []).map((s: any) => ({
        name: s.name.trim(),
        task: s.task,
        dependsOn: s.depends_on?.map((dependency: string) => dependency.trim()),
        timeout: s.timeout_seconds,
      }));
      const names = new Set<string>();
      for (const step of steps) {
        if (!step.name) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: "Workflow error: step name must not be blank." }],
            details: undefined,
          };
        }
        if (names.has(step.name)) {
          return {
            isError: true,
            content: [{
              type: "text" as const,
              text: `Workflow error: duplicate step name "${step.name}". Step names must be unique.`,
            }],
            details: undefined,
          };
        }
        names.add(step.name);
      }
      const results: StepResult[] = [];
      const completed = new Set<string>();
      const failed = new Set<string>();
      const cancelled = new Set<string>();
      const failedDependencyBlocked = new Set<string>();
      const startAll = Date.now();

      // Validate dependencies up front (unknown names)
      for (const s of steps) {
        for (const d of s.dependsOn || []) {
          if (!names.has(d)) {
            return { isError: true, content: [{ type: "text" as const, text: `Workflow error: step "${s.name}" depends on unknown step "${d}".` }], details: undefined };
          }
        }
      }

      const cancellation = createOrchestrationCancellation(signal);
      const runId = runRegistry.begin(id, { cancel: cancellation.cancel });
      let resolveWorkflowDone!: () => void;
      const activeWorkflow: ActiveWorkflow = {
        cancel: cancellation.cancel,
        done: new Promise<void>(resolve => {
          resolveWorkflowDone = resolve;
        }),
      };
      activeWorkflows.add(activeWorkflow);
      try {
        let remaining = [...steps];
        while (remaining.length > 0) {
          let newlyBlocked: WorkflowStep[];
          do {
            newlyBlocked = remaining.filter(step =>
              (step.dependsOn || []).some(dependency =>
                failed.has(dependency) || failedDependencyBlocked.has(dependency),
              ),
            );
            for (const step of newlyBlocked) failedDependencyBlocked.add(step.name);
            remaining = remaining.filter(step => !failedDependencyBlocked.has(step.name));
          } while (newlyBlocked.length > 0);
          if (remaining.length === 0) break;

          const ready = remaining.filter(s =>
            (s.dependsOn || []).every(d => completed.has(d)),
          );
          if (ready.length === 0) break; // cycle or blocked — reported below

          let batch = ready;
          if (mode === "sequential") batch = ready.slice(0, 1);
          else if (ready.length > MAX_CONCURRENT) batch = ready.slice(0, MAX_CONCURRENT);

          const batchResults = await Promise.all(batch.map(s => runWithSlot(s, cancellation.signal)));
          for (const r of batchResults) {
            results.push(r);
            if (r.success) completed.add(r.step);
            else if (r.cancelled) cancelled.add(r.step);
            else failed.add(r.step);
          }
          remaining = remaining.filter(s =>
            !completed.has(s.name) && !failed.has(s.name) && !cancelled.has(s.name),
          );
          // Results and dependency state are now stable and observable. This is
          // the workflow boundary at which queued input may be reconsidered.
          publishExtensionRuntimeCheckpoint(pi, "on_workflow_stage");
        }

        const cycleBlocked = remaining.map(s => s.name);
        const blocked = [...failedDependencyBlocked, ...cycleBlocked];
        const cleanupFailed = results.some(result => result.cleanupFailed);
        const outcomeUnknown = results.some(result => result.outcomeUnknown);
        const summary = results.map(r =>
          `### ${r.success ? "✅" : r.cancelled ? "🛑" : r.timedOut ? "⏱️" : "❌"} ${r.step} (${(r.durationMs / 1000).toFixed(1)}s)\n\`\`\`\n${r.output.slice(0, 5000)}\n\`\`\``,
        ).join("\n\n");

        const notes = [
          failedDependencyBlocked.size > 0 ? `\n⚠️ Blocked (failed dependency): ${Array.from(failedDependencyBlocked).join(", ")}` : "",
          cancelled.size > 0 ? `\n⚠️ Cancelled steps: ${Array.from(cancelled).join(", ")}` : "",
          cleanupFailed ? `\n⚠️ Cleanup failed locally for one or more terminated steps.` : "",
          outcomeUnknown ? `\n⚠️ Outcome is unknown for one or more terminated process trees.` : "",
          cycleBlocked.length > 0 ? `\n⚠️ Blocked (cycle or unsatisfied dependency): ${cycleBlocked.join(", ")}` : "",
          failed.size > 0 ? `\n⚠️ Failed steps: ${Array.from(failed).join(", ")}.` : "",
        ].join("");
        runRegistry.settle(
          runId,
          cancellation.signal.aborted ? "cancelled"
            : failed.size > 0 || blocked.length > 0 ? "failed" : "completed",
        );

        return {
          isError: failed.size > 0 || cancelled.size > 0 || blocked.length > 0,
          content: [{
            type: "text" as const,
            text: `# Workflow: ${name}\n**Mode**: ${mode} | **Steps**: ${completed.size}/${steps.length} completed, ${failed.size} failed, ${cancelled.size} cancelled${blocked.length ? `, ${blocked.length} blocked` : ""} | **Total**: ${((Date.now() - startAll) / 1000).toFixed(1)}s\n\n${summary}${notes}`,
          }],
          details: {
            name,
            mode,
            stepsCompleted: completed.size,
            stepsFailed: failed.size,
            stepsCancelled: cancelled.size,
            stepsBlocked: blocked.length,
            totalSteps: steps.length,
            cleanupFailed,
            outcomeUnknown,
            results,
            runId,
            orchestration: runRegistry.describe(runId),
          },
        };
      } finally {
        cancellation.dispose();
        if (["running", "cancelling"].includes(runRegistry.describe(runId)?.state || "")) {
          runRegistry.settle(runId, cancellation.signal.aborted ? "cancelled" : "failed");
        }
        activeWorkflows.delete(activeWorkflow);
        resolveWorkflowDone();
      }
    },
  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    const freeze = getOwnedHandleRegistry().freezeAdmission(OWNED_PROCESS_SCOPE);
    slots.stop();
    const workflows = Array.from(activeWorkflows);
    for (const workflow of workflows) workflow.cancel();
    const runs = Array.from(activeRuns);
    for (const run of runs) run.cancel();
    const ownedWorkDone = () => Promise.allSettled([
      ...runs.map(run => run.done),
      ...workflows.map(workflow => workflow.done),
    ]);
    try {
      const drained = await settleWithin(
        "workflow shutdown drain",
        SHUTDOWN_DRAIN_MS,
        ownedWorkDone(),
      );
      if (!drained.ok) {
        for (const run of Array.from(activeRuns)) {
          run.forceFinalize("Workflow shutdown cleanup deadline exceeded");
        }
        await settleWithin(
          "workflow shutdown finalization",
          SHUTDOWN_FINALIZE_MS,
          ownedWorkDone(),
        );
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
