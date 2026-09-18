/**
 * =============================================================================
 * Canvast — Paired Evidence Contract / Canvast source file
 * =============================================================================
 * @file        eval-matrix/paired-evidence-contract.mjs
 * @brief       Shared fail-closed derivations for paired evaluation evidence.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

const ENHANCED_OUTCOMES = new Set(["observed", "not_observed", "unknown"]);
const CORROBORATION_KINDS = new Set(["runtime_event", "tool_event", "source_bound_artifact"]);

export const CANONICAL_ENHANCED_PROBES = Object.freeze([
  Object.freeze({
    id: "sidecar_primary_recovery",
    title: "Sidecar Continuation And Primary Recovery",
    behavioralTask: [
      "Keep a primary repository-inspection task active while starting one bounded secondary helper execution",
      "through a runtime-provided mechanism that is distinct from the primary flow.",
      "After the helper finishes, resume the primary task and integrate both results.",
      "Use read-only inspection and do not simulate a helper by merely describing one.",
    ].join(" "),
    checks: Object.freeze([
      Object.freeze({
        id: "secondary_execution_observed",
        criterion: "A distinct secondary helper execution was started and produced an observable result.",
      }),
      Object.freeze({
        id: "primary_resumption_observed",
        criterion: "The original primary task demonstrably resumed after the secondary execution.",
      }),
      Object.freeze({
        id: "result_integration_observed",
        criterion: "The final response integrated concrete results from both primary and secondary work.",
      }),
    ]),
  }),
  Object.freeze({
    id: "compaction_same_request_continuity",
    title: "Compaction Same-Request Continuity",
    behavioralTask: [
      "While an explicit multi-step read-only task is active, invoke a runtime-provided context-compaction operation.",
      "After an observable compaction event, continue the same request and complete the next planned step.",
      "Do not simulate compaction in prose or treat a new request as same-request continuation.",
    ].join(" "),
    checks: Object.freeze([
      Object.freeze({
        id: "compaction_event_observed",
        criterion: "A real runtime context-compaction event was directly observed during this request.",
      }),
      Object.freeze({
        id: "active_request_preserved",
        criterion: "The active task and its next step remained identifiable after compaction.",
      }),
      Object.freeze({
        id: "post_compaction_step_observed",
        criterion: "A planned step completed after compaction without starting a new request.",
      }),
    ]),
  }),
  Object.freeze({
    id: "live_plan_projection",
    title: "Live Plan Tree Projection",
    behavioralTask: [
      "Create a runtime-backed plan with at least two ordered steps for a read-only repository inspection.",
      "Inspect the runtime's live plan projection while the first step is in progress, then complete that step",
      "and verify that the same projection reflects the transition while a later step remains pending.",
      "A prose checklist is not a runtime-backed plan.",
    ].join(" "),
    checks: Object.freeze([
      Object.freeze({
        id: "runtime_plan_created",
        criterion: "A plan was created through the runtime's plan mechanism rather than only written in prose.",
      }),
      Object.freeze({
        id: "in_progress_projection_observed",
        criterion: "The live projection visibly represented the active step as in progress.",
      }),
      Object.freeze({
        id: "plan_transition_observed",
        criterion: "The live projection visibly updated after one step completed while a later step remained pending.",
      }),
    ]),
  }),
  Object.freeze({
    id: "canvas_projection_and_export",
    title: "Canvas Projection And Export",
    behavioralTask: [
      "Use a runtime-provided graph or Canvas mechanism to represent at least one repository file, one task,",
      "and their relationship. Inspect the live projection, export it through the runtime's built-in export",
      "surface, and verify the exported artifact contains the represented nodes and relationship.",
      "Do not substitute a hand-written diagram or a hypothetical export description.",
    ].join(" "),
    checks: Object.freeze([
      Object.freeze({
        id: "graph_projection_observed",
        criterion: "A runtime-backed graph projection visibly contained the requested nodes and relationship.",
      }),
      Object.freeze({
        id: "export_action_observed",
        criterion: "The runtime's built-in graph or Canvas export action completed.",
      }),
      Object.freeze({
        id: "exported_artifact_verified",
        criterion: "The resulting exported artifact was read back and contained the requested nodes and relationship.",
      }),
    ]),
  }),
]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uniqueStrings(value) {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.every(item => typeof item === "string" && item.trim().length > 0) &&
    new Set(value).size === value.length;
}

export function executionHealthFromEvidence(run) {
  if (!isRecord(run) || !isRecord(run.metrics)) return false;
  if (
    run.timedOut !== false ||
    run.timeoutSource !== null ||
    run.metrics.unrecoveredModelErrorEvents !== 0
  ) return false;
  if (run.terminationSource === "natural_exit") {
    return run.exitCode === 0 && run.terminationSignal === null;
  }
  return run.terminationSource === "controlled_terminal_completion" &&
    run.terminalCompletionObserved === true;
}

export function deriveModelComparability(runs) {
  const failures = [];
  if (!Array.isArray(runs) || runs.length === 0) {
    failures.push("model-quality runs must be a non-empty array");
  }
  const sides = new Set();
  const configuredIdentities = new Set();
  const observedIdentities = new Set();
  let everyIdentityObserved = Array.isArray(runs) && runs.length > 0;

  for (const [index, run] of (Array.isArray(runs) ? runs : []).entries()) {
    const model = isRecord(run) && isRecord(run.model) ? run.model : null;
    const label = `runs[${index}].model`;
    if (!model) {
      failures.push(`${label} must be an object`);
      everyIdentityObserved = false;
      continue;
    }
    if (run.side !== "claude" && run.side !== "canvast") failures.push(`runs[${index}].side is invalid`);
    else sides.add(run.side);
    const configuredProvider = model.configuredUpstreamProvider;
    const configuredModel = model.configuredUpstreamModel;
    if (
      typeof configuredProvider !== "string" ||
      !configuredProvider.trim() ||
      typeof configuredModel !== "string" ||
      !configuredModel.trim()
    ) {
      failures.push(`${label} configured identity must be non-empty`);
      everyIdentityObserved = false;
      continue;
    }
    configuredIdentities.add(`${configuredProvider}\u0000${configuredModel}`);
    if (!["observed", "configured_only", "not_observed"].includes(model.observationStatus)) {
      failures.push(`${label}.observationStatus is invalid`);
      everyIdentityObserved = false;
      continue;
    }
    const providersValid = uniqueStrings(model.observedProviders);
    const modelsValid = uniqueStrings(model.observedModels);
    if (model.observationStatus !== "observed") {
      everyIdentityObserved = false;
      continue;
    }
    if (!providersValid || !modelsValid || model.observedProviders.length !== 1 || model.observedModels.length !== 1) {
      failures.push(`${label} observed identity must contain exactly one provider and one model`);
      everyIdentityObserved = false;
      continue;
    }
    const observedProvider = model.observedProviders[0];
    const observedModel = model.observedModels[0];
    if (observedProvider !== configuredProvider || observedModel !== configuredModel) {
      failures.push(`${label} observed identity does not match its configured upstream identity`);
      everyIdentityObserved = false;
      continue;
    }
    observedIdentities.add(`${observedProvider}\u0000${observedModel}`);
  }

  if (sides.size !== 2) failures.push("model-quality runs must contain both paired sides");
  const configuredSameProviderModel = failures.length === 0 && configuredIdentities.size === 1;
  const strictSameModelVerified = configuredSameProviderModel &&
    everyIdentityObserved &&
    observedIdentities.size === 1;
  return {
    valid: failures.length === 0,
    failures,
    configuredSameProviderModel,
    strictSameModelVerified,
    status: strictSameModelVerified
      ? "verified_same_model"
      : configuredSameProviderModel
        ? "configured_same_model_but_reference_upstream_revision_unobserved"
        : "different_models",
  };
}

export function aggregateEnhancedStatuses(statuses) {
  if (statuses.length === 0 || statuses.some(status => status === "inconclusive")) return "inconclusive";
  if (statuses.every(status => status === "passed")) return "passed";
  if (statuses.every(status => status === "failed")) return "failed";
  return "inconclusive";
}

export function enhancedVerdict(canvastStatus, referenceStatus) {
  if (canvastStatus === "passed" && referenceStatus === "failed") return "pass";
  if (canvastStatus === "passed" && referenceStatus === "passed") return "tie";
  if (canvastStatus === "failed" && referenceStatus === "passed") return "fail";
  return "inconclusive";
}

function repeatStatus(repeatEvidence, probe, side) {
  if (!isRecord(repeatEvidence) || repeatEvidence.side !== side) return "inconclusive";
  const command = repeatEvidence.command;
  if (
    !isRecord(command) ||
    command.exitCode !== 0 ||
    command.timedOut !== false ||
    command.timeoutSource !== null ||
    command.processGroupCleanupVerified !== true
  ) return "inconclusive";
  const checkIds = probe.checks.map(check => check.id);
  if (!Array.isArray(repeatEvidence.checks) || repeatEvidence.checks.length !== checkIds.length) {
    return "inconclusive";
  }
  const checks = new Map();
  for (const check of repeatEvidence.checks) {
    if (
      !isRecord(check) ||
      typeof check.id !== "string" ||
      !checkIds.includes(check.id) ||
      checks.has(check.id) ||
      !ENHANCED_OUTCOMES.has(check.outcome) ||
      typeof check.evidence !== "string" ||
      !check.evidence.trim() ||
      !Array.isArray(check.corroboration) ||
      check.corroboration.some(kind => !CORROBORATION_KINDS.has(kind))
    ) return "inconclusive";
    if (check.outcome !== "unknown" && check.corroboration.length === 0) return "inconclusive";
    checks.set(check.id, check.outcome);
  }
  if (checkIds.some(id => !checks.has(id))) return "inconclusive";
  const outcomes = [...checks.values()];
  if (outcomes.some(outcome => outcome === "unknown")) return "inconclusive";
  return outcomes.every(outcome => outcome === "observed") ? "passed" : "failed";
}

function recomputeSide(observation, probe, side, repeats, failures, label) {
  const records = isRecord(observation) && Array.isArray(observation.repeatObservations)
    ? observation.repeatObservations
    : [];
  const byRepeat = new Map();
  for (const record of records) {
    if (!isRecord(record) || !Number.isInteger(record.repeat) || record.repeat < 1 || record.repeat > repeats) {
      failures.push(`${label}.repeatObservations contains an invalid repeat`);
      continue;
    }
    if (byRepeat.has(record.repeat)) {
      failures.push(`${label}.repeatObservations contains duplicate repeat ${record.repeat}`);
      continue;
    }
    const status = repeatStatus(record, probe, side);
    if (record.status !== status) failures.push(`${label}.repeatObservations status does not match runner evidence`);
    byRepeat.set(record.repeat, status);
  }
  const statuses = Array.from({ length: repeats }, (_, index) => byRepeat.get(index + 1) || "inconclusive");
  const status = isRecord(observation) && observation.rubricKind === "structured_behavior"
    ? aggregateEnhancedStatuses(statuses)
    : "inconclusive";
  if (!isRecord(observation) || observation.status !== status) {
    failures.push(`${label}.status does not match per-repeat runner evidence`);
  }
  return status;
}

export function recomputeEnhancedCapabilityTrack(track, repeats) {
  const failures = [];
  const dimensionsById = new Map();
  const dimensions = isRecord(track) && Array.isArray(track.dimensions) ? track.dimensions : [];
  for (const dimension of dimensions) {
    if (!isRecord(dimension) || typeof dimension.id !== "string") {
      failures.push("enhancedCapabilityTrack dimensions must have string ids");
      continue;
    }
    if (dimensionsById.has(dimension.id)) failures.push("enhancedCapabilityTrack dimension ids must be unique");
    dimensionsById.set(dimension.id, dimension);
  }
  const canonicalIds = CANONICAL_ENHANCED_PROBES.map(probe => probe.id);
  if (
    dimensions.length !== canonicalIds.length ||
    dimensions.some((dimension, index) => !isRecord(dimension) || dimension.id !== canonicalIds[index])
  ) failures.push("enhancedCapabilityTrack must contain exactly the canonical enhanced probe set in canonical order");

  const recomputedDimensions = CANONICAL_ENHANCED_PROBES.map(probe => {
    const dimension = dimensionsById.get(probe.id);
    if (!isRecord(dimension)) {
      return { id: probe.id, title: probe.title, canvastStatus: "inconclusive", referenceStatus: "inconclusive", verdict: "inconclusive" };
    }
    if (dimension.title !== probe.title) failures.push(`enhancedCapabilityTrack.${probe.id}.title is not canonical`);
    const canvastStatus = recomputeSide(
      dimension.canvast, probe, "canvast", repeats, failures, `enhancedCapabilityTrack.${probe.id}.canvast`,
    );
    const referenceStatus = recomputeSide(
      dimension.reference, probe, "claude", repeats, failures, `enhancedCapabilityTrack.${probe.id}.reference`,
    );
    const verdict = enhancedVerdict(canvastStatus, referenceStatus);
    if (dimension.verdict !== verdict) failures.push(`enhancedCapabilityTrack.${probe.id}.verdict does not match runner evidence`);
    const includedInClaim = verdict !== "inconclusive";
    if (dimension.includedInClaim !== includedInClaim) {
      failures.push(`enhancedCapabilityTrack.${probe.id}.includedInClaim does not match runner evidence`);
    }
    return { id: probe.id, title: probe.title, canvastStatus, referenceStatus, verdict, includedInClaim };
  });
  const summary = {
    totalDimensions: CANONICAL_ENHANCED_PROBES.length,
    pass: recomputedDimensions.filter(dimension => dimension.verdict === "pass").length,
    tie: recomputedDimensions.filter(dimension => dimension.verdict === "tie").length,
    fail: recomputedDimensions.filter(dimension => dimension.verdict === "fail").length,
    inconclusive: recomputedDimensions.filter(dimension => dimension.verdict === "inconclusive").length,
  };
  if (
    !isRecord(track) ||
    !isRecord(track.summary) ||
    Object.entries(summary).some(([field, value]) => track.summary[field] !== value)
  ) failures.push("enhancedCapabilityTrack summary does not match runner evidence");
  return { failures, summary, dimensions: recomputedDimensions };
}
