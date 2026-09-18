/**
 * =============================================================================
 * Canvast — Runtime Live Projection / Canvast source file
 * =============================================================================
 * @file        src/tui/runtime-live-projection.ts
 * @brief       Separates current-session runtime work from persisted history.
 * @description Runtime status is append-oriented. TUI live surfaces therefore
 *              require an exact session + root identity before showing work as
 *              current; everything else remains available as explicit history.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import { isRuntimeInputQueuePending } from "../harness/context-continuity.js";
import type {
  RuntimeStatusItem,
  RuntimeStatusSnapshot,
} from "../harness/runtime-status.js";

export interface RuntimeLiveIdentity {
  rootRequestId: string;
  sessionId: string;
}

export interface RuntimeLiveProjection {
  identity?: RuntimeLiveIdentity;
  tasks: RuntimeStatusItem[];
  plans: RuntimeStatusItem[];
  subAgents: RuntimeStatusItem[];
  workflows: RuntimeStatusItem[];
  toolRuns: RuntimeStatusItem[];
  inputQueue: RuntimeStatusSnapshot["inputQueue"];
  requests: RuntimeStatusSnapshot["requests"];
}

export function isCurrentRuntimeItemStatus(status: RuntimeStatusItem["status"]): boolean {
  return status === "pending" ||
    status === "in_progress" ||
    status === "running" ||
    status === "blocked";
}

export function runtimeLiveIdentity(
  snapshot: RuntimeStatusSnapshot,
  currentSessionId?: string,
): RuntimeLiveIdentity | undefined {
  const rootRequestId = snapshot.rootExecution.rootRequestId;
  const sessionId = snapshot.rootExecution.sessionId;
  const observedSessionId = currentSessionId || snapshot.continuity.sessionId;
  if (!rootRequestId || !sessionId) return undefined;
  if (snapshot.rootExecution.state === "idle" || snapshot.rootExecution.state === "done") return undefined;
  if (observedSessionId && observedSessionId !== sessionId) return undefined;
  return { rootRequestId, sessionId };
}

function projectItems(
  items: RuntimeStatusItem[],
  identity: RuntimeLiveIdentity | undefined,
): RuntimeStatusItem[] {
  if (!identity) return [];
  return items.filter(item =>
    isCurrentRuntimeItemStatus(item.status) &&
    item.rootRequestId === identity.rootRequestId &&
    item.sessionId === identity.sessionId,
  );
}

function requestIdsForRoot(
  snapshot: RuntimeStatusSnapshot,
  identity: RuntimeLiveIdentity | undefined,
): Set<string> {
  if (!identity) return new Set();
  const requestIds = new Set([identity.rootRequestId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const request of snapshot.requests) {
      if (!requestIds.has(request.requestId) && request.parentRequestId && requestIds.has(request.parentRequestId)) {
        requestIds.add(request.requestId);
        changed = true;
      }
    }
  }
  return requestIds;
}

export function projectRuntimeLive(
  snapshot: RuntimeStatusSnapshot,
  currentSessionId?: string,
): RuntimeLiveProjection {
  const identity = runtimeLiveIdentity(snapshot, currentSessionId);
  const requestIds = requestIdsForRoot(snapshot, identity);
  return {
    identity,
    tasks: projectItems(snapshot.tasks, identity),
    plans: projectItems(snapshot.plans, identity),
    subAgents: projectItems(snapshot.subAgents, identity),
    workflows: projectItems(snapshot.workflows, identity),
    toolRuns: projectItems(snapshot.toolRuns, identity),
    inputQueue: identity
      ? snapshot.inputQueue.filter(item =>
          isRuntimeInputQueuePending(item) &&
          Boolean(item.requestId && requestIds.has(item.requestId)),
        )
      : [],
    requests: identity
      ? snapshot.requests.filter(request => requestIds.has(request.requestId))
      : [],
  };
}

export function projectRuntimeLiveSnapshot(
  snapshot: RuntimeStatusSnapshot,
  currentSessionId?: string,
): RuntimeStatusSnapshot {
  const live = projectRuntimeLive(snapshot, currentSessionId);
  if (live.identity) {
    return {
      ...snapshot,
      tasks: live.tasks,
      plans: live.plans,
      subAgents: live.subAgents,
      workflows: live.workflows,
      toolRuns: live.toolRuns,
      inputQueue: live.inputQueue,
      requests: live.requests,
    };
  }
  return {
    ...snapshot,
    tasks: [],
    plans: [],
    subAgents: [],
    workflows: [],
    toolRuns: [],
    inputQueue: [],
    requests: [],
    continuity: {
      ...snapshot.continuity,
      phase: "idle",
      requestId: undefined,
      turnId: undefined,
      pendingContinuationCount: 0,
      recoverable: false,
      recoveryMessage: undefined,
    },
    rootExecution: {
      ...snapshot.rootExecution,
      state: "idle",
      reason: "not_started",
      rootRequestId: undefined,
      sessionId: undefined,
      settledRequestId: undefined,
      settlement: "pending",
      workingCount: 0,
      waitingCount: 0,
      blockedCount: 0,
    },
  };
}
