/**
 * =============================================================================
 * Canvast — Sidecar Dispatch Policy / Sidecar 调度策略
 * =============================================================================
 * @file        src/harness/sidecar-dispatch-policy.ts
 * @brief       Deterministically selects serial or delegated sidecar execution.
 * @description Uses only explicit typed evidence. Natural-language keywords are
 *              deliberately outside this policy boundary. Unknown evidence
 *              fails closed to serial execution or an explicit deferred state.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import {
  executionDescriptorIssue,
  normalizeExternalResourceKeys,
  normalizeExecutionDescriptor,
  normalizeWriteTargets,
  type SubAgentExecutionDescriptor,
} from "../agents/sub-agent-dispatch-contract.js";

export type SidecarRequestPolicy =
  | "sidecar"
  | "status"
  | "task_adjustment"
  | "redirect"
  | "pause";

export type SidecarDispatchStrategy =
  | "serial"
  | "spawn_agent"
  | "parallel_agents"
  | "defer";

export type SidecarDispatchTool = "none" | "spawn_agent" | "parallel_agents";
export type SidecarPrimaryDependency = "none" | "snapshot" | "live";
export type SidecarIsolation = "disjoint" | "shared" | "unknown";

export type SidecarDispatchReasonCode =
  | "non_sidecar_control"
  | "status_control"
  | "explicit_serial"
  | "explicit_defer"
  | "invalid_branch_count"
  | "missing_branch_evidence"
  | "branch_identity_unproven"
  | "input_not_self_contained"
  | "live_primary_dependency"
  | "inter_branch_dependency_present"
  | "write_isolation_unproven"
  | "external_resource_isolation_unproven"
  | "branch_write_overlap"
  | "parallel_write_execution_unavailable"
  | "branch_external_resource_overlap"
  | "invalid_execution_descriptor"
  | "execution_evidence_mismatch"
  | "budget_unavailable"
  | "insufficient_child_slots"
  | "async_dispatch_unavailable"
  | "single_independent_branch"
  | "multiple_independent_branches"
  | "parallel_request_downgraded_to_spawn"
  | "spawn_request_upgraded_to_parallel";

export interface SidecarDispatchBranchEvidence {
  id: string;
  selfContained: boolean;
  primaryDependency: SidecarPrimaryDependency;
  dependsOnBranchIds: string[];
  writeTargets: string[];
  externalResourceKeys: string[];
  execution: SubAgentExecutionDescriptor;
}

export interface SidecarDispatchEvidenceInput {
  requestPolicy: SidecarRequestPolicy;
  branches?: readonly SidecarDispatchBranchEvidence[];
  branchCount?: number;
  selfContained?: boolean;
  primaryDependency?: SidecarPrimaryDependency;
  writeIsolation?: SidecarIsolation;
  externalResourceIsolation?: SidecarIsolation;
  availableChildSlots: number;
  budgetAvailable: boolean;
  /** True only when the runtime owns non-blocking dispatch, receipt, and join. */
  asyncDispatchAvailable: false;
  requestedStrategy?: SidecarDispatchStrategy;
}

export interface SidecarDispatchEvidence {
  requestPolicy: SidecarRequestPolicy;
  branches: SidecarDispatchBranchEvidence[];
  branchCount: number;
  selfContained: boolean;
  primaryDependency: SidecarPrimaryDependency;
  writeIsolation: SidecarIsolation;
  externalResourceIsolation: SidecarIsolation;
  availableChildSlots: number;
  budgetAvailable: boolean;
  /** True only when the runtime owns non-blocking dispatch, receipt, and join. */
  asyncDispatchAvailable: false;
  requestedStrategy?: SidecarDispatchStrategy;
}

export interface SidecarDispatchDecision {
  version: 1;
  strategy: SidecarDispatchStrategy;
  requestedStrategy?: SidecarDispatchStrategy;
  tool: SidecarDispatchTool;
  reasonCodes: SidecarDispatchReasonCode[];
  primaryOverlap: boolean;
  concurrencyScope: "serial" | "sidecar_children" | "primary_and_sidecar";
  explanation: string;
}

const EXPLANATIONS: Record<SidecarDispatchReasonCode, string> = {
  non_sidecar_control: "This request changes or controls primary work and must remain on the serial primary path.",
  status_control: "Status requests are answered from authoritative runtime state and are not delegated.",
  explicit_serial: "Serial execution was explicitly requested.",
  explicit_defer: "Deferred execution was explicitly requested.",
  invalid_branch_count: "A positive integer branch count is required before delegated execution.",
  missing_branch_evidence: "Delegated sidecar execution requires typed per-branch evidence.",
  branch_identity_unproven: "Each delegated branch needs one unique non-empty branch ID.",
  input_not_self_contained: "The follow-up lacks a self-contained input package.",
  live_primary_dependency: "The follow-up depends on mutable in-flight primary state.",
  inter_branch_dependency_present: "At least one delegated branch depends on another branch.",
  write_isolation_unproven: "Disjoint write ownership has not been proven.",
  external_resource_isolation_unproven: "Independent external-resource ownership has not been proven.",
  branch_write_overlap: "At least two delegated branches claim overlapping write targets.",
  parallel_write_execution_unavailable: "Parallel child execution is restricted to read-only branches until isolated worktrees and a merge owner are available.",
  branch_external_resource_overlap: "At least two delegated branches claim overlapping external resources.",
  invalid_execution_descriptor: "The branch execution descriptor is invalid or cannot prove a safe execution mode.",
  execution_evidence_mismatch: "The execution descriptor does not exactly match the branch write and resource evidence.",
  budget_unavailable: "The current execution budget cannot safely fund another branch.",
  insufficient_child_slots: "The bounded child-agent pool has insufficient free slots.",
  async_dispatch_unavailable: "The runtime lacks non-blocking dispatch, durable receipt, and join support.",
  single_independent_branch: "One independent branch is delegated through spawn_agent.",
  multiple_independent_branches: "Two or more independent branches are delegated through parallel_agents.",
  parallel_request_downgraded_to_spawn: "A single branch cannot use parallel_agents and was deterministically downgraded to spawn_agent.",
  spawn_request_upgraded_to_parallel: "Multiple branches cannot be represented by one spawn_agent call and were deterministically upgraded to parallel_agents.",
};

function result(
  evidence: SidecarDispatchEvidence,
  strategy: SidecarDispatchStrategy,
  reasonCodes: SidecarDispatchReasonCode[],
): SidecarDispatchDecision {
  const tool: SidecarDispatchTool = strategy === "spawn_agent" || strategy === "parallel_agents"
    ? strategy
    : "none";
  return {
    version: 1,
    strategy,
    requestedStrategy: evidence.requestedStrategy,
    tool,
    reasonCodes,
    primaryOverlap: false,
    concurrencyScope: tool === "none"
      ? "serial"
      : "sidecar_children",
    explanation: reasonCodes.map(code => EXPLANATIONS[code]).join(" "),
  };
}

function unavailableStrategy(evidence: SidecarDispatchEvidence): "serial" | "defer" {
  return evidence.requestedStrategy === "spawn_agent" || evidence.requestedStrategy === "parallel_agents" ||
    evidence.requestedStrategy === "defer"
    ? "defer"
    : "serial";
}

function canonicalStringList(values: readonly string[] | undefined): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values || []) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function normalizePrimaryDependency(value: SidecarPrimaryDependency | undefined): SidecarPrimaryDependency {
  if (value === "live" || value === "snapshot" || value === "none") return value;
  return "none";
}

function normalizeBranch(
  branch: SidecarDispatchBranchEvidence,
): SidecarDispatchBranchEvidence {
  const execution = normalizeExecutionDescriptor(branch.execution) || {
    mode: "llm" as const,
    readOnly: false,
    writeTargets: [],
    externalResourceKeys: [],
  };
  return {
    id: typeof branch.id === "string" ? branch.id.trim() : "",
    selfContained: branch.selfContained === true,
    primaryDependency: normalizePrimaryDependency(branch.primaryDependency),
    dependsOnBranchIds: canonicalStringList(branch.dependsOnBranchIds),
    writeTargets: normalizeWriteTargets(branch.writeTargets) || [],
    externalResourceKeys: normalizeExternalResourceKeys(branch.externalResourceKeys) || [],
    execution,
  };
}

function strongestPrimaryDependency(
  branches: readonly SidecarDispatchBranchEvidence[],
): SidecarPrimaryDependency {
  if (branches.some(branch => branch.primaryDependency === "live")) return "live";
  if (branches.some(branch => branch.primaryDependency === "snapshot")) return "snapshot";
  return "none";
}

function hasSharedKey(
  branches: readonly SidecarDispatchBranchEvidence[],
  select: (branch: SidecarDispatchBranchEvidence) => readonly string[],
): boolean {
  const owners = new Map<string, string>();
  for (const branch of branches) {
    for (const key of select(branch)) {
      const owner = owners.get(key);
      if (owner && owner !== branch.id) return true;
      owners.set(key, branch.id);
    }
  }
  return false;
}

export function hasBranchIdentityIssue(
  branches: readonly SidecarDispatchBranchEvidence[],
): boolean {
  const ids = new Set<string>();
  for (const branch of branches) {
    if (!branch.id || ids.has(branch.id)) return true;
    ids.add(branch.id);
  }
  return false;
}

export function hasInterBranchDependency(
  branches: readonly SidecarDispatchBranchEvidence[],
): boolean {
  return branches.some(branch => branch.dependsOnBranchIds.length > 0);
}

export function deriveSidecarDispatchEvidence(
  input: SidecarDispatchEvidenceInput,
): SidecarDispatchEvidence {
  const branches = (input.branches || []).map(normalizeBranch);
  const derivedBranchCount = branches.length;
  const reportedBranchCount = Number.isSafeInteger(input.branchCount)
    ? Number(input.branchCount)
    : derivedBranchCount;
  const branchCount = reportedBranchCount === derivedBranchCount ? derivedBranchCount : 0;
  const writeIsolation = branches.length === 0
    ? "unknown"
    : hasSharedKey(branches, branch => branch.writeTargets)
      ? "shared"
      : "disjoint";
  const externalResourceIsolation = branches.length === 0
    ? "unknown"
    : hasSharedKey(branches, branch => branch.externalResourceKeys)
      ? "shared"
      : "disjoint";
  return {
    requestPolicy: input.requestPolicy,
    branches,
    branchCount,
    selfContained: branches.length > 0 && branches.every(branch => branch.selfContained),
    primaryDependency: strongestPrimaryDependency(branches),
    writeIsolation,
    externalResourceIsolation,
    availableChildSlots: input.availableChildSlots,
    budgetAvailable: input.budgetAvailable,
    asyncDispatchAvailable: input.asyncDispatchAvailable,
    requestedStrategy: input.requestedStrategy,
  };
}

/**
 * Decide how a follow-up may execute. The caller must derive every field from
 * trusted structured state; this function never infers semantics from prose.
 */
export function decideSidecarDispatch(evidence: SidecarDispatchEvidence): SidecarDispatchDecision {
  const derived = deriveSidecarDispatchEvidence(evidence);
  if (derived.requestPolicy === "status") {
    return result(derived, "serial", ["status_control"]);
  }
  if (derived.requestPolicy !== "sidecar") {
    return result(derived, "serial", ["non_sidecar_control"]);
  }
  if (derived.requestedStrategy === "serial") {
    return result(derived, "serial", ["explicit_serial"]);
  }
  if (derived.requestedStrategy === "defer") {
    return result(derived, "defer", ["explicit_defer"]);
  }

  const safetyReasons: SidecarDispatchReasonCode[] = [];
  if (!Number.isInteger(derived.branchCount) || derived.branchCount < 1) {
    safetyReasons.push("invalid_branch_count");
  }
  if (derived.branches.length === 0) {
    safetyReasons.push("missing_branch_evidence");
  } else {
    if (hasBranchIdentityIssue(derived.branches)) safetyReasons.push("branch_identity_unproven");
    if (!derived.selfContained) safetyReasons.push("input_not_self_contained");
    if (derived.primaryDependency === "live") safetyReasons.push("live_primary_dependency");
    if (hasInterBranchDependency(derived.branches)) safetyReasons.push("inter_branch_dependency_present");
    if (derived.writeIsolation === "shared") {
      safetyReasons.push("branch_write_overlap");
    } else if (derived.writeIsolation !== "disjoint") {
      safetyReasons.push("write_isolation_unproven");
    }
    if (derived.externalResourceIsolation === "shared") {
      safetyReasons.push("branch_external_resource_overlap");
    } else if (derived.externalResourceIsolation !== "disjoint") {
      safetyReasons.push("external_resource_isolation_unproven");
    }
  }
  if (safetyReasons.length > 0) return result(derived, "serial", safetyReasons);
  if (derived.branchCount > 1 && derived.branches.some(branch => branch.writeTargets.length > 0)) {
    return result(derived, "serial", ["parallel_write_execution_unavailable"]);
  }
  for (const branch of derived.branches) {
    if (executionDescriptorIssue(
      branch.execution,
      derived.branchCount === 1 ? "spawn_agent" : "parallel_agents",
    )) {
      return result(derived, "serial", ["invalid_execution_descriptor"]);
    }
    if (
      JSON.stringify(branch.writeTargets) !== JSON.stringify(branch.execution.writeTargets) ||
      JSON.stringify(branch.externalResourceKeys) !== JSON.stringify(branch.execution.externalResourceKeys)
    ) {
      return result(derived, "serial", ["execution_evidence_mismatch"]);
    }
  }

  const availabilityReasons: SidecarDispatchReasonCode[] = [];
  if (!derived.budgetAvailable) availabilityReasons.push("budget_unavailable");
  const requiredSlots = derived.branchCount === 1 ? 1 : 2;
  if (!Number.isInteger(derived.availableChildSlots) || derived.availableChildSlots < requiredSlots) {
    availabilityReasons.push("insufficient_child_slots");
  }
  if (availabilityReasons.length > 0) {
    return result(derived, unavailableStrategy(derived), availabilityReasons);
  }

  if (derived.branchCount === 1) {
    const reasons: SidecarDispatchReasonCode[] = ["single_independent_branch"];
    if (derived.requestedStrategy === "parallel_agents") {
      reasons.unshift("parallel_request_downgraded_to_spawn");
    }
    if (!derived.asyncDispatchAvailable) reasons.push("async_dispatch_unavailable");
    return result(derived, "spawn_agent", reasons);
  }

  const reasons: SidecarDispatchReasonCode[] = ["multiple_independent_branches"];
  if (derived.requestedStrategy === "spawn_agent") {
    reasons.unshift("spawn_request_upgraded_to_parallel");
  }
  if (!derived.asyncDispatchAvailable) reasons.push("async_dispatch_unavailable");
  return result(derived, "parallel_agents", reasons);
}
