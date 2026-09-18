/**
 * =============================================================================
 * Canvast — Automatic Mode Adapter / 自动模式适配器
 * =============================================================================
 * @file        src/tui/canvast-automatic-mode.ts
 * @brief       Observes the host Shift+Tab key without consuming it and
 *              applies a reversible Canvast runtime tuple.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

import { invokeDesktopActionHandler, invokeDesktopActionTool } from "../desktop-action/tool-bridge.js";
import { DEFAULT_CANVAST_MODE, readCanvastModeState, type CanvastRuntimeMode } from "../harness/canvast-mode.js";
import { readRuntimeStatus } from "../harness/runtime-status.js";

export interface CanvastAutomaticTuple {
  mode: CanvastRuntimeMode;
  permissionMode: "ask" | "auto";
  unattended: boolean;
}

export interface CanvastAutomaticModeState {
  phase: "automatic" | "safe" | "custom";
  tuple: CanvastAutomaticTuple;
}

export const AUTOMATIC_TUPLE: Readonly<CanvastAutomaticTuple> = Object.freeze({
  mode: "enhanced", permissionMode: "auto", unattended: true,
});

export const SAFE_TUPLE: Readonly<CanvastAutomaticTuple> = Object.freeze({
  mode: "parity", permissionMode: "ask", unattended: false,
});

function sameTuple(left: CanvastAutomaticTuple, right: Readonly<CanvastAutomaticTuple>): boolean {
  return left.mode === right.mode && left.permissionMode === right.permissionMode &&
    left.unattended === right.unattended;
}

export function readCanvastAutomaticModeState(agentDir: string): CanvastAutomaticModeState {
  const runtime = readRuntimeStatus(agentDir);
  const tuple: CanvastAutomaticTuple = {
    mode: readCanvastModeState(agentDir)?.mode ||
      (process.env.CANVAST_MODE === "parity" ? "parity" : DEFAULT_CANVAST_MODE),
    permissionMode: runtime.permission.mode,
    unattended: runtime.permission.unattended,
  };
  return {
    phase: sameTuple(tuple, AUTOMATIC_TUPLE) ? "automatic" : sameTuple(tuple, SAFE_TUPLE) ? "safe" : "custom",
    tuple,
  };
}

export function automaticModeStatusLine(state: CanvastAutomaticModeState): string {
  const active = state.phase === "automatic";
  return `Automatic: ${active ? "on" : "off"} (${state.tuple.mode} + permission ${state.tuple.permissionMode} + unattended ${state.tuple.unattended ? "on" : "off"}) / 自动模式：${active ? "开启" : "关闭"}`;
}

async function applyTuple(
  pi: ExtensionAPI,
  target: Readonly<CanvastAutomaticTuple>,
  reason: string,
): Promise<void> {
  const modeResult = await invokeDesktopActionHandler(pi, "runtime.mode", {
    mode: target.mode, scope: "session", reason,
  });
  if (modeResult.error) throw new Error(String(modeResult.error));
  const permissionResult = await invokeDesktopActionTool(
    pi, "sandbox_permission_mode",
    { mode: target.permissionMode, unattended: target.unattended },
    `canvast-automatic-${Date.now()}`,
  );
  if (permissionResult.isError) {
    throw new Error(permissionResult.content?.find(item => item.type === "text")?.text || "Permission tuple update failed.");
  }
}

export async function toggleCanvastAutomaticMode(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  agentDir: string,
): Promise<CanvastAutomaticModeState> {
  const before = readCanvastAutomaticModeState(agentDir);
  const target = before.phase === "automatic" ? SAFE_TUPLE : AUTOMATIC_TUPLE;
  try {
    await applyTuple(pi, target, "Shift+Tab automatic-mode tuple transition.");
  } catch (error) {
    try { await applyTuple(pi, before.tuple, "Rollback after an incomplete automatic-mode transition."); } catch { /* best effort */ }
    throw error;
  }
  const next = readCanvastAutomaticModeState(agentDir);
  ctx.ui.setStatus("canvast", automaticModeStatusLine(next));
  ctx.ui.notify(automaticModeStatusLine(next), "info");
  return next;
}

export function installCanvastAutomaticModeShortcut(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  agentDir: string,
): () => void {
  let transition = Promise.resolve();
  return ctx.ui.onTerminalInput(data => {
    if (!matchesKey(data, "shift+tab")) return undefined;
    transition = transition
      .then(() => toggleCanvastAutomaticMode(pi, ctx, agentDir))
      .then(() => undefined)
      .catch(error => {
        ctx.ui.notify(`Automatic mode switch failed / 自动模式切换失败: ${error instanceof Error ? error.message : String(error)}`, "error");
      });
    return { data };
  });
}
