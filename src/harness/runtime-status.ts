/**
 * =============================================================================
 * Canvast — Runtime Status / Canvast 源文件
 * =============================================================================
 * @file        src/harness/runtime-status.ts
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import * as fs from "node:fs";
import * as path from "node:path";

import {
  normalizeRuntimeContinuityProjection, normalizeRuntimeInputQueue, normalizeRuntimeRequests,
  projectContextContinuity, recordRuntimeRequestInSnapshot,
  markRuntimeInputQueueItemAnswered, markRuntimeInputQueueItemDelivered,
  markRuntimeRequestAnswered, markRuntimeRequestAnswering, markRuntimeRequestDelivered,
  runtimeRequestKindForQueuePolicy, summarizeRuntimeInput, updateRuntimeInputQueueItem, updateRuntimeRequestRecord,
  type ContextContinuityState, type RecordRuntimeInputQueueItemInput, type RecordRuntimeRequestInput, type RuntimeContinuityProjection,
  type RuntimeInputDeliveryMode, type RuntimeInputQueueItem, type RuntimeInputQueuePolicy,
  type RuntimeInputQueueSelector, type RuntimeInputQueueStatus, type RuntimeInputQueueUpdate,
  type RuntimeRequestDeliveryScope, type RuntimeRequestDeliveryScopeKind,
  type RuntimeRequestKind, type RuntimeRequestRecord, type RuntimeRequestStatus,
  type RuntimeRequestTransitionInput,
} from "./context-continuity.js";
import {
  projectRuntimeResume,
  readRuntimeResume,
  type RuntimeResumeSnapshot,
} from "./runtime-resume.js";
import {
  inferRuntimeLanguage,
  normalizeRuntimeLanguageSource,
  normalizeRuntimeLocale,
  type RuntimeLanguageInput,
  type RuntimeLanguageState,
} from "./runtime-language.js";
import {
  emptyRuntimeRootExecution,
  normalizeRuntimeRootExecution,
  projectRuntimeRootExecution,
  reduceRuntimeRootExecution,
  type RuntimeRootExecution,
  type RuntimeRootSettlement,
} from "./runtime-root-execution.js";
import { RecordedOrchestrationDecision } from "./auto-orchestrator/types.js";
import {
  asNumber, asString, asStringArray, fingerprint, isRecord, jsonClone,
  normalizeApprovalReviews, normalizeAttachments, normalizeDecision,
  normalizeEvents, normalizeItems, normalizeModelState,
  normalizePermissionState, normalizeResumeSnapshot, normalizeRisk,
  normalizeSidecarDispatch, normalizeStatus, normalizeTokenState,
  MAX_APPROVAL_REVIEWS, MAX_ATTACHMENTS, MAX_EVENTS,
  MAX_INPUT_QUEUE, MAX_ITEMS_PER_PLANE, MAX_REQUESTS
} from "./runtime-status-normalize.js";
import {
  normalizeRuntimeBatchCommitRecords,
  type RuntimeBatchCommitRecord,
} from "./runtime-batch-commit.js";
import {
  persistRuntimeInputPayload,
  runtimeInputPayloadDigest,
  type RuntimeInputPayloadInput,
  type RuntimeInputPayloadPart,
  type RuntimeInputPayloadV1,
} from "./runtime-input-payload.js";
import { withOwnedFileLock } from "./context-continuity/filesystem.js";

export {
  isRuntimeInputQueuePending, markRuntimeInputQueueItemAnswered, markRuntimeInputQueueItemDelivered,
  markRuntimeRequestAnswered, markRuntimeRequestAnswering, markRuntimeRequestDelivered,
  pendingRuntimeInputQueueItems, recordRuntimeRequestInSnapshot, summarizeRuntimeInput,
  updateRuntimeInputQueueItem, updateRuntimeRequestRecord,
} from "./context-continuity.js";
export { commitRuntimeBatchTransitions, retireRuntimeInputQueueItems, retireRuntimeSessionItems } from "./runtime-status-ops.js";
export {
  acceptRuntimeBatchDirectiveExecution, claimRuntimeBatchDirectiveExecution,
  initializeRuntimeBatchDirectiveExecutions, releaseExpiredRuntimeBatchDirectiveExecutions,
  pendingRuntimeBatchDirectiveExecutions, releaseRuntimeBatchDirectiveExecution,
  runtimeBatchDirectiveExecutionId, settleRuntimeBatchDirectiveExecution,
  startRuntimeBatchDirectiveExecution,
} from "./runtime-batch-execution.js";
export type {
  RuntimeBatchDirectiveBranchEvidence, RuntimeBatchDirectiveExecution,
  RuntimeBatchDirectiveExecutionState, RuntimeBatchDirectiveFailureCode,
} from "./runtime-batch-commit.js";
export { inferRuntimeLanguage } from "./runtime-language.js";
export type {
  RecordRuntimeRequestInput, RuntimeContinuityProjection, RuntimeInputDeliveryMode,
  RecordRuntimeInputQueueItemInput, RuntimeInputQueueItem, RuntimeInputQueuePolicy, RuntimeInputQueueSelector,
  RuntimeInputQueueStatus, RuntimeInputQueueUpdate, RuntimeRequestDeliveryScope,
  RuntimeRequestDeliveryScopeKind, RuntimeRequestKind, RuntimeRequestRecord,
  RuntimeRequestStatus, RuntimeRequestTransitionInput,
  RuntimeResumeSnapshot, RecordedOrchestrationDecision,
};
export type {
  RuntimeLanguageInput, RuntimeLanguageSource, RuntimeLanguageState, RuntimeLocale,
} from "./runtime-language.js";
export type {
  RuntimeRootExecution, RuntimeRootExecutionReason, RuntimeRootExecutionState,
  RuntimeRootSettlement,
} from "./runtime-root-execution.js";
export type {
  RuntimeInputPayloadInput,
  RuntimeInputPayloadPart,
  RuntimeInputPayloadV1,
} from "./runtime-input-payload.js";
export {
  isRuntimeItemOpen,
  renderRuntimeStatusLines,
  runtimeStatusSummary,
} from "./runtime-status-render.js";

export type RuntimeItemStatus = "pending" | "in_progress" | "running" | "completed" | "blocked" | "failed" | "aborted" | "stale" | "unknown";
export type ApprovalReviewDecision = "approved" | "needs_user" | "blocked";
export type ApprovalReviewRisk = "low" | "medium" | "high" | "critical";
export type ApprovalAuthorization = "none" | "low" | "medium" | "high";
export type RuntimeAttachmentKind = "image" | "text";
export type RuntimeAttachmentDisposition = "inline" | "placeholder" | "omitted";
export type RuntimePermissionMode = "ask" | "auto";
export type RuntimePermissionSource = "default" | "env" | "command" | "sandbox";
export type RuntimePolicyOutcomeDisposition = "fallback_allowed" | "terminal";
export interface RuntimePolicyOutcome {
  kind: "policy_block";
  disposition: RuntimePolicyOutcomeDisposition;
  source: string;
  categories?: string[];
}
export interface RuntimeSidecarDispatch { strategy: string; tool: string; reasonCodes: string[]; explanation: string; revision: number; executionState: string; concurrencyScope: string; primaryOverlap: boolean; childRunIds: string[]; branches: RuntimeSidecarDispatchBranch[]; failureCode?: string; }
export type RuntimeSidecarDispatchBranch = { id: string; selfContained: boolean; primaryDependency: string; dependsOnBranchIds: string[]; writeTargets: string[]; externalResourceKeys: string[]; execution?: { mode: string; readOnly: boolean; writeTargets: string[]; externalResourceKeys: string[] } };
export interface RuntimeStatusItem {
  id: string;
  title: string;
  status: RuntimeItemStatus;
  required?: boolean;
  rootRequestId?: string;
  sessionId?: string;
  summary?: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  elapsedMs?: number;
  sidecarDispatch?: RuntimeSidecarDispatch;
  policyOutcome?: RuntimePolicyOutcome;
}

export interface ApprovalReviewRecord {
  id: string;
  timestamp: string;
  tool: string;
  decision: ApprovalReviewDecision;
  risk: ApprovalReviewRisk;
  authorization: ApprovalAuthorization;
  rationale: string;
  inputSummary?: string;
  categories?: string[];
  source: string;
}

export interface RuntimeEventRecord {
  id: string;
  timestamp: string;
  kind: string;
  title: string;
  summary?: string;
  source: string;
  sidecarDispatch?: RuntimeSidecarDispatch;
}

export interface RuntimeModelState {
  provider: string;
  model: string;
  thinkingLevel: string;
  availableThinkingLevels: string[];
  modalities: string[];
  imageInput: "supported" | "unsupported" | "unknown";
  updatedAt: string;
}

export interface RuntimeTokenState {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  effectiveTokens: number;
  contextWindowTokens: number;
  contextUsedTokens: number;
  contextRemainingTokens: number;
  contextUsageRatio: number;
  turnCount: number;
  toolCalls: number;
  costUsd: number;
  updatedAt: string;
}

export interface RuntimeAttachmentRecord {
  id: string;
  timestamp: string;
  kind: RuntimeAttachmentKind;
  disposition: RuntimeAttachmentDisposition;
  placeholder: string;
  summary: string;
  sizeBytes?: number;
  mimeType?: string;
  source: string;
}

export interface RuntimePermissionState {
  mode: RuntimePermissionMode;
  source: RuntimePermissionSource;
  unattended: boolean;
  updatedAt: string;
}

export interface RuntimeStatusSnapshot {
  version: 1;
  updatedAt: string;
  language: RuntimeLanguageState;
  tasks: RuntimeStatusItem[];
  plans: RuntimeStatusItem[];
  subAgents: RuntimeStatusItem[];
  workflows: RuntimeStatusItem[];
  toolRuns: RuntimeStatusItem[];
  model: RuntimeModelState;
  tokens: RuntimeTokenState;
  attachments: RuntimeAttachmentRecord[];
  permission: RuntimePermissionState;
  inputQueue: RuntimeInputQueueItem[];
  requests: RuntimeRequestRecord[];
  continuity: RuntimeContinuityProjection;
  resume: RuntimeResumeSnapshot;
  rootExecution: RuntimeRootExecution;
  approvalReviews: ApprovalReviewRecord[];
  events: RuntimeEventRecord[];
  batchCommits: RuntimeBatchCommitRecord[];
}

export interface RuntimeStatusUpsertInput {
  plane: "tasks" | "plans" | "subAgents" | "workflows" | "toolRuns";
  item: Omit<RuntimeStatusItem, "updatedAt"> & { updatedAt?: string };
}

export type RuntimeStatusUpdater = (snapshot: RuntimeStatusSnapshot) => RuntimeStatusSnapshot;
const RUNTIME_STATUS_LOCK_TIMEOUT_MS = 5_000;
const RUNTIME_STATUS_LOCK_RETRY_MS = 10;

export function runtimeStatusFile(agentDir: string): string {
  return path.join(agentDir, "runtime-status.json");
}

export function defaultRuntimeStatusDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_DIR || env.CANVAST_AGENT_DIR || path.join(env.HOME || "/tmp", ".canvast");
}

export function emptyRuntimeStatusSnapshot(now = new Date().toISOString()): RuntimeStatusSnapshot {
  return {
    version: 1,
    updatedAt: now,
    language: {
      defaultLocale: "en",
      activeLocale: "en",
      source: "default",
      updatedAt: now,
    },
    tasks: [],
    plans: [],
    subAgents: [],
    workflows: [],
    toolRuns: [],
    model: {
      provider: "",
      model: "",
      thinkingLevel: "",
      availableThinkingLevels: [],
      modalities: [],
      imageInput: "unknown",
      updatedAt: now,
    },
    tokens: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      effectiveTokens: 0,
      contextWindowTokens: 0,
      contextUsedTokens: 0,
      contextRemainingTokens: 0,
      contextUsageRatio: 0,
      turnCount: 0,
      toolCalls: 0,
      costUsd: 0,
      updatedAt: now,
    },
    attachments: [],
    permission: {
      mode: "ask",
      source: "default",
      unattended: false,
      updatedAt: now,
    },
    inputQueue: [],
    requests: [],
    continuity: normalizeRuntimeContinuityProjection(undefined, now),
    resume: { revision: 0, state: "idle", updatedAt: now, readyCandidateCount: 0, candidates: [] },
    rootExecution: emptyRuntimeRootExecution(now),
    approvalReviews: [],
    events: [],
    batchCommits: [],
  };
}

export function readRuntimeStatus(agentDir = defaultRuntimeStatusDir()): RuntimeStatusSnapshot {
  const now = new Date().toISOString();
  const file = runtimeStatusFile(agentDir);
  if (!fs.existsSync(file)) return emptyRuntimeStatusSnapshot(now);
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!isRecord(raw)) return emptyRuntimeStatusSnapshot(now);
    const language = isRecord(raw.language) ? raw.language : {};
    const snapshot: RuntimeStatusSnapshot = {
      version: 1,
      updatedAt: asString(raw.updatedAt, now),
      language: {
        defaultLocale: "en",
        activeLocale: normalizeRuntimeLocale(language.activeLocale),
        source: normalizeRuntimeLanguageSource(language.source),
        updatedAt: asString(language.updatedAt, now),
      },
      tasks: normalizeItems(raw.tasks, now),
      plans: normalizeItems(raw.plans, now),
      subAgents: normalizeItems(raw.subAgents, now),
      workflows: normalizeItems(raw.workflows, now),
      toolRuns: normalizeItems(raw.toolRuns, now),
      model: normalizeModelState(raw.model, now),
      tokens: normalizeTokenState(raw.tokens, now),
      attachments: normalizeAttachments(raw.attachments, now),
      permission: normalizePermissionState(raw.permission, now),
      inputQueue: normalizeRuntimeInputQueue(raw.inputQueue, now, MAX_INPUT_QUEUE),
      requests: normalizeRuntimeRequests(raw.requests, now, MAX_REQUESTS),
      continuity: normalizeRuntimeContinuityProjection(raw.continuity, now),
      resume: normalizeResumeSnapshot(raw.resume, now),
      rootExecution: normalizeRuntimeRootExecution(raw.rootExecution, asString(raw.updatedAt, now)),
      approvalReviews: normalizeApprovalReviews(raw.approvalReviews, now),
      events: normalizeEvents(raw.events, now),
      batchCommits: normalizeRuntimeBatchCommitRecords(raw.batchCommits),
    };
    return {
      ...snapshot,
      rootExecution: projectRuntimeRootExecution(snapshot, snapshot.rootExecution),
    };
  } catch {
    return emptyRuntimeStatusSnapshot(now);
  }
}

export function writeRuntimeStatus(snapshot: RuntimeStatusSnapshot, agentDir = defaultRuntimeStatusDir()): void {
  fs.mkdirSync(agentDir, { recursive: true });
  const target = runtimeStatusFile(agentDir);
  const temporary = `${target}.${process.pid}.${process.hrtime.bigint()}.tmp`;
  const projected = {
    ...snapshot,
    rootExecution: projectRuntimeRootExecution(snapshot, snapshot.rootExecution),
  };
  fs.writeFileSync(temporary, JSON.stringify(projected, null, 2));
  fs.renameSync(temporary, target);
}

function queueRecordComparable(item: RuntimeInputQueueItem): Record<string, unknown> {
  return {
    id: item.id,
    sequence: item.sequence,
    timestamp: item.timestamp,
    policy: item.policy,
    textSummary: item.textSummary,
    payloadDigest: runtimeInputPayloadDigest(item.payload),
    source: item.source,
    affectsActiveWork: item.affectsActiveWork,
    status: item.status,
    requestId: item.requestId,
    deliveryMode: item.deliveryMode,
    deliveredAt: item.deliveredAt,
    answeredAt: item.answeredAt,
    hasVisibleReply: item.hasVisibleReply,
    failureReason: item.failureReason,
    attentionRequired: item.attentionRequired,
    deferInfo: item.deferInfo,
  };
}

function queueChanged(current: RuntimeStatusSnapshot, next: RuntimeStatusSnapshot): boolean {
  if (current.inputQueue.length !== next.inputQueue.length) return true;
  for (let index = 0; index < current.inputQueue.length; index += 1) {
    if (JSON.stringify(queueRecordComparable(current.inputQueue[index])) !== JSON.stringify(queueRecordComparable(next.inputQueue[index]))) {
      return true;
    }
  }
  return false;
}

function finalizeRuntimeStatusUpdate(current: RuntimeStatusSnapshot, next: RuntimeStatusSnapshot): RuntimeStatusSnapshot {
  const currentRevision = current.continuity.inputQueueRevision || 0;
  const declaredRevision = next.continuity.inputQueueRevision || 0;
  const changed = queueChanged(current, next);
  const bumpedRevision = declaredRevision !== currentRevision
    ? declaredRevision
    : changed
      ? currentRevision + 1
      : currentRevision;
  return {
    ...next,
    continuity: {
      ...next.continuity,
      inputQueueRevision: bumpedRevision,
      updatedAt: changed && next.continuity.updatedAt === current.continuity.updatedAt
        ? next.updatedAt
        : next.continuity.updatedAt,
    },
  };
}

export function updateRuntimeStatus(agentDir: string, updater: RuntimeStatusUpdater): RuntimeStatusSnapshot {
  return withOwnedFileLock(
    runtimeStatusFile(agentDir),
    { timeoutMs: RUNTIME_STATUS_LOCK_TIMEOUT_MS, retryMs: RUNTIME_STATUS_LOCK_RETRY_MS },
    () => {
      const current = readRuntimeStatus(agentDir);
      const next = finalizeRuntimeStatusUpdate(current, updater(current));
      const projected = {
        ...next,
        rootExecution: projectRuntimeRootExecution(next, next.rootExecution),
      };
      writeRuntimeStatus(projected, agentDir);
      return projected;
    },
  );
}

export function updateRuntimeLanguage(agentDir: string, input: RuntimeLanguageInput): RuntimeStatusSnapshot {
  const language = inferRuntimeLanguage(input);
  return updateRuntimeStatus(agentDir, snapshot => ({
    ...snapshot,
    updatedAt: language.updatedAt,
    language,
  }));
}

export function upsertRuntimeStatusItem(agentDir: string, input: RuntimeStatusUpsertInput): RuntimeStatusSnapshot {
  const now = input.item.updatedAt || new Date().toISOString();
  return updateRuntimeStatus(agentDir, snapshot => {
    const item: RuntimeStatusItem = {
      id: input.item.id,
      title: input.item.title,
      status: input.item.status,
      required: input.item.required,
      rootRequestId: input.item.rootRequestId || snapshot.rootExecution.rootRequestId,
      sessionId: input.item.sessionId || snapshot.rootExecution.sessionId,
      summary: input.item.summary,
      updatedAt: now,
      startedAt: input.item.startedAt,
      completedAt: input.item.completedAt,
      elapsedMs: input.item.elapsedMs,
      sidecarDispatch: input.item.sidecarDispatch,
      policyOutcome: input.item.policyOutcome,
    };
    const existing = snapshot[input.plane].filter(entry => entry.id !== item.id);
    return {
      ...snapshot,
      updatedAt: now,
      [input.plane]: [...existing, item].slice(-MAX_ITEMS_PER_PLANE),
    };
  });
}

export function startRuntimeRootExecution(
  agentDir: string,
  input: { requestId: string; sessionId?: string; timestamp?: string },
): RuntimeStatusSnapshot {
  const timestamp = input.timestamp || new Date().toISOString();
  return updateRuntimeStatus(agentDir, snapshot => ({
    ...snapshot,
    updatedAt: timestamp,
    rootExecution: reduceRuntimeRootExecution(snapshot.rootExecution, snapshot, {
      type: "root_started",
      requestId: input.requestId,
      sessionId: input.sessionId,
      timestamp,
    }),
  }));
}

export function settleRuntimeRootExecution(
  agentDir: string,
  input: { requestId?: string; outcome: Exclude<RuntimeRootSettlement, "pending">; timestamp?: string },
): RuntimeStatusSnapshot {
  const timestamp = input.timestamp || new Date().toISOString();
  return updateRuntimeStatus(agentDir, snapshot => ({
    ...snapshot,
    updatedAt: timestamp,
    rootExecution: reduceRuntimeRootExecution(snapshot.rootExecution, snapshot, {
      type: "agent_settled",
      requestId: input.requestId,
      outcome: input.outcome,
      timestamp,
    }),
  }));
}

export function updateRuntimeModel(
  agentDir: string,
  input: Partial<Omit<RuntimeModelState, "updatedAt">> & { updatedAt?: string },
): RuntimeStatusSnapshot {
  const updatedAt = input.updatedAt || new Date().toISOString();
  return updateRuntimeStatus(agentDir, snapshot => ({
    ...snapshot,
    updatedAt,
    model: {
      ...snapshot.model,
      ...input,
      updatedAt,
    },
  }));
}

export function updateRuntimeTokens(
  agentDir: string,
  input: Partial<Omit<RuntimeTokenState, "updatedAt">> & { updatedAt?: string },
): RuntimeStatusSnapshot {
  const updatedAt = input.updatedAt || new Date().toISOString();
  return updateRuntimeStatus(agentDir, snapshot => ({
    ...snapshot,
    updatedAt,
    tokens: {
      ...snapshot.tokens,
      ...input,
      updatedAt,
    },
  }));
}

export function updateRuntimePermission(
  agentDir: string,
  input: Partial<Omit<RuntimePermissionState, "updatedAt">> & { updatedAt?: string },
): RuntimeStatusSnapshot {
  const updatedAt = input.updatedAt || new Date().toISOString();
  return updateRuntimeStatus(agentDir, snapshot => ({
    ...snapshot,
    updatedAt,
    permission: {
      ...snapshot.permission,
      ...input,
      updatedAt,
    },
  }));
}

export function recordRuntimeAttachment(
  agentDir: string,
  input: Omit<RuntimeAttachmentRecord, "id" | "timestamp"> & { id?: string; timestamp?: string },
): RuntimeStatusSnapshot {
  const timestamp = input.timestamp || new Date().toISOString();
  const id = input.id || `attachment-${fingerprint([timestamp, input.kind, input.placeholder, input.summary])}`;
  const record: RuntimeAttachmentRecord = {
    id,
    timestamp,
    kind: input.kind,
    disposition: input.disposition,
    placeholder: input.placeholder,
    summary: input.summary,
    sizeBytes: input.sizeBytes,
    mimeType: input.mimeType,
    source: input.source,
  };
  return updateRuntimeStatus(agentDir, snapshot => ({
    ...snapshot,
    updatedAt: timestamp,
    attachments: [...snapshot.attachments.filter(item => item.id !== id), record].slice(-MAX_ATTACHMENTS),
  }));
}

export function recordRuntimeInputQueueItem(
  agentDir: string,
  input: RecordRuntimeInputQueueItemInput,
): RuntimeStatusSnapshot {
  const timestamp = input.timestamp || new Date().toISOString();
  const textSummary = summarizeRuntimeInput(input.textSummary, 180);
  const id = input.id || (input.requestId
    ? `input-${fingerprint([input.requestId])}`
    : `input-${fingerprint([timestamp, input.policy, textSummary, input.source])}`);
  return updateRuntimeStatus(agentDir, snapshot => {
    const payload = input.payload ? persistRuntimeInputPayload(agentDir, input.payload) : undefined;
    const existing = snapshot.inputQueue.find(item => item.id === id || (input.requestId && item.requestId === input.requestId));
    const record: RuntimeInputQueueItem = {
      id: existing?.id || id, timestamp: existing?.timestamp || timestamp, policy: input.policy, textSummary, source: input.source,
      affectsActiveWork: input.affectsActiveWork, status: existing?.status || input.status, requestId: input.requestId,
      payload: payload || existing?.payload,
      deliveryMode: existing?.deliveryMode || input.deliveryMode, deliveredAt: existing?.deliveredAt || input.deliveredAt,
      answeredAt: existing?.answeredAt || input.answeredAt, hasVisibleReply: existing?.hasVisibleReply || input.hasVisibleReply,
      failureReason: existing?.failureReason || input.failureReason,
      sequence: existing?.sequence ?? input.sequence ?? (snapshot.inputQueue.reduce((max, item) => Math.max(max, item.sequence), -1) + 1),
    };
    if (existing && JSON.stringify(queueRecordComparable(existing)) === JSON.stringify(queueRecordComparable(record))) {
      return snapshot;
    }
    const withQueue = {
      ...snapshot,
      updatedAt: timestamp,
      inputQueue: [...snapshot.inputQueue.filter(item => item.id !== record.id && (!input.requestId || item.requestId !== input.requestId)), record].slice(-MAX_INPUT_QUEUE),
    };
    if (!input.requestId) return withQueue;
    return recordRuntimeRequestInSnapshot(withQueue, {
      requestId: input.requestId,
      kind: runtimeRequestKindForQueuePolicy(input.policy),
      textSummary,
      status: input.status === "delivered" || input.status === "acknowledged" ? "delivered" : input.status === "answered" ? "answered" : input.status === "failed" ? "failed" : "queued",
      hasVisibleReply: input.hasVisibleReply,
      createdAt: timestamp,
      deliveredAt: input.deliveredAt,
      answeredAt: input.answeredAt,
      deliveryMode: input.deliveryMode,
      failureReason: input.failureReason,
    });
  });
}

export function acknowledgeRuntimeInputQueueItem(
  agentDir: string,
  input: { text?: string; id?: string; timestamp?: string; source?: string },
): RuntimeStatusSnapshot {
  const timestamp = input.timestamp || new Date().toISOString();
  const summary = input.text ? summarizeRuntimeInput(input.text, 180) : "";
  return updateRuntimeStatus(agentDir, snapshot => {
    let matched = false;
    const inputQueue = snapshot.inputQueue.map(item => {
      const eligible = item.status === "queued" || item.status === "interrupt";
      const isMatch = eligible && (input.id ? item.id === input.id : (!matched && item.textSummary === summary));
      if (!isMatch) return item;
      matched = true;
      return { ...item, status: "acknowledged" as RuntimeInputQueueStatus };
    });
    return {
      ...snapshot,
      updatedAt: timestamp,
      inputQueue,
      events: input.source
        ? [...snapshot.events, {
          id: `event-${fingerprint([timestamp, input.source, summary || input.id || "input"])}`,
          timestamp,
          kind: "input_queue",
          title: "Input queue item acknowledged",
          summary: summary || input.id,
          source: input.source,
        }].slice(-MAX_EVENTS)
        : snapshot.events,
    };
  });
}

export const transitionRuntimeInputQueueItem = (agentDir: string, input: RuntimeInputQueueUpdate): RuntimeStatusSnapshot =>
  updateRuntimeStatus(agentDir, snapshot => updateRuntimeInputQueueItem(snapshot, input));

export function markRuntimeInputDelivered(
  agentDir: string, input: RuntimeInputQueueSelector & { timestamp?: string; deliveryMode?: RuntimeInputDeliveryMode },
): RuntimeStatusSnapshot {
  return updateRuntimeStatus(agentDir, snapshot => {
    const summary = input.text === undefined ? undefined : summarizeRuntimeInput(input.text, 180);
    const target = snapshot.inputQueue.find(candidate =>
      (candidate.status === "queued" || candidate.status === "interrupt") &&
      (input.id ? candidate.id === input.id : input.requestId ? candidate.requestId === input.requestId : summary === undefined || candidate.textSummary === summary),
    );
    if (!target) return snapshot;
    const next = markRuntimeInputQueueItemDelivered(snapshot, { ...input, id: target.id });
    if (!target.requestId) return next;
    return markRuntimeRequestDelivered(next, {
      requestId: target.requestId,
      timestamp: input.timestamp,
      deliveryMode: input.deliveryMode,
    });
  });
}

export function markRuntimeInputAnswered(
  agentDir: string, input: RuntimeInputQueueSelector & { timestamp?: string; visibleText: string },
): RuntimeStatusSnapshot {
  return updateRuntimeStatus(agentDir, snapshot => {
    if (!input.visibleText.trim()) return snapshot;
    const summary = input.text === undefined ? undefined : summarizeRuntimeInput(input.text, 180);
    const target = snapshot.inputQueue.find(candidate =>
      (candidate.status === "queued" || candidate.status === "interrupt" || candidate.status === "delivered" || candidate.status === "acknowledged") &&
      (input.id ? candidate.id === input.id : input.requestId ? candidate.requestId === input.requestId : summary === undefined || candidate.textSummary === summary),
    );
    if (!target) return snapshot;
    const next = markRuntimeInputQueueItemAnswered(snapshot, { ...input, id: target.id });
    if (!target.requestId) return next;
    return markRuntimeRequestAnswered(next, {
      requestId: target.requestId,
      timestamp: input.timestamp,
      visibleText: input.visibleText,
    });
  });
}

export const recordRuntimeRequest = (agentDir: string, input: RecordRuntimeRequestInput): RuntimeStatusSnapshot =>
  updateRuntimeStatus(agentDir, snapshot => recordRuntimeRequestInSnapshot(snapshot, input, MAX_REQUESTS));
export const transitionRuntimeRequest = (agentDir: string, input: RuntimeRequestTransitionInput): RuntimeStatusSnapshot =>
  updateRuntimeStatus(agentDir, snapshot => updateRuntimeRequestRecord(snapshot, input));
export const markRuntimeRequestAsDelivered = (agentDir: string, input: Omit<RuntimeRequestTransitionInput, "status">): RuntimeStatusSnapshot => {
  return updateRuntimeStatus(agentDir, snapshot => markRuntimeRequestDelivered(snapshot, input));
};
export const markRuntimeRequestAsAnswering = (agentDir: string, input: Omit<RuntimeRequestTransitionInput, "status">): RuntimeStatusSnapshot => {
  return updateRuntimeStatus(agentDir, snapshot => markRuntimeRequestAnswering(snapshot, input));
};
export const markRuntimeRequestAsAnswered = (agentDir: string, input: Omit<RuntimeRequestTransitionInput, "status"> & { visibleText: string }): RuntimeStatusSnapshot => {
  return updateRuntimeStatus(agentDir, snapshot => markRuntimeRequestAnswered(snapshot, input));
};

export function updateRuntimeContinuity(
  agentDir: string, continuity: ContextContinuityState | RuntimeContinuityProjection,
): RuntimeStatusSnapshot {
  const projection = "version" in continuity ? projectContextContinuity(continuity) : continuity;
  const resume = projectRuntimeResume(readRuntimeResume(agentDir));
  return updateRuntimeStatus(agentDir, snapshot => ({
    ...snapshot,
    updatedAt: projection.updatedAt,
    continuity: projection,
    resume,
  }));
}

export function updateRuntimeResumeProjection(agentDir: string): RuntimeStatusSnapshot {
  const resume = projectRuntimeResume(readRuntimeResume(agentDir));
  return updateRuntimeStatus(agentDir, snapshot => ({
    ...snapshot,
    updatedAt: resume.updatedAt,
    resume,
  }));
}

export function recordApprovalReview(
  agentDir: string,
  input: Omit<ApprovalReviewRecord, "id" | "timestamp"> & { id?: string; timestamp?: string },
): RuntimeStatusSnapshot {
  const timestamp = input.timestamp || new Date().toISOString();
  const id = input.id || `approval-${fingerprint([timestamp, input.tool, input.decision, input.rationale])}`;
  const record: ApprovalReviewRecord = {
    id,
    timestamp,
    tool: input.tool,
    decision: input.decision,
    risk: input.risk,
    authorization: input.authorization,
    rationale: input.rationale,
    inputSummary: input.inputSummary,
    categories: input.categories || [],
    source: input.source,
  };
  return updateRuntimeStatus(agentDir, snapshot => ({
    ...snapshot,
    updatedAt: timestamp,
    approvalReviews: [...snapshot.approvalReviews.filter(item => item.id !== id), record].slice(-MAX_APPROVAL_REVIEWS),
  }));
}

export function recordRuntimeEvent(
  agentDir: string,
  input: Omit<RuntimeEventRecord, "id" | "timestamp"> & { id?: string; timestamp?: string },
): RuntimeStatusSnapshot {
  const timestamp = input.timestamp || new Date().toISOString();
  const id = input.id || `event-${fingerprint([timestamp, input.kind, input.title])}`;
  const record: RuntimeEventRecord = {
    id,
    timestamp,
    kind: input.kind,
    title: input.title,
    summary: input.summary,
    source: input.source,
    sidecarDispatch: input.sidecarDispatch,
  };
  return updateRuntimeStatus(agentDir, snapshot => ({
    ...snapshot,
    updatedAt: timestamp,
    events: [...snapshot.events.filter(item => item.id !== id), record].slice(-MAX_EVENTS),
  }));
}
