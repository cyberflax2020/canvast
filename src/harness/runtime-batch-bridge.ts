/**
 * =============================================================================
 * Canvast — Runtime Batch Decision Bridge / 运行时批量决策桥
 * =============================================================================
 * @file        src/harness/runtime-batch-bridge.ts
 * @brief       Typed in-process bridge between harness decisions and the TUI
 *              request coordinator without depending on extension load order.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import type { RecordedOrchestrationDecision } from "./auto-orchestrator/types.js";
import type { ReevaluateCheckpoint } from "./context-continuity/runtime-queue.js";
import type { OrchestrationBatchCandidate } from "./auto-orchestrator/batch-admission.js";

export interface RuntimeBatchStage {
  batchId: string;
  revision: number;
  checkpoint: ReevaluateCheckpoint;
  candidateHash: string;
  candidates: Array<OrchestrationBatchCandidate & {
    text: string;
    policy: string;
    deferAttemptCount: number;
  }>;
}

export interface RuntimeBatchDecisionConsumer {
  applyDecision(decision: RecordedOrchestrationDecision): void;
  safeCheckpoint(checkpoint: ReevaluateCheckpoint): boolean;
}

// Scope identity is the bridge boundary: separate ExtensionAPI wrappers can
// communicate only when their callers pass the same shared object (pi.events).
// Scope 对象身份是桥接边界：不同 ExtensionAPI wrapper 只有在调用方传入同一个
// 共享对象（pi.events）时才能互通。
const consumers = new WeakMap<object, RuntimeBatchDecisionConsumer>();
const stages = new WeakMap<object, RuntimeBatchStage>();

export function runtimeBatchEventScope(api: { events?: unknown }): object | undefined {
  const events = api.events;
  return events !== null && (typeof events === "object" || typeof events === "function")
    ? events as object
    : undefined;
}

export function stageRuntimeBatch(scope: object, stage: RuntimeBatchStage): boolean {
  const current = stages.get(scope);
  if (current) return false;
  stages.set(scope, structuredClone(stage));
  return true;
}

export function inspectRuntimeBatchStage(scope: object): RuntimeBatchStage | undefined {
  const stage = stages.get(scope);
  return stage ? structuredClone(stage) : undefined;
}

export function clearRuntimeBatchStage(scope: object, batchId: string): boolean {
  const current = stages.get(scope);
  if (!current || current.batchId !== batchId) return false;
  stages.delete(scope);
  return true;
}

export function registerRuntimeBatchDecisionConsumer(
  scope: object,
  consumer: RuntimeBatchDecisionConsumer,
): () => void {
  consumers.set(scope, consumer);
  return () => { if (consumers.get(scope) === consumer) consumers.delete(scope); };
}

export function publishRuntimeBatchDecision(
  scope: object,
  decision: RecordedOrchestrationDecision,
): boolean {
  const stage = stages.get(scope);
  if (stage) {
    const plan = decision.batchPlan;
    if (!plan || plan.batchId !== stage.batchId || plan.revision !== stage.revision ||
        plan.checkpoint !== stage.checkpoint || plan.candidateHash !== stage.candidateHash) return false;
  } else if (decision.batchPlan) {
    return false;
  }
  const consumer = consumers.get(scope);
  if (!consumer) return decision.batchPlan === undefined;
  consumer.applyDecision(decision);
  if (decision.batchPlan) clearRuntimeBatchStage(scope, decision.batchPlan.batchId);
  return true;
}

export function publishRuntimeSafeCheckpoint(
  scope: object,
  checkpoint: ReevaluateCheckpoint,
): boolean {
  const consumer = consumers.get(scope);
  if (!consumer) return false;
  return consumer.safeCheckpoint(checkpoint);
}
