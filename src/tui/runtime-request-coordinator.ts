/**
 * =============================================================================
 * Canvast — Runtime Request Coordinator / Canvast source file
 * =============================================================================
 * @file        src/tui/runtime-request-coordinator.ts
 * @brief       Connects Pi message delivery to durable Canvast request state.
 * @description Routes concurrent interactive input as native follow-up work,
 *              correlates visible answers, and coordinates compaction resume.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  captureRuntimeContinuityCheckpoint,
  contextContinuityEventId,
  dispatchContextContinuity,
  readContextContinuity,
  type ContextSessionStartReason,
} from "../harness/context-continuity.js";
import {
  claimRuntimeResumeCandidate,
  inspectRuntimeResume,
  reconcileRuntimeResume,
  releaseRuntimeResumeCandidateClaim,
  retireRuntimeResumeCandidate,
  stableRuntimeResumeProjectId,
} from "../harness/runtime-resume.js";
import {
  markRuntimeInputAnswered,
  markRuntimeInputDelivered,
  markRuntimeRequestAsAnswered,
  markRuntimeRequestAsAnswering,
  readRuntimeStatus,
  recordRuntimeEvent,
  recordRuntimeRequest,
  retireRuntimeSessionItems,
  settleRuntimeRootExecution,
  startRuntimeRootExecution,
  transitionRuntimeRequest,
  updateRuntimeContinuity,
  updateRuntimeResumeProjection,
  upsertRuntimeStatusItem,
  type RecordedOrchestrationDecision,
  type RuntimeRequestKind,
} from "../harness/runtime-status.js";
import {
  routeIncomingRuntimeRequest,
  runtimeRequestControlFromEvent,
  type RuntimeRequestControlPolicy,
} from "./runtime-current-request.js";
import {
  completeSoleResumeCandidate,
  completedContinuationDispatchIds,
  continuationDispatchId,
  isFinalVisibleAssistant,
  isOpenRequestStatus,
  lifecycleEventSummary,
  lifecycleEventTitle,
  messageText,
  requestKind,
  restoreLegacyRuntimeContinuity,
  restoredResumeBinding,
  sessionId,
  shouldPreserveResumeRevisionOnStartup,
  shouldContinuePrimary,
  resolveOptionalFailedToolRuns,
  runtimeSettlementRequestId,
  stableProjectId,
} from "./runtime-request-coordinator-support.js";
import { resolveRuntimeRequestDeliveryScope } from "./runtime-request-delivery-scope.js";
import { RuntimeResumeClaimError } from "./runtime-request-coordinator-errors.js";
import { preserveIncompleteProjectDelivery } from "../harness/project-delivery-closure.js";
import { ReevaluateCheckpoint } from "../harness/context-continuity/runtime-queue.js";
import { RuntimeBatchDeliveryCoordinator } from "./runtime-request-coordinator/batch-delivery.js"; import { RuntimeBatchExecutionCoordinator } from "./runtime-request-coordinator/batch-execution.js";
import { RuntimeInputDeliveryStore } from "./runtime-request-coordinator/input-delivery.js";
import {
  consumePendingDelivery, exactQueuedInput, prunePendingDeliveries, removePendingDelivery,
} from "./runtime-request-coordinator/pending-delivery.js";
import { runtimeRunEndedIncomplete } from "./runtime-request-coordinator/run-state.js";
import { failedRuntimeSettlement, RuntimeTerminalOutcomeLatch, type RuntimeToolExecutionEndEvidence } from "./runtime-terminal-outcome.js";
import type {
  PendingDelivery,
  ResumeBinding,
  ResumeDispatchResult,
  RuntimeBatchReceipt,
  RuntimeInputBinding,
  RuntimeInputTransform,
  RuntimeRequestCoordinatorOptions,
} from "./runtime-request-coordinator/types.js";
export { RuntimeResumeClaimError } from "./runtime-request-coordinator-errors.js";
export type {
  RuntimeBatchReceipt,
  RuntimeInputBinding,
  RuntimeInputTransform,
  RuntimeRequestCoordinatorOptions,
} from "./runtime-request-coordinator/types.js";

export class RuntimeRequestCoordinator {
  private readonly pendingDeliveries: PendingDelivery[] = [];
  private activeResponseRequestId: string | undefined;
  private primaryRequestId: string | undefined;
  private lastAnsweredSidecarId: string | undefined;
  private currentTurnId: string | undefined;
  private lastRunIncomplete = false;
  private restoredRecoveryPending = false;
  private readonly activeContinuationDispatchIds = new Set<string>(); private readonly admittedContinuationDispatchIds = new Set<string>();
  private activeResume: ResumeBinding | undefined;
  private settlingResponseRequestId: string | undefined;
  private nativeDeliveryBinding: RuntimeInputBinding | undefined;
  private readonly deliveryStore: RuntimeInputDeliveryStore; private readonly batchDelivery: RuntimeBatchDeliveryCoordinator;
  private readonly batchExecution: RuntimeBatchExecutionCoordinator; private readonly terminalOutcome = new RuntimeTerminalOutcomeLatch();

  constructor(private readonly pi: ExtensionAPI, private readonly options: RuntimeRequestCoordinatorOptions) {
    this.deliveryStore = new RuntimeInputDeliveryStore(options.agentDir, options.projectId); this.batchExecution = new RuntimeBatchExecutionCoordinator(pi, options.agentDir);
    this.batchDelivery = new RuntimeBatchDeliveryCoordinator(pi, options.agentDir, receipt => {
      if (receipt.type === "canvast.runtime-batch-visible-reply/v1") {
        prunePendingDeliveries(this.pendingDeliveries, new Set(receipt.items.map(item => item.id)));
        this.lastRunIncomplete = false;
      }
      options.onBatchReceipt?.(receipt);
    }, this.batchExecution);
  }

  private transitionContinuation(event: Parameters<typeof dispatchContextContinuity>[1]): void {
    const transition = dispatchContextContinuity(this.dir(), event);
    updateRuntimeContinuity(this.dir(), transition.state);
  }

  private consumeContinuation(dispatchId: string, timestamp: string): void {
    const beforeConsume = readContextContinuity(this.dir());
    const item = beforeConsume.continuationOutbox.find(candidate => candidate.id === dispatchId);
    if (!item) return;
    this.transitionContinuation({
      type: "continuation_consumed",
      eventId: contextContinuityEventId("continuation_consumed", [dispatchId]),
      timestamp, dispatchId,
    });
    const turn = readContextContinuity(this.dir()).activeTurn;
    if (item.kind === "compaction" && turn?.phase === "awaiting_resume") {
      const transition = dispatchContextContinuity(this.dir(), {
        type: "turn_resumed",
        eventId: contextContinuityEventId("turn_resumed", [turn.turnId, "harness_retry", dispatchId]),
        timestamp,
        turnId: turn.turnId,
        cause: "harness_retry",
      });
      updateRuntimeContinuity(this.dir(), transition.state);
    }
  }

  private dispatchPendingContinuations(): boolean {
    const pending = readContextContinuity(this.dir()).continuationOutbox.filter(item =>
      item.status === "pending",
    );
    let attempted = false;
    for (const item of pending) {
      if (readContextContinuity(this.dir()).continuationInbox.some(receipt =>
        receipt.id === item.id && receipt.status === "consumed",
      )) {
        continue;
      }
      const startedAt = new Date().toISOString();
      this.transitionContinuation({
        type: "continuation_dispatch_started",
        eventId: contextContinuityEventId("continuation_dispatch_started", [item.id, String(item.attempts + 1)]),
        timestamp: startedAt, dispatchId: item.id,
      });
      try {
        const compaction = item.kind === "compaction";
        this.pi.sendMessage({
          customType: compaction ? "canvast-compaction-continuation" : "canvast-continuation",
          content: compaction
            ? "Resume the same active request after context compaction from its persisted task tree. Continue only unfinished steps, preserve completed side effects, and do not repeat completed work."
            : "Resume the active primary plan from its persisted task tree. Continue only unfinished steps, preserve completed side effects, and do not repeat the answered sidecar request.",
          display: false,
          details: compaction
            ? { requestId: item.requestId, operationId: item.operationId, dispatchId: item.id }
            : { primaryRequestId: item.requestId, afterSidecarRequestId: item.afterRequestId, dispatchId: item.id },
        }, { triggerTurn: true, deliverAs: "followUp" });
        // ExtensionAPI.sendMessage() returns void. Reaching here proves only
        // that enqueue was attempted; actual receipt is confirmed from the
        // custom message observed by message_start/context.
        attempted = true;
      } catch (error) {
        this.transitionContinuation({
          type: "continuation_dispatch_failed",
          eventId: contextContinuityEventId("continuation_dispatch_failed", [item.id, String(item.attempts + 1)]),
          timestamp: new Date().toISOString(), dispatchId: item.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return attempted;
  }

  private dir(): string {
    return this.options.agentDir();
  }

  private newRequestId(kind: RuntimeRequestKind): string {
    return `${kind}-${randomUUID()}`;
  }

  private recordQueuedRequest(
    policy: RuntimeRequestControlPolicy,
    text: string,
    images: unknown,
    source: string,
    affectsActiveWork: boolean,
    deliveryMode: "followUp" | "steer",
    ctx?: unknown,
  ): RuntimeInputBinding {
    const requestId = this.newRequestId(requestKind(policy));
    return this.deliveryStore.record({
      requestId,
      policy,
      text,
      images,
      source,
      affectsActiveWork,
      deliveryMode,
      parentRequestId: this.primaryRequestId,
      context: ctx,
    });
  }

  private failPendingDelivery(binding: RuntimeInputBinding, failureReason: string): void {
    removePendingDelivery(this.pendingDeliveries, binding.id);
    this.deliveryStore.fail(binding, failureReason);
  }

  private resetLiveSessionHandles(): void {
    this.pendingDeliveries.length = 0;
    this.activeResponseRequestId = undefined;
    this.primaryRequestId = undefined;
    this.lastAnsweredSidecarId = undefined;
    this.currentTurnId = undefined;
    this.activeResume = undefined;
    this.lastRunIncomplete = false;
    this.restoredRecoveryPending = false;
    this.activeContinuationDispatchIds.clear();
    this.admittedContinuationDispatchIds.clear();
    this.settlingResponseRequestId = undefined;
    this.nativeDeliveryBinding = undefined;
    this.terminalOutcome.reset();
    this.batchDelivery.reset(); this.batchExecution.reset();
  }

  private resumeSnapshot() {
    return inspectRuntimeResume(this.dir()).snapshot;
  }

  private selectedOrOnlyReadyResumeCandidate(snapshot = this.resumeSnapshot()) {
    if (snapshot.selectedCandidateId) {
      return snapshot.candidates.find(candidate =>
        candidate.id === snapshot.selectedCandidateId &&
        candidate.validation.availability === "ready" &&
        candidate.disposition !== "retired" &&
        candidate.disposition !== "completed",
      );
    }
    if (snapshot.readyCandidateCount !== 1) return undefined;
    return snapshot.candidates.find(candidate =>
      candidate.validation.availability === "ready" &&
      candidate.disposition !== "retired" &&
      candidate.disposition !== "completed",
    );
  }

  private reconcileResumeState(): void {
    reconcileRuntimeResume(this.dir(), {
      projectId: stableRuntimeResumeProjectId(this.options.projectId?.()),
      timestamp: new Date().toISOString(),
    });
    updateRuntimeResumeProjection(this.dir());
  }

  private resumeDispatchId(candidateId: string): string {
    return `resume-continuation-${candidateId}`;
  }

  private queueResumeContinuation(candidateId: string, requestId: string, claimToken: string): { dispatched: boolean; dispatchId: string } {
    const dispatchId = this.resumeDispatchId(candidateId);
    const continuity = readContextContinuity(this.dir());
    const existing = continuity.continuationOutbox.find(item => item.id === dispatchId);
    if (!existing) {
      this.transitionContinuation({
        type: "continuation_queued",
        eventId: contextContinuityEventId("continuation_queued", [dispatchId]),
        timestamp: new Date().toISOString(),
        dispatchId,
        kind: "sidecar",
        requestId,
        afterRequestId: claimToken,
      });
    }
    return { dispatched: this.dispatchPendingContinuations(), dispatchId };
  }

  private continuationReceiptState(dispatchId: string): "missing" | "claimed" | "consumed" {
    const receipt = readContextContinuity(this.dir()).continuationInbox.find(item => item.id === dispatchId);
    if (!receipt) return "missing";
    return receipt.status === "consumed" ? "consumed" : "claimed";
  }

  getContinuationReceiptState(dispatchId: string): "missing" | "claimed" | "consumed" {
    return this.continuationReceiptState(dispatchId);
  }

  inspectResumeState(input: { candidateId?: string } = {}) {
    return inspectRuntimeResume(
      this.dir(),
      input.candidateId ? { candidateId: input.candidateId } : undefined,
    );
  }

  claimAndDispatchResume(
    ctx: any, candidateId: string | undefined, input: { expectedRevision: number },
  ): ResumeDispatchResult | undefined {
    const snapshot = this.resumeSnapshot();
    const candidate = candidateId
      ? snapshot.candidates.find(item => item.id === candidateId)
      : this.selectedOrOnlyReadyResumeCandidate(snapshot);
    if (!candidate) return undefined;
    const claimToken = `resume-${sessionId(ctx)}-${candidate.id}`;
    const transition = claimRuntimeResumeCandidate(this.dir(), {
      candidateId: candidate.id,
      claimToken,
      sessionId: sessionId(ctx),
      expectedRevision: input.expectedRevision,
      eventId: `runtime-resume-claim:${claimToken}`,
      timestamp: new Date().toISOString(),
    });
    updateRuntimeResumeProjection(this.dir());
    if (transition.unsupported?.reason === "stale_revision") {
      throw new RuntimeResumeClaimError(
        "stale_revision", transition.unsupported.message, transition.unsupported.details,
      );
    }
    if (transition.unsupported) return undefined;
    const requestId = transition.candidate?.requestId || candidate.requestId;
    const queued = this.queueResumeContinuation(candidate.id, requestId, claimToken);
    const claimedFreshly = !transition.duplicate &&
      transition.candidate?.claim?.claimToken === claimToken &&
      transition.candidate?.claim?.state === "active";
    if (!queued.dispatched) {
      if (claimedFreshly) {
        releaseRuntimeResumeCandidateClaim(this.dir(), {
          candidateId: candidate.id,
          claimToken,
          sessionId: sessionId(ctx),
          eventId: `runtime-resume-claim-release:${claimToken}`,
          timestamp: new Date().toISOString(),
        });
        updateRuntimeResumeProjection(this.dir());
      }
      return undefined;
    }
    const priorTurnId = this.currentTurnId;
    const priorPrimaryRequestId = this.primaryRequestId;
    const priorActiveResponseRequestId = this.activeResponseRequestId;
    const priorActiveResume = this.activeResume;
    const resumedTurnId = transition.candidate?.turnId || this.currentTurnId;
    this.activeResume = { candidateId: candidate.id, claimToken };
    this.primaryRequestId = requestId;
    this.activeResponseRequestId = requestId;
    this.currentTurnId = resumedTurnId;
    return {
      claimToken,
      candidateId: candidate.id,
      requestId,
      dispatched: true,
      dispatchId: queued.dispatchId,
      revert: () => {
        releaseRuntimeResumeCandidateClaim(this.dir(), {
          candidateId: candidate.id,
          claimToken,
          sessionId: sessionId(ctx),
          eventId: `runtime-resume-claim-release:${claimToken}`,
          timestamp: new Date().toISOString(),
        });
        updateRuntimeResumeProjection(this.dir());
        if (this.activeResume?.claimToken === claimToken) this.activeResume = priorActiveResume;
        if (this.primaryRequestId === requestId) this.primaryRequestId = priorPrimaryRequestId;
        if (this.activeResponseRequestId === requestId) this.activeResponseRequestId = priorActiveResponseRequestId;
        if (this.currentTurnId === resumedTurnId) this.currentTurnId = priorTurnId;
      },
    };
  }

  /** Deliver an explicitly typed request from a trusted command/control surface. */
  async dispatchControlledRequest(policy: RuntimeRequestControlPolicy, text: string): Promise<string> {
    const controlledText = text.trim();
    if (!controlledText) throw new Error("Controlled request text must not be empty.");

    const affectsActiveWork = policy === "pause" || policy === "redirect" || policy === "task_adjustment";
    const deliveryMode = affectsActiveWork ? "steer" : "followUp";
    const binding = this.recordQueuedRequest(
      policy, controlledText, undefined, "canvast-request-control", affectsActiveWork, deliveryMode,
    );
    this.pendingDeliveries.push({ binding });
    try {
      await this.pi.sendUserMessage(controlledText, { deliverAs: deliveryMode, expandPromptTemplates: false });
    } catch (error) {
      this.failPendingDelivery(
        binding,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
    return binding.requestId;
  }

  async handleInput(
    event: any,
    ctx: any,
    transformed: RuntimeInputTransform,
  ): Promise<RuntimeInputTransform | { action: "handled" }> {
    const rawText = String(event?.text || "");
    if (!rawText.trim() || rawText.trimStart().startsWith("/")) return transformed;

    if (event?.source === "extension") {
      return transformed;
    }

    const routing = routeIncomingRuntimeRequest(this.dir(), rawText, runtimeRequestControlFromEvent(event));
    if (routing.queuePolicy === "none") return transformed;

    const outputText = transformed.action === "transform" ? String(transformed.text || rawText) : rawText;
    const outputImages = transformed.action === "transform" ? transformed.images : event?.images;
    const deliveryMode = !routing.affectsActiveWork ? "followUp" : "steer";
    const binding = this.recordQueuedRequest(
      routing.queuePolicy, outputText, outputImages, String(event?.source || "interactive"),
      routing.affectsActiveWork, deliveryMode, ctx,
    );
    this.pendingDeliveries.push({ binding });

    if (event?.streamingBehavior) {
      return { action: "handled" };
    }
    return transformed;
  }

  beginRequest(prompt: string, ctx: any): { requestId: string; replaceCurrent: boolean } {
    this.terminalOutcome.reset();
    this.reconcileResumeState();
    const queued = consumePendingDelivery(this.options.agentDir, this.pendingDeliveries);
    this.nativeDeliveryBinding = queued ? {
      id: queued.id, requestId: queued.requestId!, sequence: queued.sequence, timestamp: queued.timestamp,
    } : undefined;
    const requestId = queued?.requestId || this.newRequestId(queued ? requestKind(queued.policy) : "primary");
    const kind = queued ? requestKind(queued.policy) : "primary";
    const replaceCurrent = queued ? kind === "primary" || queued.affectsActiveWork : true;
    const deliveryScope = this.options.resolveDeliveryScope?.({ prompt, ctx, queued: Boolean(queued) }) ||
      resolveRuntimeRequestDeliveryScope(ctx);
    recordRuntimeRequest(this.dir(), {
      requestId,
      parentRequestId: kind === "primary" ? undefined : this.primaryRequestId,
      kind,
      textSummary: prompt,
      deliveryScope,
      status: "queued",
      deliveryMode: queued?.deliveryMode || "direct",
    });
    if (replaceCurrent) {
      this.primaryRequestId = requestId;
      this.currentTurnId = `turn-${requestId}`;
      const now = new Date().toISOString();
      const snapshot = readRuntimeStatus(this.dir());
      const transition = dispatchContextContinuity(this.dir(), {
        type: "turn_started",
        eventId: contextContinuityEventId("turn_started", [sessionId(ctx), requestId]),
        timestamp: now,
        projectId: stableProjectId(this.dir(), this.options.projectId?.()),
        sessionId: sessionId(ctx),
        turnId: this.currentTurnId,
        requestId,
        checkpoint: captureRuntimeContinuityCheckpoint(snapshot),
      });
      updateRuntimeContinuity(this.dir(), transition.state);
      startRuntimeRootExecution(this.dir(), { requestId, sessionId: sessionId(ctx), timestamp: now });
    }
    this.activeResponseRequestId = requestId;
    return { requestId, replaceCurrent };
  }

  onToolExecutionEnd(event: RuntimeToolExecutionEndEvidence): void { this.terminalOutcome.observe(event); }
  onMessageStart(message: any): void {
    const dispatchId = continuationDispatchId(message);
    if (dispatchId) {
      if (!readContextContinuity(this.dir()).continuationOutbox.some(item => item.id === dispatchId)) return;
      this.transitionContinuation({
        type: "continuation_received",
        eventId: contextContinuityEventId("continuation_received", [
          dispatchId, String(readContextContinuity(this.dir()).continuationInbox.find(item => item.id === dispatchId)?.receiveCount || 0),
        ]),
        timestamp: new Date().toISOString(),
        dispatchId,
      });
      this.activeContinuationDispatchIds.add(dispatchId);
      return;
    }
    if (message?.role === "custom") {
      if (this.batchExecution.onMessageStart(message)) return;
      if (this.batchDelivery.onMessageStart(message)) {
        const ids = new Set<string>((message?.details?.items || []).map((item: any) => String(item?.id || "")));
        prunePendingDeliveries(this.pendingDeliveries, ids);
      }
      return;
    }
    if (message?.role === "user") {
      const queued = exactQueuedInput(this.options.agentDir, this.nativeDeliveryBinding) ||
        consumePendingDelivery(this.options.agentDir, this.pendingDeliveries);
      this.nativeDeliveryBinding = undefined;
      if (queued?.requestId) {
        this.activeResponseRequestId = queued.requestId;
        markRuntimeInputDelivered(this.dir(), { requestId: queued.requestId, deliveryMode: queued.deliveryMode || "followUp" });
      } else if (this.primaryRequestId) {
        this.activeResponseRequestId = this.primaryRequestId;
        transitionRuntimeRequest(this.dir(), { requestId: this.primaryRequestId, status: "delivered", deliveryMode: "direct" });
      }
      return;
    }
    if (message?.role === "assistant" && (this.batchExecution.onAssistantStart() || this.batchDelivery.onAssistantStart())) return;
    if (message?.role === "assistant" && this.activeResponseRequestId) {
      markRuntimeRequestAsAnswering(this.dir(), { requestId: this.activeResponseRequestId });
      const record = readRuntimeStatus(this.dir()).requests.find(item => item.requestId === this.activeResponseRequestId);
      if (record?.kind === "sidecar" || record?.kind === "status") {
        recordRuntimeEvent(this.dir(), {
          id: `request-answering-${record.requestId}`,
          kind: "request_answering",
          title: lifecycleEventTitle(record.kind, "answering"),
          summary: lifecycleEventSummary(record),
          source: "message_start",
        });
      }
    }
  }

  onMessageEnd(message: any): void {
    if (!isFinalVisibleAssistant(message)) return;
    const text = messageText(message);
    if (this.batchExecution.onFinalVisibleReply(text) || this.batchDelivery.onFinalVisibleReply(text)) return;
    if (!this.activeResponseRequestId) return;
    const requestId = this.activeResponseRequestId;
    const record = readRuntimeStatus(this.dir()).requests.find(item => item.requestId === requestId);
    markRuntimeRequestAsAnswered(this.dir(), { requestId, visibleText: text });
    markRuntimeInputAnswered(this.dir(), { requestId, visibleText: text });
    this.lastRunIncomplete = false;
    if (record?.kind === "sidecar" || record?.kind === "status") {
      this.lastAnsweredSidecarId = requestId;
      recordRuntimeEvent(this.dir(), {
        id: `request-visible-reply-${record.requestId}`,
        kind: "request_visible_reply",
        title: lifecycleEventTitle(record.kind, "visible_reply"),
        summary: lifecycleEventSummary(record),
        source: "message_end",
      });
    }
  }

  onContext(messages: any[]): any[] {
    const continuity = readContextContinuity(this.dir());
    const seen = new Set<string>();
    const accepted: string[] = [];
    const filtered = this.batchExecution.onContext(messages).filter(message => {
      const dispatchId = continuationDispatchId(message);
      if (!dispatchId) return true;
      const outbox = continuity.continuationOutbox.find(item => item.id === dispatchId);
      const receipt = continuity.continuationInbox.find(item => item.id === dispatchId);
      if (!outbox || receipt?.status === "consumed" || seen.has(dispatchId) ||
          this.admittedContinuationDispatchIds.has(dispatchId) ||
          (receipt?.status === "claimed" && !this.activeContinuationDispatchIds.has(dispatchId))) return false;
      seen.add(dispatchId);
      accepted.push(dispatchId);
      return true;
    });
    for (const dispatchId of accepted) {
      this.activeContinuationDispatchIds.add(dispatchId);
      this.admittedContinuationDispatchIds.add(dispatchId);
    }
    return filtered;
  }

  applyBatchDecision(decision: RecordedOrchestrationDecision): void {
    this.batchDelivery.applyDecision(decision);
  }

  onSafeCheckpoint(checkpoint: ReevaluateCheckpoint): boolean {
    return this.batchDelivery.safeCheckpoint(checkpoint);
  }

  onTurnStart(): void {
    const continuity = readContextContinuity(this.dir());
    const turn = continuity.activeTurn;
    const latestCompaction = continuity.compactions.at(-1);
    const nativeRetry = (
      turn?.phase === "awaiting_resume" && latestCompaction?.owner === "native_runtime"
    ) || (
      turn?.phase === "recoverable_failure" && latestCompaction?.status === "failed" &&
      latestCompaction.retryable === true && !this.restoredRecoveryPending
    );
    const restoredRecovery = turn?.phase === "recoverable_failure" && this.restoredRecoveryPending;
    if (!turn || (!nativeRetry && !restoredRecovery)) return;
    const now = new Date().toISOString();
    const resumeCause = restoredRecovery
      ? "session_restore"
      : "native_retry";
    const transition = dispatchContextContinuity(this.dir(), {
      type: "turn_resumed",
      eventId: contextContinuityEventId("turn_resumed", [turn.turnId, resumeCause, String(turn.resumeCount + 1)]),
      timestamp: now,
      turnId: turn.turnId,
      cause: resumeCause,
    });
    updateRuntimeContinuity(this.dir(), transition.state);
    if (!restoredRecovery) return;

    const snapshot = readRuntimeStatus(this.dir());
    const request = snapshot.requests.find(item => item.requestId === turn.requestId);
    if (request?.status === "failed" || request?.status === "interrupted") {
      transitionRuntimeRequest(this.dir(), { requestId: turn.requestId, status: "queued" });
    }
    const task = snapshot.tasks.find(item => item.id === "current-user-request");
    if (task?.status === "failed" || task?.status === "aborted" || task?.status === "stale") {
      upsertRuntimeStatusItem(this.dir(), {
        plane: "tasks",
        item: {
          id: task.id,
          title: task.title,
          status: "in_progress",
          summary: task.summary,
          startedAt: task.startedAt,
        },
      });
    }
    this.activeResponseRequestId = turn.requestId;
    this.primaryRequestId = turn.requestId;
    this.currentTurnId = turn.turnId;
    this.activeResume = restoredResumeBinding(this.resumeSnapshot(), turn.requestId, turn.turnId);
    this.lastRunIncomplete = false;
    this.restoredRecoveryPending = false;
  }

  onSessionStart(event: any, ctx: any): { retired: boolean } {
    restoreLegacyRuntimeContinuity(
      this.dir(), stableProjectId(this.dir(), this.options.projectId?.()),
    );
    const reason = String(event?.reason || "startup") as ContextSessionStartReason;
    const id = sessionId(ctx);
    const priorContinuity = readContextContinuity(this.dir());
    const preserveResumeRevision = shouldPreserveResumeRevisionOnStartup(
      reason, id, priorContinuity, this.resumeSnapshot(),
    );
    if (!preserveResumeRevision) this.reconcileResumeState();
    const now = new Date().toISOString();
    const transition = dispatchContextContinuity(this.dir(), {
      type: "session_started",
      eventId: contextContinuityEventId("session_started", [id, reason, String(event?.previousSessionFile || "")]),
      timestamp: now,
      sessionId: id,
      reason,
    });
    updateRuntimeContinuity(this.dir(), transition.state);
    const retired = transition.signals.some(item => item.kind === "retire_session_runtime");
    const forked = transition.signals.some(item => item.kind === "fork_from_checkpoint");
    const restored = transition.signals.some(item => item.kind === "restore_session_runtime");
    if (restored && transition.state.activeTurn) {
      const completedDispatchIds = completedContinuationDispatchIds(
        typeof ctx?.sessionManager?.getBranch === "function" ? ctx.sessionManager.getBranch() : [],
      );
      for (const item of transition.state.continuationOutbox.filter(candidate => candidate.status === "attempted")) {
        const now = new Date().toISOString();
        if (completedDispatchIds.has(item.id)) {
          this.transitionContinuation({
            type: "continuation_received",
            eventId: contextContinuityEventId("continuation_received", [item.id, "session-reconcile"]),
            timestamp: now, dispatchId: item.id,
          });
          this.consumeContinuation(item.id, now);
        } else {
          this.transitionContinuation({
            type: "continuation_released",
            eventId: contextContinuityEventId("continuation_released", [item.id, "session-reconcile"]),
            timestamp: now, dispatchId: item.id,
          });
        }
      }
      const turn = transition.state.activeTurn;
      this.primaryRequestId = turn.requestId;
      this.activeResponseRequestId = turn.requestId;
      this.currentTurnId = turn.turnId;
      this.lastRunIncomplete = turn.phase === "recoverable_failure" || turn.phase === "interrupted";
      this.restoredRecoveryPending = turn.phase === "recoverable_failure";
      const runtime = readRuntimeStatus(this.dir());
      const answeredSidecar = [...runtime.requests].reverse().find(item =>
        item.parentRequestId === turn.requestId &&
        (item.kind === "sidecar" || item.kind === "status") &&
        item.status === "answered" && item.hasVisibleReply === true,
      );
      const alreadyQueued = transition.state.continuationOutbox.some(item =>
        item.kind === "sidecar" && item.afterRequestId === answeredSidecar?.requestId,
      );
      if (answeredSidecar && !alreadyQueued && shouldContinuePrimary(runtime, turn.requestId)) {
        const dispatchId = `sidecar-continuation-${answeredSidecar.requestId}`;
        this.transitionContinuation({
          type: "continuation_queued",
          eventId: contextContinuityEventId("continuation_queued", [dispatchId]),
          timestamp: new Date().toISOString(), dispatchId, kind: "sidecar",
          requestId: turn.requestId, afterRequestId: answeredSidecar.requestId,
        });
      }
      this.dispatchPendingContinuations();
    }
    if (retired || forked) {
      const explicitBoundary = reason === "new" || forked;
      const retirementReason = reason === "new" ? "explicit new session"
        : forked ? "forked session runtime retired" : "startup session mismatch";
      retireRuntimeSessionItems(this.dir(), {
        source: "session_start",
        reason: retirementReason,
      });
      if (explicitBoundary) {
        for (const candidate of this.resumeSnapshot().candidates.filter(item =>
          item.disposition !== "retired" && item.disposition !== "completed",
        )) retireRuntimeResumeCandidate(this.dir(), {
          candidateId: candidate.id, reason: retirementReason,
          eventId: `runtime-resume-retire:${reason}:${candidate.id}`, timestamp: now,
        });
        updateRuntimeResumeProjection(this.dir());
      }
      this.resetLiveSessionHandles();
    } else if (restored || reason === "startup") this.batchExecution.recoverPending();
    return { retired };
  }

  resetSession(ctx: any): void {
    this.reconcileResumeState();
    const id = sessionId(ctx);
    const now = new Date().toISOString();
    const transition = dispatchContextContinuity(this.dir(), {
      type: "session_reset",
      eventId: contextContinuityEventId("session_reset", [id, now]),
      timestamp: now,
      sessionId: id,
    });
    updateRuntimeContinuity(this.dir(), transition.state);
    retireRuntimeSessionItems(this.dir(), { source: "command:new", reason: "explicit session reset" });
    for (const candidate of this.resumeSnapshot().candidates.filter(item =>
      item.disposition !== "retired" && item.disposition !== "completed",
    )) {
      retireRuntimeResumeCandidate(this.dir(), {
        candidateId: candidate.id,
        reason: "explicit session reset",
        eventId: `runtime-resume-retire:reset:${candidate.id}`,
        timestamp: now,
      });
    }
    updateRuntimeResumeProjection(this.dir());
    this.resetLiveSessionHandles();
  }

  restartProject(): void {
    const now = new Date().toISOString();
    const projectId = stableProjectId(this.dir(), this.options.projectId?.());
    const transition = dispatchContextContinuity(this.dir(), {
      type: "project_restarted",
      eventId: contextContinuityEventId("project_restarted", [projectId, now]),
      timestamp: now,
      projectId,
    });
    updateRuntimeContinuity(this.dir(), transition.state);
  }

  beforeCompaction(event: any, ctx: any): void {
    const continuity = readContextContinuity(this.dir());
    const turn = continuity.activeTurn;
    if (!turn) return;
    const branchIds = (Array.isArray(event?.branchEntries) ? event.branchEntries : [])
      .map((entry: any) => String(entry?.id || "")).filter(Boolean);
    const firstKeptEntryId = String(event?.preparation?.firstKeptEntryId || "") || undefined;
    const reason = event?.reason === "manual" || event?.reason === "threshold" || event?.reason === "overflow" ? event.reason : "unknown";
    const transition = dispatchContextContinuity(this.dir(), {
      type: "compaction_prepared",
      eventId: contextContinuityEventId("compaction_prepared", [sessionId(ctx), turn.turnId, reason, firstKeptEntryId || "", ...branchIds]),
      timestamp: new Date().toISOString(),
      sessionId: sessionId(ctx),
      turnId: turn.turnId,
      reason,
      willRetry: event?.willRetry === true,
      continuationOwner: event?.willRetry === true ? "native_runtime" : "harness",
      allowHarnessResume: event?.willRetry !== true,
      firstKeptEntryId,
      branchEntryIds: branchIds,
    });
    updateRuntimeContinuity(this.dir(), transition.state);
    if (event?.signal && typeof event.signal.addEventListener === "function") {
      event.signal.addEventListener("abort", () => this.onCompactionEnd({
        aborted: true, willRetry: event?.willRetry === true, errorMessage: "Context compaction was aborted.",
      }), { once: true });
    }
  }

  afterCompaction(event: any): { continuationQueued: boolean } {
    const continuity = readContextContinuity(this.dir());
    const attempt = [...continuity.compactions].reverse().find(item => item.status === "prepared");
    if (!attempt) return { continuationQueued: false };
    const entryId = String(event?.compactionEntry?.id || "") || undefined;
    const transition = dispatchContextContinuity(this.dir(), {
      type: "compaction_succeeded",
      eventId: contextContinuityEventId("compaction_succeeded", [attempt.operationId, entryId || ""]),
      timestamp: new Date().toISOString(),
      operationId: attempt.operationId,
      compactionEntryId: entryId,
    });
    updateRuntimeContinuity(this.dir(), transition.state);
    const continuation = transition.signals.find(signal => signal.kind === "resume_same_turn" && signal.shouldDispatch);
    if (!continuation?.operationId || !continuation.requestId) {
      return { continuationQueued: false };
    }
    const dispatchId = `compaction-continuation-${continuation.operationId}`;
    this.transitionContinuation({
      type: "continuation_queued",
      eventId: contextContinuityEventId("continuation_queued", [dispatchId]),
      timestamp: new Date().toISOString(), dispatchId, kind: "compaction",
      requestId: continuation.requestId, operationId: continuation.operationId,
    });
    return { continuationQueued: this.dispatchPendingContinuations() };
  }

  onCompactionEnd(event: any): void {
    if (event?.aborted !== true && !event?.errorMessage) return;
    const continuity = readContextContinuity(this.dir());
    const attempt = [...continuity.compactions].reverse().find(item => item.status === "prepared");
    if (!attempt) return;
    const transition = dispatchContextContinuity(this.dir(), {
      type: "compaction_failed",
      eventId: contextContinuityEventId("compaction_failed", [attempt.operationId, String(event?.errorMessage || "aborted")]),
      timestamp: new Date().toISOString(), operationId: attempt.operationId,
      error: String(event?.errorMessage || "Context compaction was aborted."), retryable: true,
    });
    updateRuntimeContinuity(this.dir(), transition.state);
  }

  onAgentEnd(event: any, ctx: any): { continuationQueued: boolean; visiblePrimaryReply: boolean } {
    this.settlingResponseRequestId ||= this.activeResponseRequestId;
    const snapshot = readRuntimeStatus(this.dir());
    const primary = this.primaryRequestId ? snapshot.requests.find(item => item.requestId === this.primaryRequestId) : undefined;
    const aborted = runtimeRunEndedIncomplete(event);

    // agent_end precedes Pi's retry/overflow-compaction decision. Defer a
    // terminal failure transition until agent_settled so a native retry can
    // keep the same request identity and legitimately finish it.
    this.lastRunIncomplete = aborted;

    const sidecarId = this.lastAnsweredSidecarId;
    const sidecarDispatchId = sidecarId ? `sidecar-continuation-${sidecarId}` : undefined;
    const alreadyQueued = sidecarDispatchId
      ? readContextContinuity(this.dir()).continuationOutbox.some(item => item.id === sidecarDispatchId)
      : false;
    const shouldResume = Boolean(
      !aborted && sidecarId &&
      !alreadyQueued && !ctx?.hasPendingMessages?.() && shouldContinuePrimary(snapshot, this.primaryRequestId),
    );
    if (shouldResume && sidecarId && this.primaryRequestId) {
      this.activeResponseRequestId = this.primaryRequestId;
      const dispatchId = `sidecar-continuation-${sidecarId}`;
      this.transitionContinuation({
        type: "continuation_queued",
        eventId: contextContinuityEventId("continuation_queued", [dispatchId]),
        timestamp: new Date().toISOString(), dispatchId, kind: "sidecar",
        requestId: this.primaryRequestId, afterRequestId: sidecarId,
      });
      this.dispatchPendingContinuations();
      recordRuntimeEvent(this.dir(), {
        id: `sidecar-resume-${sidecarId}`,
        kind: "request_continuation",
        title: "Primary plan resumed after sidecar",
        summary: `Continuation queued once after ${sidecarId}.`,
        source: "agent_end",
      });
    }
    return { continuationQueued: shouldResume, visiblePrimaryReply: primary?.hasVisibleReply === true };
  }

  onAgentSettled(): void {
    const terminalOutcome = this.terminalOutcome.consume();
    if (!this.primaryRequestId) {
      this.onSafeCheckpoint("on_turn_settle");
      return;
    }
    let snapshot = readRuntimeStatus(this.dir());
    let continuity = readContextContinuity(this.dir());
    const prepared = [...continuity.compactions].reverse().find(item => item.status === "prepared");
    if (prepared) {
      const timestamp = new Date().toISOString();
      const transition = dispatchContextContinuity(this.dir(), {
        type: "compaction_failed",
        eventId: contextContinuityEventId("compaction_failed", [prepared.operationId, "settled-without-commit"]),
        timestamp,
        operationId: prepared.operationId,
        error: "Context compaction ended without a committed compaction record; the request is recoverable.",
        retryable: true,
      });
      updateRuntimeContinuity(this.dir(), transition.state);
      continuity = transition.state;
      snapshot = readRuntimeStatus(this.dir());
    }
    const primary = snapshot.requests.find(item => item.requestId === this.primaryRequestId);
    const task = snapshot.tasks.find(item => item.id === "current-user-request");
    const completedAt = new Date().toISOString();
    const elapsedMs = task?.startedAt ? Math.max(0, Date.parse(completedAt) - Date.parse(task.startedAt)) : undefined;
    const responseRequestId = this.settlingResponseRequestId || this.activeResponseRequestId;
    const settledRequestId = runtimeSettlementRequestId(snapshot, this.primaryRequestId, responseRequestId);
    this.settlingResponseRequestId = undefined;
    const isRootSettlement = Boolean(settledRequestId && settledRequestId === primary?.requestId);
    const localSucceeded = !terminalOutcome && isRootSettlement && !this.lastRunIncomplete &&
      primary?.hasVisibleReply === true && !continuity.recovery;
    const failed = failedRuntimeSettlement(terminalOutcome, this.lastRunIncomplete, continuity.recovery?.message);
    if (localSucceeded) {
      resolveOptionalFailedToolRuns(this.dir(), snapshot, this.primaryRequestId, snapshot.rootExecution.sessionId);
      snapshot = readRuntimeStatus(this.dir());
    }
    if (localSucceeded && primary && preserveIncompleteProjectDelivery({
      agentDir: this.dir(), projectRoot: this.options.projectId?.(), rootRequestId: primary.requestId,
      requestDeliveryScope: primary.deliveryScope,
      sessionId: snapshot.rootExecution.sessionId, currentTask: task,
      existingContinuation: snapshot.tasks.find(item => item.id === "whole-project-delivery-continuation"),
      timestamp: completedAt,
    })) { this.onSafeCheckpoint("on_turn_settle"); this.reconcileResumeState(); return; }
    let settlement = settleRuntimeRootExecution(this.dir(), { requestId: settledRequestId,
      outcome: localSucceeded ? "succeeded" : failed.outcome, timestamp: completedAt });
    if (settledRequestId) this.batchExecution.onCheckpoint("on_turn_settle", settledRequestId);
    if (localSucceeded && completeSoleResumeCandidate(
      this.dir(), settlement, this.activeResume, this.primaryRequestId, completedAt,
    )) {
      this.activeResume = undefined;
      settlement = settleRuntimeRootExecution(this.dir(), {
        requestId: settledRequestId,
        outcome: "succeeded",
        timestamp: completedAt,
      });
    }
    const completed = settlement.rootExecution.state === "done";
    if (!localSucceeded && settledRequestId === primary?.requestId && primary &&
        (primary.status === "queued" || primary.status === "delivered" || primary.status === "answering")) {
      transitionRuntimeRequest(this.dir(), {
        requestId: primary.requestId,
        status: failed.requestStatus, failureReason: failed.failureReason,
      });
    }
    if (completed || (isRootSettlement && !localSucceeded)) {
      upsertRuntimeStatusItem(this.dir(), {
        plane: "tasks",
        item: {
          id: "current-user-request",
          title: task?.title || "Current user request",
          status: completed ? "completed" : failed.taskStatus,
          summary: completed
            ? "Root execution completed after all required runtime work settled."
            : failed.taskSummary,
          startedAt: task?.startedAt,
          completedAt,
          elapsedMs,
        },
      });
    }
    if (completed && this.currentTurnId) {
      const transition = dispatchContextContinuity(this.dir(), {
        type: "turn_completed",
        eventId: contextContinuityEventId("turn_completed", [this.currentTurnId]),
        timestamp: completedAt,
        turnId: this.currentTurnId,
      });
      updateRuntimeContinuity(this.dir(), transition.state);
    }
    this.onSafeCheckpoint("on_turn_settle");
  }

  onContinuationRunEnd(event: any): void {
    this.batchExecution.onRunEnd(runtimeRunEndedIncomplete(event));
    if (this.activeContinuationDispatchIds.size === 0) return;
    const failed = runtimeRunEndedIncomplete(event);
    for (const dispatchId of this.activeContinuationDispatchIds) {
      const now = new Date().toISOString();
      if (failed) {
        this.transitionContinuation({
          type: "continuation_released",
          eventId: contextContinuityEventId("continuation_released", [dispatchId, String(Date.now())]),
          timestamp: now, dispatchId,
        });
        continue;
      }
      this.consumeContinuation(dispatchId, now);
    }
    this.activeContinuationDispatchIds.clear();
    this.admittedContinuationDispatchIds.clear();
  }
}
