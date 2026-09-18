/**
 * =============================================================================
 * Canvast — Intent Signal Types / Canvast 源文件
 * =============================================================================
 * @file        src/harness/intent-signals/types.ts
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

export type WebUsePolicy = "not_needed" | "conditional" | "required";
export type FollowUpPolicy = "none" | "sidecar" | "status" | "task_adjustment" | "redirect" | "pause";

export interface TermHits {
  count: number;
  hits: string[];
}

export interface IntentSignals {
  normalized: string;
  intentText: string;
  plan: TermHits;
  complexity: TermHits;
  subagents: TermHits;
  workflow: TermHits;
  web: TermHits;
  context: TermHits;
  taskControl: TermHits;
  temporal: TermHits;
  listShape: boolean;
  longPrompt: boolean;
  readOnlyIntent: boolean;
  planOnlyIntent: boolean;
  promptLocalCodeAnalysis: boolean;
  promptLocalContextValidation: boolean;
  promptLocalSubagentValidation: boolean;
  promptLocalEnhancedValidation: boolean;
  externalSourceAnswerIntent: boolean;
  standaloneAdvisoryIntent: boolean;
  ambiguousOptimizationIntent: boolean;
  localScanLike: boolean;
  localSearchLike: boolean;
  webUsePolicy: WebUsePolicy;
  followUpPolicy: FollowUpPolicy;
  followUp: TermHits;
  requiresTaskAdjustment: boolean;
  stateChangingTask: boolean;
}
