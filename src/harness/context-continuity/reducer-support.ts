/**
 * =============================================================================
 * Canvast — Reducer Support / Canvast source file
 * =============================================================================
 * @file        src/harness/context-continuity/reducer-support.ts
 * @brief       Shared helpers for compaction matching and state I/O wiring.
 * @description Keeps the main continuity reducer focused on transitions while
 *              moving compaction correlation helpers and serialized-state I/O
 *              binding into a small support module.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import type {
  ContextCompactionAttempt,
  ContextContinuityEvent,
  ContextContinuityRecovery,
  ContextContinuityState,
} from "../context-continuity.js";
import type { SerializedStateIO } from "./serialized-state.js";

import { contextContinuityFile, readStoredContextContinuity, writeStoredContextContinuity } from "./storage.js";

export function latestCompactionIndex(state: ContextContinuityState, operationId?: string): number {
  if (operationId) return state.compactions.findIndex(item => item.operationId === operationId);
  for (let index = state.compactions.length - 1; index >= 0; index -= 1) {
    if (state.compactions[index].turnId === state.activeTurn?.turnId) return index;
  }
  return -1;
}

export function activeTurnMatchesCompaction(
  state: ContextContinuityState,
  attempt: ContextCompactionAttempt | undefined,
): boolean {
  return Boolean(
    attempt &&
    state.activeTurn &&
    attempt.turnId === state.activeTurn.turnId &&
    state.activeTurn.sessionId === state.session.id,
  );
}

export function lateCompactionRecovery(
  state: ContextContinuityState,
  event: Extract<ContextContinuityEvent, { type: "compaction_succeeded" | "compaction_failed" }>,
  operationId: string,
): ContextContinuityRecovery {
  const action = event.type === "compaction_succeeded" ? "success" : "failure";
  const suffix = state.activeTurn
    ? "A newer active turn/session already exists, so this old compaction result was ignored."
    : "There is no active turn to advance, so this compaction result was ignored.";
  return {
    operationId,
    retryable: false,
    message: `Late compaction ${action} did not match the active session/turn/operation. ${suffix}`,
    availableActions: ["resume_same_turn", "reset_session"],
  };
}

export function contextContinuityStateIO(
  agentDir: string,
  normalize: (value: unknown, now: string) => ContextContinuityState,
  emptyState: (input: { now: string }) => ContextContinuityState,
): SerializedStateIO<ContextContinuityState> {
  return {
    targetFile: contextContinuityFile(agentDir),
    readStored: () => readStoredContextContinuity(agentDir),
    writeStored: (state: ContextContinuityState) => writeStoredContextContinuity(state, agentDir),
    normalize,
    emptyState,
  };
}
