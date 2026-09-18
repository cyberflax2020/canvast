/**
 * =============================================================================
 * Canvast — Context Continuity Runtime Queue Helpers / 运行时队列辅助
 * =============================================================================
 * @file        src/harness/context-continuity/runtime-queue.ts
 * @brief       Runtime input queue and request normalization/transition helpers.
 * @description Shared queue/request helpers extracted from context-continuity.ts
 *              to keep that reducer-focused module below the size limit while
 *              preserving its public API through re-exports.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import { redactCredentialText } from "../credential-redaction.js";
import {
  normalizeRuntimeInputPayload,
  type RuntimeInputPayloadInput,
  type RuntimeInputPayloadV1,
} from "../runtime-input-payload.js";

export type RuntimeInputQueuePolicy = "none" | "sidecar" | "status" | "task_adjustment" | "redirect" | "pause" | "supersede_merge" | "amend_current" | "parallel_independent" | "serial_after_current" | "defer" | "cancel";
export type RuntimeInputQueueStatus = "queued" | "delivered" | "answered" | "failed" | "interrupt" | "expired" | "acknowledged" | "deferred" | "admitted";
export type RuntimeInputDeliveryMode = "direct" | "steer" | "followUp" | "nextTurn" | "batch";

export type ReevaluateCheckpoint = "on_tool_success" | "on_tool_error" | "on_turn_settle" | "on_plan_approved" | "on_workflow_stage";

export interface RuntimeInputQueueItem {
  id: string;
  sequence: number;
  timestamp: string;
  policy: RuntimeInputQueuePolicy;
  textSummary: string;
  payload?: RuntimeInputPayloadV1;
  source: string;
  affectsActiveWork: boolean;
  status: RuntimeInputQueueStatus;
  requestId?: string;
  deliveryMode?: RuntimeInputDeliveryMode;
  deliveredAt?: string;
  answeredAt?: string;
  hasVisibleReply?: boolean;
  failureReason?: string;
  attentionRequired?: boolean;
  deferInfo?: {
    reasonCode: string;
    blockerTaskIds: string[];
    reevaluateAt: ReevaluateCheckpoint;
    attemptCount: number;
    dependencyPredicate?: string;
    dependencyVersion?: string;
  };
}

export type RuntimeRequestKind = "primary" | "sidecar" | "status" | "adjustment" | "interrupt" | "batch_member";
export type RuntimeRequestStatus = "queued" | "delivered" | "answering" | "answered" | "failed" | "interrupted" | "deferred";
export type RuntimeRequestDeliveryScopeKind = "ambient" | "whole_project_delivery";

export interface RuntimeRequestDeliveryScope {
  kind: RuntimeRequestDeliveryScopeKind;
}

export interface RuntimeRequestRecord {
  requestId: string;
  parentRequestId?: string;
  kind: RuntimeRequestKind;
  textSummary: string;
  deliveryScope?: RuntimeRequestDeliveryScope;
  status: RuntimeRequestStatus;
  hasVisibleReply: boolean;
  createdAt: string;
  deliveredAt?: string;
  answeredAt?: string;
  updatedAt: string;
  deliveryMode?: RuntimeInputDeliveryMode;
  failureReason?: string;
}

export interface RuntimeQueueSnapshotLike {
  updatedAt: string;
  inputQueue: RuntimeInputQueueItem[];
  requests: RuntimeRequestRecord[];
}

export interface RecordRuntimeInputQueueItemInput extends
  Omit<RuntimeInputQueueItem, "id" | "timestamp" | "sequence" | "payload"> {
  id?: string;
  timestamp?: string;
  sequence?: number;
  payload?: RuntimeInputPayloadInput | RuntimeInputPayloadV1;
}

export interface RuntimeInputQueueSelector {
  id?: string;
  requestId?: string;
  text?: unknown;
}

export interface RuntimeInputQueueUpdate extends RuntimeInputQueueSelector {
  timestamp?: string;
  patch: Partial<Omit<RuntimeInputQueueItem, "id" | "timestamp">>;
}

export interface RuntimeRequestTransitionInput {
  requestId: string;
  status: RuntimeRequestStatus;
  timestamp?: string;
  deliveryMode?: RuntimeInputDeliveryMode;
  hasVisibleReply?: boolean;
  failureReason?: string;
}

export interface RecordRuntimeRequestInput {
  requestId: string;
  parentRequestId?: string;
  kind: RuntimeRequestKind;
  textSummary: string;
  deliveryScope?: RuntimeRequestDeliveryScope;
  status?: RuntimeRequestStatus;
  hasVisibleReply?: boolean;
  createdAt?: string;
  deliveredAt?: string;
  answeredAt?: string;
  deliveryMode?: RuntimeInputDeliveryMode;
  failureReason?: string;
}

const OPEN_QUEUE_STATUSES = new Set<RuntimeInputQueueStatus>(["queued", "delivered", "interrupt", "deferred"]);
const DELIVERABLE_QUEUE_STATUSES = new Set<RuntimeInputQueueStatus>(["queued", "interrupt"]);
const ANSWERABLE_QUEUE_STATUSES = new Set<RuntimeInputQueueStatus>(["queued", "interrupt", "delivered", "acknowledged"]);
const REQUEST_TRANSITIONS: Record<RuntimeRequestStatus, ReadonlySet<RuntimeRequestStatus>> = {
  queued: new Set(["queued", "delivered", "answering", "answered", "failed", "interrupted", "deferred"]),
  delivered: new Set(["delivered", "answering", "answered", "failed", "interrupted", "deferred"]),
  answering: new Set(["answering", "answered", "failed", "interrupted", "deferred"]),
  deferred: new Set(["deferred", "queued", "delivered", "answering", "answered", "failed", "interrupted"]),
  answered: new Set(["answered"]),
  failed: new Set(["failed", "queued"]),
  interrupted: new Set(["interrupted", "queued"]),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function summarizeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? "");
  } catch {
    return String(value ?? "");
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function summarizeRuntimeInput(value: unknown, max = 180): string {
  const text = redactCredentialText(typeof value === "string" ? value : summarizeJson(value));
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function normalizeQueuePolicy(value: unknown): RuntimeInputQueuePolicy {
  if (
    value === "sidecar" || value === "status" || value === "task_adjustment" ||
    value === "redirect" || value === "pause" || value === "supersede_merge" ||
    value === "amend_current" || value === "parallel_independent" ||
    value === "serial_after_current" || value === "defer" || value === "cancel"
  ) return value;
  return "none";
}

export function runtimeRequestKindForQueuePolicy(policy: RuntimeInputQueuePolicy): RuntimeRequestKind {
  if (policy === "sidecar" || policy === "status") return policy;
  if (policy === "task_adjustment" || policy === "amend_current") return "adjustment";
  if (policy === "redirect" || policy === "pause" || policy === "cancel") return "interrupt";
  if (policy === "parallel_independent" || policy === "serial_after_current" || policy === "supersede_merge") return "batch_member";
  return "primary";
}

function normalizeQueueStatus(value: unknown): RuntimeInputQueueStatus {
  if (
    value === "queued" || value === "delivered" || value === "answered" || value === "failed" ||
    value === "interrupt" || value === "expired" || value === "acknowledged" ||
    value === "deferred" || value === "admitted"
  ) return value;
  return "queued";
}

function normalizeDeliveryMode(value: unknown): RuntimeInputDeliveryMode | undefined {
  if (value === "direct" || value === "steer" || value === "followUp" || value === "nextTurn" || value === "batch") return value;
  return undefined;
}

export function normalizeRuntimeInputQueue(value: unknown, now: string, maxItems = 40): RuntimeInputQueueItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item, index) => {
    const deferInfo = isRecord(item.deferInfo) ? {
      reasonCode: asString(item.deferInfo.reasonCode, "unknown"),
      blockerTaskIds: asStringArray(item.deferInfo.blockerTaskIds),
      reevaluateAt: (asString(item.deferInfo.reevaluateAt) as ReevaluateCheckpoint) || "on_turn_settle",
      attemptCount: asNumber(item.deferInfo.attemptCount, 0),
      dependencyPredicate: asString(item.deferInfo.dependencyPredicate) || undefined,
      dependencyVersion: asString(item.deferInfo.dependencyVersion) || undefined,
    } : undefined;
    return {
      id: asString(item.id, `input-${index}`),
      sequence: asNumber(item.sequence, index),
      timestamp: asString(item.timestamp, now),
      policy: normalizeQueuePolicy(item.policy),
      textSummary: asString(item.textSummary, "Input"),
      payload: normalizeRuntimeInputPayload(item.payload),
      source: asString(item.source, "runtime-status"),
      affectsActiveWork: Boolean(item.affectsActiveWork),
      status: normalizeQueueStatus(item.status),
      requestId: asString(item.requestId) || undefined,
      deliveryMode: normalizeDeliveryMode(item.deliveryMode),
      deliveredAt: asString(item.deliveredAt) || undefined,
      answeredAt: asString(item.answeredAt) || undefined,
      hasVisibleReply: item.hasVisibleReply === true || undefined,
      failureReason: asString(item.failureReason) || undefined,
      attentionRequired: item.attentionRequired === true || undefined,
      deferInfo,
    };
  }).slice(-maxItems);
}

function normalizeRequestKind(value: unknown): RuntimeRequestKind {
  if (
    value === "sidecar" || value === "status" || value === "adjustment" ||
    value === "interrupt" || value === "batch_member"
  ) return value;
  return "primary";
}

function normalizeRequestStatus(value: unknown): RuntimeRequestStatus {
  if (
    value === "delivered" || value === "answering" || value === "answered" ||
    value === "failed" || value === "interrupted" || value === "deferred"
  ) return value;
  return "queued";
}

function normalizeDeliveryScopeKind(value: unknown): RuntimeRequestDeliveryScopeKind | undefined {
  if (value === "ambient" || value === "whole_project_delivery") return value;
  return undefined;
}

function normalizeRuntimeRequestDeliveryScope(value: unknown): RuntimeRequestDeliveryScope | undefined {
  if (!isRecord(value)) return undefined;
  const kind = normalizeDeliveryScopeKind(value.kind);
  if (!kind) return undefined;
  return { kind };
}

export function normalizeRuntimeRequests(value: unknown, now: string, maxItems = 80): RuntimeRequestRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item, index) => {
    const createdAt = asString(item.createdAt, now);
    return {
      requestId: asString(item.requestId, `request-${index}`),
      parentRequestId: asString(item.parentRequestId) || undefined,
      kind: normalizeRequestKind(item.kind),
      textSummary: asString(item.textSummary, "Request"),
      deliveryScope: normalizeRuntimeRequestDeliveryScope(item.deliveryScope),
      status: normalizeRequestStatus(item.status),
      hasVisibleReply: item.hasVisibleReply === true,
      createdAt,
      deliveredAt: asString(item.deliveredAt) || undefined,
      answeredAt: asString(item.answeredAt) || undefined,
      updatedAt: asString(item.updatedAt, createdAt),
      deliveryMode: normalizeDeliveryMode(item.deliveryMode),
      failureReason: asString(item.failureReason) || undefined,
    };
  }).slice(-maxItems);
}

export function isRuntimeInputQueuePending(item: RuntimeInputQueueItem): boolean {
  return OPEN_QUEUE_STATUSES.has(item.status);
}

export function pendingRuntimeInputQueueItems<T extends Pick<RuntimeQueueSnapshotLike, "inputQueue">>(snapshot: T): RuntimeInputQueueItem[] {
  return snapshot.inputQueue.filter(isRuntimeInputQueuePending);
}

function queueMatchIndex(
  items: RuntimeInputQueueItem[],
  selector: RuntimeInputQueueSelector,
  eligible?: ReadonlySet<RuntimeInputQueueStatus>,
): number {
  const summary = selector.text === undefined ? undefined : summarizeRuntimeInput(selector.text, 180);
  return items.findIndex(item => {
    if (eligible && !eligible.has(item.status)) return false;
    if (selector.id) return item.id === selector.id;
    if (selector.requestId) return item.requestId === selector.requestId;
    if (summary !== undefined) return item.textSummary === summary;
    return true;
  });
}

export function updateRuntimeInputQueueItem<T extends RuntimeQueueSnapshotLike>(snapshot: T, input: RuntimeInputQueueUpdate): T {
  const timestamp = input.timestamp || new Date().toISOString();
  const index = queueMatchIndex(snapshot.inputQueue, input);
  if (index < 0) return snapshot;
  const inputQueue = snapshot.inputQueue.map((item, itemIndex) => itemIndex === index ? { ...item, ...input.patch } : item);
  return { ...snapshot, updatedAt: timestamp, inputQueue } as T;
}

export function markRuntimeInputQueueItemDelivered<T extends RuntimeQueueSnapshotLike>(
  snapshot: T,
  input: RuntimeInputQueueSelector & { timestamp?: string; deliveryMode?: RuntimeInputDeliveryMode },
): T {
  const timestamp = input.timestamp || new Date().toISOString();
  const index = queueMatchIndex(snapshot.inputQueue, input, DELIVERABLE_QUEUE_STATUSES);
  if (index < 0) return snapshot;
  const item = snapshot.inputQueue[index];
  return updateRuntimeInputQueueItem(snapshot, {
    id: item.id,
    timestamp,
    patch: { status: "delivered", deliveredAt: item.deliveredAt || timestamp, deliveryMode: input.deliveryMode || item.deliveryMode },
  });
}

export function markRuntimeInputQueueItemAnswered<T extends RuntimeQueueSnapshotLike>(
  snapshot: T,
  input: RuntimeInputQueueSelector & { timestamp?: string; visibleText: string },
): T {
  if (!input.visibleText.trim()) return snapshot;
  const timestamp = input.timestamp || new Date().toISOString();
  const index = queueMatchIndex(snapshot.inputQueue, input, ANSWERABLE_QUEUE_STATUSES);
  if (index < 0) return snapshot;
  const item = snapshot.inputQueue[index];
  return updateRuntimeInputQueueItem(snapshot, {
    id: item.id,
    timestamp,
    patch: {
      status: "answered",
      deliveredAt: item.deliveredAt || timestamp,
      answeredAt: timestamp,
      hasVisibleReply: true,
    },
  });
}

export function recordRuntimeRequestInSnapshot<T extends RuntimeQueueSnapshotLike>(
  snapshot: T,
  input: RecordRuntimeRequestInput,
  maxItems = 80,
): T {
  const createdAt = input.createdAt || new Date().toISOString();
  const existing = snapshot.requests.find(item => item.requestId === input.requestId);
  const record: RuntimeRequestRecord = {
    requestId: input.requestId,
    parentRequestId: input.parentRequestId ?? existing?.parentRequestId,
    kind: input.kind,
    textSummary: summarizeRuntimeInput(input.textSummary, 180),
    deliveryScope: input.deliveryScope || existing?.deliveryScope,
    status: existing?.status || input.status || "queued",
    hasVisibleReply: existing?.hasVisibleReply || input.hasVisibleReply === true,
    createdAt: existing?.createdAt || createdAt,
    deliveredAt: existing?.deliveredAt || input.deliveredAt,
    answeredAt: existing?.answeredAt || input.answeredAt,
    updatedAt: createdAt,
    deliveryMode: input.deliveryMode || existing?.deliveryMode,
    failureReason: input.failureReason || existing?.failureReason,
  };
  return {
    ...snapshot,
    updatedAt: createdAt,
    requests: [...snapshot.requests.filter(item => item.requestId !== input.requestId), record].slice(-maxItems),
  } as T;
}

export function updateRuntimeRequestRecord<T extends RuntimeQueueSnapshotLike>(snapshot: T, input: RuntimeRequestTransitionInput): T {
  const timestamp = input.timestamp || new Date().toISOString();
  const index = snapshot.requests.findIndex(item => item.requestId === input.requestId);
  if (index < 0) return snapshot;
  const current = snapshot.requests[index];
  if (!REQUEST_TRANSITIONS[current.status].has(input.status)) return snapshot;
  const visible = current.hasVisibleReply || input.hasVisibleReply === true;
  if (
    current.status === input.status && current.hasVisibleReply === visible &&
    (!input.deliveryMode || input.deliveryMode === current.deliveryMode) &&
    (!input.failureReason || input.failureReason === current.failureReason)
  ) return snapshot;
  const requests = snapshot.requests.map((item, itemIndex): RuntimeRequestRecord => itemIndex === index ? {
    ...item,
    status: input.status,
    hasVisibleReply: visible,
    deliveredAt: item.deliveredAt || ([ "delivered", "answering", "answered" ].includes(input.status) ? timestamp : undefined),
    answeredAt: item.answeredAt || (input.status === "answered" ? timestamp : undefined),
    updatedAt: timestamp,
    deliveryMode: input.deliveryMode || item.deliveryMode,
    failureReason: input.failureReason || item.failureReason,
  } : item);
  return { ...snapshot, updatedAt: timestamp, requests } as T;
}

export function markRuntimeRequestDelivered<T extends RuntimeQueueSnapshotLike>(
  snapshot: T,
  input: Omit<RuntimeRequestTransitionInput, "status">,
): T {
  return updateRuntimeRequestRecord(snapshot, { ...input, status: "delivered" });
}

export function markRuntimeRequestAnswering<T extends RuntimeQueueSnapshotLike>(
  snapshot: T,
  input: Omit<RuntimeRequestTransitionInput, "status">,
): T {
  return updateRuntimeRequestRecord(snapshot, { ...input, status: "answering" });
}

export function markRuntimeRequestAnswered<T extends RuntimeQueueSnapshotLike>(
  snapshot: T,
  input: Omit<RuntimeRequestTransitionInput, "status"> & { visibleText: string },
): T {
  if (!input.visibleText.trim()) return snapshot;
  return updateRuntimeRequestRecord(snapshot, { ...input, status: "answered", hasVisibleReply: true });
}
