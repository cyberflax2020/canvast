/**
 * =============================================================================
 * Canvast — Intent Signal Classifiers / Canvast 源文件
 * =============================================================================
 * @file        src/harness/intent-signals/classifiers.ts
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import { hasAny, hasOrderedTermsWithin } from "./text.js";
import type { FollowUpPolicy, TermHits, WebUsePolicy } from "./types.js";

export function needsPackageDomain(normalized: string): boolean {
  const packagingTerms = ["package", "deliver", "ship", "archive", "打包", "交付", "归档"];
  if (hasAny(normalized, packagingTerms)) return true;
  const releaseDocs =
    hasOrderedTermsWithin(normalized, ["release"], ["doc", "docs", "documentation", "note", "notes", "文档", "说明", "日志"], 24) ||
    hasOrderedTermsWithin(normalized, ["发布"], ["文档", "说明", "日志"], 8);
  return !releaseDocs && hasAny(normalized, ["release", "发布"]);
}

export function classifyWebUse(input: {
  explicitWeb: TermHits;
  explicitExternalResources: TermHits;
  currentFacts: TermHits;
  liveFacts: TermHits;
  temporal: TermHits;
  evidenceContract: TermHits;
}): WebUsePolicy {
  if (input.explicitWeb.count > 0) return "required";
  if (input.explicitExternalResources.count > 0) return "required";
  if (input.liveFacts.count > 0) return "required";
  if (input.currentFacts.count > 0) return "required";
  if (input.evidenceContract.count > 0) return "required";
  if (input.temporal.count > 0 && input.liveFacts.count > 0) return "required";
  return "not_needed";
}

export function classifyFollowUp(input: {
  text: string;
  followUp: TermHits;
  status: TermHits;
  adjustment: TermHits;
  critical: TermHits;
  redirect: TermHits;
  pause: TermHits;
}): FollowUpPolicy {
  if (input.pause.count > 0) return "pause";
  if (input.redirect.count > 0) return "redirect";
  if (input.adjustment.count > 0) return "task_adjustment";
  if (input.followUp.count > 0 && input.critical.count > 0) return "task_adjustment";
  if (input.status.count > 0) return "status";
  if (input.followUp.count > 0) return "sidecar";
  return "none";
}
