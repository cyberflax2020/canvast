/**
 * =============================================================================
 * Canvast — Harness: Recursion & External-Call Budgets / 递归与外呼预算
 * =============================================================================
 * @file        src/harness/step-budget.ts
 * @brief       Turn / wall-clock / external-call budgets per docs/architecture/runtime-orchestration.md
 * @description Structural loop control from docs/architecture/runtime-orchestration.md:
 *              a sub-context is limited on three orthogonal axes — turn count,
 *              wall-clock deadline, and external (web/API) calls. Each axis
 *              drains independently and, when exhausted, drives a *graceful
 *              degrade* (a "no-tools wind-down turn") rather than a hard error
 *              (stop only the exhausted axis). Budgets are static and configurable,
 *              never derived from machine resources (D-A2). Timing uses a monotonic
 *              clock so wall-clock deadlines survive NTP/clock adjustments.
 *
 *              三轴正交的预算：轮次、wall-clock 截止时间、外部调用次数。任一轴
 *              耗尽只停该轴，注入「无工具收尾轮」优雅收尾，而非硬错误或硬杀。
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * Changes: [2026-08-15] Initial implementation — Step 2-A
 * =============================================================================
 */

export interface StepBudgetConfig {
  /** Maximum tool-using turns allowed (default: 20 for sub-contexts). */
  maxTurns: number;
  /** Optional wall-clock deadline in milliseconds from start. */
  maxElapsedMs?: number;
  /** Total external-call budget across all external tools. */
  maxExternalCalls: number;
  /** Consecutive external-call hard-failure allowance (errors). */
  maxConsecutiveFailures: number;
  /** Maximum seconds for a single network call. */
  maxCallTookMs: number;
}

export const DEFAULT_STEP_BUDGET: StepBudgetConfig = {
  maxTurns: 20,
  maxElapsedMs: 15 * 60_000, // 15 min
  maxExternalCalls: 50,
  maxConsecutiveFailures: 3,
  maxCallTookMs: 30_000, // 30 s single call
};

export type AxisKind = "turns" | "wallclock" | "external_calls" | "failures";

export interface AxisState {
  kind: AxisKind;
  exhausted: boolean;
  limit: number;
  used: number;
  reason?: string;
}

export interface StepBudgetStatus {
  /** The most recently exhausted axis, if any. */
  exhaustedAxis?: AxisKind;
  /** Human/summarizable status of every axis. */
  axes: AxisState[];
  /** Whether budget is available for the next tool-using turn. */
  canContinue: boolean;
}

/**
 * Monotonic-clock based budget tracker. Each tick returns a status describing
 * every axis so the caller can attach a no-tools wind-down turn when exhausted.
 */
export class StepBudget {
  private _turns = 0;
  private _externalCalls = 0;
  private _consecutiveFailures = 0;
  private _startedAt: number;
  private _config: StepBudgetConfig;

  constructor(config: Partial<StepBudgetConfig> = {}, startedAt: number = performance.now()) {
    this._config = { ...DEFAULT_STEP_BUDGET, ...config };
    this._startedAt = startedAt;
  }

  /**
   * Mark one tool-using turn consumed. Returns the status after consuming.
   */
  tickTurn(): StepBudgetStatus {
    this._turns += 1;
    return this.status();
  }

  /**
   * Mark one external (web/API) call. `ok` is true on success, false on a
   * hard-failure (connect error, timeout, HTTP 5xx). Consecutive failures are
   * tracked to cut off a grinding loop.
   */
  tickExternal(ok: boolean): StepBudgetStatus {
    this._externalCalls += 1;
    if (ok) {
      this._consecutiveFailures = 0;
    } else {
      this._consecutiveFailures += 1;
    }
    return this.status();
  }

  /** Reset the consecutive-failure counter (e.g. after a recovered call). */
  resetFailures(): void {
    this._consecutiveFailures = 0;
  }

  status(now: number = performance.now()): StepBudgetStatus {
    const axes: AxisState[] = [
      { kind: "turns", exhausted: this._turns >= this._config.maxTurns, limit: this._config.maxTurns, used: this._turns },
    ];

    if (this._config.maxElapsedMs) {
      const elapsed = now - this._startedAt;
      axes.push({
        kind: "wallclock",
        exhausted: elapsed >= this._config.maxElapsedMs,
        limit: this._config.maxElapsedMs,
        used: elapsed,
      });
    }

    axes.push({
      kind: "external_calls",
      exhausted: this._externalCalls >= this._config.maxExternalCalls,
      limit: this._config.maxExternalCalls,
      used: this._externalCalls,
    });

    axes.push({
      kind: "failures",
      exhausted: this._consecutiveFailures >= this._config.maxConsecutiveFailures,
      limit: this._config.maxConsecutiveFailures,
      used: this._consecutiveFailures,
    });

    const exhausted = axes.find(a => a.exhausted);
    if (exhausted) {
      exhausted.reason = describeExhaustion(exhausted);
    }

    return {
      exhaustedAxis: exhausted?.kind,
      axes,
      canContinue: !exhausted,
    };
  }

  get turns(): number { return this._turns; }
  get externalCalls(): number { return this._externalCalls; }
  get consecutiveFailures(): number { return this._consecutiveFailures; }
}

function describeExhaustion(axis: AxisState): string {
  switch (axis.kind) {
    case "turns":
      return `Turn budget exhausted (${axis.used}/${axis.limit}). Entering no-tool wind-down turn. 轮次预算耗尽（${axis.used}/${axis.limit}），进入无工具收尾轮。`;
    case "wallclock":
      return `Wall-clock deadline reached (${Math.round(axis.used / 1000)}s / ${Math.round(axis.limit / 1000)}s). Degrading gracefully to winds-down. wall-clock 截止时间到，优雅收尾。`;
    case "external_calls":
      return `External-call budget exhausted (${axis.used}/${axis.limit}). Halting network operations. 外部调用次数预算耗尽，停止网络操作。`;
    case "failures":
      return `Too many consecutive external-call failures (${axis.used}). Halting network operations. 连续外部调用失败过多，停止网络操作。`;
  }
}

/**
 * Wind-down directive: when a budget axis is exhausted, the runner injects a
 * final prompt telling the agent to answer with evidence it already has, using
 * no further tools.
 */
export function windDownInstruction(status: StepBudgetStatus): string {
  const reason = status.axes.find(a => a.exhausted)?.reason;
  return [
    `## No-Tools Wind-Down / 无工具收尾`,
    ``,
    `Your operation budget is exhausted. STOP using tools and answer now with the`,
    `best result supported by the evidence you already have. If you cannot answer`,
    `definitively, say so explicitly rather than guessing.`,
    `操作预算已耗尽。立即停止使用工具，用你已掌握的证据给出最佳回答；若无法`,
    `确定，请明确说明而不是猜测。`,
    ``,
    reason ? `**Reason / 原因**: ${reason}` : "",
  ].join("\n");
}
