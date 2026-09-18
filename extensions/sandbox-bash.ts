/**
 * =============================================================================
 * Canvast — Sandbox Bash / Canvast 源文件
 * =============================================================================
 * @file        extensions/sandbox-bash.ts
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
// Sandbox Bash Execution Control / Bash 沙箱执行控制

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool, createLocalBashOperations, type BashOperations } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  DesktopActionHandlerError,
  registerDesktopActionHandler,
  registerDesktopActionTool,
} from "../src/desktop-action/tool-bridge.js";

import {
  createSandboxController,
  normalizePermissionMode,
  normalizeSandboxProfile,
  type SandboxDecision,
  type SandboxGrantScope,
} from "../src/harness/sandbox.js";
import { SandboxGrantStoreError } from "../src/harness/sandbox-grant-store.js";
import { createCredentialStreamRedactor } from "../src/harness/credential-redaction.js";
import {
  checkPairedExactCommand,
  resolvePairedExactCommandCapability,
} from "../src/harness/trusted-evaluation.js";
import {
  recordApprovalReview,
  summarizeRuntimeInput,
  type ApprovalAuthorization,
  type ApprovalReviewRisk,
} from "../src/harness/runtime-status.js";
import { publishRuntimePolicyOutcome } from "../src/harness/runtime-policy-outcome-bridge.js";

const FILE_ACCESS_TOOLS = new Set(["read", "write", "edit", "notebook_edit"]);

function filePathFromToolCall(toolName: string, input: unknown): string | undefined {
  if (!FILE_ACCESS_TOOLS.has(toolName) || !input || typeof input !== "object") return undefined;
  const values = input as Record<string, unknown>;
  const candidate = toolName === "notebook_edit"
    ? values.notebook_path
    : values.file_path ?? values.path;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function decisionSummary(decision: SandboxDecision): string {
  const writePaths = decision.writePaths.length ? `\nWrite paths:\n${decision.writePaths.map(path => `- ${path}`).join("\n")}` : "";
  const missing = decision.missingGrants.length
    ? `\nRequired grants:\n${decision.missingGrants.map(item => `- ${item.kind}: ${item.value}`).join("\n")}`
    : "";
  return [
    `Action: ${decision.action}`,
    `Profile: ${decision.profile}`,
    `Reason: ${decision.reason}`,
    `Categories: ${decision.categories.join(", ") || "none"}`,
    writePaths,
    missing,
  ].filter(Boolean).join("\n");
}

const TERMINAL_AUTO_BLOCK_CATEGORIES = new Set([
  "dangerous",
  "hard-danger",
  "protected-path",
  "protected-read",
  "outside-workspace-write",
  "read-only-write",
]);

type SandboxPolicyDisposition = "fallback_allowed" | "terminal";

function shouldTerminateBlockedDecision(decision: SandboxDecision): boolean {
  return decision.severity === "critical" ||
    decision.categories.some(category => TERMINAL_AUTO_BLOCK_CATEGORIES.has(category));
}

function blockedResult(reason: string, decision?: SandboxDecision, terminate = false) {
  const disposition: SandboxPolicyDisposition = terminate ? "terminal" : "fallback_allowed";
  return {
    block: true,
    reason: decision ? `${reason}\n${decisionSummary(decision)}` : reason,
    terminate,
    policyOutcome: {
      kind: "policy_block" as const,
      disposition,
      source: "sandbox-bash",
      categories: decision?.categories || [],
    },
  };
}

function rememberBlockedToolCall<T>(pi: ExtensionAPI, event: any, result: T): T {
  const outcome = (result as any)?.policyOutcome;
  if (outcome) publishRuntimePolicyOutcome(pi, event?.toolCallId, outcome);
  return result;
}

function grantScopeFromChoice(choice: string | undefined): SandboxGrantScope | undefined {
  if (choice === "Allow once") return "once";
  if (choice === "Allow for session") return "session";
  if (choice === "Allow for project") return "project";
  return undefined;
}

function riskFromDecision(decision: SandboxDecision): ApprovalReviewRisk {
  if (decision.severity === "critical") return "critical";
  if (
    decision.categories.includes("outside-workspace-write") ||
    decision.categories.includes("protected-path") ||
    decision.categories.includes("protected-read")
  ) return "high";
  if (decision.severity === "caution") return "medium";
  return "low";
}

function authorizationFromScope(scope: SandboxGrantScope | undefined): ApprovalAuthorization {
  if (scope === "project") return "high";
  if (scope === "session") return "medium";
  if (scope === "once") return "low";
  return "none";
}

function recordSandboxReview(
  agentDir: string,
  tool: string,
  decision: SandboxDecision,
  outcome: "approved" | "needs_user" | "blocked",
  input: unknown,
  scope?: SandboxGrantScope,
): void {
  recordApprovalReview(agentDir, {
    tool,
    decision: outcome,
    risk: riskFromDecision(decision),
    authorization: authorizationFromScope(scope),
    rationale: outcome === "approved"
      ? `Sandbox approval recorded with ${scope || "no"} scope.`
      : decision.reason,
    inputSummary: summarizeRuntimeInput(input),
    categories: decision.categories,
    source: "sandbox-bash",
  });
}

function autoBlockedResult(decision: SandboxDecision, reason: string) {
  const terminate = shouldTerminateBlockedDecision(decision);
  const terminalHint = terminate
    ? "\nTerminal safety outcome: stop this protected or dangerous tool path now; do not retry, bypass, or inspect the same target. Continue only with a non-sensitive alternative or a concise refusal/summary."
    : "";
  return blockedResult(
    `Canvast sandbox Auto mode handled this without prompting and blocked it.\n${reason}${terminalHint}`,
    decision,
    terminate,
  );
}

function maybeAutoResolve(
  controller: ReturnType<typeof createSandboxController>,
  statusDir: string,
  tool: string,
  decision: SandboxDecision,
  input: unknown,
): { resolved: true; result?: any } | { resolved: false } {
  if (controller.permissionMode() !== "auto") return { resolved: false };
  const auto = controller.resolveAutoDecision(decision);
  if (auto.action === "approve" && auto.scope) {
    controller.rememberApproval(decision, auto.scope, auto.reason);
    recordSandboxReview(statusDir, tool, decision, "approved", input, auto.scope);
    return { resolved: true };
  }
  recordSandboxReview(statusDir, tool, decision, "blocked", input);
  return { resolved: true, result: autoBlockedResult(decision, auto.reason) };
}

async function confirmDecision(decision: SandboxDecision, ctx: any): Promise<SandboxGrantScope | undefined> {
  if (!ctx?.hasUI) return undefined;
  const choice = await ctx.ui.select(
    `Sandbox permission\n\n${decisionSummary(decision)}`,
    ["Deny", "Allow once", "Allow for session", "Allow for project"],
    { timeout: 30_000 },
  );
  return grantScopeFromChoice(choice);
}

interface OnceCommandReservation {
  decision: SandboxDecision;
  active: boolean;
}

function reserveOnceCommandGrant(
  controller: ReturnType<typeof createSandboxController>,
  availableOnceCommandGrants: Set<string>,
  command: string,
  cwd: string,
): OnceCommandReservation | undefined {
  const approved = controller.decideBash(command, cwd);
  const fingerprint = approved.commandFingerprint;
  if (
    approved.action !== "allow" ||
    !fingerprint ||
    !availableOnceCommandGrants.delete(fingerprint)
  ) {
    return undefined;
  }
  controller.markDecisionUsed(approved);
  return { decision: approved, active: true };
}

function restoreOnceCommandGrant(
  controller: ReturnType<typeof createSandboxController>,
  availableOnceCommandGrants: Set<string>,
  reservation: OnceCommandReservation | undefined,
): void {
  if (!reservation?.active) return;
  reservation.active = false;
  if (reservation.decision.commandFingerprint) {
    availableOnceCommandGrants.add(reservation.decision.commandFingerprint);
  }
  controller.rememberApproval(
    reservation.decision,
    "once",
    "Restored because command execution was not launched.",
  );
}

export default function (pi: ExtensionAPI) {
  const controller = createSandboxController();
  const localOps = createLocalBashOperations();
  const pairedExactCommand = resolvePairedExactCommandCapability();
  const statusDir = controller.getConfig().agentDir;
  const availableOnceCommandGrants = new Set<string>();

  const rememberApproval = (
    decision: SandboxDecision,
    scope: SandboxGrantScope,
    reason: string,
  ) => {
    const grants = controller.rememberApproval(decision, scope, reason);
    if (scope === "once" && decision.commandFingerprint) {
      availableOnceCommandGrants.add(decision.commandFingerprint);
    }
    return grants;
  };

  const sandboxResult = (message: string, decision?: SandboxDecision) => ({
    config: controller.getConfig(),
    ...controller.grantSnapshot(),
    decision,
    status: controller.renderStatus(),
    message,
  });

  registerDesktopActionHandler(pi, "sandbox.inspect", () => sandboxResult("Sandbox state inspected."));
  registerDesktopActionHandler(pi, "sandbox.profile.set", params => {
    const profile = normalizeSandboxProfile(params.profile);
    if (!profile) throw new DesktopActionHandlerError("invalid_arguments", "profile must be read-only, workspace-write, or full-access.");
    if (profile === "full-access") {
      throw new DesktopActionHandlerError(
        "interactive_approval_required",
        "Full-access sandbox requires interactive approval and is unavailable to unattended desktop actions.",
      );
    }
    controller.setSessionProfile(profile);
    return sandboxResult(`Sandbox profile switched to ${profile}.`);
  });
  registerDesktopActionHandler(pi, "sandbox.grant", params => {
    const command = typeof params.command === "string" && params.command.trim() ? params.command.trim() : undefined;
    const targetPath = typeof params.path === "string" && params.path.trim() ? params.path.trim() : undefined;
    if (Boolean(command) === Boolean(targetPath)) {
      throw new DesktopActionHandlerError("invalid_arguments", "Provide exactly one of command or path.");
    }
    const scope = params.scope;
    if (scope !== "once" && scope !== "session" && scope !== "project") {
      throw new DesktopActionHandlerError("invalid_arguments", "scope must be once, session, or project.");
    }
    if (targetPath && params.access !== "read" && params.access !== "write") {
      throw new DesktopActionHandlerError("invalid_arguments", "Path grants require access=read or access=write.");
    }
    if (targetPath && scope === "once") {
      throw new DesktopActionHandlerError("invalid_arguments", "One-shot path grants are not supported; use session or project scope.");
    }
    let decision = command
      ? controller.decideBash(command)
      : controller.decideFileAccess(String(params.access), targetPath!);
    if (decision.action === "block") {
      recordSandboxReview(statusDir, "sandbox_grant", decision, "blocked", command || targetPath);
      throw new DesktopActionHandlerError("sandbox_blocked", decision.reason, decision);
    }
    if (controller.isUnattended() && (scope === "session" || scope === "project")) {
      recordSandboxReview(statusDir, "sandbox_grant", decision, "needs_user", command || targetPath);
      throw new DesktopActionHandlerError(
        "interactive_approval_required",
        `${scope} sandbox grants require approval from an interactive trusted App/host action.`,
        decision,
      );
    }
    if (decision.missingGrants.length === 0) {
      const kind = command ? "command" : params.access === "read" ? "read_path" : "write_path";
      const value = command ? decision.commandFingerprint! : (decision.readPaths[0] || decision.writePaths[0]);
      decision = { ...decision, missingGrants: [{ kind, value }] };
    }
    const grants = rememberApproval(decision, scope, typeof params.reason === "string" ? params.reason : "Desktop sandbox grant.");
    recordSandboxReview(statusDir, "sandbox_grant", decision, "approved", command || targetPath, scope);
    return {
      ...sandboxResult(`Sandbox grant recorded (${scope}).`, decision),
      createdGrants: grants,
    };
  });
  registerDesktopActionHandler(pi, "sandbox.revoke", params => {
    const grantId = typeof params.grantId === "string" ? params.grantId.trim() : "";
    const expectedRevision = params.expectedRevision;
    if (!grantId || typeof expectedRevision !== "number" ||
        !Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new DesktopActionHandlerError(
        "invalid_arguments",
        "sandbox.revoke requires grantId and a non-negative integer expectedRevision.",
      );
    }
    try {
      const receipt = controller.revokeGrant(grantId, expectedRevision);
      return {
        config: controller.getConfig(),
        status: controller.renderStatus(),
        ...receipt,
      };
    } catch (error) {
      if (error instanceof SandboxGrantStoreError) {
        throw new DesktopActionHandlerError(error.code, error.message, error.details);
      }
      throw error;
    }
  });

  const sandboxOps: BashOperations = {
    exec: async (command, cwd, options) => {
      const streamRedactor = createCredentialStreamRedactor();
      let reservation: OnceCommandReservation | undefined;
      let executionHandedOff = false;
      const streamOptions = {
        ...options,
        onData: (data: Buffer) => {
          const redacted = streamRedactor.push(data.toString("utf-8"));
          if (redacted) options.onData(Buffer.from(redacted));
        },
      };
      try {
        const pairedCheck = checkPairedExactCommand(pairedExactCommand, command);
        if (pairedCheck.action === "reject") throw new Error(pairedCheck.reason);
        let wrapped: { command: string; sandboxed: boolean; degraded: boolean };
        if (pairedCheck.action === "use-outer-seatbelt") {
          const decision = controller.decideBash(command, cwd);
          if (decision.action === "block") {
            throw new Error(`Canvast sandbox blocked command: ${decision.reason}`);
          }
          wrapped = { command, sandboxed: false, degraded: false };
        } else {
          wrapped = controller.buildSandboxedCommand(command, cwd);
        }
        // Build while the grant is visible, then synchronously reserve it before
        // any callback, await, or process handoff can start another execution.
        reservation = reserveOnceCommandGrant(controller, availableOnceCommandGrants, command, cwd);
        if (wrapped.degraded) {
          options.onData(Buffer.from("[Canvast sandbox] OS sandbox unavailable; enforcing policy by preflight path guard.\n"));
        } else if (wrapped.sandboxed) {
          options.onData(Buffer.from("[Canvast sandbox] Executing under OS sandbox.\n"));
        }
        if (options.signal?.aborted) throw new Error("aborted");
        // From this point the local executor owns launch state. Its rejection
        // cannot prove that no child started, so the reservation stays consumed.
        executionHandedOff = true;
        return await localOps.exec(wrapped.command, cwd, streamOptions);
      } catch (error) {
        if (!executionHandedOff) restoreOnceCommandGrant(controller, availableOnceCommandGrants, reservation);
        throw error;
      } finally {
        const flushed = streamRedactor.flush();
        if (flushed) options.onData(Buffer.from(flushed));
      }
    },
  };

  const bashTool = createBashTool(process.env.CANVAST_WORKING_DIR || process.cwd(), {
    operations: sandboxOps,
    spawnHook: ({ command, cwd, env }) => ({
      command,
      cwd,
      env: controller.dependencyInstallEnv({
        ...env,
        CANVAST_SANDBOX_PROFILE: controller.getConfig().profile,
        CANVAST_SANDBOX_NETWORK: controller.getConfig().network,
      }),
    }),
  });

  pi.registerTool({
    ...bashTool,
    label: "bash (sandboxed)",
    description:
      "Execute a bash command through the Canvast sandbox. Default profile is workspace-write. Permission mode ask may prompt; Auto mode never prompts and handles approval-required actions with policy.",
    execute: async (id: string, params: any, signal: AbortSignal | undefined, onUpdate: any) =>
      bashTool.execute(id, params, signal, onUpdate),
  } as any);

  pi.on("tool_call", async (event: any, ctx: any) => {
    if (event.toolName === "bash") {
      const command = String(event.input?.command || "");
      const pairedCheck = checkPairedExactCommand(pairedExactCommand, command);
      if (pairedCheck.action === "reject") {
        return rememberBlockedToolCall(pi, event, blockedResult(pairedCheck.reason));
      }
      const decision = controller.decideBash(command, ctx?.cwd || process.cwd());
      if (decision.action === "allow" || (
        pairedCheck.action === "use-outer-seatbelt" && decision.action === "confirm"
      )) return undefined;
      if (decision.action === "block") {
        recordSandboxReview(statusDir, "bash", decision, "blocked", command);
        return rememberBlockedToolCall(pi, event, blockedResult("Canvast sandbox blocked this command.", decision, shouldTerminateBlockedDecision(decision)));
      }
      const auto = maybeAutoResolve(controller, statusDir, "bash", decision, command);
      if (auto.resolved) return rememberBlockedToolCall(pi, event, auto.result);
      recordSandboxReview(statusDir, "bash", decision, "needs_user", command);
      if (controller.isUnattended() || !ctx?.hasUI) {
        return rememberBlockedToolCall(pi, event, blockedResult(
          "Canvast sandbox requires approval, but unattended/non-interactive mode cannot ask the user.",
          decision,
          shouldTerminateBlockedDecision(decision),
        ));
      }
      const scope = await confirmDecision(decision, ctx);
      if (!scope) return rememberBlockedToolCall(pi, event, blockedResult("Sandbox permission denied or timed out.", decision, shouldTerminateBlockedDecision(decision)));
      rememberApproval(decision, scope, `Approved from ${ctx.mode || "interactive"} tool gate.`);
      recordSandboxReview(statusDir, "bash", decision, "approved", command, scope);
      return undefined;
    }

    const toolName = String(event.toolName || "");
    const filePath = filePathFromToolCall(toolName, event.input);
    if (!filePath) return undefined;
    const decision = controller.decideFileAccess(toolName, filePath, ctx?.cwd || process.cwd());
    if (decision.action === "allow") return undefined;
    const auto = maybeAutoResolve(controller, statusDir, String(event.toolName), decision, filePath);
    if (auto.resolved) return rememberBlockedToolCall(pi, event, auto.result);
    recordSandboxReview(statusDir, String(event.toolName), decision, "needs_user", filePath);
    if (controller.isUnattended() || !ctx?.hasUI) {
      return rememberBlockedToolCall(pi, event, blockedResult(
        "Canvast sandbox requires approval for this file access, but unattended/non-interactive mode cannot ask the user.",
        decision,
        shouldTerminateBlockedDecision(decision),
      ));
    }
    const scope = await confirmDecision(decision, ctx);
    if (!scope) return rememberBlockedToolCall(pi, event, blockedResult("Sandbox file permission denied or timed out.", decision, shouldTerminateBlockedDecision(decision)));
    rememberApproval(decision, scope, `Approved from ${ctx.mode || "interactive"} file gate.`);
    if (scope === "once" && toolName === "notebook_edit" && event.input && typeof event.input === "object") {
      const approvals: WeakMap<object, string> = (pi as any).__canvast_notebook_once_approvals || new WeakMap<object, string>();
      const approvedTarget = decision.writePaths[0];
      if (approvedTarget) approvals.set(event.input, approvedTarget);
      (pi as any).__canvast_notebook_once_approvals = approvals;
    }
    recordSandboxReview(statusDir, String(event.toolName), decision, "approved", filePath, scope);
    return undefined;
  });

  pi.on("user_bash", async (event: any, ctx: any) => {
    const decision = controller.decideBash(String(event.command || ""), event.cwd || ctx?.cwd || process.cwd());
    if (decision.action === "allow") return { operations: sandboxOps };
    if (decision.action === "block") {
      recordSandboxReview(statusDir, "user_bash", decision, "blocked", event.command);
      return {
        result: {
          output: `Canvast sandbox blocked this command.\n${decisionSummary(decision)}`,
          exitCode: 126,
          cancelled: false,
          truncated: false,
        },
      };
    }
    const auto = maybeAutoResolve(controller, statusDir, "user_bash", decision, event.command);
    if (auto.resolved) {
      if (!auto.result) return { operations: sandboxOps };
      return {
        result: {
          output: `${auto.result.reason}`,
          exitCode: 126,
          cancelled: false,
          truncated: false,
        },
      };
    }
    recordSandboxReview(statusDir, "user_bash", decision, "needs_user", event.command);
    if (controller.isUnattended() || !ctx?.hasUI) {
      return {
        result: {
          output: `Canvast sandbox requires approval, but unattended/non-interactive mode cannot ask the user.\n${decisionSummary(decision)}`,
          exitCode: 126,
          cancelled: false,
          truncated: false,
        },
      };
    }
    const scope = await confirmDecision(decision, ctx);
    if (!scope) {
      return {
        result: {
          output: `Sandbox permission denied or timed out.\n${decisionSummary(decision)}`,
          exitCode: 126,
          cancelled: false,
          truncated: false,
        },
      };
    }
    rememberApproval(decision, scope, `Approved from ${ctx.mode || "interactive"} user bash.`);
    recordSandboxReview(statusDir, "user_bash", decision, "approved", event.command, scope);
    return { operations: sandboxOps };
  });

  pi.registerTool({
    name: "sandbox_status",
    label: "Sandbox Status / 沙箱状态",
    description: "Inspect the active sandbox profile, permission mode, OS sandbox availability, unattended behavior, and session/project grants.",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{ type: "text" as const, text: controller.renderStatus() }],
        details: { config: controller.getConfig(), grants: controller.grants() },
      };
    },
  });

  registerDesktopActionTool(pi, {
    name: "sandbox_permission_mode",
    label: "Sandbox Permission Mode / 沙箱权限模式",
    description: "Inspect or switch the session permission mode. ask may prompt; auto never prompts and handles decisions through policy.",
    parameters: Type.Object({
      mode: Type.Optional(Type.Union([Type.Literal("ask"), Type.Literal("auto"), Type.Literal("status")])),
      unattended: Type.Optional(Type.Boolean()),
    }),
    async execute(_id: string, params: any) {
      const rawMode = String(params.mode || "status").toLowerCase();
      if (rawMode === "status") {
        return { content: [{ type: "text" as const, text: controller.renderStatus() }], details: { config: controller.getConfig() } };
      }
      const mode = normalizePermissionMode(rawMode);
      if (!mode) {
        return { isError: true, content: [{ type: "text" as const, text: "Usage: sandbox_permission_mode mode=ask|auto|status" }], details: undefined };
      }
      controller.setPermissionMode(mode, "command",
        typeof params.unattended === "boolean" ? params.unattended : controller.isUnattended());
      return {
        content: [{ type: "text" as const, text: `Sandbox permission mode switched to ${mode}.\n${controller.renderStatus()}` }],
        details: { config: controller.getConfig() },
      };
    },
  });

  pi.registerTool({
    name: "sandbox_grant",
    label: "Sandbox Grant / 沙箱授权",
    description: "Request sandbox access for a command fingerprint or path. Model-side calls fail closed; grants require trusted App/host interaction.",
    parameters: Type.Object({
      scope: Type.Union([Type.Literal("session"), Type.Literal("project"), Type.Literal("once")]),
      command: Type.Optional(Type.String()),
      path: Type.Optional(Type.String()),
      access: Type.Optional(Type.Union([Type.Literal("read"), Type.Literal("write")])),
      reason: Type.Optional(Type.String()),
    }),
    async execute(_id: string, params: any) {
      const fail = (code: "invalid_arguments" | "interactive_approval_required" | "sandbox_blocked", message: string, decision?: SandboxDecision) => ({
        isError: true,
        content: [{ type: "text" as const, text: message }],
        details: { code, decision, status: controller.renderStatus() },
      });
      const command = typeof params.command === "string" && params.command.trim() ? params.command.trim() : undefined;
      const targetPath = typeof params.path === "string" && params.path.trim() ? params.path.trim() : undefined;
      if (Boolean(command) === Boolean(targetPath)) {
        return fail("invalid_arguments", "Provide exactly one of command or path.");
      }
      const scope = params.scope;
      if (scope !== "once" && scope !== "session" && scope !== "project") {
        return fail("invalid_arguments", "scope must be once, session, or project.");
      }
      if (targetPath && params.access !== "read" && params.access !== "write") {
        return fail("invalid_arguments", "Path grants require access=read or access=write.");
      }
      if (targetPath && scope === "once") {
        return fail("invalid_arguments", "One-shot path grants are not supported; use session or project scope.");
      }
      let decision: SandboxDecision | undefined;
      if (command) {
        decision = controller.decideBash(command);
      } else if (targetPath) {
        decision = controller.decideFileAccess(params.access, targetPath);
      }
      if (!decision) return fail("invalid_arguments", "Provide exactly one of command or path.");
      if (decision.action === "block") {
        recordSandboxReview(statusDir, "sandbox_grant", decision, "blocked", command || targetPath);
        return fail("sandbox_blocked", `Canvast sandbox blocked this grant request.\n${decisionSummary(decision)}`, decision);
      }
      recordSandboxReview(statusDir, "sandbox_grant", decision, "needs_user", command || targetPath);
      return fail(
        "interactive_approval_required",
        `Sandbox grants require trusted App/host interactive approval; model-side sandbox_grant cannot authorize itself.\n${decisionSummary(decision)}`,
        decision,
      );
    },
  });

  pi.registerCommand("sandbox", {
    description: "Inspect or set sandbox profile and permission mode: status|ask|auto|read-only|workspace-write|full-access.",
    handler: async (args, ctx) => {
      const raw = String(args || "").trim();
      if (!raw || /^status$/i.test(raw)) {
        ctx.ui?.notify(controller.renderStatus(), "info");
        return;
      }
      const first = raw.split(/\s+/)[0];
      const permissionMode = normalizePermissionMode(first);
      if (permissionMode) {
        controller.setPermissionMode(permissionMode, "command");
        ctx.ui?.notify(controller.renderStatus(), "info");
        return;
      }
      const profile = normalizeSandboxProfile(first);
      if (!profile) {
        ctx.ui?.notify("Usage: /sandbox status|ask|auto|read-only|workspace-write|full-access", "warning");
        return;
      }
      if (profile === "full-access") {
        if (controller.permissionMode() === "auto") {
          ctx.ui?.notify("Full-access sandbox requires ask mode and interactive approval. Auto mode never prompts.", "warning");
          return;
        }
        if (!ctx.hasUI || controller.isUnattended()) {
          ctx.ui?.notify("Full-access sandbox requires interactive approval and is unavailable in unattended mode.", "warning");
          return;
        }
        const ok = await ctx.ui.confirm(
          "Sandbox full access",
          "Full access disables OS sandboxing for bash commands in this session. Continue?",
          { timeout: controller.getConfig().promptTimeoutMs },
        );
        if (!ok) return;
      }
      controller.setSessionProfile(profile);
      ctx.ui?.notify(controller.renderStatus(), "info");
    },
  });

  (pi as any).__canvast_sandbox = controller;
}
