/**
 * =============================================================================
 * Canvast — Canvast Tui / Canvast 源文件
 * =============================================================================
 * @file        extensions/canvast-tui.ts
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";

import { FRONTEND_FEATURES } from "../src/frontend/feature-registry.js";
import { registerRuntimeRequestDesktopActionHandler } from "../src/desktop-action/live-handlers.js";
import {
  brandLogoLines,
  componentStatusLines,
  graphStats,
  panelComponent,
  renderAgentLines,
  renderCanvasLines,
  renderContextLines,
  renderFeatureCatalogLines,
  renderFeatureDetailLines,
  renderHelpLines,
  renderResumeLines,
  renderRuntimeLines,
  renderSandboxLines,
  renderTaskTreeLines,
  renderToolSurfaceLines,
  renderWorkflowLines,
  truncate,
  widthOf,
} from "../src/tui/canvast-tui-panels.js";
import { publishCapturePanel, publishStartupReady } from "../src/tui/capture-handshake.js";
import { setRuntimeWidget } from "../src/tui/canvast-runtime-widget.js";
import { RuntimeRequestCoordinator } from "../src/tui/runtime-request-coordinator.js";
import { installCanvastAutomaticModeShortcut } from "../src/tui/canvast-automatic-mode.js";
import { registerRuntimeBatchDecisionConsumer, runtimeBatchEventScope } from "../src/harness/runtime-batch-bridge.js";
import { parseRuntimeRequestControlCommand } from "../src/tui/runtime-current-request.js";
import { handleCanvastPermissionCommand } from "../src/tui/canvast-permission-command.js";
import { registerCanvastProjectCommands } from "../src/tui/canvast-project-command.js";
import { registerCanvastResumeCommand } from "../src/tui/canvast-resume-command.js";
import {
  CANVAST_LONG_TEXT_THRESHOLD,
  expandEditorPlaceholders,
  installCanvastEditor,
  storeLongTextPlaceholder,
} from "../src/tui/canvast-editor.js";
import { DEFAULT_CANVAST_MODE, readCanvastModeState } from "../src/harness/canvast-mode.js";
import { appendCanvastIdentityPrompt, enforceCanvastInternalInfoBoundary } from "../src/harness/product-identity.js";
import {
  acknowledgeRuntimePolicyOutcome,
  clearRuntimePolicyOutcomes,
  peekRuntimePolicyOutcome,
  recordRuntimePolicyOutcome,
  registerRuntimePolicyOutcomeConsumer,
  runtimePolicyOutcomeFromUnknown,
  runtimePolicyOutcomeScope,
} from "../src/harness/runtime-policy-outcome-bridge.js";
import { recordContextRecall, recordSessionEntryRecall, syncContextRecallFromSession } from "../src/harness/context-recall.js";
import {
  recordRuntimeAttachment,
  recordRuntimeEvent,
  readRuntimeStatus,
  runtimeStatusSummary,
  summarizeRuntimeInput,
  updateRuntimeModel,
  updateRuntimeTokens,
  updateRuntimeLanguage,
  upsertRuntimeStatusItem,
} from "../src/harness/runtime-status.js";

const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
interface TuiEntryData { title: string; lines: string[]; createdAt: string; }

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME || "/tmp", ".canvast");
}

function currentCanvastMode(): string {
  return readCanvastModeState(agentDir())?.mode || process.env.CANVAST_MODE || DEFAULT_CANVAST_MODE;
}

function asNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toolRunId(event: any): string {
  return `tool-${String(event?.toolCallId || event?.id || event?.toolName || "unknown")}`;
}

function orchestrationItemId(prefix: string, event: any): string {
  return `${prefix}-${String(event?.toolCallId || event?.id || Date.now())}`;
}

function summarizeToolArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  const command = typeof record.command === "string" ? record.command : "";
  const query = typeof record.query === "string" ? record.query : "";
  const prompt = typeof record.prompt === "string" ? record.prompt : "";
  const subject = typeof record.subject === "string" ? record.subject : "";
  return (command || query || prompt || subject || JSON.stringify(record)).slice(0, 180);
}

function currentRequestTitle(prompt: string): string {
  const summary = summarizeRuntimeInput(prompt, 72).trim();
  return summary ? `Request: ${summary}` : "Current user request";
}

function messageStopReason(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const record = message as Record<string, any>;
  return String(record.stopReason || record.stop_reason || record.finishReason || record.finish_reason || "");
}

function isAgentEndAborted(event: any): boolean {
  if (event?.aborted === true || event?.cancelled === true || event?.interrupted === true) return true;
  const directReason = String(event?.stopReason || event?.stop_reason || event?.reason || "");
  if (directReason === "aborted" || directReason === "cancelled" || directReason === "interrupted") return true;
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  return messages.some((item: any) => {
    const message = item?.message || item;
    const reason = messageStopReason(message);
    return reason === "aborted" || reason === "cancelled" || reason === "interrupted";
  });
}

function workflowTitle(args: any): string {
  return String(args?.name || args?.workflow_name || "Workflow");
}

function agentTitle(toolName: string, args: any): string {
  if (toolName === "parallel_agents") {
    const count = Array.isArray(args?.tasks) ? args.tasks.length : 0;
    return `Parallel agents${count ? ` (${count})` : ""}`;
  }
  return "Sub-agent";
}

function currentThinkingLevel(pi: ExtensionAPI, ctx?: any): string {
  if (typeof (pi as any).getThinkingLevel === "function") {
    try { return String((pi as any).getThinkingLevel()); } catch { /* best effort */ }
  }
  return String(ctx?.thinkingLevel || "");
}

function availableThinkingLevels(model: any): string[] {
  const map = model?.thinkingLevelMap;
  if (map && typeof map === "object") {
    const levels = Object.entries(map)
      .filter(([, value]) => value !== null)
      .map(([level]) => level);
    if (levels.length) return levels;
  }
  return [...THINKING_LEVELS];
}

function syncRuntimeModel(pi: ExtensionAPI, ctx?: any, thinkingOverride?: string): void {
  const model = ctx?.model;
  const modalities = Array.isArray(model?.input) ? model.input.map((item: unknown) => String(item)) : [];
  updateRuntimeModel(agentDir(), {
    provider: String(model?.provider || process.env.CANVAST_PROVIDER || process.env.CANVAST_DEFAULT_PROVIDER || ""),
    model: String(model?.id || process.env.CANVAST_MODEL || process.env.CANVAST_DEFAULT_MODEL || ""),
    thinkingLevel: thinkingOverride || currentThinkingLevel(pi, ctx),
    availableThinkingLevels: availableThinkingLevels(model),
    modalities,
    imageInput: modalities.includes("image") ? "supported" : modalities.length ? "unsupported" : "unknown",
  });
}

function usageFromMessage(message: any): any | undefined {
  return message && typeof message === "object" && message.usage && typeof message.usage === "object"
    ? message.usage
    : undefined;
}

function syncRuntimeTokensFromContext(ctx?: any): void {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let totalTokens = 0;
  let effectiveTokens = 0;
  let costUsd = 0;
  let latestUsage: any | undefined;
  const branch = typeof ctx?.sessionManager?.getBranch === "function" ? ctx.sessionManager.getBranch() : [];
  for (const entry of Array.isArray(branch) ? branch : []) {
    const usage = entry?.type === "message"
      ? usageFromMessage(entry.message)
      : (entry?.type === "compaction" || entry?.type === "branch_summary") ? entry.usage : undefined;
    if (!usage) continue;
    const input = asNumber(usage.input);
    const output = asNumber(usage.output);
    const cacheRead = asNumber(usage.cacheRead);
    const cacheWrite = asNumber(usage.cacheWrite);
    inputTokens += input;
    outputTokens += output;
    cacheReadTokens += cacheRead;
    cacheWriteTokens += cacheWrite;
    totalTokens += asNumber(usage.totalTokens) || input + output + cacheRead + cacheWrite;
    effectiveTokens += input + output + cacheWrite;
    costUsd += asNumber(usage.cost?.total);
    latestUsage = usage;
  }

  const contextUsage = typeof ctx?.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
  const contextWindowTokens = asNumber(contextUsage?.contextWindow) || asNumber(ctx?.model?.contextWindow);
  const contextUsedTokens = asNumber(contextUsage?.tokens) || (latestUsage ? asNumber(latestUsage.totalTokens) : 0);
  updateRuntimeTokens(agentDir(), {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    effectiveTokens,
    contextWindowTokens,
    contextUsedTokens,
    contextRemainingTokens: contextWindowTokens > 0 ? Math.max(0, contextWindowTokens - contextUsedTokens) : 0,
    contextUsageRatio: contextWindowTokens > 0 ? Math.min(1, contextUsedTokens / contextWindowTokens) : 0,
    costUsd,
  });
}

function refreshRuntimeLanguageFromContext(ctx: ExtensionCommandContext, text?: string): void {
  const explicitLocale = process.env.CANVAST_RUNTIME_LOCALE || process.env.CANVAST_UI_LOCALE;
  const hasSignal = Boolean(explicitLocale || text);
  if (!hasSignal && fs.existsSync(path.join(agentDir(), "runtime-status.json"))) return;
  updateRuntimeLanguage(agentDir(), {
    explicitLocale,
    userInput: text,
    modelOutput: undefined,
  });
}

function sessionPointer(ctx?: any): { sessionFile?: string; sessionId?: string } {
  return {
    sessionFile: typeof ctx?.sessionManager?.getSessionFile === "function" ? ctx.sessionManager.getSessionFile() : undefined,
    sessionId: typeof ctx?.sessionManager?.getSessionId === "function" ? ctx.sessionManager.getSessionId() : undefined,
  };
}

function syncRecallFromContext(ctx?: any): void {
  try {
    syncContextRecallFromSession(agentDir(), ctx?.sessionManager);
  } catch {
    // Recall is a visibility layer; agent execution should continue if indexing fails.
  }
}

function imageSizeBytes(image: any): number {
  const data = typeof image?.data === "string" ? image.data : "";
  return Math.max(0, Math.floor(data.length * 0.75));
}

function imagePlaceholder(index: number, image: any): string {
  const mime = String(image?.mimeType || "image");
  return `[canvast:image:${index}:${mime}]`;
}

function transformInputWithPlaceholders(event: any, ctx?: any): { action: "continue" } | { action: "transform"; text: string; images?: any[] } {
  const inputImages = Array.isArray(event?.images) ? event.images : [];
  const text = String(event?.text || "");
  const expanded = expandEditorPlaceholders(agentDir(), text, [], ctx);
  let transformedText = expanded.text;
  let transformedImages = expanded.images;
  let changed = expanded.changed;

  if (!expanded.expandedLongText && transformedText.length >= CANVAST_LONG_TEXT_THRESHOLD) {
    const placeholder = storeLongTextPlaceholder(agentDir(), transformedText, "input");
    transformedText = `${placeholder}\n\n<canvast-long-text placeholder="${placeholder}" chars="${transformedText.length}">\n${transformedText}\n</canvast-long-text>`;
    changed = true;
  }

  if (inputImages.length > 0) {
    const supportsImages = Array.isArray(ctx?.model?.input) ? ctx.model.input.includes("image") : readRuntimeStatus(agentDir()).model.imageInput === "supported";
    const placeholders = inputImages.map((image: any, index: number) => {
      const placeholder = imagePlaceholder(index + 1, image);
      recordRuntimeAttachment(agentDir(), {
        kind: "image",
        disposition: supportsImages ? "placeholder" : "omitted",
        placeholder,
        summary: supportsImages
          ? `Image attached and forwarded to the active model.`
          : `Image attached but the active model does not advertise image input support.`,
        sizeBytes: imageSizeBytes(image),
        mimeType: String(image?.mimeType || ""),
        source: "input",
      });
      return placeholder;
    });
    if (supportsImages) {
      transformedText = `${transformedText}${transformedText ? "\n\n" : ""}Attachments: ${placeholders.join(" ")}`;
      transformedImages = [...transformedImages, ...inputImages];
    } else {
      transformedText = [
        transformedText,
        "",
        `Canvast received ${inputImages.length} image attachment(s), but the active model does not advertise image input support. Re-run with an image-capable model or describe the image in text.`,
        `Omitted attachments: ${placeholders.join(" ")}`,
      ].filter(Boolean).join("\n");
    }
    changed = true;
  }

  return changed ? { action: "transform", text: transformedText, images: transformedImages } : { action: "continue" };
}

function makeEntry(title: string, lines: string[]): TuiEntryData {
  return { title, lines, createdAt: new Date().toISOString() };
}

function appendPanel(pi: ExtensionAPI, title: string, lines: string[]): void {
  pi.appendEntry<TuiEntryData>("canvast-panel", makeEntry(title, lines));
  publishCapturePanel(title, lines);
}

function setCanvastHeader(ctx: ExtensionCommandContext): void {
  if (ctx.mode !== "tui") return;
  ctx.ui.setTitle("Canvast");
  ctx.ui.setHeader((_tui, theme) => ({
    invalidate() {},
    render(width: number): string[] {
      const graph = graphStats();
      const runtime = runtimeStatusSummary(readRuntimeStatus(agentDir()));
      const title = theme.fg("accent", theme.bold("Canvast"));
      const subtitle = theme.fg("muted", `${currentCanvastMode()} | Canvas + task tree + sub-agents + workflow`);
      return [
        ...brandLogoLines().map(line => truncate(theme.fg("accent", line), width)),
        truncate(`${title}  ${subtitle}`, width),
        truncate(theme.fg("dim", graph), width),
      ];
    },
  }));
}

function setCanvastFooter(ctx: ExtensionCommandContext): void {
  if (ctx.mode !== "tui") return;
  ctx.ui.setFooter((_tui, theme, footerData) => ({
    invalidate() {},
    render(width: number): string[] {
      const snapshot = readRuntimeStatus(agentDir());
      const left = theme.fg("dim", `Canvast · Language: ${snapshot.language.activeLocale}`);
      const branch = footerData.getGitBranch();
      const right = theme.fg("dim", `${currentCanvastMode()} · ${snapshot.permission.mode} · /help · /canvast-status${branch ? ` · ${branch}` : ""}`);
      const rightWidth = widthOf(right);
      const leftWidth = Math.max(0, width - rightWidth - 1);
      const visibleLeft = truncate(left, leftWidth);
      const pad = " ".repeat(Math.max(1, width - widthOf(visibleLeft) - rightWidth));
      return [truncate(visibleLeft + pad + right, width)];
    },
  }));
}

function installRuntimeChrome(ctx: ExtensionCommandContext): void {
  setCanvastHeader(ctx);
  setCanvastFooter(ctx);
  setRuntimeWidget(ctx);
  installCanvastEditor(ctx, agentDir());
  ctx.ui.setWorkingMessage("Canvast is coordinating tools...");
  ctx.ui.setHiddenThinkingLabel("Canvast reasoning summary");
  ctx.ui.setStatus("canvast", `Canvast ${currentCanvastMode()} | ${runtimeStatusSummary(readRuntimeStatus(agentDir()))}`);
  publishStartupReady(
    currentCanvastMode(),
    typeof ctx.sessionManager?.getSessionId === "function" ? ctx.sessionManager.getSessionId() : undefined,
    agentDir(),
  );
}

function startRuntimeSession(pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
  refreshRuntimeLanguageFromContext(ctx);
  syncRuntimeModel(pi, ctx);
  syncRuntimeTokensFromContext(ctx);
  syncRecallFromContext(ctx);
  const now = new Date().toISOString();
  upsertRuntimeStatusItem(agentDir(), {
    plane: "plans",
    item: {
      id: "session-runtime",
      title: "TUI runtime session",
      status: "running",
      summary: `Canvast ${currentCanvastMode()} | ${graphStats()}`,
      startedAt: now,
    },
  });
  installRuntimeChrome(ctx);
  const runtime = readRuntimeStatus(agentDir());
  const autoVisibleResume = runtime.resume.candidates.some(candidate =>
    candidate.disposition !== "retired" && candidate.disposition !== "completed" &&
    (candidate.validation.availability === "ready" ||
      candidate.disposition === "claimed" || candidate.disposition === "running"),
  );
  if (autoVisibleResume) appendPanel(pi, "Runtime Resume", renderResumeLines());
}

export default function (pi: ExtensionAPI) {
  const policyOutcomeScope = runtimePolicyOutcomeScope(pi);
  if (policyOutcomeScope) registerRuntimePolicyOutcomeConsumer(pi, (toolCallId, outcome) =>
    recordRuntimePolicyOutcome(policyOutcomeScope, toolCallId, outcome));
  const requests = new RuntimeRequestCoordinator(pi, {
    agentDir,
    projectId: () => process.env.CANVAST_PROJECT_ROOT || process.cwd(),
  });
  const batchScope = runtimeBatchEventScope(pi);
  if (batchScope) {
    registerRuntimeBatchDecisionConsumer(batchScope, {
      applyDecision: decision => requests.applyBatchDecision(decision),
      safeCheckpoint: checkpoint => requests.onSafeCheckpoint(checkpoint),
    });
  }
  const forceCaptureExpanded = process.env.CANVAST_TUI_CAPTURE_EXPANDED === "1";
  let disposeAutomaticModeShortcut: (() => void) | undefined;
  registerRuntimeRequestDesktopActionHandler(pi, requests, agentDir);
  pi.on("message_end", async (event: any) => {
    const guarded = enforceCanvastInternalInfoBoundary(event?.message);
    return guarded.redacted ? { message: guarded.message } : undefined;
  });

  pi.registerEntryRenderer<TuiEntryData>("canvast-panel", (entry, { expanded }, theme: Theme) => {
    const data = entry.data ?? makeEntry("Canvast", ["No data"]);
    return panelComponent(
      data.title,
      [...data.lines, theme.fg("dim", data.createdAt)],
      theme,
      forceCaptureExpanded || expanded,
    );
  });

  pi.registerMessageRenderer<TuiEntryData>("canvast-panel", (message, { expanded, outputPad }, theme: Theme) => {
    const data = (message.details as TuiEntryData | undefined) ?? makeEntry("Canvast", [String(message.content || "")]);
    void outputPad;
    return panelComponent(data.title, data.lines, theme, forceCaptureExpanded || expanded);
  });

  pi.on("session_start", async (event, ctx) => {
    if (policyOutcomeScope) clearRuntimePolicyOutcomes(policyOutcomeScope);
    disposeAutomaticModeShortcut?.();
    disposeAutomaticModeShortcut = undefined;
    if (ctx.mode !== "tui") return;
    const tuiCtx = ctx as ExtensionCommandContext;
    disposeAutomaticModeShortcut = installCanvastAutomaticModeShortcut(pi, ctx, agentDir());
    requests.onSessionStart(event, ctx);
    startRuntimeSession(pi, tuiCtx);
  });

  pi.on("model_select", async (_event: any, ctx: any) => {
    syncRuntimeModel(pi, ctx);
    syncRuntimeTokensFromContext(ctx);
    ctx?.ui?.setStatus?.("canvast", runtimeStatusSummary(readRuntimeStatus(agentDir())));
  });

  pi.on("thinking_level_select", async (event: any, ctx: any) => {
    syncRuntimeModel(pi, ctx, String(event?.level || ""));
    ctx?.ui?.setStatus?.("canvast", runtimeStatusSummary(readRuntimeStatus(agentDir())));
  });

  pi.on("input", async (event: any, ctx: any) => {
    refreshRuntimeLanguageFromContext(ctx as ExtensionCommandContext, String(event?.text || ""));
    syncRuntimeModel(pi, ctx);
    const transformed = transformInputWithPlaceholders(event, ctx);
    const routed = await requests.handleInput(event, ctx, transformed);
    ctx?.ui?.setStatus?.("canvast", runtimeStatusSummary(readRuntimeStatus(agentDir())));
    return routed;
  });

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    const prompt = String(event?.prompt || "");
    refreshRuntimeLanguageFromContext(ctx as ExtensionCommandContext, prompt);
    syncRuntimeModel(pi, ctx);
    syncRuntimeTokensFromContext(ctx);
    const request = requests.beginRequest(prompt, ctx);
    recordContextRecall(agentDir(), {
      kind: "turn",
      source: "input",
      title: "User request",
      text: prompt,
      pointer: sessionPointer(ctx),
      tags: ["turn", "user-request"],
    });
    syncRecallFromContext(ctx);
    const now = new Date().toISOString();
    if (request.replaceCurrent) {
      upsertRuntimeStatusItem(agentDir(), {
        plane: "tasks",
        item: {
          id: "current-user-request",
          title: currentRequestTitle(prompt),
          status: "in_progress",
          summary: summarizeRuntimeInput(prompt, 180),
          startedAt: now,
        },
      });
    }
    ctx?.ui?.setStatus?.("canvast", runtimeStatusSummary(readRuntimeStatus(agentDir())));
    return { systemPrompt: appendCanvastIdentityPrompt(event?.systemPrompt || ctx?.getSystemPrompt?.() || "") };
  });

  pi.on("turn_end", async (event: any, ctx: any) => {
    syncRuntimeTokensFromContext(ctx);
    syncRecallFromContext(ctx);
    ctx?.ui?.setStatus?.("canvast", runtimeStatusSummary(readRuntimeStatus(agentDir())));
  });

  pi.on("session_shutdown", async () => {
    if (policyOutcomeScope) clearRuntimePolicyOutcomes(policyOutcomeScope);
    disposeAutomaticModeShortcut?.();
    disposeAutomaticModeShortcut = undefined;
  });

  pi.on("turn_start", async (_event: any, ctx: any) => {
    requests.onTurnStart();
    ctx?.ui?.setStatus?.("canvast", runtimeStatusSummary(readRuntimeStatus(agentDir())));
  });

  pi.on("context", async (event: any) => {
    return { messages: requests.onContext(Array.isArray(event?.messages) ? event.messages : []) };
  });

  pi.on("message_start", async (event: any, ctx: any) => {
    requests.onMessageStart(event?.message);
    ctx?.ui?.setStatus?.("canvast", runtimeStatusSummary(readRuntimeStatus(agentDir())));
  });

  pi.on("message_end", async (event: any, ctx: any) => {
    requests.onMessageEnd(event?.message);
    syncRecallFromContext(ctx);
  });

  pi.on("session_before_compact", async (event: any, ctx: any) => {
    requests.beforeCompaction(event, ctx);
    const pointer = sessionPointer(ctx);
    const entries = Array.isArray(event?.branchEntries) ? event.branchEntries : [];
    const sourceEntryIds = entries.map((entry: any) => String(entry?.id || entry?.type || "")).filter(Boolean);
    const sourceTimestamp = entries
      .map((entry: any) => typeof entry?.timestamp === "string" ? entry.timestamp : "")
      .find(Boolean);
    const sourceWindowIdentity = [
      pointer.sessionId || pointer.sessionFile || "unknown-session",
      String(event?.reason || "unknown"),
      ...sourceEntryIds,
    ].join("\n");
    for (const entry of entries) recordSessionEntryRecall(agentDir(), entry, pointer);
    recordContextRecall(agentDir(), {
      kind: "compaction",
      source: "compaction",
      title: "Compaction source window",
      text: sourceEntryIds.join("\n"),
      timestamp: sourceTimestamp || "1970-01-01T00:00:00.000Z",
      identityKey: sourceWindowIdentity,
      pointer,
      tags: ["compaction", String(event?.reason || "unknown")],
      maxInlineChars: 0,
    });
  });

  pi.on("session_compact", async (event: any, ctx: any) => {
    requests.afterCompaction(event);
    recordSessionEntryRecall(agentDir(), event?.compactionEntry, sessionPointer(ctx));
    syncRecallFromContext(ctx);
    recordRuntimeEvent(agentDir(), {
      kind: "compaction",
      title: "Context compaction completed; active work preserved",
      summary: "Session compacted without retiring current request, plan, sub-agent, workflow, or tool-run state.",
      source: "session_compact",
    });
    ctx?.ui?.setStatus?.("canvast", `Context compacted | ${runtimeStatusSummary(readRuntimeStatus(agentDir()))}`);
  });

  pi.on("session_tree", async (event: any, ctx: any) => {
    if (event?.summaryEntry) recordSessionEntryRecall(agentDir(), event.summaryEntry, sessionPointer(ctx));
    syncRecallFromContext(ctx);
  });

  pi.on("tool_execution_start", async (event: any, ctx: any) => {
    const now = new Date().toISOString();
    const toolName = String(event?.toolName || "tool");
    const args = event?.args || {};
    upsertRuntimeStatusItem(agentDir(), {
      plane: "toolRuns",
      item: {
        id: toolRunId(event),
        title: toolName,
        status: "running",
        summary: summarizeToolArgs(args),
        startedAt: now,
      },
    });
    if (toolName === "spawn_agent" || toolName === "parallel_agents") {
      upsertRuntimeStatusItem(agentDir(), {
        plane: "subAgents",
        item: {
          id: orchestrationItemId("agent", event),
          title: agentTitle(toolName, args),
          status: "running",
          summary: summarizeToolArgs(args),
          startedAt: now,
        },
      });
    }
    if (toolName === "run_workflow") {
      upsertRuntimeStatusItem(agentDir(), {
        plane: "workflows",
        item: {
          id: orchestrationItemId("workflow", event),
          title: workflowTitle(args),
          status: "running",
          summary: summarizeToolArgs(args),
          startedAt: now,
        },
      });
    }
    syncRuntimeTokensFromContext(ctx);
    ctx?.ui?.setStatus?.("canvast", runtimeStatusSummary(readRuntimeStatus(agentDir())));
  });

  pi.on("tool_execution_end", async (event: any, ctx: any) => {
    const policyOutcome = (policyOutcomeScope && peekRuntimePolicyOutcome(policyOutcomeScope, event?.toolCallId)) ||
      runtimePolicyOutcomeFromUnknown(event?.result?.policyOutcome);
    requests.onToolExecutionEnd(event);
    const completedAt = new Date().toISOString();
    const toolName = String(event?.toolName || "tool");
    const existing = readRuntimeStatus(agentDir()).toolRuns.find(item => item.id === toolRunId(event));
    const elapsedMs = existing?.startedAt ? Math.max(0, Date.parse(completedAt) - Date.parse(existing.startedAt)) : undefined;
    upsertRuntimeStatusItem(agentDir(), {
      plane: "toolRuns",
      item: {
        id: toolRunId(event),
        title: String(event?.toolName || existing?.title || "tool"),
        status: event?.isError ? "failed" : "completed",
        summary: existing?.summary,
        startedAt: existing?.startedAt,
        completedAt,
        elapsedMs,
        required: existing?.required,
        rootRequestId: existing?.rootRequestId,
        sessionId: existing?.sessionId,
        policyOutcome: policyOutcome || existing?.policyOutcome,
      },
    });
    if (policyOutcomeScope) acknowledgeRuntimePolicyOutcome(policyOutcomeScope, event?.toolCallId);
    if (toolName === "spawn_agent" || toolName === "parallel_agents") {
      const id = orchestrationItemId("agent", event);
      const existingAgent = readRuntimeStatus(agentDir()).subAgents.find(item => item.id === id);
      const agentElapsedMs = existingAgent?.startedAt ? Math.max(0, Date.parse(completedAt) - Date.parse(existingAgent.startedAt)) : undefined;
      upsertRuntimeStatusItem(agentDir(), {
        plane: "subAgents",
        item: {
          id,
          title: existingAgent?.title || agentTitle(toolName, event?.args || {}),
          status: event?.isError ? "failed" : "completed",
          summary: existingAgent?.summary || summarizeToolArgs(event?.args),
          startedAt: existingAgent?.startedAt,
          completedAt,
          elapsedMs: agentElapsedMs,
        },
      });
    }
    if (toolName === "run_workflow") {
      const id = orchestrationItemId("workflow", event);
      const existingWorkflow = readRuntimeStatus(agentDir()).workflows.find(item => item.id === id);
      const workflowElapsedMs = existingWorkflow?.startedAt ? Math.max(0, Date.parse(completedAt) - Date.parse(existingWorkflow.startedAt)) : undefined;
      upsertRuntimeStatusItem(agentDir(), {
        plane: "workflows",
        item: {
          id,
          title: existingWorkflow?.title || workflowTitle(event?.args || {}),
          status: event?.isError ? "failed" : "completed",
          summary: existingWorkflow?.summary || summarizeToolArgs(event?.args),
          startedAt: existingWorkflow?.startedAt,
          completedAt,
          elapsedMs: workflowElapsedMs,
        },
      });
    }
    syncRuntimeTokensFromContext(ctx);
    requests.onSafeCheckpoint(event?.isError ? "on_tool_error" : "on_tool_success");
    ctx?.ui?.setStatus?.("canvast", runtimeStatusSummary(readRuntimeStatus(agentDir())));
  });

  pi.on("agent_end", async (event: any, ctx: any) => {
    syncRuntimeTokensFromContext(ctx);
    syncRecallFromContext(ctx);
    const aborted = isAgentEndAborted(event);
    requests.onContinuationRunEnd(event);
    requests.onAgentEnd(event, ctx);
    if (aborted) {
      const completedAt = new Date().toISOString();
      recordRuntimeEvent(agentDir(), {
        kind: "agent_run",
        title: "Agent run interrupted",
        summary: "Current request marked aborted instead of completed.",
        source: "agent_end",
        timestamp: completedAt,
      });
    }
    ctx?.ui?.setStatus?.("canvast", runtimeStatusSummary(readRuntimeStatus(agentDir())));
  });

  pi.on("agent_settled", async (_event: any, ctx: any) => {
    requests.onAgentSettled();
    syncRuntimeTokensFromContext(ctx);
    syncRecallFromContext(ctx);
    ctx?.ui?.setStatus?.("canvast", runtimeStatusSummary(readRuntimeStatus(agentDir())));
  });

  pi.registerCommand("canvast", {
    description: "Open Canvast TUI command surface / 打开 Canvast TUI 命令入口",
    handler: async (_args, ctx) => {
      refreshRuntimeLanguageFromContext(ctx);
      syncRuntimeModel(pi, ctx);
      syncRuntimeTokensFromContext(ctx);
      setCanvastHeader(ctx);
      setCanvastFooter(ctx);
      setRuntimeWidget(ctx);
      installCanvastEditor(ctx, agentDir());
      appendPanel(pi, "Canvast Surface", renderToolSurfaceLines());
      ctx.ui.notify("Canvast surface opened", "info");
    },
  });

  pi.registerCommand("canvast-request-control", {
    description: "Route typed concurrent input: sidecar|status|pause|redirect|task_adjustment <request>.",
    handler: async (args, ctx) => {
      const control = parseRuntimeRequestControlCommand(String(args || ""));
      if (!control) {
        ctx.ui.notify(
          "Usage: /canvast-request-control sidecar|status|pause|redirect|task_adjustment <request>",
          "warning",
        );
        return;
      }
      await requests.dispatchControlledRequest(control.policy, control.text);
      ctx.ui.setStatus("canvast", runtimeStatusSummary(readRuntimeStatus(agentDir())));
    },
  });

  registerCanvastResumeCommand(pi, requests, {
    agentDir,
    appendPanel: (title, lines) => appendPanel(pi, title, lines),
  });
  registerCanvastProjectCommands(pi, { appendPanel: (title, lines) => appendPanel(pi, title, lines) });

  async function newSessionCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
    requests.resetSession(ctx);
    startRuntimeSession(pi, ctx);
    appendPanel(pi, "New Runtime Session", [
      "New runtime session view started.",
      "Cleared stale visible runtime state: pending input queue, current request, running tool/sub-agent/workflow markers.",
      "Preserved project memory: Canvas graph, context-recall hot index, archive index, original source pointers, and storage lifecycle metadata.",
      `Status: ${runtimeStatusSummary(readRuntimeStatus(agentDir()))}`,
    ]);
    ctx.ui.notify("Canvast runtime session reset; project memory preserved", "info");
  }

  async function restartUiCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
    requests.restartProject();
    refreshRuntimeLanguageFromContext(ctx);
    syncRuntimeModel(pi, ctx);
    syncRuntimeTokensFromContext(ctx);
    syncRecallFromContext(ctx);
    installRuntimeChrome(ctx);
    appendPanel(pi, "Canvast Restart", [
      "Canvast TUI chrome refreshed.",
      "Reinstalled header, footer, runtime widget, and editor surface.",
      "Synchronized model, token, permission, and context-recall status without clearing project memory.",
      `Status: ${runtimeStatusSummary(readRuntimeStatus(agentDir()))}`,
    ]);
    ctx.ui.notify("Canvast TUI restarted", "info");
  }

  pi.registerCommand("canvast-new", {
    description: "Start a clean Canvast runtime session view while preserving Canvas and recall archives.",
    handler: newSessionCommand,
  });

  pi.registerCommand("restart", {
    description: "Reinitialize the Canvast project UI/runtime state without clearing project memory.",
    handler: restartUiCommand,
  });

  pi.registerCommand("canvast-restart", {
    description: "Reinitialize the Canvast project UI/runtime state without clearing project memory.",
    handler: restartUiCommand,
  });

  pi.registerCommand("help", {
    description: "Open Canvast help and adapted command map / 打开 Canvast 帮助与命令适配说明",
    handler: async (_args, ctx) => {
      setCanvastHeader(ctx);
      setCanvastFooter(ctx);
      appendPanel(pi, "Canvast Help", renderHelpLines());
      ctx.ui.setStatus("canvast", "Canvast help visible");
    },
  });

  pi.registerCommand("canvast-help", {
    description: "Open Canvast help and adapted command map / 打开 Canvast 帮助与命令适配说明",
    handler: async (_args, ctx) => {
      setCanvastHeader(ctx);
      setCanvastFooter(ctx);
      appendPanel(pi, "Canvast Help", renderHelpLines());
      ctx.ui.setStatus("canvast", "Canvast help visible");
    },
  });

  pi.registerCommand("canvast-components", {
    description: "Show bundled component status and confirmed update policy / 显示内置组件状态与确认更新策略",
    handler: async (_args, ctx) => {
      appendPanel(pi, "Component Pack", componentStatusLines());
      ctx.ui.setStatus("canvast", "Component pack visible");
    },
  });

  pi.registerCommand("canvast-features", {
    description: "Show all Canvast feature entries grouped by control plane / 按控制面显示全部功能入口",
    handler: async (_args, ctx) => {
      appendPanel(pi, "Feature Catalog", renderFeatureCatalogLines());
      ctx.ui.setStatus("canvast", `${FRONTEND_FEATURES.length} feature entries visible`);
    },
  });

  pi.registerCommand("canvast-feature", {
    description: "Open one Canvast feature detail surface: /canvast-feature <id|title> / 打开单个功能详情入口",
    handler: async (args, ctx) => {
      const selector = String(args || "").trim();
      appendPanel(pi, selector ? "Feature Detail" : "Feature Catalog", selector ? renderFeatureDetailLines(selector) : renderFeatureCatalogLines());
      ctx.ui.setStatus("canvast", selector ? `Feature detail: ${selector}` : "Feature catalog visible");
    },
  });

  pi.registerCommand("canvast-permission", {
    description: "Switch or inspect session permission mode: ask|auto|status / 切换或查看会话权限模式",
    handler: async (args, ctx) => {
      const result = await handleCanvastPermissionCommand(pi, args, ctx, {
        agentDir,
        appendPanel: (title, lines) => appendPanel(pi, title, lines),
      });
      return result as void;
    },
  });

  pi.registerCommand("canvast-thinking", {
    description: "Switch or inspect model thinking level: status|minimal|low|medium|high|xhigh|max / 切换或查看推理强度",
    handler: async (args, ctx) => {
      const raw = String(args || "").trim().toLowerCase();
      const levels = availableThinkingLevels(ctx.model);
      if (!raw || raw === "status") {
        syncRuntimeModel(pi, ctx);
        appendPanel(pi, "Canvast Thinking", [
          `Current thinking: ${currentThinkingLevel(pi, ctx) || "unknown"}`,
          `Available levels: ${levels.join(", ")}`,
          `Model: ${String(ctx.model?.provider || "unknown")}/${String(ctx.model?.id || "unknown")}`,
        ]);
        ctx.ui.setStatus("canvast", runtimeStatusSummary(readRuntimeStatus(agentDir())));
        return;
      }
      if (!levels.includes(raw) || !THINKING_LEVELS.includes(raw as any)) {
        ctx.ui.notify(`Usage: /canvast-thinking ${levels.join("|")}|status`, "warning");
        return;
      }
      if (typeof (pi as any).setThinkingLevel !== "function") {
        ctx.ui.notify("The active runtime does not expose setThinkingLevel.", "warning");
        return;
      }
      (pi as any).setThinkingLevel(raw);
      syncRuntimeModel(pi, ctx, raw);
      appendPanel(pi, "Canvast Thinking", [
        `Thinking level switched to ${raw}.`,
        `Model: ${String(ctx.model?.provider || "unknown")}/${String(ctx.model?.id || "unknown")}`,
      ]);
      ctx.ui.setStatus("canvast", runtimeStatusSummary(readRuntimeStatus(agentDir())));
    },
  });

  pi.registerCommand("canvast-canvas", {
    description: "Show Canvas graph visualization; pass a node id to focus / 显示 Canvas 图谱可视化；可传节点 ID 聚焦",
    handler: async (_args, ctx) => {
      appendPanel(pi, "Canvas View", renderCanvasLines(String(_args || "")));
      ctx.ui.setStatus("canvast", `Canvas | ${graphStats()}`);
    },
  });

  pi.registerCommand("canvast-tasks", {
    description: "Show task tree from Canvas plans / 显示 Canvas 计划任务树",
    handler: async (_args, ctx) => {
      appendPanel(pi, "Task Tree", renderTaskTreeLines());
      ctx.ui.setStatus("canvast", `Task tree | ${runtimeStatusSummary(readRuntimeStatus(agentDir()))}`);
    },
  });

  pi.registerCommand("canvast-agents", {
    description: "Show sub-agent management view / 显示子 agent 管理入口",
    handler: async (_args, ctx) => {
      appendPanel(pi, "Sub-Agent Management", renderAgentLines());
      ctx.ui.setStatus("canvast", `Sub-agents | ${runtimeStatusSummary(readRuntimeStatus(agentDir()))}`);
    },
  });

  pi.registerCommand("canvast-status", {
    description: "Show persistent runtime status for task tree, plans, sub-agents, workflows, language, and approvals.",
    handler: async (_args, ctx) => {
      refreshRuntimeLanguageFromContext(ctx);
      appendPanel(pi, "Runtime Status", renderRuntimeLines());
      ctx.ui.setStatus("canvast", runtimeStatusSummary(readRuntimeStatus(agentDir())));
    },
  });

  pi.registerCommand("canvast-workflow", {
    description: "Show workflow orchestration entry / 显示 workflow 编排入口",
    handler: async (_args, ctx) => {
      appendPanel(pi, "Workflow", renderWorkflowLines());
      ctx.ui.setStatus("canvast", `Workflow | ${runtimeStatusSummary(readRuntimeStatus(agentDir()))}`);
    },
  });

  pi.registerCommand("canvast-tools", {
    description: "Show coordinated tool strategy and web policy / 显示工具协调与联网策略",
    handler: async (_args, ctx) => {
      appendPanel(pi, "Tool Coordination", renderToolSurfaceLines());
      ctx.ui.setStatus("canvast", "Tool coordination visible");
    },
  });

  pi.registerCommand("canvast-context", {
    description: "Show session context, compaction, recall, and resume policy / 显示会话上下文、压缩、召回与恢复策略",
    handler: async (_args, ctx) => {
      appendPanel(pi, "Context Management", renderContextLines());
      ctx.ui.setStatus("canvast", "Context management visible");
    },
  });

  pi.registerCommand("canvast-closure", {
    description: "Show product closure gate summary / 显示产品闭环门禁摘要",
    handler: async (_args, ctx) => {
      const file = path.join(process.cwd(), "PRODUCT_CLOSURE_RECORD.json");
      const lines = ["Product closure"];
      try {
        const record = JSON.parse(fs.readFileSync(file, "utf-8"));
        const items = Array.isArray(record.items) ? record.items : [];
        const required = items.filter((i: any) => i.required === true);
        const closed = required.filter((i: any) => i.state === "closed");
        lines.push(`${closed.length}/${required.length} required gates closed`);
        for (const item of required) {
          const blockers = Array.isArray(item.blockers) ? item.blockers : [];
          lines.push(`- [${item.state}] ${item.id}: ${item.title}`);
          for (const blocker of blockers) lines.push(`  blocker: ${String(blocker)}`);
        }
      } catch (err: any) {
        lines.push(`Unable to read closure record: ${err.message}`);
      }
      appendPanel(pi, "Product Closure", lines);
      ctx.ui.setStatus("canvast", lines[1]);
    },
  });

  pi.registerCommand("canvast-safety", {
    description: "Show resource safety entry / 显示 CPU/内存安全入口",
    handler: async (_args, ctx) => {
      appendPanel(pi, "Resource Safety", [
        "Resource safety",
        "Use ./scripts/resource-watchdog.sh --once before heavy runs.",
        "Use ./scripts/safe-run.sh --timeout <seconds> -- <command> for real pi/LLM suites.",
        "Sub-agent and workflow process fallbacks use process-group cleanup and bounded concurrency.",
        "Vitest maxWorkers is pinned at 2.",
        "",
        ...renderSandboxLines(),
      ]);
      ctx.ui.setStatus("canvast", "Resource safety visible");
    },
  });
  pi.registerCommand("canvast-sandbox", {
    description: "Show sandbox and permission controls / 显示沙箱与权限控制入口",
    handler: async (_args, ctx) => {
      appendPanel(pi, "Sandbox Controls", renderSandboxLines());
      ctx.ui.setStatus("canvast", "Sandbox controls visible");
    },
  });
  pi.registerCommand("canvast-web", {
    description: "Show web research entry and policy / 显示联网研究入口与策略",
    handler: async (_args, ctx) => {
      appendPanel(pi, "Web Research", [
        "Web research",
        "Use web_research when current/external facts, explicit URLs/downloads, missing dependencies, or evidence gaps justify browsing.",
        "Do not browse by default for local code questions.",
        "web_search supports allowed_domains and blocked_domains.",
        "web_research returns evidence with source URLs and extracts; final answers must still reconcile local project context.",
      ]);
      ctx.ui.setStatus("canvast", "Web research policy visible");
    },
  });
}
