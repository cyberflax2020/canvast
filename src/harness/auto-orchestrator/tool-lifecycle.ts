/**
 * =============================================================================
 * Canvast — Orchestration Tool Lifecycle / 编排工具生命周期
 * =============================================================================
 * @file        src/harness/auto-orchestrator/tool-lifecycle.ts
 * @brief       Commits orchestration gates from matched successful results.
 * @description Tracks admitted state-changing orchestration calls by call ID so
 *              admission, failure, cancellation, and stale results cannot
 *              prematurely unlock later execution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import { isAgentLaunchTool, normalizeToolName } from "../auto-orchestrator-constraints.js";
import type {
  OrchestrationExecutionState,
  ToolBlockDecision,
  ToolCallEvent,
  ToolResultEvent,
} from "./types.js";

type LifecycleToolKind = "agent_launch" | "plan_proposal" | "plan_approval";
type LifecycleCallState = "pending" | "succeeded" | "failed";

interface LifecycleCall {
  kind: LifecycleToolKind;
  toolName: string;
  state: LifecycleCallState;
  planRevision?: number;
}

function lifecycleToolKind(toolName: string): LifecycleToolKind | undefined {
  if (isAgentLaunchTool(toolName)) return "agent_launch";
  const normalized = normalizeToolName(toolName);
  if (normalized === "propose_plan") return "plan_proposal";
  if (normalized === "approve_plan") return "plan_approval";
  return undefined;
}

function callId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function resultWasCancelled(event: ToolResultEvent): boolean {
  if (event.aborted === true || event.cancelled === true || event.interrupted === true) return true;
  if (!event.details || typeof event.details !== "object") return false;
  const details = event.details as Record<string, unknown>;
  if (details.aborted === true || details.cancelled === true || details.interrupted === true) return true;
  const status = String(details.status || details.reason || "").toLowerCase();
  return status === "aborted" || status === "cancelled" || status === "interrupted";
}

function resultHasStructuredSuccess(call: LifecycleCall, event: ToolResultEvent): boolean {
  if (!event.details || typeof event.details !== "object" || Array.isArray(event.details)) return false;
  const details = event.details as Record<string, unknown>;
  if (call.kind === "plan_proposal") return details.status === "proposed";
  if (call.kind === "plan_approval") return details.status === "approved";
  if (call.toolName === "parallel_agents") {
    return details.status === "completed" && details.failedCount === 0;
  }
  return details.success === true;
}

export function createOrchestrationToolLifecycle() {
  const calls = new Map<string, LifecycleCall>();
  const settledResultIds = new Set<string>();
  let agentLaunched = false;
  let planProposed = false;
  let planApproved = false;
  let planRevision = 0;

  function executionState(): OrchestrationExecutionState {
    return { agentLaunched, planProposed, planApproved };
  }

  return {
    executionState,

    reset(): void {
      calls.clear();
      settledResultIds.clear();
      agentLaunched = false;
      planProposed = false;
      planApproved = false;
      planRevision = 0;
    },

    resetPending(): void {
      for (const call of calls.values()) {
        if (call.state === "pending") call.state = "failed";
      }
    },

    admit(event: ToolCallEvent): ToolBlockDecision {
      const toolName = normalizeToolName(String(event.toolName || event.tool_name || event.name || ""));
      const kind = lifecycleToolKind(toolName);
      if (!kind) return { block: false };

      const id = callId(event.toolCallId);
      if (!id) {
        return {
          block: true,
          reason: `${toolName} requires a non-empty toolCallId so its result can be matched before orchestration state advances. / ${toolName} 必须携带非空 toolCallId，只有匹配结果返回后才能推进编排状态。`,
        };
      }
      if (calls.has(id) || settledResultIds.has(id)) {
        return {
          block: true,
          reason: `Duplicate orchestration toolCallId ${id} was rejected; each lifecycle call must have a unique ID. / 编排工具调用 ID ${id} 重复；每次生命周期调用必须使用唯一 ID。`,
        };
      }
      if (kind === "plan_approval" && !planProposed) {
        return {
          block: true,
          reason: "approve_plan requires a matching successful propose_plan result first. / approve_plan 前必须先收到匹配且成功的 propose_plan 结果。",
        };
      }

      if (kind === "plan_proposal") {
        planRevision += 1;
        planProposed = false;
        planApproved = false;
      }
      calls.set(id, {
        kind,
        toolName,
        state: "pending",
        planRevision: kind === "plan_proposal" || kind === "plan_approval"
          ? planRevision
          : undefined,
      });
      return { block: false };
    },

    resolve(event: ToolResultEvent): void {
      const id = callId(event.toolCallId);
      if (!id) return;
      if (settledResultIds.has(id)) return;
      settledResultIds.add(id);
      const call = calls.get(id);
      if (!call || call.state !== "pending") return;

      const resultToolName = normalizeToolName(String(event.toolName || ""));
      const matchingResult = resultToolName === call.toolName;
      const succeeded =
        matchingResult &&
        event.isError === false &&
        !resultWasCancelled(event) &&
        resultHasStructuredSuccess(call, event);
      call.state = succeeded ? "succeeded" : "failed";
      if (!succeeded) return;

      if (call.kind === "agent_launch") {
        agentLaunched = true;
        return;
      }
      if (call.kind === "plan_proposal") {
        if (call.planRevision === planRevision) planProposed = true;
        return;
      }
      if (
        call.kind === "plan_approval" &&
        planProposed &&
        call.planRevision === planRevision
      ) {
        planApproved = true;
      }
    },
  };
}
