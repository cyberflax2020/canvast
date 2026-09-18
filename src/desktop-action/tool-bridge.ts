/**
 * =============================================================================
 * Canvast — Desktop Tool Bridge / 桌面工具桥
 * =============================================================================
 * @file        src/desktop-action/tool-bridge.ts
 * @brief       Reuses registered deterministic tool handlers from desktop actions.
 * @description Connects extensions through Pi's shared extension event bus so
 *              action dispatch executes the exact tool handler, never a prompt.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface DesktopToolResult {
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
  details?: unknown;
}

interface DesktopToolInvocation {
  callId: string;
  params: Record<string, unknown>;
  signal?: AbortSignal;
  claim(): boolean;
  resolve(result: DesktopToolResult): void;
  reject(error: unknown): void;
}

interface ActionableToolDefinition {
  name: string;
  execute: (
    id: string,
    params: any,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void,
  ) => Promise<DesktopToolResult> | DesktopToolResult;
  [key: string]: unknown;
}

export interface DesktopActionHandlerContext {
  signal?: AbortSignal;
  [key: string]: unknown;
}

export type DesktopActionHandler = (
  arguments_: Record<string, unknown>,
  context: DesktopActionHandlerContext,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

interface DesktopActionInvocation {
  arguments: Record<string, unknown>;
  context: DesktopActionHandlerContext;
  claim(): boolean;
  resolve(result: Record<string, unknown>): void;
  reject(error: unknown): void;
}

export class DesktopActionHandlerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly capabilityLevel: "full" | "degraded" = "full",
  ) {
    super(message);
    this.name = "DesktopActionHandlerError";
  }
}

function channel(toolName: string): string {
  return `canvast:desktop-action:tool:${toolName}`;
}

function actionChannel(kind: string): string {
  return `canvast:desktop-action:handler:${kind}`;
}

function isInvocation(value: unknown): value is DesktopToolInvocation {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<DesktopToolInvocation>;
  return typeof item.callId === "string" && typeof item.claim === "function" &&
    typeof item.resolve === "function" && typeof item.reject === "function";
}

export function registerDesktopActionTool(pi: ExtensionAPI, definition: ActionableToolDefinition): void {
  pi.registerTool(definition as any);
  if (!pi.events?.on) return;
  pi.events.on(channel(definition.name), payload => {
    if (!isInvocation(payload)) return;
    if (!payload.claim()) return;
    try {
      Promise.resolve(definition.execute(payload.callId, payload.params, payload.signal, () => undefined))
        .then(payload.resolve, payload.reject);
    } catch (error) {
      payload.reject(error);
    }
  });
}

export function invokeDesktopActionTool(
  pi: ExtensionAPI,
  toolName: string,
  params: Record<string, unknown>,
  callId: string,
  signal?: AbortSignal,
): Promise<DesktopToolResult> {
  return new Promise((resolve, reject) => {
    let claimed = false;
    let settled = false;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const finish = (result: DesktopToolResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => fail(new DesktopActionHandlerError(
      "cancelled", `Desktop action was cancelled while invoking ${toolName}.`, { toolName },
    ));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    const payload: DesktopToolInvocation = {
      callId, params, signal,
      claim: () => {
        if (claimed) return false;
        claimed = true;
        return true;
      },
      resolve: finish, reject: fail,
    };
    pi.events.emit(channel(toolName), payload);
    if (!claimed) fail(new DesktopActionHandlerError(
      "handler_unavailable", `Deterministic tool handler is unavailable: ${toolName}.`, { toolName },
    ));
  });
}

/** Register a desktop-only handler around an extension's existing live owner. */
export function registerDesktopActionHandler(
  pi: ExtensionAPI,
  kind: string,
  handler: DesktopActionHandler,
): void {
  if (!pi.events?.on) return;
  pi.events.on(actionChannel(kind), payload => {
    const invocation = payload as Partial<DesktopActionInvocation>;
    if (!invocation || typeof invocation.claim !== "function" ||
      typeof invocation.resolve !== "function" || typeof invocation.reject !== "function") return;
    if (!invocation.claim()) return;
    try {
      Promise.resolve(handler(invocation.arguments || {}, invocation.context || {}))
        .then(invocation.resolve, invocation.reject);
    } catch (error) {
      invocation.reject(error);
    }
  });
}

/** Invoke exactly one registered live owner without exposing another LLM tool. */
export function invokeDesktopActionHandler(
  pi: ExtensionAPI,
  kind: string,
  arguments_: Record<string, unknown>,
  context: DesktopActionHandlerContext = {},
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let claimed = false;
    let settled = false;
    const signal = context.signal;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const finish = (result: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => fail(new DesktopActionHandlerError(
      "cancelled", `Desktop action was cancelled while invoking ${kind}.`, { kind },
    ));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    const payload: DesktopActionInvocation = {
      arguments: arguments_,
      context,
      claim: () => {
        if (claimed) return false;
        claimed = true;
        return true;
      },
      resolve: finish,
      reject: fail,
    };
    pi.events?.emit(actionChannel(kind), payload);
    if (!claimed) {
      fail(new DesktopActionHandlerError(
        "handler_unavailable",
        `Live desktop action owner is unavailable: ${kind}.`,
        { kind },
      ));
    }
  });
}
