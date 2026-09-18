/**
 * =============================================================================
 * Canvast — Sidecar Dispatch Tool / Sidecar 调度工具
 * =============================================================================
 * @file        src/harness/sidecar-dispatch-tool.ts
 * @brief       Exposes typed, observable sidecar dispatch decisions.
 * @description Keeps production registration and runtime-event projection out
 *              of the main harness extension while preserving a strict typed
 *              evidence boundary and fail-closed controller semantics.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { readRuntimeStatus, recordRuntimeEvent, upsertRuntimeStatusItem } from "./runtime-status.js";
import type {
  SidecarDispatchRecord,
  SidecarOrchestrationController,
} from "./sidecar-orchestration.js";

function executionStatus(record: SidecarDispatchRecord) {
  if (record.executionState === "completed") return "completed" as const;
  if (record.executionState === "failed") return "failed" as const;
  if (record.executionState === "admitted") return "running" as const;
  return "pending" as const;
}

export function projectSidecarDispatchRecord(agentDir: string, record: SidecarDispatchRecord): void {
  const rootRequestId = readRuntimeStatus(agentDir).rootExecution.rootRequestId;
  const reason = record.decision.reasonCodes.join(",") || "none";
  const childRuns = record.childRunIds.length > 0 ? record.childRunIds.join(",") : "none";
  const summary = [
    `strategy=${record.decision.strategy}`,
    `scope=${record.decision.concurrencyScope}`,
    `primary_overlap=${record.decision.primaryOverlap}`,
    `revision=${record.revision}`,
    `state=${record.executionState}`,
    `reasons=${reason}`,
    `child_runs=${childRuns}`,
    record.failureCode ? `failure=${record.failureCode}` : "",
  ].filter(Boolean).join(" | " );
  const sidecarDispatch = {
    strategy: record.decision.strategy, tool: record.decision.tool,
    reasonCodes: record.decision.reasonCodes, explanation: record.decision.explanation,
    revision: record.revision, executionState: record.executionState,
    concurrencyScope: record.decision.concurrencyScope, primaryOverlap: record.decision.primaryOverlap,
    childRunIds: record.childRunIds, failureCode: record.failureCode,
    branches: record.evidence.branches,
  };

  upsertRuntimeStatusItem(agentDir, {
    plane: "subAgents",
    item: {
      id: `sidecar-dispatch-${record.requestId}`,
      title: `Sidecar dispatch: ${record.decision.strategy}`,
      status: executionStatus(record),
      required: true,
      rootRequestId,
      summary,
      updatedAt: record.updatedAt,
      startedAt: record.recordedAt,
      completedAt: record.settledAt,
      sidecarDispatch,
    },
  });
  recordRuntimeEvent(agentDir, {
    id: `sidecar-dispatch-${record.requestId}-r${record.revision}-${record.executionState}`,
    timestamp: record.updatedAt,
    kind: "sidecar_dispatch",
    title: `Sidecar dispatch ${record.executionState}`,
    summary,
    source: "sidecar_orchestration",
    sidecarDispatch,
  });
}

export function registerSidecarDispatchTool(
  pi: ExtensionAPI,
  controller: SidecarOrchestrationController,
): void {
  pi.registerTool({
    name: "sidecar_dispatch_decision",
    label: "Sidecar Dispatch Decision / Sidecar 调度决策",
    description: [
      "Record a typed serial, delegated, or deferred execution decision for the active sidecar before any spawn_agent or parallel_agents call.",
      "Use explicit structured evidence only. Delegated execution requires per-branch IDs, dependency evidence, and disjoint write/resource ownership. Unknown isolation or live-primary dependency fails closed.",
      "当前运行时的 agent tools are synchronous: delegation may parallelize sidecar children, but does not overlap the primary request.",
      "在 sidecar 调用 spawn_agent 或 parallel_agents 前记录结构化调度决策；委派必须提供逐分支 ID、依赖、写入与外部资源证据，证据不足时关闭并行。当前仅支持 sidecar 内部子任务并发，不代表主线与 sidecar 真并行。",
    ].join(" "),
    parameters: Type.Object({
      expected_revision: Type.Integer({ minimum: 0 }),
      requested_strategy: Type.Optional(Type.Union([
        Type.Literal("serial"),
        Type.Literal("spawn_agent"),
        Type.Literal("parallel_agents"),
        Type.Literal("defer"),
      ])),
      branches: Type.Array(Type.Object({
        id: Type.String({ minLength: 1 }),
        self_contained: Type.Boolean(),
        primary_dependency: Type.Union([
          Type.Literal("none"),
          Type.Literal("snapshot"),
          Type.Literal("live"),
        ]),
        depends_on_branch_ids: Type.Array(Type.String()),
        write_targets: Type.Array(Type.String()),
        external_resource_keys: Type.Array(Type.String()),
        execution: Type.Object({
          mode: Type.Union([
            Type.Literal("llm"),
            Type.Literal("local_file_write"),
            Type.Literal("local_scan"),
          ]),
          read_only: Type.Boolean(),
          write_targets: Type.Array(Type.String()),
          external_resource_keys: Type.Array(Type.String()),
        }),
      }), { minItems: 0 }),
      branch_count: Type.Integer({ minimum: 1 }),
      self_contained: Type.Optional(Type.Boolean()),
      primary_dependency: Type.Optional(Type.Union([
        Type.Literal("none"),
        Type.Literal("snapshot"),
        Type.Literal("live"),
      ])),
      write_isolation: Type.Optional(Type.Union([
        Type.Literal("disjoint"),
        Type.Literal("shared"),
        Type.Literal("unknown"),
      ])),
      external_resource_isolation: Type.Optional(Type.Union([
        Type.Literal("disjoint"),
        Type.Literal("shared"),
        Type.Literal("unknown"),
      ])),
    }),
    async execute(_id: string, params: any): Promise<any> {
      try {
        const record = controller.recordSidecarDispatch({
          expectedRevision: params.expected_revision,
          requestedStrategy: params.requested_strategy,
          branchCount: params.branch_count,
          branches: Array.isArray(params.branches) ? params.branches.map((branch: any) => ({
            id: branch?.id,
            selfContained: branch?.self_contained,
            primaryDependency: branch?.primary_dependency,
            dependsOnBranchIds: branch?.depends_on_branch_ids,
            writeTargets: branch?.write_targets,
            externalResourceKeys: branch?.external_resource_keys,
            execution: {
              mode: branch?.execution?.mode,
              readOnly: branch?.execution?.read_only,
              writeTargets: branch?.execution?.write_targets,
              externalResourceKeys: branch?.execution?.external_resource_keys,
            },
          })) : [],
          selfContained: params.self_contained,
          primaryDependency: params.primary_dependency,
          writeIsolation: params.write_isolation,
          externalResourceIsolation: params.external_resource_isolation,
        });
        return {
          content: [{
            type: "text" as const,
            text: [
              "# Sidecar Dispatch Recorded",
              `request=${record.requestId}`,
              `revision=${record.revision}`,
              `strategy=${record.decision.strategy}`,
              `tool=${record.decision.tool}`,
              `scope=${record.decision.concurrencyScope}`,
              `primary_overlap=${record.decision.primaryOverlap}`,
              `state=${record.executionState}`,
              `reasons=${record.decision.reasonCodes.join(",") || "none"}`,
              "",
              record.decision.explanation,
            ].join("\n"),
          }],
          details: { dispatch: record },
        };
      } catch (error) {
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: `Sidecar dispatch decision rejected: ${error instanceof Error ? error.message : String(error)}`,
          }],
          details: { code: "sidecar_dispatch_rejected" },
        };
      }
    },
  });
}
