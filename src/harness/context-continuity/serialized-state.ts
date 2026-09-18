/**
 * =============================================================================
 * Canvast — Serialized State / Canvast source file
 * =============================================================================
 * @file        src/harness/context-continuity/serialized-state.ts
 * @brief       Serializes revisioned state updates behind a per-file lock.
 * @description Prevents concurrent read-reduce-write dispatches from
 *              overwriting each other across processes while keeping the
 *              reducer itself pure and deterministic.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import { withOwnedFileLock } from "./filesystem.js";

export interface RevisionedStateLike {
  revision: number;
}

export interface SerializedStateIO<TState extends RevisionedStateLike> {
  targetFile: string;
  readStored: () => unknown | undefined;
  writeStored: (state: TState) => void;
  normalize: (value: unknown, now: string) => TState;
  emptyState: (input: { now: string }) => TState;
}

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 10;
function isRevisionedState(value: unknown): value is RevisionedStateLike {
  return typeof value === "object" && value !== null && Number.isFinite((value as RevisionedStateLike).revision);
}

function withSerializedFileLock<T>(targetFile: string, work: () => T): T {
  return withOwnedFileLock(targetFile, { timeoutMs: LOCK_TIMEOUT_MS, retryMs: LOCK_RETRY_MS }, work);
}

function currentStoredRevision<TState extends RevisionedStateLike>(io: SerializedStateIO<TState>): number {
  const stored = io.readStored();
  return isRevisionedState(stored) ? stored.revision : -1;
}

export function readSerializedState<TState extends RevisionedStateLike>(io: SerializedStateIO<TState>): TState {
  const now = new Date().toISOString();
  const stored = io.readStored();
  if (stored === undefined) return io.emptyState({ now });
  try {
    return io.normalize(stored, now);
  } catch {
    return io.emptyState({ now });
  }
}

export function writeSerializedState<TState extends RevisionedStateLike>(state: TState, io: SerializedStateIO<TState>): void {
  withSerializedFileLock(io.targetFile, () => io.writeStored(state));
}

export function dispatchSerializedStateUpdate<
  TState extends RevisionedStateLike,
  TEvent extends { timestamp: string },
  TTransition extends { state: TState; duplicate: boolean },
>(
  event: TEvent,
  io: SerializedStateIO<TState> & { reduce: (state: TState, event: TEvent) => TTransition },
): TTransition {
  return withSerializedFileLock(io.targetFile, () => {
    while (true) {
      const stored = io.readStored();
      const expectedRevision = isRevisionedState(stored) ? stored.revision : -1;
      const current = stored === undefined ? io.emptyState({ now: event.timestamp }) : io.normalize(stored, event.timestamp);
      const transition = io.reduce(current, event);
      if (transition.duplicate) return transition;
      if (currentStoredRevision(io) !== expectedRevision) continue;
      io.writeStored(transition.state);
      return transition;
    }
  });
}
