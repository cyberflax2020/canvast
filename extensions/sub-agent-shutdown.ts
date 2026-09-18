/**
 * =============================================================================
 * Canvast — Sub-Agent Shutdown Ownership / 子 Agent 关闭所有权
 * =============================================================================
 * @file        extensions/sub-agent-shutdown.ts
 * @brief       Bounds session shutdown independently from child runtime waits
 * @description Owns the outer shutdown deadline and idempotent owner release
 *              used when a child runtime never resolves after cancellation.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import type { ChildProcess } from "child_process";

import { settleWithin } from "../src/utils/bounded-lifecycle.js";
import { getOwnedHandleRegistry } from "../src/utils/owned-handle-registry.js";
import {
  runPiSubagent,
  type ActiveChildRun,
  type PiSubagentRunOptions,
  type RunResult,
  type SubagentLifecycleHooks,
} from "./sub-agent-runtime.js";

const SESSION_SHUTDOWN_DEADLINE_MS = 3_000;
const OWNED_PROCESS_SCOPE = "extension-sub-agent";

export interface ShutdownOwner {
  done: Promise<void>;
  release(): void;
}

export interface ShutdownOwnedRun {
  terminate(): void;
  forceFinalize(): void;
  done: Promise<void>;
}

export function createShutdownOwner(onRelease: () => void): ShutdownOwner {
  let released = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  return {
    done,
    release: () => {
      if (released) return;
      released = true;
      try {
        onRelease();
      } finally {
        resolveDone();
      }
    },
  };
}

function shutdownDeadlineResult(): RunResult {
  return {
    success: false,
    output: "Session shutdown deadline exceeded before sub-agent cleanup completed.",
    durationMs: 0,
    timedOut: false,
    cleanupFailed: true,
    outcomeUnknown: true,
    terminalCause: "cancelled",
    engine: "pi_llm",
  };
}

export function createShutdownOwnedRun(
  task: string,
  timeoutSeconds: number,
  cancel: () => boolean,
  cancellationSignal: AbortSignal,
  lifecycle: SubagentLifecycleHooks,
  options: PiSubagentRunOptions = {},
): { run: ShutdownOwnedRun; result: Promise<RunResult> } {
  let settled = false;
  let resolveResult!: (value: RunResult) => void;
  const result = new Promise<RunResult>((resolve) => { resolveResult = resolve; });

  const finish = (runResult: RunResult): void => {
    if (settled) return;
    settled = true;
    resolveResult(runResult);
  };

  runPiSubagent(task, timeoutSeconds, lifecycle, cancellationSignal, options).then(finish, (error) => {
    finish({
      success: false,
      output: `Sub-agent runtime rejected unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
      durationMs: 0,
      timedOut: false,
      cleanupFailed: true,
      outcomeUnknown: true,
      terminalCause: "failed",
      engine: "pi_llm",
    });
  });

  return {
    run: {
      terminate: () => {
        if (!settled) cancel();
      },
      forceFinalize: () => { finish(shutdownDeadlineResult()); },
      done: result.then(() => undefined),
    },
    result,
  };
}

function detachUnconfirmedChild<TChild extends ChildProcess>(
  child: TChild,
  activeRuns: Map<TChild, ActiveChildRun>,
): void {
  activeRuns.get(child)?.markDetachedUnconfirmed?.(
    `Session shutdown detached PID ${child.pid ?? "unknown"} before cleanup was confirmed.`,
  );
  child.removeAllListeners();
  child.stdin?.destroy?.();
  child.stdout?.removeAllListeners?.();
  child.stdout?.destroy?.();
  child.stderr?.removeAllListeners?.();
  child.stderr?.destroy?.();
  child.unref?.();
  activeRuns.delete(child);
}

export async function drainSubagentShutdown<TChild extends ChildProcess>(
  ownedRuns: Set<ShutdownOwnedRun>,
  owners: Set<ShutdownOwner>,
  activeRuns: Map<TChild, ActiveChildRun>,
): Promise<void> {
  const freeze = getOwnedHandleRegistry().freezeAdmission(OWNED_PROCESS_SCOPE);
  const runs = Array.from(ownedRuns);
  const capturedOwners = Array.from(owners);
  const drain = settleWithin(
    "sub-agent session shutdown",
    SESSION_SHUTDOWN_DEADLINE_MS,
    Promise.allSettled(capturedOwners.map(owner => owner.done)),
  );
  for (const run of runs) run.terminate();
  if ((await drain).ok) {
    freeze.release();
    return;
  }

  for (const child of Array.from(activeRuns.keys())) {
    detachUnconfirmedChild(child, activeRuns);
  }
  for (const run of runs) run.forceFinalize();
  for (const owner of capturedOwners) owner.release();
  freeze.release();
}
