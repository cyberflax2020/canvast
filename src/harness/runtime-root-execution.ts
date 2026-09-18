/**
 * =============================================================================
 * Canvast — Runtime Root Execution / Canvast source file
 * =============================================================================
 * @file        src/harness/runtime-root-execution.ts
 * @brief       Typed aggregate projection for one durable root execution.
 * @description Reduces source-of-truth runtime planes into the single state
 *              consumed by the TUI and desktop app. Local lifecycle events
 *              may commit settlement evidence but cannot bypass open work.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import type { SupersedeMergeEvidence } from "./auto-orchestrator/types.js";

export type RuntimeRootExecutionState = "idle" | "working" | "waiting" | "blocked" | "done";
export type RuntimeRootSettlement = "pending" | "succeeded" | "failed" | "interrupted";
export type RuntimeRootExecutionReason =
  | "not_started"
  | "awaiting_agent_settlement"
  | "active_task"
  | "active_plan"
  | "active_child"
  | "active_workflow"
  | "active_tool"
  | "pending_task"
  | "pending_plan"
  | "pending_request"
  | "pending_input"
  | "pending_continuation"
  | "pending_resume"
  | "required_gate"
  | "continuity_recovery"
  | "batch_paused"
  | "batch_cancelled"
  | "agent_failed"
  | "agent_interrupted"
  | "completed";

type AggregateItemStatus =
  | "pending"
  | "in_progress"
  | "running"
  | "completed"
  | "blocked"
  | "failed"
  | "aborted"
  | "stale"
  | "unknown";

interface AggregateItem {
  id: string;
  status: AggregateItemStatus;
  required?: boolean;
  rootRequestId?: string;
  sessionId?: string;
}

interface AggregateInput {
  status: string;
}

interface AggregateRequest {
  requestId: string;
  parentRequestId?: string;
  kind: string;
  status: string;
}

interface AggregateContinuity {
  phase: string;
  requestId?: string;
  recoverable: boolean;
  pendingContinuationCount?: number;
}

interface AggregateResume {
  state: string;
  readyCandidateCount: number;
  candidates: Array<{
    requestId: string;
    disposition: string;
    validation?: { availability?: string };
  }>;
}

export interface RuntimeRootExecutionSource {
  updatedAt: string;
  tasks: AggregateItem[];
  plans: AggregateItem[];
  subAgents: AggregateItem[];
  workflows: AggregateItem[];
  toolRuns: AggregateItem[];
  inputQueue: AggregateInput[];
  requests: AggregateRequest[];
  continuity: AggregateContinuity;
  resume: AggregateResume;
}

export interface RuntimeRootExecution {
  version: 1;
  state: RuntimeRootExecutionState;
  reason: RuntimeRootExecutionReason;
  rootRequestId?: string;
  sessionId?: string;
  settledRequestId?: string;
  settlement: RuntimeRootSettlement;
  workingCount: number;
  waitingCount: number;
  blockedCount: number;
  batchControl?: RuntimeRootBatchControl;
  updatedAt: string;
}

export interface RuntimeRootBatchControl {
  policy: "supersede_merge" | "pause" | "cancel";
  batchId?: string;
  sourceRequestId: string;
  targetRootRequestId: string;
  targetTaskId?: string;
  reason: string;
  appliedAt: string;
  supersedeEvidence?: SupersedeMergeEvidence;
}

export type RuntimeRootExecutionEvent =
  | { type: "root_started"; requestId: string; sessionId?: string; timestamp: string }
  | {
      type: "agent_settled";
      requestId?: string;
      outcome: Exclude<RuntimeRootSettlement, "pending">;
      timestamp: string;
    }
  | { type: "root_reset"; timestamp: string }
  | {
      type: "batch_policy_applied";
      policy: RuntimeRootBatchControl["policy"];
      batchId?: string;
      sourceRequestId: string;
      targetRootRequestId: string;
      targetTaskId?: string;
      reason: string;
      timestamp: string;
      supersedeEvidence?: SupersedeMergeEvidence;
    };

interface AggregateCounts {
  working: number;
  waiting: number;
  blocked: number;
  workingReason?: RuntimeRootExecutionReason;
  waitingReason?: RuntimeRootExecutionReason;
  blockedReason?: RuntimeRootExecutionReason;
}

const ACTIVE_STATUSES = new Set<AggregateItemStatus>(["in_progress", "running"]);
const WAITING_STATUSES = new Set<AggregateItemStatus>(["pending"]);
const BLOCKED_STATUSES = new Set<AggregateItemStatus>(["blocked", "unknown"]);
const TERMINAL_FAILURE_STATUSES = new Set<AggregateItemStatus>(["failed", "aborted", "stale"]);
const OPEN_REQUEST_STATUSES = new Set(["queued", "delivered", "answering"]);
const OPEN_INPUT_STATUSES = new Set(["queued", "delivered", "interrupt"]);

export function emptyRuntimeRootExecution(timestamp: string): RuntimeRootExecution {
  return {
    version: 1,
    state: "idle",
    reason: "not_started",
    settlement: "pending",
    workingCount: 0,
    waitingCount: 0,
    blockedCount: 0,
    updatedAt: timestamp,
  };
}

function classifiedItems(
  items: AggregateItem[],
  rootRequestId: string | undefined,
  sessionId: string | undefined,
  reasons: {
    working: RuntimeRootExecutionReason;
    waiting: RuntimeRootExecutionReason;
    blocked: RuntimeRootExecutionReason;
  },
): AggregateCounts {
  const required = items.filter(item =>
    item.required !== false &&
    (sessionId
      ? item.rootRequestId === rootRequestId && item.sessionId === sessionId
      : !item.rootRequestId || item.rootRequestId === rootRequestId),
  );
  const working = required.filter(item => ACTIVE_STATUSES.has(item.status)).length;
  const waiting = required.filter(item => WAITING_STATUSES.has(item.status)).length;
  const blocked = required.filter(item =>
    BLOCKED_STATUSES.has(item.status) ||
    (TERMINAL_FAILURE_STATUSES.has(item.status) &&
      (item.required === true || Boolean(rootRequestId && item.rootRequestId === rootRequestId))),
  ).length;
  return {
    working,
    waiting,
    blocked,
    workingReason: working > 0 ? reasons.working : undefined,
    waitingReason: waiting > 0 ? reasons.waiting : undefined,
    blockedReason: blocked > 0 ? reasons.blocked : undefined,
  };
}

function mergeCounts(target: AggregateCounts, source: AggregateCounts): void {
  target.working += source.working;
  target.waiting += source.waiting;
  target.blocked += source.blocked;
  target.workingReason ||= source.workingReason;
  target.waitingReason ||= source.waitingReason;
  target.blockedReason ||= source.blockedReason;
}

function sourceCounts(
  source: RuntimeRootExecutionSource,
  rootRequestId?: string,
  sessionId?: string,
): AggregateCounts {
  const counts: AggregateCounts = { working: 0, waiting: 0, blocked: 0 };
  if (!rootRequestId) return { working: 0, waiting: 0, blocked: 0 };
  mergeCounts(counts, classifiedItems(
    source.tasks.filter(item => !rootRequestId || item.id !== "current-user-request"),
    rootRequestId,
    sessionId,
    { working: "active_task", waiting: "pending_task", blocked: "required_gate" },
  ));
  mergeCounts(counts, classifiedItems(
    source.plans.filter(item => !rootRequestId || item.id !== "session-runtime"),
    rootRequestId,
    sessionId,
    { working: "active_plan", waiting: "pending_plan", blocked: "required_gate" },
  ));
  mergeCounts(counts, classifiedItems(source.subAgents, rootRequestId, sessionId, {
    working: "active_child", waiting: "pending_request", blocked: "required_gate",
  }));
  mergeCounts(counts, classifiedItems(source.workflows, rootRequestId, sessionId, {
    working: "active_workflow", waiting: "pending_request", blocked: "required_gate",
  }));
  mergeCounts(counts, classifiedItems(source.toolRuns, rootRequestId, sessionId, {
    working: "active_tool", waiting: "pending_request", blocked: "required_gate",
  }));

  const pendingInputs = source.inputQueue.filter(item => OPEN_INPUT_STATUSES.has(item.status)).length;
  if (pendingInputs > 0) {
    counts.waiting += pendingInputs;
    counts.waitingReason ||= "pending_input";
  }

  for (const request of source.requests) {
    if (!OPEN_REQUEST_STATUSES.has(request.status)) continue;
    if (request.requestId === rootRequestId && request.kind === "primary") {
      counts.working += 1;
      counts.workingReason ||= "awaiting_agent_settlement";
    } else if (!rootRequestId || request.parentRequestId === rootRequestId) {
      counts.waiting += 1;
      counts.waitingReason ||= "pending_request";
    }
  }

  if (rootRequestId) {
    const pendingContinuations = Math.max(0, source.continuity.pendingContinuationCount || 0);
    if (pendingContinuations > 0) {
      counts.waiting += pendingContinuations;
      counts.waitingReason ||= "pending_continuation";
    }
    if (source.continuity.recoverable || source.continuity.phase === "recoverable_failure" ||
        source.continuity.phase === "interrupted") {
      counts.blocked += 1;
      counts.blockedReason ||= "continuity_recovery";
    } else if (source.continuity.phase === "compacting") {
      counts.working += 1;
      counts.workingReason ||= "awaiting_agent_settlement";
    } else if (source.continuity.phase === "awaiting_resume") {
      counts.waiting += 1;
      counts.waitingReason ||= "pending_continuation";
    }

    const rootResume = source.resume.candidates.find(candidate =>
      candidate.requestId === rootRequestId &&
      candidate.disposition !== "retired" && candidate.disposition !== "completed",
    );
    if (rootResume?.disposition === "running") {
      counts.working += 1;
      counts.workingReason ||= "pending_resume";
    } else if (rootResume?.disposition === "claimed" ||
               rootResume?.validation?.availability === "ready") {
      counts.waiting += 1;
      counts.waitingReason ||= "pending_resume";
    } else if (rootResume) {
      counts.blocked += 1;
      counts.blockedReason ||= "pending_resume";
    }
  }
  return counts;
}

function rootIdentity(
  source: RuntimeRootExecutionSource,
  current: RuntimeRootExecution,
): string | undefined {
  if (current.rootRequestId) return current.rootRequestId;
  if (source.continuity.requestId && source.continuity.phase !== "idle" &&
      source.continuity.phase !== "completed" && source.continuity.phase !== "interrupted") {
    return source.continuity.requestId;
  }
  return [...source.requests].reverse().find(request =>
    request.kind === "primary" && OPEN_REQUEST_STATUSES.has(request.status),
  )?.requestId;
}

function sameProjection(
  current: RuntimeRootExecution,
  next: Omit<RuntimeRootExecution, "updatedAt">,
): boolean {
  return current.version === next.version &&
    current.state === next.state &&
    current.reason === next.reason &&
    current.rootRequestId === next.rootRequestId &&
    current.sessionId === next.sessionId &&
    current.settledRequestId === next.settledRequestId &&
    current.settlement === next.settlement &&
    JSON.stringify(current.batchControl) === JSON.stringify(next.batchControl) &&
    current.workingCount === next.workingCount &&
    current.waitingCount === next.waitingCount &&
    current.blockedCount === next.blockedCount;
}

export function projectRuntimeRootExecution(
  source: RuntimeRootExecutionSource,
  current: RuntimeRootExecution,
  timestamp = source.updatedAt,
): RuntimeRootExecution {
  const rootRequestId = rootIdentity(source, current);
  const counts = sourceCounts(source, rootRequestId, current.sessionId);
  let state: RuntimeRootExecutionState;
  let reason: RuntimeRootExecutionReason;

  if (!rootRequestId) {
    if (counts.working > 0) {
      state = "working";
      reason = counts.workingReason || "active_task";
    } else if (counts.blocked > 0) {
      state = "blocked";
      reason = counts.blockedReason || "required_gate";
    } else if (counts.waiting > 0) {
      state = "waiting";
      reason = counts.waitingReason || "pending_request";
    } else {
      state = "idle";
      reason = "not_started";
    }
  } else if (current.batchControl?.policy === "cancel" &&
             current.batchControl.targetRootRequestId === rootRequestId) {
    state = "done";
    reason = "batch_cancelled";
  } else if (current.batchControl?.policy === "pause" &&
             current.batchControl.targetRootRequestId === rootRequestId) {
    state = "waiting";
    reason = "batch_paused";
  } else if (current.settlement === "failed") {
    state = "blocked";
    reason = "agent_failed";
  } else if (current.settlement === "interrupted") {
    state = "blocked";
    reason = "agent_interrupted";
  } else if (counts.working > 0) {
    state = "working";
    reason = counts.workingReason || "active_task";
  } else if (counts.blocked > 0) {
    state = "blocked";
    reason = counts.blockedReason || "required_gate";
  } else if (counts.waiting > 0) {
    state = "waiting";
    reason = counts.waitingReason || "pending_request";
  } else if (current.settlement === "succeeded" && current.settledRequestId === rootRequestId) {
    state = "done";
    reason = "completed";
  } else {
    state = "working";
    reason = "awaiting_agent_settlement";
  }

  const next: Omit<RuntimeRootExecution, "updatedAt"> = {
    version: 1,
    state,
    reason,
    rootRequestId,
    sessionId: current.sessionId,
    settledRequestId: current.settledRequestId,
    settlement: current.settlement,
    batchControl: current.batchControl,
    workingCount: counts.working,
    waitingCount: counts.waiting,
    blockedCount: counts.blocked,
  };
  return { ...next, updatedAt: sameProjection(current, next) ? current.updatedAt : timestamp };
}

export function reduceRuntimeRootExecution(
  current: RuntimeRootExecution,
  source: RuntimeRootExecutionSource,
  event: RuntimeRootExecutionEvent,
): RuntimeRootExecution {
  if (event.type === "root_reset") return emptyRuntimeRootExecution(event.timestamp);
  if (event.type === "root_started") {
    return projectRuntimeRootExecution(source, {
      ...emptyRuntimeRootExecution(event.timestamp),
      state: "working",
      reason: "awaiting_agent_settlement",
      rootRequestId: event.requestId,
      sessionId: event.sessionId,
    }, event.timestamp);
  }
  if (event.type === "batch_policy_applied") {
    if (!current.rootRequestId || current.rootRequestId !== event.targetRootRequestId) {
      throw new Error(`Runtime batch policy ${event.policy} requires active root ${event.targetRootRequestId}.`);
    }
    const batchControl: RuntimeRootBatchControl = {
      policy: event.policy,
      batchId: event.batchId,
      sourceRequestId: event.sourceRequestId,
      targetRootRequestId: event.targetRootRequestId,
      targetTaskId: event.targetTaskId,
      reason: event.reason,
      appliedAt: event.timestamp,
      supersedeEvidence: event.supersedeEvidence,
    };
    const next = event.policy === "supersede_merge"
      ? {
          ...current,
          rootRequestId: event.sourceRequestId,
          settledRequestId: undefined,
          settlement: "pending" as const,
          batchControl,
          updatedAt: event.timestamp,
        }
      : {
          ...current,
          settledRequestId: event.policy === "cancel" ? event.targetRootRequestId : current.settledRequestId,
          settlement: event.policy === "cancel" ? "interrupted" as const : current.settlement,
          batchControl,
          updatedAt: event.timestamp,
        };
    return projectRuntimeRootExecution(source, next, event.timestamp);
  }
  if (!event.requestId || !current.rootRequestId || event.requestId !== current.rootRequestId) {
    return projectRuntimeRootExecution(source, current, event.timestamp);
  }
  return projectRuntimeRootExecution(source, {
    ...current,
    settledRequestId: event.requestId,
    settlement: event.outcome,
    updatedAt: event.timestamp,
  }, event.timestamp);
}

export function normalizeRuntimeRootExecution(value: unknown, timestamp: string): RuntimeRootExecution {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return emptyRuntimeRootExecution(timestamp);
  }
  const record = value as Record<string, unknown>;
  const state = record.state;
  const reason = record.reason;
  const settlement = record.settlement;
  const batchControlRecord = typeof record.batchControl === "object" && record.batchControl !== null &&
    !Array.isArray(record.batchControl)
    ? record.batchControl as Record<string, unknown>
    : undefined;
  const batchPolicy = batchControlRecord?.policy;
  const supersedeEvidence = normalizeSupersedeMergeEvidence(batchControlRecord?.supersedeEvidence);
  const validSupersedeControl = batchPolicy !== "supersede_merge" ||
    supersedeEvidence?.targetRootRequestId === batchControlRecord?.targetRootRequestId;
  const batchControl = (batchPolicy === "supersede_merge" || batchPolicy === "pause" || batchPolicy === "cancel") &&
    validSupersedeControl &&
    typeof batchControlRecord?.sourceRequestId === "string" && batchControlRecord.sourceRequestId &&
    typeof batchControlRecord.targetRootRequestId === "string" && batchControlRecord.targetRootRequestId &&
    typeof batchControlRecord.reason === "string" && batchControlRecord.reason &&
    typeof batchControlRecord.appliedAt === "string" && batchControlRecord.appliedAt
    ? {
        policy: batchPolicy,
        batchId: typeof batchControlRecord.batchId === "string" && batchControlRecord.batchId
          ? batchControlRecord.batchId : undefined,
        sourceRequestId: batchControlRecord.sourceRequestId,
        targetRootRequestId: batchControlRecord.targetRootRequestId,
        targetTaskId: typeof batchControlRecord.targetTaskId === "string" && batchControlRecord.targetTaskId
          ? batchControlRecord.targetTaskId : undefined,
        reason: batchControlRecord.reason,
        appliedAt: batchControlRecord.appliedAt,
        supersedeEvidence: batchPolicy === "supersede_merge" ? supersedeEvidence : undefined,
      } satisfies RuntimeRootBatchControl
    : undefined;
  return {
    version: 1,
    state: state === "working" || state === "waiting" || state === "blocked" || state === "done"
      ? state
      : "idle",
    reason: typeof reason === "string" ? reason as RuntimeRootExecutionReason : "not_started",
    rootRequestId: typeof record.rootRequestId === "string" && record.rootRequestId
      ? record.rootRequestId
      : undefined,
    sessionId: typeof record.sessionId === "string" && record.sessionId
      ? record.sessionId
      : undefined,
    settledRequestId: typeof record.settledRequestId === "string" && record.settledRequestId
      ? record.settledRequestId
      : undefined,
    settlement: settlement === "succeeded" || settlement === "failed" || settlement === "interrupted"
      ? settlement
      : "pending",
    batchControl,
    workingCount: Math.max(0, Number(record.workingCount) || 0),
    waitingCount: Math.max(0, Number(record.waitingCount) || 0),
    blockedCount: Math.max(0, Number(record.blockedCount) || 0),
    updatedAt: typeof record.updatedAt === "string" && record.updatedAt ? record.updatedAt : timestamp,
  };
}

function normalizeSupersedeMergeEvidence(value: unknown): SupersedeMergeEvidence | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.targetRootRequestId !== "string" || !record.targetRootRequestId ||
      !Array.isArray(record.items)) return undefined;
  const items = record.items.map(item => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
    const entry = item as Record<string, unknown>;
    const plane = entry.plane;
    const status = entry.status;
    const disposition = entry.disposition;
    if ((plane !== "tasks" && plane !== "plans" && plane !== "subAgents" &&
         plane !== "workflows" && plane !== "toolRuns") ||
        (status !== "pending" && status !== "in_progress" && status !== "running" &&
         status !== "completed" && status !== "blocked" && status !== "failed" &&
         status !== "aborted" && status !== "stale" && status !== "unknown") ||
        (disposition !== "continue_under_replacement" && disposition !== "cancel_as_redundant" &&
         disposition !== "preserve_completed_evidence") ||
        typeof entry.itemId !== "string" || !entry.itemId ||
        typeof entry.updatedAt !== "string" || !entry.updatedAt ||
        !Number.isFinite(Date.parse(entry.updatedAt))) return undefined;
    if ((disposition === "cancel_as_redundant" && status !== "pending" && status !== "unknown") ||
        (disposition === "preserve_completed_evidence" && status !== "completed" && status !== "failed" &&
         status !== "aborted" && status !== "stale") ||
        (disposition === "continue_under_replacement" && status !== "pending" &&
         status !== "in_progress" && status !== "running" && status !== "blocked" && status !== "unknown")) {
      return undefined;
    }
    return { plane, itemId: entry.itemId, status, updatedAt: entry.updatedAt, disposition };
  });
  if (items.some(item => !item)) return undefined;
  const typedItems = items as SupersedeMergeEvidence["items"];
  const keys = typedItems.map(item => `${item.plane}:${item.itemId}`);
  if (new Set(keys).size !== keys.length) return undefined;
  return { targetRootRequestId: record.targetRootRequestId, items: typedItems };
}
