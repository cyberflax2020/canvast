/**
 * =============================================================================
 * Canvast — Sidecar Message Lifecycle / Sidecar 消息生命周期
 * =============================================================================
 * @file        src/harness/sidecar-message-lifecycle.ts
 * @brief       Pure message and decision helpers for request orchestration.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import type { RecordedOrchestrationDecision } from "./auto-orchestrator.js";

export function sidecarMessageText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: any) => {
    if (typeof part === "string") return part;
    return part?.type === "text" && typeof part.text === "string" ? part.text : "";
  }).filter(Boolean).join("\n");
}

export function sidecarAssistantNeedsAnotherTurn(message: any): boolean {
  if (message?.role !== "assistant") return true;
  const content = Array.isArray(message.content) ? message.content : [];
  if (content.some((part: any) => part?.type === "toolCall")) return true;
  const reason = String(
    message?.stopReason || message?.stop_reason ||
    message?.finishReason || message?.finish_reason || "",
  );
  return reason === "toolUse" || reason === "error" || reason === "aborted" || reason === "length";
}

export function isFinalVisibleSidecarAssistant(message: any): boolean {
  return message?.role === "assistant" &&
    sidecarMessageText(message).trim().length > 0 &&
    !sidecarAssistantNeedsAnotherTurn(message);
}

export function sidecarResponseIdentity(message: any): {
  provider?: string;
  model?: string;
  providerResponseId?: string;
} {
  const provider = typeof message?.provider === "string" ? message.provider : undefined;
  const model = typeof message?.model === "string" ? message.model : undefined;
  const rawResponseId = message?.responseId || message?.response_id;
  const providerResponseId = typeof rawResponseId === "string" ? rawResponseId : undefined;
  return { provider, model, providerResponseId };
}

export function sidecarCompletionProjection(
  decision: RecordedOrchestrationDecision,
): RecordedOrchestrationDecision {
  return { ...decision, mode: "direct", lifecycleAction: "exit" };
}

export function sidecarDecisionHasRunnableWork(
  decision: Pick<RecordedOrchestrationDecision,
    "mode" | "lifecycleAction" | "planSteps" | "workflowSteps" | "subagentTasks"> | undefined,
): boolean {
  if (!decision || decision.lifecycleAction === "exit") return false;
  // Direct-mode plan steps describe the current response; they are not a
  // durable orchestration lifecycle. A final visible assistant response closes
  // them. Plan, workflow, and sub-agent modes stay open until an explicit exit.
  return decision.mode !== "direct";
}

export function sidecarDecisionCanCloseFromVisibleReply(
  decision: Pick<RecordedOrchestrationDecision,
    "mode" | "lifecycleAction" | "planSteps" | "workflowSteps" | "subagentTasks"> | undefined,
): boolean {
  if (!decision) return true;
  if (sidecarDecisionHasRunnableWork(decision)) return false;
  return decision.mode === "direct" || decision.lifecycleAction === "exit";
}

export function sidecarVisibleReplyCanSettle(
  message: any,
  decision: Pick<RecordedOrchestrationDecision,
    "mode" | "lifecycleAction" | "planSteps" | "workflowSteps" | "subagentTasks"> | undefined,
  dispatchState?: { executionState?: string },
): boolean {
  return isFinalVisibleSidecarAssistant(message) &&
    dispatchState?.executionState !== "admitted" &&
    sidecarDecisionCanCloseFromVisibleReply(decision);
}
