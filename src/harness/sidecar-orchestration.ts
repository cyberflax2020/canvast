/**
 * =============================================================================
 * Canvast — Request-Scoped Sidecar Orchestration / 请求级旁路编排
 * =============================================================================
 * @file        src/harness/sidecar-orchestration.ts
 * @brief       Keeps primary and follow-up orchestration state independent.
 * @description Uses Pi message/context lifecycle events and generated request
 *              identities to switch assessments for in-run user follow-ups,
 *              then restores unfinished primary work after the sidecar answer.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import { randomUUID } from "node:crypto";

import {
  parseSubAgentDispatchInvocation,
  type SubAgentDispatchInvocation,
} from "../agents/sub-agent-dispatch-contract.js";
import { createAutoOrchestrationController } from "./auto-orchestrator.js";
import type { AutoOrchestrationAssessment, RecordedOrchestrationDecision, ToolBlockDecision } from "./auto-orchestrator.js";
import type { RuntimeBatchStage } from "./runtime-batch-bridge.js";
import { type RuntimeInputQueuePolicy } from "./runtime-status.js";
import {
  decideSidecarDispatch,
  deriveSidecarDispatchEvidence,
  type SidecarDispatchBranchEvidence,
  type SidecarDispatchEvidence,
  type SidecarDispatchStrategy,
  type SidecarIsolation,
  type SidecarPrimaryDependency,
} from "./sidecar-dispatch-policy.js";
import {
  collectSidecarChildRunIds,
  parsePersistedSidecarDispatch,
  sidecarDispatchAdmissionIssue,
  sidecarDispatchResultFailure,
  type SidecarDispatchRecord,
  type SidecarDispatchRuntimeEvidence,
} from "./sidecar-dispatch-record.js";
import {
  sidecarAssistantNeedsAnotherTurn,
  sidecarCompletionProjection,
  sidecarDecisionHasRunnableWork,
  sidecarMessageText,
  sidecarResponseIdentity,
  sidecarVisibleReplyCanSettle,
} from "./sidecar-message-lifecycle.js";
import {
  agentPlanTools,
  dispatchPolicy,
  dispatchToolInput,
  dispatchToolName,
  isSidecarPolicy,
  runtimeInputResolver,
  type RuntimeInputRoute,
} from "./sidecar-orchestration-routing.js";
import { buildSidecarContextGuidance, createBoundLlmRequest, createUnboundLlmRequest } from "./sidecar-orchestration-context.js";
import { validatePersistedSidecarFifo } from "./sidecar-orchestration-hydration.js";
import {
  clearSidecarRuntimeState,
  beginBatchRequest,
  readSidecarOrchestrationState,
  recordBatchRequestTransaction,
  requestSnapshot,
  resolveSidecarOrchestrationStateFile,
  settleRuntimeStateRequests,
  sidecarOrchestrationStateExists,
  runtimeBatchMessageIdentity,
  writeSidecarOrchestrationState,
  type DurableSidecarOrchestrationState,
  type LlmRequestIdentity,
  type BatchRecordBinding,
  type OrchestrationBatchRequestIdentity,
  type OrchestrationRequestKind,
  type OrchestrationRequestPhase,
  type OrchestrationRequestSnapshot,
  type OrchestrationTerminalReason,
  type SidecarOrchestrationSnapshot,
} from "./sidecar-orchestration-state.js";

export type {
  SidecarDispatchExecutionState,
  SidecarDispatchFailureCode,
  SidecarDispatchRecord,
  SidecarDispatchRuntimeEvidence,
} from "./sidecar-dispatch-record.js";
export type {
  LlmRequestIdentity,
  OrchestrationRequestKind,
  OrchestrationRequestPhase,
  OrchestrationRequestSnapshot,
  OrchestrationTerminalReason,
  SidecarOrchestrationSnapshot,
} from "./sidecar-orchestration-state.js";

type AutoOrchestrationController = ReturnType<typeof createAutoOrchestrationController>;
type RecordedDecisionInput = Parameters<AutoOrchestrationController["record"]>[0];
type ToolCallEvent = Parameters<AutoOrchestrationController["shouldBlock"]>[0];
type ToolResultEvent = Parameters<AutoOrchestrationController["onToolResult"]>[0];

interface OrchestrationRequest {
  requestId: string;
  parentRequestId?: string;
  kind: OrchestrationRequestKind;
  runtimePolicy?: RuntimeInputQueuePolicy;
  prompt: string; assessmentPrompt?: string;
  phase: OrchestrationRequestPhase;
  terminalReason?: OrchestrationTerminalReason;
  controller: AutoOrchestrationController;
  createdAt: string;
  completedAt?: string;
  dispatch?: SidecarDispatchRecord;
  batch?: OrchestrationBatchRequestIdentity;
}

export interface RecordSidecarDispatchInput {
  expectedRevision: number;
  requestedStrategy?: SidecarDispatchStrategy;
  branches: SidecarDispatchBranchEvidence[];
  branchCount: number;
  selfContained?: boolean;
  primaryDependency?: SidecarPrimaryDependency;
  writeIsolation?: SidecarIsolation;
  externalResourceIsolation?: SidecarIsolation;
}

export interface SidecarOrchestrationOptions {
  createController?: () => AutoOrchestrationController;
  now?: () => string;
  createId?: (kind: "primary" | "sidecar" | "batch" | "llm") => string;
  agentDir?: string | (() => string);
  resolveRuntimeInput?: (prompt: string) => RuntimeInputRoute | undefined;
  resolveDispatchRuntime?: () => SidecarDispatchRuntimeEvidence;
  reserveDispatchCapacity?: (
    reservationId: string,
    slots: number,
    dispatch: SubAgentDispatchInvocation,
  ) => boolean;
  releaseDispatchCapacity?: (reservationId: string) => void;
  onDispatchUpdate?: (record: SidecarDispatchRecord) => void;
  resolveRuntimeBatch?: (identity: { batchId: string; revision: number; checkpoint: RuntimeBatchStage["checkpoint"] }) => RuntimeBatchStage | undefined;
  onProjectRebind?: () => void;
}

export interface ContextInjectionResult { messages: any[]; llmRequest: LlmRequestIdentity; injected: boolean; }

export interface TurnCompletionResult {
  completedSidecarRequestIds: string[];
  completedDecisions: RecordedOrchestrationDecision[];
  restoredPrimary: boolean;
  primaryDecision?: RecordedOrchestrationDecision;
}

export interface SidecarProjectBindingTransition {
  fromAgentDir?: string;
  toAgentDir: string;
  settled: boolean;
  retiredRequestIds: string[];
}

interface SidecarToolCallOwner {
  requestId: string;
  revision: number;
  toolName: string;
}

export interface RollbackToolAdmissionResult { rolledBack: boolean; requestId?: string; revision?: number; }

export class SidecarOrchestrationController {
  private readonly createController: () => AutoOrchestrationController;
  private readonly now: () => string;
  private readonly createId: (kind: "primary" | "sidecar" | "batch" | "llm") => string;
  private readonly resolveRuntimeInput: (prompt: string) => RuntimeInputRoute | undefined;
  private readonly resolveDispatchRuntime: () => SidecarDispatchRuntimeEvidence;
  private readonly reserveDispatchCapacity?: (
    reservationId: string,
    slots: number,
    dispatch: SubAgentDispatchInvocation,
  ) => boolean;
  private readonly releaseDispatchCapacity?: (reservationId: string) => void;
  private readonly onDispatchUpdate?: (record: SidecarDispatchRecord) => void;
  private readonly resolveRuntimeBatch?: (identity: { batchId: string; revision: number; checkpoint: RuntimeBatchStage["checkpoint"] }) => RuntimeBatchStage | undefined;
  private readonly onProjectRebind?: () => void;
  private readonly requests = new Map<string, OrchestrationRequest>();
  private readonly openSidecarRequestIds: string[] = [];
  private readonly toolCallOwners = new Map<string, SidecarToolCallOwner>();
  private readonly seenToolCallIds = new Set<string>();
  private primaryRequestId: string | undefined;
  private activeRequestId: string | undefined;
  private awaitingPrimaryMessage = false;
  private primaryNeedsExecution = false;
  private restorationPending = false;
  private latestLlmRequest: LlmRequestIdentity | undefined;
  private sequence = 0;
  private readonly agentDir?: string | (() => string);
  private boundAgentDir: string | undefined;

  constructor(options: SidecarOrchestrationOptions = {}) {
    this.createController = options.createController || createAutoOrchestrationController;
    this.now = options.now || (() => new Date().toISOString());
    this.createId = options.createId || (kind => `${kind}-${++this.sequence}-${randomUUID()}`);
    this.resolveRuntimeInput = options.resolveRuntimeInput || runtimeInputResolver(options.agentDir);
    this.resolveDispatchRuntime = options.resolveDispatchRuntime || (() => ({
      availableChildSlots: 0,
      budgetAvailable: false,
      asyncDispatchAvailable: false,
    }));
    this.reserveDispatchCapacity = options.reserveDispatchCapacity;
    this.releaseDispatchCapacity = options.releaseDispatchCapacity;
    this.onDispatchUpdate = options.onDispatchUpdate;
    this.resolveRuntimeBatch = options.resolveRuntimeBatch;
    this.onProjectRebind = options.onProjectRebind;
    this.agentDir = options.agentDir;
    this.boundAgentDir = this.resolvedAgentDir();
    this.hydrate();
  }

  private emitDispatchUpdate(record: SidecarDispatchRecord): void {
    try {
      this.onDispatchUpdate?.(structuredClone(record));
    } catch {
      // Runtime projection is observational and must not corrupt dispatch state.
    }
  }

  private persist(): void {
    const target = resolveSidecarOrchestrationStateFile(this.boundAgentDir);
    if (!target) return;
    const state: DurableSidecarOrchestrationState = {
      version: 1, primaryRequestId: this.primaryRequestId, activeRequestId: this.activeRequestId,
      openSidecarRequestIds: [...this.openSidecarRequestIds], primaryNeedsExecution: this.primaryNeedsExecution,
      restorationPending: this.restorationPending, latestLlmRequest: this.latestLlmRequest ? { ...this.latestLlmRequest } : undefined,
      requests: Array.from(this.requests.values()).map(request => ({
        requestId: request.requestId, parentRequestId: request.parentRequestId, kind: request.kind,
        runtimePolicy: request.runtimePolicy, prompt: request.prompt, assessmentPrompt: request.assessmentPrompt, phase: request.phase,
        terminalReason: request.terminalReason,
        decision: request.controller.decision, createdAt: request.createdAt, completedAt: request.completedAt,
        dispatch: request.dispatch, batch: request.batch,
      })),
    };
    writeSidecarOrchestrationState(target, state);
  }

  private resolvedAgentDir(): string | undefined {
    if (!this.agentDir) return undefined;
    return typeof this.agentDir === "function" ? this.agentDir() : this.agentDir;
  }

  private hydrate(): void {
    const target = resolveSidecarOrchestrationStateFile(this.boundAgentDir);
    if (!target || !sidecarOrchestrationStateExists(target)) return;
    try {
      const state = readSidecarOrchestrationState(target);
      if (state.version !== 1 || !Array.isArray(state.requests)) return;
      if (!Array.isArray(state.openSidecarRequestIds)) return;
      const hydratedRequests = new Map<string, OrchestrationRequest>();
      const reconciledDispatches: SidecarDispatchRecord[] = [];
      for (const stored of state.requests) {
        if (!stored?.requestId || !stored.prompt ||
            (stored.kind !== "primary" && stored.kind !== "sidecar" && stored.kind !== "batch")) {
          throw new Error("invalid persisted orchestration request");
        }
        if (hydratedRequests.has(stored.requestId)) throw new Error("duplicate persisted orchestration request");
        const controller = this.createController();
        const assessment = controller.assess(stored.assessmentPrompt ?? stored.prompt, stored.createdAt);
        assessment.id = `${assessment.id}_${stored.requestId}`;
        if (stored.decision) {
          const { assessmentId: _assessmentId, recordedAt, ...decision } = stored.decision;
          controller.record(decision, recordedAt);
        }
        const dispatch = parsePersistedSidecarDispatch(
          stored.dispatch,
          stored.requestId,
          dispatchPolicy(stored.runtimePolicy),
          stored.phase === "completed",
          this.now(),
        );
        if (dispatch?.failureCode === "invalid_persisted_dispatch") reconciledDispatches.push(dispatch);
        if (dispatch?.executionState === "admitted") {
          const settledAt = this.now();
          dispatch.executionState = "failed";
          dispatch.updatedAt = settledAt;
          dispatch.settledAt = settledAt;
          dispatch.failureCode = "runtime_owner_unavailable_after_reload";
          reconciledDispatches.push(dispatch);
        }
        hydratedRequests.set(stored.requestId, { ...stored, dispatch, controller });
      }
      const openSidecars = validatePersistedSidecarFifo(state, hydratedRequests);
      this.requests.clear();
      for (const [id, request] of hydratedRequests) this.requests.set(id, request);
      this.primaryRequestId = state.primaryRequestId && hydratedRequests.get(state.primaryRequestId)?.kind === "primary"
        ? state.primaryRequestId
        : undefined;
      this.activeRequestId = state.activeRequestId && hydratedRequests.has(state.activeRequestId)
        ? state.activeRequestId
        : this.primaryRequestId;
      this.openSidecarRequestIds.push(...openSidecars);
      this.primaryNeedsExecution = state.primaryNeedsExecution === true;
      this.restorationPending = state.restorationPending === true;
      this.latestLlmRequest = state.latestLlmRequest;
      if (reconciledDispatches.length > 0) this.persist();
    } catch {
      // Corrupt orchestration state is isolated; runtime request state remains authoritative.
    }
  }

  private settleAllRequests(reason: OrchestrationTerminalReason, now = this.now()): string[] {
    return settleRuntimeStateRequests(this.requests.values(), reason, now, dispatch =>
      this.emitDispatchUpdate(dispatch)
    );
  }

  private clearRuntimeState(): void {
    clearSidecarRuntimeState(this as unknown as Parameters<typeof clearSidecarRuntimeState>[0]);
  }

  reconcilePersistedDispatches(): void {
    for (const request of this.requests.values()) {
      const dispatch = request.dispatch;
      if (!dispatch) continue;
      if (["runtime_owner_unavailable_after_reload", "invalid_persisted_dispatch"].includes(
        dispatch.failureCode || "",
      )) {
        this.emitDispatchUpdate(dispatch);
      }
    }
  }

  private request(id: string | undefined): OrchestrationRequest | undefined {
    return id ? this.requests.get(id) : undefined;
  }

  private activeRequest(): OrchestrationRequest | undefined {
    return this.request(this.activeRequestId);
  }

  private primaryRequest(): OrchestrationRequest | undefined {
    return this.request(this.primaryRequestId);
  }

  private removeOpenSidecar(requestId: string): void {
    const index = this.openSidecarRequestIds.lastIndexOf(requestId);
    if (index >= 0) this.openSidecarRequestIds.splice(index, 1);
  }

  private nextOpenSidecar(): OrchestrationRequest | undefined {
    for (let index = 0; index < this.openSidecarRequestIds.length; index += 1) {
      const candidate = this.request(this.openSidecarRequestIds[index]);
      if (candidate && candidate.phase !== "completed") return candidate;
    }
    return undefined;
  }

  private releaseAllDispatchReservations(): void {
    if (!this.releaseDispatchCapacity) return;
    for (const request of this.requests.values()) {
      if (request.dispatch?.executionState === "admitted" && request.dispatch.toolCallId) {
        this.releaseDispatchCapacity(request.dispatch.toolCallId);
      }
    }
  }

  private createRequest(
    kind: OrchestrationRequestKind,
    prompt: string,
    parentRequestId?: string,
    now = this.now(),
    runtimeInput?: RuntimeInputRoute,
    batch?: OrchestrationBatchRequestIdentity,
    requestIdOverride?: string, assessmentPrompt = prompt,
  ): OrchestrationRequest {
    const requestId = requestIdOverride || runtimeInput?.requestId || this.createId(kind);
    const controller = this.createController();
    const assessment = controller.assess(assessmentPrompt, now);
    // The base orchestrator hashes prompt text. Qualifying that hash with the
    // generated request identity keeps repeated, text-identical follow-ups
    // independent without changing the prompt used for semantic assessment.
    assessment.id = `${assessment.id}_${requestId}`;
    const request: OrchestrationRequest = {
      requestId,
      parentRequestId,
      kind,
      runtimePolicy: runtimeInput?.policy,
      prompt,
      ...(assessmentPrompt !== prompt ? { assessmentPrompt } : {}),
      phase: kind === "primary" ? "awaiting_message" : "active",
      controller,
      createdAt: now,
      batch,
    };
    this.requests.set(request.requestId, request);
    return request;
  }

  beginPrimary(
    prompt: string,
    now = this.now(),
    runtimeInput?: RuntimeInputRoute,
  ): AutoOrchestrationAssessment {
    this.releaseAllDispatchReservations();
    this.requests.clear();
    this.openSidecarRequestIds.length = 0;
    this.latestLlmRequest = undefined;
    this.restorationPending = false;
    const primary = this.createRequest("primary", prompt, undefined, now, runtimeInput);
    this.primaryRequestId = primary.requestId;
    this.activeRequestId = primary.requestId;
    this.awaitingPrimaryMessage = true;
    this.primaryNeedsExecution = prompt.trim().length > 0;
    this.persist();
    return primary.controller.assessment!;
  }

  resumeRestoredPrimary(): AutoOrchestrationAssessment | undefined {
    const primary = this.primaryRequest();
    if (!primary || !this.restorationPending) return undefined;
    primary.phase = "active";
    this.activeRequestId = primary.requestId;
    this.persist();
    return primary.controller.assessment;
  }

  /** Compatibility surface for the former singleton controller. */
  assess(prompt: string, now?: string): AutoOrchestrationAssessment {
    return this.beginPrimary(prompt, now || this.now());
  }

  get assessment(): AutoOrchestrationAssessment | undefined {
    return this.activeRequest()?.controller.assessment;
  }

  get decision(): RecordedOrchestrationDecision | undefined {
    return this.activeRequest()?.controller.decision;
  }

  get lifecycleActions() {
    return this.activeRequest()?.controller.lifecycleActions || [];
  }

  private beginBatch(prompt: string, stage: RuntimeBatchStage, now = this.now()): OrchestrationRequestSnapshot {
    return beginBatchRequest(prompt, stage, now, {
      request: id => this.request(id),
      activeRequest: () => this.activeRequest(),
      createRequest: (kind, batchPrompt, parentRequestId, createdAt, runtimeInput, batch, requestIdOverride, assessmentPrompt) =>
        this.createRequest(kind, batchPrompt, parentRequestId, createdAt, runtimeInput, batch, requestIdOverride, assessmentPrompt),
      persist: () => this.persist(),
      setActiveRequestId: requestId => { this.activeRequestId = requestId; },
      setRestorationPending: pending => { this.restorationPending = pending; },
    });
  }

  recordBatchTransaction(
    input: RecordedDecisionInput,
    binding: BatchRecordBinding,
    publish: (decision: RecordedOrchestrationDecision) => boolean,
    now = this.now(),
  ) {
    return recordBatchRequestTransaction(
      this.activeRequest(),
      input,
      binding,
      this.createController,
      publish,
      () => this.persist(),
      now,
    );
  }

  private settleRollbackDispatch(
    owner: OrchestrationRequest,
    toolCallId: string,
    reason: string,
  ): RollbackToolAdmissionResult {
    const dispatch = owner.dispatch;
    if (
      !dispatch ||
      dispatch.executionState !== "admitted" ||
      dispatch.toolCallId !== toolCallId
    ) {
      return { rolledBack: false };
    }
    dispatch.executionState = "recorded";
    dispatch.updatedAt = this.now();
    dispatch.toolCallId = undefined;
    dispatch.settledAt = undefined;
    dispatch.failureCode = undefined;
    dispatch.childRunIds = [];
    this.toolCallOwners.delete(toolCallId);
    this.releaseDispatchCapacity?.(toolCallId);
    this.persist();
    this.emitDispatchUpdate(dispatch);
    void reason;
    return { rolledBack: true, requestId: owner.requestId, revision: dispatch.revision };
  }

  rollbackToolAdmission(toolCallId: string, _reason?: string): RollbackToolAdmissionResult {
    const id = typeof toolCallId === "string" ? toolCallId.trim() : "";
    if (!id) return { rolledBack: false };
    const binding = this.toolCallOwners.get(id);
    if (!binding) return { rolledBack: false };
    const owner = this.request(binding.requestId);
    if (!owner) {
      this.toolCallOwners.delete(id);
      this.releaseDispatchCapacity?.(id);
      return { rolledBack: false };
    }
    if (binding.revision === 0) return { rolledBack: false };
    return this.settleRollbackDispatch(owner, id, _reason || "tool_admission_rolled_back");
  }

  recordSidecarDispatch(input: RecordSidecarDispatchInput, now = this.now()): SidecarDispatchRecord {
    const active = this.activeRequest();
    if (!active || active.kind !== "sidecar") {
      throw new Error("sidecar dispatch requires an active sidecar request");
    }
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new Error("sidecar dispatch expectedRevision must be a non-negative integer");
    }
    const currentRevision = active.dispatch?.revision || 0;
    if (currentRevision >= Number.MAX_SAFE_INTEGER - 1) {
      throw new Error("sidecar dispatch revision space is exhausted");
    }
    if (input.expectedRevision !== currentRevision) {
      throw new Error(`sidecar dispatch revision conflict: expected ${input.expectedRevision}, current ${currentRevision}`);
    }
    if (active.dispatch?.executionState === "admitted") {
      throw new Error("sidecar dispatch cannot be replaced while its agent tool is in flight");
    }
    const runtime = this.resolveDispatchRuntime();
    const evidence: SidecarDispatchEvidence = deriveSidecarDispatchEvidence({
      requestPolicy: dispatchPolicy(active.runtimePolicy),
      branches: input.branches,
      branchCount: input.branchCount,
      selfContained: input.selfContained,
      primaryDependency: input.primaryDependency,
      writeIsolation: input.writeIsolation,
      externalResourceIsolation: input.externalResourceIsolation,
      availableChildSlots: runtime.availableChildSlots,
      budgetAvailable: runtime.budgetAvailable,
      asyncDispatchAvailable: false,
      requestedStrategy: input.requestedStrategy,
    });
    const decision = decideSidecarDispatch(evidence);
    const orchestrationDecision = active.controller.decision;
    const plannedAgentTools = agentPlanTools(orchestrationDecision?.toolCallPlan || []);
    if (decision.tool !== "none" && orchestrationDecision && plannedAgentTools.size === 0) {
      throw new Error(
        `sidecar dispatch tool ${decision.tool} requires an agent domain in the current auto_orchestration_decision`,
      );
    }
    active.dispatch = {
      revision: currentRevision + 1,
      requestId: active.requestId,
      recordedAt: now,
      evidence,
      decision,
      executionState: "recorded",
      updatedAt: now,
      childRunIds: [],
    };
    this.persist();
    this.emitDispatchUpdate(active.dispatch);
    return structuredClone(active.dispatch);
  }

  renderPrompt(): string {
    return this.activeRequest()?.controller.renderPrompt() || "";
  }

  record(input: RecordedDecisionInput, now = this.now()) {
    const active = this.activeRequest();
    if (!active) return { ok: false as const, errors: ["no active orchestration request"] };
    if (input.batchPlan || active.kind === "batch") {
      return {
        ok: false as const,
        errors: ["batch decisions require request-bound transactional recording"],
      };
    }
    const result = active.controller.record(input, now);
    if (result.ok) this.persist();
    return result;
  }

  shouldBlock(event: ToolCallEvent): ToolBlockDecision {
    const active = this.activeRequest();
    if (!active) return { block: false };
    const toolName = dispatchToolName(event);
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId.trim() : "";
    if (toolCallId && (this.toolCallOwners.has(toolCallId) || this.seenToolCallIds.has(toolCallId))) {
      return {
        block: true,
        reason: "toolCallId must be globally unique for the current orchestration runtime. / 当前编排运行中 toolCallId 必须全局唯一。",
      };
    }
    let reservedDispatchId: string | undefined;
    if (active.kind === "sidecar" && (toolName === "spawn_agent" || toolName === "parallel_agents")) {
      const dispatch = active.dispatch;
      if (!dispatch) {
        return {
          block: true,
          reason: "Record a typed sidecar dispatch decision before launching a child agent. / 启动子 Agent 前必须先记录结构化 sidecar 调度决策。",
        };
      }
      if (dispatch.executionState !== "recorded") {
        return { block: true, reason: "This sidecar dispatch revision has already been used. / 当前 sidecar 调度版本已经使用。" };
      }
      if (dispatch.decision.tool !== toolName) {
        return {
          block: true,
          reason: `Recorded sidecar dispatch requires ${dispatch.decision.tool}, not ${toolName}. / 已记录的 sidecar 调度要求 ${dispatch.decision.tool}，不能执行 ${toolName}。`,
        };
      }
      if (!toolCallId) {
        return {
          block: true,
          reason: "Sidecar agent dispatch requires a non-empty tool-call correlation ID. / Sidecar 子 Agent 调度需要非空的工具调用关联 ID。",
        };
      }
      const dispatchInput = dispatchToolInput(event);
      const admissionIssue = sidecarDispatchAdmissionIssue(
        dispatch,
        toolName,
        dispatchInput,
        this.resolveDispatchRuntime(),
      );
      if (admissionIssue) return { block: true, reason: admissionIssue };
      const invocation = parseSubAgentDispatchInvocation(toolName, dispatchInput);
      if (!invocation) {
        return {
          block: true,
          reason: "The typed sub-agent execution descriptor is invalid. / 子 Agent 的结构化执行描述无效。",
        };
      }
      const requiredSlots = toolName === "parallel_agents" ? 2 : 1;
      if (this.reserveDispatchCapacity &&
          !this.reserveDispatchCapacity(toolCallId, requiredSlots, invocation)) {
        return {
          block: true,
          reason: "The child-agent owner could not reserve capacity for this dispatch. Record a new revision when capacity is available. / 子 Agent owner 无法为此次调度预留容量，请在容量可用后记录新版本。",
        };
      }
      if (this.reserveDispatchCapacity) reservedDispatchId = toolCallId;
    }
    const trustedAgentTool = active.kind === "sidecar" && active.dispatch?.decision.tool === toolName
      ? toolName as "spawn_agent" | "parallel_agents"
      : undefined;
    const decision = active.controller.shouldBlock(event, { trustedAgentTool });
    if (decision.block && reservedDispatchId) {
      this.releaseDispatchCapacity?.(reservedDispatchId);
    }
    if (!decision.block && toolCallId) {
      this.seenToolCallIds.add(toolCallId);
      if (active.kind === "sidecar" && active.dispatch?.decision.tool === toolName) {
        active.dispatch.executionState = "admitted";
        active.dispatch.updatedAt = this.now();
        active.dispatch.toolCallId = toolCallId;
        this.toolCallOwners.set(toolCallId, {
          requestId: active.requestId,
          revision: active.dispatch.revision,
          toolName,
        });
        this.persist();
        this.emitDispatchUpdate(active.dispatch);
      } else {
        this.toolCallOwners.set(toolCallId, {
          requestId: active.requestId,
          revision: 0,
          toolName,
        });
      }
    }
    return decision;
  }

  onToolResult(event: ToolResultEvent): void {
    const id = typeof event.toolCallId === "string" ? event.toolCallId.trim() : "";
    const binding = id ? this.toolCallOwners.get(id) : undefined;
    const owner = this.request(binding?.requestId);
    if (binding?.revision === 0 && owner) owner.controller.onToolResult(event);
    const resultToolName = dispatchToolName(event);
    if (
      binding &&
      owner?.dispatch?.toolCallId === id &&
      owner.dispatch.revision === binding.revision &&
      owner.dispatch.executionState === "admitted"
    ) {
      const settledAt = this.now();
      const failureCode = binding.toolName === resultToolName
        ? sidecarDispatchResultFailure(
            event,
            binding.toolName as "spawn_agent" | "parallel_agents",
            owner.dispatch.evidence.branches,
          )
        : "invalid_tool_result";
      owner.dispatch.executionState = failureCode ? "failed" : "completed";
      owner.dispatch.updatedAt = settledAt;
      owner.dispatch.settledAt = settledAt;
      owner.dispatch.failureCode = failureCode;
      owner.dispatch.childRunIds = collectSidecarChildRunIds(event.details);
      this.persist();
      this.emitDispatchUpdate(owner.dispatch);
    }
    if (binding && id) this.toolCallOwners.delete(id);
    if (binding && id) this.releaseDispatchCapacity?.(id);
  }

  resetPendingToolCalls(): void {
    for (const request of this.requests.values()) {
      request.controller.resetPendingToolCalls();
    }
    const resetAt = this.now();
    for (const [toolCallId, binding] of this.toolCallOwners) {
      const owner = this.request(binding.requestId);
      if (
        owner?.dispatch?.executionState === "admitted" &&
        owner.dispatch.revision === binding.revision &&
        owner.dispatch.toolCallId === toolCallId
      ) {
        owner.dispatch.executionState = "failed";
        owner.dispatch.updatedAt = resetAt;
        owner.dispatch.settledAt = resetAt;
        owner.dispatch.failureCode = "tool_owner_reset";
        this.emitDispatchUpdate(owner.dispatch);
      }
      this.releaseDispatchCapacity?.(toolCallId);
    }
    this.toolCallOwners.clear();
    this.seenToolCallIds.clear();
    this.persist();
  }

  rebindProject(agentDir: string, now = this.now()): SidecarProjectBindingTransition {
    const nextAgentDir = agentDir.trim();
    if (!nextAgentDir) throw new Error("sidecar project rebind requires a non-empty agentDir");
    this.onProjectRebind?.();
    const previousAgentDir = this.boundAgentDir;
    if (previousAgentDir === nextAgentDir) {
      this.releaseAllDispatchReservations();
      this.seenToolCallIds.clear();
      this.clearRuntimeState();
      this.hydrate();
      this.persist();
      return {
        fromAgentDir: previousAgentDir,
        toAgentDir: nextAgentDir,
        settled: false,
        retiredRequestIds: [],
      };
    }

    this.releaseAllDispatchReservations();
    const retiredRequestIds = this.settleAllRequests("project_switched", now);
    if (retiredRequestIds.length > 0) {
      this.primaryRequestId = undefined;
      this.activeRequestId = undefined;
      this.openSidecarRequestIds.length = 0;
      this.primaryNeedsExecution = false;
      this.restorationPending = false;
      this.latestLlmRequest = undefined;
      this.persist();
    }
    this.seenToolCallIds.clear();
    this.clearRuntimeState();
    this.boundAgentDir = nextAgentDir;
    this.hydrate();
    this.persist();
    return {
      fromAgentDir: previousAgentDir,
      toAgentDir: nextAgentDir,
      settled: retiredRequestIds.length > 0,
      retiredRequestIds,
    };
  }

  onMessageStart(message: any, now = this.now()): OrchestrationRequestSnapshot | undefined {
    const identity = runtimeBatchMessageIdentity(message);
    if (identity) {
      const stage = this.resolveRuntimeBatch?.(identity);
      if (!stage || stage.batchId !== identity.batchId || stage.revision !== identity.revision ||
          stage.checkpoint !== identity.checkpoint) return undefined;
      return this.beginBatch(sidecarMessageText(message), stage, now);
    }
    if (message?.role === "user") {
      if (this.awaitingPrimaryMessage) {
        this.awaitingPrimaryMessage = false;
        const primary = this.primaryRequest();
        if (primary) {
          primary.phase = "active";
          this.activeRequestId = primary.requestId;
          this.persist();
          return requestSnapshot(primary);
        }
      }

      const prompt = sidecarMessageText(message);
      const runtimeInput = this.resolveRuntimeInput(prompt);
      if (!this.primaryRequest()) {
        this.beginPrimary(prompt, now, runtimeInput);
        this.awaitingPrimaryMessage = false;
        const primary = this.primaryRequest();
        if (primary) primary.phase = "active";
        this.persist();
        return requestSnapshot(primary);
      }

      // Queue text is only a correlation key. The persisted policy is the
      // authoritative semantic route: only sidecar/status records suspend the
      // primary. Interrupting or adjusting input replaces the primary-scoped
      // assessment, and uncorrelated input is never guessed to be a sidecar.
      if (!runtimeInput || !isSidecarPolicy(runtimeInput.policy)) {
        this.beginPrimary(prompt, now, runtimeInput);
        this.awaitingPrimaryMessage = false;
        const primary = this.primaryRequest();
        if (primary) primary.phase = "active";
        this.persist();
        return requestSnapshot(primary);
      }

      const previousActive = this.activeRequest();
      const primary = this.primaryRequest()!;
      if (primary.phase !== "completed") primary.phase = "suspended";
      const sidecar = this.createRequest("sidecar", prompt, primary.requestId, now, runtimeInput);
      if (previousActive?.kind === "sidecar" && previousActive.phase !== "completed") {
        sidecar.phase = "waiting";
      }
      this.openSidecarRequestIds.push(sidecar.requestId);
      this.activeRequestId = previousActive?.kind === "sidecar" && previousActive.phase !== "completed"
        ? previousActive.requestId
        : sidecar.requestId;
      this.restorationPending = false;
      this.persist();
      return requestSnapshot(this.activeRequest());
    }

    if (message?.role === "assistant") {
      const active = this.activeRequest();
      if (active && active.phase !== "completed") active.phase = "answering";
      this.captureResponseIdentity(message);
      this.persist();
      return requestSnapshot(active);
    }
    return undefined;
  }

  onMessageEnd(message: any): void {
    if (message?.role === "assistant") {
      this.captureResponseIdentity(message);
      this.persist();
    }
  }

  onContext(messages: any[]): ContextInjectionResult {
    const active = this.activeRequest() || this.primaryRequest();
    if (!active) {
      const llmRequest = createUnboundLlmRequest(() => this.createId("llm"));
      this.latestLlmRequest = llmRequest;
      return { messages, llmRequest, injected: false };
    }

    const llmRequest = createBoundLlmRequest(active, () => this.createId("llm"));
    this.latestLlmRequest = llmRequest;

    const restoringPrimary = active.kind === "primary" && this.restorationPending;
    if (active.kind !== "sidecar" && active.kind !== "batch" && !restoringPrimary) {
      return { messages, llmRequest, injected: false };
    }
    const guidance = buildSidecarContextGuidance(active, llmRequest, restoringPrimary);
    this.restorationPending = false;
    this.persist();

    return {
      messages: [
        ...messages,
        {
          role: "custom",
          customType: "canvast-request-orchestration",
          content: guidance,
          display: false,
          details: llmRequest,
          timestamp: Date.now(),
        },
      ],
      llmRequest,
      injected: true,
    };
  }

  onTurnEnd(message: any, now = this.now()): TurnCompletionResult {
    const empty: TurnCompletionResult = {
      completedSidecarRequestIds: [],
      completedDecisions: [],
      restoredPrimary: false,
    };
    const active = this.activeRequest();
    if (!active) return empty;

    if (active.kind === "batch") {
      if (!active.batch?.committedAt || sidecarAssistantNeedsAnotherTurn(message)) return empty;
      active.phase = "completed";
      active.completedAt = now;
      const parent = this.request(active.parentRequestId);
      this.activeRequestId = parent?.requestId || this.primaryRequestId || active.requestId;
      this.persist();
      return empty;
    }

    if (active.kind === "primary") {
      this.primaryNeedsExecution = sidecarAssistantNeedsAnotherTurn(message) ||
        sidecarDecisionHasRunnableWork(active.controller.decision);
      active.phase = this.primaryNeedsExecution ? "active" : "completed";
      if (!this.primaryNeedsExecution) active.completedAt = now;
      this.persist();
      return !this.primaryNeedsExecution && active.controller.decision
        ? { ...empty, completedDecisions: [sidecarCompletionProjection(active.controller.decision)] }
        : empty;
    }

    if (!sidecarVisibleReplyCanSettle(message, active.controller.decision, active.dispatch)) return empty;
    const completedDecisions: RecordedOrchestrationDecision[] = [];

    active.phase = "completed";
    active.completedAt = now;
    if (active.dispatch?.executionState === "recorded") {
      active.dispatch.executionState = active.dispatch.decision.tool === "none" ? "completed" : "failed";
      active.dispatch.updatedAt = now;
      active.dispatch.settledAt = now;
      active.dispatch.failureCode = active.dispatch.decision.tool === "none"
        ? undefined
        : "tool_not_executed";
      this.emitDispatchUpdate(active.dispatch);
    }
    this.removeOpenSidecar(active.requestId);
    if (active.controller.decision && active.dispatch?.executionState !== "failed") {
      completedDecisions.push(sidecarCompletionProjection(active.controller.decision));
    }
    const completedSidecarRequestIds = [active.requestId];

    const nextSidecar = this.nextOpenSidecar();
    if (nextSidecar) {
      nextSidecar.phase = "active";
      this.activeRequestId = nextSidecar.requestId;
      this.restorationPending = false;
      this.persist();
      return { completedSidecarRequestIds, completedDecisions, restoredPrimary: false };
    }

    const primary = this.primaryRequest();
    if (primary && this.primaryNeedsExecution && primary.phase !== "completed") {
      primary.phase = "active";
      this.activeRequestId = primary.requestId;
      this.restorationPending = true;
      this.persist();
      return {
        completedSidecarRequestIds,
        completedDecisions,
        restoredPrimary: true,
        primaryDecision: primary.controller.decision,
      };
    }

    if (primary) {
      primary.phase = primary.phase === "completed" || this.primaryNeedsExecution ? primary.phase : "completed";
      if (primary.phase === "completed" && !primary.completedAt) primary.completedAt = now;
      this.activeRequestId = primary.requestId;
    } else {
      this.activeRequestId = active.requestId;
    }
    this.persist();
    return { completedSidecarRequestIds, completedDecisions, restoredPrimary: false };
  }

  snapshot(): SidecarOrchestrationSnapshot {
    return {
      primaryRequest: requestSnapshot(this.primaryRequest()),
      activeRequest: requestSnapshot(this.activeRequest()),
      requests: Array.from(this.requests.values()).map(request => requestSnapshot(request)!),
      primaryNeedsExecution: this.primaryNeedsExecution,
      restorationPending: this.restorationPending,
      latestLlmRequest: this.latestLlmRequest ? { ...this.latestLlmRequest } : undefined,
    };
  }

  private captureResponseIdentity(message: any): void {
    if (!this.latestLlmRequest) return;
    this.latestLlmRequest = {
      ...this.latestLlmRequest,
      ...sidecarResponseIdentity(message),
    };
  }
}

export function createSidecarOrchestrationController(
  options: SidecarOrchestrationOptions = {},
): SidecarOrchestrationController {
  return new SidecarOrchestrationController(options);
}

export { registerSidecarOrchestrationHooks } from "./sidecar-orchestration-context.js";
