/**
 * =============================================================================
 * Canvast — Runtime Batch Policy Contract / 运行时批策略合同
 * =============================================================================
 * @file        src/harness/runtime-batch-policy.ts
 * @brief       Executable semantics for every typed runtime batch policy.
 * @description Converts orchestration choices into explicit queue, request,
 *              root, and scheduler effects. Invalid or incomplete semantics
 *              fail closed before the shared runtime-status commit.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import type {
  OrchestrationBatchBranchEvidence,
  OrchestrationBatchItem,
  SupersedeMergeEvidence,
} from "./auto-orchestrator/types.js";
import type {
  ReevaluateCheckpoint,
  RuntimeInputQueueItem,
  RuntimeInputQueueStatus,
  RuntimeRequestKind,
  RuntimeRequestStatus,
} from "./context-continuity/runtime-queue.js";

export type RuntimeBatchPolicy = OrchestrationBatchItem["policy"];
export type RuntimeBatchSchedulingMode =
  | "current_root"
  | "parallel"
  | "serial"
  | "deferred"
  | "none";
export type RuntimeBatchRootAction = "preserve" | "supersede" | "pause" | "cancel";

export interface RuntimeBatchPolicyEffect {
  policy: RuntimeBatchPolicy;
  requestStatus: RuntimeRequestStatus;
  requestKind: RuntimeRequestKind;
  rootAction: RuntimeBatchRootAction;
  schedulingMode: RuntimeBatchSchedulingMode;
  targetTaskId?: string;
  dependencyIds: string[];
  priority?: number;
  nextCheckpoint?: ReevaluateCheckpoint;
  reason: string;
  blockerTaskIds: string[];
  attemptCount?: number;
  dependencyPredicate?: string;
  dependencyVersion?: string;
  branchEvidence?: OrchestrationBatchBranchEvidence;
  supersedeEvidence?: SupersedeMergeEvidence;
}

export interface RuntimeBatchPolicyTransition {
  id: string;
  from: RuntimeInputQueueStatus;
  to: RuntimeInputQueueStatus;
  patch: Partial<Omit<RuntimeInputQueueItem, "id" | "timestamp" | "sequence">>;
  policyEffect: RuntimeBatchPolicyEffect;
}

const EXPECTED_EFFECTS: Record<RuntimeBatchPolicy, {
  queueStatus: RuntimeInputQueueStatus;
  requestStatus: RuntimeRequestStatus;
  requestKind: RuntimeRequestKind;
  rootAction: RuntimeBatchRootAction;
  schedulingMode: RuntimeBatchSchedulingMode;
}> = {
  supersede_merge: {
    queueStatus: "admitted", requestStatus: "delivered", requestKind: "primary",
    rootAction: "supersede", schedulingMode: "current_root",
  },
  amend_current: {
    queueStatus: "admitted", requestStatus: "delivered", requestKind: "adjustment",
    rootAction: "preserve", schedulingMode: "current_root",
  },
  parallel_independent: {
    queueStatus: "admitted", requestStatus: "delivered", requestKind: "batch_member",
    rootAction: "preserve", schedulingMode: "parallel",
  },
  serial_after_current: {
    queueStatus: "deferred", requestStatus: "deferred", requestKind: "batch_member",
    rootAction: "preserve", schedulingMode: "serial",
  },
  defer: {
    queueStatus: "deferred", requestStatus: "deferred", requestKind: "batch_member",
    rootAction: "preserve", schedulingMode: "deferred",
  },
  pause: {
    queueStatus: "acknowledged", requestStatus: "answered", requestKind: "interrupt",
    rootAction: "pause", schedulingMode: "none",
  },
  cancel: {
    queueStatus: "acknowledged", requestStatus: "answered", requestKind: "interrupt",
    rootAction: "cancel", schedulingMode: "none",
  },
};

export function isRuntimeBatchPolicy(value: unknown): value is RuntimeBatchPolicy {
  return typeof value === "string" && Object.hasOwn(EXPECTED_EFFECTS, value);
}

export function assertRuntimeBatchPolicyTransition(transition: RuntimeBatchPolicyTransition): void {
  const effect = transition.policyEffect;
  if (!effect || !isRuntimeBatchPolicy(effect.policy)) {
    throw new Error(`Batch transition failed: item ${transition.id} lacks a valid policy effect.`);
  }
  const expected = EXPECTED_EFFECTS[effect.policy];
  if (transition.to !== expected.queueStatus || transition.patch.status !== expected.queueStatus ||
      transition.patch.policy !== effect.policy || effect.requestStatus !== expected.requestStatus ||
      effect.requestKind !== expected.requestKind || effect.rootAction !== expected.rootAction ||
      effect.schedulingMode !== expected.schedulingMode) {
    throw new Error(`Batch transition failed: policy effect for ${transition.id} contradicts ${effect.policy} semantics.`);
  }
  if ((effect.policy === "supersede_merge" || effect.policy === "amend_current") &&
      !nonEmpty(effect.targetTaskId)) {
    throw new Error(`Batch transition failed: policy ${effect.policy} for ${transition.id} requires targetTaskId.`);
  }
  if (effect.policy === "supersede_merge") {
    assertSupersedeEvidenceShape(transition.id, effect.supersedeEvidence);
  } else if (effect.supersedeEvidence !== undefined) {
    throw new Error(`Batch transition failed: policy ${effect.policy} for ${transition.id} cannot carry supersede evidence.`);
  }
  if (effect.policy === "parallel_independent" && uniqueStrings(effect.dependencyIds).length > 0) {
    throw new Error(`Batch transition failed: parallel_independent item ${transition.id} cannot declare dependencies.`);
  }
  if (effect.policy === "parallel_independent") {
    assertSafeParallelEvidence(transition.id, effect.branchEvidence, "transition");
  }
  if (effect.schedulingMode === "serial" || effect.schedulingMode === "deferred") {
    if (!nonEmpty(effect.reason) || !effect.nextCheckpoint || !CHECKPOINTS.has(effect.nextCheckpoint)) {
      throw new Error(`Batch transition failed: policy ${effect.policy} for ${transition.id} requires defer metadata.`);
    }
  }
}

const CHECKPOINTS = new Set<ReevaluateCheckpoint>([
  "on_tool_success",
  "on_tool_error",
  "on_turn_settle",
  "on_plan_approved",
  "on_workflow_stage",
]);

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(nonEmpty).filter((value): value is string => Boolean(value)))];
}

const SUPERSEDE_PLANES = new Set(["tasks", "plans", "subAgents", "workflows", "toolRuns"]);
const ITEM_STATUSES = new Set([
  "pending", "in_progress", "running", "completed", "blocked",
  "failed", "aborted", "stale", "unknown",
]);
const SUPERSEDE_DISPOSITIONS = new Set([
  "continue_under_replacement", "cancel_as_redundant", "preserve_completed_evidence",
]);

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some(item => !nonEmpty(item))) return undefined;
  const normalized = value.map(item => nonEmpty(item)!);
  return new Set(normalized).size === normalized.length ? normalized : undefined;
}

function branchEvidenceFor(plan: OrchestrationBatchItem): OrchestrationBatchBranchEvidence | undefined {
  const value = plan.relation.branchEvidence;
  if (!value || typeof value !== "object" || typeof value.selfContained !== "boolean" ||
      (value.primaryDependency !== "none" && value.primaryDependency !== "snapshot" &&
       value.primaryDependency !== "live")) return undefined;
  const dependsOnBranchIds = stringList(value.dependsOnBranchIds);
  const writeTargets = stringList(value.writeTargets);
  const externalResourceKeys = stringList(value.externalResourceKeys);
  if (!dependsOnBranchIds || !writeTargets || !externalResourceKeys) return undefined;
  return {
    selfContained: value.selfContained, primaryDependency: value.primaryDependency,
    dependsOnBranchIds, writeTargets, externalResourceKeys,
  };
}

function assertSafeParallelEvidence(
  itemId: string, evidence: OrchestrationBatchBranchEvidence | undefined, phase: "admission" | "transition",
): asserts evidence is OrchestrationBatchBranchEvidence {
  const prefix = phase === "admission" ? "Batch admission failed" : "Batch transition failed";
  if (!evidence) throw new Error(`${prefix}: parallel_independent item ${itemId} requires complete branch evidence.`);
  if (!evidence.selfContained) throw new Error(`${prefix}: parallel_independent item ${itemId} must be self-contained.`);
  if (evidence.primaryDependency === "live") {
    throw new Error(`${prefix}: parallel_independent item ${itemId} cannot use a live primary dependency.`);
  }
  if (evidence.dependsOnBranchIds.length > 0) {
    throw new Error(`${prefix}: parallel_independent item ${itemId} cannot depend on another branch.`);
  }
}

function assertSupersedeEvidenceShape(
  itemId: string, evidence: SupersedeMergeEvidence | undefined,
): asserts evidence is SupersedeMergeEvidence {
  if (!evidence || !nonEmpty(evidence.targetRootRequestId) || !Array.isArray(evidence.items)) {
    throw new Error(`Batch transition failed: supersede_merge item ${itemId} requires complete supersede evidence.`);
  }
  const keys = new Set<string>();
  for (const entry of evidence.items) {
    const key = `${entry?.plane}:${entry?.itemId}`;
    if (!entry || !SUPERSEDE_PLANES.has(entry.plane) || !nonEmpty(entry.itemId) ||
        !ITEM_STATUSES.has(entry.status) || !nonEmpty(entry.updatedAt) ||
        !Number.isFinite(Date.parse(entry.updatedAt)) || !SUPERSEDE_DISPOSITIONS.has(entry.disposition)) {
      throw new Error(`Batch transition failed: supersede_merge item ${itemId} has invalid supersede evidence.`);
    }
    if (keys.has(key)) throw new Error(`Batch transition failed: supersede evidence contains duplicate item ${key}.`);
    keys.add(key);
  }
}

function relationFor(plan: OrchestrationBatchItem): {
  targetTaskId?: string;
  dependencyIds: string[];
  priority?: number;
  branchEvidence?: OrchestrationBatchBranchEvidence;
} {
  if (!plan.relation || typeof plan.relation !== "object") {
    throw new Error(`Batch admission failed: policy ${plan.policy} for ${plan.id} requires a relation object.`);
  }
  const priority = plan.relation.priority;
  if (priority !== undefined && !Number.isSafeInteger(priority)) {
    throw new Error(`Batch admission failed: policy ${plan.policy} for ${plan.id} has an invalid priority.`);
  }
  const branchEvidence = branchEvidenceFor(plan);
  if (plan.relation.branchEvidence !== undefined && !branchEvidence) {
    throw new Error(`Batch admission failed: policy ${plan.policy} for ${plan.id} has invalid branch evidence.`);
  }
  return {
    targetTaskId: nonEmpty(plan.relation.targetTaskId),
    dependencyIds: uniqueStrings(plan.relation.dependencyIds),
    priority,
    branchEvidence,
  };
}

function deferralFor(
  item: RuntimeInputQueueItem,
  plan: OrchestrationBatchItem,
  policy: "defer" | "serial_after_current",
): NonNullable<RuntimeInputQueueItem["deferInfo"]> {
  const relation = relationFor(plan);
  const previous = item.deferInfo;
  const planned = plan.deferInfo;
  const reasonCode = nonEmpty(planned?.reasonCode) || nonEmpty(previous?.reasonCode) ||
    (policy === "serial_after_current" ? "serial_after_current" : undefined);
  const reevaluateAt = planned?.reevaluateAt || previous?.reevaluateAt ||
    (policy === "serial_after_current" ? "on_turn_settle" : undefined);
  if (!reasonCode || !reevaluateAt || !CHECKPOINTS.has(reevaluateAt)) {
    throw new Error(`Batch admission failed: policy ${policy} for ${plan.id} requires a reason and next checkpoint.`);
  }
  return {
    reasonCode,
    blockerTaskIds: uniqueStrings([
      ...(previous?.blockerTaskIds || []),
      ...(planned?.blockerTaskIds || []),
      ...relation.dependencyIds,
    ]),
    reevaluateAt,
    attemptCount: policy === "defer"
      ? Math.max(0, previous?.attemptCount || 0) + 1
      : Math.max(0, previous?.attemptCount || 0),
    dependencyPredicate: previous?.dependencyPredicate,
    dependencyVersion: previous?.dependencyVersion,
  };
}

function effect(
  plan: OrchestrationBatchItem,
  values: Omit<RuntimeBatchPolicyEffect, "policy" | "targetTaskId" | "dependencyIds" | "priority" | "branchEvidence">,
): RuntimeBatchPolicyEffect {
  const relation = relationFor(plan);
  return { policy: plan.policy, ...relation, ...values };
}

function admittedPatch(plan: OrchestrationBatchItem, now: string): Partial<RuntimeInputQueueItem> {
  return {
    status: "admitted",
    policy: plan.policy,
    deliveryMode: "batch",
    deliveredAt: now,
    failureReason: undefined,
    attentionRequired: false,
    deferInfo: undefined,
  };
}

function acknowledgedPatch(plan: OrchestrationBatchItem, now: string): Partial<RuntimeInputQueueItem> {
  return {
    status: "acknowledged",
    policy: plan.policy,
    deliveryMode: "batch",
    deliveredAt: now,
    failureReason: undefined,
    attentionRequired: false,
    deferInfo: undefined,
  };
}

export function createRuntimeBatchPolicyTransition(
  item: RuntimeInputQueueItem,
  plan: OrchestrationBatchItem,
  now: string,
  starvationThreshold = 5,
): RuntimeBatchPolicyTransition {
  const relation = relationFor(plan);
  const requireTargetTask = () => {
    if (!relation.targetTaskId) {
      throw new Error(`Batch admission failed: policy ${plan.policy} for ${plan.id} requires targetTaskId.`);
    }
  };

  switch (plan.policy) {
    case "supersede_merge":
      requireTargetTask();
      if (!plan.supersedeEvidence) {
        throw new Error(`Batch admission failed: supersede_merge item ${plan.id} requires supersede evidence.`);
      }
      return {
        id: item.id, from: item.status, to: "admitted", patch: admittedPatch(plan, now),
        policyEffect: effect(plan, {
          requestStatus: "delivered", requestKind: "primary", rootAction: "supersede",
          schedulingMode: "current_root", reason: "supersede_merge", blockerTaskIds: [],
          supersedeEvidence: plan.supersedeEvidence,
        }),
      };
    case "amend_current":
      requireTargetTask();
      return {
        id: item.id, from: item.status, to: "admitted", patch: admittedPatch(plan, now),
        policyEffect: effect(plan, {
          requestStatus: "delivered", requestKind: "adjustment", rootAction: "preserve",
          schedulingMode: "current_root", reason: "amend_current", blockerTaskIds: [],
        }),
      };
    case "parallel_independent":
      if (relation.dependencyIds.length > 0) {
        throw new Error(`Batch admission failed: parallel_independent item ${plan.id} cannot declare dependencies.`);
      }
      assertSafeParallelEvidence(plan.id, relation.branchEvidence, "admission");
      return {
        id: item.id, from: item.status, to: "admitted", patch: admittedPatch(plan, now),
        policyEffect: effect(plan, {
          requestStatus: "delivered", requestKind: "batch_member", rootAction: "preserve",
          schedulingMode: "parallel", reason: "parallel_independent", blockerTaskIds: [],
        }),
      };
    case "serial_after_current": {
      const deferInfo = deferralFor(item, plan, plan.policy);
      return {
        id: item.id, from: item.status, to: "deferred",
        patch: {
          status: "deferred", policy: plan.policy, deliveryMode: "batch",
          failureReason: deferInfo.reasonCode, deferInfo, attentionRequired: item.attentionRequired,
        },
        policyEffect: effect(plan, {
          requestStatus: "deferred", requestKind: "batch_member", rootAction: "preserve",
          schedulingMode: "serial", reason: deferInfo.reasonCode,
          blockerTaskIds: deferInfo.blockerTaskIds, nextCheckpoint: deferInfo.reevaluateAt,
          attemptCount: deferInfo.attemptCount, dependencyPredicate: deferInfo.dependencyPredicate,
          dependencyVersion: deferInfo.dependencyVersion,
        }),
      };
    }
    case "defer": {
      const deferInfo = deferralFor(item, plan, plan.policy);
      const attentionRequired = deferInfo.attemptCount >= starvationThreshold;
      return {
        id: item.id, from: item.status, to: "deferred",
        patch: {
          status: "deferred", policy: plan.policy, deliveryMode: "batch",
          failureReason: deferInfo.reasonCode, deferInfo,
          attentionRequired: attentionRequired || item.attentionRequired,
        },
        policyEffect: effect(plan, {
          requestStatus: "deferred", requestKind: "batch_member", rootAction: "preserve",
          schedulingMode: "deferred", reason: deferInfo.reasonCode,
          blockerTaskIds: deferInfo.blockerTaskIds, nextCheckpoint: deferInfo.reevaluateAt,
          attemptCount: deferInfo.attemptCount, dependencyPredicate: deferInfo.dependencyPredicate,
          dependencyVersion: deferInfo.dependencyVersion,
        }),
      };
    }
    case "pause":
      return {
        id: item.id, from: item.status, to: "acknowledged", patch: acknowledgedPatch(plan, now),
        policyEffect: effect(plan, {
          requestStatus: "answered", requestKind: "interrupt", rootAction: "pause",
          schedulingMode: "none", reason: "pause", blockerTaskIds: [],
        }),
      };
    case "cancel":
      return {
        id: item.id, from: item.status, to: "acknowledged", patch: acknowledgedPatch(plan, now),
        policyEffect: effect(plan, {
          requestStatus: "answered", requestKind: "interrupt", rootAction: "cancel",
          schedulingMode: "none", reason: "cancel", blockerTaskIds: [],
        }),
      };
    default: {
      const exhaustive: never = plan.policy;
      throw new Error(`Batch admission failed: unsupported policy ${String(exhaustive)}.`);
    }
  }
}
