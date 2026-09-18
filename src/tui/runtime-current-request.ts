/**
 * =============================================================================
 * Canvast — Runtime Current Request Policy / Canvast 源文件
 * =============================================================================
 * @file        src/tui/runtime-current-request.ts
 * @brief       Decides how TUI follow-up inputs affect the current request row.
 * @description Keeps sidecar/status follow-ups from hijacking the active
 *              runtime task while allowing redirects, pauses, and normal new
 *              requests to replace it.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import {
  readRuntimeStatus,
  type RuntimeInputQueuePolicy,
} from "../harness/runtime-status.js";

export interface CurrentRequestRouting {
  replaceCurrent: boolean;
  queuePolicy: RuntimeInputQueuePolicy;
  affectsActiveWork: boolean;
}

export const CANVAST_RUNTIME_REQUEST_CONTROL_TYPE = "canvast.runtime-request-control/v1" as const;
export type RuntimeRequestControlPolicy = Exclude<RuntimeInputQueuePolicy, "none">;

/** Versioned routing metadata supplied by a trusted UI/control-plane producer. */
export interface RuntimeRequestControl {
  type: typeof CANVAST_RUNTIME_REQUEST_CONTROL_TYPE;
  policy: RuntimeRequestControlPolicy;
}

const CONTROL_POLICIES = new Set<RuntimeRequestControlPolicy>([
  "sidecar", "status", "task_adjustment", "redirect", "pause",
]);

export interface RuntimeRequestControlCommand {
  policy: RuntimeRequestControlPolicy;
  text: string;
}

/** Parse the explicit command transport without inferring policy from prose. */
export function parseRuntimeRequestControlCommand(args: string): RuntimeRequestControlCommand | undefined {
  const input = String(args || "").trim();
  const separator = input.indexOf(" ");
  if (separator <= 0) return undefined;
  const policy = input.slice(0, separator);
  const text = input.slice(separator + 1).trim();
  if (!text || !CONTROL_POLICIES.has(policy as RuntimeRequestControlPolicy)) return undefined;
  return { policy: policy as RuntimeRequestControlPolicy, text };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read `event.metadata.canvast.requestControl`; malformed input is ignored. */
export function runtimeRequestControlFromEvent(event: unknown): RuntimeRequestControl | undefined {
  if (!isRecord(event) || !isRecord(event.metadata)) return undefined;
  const canvast = event.metadata.canvast;
  if (!isRecord(canvast) || !isRecord(canvast.requestControl)) return undefined;
  const control = canvast.requestControl;
  if (control.type !== CANVAST_RUNTIME_REQUEST_CONTROL_TYPE) return undefined;
  if (typeof control.policy !== "string" || !CONTROL_POLICIES.has(control.policy as RuntimeRequestControlPolicy)) {
    return undefined;
  }
  return { type: CANVAST_RUNTIME_REQUEST_CONTROL_TYPE, policy: control.policy as RuntimeRequestControlPolicy };
}

export function routeIncomingRuntimeRequest(
  agentDir: string,
  _prompt: string,
  control?: RuntimeRequestControl,
): CurrentRequestRouting {
  const snapshot = readRuntimeStatus(agentDir);
  if (control?.policy === "pause" || control?.policy === "redirect" || control?.policy === "task_adjustment") {
    return { replaceCurrent: true, queuePolicy: control.policy, affectsActiveWork: true };
  }
  if (!snapshot.rootExecution.rootRequestId) {
    return { replaceCurrent: true, queuePolicy: "none", affectsActiveWork: false };
  }
  if (snapshot.rootExecution.reason === "pending_resume" && snapshot.rootExecution.state !== "working") {
    return { replaceCurrent: true, queuePolicy: "none", affectsActiveWork: false };
  }
  if (snapshot.rootExecution.state !== "idle" && snapshot.rootExecution.state !== "done") {
    return {
      replaceCurrent: false,
      queuePolicy: control?.policy === "status" ? "status" : "sidecar",
      affectsActiveWork: false,
    };
  }
  return { replaceCurrent: true, queuePolicy: "none", affectsActiveWork: false };
}

export function shouldReplaceCurrentRequest(
  agentDir: string,
  prompt: string,
  control?: RuntimeRequestControl,
): boolean {
  return routeIncomingRuntimeRequest(agentDir, prompt, control).replaceCurrent;
}
