/**
 * =============================================================================
 * Canvast — Auto Orchestrator Assessment / Canvast 源文件
 * =============================================================================
 * @file        src/harness/auto-orchestrator/assessment.ts
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import { createHash } from "node:crypto";
import { assessPromptIntent } from "../intent-signals.js";
import { inferToolDomains } from "../tool-domains.js";
import {
  hasApprovedPlanStepExecutionIntent,
  hasExplicitPlanModeIntent,
  hasRecoveredPlanStepExecutionIntent,
  isPlanProposalIntent,
  isPureTaskTrackingIntent,
  isPlanResearchProposalIntent,
  isSimpleWriteVerification,
} from "../tool-intent.js";
import type {
  AutoOrchestrationAssessment,
  OrchestrationMode,
} from "./types.js";
import { hasExplicitAgentLaunchSignal } from "./tool-strategy.js";

function hashPrompt(prompt: string): string {
  return createHash("sha1").update(prompt).digest("hex").slice(0, 12);
}

function hasPromptProvidedStateSnapshot(normalized: string): boolean {
  return [
    "snapshot",
    "provided",
    "given",
    "state snapshot",
    "plan state",
    "task state",
    "快照",
    "下面是",
    "用户提供",
    "计划状态",
    "任务状态",
  ].some(term => normalized.includes(term));
}

export function assessAutoOrchestration(
  prompt: string,
  now = new Date().toISOString(),
): AutoOrchestrationAssessment {
  const signals = assessPromptIntent(prompt);
  const {
    normalized,
    plan,
    complexity,
    subagents,
    workflow,
    web,
    context,
    taskControl,
    temporal,
    listShape,
    longPrompt,
    readOnlyIntent,
    planOnlyIntent,
    promptLocalContextValidation,
    promptLocalSubagentValidation,
    promptLocalEnhancedValidation,
    externalSourceAnswerIntent,
    localScanLike,
    localSearchLike,
    webUsePolicy,
    followUpPolicy,
    followUp,
    requiresTaskAdjustment,
    ambiguousOptimizationIntent,
    stateChangingTask,
  } = signals;
  const approvedPlanStepExecution = hasApprovedPlanStepExecutionIntent(normalized);
  const recoveredPlanStepExecution = hasRecoveredPlanStepExecutionIntent(normalized);
  const boundedExistingPlanStepExecution = approvedPlanStepExecution || recoveredPlanStepExecution;
  const pureTaskTracking = isPureTaskTrackingIntent(normalized);
  const promptLocalValidation = promptLocalContextValidation || promptLocalSubagentValidation || promptLocalEnhancedValidation;
  const directExternalSourceAnswer = externalSourceAnswerIntent && webUsePolicy !== "not_needed";
  const effectiveRequiresTaskAdjustment = (boundedExistingPlanStepExecution || pureTaskTracking || promptLocalValidation) ? false : requiresTaskAdjustment;

  const complexityScore =
    ((promptLocalValidation || directExternalSourceAnswer) ? 0 : plan.count) +
    ((promptLocalValidation || directExternalSourceAnswer) ? 0 : complexity.count * 2) +
    ((promptLocalValidation || directExternalSourceAnswer) ? 0 : subagents.count * 2) +
    ((promptLocalValidation || directExternalSourceAnswer) ? 0 : workflow.count * 2) +
    (!promptLocalValidation && !directExternalSourceAnswer && listShape ? 2 : 0) +
    (!promptLocalValidation && !directExternalSourceAnswer && longPrompt ? 1 : 0);

  const simpleWriteVerification = isSimpleWriteVerification({
    normalized,
    planCount: plan.count,
    complexityCount: complexity.count,
    subagentCount: subagents.count,
    workflowCount: workflow.count,
    listShape,
    longPrompt,
    readOnlyIntent,
    planOnlyIntent,
    localScanLike,
    requiresTaskAdjustment: effectiveRequiresTaskAdjustment,
    taskControlLike: taskControl.count > 0,
  });
  const explicitPlanMode = hasExplicitPlanModeIntent(normalized);
  const planResearchProposal = isPlanResearchProposalIntent(normalized);
  const planProposalIntent = isPlanProposalIntent(normalized);
  const planRevisionFromProvidedState =
    planProposalIntent &&
    readOnlyIntent &&
    taskControl.count > 0 &&
    hasPromptProvidedStateSnapshot(normalized);
  const requiresWorkflow = !pureTaskTracking && !promptLocalValidation && !directExternalSourceAnswer && (workflow.count >= 2 || (complexity.count >= 3 && plan.count >= 2) || (listShape && complexity.count >= 2));
  const requiresSubagents = !pureTaskTracking && !promptLocalValidation && !directExternalSourceAnswer && (subagents.count >= 2 || (listShape && subagents.count >= 1) || hasExplicitAgentLaunchSignal(subagents.hits));
  const requiresPlan = !simpleWriteVerification && (
    (explicitPlanMode && !pureTaskTracking && !promptLocalValidation && !directExternalSourceAnswer) ||
    (planProposalIntent && !pureTaskTracking && !promptLocalValidation && !directExternalSourceAnswer) ||
    (planOnlyIntent && !promptLocalValidation && !directExternalSourceAnswer) ||
    (!pureTaskTracking && !promptLocalValidation && !directExternalSourceAnswer && readOnlyIntent && localScanLike && plan.count >= 1) ||
    (!pureTaskTracking && !promptLocalValidation && !directExternalSourceAnswer && plan.count >= 1 && (complexityScore >= 4 || longPrompt || listShape))
  );
  const requiresLocalSearchStrategy =
    !pureTaskTracking &&
    !promptLocalValidation &&
    !directExternalSourceAnswer &&
    !requiresPlan &&
    !requiresSubagents &&
    !requiresWorkflow &&
    readOnlyIntent &&
    localSearchLike;
  const rawRequiresContextManagement =
    context.count >= 1 ||
    followUpPolicy !== "none" ||
    requiresWorkflow ||
    (!readOnlyIntent && longPrompt && (requiresPlan || requiresSubagents));
  const requiresContextManagement = (
    boundedExistingPlanStepExecution ||
    pureTaskTracking ||
    promptLocalValidation ||
    planRevisionFromProvidedState
  ) ? false : rawRequiresContextManagement;
  const requiresGate =
    requiresWorkflow ||
    requiresSubagents ||
    requiresPlan ||
    requiresContextManagement ||
    effectiveRequiresTaskAdjustment ||
    pureTaskTracking ||
    requiresLocalSearchStrategy ||
    ambiguousOptimizationIntent ||
    (stateChangingTask && !(simpleWriteVerification && taskControl.count === 0)) ||
    webUsePolicy !== "not_needed";
  const mode: OrchestrationMode = requiresWorkflow
    ? "workflow"
    : requiresSubagents
      ? "subagents"
      : requiresPlan
        ? "plan"
        : "direct";
  const { requiredToolDomains, optionalToolDomains } = inferToolDomains({
    normalized,
    requiresGate,
    requiresPlan,
    requiresSubagents,
    requiresWorkflow,
    webUsePolicy,
    requiresTaskAdjustment: effectiveRequiresTaskAdjustment,
    stateChangingTask,
    readOnlyIntent,
    planOnlyIntent,
    localScanLike,
    ambiguousOptimizationIntent,
    requiresContextManagement,
    taskControlLike: taskControl.count > 0,
    planResearchProposal,
    planProposalIntent,
    planRevisionFromProvidedState,
    simpleWriteVerification,
    promptLocalContextValidation,
    localSearchLike,
  });

  const triggers = [
    ...plan.hits.map(h => `plan:${h}`),
    ...complexity.hits.map(h => `complexity:${h}`),
    ...subagents.hits.map(h => `subagent:${h}`),
    ...workflow.hits.map(h => `workflow:${h}`),
    ...web.hits.map(h => `web:${h}`),
    ...context.hits.map(h => `context:${h}`),
    ...taskControl.hits.map(h => `task-control:${h}`),
    ...followUp.hits.map(h => `follow-up:${h}`),
    ...temporal.hits.map(h => `time:${h}`),
    ...(effectiveRequiresTaskAdjustment ? ["task:adjustment"] : []),
    ...(ambiguousOptimizationIntent ? ["task:ambiguous-optimization"] : []),
    ...(requiresLocalSearchStrategy ? ["tool:local-search-strategy"] : []),
    ...(explicitPlanMode ? ["plan-mode:explicit"] : []),
    ...(planResearchProposal ? ["plan-mode:research-proposal"] : []),
    ...(planProposalIntent ? ["plan-mode:proposal"] : []),
    ...(recoveredPlanStepExecution ? ["plan-mode:recovered-step-execution"] : []),
    ...(pureTaskTracking ? ["scope:task-tracking-only"] : []),
    ...(promptLocalContextValidation ? ["scope:prompt-local-context-validation"] : []),
    ...(promptLocalSubagentValidation ? ["scope:prompt-local-subagent-validation"] : []),
    ...(promptLocalEnhancedValidation ? ["scope:prompt-local-enhanced-validation"] : []),
    ...(readOnlyIntent ? ["scope:read-only"] : []),
    ...(listShape ? ["shape:list"] : []),
    ...(longPrompt ? ["shape:long"] : []),
  ];

  return {
    id: `auto_${hashPrompt(prompt)}`,
    prompt,
    mode,
    requiresGate,
    requiresPlan,
    requiresSubagents,
    requiresWorkflow,
    complexityScore,
    triggers: Array.from(new Set(triggers)),
    requiredToolDomains,
    optionalToolDomains,
    webUsePolicy,
    webTriggers: Array.from(new Set(web.hits)),
    planOnlyIntent,
    requiresContextManagement,
    contextTriggers: Array.from(new Set(context.hits)),
    followUpPolicy,
    followUpTriggers: Array.from(new Set(followUp.hits)),
    requiresTaskAdjustment: effectiveRequiresTaskAdjustment,
    ambiguousOptimizationIntent,
    planProposalIntent,
    localSearchLike,
    requiresLocalSearchStrategy,
    simpleWriteVerification,
    promptLocalContextValidation,
    promptLocalSubagentValidation,
    promptLocalEnhancedValidation,
    externalSourceAnswerIntent,
    createdAt: now,
  };
}
