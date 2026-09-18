/**
 * =============================================================================
 * Canvast — TUI Project Lifecycle Commands / TUI 项目生命周期命令
 * =============================================================================
 * @file        src/tui/canvast-project-command.ts
 * @brief       Typed TUI adapters for shared project and session lifecycle actions.
 * @description Delegates every preflight and mutation decision to the live
 *              desktop-action owners while rendering explicit command receipts.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type {
  ProjectLifecycleActionReceipt,
  ProjectLifecycleOperation,
  ProjectPreflightReceipt,
  SessionDeleteReceipt,
} from "../desktop-action/project-lifecycle.js";
import {
  DesktopActionHandlerError,
  invokeDesktopActionHandler,
} from "../desktop-action/tool-bridge.js";

const PROJECT_COMMAND = "/canvast-project-lifecycle";
const PROJECT_USAGE =
  `Usage: ${PROJECT_COMMAND} status|create <path>|open <path>|reinitialize [path]|confirm <create|open|reinitialize> <revision> <path>`;
const SESSION_USAGE = "Usage: /canvast-session delete <session-path>";

type ProjectMutationKind = "project.create" | "project.open" | "project.reinitialize";
type LifecycleActionKind = ProjectMutationKind | "project.preflight" | "session.delete";

interface ProjectCommandOptions {
  appendPanel: (title: string, lines: string[]) => void;
}

interface ParsedToken {
  token: string;
  remainder: string;
}

type ParsedProjectCommand =
  | { type: "status" }
  | { type: "request"; operation: ProjectLifecycleOperation; path?: string }
  | {
    type: "confirm";
    operation: ProjectLifecycleOperation;
    revision: string;
    path: string;
  };

interface LifecycleCommandFailureDetails {
  code: string;
  actionKind: LifecycleActionKind;
  cause?: unknown;
}

export interface LifecycleCommandErrorResult {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
  details: LifecycleCommandFailureDetails;
}

type LifecycleCommandResult = LifecycleCommandErrorResult | undefined;

function takeToken(input: string): ParsedToken {
  const text = input.trim();
  let boundary = text.length;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === " " || character === "\t" || character === "\n" || character === "\r") {
      boundary = index;
      break;
    }
  }
  return {
    token: text.slice(0, boundary),
    remainder: text.slice(boundary).trim(),
  };
}

function projectOperation(value: string): ProjectLifecycleOperation | undefined {
  if (value === "create" || value === "open" || value === "reinitialize") return value;
  return undefined;
}

function parseProjectCommand(args: string): ParsedProjectCommand | undefined {
  const first = takeToken(String(args || ""));
  if (!first.token || first.token === "status") {
    return first.remainder ? undefined : { type: "status" };
  }
  if (first.token === "confirm") {
    const operationToken = takeToken(first.remainder);
    const operation = projectOperation(operationToken.token);
    const revisionToken = takeToken(operationToken.remainder);
    if (!operation || !revisionToken.token || !revisionToken.remainder) return undefined;
    return {
      type: "confirm",
      operation,
      revision: revisionToken.token,
      path: revisionToken.remainder,
    };
  }
  const operation = projectOperation(first.token);
  if (!operation) return undefined;
  if (!first.remainder && operation !== "reinitialize") return undefined;
  return { type: "request", operation, path: first.remainder || undefined };
}

function mutationKind(operation: ProjectLifecycleOperation): ProjectMutationKind {
  if (operation === "create") return "project.create";
  if (operation === "open") return "project.open";
  return "project.reinitialize";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPreflightReceipt(value: unknown): value is ProjectPreflightReceipt {
  if (!isRecord(value) || value.receiptType !== "project-preflight") return false;
  return projectOperation(String(value.operation || "")) !== undefined
    && typeof value.revision === "string"
    && Boolean(value.revision)
    && typeof value.requiresApproval === "boolean"
    && typeof value.canProceed === "boolean"
    && typeof value.canProceedWithApproval === "boolean"
    && Array.isArray(value.issues)
    && isRecord(value.target)
    && typeof value.target.canonicalPath === "string"
    && typeof value.message === "string";
}

function isProjectReceipt(
  value: unknown,
  expectedKind: ProjectMutationKind,
): value is ProjectLifecycleActionReceipt {
  return isRecord(value)
    && value.receiptType === "project-lifecycle"
    && value.actionKind === expectedKind
    && typeof value.activeProjectRoot === "string"
    && typeof value.targetProjectRoot === "string"
    && typeof value.preflightRevision === "string"
    && typeof value.message === "string";
}

function isSessionDeleteReceipt(value: unknown): value is SessionDeleteReceipt {
  return isRecord(value)
    && value.receiptType === "session-trash"
    && typeof value.sessionId === "string"
    && typeof value.sessionPath === "string"
    && typeof value.trashedSessionPath === "string"
    && typeof value.message === "string";
}

function commandFailure(
  actionKind: LifecycleActionKind,
  code: string,
  message: string,
  cause?: unknown,
): LifecycleCommandErrorResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    details: { code, actionKind, cause },
  };
}

async function invokeLifecycleAction(
  pi: ExtensionAPI,
  actionKind: LifecycleActionKind,
  arguments_: Record<string, unknown>,
  ctx: ExtensionCommandContext,
): Promise<Record<string, unknown> | LifecycleCommandErrorResult> {
  if (!pi.events || typeof pi.events.emit !== "function") {
    return commandFailure(
      actionKind,
      "handler_unavailable",
      `Canvast lifecycle action is unavailable: ${actionKind}.`,
    );
  }
  try {
    return await invokeDesktopActionHandler(pi, actionKind, arguments_, {
      signal: ctx.signal,
      commandContext: ctx,
    });
  } catch (error) {
    if (error instanceof DesktopActionHandlerError) {
      return commandFailure(actionKind, error.code, error.message, error.details);
    }
    return commandFailure(
      actionKind,
      "dispatch_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function isCommandFailure(value: unknown): value is LifecycleCommandErrorResult {
  return isRecord(value) && value.isError === true && Array.isArray(value.content);
}

function showFailure(
  result: LifecycleCommandErrorResult,
  ctx: ExtensionCommandContext,
  options: ProjectCommandOptions,
  title: string,
): LifecycleCommandErrorResult {
  options.appendPanel(title, [
    result.content[0]?.text || "Canvast lifecycle action failed.",
    `Error code: ${result.details.code}`,
  ]);
  ctx.ui.notify(result.content[0]?.text || "Canvast lifecycle action failed.", "error");
  return result;
}

function confirmationCommand(
  operation: ProjectLifecycleOperation,
  revision: string,
  path: string,
): string {
  return `${PROJECT_COMMAND} confirm ${operation} ${revision} ${path}`;
}

function preflightLines(receipt: ProjectPreflightReceipt): string[] {
  const status = receipt.canProceed
    ? "ready"
    : receipt.canProceedWithApproval
      ? "approval required"
      : "blocked";
  return [
    receipt.message,
    `Operation: ${receipt.operation}`,
    `Target: ${receipt.target.canonicalPath}`,
    `Preflight revision: ${receipt.revision}`,
    `Status: ${status}`,
    ...receipt.issues.map(issue => `[${issue.scope}/${issue.code}] ${issue.message}`),
  ];
}

function projectReceiptLines(receipt: ProjectLifecycleActionReceipt): string[] {
  const lines = [
    receipt.message,
    `Action: ${receipt.actionKind}`,
    `Active project: ${receipt.activeProjectRoot}`,
    `Preflight revision: ${receipt.preflightRevision}`,
  ];
  if (receipt.sessionPath) lines.push(`Session: ${receipt.sessionPath}`);
  if (receipt.preservedStatePath) lines.push(`Preserved state: ${receipt.preservedStatePath}`);
  return lines;
}

async function invokeProjectMutation(
  pi: ExtensionAPI,
  operation: ProjectLifecycleOperation,
  path: string,
  ctx: ExtensionCommandContext,
  options: ProjectCommandOptions,
  confirmation?: { revision: string },
): Promise<LifecycleCommandResult> {
  const actionKind = mutationKind(operation);
  const arguments_: Record<string, unknown> = { path };
  if (confirmation) {
    arguments_.expectedRevision = confirmation.revision;
    arguments_.approvedAcknowledgement = true;
  }
  const result = await invokeLifecycleAction(pi, actionKind, arguments_, ctx);
  if (isCommandFailure(result)) {
    return showFailure(result, ctx, options, "Project Lifecycle Error");
  }
  if (!isProjectReceipt(result, actionKind)) {
    return showFailure(
      commandFailure(
        actionKind,
        "invalid_action_result",
        `${actionKind} returned an invalid lifecycle receipt.`,
        result,
      ),
      ctx,
      options,
      "Project Lifecycle Error",
    );
  }
  options.appendPanel("Project Lifecycle", projectReceiptLines(result));
  ctx.ui.notify(result.message, "info");
  return;
}

async function handleProjectRequest(
  pi: ExtensionAPI,
  command: Extract<ParsedProjectCommand, { type: "request" }>,
  ctx: ExtensionCommandContext,
  options: ProjectCommandOptions,
): Promise<LifecycleCommandResult> {
  const path = command.path || ctx.cwd;
  if (!path) {
    ctx.ui.notify(PROJECT_USAGE, "warning");
    return;
  }
  const result = await invokeLifecycleAction(
    pi,
    "project.preflight",
    { path, operation: command.operation },
    ctx,
  );
  if (isCommandFailure(result)) {
    return showFailure(result, ctx, options, "Project Lifecycle Error");
  }
  if (!isPreflightReceipt(result) || result.operation !== command.operation) {
    return showFailure(
      commandFailure(
        "project.preflight",
        "invalid_action_result",
        "project.preflight returned an invalid or mismatched receipt.",
        result,
      ),
      ctx,
      options,
      "Project Lifecycle Error",
    );
  }

  const lines = preflightLines(result);
  if (!result.canProceedWithApproval) {
    options.appendPanel("Project Preflight", lines);
    ctx.ui.notify("Project lifecycle action is blocked by shared preflight.", "warning");
    return;
  }
  if (result.requiresApproval) {
    const confirmation = confirmationCommand(
      command.operation,
      result.revision,
      path,
    );
    options.appendPanel("Project Preflight", [
      ...lines,
      "",
      "No project mutation was executed.",
      "Review the reported changes, then run this exact confirmation command:",
      confirmation,
    ]);
    ctx.ui.notify("Project changes require an explicit revision-bound confirmation.", "warning");
    return;
  }
  if (!result.canProceed) {
    return showFailure(
      commandFailure(
        "project.preflight",
        "invalid_action_result",
        "project.preflight returned an inconsistent readiness state.",
        result,
      ),
      ctx,
      options,
      "Project Lifecycle Error",
    );
  }
  return await invokeProjectMutation(pi, command.operation, path, ctx, options);
}

export function registerCanvastProjectCommands(
  pi: ExtensionAPI,
  options: ProjectCommandOptions,
): void {
  pi.registerCommand("canvast-project-lifecycle", {
    description: "Preflight and run typed project create, open, or reinitialize actions.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const command = parseProjectCommand(args);
      if (!command) {
        ctx.ui.notify(PROJECT_USAGE, "warning");
        return;
      }
      if (command.type === "status") {
        options.appendPanel("Project Lifecycle", [
          PROJECT_USAGE,
          "Canvas scope remains available through /canvast-project status|rebind.",
          "Every create, open, and reinitialize request runs shared project.preflight first.",
        ]);
        return;
      }
      if (command.type === "confirm") {
        await invokeProjectMutation(
          pi,
          command.operation,
          command.path,
          ctx,
          options,
          { revision: command.revision },
        );
        return;
      }
      await handleProjectRequest(pi, command, ctx, options);
    },
  });

  pi.registerCommand("canvast-session", {
    description: "Run typed session lifecycle actions: delete <session-path>.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const action = takeToken(String(args || ""));
      if (action.token !== "delete" || !action.remainder) {
        ctx.ui.notify(SESSION_USAGE, "warning");
        return;
      }
      const result = await invokeLifecycleAction(
        pi,
        "session.delete",
        { sessionPath: action.remainder },
        ctx,
      );
      if (isCommandFailure(result)) {
        showFailure(result, ctx, options, "Session Lifecycle Error");
        return;
      }
      if (!isSessionDeleteReceipt(result)) {
        showFailure(
          commandFailure(
            "session.delete",
            "invalid_action_result",
            "session.delete returned an invalid trash receipt.",
            result,
          ),
          ctx,
          options,
          "Session Lifecycle Error",
        );
        return;
      }
      options.appendPanel("Session Lifecycle", [
        result.message,
        `Session: ${result.sessionPath}`,
        `Trash path: ${result.trashedSessionPath}`,
      ]);
      ctx.ui.notify(result.message, "info");
      return;
    },
  });
}
