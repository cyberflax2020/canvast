/**
 * =============================================================================
 * Canvast — Token & Cost Tracker / Token与成本追踪
 * =============================================================================
 * @file        extensions/token-tracker.ts
 * @brief       Track token usage and cost per turn and session
 * @description Adapted from pi-vs-claude-code/tool-counter.ts (MIT).
 *              Tracks: tool calls, tokens consumed, estimated cost.
 *              从 tool-counter.ts (MIT) 适配的 token 与成本追踪。
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * Changes: [2026-08-08] Initial — from pi-vs-claude-code/tool-counter.ts (MIT)
 * =============================================================================
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  defaultRuntimeStatusDir,
  updateRuntimeModel,
  updateRuntimeTokens,
} from "../src/harness/runtime-status.js";

interface UsageStats {
  toolCalls: Record<string, number>;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  effectiveTokens: number;
  contextWindowTokens: number;
  contextUsedTokens: number;
  contextRemainingTokens: number;
  contextUsageRatio: number;
  estimatedCost: number;
}

interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

function runtimeDir(): string {
  return defaultRuntimeStatusDir();
}

function asNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function modelProvider(model: any): string {
  return String(model?.provider || process.env.CANVAST_PROVIDER || process.env.CANVAST_DEFAULT_PROVIDER || "");
}

function modelId(model: any): string {
  return String(model?.id || model?.model || process.env.CANVAST_MODEL || process.env.CANVAST_DEFAULT_MODEL || "");
}

function thinkingLevels(model: any): string[] {
  const map = model?.thinkingLevelMap;
  if (!map || typeof map !== "object") return ["minimal", "low", "medium", "high", "xhigh", "max"];
  return Object.entries(map)
    .filter(([, value]) => value !== null)
    .map(([level]) => level);
}

function syncModel(pi: ExtensionAPI, ctx?: any): void {
  const model = ctx?.model;
  const modalities = Array.isArray(model?.input) ? model.input.map((item: unknown) => String(item)) : [];
  const level = typeof (pi as any).getThinkingLevel === "function"
    ? String((pi as any).getThinkingLevel())
    : "";
  updateRuntimeModel(runtimeDir(), {
    provider: modelProvider(model),
    model: modelId(model),
    thinkingLevel: level,
    availableThinkingLevels: thinkingLevels(model),
    modalities,
    imageInput: modalities.includes("image") ? "supported" : modalities.length ? "unsupported" : "unknown",
  });
}

function usageFromMessage(message: any): UsageLike | undefined {
  return message && typeof message === "object" && message.usage && typeof message.usage === "object"
    ? message.usage as UsageLike
    : undefined;
}

function addUsage(stats: UsageStats, usage: UsageLike | undefined): void {
  if (!usage) return;
  const input = asNumber(usage.input);
  const output = asNumber(usage.output);
  const cacheRead = asNumber(usage.cacheRead);
  const cacheWrite = asNumber(usage.cacheWrite);
  stats.inputTokens += input;
  stats.outputTokens += output;
  stats.cacheReadTokens += cacheRead;
  stats.cacheWriteTokens += cacheWrite;
  stats.totalTokens += asNumber(usage.totalTokens) || input + output + cacheRead + cacheWrite;
  stats.effectiveTokens += input + output + cacheWrite;
  stats.estimatedCost += asNumber(usage.cost?.total);
}

function recomputeUsage(stats: UsageStats, ctx?: any): void {
  stats.inputTokens = 0;
  stats.outputTokens = 0;
  stats.cacheReadTokens = 0;
  stats.cacheWriteTokens = 0;
  stats.totalTokens = 0;
  stats.effectiveTokens = 0;
  stats.estimatedCost = 0;

  let latestUsage: UsageLike | undefined;
  const branch = typeof ctx?.sessionManager?.getBranch === "function" ? ctx.sessionManager.getBranch() : [];
  for (const entry of Array.isArray(branch) ? branch : []) {
    if (entry?.type === "message") {
      const usage = usageFromMessage(entry.message);
      addUsage(stats, usage);
      if (usage) latestUsage = usage;
    } else if ((entry?.type === "compaction" || entry?.type === "branch_summary") && entry.usage) {
      const usage = entry.usage as UsageLike;
      addUsage(stats, usage);
      latestUsage = usage;
    }
  }

  const contextUsage = typeof ctx?.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
  stats.contextWindowTokens = asNumber(contextUsage?.contextWindow) || asNumber(ctx?.model?.contextWindow);
  stats.contextUsedTokens = asNumber(contextUsage?.tokens) || (latestUsage
    ? asNumber(latestUsage.totalTokens) || asNumber(latestUsage.input) + asNumber(latestUsage.output)
    : 0);
  stats.contextRemainingTokens = stats.contextWindowTokens > 0
    ? Math.max(0, stats.contextWindowTokens - stats.contextUsedTokens)
    : 0;
  stats.contextUsageRatio = stats.contextWindowTokens > 0
    ? Math.min(1, stats.contextUsedTokens / stats.contextWindowTokens)
    : 0;
}

function persistUsage(stats: UsageStats): void {
  updateRuntimeTokens(runtimeDir(), {
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    cacheReadTokens: stats.cacheReadTokens,
    cacheWriteTokens: stats.cacheWriteTokens,
    totalTokens: stats.totalTokens,
    effectiveTokens: stats.effectiveTokens,
    contextWindowTokens: stats.contextWindowTokens,
    contextUsedTokens: stats.contextUsedTokens,
    contextRemainingTokens: stats.contextRemainingTokens,
    contextUsageRatio: stats.contextUsageRatio,
    turnCount: stats.turns,
    toolCalls: Object.values(stats.toolCalls).reduce((sum, count) => sum + count, 0),
    costUsd: stats.estimatedCost,
  });
}

export default function (pi: ExtensionAPI) {
  const stats: UsageStats = {
    toolCalls: {},
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    effectiveTokens: 0,
    contextWindowTokens: 0,
    contextUsedTokens: 0,
    contextRemainingTokens: 0,
    contextUsageRatio: 0,
    estimatedCost: 0,
  };

  pi.on("session_start", (_event: any, ctx: any) => {
    syncModel(pi, ctx);
    recomputeUsage(stats, ctx);
    persistUsage(stats);
  });

  pi.on("model_select", (_event: any, ctx: any) => {
    syncModel(pi, ctx);
    recomputeUsage(stats, ctx);
    persistUsage(stats);
  });

  pi.on("thinking_level_select", (event: any, ctx: any) => {
    updateRuntimeModel(runtimeDir(), {
      provider: modelProvider(ctx?.model),
      model: modelId(ctx?.model),
      thinkingLevel: String(event?.level || ""),
      availableThinkingLevels: thinkingLevels(ctx?.model),
      modalities: Array.isArray(ctx?.model?.input) ? ctx.model.input.map((item: unknown) => String(item)) : [],
      imageInput: Array.isArray(ctx?.model?.input) && ctx.model.input.includes("image") ? "supported" : "unsupported",
    });
  });

  // Track tool calls
  pi.on("tool_execution_end", (event: any, ctx: any) => {
    const name = event.toolName || "unknown";
    stats.toolCalls[name] = (stats.toolCalls[name] || 0) + 1;
    recomputeUsage(stats, ctx);
    persistUsage(stats);
  });

  // Track turns
  pi.on("turn_end", (_event: any, ctx: any) => {
    stats.turns = Math.max(stats.turns, Number(_event?.turnIndex || 0) + 1);
    recomputeUsage(stats, ctx);
    persistUsage(stats);
  });

  // Register usage query tool
  pi.registerTool?.({
    name: "usage_stats",
    label: "Usage Stats / 用量统计",
    description: "Query token usage and cost statistics for the current session.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute() {
      const topTools = Object.entries(stats.toolCalls)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 10)
        .map(([name, count]) => `  ${name}: ${count}`).join("\n");

      return {
        content: [{
          type: "text" as const,
          text: [
            "# Usage Stats / 用量统计",
            "",
            `Turns / 轮次: ${stats.turns}`,
            `Tokens / Token: ${Math.round(stats.totalTokens).toLocaleString()} total, ${Math.round(stats.inputTokens).toLocaleString()} input, ${Math.round(stats.outputTokens).toLocaleString()} output`,
            stats.contextWindowTokens > 0
              ? `Context / 上下文: ${Math.round(stats.contextUsedTokens).toLocaleString()} / ${Math.round(stats.contextWindowTokens).toLocaleString()} (${Math.round(stats.contextUsageRatio * 100)}%)`
              : "Context / 上下文: unknown",
            `Est. Cost / 估算成本: $${stats.estimatedCost.toFixed(4)}`,
            "",
            "Top Tools / 工具使用:",
            topTools || "  (none yet)",
          ].join("\n"),
        }],
        details: undefined,
      };
    },
  });
}
