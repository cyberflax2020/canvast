/**
 * =============================================================================
 * Canvast — Runtime Status Rendering / Canvast source file
 * =============================================================================
 * @file        src/harness/runtime-status-render.ts
 * @brief       Read-only text projections for persisted runtime status.
 * @description Keeps presentation helpers separate from runtime persistence
 *              and aggregate-state mutation.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import {
  isRuntimeInputQueuePending,
  type RuntimeInputQueueItem,
} from "./context-continuity.js";
import type {
  RuntimeItemStatus,
  RuntimeStatusItem,
  RuntimeStatusSnapshot,
} from "./runtime-status.js";

export function isRuntimeItemOpen(status: RuntimeItemStatus): boolean {
  return status === "pending" || status === "in_progress" || status === "running" ||
    status === "blocked" || status === "unknown";
}

function activeItem(items: RuntimeStatusItem[]): RuntimeStatusItem | undefined {
  return items.find(item => item.status === "in_progress" || item.status === "running") ||
    items.find(item => isRuntimeItemOpen(item.status));
}

function pendingInputs(snapshot: RuntimeStatusSnapshot): RuntimeInputQueueItem[] {
  return snapshot.inputQueue.filter(isRuntimeInputQueuePending);
}

export function runtimeStatusSummary(snapshot: RuntimeStatusSnapshot): string {
  const openTasks = snapshot.tasks.filter(item => isRuntimeItemOpen(item.status)).length;
  const runningAgents = snapshot.subAgents.filter(item => item.status === "running" || item.status === "in_progress").length;
  const runningWorkflows = snapshot.workflows.filter(item => item.status === "running" || item.status === "in_progress").length;
  const runningTools = snapshot.toolRuns.filter(item => item.status === "running" || item.status === "in_progress").length;
  const queuedInputs = pendingInputs(snapshot).length;
  const active = activeItem(snapshot.tasks) || activeItem(snapshot.plans) || activeItem(snapshot.workflows);
  const activeText = active ? `${active.status}: ${active.title}` : "idle";
  const thinking = snapshot.model.thinkingLevel ? ` | thinking ${snapshot.model.thinkingLevel}` : "";
  const tokens = snapshot.tokens.totalTokens > 0 ? ` | tokens ${Math.round(snapshot.tokens.totalTokens).toLocaleString()}` : "";
  const context = snapshot.tokens.contextUsedTokens > 0 && snapshot.tokens.contextWindowTokens > 0
    ? ` | ctx ${Math.round(snapshot.tokens.contextUsedTokens).toLocaleString()}/${Math.round(snapshot.tokens.contextWindowTokens).toLocaleString()}`
    : "";
  const queue = queuedInputs > 0 ? ` | input queue ${queuedInputs}` : "";
  const continuity = snapshot.continuity.phase !== "idle"
    ? ` | continuity ${snapshot.continuity.phase}${snapshot.continuity.recoverable ? " (recoverable)" : ""}`
    : "";
  const resume = snapshot.resume.readyCandidateCount > 0 || snapshot.resume.state !== "idle"
    ? ` | resume ${snapshot.resume.state}:${snapshot.resume.readyCandidateCount}`
    : "";
  return `${snapshot.language.activeLocale} | root ${snapshot.rootExecution.state}:${snapshot.rootExecution.reason} | ${activeText} | tasks ${openTasks}/${snapshot.tasks.length} | agents ${runningAgents} | workflows ${runningWorkflows} | tools ${runningTools}${queue}${continuity}${resume} | permission ${snapshot.permission.mode}${thinking}${tokens}${context}`;
}

function formatElapsed(item: RuntimeStatusItem): string {
  if (Number.isFinite(item.elapsedMs)) return ` (${Math.round(Number(item.elapsedMs) / 1000)}s)`;
  if (item.startedAt) {
    const started = Date.parse(item.startedAt);
    if (Number.isFinite(started)) return ` (${Math.max(0, Math.round((Date.now() - started) / 1000))}s)`;
  }
  return "";
}

export function renderRuntimeStatusLines(snapshot: RuntimeStatusSnapshot): string[] {
  const contextLine = snapshot.tokens.contextWindowTokens > 0
    ? `Context: used=${Math.round(snapshot.tokens.contextUsedTokens).toLocaleString()} window=${Math.round(snapshot.tokens.contextWindowTokens).toLocaleString()} remaining=${Math.round(snapshot.tokens.contextRemainingTokens).toLocaleString()} ratio=${Math.round(snapshot.tokens.contextUsageRatio * 100)}%`
    : "Context: unknown";
  const lines = [
    "Runtime Status",
    `Updated: ${snapshot.updatedAt}`,
    `Language: ${snapshot.language.activeLocale} (default ${snapshot.language.defaultLocale}, source ${snapshot.language.source})`,
    `Model: ${snapshot.model.provider || "unknown"}/${snapshot.model.model || "unknown"} thinking=${snapshot.model.thinkingLevel || "unknown"} image_input=${snapshot.model.imageInput}`,
    `Modalities: ${snapshot.model.modalities.length ? snapshot.model.modalities.join(", ") : "unknown"}`,
    `Tokens: total=${Math.round(snapshot.tokens.totalTokens).toLocaleString()} effective=${Math.round(snapshot.tokens.effectiveTokens).toLocaleString()} input=${Math.round(snapshot.tokens.inputTokens).toLocaleString()} output=${Math.round(snapshot.tokens.outputTokens).toLocaleString()} cache_read=${Math.round(snapshot.tokens.cacheReadTokens).toLocaleString()} cache_write=${Math.round(snapshot.tokens.cacheWriteTokens).toLocaleString()} turns=${snapshot.tokens.turnCount} tools=${snapshot.tokens.toolCalls} cost=$${snapshot.tokens.costUsd.toFixed(4)}`,
    contextLine,
    `Permission: mode=${snapshot.permission.mode} source=${snapshot.permission.source} unattended=${snapshot.permission.unattended}`,
    `Root execution: ${snapshot.rootExecution.state} (${snapshot.rootExecution.reason})`,
    `Continuity: ${snapshot.continuity.phase}${snapshot.continuity.recoveryMessage ? ` — ${snapshot.continuity.recoveryMessage}` : ""}`,
    `Resume: ${snapshot.resume.state} (${snapshot.resume.readyCandidateCount} ready candidate${snapshot.resume.readyCandidateCount === 1 ? "" : "s"})`,
    `Summary: ${runtimeStatusSummary(snapshot)}`,
    "",
    `Input queue: ${pendingInputs(snapshot).length}/${snapshot.inputQueue.length} pending`,
  ];
  for (const item of snapshot.inputQueue.slice(-8)) {
    lines.push(`- [${item.status}] ${item.policy}${item.affectsActiveWork ? " affects-active-work" : ""}: ${item.textSummary}`);
  }
  lines.push("", `Tasks: ${snapshot.tasks.filter(item => isRuntimeItemOpen(item.status)).length}/${snapshot.tasks.length} open`);
  for (const item of snapshot.tasks.slice(-8)) {
    lines.push(`- [${item.status}] ${item.title}${formatElapsed(item)}${item.summary ? ` — ${item.summary}` : ""}`);
  }
  lines.push("", `Plans: ${snapshot.plans.filter(item => isRuntimeItemOpen(item.status)).length}/${snapshot.plans.length} open`);
  for (const item of snapshot.plans.slice(-6)) {
    lines.push(`- [${item.status}] ${item.title}${formatElapsed(item)}${item.summary ? ` — ${item.summary}` : ""}`);
  }
  lines.push("", `Sub-agents: ${snapshot.subAgents.filter(item => isRuntimeItemOpen(item.status)).length}/${snapshot.subAgents.length} active`);
  for (const item of snapshot.subAgents.slice(-6)) {
    lines.push(`- [${item.status}] ${item.title}${formatElapsed(item)}${item.summary ? ` — ${item.summary}` : ""}`);
  }
  lines.push("", `Workflows: ${snapshot.workflows.filter(item => isRuntimeItemOpen(item.status)).length}/${snapshot.workflows.length} active`);
  for (const item of snapshot.workflows.slice(-6)) {
    lines.push(`- [${item.status}] ${item.title}${formatElapsed(item)}${item.summary ? ` — ${item.summary}` : ""}`);
  }
  lines.push("", `Tool runs: ${snapshot.toolRuns.filter(item => item.status === "running" || item.status === "in_progress").length}/${snapshot.toolRuns.length} running`);
  for (const item of snapshot.toolRuns.slice(-6)) {
    lines.push(`- [${item.status}] ${item.title}${formatElapsed(item)}${item.summary ? ` — ${item.summary}` : ""}`);
  }
  lines.push("", `Attachments: ${snapshot.attachments.length}`);
  for (const attachment of snapshot.attachments.slice(-8)) {
    lines.push(`- [${attachment.kind}/${attachment.disposition}] ${attachment.placeholder} — ${attachment.summary}${attachment.mimeType ? ` (${attachment.mimeType})` : ""}`);
  }
  lines.push("", `Approval reviews: ${snapshot.approvalReviews.length}`);
  for (const review of snapshot.approvalReviews.slice(-8)) {
    lines.push(`- Automatic approval review ${review.decision} (risk: ${review.risk}, authorization: ${review.authorization}) ${review.tool}: ${review.rationale}`);
    if (review.inputSummary) lines.push(`  input: ${review.inputSummary}`);
  }
  lines.push("", `Events: ${snapshot.events.length}`);
  for (const event of snapshot.events.slice(-8)) {
    lines.push(`- [${event.kind}] ${event.title}${event.summary ? ` — ${event.summary}` : ""}`);
  }
  return lines;
}
