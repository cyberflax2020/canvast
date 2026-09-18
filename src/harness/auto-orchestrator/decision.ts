/**
 * =============================================================================
 * Canvast — Auto Orchestrator Decision / Canvast 源文件
 * =============================================================================
 * @file        src/harness/auto-orchestrator/decision.ts
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import {
  groundingRequiresExternalEvidence,
  hasUsableGroundingStrategy,
  validateGroundingStrategy,
} from "../grounding-policy.js";
import { alignGroundingStrategyToPromptBudget } from "../grounding-budget.js";
import { hasDependencyInstallIntent } from "../tool-intent.js";
import { hasConcreteWebJustification } from "../web-policy.js";
import {
  agentPlanTools,
  hasContextContinuityTrigger,
  hasNoShellConstraint,
  namesContextRecallSource,
  normalizeToolName,
  requiresParallelAgentsTool,
  resumePlanPreservesActiveWork,
} from "../auto-orchestrator-constraints.js";
import type {
  AutoOrchestrationAssessment,
  ContextInputSource,
  ContextInputSourceKind,
  RecordedOrchestrationDecision,
  ToolDomain,
} from "./types.js";
import {
  decisionRequiresWebPlan,
  defaultToolPlanItem,
  hasDedicatedLocalSearchTool,
  hasWebEvidenceReason,
  isLifecycleModeCompatible,
  minimumSubagentTasks,
  MODE_RANK,
  requiredToolDomainsForDecision,
  shellOnlyLocalSearchTools,
  structuralModeRequiresPlanSteps,
  structuralModeRequiresSubagentTasks,
  structuralModeRequiresWorkflowSteps,
  toolPlanDomains,
  toolPlanToolMatchesDomain,
} from "./tool-strategy.js";
import { batchCandidateHash } from "./batch-admission.js";

export function normalizeRecordedDecision(
  assessment: AutoOrchestrationAssessment,
  input: Omit<RecordedOrchestrationDecision, "assessmentId" | "recordedAt">,
): Omit<RecordedOrchestrationDecision, "assessmentId" | "recordedAt"> {
  const groundingStrategy = alignGroundingStrategyToPromptBudget(assessment.prompt, input.groundingStrategy);
  const alignedInput = { ...input, groundingStrategy };
  const requiredToolDomains = requiredToolDomainsForDecision(assessment, alignedInput);
  const forbiddenPlanOnlyDomains = new Set<ToolDomain>(["local_search", "file_read", "file_write", "shell"]);
  const toolCallPlan = (input.toolCallPlan || []).filter(item =>
    !assessment.planOnlyIntent || !forbiddenPlanOnlyDomains.has(item.domain),
  );
  const planned = toolPlanDomains(toolCallPlan);
  if (decisionRequiresWebPlan(alignedInput) && !planned.has("web")) {
    toolCallPlan.push(defaultToolPlanItem("web", alignedInput.webJustification));
    planned.add("web");
  }
  for (const domain of requiredToolDomains) {
    if (!planned.has(domain)) {
      toolCallPlan.push(defaultToolPlanItem(domain, alignedInput.webJustification));
      planned.add(domain);
    }
  }
  const localSearchUsesRead = toolCallPlan
    .filter(item => item.domain === "local_search")
    .flatMap(item => item.tools)
    .map(normalizeToolName)
    .includes("read");
  if (localSearchUsesRead && !planned.has("file_read")) {
    toolCallPlan.push({
      domain: "file_read",
      tools: ["read"],
      purpose: "Read exact files or snippets referenced by the local_search strategy.",
      order: "before_edit",
      parallelSafe: true,
    });
    planned.add("file_read");
  }
  return { ...alignedInput, toolCallPlan };
}

export function validateRecordedDecision(
  assessment: AutoOrchestrationAssessment,
  decision: Omit<RecordedOrchestrationDecision, "assessmentId" | "recordedAt">,
): string[] {
  const errors: string[] = [];
  if (decision.batchPlan) {
    const batch = decision.batchPlan;
    if (!batch.batchId.trim()) errors.push("batch_plan.batch_id is required");
    if (!Number.isSafeInteger(batch.revision) || batch.revision < 0) {
      errors.push("batch_plan.revision must be a non-negative safe integer");
    }
    if (!batch.admittedAt.trim() || !Number.isFinite(Date.parse(batch.admittedAt))) {
      errors.push("batch_plan.admitted_at must be an ISO timestamp");
    }
    if (batch.items.length < 1) errors.push("batch_plan.items must include every checkpoint candidate");
    const ids = new Set<string>();
    for (const item of batch.items) {
      if (!item.id.trim() || ids.has(item.id)) errors.push(`batch_plan contains an invalid or duplicate id: ${item.id || "(empty)"}`);
      ids.add(item.id);
      if (!item.requestId.trim()) errors.push(`batch_plan item ${item.id || "(empty)"} requires request_id`);
      if (!Number.isSafeInteger(item.sequence) || item.sequence < 0) errors.push(`batch_plan item ${item.id || "(empty)"} has an invalid sequence`);
      if (!item.timestamp.trim() || !Number.isFinite(Date.parse(item.timestamp))) errors.push(`batch_plan item ${item.id || "(empty)"} has an invalid timestamp`);
      if (item.policy === "defer" && !item.deferInfo?.reasonCode.trim()) errors.push(`batch_plan deferred item ${item.id || "(empty)"} requires a reason_code`);
    }
    const canonicalCandidates = [...batch.items]
      .sort((left, right) => left.sequence - right.sequence || left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id))
      .map(item => ({ id: item.id, requestId: item.requestId, sequence: item.sequence, timestamp: item.timestamp, status: item.status }));
    if (batchCandidateHash(canonicalCandidates) !== batch.candidateHash) {
      errors.push("batch_plan.candidate_hash does not match its exact candidate manifest");
    }
  }
  const requiredToolDomains = requiredToolDomainsForDecision(assessment, decision);
  if (!decision.taskSummary?.trim()) errors.push("task_summary is required");
  if (!decision.rationale?.trim()) errors.push("rationale is required");
  const requiresObservableSummary =
    assessment.requiresPlan ||
    assessment.requiresSubagents ||
    assessment.requiresWorkflow ||
    assessment.requiresContextManagement ||
    assessment.requiresTaskAdjustment;
  if (requiresObservableSummary && decision.observableReasoningSummary.length < 1) {
    errors.push("observable_reasoning_summary is required for automatic orchestration");
  }
  if ((assessment.requiresPlan || assessment.requiresSubagents || assessment.requiresWorkflow) && decision.observableReasoningSummary.length < 2) {
    errors.push("plan/sub-agent/workflow orchestration requires at least two observable_reasoning_summary items");
  }
  const planDomains = toolPlanDomains(decision.toolCallPlan);
  if (assessment.externalSourceAnswerIntent) {
    for (const domain of planDomains) {
      if (["local_search", "file_read", "file_write", "shell", "task", "agent", "workflow", "canvas"].includes(domain)) {
        errors.push("external source answer tasks must keep the recorded strategy to dedicated web/source evidence and final answer output unless the user explicitly asks for local or persistent project state");
        break;
      }
    }
  }
  if (assessment.planOnlyIntent) {
    for (const domain of planDomains) {
      if (["local_search", "file_read", "file_write", "shell"].includes(domain)) {
        errors.push("plan-only no-code requests must not plan repository inspection or mutation unless local evidence is explicitly requested");
        break;
      }
    }
  }
  if (structuralModeRequiresPlanSteps(assessment, decision) && decision.planSteps.length < 2) {
    errors.push("automatic plan mode requires at least two plan_steps");
  }
  const minSubagentTasks = minimumSubagentTasks(assessment);
  if (structuralModeRequiresSubagentTasks(assessment, decision) && decision.subagentTasks.length < minSubagentTasks) {
    errors.push(`automatic sub-agent mode requires at least ${minSubagentTasks} subagent_tasks or workflow mode`);
  }
  if (structuralModeRequiresWorkflowSteps(assessment, decision) && decision.workflowSteps.length < 2) {
    errors.push("automatic workflow mode requires at least two workflow_steps");
  }
  if (decision.mode === "direct" && decision.lifecycleAction !== "exit" && assessment.requiresGate && assessment.mode !== "direct") {
    errors.push(`direct mode is weaker than required ${assessment.mode} orchestration`);
  }
  if (!decision.lifecycleAction && MODE_RANK[decision.mode] < MODE_RANK[assessment.mode]) {
    errors.push(`mode ${decision.mode} is weaker than detected ${assessment.mode} orchestration`);
  }
  const needsLifecycleToolPlan = Boolean(decision.lifecycleAction && decision.lifecycleAction !== "exit" && decision.mode !== "direct");
  const minToolPlanItems = Math.max(1, Math.min(2, requiredToolDomains.length || (needsLifecycleToolPlan ? 1 : 0)));
  if ((assessment.requiresGate || needsLifecycleToolPlan) && decision.lifecycleAction !== "exit" && decision.toolCallPlan.length < minToolPlanItems) {
    errors.push("tool_call_plan must describe the required tool strategy");
  }
  for (const domain of requiredToolDomains) {
    if (!planDomains.has(domain)) errors.push(`tool_call_plan must cover required domain: ${domain}`);
  }
  if (assessment.requiresLocalSearchStrategy && !hasDedicatedLocalSearchTool(decision.toolCallPlan)) {
    errors.push("local_search strategy must include a dedicated search/list/read tool before any shell fallback");
  }
  if (assessment.requiresLocalSearchStrategy && planDomains.has("shell")) {
    errors.push("simple local_search tasks must use dedicated local_search tools and must not plan shell or sandbox grants as fallback");
  }
  if (requiresParallelAgentsTool(assessment) && !agentPlanTools(decision.toolCallPlan).has("parallel_agents")) {
    errors.push("explicit parallel_agents requests must plan the parallel_agents tool");
  }
  if (!isLifecycleModeCompatible(decision.lifecycleAction, decision.mode)) {
    errors.push("lifecycle_action must match the recorded mode: enter/switch use plan/subagents/workflow, update may revise the current direct or orchestration strategy, exit uses direct");
  }
  if (hasNoShellConstraint(assessment.prompt) && planDomains.has("shell")) {
    errors.push("user explicitly forbids shell execution, so shell must not be in tool_call_plan");
  }
  const lifecycleEntryOnly = Boolean(
    decision.lifecycleAction === "enter" &&
    decision.mode !== "direct" &&
    !planDomains.has("package"),
  );
  if (
    hasDependencyInstallIntent(assessment.prompt.toLowerCase()) &&
    !lifecycleEntryOnly &&
    (!planDomains.has("package") || !planDomains.has("shell"))
  ) {
    errors.push("package-manager dependency changes must plan both shell execution and package/dependency audit domains");
  }
  if (
    hasDependencyInstallIntent(assessment.prompt.toLowerCase()) &&
    !lifecycleEntryOnly &&
    decision.dependencyAudit?.isolatedCacheVerified !== true
  ) {
    errors.push("package-manager dependency changes must set dependency_audit.isolated_cache_verified=true");
  }
  if (assessment.requiresGate && decision.verificationSteps.length < 1) {
    errors.push("verification_steps are required before delivery");
  }
  if (assessment.webUsePolicy === "required" && decision.webUse === "not_needed") {
    errors.push("web_use cannot be not_needed when the prompt requires current/external web evidence");
  }
  if (decision.groundingStrategy) {
    errors.push(...validateGroundingStrategy(decision.groundingStrategy));
    if (decision.webUse === "not_needed" && groundingRequiresExternalEvidence(decision.groundingStrategy)) {
      errors.push("grounding_strategy requires external evidence, so web_use cannot be not_needed");
    }
  }
  if (decision.webUse !== "not_needed" && !hasWebEvidenceReason(decision)) {
    errors.push("web_justification or grounding_strategy must explain the current/external evidence need");
  }
  if (assessment.webUsePolicy === "not_needed" && decision.webUse !== "not_needed" && !hasWebEvidenceReason(decision)) {
    errors.push("web use was not inferred from the task; a strong explicit justification is required");
  }
  if (decision.webUse === "required" && !planDomains.has("web")) {
    errors.push("required web_use must include the web domain in tool_call_plan");
  }
  if (decision.webUse === "conditional" && !planDomains.has("web")) {
    errors.push("conditional web_use must include the web domain in tool_call_plan");
  }
  for (const item of decision.toolCallPlan) {
    if (item.tools.length === 0) {
      errors.push(`tool_call_plan item for ${item.domain} must name at least one tool`);
      continue;
    }
    const shellOnlyLocalTools = shellOnlyLocalSearchTools(item);
    if (shellOnlyLocalTools.length > 0) {
      errors.push(`local_search tools must be native pi tools (content_search/grep/find/ls/read), not shell-only commands: ${shellOnlyLocalTools.join(", ")}`);
    }
    if (
      item.domain === "shell" &&
      decision.groundingStrategy &&
      groundingRequiresExternalEvidence(decision.groundingStrategy) &&
      decision.webUse !== "not_needed" &&
      hasConcreteWebJustification(item.webJustification)
    ) {
      errors.push("grounding_strategy external evidence must use dedicated web tools; shell cannot be the evidence-fetching path");
    }
    if (!item.tools.every(tool => toolPlanToolMatchesDomain(tool, item.domain))) {
      errors.push(`tool_call_plan tools must match domain: ${item.domain}`);
    }
    if (item.domain === "web" && !hasConcreteWebJustification(item.webJustification || decision.webJustification) && !hasUsableGroundingStrategy(decision.groundingStrategy)) {
      errors.push("web tool plan items require a specific web justification");
      break;
    }
  }
  if (assessment.requiresContextManagement) {
    const strategy = decision.contextStrategy;
    if (!strategy) {
      errors.push("context_strategy is required for long, resumed, or multi-session orchestration");
    } else {
      if (!strategy.compressionTrigger?.trim()) {
        errors.push("context_strategy.compression_trigger is required");
      }
      if (!Array.isArray(strategy.recallSources) || strategy.recallSources.length < 1) {
        errors.push("context_strategy.recall_sources must include at least one source");
      }
      if (!Array.isArray(strategy.resumePlan) || strategy.resumePlan.length < 1) {
        errors.push("context_strategy.resume_plan must include at least one recovery step");
      }
      const needsResume =
        hasContextContinuityTrigger(assessment.contextTriggers) ||
        assessment.followUpPolicy !== "none";
      if (needsResume && !["recall", "resume", "compact"].includes(strategy.historyPolicy)) {
        errors.push("context_strategy.history_policy must support recall/resume when the prompt asks for session continuity");
      }
      if (!namesContextRecallSource(strategy.recallSources)) {
        errors.push("context_strategy.recall_sources must name Canvas, session history, summaries, or equivalent persisted memory");
      }
      if (!contextInputSourcesCoverRequiredLayers(strategy.inputSources)) {
        errors.push("context_strategy.input_sources must include session recent history and harness controls, and must either include or intentionally mark unavailable Canvas, recall/memory, and tools/skills context");
      }
      if (assessment.followUpPolicy !== "none") {
        if (!resumePlanPreservesActiveWork(strategy.resumePlan)) {
          errors.push("context_strategy.resume_plan must preserve or resume active work for follow-up requests");
        }
      }
    }
  }
  return errors;
}

function contextInputSourcesCoverRequiredLayers(inputSources: ContextInputSource[] | undefined): boolean {
  if (!inputSources) return false;
  const sources = new Map(inputSources.map(source => [source.kind, source]));
  const hasActive = (kind: ContextInputSourceKind): boolean => {
    const source = sources.get(kind);
    return Boolean(source && source.injectPolicy !== "none");
  };
  const hasUnavailable = (kind: ContextInputSourceKind): boolean => {
    const source = sources.get(kind);
    return Boolean(source && source.injectPolicy === "none" && source.provenance.trim());
  };
  const hasSession = hasActive("session_recent");
  const hasHarnessControls = hasActive("harness_controls");
  const hasCanvas = hasActive("canvas_scope") || hasUnavailable("canvas_scope");
  const hasRecallOrMemory =
    hasActive("context_recall") ||
    hasActive("long_term_memory") ||
    hasUnavailable("context_recall") ||
    hasUnavailable("long_term_memory");
  const hasToolsSkills = hasActive("tools_skills") || hasUnavailable("tools_skills");
  return hasSession && hasHarnessControls && hasCanvas && hasRecallOrMemory && hasToolsSkills;
}
