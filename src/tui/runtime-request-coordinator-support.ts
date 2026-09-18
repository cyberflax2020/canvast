/**
 * =============================================================================
 * Canvast — Runtime Request Coordinator Support / Canvast source file
 * =============================================================================
 * @file        src/tui/runtime-request-coordinator-support.ts
 * @brief       Focused helpers for runtime request coordination.
 * @description Keeps pure request-routing, continuation, and message utility
 *              logic out of the coordinator class so the public coordinator
 *              surface stays below the project file-size cap.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import { createHash } from "node:crypto";

import {
  captureRuntimeContinuityCheckpoint,
  contextContinuityEventId,
  dispatchContextContinuity,
  readContextContinuity,
  type ContextContinuityState,
} from "../harness/context-continuity.js";
import {
  markRuntimeResumeCandidateCompleted,
  type RuntimeResumeSnapshot,
} from "../harness/runtime-resume.js";
import type { RuntimeInputQueuePolicy, RuntimeRequestKind } from "../harness/runtime-status.js";
import {
  readRuntimeStatus,
  summarizeRuntimeInput,
  updateRuntimeResumeProjection,
  upsertRuntimeStatusItem,
} from "../harness/runtime-status.js";
import type { ResumeBinding } from "./runtime-request-coordinator/types.js";

export const CONTINUATION_MESSAGE_TYPES = new Set([
  "canvast-compaction-continuation",
  "canvast-continuation",
]);

export function messageText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: any) => {
    if (typeof part === "string") return part;
    return part?.type === "text" && typeof part.text === "string" ? part.text : "";
  }).filter(Boolean).join("\n");
}

export function requestKind(policy: RuntimeInputQueuePolicy): RuntimeRequestKind {
  if (policy === "sidecar") return "sidecar";
  if (policy === "status") return "status";
  if (policy === "task_adjustment") return "adjustment";
  if (policy === "redirect" || policy === "pause") return "interrupt";
  return "primary";
}

export function isFinalVisibleAssistant(message: any): boolean {
  if (message?.role !== "assistant" || !messageText(message).trim()) return false;
  const reason = String(message?.stopReason || message?.stop_reason || message?.finishReason || message?.finish_reason || "");
  return reason !== "toolUse" && reason !== "error" && reason !== "aborted" && reason !== "length";
}

export function sessionId(ctx: any): string {
  const id = typeof ctx?.sessionManager?.getSessionId === "function" ? ctx.sessionManager.getSessionId() : "";
  const file = typeof ctx?.sessionManager?.getSessionFile === "function" ? ctx.sessionManager.getSessionFile() : "";
  return String(id || file || "canvast-session");
}

export function stableProjectId(agentDir: string, configured?: string): string {
  const value = configured || process.env.CANVAST_PROJECT_ROOT || process.cwd() || agentDir;
  return `project-${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

export function shouldPreserveResumeRevisionOnStartup(
  reason: string,
  nextSessionId: string,
  continuity: ContextContinuityState,
  resume: RuntimeResumeSnapshot,
): boolean {
  const turnId = continuity.activeTurn?.turnId;
  return reason === "startup" && Boolean(continuity.session.id) &&
    continuity.session.id !== nextSessionId && Boolean(turnId) && resume.candidates.some(candidate =>
      candidate.turnId === turnId && candidate.disposition !== "retired" && candidate.disposition !== "completed",
    );
}

export function restoredResumeBinding(
  resume: RuntimeResumeSnapshot,
  requestId: string,
  turnId: string,
): ResumeBinding | undefined {
  const matching = resume.candidates.filter(candidate =>
    candidate.requestId === requestId &&
    candidate.turnId === turnId &&
    candidate.disposition !== "retired" &&
    candidate.disposition !== "completed",
  );
  return matching.length === 1 ? { candidateId: matching[0].id } : undefined;
}

export function completeSoleResumeCandidate(
  agentDir: string,
  snapshot: ReturnType<typeof readRuntimeStatus>,
  binding: ResumeBinding | undefined,
  rootRequestId: string | undefined,
  timestamp: string,
): boolean {
  if (!isSoleResumeCandidateBlock(snapshot, binding, rootRequestId)) return false;
  const candidateId = binding!.candidateId;
  markRuntimeResumeCandidateCompleted(agentDir, {
    candidateId,
    eventId: `runtime-resume-completed:${candidateId}`,
    timestamp,
  });
  updateRuntimeResumeProjection(agentDir);
  return true;
}

export function isSoleResumeCandidateBlock(
  snapshot: ReturnType<typeof readRuntimeStatus>,
  binding: ResumeBinding | undefined,
  rootRequestId: string | undefined,
): boolean {
  if (!binding || !rootRequestId) return false;
  const active = snapshot.resume.candidates.filter(candidate =>
    candidate.requestId === rootRequestId &&
    candidate.disposition !== "retired" &&
    candidate.disposition !== "completed",
  );
  const candidate = active.length === 1 && active[0].id === binding.candidateId ? active[0] : undefined;
  const root = snapshot.rootExecution;
  if (!candidate || candidate.turnId !== snapshot.continuity.turnId ||
      root.rootRequestId !== rootRequestId || root.settledRequestId !== rootRequestId ||
      root.settlement !== "succeeded" || root.reason !== "pending_resume" ||
      root.workingCount + root.waitingCount + root.blockedCount !== 1) return false;
  return true;
}

/** Restore pre-sidecar continuity once so a new session can retire, not inherit, legacy live state. */
export function restoreLegacyRuntimeContinuity(agentDir: string, fallbackProjectId: string): boolean {
  const canonical = readContextContinuity(agentDir);
  if (canonical.session.id || canonical.activeTurn) return false;
  const runtime = readRuntimeStatus(agentDir);
  const legacy = runtime.continuity;
  if (!legacy.sessionId || !legacy.requestId || legacy.phase === "idle" || legacy.phase === "completed") {
    return false;
  }
  dispatchContextContinuity(agentDir, {
    type: "turn_started",
    eventId: contextContinuityEventId("turn_started", [
      "legacy-runtime-projection", legacy.sessionId, legacy.requestId,
    ]),
    timestamp: legacy.updatedAt || new Date().toISOString(),
    projectId: legacy.projectId || fallbackProjectId,
    sessionId: legacy.sessionId,
    turnId: legacy.turnId || `turn-${legacy.requestId}`,
    requestId: legacy.requestId,
    checkpoint: captureRuntimeContinuityCheckpoint(runtime),
  });
  return true;
}

export function queueStatus(policy: RuntimeInputQueuePolicy): "queued" | "interrupt" {
  return policy === "pause" || policy === "redirect" || policy === "task_adjustment" ? "interrupt" : "queued";
}

export function isOpenRequestStatus(status: string | undefined): boolean {
  return status === "queued" || status === "delivered" || status === "answering";
}

export function hasRunnablePrimaryWorkFromSnapshot(
  snapshot: ReturnType<typeof readRuntimeStatus>,
  primaryRequestId?: string,
): boolean {
  const runnable = (status: string) => status === "pending" || status === "in_progress" || status === "running";
  return snapshot.tasks.some(item => item.id !== "current-user-request" && runnable(item.status)) ||
    snapshot.plans.some(item => item.id !== "session-runtime" && runnable(item.status)) ||
    snapshot.subAgents.some(item => runnable(item.status)) ||
    snapshot.workflows.some(item => runnable(item.status)) ||
    (primaryRequestId
      ? snapshot.requests.some(item => item.parentRequestId === primaryRequestId && isOpenRequestStatus(item.status))
      : false);
}

export function shouldContinuePrimary(
  snapshot: ReturnType<typeof readRuntimeStatus>,
  primaryRequestId: string | undefined,
): boolean {
  if (!primaryRequestId) return false;
  const primary = snapshot.requests.find(item => item.requestId === primaryRequestId);
  if (!primary || primary.status === "failed" || primary.status === "interrupted") return false;
  if (snapshot.requests.some(item => item.parentRequestId === primaryRequestId && isOpenRequestStatus(item.status))) {
    return false;
  }
  if (primary.status !== "answered") return true;
  return hasRunnablePrimaryWorkFromSnapshot(snapshot, primaryRequestId);
}

/** Attribute the final run settlement to an already answered primary only
 * when the aggregate proves that no child, input, continuation, or plan work
 * remains. This covers a primary answer followed by a terminal sidecar in the
 * same Pi run without guessing across an open lifecycle boundary. */
export function runtimeSettlementRequestId(
  snapshot: ReturnType<typeof readRuntimeStatus>,
  primaryRequestId: string | undefined,
  responseRequestId: string | undefined,
): string | undefined {
  if (!primaryRequestId || responseRequestId === primaryRequestId) return responseRequestId;
  const primary = snapshot.requests.find(item => item.requestId === primaryRequestId);
  const aggregateReady = snapshot.rootExecution.rootRequestId === primaryRequestId &&
    snapshot.rootExecution.reason === "awaiting_agent_settlement" &&
    snapshot.rootExecution.workingCount === 0 &&
    snapshot.rootExecution.waitingCount === 0 &&
    snapshot.rootExecution.blockedCount === 0;
  return primary?.status === "answered" && primary.hasVisibleReply === true && aggregateReady
    ? primaryRequestId
    : responseRequestId;
}

export function supersededFailedToolRunIds(
  snapshot: ReturnType<typeof readRuntimeStatus>,
  rootRequestId: string | undefined,
  sessionId: string | undefined,
): string[] {
  if (!rootRequestId) return [];
  const matchesRoot = (item: { rootRequestId?: string; sessionId?: string }) =>
    item.rootRequestId === rootRequestId && (!sessionId || item.sessionId === sessionId);
  const scoped = snapshot.toolRuns.filter(matchesRoot);
  return scoped
    .filter(item => item.status === "failed")
    .filter(item => scoped.some(candidate =>
      candidate.id !== item.id &&
      candidate.status === "completed" &&
      candidate.title === item.title &&
      (candidate.summary || "") === (item.summary || "") &&
      Date.parse(candidate.updatedAt || candidate.completedAt || "0") >=
        Date.parse(item.updatedAt || item.completedAt || "0"),
    ))
    .map(item => item.id);
}

export function fallbackAllowedToolRunIds(
  snapshot: ReturnType<typeof readRuntimeStatus>,
  rootRequestId: string | undefined,
  sessionId: string | undefined,
): string[] {
  if (!rootRequestId) return [];
  return snapshot.toolRuns
    .filter(item =>
      item.rootRequestId === rootRequestId &&
      (!sessionId || item.sessionId === sessionId) &&
      item.status === "failed" &&
      item.policyOutcome?.kind === "policy_block" &&
      item.policyOutcome.disposition === "fallback_allowed",
    )
    .map(item => item.id);
}

export function resolveOptionalFailedToolRuns(
  agentDir: string,
  snapshot: ReturnType<typeof readRuntimeStatus>,
  rootRequestId: string | undefined,
  sessionIdValue: string | undefined,
): void {
  const resolvedIds = new Set([
    ...supersededFailedToolRunIds(snapshot, rootRequestId, sessionIdValue),
    ...fallbackAllowedToolRunIds(snapshot, rootRequestId, sessionIdValue),
  ]);
  for (const id of resolvedIds) {
    const toolRun = snapshot.toolRuns.find(item => item.id === id);
    if (!toolRun) continue;
    upsertRuntimeStatusItem(agentDir, {
      plane: "toolRuns",
      item: {
        ...toolRun,
        status: toolRun.policyOutcome?.disposition === "fallback_allowed" ? "completed" : toolRun.status,
        required: false,
      },
    });
  }
}

export function newestPendingByText(agentDir: string, text: string) {
  const summary = summarizeRuntimeInput(text, 180);
  return [...readRuntimeStatus(agentDir).inputQueue].reverse().find(item =>
    item.textSummary === summary && (item.status === "queued" || item.status === "interrupt" || item.status === "acknowledged"),
  );
}

export function lifecycleEventTitle(kind: RuntimeRequestKind, phase: "answering" | "visible_reply"): string {
  const prefix = kind === "status" ? "Status request" : "Sidecar request";
  return phase === "answering" ? `${prefix} answering` : `${prefix} visible reply delivered`;
}

export function lifecycleEventSummary(record: { kind: RuntimeRequestKind; textSummary: string; deliveryMode?: string }): string {
  const label = summarizeRuntimeInput(record.textSummary, 72);
  return `${record.kind}${record.deliveryMode ? `/${record.deliveryMode}` : ""}: ${label}`;
}

export function continuationDispatchId(message: any): string | undefined {
  if (message?.role !== "custom" || !CONTINUATION_MESSAGE_TYPES.has(String(message?.customType || ""))) {
    return undefined;
  }
  const dispatchId = message?.details?.dispatchId;
  return typeof dispatchId === "string" && dispatchId.trim() ? dispatchId : undefined;
}

export function completedContinuationDispatchIds(entries: any[]): Set<string> {
  const completed = new Set<string>();
  const open = new Set<string>();
  for (const entry of entries) {
    if (entry?.type === "custom_message") {
      const dispatchId = continuationDispatchId({
        role: "custom",
        customType: entry.customType,
        details: entry.details,
      });
      if (dispatchId) open.add(dispatchId);
      continue;
    }
    if (entry?.type !== "message" || entry?.message?.role !== "assistant" || !isFinalVisibleAssistant(entry.message)) {
      continue;
    }
    for (const dispatchId of open) completed.add(dispatchId);
    open.clear();
  }
  return completed;
}
