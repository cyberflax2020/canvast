/**
 * =============================================================================
 * Canvast — Runtime Status Operations / Canvast 源文件
 * =============================================================================
 * @file        src/harness/runtime-status-ops.ts
 * @brief       Specialized runtime status operations.
 * @description Part of the Canvast product codebase.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import { createHash } from "node:crypto";
import {
  isRuntimeInputQueuePending,
  pendingRuntimeInputQueueItems,
  type RuntimeInputQueueItem,
  type RuntimeInputQueueStatus,
  type RuntimeRequestRecord,
  type RuntimeRequestStatus,
} from "./context-continuity.js";
import {
  readRuntimeStatus,
  updateRuntimeStatus,
  upsertRuntimeStatusItem,
  type RuntimeStatusSnapshot,
  type RuntimeStatusItem,
} from "./runtime-status.js";
import { emptyRuntimeRootExecution, reduceRuntimeRootExecution } from "./runtime-root-execution.js";
import { isRuntimeItemOpen } from "./runtime-status-render.js";
import type {
  OrchestrationBatchBranchEvidence,
  OrchestrationRuntimeStatusPlane,
  SupersedeMergeEvidence,
  SupersedeMergeItemEvidence,
} from "./auto-orchestrator/types.js";
import {
  assertRuntimeBatchPolicyTransition,
  type RuntimeBatchPolicyTransition,
} from "./runtime-batch-policy.js";
import {
  batchCommitPayloadHash,
  equalRuntimeBatchManifest,
  runtimeBatchInputPayloadDigest,
  sortRuntimeBatchManifest,
  upsertRuntimeBatchCommitRecord,
  type RuntimeBatchTransitionReceipt,
  type RuntimeBatchTransitionManifestItem,
  type RuntimeBatchExecutionDirective,
} from "./runtime-batch-commit.js";

function fingerprint(parts: string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 12);
}

function runtimeExecutionQueueKey(
  binding: { id: string; requestId?: string; sequence: number; timestamp: string },
): string {
  return JSON.stringify([binding.id, binding.requestId, binding.sequence, binding.timestamp]);
}

export interface RuntimeBatchTransition {
  id: string;
  patch: Partial<Omit<RuntimeInputQueueItem, "id" | "timestamp" | "sequence">>;
  from?: RuntimeInputQueueStatus;
  to?: RuntimeInputQueueStatus;
  policyEffect?: RuntimeBatchPolicyTransition["policyEffect"];
}

function isPolicyTransition(transition: RuntimeBatchTransition): transition is RuntimeBatchPolicyTransition {
  return transition.policyEffect !== undefined && transition.from !== undefined && transition.to !== undefined;
}

export interface RuntimeBatchTransitionCommitResult {
  snapshot: RuntimeStatusSnapshot;
  receipt: RuntimeBatchTransitionReceipt;
  replayed: boolean;
}

function normalizeExpectedItemIds(ids: string[] | undefined): string[] | undefined {
  return ids ? [...ids].sort() : undefined;
}

function manifestForTransitions(
  snapshot: RuntimeStatusSnapshot,
  transitions: RuntimeBatchTransition[],
): RuntimeBatchTransitionManifestItem[] {
  return sortRuntimeBatchManifest(transitions
    .map(transition => {
      const item = snapshot.inputQueue.find(candidate => candidate.id === transition.id);
      if (!item) throw new Error(`Batch transition failed: missing required item ID ${transition.id}`);
      return {
        id: item.id,
        requestId: item.requestId,
        sequence: item.sequence,
        timestamp: item.timestamp,
        status: item.status,
        payloadDigest: runtimeBatchInputPayloadDigest(item),
      };
    }));
}

const STATUS_PLANES: OrchestrationRuntimeStatusPlane[] = [
  "tasks", "plans", "subAgents", "workflows", "toolRuns",
];
const CONTINUING_STATUSES = new Set(["pending", "in_progress", "running", "blocked", "unknown"]);
const REDUNDANT_NOT_STARTED_STATUSES = new Set(["pending", "unknown"]);
const COMPLETED_EVIDENCE_STATUSES = new Set(["completed", "failed", "aborted", "stale"]);

function evidenceKey(plane: OrchestrationRuntimeStatusPlane, itemId: string): string {
  return `${plane}:${itemId}`;
}

function currentRootItems(
  snapshot: RuntimeStatusSnapshot, rootRequestId: string,
): Array<{ plane: OrchestrationRuntimeStatusPlane; item: RuntimeStatusItem }> {
  return STATUS_PLANES.flatMap(plane => snapshot[plane]
    .filter(item => item.rootRequestId === rootRequestId)
    .map(item => ({ plane, item })));
}

function validateSupersedeMergeEvidence(
  snapshot: RuntimeStatusSnapshot, transition: RuntimeBatchPolicyTransition,
): SupersedeMergeEvidence {
  const evidence = transition.policyEffect.supersedeEvidence;
  const activeRootId = snapshot.rootExecution.rootRequestId;
  if (!evidence || !activeRootId || evidence.targetRootRequestId !== activeRootId) {
    throw new Error(`Batch transition failed: supersede evidence for ${transition.id} targets a stale current root.`);
  }
  const current = currentRootItems(snapshot, activeRootId);
  const currentByKey = new Map(current.map(entry => [evidenceKey(entry.plane, entry.item.id), entry.item]));
  if (currentByKey.size !== current.length) {
    throw new Error(`Batch transition failed: old root ${activeRootId} contains duplicate runtime item identities.`);
  }
  const evidenceByKey = new Map<string, SupersedeMergeItemEvidence>();
  for (const entry of evidence.items) {
    const key = evidenceKey(entry.plane, entry.itemId);
    if (evidenceByKey.has(key)) {
      throw new Error(`Batch transition failed: supersede evidence contains duplicate item ${key}.`);
    }
    evidenceByKey.set(key, entry);
  }
  if (evidenceByKey.size !== currentByKey.size ||
      [...currentByKey.keys()].some(key => !evidenceByKey.has(key)) ||
      [...evidenceByKey.keys()].some(key => !currentByKey.has(key))) {
    throw new Error(`Batch transition failed: supersede evidence for ${transition.id} must exactly cover every old-root item.`);
  }
  for (const [key, item] of currentByKey) {
    const entry = evidenceByKey.get(key)!;
    if (entry.status !== item.status) {
      throw new Error(`Batch transition failed: supersede evidence status is stale for ${key}.`);
    }
    if (entry.updatedAt !== item.updatedAt) {
      throw new Error(`Batch transition failed: supersede evidence updatedAt is stale for ${key}.`);
    }
    if (entry.disposition === "continue_under_replacement" && !CONTINUING_STATUSES.has(item.status)) {
      throw new Error(`Batch transition failed: continue_under_replacement is invalid for ${key} status ${item.status}.`);
    }
    if (entry.disposition === "cancel_as_redundant" &&
        (!REDUNDANT_NOT_STARTED_STATUSES.has(item.status) || item.required !== false ||
         item.startedAt || item.completedAt)) {
      throw new Error(`Batch transition failed: cancel_as_redundant is invalid for required, started, or ${item.status} item ${key}.`);
    }
    if (entry.disposition === "preserve_completed_evidence" && !COMPLETED_EVIDENCE_STATUSES.has(item.status)) {
      throw new Error(`Batch transition failed: preserve_completed_evidence is invalid for ${key} status ${item.status}.`);
    }
  }
  return evidence;
}

function validateParallelClaimIsolation(transitions: RuntimeBatchPolicyTransition[]): void {
  const parallel = transitions.filter(item => item.policyEffect.policy === "parallel_independent");
  const claimedWrites = new Map<string, string>();
  const claimedResources = new Map<string, string>();
  const claim = (
    claims: Map<string, string>, values: string[], itemId: string, label: "write target" | "external resource",
  ) => {
    for (const value of values) {
      const owner = claims.get(value);
      if (owner && owner !== itemId) {
        throw new Error(`Batch transition failed: parallel items ${owner} and ${itemId} have an overlapping ${label} claim ${value}.`);
      }
      claims.set(value, itemId);
    }
  };
  for (const transition of parallel) {
    const evidence = transition.policyEffect.branchEvidence as OrchestrationBatchBranchEvidence;
    claim(claimedWrites, evidence.writeTargets, transition.id, "write target");
    claim(claimedResources, evidence.externalResourceKeys, transition.id, "external resource");
  }
}

function applySupersedeDispositions(
  items: RuntimeStatusItem[], plane: OrchestrationRuntimeStatusPlane, evidence: SupersedeMergeEvidence,
  replacementRootRequestId: string, timestamp: string,
): RuntimeStatusItem[] {
  const entries = new Map(evidence.items.filter(item => item.plane === plane)
    .map(item => [item.itemId, item]));
  return items.map(item => {
    const entry = entries.get(item.id);
    if (!entry || item.rootRequestId !== evidence.targetRootRequestId) return item;
    if (entry.disposition === "continue_under_replacement") {
      return { ...item, rootRequestId: replacementRootRequestId };
    }
    if (entry.disposition === "cancel_as_redundant") {
      return { ...item, status: "aborted", completedAt: timestamp, updatedAt: timestamp };
    }
    return item;
  });
}

function applyRuntimeBatchTransitions(
  snapshot: RuntimeStatusSnapshot,
  input: {
    transitions: RuntimeBatchTransition[];
    batchId?: string;
    expectedQueueRevision?: number;
    expectedItemIds?: string[];
    timestamp: string;
  },
): RuntimeStatusSnapshot {
  const transitionIds = input.transitions.map(transition => transition.id);
  if (new Set(transitionIds).size !== transitionIds.length) {
    throw new Error("Batch transition failed: duplicate transition item IDs.");
  }
  if (input.expectedQueueRevision !== undefined && snapshot.continuity.inputQueueRevision !== input.expectedQueueRevision) {
    throw new Error(`Batch transition failed: stale queue revision (expected ${input.expectedQueueRevision}, got ${snapshot.continuity.inputQueueRevision})`);
  }
  if (input.expectedItemIds) {
    const currentIds = new Set(snapshot.inputQueue.map(item => item.id));
    for (const id of input.expectedItemIds) {
      if (!currentIds.has(id)) throw new Error(`Batch transition failed: missing required item ID ${id}`);
    }
  }

  for (const transition of input.transitions) {
    if (!transition.policyEffect) {
      if (transition.patch.policy && transition.patch.policy !== "none" &&
          transition.patch.policy !== "sidecar" && transition.patch.policy !== "status" &&
          transition.patch.policy !== "task_adjustment" && transition.patch.policy !== "redirect") {
        throw new Error(`Batch transition failed: policy ${transition.patch.policy} for ${transition.id} lacks an executable policy effect.`);
      }
      continue;
    }
    if (!isPolicyTransition(transition)) {
      throw new Error(`Batch transition failed: item ${transition.id} lacks a complete policy transition.`);
    }
    assertRuntimeBatchPolicyTransition(transition);
    const item = snapshot.inputQueue.find(candidate => candidate.id === transition.id);
    if (!item || item.status !== transition.from) {
      throw new Error(`Batch transition failed: source status changed for item ${transition.id}.`);
    }
  }
  const policyTransitions = input.transitions.filter(isPolicyTransition);
  const rootMutations = policyTransitions.filter(transition => transition.policyEffect.rootAction !== "preserve");
  if (rootMutations.length > 1) {
    throw new Error("Batch transition failed: one atomic batch cannot contain multiple current-root mutations.");
  }
  validateParallelClaimIsolation(policyTransitions);
  const supersedeTransition = rootMutations.find(transition =>
    transition.policyEffect.policy === "supersede_merge",
  );
  if (supersedeTransition && !snapshot.rootExecution.rootRequestId) {
    throw new Error(`Batch transition failed: policy supersede_merge for ${supersedeTransition.id} requires an active current root.`);
  }
  const supersedeEvidence = supersedeTransition
    ? validateSupersedeMergeEvidence(snapshot, supersedeTransition)
    : undefined;

  const inputQueue = snapshot.inputQueue.map(item => {
    const transition = input.transitions.find(t => t.id === item.id);
    if (!transition) return item;
    return { ...item, ...transition.patch };
  });

  let requests = snapshot.requests;
  let rootExecution = snapshot.rootExecution;
  for (const transition of input.transitions) {
    const queueItem = snapshot.inputQueue.find(q => q.id === transition.id)!;
    if (!isPolicyTransition(transition)) {
      if (transition.patch.status === "admitted" && queueItem.requestId) {
        requests = requests.map((request): RuntimeRequestRecord => request.requestId === queueItem.requestId ? {
          ...request, status: "delivered", deliveryMode: "batch",
          deliveredAt: request.deliveredAt || input.timestamp, updatedAt: input.timestamp,
        } : request);
      }
      continue;
    }
    const requestIndex = requests.findIndex(request => request.requestId === queueItem.requestId);
    if (requestIndex < 0) {
      throw new Error(`Batch transition failed: missing request record for item ${transition.id}.`);
    }
    const effect = transition.policyEffect;
    const currentRequest = requests[requestIndex];
    const activeRootId = rootExecution.rootRequestId;
    if (effect.schedulingMode === "current_root" || effect.schedulingMode === "parallel" ||
        effect.schedulingMode === "serial" || effect.rootAction !== "preserve") {
      if (!activeRootId) {
        throw new Error(`Batch transition failed: policy ${effect.policy} for ${transition.id} requires an active current root.`);
      }
    }
    if (effect.targetTaskId) {
      const targetTask = snapshot.tasks.find(task => task.id === effect.targetTaskId);
      if (!targetTask || targetTask.rootRequestId !== activeRootId) {
        throw new Error(`Batch transition failed: target task ${effect.targetTaskId} is not owned by the active current root.`);
      }
    }
    requests = requests.map((request, index): RuntimeRequestRecord => index === requestIndex ? {
      ...request,
      kind: effect.requestKind,
      status: effect.requestStatus,
      deliveryMode: "batch",
      deliveredAt: request.deliveredAt || (effect.requestStatus === "delivered" ? input.timestamp : undefined),
      answeredAt: request.answeredAt || (effect.requestStatus === "answered" ? input.timestamp : undefined),
      hasVisibleReply: request.hasVisibleReply,
      failureReason: effect.requestStatus === "deferred" ? effect.reason : undefined,
      parentRequestId: effect.policy === "supersede_merge"
        ? undefined
        : request.parentRequestId || activeRootId,
      updatedAt: input.timestamp,
    } : request);

    if (effect.rootAction !== "preserve") {
      const rootIndex = requests.findIndex(request => request.requestId === activeRootId);
      if (rootIndex < 0) {
        throw new Error(`Batch transition failed: active root request ${activeRootId} is missing.`);
      }
      if (effect.rootAction === "supersede") {
        requests = requests.map((request, index): RuntimeRequestRecord => index === rootIndex ? {
          ...request, status: "interrupted", updatedAt: input.timestamp,
          failureReason: `Superseded by ${currentRequest.requestId}`,
        } : request);
      } else if (effect.rootAction === "pause") {
        requests = requests.map((request, index): RuntimeRequestRecord => index === rootIndex ? {
          ...request, status: "deferred", updatedAt: input.timestamp,
          failureReason: `Paused by ${currentRequest.requestId}`,
        } : request);
      } else {
        requests = requests.map((request, index): RuntimeRequestRecord => index === rootIndex ? {
          ...request, status: "interrupted", updatedAt: input.timestamp,
          failureReason: `Cancelled by ${currentRequest.requestId}`,
        } : request);
      }
      const rootSource: RuntimeStatusSnapshot = {
        ...snapshot, inputQueue, requests, rootExecution, updatedAt: input.timestamp,
      };
      rootExecution = reduceRuntimeRootExecution(rootExecution, rootSource, {
        type: "batch_policy_applied",
        policy: effect.policy as "supersede_merge" | "pause" | "cancel",
        batchId: input.batchId,
        sourceRequestId: currentRequest.requestId,
        targetRootRequestId: activeRootId!,
        targetTaskId: effect.targetTaskId,
        reason: effect.reason,
        timestamp: input.timestamp,
        supersedeEvidence: effect.supersedeEvidence,
      });
    }
  }

  let tasks = snapshot.tasks;
  let plans = snapshot.plans;
  let subAgents = snapshot.subAgents;
  let workflows = snapshot.workflows;
  let toolRuns = snapshot.toolRuns;
  const rootMutation = rootMutations[0];
  const previousRootId = snapshot.rootExecution.rootRequestId;
  if (rootMutation && previousRootId) {
    const effect = rootMutation.policyEffect;
    if (effect.rootAction === "supersede") {
      const replacementRootId = snapshot.inputQueue.find(entry => entry.id === rootMutation.id)?.requestId;
      if (!supersedeEvidence || !replacementRootId) {
        throw new Error(`Batch transition failed: supersede_merge for ${rootMutation.id} lacks an exact replacement binding.`);
      }
      tasks = applySupersedeDispositions(tasks, "tasks", supersedeEvidence, replacementRootId, input.timestamp);
      plans = applySupersedeDispositions(plans, "plans", supersedeEvidence, replacementRootId, input.timestamp);
      subAgents = applySupersedeDispositions(subAgents, "subAgents", supersedeEvidence, replacementRootId, input.timestamp);
      workflows = applySupersedeDispositions(workflows, "workflows", supersedeEvidence, replacementRootId, input.timestamp);
      toolRuns = applySupersedeDispositions(toolRuns, "toolRuns", supersedeEvidence, replacementRootId, input.timestamp);
    } else if (effect.rootAction === "cancel") {
      const abort = <T extends { status: string; rootRequestId?: string; updatedAt: string; completedAt?: string }>(items: T[]): T[] =>
        items.map(item => item.rootRequestId === previousRootId &&
          (item.status === "pending" || item.status === "in_progress" || item.status === "running" ||
           item.status === "blocked" || item.status === "unknown")
          ? { ...item, status: "aborted", completedAt: item.completedAt || input.timestamp, updatedAt: input.timestamp }
          : item);
      tasks = abort(tasks);
      plans = abort(plans);
      subAgents = abort(subAgents);
      workflows = abort(workflows);
      toolRuns = abort(toolRuns);
    }
  }

  return {
    ...snapshot,
    updatedAt: input.timestamp,
    inputQueue,
    requests,
    tasks,
    plans,
    subAgents,
    workflows,
    toolRuns,
    rootExecution,
    continuity: {
      ...snapshot.continuity,
      inputQueueRevision: (snapshot.continuity.inputQueueRevision || 0) + 1,
      updatedAt: input.timestamp,
    }
  };
}

export function commitRuntimeBatchTransitions(
  agentDir: string,
  input: {
    transitions: RuntimeBatchTransition[];
    batchId?: string;
    expectedQueueRevision?: number;
    expectedItemIds?: string[];
    expectedManifest?: RuntimeBatchTransitionManifestItem[];
    timestamp?: string;
  }
): RuntimeBatchTransitionCommitResult {
  const now = input.timestamp || new Date().toISOString();
  const expectedItemIds = normalizeExpectedItemIds(input.expectedItemIds);
  let result: RuntimeBatchTransitionCommitResult | undefined;
  const fallbackBatchId = input.batchId || `batch-${fingerprint([
    String(input.expectedQueueRevision ?? ""),
    ...input.transitions.map(transition => transition.id).sort(),
  ])}`;
  const snapshot = updateRuntimeStatus(agentDir, current => {
    const manifest = manifestForTransitions(current, input.transitions);
    const expectedManifest = input.expectedManifest
      ? sortRuntimeBatchManifest(input.expectedManifest.map(expected => ({
          ...expected,
          payloadDigest: expected.payloadDigest || manifest.find(item => item.id === expected.id)?.payloadDigest,
        })))
      : manifest;
    const batchPayload = {
      expectedQueueRevision: input.expectedQueueRevision,
      expectedItemIds,
      manifest: expectedManifest,
      transitions: input.transitions.map(transition => ({
        id: transition.id,
        from: transition.from,
        to: transition.to,
        patch: transition.patch,
        policyEffect: transition.policyEffect,
      })),
    };
    const payloadHash = batchCommitPayloadHash(batchPayload);
    const batchId = input.batchId || fallbackBatchId;
    const existing = current.batchCommits.find(item => item.batchId === batchId);
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new Error(`Batch transition failed: batchId ${batchId} was already used with a different payload.`);
      }
      result = {
        snapshot: current,
        receipt: existing.receipt,
        replayed: true,
      };
      return current;
    }
    if (!equalRuntimeBatchManifest(manifest, expectedManifest)) {
      throw new Error("Batch transition failed: exact manifest changed before commit.");
    }

    const next = applyRuntimeBatchTransitions(current, {
      transitions: input.transitions,
      batchId,
      expectedQueueRevision: input.expectedQueueRevision,
      expectedItemIds,
      timestamp: now,
    });
    const directives: RuntimeBatchExecutionDirective[] = input.transitions.filter(isPolicyTransition).map(transition => {
      const manifestItem = manifest.find(item => item.id === transition.id)!;
      return {
        id: transition.id,
        requestId: manifestItem.requestId || "",
        sequence: manifestItem.sequence,
        targetRootRequestId: current.rootExecution.rootRequestId,
        ...transition.policyEffect,
        nextCheckpoint: transition.policyEffect.nextCheckpoint,
        attemptCount: transition.policyEffect.attemptCount,
        dependencyPredicate: transition.policyEffect.dependencyPredicate,
        dependencyVersion: transition.policyEffect.dependencyVersion,
      };
    });
    const receipt: RuntimeBatchTransitionReceipt = {
      receiptType: "runtime-batch-transition",
      batchId,
      committedAt: now,
      expectedQueueRevision: input.expectedQueueRevision,
      committedQueueRevision: next.continuity.inputQueueRevision,
      manifest: expectedManifest,
      ...(directives.length > 0 ? { directives } : {}),
    };
    const committed = {
      ...next,
      batchCommits: upsertRuntimeBatchCommitRecord(next.batchCommits, {
        batchId,
        payloadHash,
        committedAt: now,
        receipt,
      }),
    };
    result = {
      snapshot: committed,
      receipt,
      replayed: false,
    };
    return committed;
  });
  if (!result) {
    throw new Error("Batch transition failed: commit result was not produced.");
  }
  return result;
}

export function retireRuntimeInputQueueItems(
  agentDir: string,
  input: { timestamp?: string; source?: string; reason?: string } = {},
): RuntimeStatusSnapshot {
  const timestamp = input.timestamp || new Date().toISOString();
  const source = input.source || "runtime-status";
  const reason = input.reason || "new runtime session";
  return updateRuntimeStatus(agentDir, snapshot => {
    const pending = pendingRuntimeInputQueueItems(snapshot);
    if (!pending.length) return snapshot;
    return {
      ...snapshot,
      updatedAt: timestamp,
      inputQueue: snapshot.inputQueue.map(item =>
        isRuntimeInputQueuePending(item)
          ? { ...item, status: "expired" as RuntimeInputQueueStatus, failureReason: reason }
          : item,
      ),
      requests: snapshot.requests.map(item =>
        pending.some(queued => queued.requestId === item.requestId) && (item.status === "queued" || item.status === "delivered" || item.status === "answering")
          ? { ...item, status: "interrupted" as RuntimeRequestStatus, updatedAt: timestamp, failureReason: reason }
          : item,
      ),
      events: [...snapshot.events, {
        id: `event-${fingerprint([timestamp, source, reason, String(pending.length)])}`,
        timestamp,
        kind: "input_queue",
        title: "Input queue items retired",
        summary: `${pending.length} pending item(s) expired: ${reason}`,
        source,
      }].slice(-MAX_EVENTS),
    };
  });
}

const MAX_EVENTS = 80;

function markRuntimeItemStale(item: RuntimeStatusItem, timestamp: string): RuntimeStatusItem {
  return isRuntimeItemOpen(item.status)
    ? {
        ...item,
        status: "stale",
        required: false,
        completedAt: item.completedAt || timestamp,
        updatedAt: timestamp,
      }
    : item;
}

function countRuntimeOpenItems(items: RuntimeStatusItem[]): number {
  return items.filter(item => isRuntimeItemOpen(item.status)).length;
}

export function retireRuntimeSessionItems(
  agentDir: string,
  input: { timestamp?: string; source?: string; reason?: string } = {},
): RuntimeStatusSnapshot {
  const timestamp = input.timestamp || new Date().toISOString();
  const source = input.source || "runtime-status";
  const reason = input.reason || "new runtime session";
  return updateRuntimeStatus(agentDir, snapshot => {
    const nonterminalExecutionIds = new Set(snapshot.batchCommits.flatMap(commit =>
      (commit.executions || []).filter(execution =>
        execution.state === "pending" || execution.state === "dispatching" ||
        execution.state === "accepted" || execution.state === "running",
      ).map(execution => execution.executionId),
    ));
    const retiredExecutionBindings = snapshot.batchCommits.flatMap(commit =>
      (commit.executions || []).filter(execution => nonterminalExecutionIds.has(execution.executionId)),
    );
    const retiredQueueBindings = new Set(retiredExecutionBindings.map(execution => runtimeExecutionQueueKey({
      id: execution.directiveId, requestId: execution.requestId,
      sequence: execution.sequence, timestamp: execution.timestamp,
    })));
    const retiredRequestIds = new Set(retiredExecutionBindings.map(execution => execution.requestId));
    const pendingInputs = pendingRuntimeInputQueueItems(snapshot).length;
    const staleTaskCount = countRuntimeOpenItems(snapshot.tasks);
    const stalePlanCount = countRuntimeOpenItems(snapshot.plans);
    const staleSubAgentCount = countRuntimeOpenItems(snapshot.subAgents);
    const staleWorkflowCount = countRuntimeOpenItems(snapshot.workflows);
    const staleToolCount = countRuntimeOpenItems(snapshot.toolRuns);
    const openRequestCount = snapshot.requests.filter(item => item.status === "queued" || item.status === "delivered" || item.status === "answering").length;
    const liveRootCount = snapshot.rootExecution.rootRequestId || snapshot.rootExecution.state !== "idle" ? 1 : 0;
    const batchExecutionCount = nonterminalExecutionIds.size;
    const changed = pendingInputs + openRequestCount + staleTaskCount + stalePlanCount +
      staleSubAgentCount + staleWorkflowCount + staleToolCount + liveRootCount + batchExecutionCount;
    if (changed === 0) return snapshot;
    return {
      ...snapshot,
      updatedAt: timestamp,
      rootExecution: emptyRuntimeRootExecution(timestamp),
      inputQueue: snapshot.inputQueue.map(item =>
        isRuntimeInputQueuePending(item) || retiredQueueBindings.has(runtimeExecutionQueueKey(item))
          ? { ...item, status: "expired" as RuntimeInputQueueStatus, failureReason: reason }
          : item,
      ),
      requests: snapshot.requests.map(item =>
        item.status === "queued" || item.status === "delivered" || item.status === "answering" ||
        retiredRequestIds.has(item.requestId)
          ? { ...item, status: "interrupted" as RuntimeRequestStatus, updatedAt: timestamp, failureReason: reason }
          : item,
      ),
      batchCommits: snapshot.batchCommits.map(commit => ({
        ...commit,
        executions: commit.executions?.map(execution => nonterminalExecutionIds.has(execution.executionId)
          ? {
              ...execution, state: "cancelled" as const, settledAt: timestamp, dispatchLeaseUntil: undefined,
              failureCode: "session_retired" as const, failureReason: reason,
            }
          : execution),
      })),
      tasks: snapshot.tasks.map(item => markRuntimeItemStale(item, timestamp)),
      plans: snapshot.plans.map(item => markRuntimeItemStale(item, timestamp)),
      subAgents: snapshot.subAgents.map(item => markRuntimeItemStale(item, timestamp)),
      workflows: snapshot.workflows.map(item => markRuntimeItemStale(item, timestamp)),
      toolRuns: snapshot.toolRuns.map(item => markRuntimeItemStale(item, timestamp)),
      events: [...snapshot.events, {
        id: `event-${fingerprint([timestamp, source, reason, String(changed)])}`,
        timestamp,
        kind: "runtime_session",
        title: "Runtime session items retired",
        summary: [
          `reason=${reason}`,
          `inputs=${pendingInputs}`,
          `requests=${openRequestCount}`,
          `tasks=${staleTaskCount}`,
          `plans=${stalePlanCount}`,
          `agents=${staleSubAgentCount}`,
          `workflows=${staleWorkflowCount}`,
          `tools=${staleToolCount}`,
          `batch_executions=${batchExecutionCount}`,
        ].join(" "),
        source,
      }].slice(-MAX_EVENTS),
    };
  });
}
