/**
 * =============================================================================
 * Canvast — Batch Admission Logic / 批量准入逻辑
 * =============================================================================
 * @file        src/harness/auto-orchestrator/batch-admission.ts
 * @brief       Core logic for atomic batch admission and typed relations.
 * @description Manages queued input transitions, deferral, and anti-starvation.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import { createHash } from "node:crypto";

import type { 
  RuntimeInputQueueItem, 
  RuntimeInputQueueStatus, 
  ReevaluateCheckpoint
} from "../context-continuity/runtime-queue.js";
import {
  createRuntimeBatchPolicyTransition,
  type RuntimeBatchPolicyTransition,
} from "../runtime-batch-policy.js";
import type { 
  RecordedOrchestrationDecision, 
  OrchestrationBatchPlan, 
  OrchestrationBatchItem 
} from "./types.js";

export interface BatchAdmissionResult {
  admittedIds: string[];
  deferredIds: string[];
  acknowledgedIds: string[];
  expiredIds: string[];
  transitions: RuntimeBatchPolicyTransition[];
}

export interface OrchestrationBatchCandidate {
  id: string;
  requestId: string;
  sequence: number;
  timestamp: string;
  status: "queued" | "interrupt" | "deferred";
}

function canonicalCandidate(candidate: OrchestrationBatchCandidate): string {
  return [candidate.id, candidate.requestId, candidate.sequence, candidate.timestamp, candidate.status]
    .map(value => JSON.stringify(value))
    .join("|");
}

export function batchCandidates(
  queue: RuntimeInputQueueItem[],
  checkpoint?: ReevaluateCheckpoint,
): OrchestrationBatchCandidate[] {
  return queue
    .filter(item => {
      if (item.status === "queued" || item.status === "interrupt") return true;
      return item.status === "deferred" && (!checkpoint || item.deferInfo?.reevaluateAt === checkpoint);
    })
    .sort((left, right) => left.sequence - right.sequence || left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id))
    .map(item => ({
      id: item.id,
      requestId: item.requestId || "",
      sequence: item.sequence,
      timestamp: item.timestamp,
      status: item.status as OrchestrationBatchCandidate["status"],
    }));
}

export function batchCandidateHash(candidates: OrchestrationBatchCandidate[]): string {
  return createHash("sha256")
    .update(candidates.map(canonicalCandidate).join("\n"))
    .digest("hex");
}

export class BatchOrchestrator {
  private static readonly STARVATION_THRESHOLD = 5;

  /**
   * Performs atomic batch admission based on a structured orchestration decision.
   * Enforces: revision match, request-binding consistency, no duplicates, and total claim coverage.
   */
  static admitBatch(
    queue: RuntimeInputQueueItem[],
    decision: RecordedOrchestrationDecision,
    inputQueueRevision: number,
    now = new Date().toISOString()
  ): BatchAdmissionResult {
    const batchPlan = decision.batchPlan;
    if (!batchPlan) {
      return { admittedIds: [], deferredIds: [], acknowledgedIds: [], expiredIds: [], transitions: [] };
    }

    // 1. Revision check
    if (batchPlan.revision !== inputQueueRevision) {
      throw new Error(`Batch admission failed: plan revision ${batchPlan.revision} does not match queue revision ${inputQueueRevision}.`);
    }

    // 2. Duplicate ID check in plan
    const planIds = batchPlan.items.map(item => item.id);
    if (new Set(planIds).size !== planIds.length) {
      throw new Error("Batch admission failed: duplicate item IDs found in orchestration plan.");
    }

    // 3. Total claim/coverage: plan must exactly cover all deliverable items in the queue
    const candidates = batchCandidates(queue, batchPlan.checkpoint);
    if (batchCandidateHash(candidates) !== batchPlan.candidateHash) {
      throw new Error("Batch admission failed: candidate manifest hash does not match the queued inputs.");
    }
    const deliverableQueue = candidates.map(candidate =>
      queue.find(item => item.id === candidate.id)!,
    );
    const deliverableIds = new Set(deliverableQueue.map(q => q.id));
    const planIdSet = new Set(planIds);

    if (deliverableIds.size !== planIdSet.size) {
      throw new Error(`Batch admission failed: plan coverage mismatch. Plan has ${planIdSet.size} items, queue has ${deliverableIds.size} deliverable items.`);
    }
    for (const id of planIds) {
      if (!deliverableIds.has(id)) {
        throw new Error(`Batch admission failed: plan item ${id} is not in a deliverable state or missing from queue.`);
      }
    }

    const result: BatchAdmissionResult = {
      admittedIds: [],
      deferredIds: [],
      acknowledgedIds: [],
      expiredIds: [],
      transitions: [],
    };

    // 4. Preserve canonical queue order for processing, but follow plan policies
    const sortedQueue = [...deliverableQueue].sort((a, b) => {
      if (a.sequence !== b.sequence) return a.sequence - b.sequence;
      return Date.parse(a.timestamp) - Date.parse(b.timestamp);
    });

    for (const queueItem of sortedQueue) {
      const planItem = batchPlan.items.find(p => p.id === queueItem.id);
      if (!planItem) continue; // Should not happen due to coverage check

      // 5. Request-binding consistency
      if ((queueItem.requestId || "") !== planItem.requestId) {
        throw new Error(`Batch admission failed: requestId mismatch for ${queueItem.id}. Queue has ${queueItem.requestId}, plan has ${planItem.requestId}.`);
      }
      if (queueItem.sequence !== planItem.sequence) {
        throw new Error(`Batch admission failed: sequence mismatch for ${queueItem.id}.`);
      }
      if (queueItem.timestamp !== planItem.timestamp) {
        throw new Error(`Batch admission failed: timestamp mismatch for ${queueItem.id}.`);
      }
      if (queueItem.status !== planItem.status) {
        throw new Error(`Batch admission failed: status mismatch for ${queueItem.id}.`);
      }

      const transition = createRuntimeBatchPolicyTransition(
        queueItem, planItem, now, this.STARVATION_THRESHOLD,
      );
      result.transitions.push(transition);
      if (transition.to === "admitted") result.admittedIds.push(queueItem.id);
      else if (transition.to === "deferred") result.deferredIds.push(queueItem.id);
      else if (transition.to === "acknowledged") result.acknowledgedIds.push(queueItem.id);
      else if (transition.to === "expired") result.expiredIds.push(queueItem.id);
    }

    return result;
  }

  /**
   * Filters queue items that should be re-evaluated at the given checkpoint.
   */
  static getReevaluationCandidates(
    queue: RuntimeInputQueueItem[],
    checkpoint: ReevaluateCheckpoint
  ): RuntimeInputQueueItem[] {
    return queue.filter(item => 
      item.status === "deferred" && 
      item.deferInfo?.reevaluateAt === checkpoint
    );
  }
}
