/**
 * =============================================================================
 * Canvast — Harness Budget Lifecycle Controller / 预算生命周期控制器
 * =============================================================================
 * @file        src/harness/budget-lifecycle.ts
 * @brief       Real turn_start/tool_call budget enforcement for production hooks.
 * @description Owns exactly-once turn consumption, monotonic wall-clock checks,
 *              one-shot no-tools wind-down state, child timeout bounding, and
 *              explicit reset semantics for fresh sessions/forks.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import { TurnBudget, WallClockBudget } from "./cap-or-spill.js";

export interface BudgetTurnStartEvent {
  turnIndex?: number;
}

export interface MutableToolCallEvent {
  toolName?: string;
  input?: Record<string, unknown>;
}

export interface BudgetToolCallResult {
  block?: boolean;
  reason?: string;
  terminate?: boolean;
}

export interface BudgetLifecycleOptions {
  turnBudget?: TurnBudget;
  wallClock?: WallClockBudget;
}

interface PendingWindDown {
  turnIndex: number;
  delivered: boolean;
  cause: "turns" | "wallclock";
  message: string;
}

const DEFAULT_CHILD_TIMEOUT_SECONDS = 120;
const WORKFLOW_MIN_TIMEOUT_SECONDS = 5;

function asFiniteInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.floor(value);
}

function normalizeTurnIndex(value: unknown): number | undefined {
  const normalized = asFiniteInteger(value);
  return normalized !== undefined && normalized >= 0 ? normalized : undefined;
}

function normalizeTimeoutSeconds(value: unknown, fallback: number): number {
  const normalized = asFiniteInteger(value);
  if (normalized === undefined || normalized <= 0) return fallback;
  return Math.max(1, Math.min(86_400, normalized));
}

function renderNoToolsWindDown(reason: string): string {
  return [
    "## No-Tools Wind-Down / 无工具收尾",
    "",
    "STOP using tools. Give the best final answer now using only the evidence already collected.",
    "立即停止使用工具，仅基于已经掌握的证据给出最佳最终回答。",
    "",
    `Reason / 原因: ${reason}`,
  ].join("\n");
}

function renderRepeatedWindDownBlock(): string {
  return [
    "No-tools wind-down is already active for this turn.",
    "本轮已经进入无工具收尾状态，禁止继续调用工具。",
  ].join(" ");
}

function renderWorkflowLaunchBudgetBlock(remainingMs: number): string {
  return [
    `Remaining wall-clock budget (${Math.max(0, Math.floor(remainingMs))}ms) is too small to launch workflow child steps safely.`,
    "剩余 wall-clock 预算不足 5 秒，禁止再启动 workflow 子步骤。",
  ].join(" ");
}

function capSecondsByRemaining(remainingMs: number): number {
  return Math.max(1, Math.floor(Math.max(0, remainingMs) / 1000));
}

export function createHarnessBudgetLifecycle(options: BudgetLifecycleOptions = {}) {
  const turnBudget = options.turnBudget ?? new TurnBudget();
  const wallClock = options.wallClock;
  let lastTurnIndex: number | undefined;
  let currentTurnIndex: number | undefined;
  let pendingWindDown: PendingWindDown | undefined;

  function inspect() {
    const wallClockDecision = wallClock?.check();
    return {
      lastTurnIndex,
      currentTurnIndex,
      pendingWindDown: pendingWindDown
        ? {
            turnIndex: pendingWindDown.turnIndex,
            delivered: pendingWindDown.delivered,
            cause: pendingWindDown.cause,
            message: pendingWindDown.message,
          }
        : undefined,
      turnBudget: {
        used: turnBudget.usedTurns,
        remaining: turnBudget.remaining,
        max: turnBudget.maxTurns,
      },
      wallClock: wallClock
        ? {
            remainingMs: wallClockDecision?.remainingMs ?? wallClock.remainingMs(),
            exhausted: wallClockDecision ? !wallClockDecision.ok : false,
            budgetMs: wallClock.configuredBudgetMs,
          }
        : undefined,
    };
  }

  function clearWindDownForNewTurn(turnIndex: number): void {
    currentTurnIndex = turnIndex;
    if (pendingWindDown && pendingWindDown.turnIndex !== turnIndex) pendingWindDown = undefined;
  }

  function ensureWindDown(cause: PendingWindDown["cause"], reason: string): PendingWindDown {
    const turnIndex = currentTurnIndex ?? lastTurnIndex ?? 0;
    if (
      pendingWindDown &&
      pendingWindDown.turnIndex === turnIndex &&
      pendingWindDown.cause === cause
    ) {
      return pendingWindDown;
    }
    pendingWindDown = {
      turnIndex,
      delivered: false,
      cause,
      message: renderNoToolsWindDown(reason),
    };
    return pendingWindDown;
  }

  function gateOnPendingWindDown(): BudgetToolCallResult {
    const active = pendingWindDown;
    if (!active) return {};
    if (!active.delivered) {
      active.delivered = true;
      return {
        block: true,
        terminate: true,
        reason: active.message,
      };
    }
    return {
      block: true,
      reason: renderRepeatedWindDownBlock(),
    };
  }

  function capChildTimeouts(event: MutableToolCallEvent, remainingMs: number): BudgetToolCallResult | undefined {
    if (!event.input || typeof event.input !== "object") return undefined;
    const remainingSeconds = capSecondsByRemaining(remainingMs);
    if (event.toolName === "spawn_agent" || event.toolName === "parallel_agents") {
      event.input.timeout_seconds = Math.min(
        normalizeTimeoutSeconds(event.input.timeout_seconds, DEFAULT_CHILD_TIMEOUT_SECONDS),
        remainingSeconds,
      );
      return undefined;
    }
    if (event.toolName !== "run_workflow") return undefined;
    if (remainingSeconds < WORKFLOW_MIN_TIMEOUT_SECONDS) {
      return {
        block: true,
        reason: renderWorkflowLaunchBudgetBlock(remainingMs),
      };
    }
    const steps = Array.isArray(event.input.steps) ? event.input.steps : [];
    for (const step of steps) {
      if (!step || typeof step !== "object") continue;
      const mutableStep = step as Record<string, unknown>;
      mutableStep.timeout_seconds = Math.min(
        normalizeTimeoutSeconds(mutableStep.timeout_seconds, DEFAULT_CHILD_TIMEOUT_SECONDS),
        remainingSeconds,
      );
    }
    return undefined;
  }

  return {
    turnBudget,
    wallClock,

    onTurnStart(event: BudgetTurnStartEvent = {}) {
      const turnIndex = normalizeTurnIndex(event.turnIndex);
      if (turnIndex === undefined) return inspect();
      clearWindDownForNewTurn(turnIndex);
      if (lastTurnIndex === turnIndex) return inspect();
      if (lastTurnIndex !== undefined && turnIndex < lastTurnIndex) {
        lastTurnIndex = turnIndex;
        return inspect();
      }

      lastTurnIndex = turnIndex;
      const wallClockBefore = wallClock?.check();
      const turnDecision = turnBudget.consume();
      const wallClockAfter = wallClock?.check();

      if (wallClockBefore && !wallClockBefore.ok) ensureWindDown("wallclock", wallClockBefore.message);
      else if (!turnDecision.ok) ensureWindDown("turns", turnDecision.message);
      else if (wallClockAfter && !wallClockAfter.ok) ensureWindDown("wallclock", wallClockAfter.message);

      return inspect();
    },

    onToolCall(event: MutableToolCallEvent): BudgetToolCallResult | undefined {
      const deadline = wallClock?.check();
      if (deadline && !deadline.ok) ensureWindDown("wallclock", deadline.message);
      if (pendingWindDown) return gateOnPendingWindDown();
      if (!deadline || !deadline.ok) return undefined;
      return capChildTimeouts(event, deadline.remainingMs);
    },

    resetBudgets(input: { maxTurns?: number } = {}) {
      turnBudget.reset(input.maxTurns);
      wallClock?.reset();
      lastTurnIndex = undefined;
      currentTurnIndex = undefined;
      pendingWindDown = undefined;
      return inspect();
    },

    inspect,
  };
}
