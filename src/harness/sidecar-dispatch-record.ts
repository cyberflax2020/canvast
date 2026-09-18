/**
 * =============================================================================
 * Canvast — Durable Sidecar Dispatch Record / Sidecar 持久调度记录
 * =============================================================================
 * @file        src/harness/sidecar-dispatch-record.ts
 * @brief       Validates persisted dispatch state and pre-execution admission.
 * @description Recomputes canonical policy decisions from typed evidence so
 *              stale or corrupted JSON can never become trusted tool authority.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import {
  decideSidecarDispatch,
  deriveSidecarDispatchEvidence,
  type SidecarDispatchBranchEvidence,
  type SidecarDispatchDecision,
  type SidecarDispatchEvidence,
  type SidecarDispatchEvidenceInput,
  type SidecarDispatchStrategy,
  type SidecarIsolation,
  type SidecarPrimaryDependency,
  type SidecarRequestPolicy,
} from "./sidecar-dispatch-policy.js";
import {
  normalizeExecutionDescriptor,
  parseSubAgentDispatchInvocation,
  sameSubAgentDispatchInvocation,
  type SubAgentDispatchInvocation,
} from "../agents/sub-agent-dispatch-contract.js";

export type SidecarDispatchExecutionState = "recorded" | "admitted" | "completed" | "failed";
export type SidecarDispatchFailureCode =
  | "tool_error"
  | "partial_failure"
  | "invalid_tool_result"
  | "tool_not_executed"
  | "tool_owner_reset"
  | "runtime_owner_unavailable_after_reload"
  | "invalid_persisted_dispatch";

export interface SidecarDispatchRecord {
  revision: number;
  requestId: string;
  recordedAt: string;
  evidence: SidecarDispatchEvidence;
  decision: SidecarDispatchDecision;
  executionState: SidecarDispatchExecutionState;
  updatedAt: string;
  settledAt?: string;
  failureCode?: SidecarDispatchFailureCode;
  toolCallId?: string;
  /** Stable logical run identifiers reported after execution, not OS process IDs. */
  childRunIds: string[];
}

export interface SidecarDispatchRuntimeEvidence {
  availableChildSlots: number;
  budgetAvailable: boolean;
  asyncDispatchAvailable: boolean;
}

const REQUEST_POLICIES = new Set<SidecarRequestPolicy>([
  "sidecar", "status", "task_adjustment", "redirect", "pause",
]);
const STRATEGIES = new Set<SidecarDispatchStrategy>([
  "serial", "spawn_agent", "parallel_agents", "defer",
]);
const PRIMARY_DEPENDENCIES = new Set<SidecarPrimaryDependency>(["none", "snapshot", "live"]);
const ISOLATIONS = new Set<SidecarIsolation>(["disjoint", "shared", "unknown"]);
const EXECUTION_STATES = new Set<SidecarDispatchExecutionState>([
  "recorded", "admitted", "completed", "failed",
]);
const FAILURE_CODES = new Set<SidecarDispatchFailureCode>([
  "tool_error",
  "partial_failure",
  "invalid_tool_result",
  "tool_not_executed",
  "tool_owner_reset",
  "runtime_owner_unavailable_after_reload",
  "invalid_persisted_dispatch",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function parseBranchEvidence(value: unknown): SidecarDispatchBranchEvidence | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== "string" ||
    typeof value.selfContained !== "boolean" ||
    !PRIMARY_DEPENDENCIES.has(value.primaryDependency as SidecarPrimaryDependency) ||
    !Array.isArray(value.dependsOnBranchIds) ||
    !value.dependsOnBranchIds.every(item => typeof item === "string") ||
    !Array.isArray(value.writeTargets) ||
    !value.writeTargets.every(item => typeof item === "string") ||
    !Array.isArray(value.externalResourceKeys) ||
    !value.externalResourceKeys.every(item => typeof item === "string") ||
    !value.execution
  ) return undefined;
  const execution = normalizeExecutionDescriptor(value.execution);
  if (!execution) return undefined;
  return {
    id: value.id,
    selfContained: value.selfContained,
    primaryDependency: value.primaryDependency as SidecarPrimaryDependency,
    dependsOnBranchIds: value.dependsOnBranchIds.map(String),
    writeTargets: value.writeTargets.map(String),
    externalResourceKeys: value.externalResourceKeys.map(String),
    execution,
  };
}

function parseEvidenceInput(value: unknown): SidecarDispatchEvidenceInput | undefined {
  if (!isRecord(value)) return undefined;
  const requestedStrategy = value.requestedStrategy;
  const branches = Array.isArray(value.branches)
    ? value.branches.map(parseBranchEvidence)
    : undefined;
  if (Array.isArray(value.branches) && branches?.some(branch => branch === undefined)) return undefined;
  if (
    !REQUEST_POLICIES.has(value.requestPolicy as SidecarRequestPolicy) ||
    (value.branchCount !== undefined && (!Number.isSafeInteger(value.branchCount) || Number(value.branchCount) < 1)) ||
    (value.selfContained !== undefined && typeof value.selfContained !== "boolean") ||
    (value.primaryDependency !== undefined && !PRIMARY_DEPENDENCIES.has(value.primaryDependency as SidecarPrimaryDependency)) ||
    (value.writeIsolation !== undefined && !ISOLATIONS.has(value.writeIsolation as SidecarIsolation)) ||
    (value.externalResourceIsolation !== undefined && !ISOLATIONS.has(value.externalResourceIsolation as SidecarIsolation)) ||
    !Number.isSafeInteger(value.availableChildSlots) || Number(value.availableChildSlots) < 0 ||
    typeof value.budgetAvailable !== "boolean" ||
    value.asyncDispatchAvailable !== false ||
    (requestedStrategy !== undefined && !STRATEGIES.has(requestedStrategy as SidecarDispatchStrategy))
  ) return undefined;
  return {
    requestPolicy: value.requestPolicy as SidecarRequestPolicy,
    branches: branches as SidecarDispatchBranchEvidence[] | undefined,
    branchCount: value.branchCount === undefined ? undefined : Number(value.branchCount),
    selfContained: value.selfContained as boolean | undefined,
    primaryDependency: value.primaryDependency as SidecarPrimaryDependency | undefined,
    writeIsolation: value.writeIsolation as SidecarIsolation | undefined,
    externalResourceIsolation: value.externalResourceIsolation as SidecarIsolation | undefined,
    availableChildSlots: Number(value.availableChildSlots),
    budgetAvailable: value.budgetAvailable,
    asyncDispatchAvailable: false,
    requestedStrategy: requestedStrategy as SidecarDispatchStrategy | undefined,
  };
}

function sameDecision(value: unknown, canonical: SidecarDispatchDecision): boolean {
  if (!isRecord(value) || !Array.isArray(value.reasonCodes)) return false;
  return value.version === canonical.version &&
    value.strategy === canonical.strategy &&
    value.requestedStrategy === canonical.requestedStrategy &&
    value.tool === canonical.tool &&
    value.primaryOverlap === canonical.primaryOverlap &&
    value.concurrencyScope === canonical.concurrencyScope &&
    value.explanation === canonical.explanation &&
    value.reasonCodes.length === canonical.reasonCodes.length &&
    value.reasonCodes.every((reason, index) => reason === canonical.reasonCodes[index]);
}

function invalidRecord(
  value: unknown,
  requestId: string,
  requestPolicy: SidecarRequestPolicy,
  now: string,
): SidecarDispatchRecord {
  const candidate = isRecord(value) ? value : {};
  const evidence = deriveSidecarDispatchEvidence({
    requestPolicy,
    branches: [],
    branchCount: 0,
    selfContained: false,
    primaryDependency: "live",
    writeIsolation: "unknown",
    externalResourceIsolation: "unknown",
    availableChildSlots: 0,
    budgetAvailable: false,
    asyncDispatchAvailable: false,
  });
  return {
    revision: Number.isSafeInteger(candidate.revision) && Number(candidate.revision) > 0 &&
      Number(candidate.revision) < Number.MAX_SAFE_INTEGER
      ? Number(candidate.revision)
      : 1,
    requestId,
    recordedAt: isTimestamp(candidate.recordedAt) ? candidate.recordedAt : now,
    evidence,
    decision: decideSidecarDispatch(evidence),
    executionState: "failed",
    updatedAt: now,
    settledAt: now,
    failureCode: "invalid_persisted_dispatch",
    childRunIds: [],
  };
}

function validStateFields(record: SidecarDispatchRecord): boolean {
  const hasToolCall = typeof record.toolCallId === "string" && record.toolCallId.length > 0;
  const hasSettlement = typeof record.settledAt === "string";
  const hasFailure = typeof record.failureCode === "string";
  const delegates = record.decision.tool !== "none";
  if (record.executionState === "recorded") {
    return !hasToolCall && !hasSettlement && !hasFailure && record.childRunIds.length === 0;
  }
  if (record.executionState === "admitted") {
    return delegates && hasToolCall && !hasSettlement && !hasFailure && record.childRunIds.length === 0;
  }
  if (record.executionState === "completed") {
    if (!hasSettlement || hasFailure) return false;
    if (!delegates) return !hasToolCall && record.childRunIds.length === 0;
    if (!hasToolCall || !hasCompletedOutcomeEvidence(record)) return false;
    return true;
  }
  if (!hasSettlement || !hasFailure || !record.failureCode) return false;
  if (record.childRunIds.length > 0 && !hasToolCall) return false;
  if (record.failureCode === "invalid_persisted_dispatch") return !hasToolCall;
  if (!delegates) return false;
  if (record.failureCode === "runtime_owner_unavailable_after_reload") return hasToolCall;
  if (record.failureCode === "tool_not_executed") return !hasToolCall;
  if (record.failureCode === "tool_owner_reset") return hasToolCall;
  return hasToolCall;
}

function hasCompletedOutcomeEvidence(record: SidecarDispatchRecord): boolean {
  if (record.decision.tool === "spawn_agent") {
    return record.evidence.branchCount === 1 && record.childRunIds.length >= 1;
  }
  if (record.decision.tool === "parallel_agents") {
    return record.evidence.branchCount >= 1 && record.childRunIds.length >= record.evidence.branchCount + 1;
  }
  return record.childRunIds.length === 0;
}

/** Parse untrusted JSON into a canonical latest-revision record. */
export function parsePersistedSidecarDispatch(
  value: unknown,
  requestId: string,
  requestPolicy: SidecarRequestPolicy,
  requestCompleted: boolean,
  now: string,
): SidecarDispatchRecord | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return invalidRecord(value, requestId, requestPolicy, now);
  const evidenceInput = parseEvidenceInput(value.evidence);
  const evidence = evidenceInput ? deriveSidecarDispatchEvidence(evidenceInput) : undefined;
  const canonical = evidence ? decideSidecarDispatch(evidence) : undefined;
  const childRunIds = Array.isArray(value.childRunIds) && value.childRunIds.every(item =>
    typeof item === "string" && item.trim().length > 0
  ) ? value.childRunIds.map(String) : undefined;
  const executionState = value.executionState as SidecarDispatchExecutionState;
  const failureCode = value.failureCode as SidecarDispatchFailureCode | undefined;
  const updatedAt = value.updatedAt === undefined ? value.recordedAt : value.updatedAt;
  if (
    value.requestId !== requestId ||
    !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 ||
    Number(value.revision) >= Number.MAX_SAFE_INTEGER ||
    !isTimestamp(value.recordedAt) || !isTimestamp(updatedAt) ||
    !evidence || evidence.requestPolicy !== requestPolicy || !canonical || !sameDecision(value.decision, canonical) ||
    !EXECUTION_STATES.has(executionState) ||
    (failureCode !== undefined && !FAILURE_CODES.has(failureCode)) ||
    !childRunIds || new Set(childRunIds).size !== childRunIds.length ||
    (value.settledAt !== undefined && !isTimestamp(value.settledAt)) ||
    (value.toolCallId !== undefined && (typeof value.toolCallId !== "string" || !value.toolCallId.trim()))
  ) return invalidRecord(value, requestId, requestPolicy, now);

  const parsed: SidecarDispatchRecord = {
    revision: Number(value.revision),
    requestId,
    recordedAt: value.recordedAt,
    evidence,
    decision: canonical,
    executionState,
    updatedAt,
    settledAt: value.settledAt as string | undefined,
    failureCode,
    toolCallId: typeof value.toolCallId === "string" ? value.toolCallId.trim() : undefined,
    childRunIds,
  };
  if (!validStateFields(parsed) || (requestCompleted && ["recorded", "admitted"].includes(parsed.executionState))) {
    return invalidRecord(value, requestId, requestPolicy, now);
  }
  return parsed;
}

export function collectSidecarChildRunIds(details: unknown): string[] {
  if (!isRecord(details)) return [];
  const ids: unknown[] = [details.runId];
  if (Array.isArray(details.childRunIds)) ids.push(...details.childRunIds);
  if (Array.isArray(details.results)) {
    for (const item of details.results) if (isRecord(item)) ids.push(item.runId);
  }
  return Array.from(new Set(ids.filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  )));
}

function nonEmptyRunId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function completedTerminalCause(value: unknown): boolean {
  return value === undefined || value === "completed";
}

function failedTerminalCause(value: unknown): boolean {
  return value === "timeout" || value === "emergency_stop" ||
    value === "cleanup_failed" || value === "cancelled";
}

function successfulRunResult(value: unknown): value is Record<string, unknown> & {
  success: true;
  runId: string;
} {
  return isRecord(value) &&
    value.success === true &&
    nonEmptyRunId(value.runId) &&
    value.timedOut !== true &&
    value.cleanupFailed !== true &&
    value.outcomeUnknown !== true &&
    completedTerminalCause(value.terminalCause);
}

function explicitBranchFailure(value: unknown): boolean {
  return isRecord(value) && (
    value.success === false ||
    value.timedOut === true ||
    value.cleanupFailed === true ||
    value.outcomeUnknown === true ||
    failedTerminalCause(value.terminalCause)
  );
}

function inputTaskIds(input: Record<string, unknown>): string[] | undefined {
  const tasks = input.tasks;
  if (!Array.isArray(tasks)) return undefined;
  const ids: string[] = [];
  for (const task of tasks) {
    if (!isRecord(task) || typeof task.id !== "string") return undefined;
    ids.push(task.id.trim());
  }
  return ids;
}

function inputTasksAreExplicitlyReadOnly(input: Record<string, unknown>): boolean {
  return Array.isArray(input.tasks) && input.tasks.every(task =>
    isRecord(task) && task.read_only === true
  );
}

function idsMatch(expected: readonly string[], actual: readonly string[]): boolean {
  if (expected.length !== actual.length) return false;
  const left = [...expected].sort();
  const right = [...actual].sort();
  return left.every((value, index) => value === right[index]);
}

export function sidecarDispatchResultFailure(
  event: { isError?: boolean; details?: unknown },
  toolName: "spawn_agent" | "parallel_agents",
  expectedBranches: readonly SidecarDispatchBranchEvidence[],
): SidecarDispatchFailureCode | undefined {
  if (!isRecord(event.details)) {
    return event.isError === true ? "tool_error" : "invalid_tool_result";
  }
  const details = event.details;
  if (toolName === "spawn_agent") {
    if (event.isError === true) return "tool_error";
    const branch = expectedBranches[0];
    const resultInvocation = parseSubAgentDispatchInvocation("spawn_agent", {
      branch_id: details.branchId,
      mode: isRecord(details.execution) ? details.execution.mode : undefined,
      read_only: isRecord(details.execution)
        ? details.execution.readOnly ?? details.execution.read_only
        : undefined,
      execution: details.execution,
      file_path: isRecord(details.execution) && Array.isArray(details.execution.writeTargets)
        ? details.execution.writeTargets[0]
        : undefined,
    });
    const expectedInvocation: SubAgentDispatchInvocation = {
      toolName: "spawn_agent",
      branches: branch ? [{ branchId: branch.id, execution: branch.execution }] : [],
    };
    return event.isError === false && expectedBranches.length === 1 &&
      Boolean(resultInvocation && sameSubAgentDispatchInvocation(expectedInvocation, resultInvocation)) &&
      successfulRunResult(details)
      ? undefined
      : "invalid_tool_result";
  }

  const results = Array.isArray(details.results) ? details.results : undefined;
  const branchFailure = details.status === "failed" || details.status === "partial_failure" ||
    (typeof details.failedCount === "number" && details.failedCount > 0) ||
    Boolean(results?.some(item => explicitBranchFailure(item)));
  if (branchFailure) return "partial_failure";
  if (event.isError === true) return "tool_error";
  const expectedInvocation: SubAgentDispatchInvocation = {
    toolName: "parallel_agents",
    branches: expectedBranches.map(branch => ({ branchId: branch.id, execution: branch.execution })),
  };
  const resultInvocation = isRecord(details.dispatch)
    ? parseSubAgentDispatchInvocation("parallel_agents", {
        tasks: Array.isArray(details.dispatch.branches)
          ? details.dispatch.branches.map(branch => isRecord(branch) ? {
              id: branch.branchId,
              branch_id: branch.branchId,
              mode: isRecord(branch.execution) ? branch.execution.mode : undefined,
              read_only: true,
              execution: branch.execution,
            } : branch)
          : undefined,
      })
    : undefined;
  const resultReceipts = results?.map(item => {
    if (!isRecord(item)) return undefined;
    return {
      branchId: typeof item.branchId === "string" ? item.branchId : "",
      execution: normalizeExecutionDescriptor(item.execution),
    };
  });
  const validReceipts = resultReceipts?.every(receipt => receipt?.execution) &&
    resultReceipts?.length === expectedBranches.length &&
    expectedBranches.every(expected => resultReceipts.some(receipt =>
      receipt?.branchId === expected.id &&
      JSON.stringify(receipt.execution) === JSON.stringify(expected.execution)
    ));
  const validResults = results?.length === expectedBranches.length &&
    results.every(item => successfulRunResult(item)) &&
    new Set(results.map(item => item.runId)).size === results.length &&
    !results.some(item => item.runId === details.runId) &&
    validReceipts;
  return event.isError === false && details.status === "completed" &&
    details.failedCount === 0 &&
    successfulRunResult({ ...details, success: true }) &&
    Boolean(resultInvocation && sameSubAgentDispatchInvocation(expectedInvocation, resultInvocation)) &&
    validResults
    ? undefined
    : "invalid_tool_result";
}

export function sidecarDispatchAdmissionIssue(
  record: SidecarDispatchRecord,
  toolName: string,
  input: Record<string, unknown>,
  runtime: SidecarDispatchRuntimeEvidence,
): string | undefined {
  const expectedBranchIds = record.evidence.branches.map(branch => branch.id);
  const expectedInvocation: SubAgentDispatchInvocation = {
    toolName: toolName as "spawn_agent" | "parallel_agents",
    branches: record.evidence.branches.map(branch => ({
      branchId: branch.id,
      execution: branch.execution,
    })),
  };
  if (toolName === "parallel_agents") {
    const actualBranches = Array.isArray(input.tasks) ? input.tasks.length : -1;
    if (actualBranches !== record.evidence.branchCount) {
      return `Recorded branch_count=${record.evidence.branchCount}, but parallel_agents received ${actualBranches < 0 ? "no tasks array" : `${actualBranches} tasks`}. Record a new matching dispatch revision. / 已记录分支数与实际任务数不一致，请重新记录匹配的调度版本。`;
    }
    const actualIds = inputTaskIds(input);
    if (!actualIds || !idsMatch(expectedBranchIds, actualIds)) {
      return `Recorded branch IDs must exactly match parallel_agents task IDs. Record a new matching dispatch revision. / 已记录 branch ID 必须与 parallel_agents 的 task ID 精确匹配，请重新记录匹配的调度版本。`;
    }
    if (!inputTasksAreExplicitlyReadOnly(input)) {
      return "Every parallel_agents task must set read_only=true. Parallel writes remain serial until isolated worktrees and a merge owner are available. / parallel_agents 的每个任务都必须显式设置 read_only=true；在独立 worktree 和合并 owner 可用前，并行写任务保持串行。";
    }
  }
  if (toolName === "spawn_agent") {
    const actualTask = typeof input.task === "string" ? input.task.trim() : "";
    if (record.evidence.branchCount !== 1 || expectedBranchIds.length !== 1 || !actualTask) {
      return "Spawn admission requires exactly one recorded branch and a non-empty task. Record a new matching dispatch revision. / spawn_agent 准入需要恰好一个已记录分支且 task 非空，请重新记录匹配的调度版本。";
    }
  }
  const actualInvocation = toolName === "spawn_agent" || toolName === "parallel_agents"
    ? parseSubAgentDispatchInvocation(toolName, input)
    : undefined;
  if (!actualInvocation || !sameSubAgentDispatchInvocation(expectedInvocation, actualInvocation)) {
    return "Agent execution must exactly match the recorded branch ID, mode, read-only state, write targets, and external resources. Record a new matching dispatch revision. / Agent 执行必须与已记录的分支 ID、模式、只读状态、写目标和外部资源精确一致，请重新记录匹配的调度版本。";
  }
  if (!runtime.budgetAvailable) {
    return "The sidecar execution budget changed before tool admission. Record a new dispatch revision. / 工具准入前预算已变化，请重新记录调度版本。";
  }
  const requiredSlots = toolName === "parallel_agents" ? 2 : 1;
  if (!Number.isSafeInteger(runtime.availableChildSlots) || runtime.availableChildSlots < requiredSlots) {
    return `Child capacity changed before tool admission; ${requiredSlots} slot(s) required and ${runtime.availableChildSlots} reported. Record a new dispatch revision. / 工具准入前子 Agent 容量已变化，请重新记录调度版本。`;
  }
  return undefined;
}
