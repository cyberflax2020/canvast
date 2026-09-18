/**
 * =============================================================================
 * Canvast — Auto Orchestrator Constraints / Canvast 源文件
 * =============================================================================
 * @file        src/harness/auto-orchestrator-constraints.ts
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import { hasAny } from "./intent-signals.js";
import type { AutoOrchestrationAssessment, ToolCallPlanItem } from "./auto-orchestrator.js";

const NORMALIZED_TOOL_NAME_SEPARATOR = "_";

const PERSISTED_CONTEXT_SOURCE_TERMS = [
  "canvas",
  "session",
  "history",
  "summary",
  "memory",
  "画布",
  "会话",
  "历史",
  "摘要",
  "记忆",
  "上下文",
];

const PROVIDED_RECOVERY_SOURCE_TERMS = [
  "snapshot",
  "checkpoint",
  "handoff",
  "user provided",
  "prompt provided",
  "task tracking",
  "task state",
  "plan state",
  "恢复快照",
  "快照",
  "交接",
  "用户提供",
  "prompt 提供",
  "任务追踪",
  "任务状态",
  "计划状态",
];

const NO_SHELL_CONSTRAINT_TERMS = [
  "do not run shell",
  "do not execute shell",
  "no shell",
  "without shell",
  "不要执行 shell",
  "不要执行shell",
  "不执行 shell",
  "不执行shell",
  "不用 shell",
  "不用shell",
  "无需执行 shell",
  "无需执行shell",
];

const AGENT_LAUNCH_TOOLS = new Set([
  "spawn_agent",
  "parallel_agents",
  "subagent",
  "sub_agent",
  "worker_agent",
]);

const CONTEXT_CONTINUITY_TRIGGER_TERMS = [
  "resume",
  "restore",
  "continue",
  "session",
  "恢复",
  "续接",
  "继续",
  "会话",
];

const ACTIVE_WORK_RESUME_TERMS = [
  "continue",
  "resume",
  "preserve",
  "active",
  "main",
  "task",
  "canvas",
  "继续",
  "恢复",
  "保留",
  "主线",
  "任务",
  "画布",
];

function isNameSeparator(char: string): boolean {
  return char === " " ||
    char === "\t" ||
    char === "\n" ||
    char === "\r" ||
    char === "-";
}

export function normalizeToolName(toolName: string): string {
  const out: string[] = [];
  let previousWasSeparator = false;
  for (const char of toolName.trim().toLowerCase()) {
    if (isNameSeparator(char)) {
      if (!previousWasSeparator && out.length > 0) {
        out.push(NORMALIZED_TOOL_NAME_SEPARATOR);
        previousWasSeparator = true;
      }
      continue;
    }
    out.push(char);
    previousWasSeparator = false;
  }
  if (out[out.length - 1] === NORMALIZED_TOOL_NAME_SEPARATOR) out.pop();
  return out.join("");
}

export function namesContextRecallSource(sources: string[]): boolean {
  const normalized = sources.join(" ").toLowerCase();
  return hasAny(normalized, PERSISTED_CONTEXT_SOURCE_TERMS) ||
    hasAny(normalized, PROVIDED_RECOVERY_SOURCE_TERMS);
}

export function hasNoShellConstraint(prompt: string): boolean {
  return hasAny(prompt.toLowerCase(), NO_SHELL_CONSTRAINT_TERMS);
}

export function isAgentLaunchTool(toolName: string): boolean {
  return AGENT_LAUNCH_TOOLS.has(normalizeToolName(toolName));
}

export function hasContextContinuityTrigger(triggers: string[]): boolean {
  return triggers.some(trigger => hasAny(trigger.toLowerCase(), CONTEXT_CONTINUITY_TRIGGER_TERMS));
}

export function resumePlanPreservesActiveWork(resumePlan: string[]): boolean {
  return hasAny(resumePlan.join(" ").toLowerCase(), ACTIVE_WORK_RESUME_TERMS);
}

export function agentPlanTools(toolCallPlan: ToolCallPlanItem[]): Set<string> {
  const tools = toolCallPlan
    .filter(item => item.domain === "agent")
    .flatMap(item => item.tools)
    .map(normalizeToolName);
  return new Set(tools);
}

export function requiresParallelAgentsTool(assessment: AutoOrchestrationAssessment): boolean {
  return assessment.triggers.includes("subagent:parallel_agents");
}
