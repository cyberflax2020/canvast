/**
 * =============================================================================
 * Canvast — Runtime Batch Delivery / 运行时批量投递
 * =============================================================================
 * @file        src/tui/runtime-request-coordinator/batch-delivery.ts
 * @brief       Sends and receipts exact runtime input batch envelopes once.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { BatchOrchestrator, batchCandidateHash, batchCandidates } from "../../harness/auto-orchestrator/batch-admission.js";
import { clearRuntimeBatchStage, runtimeBatchEventScope } from "../../harness/runtime-batch-bridge.js";
import {
  commitRuntimeBatchTransitions,
  markRuntimeRequestAsAnswered,
  markRuntimeRequestAsAnswering,
  readRuntimeStatus,
  recordRuntimeEvent,
  transitionRuntimeInputQueueItem,
  type RecordedOrchestrationDecision,
} from "../../harness/runtime-status.js";
import type { ReevaluateCheckpoint } from "../../harness/context-continuity/runtime-queue.js";
import { prepareRuntimeBatchDispatch, RUNTIME_BATCH_MESSAGE_TYPE } from "../runtime-batch-coordinator.js";
import type { RuntimeBatchExecutionCoordinator } from "./batch-execution.js";
import type {
  RuntimeBatchDispatchedReceipt,
  RuntimeBatchReceipt,
  RuntimeInputBinding,
} from "./types.js";

function exactBindingsEqual(left: RuntimeInputBinding[], right: RuntimeInputBinding[]): boolean {
  return left.length === right.length && left.every((item, index) =>
    item.id === right[index]?.id && item.requestId === right[index]?.requestId &&
    item.sequence === right[index]?.sequence && item.timestamp === right[index]?.timestamp);
}

function parseBindings(value: unknown): RuntimeInputBinding[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const bindings: RuntimeInputBinding[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;
    const candidate = item as Partial<RuntimeInputBinding>;
    if (typeof candidate.id !== "string" || !candidate.id || ids.has(candidate.id) ||
        typeof candidate.requestId !== "string" || !candidate.requestId ||
        !Number.isSafeInteger(candidate.sequence) || Number(candidate.sequence) < 0 ||
        typeof candidate.timestamp !== "string" || !Number.isFinite(Date.parse(candidate.timestamp))) {
      return undefined;
    }
    ids.add(candidate.id);
    bindings.push({
      id: candidate.id,
      requestId: candidate.requestId,
      sequence: Number(candidate.sequence),
      timestamp: candidate.timestamp,
    });
  }
  return bindings.length > 0 ? bindings : undefined;
}

export class RuntimeBatchDeliveryCoordinator {
  private readonly pending = new Map<string, RuntimeBatchDispatchedReceipt>();
  private active: RuntimeBatchDispatchedReceipt | undefined;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly agentDir: () => string,
    private readonly onReceipt?: (receipt: RuntimeBatchReceipt) => void,
    private readonly execution?: RuntimeBatchExecutionCoordinator,
  ) {}

  reset(): void {
    const scope = runtimeBatchEventScope(this.pi);
    if (scope) for (const batchId of this.pending.keys()) clearRuntimeBatchStage(scope, batchId);
    this.pending.clear();
    this.active = undefined;
  }

  private emit(receipt: RuntimeBatchReceipt): void {
    try {
      this.onReceipt?.(structuredClone(receipt));
    } catch (error) {
      recordRuntimeEvent(this.agentDir(), {
        kind: "input_batch",
        title: "Runtime batch receipt callback failed",
        summary: error instanceof Error ? error.message : String(error),
        source: receipt.type,
      });
    }
  }

  safeCheckpoint(checkpoint: ReevaluateCheckpoint): boolean {
    const scope = runtimeBatchEventScope(this.pi);
    if (!scope) return false;
    const dispatch = prepareRuntimeBatchDispatch(scope, this.agentDir(), checkpoint);
    if (!dispatch) return false;
    const receipt: RuntimeBatchDispatchedReceipt = {
      type: "canvast.runtime-batch-dispatched/v1",
      batchId: dispatch.details.batchId,
      revision: dispatch.details.revision,
      checkpoint: dispatch.details.checkpoint,
      candidateHash: dispatch.details.candidateHash,
      items: dispatch.details.items,
      timestamp: new Date().toISOString(),
    };
    this.pending.set(receipt.batchId, receipt);
    try {
      this.pi.sendMessage({
        customType: dispatch.details.type,
        content: dispatch.content,
        display: false,
        details: dispatch.details,
      }, { triggerTurn: true, deliverAs: "steer" });
      this.emit(receipt);
      return true;
    } catch (error) {
      this.pending.delete(receipt.batchId);
      clearRuntimeBatchStage(scope, receipt.batchId);
      recordRuntimeEvent(this.agentDir(), {
        kind: "input_batch",
        title: "Safe-checkpoint batch dispatch failed",
        summary: error instanceof Error ? error.message : String(error),
        source: checkpoint,
      });
      return false;
    }
  }

  private receiptFromMessage(message: any): RuntimeBatchDispatchedReceipt | undefined {
    if (message?.role !== "custom" || message?.customType !== RUNTIME_BATCH_MESSAGE_TYPE) return undefined;
    const details = message?.details;
    if (!details || details.type !== RUNTIME_BATCH_MESSAGE_TYPE || typeof details.batchId !== "string" ||
        !Number.isSafeInteger(details.revision) || typeof details.candidateHash !== "string" ||
        typeof details.checkpoint !== "string") return undefined;
    const items = parseBindings(details.items);
    if (!items) return undefined;

    const snapshot = readRuntimeStatus(this.agentDir());
    if (snapshot.continuity.inputQueueRevision !== details.revision) return undefined;
    const candidates = batchCandidates(snapshot.inputQueue, details.checkpoint as ReevaluateCheckpoint);
    const expected = candidates.map(item => ({
      id: item.id, requestId: item.requestId, sequence: item.sequence, timestamp: item.timestamp,
    }));
    if (!exactBindingsEqual(items, expected) || batchCandidateHash(candidates) !== details.candidateHash) return undefined;
    const pending = this.pending.get(details.batchId);
    if (pending && (pending.revision !== details.revision || pending.checkpoint !== details.checkpoint ||
        pending.candidateHash !== details.candidateHash || !exactBindingsEqual(pending.items, items))) return undefined;
    return pending || {
      type: "canvast.runtime-batch-dispatched/v1",
      batchId: details.batchId,
      revision: details.revision,
      checkpoint: details.checkpoint as ReevaluateCheckpoint,
      candidateHash: details.candidateHash,
      items,
      timestamp: new Date().toISOString(),
    };
  }

  onMessageStart(message: any): boolean {
    const receipt = this.receiptFromMessage(message);
    if (!receipt) return false;
    this.active = receipt;
    return true;
  }

  onAssistantStart(): boolean {
    if (!this.active) return false;
    const runtime = readRuntimeStatus(this.agentDir());
    const committed = runtime.batchCommits.find(item => item.batchId === this.active!.batchId);
    const scheduledIds = new Set((committed?.receipt.directives || []).filter(directive =>
      directive.schedulingMode === "parallel" || directive.schedulingMode === "serial" ||
      directive.schedulingMode === "deferred",
    ).map(directive => directive.id));
    for (const item of this.active.items.filter(candidate => !scheduledIds.has(candidate.id))) {
      markRuntimeRequestAsAnswering(this.agentDir(), { requestId: item.requestId, deliveryMode: "batch" });
    }
    return true;
  }

  onFinalVisibleReply(visibleText: string): boolean {
    if (!this.active || !visibleText.trim()) return false;
    const receipt = this.active;
    const answeredAt = new Date().toISOString();
    const runtime = readRuntimeStatus(this.agentDir());
    const committed = runtime.batchCommits.find(item => item.batchId === receipt.batchId);
    const plannerOnlyIds = new Set((committed?.receipt.directives || []).filter(directive =>
      directive.schedulingMode === "parallel" || directive.schedulingMode === "serial" ||
      directive.schedulingMode === "deferred",
    ).map(directive => directive.id));
    const answeredItems = receipt.items.filter(item => {
      if (plannerOnlyIds.has(item.id)) return false;
      const queueItem = runtime.inputQueue.find(candidate => candidate.id === item.id);
      return queueItem?.status !== "deferred" && queueItem?.policy !== "parallel_independent" &&
        queueItem?.policy !== "serial_after_current" && queueItem?.policy !== "defer";
    });
    for (const item of answeredItems) {
      const exact = readRuntimeStatus(this.agentDir()).inputQueue.find(candidate =>
        candidate.id === item.id && candidate.requestId === item.requestId &&
        candidate.sequence === item.sequence && candidate.timestamp === item.timestamp);
      if (!exact) continue;
      transitionRuntimeInputQueueItem(this.agentDir(), {
        id: item.id,
        timestamp: answeredAt,
        patch: { status: "answered", answeredAt, hasVisibleReply: true, deliveryMode: "batch" },
      });
      markRuntimeRequestAsAnswered(this.agentDir(), {
        requestId: item.requestId, visibleText, timestamp: answeredAt, deliveryMode: "batch",
      });
    }
    this.emit({
      ...receipt,
      type: "canvast.runtime-batch-visible-reply/v1",
      items: answeredItems, visibleText,
      timestamp: answeredAt,
    });
    this.pending.delete(receipt.batchId);
    const scope = runtimeBatchEventScope(this.pi);
    if (scope) clearRuntimeBatchStage(scope, receipt.batchId);
    this.active = undefined;
    return true;
  }

  applyDecision(decision: RecordedOrchestrationDecision): void {
    const snapshot = readRuntimeStatus(this.agentDir());
    const result = BatchOrchestrator.admitBatch(
      snapshot.inputQueue, decision, snapshot.continuity.inputQueueRevision,
    );
    if (result.transitions.length === 0) return;
    const committed = commitRuntimeBatchTransitions(this.agentDir(), {
      transitions: result.transitions,
      batchId: decision.batchPlan?.batchId,
      expectedQueueRevision: snapshot.continuity.inputQueueRevision,
      expectedItemIds: decision.batchPlan?.items.map(item => item.id),
      expectedManifest: decision.batchPlan?.items.map(item => ({
        id: item.id,
        requestId: item.requestId || undefined,
        sequence: item.sequence,
        timestamp: item.timestamp,
        status: item.status,
      })),
      timestamp: new Date().toISOString(),
    });
    if (!committed.replayed) this.execution?.consumeCommittedReceipt(committed.receipt);
  }
}
