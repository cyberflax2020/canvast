/**
 * =============================================================================
 * Canvast — Runtime Resume State / Canvast source file
 * =============================================================================
 * @file        src/harness/runtime-resume.ts
 * @brief       Canonical resumable runtime contract shared by TUI and App.
 * @description Persists resumable turn candidates, typed selection and claim
 *              state, and structural validation against runtime plus Canvas.
 *              All mutations are serialized behind the same atomic no-follow
 *              file-locking path used by context continuity.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import {
  dispatchSerializedStateUpdate,
  readSerializedState,
  writeSerializedState,
} from "./context-continuity/serialized-state.js";
import { readContextContinuity, type ContextContinuityState, type RuntimeContinuityCheckpoint } from "./context-continuity.js";
import { readRuntimeStatus, type RuntimeStatusSnapshot } from "./runtime-status.js";
import {
  buildResumeValidation,
  deriveResumeSources,
  emptyCheckpoint,
  readCanvasGraph,
  readStoredRuntimeResume,
  runtimeResumeFile,
  runtimeResumeFingerprint,
  stableRuntimeResumeProjectId,
  writeStoredRuntimeResume,
} from "./runtime-resume-support.js";

export type ResumeAvailability =
  | "ready"
  | "needs_rebind"
  | "blocked_active_run"
  | "project_mismatch"
  | "missing_plan_node"
  | "missing_task_node"
  | "invalid_parent_link";
export type ResumeDisposition = "available" | "selected" | "claimed" | "running" | "completed" | "retired";
export type ResumeFreshness = "fresh" | "stale";
export type ResumeActionKind = "inspect" | "choose" | "claim" | "rebind" | "retire" | "reconcile";
export type ResumeUnsupportedReason =
  | "candidate_not_found"
  | "candidate_not_ready"
  | "selection_required"
  | "stale_revision"
  | "candidate_claimed_elsewhere"
  | "candidate_retired"
  | "candidate_completed";

export interface ResumeCandidateBinding {
  planNodeId?: string;
  taskNodeId?: string;
  updatedAt: string;
  source: string;
}

export interface ResumeCandidateClaim {
  claimToken: string;
  sessionId: string;
  state: "active" | "released" | "consumed";
  claimedAt: string;
  updatedAt: string;
}

export interface ResumeCandidateValidation {
  availability: ResumeAvailability;
  freshness: ResumeFreshness;
  issues: string[];
  projectMatched: boolean;
  hasBlockingActiveRun: boolean;
  missingPlanNode: boolean;
  missingTaskNode: boolean;
  parentLinkValid: boolean;
}

export interface ResumeCandidate {
  id: string;
  projectId: string;
  requestId: string;
  title: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string;
  sessionId?: string;
  turnId?: string;
  continuationOwner?: string;
  continuityPhase?: string;
  operationId?: string;
  checkpoint: RuntimeContinuityCheckpoint;
  disposition: ResumeDisposition;
  binding?: ResumeCandidateBinding;
  claim?: ResumeCandidateClaim;
  validation: ResumeCandidateValidation;
  availableActions: ResumeActionKind[];
  retiredReason?: string;
  completedAt?: string;
}

export interface RuntimeResumeSnapshot {
  revision: number;
  state: "idle" | "attention_required" | "ready" | "claimed" | "running";
  updatedAt: string;
  projectId?: string;
  selectedCandidateId?: string;
  claimedCandidateId?: string;
  readyCandidateCount: number;
  candidates: ResumeCandidate[];
}

export interface RuntimeResumeUnsupported {
  action: ResumeActionKind;
  reason: ResumeUnsupportedReason;
  candidateId?: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface RuntimeResumeState {
  version: 1;
  revision: number;
  updatedAt: string;
  projectId: string;
  selectedCandidateId?: string;
  candidates: ResumeCandidate[];
  processedEventIds: string[];
}

export interface ResumeCandidateSource {
  id: string;
  projectId: string;
  requestId: string;
  title: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string;
  sessionId?: string;
  turnId?: string;
  continuationOwner?: string;
  continuityPhase?: string;
  operationId?: string;
  checkpoint: RuntimeContinuityCheckpoint;
}

export interface RuntimeResumeTransition {
  state: RuntimeResumeState;
  snapshot: RuntimeResumeSnapshot;
  duplicate: boolean;
  candidate?: ResumeCandidate;
  unsupported?: RuntimeResumeUnsupported;
}

interface RuntimeResumeChooseEvent {
  type: "candidate_chosen";
  eventId: string;
  timestamp: string;
  candidateId: string;
}

interface RuntimeResumeClaimEvent {
  type: "candidate_claimed";
  eventId: string;
  timestamp: string;
  candidateId: string;
  claimToken: string;
  sessionId: string;
  expectedRevision: number;
}

interface RuntimeResumeClaimReleasedEvent {
  type: "candidate_claim_released";
  eventId: string;
  timestamp: string;
  candidateId: string;
  claimToken?: string;
  sessionId?: string;
}

interface RuntimeResumeRebindEvent {
  type: "candidate_rebound";
  eventId: string;
  timestamp: string;
  candidateId: string;
  planNodeId?: string;
  taskNodeId?: string;
  source: string;
}

interface RuntimeResumeRetireEvent {
  type: "candidate_retired";
  eventId: string;
  timestamp: string;
  candidateId: string;
  reason: string;
}

interface RuntimeResumeRunningEvent {
  type: "candidate_running";
  eventId: string;
  timestamp: string;
  candidateId: string;
  claimToken?: string;
  sessionId?: string;
}

interface RuntimeResumeCompletedEvent {
  type: "candidate_completed";
  eventId: string;
  timestamp: string;
  candidateId: string;
}

interface RuntimeResumeReconciledEvent {
  type: "snapshot_reconciled";
  eventId: string;
  timestamp: string;
  projectId: string;
  sources: ResumeCandidateSource[];
  validation: Record<string, ResumeCandidateValidation>;
}

type RuntimeResumeEvent =
  | RuntimeResumeChooseEvent
  | RuntimeResumeClaimEvent
  | RuntimeResumeClaimReleasedEvent
  | RuntimeResumeRebindEvent
  | RuntimeResumeRetireEvent
  | RuntimeResumeRunningEvent
  | RuntimeResumeCompletedEvent
  | RuntimeResumeReconciledEvent;

const MAX_CANDIDATES = 24;
const MAX_PROCESSED_EVENTS = 128;
const STALE_CANDIDATE_MS = 24 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function fingerprint(parts: string[]): string {
  return runtimeResumeFingerprint(parts);
}

function normalizeCheckpoint(value: unknown): RuntimeContinuityCheckpoint {
  const record = isRecord(value) ? value : {};
  return {
    taskIds: uniqueStrings(asStringArray(record.taskIds)),
    planIds: uniqueStrings(asStringArray(record.planIds)),
    subAgentIds: uniqueStrings(asStringArray(record.subAgentIds)),
    workflowIds: uniqueStrings(asStringArray(record.workflowIds)),
    toolRunIds: uniqueStrings(asStringArray(record.toolRunIds)),
  };
}

function normalizeBinding(value: unknown, now: string): ResumeCandidateBinding | undefined {
  if (!isRecord(value)) return undefined;
  const planNodeId = asString(value.planNodeId) || undefined;
  const taskNodeId = asString(value.taskNodeId) || undefined;
  if (!planNodeId && !taskNodeId) return undefined;
  return {
    planNodeId,
    taskNodeId,
    updatedAt: asString(value.updatedAt, now),
    source: asString(value.source, "stored"),
  };
}

function normalizeClaim(value: unknown, now: string): ResumeCandidateClaim | undefined {
  if (!isRecord(value) || !asString(value.claimToken) || !asString(value.sessionId)) return undefined;
  return {
    claimToken: asString(value.claimToken),
    sessionId: asString(value.sessionId),
    state: value.state === "released" || value.state === "consumed" ? value.state : "active",
    claimedAt: asString(value.claimedAt, now),
    updatedAt: asString(value.updatedAt, now),
  };
}

function normalizeAvailability(value: unknown): ResumeAvailability {
  if (
    value === "ready" || value === "needs_rebind" || value === "blocked_active_run" ||
    value === "project_mismatch" || value === "missing_plan_node" || value === "missing_task_node" ||
    value === "invalid_parent_link"
  ) return value;
  return "needs_rebind";
}

function normalizeDisposition(value: unknown): ResumeDisposition {
  if (
    value === "selected" || value === "claimed" || value === "running" ||
    value === "completed" || value === "retired"
  ) return value;
  return "available";
}

function normalizeValidation(value: unknown, now: string, updatedAt: string): ResumeCandidateValidation {
  const record = isRecord(value) ? value : {};
  const issues = uniqueStrings(asStringArray(record.issues));
  return {
    availability: normalizeAvailability(record.availability),
    freshness: record.freshness === "stale" ? "stale" : "fresh",
    issues,
    projectMatched: record.projectMatched !== false,
    hasBlockingActiveRun: record.hasBlockingActiveRun === true,
    missingPlanNode: record.missingPlanNode === true,
    missingTaskNode: record.missingTaskNode === true,
    parentLinkValid: record.parentLinkValid !== false,
  };
}

function candidateActions(candidate: ResumeCandidate): ResumeActionKind[] {
  const actions: ResumeActionKind[] = ["inspect", "reconcile"];
  if (candidate.disposition === "retired" || candidate.disposition === "completed") return actions;
  actions.push("choose");
  if (candidate.validation.availability !== "ready") actions.push("rebind");
  if (
    candidate.validation.availability === "ready" &&
    (candidate.disposition === "available" || candidate.disposition === "selected" || candidate.disposition === "claimed")
  ) {
    actions.push("claim");
  }
  actions.push("retire");
  return [...new Set(actions)];
}

function normalizeCandidate(value: unknown, now: string): ResumeCandidate | undefined {
  if (!isRecord(value) || !asString(value.id) || !asString(value.requestId)) return undefined;
  const createdAt = asString(value.createdAt, now);
  const updatedAt = asString(value.updatedAt, createdAt);
  const candidate: ResumeCandidate = {
    id: asString(value.id),
    projectId: asString(value.projectId),
    requestId: asString(value.requestId),
    title: asString(value.title, "Resume active work"),
    summary: asString(value.summary, "Continue unfinished work from persisted runtime state."),
    createdAt,
    updatedAt,
    lastActiveAt: asString(value.lastActiveAt, updatedAt),
    sessionId: asString(value.sessionId) || undefined,
    turnId: asString(value.turnId) || undefined,
    continuationOwner: asString(value.continuationOwner) || undefined,
    continuityPhase: asString(value.continuityPhase) || undefined,
    operationId: asString(value.operationId) || undefined,
    checkpoint: normalizeCheckpoint(value.checkpoint),
    disposition: normalizeDisposition(value.disposition),
    binding: normalizeBinding(value.binding, updatedAt),
    claim: normalizeClaim(value.claim, updatedAt),
    validation: normalizeValidation(value.validation, now, updatedAt),
    availableActions: [],
    retiredReason: asString(value.retiredReason) || undefined,
    completedAt: asString(value.completedAt) || undefined,
  };
  candidate.availableActions = candidateActions(candidate);
  return candidate;
}

function emptyRuntimeResumeState(input: { now?: string; projectId?: string } = {}): RuntimeResumeState {
  const now = input.now || new Date().toISOString();
  return {
    version: 1,
    revision: 0,
    updatedAt: now,
    projectId: input.projectId || "",
    candidates: [],
    processedEventIds: [],
  };
}

function normalizeRuntimeResumeState(value: unknown, now: string): RuntimeResumeState {
  if (!isRecord(value)) return emptyRuntimeResumeState({ now });
  const candidates = Array.isArray(value.candidates)
    ? value.candidates.map(item => normalizeCandidate(item, now)).filter((item): item is ResumeCandidate => Boolean(item)).slice(-MAX_CANDIDATES)
    : [];
  const selectedCandidateId = asString(value.selectedCandidateId) || undefined;
  return {
    version: 1,
    revision: Math.max(0, Number(value.revision) || 0),
    updatedAt: asString(value.updatedAt, now),
    projectId: asString(value.projectId),
    selectedCandidateId: selectedCandidateId && candidates.some(item => item.id === selectedCandidateId) ? selectedCandidateId : undefined,
    candidates,
    processedEventIds: uniqueStrings(asStringArray(value.processedEventIds)).slice(-MAX_PROCESSED_EVENTS),
  };
}

function snapshotState(candidates: ResumeCandidate[]): RuntimeResumeSnapshot["state"] {
  const activeCandidates = candidates.filter(item =>
    item.disposition !== "retired" && item.disposition !== "completed",
  );
  const running = activeCandidates.find(item => item.disposition === "running");
  if (running) return "running";
  const claimed = activeCandidates.find(item => item.disposition === "claimed");
  if (claimed) return "claimed";
  if (!activeCandidates.length) return "idle";
  if (activeCandidates.some(item => item.validation.availability === "ready")) return "ready";
  return "attention_required";
}

export function projectRuntimeResume(state: RuntimeResumeState): RuntimeResumeSnapshot {
  const candidates = [...state.candidates].sort((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt));
  return {
    revision: state.revision,
    state: snapshotState(candidates),
    updatedAt: state.updatedAt,
    projectId: state.projectId || undefined,
    selectedCandidateId: state.selectedCandidateId,
    claimedCandidateId: candidates.find(item => item.claim?.state === "active")?.id,
    readyCandidateCount: candidates.filter(item => item.validation.availability === "ready" && item.disposition !== "retired" && item.disposition !== "completed").length,
    candidates,
  };
}

function duplicateTransition(state: RuntimeResumeState): RuntimeResumeTransition {
  return { state, snapshot: projectRuntimeResume(state), duplicate: true };
}

function commitTransition(
  state: RuntimeResumeState,
  event: RuntimeResumeEvent,
  changes: Omit<Partial<RuntimeResumeState>, "version" | "revision" | "updatedAt" | "processedEventIds">,
  candidate?: ResumeCandidate,
  unsupported?: RuntimeResumeUnsupported,
): RuntimeResumeTransition {
  const next: RuntimeResumeState = {
    ...state,
    ...changes,
    version: 1,
    revision: state.revision + 1,
    updatedAt: event.timestamp,
    processedEventIds: uniqueStrings([...state.processedEventIds, event.eventId]).slice(-MAX_PROCESSED_EVENTS),
  };
  return { state: next, snapshot: projectRuntimeResume(next), duplicate: false, candidate, unsupported };
}

function unsupported(
  action: ResumeActionKind,
  reason: ResumeUnsupportedReason,
  message: string,
  candidateId?: string,
  details?: Record<string, unknown>,
): RuntimeResumeUnsupported {
  return { action, reason, candidateId, message, details };
}

function updateCandidate(
  candidates: ResumeCandidate[],
  candidateId: string,
  update: (candidate: ResumeCandidate) => ResumeCandidate,
): { candidates: ResumeCandidate[]; candidate?: ResumeCandidate } {
  let changed: ResumeCandidate | undefined;
  return {
    candidates: candidates.map(candidate => {
      if (candidate.id !== candidateId) return candidate;
      changed = update(candidate);
      return changed;
    }),
    candidate: changed,
  };
}

function reduceRuntimeResume(
  current: RuntimeResumeState,
  event: RuntimeResumeEvent,
): RuntimeResumeTransition {
  const state = normalizeRuntimeResumeState(current, event.timestamp);
  if (state.processedEventIds.includes(event.eventId) && event.type !== "candidate_claimed") {
    return duplicateTransition(state);
  }

  if (event.type === "snapshot_reconciled") {
    const priorById = new Map(state.candidates.map(candidate => [candidate.id, candidate]));
    const nextIds = new Set(event.sources.map(source => source.id));
    const carried = state.candidates.filter(candidate =>
      !nextIds.has(candidate.id) && candidate.disposition !== "completed" && candidate.disposition !== "retired",
    );
    const candidates = event.sources.map(source => {
      const prior = priorById.get(source.id);
      const validation = event.validation[source.id] || prior?.validation || {
        availability: "needs_rebind" as const,
        freshness: "fresh" as const,
        issues: [] as string[],
        projectMatched: true,
        hasBlockingActiveRun: false,
        missingPlanNode: false,
        missingTaskNode: false,
        parentLinkValid: true,
      };
      const disposition = prior?.disposition === "completed" || prior?.disposition === "retired"
        ? prior.disposition
        : prior?.claim?.state === "active" && (prior.disposition === "claimed" || prior.disposition === "running")
          ? prior.disposition
          : prior?.disposition === "selected"
            ? "selected"
            : "available";
      const candidate: ResumeCandidate = {
        ...source,
        disposition,
        binding: prior?.binding,
        claim: prior?.claim,
        validation,
        availableActions: [],
        retiredReason: prior?.retiredReason,
        completedAt: prior?.completedAt,
      };
      candidate.availableActions = candidateActions(candidate);
      return candidate;
    });
    const merged = [...candidates, ...carried].slice(-MAX_CANDIDATES);
    const selectedCandidateId = state.selectedCandidateId && merged.some(item => item.id === state.selectedCandidateId)
      ? state.selectedCandidateId
      : undefined;
    return commitTransition(state, event, {
      projectId: event.projectId,
      selectedCandidateId,
      candidates: merged,
    });
  }

  if (event.type === "candidate_chosen") {
    const target = state.candidates.find(candidate => candidate.id === event.candidateId);
    if (!target) {
      return commitTransition(state, event, {}, undefined, unsupported("choose", "candidate_not_found", "Resume candidate was not found.", event.candidateId));
    }
    if (target.disposition === "retired") {
      return commitTransition(state, event, {}, target, unsupported("choose", "candidate_retired", "Resume candidate was already retired.", event.candidateId));
    }
    if (target.disposition === "completed") {
      return commitTransition(state, event, {}, target, unsupported("choose", "candidate_completed", "Resume candidate already completed.", event.candidateId));
    }
    const { candidates, candidate } = updateCandidate(state.candidates, event.candidateId, currentCandidate => {
      const next: ResumeCandidate = { ...currentCandidate, disposition: "selected", updatedAt: event.timestamp };
      next.availableActions = candidateActions(next);
      return next;
    });
    return commitTransition(state, event, { selectedCandidateId: event.candidateId, candidates }, candidate);
  }

  if (event.type === "candidate_rebound") {
    const target = state.candidates.find(candidate => candidate.id === event.candidateId);
    if (!target) {
      return commitTransition(state, event, {}, undefined, unsupported("rebind", "candidate_not_found", "Resume candidate was not found.", event.candidateId));
    }
    if (target.disposition === "retired") {
      return commitTransition(state, event, {}, target, unsupported("rebind", "candidate_retired", "Resume candidate was already retired.", event.candidateId));
    }
    if (target.disposition === "completed") {
      return commitTransition(state, event, {}, target, unsupported("rebind", "candidate_completed", "Resume candidate already completed.", event.candidateId));
    }
    const { candidates, candidate } = updateCandidate(state.candidates, event.candidateId, currentCandidate => {
      const next: ResumeCandidate = {
        ...currentCandidate,
        updatedAt: event.timestamp,
        binding: {
          planNodeId: event.planNodeId,
          taskNodeId: event.taskNodeId,
          updatedAt: event.timestamp,
          source: event.source,
        },
      };
      next.availableActions = candidateActions(next);
      return next;
    });
    return commitTransition(state, event, { candidates, selectedCandidateId: event.candidateId }, candidate);
  }

  if (event.type === "candidate_claimed") {
    const target = state.candidates.find(candidate => candidate.id === event.candidateId);
    if (!Number.isInteger(event.expectedRevision) || event.expectedRevision < 0) {
      return {
        ...duplicateTransition(state),
        candidate: target,
        unsupported: unsupported(
          "claim",
          "stale_revision",
          "Resume claim requires a non-negative integer expected revision.",
          event.candidateId,
          { expectedRevision: event.expectedRevision, actualRevision: state.revision },
        ),
      };
    }
    if (target?.claim?.state === "active") {
      if (target.claim.claimToken === event.claimToken && target.claim.sessionId === event.sessionId) {
        return duplicateTransition(state);
      }
      return {
        ...duplicateTransition(state),
        candidate: target,
        unsupported: unsupported(
          "claim",
          "candidate_claimed_elsewhere",
          "Resume candidate is already claimed by another active claim.",
          event.candidateId,
          { claimedSessionId: target.claim.sessionId },
        ),
      };
    }
    if (event.expectedRevision !== state.revision) {
      return {
        ...duplicateTransition(state),
        candidate: target,
        unsupported: unsupported(
          "claim",
          "stale_revision",
          `Resume revision changed from ${event.expectedRevision} to ${state.revision}.`,
          event.candidateId,
          { expectedRevision: event.expectedRevision, actualRevision: state.revision },
        ),
      };
    }
    if (state.processedEventIds.includes(event.eventId)) return duplicateTransition(state);
    if (!target) {
      return commitTransition(state, event, {}, undefined, unsupported("claim", "candidate_not_found", "Resume candidate was not found.", event.candidateId));
    }
    if (target.disposition === "retired") {
      return commitTransition(state, event, {}, target, unsupported("claim", "candidate_retired", "Resume candidate was already retired.", event.candidateId));
    }
    if (target.disposition === "completed") {
      return commitTransition(state, event, {}, target, unsupported("claim", "candidate_completed", "Resume candidate already completed.", event.candidateId));
    }
    if (target.validation.availability !== "ready") {
      return commitTransition(state, event, {}, target, unsupported(
        "claim",
        "candidate_not_ready",
        `Resume candidate is not ready: ${target.validation.availability}.`,
        event.candidateId,
        { availability: target.validation.availability, issues: target.validation.issues },
      ));
    }
    const { candidates, candidate } = updateCandidate(state.candidates, event.candidateId, currentCandidate => {
      const next: ResumeCandidate = {
        ...currentCandidate,
        disposition: "claimed",
        updatedAt: event.timestamp,
        claim: {
          claimToken: event.claimToken,
          sessionId: event.sessionId,
          state: "active",
          claimedAt: event.timestamp,
          updatedAt: event.timestamp,
        },
      };
      next.availableActions = candidateActions(next);
      return next;
    });
    return commitTransition(state, event, { candidates, selectedCandidateId: event.candidateId }, candidate);
  }

  if (event.type === "candidate_claim_released") {
    const target = state.candidates.find(candidate => candidate.id === event.candidateId);
    if (!target) {
      return commitTransition(state, event, {}, undefined, unsupported("claim", "candidate_not_found", "Resume candidate was not found.", event.candidateId));
    }
    if (
      target.claim?.state === "active" &&
      event.claimToken && target.claim.claimToken !== event.claimToken &&
      event.sessionId && target.claim.sessionId !== event.sessionId
    ) {
      return commitTransition(state, event, {}, target, unsupported(
        "claim",
        "candidate_claimed_elsewhere",
        "Resume candidate is already claimed by another active session.",
        event.candidateId,
        { claimedSessionId: target.claim.sessionId },
      ));
    }
    const { candidates, candidate } = updateCandidate(state.candidates, event.candidateId, currentCandidate => {
      const next: ResumeCandidate = {
        ...currentCandidate,
        disposition: state.selectedCandidateId === event.candidateId ? "selected" : "available",
        updatedAt: event.timestamp,
        claim: currentCandidate.claim
          ? { ...currentCandidate.claim, state: "released", updatedAt: event.timestamp }
          : currentCandidate.claim,
      };
      next.availableActions = candidateActions(next);
      return next;
    });
    return commitTransition(state, event, { candidates }, candidate);
  }

  if (event.type === "candidate_running") {
    const target = state.candidates.find(candidate => candidate.id === event.candidateId);
    if (!target) {
      return commitTransition(state, event, {}, undefined, unsupported("claim", "candidate_not_found", "Resume candidate was not found.", event.candidateId));
    }
    if (
      target.claim?.state === "active" &&
      event.claimToken && target.claim.claimToken !== event.claimToken &&
      event.sessionId && target.claim.sessionId !== event.sessionId
    ) {
      return commitTransition(state, event, {}, target, unsupported(
        "claim",
        "candidate_claimed_elsewhere",
        "Resume candidate is already claimed by another active session.",
        event.candidateId,
        { claimedSessionId: target.claim.sessionId },
      ));
    }
    const { candidates, candidate } = updateCandidate(state.candidates, event.candidateId, currentCandidate => {
      const next: ResumeCandidate = { ...currentCandidate, disposition: "running", updatedAt: event.timestamp };
      if (next.claim && next.claim.state === "active") next.claim = { ...next.claim, updatedAt: event.timestamp };
      next.availableActions = candidateActions(next);
      return next;
    });
    return commitTransition(state, event, { candidates, selectedCandidateId: event.candidateId }, candidate);
  }

  if (event.type === "candidate_completed") {
    const target = state.candidates.find(candidate => candidate.id === event.candidateId);
    if (!target) {
      return commitTransition(state, event, {}, undefined, unsupported("inspect", "candidate_not_found", "Resume candidate was not found.", event.candidateId));
    }
    const { candidates, candidate } = updateCandidate(state.candidates, event.candidateId, currentCandidate => {
      const next: ResumeCandidate = {
        ...currentCandidate,
        disposition: "completed",
        updatedAt: event.timestamp,
        completedAt: event.timestamp,
        claim: currentCandidate.claim ? { ...currentCandidate.claim, state: "consumed", updatedAt: event.timestamp } : currentCandidate.claim,
      };
      next.availableActions = candidateActions(next);
      return next;
    });
    const selectedCandidateId = state.selectedCandidateId === event.candidateId ? undefined : state.selectedCandidateId;
    return commitTransition(state, event, { candidates, selectedCandidateId }, candidate);
  }

  const target = state.candidates.find(candidate => candidate.id === event.candidateId);
  if (!target) {
    return commitTransition(state, event, {}, undefined, unsupported("retire", "candidate_not_found", "Resume candidate was not found.", event.candidateId));
  }
  const { candidates, candidate } = updateCandidate(state.candidates, event.candidateId, currentCandidate => {
    const next: ResumeCandidate = {
      ...currentCandidate,
      disposition: "retired",
      updatedAt: event.timestamp,
      retiredReason: event.reason,
      claim: currentCandidate.claim ? { ...currentCandidate.claim, state: "released", updatedAt: event.timestamp } : currentCandidate.claim,
    };
    next.availableActions = candidateActions(next);
    return next;
  });
  const selectedCandidateId = state.selectedCandidateId === event.candidateId ? undefined : state.selectedCandidateId;
  return commitTransition(state, event, { candidates, selectedCandidateId }, candidate);
}

function runtimeResumeStateIO(agentDir: string) {
  return {
    targetFile: runtimeResumeFile(agentDir),
    readStored: () => readStoredRuntimeResume(agentDir),
    writeStored: (state: RuntimeResumeState) => writeStoredRuntimeResume(state, agentDir),
    normalize: normalizeRuntimeResumeState,
    emptyState: ({ now }: { now: string }) => emptyRuntimeResumeState({ now }),
  };
}

export function readRuntimeResume(agentDir: string): RuntimeResumeState {
  return readSerializedState(runtimeResumeStateIO(agentDir));
}

export function writeRuntimeResume(state: RuntimeResumeState, agentDir: string): void {
  writeSerializedState(state, runtimeResumeStateIO(agentDir));
}

export function reconcileRuntimeResume(
  agentDir: string,
  input: { eventId?: string; projectId?: string; timestamp?: string } = {},
): RuntimeResumeTransition {
  const timestamp = input.timestamp || new Date().toISOString();
  const continuity = readContextContinuity(agentDir);
  const runtime = readRuntimeStatus(agentDir);
  const prior = readRuntimeResume(agentDir);
  const graph = readCanvasGraph(agentDir);
  const projectId = input.projectId || continuity.project.id || stableRuntimeResumeProjectId();
  const sources = deriveResumeSources(continuity, runtime);
  const validation: Record<string, ResumeCandidateValidation> = {};
  for (const source of sources) {
    const previous = prior.candidates.find(candidate => candidate.id === source.id);
    validation[source.id] = buildResumeValidation(source, previous, graph, continuity, timestamp, projectId, STALE_CANDIDATE_MS);
  }
  return dispatchSerializedStateUpdate({
    type: "snapshot_reconciled",
    eventId: input.eventId || `runtime-resume-${fingerprint([projectId, timestamp, "reconcile"])}`,
    timestamp,
    projectId,
    sources,
    validation,
  } satisfies RuntimeResumeReconciledEvent, {
    ...runtimeResumeStateIO(agentDir),
    reduce: reduceRuntimeResume,
  });
}

export function chooseRuntimeResumeCandidate(
  agentDir: string,
  input: { candidateId: string; eventId?: string; timestamp?: string },
): RuntimeResumeTransition {
  return dispatchSerializedStateUpdate({
    type: "candidate_chosen",
    eventId: input.eventId || `runtime-resume-${fingerprint([input.candidateId, "choose"])}`,
    timestamp: input.timestamp || new Date().toISOString(),
    candidateId: input.candidateId,
  } satisfies RuntimeResumeChooseEvent, {
    ...runtimeResumeStateIO(agentDir),
    reduce: reduceRuntimeResume,
  });
}

export function claimRuntimeResumeCandidate(
  agentDir: string,
  input: { candidateId: string; claimToken: string; sessionId: string; expectedRevision: number; eventId?: string; timestamp?: string },
): RuntimeResumeTransition {
  return dispatchSerializedStateUpdate({
    type: "candidate_claimed",
    eventId: input.eventId || `runtime-resume-${fingerprint([input.candidateId, input.claimToken, "claim"])}`,
    timestamp: input.timestamp || new Date().toISOString(),
    candidateId: input.candidateId,
    claimToken: input.claimToken,
    sessionId: input.sessionId,
    expectedRevision: input.expectedRevision,
  } satisfies RuntimeResumeClaimEvent, {
    ...runtimeResumeStateIO(agentDir),
    reduce: reduceRuntimeResume,
  });
}

export function releaseRuntimeResumeCandidateClaim(
  agentDir: string,
  input: { candidateId: string; claimToken?: string; sessionId?: string; eventId?: string; timestamp?: string },
): RuntimeResumeTransition {
  return dispatchSerializedStateUpdate({
    type: "candidate_claim_released",
    eventId: input.eventId || `runtime-resume-${fingerprint([input.candidateId, input.claimToken || "", "claim-release"])}`,
    timestamp: input.timestamp || new Date().toISOString(),
    candidateId: input.candidateId,
    claimToken: input.claimToken,
    sessionId: input.sessionId,
  } satisfies RuntimeResumeClaimReleasedEvent, {
    ...runtimeResumeStateIO(agentDir),
    reduce: reduceRuntimeResume,
  });
}

export function rebindRuntimeResumeCandidate(
  agentDir: string,
  input: { candidateId: string; planNodeId?: string; taskNodeId?: string; source: string; eventId?: string; timestamp?: string },
): RuntimeResumeTransition {
  return dispatchSerializedStateUpdate({
    type: "candidate_rebound",
    eventId: input.eventId || `runtime-resume-${fingerprint([input.candidateId, input.planNodeId || "", input.taskNodeId || "", "rebind"])}`,
    timestamp: input.timestamp || new Date().toISOString(),
    candidateId: input.candidateId,
    planNodeId: input.planNodeId,
    taskNodeId: input.taskNodeId,
    source: input.source,
  } satisfies RuntimeResumeRebindEvent, {
    ...runtimeResumeStateIO(agentDir),
    reduce: reduceRuntimeResume,
  });
}

export function retireRuntimeResumeCandidate(
  agentDir: string,
  input: { candidateId: string; reason: string; eventId?: string; timestamp?: string },
): RuntimeResumeTransition {
  return dispatchSerializedStateUpdate({
    type: "candidate_retired",
    eventId: input.eventId || `runtime-resume-${fingerprint([input.candidateId, input.reason, "retire"])}`,
    timestamp: input.timestamp || new Date().toISOString(),
    candidateId: input.candidateId,
    reason: input.reason,
  } satisfies RuntimeResumeRetireEvent, {
    ...runtimeResumeStateIO(agentDir),
    reduce: reduceRuntimeResume,
  });
}

export function markRuntimeResumeCandidateRunning(
  agentDir: string,
  input: { candidateId: string; claimToken?: string; sessionId?: string; eventId?: string; timestamp?: string },
): RuntimeResumeTransition {
  return dispatchSerializedStateUpdate({
    type: "candidate_running",
    eventId: input.eventId || `runtime-resume-${fingerprint([input.candidateId, input.claimToken || "", "running"])}`,
    timestamp: input.timestamp || new Date().toISOString(),
    candidateId: input.candidateId,
    claimToken: input.claimToken,
    sessionId: input.sessionId,
  } satisfies RuntimeResumeRunningEvent, {
    ...runtimeResumeStateIO(agentDir),
    reduce: reduceRuntimeResume,
  });
}

export function markRuntimeResumeCandidateCompleted(
  agentDir: string,
  input: { candidateId: string; eventId?: string; timestamp?: string },
): RuntimeResumeTransition {
  return dispatchSerializedStateUpdate({
    type: "candidate_completed",
    eventId: input.eventId || `runtime-resume-${fingerprint([input.candidateId, "completed"])}`,
    timestamp: input.timestamp || new Date().toISOString(),
    candidateId: input.candidateId,
  } satisfies RuntimeResumeCompletedEvent, {
    ...runtimeResumeStateIO(agentDir),
    reduce: reduceRuntimeResume,
  });
}

export function inspectRuntimeResume(
  agentDir: string,
  input: { candidateId?: string } = {},
): { state: RuntimeResumeState; snapshot: RuntimeResumeSnapshot; candidate?: ResumeCandidate } {
  const state = readRuntimeResume(agentDir);
  const snapshot = projectRuntimeResume(state);
  return {
    state,
    snapshot,
    candidate: input.candidateId ? snapshot.candidates.find(candidate => candidate.id === input.candidateId) : undefined,
  };
}

export function candidateReadyForClaim(candidate: ResumeCandidate | undefined): boolean {
  return Boolean(
    candidate &&
    candidate.disposition !== "retired" &&
    candidate.disposition !== "completed" &&
    candidate.validation.availability === "ready",
  );
}

export function claimedResumeCandidateForSession(
  snapshot: RuntimeResumeSnapshot,
  sessionId: string,
): ResumeCandidate | undefined {
  return snapshot.candidates.find(candidate => candidate.claim?.state === "active" && candidate.claim.sessionId === sessionId);
}

export function selectedResumeCandidate(snapshot: RuntimeResumeSnapshot): ResumeCandidate | undefined {
  return snapshot.selectedCandidateId
    ? snapshot.candidates.find(candidate => candidate.id === snapshot.selectedCandidateId)
    : undefined;
}

export { stableRuntimeResumeProjectId };
