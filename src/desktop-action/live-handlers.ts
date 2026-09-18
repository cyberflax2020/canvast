/**
 * =============================================================================
 * Canvast — Desktop Live Handlers / 桌面实时处理器
 * =============================================================================
 * @file        src/desktop-action/live-handlers.ts
 * @brief       Adapts desktop actions to the runtime's existing live owners.
 * @description Keeps mode, request, Canvas, and project-scope mutations on the
 *              same controller instances used by their command surfaces.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import * as fs from "node:fs";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";

import type { CanvasStore } from "../graph/canvas-store.js";
import type { CanvastModeController } from "../harness/canvast-mode.js";
import { normalizeCanvastMode } from "../harness/canvast-mode.js";
import type { ProjectScopeController } from "../harness/canvast-project-scope.js";
import { inspectRuntimeResume, reconcileRuntimeResume, stableRuntimeResumeProjectId } from "../harness/runtime-resume.js";
import { readContextContinuity } from "../harness/context-continuity.js";
import { readRuntimeStatus } from "../harness/runtime-status.js";
import { RuntimeResumeClaimError, type RuntimeRequestCoordinator } from "../tui/runtime-request-coordinator.js";
import type { RuntimeRequestControlPolicy } from "../tui/runtime-current-request.js";
import {
  inspectProjectPreflight,
  ProjectLifecycleError,
  runProjectLifecycleAction,
  trashSession,
  type ProjectLifecycleOwner,
  type ProjectLifecycleCommandContext,
  workspaceRootFromContext,
} from "./project-lifecycle.js";
import { DesktopActionHandlerError, registerDesktopActionHandler } from "./tool-bridge.js";

interface CanvasHarnessOwner {
  setCurrentTask(id: string): void;
  setActivePlan(id: string): void;
}

export interface HarnessDesktopActionOwners {
  store: CanvasStore;
  harness: CanvasHarnessOwner;
  modeController: CanvastModeController;
  projectScope: ProjectScopeController;
  projectLifecycle?: ProjectLifecycleOwner;
  currentProjectRoot(): string;
  reloadCanvas(): boolean;
}

function requiredText(args: Record<string, unknown>, names: string[]): string {
  for (const name of names) {
    const value = args[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  throw new DesktopActionHandlerError("invalid_arguments", `Missing non-empty argument: ${names.join(" or ")}.`);
}

interface SessionActionContext {
  commandContext?: ProjectLifecycleCommandContext;
}

interface IndexedSessionManager {
  isPersisted(): boolean;
  getSessionFile(): string | undefined;
  getHeader(): unknown;
  getEntries(): SessionEntry[];
  flushed: boolean;
}

function optionalText(args: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function entryTranscriptLine(entry: SessionEntry): string {
  if (entry.type === "message") {
    const role = String(entry.message?.role || "message");
    if (role === "bashExecution") {
      const command = "command" in entry.message ? String(entry.message.command || "") : "";
      const output = "output" in entry.message ? String(entry.message.output || "") : "";
      return [command ? `bash: ${command}` : "bash", output].filter(Boolean).join("\n");
    }
    const content = "content" in entry.message ? entry.message.content : undefined;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map(item => typeof item === "string" ? item : item?.type === "text" ? String(item.text || "") : "").filter(Boolean).join("\n")
        : "";
    return text.trim() ? `${role}: ${text}` : role;
  }
  if (entry.type === "custom_message") {
    const content = entry.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map(item => typeof item === "string" ? item : item?.type === "text" ? String(item.text || "") : "").filter(Boolean).join("\n")
        : "";
    return text.trim() ? `custom:${entry.customType}: ${text}` : `custom:${entry.customType}`;
  }
  if (entry.type === "compaction") return `compaction: ${entry.summary}`;
  if (entry.type === "branch_summary") return `branch_summary: ${entry.summary}`;
  if (entry.type === "session_info") return entry.name ? `session_info: ${entry.name}` : "session_info";
  if (entry.type === "label") return `label: ${entry.label || ""}`.trim();
  if (entry.type === "thinking_level_change") return `thinking_level_change: ${entry.thinkingLevel}`;
  if (entry.type === "model_change") return `model_change: ${entry.provider}/${entry.modelId}`;
  return entry.type;
}

function sessionCatalog(sessionManager: { getCwd(): string; getSessionDir(): string; getSessionFile(): string | undefined; getSessionId(): string; getSessionName(): string | undefined }) {
  const cwd = sessionManager.getCwd();
  const sessionDir = sessionManager.getSessionDir();
  const activePath = sessionManager.getSessionFile();
  const infos = SessionManager.list(cwd, sessionDir);
  return Promise.resolve(infos).then(items => ({
    cwd,
    sessionDir,
    activeSessionPath: activePath || "",
    activeSessionId: sessionManager.getSessionId(),
    activeSessionName: sessionManager.getSessionName() || "",
    sessions: items
      .sort((left, right) => right.modified.getTime() - left.modified.getTime())
      .map(item => ({
        path: item.path,
        id: item.id,
        cwd: item.cwd,
        name: item.name || "",
        createdAt: item.created.toISOString(),
        modifiedAt: item.modified.toISOString(),
        messageCount: item.messageCount,
        firstMessage: item.firstMessage,
        allMessagesText: item.allMessagesText,
        parentSessionPath: item.parentSessionPath || "",
        isActive: activePath === item.path,
      })),
  }));
}

function hasFunction(value: object, key: string): boolean {
  return typeof Reflect.get(value, key) === "function";
}

function hasBoolean(value: object, key: string): boolean {
  return typeof Reflect.get(value, key) === "boolean";
}

function isIndexedSessionManager(value: object): value is IndexedSessionManager {
  return hasFunction(value, "isPersisted")
    && hasFunction(value, "getSessionFile")
    && hasFunction(value, "getHeader")
    && hasFunction(value, "getEntries")
    && hasBoolean(value, "flushed");
}

function ensureSessionIndexed(sessionManager: IndexedSessionManager): void {
  if (!sessionManager.isPersisted()) return;
  const sessionPath = sessionManager.getSessionFile();
  const header = sessionManager.getHeader();
  if (!sessionPath || !header) return;
  const lines = [header, ...sessionManager.getEntries()].map(entry => `${JSON.stringify(entry)}\n`).join("");
  fs.writeFileSync(sessionPath, lines, "utf8");
  sessionManager.flushed = true;
}

function lifecycleHandlerError(error: unknown): never {
  if (error instanceof DesktopActionHandlerError) throw error;
  if (error instanceof ProjectLifecycleError) {
    throw new DesktopActionHandlerError(error.code, error.message, error.details);
  }
  throw error;
}

export function registerHarnessDesktopActionHandlers(
  pi: ExtensionAPI, owners: HarnessDesktopActionOwners,
): void {
  registerDesktopActionHandler(pi, "session.new", async (_args, context) => {
    const commandContext = (context as SessionActionContext).commandContext;
    if (!commandContext?.newSession) {
      throw new DesktopActionHandlerError("handler_unavailable", "Starting a new session requires a live command context.");
    }
    let createdSession:
      | {
        sessionPath: string;
        sessionId: string;
        sessionName: string;
      }
      | undefined;
    const result = await commandContext.newSession({
      withSession: async nextContext => {
        commandContext.resultRelay?.setResultContext(nextContext);
        const sessionManager = nextContext.sessionManager;
        if (isIndexedSessionManager(sessionManager)) {
          ensureSessionIndexed(sessionManager);
        }
        createdSession = {
          sessionPath: sessionManager.getSessionFile() || "",
          sessionId: sessionManager.getSessionId(),
          sessionName: sessionManager.getSessionName() || "",
        };
      },
    });
    if (result.cancelled) {
      throw new DesktopActionHandlerError("cancelled", "Session creation was cancelled.");
    }
    if (!createdSession) {
      throw new DesktopActionHandlerError("handler_unavailable", "Session creation completed without a replacement session context.");
    }
    return {
      ...createdSession,
      message: `Started session ${createdSession.sessionId}.`,
    };
  });

  registerDesktopActionHandler(pi, "session.catalog", async (_args, context) => {
    const commandContext = (context as SessionActionContext).commandContext;
    const sessionManager = commandContext?.sessionManager;
    if (!sessionManager) {
      throw new DesktopActionHandlerError("handler_unavailable", "Session catalog requires a live command context.");
    }
    const catalog = await sessionCatalog(sessionManager);
    return {
      ...catalog,
      sessionCount: catalog.sessions.length,
      message: `Loaded ${catalog.sessions.length} sessions.`,
    };
  });

  registerDesktopActionHandler(pi, "session.open", async (args, context) => {
    const commandContext = (context as SessionActionContext).commandContext;
    if (!commandContext?.switchSession) {
      throw new DesktopActionHandlerError("handler_unavailable", "Opening a session requires a live command context.");
    }
    const sessionPath = requiredText(args, ["sessionPath", "path"]);
    const before = commandContext.sessionManager?.getSessionFile() || "";
    let activeSessionPath = "";
    let activeSessionId = "";
    let activeSessionName = "";
    const switched = await commandContext.switchSession(sessionPath, {
      withSession: async nextContext => {
        commandContext.resultRelay?.setResultContext(nextContext);
        const sessionManager = nextContext.sessionManager;
        activeSessionPath = sessionManager.getSessionFile() || "";
        activeSessionId = sessionManager.getSessionId();
        activeSessionName = sessionManager.getSessionName() || "";
      },
    });
    if (switched?.cancelled) {
      throw new DesktopActionHandlerError("cancelled", `Session open was cancelled for ${sessionPath}.`, { sessionPath });
    }
    return {
      sessionPath,
      previousSessionPath: before || "",
      activeSessionPath: activeSessionPath || sessionPath,
      activeSessionId,
      activeSessionName,
      message: `Opened session ${activeSessionPath || sessionPath}.`,
    };
  });

  registerDesktopActionHandler(pi, "session.rename", async (args, context) => {
    const commandContext = (context as SessionActionContext).commandContext;
    const nextName = requiredText(args, ["name", "title"]);
    const targetPath = optionalText(args, ["sessionPath", "path"]);
    const activeSessionManager = commandContext?.sessionManager;
    const activePath = activeSessionManager?.getSessionFile();
    if (!activeSessionManager || !activePath) {
      throw new DesktopActionHandlerError("handler_unavailable", "Renaming requires an active persisted session.");
    }
    if (targetPath && targetPath !== activePath) {
      throw new DesktopActionHandlerError(
        "invalid_arguments",
        "Open the target session before renaming it.",
        { sessionPath: targetPath, activeSessionPath: activePath },
      );
    }
    pi.setSessionName(nextName);
    return {
      sessionPath: activePath,
      sessionId: activeSessionManager.getSessionId(),
      name: nextName,
      message: `Renamed session to ${nextName}.`,
    };
  });

  registerDesktopActionHandler(pi, "session.delete", async (args, context) => {
    const commandContext = (context as SessionActionContext).commandContext;
    const sessionManager = commandContext?.sessionManager;
    if (!sessionManager) {
      throw new DesktopActionHandlerError(
        "handler_unavailable",
        "Deleting a session requires a live command context.",
      );
    }
    try {
      const receipt = await trashSession(sessionManager, requiredText(args, ["sessionPath", "path"]));
      return { ...receipt };
    } catch (error) {
      lifecycleHandlerError(error);
    }
  });

  registerDesktopActionHandler(pi, "session.transcript", async args => {
    const sessionPath = requiredText(args, ["sessionPath", "path"]);
    const opened = SessionManager.open(sessionPath);
    const entries = opened.getEntries();
    const lines = entries.map(entryTranscriptLine);
    return {
      sessionPath,
      sessionId: opened.getSessionId(),
      sessionName: opened.getSessionName() || "",
      entryCount: entries.length,
      transcript: lines.join("\n"),
      entries: entries.map(entry => ({
        id: entry.id,
        type: entry.type,
        role: entry.type === "message" ? String(entry.message?.role || "") : entry.type === "custom_message" ? entry.customType : entry.type,
        timestamp: entry.timestamp,
        parentId: entry.parentId,
        text: entryTranscriptLine(entry),
      })),
      message: `Loaded transcript for ${sessionPath}.`,
    };
  });

  const commandContextOf = (context: unknown): ProjectLifecycleCommandContext | undefined =>
    (context as SessionActionContext).commandContext;
  const currentProjectRoot = () => owners.currentProjectRoot();
  const workspaceRoot = (context: unknown) =>
    workspaceRootFromContext(commandContextOf(context), currentProjectRoot());

  registerDesktopActionHandler(pi, "project.preflight", async (args, context) => {
    try {
      const receipt = inspectProjectPreflight({
        operation: requiredText(args, ["operation"]) as "create" | "open" | "reinitialize" | "retire",
        inputPath: requiredText(args, ["path", "projectPath"]),
        replacementPath: optionalText(args, ["replacementPath"]),
        currentProjectRoot: currentProjectRoot(),
        workspaceRoot: workspaceRoot(context),
      });
      return { ...receipt };
    } catch (error) {
      lifecycleHandlerError(error);
    }
  });

  const runProjectAction = async (
    actionKind: "project.create" | "project.open" | "project.reinitialize" | "project.delete",
    args: Record<string, unknown>,
    context: unknown,
  ): Promise<Record<string, unknown>> => {
    const inputPath = requiredText(args, ["path", "projectPath"]);
    try {
      const preflight = inspectProjectPreflight({
        operation: actionKind === "project.create"
          ? "create"
          : actionKind === "project.open"
            ? "open"
            : actionKind === "project.reinitialize"
              ? "reinitialize"
              : "retire",
        inputPath,
        replacementPath: optionalText(args, ["replacementPath"]),
        currentProjectRoot: currentProjectRoot(),
        workspaceRoot: workspaceRoot(context),
      });
      const receipt = await runProjectLifecycleAction({
        actionKind,
        inputPath,
        currentProjectRoot: currentProjectRoot(),
        workspaceRoot: workspaceRoot(context),
        expectedRevision: optionalText(args, ["expectedRevision"]),
        approvedAcknowledgement: args.approvedAcknowledgement === true,
        preflight,
        owner: owners.projectLifecycle,
        commandContext: commandContextOf(context),
      });
      return { ...receipt };
    } catch (error) {
      lifecycleHandlerError(error);
    }
  };

  registerDesktopActionHandler(pi, "project.create", async (args, context) =>
    await runProjectAction("project.create", args, context));
  registerDesktopActionHandler(pi, "project.open", async (args, context) =>
    await runProjectAction("project.open", args, context));
  registerDesktopActionHandler(pi, "project.reinitialize", async (args, context) =>
    await runProjectAction("project.reinitialize", args, context));
  registerDesktopActionHandler(pi, "project.delete", async (args, context) =>
    await runProjectAction("project.delete", args, context));

  registerDesktopActionHandler(pi, "runtime.mode", args => {
    const mode = normalizeCanvastMode(args.mode);
    if (!mode) throw new DesktopActionHandlerError("invalid_arguments", "runtime.mode mode must be parity or enhanced.");
    const scope = args.scope === "turn" ? "turn" : "session";
    const reason = typeof args.reason === "string" ? args.reason : "Desktop runtime mode switch.";
    const state = scope === "turn"
      ? owners.modeController.setTurnMode(mode, reason)
      : owners.modeController.setMode(mode, "tool", reason);
    return { state, effectiveMode: owners.modeController.getEffectiveMode(), scope, message: owners.modeController.renderStatus() };
  });

  registerDesktopActionHandler(pi, "canvas.task.select", args => {
    const nodeId = requiredText(args, ["nodeId", "taskId", "id"]);
    const node = owners.store.getNode(nodeId);
    if (!node) throw new DesktopActionHandlerError("not_found", `Canvas node ${nodeId} does not exist.`, { nodeId });
    const hasPlanParent = node.type === "plan" && owners.store
      .getEdgesTo(nodeId, "DECOMPOSES_INTO")
      .some(edge => owners.store.getNode(edge.fromNodeId)?.type === "plan");
    if (!hasPlanParent) {
      throw new DesktopActionHandlerError(
        "invalid_node_kind",
        `Canvas node ${nodeId} is not a task-shaped plan node.`,
        { nodeId, expectedNodeKind: "task", actualNodeType: node.type },
      );
    }
    owners.harness.setCurrentTask(nodeId);
    return { nodeId, currentTaskId: nodeId, nodeType: node.type, message: `Canvas current task set to ${nodeId}.` };
  });

  registerDesktopActionHandler(pi, "canvas.plan.select", args => {
    const planId = requiredText(args, ["planId", "nodeId", "id"]);
    const node = owners.store.getNode(planId);
    if (!node) throw new DesktopActionHandlerError("not_found", `Canvas node ${planId} does not exist.`, { planId });
    const isTaskShapedPlan = node.type === "plan" && owners.store
      .getEdgesTo(planId, "DECOMPOSES_INTO")
      .some(edge => owners.store.getNode(edge.fromNodeId)?.type === "plan");
    if (node.type !== "plan" || isTaskShapedPlan) {
      throw new DesktopActionHandlerError(
        "invalid_node_kind",
        isTaskShapedPlan
          ? `Canvas node ${planId} is task-shaped and cannot be selected as the active plan.`
          : `Canvas node ${planId} is not a plan node.`,
        {
          planId,
          expectedNodeKind: "plan",
          actualNodeType: node.type,
          actualNodeKind: isTaskShapedPlan ? "task" : node.type,
        },
      );
    }
    owners.harness.setActivePlan(planId);
    return { planId, activePlanId: planId, nodeType: node.type, message: `Active Canvas plan set to ${planId}.` };
  });

  const scopeResult = (canvasReloaded?: boolean) => {
    const currentProjectRoot = owners.currentProjectRoot();
    const decision = owners.projectScope.inspect(currentProjectRoot);
    return { currentProjectRoot, ...decision, canvasReloaded, message: owners.projectScope.renderStatus(currentProjectRoot) };
  };
  registerDesktopActionHandler(pi, "project.scope.inspect", () => scopeResult());
  registerDesktopActionHandler(pi, "project.scope.rebind", () => {
    owners.projectScope.rebind(owners.currentProjectRoot(), "command");
    return scopeResult(owners.reloadCanvas());
  });
}

const REQUEST_POLICIES = new Set<RuntimeRequestControlPolicy>([
  "sidecar", "status", "pause", "redirect", "task_adjustment",
]);

export function registerRuntimeRequestDesktopActionHandler(
  pi: ExtensionAPI, coordinator: RuntimeRequestCoordinator, agentDir: () => string,
): void {
  registerDesktopActionHandler(pi, "runtime.requestControl", async args => {
    const policy = requiredText(args, ["policy"]) as RuntimeRequestControlPolicy;
    if (!REQUEST_POLICIES.has(policy)) {
      throw new DesktopActionHandlerError("invalid_arguments", `Unsupported request-control policy: ${policy}.`);
    }
    const text = requiredText(args, ["text", "message", "request"]);
    const runtimeRequestId = await coordinator.dispatchControlledRequest(policy, text);
    const snapshot = readRuntimeStatus(agentDir());
    const queued = snapshot.inputQueue.find(item => item.requestId === runtimeRequestId);
    const request = snapshot.requests.find(item => item.requestId === runtimeRequestId);
    return {
      requestId: runtimeRequestId, runtimeRequestId, policy, text, summary: queued?.textSummary || text,
      queueStatus: queued?.status || "queued", deliveryMode: queued?.deliveryMode || "followUp",
      requestKind: request?.kind || "sidecar", affectsActiveWork: queued?.affectsActiveWork === true,
      message: `Request control accepted (${policy}).`,
    };
  });

  registerDesktopActionHandler(pi, "resume.claim", async (args, context) => {
    const candidateId = typeof args.candidateId === "string" && args.candidateId.trim()
      ? args.candidateId.trim()
      : typeof args.id === "string" && args.id.trim()
        ? args.id.trim()
        : undefined;
    const commandContext = (context as SessionActionContext).commandContext;
    const sessionContext = commandContext?.sessionManager
      ? { sessionManager: commandContext.sessionManager }
      : {
          sessionManager: {
            getSessionId: () => `desktop-action-${Date.now()}`,
            getSessionFile: () => "",
          },
        };
    let result: ReturnType<RuntimeRequestCoordinator["claimAndDispatchResume"]>;
    try {
      result = coordinator.claimAndDispatchResume(sessionContext, candidateId, {
        expectedRevision: args.expectedRevision as number,
      });
    } catch (error) {
      if (error instanceof RuntimeResumeClaimError) {
        throw new DesktopActionHandlerError(error.code, error.message, error.details);
      }
      throw error;
    }
    if (!result?.dispatched) {
      throw new DesktopActionHandlerError(
        "resume_unavailable",
        candidateId
          ? `Resume candidate ${candidateId} could not be claimed and dispatched.`
          : "A single ready resume candidate was not available for claim.",
        { candidateId },
      );
    }
    const deadline = Date.now() + 1_500;
    let receiptState = coordinator.getContinuationReceiptState(result.dispatchId);
    while (receiptState === "missing" && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
      receiptState = coordinator.getContinuationReceiptState(result.dispatchId);
    }
    if (receiptState === "missing") {
      result.revert();
      throw new DesktopActionHandlerError(
        "resume_not_accepted",
        candidateId
          ? `Resume candidate ${candidateId} was dispatched but not accepted by the shared continuation path.`
          : "Resume continuation dispatch was not accepted by the shared continuation path.",
        { candidateId, dispatchId: result.dispatchId },
      );
    }
    const snapshot = inspectRuntimeResume(agentDir(), { candidateId: result.candidateId }).snapshot;
    const continuity = readContextContinuity(agentDir());
    return {
      candidateId: result.candidateId,
      requestId: result.requestId,
      claimToken: result.claimToken,
      dispatchId: result.dispatchId,
      dispatched: true,
      accepted: true,
      revision: snapshot.revision,
      continuationReceiptState: receiptState,
      snapshot,
      continuityPhase: continuity.activeTurn?.phase || "",
      message: `Resume claim accepted for ${result.requestId}.`,
    };
  });

  registerDesktopActionHandler(pi, "resume.inspect", args => {
    const candidateId = requiredText(args, ["candidateId", "id"]).trim();
    const inspected = inspectRuntimeResume(agentDir(), { candidateId });
    if (!inspected.candidate) {
      throw new DesktopActionHandlerError("not_found", `Resume candidate ${candidateId} does not exist.`, { candidateId });
    }
    return { candidate: inspected.candidate, snapshot: inspected.snapshot, message: `Resume candidate ${candidateId} inspected.` };
  });

  registerDesktopActionHandler(pi, "resume.reconcile", () => {
    const transition = reconcileRuntimeResume(agentDir(), {
      projectId: stableRuntimeResumeProjectId(),
      timestamp: new Date().toISOString(),
    });
    return { snapshot: transition.snapshot, message: "Resume candidates reconciled." };
  });
}
