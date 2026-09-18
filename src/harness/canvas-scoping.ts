/**
 * =============================================================================
 * Canvast — Harness: Canvas Scoping (pi extension hook)
 * =============================================================================
 * @file        src/harness/canvas-scoping.ts
 * @brief       Injects Canvas-scoped context into agent system prompt
 * @description pi extension that hooks into before_agent_start to assemble
 *              the Canvas Scoped View and inject it. Also handles stale file
 *              alerts and context budget enforcement.
 *              pi 扩展，在 before_agent_start 中注入 Canvas 作用域上下文。
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * Changes: [2026-08-08] Initial implementation
 * =============================================================================
 */

import type { CanvasStore } from "../graph/canvas-store.js";
import { assembleCanvasScopedView, estimateScopeTokens } from "../graph/canvas-scope.js";
import { allocateBudget, checkBudget, estimateTokens as estimateMsgTokens } from "./context-budgeting.js";
import { modelBudgetDefaults, resolveModelCapabilities } from "./model-capabilities.js";
import { checkPlanScope } from "./plan-constraints.js";

/**
 * pi extension: Canvas Scoping harness control plane.
 *
 * Usage in pi extension:
 *   import { createCanvasScopingHarness } from "canvast/harness";
 *   export default function(pi: ExtensionAPI) {
 *     const harness = createCanvasScopingHarness(store);
 *     pi.on("before_agent_start", harness.onAgentStart);
 *     pi.on("tool_call", harness.onToolCall);
 *   }
 */
export function createCanvasScopingHarness(store: CanvasStore) {
  let activePlanId: string | undefined;
  let currentTaskId: string | undefined;

  return {
    /** Set the active plan (called when plan is approved) */
    setActivePlan(planId: string) { activePlanId = planId; },
    /** Set the current task */
    setCurrentTask(taskId: string) { currentTaskId = taskId; },

    /**
     * before_agent_start hook: inject Canvas scoped view into system prompt.
     *
     * pi contract: this handler must RETURN the payload to inject — either
     * { message } or { systemPrompt }. The runner chains any returned
     * `systemPrompt` into the turn's prompt (see runner.emitBeforeAgentStart).
     * There is NO `ctx.appendSystemPrompt` on pi's ExtensionContext, so relying
     * on it silently drops the injection (2026-08-15: found + fixed).
     */
    async onAgentStart(event: any, ctx: any) {
      if (!currentTaskId) return undefined;

      // 1. Assemble Canvas scoped view
      let scopeText = assembleCanvasScopedView(store, currentTaskId);
      const scopeTokens = estimateScopeTokens(scopeText);

      // 2. Estimate current context (pi exposes the chained prompt on the event;
      //    ctx.getSystemPrompt() is an equivalent fallback).
      const systemPrompt = event?.systemPrompt || ctx.getSystemPrompt?.() || "";
      const sysTokens = estimateMsgTokens(systemPrompt);

      // 3. Allocate budget
      const capabilities = resolveModelCapabilities();
      const budgetDefaults = modelBudgetDefaults(capabilities);
      const budget = allocateBudget(scopeTokens, budgetDefaults.maxFiles, {
        capabilities,
        ...budgetDefaults,
      });

      // 4. Check hard ceiling, warn (don't block) if exceeded
      const currentTotal = sysTokens + scopeTokens;
      const result = checkBudget(currentTotal, budget.recentHistory, budgetDefaults.hardCeiling);
      if (!result.withinBudget && result.suggestion) {
        scopeText += `\n\n[Canvast context budget]\n${result.suggestion}`;
      }

      // 5. Return the appended system prompt so pi chains it in.
      return { systemPrompt: systemPrompt + "\n\n" + scopeText };
    },

    /**
     * tool_call hook: enforce Plan Constraints.
     */
    async onToolCall(event: any, _ctx: any) {
      const { toolName: tool, input } = event;
      const filePath = input?.file_path || input?.notebook_path || input?.path;
      const command = input?.command;

      const check = checkPlanScope(store, activePlanId, { tool, filePath, command });

      if (!check.allowed) {
        return {
          block: true,
          reason: check.reason,
        };
      }

      // If file is in scope but stale, warn (don't block)
      if (filePath) {
        const fileNode = store.findNodesByProperty("file", { path: filePath })[0];
        if (fileNode && store.isFileStale(fileNode.id)) {
          // Allow the operation but the agent was already warned in the scoped view
          // Could inject a runtime warning here if pi supports it
        }
      }
    },
  };
}
