/**
 * =============================================================================
 * Canvast — Canvas Context Scoping / 画布上下文作用域
 * =============================================================================
 * @file        src/graph/canvas-scope.ts
 * @brief       Assembles scoped context from Canvas for agent tasks
 * @description Builds a structured context package by querying the Canvas for
 *              the Plan, Decision, File, and AgentRun nodes relevant to a task.
 *              The output is injected into the agent's system prompt as a
 *              "Canvas Scoped View" section (~2-5K tokens).
 *              从 Canvas 为 agent 任务组装结构化上下文包，注入为系统提示中的
 *              "Canvas Scoped View" 区块。
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * Changes:
 *   [2026-08-08] Initial implementation
 * =============================================================================
 */

import type { CanvasStore } from "./canvas-store.js";
import type { CanvasScope } from "./types.js";

/**
 * Assembles the Canvas Scoped View for an agent about to execute a task.
 * This is the ~2-5K token structured block injected into the system prompt.
 */
export function assembleCanvasScopedView(
  store: CanvasStore,
  taskId: string,
): string {
  const scope = store.assembleScope(taskId);

  if (!scope.task && !scope.plan) {
    return "[Canvas] No scoped context available for this task. / 此任务无可用画布上下文。";
  }

  const lines: string[] = [];
  lines.push("## Canvas Scoped View / 画布作用域");
  lines.push("");

  // Task context
  if (scope.task) {
    const t = scope.task;
    lines.push(`### 📋 Current Task / 当前任务`);
    lines.push(`- **Goal / 目标**: ${t.properties.goal}`);
    lines.push(`- **Status / 状态**: ${t.properties.status}`);
    if (t.properties.steps?.length) {
      lines.push(`- **Steps / 步骤**:`);
      for (const s of t.properties.steps) {
        const icon = s.status === "completed" ? "✅" : s.status === "in_progress" ? "🔄" : "⏳";
        lines.push(`  ${icon} [${s.status}] ${s.description}`);
      }
    }
    lines.push("");
  }

  // Parent Plan
  if (scope.plan) {
    const p = scope.plan;
    lines.push(`### 🎯 Parent Plan / 父计划`);
    lines.push(`- **Goal / 目标**: ${p.properties.goal}`);
    lines.push(`- **Status / 状态**: ${p.properties.status}`);
    const scopeFiles = p.properties.scope?.files || [];
    if (scopeFiles.length) {
      lines.push(`- **Scope Files / 范围文件**: ${scopeFiles.join(", ")}`);
    }
    lines.push("");
  }

  // Motivating Decisions
  if (scope.decisions.length) {
    lines.push(`### 🧭 Why This Work / 为什么做这个`);
    for (const d of scope.decisions.slice(0, 3)) {
      lines.push(`- **Decision / 决策**: ${d.properties.chosen}`);
      lines.push(`  - Problem / 问题: ${d.properties.problem}`);
      lines.push(`  - Rationale / 理由: ${d.properties.rationale}`);
      if (d.properties.alternatives?.length) {
        lines.push(`  - Alternatives / 替代方案: ${d.properties.alternatives.join("; ")}`);
      }
    }
    lines.push("");
  }

  // Constraints
  const allConstraints = [
    ...(scope.plan?.properties.constraints || []),
    ...(scope.task?.properties.constraints || []),
  ];
  if (allConstraints.length) {
    lines.push(`### ⚠️ Constraints / 约束`);
    for (const c of allConstraints) {
      lines.push(`- ${c}`);
    }
    lines.push("");
  }

  // Relevant files
  if (scope.files.length) {
    lines.push(`### 📁 Relevant Files / 相关文件`);
    for (const f of scope.files.slice(0, 5)) {
      const stale = store.isFileStale(f.id) ? " ⚠️[MAY BE STALE/可能过时]" : "";
      lines.push(`- \`${f.properties.path}\` (${f.properties.language || "unknown"}, ${f.properties.size} bytes)${stale}`);
    }
    lines.push("");
  }

  // Stale warnings
  if (scope.staleWarnings.length) {
    lines.push(`### ⚠️ Stale File Warnings / 过时文件警告`);
    for (const w of scope.staleWarnings) {
      lines.push(`- ${w}`);
    }
    lines.push("");
  }

  // Related agent runs
  const completedRuns = (scope.agentRuns || []).filter(r => r.properties.status === "completed");
  if (completedRuns.length) {
    lines.push(`### 🔗 Dependent Agent Results / 依赖的 Agent 结果`);
    for (const r of completedRuns.slice(0, 3)) {
      lines.push(`- **AgentRun / 执行**: ${r.properties.summary || r.properties.task}`);
      lines.push(`  - Files produced / 产出文件: ${(r.properties.filesProduced || []).join(", ") || "none"}`);
      lines.push(`  - Duration / 耗时: ${r.properties.endTime ? calcDuration(r.properties.startTime, r.properties.endTime) : "N/A"}`);
    }
    lines.push("");
  }

  // Token budget
  lines.push(`---`);
  lines.push(`*Canvas context: queried at BFS depth 2. Use canvas_query tool for deeper exploration.*`);
  lines.push(`*画布上下文: BFS 深度 2。使用 canvas_query 工具进行更深探索。*`);

  return lines.join("\n");
}

function calcDuration(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}min`;
}

/** Estimate token count for the scoped view (rough: 4 chars ≈ 1 token for EN, 2 chars ≈ 1 token for CN) */
export function estimateScopeTokens(scopeText: string): number {
  const enChars = (scopeText.match(/[a-zA-Z0-9\s.,;:!?\-_/()[\]{}'"`]/g) || []).length;
  const otherChars = scopeText.length - enChars;
  return Math.ceil(enChars / 4 + otherChars / 2);
}
