/**
 * =============================================================================
 * Canvast — Permission Command / Canvast 源文件
 * =============================================================================
 * @file        src/tui/canvast-permission-command.ts
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  DesktopActionHandlerError,
  invokeDesktopActionTool,
  type DesktopToolResult,
} from "../desktop-action/tool-bridge.js";
import { readRuntimeStatus, runtimeStatusSummary } from "../harness/runtime-status.js";

interface PermissionCommandOptions {
  agentDir: () => string;
  appendPanel: (title: string, lines: string[]) => void;
}

interface SandboxPermissionConfig {
  permissionMode?: string;
  permissionSource?: string;
  unattended?: boolean;
}

interface PermissionCommandFailureDetails {
  code: string;
  toolName: "sandbox_permission_mode";
  cause?: unknown;
}

export interface PermissionCommandErrorResult {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
  details: PermissionCommandFailureDetails;
}

type PermissionCommandResult = PermissionCommandErrorResult | undefined;

function failPermissionCommand(
  message: string,
  code: string,
  cause?: unknown,
): PermissionCommandErrorResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    details: { code, toolName: "sandbox_permission_mode", cause },
  };
}

function isPermissionCommandErrorResult(value: unknown): value is PermissionCommandErrorResult {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as { isError?: unknown }).isError === true &&
    Array.isArray((value as { content?: unknown }).content),
  );
}

function sandboxConfigFromResult(result: DesktopToolResult): SandboxPermissionConfig | undefined {
  const details = result?.details;
  if (!details || typeof details !== "object") return undefined;
  const config = (details as { config?: unknown }).config;
  return config && typeof config === "object" ? config as SandboxPermissionConfig : undefined;
}

function permissionStatusLines(config: SandboxPermissionConfig): string[] {
  return [
    `Current permission mode: ${config.permissionMode || "unknown"}`,
    `Source: ${config.permissionSource || "unknown"}`,
    `Unattended: ${config.unattended === true}`,
    "ask: approval-required actions may prompt when interactive UI is available.",
    "auto: no approval prompts; routine low-risk confirmations are handled by policy, high-risk boundaries return structured blocks so long sessions do not hang.",
    "Hard safety blocks remain active in every mode.",
  ];
}

function switchedPermissionLines(mode: string): string[] {
  return [
    `Permission mode switched to ${mode}.`,
    mode === "auto"
      ? "Auto mode will not open permission prompts; policy approvals or structured blocks are recorded in runtime status."
      : "Ask mode may use interactive approval prompts when available.",
    "Use /canvast-sandbox to inspect reviews and grants.",
  ];
}

async function callSandboxPermissionMode(
  pi: ExtensionAPI,
  mode: "ask" | "auto" | "status",
): Promise<DesktopToolResult | PermissionCommandErrorResult> {
  if (!pi.events || typeof pi.events.emit !== "function") {
    return failPermissionCommand(
      "Canvast sandbox permission control is unavailable: deterministic tool dispatch is not active.",
      "handler_unavailable",
    );
  }
  try {
    return await invokeDesktopActionTool(
      pi,
      "sandbox_permission_mode",
      { mode },
      `canvast-permission-${mode}-${Date.now()}`,
    );
  } catch (error) {
    if (error instanceof DesktopActionHandlerError) {
      return failPermissionCommand(
        `Canvast sandbox permission control is unavailable: ${error.message}`,
        error.code,
        error.details,
      );
    }
    return failPermissionCommand(
      `Canvast sandbox permission control failed: ${error instanceof Error ? error.message : String(error)}`,
      "dispatch_failed",
    );
  }
}

export async function handleCanvastPermissionCommand(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
  options: PermissionCommandOptions,
): Promise<PermissionCommandResult> {
  const raw = String(args || "").trim().toLowerCase();
  if (raw && raw !== "status" && raw !== "ask" && raw !== "auto") {
    ctx.ui.notify("Usage: /canvast-permission ask|auto|status", "warning");
    return;
  }

  const mode = raw === "ask" || raw === "auto" ? raw : "status";
  const result = await callSandboxPermissionMode(pi, mode);
  if (isPermissionCommandErrorResult(result)) return result;

  if (result.isError === true) {
    const message = result.content?.find(item => item?.type === "text")?.text ||
      "Canvast sandbox permission mode change failed.";
    return failPermissionCommand(
      message,
      typeof (result.details as any)?.code === "string" ? (result.details as any).code : "tool_failed",
      result.details,
    );
  }

  const config = sandboxConfigFromResult(result);
  if (!config) {
    return failPermissionCommand(
      "Canvast sandbox permission control returned an invalid result without configuration details.",
      "invalid_tool_result",
      result.details,
    );
  }

  options.appendPanel(
    "Canvast Permission",
    mode === "status" ? permissionStatusLines(config) : switchedPermissionLines(config.permissionMode || mode),
  );
  ctx.ui.setStatus("canvast", runtimeStatusSummary(readRuntimeStatus(options.agentDir())));
  return;
}
