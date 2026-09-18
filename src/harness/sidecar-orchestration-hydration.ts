/**
 * =============================================================================
 * Canvast — Sidecar Hydration Invariants / Sidecar 恢复不变量
 * =============================================================================
 * @file        src/harness/sidecar-orchestration-hydration.ts
 * @brief       Validates durable FIFO ownership before runtime hydration.
 * @description Rejects the complete persisted root when queue order, active
 *              ownership, or sidecar phases cannot represent one FIFO state.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import type {
  DurableOrchestrationRequest,
  DurableSidecarOrchestrationState,
} from "./sidecar-orchestration-state.js";

const RUNNABLE_HEAD_PHASES = new Set(["active", "answering"]);

export function validatePersistedSidecarFifo(
  state: DurableSidecarOrchestrationState,
  requests: ReadonlyMap<string, DurableOrchestrationRequest>,
): string[] {
  const expected = state.requests
    .filter(request => request.kind === "sidecar" && request.phase !== "completed")
    .map(request => request.requestId);
  const queue = state.openSidecarRequestIds;
  if (
    queue.length !== expected.length ||
    queue.some((requestId, index) => requestId !== expected[index])
  ) {
    throw new Error("persisted sidecar queue must exactly match unfinished sidecars in FIFO order");
  }
  if (queue.length === 0) {
    if (state.activeRequestId && requests.get(state.activeRequestId)?.kind === "sidecar") {
      throw new Error("persisted active sidecar is absent from the open queue");
    }
    return [];
  }
  if (state.activeRequestId !== queue[0]) {
    throw new Error("persisted active request must own the FIFO head sidecar");
  }
  for (let index = 0; index < queue.length; index += 1) {
    const request = requests.get(queue[index]);
    if (!request || request.kind !== "sidecar") {
      throw new Error("persisted sidecar queue references an invalid request");
    }
    if (index === 0 && !RUNNABLE_HEAD_PHASES.has(request.phase)) {
      throw new Error("persisted FIFO head sidecar must be runnable");
    }
    if (index > 0 && request.phase !== "waiting") {
      throw new Error("persisted non-head sidecars must be waiting");
    }
  }
  return [...queue];
}
