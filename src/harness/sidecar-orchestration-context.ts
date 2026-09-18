/**
 * =============================================================================
 * Canvast — Sidecar Orchestration Context / 旁路编排上下文
 * =============================================================================
 * @file        src/harness/sidecar-orchestration-context.ts
 * @brief       Builds context-injection payloads for request-scoped sidecars.
 * @description Keeps prompt assembly and LLM request identity projection out of
 *              the main orchestration state machine file.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import type {
  LlmRequestIdentity,
  OrchestrationBatchRequestIdentity,
  OrchestrationRequestKind,
} from "./sidecar-orchestration-state.js";
import type { RecordedOrchestrationDecision } from "./auto-orchestrator.js";

interface ContextRequestLike {
  requestId: string;
  parentRequestId?: string;
  kind: OrchestrationRequestKind;
  batch?: OrchestrationBatchRequestIdentity;
  controller: {
    assessment?: { id: string };
    renderPrompt(): string;
  };
}

export function createUnboundLlmRequest(
  createId: (kind: "llm") => string,
): LlmRequestIdentity {
  return {
    llmRequestId: createId("llm"),
    requestId: "unbound",
    requestKind: "primary",
  };
}

export function createBoundLlmRequest(
  request: ContextRequestLike,
  createId: (kind: "llm") => string,
): LlmRequestIdentity {
  return {
    llmRequestId: createId("llm"),
    requestId: request.requestId,
    parentRequestId: request.parentRequestId,
    requestKind: request.kind,
    assessmentId: request.controller.assessment?.id,
  };
}

export function buildSidecarContextGuidance(
  request: ContextRequestLike,
  llmRequest: LlmRequestIdentity,
  restoringPrimary: boolean,
): string {
  if (request.kind === "batch" && request.batch) {
    const batch = request.batch;
    const items = batch.items.map((item, index) => [
      `### Batch Item ${index + 1}`,
      `id=${item.id}`,
      `request_id=${item.requestId}`,
      `sequence=${item.sequence}`,
      `timestamp=${item.timestamp}`,
      `status=${item.status}`,
    ].join("\n")).join("\n\n");
    return [
      "## Canvast Runtime Batch Orchestration Request",
      `request_id=${request.requestId}`,
      `request_kind=${request.kind}`,
      `llm_request_id=${llmRequest.llmRequestId}`,
      request.controller.assessment ? `assessment_id=${request.controller.assessment.id}` : "",
      `batch_id=${batch.batchId}`,
      `queue_revision=${batch.revision}`,
      `checkpoint=${batch.checkpoint}`,
      `candidate_hash=${batch.candidateHash}`,
      "This typed batch request is independent from primary and sidecar work. Record exactly one decision bound to this request_id and assessment_id. Preserve the header and ordered item manifest exactly.",
      "中文：该批处理请求独立于 primary 和 sidecar。必须使用当前 request_id 与 assessment_id 仅提交一次决策，并原样保留批次头及条目顺序。",
      items,
      request.controller.renderPrompt(),
    ].filter(Boolean).join("\n");
  }
  const heading = request.kind === "sidecar"
    ? "## Canvast Sidecar Orchestration Request"
    : "## Canvast Primary Orchestration Restored";
  const lifecycleGuidance = request.kind === "sidecar"
    ? [
        "This request-local assessment is authoritative for the next LLM response. Keep the primary request suspended and do not reuse its assessment or decision for this sidecar.",
        "Before spawn_agent or parallel_agents, record sidecar_dispatch_decision with typed dependency and isolation evidence.",
        "Use expected_revision=0 for the first record, then the currently displayed revision for a replacement. Unknown evidence stays serial.",
        "The current synchronous agent tools only provide sidecar_children concurrency; never claim primary_and_sidecar overlap.",
      ].join(" ")
    : "The sidecar response is complete. Resume only the unfinished primary work with its preserved assessment and recorded decision.";
  void restoringPrimary;
  return [
    heading,
    `request_id=${request.requestId}`,
    `request_kind=${request.kind}`,
    request.parentRequestId ? `parent_request_id=${request.parentRequestId}` : "",
    `llm_request_id=${llmRequest.llmRequestId}`,
    request.controller.assessment ? `assessment_id=${request.controller.assessment.id}` : "",
    lifecycleGuidance,
    request.controller.renderPrompt(),
  ].filter(Boolean).join("\n");
}

interface SidecarHookController {
  resetPendingToolCalls(): void;
  onToolResult(event: any): void;
  onMessageStart(message: any): unknown;
  onContext(messages: any[]): { messages: any[] };
  onTurnEnd(message: any): {
    completedDecisions: RecordedOrchestrationDecision[];
    restoredPrimary: boolean;
    primaryDecision?: RecordedOrchestrationDecision;
  };
}

interface SidecarHookRegistrationOptions {
  isEnhanced: () => boolean;
  projectDecision: (decision: RecordedOrchestrationDecision, source: string) => void;
}

/** Register the Pi lifecycle hooks needed for in-run request switching. */
export function registerSidecarOrchestrationHooks(
  pi: any,
  controller: SidecarHookController,
  options: SidecarHookRegistrationOptions,
): void {
  pi.on("session_start", async () => controller.resetPendingToolCalls());
  pi.on("tool_result", async (event: any) => {
    if (options.isEnhanced()) controller.onToolResult(event);
  });
  pi.on("message_start", async (event: any) => {
    if (options.isEnhanced()) controller.onMessageStart(event?.message);
  });
  pi.on("context", async (event: any) => {
    if (!options.isEnhanced()) return undefined;
    return { messages: controller.onContext(event?.messages || []).messages };
  });
  pi.on("turn_end", async (event: any) => {
    if (!options.isEnhanced()) return;
    const transition = controller.onTurnEnd(event?.message);
    for (const decision of transition.completedDecisions) options.projectDecision(decision, "sidecar_orchestration");
    if (transition.restoredPrimary && transition.primaryDecision) {
      options.projectDecision(transition.primaryDecision, "sidecar_orchestration");
    }
  });
}
