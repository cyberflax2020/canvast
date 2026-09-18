/**
 * =============================================================================
 * Canvast — Grounding Budget / Canvast 源文件
 * =============================================================================
 * @file        src/harness/grounding-budget.ts
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import type { GroundingStrategy } from "./grounding-policy.js";
import { externalEvidenceCallLimit } from "./web-policy.js";

export function alignGroundingStrategyToPromptBudget(
  prompt: string,
  strategy: GroundingStrategy | undefined,
): GroundingStrategy | undefined {
  if (!strategy) return undefined;
  const explicitLimit = externalEvidenceCallLimit(prompt);
  if (explicitLimit === undefined) {
    if (strategy.maxExternalCalls === undefined) return strategy;
    const next: GroundingStrategy = { ...strategy };
    delete next.maxExternalCalls;
    return next;
  }
  if (strategy.maxExternalCalls === undefined || strategy.maxExternalCalls <= explicitLimit) {
    return strategy;
  }
  return { ...strategy, maxExternalCalls: explicitLimit };
}
