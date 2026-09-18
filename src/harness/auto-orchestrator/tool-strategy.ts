/**
 * =============================================================================
 * Canvast — Auto Orchestrator Tool Strategy / Canvast 源文件
 * =============================================================================
 * @file        src/harness/auto-orchestrator/tool-strategy.ts
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import {
  groundingRequiresExternalEvidence,
  hasUsableGroundingStrategy,
} from "../grounding-policy.js";
import { hasDependencyInstallIntent } from "../tool-intent.js";
import {
  isReadOnlyBash,
  READ_ONLY_SHELL_PLAN_TOOLS,
} from "../auto-orchestrator-shell.js";
import { hasConcreteWebJustification } from "../web-policy.js";
import { normalizeToolName } from "../auto-orchestrator-constraints.js";
import type {
  AutoOrchestrationAssessment,
  OrchestrationLifecycleAction,
  OrchestrationMode,
  RecordedOrchestrationDecision,
  ToolCallEvent,
  ToolCallPlanItem,
  ToolDomain,
} from "./types.js";
import { isExplicitAgentLaunchSignal } from "./types.js";

export const FILE_MUTATING_TOOLS = new Set([
  "write",
  "edit",
  "multi_edit",
  "patch",
  "apply_patch",
  "notebook_edit",
]);

export const ORCHESTRATION_TOOLS = new Set([
  "auto_orchestration_decision",
  "sidecar_dispatch_decision",
  "task_list",
  "task_get",
  "canvas_query",
  "canvas_trace",
  "permission_audit",
  "usage_stats",
  "git_status",
  "workflow_status",
  "sandbox_status",
  "sandbox_permission_mode",
  "cron_list",
  "monitor_list",
  "task_status",
  "task_output",
  "task_list_bg",
  "list_worktrees",
  "list_agents",
  "mcp_list",
  "report_list",
]);

export const STRATEGY_TOOLS = new Set([
  ...FILE_MUTATING_TOOLS,
  "web_search",
  "web_fetch",
  "web_research",
  "spawn_agent",
  "parallel_agents",
  "run_workflow",
  "task_create",
  "task_update",
  "canvas_record",
  "product_delivery_gate",
  "create_artifact",
  "git_checkpoint",
  "report_update",
  "cron_create",
  "cron_delete",
  "monitor_start",
  "monitor_stop",
  "bg_bash",
  "task_stop",
  "enter_worktree",
  "exit_worktree",
  "mcp_register",
]);

export const SHELL_GRANT_TOOLS = new Set(["sandbox_grant"]);

const EMERGENT_STRATEGY_DOMAINS = new Set<ToolDomain>([
  "file_write",
  "web",
  "agent",
  "workflow",
  "task",
  "canvas",
  "test",
  "package",
  "tui",
]);

const NATIVE_LOCAL_SEARCH_TOOLS = new Set(["content_search", "grep", "find", "ls", "read"]);
const SHELL_ONLY_LOCAL_SEARCH_COMMANDS = new Set(["rg", "ripgrep", "fd", "fd_find"]);

const DOMAIN_TOOL_EXAMPLES: Record<ToolDomain, string[]> = {
  local_search: ["content_search", "grep", "find", "ls", "read"],
  file_read: ["read"],
  file_write: ["write", "edit", "multi_edit", "apply_patch"],
  shell: ["bash", "bg_bash"],
  web: ["web_search", "web_fetch", "web_research"],
  task: ["task", "task_create", "task_update", "task_list", "enter_plan_mode", "propose_plan", "ask_user"],
  agent: ["spawn_agent", "parallel_agents", "list_agents"],
  workflow: ["run_workflow", "workflow_status"],
  canvas: ["canvas_query", "canvas_record", "canvas_trace"],
  test: ["test", "vitest", "pytest", "npm_test", "safe-run"],
  review: ["review", "report_findings", "report_update", "permission_audit"],
  monitor: ["monitor_start", "monitor_list", "usage_stats", "watchdog", "sandbox_status", "sandbox_permission_mode"],
  package: ["product_delivery_gate", "create_artifact", "git_checkpoint", "zip"],
  tui: ["tui", "canvast_tui", "terminal_ui"],
};

interface ToolDomainMatcher {
  exact?: readonly string[];
  prefixes?: readonly string[];
  contains?: readonly string[];
  tokens?: readonly string[];
}

const TOOL_DOMAIN_MATCHERS: Record<ToolDomain, ToolDomainMatcher> = {
  local_search: { exact: ["content_search", "ls", "find", "grep"] },
  file_read: { exact: ["read", "cat", "sed", "nl", "head", "tail", "grep", "rg", "ripgrep"] },
  file_write: {
    exact: ["write", "edit", "multi_edit", "patch", "apply_patch", "notebook_edit"],
    tokens: ["write", "edit", "patch", "delete", "remove", "create", "update", "apply", "save", "import"],
  },
  shell: {
    exact: ["bash", "shell", "exec", "execute", "bg_bash"],
    tokens: ["run", "execute", "exec", "start", "stop"],
  },
  web: {
    exact: ["search_web", "fetch_url", "browser_search", "browser_fetch"],
    prefixes: ["web_"],
  },
  task: {
    exact: ["enter_plan_mode", "propose_plan", "approve_plan", "exit_plan_mode", "ask_user"],
    prefixes: ["task_"],
  },
  agent: {
    exact: ["spawn_agent", "parallel_agents", "list_agents", "subagent", "sub_agent", "worker_agent"],
  },
  workflow: { exact: ["run_workflow", "workflow", "workflow_status"] },
  canvas: { prefixes: ["canvas_"] },
  test: {
    exact: ["test", "verify", "vitest", "jest", "pytest", "go_test", "cargo_test", "npm_test", "npm_run_test", "safe_run", "regression", "e2e"],
  },
  review: {
    exact: ["report_findings", "report_update", "permission_audit"],
    tokens: ["review"],
  },
  monitor: {
    exact: ["usage_stats", "watchdog", "permission_audit", "sandbox_status", "sandbox_permission_mode"],
    tokens: ["monitor"],
  },
  package: {
    exact: ["product_delivery_gate", "create_artifact", "git_checkpoint", "package", "pack", "archive", "zip", "tar"],
    prefixes: ["cron_", "mcp_"],
    contains: ["worktree", "artifact"],
  },
  tui: { exact: ["tui", "canvast_tui", "terminal_ui", "dashboard", "task_tree"] },
};

export const MODE_RANK: Record<OrchestrationMode, number> = {
  direct: 0,
  plan: 1,
  subagents: 2,
  workflow: 3,
};

export function hasExplicitAgentLaunchSignal(hits: string[]): boolean {
  return hits.some(isExplicitAgentLaunchSignal);
}

export function minimumSubagentTasks(assessment: AutoOrchestrationAssessment): number {
  return assessment.triggers.some(trigger =>
    trigger.startsWith("subagent:") &&
    isExplicitAgentLaunchSignal(trigger.slice("subagent:".length)),
  ) ? 1 : 2;
}

export function toolPlanDomains(plan: ToolCallPlanItem[] | undefined): Set<ToolDomain> {
  return new Set((plan || []).map(item => item.domain));
}

export function isSandboxCommandGrant(toolName: string, input: Record<string, unknown>): boolean {
  return normalizeToolName(toolName) === "sandbox_grant" && typeof input.command === "string" && input.command.trim().length > 0;
}

export function toolEventName(event: ToolCallEvent): string {
  return String(event.toolName || event.tool_name || event.name || "");
}

export function toolEventInput(event: ToolCallEvent): Record<string, unknown> {
  if (event.input && typeof event.input === "object") return event.input;
  if (event.args && typeof event.args === "object") return event.args;
  if (event.arguments && typeof event.arguments === "object") return event.arguments;
  if (typeof event.arguments === "string") {
    try {
      const parsed = JSON.parse(event.arguments);
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return {};
}

export function defaultToolPlanItem(domain: ToolDomain, webJustification?: string): ToolCallPlanItem {
  const order: ToolCallPlanItem["order"] =
    domain === "file_write" ? "during_edit"
      : domain === "test" || domain === "package" ? "after_edit"
        : ["task", "agent", "workflow", "canvas", "monitor", "review"].includes(domain) ? "as_needed"
          : "before_edit";
  return {
    domain,
    tools: DOMAIN_TOOL_EXAMPLES[domain],
    purpose: `Cover required ${domain} control for the automatic orchestration strategy.`,
    order,
    parallelSafe: !["file_write", "shell", "workflow", "package"].includes(domain),
    webJustification: domain === "web" ? webJustification : undefined,
  };
}

export function decisionRequiresWebPlan(
  decision: Pick<RecordedOrchestrationDecision, "webUse" | "groundingStrategy">,
): boolean {
  if (decision.webUse !== "not_needed") return true;
  return Boolean(
    decision.groundingStrategy &&
    groundingRequiresExternalEvidence(decision.groundingStrategy),
  );
}

export function hasWebEvidenceReason(
  decision: Pick<RecordedOrchestrationDecision, "webJustification" | "groundingStrategy">,
): boolean {
  return hasConcreteWebJustification(decision.webJustification) ||
    hasUsableGroundingStrategy(decision.groundingStrategy);
}

export function isLifecycleModeCompatible(
  action: OrchestrationLifecycleAction | undefined,
  mode: OrchestrationMode,
): boolean {
  if (!action) return true;
  if (action === "exit") return mode === "direct";
  if (action === "update") return true;
  return mode !== "direct";
}

export function structuralModeRequiresPlanSteps(
  assessment: AutoOrchestrationAssessment,
  decision: Pick<RecordedOrchestrationDecision, "mode" | "lifecycleAction">,
): boolean {
  if (decision.lifecycleAction === "exit") return false;
  if (!decision.lifecycleAction) return assessment.requiresPlan;
  return decision.mode === "plan" || decision.mode === "subagents" || decision.mode === "workflow";
}

export function structuralModeRequiresSubagentTasks(
  assessment: AutoOrchestrationAssessment,
  decision: Pick<RecordedOrchestrationDecision, "mode" | "lifecycleAction">,
): boolean {
  if (decision.lifecycleAction === "exit") return false;
  if (!decision.lifecycleAction) return assessment.requiresSubagents && decision.mode !== "workflow";
  return decision.mode === "subagents";
}

export function structuralModeRequiresWorkflowSteps(
  assessment: AutoOrchestrationAssessment,
  decision: Pick<RecordedOrchestrationDecision, "mode" | "lifecycleAction">,
): boolean {
  if (decision.lifecycleAction === "exit") return false;
  if (!decision.lifecycleAction) return assessment.requiresWorkflow;
  return decision.mode === "workflow";
}

export function requiredToolDomainsForDecision(
  assessment: AutoOrchestrationAssessment,
  decision: Pick<RecordedOrchestrationDecision, "mode" | "lifecycleAction" | "webUse" | "groundingStrategy"> & { toolCallPlan?: ToolCallPlanItem[] },
): ToolDomain[] {
  if (decision.lifecycleAction === "exit") return [];
  const plannedDomains = toolPlanDomains(decision.toolCallPlan || []);
  const lifecycleEntryBoundaryOnly =
    decision.lifecycleAction === "enter" &&
    decision.mode === "plan" &&
    plannedDomains.size > 0 &&
    Array.from(plannedDomains).every(domain => domain === "task");
  if (lifecycleEntryBoundaryOnly) return ["task"];
  if (!decision.lifecycleAction || MODE_RANK[decision.mode] >= MODE_RANK[assessment.mode]) {
    return assessment.requiredToolDomains;
  }

  const domains = new Set<ToolDomain>();
  if (decision.mode === "subagents") domains.add("agent");
  if (decision.mode === "workflow") domains.add("workflow");
  if (
    assessment.webUsePolicy === "required" ||
    decision.webUse !== "not_needed" ||
    (decision.groundingStrategy && groundingRequiresExternalEvidence(decision.groundingStrategy))
  ) {
    domains.add("web");
  }
  if (assessment.requiresTaskAdjustment) domains.add("task");
  if (hasDependencyInstallIntent(assessment.prompt.toLowerCase())) {
    domains.add("shell");
    domains.add("package");
  }
  return Array.from(domains);
}

export function toolDomain(toolName: string): ToolDomain | undefined {
  const normalized = normalizeToolName(toolName);
  const priority: ToolDomain[] = [
    "web",
    "agent",
    "workflow",
    "canvas",
    "task",
    "monitor",
    "package",
    "tui",
    "test",
    "local_search",
    "file_read",
    "file_write",
    "shell",
    "review",
  ];
  for (const domain of priority) {
    if (toolMatchesDomain(normalized, domain)) return domain;
  }
  return undefined;
}

export function emergentStrategyDomain(
  toolName: string,
  input: Record<string, unknown>,
): ToolDomain | undefined {
  const normalized = normalizeToolName(toolName);
  if (normalized === "auto_orchestration_decision" || normalized === "sidecar_dispatch_decision") return undefined;
  if (normalized === "bash") {
    const command = String(input.command || "");
    if (hasDependencyInstallIntent(command.toLowerCase())) return "package";
    return isReadOnlyBash(command) ? undefined : "shell";
  }
  const domain = toolDomain(normalized);
  if (!domain) return undefined;
  return EMERGENT_STRATEGY_DOMAINS.has(domain) ? domain : undefined;
}

export function toolMatchesDomain(toolName: string, domain: ToolDomain): boolean {
  const normalized = normalizeToolName(toolName);
  if (normalized === domain) return true;
  const matcher = TOOL_DOMAIN_MATCHERS[domain];
  const exact = new Set(matcher.exact || []);
  if (exact.has(normalized)) return true;
  if ((matcher.prefixes || []).some(prefix => normalized.startsWith(prefix))) return true;
  if ((matcher.contains || []).some(part => normalized.includes(part))) return true;
  if (matcher.tokens && matcher.tokens.length > 0) {
    const tokens = new Set(normalized.split("_").filter(Boolean));
    return matcher.tokens.some(token => tokens.has(token));
  }
  return false;
}

export function toolPlanToolMatchesDomain(toolName: string, domain: ToolDomain): boolean {
  const normalized = normalizeToolName(toolName);
  if (domain === "local_search") return NATIVE_LOCAL_SEARCH_TOOLS.has(normalized);
  if (toolMatchesDomain(normalized, domain)) return true;
  if (domain === "shell") return READ_ONLY_SHELL_PLAN_TOOLS.has(normalized);
  if (domain === "package") {
    return ["bash", "npm", "pnpm", "yarn", "bun", "pip", "uv", "cargo", "go"].includes(normalized);
  }
  return domain === "file_read" && normalized === "bash";
}

export function formatDomainExamples(domains: ToolDomain[]): string {
  return domains
    .map(domain => `${domain}: ${DOMAIN_TOOL_EXAMPLES[domain].join("/")}`)
    .join("; ");
}

export function hasDedicatedLocalSearchTool(toolCallPlan: ToolCallPlanItem[]): boolean {
  return toolCallPlan
    .filter(item => item.domain === "local_search")
    .flatMap(item => item.tools)
    .map(normalizeToolName)
    .some(tool => NATIVE_LOCAL_SEARCH_TOOLS.has(tool));
}

export function hasLocalSearchReadTool(toolCallPlan: ToolCallPlanItem[]): boolean {
  return toolCallPlan
    .filter(item => item.domain === "local_search")
    .flatMap(item => item.tools)
    .map(normalizeToolName)
    .includes("read");
}

export function hasPlanApprovalBoundary(toolCallPlan: ToolCallPlanItem[] | undefined): boolean {
  return (toolCallPlan || [])
    .filter(item => item.domain === "task")
    .flatMap(item => item.tools)
    .map(normalizeToolName)
    .some(tool =>
      tool === "enter_plan_mode" ||
      tool === "propose_plan" ||
      tool === "approve_plan"
    );
}

export function shellOnlyLocalSearchTools(item: ToolCallPlanItem): string[] {
  if (item.domain !== "local_search") return [];
  return item.tools
    .map(normalizeToolName)
    .filter(tool => SHELL_ONLY_LOCAL_SEARCH_COMMANDS.has(tool));
}
