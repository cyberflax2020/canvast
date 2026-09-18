/**
 * =============================================================================
 * Canvast — Harness: Budget 静态多轴预算 / Static multi-axis budget
 * =============================================================================
 * @file        src/harness/budget.ts
 * @brief       Static multi-axis budget: turns, wall-clock, output bytes,
 *              external calls. Each axis caps only itself; exhaustion means a
 *              graceful degraded finish, never a hard error.
 * @description docs/architecture/runtime-orchestration.md 预算系统。四轴全部【静态可配】，不从机器资源
 *              推导（D-A2：机器资源与语义预算无关）。任一轴耗尽只停该轴；
 *              停止永远降级收尾（给出已有证据的最佳回答或明确声明不足），不是硬错误。
 *
 *                | 轴        | 默认        | 耗尽行为                          |
 *                |-----------|-------------|-----------------------------------|
 *                | 轮次      | 子上下文≤20 | 注入收尾指令，最后一次无工具作答  |
 *                | Wall-clock| 可选截止    | 子操作超时 = min(配置, 剩余预算)  |
 *                | 输出字节  | 1 MiB/条     | 落盘 + 引用（capOrSpill）         |
 *                | 外部调用  | 总量+连错+总时| 结构化诊断，主循环继续            |
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * Changes: [2026-08-15] Initial implementation — Step 2-A P0
 * =============================================================================
 */

/** 静态预算配置——四轴全部可配，缺省用默认值。 */
export interface BudgetConfig {
  /** 轮次轴：子上下文最大 turn 数（≥1）。 */
  maxTurns?: number;
  /** 轮次耗尽时注入的收尾指令（最后一次无工具作答）。 */
  turnExhaustionDirective?: string;
  /** Wall-clock 轴：距离任务级截止时间的预估剩余毫秒；undefined=不设截止。 */
  deadlineMs?: number;
  /** 输出字节轴：单条工具输出阈值 B（传给 capOrSpill）。 */
  outputByteLimit?: number;
  /** 外部调用轴：总调用次数。 */
  maxExternalCalls?: number;
  /** 外部调用轴：连续错误容忍。 */
  maxConsecutiveErrors?: number;
  /** 外部调用轴：外部调用总耗时上限 ms。 */
  maxExternalTotalMs?: number;
}

export const DEFAULT_TURN_LIMIT = 20;

export const TURN_EXHAUSTION_DIRECTIVE =
  "You have no turns remaining. Give your best answer from the evidence gathered so far; do not call any more tools.";

/** 默认预算（对齐 docs/architecture/runtime-orchestration.md：子上下文 ≤20 turn、输出 1 MiB/条）。 */
export const DEFAULT_BUDGET: Required<BudgetConfig> = {
  maxTurns: 20,
  turnExhaustionDirective: TURN_EXHAUSTION_DIRECTIVE,
  deadlineMs: 0, // 0 = 不设截止
  outputByteLimit: 1 * 1024 * 1024,
  maxExternalCalls: 50,
  maxConsecutiveErrors: 5,
  maxExternalTotalMs: 120_000,
};

interface Delta {
  turns: number;
  elapsedMsHint: number;
  externalCalls: number;
  consecutiveErrors: number;
  externalMs: number;
}

/**
 * 单次（当前会话/子上下文）预算控制器。构造时固化配置；消费则是单调的。
 * 停止永远是【降级收尾】语义：返回诊断而非抛异常。
 */
export class Budget {
  private readonly cfg: Required<BudgetConfig>;
  private turnsUsed = 0;
  private externalCalls = 0;
  private errorStreak = 0;
  private externalMsTotal = 0;
  private startedAt = Date.now();
  private exhaustedTurns = false;

  constructor(config?: BudgetConfig) {
    this.cfg = { ...DEFAULT_BUDGET, ...(config || {}) };
  }

  /** 记录一次轮次消耗（工具调用或回答）。 */
  tick(): void {
    this.turnsUsed++;
    this.exhaustedTurns = this.turnsUsed >= this.cfg.maxTurns;
  }

  /** 记录一次外部调用；`ok` 标记这次是否成功（用于连续错误轴）。 */
  recordExternal(ok: boolean, elapsedMs: number): void {
    this.externalCalls++;
    this.errorStreak = ok ? 0 : this.errorStreak + 1;
    this.externalMsTotal += elapsedMs;
  }

  get turnsRemaining(): number {
    return Math.max(0, this.cfg.maxTurns - this.turnsUsed);
  }
  get outputByteLimit(): number {
    return this.cfg.outputByteLimit;
  }
  get deadlineRemainingMs(): number {
    if (!this.cfg.deadlineMs) return Infinity;
    return Math.max(0, this.cfg.deadlineMs - (Date.now() - this.startedAt));
  }
  get externalCallsRemaining(): number {
    return Math.max(0, this.cfg.maxExternalCalls - this.externalCalls);
  }
  get consecutiveErrors(): number {
    return this.errorStreak;
  }
  get externalMsRemaining(): number {
    return Math.max(0, this.cfg.maxExternalTotalMs - this.externalMsTotal);
  }

  /**
   * 读取当前预算状态摘要。轴级诊断，不是全局 flag——供主循环决定降级到什么程度。
   */
  status(): BudgetStatus {
    const delta: Delta = {
      turns: this.turnsUsed,
      elapsedMsHint: Date.now() - this.startedAt,
      externalCalls: this.externalCalls,
      consecutiveErrors: this.consecutiveErrors,
      externalMs: this.externalMsTotal,
    };
    const warnings: string[] = [];
    if (this.turnsRemaining === 0) {
      warnings.push("轮次已耗尽——只能无工具收尾（turn budget exhausted）");
    }
    if (this.externalCallsRemaining === 0) {
      warnings.push("外部调用计数已达上限（external call budget exhausted）");
    }
    if (this.errorStreak >= this.cfg.maxConsecutiveErrors) {
      warnings.push("外部调用连续错误过多——暂停外部调用（external error budget）");
    }
    if (this.externalMsRemaining <= 0) {
      warnings.push("外部调用总耗时已达上限（external time budget exhausted）");
    }
    return {
      turnsUsed: delta.turns,
      turnsRemaining: this.turnsRemaining,
      turnsExhausted: this.turnsRemaining === 0,
      elapsedMs: delta.elapsedMsHint,
      deadlineRemainingMs: this.deadlineRemainingMs,
      outputByteLimit: this.cfg.outputByteLimit,
      externalCallsUsed: delta.externalCalls,
      externalCallsRemaining: this.externalCallsRemaining,
      consecutiveErrors: delta.consecutiveErrors,
      externalMsUsed: delta.externalMs,
      externalMsRemaining: this.externalMsRemaining,
      warnings,
    };
  }

  /**
   * 从状态的轴级角度给出当前【建议主循环】怎么做：
   * 'continue' | 'noTools'（轮次耗尽只能无工具收尾）| 'degraded'
   * 'pauseExternal'（外部调用暂停，主循环可继续本地工具）。
   */
  suggestAction(): "continue" | "noTools" | "degraded" | "pauseExternal" {
    if (this.turnsExhausted) return "noTools";
    if (this.externalCallsRemaining === 0 || this.errorStreak >= this.cfg.maxConsecutiveErrors) {
      return "pauseExternal";
    }
    if (this.deadlineRemainingMs === 0 || this.externalMsRemaining <= 0) {
      return "degraded";
    }
    return "continue";
  }

  private get turnsExhausted(): boolean {
    return this.exhaustedTurns;
  }
}

export interface BudgetStatus {
  turnsUsed: number;
  turnsRemaining: number;
  turnsExhausted: boolean;
  elapsedMs: number;
  deadlineRemainingMs: number;
  outputByteLimit: number;
  externalCallsUsed: number;
  externalCallsRemaining: number;
  consecutiveErrors: number;
  externalMsUsed: number;
  externalMsRemaining: number;
  warnings: string[];
}
