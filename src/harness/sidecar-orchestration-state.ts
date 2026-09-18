/**
 * =============================================================================
 * Canvast — Sidecar Orchestration State / 旁路编排状态
 * =============================================================================
 * @file        src/harness/sidecar-orchestration-state.ts
 * @brief       Provides durable-state and snapshot helpers for sidecars.
 * @description Keeps persistence mechanics and state projection separate from
 *              request-scoped sidecar orchestration control flow.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { AutoOrchestrationAssessment, RecordedOrchestrationDecision } from "./auto-orchestrator.js";
import type { RuntimeBatchStage } from "./runtime-batch-bridge.js";
import type { RuntimeInputQueuePolicy } from "./runtime-status.js";
import type { SidecarDispatchRecord } from "./sidecar-dispatch-record.js";
import type { OrchestrationBatchCheckpoint, OrchestrationBatchCandidateStatus } from "./auto-orchestrator/types.js";

export type OrchestrationRequestKind = "primary" | "sidecar" | "batch";
export type OrchestrationRequestPhase =
  | "awaiting_message"
  | "active"
  | "waiting"
  | "answering"
  | "suspended"
  | "completed";
export type OrchestrationTerminalReason = "project_switched";

export interface OrchestrationBatchRequestItemIdentity {
  id: string;
  requestId: string;
  sequence: number;
  timestamp: string;
  status: OrchestrationBatchCandidateStatus;
}

export interface OrchestrationBatchRequestIdentity {
  batchId: string;
  revision: number;
  checkpoint: OrchestrationBatchCheckpoint;
  candidateHash: string;
  items: OrchestrationBatchRequestItemIdentity[];
  committedAt?: string;
}

export interface BatchRecordBinding {
  requestId: string;
  assessmentId: string;
}

export interface RuntimeBatchMessageIdentity {
  batchId: string;
  revision: number;
  checkpoint: RuntimeBatchStage["checkpoint"];
}

export interface BatchTransactionController {
  assessment?: AutoOrchestrationAssessment;
  decision?: RecordedOrchestrationDecision;
  record(
    input: Omit<RecordedOrchestrationDecision, "assessmentId" | "recordedAt">,
    now?: string,
  ): { ok: true; decision: RecordedOrchestrationDecision } | { ok: false; errors: string[] };
  assess(prompt: string, now?: string): AutoOrchestrationAssessment;
}

export interface BatchTransactionRequest {
  requestId: string;
  parentRequestId?: string;
  kind: OrchestrationRequestKind;
  runtimePolicy?: RuntimeInputQueuePolicy;
  prompt: string;
  assessmentPrompt?: string;
  phase: OrchestrationRequestPhase;
  createdAt: string;
  completedAt?: string;
  controller: BatchTransactionController;
  terminalReason?: OrchestrationTerminalReason;
  dispatch?: SidecarDispatchRecord;
  batch?: OrchestrationBatchRequestIdentity;
}

export function runtimeBatchMessageIdentity(message: any): RuntimeBatchMessageIdentity | undefined {
  if (message?.role !== "custom" || message?.customType !== "canvast-runtime-input-batch/v1" ||
      message?.details?.type !== "canvast-runtime-input-batch/v1") return undefined;
  return {
    batchId: String(message.details.batchId || ""),
    revision: Number(message.details.revision),
    checkpoint: message.details.checkpoint,
  };
}

export function batchRequestIdentity(stage: RuntimeBatchStage): OrchestrationBatchRequestIdentity {
  return {
    batchId: stage.batchId, revision: stage.revision, checkpoint: stage.checkpoint,
    candidateHash: stage.candidateHash,
    items: stage.candidates.map(({ id, requestId, sequence, timestamp, status }) =>
      ({ id, requestId, sequence, timestamp, status })),
  };
}

export function batchAssessmentPrompt(stage: RuntimeBatchStage): string {
  return stage.candidates.map(candidate => candidate.text).join("\n\n");
}

function batchBindingErrors(
  request: BatchTransactionRequest,
  input: Omit<RecordedOrchestrationDecision, "assessmentId" | "recordedAt">,
  binding: BatchRecordBinding,
): string[] {
  if (request.kind !== "batch" || !request.batch) return ["batch_plan requires the active typed batch request"];
  if (request.batch.committedAt) return [`batch ${request.batch.batchId} was already committed`];
  const assessmentId = request.controller.assessment?.id;
  if (binding.requestId !== request.requestId) return [`batch request_id does not match the active request ${request.requestId}`];
  if (!assessmentId || binding.assessmentId !== assessmentId) return ["batch assessment_id does not match the active batch assessment"];
  const plan = input.batchPlan;
  if (!plan) return ["the active batch assessment requires batch_plan"];
  const batch = request.batch;
  if (plan.batchId !== batch.batchId || plan.revision !== batch.revision ||
      plan.checkpoint !== batch.checkpoint || plan.candidateHash !== batch.candidateHash) {
    return ["batch_plan header does not match the active staged batch"];
  }
  if (plan.items.length !== batch.items.length) return ["batch_plan items do not exactly cover the active staged batch"];
  for (let index = 0; index < batch.items.length; index += 1) {
    const expected = batch.items[index];
    const actual = plan.items[index];
    if (!actual || actual.id !== expected.id || actual.requestId !== expected.requestId ||
        actual.sequence !== expected.sequence || actual.timestamp !== expected.timestamp ||
        actual.status !== expected.status) {
      return [`batch_plan item ${index + 1} does not match the ordered staged manifest`];
    }
  }
  return [];
}

export function prepareBatchTransaction(
  request: BatchTransactionRequest,
  input: Omit<RecordedOrchestrationDecision, "assessmentId" | "recordedAt">,
  binding: BatchRecordBinding,
  createController: () => BatchTransactionController,
  publish: (decision: RecordedOrchestrationDecision) => boolean,
  now: string,
) {
  const errors = batchBindingErrors(request, input, binding);
  if (errors.length > 0) return { ok: false as const, errors };
  const controller = createController();
  const assessment = controller.assess(request.assessmentPrompt ?? request.prompt, request.createdAt);
  assessment.id = request.controller.assessment!.id;
  const preview = controller.record(input, now);
  if (!preview.ok) return preview;
  try {
    if (!publish(preview.decision)) return { ok: false as const, errors: ["batch coordinator rejected the staged decision"] };
  } catch (error) {
    return { ok: false as const, errors: [`batch coordinator publish failed: ${error instanceof Error ? error.message : String(error)}`] };
  }
  return { ...preview, controller };
}

interface CreateBatchRequestOptions<TRequest extends BatchTransactionRequest> {
  request: (id: string | undefined) => TRequest | undefined;
  activeRequest: () => TRequest | undefined;
  createRequest: (
    kind: "batch",
    prompt: string,
    parentRequestId: string | undefined,
    now: string,
    runtimeInput: undefined,
    batch: OrchestrationBatchRequestIdentity,
    requestIdOverride: string,
    assessmentPrompt: string,
  ) => TRequest;
  persist: () => void;
  setActiveRequestId: (requestId: string) => void;
  setRestorationPending: (pending: boolean) => void;
}

export function beginBatchRequest<TRequest extends BatchTransactionRequest>(
  prompt: string,
  stage: RuntimeBatchStage,
  now: string,
  options: CreateBatchRequestOptions<TRequest>,
): OrchestrationRequestSnapshot {
  const requestId = `batch-request:${stage.batchId}`;
  const existing = options.request(requestId);
  if (existing?.kind === "batch") {
    options.setActiveRequestId(existing.requestId);
    options.persist();
    return requestSnapshot(existing)!;
  }
  const previousActive = options.activeRequest();
  const batch = batchRequestIdentity(stage);
  const request = options.createRequest(
    "batch",
    prompt,
    previousActive?.requestId,
    now,
    undefined,
    batch,
    requestId,
    batchAssessmentPrompt(stage),
  );
  request.phase = "active";
  options.setActiveRequestId(request.requestId);
  options.setRestorationPending(false);
  options.persist();
  return requestSnapshot(request)!;
}

export function recordBatchRequestTransaction<TRequest extends BatchTransactionRequest>(
  active: TRequest | undefined,
  input: Omit<RecordedOrchestrationDecision, "assessmentId" | "recordedAt">,
  binding: BatchRecordBinding,
  createController: () => BatchTransactionController,
  publish: (decision: RecordedOrchestrationDecision) => boolean,
  persist: () => void,
  now: string,
) {
  if (!active) return { ok: false as const, errors: ["no active orchestration request"] };
  const committed = prepareBatchTransaction(active, input, binding, createController, publish, now);
  if (!committed.ok) return committed;
  active.controller = committed.controller;
  active.batch!.committedAt = now;
  persist();
  return { ok: true as const, decision: committed.decision };
}

export interface OrchestrationRequestSnapshot {
  requestId: string;
  parentRequestId?: string;
  kind: OrchestrationRequestKind;
  runtimePolicy?: RuntimeInputQueuePolicy;
  phase: OrchestrationRequestPhase;
  terminalReason?: OrchestrationTerminalReason;
  assessmentId?: string;
  decisionAssessmentId?: string;
  createdAt: string;
  completedAt?: string;
  dispatch?: SidecarDispatchRecord;
  batch?: OrchestrationBatchRequestIdentity;
}

export interface LlmRequestIdentity {
  llmRequestId: string;
  requestId: string;
  parentRequestId?: string;
  requestKind: OrchestrationRequestKind;
  assessmentId?: string;
  provider?: string;
  model?: string;
  providerResponseId?: string;
}

export interface SidecarOrchestrationSnapshot {
  primaryRequest?: OrchestrationRequestSnapshot;
  activeRequest?: OrchestrationRequestSnapshot;
  requests: OrchestrationRequestSnapshot[];
  primaryNeedsExecution: boolean;
  restorationPending: boolean;
  latestLlmRequest?: LlmRequestIdentity;
}

export interface DurableOrchestrationRequest {
  requestId: string;
  parentRequestId?: string;
  kind: OrchestrationRequestKind;
  runtimePolicy?: RuntimeInputQueuePolicy;
  prompt: string;
  assessmentPrompt?: string;
  phase: OrchestrationRequestPhase;
  terminalReason?: OrchestrationTerminalReason;
  decision?: RecordedOrchestrationDecision;
  createdAt: string;
  completedAt?: string;
  dispatch?: SidecarDispatchRecord;
  batch?: OrchestrationBatchRequestIdentity;
}

export interface DurableSidecarOrchestrationState {
  version: 1;
  primaryRequestId?: string;
  activeRequestId?: string;
  openSidecarRequestIds: string[];
  primaryNeedsExecution: boolean;
  restorationPending: boolean;
  latestLlmRequest?: LlmRequestIdentity;
  requests: DurableOrchestrationRequest[];
}

interface RequestSnapshotSource extends DurableOrchestrationRequest {
  controller: {
    assessment?: { id: string };
    decision?: { assessmentId: string };
  };
}

export function requestSnapshot(
  request: RequestSnapshotSource | undefined,
): OrchestrationRequestSnapshot | undefined {
  if (!request) return undefined;
  const dispatch = request.dispatch ? {
    ...structuredClone(request.dispatch),
    toolCallId: request.dispatch.toolCallId,
    settledAt: request.dispatch.settledAt,
    failureCode: request.dispatch.failureCode,
  } : undefined;
  return {
    requestId: request.requestId,
    parentRequestId: request.parentRequestId,
    kind: request.kind,
    runtimePolicy: request.runtimePolicy,
    phase: request.phase,
    ...(request.terminalReason ? { terminalReason: request.terminalReason } : {}),
    assessmentId: request.controller.assessment?.id,
    decisionAssessmentId: request.controller.decision?.assessmentId,
    createdAt: request.createdAt,
    completedAt: request.completedAt,
    dispatch,
    batch: request.batch ? structuredClone(request.batch) : undefined,
  };
}

export function resolveSidecarOrchestrationStateFile(
  agentDir: string | (() => string) | undefined,
): string | undefined {
  if (!agentDir) return undefined;
  const dir = typeof agentDir === "function" ? agentDir() : agentDir;
  return path.join(dir, "sidecar-orchestration.json");
}

export function sidecarOrchestrationStateExists(target: string): boolean {
  return fs.existsSync(target);
}

export function readSidecarOrchestrationState(target: string): DurableSidecarOrchestrationState {
  return JSON.parse(fs.readFileSync(target, "utf-8")) as DurableSidecarOrchestrationState;
}

export function writeSidecarOrchestrationState(
  target: string,
  state: DurableSidecarOrchestrationState,
): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${process.hrtime.bigint()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
  fs.renameSync(temporary, target);
}

export interface RuntimeStateRequest {
  requestId: string;
  phase: OrchestrationRequestPhase;
  completedAt?: string;
  terminalReason?: OrchestrationTerminalReason;
  dispatch?: SidecarDispatchRecord;
}

export function settleRuntimeStateRequests(
  requests: Iterable<RuntimeStateRequest>,
  reason: OrchestrationTerminalReason,
  now: string,
  emitDispatchUpdate: (dispatch: SidecarDispatchRecord) => void,
): string[] {
  const retiredRequestIds: string[] = [];
  for (const request of requests) {
    if (request.phase !== "completed") {
      request.phase = "completed";
      request.completedAt = now;
    } else if (!request.completedAt) {
      request.completedAt = now;
    }
    request.terminalReason = reason;
    retiredRequestIds.push(request.requestId);
    if (request.dispatch?.executionState === "recorded" || request.dispatch?.executionState === "admitted") {
      request.dispatch.executionState = request.dispatch.decision.tool === "none" ? "completed" : "failed";
      request.dispatch.updatedAt = now;
      request.dispatch.settledAt = now;
      request.dispatch.failureCode = request.dispatch.decision.tool === "none"
        ? undefined
        : request.dispatch.executionState === "failed" && request.dispatch.toolCallId
          ? "tool_owner_reset"
          : "tool_not_executed";
      emitDispatchUpdate(request.dispatch);
    }
  }
  return retiredRequestIds;
}

export interface ResettableRuntimeState {
  requests: Map<string, unknown>;
  openSidecarRequestIds: string[];
  toolCallOwners: Map<string, unknown>;
  primaryRequestId?: string;
  activeRequestId?: string;
  awaitingPrimaryMessage: boolean;
  primaryNeedsExecution: boolean;
  restorationPending: boolean;
  latestLlmRequest?: LlmRequestIdentity;
}

export function clearSidecarRuntimeState(state: ResettableRuntimeState): void {
  state.requests.clear();
  state.openSidecarRequestIds.length = 0;
  state.toolCallOwners.clear();
  state.primaryRequestId = undefined;
  state.activeRequestId = undefined;
  state.awaitingPrimaryMessage = false;
  state.primaryNeedsExecution = false;
  state.restorationPending = false;
  state.latestLlmRequest = undefined;
}
