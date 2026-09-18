/**
 * =============================================================================
 * Canvast — Sidecar Orchestration Routing / 旁路编排路由
 * =============================================================================
 * @file        src/harness/sidecar-orchestration-routing.ts
 * @brief       Keeps routing and correlation helpers out of the main state
 *              machine file.
 * @description Resolves runtime-input routing and normalizes policy/tool names
 *              for request-scoped sidecar orchestration.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import { agentPlanTools, normalizeToolName } from "./auto-orchestrator-constraints.js";
import {
  readRuntimeStatus,
  summarizeRuntimeInput,
  type RuntimeInputQueuePolicy,
  type RuntimeInputQueueStatus,
} from "./runtime-status.js";
import type { SidecarDispatchEvidence } from "./sidecar-dispatch-policy.js";

const ROUTABLE_QUEUE_STATUSES = new Set<RuntimeInputQueueStatus>([
  "queued",
  "delivered",
  "interrupt",
  "acknowledged",
]);

export interface RuntimeInputRoute {
  requestId: string;
  policy: RuntimeInputQueuePolicy;
  status: RuntimeInputQueueStatus;
}

export function isSidecarPolicy(policy: RuntimeInputQueuePolicy): boolean {
  return policy === "sidecar" || policy === "status";
}

export function dispatchPolicy(
  policy: RuntimeInputQueuePolicy | undefined,
): SidecarDispatchEvidence["requestPolicy"] {
  if (policy === "status" || policy === "task_adjustment" || policy === "redirect" || policy === "pause") {
    return policy;
  }
  return "sidecar";
}

export function dispatchToolName(event: { toolName?: unknown; tool_name?: unknown; name?: unknown }): string {
  return normalizeToolName(String(event.toolName || event.tool_name || event.name || ""));
}

export function dispatchToolInput(
  event: { input?: unknown; args?: unknown; arguments?: unknown },
): Record<string, unknown> {
  const candidate = event.input || event.args || event.arguments;
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    return candidate as Record<string, unknown>;
  }
  if (typeof candidate === "string") {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

export function runtimeInputResolver(
  agentDir: string | (() => string) | undefined,
): (prompt: string) => RuntimeInputRoute | undefined {
  if (!agentDir) return () => undefined;
  return prompt => {
    const dir = typeof agentDir === "function" ? agentDir() : agentDir;
    const summary = summarizeRuntimeInput(prompt, 180);
    const item = [...readRuntimeStatus(dir).inputQueue].reverse().find(candidate =>
      Boolean(candidate.requestId) &&
      candidate.textSummary === summary &&
      ROUTABLE_QUEUE_STATUSES.has(candidate.status),
    );
    return item?.requestId
      ? { requestId: item.requestId, policy: item.policy, status: item.status }
      : undefined;
  };
}

export { agentPlanTools };
