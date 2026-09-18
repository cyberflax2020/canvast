/**
 * =============================================================================
 * Canvast — Prompt Local Validation / Canvast 源文件
 * =============================================================================
 * @file        src/harness/prompt-local-validation.ts
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
/**
 * Guard self-contained evidence-validation prompts against tool drift.
 */

export interface PromptLocalValidationAssessment {
  promptLocalContextValidation?: boolean;
  promptLocalSubagentValidation?: boolean;
  promptLocalEnhancedValidation?: boolean;
}

export interface PromptLocalValidationBlock {
  block: boolean;
  reason?: string;
}

export function isPromptLocalValidation(assessment: PromptLocalValidationAssessment | undefined): boolean {
  return Boolean(assessment?.promptLocalContextValidation || assessment?.promptLocalSubagentValidation || assessment?.promptLocalEnhancedValidation);
}

export function renderPromptLocalValidationPrompt(assessment: PromptLocalValidationAssessment): string {
  if (!isPromptLocalValidation(assessment)) return "";
  const evidenceKind = assessment.promptLocalEnhancedValidation ? "enhanced architecture" : assessment.promptLocalSubagentValidation ? "sub-agent" : "context";
  return [
    "## Canvast Prompt-Local Evidence Validation",
    "",
    `Detected ${evidenceKind} evidence validation that is fully self-contained in the user prompt.`,
    "Answer directly from the prompt only.",
    "Do not call tools: no repository read/search, no shell, no web, no sub-agent, no workflow, no Canvas/task writes.",
    "If the prompt asks for a required evidence JSON line, include that line in the final answer.",
    "",
    "中文：这是自包含验证题。只根据用户 prompt 作答，不调用任何工具；按要求输出证据 JSON 行。",
  ].join("\n");
}

export function shouldBlockPromptLocalValidationTool(
  assessment: PromptLocalValidationAssessment | undefined,
  toolName: string,
): PromptLocalValidationBlock | undefined {
  if (!isPromptLocalValidation(assessment)) return undefined;
  return {
    block: true,
    reason: `Prompt-local evidence validation must be answered from the user prompt only; tool ${toolName || "(unknown)"} is not allowed. / 自包含验证题只能根据用户 prompt 作答，不允许调用工具。`,
  };
}
