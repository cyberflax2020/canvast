/**
 * =============================================================================
 * Canvast — Feature Registry / Canvast 源文件
 * =============================================================================
 * @file        src/frontend/feature-registry.ts
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
export interface FrontendFeature {
  id: string;
  title: string;
  command?: string;
  controlPlane: string;
  detail: string;
  enhanced: boolean;
  primary: boolean;
}

export const FRONTEND_FEATURES: FrontendFeature[] = [
  { id: "chat", title: "Run", command: "canvast.sh", controlPlane: "agent", detail: "Interactive and print-mode execution through the same local harness.", enhanced: false, primary: true },
  { id: "reasoningTrace", title: "Reasoning Trace", command: "auto_orchestration_decision", controlPlane: "orchestration", detail: "Visible reasoning summaries, tool strategy, and verification notes without exposing hidden chain-of-thought.", enhanced: true, primary: true },
  { id: "autoOrchestration", title: "Auto Orchestration", command: "auto_orchestration_decision", controlPlane: "orchestration", detail: "Automatic plan, sub-agent, workflow, web, context, and verification decision gate.", enhanced: true, primary: true },
  { id: "planMode", title: "Plan", command: "enter_plan_mode", controlPlane: "planning", detail: "Plan proposal, approval, scope constraints, amendments, and execution readiness.", enhanced: true, primary: true },
  { id: "canvas", title: "Canvas", command: "/canvast-canvas", controlPlane: "canvas", detail: "Graph state for files, plans, decisions, and agent runs.", enhanced: true, primary: true },
  { id: "dynamicCanvas", title: "Dynamic Canvas", command: "canvas_record", controlPlane: "canvas", detail: "Live graph updates for scope, traceability, stale file detection, and recovery.", enhanced: true, primary: true },
  { id: "taskTree", title: "Tasks", command: "/canvast-tasks", controlPlane: "planning", detail: "Task tree, dependencies, blockers, and plan/task adjustment.", enhanced: true, primary: true },
  { id: "subAgents", title: "Agents", command: "/canvast-agents", controlPlane: "agent", detail: "Bounded sub-agent branches, isolated state, and result merge.", enhanced: true, primary: true },
  { id: "workflow", title: "Workflow", command: "/canvast-workflow", controlPlane: "orchestration", detail: "Sequential, parallel, and DAG workflow entry.", enhanced: true, primary: true },
  { id: "dynamicWorkflow", title: "Dynamic Workflow", command: "run_workflow", controlPlane: "orchestration", detail: "Runtime workflow planning, bounded worker pools, cycle detection, and verification gates.", enhanced: true, primary: true },
  { id: "tools", title: "Tools", command: "/canvast-tools", controlPlane: "tools", detail: "Coordinated tool strategy for reads, writes, shell, tests, web, agents, workflow, and package steps.", enhanced: false, primary: true },
  { id: "webResearch", title: "Web", command: "/canvast-web", controlPlane: "research", detail: "Current/external evidence search, fetch, research synthesis, source URLs, and domain filters.", enhanced: false, primary: true },
  { id: "context", title: "Context", command: "/canvast-context", controlPlane: "memory", detail: "Compaction, recall, resume continuity, active task recovery, and cross-session state.", enhanced: true, primary: true },
  { id: "sessions", title: "Sessions", controlPlane: "memory", detail: "Project-scoped persistent sessions, ephemeral mode, and state directory policy.", enhanced: false, primary: false },
  { id: "askUser", title: "Ask User", command: "ask_user", controlPlane: "interaction", detail: "Structured confirmation requests with unattended non-blocking behavior.", enhanced: false, primary: false },
  { id: "sandbox", title: "Sandbox", command: "/canvast-sandbox", controlPlane: "safety", detail: "Read-only, workspace-write, and full-access profiles with grants.", enhanced: false, primary: true },
  { id: "permissions", title: "Permissions", command: "permission_audit", controlPlane: "safety", detail: "Protected paths, dangerous command blocks, approval policy, and audit trail.", enhanced: false, primary: false },
  { id: "models", title: "Models", controlPlane: "runtime", detail: "Provider, model, thinking level, context budget, and modality capability display.", enhanced: false, primary: false },
  { id: "modelRegistry", title: "Model Registry", controlPlane: "runtime", detail: "Commercial-use registry adapters for context windows, tool use, multimodal and structured output capabilities.", enhanced: false, primary: false },
  { id: "lsp", title: "LSP", command: "lsp", controlPlane: "code-intel", detail: "Definition, references, hover, document symbols, and workspace symbols.", enhanced: false, primary: false },
  { id: "notebooks", title: "Notebooks", command: "notebook_edit", controlPlane: "editing", detail: "Notebook cell replace, insert, and delete operations.", enhanced: false, primary: false },
  { id: "artifacts", title: "Artifacts", command: "create_artifact", controlPlane: "delivery", detail: "Standalone HTML artifact creation and local review.", enhanced: false, primary: false },
  { id: "cron", title: "Cron", command: "cron_create", controlPlane: "automation", detail: "Session-level scheduled tasks with explicit supported cron subset.", enhanced: false, primary: false },
  { id: "monitor", title: "Monitor", command: "monitor_start", controlPlane: "observability", detail: "File watches and command polling with visible status.", enhanced: false, primary: false },
  { id: "backgroundTasks", title: "Background", command: "bg_bash", controlPlane: "execution", detail: "Bounded background shell tasks with output caps and process-group cleanup.", enhanced: false, primary: false },
  { id: "worktrees", title: "Worktrees", command: "enter_worktree", controlPlane: "isolation", detail: "Isolated git worktrees for experiments and parallel work.", enhanced: false, primary: false },
  { id: "git", title: "Git", command: "git_status", controlPlane: "source", detail: "Status, diff, and checkpoint entry points.", enhanced: false, primary: false },
  { id: "mcp", title: "MCP", command: "mcp_list", controlPlane: "integration", detail: "MCP registration, listing, and tool bridge entry.", enhanced: false, primary: false },
  { id: "codeReview", title: "Review", command: "report_findings", controlPlane: "quality", detail: "Structured findings, severity, location, status, and verification.", enhanced: false, primary: false },
  { id: "usage", title: "Usage", command: "usage_stats", controlPlane: "observability", detail: "Tool calls, turns, token estimates, and cost estimates.", enhanced: false, primary: false },
  { id: "closure", title: "Closure", command: "/canvast-closure", controlPlane: "delivery", detail: "Evidence-backed product delivery gates with no open required gaps.", enhanced: true, primary: true },
  { id: "evaluation", title: "Quality Validation", command: "verify:product", controlPlane: "verification", detail: "Canvast quality scenarios, evidence-backed checks, remediation loops, and verification reports.", enhanced: true, primary: false },
  { id: "packaging", title: "Package", command: "package:product", controlPlane: "delivery", detail: "Clean product verification, exclusions, archive, and retest path.", enhanced: false, primary: false },
  { id: "safety", title: "Safety", command: "/canvast-safety", controlPlane: "safety", detail: "Watchdog, safe-run, process lifecycle, and resource thresholds.", enhanced: false, primary: true },
  { id: "guiGuard", title: "GUI Guard", command: "unattended-gui-guard", controlPlane: "safety", detail: "Scoped unattended guard for frontend tests that prevents Canvast-launched GUI/browser popups.", enhanced: false, primary: false },
  { id: "offscreenSnapshot", title: "Offscreen Snapshot", command: "render_snapshot", controlPlane: "frontend", detail: "No-window render model for UI inspection and regression checks.", enhanced: true, primary: false },
  { id: "macApp", title: "macOS App", controlPlane: "frontend", detail: "Native desktop front end exposing the full Canvast control surface.", enhanced: true, primary: false },
];

export function frontendFeatureCommands(): string[] {
  return FRONTEND_FEATURES.flatMap(feature => feature.command ? [feature.command] : []);
}

