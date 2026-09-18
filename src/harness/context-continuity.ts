/**
 * =============================================================================
 * Canvast — Context Continuity / Canvast source file
 * =============================================================================
 * @file        src/harness/context-continuity.ts
 * @brief       Durable state machines for requests and context compaction.
 * @description Keeps turn identity and runtime work stable across compaction,
 *              session restoration, and project-process restarts.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import { createHash } from "node:crypto";

import { dispatchSerializedStateUpdate, readSerializedState, writeSerializedState } from "./context-continuity/serialized-state.js";
import {
  summarizeRuntimeInput,
  runtimeRequestKindForQueuePolicy,
  normalizeRuntimeInputQueue,
  normalizeRuntimeRequests,
  isRuntimeInputQueuePending,
  pendingRuntimeInputQueueItems,
  updateRuntimeInputQueueItem,
  markRuntimeInputQueueItemDelivered,
  markRuntimeInputQueueItemAnswered,
  recordRuntimeRequestInSnapshot,
  updateRuntimeRequestRecord,
  markRuntimeRequestDelivered,
  markRuntimeRequestAnswering,
  markRuntimeRequestAnswered,
  type RecordRuntimeInputQueueItemInput,
  type RecordRuntimeRequestInput,
  type RuntimeInputDeliveryMode,
  type RuntimeInputQueueItem,
  type RuntimeInputQueuePolicy,
  type RuntimeInputQueueSelector,
  type RuntimeInputQueueStatus,
  type RuntimeInputQueueUpdate,
  type RuntimeQueueSnapshotLike,
  type RuntimeRequestDeliveryScope,
  type RuntimeRequestDeliveryScopeKind,
  type RuntimeRequestKind,
  type RuntimeRequestRecord,
  type RuntimeRequestStatus,
  type RuntimeRequestTransitionInput,
} from "./context-continuity/runtime-queue.js";
import {
  activeTurnMatchesCompaction,
  contextContinuityStateIO,
  lateCompactionRecovery,
  latestCompactionIndex,
} from "./context-continuity/reducer-support.js";
import { contextContinuityFile } from "./context-continuity/storage.js";

export { contextContinuityFile };
export {
  summarizeRuntimeInput,
  runtimeRequestKindForQueuePolicy,
  normalizeRuntimeInputQueue,
  normalizeRuntimeRequests,
  isRuntimeInputQueuePending,
  pendingRuntimeInputQueueItems,
  updateRuntimeInputQueueItem,
  markRuntimeInputQueueItemDelivered,
  markRuntimeInputQueueItemAnswered,
  recordRuntimeRequestInSnapshot,
  updateRuntimeRequestRecord,
  markRuntimeRequestDelivered,
  markRuntimeRequestAnswering,
  markRuntimeRequestAnswered,
};
export type {
  RecordRuntimeInputQueueItemInput,
  RecordRuntimeRequestInput,
  RuntimeInputDeliveryMode,
  RuntimeInputQueueItem,
  RuntimeInputQueuePolicy,
  RuntimeInputQueueSelector,
  RuntimeInputQueueStatus,
  RuntimeInputQueueUpdate,
  RuntimeQueueSnapshotLike,
  RuntimeRequestDeliveryScope,
  RuntimeRequestDeliveryScopeKind,
  RuntimeRequestKind,
  RuntimeRequestRecord,
  RuntimeRequestStatus,
  RuntimeRequestTransitionInput,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function fingerprint(parts: string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}

export type ContextContinuationPhase =
  | "idle"
  | "active"
  | "compacting"
  | "awaiting_resume"
  | "resumed"
  | "recoverable_failure"
  | "completed"
  | "interrupted";
export type ContextCompactionReason = "manual" | "threshold" | "overflow" | "unknown";
export type ContextContinuationOwner = "native_runtime" | "harness" | "user";
export type ContextSessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";

export interface RuntimeContinuityCheckpoint {
  taskIds: string[];
  planIds: string[];
  subAgentIds: string[];
  workflowIds: string[];
  toolRunIds: string[];
}

export interface ContextContinuityTurn {
  turnId: string;
  requestId: string;
  sessionId: string;
  phase: ContextContinuationPhase;
  attempt: number;
  resumeCount: number;
  startedAt: string;
  updatedAt: string;
  checkpoint: RuntimeContinuityCheckpoint;
}

export interface ContextCompactionAttempt {
  operationId: string;
  turnId: string;
  reason: ContextCompactionReason;
  willRetry: boolean;
  owner: ContextContinuationOwner;
  status: "prepared" | "committed" | "resumed" | "failed";
  preparedAt: string;
  completedAt?: string;
  resumedAt?: string;
  compactionEntryId?: string;
  firstKeptEntryId?: string;
  branchEntryIds: string[];
  retryable?: boolean;
  error?: string;
}

export type ContextContinuationDispatchStatus = "pending" | "attempted" | "acknowledged";

export interface ContextContinuationDispatch {
  id: string;
  kind: "compaction" | "sidecar";
  requestId: string;
  operationId?: string;
  afterRequestId?: string;
  status: ContextContinuationDispatchStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export interface ContextContinuationReceipt {
  id: string;
  status: "claimed" | "consumed";
  claimedAt: string;
  updatedAt: string;
  receiveCount: number;
}

export interface ContextContinuityRecovery {
  operationId: string;
  retryable: boolean;
  message: string;
  availableActions: Array<"retry_compaction" | "resume_same_turn" | "reset_session">;
}

export interface ContextContinuityState {
  version: 1;
  revision: number;
  updatedAt: string;
  project: { id: string; restartCount: number; updatedAt: string };
  session: { id: string; epoch: number; status: "active" | "reset" | "forked"; updatedAt: string };
  activeTurn?: ContextContinuityTurn;
  compactions: ContextCompactionAttempt[];
  continuationOutbox: ContextContinuationDispatch[];
  continuationInbox: ContextContinuationReceipt[];
  recovery?: ContextContinuityRecovery;
  processedEventIds: string[];
  inputQueueRevision: number;
}

export interface RuntimeContinuityProjection {
  phase: ContextContinuationPhase;
  projectId?: string;
  sessionId?: string;
  turnId?: string;
  requestId?: string;
  compactionOperationId?: string;
  continuationOwner?: ContextContinuationOwner;
  pendingContinuationCount?: number;
  recoverable: boolean;
  recoveryMessage?: string;
  updatedAt: string;
  inputQueueRevision: number;
}

export type ContextContinuitySignalKind =
  | "preserve_runtime"
  | "await_native_retry"
  | "resume_same_turn"
  | "recovery_available"
  | "retire_session_runtime"
  | "restore_session_runtime"
  | "project_restart_preserved"
  | "fork_from_checkpoint"
  | "turn_completed";

export interface ContextContinuitySignal {
  id: string;
  kind: ContextContinuitySignalKind;
  timestamp: string;
  requestId?: string;
  operationId?: string;
  shouldDispatch: boolean;
  visible: boolean;
  message: string;
}

export type ContextContinuityEvent =
  | { type: "turn_started"; eventId: string; timestamp: string; projectId: string; sessionId: string; turnId: string; requestId: string; checkpoint?: RuntimeContinuityCheckpoint }
  | { type: "compaction_prepared"; eventId: string; timestamp: string; sessionId: string; turnId: string; reason: ContextCompactionReason; willRetry: boolean; continuationOwner?: ContextContinuationOwner; allowHarnessResume?: boolean; firstKeptEntryId?: string; branchEntryIds?: string[] }
  | { type: "compaction_succeeded"; eventId: string; timestamp: string; operationId?: string; compactionEntryId?: string }
  | { type: "compaction_failed"; eventId: string; timestamp: string; operationId?: string; error: string; retryable: boolean }
  | { type: "continuation_queued"; eventId: string; timestamp: string; dispatchId: string; kind: "compaction" | "sidecar"; requestId: string; operationId?: string; afterRequestId?: string }
  | { type: "continuation_dispatch_started"; eventId: string; timestamp: string; dispatchId: string }
  | { type: "continuation_dispatch_succeeded"; eventId: string; timestamp: string; dispatchId: string }
  | { type: "continuation_dispatch_failed"; eventId: string; timestamp: string; dispatchId: string; error: string }
  | { type: "continuation_received"; eventId: string; timestamp: string; dispatchId: string }
  | { type: "continuation_consumed"; eventId: string; timestamp: string; dispatchId: string }
  | { type: "continuation_released"; eventId: string; timestamp: string; dispatchId: string }
  | { type: "continuation_acknowledged"; eventId: string; timestamp: string; dispatchId: string }
  | { type: "turn_resumed"; eventId: string; timestamp: string; turnId: string; cause: "native_retry" | "harness_retry" | "session_restore" }
  | { type: "turn_completed"; eventId: string; timestamp: string; turnId: string }
  | { type: "session_started"; eventId: string; timestamp: string; sessionId: string; reason: ContextSessionStartReason }
  | { type: "session_reset"; eventId: string; timestamp: string; sessionId: string }
  | { type: "project_restarted"; eventId: string; timestamp: string; projectId: string };

export interface ContextContinuityTransition {
  state: ContextContinuityState;
  projection: RuntimeContinuityProjection;
  signals: ContextContinuitySignal[];
  duplicate: boolean;
}

const EMPTY_CHECKPOINT: RuntimeContinuityCheckpoint = { taskIds: [], planIds: [], subAgentIds: [], workflowIds: [], toolRunIds: [] };
const OPEN_RUNTIME_STATUSES = new Set(["pending", "in_progress", "running", "blocked", "unknown"]);
const MAX_COMPACTIONS = 32;
const MAX_CONTINUATION_OUTBOX = 64;
const MAX_CONTINUATION_INBOX = 64;
const MAX_PROCESSED_EVENTS = 128;

function normalizeCheckpoint(value: unknown): RuntimeContinuityCheckpoint {
  const record = isRecord(value) ? value : {};
  return {
    taskIds: uniqueStrings(asStringArray(record.taskIds)),
    planIds: uniqueStrings(asStringArray(record.planIds)),
    subAgentIds: uniqueStrings(asStringArray(record.subAgentIds)),
    workflowIds: uniqueStrings(asStringArray(record.workflowIds)),
    toolRunIds: uniqueStrings(asStringArray(record.toolRunIds)),
  };
}

export function captureRuntimeContinuityCheckpoint(snapshot: {
  tasks: Array<{ id: string; status: string }>;
  plans: Array<{ id: string; status: string }>;
  subAgents: Array<{ id: string; status: string }>;
  workflows: Array<{ id: string; status: string }>;
  toolRuns: Array<{ id: string; status: string }>;
}): RuntimeContinuityCheckpoint {
  const activeIds = (items: Array<{ id: string; status: string }>) => uniqueStrings(items.filter(item => OPEN_RUNTIME_STATUSES.has(item.status)).map(item => item.id));
  return {
    taskIds: activeIds(snapshot.tasks),
    planIds: activeIds(snapshot.plans),
    subAgentIds: activeIds(snapshot.subAgents),
    workflowIds: activeIds(snapshot.workflows),
    toolRunIds: activeIds(snapshot.toolRuns),
  };
}

export function emptyContextContinuityState(
  input: { projectId?: string; sessionId?: string; now?: string } = {},
): ContextContinuityState {
  const now = input.now || new Date().toISOString();
  return {
    version: 1,
    revision: 0,
    updatedAt: now,
    project: { id: input.projectId || "", restartCount: 0, updatedAt: now },
    session: { id: input.sessionId || "", epoch: 0, status: "active", updatedAt: now },
    compactions: [],
    continuationOutbox: [],
    continuationInbox: [],
    processedEventIds: [],
    inputQueueRevision: 0,
  };
}

function normalizeTurn(value: unknown): ContextContinuityTurn | undefined {
  if (!isRecord(value)) return undefined;
  const turnId = asString(value.turnId);
  const requestId = asString(value.requestId);
  if (!turnId || !requestId) return undefined;
  const phase = normalizeContinuityPhase(value.phase);
  return {
    turnId,
    requestId,
    sessionId: asString(value.sessionId),
    phase,
    attempt: Math.max(1, Number(value.attempt) || 1),
    resumeCount: Math.max(0, Number(value.resumeCount) || 0),
    startedAt: asString(value.startedAt),
    updatedAt: asString(value.updatedAt),
    checkpoint: normalizeCheckpoint(value.checkpoint),
  };
}

function normalizeContinuityPhase(value: unknown): ContextContinuationPhase {
  if (
    value === "active" || value === "compacting" || value === "awaiting_resume" || value === "resumed" ||
    value === "recoverable_failure" || value === "completed" || value === "interrupted"
  ) return value;
  return "idle";
}

function normalizeCompaction(value: unknown): ContextCompactionAttempt | undefined {
  if (!isRecord(value) || !asString(value.operationId) || !asString(value.turnId)) return undefined;
  const owner = value.owner === "harness" || value.owner === "user" ? value.owner : "native_runtime";
  const status = value.status === "committed" || value.status === "resumed" || value.status === "failed" ? value.status : "prepared";
  const reason = value.reason === "manual" || value.reason === "threshold" || value.reason === "overflow" ? value.reason : "unknown";
  return {
    operationId: asString(value.operationId),
    turnId: asString(value.turnId),
    reason,
    willRetry: value.willRetry === true,
    owner,
    status,
    preparedAt: asString(value.preparedAt),
    completedAt: asString(value.completedAt) || undefined,
    resumedAt: asString(value.resumedAt) || undefined,
    compactionEntryId: asString(value.compactionEntryId) || undefined,
    firstKeptEntryId: asString(value.firstKeptEntryId) || undefined,
    branchEntryIds: uniqueStrings(asStringArray(value.branchEntryIds)),
    retryable: typeof value.retryable === "boolean" ? value.retryable : undefined,
    error: asString(value.error) || undefined,
  };
}

function normalizeContinuationDispatch(value: unknown): ContextContinuationDispatch | undefined {
  if (!isRecord(value) || !asString(value.id) || !asString(value.requestId)) return undefined;
  const status: ContextContinuationDispatchStatus = value.status === "acknowledged"
    ? "acknowledged"
    : value.status === "attempted" || value.status === "dispatching" || value.status === "dispatched"
      ? "attempted"
      : "pending";
  return {
    id: asString(value.id), kind: value.kind === "sidecar" ? "sidecar" : "compaction",
    requestId: asString(value.requestId), operationId: asString(value.operationId) || undefined,
    afterRequestId: asString(value.afterRequestId) || undefined, status,
    attempts: Math.max(0, Number(value.attempts) || 0), createdAt: asString(value.createdAt),
    updatedAt: asString(value.updatedAt), lastError: asString(value.lastError) || undefined,
  };
}

function normalizeContinuationReceipt(value: unknown): ContextContinuationReceipt | undefined {
  if (!isRecord(value) || !asString(value.id)) return undefined;
  return {
    id: asString(value.id),
    status: value.status === "consumed" ? "consumed" : "claimed",
    claimedAt: asString(value.claimedAt),
    updatedAt: asString(value.updatedAt),
    receiveCount: Math.max(1, Number(value.receiveCount) || 1),
  };
}

export function normalizeRuntimeContinuityProjection(value: unknown, now: string): RuntimeContinuityProjection {
  const record = isRecord(value) ? value : {};
  return {
    phase: normalizeContinuityPhase(record.phase),
    projectId: asString(record.projectId) || undefined,
    sessionId: asString(record.sessionId) || undefined,
    turnId: asString(record.turnId) || undefined,
    requestId: asString(record.requestId) || undefined,
    compactionOperationId: asString(record.compactionOperationId) || undefined,
    continuationOwner: record.continuationOwner === "harness" || record.continuationOwner === "user" ? record.continuationOwner : record.continuationOwner === "native_runtime" ? "native_runtime" : undefined,
    pendingContinuationCount: Math.max(0, Math.floor(Number(record.pendingContinuationCount) || 0)),
    recoverable: record.recoverable === true,
    recoveryMessage: asString(record.recoveryMessage) || undefined,
    updatedAt: asString(record.updatedAt, now),
    inputQueueRevision: Math.max(0, Math.floor(Number(record.inputQueueRevision) || 0)),
  };
}

function normalizeContinuityState(value: unknown, now: string): ContextContinuityState {
  if (!isRecord(value)) return emptyContextContinuityState({ now });
  const project = isRecord(value.project) ? value.project : {};
  const session = isRecord(value.session) ? value.session : {};
  const recovery = isRecord(value.recovery) && asString(value.recovery.operationId) ? {
    operationId: asString(value.recovery.operationId),
    retryable: value.recovery.retryable === true,
    message: asString(value.recovery.message, "Context compaction failed."),
    availableActions: asStringArray(value.recovery.availableActions).filter((item): item is ContextContinuityRecovery["availableActions"][number] => item === "retry_compaction" || item === "resume_same_turn" || item === "reset_session"),
  } : undefined;
  return {
    version: 1,
    revision: Math.max(0, Number(value.revision) || 0),
    updatedAt: asString(value.updatedAt, now),
    project: { id: asString(project.id), restartCount: Math.max(0, Number(project.restartCount) || 0), updatedAt: asString(project.updatedAt, now) },
    session: {
      id: asString(session.id),
      epoch: Math.max(0, Number(session.epoch) || 0),
      status: session.status === "reset" || session.status === "forked" ? session.status : "active",
      updatedAt: asString(session.updatedAt, now),
    },
    activeTurn: normalizeTurn(value.activeTurn),
    compactions: Array.isArray(value.compactions) ? value.compactions.map(normalizeCompaction).filter((item): item is ContextCompactionAttempt => Boolean(item)).slice(-MAX_COMPACTIONS) : [],
    continuationOutbox: Array.isArray(value.continuationOutbox)
      ? value.continuationOutbox.map(normalizeContinuationDispatch).filter((item): item is ContextContinuationDispatch => Boolean(item)).slice(-MAX_CONTINUATION_OUTBOX)
      : [],
    continuationInbox: Array.isArray(value.continuationInbox)
      ? value.continuationInbox.map(normalizeContinuationReceipt).filter((item): item is ContextContinuationReceipt => Boolean(item)).slice(-MAX_CONTINUATION_INBOX)
      : [],
    recovery,
    processedEventIds: uniqueStrings(asStringArray(value.processedEventIds)).slice(-MAX_PROCESSED_EVENTS),
    inputQueueRevision: Math.max(0, Number(value.inputQueueRevision) || 0),
  };
}

export function projectContextContinuity(state: ContextContinuityState): RuntimeContinuityProjection {
  const latest = state.compactions.at(-1);
  return {
    phase: state.activeTurn?.phase || "idle",
    projectId: state.project.id || undefined,
    sessionId: state.session.id || undefined,
    turnId: state.activeTurn?.turnId,
    requestId: state.activeTurn?.requestId,
    compactionOperationId: latest?.operationId,
    continuationOwner: latest?.owner,
    pendingContinuationCount: state.continuationOutbox.filter(item => item.status !== "acknowledged").length,
    recoverable: Boolean(state.recovery),
    recoveryMessage: state.recovery?.message,
    updatedAt: state.updatedAt,
    inputQueueRevision: state.inputQueueRevision || 0,
  };
}

export function renderContextContinuityStatus(state: ContextContinuityState): string {
  const projection = projectContextContinuity(state);
  const identity = projection.turnId ? `turn ${projection.turnId} request ${projection.requestId}` : "no active turn";
  const recovery = projection.recoverable ? ` | recoverable: ${projection.recoveryMessage}` : "";
  return `${projection.phase} | ${identity}${recovery}`;
}

export function contextContinuityEventId(type: ContextContinuityEvent["type"], parts: string[]): string {
  return `continuity-${fingerprint([type, ...parts])}`;
}

export function contextCompactionOperationId(input: {
  sessionId: string;
  turnId: string;
  reason: ContextCompactionReason;
  firstKeptEntryId?: string;
  branchEntryIds?: string[];
}): string {
  const branchIds = uniqueStrings(input.branchEntryIds || []).sort();
  return `compact-${fingerprint([input.sessionId, input.turnId, input.reason, input.firstKeptEntryId || "", ...branchIds])}`;
}

function signal(
  kind: ContextContinuitySignalKind,
  event: ContextContinuityEvent,
  message: string,
  options: { requestId?: string; operationId?: string; shouldDispatch?: boolean; visible?: boolean } = {},
): ContextContinuitySignal {
  return {
    id: `${event.eventId}:${kind}`,
    kind,
    timestamp: event.timestamp,
    requestId: options.requestId,
    operationId: options.operationId,
    shouldDispatch: options.shouldDispatch === true,
    visible: options.visible === true,
    message,
  };
}

function commitTransition(
  state: ContextContinuityState,
  event: ContextContinuityEvent,
  changes: Omit<Partial<ContextContinuityState>, "version" | "revision" | "updatedAt" | "processedEventIds">,
  signals: ContextContinuitySignal[],
  duplicate = false,
): ContextContinuityTransition {
  const next: ContextContinuityState = {
    ...state,
    ...changes,
    version: 1,
    revision: state.revision + 1,
    updatedAt: event.timestamp,
    processedEventIds: uniqueStrings([...state.processedEventIds, event.eventId]).slice(-MAX_PROCESSED_EVENTS),
  };
  return { state: next, projection: projectContextContinuity(next), signals, duplicate };
}

function duplicateTransition(state: ContextContinuityState): ContextContinuityTransition {
  return { state, projection: projectContextContinuity(state), signals: [], duplicate: true };
}

export function reduceContextContinuity(
  current: ContextContinuityState,
  event: ContextContinuityEvent,
): ContextContinuityTransition {
  const state = normalizeContinuityState(current, event.timestamp);
  if (state.processedEventIds.includes(event.eventId)) return duplicateTransition(state);

  if (event.type === "continuation_queued") {
    if (state.continuationOutbox.some(item => item.id === event.dispatchId)) return duplicateTransition(state);
    const dispatch: ContextContinuationDispatch = {
      id: event.dispatchId, kind: event.kind, requestId: event.requestId, operationId: event.operationId,
      afterRequestId: event.afterRequestId, status: "pending", attempts: 0, createdAt: event.timestamp, updatedAt: event.timestamp,
    };
    return commitTransition(state, event, {
      continuationOutbox: [...state.continuationOutbox, dispatch].slice(-MAX_CONTINUATION_OUTBOX),
    }, []);
  }

  if (event.type === "continuation_dispatch_started" || event.type === "continuation_dispatch_succeeded" ||
      event.type === "continuation_dispatch_failed" || event.type === "continuation_acknowledged") {
    if (!state.continuationOutbox.some(item => item.id === event.dispatchId)) return duplicateTransition(state);
    const continuationOutbox = state.continuationOutbox.map(item => {
      if (item.id !== event.dispatchId) return item;
      if (event.type === "continuation_dispatch_started") {
        return { ...item, status: "attempted" as const, attempts: item.attempts + 1, updatedAt: event.timestamp, lastError: undefined };
      }
      if (event.type === "continuation_dispatch_succeeded") {
        return { ...item, status: "attempted" as const, updatedAt: event.timestamp, lastError: undefined };
      }
      if (event.type === "continuation_dispatch_failed") {
        return { ...item, status: "pending" as const, updatedAt: event.timestamp, lastError: summarizeRuntimeInput(event.error, 500) };
      }
      return { ...item, status: "acknowledged" as const, updatedAt: event.timestamp, lastError: undefined };
    });
    return commitTransition(state, event, { continuationOutbox }, []);
  }

  if (event.type === "continuation_received") {
    if (!state.continuationOutbox.some(item => item.id === event.dispatchId)) return duplicateTransition(state);
    const existing = state.continuationInbox.find(item => item.id === event.dispatchId);
    const continuationInbox = existing
      ? state.continuationInbox.map(item => item.id === event.dispatchId ? {
          ...item, receiveCount: item.receiveCount + 1, updatedAt: event.timestamp,
        } : item)
      : [...state.continuationInbox, {
          id: event.dispatchId, status: "claimed" as const, claimedAt: event.timestamp,
          updatedAt: event.timestamp, receiveCount: 1,
        }].slice(-MAX_CONTINUATION_INBOX);
    return commitTransition(state, event, { continuationInbox }, []);
  }

  if (event.type === "continuation_consumed") {
    const receipt = state.continuationInbox.find(item => item.id === event.dispatchId);
    if (!receipt || receipt.status === "consumed") return duplicateTransition(state);
    const continuationInbox = state.continuationInbox.map(item => item.id === event.dispatchId
      ? { ...item, status: "consumed" as const, updatedAt: event.timestamp }
      : item);
    const continuationOutbox = state.continuationOutbox.map(item => item.id === event.dispatchId
      ? { ...item, status: "acknowledged" as const, updatedAt: event.timestamp, lastError: undefined }
      : item);
    return commitTransition(state, event, { continuationInbox, continuationOutbox }, []);
  }

  if (event.type === "continuation_released") {
    const receipt = state.continuationInbox.find(item => item.id === event.dispatchId);
    const dispatch = state.continuationOutbox.find(item => item.id === event.dispatchId);
    if (!dispatch || dispatch.status === "acknowledged" || receipt?.status === "consumed") return duplicateTransition(state);
    const continuationInbox = state.continuationInbox.filter(item => item.id !== event.dispatchId);
    const continuationOutbox = state.continuationOutbox.map(item => item.id === event.dispatchId
      ? { ...item, status: "pending" as const, updatedAt: event.timestamp }
      : item);
    return commitTransition(state, event, { continuationInbox, continuationOutbox }, []);
  }

  if (event.type === "turn_started") {
    const sameTurn = state.activeTurn?.turnId === event.turnId && state.activeTurn.requestId === event.requestId;
    if (sameTurn && state.activeTurn?.phase !== "completed" && state.activeTurn?.phase !== "interrupted") {
      return duplicateTransition(state);
    }
    const activeTurn: ContextContinuityTurn = {
      turnId: event.turnId, requestId: event.requestId, sessionId: event.sessionId, phase: "active", attempt: 1, resumeCount: 0,
      startedAt: event.timestamp, updatedAt: event.timestamp, checkpoint: normalizeCheckpoint(event.checkpoint || EMPTY_CHECKPOINT),
    };
    return commitTransition(state, event, {
      project: { id: event.projectId, restartCount: state.project.id === event.projectId ? state.project.restartCount : 0, updatedAt: event.timestamp },
      session: { id: event.sessionId, epoch: state.session.id && state.session.id !== event.sessionId ? state.session.epoch + 1 : state.session.epoch, status: "active", updatedAt: event.timestamp },
      activeTurn, recovery: undefined,
      ...(state.session.id && state.session.id !== event.sessionId
        ? { continuationOutbox: [], continuationInbox: [] }
        : {}),
    }, [signal("preserve_runtime", event, "Active turn registered without creating replacement task or plan rows.", { requestId: event.requestId })]);
  }

  if (event.type === "compaction_prepared") {
    if (!state.activeTurn || state.activeTurn.turnId !== event.turnId || state.activeTurn.sessionId !== event.sessionId) {
      const recovery: ContextContinuityRecovery = {
        operationId: contextCompactionOperationId(event), retryable: false,
        message: "Compaction preparation could not be correlated with the active turn.", availableActions: ["reset_session"],
      };
      return commitTransition(state, event, { recovery }, [signal("recovery_available", event, recovery.message, { visible: true })]);
    }
    const operationId = contextCompactionOperationId(event);
    if (state.compactions.some(item => item.operationId === operationId)) return duplicateTransition(state);
    const owner: ContextContinuationOwner = event.willRetry ? "native_runtime" : event.continuationOwner || (event.allowHarnessResume ? "harness" : "user");
    const attempt: ContextCompactionAttempt = {
      operationId, turnId: event.turnId, reason: event.reason, willRetry: event.willRetry, owner, status: "prepared",
      preparedAt: event.timestamp, firstKeptEntryId: event.firstKeptEntryId, branchEntryIds: uniqueStrings(event.branchEntryIds || []).sort(),
    };
    return commitTransition(state, event, {
      activeTurn: { ...state.activeTurn, phase: "compacting", updatedAt: event.timestamp },
      compactions: [...state.compactions, attempt].slice(-MAX_COMPACTIONS), recovery: undefined,
    }, [signal("preserve_runtime", event, "Compaction prepared; active runtime rows remain authoritative.", { requestId: state.activeTurn.requestId, operationId })]);
  }

  if (event.type === "compaction_succeeded") {
    const index = latestCompactionIndex(state, event.operationId);
    const attempt = index >= 0 ? state.compactions[index] : undefined;
    if (index < 0 || !activeTurnMatchesCompaction(state, attempt)) {
      const recovery = lateCompactionRecovery(state, event, event.operationId || attempt?.operationId || "unmatched");
      return commitTransition(state, event, { recovery }, [signal("recovery_available", event, recovery.message, { visible: true })]);
    }
    if (!state.activeTurn) {
      const recovery: ContextContinuityRecovery = {
        operationId: event.operationId || "unmatched", retryable: false,
        message: "Compaction success was not correlated with a prepared active turn.", availableActions: ["reset_session"],
      };
      return commitTransition(state, event, { recovery }, [signal("recovery_available", event, recovery.message, { visible: true })]);
    }
    const matchedAttempt = attempt as ContextCompactionAttempt;
    if (matchedAttempt.status === "committed" || matchedAttempt.status === "resumed") return duplicateTransition(state);
    const compactions = state.compactions.map((item, itemIndex): ContextCompactionAttempt => itemIndex === index ? {
      ...item, status: "committed", completedAt: event.timestamp, compactionEntryId: event.compactionEntryId || item.compactionEntryId,
    } : item);
    const phase: ContextContinuationPhase = matchedAttempt.willRetry || matchedAttempt.owner === "harness" ? "awaiting_resume" : "resumed";
    const continuationSignal = matchedAttempt.willRetry
      ? signal("await_native_retry", event, "Compaction committed; native runtime owns same-turn retry.", { requestId: state.activeTurn.requestId, operationId: matchedAttempt.operationId })
      : signal("resume_same_turn", event, "Compaction committed; the same request remains active.", { requestId: state.activeTurn.requestId, operationId: matchedAttempt.operationId, shouldDispatch: matchedAttempt.owner === "harness" });
    return commitTransition(state, event, {
      activeTurn: { ...state.activeTurn, phase, updatedAt: event.timestamp }, compactions, recovery: undefined,
    }, [signal("preserve_runtime", event, "Task, plan, agent, workflow, and request identities were preserved.", { requestId: state.activeTurn.requestId, operationId: matchedAttempt.operationId }), continuationSignal]);
  }

  if (event.type === "compaction_failed") {
    const index = latestCompactionIndex(state, event.operationId);
    const attempt = index >= 0 ? state.compactions[index] : undefined;
    if (attempt && !activeTurnMatchesCompaction(state, attempt)) {
      const recovery = lateCompactionRecovery(state, event, attempt.operationId);
      return commitTransition(state, event, { recovery }, [signal("recovery_available", event, recovery.message, { visible: true })]);
    }
    const operationId = attempt?.operationId || event.operationId || "unmatched";
    const error = summarizeRuntimeInput(event.error, 500) || "Context compaction failed.";
    const recovery: ContextContinuityRecovery = {
      operationId, retryable: event.retryable, message: error,
      availableActions: event.retryable ? ["retry_compaction", "resume_same_turn", "reset_session"] : ["resume_same_turn", "reset_session"],
    };
    const compactions = attempt ? state.compactions.map((item, itemIndex): ContextCompactionAttempt => itemIndex === index ? {
      ...item, status: "failed", completedAt: event.timestamp, retryable: event.retryable, error,
    } : item) : state.compactions;
    return commitTransition(state, event, {
      activeTurn: state.activeTurn ? { ...state.activeTurn, phase: "recoverable_failure", updatedAt: event.timestamp } : undefined,
      compactions, recovery,
    }, [signal("recovery_available", event, error, { requestId: state.activeTurn?.requestId, operationId, visible: true })]);
  }

  if (event.type === "turn_resumed") {
    if (!state.activeTurn || state.activeTurn.turnId !== event.turnId) return commitTransition(state, event, {}, [], true);
    const index = latestCompactionIndex(state);
    const attempt = index >= 0 ? state.compactions[index] : undefined;
    if (attempt?.status === "resumed" && state.activeTurn.phase === "resumed") return duplicateTransition(state);
    const compactions = attempt ? state.compactions.map((item, itemIndex): ContextCompactionAttempt => itemIndex === index ? { ...item, status: "resumed", resumedAt: event.timestamp } : item) : state.compactions;
    return commitTransition(state, event, {
      activeTurn: { ...state.activeTurn, phase: "resumed", attempt: state.activeTurn.attempt + 1, resumeCount: state.activeTurn.resumeCount + 1, updatedAt: event.timestamp },
      compactions, recovery: undefined,
    }, [signal("preserve_runtime", event, `Same turn resumed by ${event.cause}.`, { requestId: state.activeTurn.requestId, operationId: attempt?.operationId })]);
  }

  if (event.type === "turn_completed") {
    if (!state.activeTurn || state.activeTurn.turnId !== event.turnId) return commitTransition(state, event, {}, [], true);
    return commitTransition(state, event, {
      activeTurn: { ...state.activeTurn, phase: "completed", updatedAt: event.timestamp }, recovery: undefined,
    }, [signal("turn_completed", event, "Active turn completed.", { requestId: state.activeTurn.requestId })]);
  }

  if (event.type === "project_restarted") {
    return commitTransition(state, event, {
      project: { id: event.projectId, restartCount: state.project.restartCount + 1, updatedAt: event.timestamp },
    }, [signal("project_restart_preserved", event, "Project process restarted; active session and turn were preserved.", { requestId: state.activeTurn?.requestId })]);
  }

  const isExplicitReset = event.type === "session_reset" || event.reason === "new";
  if (isExplicitReset) {
    return commitTransition(state, event, {
      session: { id: event.sessionId, epoch: state.session.epoch + 1, status: "reset", updatedAt: event.timestamp },
      activeTurn: undefined, recovery: undefined, continuationOutbox: [], continuationInbox: [],
    }, [signal("retire_session_runtime", event, "Explicit session reset retires session-scoped runtime work while preserving project memory.", { visible: true })]);
  }

  if (event.reason === "fork") {
    return commitTransition(state, event, {
      session: { id: event.sessionId, epoch: state.session.epoch + 1, status: "forked", updatedAt: event.timestamp },
      activeTurn: undefined, recovery: undefined, continuationOutbox: [], continuationInbox: [],
    }, [signal("fork_from_checkpoint", event, "Fork starts a new session epoch from persisted project state, without inheriting live handles.", { visible: true })]);
  }

  const identityMatches = !state.session.id || state.session.id === event.sessionId;
  if (identityMatches || event.reason === "reload" || event.reason === "resume") {
    const activeTurn = state.activeTurn ? { ...state.activeTurn, sessionId: event.sessionId, updatedAt: event.timestamp } : undefined;
    return commitTransition(state, event, {
      session: { id: event.sessionId, epoch: state.session.epoch, status: "active", updatedAt: event.timestamp }, activeTurn,
    }, [signal("restore_session_runtime", event, "Session reload/resume preserves active runtime and continuation state.", { requestId: activeTurn?.requestId })]);
  }

  const recovery: ContextContinuityRecovery | undefined = state.activeTurn ? {
    operationId: state.compactions.at(-1)?.operationId || "session-identity-change", retryable: false,
    message: "Startup session identity changed while work was active; the prior turn remains recoverable.",
    availableActions: ["resume_same_turn", "reset_session"],
  } : undefined;
  return commitTransition(state, event, {
    session: { id: event.sessionId, epoch: state.session.epoch + 1, status: "active", updatedAt: event.timestamp },
    activeTurn: state.activeTurn ? { ...state.activeTurn, phase: "interrupted", updatedAt: event.timestamp } : undefined, recovery,
    continuationOutbox: [], continuationInbox: [],
  }, [
    ...(recovery ? [signal("recovery_available", event, recovery.message, { requestId: state.activeTurn?.requestId, visible: true })] : []),
    signal("retire_session_runtime", event, "Startup session identity changed; prior live runtime was retired while recovery evidence was preserved.", { visible: true }),
  ]);
}

export function readContextContinuity(agentDir: string): ContextContinuityState {
  return readSerializedState(contextContinuityStateIO(agentDir, normalizeContinuityState, emptyContextContinuityState));
}

export function writeContextContinuity(state: ContextContinuityState, agentDir: string): void {
  writeSerializedState(state, contextContinuityStateIO(agentDir, normalizeContinuityState, emptyContextContinuityState));
}

export function dispatchContextContinuity(agentDir: string, event: ContextContinuityEvent): ContextContinuityTransition {
  return dispatchSerializedStateUpdate(event, {
    ...contextContinuityStateIO(agentDir, normalizeContinuityState, emptyContextContinuityState),
    reduce: reduceContextContinuity,
  });
}
