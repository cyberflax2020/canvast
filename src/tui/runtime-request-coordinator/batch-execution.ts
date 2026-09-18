/**
 * =============================================================================
 * Canvast — Runtime Batch Execution Delivery / 运行时批执行投递
 * =============================================================================
 * @file        src/tui/runtime-request-coordinator/batch-execution.ts
 * @brief       Consumes committed parallel and serial directives exactly once.
 * @description Owns durable dispatch claims and receiver-side deduplication;
 *              transport delivery itself remains at-least-once.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import { createHash, randomUUID } from "node:crypto";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ReevaluateCheckpoint } from "../../harness/context-continuity/runtime-queue.js";
import type {
  RuntimeBatchDirectiveExecution,
  RuntimeBatchExecutionDirective,
  RuntimeBatchTransitionReceipt,
} from "../../harness/runtime-batch-commit.js";
import { runtimeBatchInputPayloadDigest } from "../../harness/runtime-batch-commit.js";
import { readRuntimeInputPayload } from "../../harness/runtime-input-payload.js";
import {
  acceptRuntimeBatchDirectiveExecution,
  claimRuntimeBatchDirectiveExecution,
  readRuntimeStatus,
  recordRuntimeEvent,
  releaseExpiredRuntimeBatchDirectiveExecutions,
  releaseRuntimeBatchDirectiveExecution,
  settleRuntimeBatchDirectiveExecution,
  startRuntimeBatchDirectiveExecution,
} from "../../harness/runtime-status.js";

export const RUNTIME_BATCH_EXECUTION_MESSAGE_TYPE = "canvast-runtime-batch-execution/v1";
const DISPATCH_LEASE_MS = 30_000;

interface RuntimeBatchExecutionBinding {
  executionId: string;
  batchId: string;
  directiveId: string;
  requestId: string;
  sequence: number;
  timestamp: string;
  payloadDigest: string;
  schedulingMode: "parallel" | "serial";
}

interface RuntimeBatchExecutionEnvelope {
  type: typeof RUNTIME_BATCH_EXECUTION_MESSAGE_TYPE;
  dispatchId: string;
  dispatchToken: string;
  checkpoint?: ReevaluateCheckpoint;
  executions: RuntimeBatchExecutionBinding[];
}

interface ActiveExecutionEnvelope extends RuntimeBatchExecutionEnvelope {
  acceptedExecutionIds: string[];
}

function binding(execution: RuntimeBatchDirectiveExecution): RuntimeBatchExecutionBinding {
  return {
    executionId: execution.executionId, batchId: execution.batchId,
    directiveId: execution.directiveId, requestId: execution.requestId,
    sequence: execution.sequence, timestamp: execution.timestamp, payloadDigest: execution.payloadDigest,
    schedulingMode: execution.schedulingMode,
  };
}

function sameBinding(left: RuntimeBatchExecutionBinding, right: RuntimeBatchDirectiveExecution): boolean {
  return left.executionId === right.executionId && left.batchId === right.batchId &&
    left.directiveId === right.directiveId && left.requestId === right.requestId &&
    left.sequence === right.sequence && left.timestamp === right.timestamp &&
    left.payloadDigest === right.payloadDigest &&
    left.schedulingMode === right.schedulingMode;
}

function parseEnvelope(message: any): RuntimeBatchExecutionEnvelope | undefined {
  if (message?.role !== "custom" || message?.customType !== RUNTIME_BATCH_EXECUTION_MESSAGE_TYPE) return undefined;
  const details = message?.details;
  if (!details || details.type !== RUNTIME_BATCH_EXECUTION_MESSAGE_TYPE ||
      typeof details.dispatchId !== "string" || !details.dispatchId ||
      typeof details.dispatchToken !== "string" || !details.dispatchToken ||
      !Array.isArray(details.executions) || details.executions.length === 0) return undefined;
  const executions: RuntimeBatchExecutionBinding[] = [];
  const ids = new Set<string>();
  for (const item of details.executions) {
    if (!item || typeof item !== "object" || typeof item.executionId !== "string" ||
        !item.executionId || ids.has(item.executionId) || typeof item.batchId !== "string" ||
        typeof item.directiveId !== "string" || typeof item.requestId !== "string" ||
        !Number.isSafeInteger(item.sequence) || typeof item.timestamp !== "string" ||
        typeof item.payloadDigest !== "string" || !item.payloadDigest ||
        !Number.isFinite(Date.parse(item.timestamp)) ||
        (item.schedulingMode !== "parallel" && item.schedulingMode !== "serial")) return undefined;
    ids.add(item.executionId);
    executions.push({
      executionId: item.executionId, batchId: item.batchId, directiveId: item.directiveId,
      requestId: item.requestId, sequence: item.sequence, timestamp: item.timestamp,
      payloadDigest: item.payloadDigest,
      schedulingMode: item.schedulingMode,
    });
  }
  return {
    type: RUNTIME_BATCH_EXECUTION_MESSAGE_TYPE, dispatchId: details.dispatchId,
    dispatchToken: details.dispatchToken, checkpoint: details.checkpoint, executions,
  };
}

function allExecutions(agentDir: string): RuntimeBatchDirectiveExecution[] {
  return readRuntimeStatus(agentDir).batchCommits.flatMap(commit => commit.executions || []);
}

function executionDirective(agentDir: string, execution: RuntimeBatchDirectiveExecution): RuntimeBatchExecutionDirective | undefined {
  const commit = readRuntimeStatus(agentDir).batchCommits.find(item => item.batchId === execution.batchId);
  return commit?.receipt.directives?.find(item => item.id === execution.directiveId);
}

function dispatchIdFor(executions: RuntimeBatchDirectiveExecution[]): string {
  return `batch-dispatch-${createHash("sha256").update(executions.map(item => item.executionId).join("\n")).digest("hex").slice(0, 24)}`;
}

function exactInputContent(agentDir: string, execution: RuntimeBatchDirectiveExecution): any[] | undefined {
  const snapshot = readRuntimeStatus(agentDir);
  const item = snapshot.inputQueue.find(candidate => candidate.id === execution.directiveId &&
    candidate.requestId === execution.requestId && candidate.sequence === execution.sequence &&
    candidate.timestamp === execution.timestamp);
  if (!item) return undefined;
  if (runtimeBatchInputPayloadDigest(item) !== execution.payloadDigest) return undefined;
  if (!item.payload) return item.textSummary.trim() ? [{ type: "text", text: item.textSummary }] : undefined;
  try {
    const payload = readRuntimeInputPayload(agentDir, item.payload, snapshot.continuity.projectId && snapshot.continuity.sessionId
      ? { projectId: snapshot.continuity.projectId, sessionId: snapshot.continuity.sessionId } : undefined);
    return payload.parts.map(part => part.kind === "text"
      ? { type: "text", text: part.text }
      : { type: "image", data: part.bytes.toString("base64"), mimeType: part.mimeType });
  } catch {
    return undefined;
  }
}

function safeBranch(execution: RuntimeBatchDirectiveExecution): boolean {
  const evidence = execution.branchEvidence;
  return Boolean(evidence && evidence.selfContained && evidence.primaryDependency !== "live" &&
    evidence.dependsOnBranchIds.length === 0);
}

function belongsToReceipt(
  execution: RuntimeBatchDirectiveExecution, receipt: RuntimeBatchTransitionReceipt,
): boolean {
  if (execution.batchId !== receipt.batchId) return false;
  const directive = receipt.directives?.find(item => item.id === execution.directiveId &&
    item.requestId === execution.requestId && item.sequence === execution.sequence);
  const manifest = receipt.manifest.find(item => item.id === execution.directiveId &&
    item.requestId === execution.requestId && item.sequence === execution.sequence &&
    item.timestamp === execution.timestamp && item.payloadDigest === execution.payloadDigest);
  return Boolean(directive && manifest);
}

export class RuntimeBatchExecutionCoordinator {
  private active: ActiveExecutionEnvelope | undefined;
  private readonly admitted = new Set<string>();

  constructor(private readonly pi: ExtensionAPI, private readonly agentDir: () => string) {}

  consumeCommittedReceipt(receipt: RuntimeBatchTransitionReceipt): boolean {
    return this.dispatchReady("parallel", undefined, undefined, receipt);
  }

  recoverPending(): boolean {
    for (const execution of allExecutions(this.agentDir()).filter(item =>
      item.state === "accepted" || item.state === "running",
    )) {
      const dispatchToken = execution.dispatchToken;
      if (!dispatchToken) continue;
      if (execution.state === "accepted") {
        startRuntimeBatchDirectiveExecution(this.agentDir(), {
          executionId: execution.executionId, dispatchToken, timestamp: new Date().toISOString(),
        });
      }
      settleRuntimeBatchDirectiveExecution(this.agentDir(), {
        executionId: execution.executionId, dispatchToken, outcome: "failed",
        failureCode: "execution_error",
        failureReason: "Runtime reloaded before batch execution produced a visible reply.",
        timestamp: new Date().toISOString(),
      });
    }
    releaseExpiredRuntimeBatchDirectiveExecutions(this.agentDir());
    return this.dispatchReady("parallel");
  }

  onCheckpoint(checkpoint: ReevaluateCheckpoint, settledRootRequestId?: string): boolean {
    return this.dispatchReady("serial", checkpoint, settledRootRequestId);
  }

  private ready(
    mode: "parallel" | "serial", checkpoint?: ReevaluateCheckpoint, settledRootRequestId?: string,
    receipt?: RuntimeBatchTransitionReceipt,
  ): RuntimeBatchDirectiveExecution[] {
    const executions = allExecutions(this.agentDir()).filter(item => item.state === "pending" &&
      item.schedulingMode === mode && (!receipt || belongsToReceipt(item, receipt)));
    if (mode === "parallel") return executions.filter(safeBranch);
    return executions.filter(item => {
      const directive = executionDirective(this.agentDir(), item);
      return Boolean(settledRootRequestId && item.targetRootRequestId === settledRootRequestId &&
        checkpoint && directive?.nextCheckpoint === checkpoint);
    }).sort((left, right) => left.sequence - right.sequence || left.executionId.localeCompare(right.executionId)).slice(0, 1);
  }

  private failUnsafeParallel(receipt?: RuntimeBatchTransitionReceipt): void {
    for (const execution of allExecutions(this.agentDir()).filter(item =>
      item.state === "pending" && item.schedulingMode === "parallel" &&
      (!receipt || belongsToReceipt(item, receipt)) && !safeBranch(item),
    )) {
      const claimed = claimRuntimeBatchDirectiveExecution(this.agentDir(), {
        executionId: execution.executionId, dispatchToken: `rejected-${randomUUID()}`,
        timestamp: new Date().toISOString(), leaseUntil: new Date(Date.now() + DISPATCH_LEASE_MS).toISOString(),
      });
      if (!claimed.changed || !claimed.execution?.dispatchToken) continue;
      acceptRuntimeBatchDirectiveExecution(this.agentDir(), {
        executionId: execution.executionId, dispatchToken: claimed.execution.dispatchToken, timestamp: new Date().toISOString(),
      });
      startRuntimeBatchDirectiveExecution(this.agentDir(), {
        executionId: execution.executionId, dispatchToken: claimed.execution.dispatchToken, timestamp: new Date().toISOString(),
      });
      settleRuntimeBatchDirectiveExecution(this.agentDir(), {
        executionId: execution.executionId, dispatchToken: claimed.execution.dispatchToken, outcome: "failed",
        failureCode: "missing_unsafe_execution_evidence",
        failureReason: "Parallel execution requires complete typed branch isolation evidence.",
        timestamp: new Date().toISOString(),
      });
    }
  }

  private dispatchReady(
    mode: "parallel" | "serial", checkpoint?: ReevaluateCheckpoint, settledRootRequestId?: string,
    receipt?: RuntimeBatchTransitionReceipt,
  ): boolean {
    if (mode === "parallel") this.failUnsafeParallel(receipt);
    const candidates = this.ready(mode, checkpoint, settledRootRequestId, receipt);
    if (candidates.length === 0) return false;
    const dispatchToken = randomUUID();
    const now = new Date();
    const claimed: RuntimeBatchDirectiveExecution[] = [];
    for (const candidate of candidates) {
      const result = claimRuntimeBatchDirectiveExecution(this.agentDir(), {
        executionId: candidate.executionId, dispatchToken, timestamp: now.toISOString(),
        leaseUntil: new Date(now.getTime() + DISPATCH_LEASE_MS).toISOString(),
        settledRootRequestId, checkpoint,
      });
      if (result.changed && result.execution) claimed.push(result.execution);
    }
    if (claimed.length === 0) return false;
    const directives = claimed.map(item => executionDirective(this.agentDir(), item));
    const inputContent = claimed.map(item => exactInputContent(this.agentDir(), item));
    if (directives.some(item => !item) || inputContent.some(item => !item)) {
      for (const execution of claimed) {
        acceptRuntimeBatchDirectiveExecution(this.agentDir(), {
          executionId: execution.executionId, dispatchToken, timestamp: new Date().toISOString(),
        });
        startRuntimeBatchDirectiveExecution(this.agentDir(), {
          executionId: execution.executionId, dispatchToken, timestamp: new Date().toISOString(),
        });
        settleRuntimeBatchDirectiveExecution(this.agentDir(), {
          executionId: execution.executionId, dispatchToken, outcome: "failed",
          failureCode: "exact_input_unavailable", failureReason: "Exact committed input payload is unavailable.",
          timestamp: new Date().toISOString(),
        });
      }
      return false;
    }
    const details: RuntimeBatchExecutionEnvelope = {
      type: RUNTIME_BATCH_EXECUTION_MESSAGE_TYPE, dispatchId: dispatchIdFor(claimed),
      dispatchToken, checkpoint, executions: claimed.map(binding),
    };
    try {
      this.pi.sendMessage({
        customType: RUNTIME_BATCH_EXECUTION_MESSAGE_TYPE, display: false, details,
        content: [
          { type: "text", text: [
            "# Canvast Committed Batch Execution",
            `dispatch_id=${details.dispatchId}`,
            `mode=${mode}`,
            "Execute only the exact committed inputs below. Preserve each identity and do not repeat completed evidence or external work.",
          ].join("\n") },
          { type: "text", text: JSON.stringify(directives) },
          ...inputContent.flatMap((parts, index) => [
            { type: "text", text: `## Execution ${index + 1}\nexecution_id=${claimed[index].executionId}\nrequest_id=${claimed[index].requestId}` },
            ...parts!,
          ]),
        ] as any,
      }, { triggerTurn: true, deliverAs: mode === "parallel" ? "steer" : "followUp" });
      return true;
    } catch (error) {
      for (const execution of claimed) {
        releaseRuntimeBatchDirectiveExecution(this.agentDir(), {
          executionId: execution.executionId, dispatchToken, timestamp: new Date().toISOString(),
        });
      }
      recordRuntimeEvent(this.agentDir(), {
        kind: "input_batch", title: "Runtime batch execution dispatch failed",
        summary: error instanceof Error ? error.message : String(error), source: mode,
      });
      return false;
    }
  }

  onContext(messages: any[]): any[] {
    const seen = new Set<string>();
    return messages.filter(message => {
      const envelope = parseEnvelope(message);
      if (!envelope) return true;
      if (seen.has(envelope.dispatchId) || this.admitted.has(envelope.dispatchId)) return false;
      const current = allExecutions(this.agentDir());
      const exact = envelope.executions.every(item => {
        const execution = current.find(candidate => candidate.executionId === item.executionId);
        return execution && sameBinding(item, execution) && execution.state === "dispatching" &&
          execution.dispatchToken === envelope.dispatchToken;
      });
      if (!exact) return false;
      seen.add(envelope.dispatchId);
      return true;
    });
  }

  onMessageStart(message: any): boolean {
    const envelope = parseEnvelope(message);
    if (!envelope) return false;
    if (this.admitted.has(envelope.dispatchId)) return true;
    const acceptedExecutionIds: string[] = [];
    for (const item of envelope.executions) {
      const execution = allExecutions(this.agentDir()).find(candidate => candidate.executionId === item.executionId);
      if (!execution || !sameBinding(item, execution)) continue;
      const result = acceptRuntimeBatchDirectiveExecution(this.agentDir(), {
        executionId: item.executionId, dispatchToken: envelope.dispatchToken, timestamp: new Date().toISOString(),
      });
      if (result.changed) acceptedExecutionIds.push(item.executionId);
    }
    if (acceptedExecutionIds.length === 0) return true;
    this.admitted.add(envelope.dispatchId);
    this.active = { ...envelope, acceptedExecutionIds };
    return true;
  }

  onAssistantStart(): boolean {
    if (!this.active) return false;
    for (const executionId of this.active.acceptedExecutionIds) {
      startRuntimeBatchDirectiveExecution(this.agentDir(), {
        executionId, dispatchToken: this.active.dispatchToken, timestamp: new Date().toISOString(),
      });
    }
    return true;
  }

  onFinalVisibleReply(visibleText: string): boolean {
    if (!this.active || !visibleText.trim()) return false;
    const active = this.active;
    const completed = active.acceptedExecutionIds.map(executionId =>
      allExecutions(this.agentDir()).find(execution => execution.executionId === executionId),
    );
    for (const executionId of active.acceptedExecutionIds) {
      settleRuntimeBatchDirectiveExecution(this.agentDir(), {
        executionId, dispatchToken: active.dispatchToken, outcome: "completed",
        timestamp: new Date().toISOString(), ...( { visibleText } as any ),
      });
    }
    this.admitted.delete(active.dispatchId);
    this.active = undefined;
    const completedSerial = completed.find(execution => execution?.schedulingMode === "serial");
    if (completedSerial && active.checkpoint && completedSerial.targetRootRequestId) {
      this.dispatchReady("serial", active.checkpoint, completedSerial.targetRootRequestId);
    }
    return true;
  }

  onRunEnd(_failed: boolean): void {
    if (!this.active) return;
    const active = this.active;
    for (const executionId of active.acceptedExecutionIds) {
      startRuntimeBatchDirectiveExecution(this.agentDir(), {
        executionId, dispatchToken: active.dispatchToken, timestamp: new Date().toISOString(),
      });
      settleRuntimeBatchDirectiveExecution(this.agentDir(), {
        executionId, dispatchToken: active.dispatchToken, outcome: "failed",
        failureCode: "execution_error", failureReason: "Batch execution run ended before a visible reply.",
        timestamp: new Date().toISOString(),
      });
    }
    this.admitted.delete(active.dispatchId);
    this.active = undefined;
  }

  reset(): void {
    this.active = undefined;
    this.admitted.clear();
  }
}
