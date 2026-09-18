/**
 * =============================================================================
 * Canvast — Sub-Agent Dispatch Contract / 子 Agent 调度契约
 * =============================================================================
 * @file        src/agents/sub-agent-dispatch-contract.ts
 * @brief       Canonical typed execution descriptors shared by admission and execution.
 * @description Binds branch identity, execution mode, read-only state, writes,
 *              and external resources without inferring semantics from prose.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import * as path from "node:path";

export type SubAgentExecutionMode = "llm" | "local_file_write" | "local_scan";

export interface SubAgentExecutionDescriptor {
  mode: SubAgentExecutionMode;
  readOnly: boolean;
  writeTargets: string[];
  externalResourceKeys: string[];
}

export interface SubAgentBranchDescriptor {
  branchId: string;
  execution: SubAgentExecutionDescriptor;
}

export interface SubAgentDispatchInvocation {
  toolName: "spawn_agent" | "parallel_agents";
  branches: SubAgentBranchDescriptor[];
}

function canonicalStrings(values: unknown, normalize: (value: string) => string): string[] | undefined {
  if (!Array.isArray(values) || !values.every(value => typeof value === "string")) return undefined;
  const canonical = values.map(value => normalize(value.trim())).filter(Boolean);
  if (canonical.length !== values.length || new Set(canonical).size !== canonical.length) return undefined;
  return canonical.sort();
}

export function normalizeWriteTargets(values: unknown): string[] | undefined {
  return canonicalStrings(values, value => path.resolve(process.cwd(), value));
}

export function normalizeExternalResourceKeys(values: unknown): string[] | undefined {
  return canonicalStrings(values, value => value);
}

export function normalizeExecutionDescriptor(value: unknown): SubAgentExecutionDescriptor | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (
    input.mode !== "llm" &&
    input.mode !== "local_file_write" &&
    input.mode !== "local_scan"
  ) return undefined;
  if (typeof input.read_only !== "boolean" && typeof input.readOnly !== "boolean") return undefined;
  const writeTargets = normalizeWriteTargets(input.write_targets ?? input.writeTargets);
  const externalResourceKeys = normalizeExternalResourceKeys(
    input.external_resource_keys ?? input.externalResourceKeys,
  );
  if (!writeTargets || !externalResourceKeys) return undefined;
  return {
    mode: input.mode,
    readOnly: input.read_only === true || input.readOnly === true,
    writeTargets,
    externalResourceKeys,
  };
}

export function executionDescriptorIssue(
  descriptor: SubAgentExecutionDescriptor,
  toolName: "spawn_agent" | "parallel_agents",
): string | undefined {
  if (toolName === "parallel_agents" && descriptor.mode === "local_file_write") {
    return "parallel_agents does not support local_file_write execution";
  }
  if (toolName === "spawn_agent" && descriptor.mode === "local_scan") {
    return "spawn_agent does not support local_scan execution";
  }
  if (descriptor.mode === "llm" && !descriptor.readOnly) {
    return "generic LLM child execution must be explicitly read-only";
  }
  if (descriptor.mode === "local_scan" && (!descriptor.readOnly || descriptor.writeTargets.length > 0)) {
    return "local_scan execution must be read-only with no write targets";
  }
  if (descriptor.mode === "local_file_write" &&
      (descriptor.readOnly || descriptor.writeTargets.length !== 1 ||
       descriptor.externalResourceKeys.length > 0)) {
    return "local_file_write execution must declare exactly one write target and no external resources";
  }
  if (descriptor.readOnly && descriptor.writeTargets.length > 0) {
    return "read-only execution cannot declare write targets";
  }
  return undefined;
}

export function parseSubAgentDispatchInvocation(
  toolName: "spawn_agent" | "parallel_agents",
  input: Record<string, unknown>,
): SubAgentDispatchInvocation | undefined {
  const rawBranches = toolName === "spawn_agent" ? [input] : input.tasks;
  if (!Array.isArray(rawBranches)) return undefined;
  const branches: SubAgentBranchDescriptor[] = [];
  for (const raw of rawBranches) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const branch = raw as Record<string, unknown>;
    const branchId = typeof branch.branch_id === "string" ? branch.branch_id.trim() : "";
    const execution = normalizeExecutionDescriptor(branch.execution);
    if (!branchId || !execution || executionDescriptorIssue(execution, toolName)) return undefined;
    if (toolName === "parallel_agents" && branch.id !== branchId) return undefined;
    const actualMode = typeof branch.mode === "string" ? branch.mode : "llm";
    if (execution.mode !== actualMode) return undefined;
    if (toolName === "parallel_agents" && branch.read_only !== true) return undefined;
    if (toolName === "spawn_agent" && branch.read_only !== execution.readOnly) return undefined;
    if (execution.mode === "local_file_write") {
      const actualTargets = normalizeWriteTargets([branch.file_path]);
      if (!actualTargets || JSON.stringify(actualTargets) !== JSON.stringify(execution.writeTargets)) {
        return undefined;
      }
    }
    branches.push({ branchId, execution });
  }
  if (branches.length === 0 || new Set(branches.map(branch => branch.branchId)).size !== branches.length) {
    return undefined;
  }
  return { toolName, branches };
}

export function sameSubAgentDispatchInvocation(
  left: SubAgentDispatchInvocation,
  right: SubAgentDispatchInvocation,
): boolean {
  const canonical = (value: SubAgentDispatchInvocation) => ({
    ...value,
    branches: [...value.branches].sort((first, second) =>
      first.branchId.localeCompare(second.branchId)
    ),
  });
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}
