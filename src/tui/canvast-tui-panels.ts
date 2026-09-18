/**
 * =============================================================================
 * Canvast — Canvast Tui Panels / Canvast 源文件
 * =============================================================================
 * @file        src/tui/canvast-tui-panels.ts
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */


import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "node:url";

import { FRONTEND_FEATURES } from "../frontend/feature-registry.js";
import { DEFAULT_CANVAST_MODE, readCanvastModeState } from "../harness/canvast-mode.js";
import {
  CONTEXT_RECALL_HOT_RECORDS,
  readContextRecallArchive,
  readContextRecallIndex,
  renderContextRecallLines,
} from "../harness/context-recall.js";
import { verifyComponentPack } from "../harness/component-verifier.js";
import {
  readRuntimeStatus,
  renderRuntimeStatusLines,
  runtimeStatusSummary,
  type RuntimeStatusItem,
  type RuntimeStatusSnapshot,
} from "../harness/runtime-status.js";
import { resolveSandboxConfig } from "../harness/sandbox.js";
import type { RuntimeResumeSnapshot } from "../harness/runtime-resume.js";
import {
  projectRuntimeLive,
  projectRuntimeLiveSnapshot,
} from "./runtime-live-projection.js";
import {
  formatCanvasStats,
  labelCanvasNode,
  renderCanvasGraphLines,
  type CanvasGraphSnapshot,
  type CanvasGraphRenderOptions,
} from "./canvas-graph-renderer.js";

const EXPAND_HINT = "Press Ctrl+O to expand or collapse this output; use mouse or trackpad scroll for transcript history and End to return to latest.";
const CANVAST_COMMANDS = [
  ["/help", "Open Canvast help and command map."],
  ["/canvast", "Open the main Canvast surface."],
  ["/canvast-new", "Reset the Canvast session view; keeps project Canvas and recall archives."],
  ["/restart", "Project-level Canvast UI/runtime reinitialization; keeps project memory."],
  ["/canvast-restart", "Named alias for /restart."],
  ["/canvast-help", "Open Canvast help and command map."],
  ["/canvast-components", "Show bundled component status and update policy."],
  ["/canvast-features", "List Canvast feature surfaces."],
  ["/canvast-feature <id>", "Open one feature detail panel."],
  ["/canvast-canvas", "Show Canvas graph state."],
  ["/canvast-tasks", "Show task tree state."],
  ["/canvast-agents", "Show sub-agent runs."],
  ["/canvast-status", "Show persistent live runtime status."],
  ["/canvast-resume", "Inspect and trigger shared runtime resume state."],
  ["/canvast-project-lifecycle", "Preflight and run project create/open/reinitialize actions."],
  ["/canvast-session delete <path>", "Move an inactive cataloged session to recoverable trash."],
  ["/canvast-tools", "Show tool coordination policy."],
  ["/canvast-context", "Show context and resume policy."],
  ["/canvast-sandbox", "Show sandbox and permission controls."],
  ["/canvast-permission ask|auto|status", "Switch or inspect session permission mode."],
  ["/canvast-safety", "Show resource safety controls."],
  ["/canvast-web", "Show web research policy."],
  ["/canvast-closure", "Show product closure gates."],
  ["/canvast-mode parity|enhanced|status", "Switch or inspect runtime mode."],
  ["/canvast-thinking <level|status>", "Switch or inspect model thinking level."],
];

export interface Component {
  invalidate(): void;
  render(width: number): string[];
}

class TextBlock implements Component {
  constructor(private readonly lines: string[]) {}
  invalidate() {}
  render(width: number): string[] {
    const safeWidth = renderWidth(width);
    return this.lines.flatMap(line => wrapLine(line, safeWidth));
  }
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME || "/tmp", ".canvast");
}

function projectDir(): string {
  return process.env.CANVAST_INSTALL_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function currentCanvastMode(): string {
  return readCanvastModeState(agentDir())?.mode || process.env.CANVAST_MODE || DEFAULT_CANVAST_MODE;
}

function renderWidth(width: number): number {
  if (!Number.isFinite(width)) return 1;
  return Math.max(1, Math.floor(width));
}

export function widthOf(text: string): number {
  return visibleWidth(text);
}

export function truncate(text: string, width: number): string {
  if (!Number.isFinite(width) || width <= 0) return "";
  return truncateToWidth(text, Math.floor(width), "");
}

function wrapLine(line: string, width: number): string[] {
  const safeWidth = renderWidth(width);
  return wrapTextWithAnsi(line, safeWidth).map(part =>
    widthOf(part) <= safeWidth ? part : truncateToWidth(part, safeWidth, ""),
  );
}

export function panelComponent(title: string, lines: string[], theme: Theme, expanded = true): Component {
  const body = expanded ? lines : lines.slice(0, 14);
  const rendered = [
    theme.fg("accent", theme.bold(title)),
    ...body,
    ...(!expanded && lines.length > body.length ? [theme.fg("dim", `${lines.length - body.length} more lines are hidden. ${EXPAND_HINT}`)] : []),
  ];
  return new TextBlock(rendered);
}

export function brandLogoLines(): string[] {
  const file = path.join(projectDir(), "assets", "brand", "canvast-logo.tui.txt");
  try {
    const text = fs.readFileSync(file, "utf-8").trimEnd();
    return text ? text.split(/\r?\n/) : ["Canvast"];
  } catch {
    return ["Canvast"];
  }
}

function componentBinDir(): string {
  return process.env.CANVAST_COMPONENT_BIN_DIR || path.join(projectDir(), "components", "bin");
}

export function componentStatusLines(): string[] {
  const binDir = componentBinDir();
  const verification = verifyComponentPack({
    installDir: projectDir(),
    componentsDir: path.dirname(binDir),
  });
  const rows = verification.components.map(component => {
    if (component.trusted) return `- ${component.name}: bundled and verified (${component.path})`;
    return `- ${component.name}: untrusted or unavailable (${component.reason}); Canvast will not prioritize it`;
  });
  return [
    "Component pack",
    `Bundled bin dir: ${binDir}`,
    ...rows,
    "",
    "Startup policy:",
    "- Canvast puts the bundled component bin directory before the rest of PATH only after all components verify.",
    "- Canvast sets PI_OFFLINE=1 by default so upstream pi does not silently download missing fd/rg from GitHub.",
    "- Run scripts/update-components.sh to check or install component updates after confirming network access.",
    "- Normal startup never downloads components; use the confirmed updater with a manifest-pinned source.",
  ];
}

export function renderHelpLines(): string[] {
  return [
    ...brandLogoLines(),
    "",
    "Canvast Help",
    "Use /canvast for the main surface. Use /canvast-components to inspect the bundled component pack and update policy.",
    EXPAND_HINT,
    "",
    "Canvast commands:",
    ...CANVAST_COMMANDS.map(([command, detail]) => `- ${command}: ${detail}`),
    "",
    "Adapted native commands:",
    "- /new: native session-level reset/new session; Canvast does not register this name, so it cannot conflict with the host.",
    "- /hotkeys: keyboard map; Ctrl+O expands collapsed tool and panel output.",
    "- PageUp / PageDown: scroll transcript history by one page; mouse or trackpad scrolling remains available.",
    "- /settings: terminal settings inherited from pi, used by the Canvast TUI shell.",
    "- /model: select the active model/provider for this Canvast session.",
    "- /session: show persisted session stats for the current Canvast project namespace.",
    "- /tree: inspect conversation branches; Canvast task/Canvas state is in /canvast-tasks and /canvast-canvas.",
    "- /compact: manually compact long context; Canvast also records resume state through Canvas/session recall.",
    "- /reload: reload extensions, prompts, skills, themes, and Canvast surfaces.",
  ];
}

export function readGraph(): CanvasGraphSnapshot {
  const file = path.join(agentDir(), "canvas-graph.json");
  if (!fs.existsSync(file)) return { nodes: [], edges: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<CanvasGraphSnapshot>;
    return {
      nodes: Array.isArray(raw.nodes) ? raw.nodes : [],
      edges: Array.isArray(raw.edges) ? raw.edges : [],
    };
  } catch {
    return { nodes: [], edges: [] };
  }
}

function labelNode(node: { id: string; type: string; properties?: Record<string, unknown> }): string {
  return labelCanvasNode(node);
}

export function graphStats(graph = readGraph()): string {
  return formatCanvasStats(graph);
}

function parseCanvasArgs(rawArgs = ""): CanvasGraphRenderOptions {
  const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);
  const options: CanvasGraphRenderOptions = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index].toLowerCase();
    const next = tokens[index + 1];
    if ((token === "focus" || token === "node") && next) {
      options.focusId = next;
      index += 1;
    } else if (token === "type" && next) {
      options.typeFilter = next;
      index += 1;
    } else if (token === "search" && next) {
      options.searchText = tokens.slice(index + 1).join(" ");
      break;
    } else if (token === "page" && next) {
      const page = Number.parseInt(next, 10);
      if (Number.isFinite(page)) options.page = page;
      index += 1;
    } else if (token === "limit" && next) {
      const limit = Number.parseInt(next, 10);
      if (Number.isFinite(limit)) options.maxNodes = limit;
      index += 1;
    } else if (!options.focusId && !token.includes(":")) {
      options.focusId = tokens[index];
    }
  }
  return options;
}

export function renderCanvasLines(rawArgs = "", graph = readGraph()): string[] {
  return renderCanvasGraphLines(graph, parseCanvasArgs(rawArgs));
}

function isTerminalTaskTreeStatus(status: unknown): boolean {
  switch (String(status || "").toLowerCase()) {
    case "completed":
    case "done":
    case "succeeded":
    case "failed":
    case "aborted":
    case "expired":
    case "cancelled":
    case "canceled":
    case "deleted":
    case "stale":
      return true;
    default:
      return false;
  }
}

function currentTaskTreeStatus(status: unknown): string {
  const normalized = String(status || "unknown").toLowerCase();
  if (normalized === "in_progress" || normalized === "running" || normalized === "active") {
    return "in progress · current execution / 当前执行";
  }
  if (normalized === "pending" || normalized === "open" || normalized === "queued" || normalized === "waiting") {
    return "open · not started or waiting on dependencies / 尚未开始或等待依赖";
  }
  if (normalized === "blocked" || normalized === "unknown") {
    return "open · waiting on a blocker or dependency / 等待阻塞解除或依赖满足";
  }
  return `${normalized} · current / 当前`;
}

function historicalTaskTreeStatus(status: unknown): string {
  const normalized = String(status || "unknown").toLowerCase();
  return isTerminalTaskTreeStatus(normalized)
    ? `done · history / 历史 (${normalized})`
    : `archived · history / 已归档历史 (${normalized})`;
}

function historicalRuntimeTaskItems(snapshot: RuntimeStatusSnapshot, current: RuntimeStatusItem[]): RuntimeStatusItem[] {
  const currentItems = new Set(current);
  return [...snapshot.plans, ...snapshot.tasks].filter(item =>
    item.id !== "session-runtime" && !currentItems.has(item),
  );
}

export function renderTaskTreeLines(graph = readGraph()): string[] {
  const plans = graph.nodes.filter(node => node.type === "plan");
  const runtime = readRuntimeStatus(agentDir());
  const live = projectRuntimeLive(runtime);
  const currentPlans = live.identity
    ? plans.filter(plan =>
        !isTerminalTaskTreeStatus(plan.properties?.status) &&
        plan.properties?.rootRequestId === live.identity?.rootRequestId &&
        plan.properties?.sessionId === live.identity?.sessionId,
      )
    : [];
  const currentPlanIds = new Set(currentPlans.map(plan => plan.id));
  const historicalPlans = plans.filter(plan => !currentPlanIds.has(plan.id));
  const currentRuntime = [...live.plans, ...live.tasks].filter(item => item.id !== "session-runtime");
  const historicalRuntime = historicalRuntimeTaskItems(runtime, currentRuntime);
  const lines = [
    `Task Tree: ${currentRuntime.length} current runtime items, ${currentPlans.length} current Canvas nodes`,
    "",
    "Current / 当前",
    "In progress: current execution / 当前执行",
    "Open or pending: not started or waiting on dependencies / 尚未开始或等待依赖",
  ];
  if (currentRuntime.length) {
    lines.push("Persistent runtime tasks:");
    for (const item of currentRuntime.slice(-10)) {
      lines.push(`- [${currentTaskTreeStatus(item.status)}] ${item.title}${item.summary ? ` - ${item.summary}` : ""}`);
    }
  } else {
    lines.push("Persistent runtime tasks: none");
  }
  if (currentPlans.length === 0) {
    lines.push("No plan/task nodes yet. Auto orchestration and task_create will populate this tree.");
  } else {
    const currentById = new Map(currentPlans.map(node => [node.id, node]));
    for (const plan of currentPlans.slice(-10)) {
      const status = String(plan.properties?.status || "unknown");
      lines.push(`- ${plan.id} [${currentTaskTreeStatus(status)}] ${labelNode(plan)}`);
      for (const edge of graph.edges.filter(edge =>
        edge.fromNodeId === plan.id &&
        edge.type === "DECOMPOSES_INTO" &&
        currentById.has(edge.toNodeId),
      ).slice(0, 6)) {
        const child = currentById.get(edge.toNodeId);
        lines.push(`  - ${edge.toNodeId} ${child ? labelNode(child) : "(missing node)"}`);
      }
    }
  }
  lines.push(
    "",
    "History / 历史",
    "Done or completed items are history / done 或 completed 项仅属于历史",
  );
  if (historicalRuntime.length) {
    lines.push("Persistent runtime task history:");
    for (const item of historicalRuntime.slice(-10)) {
      lines.push(`- [${historicalTaskTreeStatus(item.status)}] ${item.title}${item.summary ? ` - ${item.summary}` : ""}`);
    }
  }
  if (historicalPlans.length) {
    lines.push("Canvas plan/task history:");
    for (const plan of historicalPlans.slice(-10)) {
      const status = String(plan.properties?.status || "unknown");
      lines.push(`- ${plan.id} [${historicalTaskTreeStatus(status)}] ${labelNode(plan)}`);
    }
  }
  if (!historicalRuntime.length && !historicalPlans.length) lines.push("No terminal or archived task history.");
  return lines;
}

export function renderAgentLines(graph = readGraph()): string[] {
  const agents = graph.nodes.filter(n => n.type === "agent_run");
  const runtime = readRuntimeStatus(agentDir());
  const lines = [`Sub-agents ${agents.length} recorded runs`];
  lines.push("Management: spawn_agent starts one branch; parallel_agents starts bounded independent branches; list_agents shows the local registry.");
  lines.push("Sidecar policy: control, dependent, shared-write, shared-resource, or unproven work stays serial; one proven independent branch uses spawn_agent; multiple proven independent branches use parallel_agents.");
  lines.push("Admission: typed evidence only; actual branch count must match; child-owner capacity is reserved atomically before launch.");
  lines.push("Concurrency scope: current agent tools wait for completion, so only sidecar children may overlap; primary work remains suspended.");
  lines.push("Runtime view: active and recent sub-agent tool executions are persisted below and mirrored in the runtime widget.");
  lines.push("");
  if (runtime.subAgents.length) {
    lines.push("Persistent runtime sub-agents:");
    for (const item of runtime.subAgents.slice(-8)) {
      lines.push(`- [${item.status}] ${item.title}${item.summary ? ` - ${item.summary}` : ""}`);
    }
    lines.push("");
  }
  const dispatchEvents = runtime.events.filter(item => item.kind === "sidecar_dispatch").slice(-6);
  if (dispatchEvents.length) {
    lines.push("Recent sidecar dispatch decisions:");
    for (const event of dispatchEvents) {
      lines.push(`- ${event.title}${event.summary ? ` - ${event.summary}` : ""}`);
    }
    lines.push("");
  }
  if (agents.length === 0) {
    lines.push("No recorded sub-agent runs yet. Use spawn_agent or parallel_agents for independent branches.");
    lines.push("Runtime limit: process fallback max concurrency is 2; children run in isolated data dirs.");
    return lines;
  }
  for (const agent of agents.slice(-12)) {
    const p = agent.properties || {};
    lines.push(`- ${agent.id} [${String(p.status || "unknown")}] ${String(p.agentType || "agent")} ${String(p.task || "").slice(0, 80)}`);
  }
  return lines;
}

export function renderToolSurfaceLines(): string[] {
  const primary = FRONTEND_FEATURES.filter(feature => feature.primary);
  const secondary = FRONTEND_FEATURES.filter(feature => !feature.primary);
  const runtime = readRuntimeStatus(agentDir());
  const activeTools = runtime.toolRuns.filter(item => item.status === "running" || item.status === "in_progress");
  return [
    ...brandLogoLines(),
    "",
    "Canvast Surface",
    `Runtime mode: ${currentCanvastMode()} (switch with /canvast-mode parity|enhanced)`,
    `Permission mode: ${runtime.permission.mode} (switch with /canvast-permission ask|auto|status)`,
    `Live status: ${runtimeStatusSummary(runtime)}`,
    "Start with /help for the Canvast command map, /canvast-components for component status, and /hotkeys for keyboard controls.",
    "High-impact tools require an auto_orchestration_decision first: file mutation, state-changing shell, web, sub-agent, workflow, package, monitor, and background task controls.",
    "Management panels: /canvast-tasks for todos, /canvast-agents for sub-agents, /canvast-workflow for workflows, /canvast-tools for shell/tool runs, /canvast-sandbox for permission reviews.",
    "Web policy: no default browsing; web_research requires a concrete current/external evidence reason.",
    "Context policy: long, resumed, or multi-session work records compaction, Canvas/session recall, and resume continuity.",
    "Expansion: Ctrl+O expands or collapses long outputs; use mouse or trackpad scroll for transcript history and End to return to latest.",
    "",
    "Active tool and shell runs:",
    ...(activeTools.length
      ? activeTools.slice(-8).map(item => `- [${item.status}] ${item.title}${item.summary ? ` - ${item.summary}` : ""}`)
      : ["- No active shell/tool runs."]),
    "",
    "Primary entries:",
    ...primary.map(feature => `- ${feature.title}: ${feature.command || "(state view)"} - ${feature.detail}`),
    "",
    "All capabilities:",
    ...secondary.map(feature => `- ${feature.title}: ${feature.command || "(state view)"} - ${feature.detail}`),
  ];
}

export function renderFeatureCatalogLines(): string[] {
  const byPlane = new Map<string, typeof FRONTEND_FEATURES>();
  for (const feature of FRONTEND_FEATURES) {
    const bucket = byPlane.get(feature.controlPlane) || [];
    bucket.push(feature);
    byPlane.set(feature.controlPlane, bucket);
  }
  const lines = [
    "Feature Catalog",
    "Use /canvast-feature <id|title> to open the detail surface for any capability.",
  ];
  for (const [plane, features] of Array.from(byPlane.entries()).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push("");
    lines.push(`[${plane}]`);
    for (const feature of features) {
      const tier = feature.enhanced ? "enhanced" : "baseline";
      lines.push(`- ${feature.id}: ${feature.title} (${tier}) ${feature.command || "(state view)"}`);
    }
  }
  return lines;
}

export function renderFeatureDetailLines(rawSelector: string): string[] {
  const selector = rawSelector.trim().toLowerCase();
  const feature = FRONTEND_FEATURES.find(item =>
    item.id.toLowerCase() === selector ||
    item.title.toLowerCase() === selector ||
    item.title.toLowerCase().replace(/\s+/g, "-") === selector,
  );
  if (!feature) {
    return [
      "Feature not found",
      "Usage: /canvast-feature <id|title>",
      "",
      ...FRONTEND_FEATURES.map(item => `- ${item.id}: ${item.title}`),
    ];
  }
  return [
    `${feature.title} (${feature.id})`,
    `Control plane: ${feature.controlPlane}`,
    `Tier: ${feature.enhanced ? "enhanced" : "baseline"}`,
    `Entry: ${feature.command || "state view"}`,
    `Primary: ${feature.primary ? "yes" : "no"}`,
    "",
    feature.detail,
    "",
    "Operational notes:",
    "- Use the listed command/tool when present.",
    "- State-view features are inspected through this panel, Canvas/session state, or the matching product command surface.",
    "- Enhanced features follow the current /canvast-mode setting and can be switched per session or per prompt.",
  ];
}

export function renderContextLines(graph = readGraph()): string[] {
  const decisions = graph.nodes.filter(n => n.type === "decision");
  const plans = graph.nodes.filter(n => n.type === "plan");
  const recall = readContextRecallIndex(agentDir());
  const archive = readContextRecallArchive(agentDir());
  const archiveRecords = recall.storage?.archiveRecords ?? archive.records.length;
  const totalRecords = recall.records.length + archiveRecords;
  const lines = [
    "Context Management",
    `Canvas recall surface: ${graphStats(graph)}`,
    `Recoverable planning state: ${plans.length} plan/task nodes, ${decisions.length} decisions`,
    `Project recall index: hot ${recall.records.length}/${CONTEXT_RECALL_HOT_RECORDS}, archive ${archiveRecords}, total ${totalRecords}.`,
    "History policy: keep a recent window, compact older turns under budget pressure, and keep entry-level recall pointers for compacted source text.",
    "Resume continuity: reload canvas-graph.json, runtime-status.json, context-recall/index.json, and context-recall/archive-index.json before continuing active work.",
    "Original text recall: compacted summaries point back to session entry ids and bounded local excerpts when available; older records move to archive, not a silent sliding-window drop.",
    "",
    ...renderContextRecallLines(recall, 8),
    "",
  ];
  for (const decision of decisions.slice(-6)) {
    lines.push(`- decision ${decision.id}: ${labelNode(decision).slice(0, 88)}`);
  }
  return lines;
}

export function renderSandboxLines(): string[] {
  const config = resolveSandboxConfig();
  const runtime = readRuntimeStatus(agentDir());
  const modeDetail = runtime.permission.mode === "auto"
    ? "Auto mode never prompts; low-risk policy approvals are recorded, high-risk boundaries return structured blocks."
    : "Ask mode may prompt through the TUI when interactive approval is needed.";
  return [
    "Sandbox and permissions",
    `Profile: ${config.profile}`,
    `Permission mode: ${runtime.permission.mode} (source ${runtime.permission.source})`,
    `Permission behavior: ${modeDetail}`,
    `OS sandbox: ${config.useOsSandbox ? "enabled when available" : "disabled"}`,
    `Unattended mode: ${config.unattended ? "approval-required actions return non-interactive results" : "controlled by permission mode"}`,
    `Network in shell sandbox: ${config.network}`,
    `Project root: ${config.projectRoot}`,
    `Writable roots: ${config.writableRoots.join(path.delimiter)}`,
    `Dependency cache: ${config.dependencyCacheRoot}`,
    "",
    "Controls:",
    "- /canvast-permission ask|auto|status",
    "- /sandbox status|ask|auto|read-only|workspace-write|full-access",
    "- sandbox_status: inspect current profile and session/project grants",
    "- sandbox_permission_mode: switch ask/auto from tools or workflows",
    "- sandbox_grant: add explicit once/session/project grants after user intent is clear",
    "- Approval-required actions include protected file reads/writes, outside-workspace writes, and dangerous shell commands.",
    "",
    "Approval review stream:",
    ...(runtime.approvalReviews.length
      ? runtime.approvalReviews.slice(-8).map(review =>
          `- Automatic approval review ${review.decision} (risk: ${review.risk}, authorization: ${review.authorization}): ${review.rationale}`,
        )
      : ["- No approval review records yet."]),
  ];
}

export function renderWorkflowLines(): string[] {
  const runtime = readRuntimeStatus(agentDir());
  return [
    "Workflow orchestration",
    "Use run_workflow for multi-stage delivery with sequential, parallel, or DAG modes.",
    "Use task_create/task_update for visible dependency state.",
    "Keep workflow fanout bounded; current extension concurrency is 4.",
    "Manage from here: /canvast-status shows live workflow state; /canvast-tools shows active step tools; /canvast-sandbox shows permission mode and reviews.",
    "Runtime view: run_workflow executions are persisted below with status, elapsed time, and summaries.",
    "",
    "Persistent runtime workflows:",
    ...(runtime.workflows.length
      ? runtime.workflows.slice(-8).map(item => `- [${item.status}] ${item.title}${item.summary ? ` - ${item.summary}` : ""}`)
      : ["- No workflow runs recorded yet."]),
  ];
}

function requestKindLabel(kind: string): string {
  if (kind === "status") return "status";
  if (kind === "sidecar") return "sidecar";
  if (kind === "interrupt") return "interrupt";
  if (kind === "adjustment") return "adjustment";
  return "primary";
}

function recentRequestLifecycleLines(snapshot: RuntimeStatusSnapshot): string[] {
  const answeredFollowUps = snapshot.requests.filter(item =>
    (item.kind === "sidecar" || item.kind === "status") && item.status === "answered" && item.hasVisibleReply,
  );
  const latestAnswered = [...answeredFollowUps]
    .sort((left, right) => String(left.answeredAt || left.updatedAt).localeCompare(String(right.answeredAt || right.updatedAt)))
    .at(-1);
  const visibleReplyEvent = [...snapshot.events]
    .filter(item => item.kind === "request_visible_reply")
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .at(-1);
  const resumedEvent = [...snapshot.events]
    .filter(item => item.kind === "request_continuation" && item.title === "Primary plan resumed after sidecar")
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .at(-1);

  return [
    "Request lifecycle:",
    `- Follow-ups answered: ${answeredFollowUps.length} | visible replies: ${snapshot.events.filter(item => item.kind === "request_visible_reply").length}`,
    latestAnswered
      ? `- Latest answered: ${requestKindLabel(latestAnswered.kind)} · ${latestAnswered.textSummary.slice(0, 88)}`
      : "- Latest answered: none",
    visibleReplyEvent
      ? `- Visible reply landed: ${visibleReplyEvent.summary || visibleReplyEvent.title}`
      : "- Visible reply landed: none",
    resumedEvent
      ? `- Primary resumed: ${resumedEvent.summary || resumedEvent.title}`
      : "- Primary resumed: not recorded",
  ];
}

export function renderResumeLines(resume: RuntimeResumeSnapshot = readRuntimeStatus(agentDir()).resume): string[] {
  const lines = [
    `Revision: ${resume.revision}`,
    `State: ${resume.state}`,
    `Ready candidates: ${resume.readyCandidateCount}`,
    resume.selectedCandidateId ? `Selected candidate: ${resume.selectedCandidateId}` : "Selected candidate: none",
    "",
  ];
  if (!resume.candidates.length) {
    lines.push("No resumable candidates are available.");
    lines.push("Use /canvast-resume after reload/restart to inspect the shared resume snapshot.");
    return lines;
  }
  for (const candidate of resume.candidates.slice(0, 6)) {
    lines.push(`- ${candidate.id} [${candidate.disposition}] ${candidate.validation.availability}`);
    lines.push(`  request=${candidate.requestId}${candidate.turnId ? ` turn=${candidate.turnId}` : ""}`);
    lines.push(`  ${candidate.summary}`);
    if (candidate.binding?.planNodeId || candidate.binding?.taskNodeId) {
      lines.push(`  bind plan=${candidate.binding.planNodeId || "-"} task=${candidate.binding.taskNodeId || "-"}`);
    }
    if (candidate.validation.issues.length) {
      lines.push(`  issues: ${candidate.validation.issues.join(" | ")}`);
    }
    lines.push(`  actions: ${candidate.availableActions.join(", ")}`);
  }
  lines.push("");
  lines.push("Actions:");
  lines.push("- /canvast-resume");
  lines.push("- App/Desktop action kinds: resume.inspect resume.choose resume.claim resume.rebind resume.retire resume.reconcile");
  return lines;
}

export function renderRuntimeLines(currentSessionId?: string): string[] {
  const snapshot = readRuntimeStatus(agentDir());
  const liveSnapshot = projectRuntimeLiveSnapshot(snapshot, currentSessionId);
  const lines = renderRuntimeStatusLines(liveSnapshot);
  // Keep the newest request outcome adjacent to the panel heading. Besides
  // making follow-up handling immediately legible, this guarantees that a
  // normal terminal viewport can show the status title and its latest visible
  // reply together even when the detailed task/history sections are long.
  const headingIndex = lines.findIndex(line => line === "Runtime Status");
  const insertAt = headingIndex >= 0
    ? headingIndex + 1
    : lines.findIndex(line => line.startsWith("Input queue:"));
  const currentLines = insertAt < 0
    ? [...lines, "", ...recentRequestLifecycleLines(liveSnapshot)]
    : [
    ...lines.slice(0, insertAt),
    "",
    ...recentRequestLifecycleLines(liveSnapshot),
    "",
    ...lines.slice(insertAt),
  ];
  const live = projectRuntimeLive(snapshot, currentSessionId);
  const currentItems = new Set([
    ...live.tasks,
    ...live.plans,
    ...live.subAgents,
    ...live.workflows,
    ...live.toolRuns,
  ]);
  const historyPlanes: Array<[string, RuntimeStatusItem[]]> = [
    ["Tasks", snapshot.tasks],
    ["Plans", snapshot.plans.filter(item => item.id !== "session-runtime")],
    ["Sub-agents", snapshot.subAgents],
    ["Workflows", snapshot.workflows],
    ["Tool runs", snapshot.toolRuns],
  ];
  const historyLines = ["", "History"];
  let historyCount = 0;
  for (const [label, items] of historyPlanes) {
    const history = items.filter(item => !currentItems.has(item));
    if (!history.length) continue;
    historyCount += history.length;
    historyLines.push(`${label}: ${history.length}`);
    for (const item of history.slice(-8)) {
      historyLines.push(`- [${item.status}] ${item.title}${item.summary ? ` — ${item.summary}` : ""}`);
    }
  }
  if (historyCount === 0) historyLines.push("No terminal or archived runtime history.");
  return [...currentLines, ...historyLines];
}
