/**
 * =============================================================================
 * Canvast — Runtime Status Normalization / Canvast 源文件
 * =============================================================================
 * @file        src/harness/runtime-status-normalize.ts
 * @brief       Normalization logic for runtime status snapshots.
 * @description Part of the Canvast product codebase.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import {
  normalizeRuntimeLocale,
  normalizeRuntimeLanguageSource,
  type RuntimeLanguageState,
} from "./runtime-language.js";
import {
  normalizeRuntimeInputQueue,
  normalizeRuntimeRequests,
  normalizeRuntimeContinuityProjection,
} from "./context-continuity.js";
import {
  normalizeRuntimeRootExecution,
} from "./runtime-root-execution.js";
import type {
  RuntimeStatusItem,
  RuntimeItemStatus,
  RuntimeModelState,
  RuntimeTokenState,
  RuntimeAttachmentKind,
  RuntimeAttachmentDisposition,
  RuntimePermissionMode,
  RuntimePermissionSource,
  RuntimePermissionState,
  RuntimeAttachmentRecord,
  ApprovalReviewRecord,
  ApprovalReviewDecision,
  ApprovalReviewRisk,
  ApprovalAuthorization,
  RuntimeEventRecord,
  RuntimePolicyOutcome,
  RuntimeSidecarDispatch,
  RuntimeSidecarDispatchBranch,
  RuntimeStatusSnapshot,
} from "./runtime-status.js";
import type { RuntimeResumeSnapshot } from "./runtime-resume.js";
import { createHash } from "node:crypto";
import {
  ContextContinuationPhase,
  RuntimeContinuityProjection,
} from "./context-continuity.js";

export const MAX_ITEMS_PER_PLANE = 30;
export const MAX_ATTACHMENTS = 40;
export const MAX_APPROVAL_REVIEWS = 40;
export const MAX_EVENTS = 80;
export const MAX_INPUT_QUEUE = 40;
export const MAX_REQUESTS = 80;
export const MAX_BATCH_COMMITS = 512;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(item => typeof item === "string") : [];
}

export function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function fingerprint(parts: string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 12);
}

export function normalizeStatus(value: unknown): RuntimeItemStatus {
  const raw = asString(value, "unknown");
  const valid: RuntimeItemStatus[] = ["pending", "in_progress", "running", "completed", "blocked", "failed", "aborted", "stale", "unknown"];
  return valid.includes(raw as any) ? (raw as any) : "unknown";
}

export function normalizeDecision(value: unknown): ApprovalReviewDecision {
  if (value === "approved" || value === "needs_user" || value === "blocked") return value;
  return "needs_user";
}

export function normalizeRisk(value: unknown): ApprovalReviewRisk {
  if (value === "low" || value === "medium" || value === "high" || value === "critical") return value;
  return "medium";
}

export function normalizeAuthorization(value: unknown): ApprovalAuthorization {
  if (value === "none" || value === "low" || value === "medium" || value === "high") return value;
  return "low";
}

export function normalizeSidecarDispatch(value: unknown): RuntimeSidecarDispatch | undefined {
  if (!isRecord(value)) return undefined;
  const revision = Number(value.revision);
  if (!Number.isInteger(revision) || revision < 1) return undefined;
  return {
    strategy: asString(value.strategy), tool: asString(value.tool), reasonCodes: asStringArray(value.reasonCodes),
    explanation: asString(value.explanation), revision, executionState: asString(value.executionState),
    concurrencyScope: asString(value.concurrencyScope), primaryOverlap: value.primaryOverlap === true,
    childRunIds: asStringArray(value.childRunIds), failureCode: asString(value.failureCode) || undefined,
    branches: Array.isArray(value.branches) ? value.branches.filter(isRecord).map(branch => ({ id: asString(branch.id),
      selfContained: branch.selfContained === true, primaryDependency: asString(branch.primaryDependency), dependsOnBranchIds: asStringArray(branch.dependsOnBranchIds),
      writeTargets: asStringArray(branch.writeTargets), externalResourceKeys: asStringArray(branch.externalResourceKeys),
      execution: isRecord(branch.execution) ? {
        mode: asString(branch.execution.mode), readOnly: branch.execution.readOnly === true,
        writeTargets: asStringArray(branch.execution.writeTargets),
        externalResourceKeys: asStringArray(branch.execution.externalResourceKeys),
      } : undefined })) : [],
  };
}

export function normalizePolicyOutcome(value: unknown): RuntimePolicyOutcome | undefined {
  if (!isRecord(value) || value.kind !== "policy_block") return undefined;
  if (value.disposition !== "fallback_allowed" && value.disposition !== "terminal") return undefined;
  return {
    kind: "policy_block",
    disposition: value.disposition,
    source: asString(value.source, "runtime"),
    categories: asStringArray(value.categories),
  };
}

export function normalizeItems(value: unknown, now: string): RuntimeStatusItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item, index): RuntimeStatusItem => ({
    id: asString(item.id, `item-${index}`),
    title: asString(item.title, "Untitled"),
    status: normalizeStatus(item.status),
    required: typeof item.required === "boolean" ? item.required : undefined,
    rootRequestId: asString(item.rootRequestId) || undefined,
    sessionId: asString(item.sessionId) || undefined,
    summary: asString(item.summary) || undefined,
    updatedAt: asString(item.updatedAt, now),
    startedAt: asString(item.startedAt) || undefined,
    completedAt: asString(item.completedAt) || undefined,
    elapsedMs: Number.isFinite(Number(item.elapsedMs)) ? Number(item.elapsedMs) : undefined,
    sidecarDispatch: normalizeSidecarDispatch(item.sidecarDispatch),
    policyOutcome: normalizePolicyOutcome(item.policyOutcome),
  })).slice(-MAX_ITEMS_PER_PLANE);
}

export function normalizeModelState(value: unknown, now: string): RuntimeModelState {
  const record = isRecord(value) ? value : {};
  return {
    provider: asString(record.provider),
    model: asString(record.model),
    thinkingLevel: asString(record.thinkingLevel),
    availableThinkingLevels: asStringArray(record.availableThinkingLevels),
    modalities: asStringArray(record.modalities),
    imageInput: (record.imageInput === "supported" || record.imageInput === "unsupported") ? record.imageInput : "unknown",
    updatedAt: asString(record.updatedAt, now),
  };
}

export function normalizeTokenState(value: unknown, now: string): RuntimeTokenState {
  const record = isRecord(value) ? value : {};
  return {
    inputTokens: asNumber(record.inputTokens),
    outputTokens: asNumber(record.outputTokens),
    cacheReadTokens: asNumber(record.cacheReadTokens),
    cacheWriteTokens: asNumber(record.cacheWriteTokens),
    totalTokens: asNumber(record.totalTokens),
    effectiveTokens: asNumber(record.effectiveTokens),
    contextWindowTokens: asNumber(record.contextWindowTokens),
    contextUsedTokens: asNumber(record.contextUsedTokens),
    contextRemainingTokens: asNumber(record.contextRemainingTokens),
    contextUsageRatio: asNumber(record.contextUsageRatio),
    turnCount: asNumber(record.turnCount),
    toolCalls: asNumber(record.toolCalls),
    costUsd: asNumber(record.costUsd),
    updatedAt: asString(record.updatedAt, now),
  };
}

export function normalizePermissionState(value: unknown, now: string): RuntimePermissionState {
  const record = isRecord(value) ? value : {};
  return {
    mode: record.mode === "auto" ? "auto" : "ask",
    source: (record.source === "env" || record.source === "command" || record.source === "sandbox") ? record.source : "default",
    unattended: Boolean(record.unattended),
    updatedAt: asString(record.updatedAt, now),
  };
}

export function normalizeAttachments(value: unknown, now: string): RuntimeAttachmentRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item, index): RuntimeAttachmentRecord => ({
    id: asString(item.id, `attachment-${index}`),
    timestamp: asString(item.timestamp, now),
    kind: item.kind === "image" ? "image" : "text",
    disposition: (item.disposition === "inline" || item.disposition === "placeholder" || item.disposition === "omitted") ? item.disposition : "placeholder",
    placeholder: asString(item.placeholder, `[attachment:${index + 1}]`),
    summary: asString(item.summary, "Attachment"),
    sizeBytes: Number.isFinite(Number(item.sizeBytes)) ? Number(item.sizeBytes) : undefined,
    mimeType: asString(item.mimeType) || undefined,
    source: asString(item.source, "runtime-status"),
  })).slice(-MAX_ATTACHMENTS);
}

export function normalizeApprovalReviews(value: unknown, now: string): ApprovalReviewRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item, index) => ({
    id: asString(item.id, `approval-${index}`),
    timestamp: asString(item.timestamp, now),
    tool: asString(item.tool, "unknown"),
    decision: normalizeDecision(item.decision),
    risk: normalizeRisk(item.risk),
    authorization: normalizeAuthorization(item.authorization),
    rationale: asString(item.rationale, "No rationale recorded."),
    inputSummary: asString(item.inputSummary) || undefined,
    categories: asStringArray(item.categories),
    source: asString(item.source, "runtime-status"),
  })).slice(-MAX_APPROVAL_REVIEWS);
}

export function normalizeEvents(value: unknown, now: string): RuntimeEventRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item, index) => ({
    id: asString(item.id, `event-${index}`),
    timestamp: asString(item.timestamp, now),
    kind: asString(item.kind, "event"),
    title: asString(item.title, "Runtime event"),
    summary: asString(item.summary) || undefined,
    source: asString(item.source, "runtime-status"),
    sidecarDispatch: normalizeSidecarDispatch(item.sidecarDispatch),
  })).slice(-MAX_EVENTS);
}

export function normalizeResumeSnapshot(value: unknown, now: string): RuntimeResumeSnapshot {
  const record = isRecord(value) ? value : {};
  return {
    revision: Math.max(0, Math.floor(asNumber(record.revision))),
    state: (record.state === "attention_required" || record.state === "ready" || record.state === "claimed" || record.state === "running") ? record.state : "idle",
    updatedAt: asString(record.updatedAt, now),
    projectId: asString(record.projectId) || undefined,
    selectedCandidateId: asString(record.selectedCandidateId) || undefined,
    claimedCandidateId: asString(record.claimedCandidateId) || undefined,
    readyCandidateCount: Math.max(0, Math.floor(asNumber(record.readyCandidateCount))),
    candidates: Array.isArray(record.candidates) ? record.candidates.map(item => jsonClone(item)) as any[] : [],
  };
}

export function normalizeContinuityPhase(value: unknown): ContextContinuationPhase {
  if (
    value === "active" || value === "compacting" || value === "awaiting_resume" || value === "resumed" ||
    value === "recoverable_failure" || value === "completed" || value === "interrupted"
  ) return value;
  return "idle";
}

export function normalizeContinuityProjection(value: unknown, now: string): RuntimeContinuityProjection {
  const record = isRecord(value) ? value : {};
  return {
    phase: normalizeContinuityPhase(record.phase),
    projectId: asString(record.projectId) || undefined,
    sessionId: asString(record.sessionId) || undefined,
    turnId: asString(record.turnId) || undefined,
    requestId: asString(record.requestId) || undefined,
    compactionOperationId: asString(record.compactionOperationId) || undefined,
    continuationOwner: (record.continuationOwner === "harness" || record.continuationOwner === "user" || record.continuationOwner === "native_runtime") ? record.continuationOwner : undefined,
    pendingContinuationCount: Math.max(0, Math.floor(Number(record.pendingContinuationCount) || 0)),
    recoverable: record.recoverable === true,
    recoveryMessage: asString(record.recoveryMessage) || undefined,
    updatedAt: asString(record.updatedAt, now),
    inputQueueRevision: Math.max(0, Math.floor(Number(record.inputQueueRevision) || 0)),
  };
}
