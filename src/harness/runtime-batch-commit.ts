/**
 * =============================================================================
 * Canvast — Runtime Batch Commit / Canvast 源文件
 * =============================================================================
 * @file        src/harness/runtime-batch-commit.ts
 * @brief       Helpers for idempotent runtime batch commit receipts.
 * @description Canonicalizes payloads, manifests, and persisted batch receipt
 *              records so callers can rely on the shared runtime-status lock.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import { createHash } from "node:crypto";

import type { RuntimeBatchPolicyEffect, RuntimeBatchSchedulingMode } from "./runtime-batch-policy.js";

export interface RuntimeBatchTransitionManifestItem {
  id: string;
  requestId?: string;
  sequence: number;
  timestamp: string;
  status: string;
  payloadDigest?: string;
}

export interface RuntimeBatchTransitionReceipt {
  receiptType: "runtime-batch-transition";
  batchId: string;
  committedAt: string;
  expectedQueueRevision?: number;
  committedQueueRevision: number;
  manifest: RuntimeBatchTransitionManifestItem[];
  directives?: RuntimeBatchExecutionDirective[];
}

export interface RuntimeBatchExecutionDirective extends RuntimeBatchPolicyEffect {
  id: string;
  requestId: string;
  sequence: number;
  targetRootRequestId?: string;
  branchEvidence?: RuntimeBatchDirectiveBranchEvidence;
}

export type RuntimeBatchDirectivePrimaryDependency = "none" | "snapshot" | "live";

export interface RuntimeBatchDirectiveBranchEvidence {
  selfContained: boolean;
  primaryDependency: RuntimeBatchDirectivePrimaryDependency;
  dependsOnBranchIds: string[];
  writeTargets: string[];
  externalResourceKeys: string[];
}

export type RuntimeBatchDirectiveExecutionState =
  | "pending" | "dispatching" | "accepted" | "running"
  | "completed" | "failed" | "cancelled";

export type RuntimeBatchDirectiveFailureCode =
  | "dispatch_error" | "execution_error" | "root_replaced" | "session_retired"
  | "missing_unsafe_execution_evidence" | "exact_input_unavailable"
  | "invalid_persisted_execution";

export interface RuntimeBatchDirectiveExecution {
  executionId: string;
  batchId: string;
  directiveId: string;
  requestId: string;
  sequence: number;
  timestamp: string;
  payloadDigest: string;
  targetRootRequestId?: string;
  schedulingMode: "parallel" | "serial";
  branchEvidence?: RuntimeBatchDirectiveBranchEvidence;
  state: RuntimeBatchDirectiveExecutionState;
  attemptCount: number;
  dispatchToken?: string;
  dispatchLeaseUntil?: string;
  lastDispatchedAt?: string;
  acceptedAt?: string;
  startedAt?: string;
  settledAt?: string;
  failureCode?: RuntimeBatchDirectiveFailureCode;
  failureReason?: string;
}

export interface RuntimeBatchCommitRecord {
  batchId: string;
  payloadHash: string;
  committedAt: string;
  receipt: RuntimeBatchTransitionReceipt;
  executions?: RuntimeBatchDirectiveExecution[];
}

export const MAX_BATCH_COMMITS = 512;

function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0))]
    : [];
}

function isSha256Digest(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 64) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (!((code >= 48 && code <= 57) || (code >= 97 && code <= 102))) return false;
  }
  return true;
}

function normalizeBranchEvidence(value: unknown): RuntimeBatchDirectiveBranchEvidence | undefined {
  if (!isRecord(value) || typeof value.selfContained !== "boolean" ||
      (value.primaryDependency !== "none" && value.primaryDependency !== "snapshot" &&
       value.primaryDependency !== "live") ||
      !Array.isArray(value.dependsOnBranchIds) || !Array.isArray(value.writeTargets) ||
      !Array.isArray(value.externalResourceKeys)) return undefined;
  const dependsOnBranchIds = asStringArray(value.dependsOnBranchIds);
  const writeTargets = asStringArray(value.writeTargets);
  const externalResourceKeys = asStringArray(value.externalResourceKeys);
  if (dependsOnBranchIds.length !== value.dependsOnBranchIds.length ||
      writeTargets.length !== value.writeTargets.length ||
      externalResourceKeys.length !== value.externalResourceKeys.length) return undefined;
  return {
    selfContained: value.selfContained,
    primaryDependency: value.primaryDependency,
    dependsOnBranchIds, writeTargets, externalResourceKeys,
  };
}

type RuntimeBatchDirectiveSupersedeEvidence = NonNullable<RuntimeBatchExecutionDirective["supersedeEvidence"]>;

function normalizeSupersedeEvidence(value: unknown): RuntimeBatchDirectiveSupersedeEvidence | undefined {
  if (!isRecord(value) || !asString(value.targetRootRequestId) || !Array.isArray(value.items)) return undefined;
  const items: RuntimeBatchDirectiveSupersedeEvidence["items"] = [];
  const seen = new Set<string>();
  for (const item of value.items) {
    if (!isRecord(item)) return undefined;
    const plane = item.plane;
    const status = item.status;
    const disposition = item.disposition;
    const itemId = asString(item.itemId);
    const updatedAt = asString(item.updatedAt);
    if ((plane !== "tasks" && plane !== "plans" && plane !== "subAgents" &&
         plane !== "workflows" && plane !== "toolRuns") ||
        (status !== "pending" && status !== "in_progress" && status !== "running" &&
         status !== "completed" && status !== "blocked" && status !== "failed" &&
         status !== "aborted" && status !== "stale" && status !== "unknown") ||
        (disposition !== "continue_under_replacement" && disposition !== "cancel_as_redundant" &&
         disposition !== "preserve_completed_evidence") || !itemId || !updatedAt ||
        !Number.isFinite(Date.parse(updatedAt))) return undefined;
    if ((disposition === "cancel_as_redundant" && status !== "pending" && status !== "unknown") ||
        (disposition === "preserve_completed_evidence" && status !== "completed" && status !== "failed" &&
         status !== "aborted" && status !== "stale") ||
        (disposition === "continue_under_replacement" && status !== "pending" &&
         status !== "in_progress" && status !== "running" && status !== "blocked" && status !== "unknown")) {
      return undefined;
    }
    const key = `${plane}:${itemId}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    items.push({ plane, itemId, status, updatedAt, disposition });
  }
  return { targetRootRequestId: String(value.targetRootRequestId), items };
}

function normalizeDirective(value: unknown): RuntimeBatchExecutionDirective | undefined {
  if (!isRecord(value)) return undefined;
  const id = asString(value.id);
  const requestId = asString(value.requestId);
  const policy = value.policy;
  const requestStatus = value.requestStatus;
  const requestKind = value.requestKind;
  const rootAction = value.rootAction;
  const schedulingMode = value.schedulingMode;
  const validPolicy = policy === "supersede_merge" || policy === "amend_current" ||
    policy === "parallel_independent" || policy === "serial_after_current" ||
    policy === "defer" || policy === "pause" || policy === "cancel";
  const validRequestStatus = requestStatus === "queued" || requestStatus === "delivered" ||
    requestStatus === "answering" || requestStatus === "answered" ||
    requestStatus === "failed" || requestStatus === "interrupted" || requestStatus === "deferred";
  const validRequestKind = requestKind === "primary" || requestKind === "sidecar" ||
    requestKind === "status" || requestKind === "adjustment" ||
    requestKind === "interrupt" || requestKind === "batch_member";
  const validRootAction = rootAction === "preserve" || rootAction === "supersede" ||
    rootAction === "pause" || rootAction === "cancel";
  const validSchedulingMode = schedulingMode === "current_root" || schedulingMode === "parallel" ||
    schedulingMode === "serial" || schedulingMode === "deferred" || schedulingMode === "none";
  const supersedeEvidence = normalizeSupersedeEvidence(value.supersedeEvidence);
  if (!id || !requestId || !validPolicy || !validRequestStatus || !validRequestKind ||
      !validRootAction || !validSchedulingMode || !Number.isSafeInteger(value.sequence) ||
      (policy === "supersede_merge" && !supersedeEvidence)) return undefined;
  return {
    id, requestId, sequence: Number(value.sequence), policy, requestStatus, requestKind, rootAction,
    schedulingMode,
    targetRootRequestId: asString(value.targetRootRequestId),
    targetTaskId: asString(value.targetTaskId),
    dependencyIds: asStringArray(value.dependencyIds),
    priority: Number.isSafeInteger(value.priority) ? Number(value.priority) : undefined,
    nextCheckpoint: value.nextCheckpoint === "on_tool_success" || value.nextCheckpoint === "on_tool_error" ||
      value.nextCheckpoint === "on_turn_settle" || value.nextCheckpoint === "on_plan_approved" ||
      value.nextCheckpoint === "on_workflow_stage" ? value.nextCheckpoint : undefined,
    reason: asString(value.reason) || policy,
    blockerTaskIds: asStringArray(value.blockerTaskIds),
    attemptCount: Number.isSafeInteger(value.attemptCount) && Number(value.attemptCount) >= 0
      ? Number(value.attemptCount) : undefined,
    dependencyPredicate: asString(value.dependencyPredicate),
    dependencyVersion: asString(value.dependencyVersion),
    branchEvidence: normalizeBranchEvidence(value.branchEvidence),
    supersedeEvidence: policy === "supersede_merge" ? supersedeEvidence : undefined,
  };
}

function executionId(batchId: string, directiveId: string): string {
  return `batch-exec-${createHash("sha256").update(`${batchId}\n${directiveId}`).digest("hex").slice(0, 24)}`;
}

const EXECUTION_STATES = new Set<RuntimeBatchDirectiveExecutionState>([
  "pending", "dispatching", "accepted", "running", "completed", "failed", "cancelled",
]);
const FAILURE_CODES = new Set<RuntimeBatchDirectiveFailureCode>([
  "dispatch_error", "execution_error", "root_replaced", "session_retired",
  "missing_unsafe_execution_evidence", "exact_input_unavailable", "invalid_persisted_execution",
]);

function failedExecution(
  batchId: string, directive: RuntimeBatchExecutionDirective, timestamp: string, reason: string,
  code: RuntimeBatchDirectiveFailureCode = "invalid_persisted_execution", payloadDigest = "",
): RuntimeBatchDirectiveExecution {
  return {
    executionId: executionId(batchId, directive.id), batchId, directiveId: directive.id,
    requestId: directive.requestId, sequence: directive.sequence, timestamp, payloadDigest,
    targetRootRequestId: directive.targetRootRequestId,
    schedulingMode: directive.schedulingMode as "parallel" | "serial",
    branchEvidence: directive.branchEvidence, state: "failed", attemptCount: 0,
    settledAt: new Date(0).toISOString(), failureCode: code, failureReason: reason,
  };
}

function normalizeExecutions(
  value: unknown, batchId: string, receipt: RuntimeBatchTransitionReceipt,
): RuntimeBatchDirectiveExecution[] {
  const records = Array.isArray(value) ? value.filter(isRecord) : [];
  const runnable = runtimeBatchSchedulingDirectives(receipt);
  return runnable.map(directive => {
    const manifest = receipt.manifest.find(item => item.id === directive.id && item.requestId === directive.requestId);
    if (!manifest || !isSha256Digest(manifest.payloadDigest)) {
      return failedExecution(batchId, directive, manifest?.timestamp || receipt.committedAt,
        "The exact committed input payload binding is unavailable.", "exact_input_unavailable",
        manifest?.payloadDigest || "");
    }
    const matches = records.filter(record => record.directiveId === directive.id);
    if (matches.length !== 1) {
      if (matches.length === 0) return {
        executionId: executionId(batchId, directive.id), batchId, directiveId: directive.id,
        requestId: directive.requestId, sequence: directive.sequence, timestamp: manifest.timestamp,
        payloadDigest: manifest.payloadDigest || "",
        targetRootRequestId: directive.targetRootRequestId,
        schedulingMode: directive.schedulingMode as "parallel" | "serial",
        branchEvidence: directive.branchEvidence, state: "pending", attemptCount: 0,
      };
      return failedExecution(batchId, directive, manifest.timestamp, "Duplicate persisted execution records.",
        "invalid_persisted_execution", manifest.payloadDigest || "");
    }
    const record = matches[0];
    const state = record.state as RuntimeBatchDirectiveExecutionState;
    const immutableValid = record.executionId === executionId(batchId, directive.id) &&
      record.batchId === batchId && record.directiveId === directive.id &&
      record.requestId === directive.requestId && record.sequence === directive.sequence &&
      record.timestamp === manifest.timestamp && record.payloadDigest === (manifest.payloadDigest || "") &&
      record.targetRootRequestId === directive.targetRootRequestId &&
      record.schedulingMode === directive.schedulingMode &&
      JSON.stringify(normalizeBranchEvidence(record.branchEvidence)) === JSON.stringify(directive.branchEvidence);
    const attemptCount = Number(record.attemptCount);
    const dispatchToken = asString(record.dispatchToken);
    const dispatchLeaseUntil = asString(record.dispatchLeaseUntil);
    const acceptedAt = asString(record.acceptedAt);
    const startedAt = asString(record.startedAt);
    const settledAt = asString(record.settledAt);
    const failureCode = FAILURE_CODES.has(record.failureCode as RuntimeBatchDirectiveFailureCode)
      ? record.failureCode as RuntimeBatchDirectiveFailureCode : undefined;
    const shapeValid = immutableValid && EXECUTION_STATES.has(state) && Number.isSafeInteger(attemptCount) && attemptCount >= 0 &&
      (state === "pending" ? !dispatchToken && !acceptedAt && !startedAt && !settledAt : true) &&
      (state === "dispatching" ? Boolean(dispatchToken && dispatchLeaseUntil && !acceptedAt && !settledAt) : true) &&
      (state === "accepted" ? Boolean(dispatchToken && acceptedAt && !startedAt && !settledAt) : true) &&
      (state === "running" ? Boolean(dispatchToken && acceptedAt && startedAt && !settledAt) : true) &&
      ((state === "completed" || state === "cancelled") ? Boolean(settledAt) : true) &&
      (state === "failed" ? Boolean(settledAt && failureCode) : true);
    if (!shapeValid) return failedExecution(batchId, directive, manifest.timestamp, "Invalid persisted execution state.",
      "invalid_persisted_execution", manifest.payloadDigest || "");
    return {
      executionId: String(record.executionId), batchId, directiveId: directive.id, requestId: directive.requestId,
      sequence: directive.sequence, timestamp: manifest.timestamp, payloadDigest: manifest.payloadDigest || "",
      targetRootRequestId: directive.targetRootRequestId,
      schedulingMode: directive.schedulingMode as "parallel" | "serial", branchEvidence: directive.branchEvidence,
      state, attemptCount, dispatchToken, dispatchLeaseUntil, lastDispatchedAt: asString(record.lastDispatchedAt),
      acceptedAt, startedAt, settledAt, failureCode, failureReason: asString(record.failureReason),
    };
  });
}

export function sortRuntimeBatchDirectives(
  directives: RuntimeBatchExecutionDirective[],
): RuntimeBatchExecutionDirective[] {
  return [...directives].sort((left, right) =>
    left.sequence - right.sequence || left.id.localeCompare(right.id),
  );
}

/** Deterministic scheduler input; control-only and deferred items stay out of execution dispatch. */
export function runtimeBatchSchedulingDirectives(
  receipt: RuntimeBatchTransitionReceipt,
  mode?: Extract<RuntimeBatchSchedulingMode, "parallel" | "serial">,
): RuntimeBatchExecutionDirective[] {
  return sortRuntimeBatchDirectives((receipt.directives || []).filter(directive =>
    mode ? directive.schedulingMode === mode :
      directive.schedulingMode === "parallel" || directive.schedulingMode === "serial",
  ));
}

export function batchCommitPayloadHash(value: unknown): string {
  return createHash("sha256").update(canonicalJSON(value)).digest("hex");
}

/** Binds a committed execution to its exact durable payload or legacy text. */
export function runtimeBatchInputPayloadDigest(
  item: { payload?: unknown; textSummary: string },
): string {
  return batchCommitPayloadHash(item.payload
    ? { kind: "durable_payload", payload: item.payload }
    : { kind: "legacy_text", text: item.textSummary });
}

export function sortRuntimeBatchManifest(
  manifest: RuntimeBatchTransitionManifestItem[],
): RuntimeBatchTransitionManifestItem[] {
  return manifest.map(item => ({
    id: item.id,
    requestId: item.requestId,
    sequence: item.sequence,
    timestamp: item.timestamp,
    status: item.status,
    payloadDigest: item.payloadDigest,
  })).sort((left, right) => {
    if (left.sequence !== right.sequence) return left.sequence - right.sequence;
    if (left.timestamp !== right.timestamp) return left.timestamp.localeCompare(right.timestamp);
    return left.id.localeCompare(right.id);
  });
}

export function equalRuntimeBatchManifest(
  left: RuntimeBatchTransitionManifestItem[],
  right: RuntimeBatchTransitionManifestItem[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index].id !== right[index].id) return false;
    if (left[index].requestId !== right[index].requestId) return false;
    if (left[index].sequence !== right[index].sequence) return false;
    if (left[index].timestamp !== right[index].timestamp) return false;
    if (left[index].status !== right[index].status) return false;
    if (left[index].payloadDigest !== right[index].payloadDigest) return false;
  }
  return true;
}

export function normalizeRuntimeBatchCommitRecords(value: unknown): RuntimeBatchCommitRecord[] {
  if (!Array.isArray(value)) return [];
  const records = value
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map(item => {
      const receipt = item.receipt as Record<string, unknown> | undefined;
      const manifest = Array.isArray(receipt?.manifest)
        ? receipt!.manifest
          .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
          .map(entry => ({
            id: typeof entry.id === "string" ? entry.id : "",
            requestId: typeof entry.requestId === "string" ? entry.requestId : undefined,
            sequence: Number.isInteger(Number(entry.sequence)) ? Number(entry.sequence) : 0,
            timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
            status: typeof entry.status === "string" ? entry.status : "",
            payloadDigest: isSha256Digest(entry.payloadDigest) ? entry.payloadDigest : undefined,
          }))
        : [];
      const directives = Array.isArray(receipt?.directives)
        ? sortRuntimeBatchDirectives(receipt.directives.map(normalizeDirective).filter(
          (entry): entry is RuntimeBatchExecutionDirective => Boolean(entry),
        ))
        : undefined;
      const normalizedReceipt: RuntimeBatchTransitionReceipt = {
        receiptType: "runtime-batch-transition",
        batchId: typeof receipt?.batchId === "string" ? receipt.batchId : "",
        committedAt: typeof receipt?.committedAt === "string" ? receipt.committedAt : "",
        expectedQueueRevision: Number.isInteger(receipt?.expectedQueueRevision) ? Number(receipt!.expectedQueueRevision) : undefined,
        committedQueueRevision: Number.isInteger(receipt?.committedQueueRevision) ? Number(receipt!.committedQueueRevision) : 0,
        manifest: sortRuntimeBatchManifest(manifest),
        ...(directives ? { directives } : {}),
      };
      const batchId = typeof item.batchId === "string" ? item.batchId : "";
      return {
        batchId,
        payloadHash: typeof item.payloadHash === "string" ? item.payloadHash : "",
        committedAt: typeof item.committedAt === "string" ? item.committedAt : "",
        receipt: normalizedReceipt,
        executions: normalizeExecutions(item.executions, batchId, normalizedReceipt),
      };
    })
    .filter(item =>
      item.batchId.length > 0 &&
      item.payloadHash.length > 0 &&
      item.committedAt.length > 0 &&
      item.receipt.batchId.length > 0 &&
      item.receipt.committedAt.length > 0,
    );
  return retainRuntimeBatchCommitHistory(records);
}

const TERMINAL_EXECUTION_STATES = new Set<RuntimeBatchDirectiveExecutionState>([
  "completed", "failed", "cancelled",
]);

function terminalBatchCommit(record: RuntimeBatchCommitRecord): boolean {
  return (record.executions || []).every(execution => TERMINAL_EXECUTION_STATES.has(execution.state));
}

function retainRuntimeBatchCommitHistory(records: RuntimeBatchCommitRecord[]): RuntimeBatchCommitRecord[] {
  const nonterminalCount = records.filter(record => !terminalBatchCommit(record)).length;
  const terminalLimit = Math.max(0, MAX_BATCH_COMMITS - nonterminalCount);
  const terminal = records.filter(terminalBatchCommit);
  const retainedTerminal = new Set(terminalLimit > 0 ? terminal.slice(-terminalLimit) : []);
  return records.filter(record => !terminalBatchCommit(record) || retainedTerminal.has(record));
}

export function upsertRuntimeBatchCommitRecord(
  records: RuntimeBatchCommitRecord[],
  record: RuntimeBatchCommitRecord,
): RuntimeBatchCommitRecord[] {
  const executions = record.executions || normalizeExecutions(undefined, record.batchId, record.receipt);
  return retainRuntimeBatchCommitHistory([
    ...records.filter(item => item.batchId !== record.batchId), { ...record, executions },
  ]);
}
