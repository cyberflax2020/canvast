/**
 * =============================================================================
 * Canvast — Runtime Request Coordinator Types / 运行时请求协调器类型
 * =============================================================================
 * @file        src/tui/runtime-request-coordinator/types.ts
 * @brief       Exact request bindings and observable batch delivery receipts.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import type { ReevaluateCheckpoint } from "../../harness/context-continuity/runtime-queue.js";
import type { RuntimeRequestDeliveryScope } from "../../harness/runtime-status.js";

export interface RuntimeInputBinding {
  id: string;
  requestId: string;
  sequence: number;
  timestamp: string;
}

interface RuntimeBatchReceiptBase {
  batchId: string;
  revision: number;
  checkpoint: ReevaluateCheckpoint;
  candidateHash: string;
  items: RuntimeInputBinding[];
  timestamp: string;
}

export interface RuntimeBatchDispatchedReceipt extends RuntimeBatchReceiptBase {
  type: "canvast.runtime-batch-dispatched/v1";
}

export interface RuntimeBatchVisibleReplyReceipt extends RuntimeBatchReceiptBase {
  type: "canvast.runtime-batch-visible-reply/v1";
  visibleText: string;
}

export type RuntimeBatchReceipt = RuntimeBatchDispatchedReceipt | RuntimeBatchVisibleReplyReceipt;

export interface RuntimeRequestCoordinatorOptions {
  agentDir: () => string;
  projectId?: () => string;
  resolveDeliveryScope?: (input: { prompt: string; ctx: unknown; queued: boolean }) => RuntimeRequestDeliveryScope | undefined;
  /** Observable handoff for consumers that persist batch-to-visible-reply attribution. */
  onBatchReceipt?: (receipt: RuntimeBatchReceipt) => void;
}

export interface ResumeBinding {
  candidateId: string;
  claimToken?: string;
}

export interface ResumeDispatchResult {
  claimToken: string;
  candidateId: string;
  requestId: string;
  dispatched: boolean;
  dispatchId: string;
  revert(): void;
}

export interface PendingDelivery {
  binding: RuntimeInputBinding;
}

export type RuntimeInputTransform =
  | { action: "continue" }
  | { action: "transform"; text: string; images?: any[] };
