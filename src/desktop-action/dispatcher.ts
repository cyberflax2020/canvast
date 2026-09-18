/**
 * =============================================================================
 * Canvast — Desktop Action Dispatcher / 桌面动作分发器
 * =============================================================================
 * @file        src/desktop-action/dispatcher.ts
 * @brief       Deterministic dispatch for typed macOS desktop actions.
 * @description Maps validated action kinds to shared service/tool handlers.
 *              It never converts an action to prose and never starts a model
 *              turn merely to decide which capability should run.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import { createHash } from "node:crypto";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  contextContinuityEventId,
  dispatchContextContinuity,
} from "../harness/context-continuity.js";
import {
  chooseRuntimeResumeCandidate,
  inspectRuntimeResume,
  rebindRuntimeResumeCandidate,
  reconcileRuntimeResume,
  retireRuntimeResumeCandidate,
  stableRuntimeResumeProjectId,
} from "../harness/runtime-resume.js";
import {
  defaultRuntimeStatusDir,
  readRuntimeStatus,
  recordRuntimeEvent,
  summarizeRuntimeInput,
  updateRuntimeResumeProjection,
  updateRuntimeContinuity,
  upsertRuntimeStatusItem,
  type RuntimeItemStatus,
} from "../harness/runtime-status.js";
import {
  DESKTOP_ACTION_KINDS,
  DESKTOP_ACTION_PROTOCOL_VERSION,
  DesktopActionProtocolError,
  degradedDesktopAction,
  failedDesktopAction,
  isRecord,
  jsonValue,
  parseDesktopActionRequest,
  PLAN_UPDATE_STATUSES,
  validateDesktopActionArguments,
  unsupportedDesktopAction,
  type DesktopActionKind,
  type DesktopActionRequest,
  type DesktopActionResult,
  type DesktopActionWorkspace,
  type DesktopJsonValue,
} from "./protocol.js";
import {
  DesktopActionHandlerError,
  invokeDesktopActionHandler,
  invokeDesktopActionTool,
  type DesktopToolResult,
} from "./tool-bridge.js";
import { orchestrationRunId } from "./orchestration-control.js";
import { cancelCanvasExport, exportCanvasForDesktop } from "./canvas-export-handler.js";
import {
  inspectProjectPreflight,
  ProjectLifecycleError,
  type ProjectLifecycleCommandContext,
  requireApprovedPreflight,
  workspaceRootFromContext,
} from "./project-lifecycle.js";

interface ActionRoute {
  workspace: DesktopActionWorkspace;
  featureIDs: readonly string[];
}

const ACTION_ROUTES: Readonly<Record<DesktopActionKind, ActionRoute>> = {
  "session.new": { workspace: "project", featureIDs: ["sessions"] },
  "session.catalog": { workspace: "project", featureIDs: ["sessions"] },
  "session.open": { workspace: "project", featureIDs: ["sessions"] },
  "session.rename": { workspace: "project", featureIDs: ["sessions"] },
  "session.delete": { workspace: "project", featureIDs: ["sessions"] },
  "session.transcript": { workspace: "project", featureIDs: ["sessions"] },
  "session.projectRestart": { workspace: "project", featureIDs: ["sessions"] },
  "project.preflight": { workspace: "project", featureIDs: ["sessions"] },
  "project.create": { workspace: "project", featureIDs: ["sessions"] },
  "project.open": { workspace: "project", featureIDs: ["sessions"] },
  "project.reinitialize": { workspace: "project", featureIDs: ["sessions"] },
  "project.delete": { workspace: "project", featureIDs: ["sessions"] },
  "runtime.mode": { workspace: "project", featureIDs: ["sessions"] },
  "runtime.requestControl": { workspace: "run", featureIDs: ["chat"] },
  "resume.inspect": { workspace: "run", featureIDs: ["chat"] },
  "resume.choose": { workspace: "run", featureIDs: ["chat"] },
  "resume.claim": { workspace: "run", featureIDs: ["chat"] },
  "resume.rebind": { workspace: "run", featureIDs: ["chat"] },
  "resume.retire": { workspace: "run", featureIDs: ["chat"] },
  "resume.reconcile": { workspace: "run", featureIDs: ["chat"] },
  "permission.set": { workspace: "safety", featureIDs: ["permissions"] },
  "plan.create": { workspace: "planning", featureIDs: ["planMode"] },
  "plan.update": { workspace: "planning", featureIDs: ["planMode"] },
  "plan.approve": { workspace: "planning", featureIDs: ["planMode"] },
  "plan.complete": { workspace: "planning", featureIDs: ["planMode"] },
  "task.create": { workspace: "planning", featureIDs: ["taskTree"] },
  "task.update": { workspace: "planning", featureIDs: ["taskTree"] },
  "canvas.task.select": { workspace: "canvas", featureIDs: ["canvas"] },
  "canvas.plan.select": { workspace: "planning", featureIDs: ["planMode"] },
  "canvas.export": { workspace: "canvas", featureIDs: ["canvas"] },
  "canvas.export.cancel": { workspace: "canvas", featureIDs: ["canvas"] },
  "project.scope.inspect": { workspace: "project", featureIDs: ["sessions"] },
  "project.scope.rebind": { workspace: "project", featureIDs: ["sessions"] },
  "sandbox.inspect": { workspace: "safety", featureIDs: ["sandbox"] },
  "sandbox.profile.set": { workspace: "safety", featureIDs: ["sandbox"] },
  "sandbox.grant": { workspace: "safety", featureIDs: ["sandbox"] },
  "sandbox.revoke": { workspace: "safety", featureIDs: ["sandbox"] },
  "agent.launch": { workspace: "orchestration", featureIDs: ["subAgents"] },
  "agent.cancel": { workspace: "orchestration", featureIDs: ["subAgents"] },
  "agent.followUp": { workspace: "orchestration", featureIDs: ["subAgents"] },
  "workflow.launch": { workspace: "orchestration", featureIDs: ["workflow", "dynamicWorkflow"] },
  "workflow.cancel": { workspace: "orchestration", featureIDs: ["workflow", "dynamicWorkflow"] },
  "workflow.followUp": { workspace: "orchestration", featureIDs: ["workflow", "dynamicWorkflow"] },
};

export interface DesktopActionDispatchContext {
  commandContext?: ProjectLifecycleCommandContext;
  signal?: AbortSignal;
}

export interface DesktopActionDispatcherOptions {
  agentDir?: () => string;
  projectRoot?: () => string;
  now?: () => string;
  ledgerTTLms?: number;
  ledgerMaxCompletedEntries?: number;
}

function requiredText(args: Record<string, unknown>, names: string[], requestId: string): string {
  for (const name of names) {
    const value = args[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  throw new DesktopActionProtocolError("invalid_arguments", `Missing non-empty argument: ${names.join(" or ")}.`, requestId);
}

function optionalText(args: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function optionalStringArray(args: Record<string, unknown>, names: string[]): string[] | undefined {
  for (const name of names) {
    const value = args[name];
    if (Array.isArray(value) && value.every(item => typeof item === "string")) return value;
  }
  return undefined;
}

function optionalNumber(args: Record<string, unknown>, names: string[]): number | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function toolText(result: DesktopToolResult): string | undefined {
  const text = (result.content || [])
    .filter(item => item?.type === "text" && typeof item.text === "string")
    .map(item => item.text)
    .join("\n")
    .trim();
  return text || undefined;
}

function successfulResult(action: DesktopActionRequest, result: Record<string, unknown>): DesktopActionResult {
  return {
    protocolVersion: DESKTOP_ACTION_PROTOCOL_VERSION,
    requestId: action.requestId,
    status: "succeeded",
    result: jsonValue(result) as Record<string, DesktopJsonValue>,
    capabilityLevel: "full",
  };
}

function isSupportedKind(kind: string): kind is DesktopActionKind {
  return (DESKTOP_ACTION_KINDS as readonly string[]).includes(kind);
}

function assertRoute(action: DesktopActionRequest): DesktopActionKind {
  if (!isSupportedKind(action.kind)) {
    throw new DesktopActionProtocolError("unsupported_action", `Unsupported desktop action kind: ${action.kind}.`, action.requestId);
  }
  const route = ACTION_ROUTES[action.kind];
  if (action.workspace !== route.workspace || !route.featureIDs.includes(action.featureID)) {
    throw new DesktopActionProtocolError(
      "invalid_route",
      `Action ${action.kind} requires workspace=${route.workspace} and featureID=${route.featureIDs.join("|")}.`,
      action.requestId,
      { workspace: action.workspace, featureID: action.featureID },
    );
  }
  return action.kind;
}

function toolFailure(action: DesktopActionRequest, toolName: string, result: DesktopToolResult): DesktopActionResult {
  return failedDesktopAction(
    action.requestId,
    "handler_failed",
    toolText(result) || `${toolName} failed.`,
    result.details,
  );
}

function projectId(projectRoot: string): string {
  return `project-${createHash("sha256").update(projectRoot).digest("hex").slice(0, 16)}`;
}

function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

interface DesktopActionLedgerEntry {
  hash: string;
  promise: Promise<DesktopActionResult>;
  state: "in_flight" | "completed";
  lastAccessedAt: number;
  completedAt?: number;
}

const DEFAULT_LEDGER_TTL_MS = 10 * 60 * 1000;
const DEFAULT_LEDGER_MAX_COMPLETED_ENTRIES = 1_024;
export class DesktopActionDispatcher {
  private readonly dir: () => string;
  private readonly root: () => string;
  private readonly clock: () => string;
  private readonly ledgerTTLms: number;
  private readonly ledgerMaxCompletedEntries: number;
  private readonly ledger = new Map<string, DesktopActionLedgerEntry>();

  constructor(private readonly pi: ExtensionAPI, options: DesktopActionDispatcherOptions = {}) {
    this.dir = options.agentDir || (() => defaultRuntimeStatusDir());
    this.root = options.projectRoot || (() => process.env.CANVAST_PROJECT_ROOT || process.cwd());
    this.clock = options.now || (() => new Date().toISOString());
    this.ledgerTTLms = normalizeNonNegativeInteger(options.ledgerTTLms, DEFAULT_LEDGER_TTL_MS);
    this.ledgerMaxCompletedEntries = normalizeNonNegativeInteger(
      options.ledgerMaxCompletedEntries,
      DEFAULT_LEDGER_MAX_COMPLETED_ENTRIES,
    );
  }

  async dispatch(input: unknown, context: DesktopActionDispatchContext = {}): Promise<DesktopActionResult> {
    let action: DesktopActionRequest;
    try {
      action = parseDesktopActionRequest(input);
    } catch (error) {
      if (error instanceof DesktopActionProtocolError) {
        return this.persist(failedDesktopAction(error.requestId, error.code, error.message, error.details));
      }
      return this.persist(failedDesktopAction("invalid-request", "invalid_request", error instanceof Error ? error.message : String(error)));
    }
    const hash = createHash("sha256").update(canonicalJSON(action)).digest("hex");
    const now = this.nowMilliseconds();
    this.pruneLedger(now);
    const existing = this.ledger.get(action.requestId);
    if (existing) {
      existing.lastAccessedAt = now;
      if (existing.hash === hash) return existing.promise;
      return failedDesktopAction(
        action.requestId,
        "request_id_conflict",
        "The desktop action requestId was already used with a different payload.",
      );
    }
    const promise = this.dispatchOnce(action, context);
    const entry: DesktopActionLedgerEntry = {
      hash,
      promise,
      state: "in_flight",
      lastAccessedAt: now,
    };
    this.ledger.set(action.requestId, entry);
    void promise.then(
      () => this.completeLedgerEntry(action.requestId, entry),
      () => this.completeLedgerEntry(action.requestId, entry),
    );
    return promise;
  }

  private nowMilliseconds(): number {
    const value = Date.parse(this.clock());
    return Number.isFinite(value) ? value : Date.now();
  }

  private completeLedgerEntry(requestId: string, entry: DesktopActionLedgerEntry): void {
    if (this.ledger.get(requestId) !== entry) return;
    const now = this.nowMilliseconds();
    entry.state = "completed";
    entry.completedAt = now;
    entry.lastAccessedAt = now;
    this.pruneLedger(now);
  }

  private pruneLedger(now: number): void {
    for (const [requestId, entry] of this.ledger) {
      if (entry.state === "completed" && entry.completedAt !== undefined &&
          now - entry.completedAt >= this.ledgerTTLms) {
        this.ledger.delete(requestId);
      }
    }
    const completed = [...this.ledger.entries()]
      .filter(([, entry]) => entry.state === "completed")
      .sort((left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt);
    const overflow = completed.length - this.ledgerMaxCompletedEntries;
    for (let index = 0; index < overflow; index += 1) {
      this.ledger.delete(completed[index][0]);
    }
  }

  private async dispatchOnce(
    action: DesktopActionRequest, context: DesktopActionDispatchContext,
  ): Promise<DesktopActionResult> {
    try {
      const kind = assertRoute(action);
      validateDesktopActionArguments(action);
      let result: DesktopActionResult;
      switch (kind) {
      case "session.new":
      case "session.catalog":
      case "session.open":
      case "session.rename":
      case "session.delete":
      case "session.transcript":
      case "project.preflight":
      case "project.create":
      case "project.open":
      case "project.reinitialize":
      case "project.delete":
      case "session.projectRestart": result = await this.restartProject(action, context); break;
      case "resume.inspect":
      case "resume.claim":
      case "resume.reconcile":
        result = await this.invokeLiveHandler(action, context); break;
      case "resume.choose": result = await this.chooseResume(action); break;
      case "resume.rebind": result = await this.rebindResume(action); break;
      case "resume.retire": result = await this.retireResume(action); break;
      case "runtime.mode":
      case "runtime.requestControl":
      case "canvas.task.select":
      case "canvas.plan.select":
      case "project.scope.inspect":
      case "project.scope.rebind":
      case "sandbox.inspect":
      case "sandbox.profile.set":
      case "sandbox.grant":
      case "sandbox.revoke": result = await this.invokeLiveHandler(action, context); break;
      case "canvas.export": result = successfulResult(action, await exportCanvasForDesktop({
        requestId: action.requestId,
        outputName: requiredText(action.arguments, ["outputName"], action.requestId),
        agentDir: this.dir(), projectRoot: this.root(), signal: context.signal,
      })); break;
      case "canvas.export.cancel": result = successfulResult(action, cancelCanvasExport(
        requiredText(action.arguments, ["targetRequestId"], action.requestId),
      )); break;
      case "plan.approve": result = await this.approvePlan(action, context); break;
      case "plan.complete": result = await this.completePlan(action, context); break;
      case "permission.set": result = await this.setPermission(action, context); break;
      case "plan.create": result = await this.createPlan(action, context); break;
      case "plan.update": result = await this.updatePlan(action, context); break;
      case "task.create": result = await this.createTask(action, context); break;
      case "task.update": result = await this.updateTask(action, context); break;
      case "agent.launch": result = await this.launchAgent(action, context); break;
      case "workflow.launch": result = await this.launchWorkflow(action, context); break;
      case "agent.cancel":
      case "agent.followUp":
      case "workflow.cancel":
      case "workflow.followUp":
        result = await this.invokeLiveHandler(action, context); break;
      }
      return this.persist(result, action.kind);
    } catch (error) {
      if (error instanceof DesktopActionProtocolError && error.code === "unsupported_action") {
        return this.persist(unsupportedDesktopAction(action, error.message), action.kind);
      }
      const protocolError = error instanceof DesktopActionProtocolError ? error : undefined;
      const handlerError = error instanceof DesktopActionHandlerError ? error : undefined;
      const lifecycleError = error instanceof ProjectLifecycleError ? error : undefined;
      const code = protocolError?.code || handlerError?.code || lifecycleError?.code || "dispatch_failed";
      const message = error instanceof Error ? error.message : String(error);
      const details = protocolError?.details ?? handlerError?.details ?? lifecycleError?.details;
      return this.persist(
        handlerError?.capabilityLevel === "degraded"
          ? degradedDesktopAction(action.requestId, code, message, details)
          : failedDesktopAction(action.requestId, code, message, details),
        action.kind,
      );
    }
  }

  record(result: DesktopActionResult, kind = "protocol"): DesktopActionResult {
    return this.persist(result, kind);
  }

  private async invokeLiveHandler(
    action: DesktopActionRequest, context: DesktopActionDispatchContext,
  ): Promise<DesktopActionResult> {
    const result = await invokeDesktopActionHandler(this.pi, action.kind, action.arguments, {
      signal: context.signal,
      commandContext: context.commandContext,
    });
    return successfulResult(action, result);
  }

  private async invoke(
    action: DesktopActionRequest, toolName: string, params: Record<string, unknown>, context: DesktopActionDispatchContext,
  ): Promise<DesktopActionResult> {
    const toolResult = await invokeDesktopActionTool(this.pi, toolName, params, `desktop-action:${action.requestId}`, context.signal);
    if (toolResult.isError) return toolFailure(action, toolName, toolResult);
    return successfulResult(action, {
      handler: toolName,
      details: toolResult.details ?? null,
      message: toolText(toolResult) || "Action completed.",
    });
  }

  private projectExecution(
    plane: "subAgents" | "workflows",
    action: DesktopActionRequest,
    expectedRunId: string,
    title: string,
    result: DesktopActionResult,
  ): DesktopActionResult {
    const now = this.clock();
    const succeeded = result.status === "succeeded";
    const details = succeeded && isRecord(result.result?.details)
      ? result.result.details
      : !succeeded && isRecord(result.error?.details)
        ? result.error.details
        : undefined;
    const ownerRunId = typeof details?.runId === "string" && details.runId.trim()
      ? details.runId.trim()
      : undefined;
    const id = ownerRunId || expectedRunId;
    const terminalCause = typeof details?.terminalCause === "string"
      ? details.terminalCause
      : isRecord(details?.orchestration) && typeof details.orchestration.state === "string"
        ? details.orchestration.state
        : undefined;
    const effectiveResult = succeeded && !ownerRunId
      ? failedDesktopAction(
        action.requestId,
        "missing_runtime_handle",
        `${action.kind} completed without confirming an addressable runtime handle.`,
        { expectedRunId },
      )
      : succeeded && ownerRunId !== expectedRunId
        ? failedDesktopAction(
          action.requestId,
          "runtime_handle_mismatch",
          `${action.kind} returned a runtime handle that does not match its invocation ID.`,
          { expectedRunId, ownerRunId },
        )
        : result;
    const effectiveSucceeded = effectiveResult.status === "succeeded";
    const status: RuntimeItemStatus = effectiveSucceeded
      ? "completed"
      : terminalCause === "cancelled" ? "aborted"
        : effectiveResult.status === "unsupported" ? "blocked" : "failed";
    upsertRuntimeStatusItem(this.dir(), {
      plane,
      item: {
        id, title,
        status,
        summary: summarizeRuntimeInput(
          effectiveResult.error?.message || `${action.kind} ${effectiveResult.status}.`,
          180,
        ),
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      },
    });
    if (!effectiveSucceeded || !ownerRunId) return effectiveResult;
    return { ...result, result: { ...(result.result || {}), runId: ownerRunId } };
  }

  private projectExecutionStart(
    plane: "subAgents" | "workflows",
    id: string,
    title: string,
  ): void {
    const now = this.clock();
    upsertRuntimeStatusItem(this.dir(), {
      plane,
      item: {
        id,
        title,
        status: "running",
        summary: "Addressable runtime owner is starting.",
        startedAt: now,
        updatedAt: now,
      },
    });
  }

  private async restartProject(action: DesktopActionRequest, context: DesktopActionDispatchContext): Promise<DesktopActionResult> {
    if (action.kind === "project.preflight") {
      const operation = requiredText(action.arguments, ["operation"], action.requestId) as
        "create" | "open" | "reinitialize" | "retire";
      const preflight = inspectProjectPreflight({
        operation,
        inputPath: requiredText(action.arguments, ["path", "projectPath"], action.requestId),
        replacementPath: optionalText(action.arguments, ["replacementPath"]),
        currentProjectRoot: this.root(),
        workspaceRoot: workspaceRootFromContext(context.commandContext, this.root()),
      });
      return successfulResult(action, { ...preflight });
    }
    if (action.kind === "project.create" || action.kind === "project.open"
      || action.kind === "project.reinitialize" || action.kind === "project.delete") {
      const operation = action.kind === "project.create"
        ? "create"
        : action.kind === "project.open"
          ? "open"
          : action.kind === "project.reinitialize"
            ? "reinitialize"
            : "retire";
      const inputPath = requiredText(action.arguments, ["path", "projectPath"], action.requestId);
      const preflight = inspectProjectPreflight({
        operation,
        inputPath,
        replacementPath: optionalText(action.arguments, ["replacementPath"]),
        currentProjectRoot: this.root(),
        workspaceRoot: workspaceRootFromContext(context.commandContext, this.root()),
      });
      requireApprovedPreflight(
        action.kind,
        preflight,
        optionalText(action.arguments, ["expectedRevision"]),
        action.arguments.approvedAcknowledgement === true,
      );
      return await this.invokeLiveHandler(action, context);
    }
    if (action.kind !== "session.projectRestart") {
      return await this.invokeLiveHandler(action, context);
    }
    const now = this.clock();
    const id = projectId(this.root());
    const transition = dispatchContextContinuity(this.dir(), {
      type: "project_restarted",
      eventId: contextContinuityEventId("project_restarted", [id, action.requestId]),
      timestamp: now,
      projectId: id,
    });
    updateRuntimeContinuity(this.dir(), transition.state);
    if (context.commandContext?.reload) await context.commandContext.reload();
    return successfulResult(action, {
      projectId: id,
      restartCount: transition.state.project.restartCount,
      preservedSession: true,
      reloaded: Boolean(context.commandContext?.reload),
    });
  }

  private async chooseResume(action: DesktopActionRequest): Promise<DesktopActionResult> {
    const transition = chooseRuntimeResumeCandidate(this.dir(), {
      candidateId: requiredText(action.arguments, ["candidateId", "id"], action.requestId),
      eventId: `desktop-resume-choose:${action.requestId}`,
      timestamp: this.clock(),
    });
    updateRuntimeResumeProjection(this.dir());
    if (transition.unsupported) {
      return transition.unsupported.reason === "candidate_not_found"
        ? failedDesktopAction(action.requestId, "not_found", transition.unsupported.message, transition.unsupported)
        : unsupportedDesktopAction(action, transition.unsupported.message);
    }
    return successfulResult(action, {
      snapshot: transition.snapshot,
      candidate: transition.candidate || null,
    });
  }

  private async rebindResume(action: DesktopActionRequest): Promise<DesktopActionResult> {
    const transition = rebindRuntimeResumeCandidate(this.dir(), {
      candidateId: requiredText(action.arguments, ["candidateId", "id"], action.requestId),
      planNodeId: optionalText(action.arguments, ["planNodeId", "planId"]),
      taskNodeId: optionalText(action.arguments, ["taskNodeId", "taskId", "nodeId"]),
      source: "desktop-action",
      eventId: `desktop-resume-rebind:${action.requestId}`,
      timestamp: this.clock(),
    });
    if (transition.unsupported) {
      return transition.unsupported.reason === "candidate_not_found"
        ? failedDesktopAction(action.requestId, "not_found", transition.unsupported.message, transition.unsupported)
        : unsupportedDesktopAction(action, transition.unsupported.message);
    }
    const reconciled = reconcileRuntimeResume(this.dir(), {
      eventId: `desktop-resume-rebind-reconcile:${action.requestId}`,
      projectId: stableRuntimeResumeProjectId(this.root()),
      timestamp: this.clock(),
    });
    updateRuntimeResumeProjection(this.dir());
    return successfulResult(action, {
      snapshot: reconciled.snapshot,
      candidate: inspectRuntimeResume(this.dir(), { candidateId: transition.candidate?.id }).candidate || null,
    });
  }

  private async retireResume(action: DesktopActionRequest): Promise<DesktopActionResult> {
    const transition = retireRuntimeResumeCandidate(this.dir(), {
      candidateId: requiredText(action.arguments, ["candidateId", "id"], action.requestId),
      reason: optionalText(action.arguments, ["reason", "summary"]) || "retired by desktop action",
      eventId: `desktop-resume-retire:${action.requestId}`,
      timestamp: this.clock(),
    });
    updateRuntimeResumeProjection(this.dir());
    if (transition.unsupported) {
      return transition.unsupported.reason === "candidate_not_found"
        ? failedDesktopAction(action.requestId, "not_found", transition.unsupported.message, transition.unsupported)
        : unsupportedDesktopAction(action, transition.unsupported.message);
    }
    return successfulResult(action, {
      snapshot: transition.snapshot,
      candidate: transition.candidate || null,
    });
  }


  private async setPermission(action: DesktopActionRequest, context: DesktopActionDispatchContext): Promise<DesktopActionResult> {
    const mode = requiredText(action.arguments, ["mode"], action.requestId);
    if (mode !== "ask" && mode !== "auto") {
      throw new DesktopActionProtocolError("invalid_arguments", "permission.set mode must be ask or auto.", action.requestId);
    }
    return await this.invoke(action, "sandbox_permission_mode", { mode }, context);
  }

  private async createPlan(action: DesktopActionRequest, context: DesktopActionDispatchContext): Promise<DesktopActionResult> {
    const task = requiredText(action.arguments, ["task", "goal", "title"], action.requestId);
    const result = await this.invoke(action, "enter_plan_mode", {
      task,
      reason: optionalText(action.arguments, ["reason"]),
    }, context);
    if (result.status !== "succeeded") return result;
    const plan = [...readRuntimeStatus(this.dir()).plans].reverse().find(item => item.title === task);
    return { ...result, result: { ...(result.result || {}), planId: plan?.id || "" } };
  }

  private async approvePlan(action: DesktopActionRequest, context: DesktopActionDispatchContext): Promise<DesktopActionResult> {
    const result = await this.invoke(action, "approve_plan", {
      notes: optionalText(action.arguments, ["notes", "reason"]),
    }, context);
    return this.withCurrentPlan(result);
  }

  private async completePlan(action: DesktopActionRequest, context: DesktopActionDispatchContext): Promise<DesktopActionResult> {
    const result = await this.invoke(action, "exit_plan_mode", {
      summary: optionalText(action.arguments, ["summary", "notes"]),
    }, context);
    return this.withCurrentPlan(result);
  }

  private withCurrentPlan(result: DesktopActionResult): DesktopActionResult {
    if (result.status !== "succeeded") return result;
    const plan = readRuntimeStatus(this.dir()).plans.at(-1);
    return {
      ...result,
      result: {
        ...(result.result || {}),
        planId: plan?.id || "",
        status: plan?.status || "unknown",
        message: result.result?.message || "Plan lifecycle action completed.",
      },
    };
  }

  private async updatePlan(
    action: DesktopActionRequest, context: DesktopActionDispatchContext,
  ): Promise<DesktopActionResult> {
    const id = requiredText(action.arguments, ["planId", "id"], action.requestId);
    const status = requiredText(action.arguments, ["status"], action.requestId);
    if (!(PLAN_UPDATE_STATUSES as readonly string[]).includes(status)) {
      throw new DesktopActionProtocolError(
        "invalid_arguments",
        `Unsupported plan.update status: ${status}.`,
        action.requestId,
        { planId: id, status, acceptedStatuses: [...PLAN_UPDATE_STATUSES] },
      );
    }
    return await this.invokeLiveHandler(action, context);
  }

  private createTask(action: DesktopActionRequest, context: DesktopActionDispatchContext): Promise<DesktopActionResult> {
    const subject = requiredText(action.arguments, ["subject", "title"], action.requestId);
    return this.invoke(action, "task_create", {
      subject,
      description: optionalText(action.arguments, ["description"]) || subject,
      status: optionalText(action.arguments, ["status"]),
      blocked_by: optionalStringArray(action.arguments, ["blocked_by", "blockedBy"]),
    }, context);
  }

  private updateTask(action: DesktopActionRequest, context: DesktopActionDispatchContext): Promise<DesktopActionResult> {
    return this.invoke(action, "task_update", {
      task_id: requiredText(action.arguments, ["task_id", "taskId", "id"], action.requestId),
      status: optionalText(action.arguments, ["status"]),
      subject: optionalText(action.arguments, ["subject", "title"]),
      description: optionalText(action.arguments, ["description"]),
      add_blocks: optionalStringArray(action.arguments, ["add_blocks", "addBlocks"]),
      add_blocked_by: optionalStringArray(action.arguments, ["add_blocked_by", "addBlockedBy"]),
    }, context);
  }

  private async launchAgent(action: DesktopActionRequest, context: DesktopActionDispatchContext): Promise<DesktopActionResult> {
    const task = requiredText(action.arguments, ["task"], action.requestId);
    const runId = orchestrationRunId("agent", `desktop-action:${action.requestId}`);
    this.projectExecutionStart("subAgents", runId, task);
    const result = await this.invoke(action, "spawn_agent", {
      task,
      mode: optionalText(action.arguments, ["mode"]),
      file_path: optionalText(action.arguments, ["file_path", "filePath"]),
      content: optionalText(action.arguments, ["content"]),
      timeout_seconds: optionalNumber(action.arguments, ["timeout_seconds", "timeoutSeconds"]),
    }, context);
    return this.projectExecution("subAgents", action, runId, task, result);
  }

  private async launchWorkflow(action: DesktopActionRequest, context: DesktopActionDispatchContext): Promise<DesktopActionResult> {
    const name = requiredText(action.arguments, ["name", "goal"], action.requestId);
    const runId = orchestrationRunId("workflow", `desktop-action:${action.requestId}`);
    this.projectExecutionStart("workflows", runId, name);
    const suppliedSteps = action.arguments.steps;
    const steps = Array.isArray(suppliedSteps) && suppliedSteps.length > 0
      ? suppliedSteps
      : [{ name: "main", task: requiredText(action.arguments, ["goal", "task", "name"], action.requestId) }];
    const result = await this.invoke(action, "run_workflow", {
      name, steps, mode: optionalText(action.arguments, ["mode"]),
    }, context);
    return this.projectExecution("workflows", action, runId, name, result);
  }

  private persist(result: DesktopActionResult, kind = "protocol"): DesktopActionResult {
    const now = this.clock();
    const status: RuntimeItemStatus = result.status === "succeeded" ? "completed" : result.status === "unsupported" ? "blocked" : "failed";
    const summary = result.error?.message || `${kind}: ${result.status}/${result.capabilityLevel}`;
    upsertRuntimeStatusItem(this.dir(), {
      plane: "toolRuns",
      item: {
        id: `desktop-action-${result.requestId}`,
        title: kind,
        status,
        summary: summarizeRuntimeInput(summary, 200),
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      },
    });
    recordRuntimeEvent(this.dir(), {
      id: `desktop-action-result-${result.requestId}`,
      timestamp: now,
      kind: "desktop_action_result",
      title: `${kind}: ${result.status}`,
      summary: summarizeRuntimeInput(`${result.requestId} | ${summary}`, 220),
      source: "desktop-action",
    });
    return result;
  }
}
