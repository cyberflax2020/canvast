/**
 * =============================================================================
 * Canvast — Harness: Context Budgeting / 上下文预算控制
 * =============================================================================
 * @file        src/harness/context-budgeting.ts
 * @brief       Hard ceiling on context tokens, dynamically adjusted by Canvas scope
 * @description Allocates context from the active model capability profile.
 *              Canvas scoping reduces waste by only loading relevant context,
 *              not dumping entire conversation history.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * Changes: [2026-08-08] Initial implementation
 * =============================================================================
 */

import {
  modelBudgetDefaults,
  resolveModelCapabilities,
  type ModelCapabilities,
} from "./model-capabilities.js";

export interface ContextBudget {
  systemPrompt: number;     // ~3K, fixed
  canvasScope: number;      // ~2-5K, from Canvas query
  recentHistory: number;    // ~5-10K, rolling window
  taskFiles: number;        // ~5-10K, relevance-ranked
}

export const DEFAULT_BUDGET: ContextBudget = {
  systemPrompt: 3000,
  canvasScope: 5000,
  recentHistory: 10000,
  taskFiles: 10000,
};

/** Legacy conservative ceiling kept for API compatibility. Runtime defaults are model-derived. */
export const HARD_CEILING = 28000;

export interface ContextBudgetOptions {
  /** Override hard ceiling (e.g., from a model profile or dynamic config). */
  hardCeiling?: number;
  /** Override system prompt allocation. */
  systemPromptTokens?: number;
  /** Override canvas scope max. */
  canvasScopeMax?: number;
  /** Minimum rolling history window to preserve. */
  recentHistoryMin?: number;
  /** Override max files. */
  maxFiles?: number;
  /** Override per-file token budget. */
  perFileTokens?: number;
  /** Already-resolved model capability profile. */
  capabilities?: ModelCapabilities;
  /** Resolve capabilities from a specific env for tests or embedded runners. */
  env?: NodeJS.ProcessEnv;
}

export function contextBudgetOptionsFromModel(
  capabilities: ModelCapabilities = resolveModelCapabilities(),
): Required<Pick<
  ContextBudgetOptions,
  "hardCeiling" | "canvasScopeMax" | "recentHistoryMin" | "maxFiles" | "perFileTokens"
>> {
  return modelBudgetDefaults(capabilities);
}

/**
 * Allocate context budget based on task characteristics.
 * Tasks with more Canvas scope get less history (and vice versa).
 */
export function allocateBudget(
  canvasScopeTokens: number,
  fileCount: number,
  options: ContextBudgetOptions = {},
): ContextBudget {
  const modelDefaults = contextBudgetOptionsFromModel(
    options.capabilities ?? resolveModelCapabilities({ env: options.env }),
  );
  const ceiling = options.hardCeiling ?? modelDefaults.hardCeiling;
  const sysTokens = options.systemPromptTokens ?? DEFAULT_BUDGET.systemPrompt;
  const scopeMax = options.canvasScopeMax ?? modelDefaults.canvasScopeMax;
  const historyMin = options.recentHistoryMin ?? modelDefaults.recentHistoryMin;
  const maxFiles = options.maxFiles ?? modelDefaults.maxFiles;
  const perFile = options.perFileTokens ?? modelDefaults.perFileTokens;

  const budget: ContextBudget = {
    systemPrompt: sysTokens,
    canvasScope: Math.min(canvasScopeTokens, scopeMax),
    recentHistory: 0,
    taskFiles: Math.min(fileCount, maxFiles) * perFile,
  };

  // History: remaining budget after system + canvas + files
  const used = budget.systemPrompt + budget.canvasScope + budget.taskFiles;
  budget.recentHistory = Math.max(historyMin, ceiling - used);

  return budget;
}

/**
 * Check if adding more context would exceed the hard ceiling.
 * If so, suggest compaction or scope reduction.
 */
export function checkBudget(
  currentTokens: number,
  additionalTokens: number,
  ceiling?: number,
): {
  withinBudget: boolean;
  remainingTokens: number;
  suggestion?: string;
} {
  const effectiveCeiling = ceiling ?? modelBudgetDefaults(resolveModelCapabilities()).hardCeiling;
  const total = currentTokens + additionalTokens;
  const remaining = effectiveCeiling - currentTokens;

  if (total <= effectiveCeiling) {
    return { withinBudget: true, remainingTokens: remaining };
  }

  // Over budget — suggest actions
  const overBy = total - effectiveCeiling;
  const suggestion = [
    `Context budget exceeded by ${overBy} tokens (ceiling: ${effectiveCeiling}).`,
    "Consider:",
    "- Compacting conversation history",
    "- Reducing Canvas scope depth",
    "- Limiting task files to the model-derived file budget",
    "- Splitting the task into smaller sub-tasks",
  ].join("\n");

  return { withinBudget: false, remainingTokens: remaining, suggestion };
}

/**
 * Estimate token count from text content.
 * Rough heuristic: EN ~4 chars/token, CJK ~2 chars/token.
 *
 * Fast path: single-pass char scan avoids allocating a regex match array,
 * which is significant when called on large texts or in hot loops.
 */
export function estimateTokens(text: string): number {
  let enChars = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // ASCII letters/digits/whitespace/common punctuation count as "EN".
    if (
      (code >= 48 && code <= 57) ||   // 0-9
      (code >= 65 && code <= 90) ||   // A-Z
      (code >= 97 && code <= 122) ||  // a-z
      code === 32 ||                  // space
      (code >= 9 && code <= 13) ||    // \t \n \v \f \r
      code === 44 || code === 46 || code === 59 || code === 58 || // , . ; :
      code === 33 || code === 63 ||   // ! ?
      code === 45 || code === 95 ||   // - _
      code === 47 || code === 40 || code === 41 || // / ( )
      code === 91 || code === 93 ||   // [ ]
      code === 123 || code === 125 || // { }
      code === 39 || code === 34 ||   // ' "
      code === 96                       // `
    ) {
      enChars++;
    }
  }
  const otherChars = text.length - enChars;
  return Math.ceil(enChars / 4 + otherChars / 2);
}

/**
 * Trim conversation history to fit within budget.
 * Keeps most recent turns, summarized older turns.
 */
export function trimHistoryToBudget(
  messages: Array<{ content: string; estimatedTokens: number }>,
  budgetTokens: number,
): Array<{ content: string; estimatedTokens: number }> {
  let used = 0;
  const kept: Array<{ content: string; estimatedTokens: number }> = [];

  // Walk backwards (most recent first)
  for (let i = messages.length - 1; i >= 0; i--) {
    if (used + messages[i].estimatedTokens <= budgetTokens) {
      kept.unshift(messages[i]);
      used += messages[i].estimatedTokens;
    } else {
      break; // older messages don't fit
    }
  }

  return kept;
}
