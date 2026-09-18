/**
 * =============================================================================
 * Canvast — Durable Runtime Batch Execution / 持久运行时批执行
 * =============================================================================
 * @file        src/harness/runtime-batch-execution.ts
 * @brief       Atomic lifecycle operations for committed batch directives.
 * @description Gives scheduler transports reload-safe claims and idempotent
 *              acceptance, start, settlement, and expired-lease release.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import { createHash } from "node:crypto";

import { updateRuntimeStatus, type RuntimeStatusSnapshot } from "./runtime-status.js";
import { runtimeBatchInputPayloadDigest, runtimeBatchSchedulingDirectives, type RuntimeBatchDirectiveExecution,
  type RuntimeBatchDirectiveFailureCode, type RuntimeBatchTransitionReceipt } from "./runtime-batch-commit.js";

export interface RuntimeBatchDirectiveExecutionResult {
  snapshot: RuntimeStatusSnapshot;
  execution?: RuntimeBatchDirectiveExecution;
  changed: boolean;
}

function validPayloadDigest(value: string | undefined): value is string {
  if (!value || value.length !== 64) return false;
  return [...value].every(character => {
    const code = character.charCodeAt(0);
    return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
  });
}

export function runtimeBatchDirectiveExecutionId(batchId: string, directiveId: string): string {
  const digest = createHash("sha256").update(`${batchId}\n${directiveId}`).digest("hex").slice(0, 24);
  return `batch-exec-${digest}`;
}

export function initializeRuntimeBatchDirectiveExecutions(
  receipt: RuntimeBatchTransitionReceipt,
): RuntimeBatchDirectiveExecution[] {
  return runtimeBatchSchedulingDirectives(receipt).map(directive => {
    const manifest = receipt.manifest.find(item =>
      item.id === directive.id && item.requestId === directive.requestId && item.sequence === directive.sequence,
    );
    const payloadDigest = validPayloadDigest(manifest?.payloadDigest) ? manifest.payloadDigest : "";
    const base: RuntimeBatchDirectiveExecution = {
      executionId: runtimeBatchDirectiveExecutionId(receipt.batchId, directive.id),
      batchId: receipt.batchId, directiveId: directive.id, requestId: directive.requestId,
      sequence: directive.sequence, timestamp: manifest?.timestamp || "",
      payloadDigest,
      targetRootRequestId: directive.targetRootRequestId,
      schedulingMode: directive.schedulingMode as "parallel" | "serial",
      branchEvidence: directive.branchEvidence, state: "pending", attemptCount: 0,
    };
    return manifest && payloadDigest ? base : {
      ...base, state: "failed", settledAt: receipt.committedAt,
      failureCode: "exact_input_unavailable",
      failureReason: "The exact committed input binding is unavailable.",
    };
  });
}

export function pendingRuntimeBatchDirectiveExecutions(
  snapshot: RuntimeStatusSnapshot, mode?: "parallel" | "serial",
): RuntimeBatchDirectiveExecution[] {
  return snapshot.batchCommits.flatMap(commit => commit.executions || []).filter(execution =>
    execution.state === "pending" && (!mode || execution.schedulingMode === mode),
  ).sort((left, right) => left.sequence - right.sequence || left.executionId.localeCompare(right.executionId));
}

function mutateExecution(
  agentDir: string, executionId: string,
  mutate: (execution: RuntimeBatchDirectiveExecution) => RuntimeBatchDirectiveExecution | undefined,
): RuntimeBatchDirectiveExecutionResult {
  let changed = false;
  let selected: RuntimeBatchDirectiveExecution | undefined;
  const snapshot = updateRuntimeStatus(agentDir, current => ({
    ...current,
    batchCommits: current.batchCommits.map(commit => {
      if (!commit.executions?.some(item => item.executionId === executionId)) return commit;
      return {
        ...commit,
        executions: commit.executions.map(execution => {
          if (execution.executionId !== executionId) return execution;
          const next = mutate(execution);
          if (!next) { selected = execution; return execution; }
          changed = true;
          selected = next;
          return next;
        }),
      };
    }),
  }));
  return { snapshot, execution: selected, changed };
}

function validTimestamp(value: string): boolean {
  return Boolean(value) && Number.isFinite(Date.parse(value));
}

function exactQueueIndex(
  snapshot: RuntimeStatusSnapshot, execution: RuntimeBatchDirectiveExecution,
): number {
  return snapshot.inputQueue.findIndex(item => item.id === execution.directiveId &&
    item.requestId === execution.requestId && item.sequence === execution.sequence &&
    item.timestamp === execution.timestamp &&
    runtimeBatchInputPayloadDigest(item) === execution.payloadDigest);
}

export function claimRuntimeBatchDirectiveExecution(
  agentDir: string,
  input: {
    executionId: string; dispatchToken: string; timestamp: string; leaseUntil: string;
    settledRootRequestId?: string; checkpoint?: string;
  },
): RuntimeBatchDirectiveExecutionResult {
  if (!input.dispatchToken.trim() || !validTimestamp(input.timestamp) || !validTimestamp(input.leaseUntil) ||
      Date.parse(input.leaseUntil) <= Date.parse(input.timestamp)) {
    throw new Error("Runtime batch execution claim requires a token and a future valid lease.");
  }
  let changed = false;
  let selected: RuntimeBatchDirectiveExecution | undefined;
  const snapshot = updateRuntimeStatus(agentDir, current => {
    const located = current.batchCommits.flatMap(commit => commit.executions || []).find(
      execution => execution.executionId === input.executionId,
    );
    if (!located || located.state !== "pending") return current;
    const queueIndex = exactQueueIndex(current, located);
    const requestIndex = current.requests.findIndex(item => item.requestId === located.requestId);
    if (queueIndex < 0 || requestIndex < 0) return current;
    const commit = current.batchCommits.find(item => item.batchId === located.batchId);
    const directive = commit?.receipt.directives?.find(item => item.id === located.directiveId);
    if (!directive) return current;
    if (located.schedulingMode === "serial") {
      if (!input.settledRootRequestId || input.settledRootRequestId !== located.targetRootRequestId ||
          input.checkpoint !== directive.nextCheckpoint ||
          current.rootExecution.settledRequestId !== located.targetRootRequestId ||
          current.rootExecution.settlement === "pending" ||
          current.inputQueue[queueIndex].status !== "deferred" ||
          current.requests[requestIndex].status !== "deferred") return current;
    }
    selected = {
      ...located, state: "dispatching", attemptCount: located.attemptCount + 1,
      dispatchToken: input.dispatchToken, dispatchLeaseUntil: input.leaseUntil,
      lastDispatchedAt: input.timestamp, failureCode: undefined, failureReason: undefined, settledAt: undefined,
    };
    changed = true;
    return {
      ...current, updatedAt: input.timestamp,
      batchCommits: current.batchCommits.map(batch => ({
        ...batch, executions: batch.executions?.map(execution =>
          execution.executionId === input.executionId ? selected! : execution),
      })),
      inputQueue: current.inputQueue.map((item, index) => index !== queueIndex || located.schedulingMode !== "serial"
        ? item : { ...item, status: "admitted" as const, deliveredAt: item.deliveredAt || input.timestamp,
          failureReason: undefined, deferInfo: undefined }),
      requests: current.requests.map((request, index) => index !== requestIndex || located.schedulingMode !== "serial"
        ? request : { ...request, status: "delivered" as const, deliveredAt: request.deliveredAt || input.timestamp,
          failureReason: undefined, updatedAt: input.timestamp }),
    };
  });
  return { snapshot, execution: selected || snapshot.batchCommits.flatMap(item => item.executions || [])
    .find(item => item.executionId === input.executionId), changed };
}

function releaseDispatchingClaim(
  current: RuntimeStatusSnapshot,
  input: { executionId: string; timestamp: string; dispatchToken?: string; expiredOnly?: boolean },
): RuntimeBatchDirectiveExecutionResult {
  const located = current.batchCommits.flatMap(commit => commit.executions || []).find(
    execution => execution.executionId === input.executionId,
  );
  if (!located || located.state !== "dispatching" ||
      (input.dispatchToken !== undefined && located.dispatchToken !== input.dispatchToken) ||
      (input.expiredOnly && (!located.dispatchLeaseUntil ||
        Date.parse(located.dispatchLeaseUntil) > Date.parse(input.timestamp)))) {
    return { snapshot: current, execution: located, changed: false };
  }

  let queueIndex = -1;
  let requestIndex = -1;
  let deferredQueue: RuntimeStatusSnapshot["inputQueue"][number] | undefined;
  if (located.schedulingMode === "serial") {
    queueIndex = exactQueueIndex(current, located);
    requestIndex = current.requests.findIndex(item => item.requestId === located.requestId);
    const commit = current.batchCommits.find(item => item.batchId === located.batchId);
    const directive = commit?.receipt.directives?.find(item => item.id === located.directiveId &&
      item.requestId === located.requestId && item.sequence === located.sequence);
    if (queueIndex < 0 || requestIndex < 0 || !directive?.nextCheckpoint) {
      return { snapshot: current, execution: located, changed: false };
    }
    deferredQueue = {
      ...current.inputQueue[queueIndex], status: "deferred", deliveredAt: undefined,
      failureReason: directive.reason,
      deferInfo: {
        reasonCode: directive.reason, blockerTaskIds: directive.blockerTaskIds,
        reevaluateAt: directive.nextCheckpoint, attemptCount: directive.attemptCount || 0,
        dependencyPredicate: directive.dependencyPredicate, dependencyVersion: directive.dependencyVersion,
      },
    };
  }

  const released: RuntimeBatchDirectiveExecution = {
    ...located, state: "pending", dispatchToken: undefined, dispatchLeaseUntil: undefined,
    acceptedAt: undefined, startedAt: undefined, settledAt: undefined,
    failureCode: undefined, failureReason: undefined,
  };
  return {
    changed: true,
    execution: released,
    snapshot: {
      ...current, updatedAt: input.timestamp,
      batchCommits: current.batchCommits.map(commit => ({
        ...commit, executions: commit.executions?.map(execution =>
          execution.executionId === located.executionId ? released : execution),
      })),
      inputQueue: current.inputQueue.map((item, index) => index === queueIndex ? deferredQueue! : item),
      requests: current.requests.map((request, index) => index === requestIndex ? {
        ...request, status: "deferred" as const, deliveredAt: undefined,
        failureReason: deferredQueue?.failureReason, updatedAt: input.timestamp,
      } : request),
    },
  };
}

export function releaseRuntimeBatchDirectiveExecution(
  agentDir: string,
  input: { executionId: string; dispatchToken: string; timestamp?: string },
): RuntimeBatchDirectiveExecutionResult {
  const timestamp = input.timestamp || new Date().toISOString();
  if (!input.dispatchToken.trim() || !validTimestamp(timestamp)) {
    throw new Error("Runtime batch execution release requires a token and a valid timestamp.");
  }
  let result: RuntimeBatchDirectiveExecutionResult | undefined;
  const snapshot = updateRuntimeStatus(agentDir, current => {
    result = releaseDispatchingClaim(current, {
      executionId: input.executionId, dispatchToken: input.dispatchToken, timestamp,
    });
    return result.snapshot;
  });
  return { snapshot, execution: result?.execution, changed: Boolean(result?.changed) };
}

export function acceptRuntimeBatchDirectiveExecution(
  agentDir: string, input: { executionId: string; dispatchToken: string; timestamp: string },
): RuntimeBatchDirectiveExecutionResult {
  return mutateExecution(agentDir, input.executionId, execution => {
    if (execution.dispatchToken !== input.dispatchToken) return undefined;
    if (execution.state === "accepted" || execution.state === "running" || execution.state === "completed") return undefined;
    if (execution.state !== "dispatching") return undefined;
    return { ...execution, state: "accepted", acceptedAt: input.timestamp, dispatchLeaseUntil: undefined };
  });
}

export function startRuntimeBatchDirectiveExecution(
  agentDir: string, input: { executionId: string; dispatchToken: string; timestamp: string },
): RuntimeBatchDirectiveExecutionResult {
  return mutateExecution(agentDir, input.executionId, execution => {
    if (execution.state !== "accepted" || execution.dispatchToken !== input.dispatchToken) return undefined;
    return { ...execution, state: "running", startedAt: input.timestamp };
  });
}

export function settleRuntimeBatchDirectiveExecution(
  agentDir: string,
  input: {
    executionId: string; dispatchToken: string; outcome: "completed" | "failed" | "cancelled";
    timestamp: string; visibleText?: string; failureCode?: RuntimeBatchDirectiveFailureCode; failureReason?: string;
  },
): RuntimeBatchDirectiveExecutionResult {
  let changed = false;
  let selected: RuntimeBatchDirectiveExecution | undefined;
  const snapshot = updateRuntimeStatus(agentDir, current => {
    const located = current.batchCommits.flatMap(commit => commit.executions || []).find(
      execution => execution.executionId === input.executionId,
    );
    if (!located || located.dispatchToken !== input.dispatchToken || located.state !== "running") return current;
    const queueIndex = exactQueueIndex(current, located);
    const requestIndex = current.requests.findIndex(item => item.requestId === located.requestId);
    if (queueIndex < 0 || requestIndex < 0) return current;
    const visibleText = input.visibleText?.trim();
    const failureCode = input.outcome === "failed" ? input.failureCode || "execution_error"
      : input.outcome === "cancelled" ? input.failureCode || "session_retired" : undefined;
    selected = {
      ...located, state: input.outcome, settledAt: input.timestamp, dispatchLeaseUntil: undefined,
      failureCode, failureReason: failureCode ? input.failureReason : undefined,
    };
    changed = true;
    return {
      ...current, updatedAt: input.timestamp,
      batchCommits: current.batchCommits.map(commit => ({
        ...commit, executions: commit.executions?.map(execution =>
          execution.executionId === input.executionId ? selected! : execution),
      })),
      inputQueue: current.inputQueue.map((item, index) => index !== queueIndex ? item : {
        ...item, status: input.outcome === "completed" ? "answered" as const : "failed" as const,
        answeredAt: input.outcome === "completed" ? input.timestamp : item.answeredAt,
        hasVisibleReply: input.outcome === "completed" ? Boolean(visibleText) : item.hasVisibleReply,
        failureReason: input.outcome === "completed" ? undefined : input.failureReason || failureCode,
      }),
      requests: current.requests.map((request, index) => index !== requestIndex ? request : {
        ...request, status: input.outcome === "completed" ? "answered" as const : "failed" as const,
        answeredAt: input.outcome === "completed" ? input.timestamp : request.answeredAt,
        hasVisibleReply: input.outcome === "completed" ? Boolean(visibleText) : request.hasVisibleReply,
        failureReason: input.outcome === "completed" ? undefined : input.failureReason || failureCode,
        updatedAt: input.timestamp,
      }),
    };
  });
  return { snapshot, execution: selected || snapshot.batchCommits.flatMap(item => item.executions || [])
    .find(item => item.executionId === input.executionId), changed };
}

export function releaseExpiredRuntimeBatchDirectiveExecutions(
  agentDir: string, timestamp = new Date().toISOString(),
): { snapshot: RuntimeStatusSnapshot; changed: boolean; executionIds: string[] } {
  if (!validTimestamp(timestamp)) throw new Error("Runtime batch execution release requires a valid timestamp.");
  const released: string[] = [];
  const snapshot = updateRuntimeStatus(agentDir, current => {
    let next = current;
    const candidates = current.batchCommits.flatMap(commit => commit.executions || []).filter(execution =>
      execution.state === "dispatching" && Boolean(execution.dispatchLeaseUntil) &&
      Date.parse(execution.dispatchLeaseUntil!) <= Date.parse(timestamp),
    );
    for (const execution of candidates) {
      const result = releaseDispatchingClaim(next, {
        executionId: execution.executionId, timestamp, expiredOnly: true,
      });
      if (!result.changed) continue;
      next = result.snapshot;
      released.push(execution.executionId);
    }
    return next;
  });
  return { snapshot, changed: released.length > 0, executionIds: released };
}
