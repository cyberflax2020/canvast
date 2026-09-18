/**
 * =============================================================================
 * Canvast — Harness Auto Orchestration Tool / Harness 自动编排工具
 * =============================================================================
 * @file        extensions/canvast-harness/auto-orchestration-tool.ts
 * @brief       Registers orchestration decisions with transactional batch flow.
 * @description Keeps the public tool schema stable while binding batch records
 *              to a distinct request/assessment and publishing before commit.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import type { RecordedOrchestrationDecision } from "../../src/harness/auto-orchestrator.js";
import {
  GROUNDING_CORRECTION_POLICIES,
  GROUNDING_FACT_KINDS,
  GROUNDING_FRESHNESS,
  GROUNDING_SOURCE_KINDS,
  GROUNDING_UNAVAILABLE_POLICIES,
} from "../../src/harness/grounding-policy.js";
import type { SidecarOrchestrationController } from "../../src/harness/sidecar-orchestration.js";

function literalUnion(values: readonly string[]) {
  return Type.Union(values.map(value => Type.Literal(value)) as any);
}

function normalizeGroundingStrategy(value: any, webUsePolicy = "not_needed", webUse = "not_needed") {
  if (!value || typeof value !== "object") return undefined;
  const requirements = Array.isArray(value.requirements) ? value.requirements : [];
  const preferredSources = Array.isArray(value.preferred_sources) ? value.preferred_sources : [];
  const minimumSources = Number(value.minimum_sources || 0);
  const maxExternalCalls = Number(value.max_external_calls || 0);
  if (requirements.length === 0 && webUsePolicy === "not_needed" && webUse === "not_needed") return undefined;
  const semanticallyEmpty = requirements.length === 0 && preferredSources.length === 0 &&
    minimumSources <= 0 && value.allow_memory_only !== true &&
    !value.unavailable_policy && !value.correction_policy;
  if (semanticallyEmpty) return undefined;
  return {
    requirements: requirements.map((item: any) => ({
      kind: item.kind,
      claim: String(item.claim || ""),
      freshness: item.freshness,
      sourceKinds: item.source_kinds || [],
    })),
    preferredSources,
    minimumSources,
    maxExternalCalls: Number.isInteger(maxExternalCalls) && maxExternalCalls > 0 ? maxExternalCalls : undefined,
    allowMemoryOnly: value.allow_memory_only === true,
    unavailablePolicy: value.unavailable_policy,
    correctionPolicy: value.correction_policy,
  };
}

function decisionInput(params: any, controller: SidecarOrchestrationController) {
  return {
    mode: params.mode,
    lifecycleAction: params.lifecycle_action,
    taskSummary: String(params.task_summary || ""),
    rationale: String(params.rationale || ""),
    observableReasoningSummary: params.observable_reasoning_summary || [],
    planSteps: params.plan_steps || [],
    subagentTasks: params.subagent_tasks || [],
    workflowSteps: params.workflow_steps || [],
    scopeFiles: params.scope_files || [],
    toolCallPlan: (params.tool_call_plan || []).map((item: any) => ({
      domain: item.domain, tools: item.tools || [], purpose: String(item.purpose || ""),
      order: item.order || "as_needed", parallelSafe: item.parallel_safe === true,
      webJustification: item.web_justification,
    })),
    verificationSteps: params.verification_steps || [],
    webUse: params.web_use || "not_needed",
    webJustification: params.web_justification,
    dependencyAudit: params.dependency_audit
      ? { isolatedCacheVerified: params.dependency_audit.isolated_cache_verified === true }
      : undefined,
    groundingStrategy: normalizeGroundingStrategy(
      params.grounding_strategy,
      controller.assessment?.webUsePolicy,
      params.web_use || "not_needed",
    ),
    localEvidenceUsed: params.local_evidence_used,
    contextStrategy: params.context_strategy ? {
      historyPolicy: params.context_strategy.history_policy,
      compressionTrigger: String(params.context_strategy.compression_trigger || ""),
      recallSources: params.context_strategy.recall_sources || [],
      resumePlan: params.context_strategy.resume_plan || [],
      inputSources: Array.isArray(params.context_strategy.input_sources)
        ? params.context_strategy.input_sources.map((source: any) => ({
            kind: source.kind, budget: String(source.budget || ""),
            provenance: String(source.provenance || ""), injectPolicy: source.inject_policy || "manifest",
          }))
        : undefined,
    } : undefined,
    batchPlan: params.batch_plan ? {
      batchId: String(params.batch_plan.batch_id || ""),
      revision: Number(params.batch_plan.revision),
      checkpoint: params.batch_plan.checkpoint,
      candidateHash: String(params.batch_plan.candidate_hash || ""),
      admittedAt: String(params.batch_plan.admitted_at || ""),
      items: (params.batch_plan.items || []).map((item: any) => ({
        id: String(item.id || ""), requestId: String(item.request_id || ""),
        sequence: Number(item.sequence), timestamp: String(item.timestamp || ""),
        status: item.status, policy: item.policy,
        relation: {
          targetTaskId: item.relation?.target_task_id, dependencyIds: item.relation?.dependency_ids || [],
          priority: item.relation?.priority,
          branchEvidence: item.relation?.branch_evidence ? {
            selfContained: item.relation.branch_evidence.self_contained === true,
            primaryDependency: item.relation.branch_evidence.primary_dependency,
            dependsOnBranchIds: item.relation.branch_evidence.depends_on_branch_ids || [],
            writeTargets: item.relation.branch_evidence.write_targets || [],
            externalResourceKeys: item.relation.branch_evidence.external_resource_keys || [],
          } : undefined,
        },
        supersedeEvidence: item.supersede_evidence ? {
          targetRootRequestId: String(item.supersede_evidence.target_root_request_id || ""),
          items: (item.supersede_evidence.items || []).map((evidence: any) => ({
            plane: evidence.plane, itemId: String(evidence.item_id || ""),
            status: evidence.status, updatedAt: String(evidence.updated_at || ""),
            disposition: evidence.disposition,
          })),
        } : undefined,
        deferInfo: item.defer_info ? {
          reasonCode: String(item.defer_info.reason_code || ""),
          blockerTaskIds: item.defer_info.blocker_task_ids || [], reevaluateAt: item.defer_info.reevaluate_at,
        } : undefined,
      })),
    } : undefined,
  };
}

function errorResult(controller: SidecarOrchestrationController, errors: string[]) {
  return {
    isError: true,
    content: [{
      type: "text" as const,
      text: `Automatic orchestration decision rejected:\n- ${errors.join("\n- ")}`,
    }],
    details: { errors, assessment: controller.assessment },
  };
}

function successResult(decision: RecordedOrchestrationDecision, assessment: unknown) {
  const planLines = decision.toolCallPlan.map((item, index) =>
    `${index + 1}. ${item.domain}: ${item.tools.join(", ") || "n/a"} — ${item.purpose}`
  ).join("\n");
  return {
    content: [{
      type: "text" as const,
      text: [
        "# Auto Orchestration Recorded", `mode=${decision.mode}`,
        decision.lifecycleAction ? `lifecycle_action=${decision.lifecycleAction}` : "",
        `assessment=${decision.assessmentId}`, `web_use=${decision.webUse}`,
        decision.dependencyAudit ? `dependency_audit.isolated_cache_verified=${decision.dependencyAudit.isolatedCacheVerified === true}` : "",
        decision.localEvidenceUsed === undefined ? "" : `local_evidence_used=${decision.localEvidenceUsed}`,
        decision.contextStrategy ? `context=${decision.contextStrategy.historyPolicy}` : "",
        "", "## Observable Reasoning Summary",
        decision.observableReasoningSummary.map((item, index) => `${index + 1}. ${item}`).join("\n") || "(none)",
        "", "## Tool Strategy", planLines || "(no tool plan)",
        "", "## Context Strategy",
        decision.contextStrategy ? [
          `history_policy=${decision.contextStrategy.historyPolicy}`,
          `compression_trigger=${decision.contextStrategy.compressionTrigger}`,
          `recall_sources=${decision.contextStrategy.recallSources.join(", ")}`,
          `resume_plan=${decision.contextStrategy.resumePlan.join(" -> ")}`,
        ].join("\n") : "(recent window only)",
        "", "## Verification",
        decision.verificationSteps.map((item, index) => `${index + 1}. ${item}`).join("\n") || "(none)",
      ].filter(value => value !== "").join("\n"),
    }],
    details: { decision, assessment },
  };
}

export interface RegisterAutoOrchestrationToolOptions {
  controller: SidecarOrchestrationController;
  publishDecision: (decision: RecordedOrchestrationDecision) => boolean;
  projectDecision: (decision: RecordedOrchestrationDecision) => void;
}

export function registerAutoOrchestrationTool(
  pi: ExtensionAPI,
  options: RegisterAutoOrchestrationToolOptions,
): void {
  const controller = options.controller;
  pi.registerTool({
    name: "auto_orchestration_decision",
    label: "Auto Orchestration Decision / 自动编排决策",
    description: "Record the automatic plan/sub-agent/workflow decision and coordinated tool strategy before mutating, web, sub-agent, or workflow tools. Web is conditional and requires a concrete reason. / 在修改、联网、子 agent 或 workflow 前记录自动规划与工具协调策略。联网不是默认动作，必须有具体理由。",
    parameters: Type.Object({
      request_id: Type.Optional(Type.String()),
      assessment_id: Type.Optional(Type.String()),
      mode: Type.Union([Type.Literal("direct"), Type.Literal("plan"), Type.Literal("subagents"), Type.Literal("workflow")]),
      lifecycle_action: Type.Optional(Type.Union([Type.Literal("enter"), Type.Literal("update"), Type.Literal("switch"), Type.Literal("exit")])),
      task_summary: Type.String(), rationale: Type.String(),
      observable_reasoning_summary: Type.Optional(Type.Array(Type.String())),
      plan_steps: Type.Optional(Type.Array(Type.String())), subagent_tasks: Type.Optional(Type.Array(Type.String())),
      workflow_steps: Type.Optional(Type.Array(Type.String())), scope_files: Type.Optional(Type.Array(Type.String())),
      tool_call_plan: Type.Optional(Type.Array(Type.Object({
        domain: Type.Union(["local_search", "file_read", "file_write", "shell", "web", "task", "agent", "workflow", "canvas", "test", "review", "monitor", "package", "tui"].map(value => Type.Literal(value)) as any),
        tools: Type.Array(Type.String()), purpose: Type.String(),
        order: Type.Union([Type.Literal("before_edit"), Type.Literal("during_edit"), Type.Literal("after_edit"), Type.Literal("as_needed")]),
        parallel_safe: Type.Boolean(), web_justification: Type.Optional(Type.String()),
      }))),
      verification_steps: Type.Optional(Type.Array(Type.String())),
      web_use: Type.Optional(Type.Union([Type.Literal("not_needed"), Type.Literal("conditional"), Type.Literal("required")])),
      web_justification: Type.Optional(Type.String()),
      dependency_audit: Type.Optional(Type.Object({ isolated_cache_verified: Type.Optional(Type.Boolean()) })),
      local_evidence_used: Type.Optional(Type.Boolean()),
      grounding_strategy: Type.Optional(Type.Object({
        requirements: Type.Array(Type.Object({
          kind: literalUnion(GROUNDING_FACT_KINDS), claim: Type.String(),
          freshness: literalUnion(GROUNDING_FRESHNESS), source_kinds: Type.Array(literalUnion(GROUNDING_SOURCE_KINDS)),
        })),
        preferred_sources: Type.Array(literalUnion(GROUNDING_SOURCE_KINDS)), minimum_sources: Type.Number(),
        max_external_calls: Type.Optional(Type.Number()), allow_memory_only: Type.Boolean(),
        unavailable_policy: literalUnion(GROUNDING_UNAVAILABLE_POLICIES),
        correction_policy: literalUnion(GROUNDING_CORRECTION_POLICIES),
      })),
      context_strategy: Type.Optional(Type.Object({
        history_policy: Type.Union([Type.Literal("recent_window"), Type.Literal("compact"), Type.Literal("recall"), Type.Literal("resume")]),
        compression_trigger: Type.String(), recall_sources: Type.Array(Type.String()), resume_plan: Type.Array(Type.String()),
        input_sources: Type.Optional(Type.Array(Type.Object({
          kind: Type.Union(["session_recent", "harness_controls", "canvas_scope", "context_recall", "long_term_memory", "tools_skills", "task_files"].map(value => Type.Literal(value)) as any),
          budget: Type.String(), provenance: Type.String(),
          inject_policy: Type.Union([Type.Literal("inline"), Type.Literal("manifest"), Type.Literal("pointer"), Type.Literal("on_demand"), Type.Literal("none")]),
        }))),
      })),
      batch_plan: Type.Optional(Type.Object({
        batch_id: Type.String(), revision: Type.Integer({ minimum: 0 }),
        checkpoint: Type.Union([Type.Literal("on_tool_success"), Type.Literal("on_tool_error"), Type.Literal("on_turn_settle"), Type.Literal("on_plan_approved"), Type.Literal("on_workflow_stage")]),
        candidate_hash: Type.String(), admitted_at: Type.String(),
        items: Type.Array(Type.Object({
          id: Type.String(), request_id: Type.String(), sequence: Type.Integer({ minimum: 0 }), timestamp: Type.String(),
          status: Type.Union([Type.Literal("queued"), Type.Literal("interrupt"), Type.Literal("deferred")]),
          policy: Type.Union([Type.Literal("supersede_merge"), Type.Literal("amend_current"), Type.Literal("parallel_independent"), Type.Literal("serial_after_current"), Type.Literal("defer"), Type.Literal("pause"), Type.Literal("cancel")]),
          relation: Type.Object({
            target_task_id: Type.Optional(Type.String()),
            dependency_ids: Type.Optional(Type.Array(Type.String())),
            priority: Type.Optional(Type.Integer()),
            branch_evidence: Type.Optional(Type.Object({
              self_contained: Type.Boolean(),
              primary_dependency: Type.Union([Type.Literal("none"), Type.Literal("snapshot"), Type.Literal("live")]),
              depends_on_branch_ids: Type.Array(Type.String()),
              write_targets: Type.Array(Type.String()),
              external_resource_keys: Type.Array(Type.String()),
            })),
          }),
          supersede_evidence: Type.Optional(Type.Object({
            target_root_request_id: Type.String(),
            items: Type.Array(Type.Object({
              plane: Type.Union([Type.Literal("tasks"), Type.Literal("plans"), Type.Literal("subAgents"), Type.Literal("workflows"), Type.Literal("toolRuns")]),
              item_id: Type.String(),
              status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("running"), Type.Literal("completed"), Type.Literal("blocked"), Type.Literal("failed"), Type.Literal("aborted"), Type.Literal("stale"), Type.Literal("unknown")]),
              updated_at: Type.String(),
              disposition: Type.Union([Type.Literal("continue_under_replacement"), Type.Literal("cancel_as_redundant"), Type.Literal("preserve_completed_evidence")]),
            })),
          })),
          defer_info: Type.Optional(Type.Object({
            reason_code: Type.String(), blocker_task_ids: Type.Array(Type.String()),
            reevaluate_at: Type.Union([Type.Literal("on_tool_success"), Type.Literal("on_tool_error"), Type.Literal("on_turn_settle"), Type.Literal("on_plan_approved"), Type.Literal("on_workflow_stage")]),
          })),
        })),
      })),
    }),
    async execute(_id: string, params: any): Promise<any> {
      const input = decisionInput(params, controller);
      const result = params.batch_plan
        ? controller.recordBatchTransaction(input as never, {
            requestId: String(params.request_id || ""),
            assessmentId: String(params.assessment_id || ""),
          }, options.publishDecision)
        : controller.record(input as never);
      if (!result.ok) return errorResult(controller, result.errors);
      options.projectDecision(result.decision);
      return successResult(result.decision, controller.assessment);
    },
  });
}
