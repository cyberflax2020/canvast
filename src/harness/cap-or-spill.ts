/**
 * =============================================================================
 * Canvast — Harness: Cap-Or-Spill output ceiling + Budget system / 统一输出封顶与预算系统
 * =============================================================================
 * @file        src/harness/cap-or-spill.ts
 * @brief       Unified output cap (capOrSpill) + multi-axis budget system
 * @description docs/architecture/runtime-orchestration.md (budgets and output spill). Every tool result is capped
 *              at a threshold (~1 MiB); results that exceed it are spilled to a
 *              disk-backed directory (`pi-data/spill/<id>`) and the model receives
 *              only { size, head preview, path }, so it can re-read on demand —
 *              the same pattern as Codex 1MiB/HeadTail.
 *
 *              Also implements the three required budget axes:
 *                - OutputBudget:  total calls / consecutive errors / total time
 *                - TurnBudget:    ≤20 turns per child context
 *                - WallClockBudget: task deadline (output = min(remaining, config))
 *
 *              Every axis either allows the operation or returns a STRUCTURED
 *              diagnostic (not an exception); exhaustion stops only that axis and
 *              the main loop continues.
 *
 *              Pure, deterministic, no-LLM — this module is P0 (Step 2-A).
 *
 *              纯垃圾引擎 + 磁盘溢出层 + 三轴预算。所有预算耗尽都返回结构化诊断
 *              而非抛异常；停止永远是降级收尾而非硬错误（D-A2/§4 原则）。
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * Changes: [2026-08-15] Initial implementation — capOrSpill + budget system (Step 2-A)
 * =============================================================================
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface BudgetClock {
  nowMs(): number;
}

export const MONOTONIC_BUDGET_CLOCK: BudgetClock = {
  nowMs: () => (typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now()),
};

// ─── Cap-Or-Spill constants ───────────────────────────────────────────────

/** Default single-result output ceiling (1 MiB, matching Codex). */
export const DEFAULT_SPILL_THRESHOLD_BYTES = 1 * 1024 * 1024;
/** Bytes of the head (start) of a spilled payload shown in the preview. */
export const SPILL_HEAD_PREVIEW_CHARS = 500;
/** Bytes of the tail (end) of a spilled payload shown in the preview. */
export const SPILL_TAIL_PREVIEW_CHARS = 500;
/** Previews are abbreviated with this ellipse marker. */
export const SPILL_ELLIPSIS = "\n…[truncated by Canvast capOrSpill]…\n";

// ─── Spill primitives (pure) ──────────────────────────────────────────────

/** A single capOrSpill decision — either inline text or a spill reference. */
export type SpillResult =
  | { spilled: false; text: string }   // within cap → pass through unchanged
  | { spilled: true; id: string; sizeBytes: number; head: string; tail: string; path: string };

/**
 * Decide whether a tool output must be spilled.
 *
 * Pure: takes bytes and returns a spill reference without touching the disk.
 * The caller (SpillStore.write) performs the actual persistence.
 */
export function capOrSpill(
  output: string,
  thresholdBytes: number = DEFAULT_SPILL_THRESHOLD_BYTES,
): { spill: boolean; id: string; sizeBytes: number; head: string; tail: string } {
  const sizeBytes = Buffer.byteLength(output, "utf-8");
  const spill = sizeBytes > thresholdBytes;

  if (!spill) {
    return { spill, id: "", sizeBytes, head: "", tail: "" };
  }

  const head = output.slice(0, SPILL_HEAD_PREVIEW_CHARS);
  const tail = output.slice(Math.max(0, output.length - SPILL_TAIL_PREVIEW_CHARS));

  return { spill, id: `spill_${randomUUID()}`, sizeBytes, head, tail };
}

/**
 * Format the head/tail preview the model sees for a spilled result.
 * Returns the full reference body a caller stores on disk (or the text to hand
 * to the model when persisting externally).
 */
export function formatSpillPreview(s: {
  id: string; sizeBytes: number; head: string; tail: string; path: string;
}): string {
  return [
    `[Canvast capOrSpill] output ${s.sizeBytes} bytes exceeds threshold — spilled to disk.`,
    `Path: ${s.path}`,
    `ID:   ${s.id}`,
    ``,
    `HEAD (${SPILL_HEAD_PREVIEW_CHARS} chars):`,
    s.head,
    SPILL_ELLIPSIS,
    `TAIL (${SPILL_TAIL_PREVIEW_CHARS} chars):`,
    s.tail,
  ].join("\n");
}

// ─── SpillStore (disk-backed) ─────────────────────────────────────────────

/**
 * Disk-backed spill store. Writes oversized tool results to a directory so the
 * model can re-read them by path on demand. GC prunes old spills with a bounded
 * TTL / count to keep the disk from growing without limit (D-A2 / D-A5).
 */
export class SpillStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  /** Absolute path where a spill would be written. */
  resolve(id: string): string {
    return path.join(this.dir, `${id}.txt`);
  }

  /**
   * Apply capOrSpill and, if spilled, persist the full payload to disk.
   * Returns the SpillResult the harness should hand to the model.
   */
  write(output: string, thresholdBytes: number = DEFAULT_SPILL_THRESHOLD_BYTES): SpillResult {
    const { spill, id, sizeBytes, head, tail } = capOrSpill(output, thresholdBytes);
    if (!spill) {
      return { spilled: false, text: output };
    }

    const p = this.resolve(id);
    fs.writeFileSync(p, output, "utf-8");
    return { spilled: true, id, sizeBytes, head, tail, path: p };
  }

  /** Read a previously spilled payload back (for on-demand re-read). */
  read(id: string): string | undefined {
    const p = this.resolve(id);
    return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : undefined;
  }

  /** Remove a single spill. Returns true if it existed and was removed. */
  delete(id: string): boolean {
    const p = this.resolve(id);
    if (!fs.existsSync(p)) return false;
    fs.unlinkSync(p);
    return true;
  }

  /** List all spill ids currently on disk. */
  list(): string[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir)
      .filter(f => f.endsWith(".txt"))
      .map(f => f.replace(/\.txt$/, ""));
  }

  /** Number of spill files on disk. */
  get count(): number {
    return this.list().length;
  }

  /**
   * Garbage-collect old spills by (a) a maximum number of files and (b) a TTL.
   * Older-than-TTL files are always removed; if the count still exceeds
   * maxFiles, the oldest remaining files are removed newest-first then oldest
   * until under the cap. Returns ids removed.
   */
  gc(options: { maxFiles?: number; maxAgeMs?: number } = {}): string[] {
    const maxFiles = options.maxFiles ?? 100;
    const maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60 * 1000; // 24h
    const now = Date.now();
    const removed: string[] = [];

    if (!fs.existsSync(this.dir)) return removed;

    const byTime = fs.readdirSync(this.dir)
      .filter(f => f.endsWith(".txt"))
      .map(f => {
        const p = path.join(this.dir, f);
        let age = 0;
        try { age = now - fs.statSync(p).mtimeMs; } catch { age = Infinity; }
        return { id: f.replace(/\.txt$/, ""), age };
      })
      .sort((a, b) => b.age - a.age); // oldest first

    // 1) Remove everything past its TTL.
    for (const { id, age } of byTime) {
      if (age > maxAgeMs) {
        this.delete(id);
        removed.push(id);
      }
    }

    // 2) If still over the count cap, drop oldest remainder first.
    const remaining = this.list();
    if (remaining.length > maxFiles) {
      const overflow = remaining.length - maxFiles;
      // list() is unordered; order by file mtime.
      const ordered = fs.readdirSync(this.dir)
        .filter(f => f.endsWith(".txt")).map(f => ({ f, p: path.join(this.dir, f) }))
        .sort((a, b) => fs.statSync(a.p).mtimeMs - fs.statSync(b.p).mtimeMs);
      for (let i = 0; i < overflow && i < ordered.length; i++) {
        this.delete(ordered[i].f.replace(/\.txt$/, ""));
        removed.push(ordered[i].f.replace(/\.txt$/, ""));
      }
    }

    return removed;
  }
}

// ─── OutputBudget (total calls / consecutive errors / total time) ────────

export interface OutputBudgetConfig {
  /** Max total external (web/API) calls before the budget stops. */
  maxCalls: number;
  /** Max consecutive errors before the budget stops (structured drain). */
  maxConsecutiveErrors: number;
  /** Max total wall time (ms) spent on external calls. */
  maxTotalTimeMs: number;
}

export const DEFAULT_OUTPUT_BUDGET: OutputBudgetConfig = {
  maxCalls: 50,
  maxConsecutiveErrors: 3,
  maxTotalTimeMs: 300_000, // 5 min
};

export type BudgetDecision =
  | { ok: true }
  | {
      ok: false;
      axis: "calls" | "errors" | "time";
      counts: { calls: number; consecutiveErrors: number; totalTimeMs: number };
      message: string;
    };

/**
 * Three-counter external-call budget (docs/architecture/runtime-orchestration.md).
 * Incremented by the harness on every external call; exhaustion returns a
 * STRUCTURED DIAGNOSTIC (never throws), so the main loop can continue and give
 * the best available answer.
 */
export class OutputBudget {
  private config: OutputBudgetConfig;
  private calls = 0;
  private consecutiveErrors = 0;
  private totalTimeMs = 0;
  private callExtensions: Array<{ by: number; reason: string; maxCallsAfter: number }> = [];

  constructor(config: Partial<OutputBudgetConfig> = {}) {
    this.config = { ...DEFAULT_OUTPUT_BUDGET, ...config };
  }

  /** Test before spending an external call. */
  check(): BudgetDecision {
    return this.checkCanStart();
  }

  /** Remaining total external-call time in ms, optionally including in-flight elapsed time. */
  remainingTimeMs(inFlightElapsedMs = 0): number {
    const elapsed = Math.max(0, Math.floor(inFlightElapsedMs));
    return Math.max(0, this.config.maxTotalTimeMs - this.totalTimeMs - elapsed);
  }

  /** Remaining external calls. */
  remainingCalls(): number {
    return Math.max(0, this.config.maxCalls - this.calls);
  }

  /** Configured call ceiling, including any approved elastic extensions. */
  maxCalls(): number {
    return this.config.maxCalls;
  }

  /**
   * Increase the call ceiling by a small audited amount.
   *
   * This is intentionally narrow: callers must decide eligibility before
   * calling it, and the budget records the reason so tests/reports can prove
   * an extension was bounded rather than an accidental unlimited retry loop.
   */
  extendCalls(by: number, reason: string): { applied: boolean; maxCalls: number } {
    const increment = Math.max(0, Math.floor(by));
    if (increment <= 0) return { applied: false, maxCalls: this.config.maxCalls };
    this.config = { ...this.config, maxCalls: this.config.maxCalls + increment };
    this.callExtensions.push({
      by: increment,
      reason: String(reason || "unspecified").slice(0, 240),
      maxCallsAfter: this.config.maxCalls,
    });
    return { applied: true, maxCalls: this.config.maxCalls };
  }

  /**
   * Test whether a new external call should start. `minRemainingTimeMs`
   * lets callers stop before launching a slow network operation that would
   * consume the wrap-up window.
   */
  checkCanStart(minRemainingTimeMs = 0, inFlightElapsedMs = 0): BudgetDecision {
    const elapsed = Math.max(0, Math.floor(inFlightElapsedMs));
    const projectedTotalTimeMs = this.totalTimeMs + elapsed;
    const counts = {
      calls: this.calls,
      consecutiveErrors: this.consecutiveErrors,
      totalTimeMs: projectedTotalTimeMs,
    };

    if (this.calls >= this.config.maxCalls) {
      return {
        ok: false, axis: "calls", counts,
        message: `External-call budget exhausted: ${this.calls}/${this.config.maxCalls} calls used. Returning best available evidence. 外部调用预算耗尽。`,
      };
    }
    if (this.consecutiveErrors >= this.config.maxConsecutiveErrors) {
      return {
        ok: false, axis: "errors", counts,
        message: `External-call budget stopped after ${this.consecutiveErrors} consecutive errors. Declining further calls. 连续错误过多，停止外部调用。`,
      };
    }
    return this.checkTimeRemaining(minRemainingTimeMs, elapsed);
  }

  /** Test only the time axis, useful for sub-operations inside an already allowed tool call. */
  checkTimeRemaining(minRemainingTimeMs = 0, inFlightElapsedMs = 0): BudgetDecision {
    const elapsed = Math.max(0, Math.floor(inFlightElapsedMs));
    const projectedTotalTimeMs = this.totalTimeMs + elapsed;
    const counts = {
      calls: this.calls,
      consecutiveErrors: this.consecutiveErrors,
      totalTimeMs: projectedTotalTimeMs,
    };
    if (projectedTotalTimeMs >= this.config.maxTotalTimeMs) {
      return {
        ok: false, axis: "time", counts,
        message: `External-call time budget exhausted: ${projectedTotalTimeMs}ms/${this.config.maxTotalTimeMs}ms. 外部调用总时长超限。`,
      };
    }
    const minTime = Math.max(0, Math.floor(minRemainingTimeMs));
    const remainingTime = this.remainingTimeMs(elapsed);
    if (minTime > 0 && remainingTime < minTime) {
      return {
        ok: false, axis: "time", counts,
        message: `External-call time budget too low to start another call: ${remainingTime}ms remaining, requires at least ${minTime}ms. Returning best available evidence. 外部调用剩余时间不足，停止继续请求。`,
      };
    }
    return { ok: true };
  }

  /** Record that an external call was made (before or after check()). */
  registerCall(): void {
    this.calls++;
  }

  /** Record a resolved external call's elapsed time. */
  registerElapsed(ms: number): void {
    this.totalTimeMs += ms;
  }

  /** Record a success (resets the consecutive-error streak). */
  registerSuccess(): void {
    this.consecutiveErrors = 0;
  }

  /** Record an error (increments the consecutive-error streak). */
  registerError(): void {
    this.consecutiveErrors++;
  }

  /** Reset all counters (e.g. new turn or manual recovery). */
  reset(): void {
    this.calls = 0;
    this.consecutiveErrors = 0;
    this.totalTimeMs = 0;
    this.callExtensions = [];
  }

  snapshot(): { calls: number; consecutiveErrors: number; totalTimeMs: number; maxCalls: number; callExtensions: Array<{ by: number; reason: string; maxCallsAfter: number }> } {
    return {
      calls: this.calls,
      consecutiveErrors: this.consecutiveErrors,
      totalTimeMs: this.totalTimeMs,
      maxCalls: this.config.maxCalls,
      callExtensions: this.callExtensions.map(item => ({ ...item })),
    };
  }
}

// ─── TurnBudget (≤20 turns per child context) ─────────────────────────────

export type TurnDecision =
  | { ok: true; remaining: number }
  | {
      ok: false;
      remaining: number;
      message: string;
    };

/**
 * Turn (round) budget — docs/architecture/runtime-orchestration.md. Default ≤20 turns for a
 * child context. On exhaustion the harness injects a "wrap-up" instruction so
 * the child does a final NON-TOOL answer (graceful degradation, not a hard kill).
 */
export class TurnBudget {
  private max: number;
  private used = 0;

  constructor(maxTurns: number = 20) {
    this.max = maxTurns;
  }

  /** Sink one used turn; returns whether a tool round is still allowed. */
  consume(): TurnDecision {
    this.used++;
    const remaining = Math.max(0, this.max - this.used);
    if (remaining <= 0) {
      return {
        ok: false, remaining: 0,
        message: `Turn budget exhausted (${this.used}/${this.max}). Do a final answer WITHOUT any tool calls. 轮次预算耗尽，请直接作答，不再调用工具。`,
      };
    }
    return { ok: true, remaining };
  }

  reset(maxTurns: number = this.max): void {
    this.max = Math.max(1, Math.floor(maxTurns));
    this.used = 0;
  }

  get usedTurns(): number { return this.used; }
  get remaining(): number { return Math.max(0, this.max - this.used); }
  get maxTurns(): number { return this.max; }
}

// ─── WallClockBudget (task deadline) ──────────────────────────────────────

export interface WallClockStart {
  deadlineMs: number;
}

export type WallClockDecision =
  | { ok: true; remainingMs: number }
  | { ok: false; remainingMs: number; message: string };

/**
 * Wall-clock deadline for a task (docs/architecture/runtime-orchestration.md). Sub-operations take
 * `min(config, remaining budget)` — the total is never exceeded. When the
 * deadline passes we return a structured "wrap up" decision, not an error.
 */
export class WallClockBudget {
  private readonly clock: BudgetClock;
  private startTimeMs: number;
  private budgetMs: number;
  private lastObservedNowMs: number;

  constructor(budgetMs: number, clock: BudgetClock = MONOTONIC_BUDGET_CLOCK) {
    this.clock = clock;
    this.budgetMs = budgetMs;
    this.startTimeMs = this.readNowMs();
    this.lastObservedNowMs = this.startTimeMs;
  }

  private readNowMs(): number {
    const observed = this.clock.nowMs();
    if (!Number.isFinite(observed)) return this.lastObservedNowMs ?? 0;
    if (this.lastObservedNowMs !== undefined && observed < this.lastObservedNowMs) return this.lastObservedNowMs;
    this.lastObservedNowMs = observed;
    return observed;
  }

  /** Remaining budget in ms (can go negative after the deadline passes). */
  remainingMs(): number {
    return this.budgetMs - (this.readNowMs() - this.startTimeMs);
  }

  /** True when the deadline has not yet passed. */
  hasRemaining(): boolean {
    return this.remainingMs() > 0;
  }

  /** The time slice an operation may take: min(desired, remaining). */
  slice(desiredMs: number): number {
    return Math.max(0, Math.min(desiredMs, this.remainingMs()));
  }

  /** Check the deadline; returns a wrap-up diagnostic when exhausted. */
  check(): WallClockDecision {
    const remaining = this.remainingMs();
    if (remaining <= 0) {
      return {
        ok: false, remainingMs: 0,
        message: `Task wall-clock deadline exceeded. Provide the best final answer now (degraded wrap-up). 任务超时，请尽快给出降级收尾回答。`,
      };
    }
    return { ok: true, remainingMs: remaining };
  }

  reset(budgetMs: number = this.budgetMs): void {
    this.budgetMs = budgetMs;
    this.startTimeMs = this.readNowMs();
  }

  get configuredBudgetMs(): number {
    return this.budgetMs;
  }
}

// ─── CapOrSpillHarness — wiring entry point ───────────────────────────────

export interface CapOrSpillHarnessOptions {
  /** Spill store (default: pi-data/spill). */
  spillStore?: SpillStore;
  /** Spill threshold bytes (default 1 MiB). */
  thresholdBytes?: number;
  /** OutputBudget to drive; when undefined, harness creates one. */
  outputBudget?: OutputBudget;
  /** TurnBudget; when undefined, harness creates one. */
  turnBudget?: TurnBudget;
  /** WallClockBudget; when undefined, no wall-clock deadline is enforced. */
  wallClock?: WallClockBudget;
}

/**
 * Creates the capOrSpill harness: the tool_result hook that rewrites oversized
 * tool outputs into spill references, and exposes the budget dials to the
 * control plane. Deterministic, no-LLM.
 */
export function createCapOrSpillHarness(options: CapOrSpillHarnessOptions = {}) {
  const spillStore = options.spillStore ?? new SpillStore(path.join(process.cwd(), "pi-data", "spill"));
  const thresholdBytes = options.thresholdBytes ?? DEFAULT_SPILL_THRESHOLD_BYTES;
  const outputBudget = options.outputBudget ?? new OutputBudget();
  const turnBudget = options.turnBudget ?? new TurnBudget();
  const wallClock = options.wallClock;

  return {
    spillStore,
    outputBudget,
    turnBudget,
    wallClock,

    /**
     * pi tool_result hook: cap-or-spill every tool result.
     *
     * pi's ToolResultEvent carries the finalized result as
     * `content: (TextContent | ImageContent)[]` (see pi-coding-agent
     * extensions/types.d.ts). The text parts are concatenated; when the
     * total exceeds the threshold the full text is written to the spill
     * store and `{ content }` is returned so pi replaces what the model
     * sees with a bounded preview + disk reference (ToolResultEventResult
     * shape). Returns undefined when the result fits within the cap
     * (pass-through).
     *
     * (2026-08-15: rewritten against the real SDK event shape. The crash-era
     * version read `event.tool_call_result.result`, a field that does not
     * exist on ToolResultEvent, so the hook silently never capped anything.)
     */
    async onToolResult(event: any, _ctx: any) {
      const content = event?.content;
      if (!Array.isArray(content) || content.length === 0) return undefined;

      let text = "";
      for (const part of content) {
        if (part && part.type === "text" && typeof part.text === "string") {
          text += part.text;
        }
      }
      if (!text) return undefined; // image-only (or empty) results pass through

      const out = spillStore.write(text, thresholdBytes);
      if (!out.spilled) return undefined; // fits → no rewrite

      // pi REPLACES event.content with the returned array — preserve all
      // non-text parts (e.g. images) or they would be silently dropped.
      // pi 会用返回数组整体替换 content——保留非文本部分（如图像），否则会丢。
      const nonText = content.filter((p: any) => !(p && p.type === "text"));
      return {
        content: [...nonText, { type: "text" as const, text: formatSpillPreview(out) }],
      };
    },

    /**
     * wrapper for an external call that respects the OutputBudget.
     */
    async withExternalCall<T>(fn: () => Promise<T>): Promise<BudgetDecision | T> {
      const d = outputBudget.check();
      if (!d.ok) {
        // Do not consume a call for a denied operation (so recovery is possible).
        return d;
      }
      outputBudget.registerCall();
      const start = Date.now();
      try {
        const r = await fn();
        outputBudget.registerElapsed(Date.now() - start);
        outputBudget.registerSuccess();
        return r;
      } catch (err) {
        outputBudget.registerElapsed(Date.now() - start);
        outputBudget.registerError();
        throw err;
      }
    },

    /** Record a turn was used; returns the TurnDecision. */
    consumeTurn(): TurnDecision {
      return turnBudget.consume();
    },

    /** Check the wall clock; returns the WallClockDecision. */
    checkWallClock(): WallClockDecision | undefined {
      return wallClock ? wallClock.check() : undefined;
    },

    /** GC the spill store (call periodically or on session end). */
    gcSpillStore(options?: { maxFiles?: number; maxAgeMs?: number }): string[] {
      return spillStore.gc(options);
    },
  };
}
