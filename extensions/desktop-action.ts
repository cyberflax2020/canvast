/**
 * =============================================================================
 * Canvast — Desktop Action Host / 桌面动作宿主
 * =============================================================================
 * @file        extensions/desktop-action.ts
 * @brief       No-LLM command and tool entry points for native desktop actions.
 * @description Registers /canvast-action and canvast_action against one
 *              deterministic dispatcher, then emits a correlated custom result
 *              without triggering an agent turn.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  DESKTOP_ACTION_RESULT_TYPE,
  DesktopActionDispatcher,
  DesktopActionRequestSchema,
  failedDesktopAction,
  type DesktopActionResult,
} from "../src/desktop-action/index.js";
import { shutdownCanvasExports } from "../src/desktop-action/canvas-export-handler.js";
import type {
  ReplacementSessionContext,
  ReplacementSessionResultRelay,
} from "../src/desktop-action/project-lifecycle.js";

interface DesktopActionPublishContext {
  sendMessage?: ExtensionAPI["sendMessage"];
}

function createResultRelay(): ReplacementSessionResultRelay {
  let replacementContext: ReplacementSessionContext | undefined;
  return {
    get sessionContext() { return replacementContext; },
    setResultContext(context) { replacementContext = context; },
  };
}

function publishResult(target: DesktopActionPublishContext, result: DesktopActionResult): Promise<void> | void {
  return target.sendMessage?.({
    customType: DESKTOP_ACTION_RESULT_TYPE,
    content: JSON.stringify(result),
    display: false,
    details: result,
  }, { triggerTurn: false });
}

function commandContextWithResultRelay<T extends object>(
  ctx: T,
  resultRelay: ReplacementSessionResultRelay,
): T & { resultRelay: ReplacementSessionResultRelay } {
  const commandContext = Object.create(ctx) as T & { resultRelay: ReplacementSessionResultRelay };
  Object.defineProperty(commandContext, "sessionManager", {
    get() {
      const replacement = resultRelay.sessionContext as { sessionManager?: unknown } | undefined;
      return replacement?.sessionManager ?? (ctx as { sessionManager?: unknown }).sessionManager;
    },
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(commandContext, "resultRelay", {
    value: resultRelay,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return commandContext;
}

export default function (pi: ExtensionAPI) {
  const dispatcher = new DesktopActionDispatcher(pi);
  let shuttingDown = false;
  const host = {
    dispatch: (...args: Parameters<DesktopActionDispatcher["dispatch"]>) => {
      if (shuttingDown) {
        const request = args[0] as { requestId?: unknown };
        return Promise.resolve(dispatcher.record(failedDesktopAction(
          typeof request?.requestId === "string" ? request.requestId : "invalid-request",
          "dispatch_failed", "Desktop actions are unavailable while the session is shutting down.",
        )));
      }
      return dispatcher.dispatch(...args);
    },
  };

  pi.registerCommand("canvast-action", {
    description: "Execute one versioned Canvast desktop action JSON envelope without invoking an LLM.",
    handler: async (args, ctx) => {
      const resultRelay = createResultRelay();
      try {
        const result = await host.dispatch(args, {
          commandContext: commandContextWithResultRelay(ctx, resultRelay),
          signal: ctx.signal,
        });
        await publishResult(resultRelay.sessionContext || pi, result);
      } catch (error) {
        await publishResult(resultRelay.sessionContext || pi, dispatcher.record(failedDesktopAction(
          "invalid-request", "dispatch_failed", error instanceof Error ? error.message : String(error),
        )));
      }
    },
  });

  pi.registerTool({
    name: "canvast_action",
    label: "Canvast Desktop Action",
    description: "Execute the same deterministic typed desktop action dispatcher used by /canvast-action.",
    parameters: DesktopActionRequestSchema,
    async execute(_id, params, signal) {
      let result: DesktopActionResult;
      try {
        result = await host.dispatch(params, { signal });
      } catch (error) {
        result = dispatcher.record(failedDesktopAction(
          typeof (params as any)?.requestId === "string" ? (params as any).requestId : "invalid-request",
          "dispatch_failed", error instanceof Error ? error.message : String(error),
        ));
      }
      await publishResult(pi, result);
      return {
        isError: result.status === "failed",
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: result,
      };
    },
  });

  (pi as any).__canvast_desktop_action = host;
  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    await shutdownCanvasExports();
  });
}
