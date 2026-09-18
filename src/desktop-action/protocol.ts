/**
 * =============================================================================
 * Canvast — Desktop Action Protocol / 桌面动作协议
 * =============================================================================
 * @file        src/desktop-action/protocol.ts
 * @brief       Versioned JSON contract for deterministic desktop actions.
 * @description Validates the native desktop request envelope and decodes the
 *              tagged values emitted by the Swift client without involving an
 *              LLM or natural-language action routing.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import { Type } from "@sinclair/typebox";

export const DESKTOP_ACTION_PROTOCOL_VERSION = 1 as const;
export const DESKTOP_ACTION_RESULT_TYPE = "canvast-desktop-action-result";

export const DESKTOP_ACTION_WORKSPACES = [
  "run", "planning", "orchestration", "canvas", "safety", "project",
] as const;

export const DESKTOP_ACTION_KINDS = [
  "session.new",
  "session.catalog",
  "session.open",
  "session.rename",
  "session.delete",
  "session.transcript",
  "session.projectRestart",
  "project.preflight",
  "project.create",
  "project.open",
  "project.reinitialize",
  "project.delete",
  "runtime.mode",
  "runtime.requestControl",
  "resume.inspect",
  "resume.choose",
  "resume.claim",
  "resume.rebind",
  "resume.retire",
  "resume.reconcile",
  "permission.set",
  "plan.create",
  "plan.update",
  "plan.approve",
  "plan.complete",
  "task.create",
  "task.update",
  "canvas.task.select",
  "canvas.plan.select",
  "canvas.export",
  "canvas.export.cancel",
  "project.scope.inspect",
  "project.scope.rebind",
  "sandbox.inspect",
  "sandbox.profile.set",
  "sandbox.grant",
  "sandbox.revoke",
  "agent.launch",
  "agent.cancel",
  "agent.followUp",
  "workflow.launch",
  "workflow.cancel",
  "workflow.followUp",
] as const;

export const PLAN_UPDATE_STATUSES = ["in_progress", "completed"] as const;

export type DesktopActionWorkspace = typeof DESKTOP_ACTION_WORKSPACES[number];
export type DesktopActionKind = typeof DESKTOP_ACTION_KINDS[number];
export type DesktopActionStatus = "succeeded" | "failed" | "unsupported";
export type DesktopActionCapabilityLevel = "full" | "degraded" | "unsupported";
export type DesktopJsonValue = string | number | boolean | null | DesktopJsonValue[] | { [key: string]: DesktopJsonValue };

export interface DesktopActionRequest {
  protocolVersion: typeof DESKTOP_ACTION_PROTOCOL_VERSION;
  requestId: string;
  workspace: DesktopActionWorkspace;
  kind: string;
  featureID: string;
  arguments: Record<string, unknown>;
}

export interface DesktopActionError {
  code: string;
  message: string;
  details?: DesktopJsonValue;
}

export interface DesktopActionResult {
  protocolVersion: typeof DESKTOP_ACTION_PROTOCOL_VERSION;
  requestId: string;
  status: DesktopActionStatus;
  result?: Record<string, DesktopJsonValue>;
  error?: DesktopActionError;
  capabilityLevel: DesktopActionCapabilityLevel;
}

export const DesktopActionRequestSchema = Type.Object({
  protocolVersion: Type.Literal(DESKTOP_ACTION_PROTOCOL_VERSION),
  requestId: Type.String({ minLength: 1, maxLength: 256 }),
  workspace: Type.Union(DESKTOP_ACTION_WORKSPACES.map(value => Type.Literal(value))),
  kind: Type.String({ minLength: 1 }),
  featureID: Type.String({ minLength: 1 }),
  arguments: Type.Record(Type.String(), Type.Unknown()),
}, { additionalProperties: false });

export class DesktopActionProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly requestId = "invalid-request",
    readonly details?: DesktopJsonValue,
  ) {
    super(message);
    this.name = "DesktopActionProtocolError";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string, requestId: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new DesktopActionProtocolError("invalid_request", `${key} must be a non-empty string.`, requestId);
  }
  return value.trim();
}

function decodeTaggedValue(value: unknown, requestId: string): unknown {
  if (Array.isArray(value)) return value.map(item => decodeTaggedValue(item, requestId));
  if (!isRecord(value)) return value;
  const tag = value.type;
  if (tag === "string") {
    if (typeof value.string !== "string") throw new DesktopActionProtocolError("invalid_argument", "Tagged string value is invalid.", requestId);
    return value.string;
  }
  if (tag === "integer") {
    if (typeof value.integer !== "number" || !Number.isInteger(value.integer)) throw new DesktopActionProtocolError("invalid_argument", "Tagged integer value is invalid.", requestId);
    return value.integer;
  }
  if (tag === "boolean") {
    if (typeof value.boolean !== "boolean") throw new DesktopActionProtocolError("invalid_argument", "Tagged boolean value is invalid.", requestId);
    return value.boolean;
  }
  if (tag === "strings") {
    if (!Array.isArray(value.strings) || !value.strings.every(item => typeof item === "string")) {
      throw new DesktopActionProtocolError("invalid_argument", "Tagged strings value is invalid.", requestId);
    }
    return [...value.strings];
  }
  const decoded: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) decoded[key] = decodeTaggedValue(child, requestId);
  return decoded;
}

export function normalizeDesktopActionKind(value: string): string {
  switch (value) {
  case "newSession": return "session.new";
  case "listSessions": return "session.catalog";
  case "openSession": return "session.open";
  case "renameSession": return "session.rename";
  case "deleteSession": return "session.delete";
  case "readSessionTranscript": return "session.transcript";
  case "projectRestart": return "session.projectRestart";
  case "projectPreflight": return "project.preflight";
  case "createProject": return "project.create";
  case "openProject": return "project.open";
  case "reinitializeProject": return "project.reinitialize";
  case "deleteProject":
  case "retireProject": return "project.delete";
  case "setRuntimeMode": return "runtime.mode";
  case "requestControl": return "runtime.requestControl";
  case "inspectResume": return "resume.inspect";
  case "chooseResume": return "resume.choose";
  case "claimResume": return "resume.claim";
  case "rebindResume": return "resume.rebind";
  case "retireResume": return "resume.retire";
  case "reconcileResume": return "resume.reconcile";
  case "setPermissionMode": return "permission.set";
  case "createPlan": return "plan.create";
  case "updatePlan": return "plan.update";
  case "approvePlan": return "plan.approve";
  case "completePlan": return "plan.complete";
  case "createTask": return "task.create";
  case "updateTask": return "task.update";
  case "selectCanvasTask": return "canvas.task.select";
  case "selectCanvasPlan": return "canvas.plan.select";
  case "exportCanvas": return "canvas.export";
  case "cancelCanvasExport": return "canvas.export.cancel";
  case "inspectProjectScope": return "project.scope.inspect";
  case "rebindProjectScope": return "project.scope.rebind";
  case "inspectSandbox": return "sandbox.inspect";
  case "setSandboxProfile": return "sandbox.profile.set";
  case "grantSandboxAccess": return "sandbox.grant";
  case "revokeSandboxAccess": return "sandbox.revoke";
  case "spawnAgent": return "agent.launch";
  case "cancelAgent": return "agent.cancel";
  case "followUpAgent": return "agent.followUp";
  case "runWorkflow": return "workflow.launch";
  case "cancelWorkflow": return "workflow.cancel";
  case "followUpWorkflow": return "workflow.followUp";
  default: return value;
  }
}

const REQUEST_CONTROL_POLICIES = new Set([
  "sidecar", "status", "pause", "redirect", "task_adjustment",
]);

export function isSafeCanvasExportName(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 96 || value.startsWith(".")) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    const allowed = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) || character === "-" || character === "_";
    if (!allowed) return false;
  }
  return true;
}

function exactArguments(
  action: DesktopActionRequest, accepted: readonly string[],
): void {
  const unexpected = Object.keys(action.arguments).filter(key => !accepted.includes(key)).sort();
  if (unexpected.length > 0) {
    throw new DesktopActionProtocolError(
      "invalid_arguments", `${action.kind} does not accept: ${unexpected.join(", ")}.`,
      action.requestId, { unexpectedArguments: unexpected },
    );
  }
}

function actionText(
  args: Record<string, unknown>, names: readonly string[], requestId: string, label: string,
): string {
  for (const name of names) {
    const value = args[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  throw new DesktopActionProtocolError("invalid_arguments", `${label} must be a non-empty string.`, requestId, {
    acceptedNames: [...names],
  });
}

/** Validate contracts used by native capability UIs before any live owner can mutate state. */
export function validateDesktopActionArguments(action: DesktopActionRequest): void {
  const args = action.arguments;
  switch (action.kind) {
  case "session.open":
  case "session.transcript":
    actionText(args, ["sessionPath", "path"], action.requestId, "Session path");
    break;
  case "session.rename":
    actionText(args, ["name", "title"], action.requestId, "Session name");
    if (args.sessionPath !== undefined && typeof args.sessionPath !== "string") {
      throw new DesktopActionProtocolError(
        "invalid_arguments",
        "session.rename sessionPath must be a string when provided.",
        action.requestId,
      );
    }
    break;
  case "session.delete":
    exactArguments(action, ["sessionPath", "path"]);
    actionText(args, ["sessionPath", "path"], action.requestId, "Session path");
    break;
  case "project.preflight":
    exactArguments(action, ["path", "projectPath", "replacementPath", "operation"]);
    actionText(args, ["path", "projectPath"], action.requestId, "Project path");
    if (args.operation !== "create" && args.operation !== "open"
      && args.operation !== "reinitialize" && args.operation !== "retire") {
      const invalidOperation = typeof args.operation === "string" ? args.operation : String(args.operation);
      throw new DesktopActionProtocolError(
        "invalid_arguments",
        "project.preflight operation must be create, open, reinitialize, or retire.",
        action.requestId,
        { operation: invalidOperation, acceptedOperations: ["create", "open", "reinitialize", "retire"] },
      );
    }
    if (args.replacementPath !== undefined && typeof args.replacementPath !== "string") {
      throw new DesktopActionProtocolError(
        "invalid_arguments",
        "project.preflight replacementPath must be a string when provided.",
        action.requestId,
      );
    }
    break;
  case "project.create":
  case "project.open":
  case "project.reinitialize":
  case "project.delete":
    exactArguments(action, [
      "path", "projectPath", "replacementPath", "expectedRevision", "approvedAcknowledgement",
    ]);
    actionText(args, ["path", "projectPath"], action.requestId, "Project path");
    if (args.replacementPath !== undefined && typeof args.replacementPath !== "string") {
      throw new DesktopActionProtocolError(
        "invalid_arguments",
        `${action.kind} replacementPath must be a string when provided.`,
        action.requestId,
      );
    }
    if (args.expectedRevision !== undefined && typeof args.expectedRevision !== "string") {
      throw new DesktopActionProtocolError(
        "invalid_arguments",
        `${action.kind} expectedRevision must be a string when provided.`,
        action.requestId,
      );
    }
    if (args.approvedAcknowledgement !== undefined && typeof args.approvedAcknowledgement !== "boolean") {
      throw new DesktopActionProtocolError(
        "invalid_arguments",
        `${action.kind} approvedAcknowledgement must be a boolean when provided.`,
        action.requestId,
      );
    }
    break;
  case "runtime.requestControl": {
    const policy = actionText(args, ["policy"], action.requestId, "policy");
    if (!REQUEST_CONTROL_POLICIES.has(policy)) {
      throw new DesktopActionProtocolError(
        "invalid_arguments", `Unsupported request-control policy: ${policy}.`, action.requestId,
        { policy, acceptedPolicies: [...REQUEST_CONTROL_POLICIES] },
      );
    }
    actionText(args, ["text", "message", "request"], action.requestId, "request-control text");
    break;
  }
  case "resume.choose":
  case "resume.retire":
  case "resume.inspect":
    actionText(args, ["candidateId", "id"], action.requestId, "Resume candidate id");
    break;
  case "resume.claim":
    exactArguments(action, ["candidateId", "id", "expectedRevision"]);
    if (args.candidateId !== undefined && typeof args.candidateId !== "string") {
      throw new DesktopActionProtocolError(
        "invalid_arguments",
        "resume.claim candidateId must be a string when provided.",
        action.requestId,
      );
    }
    if (
      typeof args.expectedRevision !== "number" ||
      !Number.isInteger(args.expectedRevision) ||
      args.expectedRevision < 0
    ) {
      throw new DesktopActionProtocolError(
        "invalid_arguments",
        "resume.claim expectedRevision must be a non-negative integer.",
        action.requestId,
      );
    }
    break;
  case "resume.rebind":
    actionText(args, ["candidateId", "id"], action.requestId, "Resume candidate id");
    if (
      (typeof args.planNodeId !== "string" || !args.planNodeId.trim())
      && (typeof args.taskNodeId !== "string" || !args.taskNodeId.trim())
    ) {
      throw new DesktopActionProtocolError(
        "invalid_arguments",
        "resume.rebind requires at least one of planNodeId or taskNodeId.",
        action.requestId,
      );
    }
    break;
  case "agent.cancel":
    actionText(args, ["agentId", "runId", "id"], action.requestId, "Agent run id");
    break;
  case "agent.followUp":
    actionText(args, ["agentId", "runId", "id"], action.requestId, "Agent run id");
    actionText(args, ["message", "text", "prompt"], action.requestId, "Agent follow-up message");
    break;
  case "workflow.cancel":
    actionText(args, ["workflowId", "runId", "id"], action.requestId, "Workflow run id");
    break;
  case "workflow.followUp":
    actionText(args, ["workflowId", "runId", "id"], action.requestId, "Workflow run id");
    actionText(args, ["message", "text", "prompt"], action.requestId, "Workflow follow-up message");
    break;
  case "canvas.task.select":
    actionText(args, ["nodeId", "taskId", "id"], action.requestId, "Canvas task id");
    break;
  case "canvas.plan.select":
    actionText(args, ["planId", "nodeId", "id"], action.requestId, "Canvas plan id");
    break;
  case "plan.update": {
    exactArguments(action, ["id", "planId", "status"]);
    const planId = actionText(args, ["planId", "id"], action.requestId, "Plan id");
    if (typeof args.planId === "string" && typeof args.id === "string" &&
        args.planId.trim() !== args.id.trim()) {
      throw new DesktopActionProtocolError(
        "invalid_arguments", "plan.update id and planId must match when both are provided.",
        action.requestId, { id: args.id, planId: args.planId },
      );
    }
    const status = actionText(args, ["status"], action.requestId, "Plan status");
    if (!(PLAN_UPDATE_STATUSES as readonly string[]).includes(status)) {
      throw new DesktopActionProtocolError(
        "invalid_arguments", `Unsupported plan.update status: ${status}.`, action.requestId,
        { planId, status, acceptedStatuses: [...PLAN_UPDATE_STATUSES] },
      );
    }
    break;
  }
  case "canvas.export": {
    exactArguments(action, ["outputName"]);
    const outputName = actionText(args, ["outputName"], action.requestId, "Canvas export outputName");
    if (!isSafeCanvasExportName(outputName)) {
      throw new DesktopActionProtocolError(
        "invalid_arguments",
        "Canvas export outputName must be a safe basename of 1-96 letters, digits, hyphens, or underscores.",
        action.requestId,
      );
    }
    break;
  }
  case "canvas.export.cancel":
    exactArguments(action, ["targetRequestId"]);
    actionText(args, ["targetRequestId"], action.requestId, "Canvas export target request id");
    break;
  case "project.scope.inspect":
  case "project.scope.rebind":
  case "resume.reconcile":
    if (Object.keys(args).length > 0) {
      throw new DesktopActionProtocolError(
        "invalid_arguments", `${action.kind} does not accept arguments.`, action.requestId,
        { unexpectedArguments: Object.keys(args).sort() },
      );
    }
    break;
  case "sandbox.revoke": {
    exactArguments(action, ["grantId", "expectedRevision"]);
    actionText(args, ["grantId"], action.requestId, "Sandbox grant id");
    if (
      typeof args.expectedRevision !== "number" ||
      !Number.isInteger(args.expectedRevision) ||
      args.expectedRevision < 0
    ) {
      throw new DesktopActionProtocolError(
        "invalid_arguments",
        "sandbox.revoke expectedRevision must be a non-negative integer.",
        action.requestId,
      );
    }
    break;
  }
  default:
    break;
  }
}

export function parseDesktopActionRequest(input: unknown): DesktopActionRequest {
  let parsed = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch (error) {
      throw new DesktopActionProtocolError(
        "invalid_json",
        `Action payload must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (!isRecord(parsed)) throw new DesktopActionProtocolError("invalid_request", "Action payload must be a JSON object.");
  const requestId = typeof parsed.requestId === "string" && parsed.requestId.trim()
    ? parsed.requestId.trim()
    : "invalid-request";
  if (parsed.protocolVersion !== DESKTOP_ACTION_PROTOCOL_VERSION) {
    throw new DesktopActionProtocolError("unsupported_protocol", `protocolVersion must be ${DESKTOP_ACTION_PROTOCOL_VERSION}.`, requestId);
  }
  const normalizedRequestId = requiredString(parsed, "requestId", requestId);
  if (normalizedRequestId.length > 256) throw new DesktopActionProtocolError("invalid_request", "requestId exceeds 256 characters.", normalizedRequestId);
  const workspace = requiredString(parsed, "workspace", normalizedRequestId);
  if (!(DESKTOP_ACTION_WORKSPACES as readonly string[]).includes(workspace)) {
    throw new DesktopActionProtocolError("invalid_workspace", `Unsupported workspace: ${workspace}.`, normalizedRequestId);
  }
  const kind = normalizeDesktopActionKind(requiredString(parsed, "kind", normalizedRequestId));
  const featureID = requiredString(parsed, "featureID", normalizedRequestId);
  if (!isRecord(parsed.arguments)) {
    throw new DesktopActionProtocolError("invalid_request", "arguments must be a JSON object.", normalizedRequestId);
  }
  return {
    protocolVersion: DESKTOP_ACTION_PROTOCOL_VERSION,
    requestId: normalizedRequestId,
    workspace: workspace as DesktopActionWorkspace,
    kind,
    featureID,
    arguments: decodeTaggedValue(parsed.arguments, normalizedRequestId) as Record<string, unknown>,
  };
}

export function jsonValue(value: unknown): DesktopJsonValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(jsonValue);
  if (isRecord(value)) {
    const output: Record<string, DesktopJsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      if (child !== undefined && typeof child !== "function" && typeof child !== "symbol") output[key] = jsonValue(child);
    }
    return output;
  }
  return String(value);
}

export function failedDesktopAction(
  requestId: string,
  code: string,
  message: string,
  details?: unknown,
  capabilityLevel: Extract<DesktopActionCapabilityLevel, "full" | "degraded"> = "full",
): DesktopActionResult {
  return {
    protocolVersion: DESKTOP_ACTION_PROTOCOL_VERSION,
    requestId,
    status: "failed",
    error: { code, message, details: details === undefined ? undefined : jsonValue(details) },
    capabilityLevel,
  };
}

export function degradedDesktopAction(
  requestId: string, code: string, message: string, details?: unknown,
): DesktopActionResult {
  return {
    protocolVersion: DESKTOP_ACTION_PROTOCOL_VERSION,
    requestId,
    status: "unsupported",
    error: { code, message, details: details === undefined ? undefined : jsonValue(details) },
    capabilityLevel: "degraded",
  };
}

export function unsupportedDesktopAction(
  action: Pick<DesktopActionRequest, "requestId" | "kind">, message: string,
): DesktopActionResult {
  return {
    protocolVersion: DESKTOP_ACTION_PROTOCOL_VERSION,
    requestId: action.requestId,
    status: "unsupported",
    error: { code: "unsupported_action", message, details: { kind: action.kind } },
    capabilityLevel: "unsupported",
  };
}
