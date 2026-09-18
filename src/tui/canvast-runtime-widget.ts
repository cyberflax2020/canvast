/**
 * =============================================================================
 * Canvast — Canvast Runtime Widget / Canvast 源文件
 * =============================================================================
 * @file        src/tui/canvast-runtime-widget.ts
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */


import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as path from "path";

import { DEFAULT_CANVAST_MODE, readCanvastModeState } from "../harness/canvast-mode.js";
import { CONTEXT_RECALL_HOT_RECORDS, readContextRecallIndex } from "../harness/context-recall.js";
import {
  readRuntimeStatus,
  type RuntimeStatusItem,
  type RuntimeStatusSnapshot,
} from "../harness/runtime-status.js";
import { capturePanelPendingAck } from "./capture-handshake.js";
import { truncate } from "./canvast-tui-panels.js";
import {
  isCurrentRuntimeItemStatus,
  projectRuntimeLive,
} from "./runtime-live-projection.js";

const KEY_HINT_LINES = [
  "Keys: Esc interrupt · Shift+Tab automatic (+thinking) · Ctrl+T thinking · End latest",
  "Scroll: mouse/trackpad or PageUp/PageDown · Ctrl+O expand tools · /help commands",
];
const SCROLL_PATCH_MARK = Symbol.for("canvast.tui.scroll-stability-patch");
const TUI_SCROLL_PATCH_MARK = Symbol.for("canvast.tui.tui-scroll-stability-patch");
const USER_SCROLL_LOCK = Symbol.for("canvast.tui.user-scroll-lock");
const USER_SCROLL_COMMAND = Symbol.for("canvast.tui.user-scroll-command");
const VIEWPORT_INPUT_DATA = Symbol.for("canvast.tui.viewport-input-data");
const HOME_KEY_SEQUENCES = new Set([
  "top",
  "\u001b[H",
  "\u001bOH",
  "\u001b[1~",
  "\u001b[7~",
  "\u001b[1;2H",
  "\u001b[1;3H",
  "\u001b[1;4H",
  "\u001b[1;5H",
  "\u001b[1;6H",
  "\u001b[1;7H",
  "\u001b[1;8H",
]);

type ScrollViewLike = {
  scrollTop?: number;
  viewportHeight?: number;
  isFollowingEnd?: boolean;
  contentHeight?: number;
  currentViewportHeight?: number;
  currentScrollTop?: number;
  followEnd?: boolean;
  followingEnd?: boolean;
  followSuppressedAtEnd?: boolean;
  requestRenderCallback?: () => void;
  scrollBy?: (lines: number) => number;
  scrollTo?: (scrollTop: number, options?: { disableFollow?: boolean }) => void;
  scrollToStart?: () => void;
  scrollToEnd?: () => void;
  updateLayout?: (contentHeight: number, viewportHeight: number, requestRender: () => void) => void;
};

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME || "/tmp", ".canvast");
}

function currentCanvastMode(): string {
  return readCanvastModeState(agentDir())?.mode || process.env.CANVAST_MODE || DEFAULT_CANVAST_MODE;
}

function scrollMax(view: ScrollViewLike): number {
  const contentHeight = Number(view.contentHeight ?? 0);
  const viewportHeight = Number(view.currentViewportHeight ?? view.viewportHeight ?? 0);
  return Math.max(0, contentHeight - viewportHeight);
}

function scrollTopOf(view: ScrollViewLike): number {
  return Number(view.currentScrollTop ?? view.scrollTop ?? 0);
}

function setUserScrollLock(view: ScrollViewLike, locked: boolean): void {
  (view as any)[USER_SCROLL_LOCK] = locked;
  if (!locked) {
    view.followSuppressedAtEnd = false;
    if (view.followEnd && scrollTopOf(view) >= scrollMax(view)) view.followingEnd = true;
    return;
  }
  view.followingEnd = false;
  if (view.followEnd && scrollTopOf(view) >= scrollMax(view)) view.followSuppressedAtEnd = true;
}

function isExplicitTopInput(data: unknown): boolean {
  return typeof data === "string" && HOME_KEY_SEQUENCES.has(data);
}

function restoreAfterProgrammaticTop(view: ScrollViewLike | undefined, previousTop: number, state: {
  followingEnd: boolean;
  followSuppressedAtEnd: boolean;
  userLocked: boolean;
}): void {
  if (!view || previousTop <= 0 || scrollTopOf(view) > 0) return;
  const max = scrollMax(view);
  view.currentScrollTop = Math.max(0, Math.min(previousTop, max));
  view.followingEnd = state.followingEnd;
  view.followSuppressedAtEnd = state.followSuppressedAtEnd;
  (view as any)[USER_SCROLL_LOCK] = state.userLocked;
}

function patchScrollViewPrototype(view: ScrollViewLike | undefined): void {
  if (!view) return;
  const proto = Object.getPrototypeOf(view) as any;
  if (!proto || proto[SCROLL_PATCH_MARK]) return;
  if (
    typeof proto.scrollBy !== "function" ||
    typeof proto.scrollTo !== "function" ||
    typeof proto.scrollToStart !== "function" ||
    typeof proto.scrollToEnd !== "function" ||
    typeof proto.updateLayout !== "function"
  ) {
    return;
  }

  const originalScrollBy = proto.scrollBy;
  const originalScrollTo = proto.scrollTo;
  const originalScrollToStart = proto.scrollToStart;
  const originalScrollToEnd = proto.scrollToEnd;
  const originalUpdateLayout = proto.updateLayout;

  Object.defineProperty(proto, SCROLL_PATCH_MARK, { value: true, configurable: false });

  proto.scrollBy = function patchedScrollBy(lines: number): number {
    const remaining = originalScrollBy.call(this, lines);
    const requested = Number.isFinite(lines) ? Math.trunc(lines) : 0;
    const max = scrollMax(this);
    if (requested < 0 || scrollTopOf(this) < max) {
      setUserScrollLock(this, true);
    } else if (requested > 0 && scrollTopOf(this) >= max) {
      setUserScrollLock(this, false);
    }
    return remaining;
  };

  proto.scrollTo = function patchedScrollTo(scrollTop: number, options: { disableFollow?: boolean } = {}): void {
    const explicitUserCommand = Boolean((this as any)[USER_SCROLL_COMMAND]);
    const requestedTop = Number.isFinite(scrollTop) ? Math.trunc(scrollTop) : scrollTopOf(this);
    const previousTop = scrollTopOf(this);
    const wasFollowingEnd = Boolean(this.followingEnd);
    const wasFollowSuppressed = Boolean(this.followSuppressedAtEnd);
    const wasUserLocked = Boolean((this as any)[USER_SCROLL_LOCK]);
    originalScrollTo.call(this, scrollTop, options);
    if (!explicitUserCommand && requestedTop <= 0 && previousTop > 0) {
      const max = scrollMax(this);
      this.currentScrollTop = Math.max(0, Math.min(previousTop, max));
      this.followingEnd = wasFollowingEnd;
      this.followSuppressedAtEnd = wasFollowSuppressed;
      (this as any)[USER_SCROLL_LOCK] = wasUserLocked;
      return;
    }
    const max = scrollMax(this);
    if (options.disableFollow === true || scrollTopOf(this) < max) {
      setUserScrollLock(this, true);
    } else if (scrollTopOf(this) >= max) {
      setUserScrollLock(this, false);
    }
  };

  proto.scrollToStart = function patchedScrollToStart(): void {
    const explicitUserCommand = Boolean((this as any)[USER_SCROLL_COMMAND]);
    const previousTop = scrollTopOf(this);
    const wasFollowingEnd = Boolean(this.followingEnd);
    const wasFollowSuppressed = Boolean(this.followSuppressedAtEnd);
    const wasUserLocked = Boolean((this as any)[USER_SCROLL_LOCK]);
    originalScrollToStart.call(this);
    if (explicitUserCommand) {
      setUserScrollLock(this, true);
      return;
    }

    const max = scrollMax(this);
    this.currentScrollTop = Math.max(0, Math.min(previousTop, max));
    this.followingEnd = wasFollowingEnd;
    this.followSuppressedAtEnd = wasFollowSuppressed;
    (this as any)[USER_SCROLL_LOCK] = wasUserLocked;
  };

  proto.scrollToEnd = function patchedScrollToEnd(): void {
    originalScrollToEnd.call(this);
    setUserScrollLock(this, false);
  };

  proto.updateLayout = function patchedUpdateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
    const wasUserLocked = Boolean((this as any)[USER_SCROLL_LOCK]);
    const previousTop = scrollTopOf(this);
    originalUpdateLayout.call(this, contentHeight, viewportHeight, requestRender);
    if (!wasUserLocked) return;
    const max = scrollMax(this);
    this.currentScrollTop = Math.max(0, Math.min(previousTop, max));
    this.followingEnd = false;
    this.followSuppressedAtEnd = Boolean(this.followEnd && this.currentScrollTop >= max);
  };
}

function patchTuiScrollMethods(tui: any): void {
  if (!tui) return;
  if (tui[TUI_SCROLL_PATCH_MARK]) return;
  const originalScrollToTop = typeof tui.scrollToTop === "function" ? tui.scrollToTop : undefined;
  const originalHandleViewportInput = typeof tui.handleViewportInput === "function" ? tui.handleViewportInput : undefined;
  if (!originalScrollToTop && !originalHandleViewportInput) return;
  Object.defineProperty(tui, TUI_SCROLL_PATCH_MARK, { value: true, configurable: false });

  if (originalScrollToTop) {
    tui.scrollToTop = function patchedTuiScrollToTop(): void {
      const view = typeof this.getPrimaryScrollView === "function" ? this.getPrimaryScrollView() : undefined;
      patchScrollViewPrototype(view);
      const explicitUserCommand = isExplicitTopInput(this[VIEWPORT_INPUT_DATA]);
      if (view) (view as any)[USER_SCROLL_COMMAND] = explicitUserCommand;
      const previousTop = scrollTopOf(view || {});
      const state = {
        followingEnd: Boolean(view?.followingEnd),
        followSuppressedAtEnd: Boolean(view?.followSuppressedAtEnd),
        userLocked: Boolean(view && (view as any)[USER_SCROLL_LOCK]),
      };
      try {
        originalScrollToTop.call(this);
      } finally {
        if (view) (view as any)[USER_SCROLL_COMMAND] = false;
      }
      if (!explicitUserCommand) restoreAfterProgrammaticTop(view, previousTop, state);
    };
  }

  if (originalHandleViewportInput) {
    tui.handleViewportInput = function patchedHandleViewportInput(data: string): unknown {
      const view = typeof this.getPrimaryScrollView === "function" ? this.getPrimaryScrollView() : undefined;
      patchScrollViewPrototype(view);
      if (!view) return originalHandleViewportInput.call(this, data);
      this[VIEWPORT_INPUT_DATA] = data;
      (view as any)[USER_SCROLL_COMMAND] = isExplicitTopInput(data);
      try {
        return originalHandleViewportInput.call(this, data);
      } finally {
        this[VIEWPORT_INPUT_DATA] = undefined;
        (view as any)[USER_SCROLL_COMMAND] = false;
      }
    };
  }
}

function installScrollStabilityPatch(tui: any): void {
  patchTuiScrollMethods(tui);
  if (typeof tui?.setClearOnShrink === "function") {
    tui.setClearOnShrink(false);
  }
  const candidates: Array<ScrollViewLike | undefined> = [
    tui?.implicitScrollView,
    tui?.currentLayout?.primaryScrollView,
  ];
  if (typeof tui?.getPrimaryScrollView === "function") {
    try {
      candidates.push(tui.getPrimaryScrollView());
    } catch {
      // The TUI may not have completed its first layout yet.
    }
  }
  for (const candidate of candidates) patchScrollViewPrototype(candidate);
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${rest}s`;
  return `${rest}s`;
}

function elapsedForItem(item: { startedAt?: string; elapsedMs?: number }): string {
  if (Number.isFinite(item.elapsedMs)) return formatDuration(Number(item.elapsedMs));
  if (!item.startedAt) return "";
  const started = Date.parse(item.startedAt);
  if (!Number.isFinite(started)) return "";
  return formatDuration(Date.now() - started);
}

function runtimeItemOrder(status: RuntimeStatusItem["status"]): number {
  if (status === "in_progress" || status === "running") return 0;
  if (status === "pending") return 1;
  if (status === "blocked" || status === "unknown") return 2;
  if (status === "failed" || status === "aborted") return 3;
  if (status === "completed") return 4;
  return 5;
}

function newestRuntimeItems(items: RuntimeStatusItem[]): RuntimeStatusItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const statusOrder = runtimeItemOrder(left.item.status) - runtimeItemOrder(right.item.status);
      if (statusOrder !== 0) return statusOrder;
      const leftTime = Date.parse(left.item.updatedAt);
      const rightTime = Date.parse(right.item.updatedAt);
      const recency = (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
      return recency || left.index - right.index;
    })
    .map(({ item }) => item);
}

function visibleTodoItems(snapshot: RuntimeStatusSnapshot, currentSessionId?: string): RuntimeStatusItem[] {
  const currentTasks = projectRuntimeLive(snapshot, currentSessionId).tasks;
  const realTasks = currentTasks.filter(item => item.id !== "current-user-request");
  const openRealTasks = realTasks.filter(item => isCurrentRuntimeItemStatus(item.status));
  const hasOpenRealTree = openRealTasks.length > 0 || visiblePlanItems(snapshot, currentSessionId).length > 0;
  if (hasOpenRealTree) return newestRuntimeItems(openRealTasks);
  return newestRuntimeItems(currentTasks.filter(item =>
    item.id === "current-user-request" && isCurrentRuntimeItemStatus(item.status)
  ));
}

function visiblePlanItems(snapshot: RuntimeStatusSnapshot, currentSessionId?: string): RuntimeStatusItem[] {
  return newestRuntimeItems(projectRuntimeLive(snapshot, currentSessionId).plans.filter(item =>
    item.id !== "session-runtime" && isCurrentRuntimeItemStatus(item.status)
  ));
}

function compactTaskTitle(title: string, _max = 42): string {
  return title;
}

function taskGlyph(item: RuntimeStatusItem): string {
  if (item.status === "in_progress" || item.status === "running") return "■";
  if (item.status === "blocked") return "!";
  return "□";
}

function renderTodoBoard(snapshot: RuntimeStatusSnapshot, currentSessionId: string | undefined, limit = 6): string[] {
  const tasks = visibleTodoItems(snapshot, currentSessionId);
  const plans = visiblePlanItems(snapshot, currentSessionId);
  if (!tasks.length && !plans.length) return ["Task tree: 0 tracked"];
  const treeItems = [...plans, ...tasks];
  const active = treeItems.filter(item => item.status === "in_progress" || item.status === "running").length;
  const open = treeItems.filter(item => item.status === "pending").length;
  const blocked = treeItems.filter(item => item.status === "blocked" || item.status === "unknown").length;
  const blockedText = blocked > 0 ? `, ${blocked} blocked` : "";
  const lines = [
    `Task tree: ${treeItems.length} items (${plans.length} plans, ${active} in progress, ${open} open${blockedText})`,
    "In progress: current execution / 当前执行",
    "Open or pending: not started or waiting on dependencies / 尚未开始或等待依赖",
  ];
  const activePlans = plans.filter(item => item.status === "in_progress" || item.status === "running");
  const pendingPlans = plans.filter(item => item.status !== "in_progress" && item.status !== "running");
  const activeItems = tasks.filter(item => item.status === "in_progress" || item.status === "running");
  const pendingItems = tasks.filter(item => item.status !== "in_progress" && item.status !== "running");
  const ordered = [...activePlans, ...activeItems, ...pendingPlans, ...pendingItems];
  const shown = ordered.slice(0, limit);
  for (const item of shown) {
    const prefix = plans.includes(item) ? "Plan" : "Task";
    lines.push(`  ${taskGlyph(item)} ${prefix}: ${compactTaskTitle(item.title)}`);
  }
  const remaining = treeItems.length - shown.length;
  if (remaining > 0) lines.push(`   ${remaining} more current items are available in /canvast-tasks`);
  return lines;
}

function renderInputQueue(snapshot: RuntimeStatusSnapshot, currentSessionId?: string): string[] {
  const pending = projectRuntimeLive(snapshot, currentSessionId).inputQueue;
  if (!pending.length) return [];
  const latest = pending.at(-1);
  const lines = [`Input queue: ${pending.length} pending`];
  if (latest) {
    const marker = latest.status === "interrupt" ? "interrupt" : latest.policy;
    lines.push(`  ${marker}: ${compactTaskTitle(latest.textSummary, 64)}`);
  }
  return lines;
}

function activeShellCount(snapshot: RuntimeStatusSnapshot, currentSessionId?: string): number {
  return projectRuntimeLive(snapshot, currentSessionId).toolRuns.filter(item =>
    (item.status === "running" || item.status === "in_progress") &&
    /^(bash|shell|bg_bash|sandbox_bash)$/i.test(item.title)
  ).length;
}

function activeRuntimeLine(snapshot: RuntimeStatusSnapshot, currentSessionId?: string): string {
  const live = projectRuntimeLive(snapshot, currentSessionId);
  const current = visiblePlanItems(snapshot, currentSessionId).find(item =>
    item.status === "in_progress" || item.status === "running"
  ) ||
    visibleTodoItems(snapshot, currentSessionId).find(item => item.status === "in_progress" || item.status === "running") ||
    (live.identity
      ? live.tasks.find(item =>
          item.id === "current-user-request" &&
          (item.status === "in_progress" || item.status === "running"),
        )
      : undefined);
  const fallback = !live.identity
    ? "Idle"
    : `${snapshot.rootExecution.state}: ${snapshot.rootExecution.reason}`;
  const title = current ? compactTaskTitle(current.title, 46) : fallback;
  const elapsed = current && elapsedForItem(current) ? ` · ${elapsedForItem(current)}` : "";
  const shellCount = activeShellCount(snapshot, currentSessionId);
  const shellText = shellCount === 1 ? " · 1 shell running" : ` · ${shellCount} shells running`;
  return `Current: ${title}${elapsed}${shellText}`;
}

function runtimeMetricsLines(snapshot: RuntimeStatusSnapshot): string[] {
  const model = `${snapshot.model.provider || "unknown"}/${snapshot.model.model || "unknown"}`;
  const thinking = snapshot.model.thinkingLevel || "unknown";
  const tokens = Math.round(snapshot.tokens.totalTokens).toLocaleString();
  const context = snapshot.tokens.contextWindowTokens > 0
    ? `${Math.round(snapshot.tokens.contextUsedTokens).toLocaleString()}/${Math.round(snapshot.tokens.contextWindowTokens).toLocaleString()} (${Math.round(snapshot.tokens.contextUsageRatio * 100)}%)`
    : "unknown";
  return [
    `Model: ${model} · thinking ${thinking}`,
    `Tokens: ${tokens} total · ctx ${context}`,
  ];
}

function runtimeModeLine(snapshot: RuntimeStatusSnapshot): string {
  const permissionHint = snapshot.permission.mode === "auto"
    ? "auto, no prompts"
    : "ask";
  return `Modes: canvas ${currentCanvastMode()} (/canvast-mode) · permission ${permissionHint} (/canvast-permission auto|ask)`;
}

function runtimeManagementLines(): string[] {
  return [
    "Manage: /canvast-status · /canvast-tasks · /canvast-resume",
    "Runs: /canvast-agents · /canvast-workflow",
    "Tools: /canvast-tools · /canvast-sandbox · /canvast-context",
  ];
}

function recallRuntimeLine(agentDirPath: string): string {
  const recall = readContextRecallIndex(agentDirPath);
  const archive = recall.storage?.archiveRecords ?? 0;
  const total = recall.records.length + archive;
  const storage = recall.storage
    ? ` · storage ${Math.round(recall.storage.directoryBytes / 1024)} KiB`
    : "";
  return `Recall: hot ${recall.records.length}/${CONTEXT_RECALL_HOT_RECORDS} · archive ${archive} · total ${total}${storage} (/canvast-context)`;
}

export function setRuntimeWidget(ctx: ExtensionCommandContext): void {
  if (ctx.mode !== "tui") return;
  const currentSessionId = typeof ctx.sessionManager?.getSessionId === "function"
    ? ctx.sessionManager.getSessionId()
    : undefined;
  ctx.ui.setWidget("canvast-runtime", (tui, theme) => {
    installScrollStabilityPatch(tui);
    let disposed = false;
    const timer = setInterval(() => {
      if (!disposed && !capturePanelPendingAck()) tui.requestRender();
    }, 1000);
    timer.unref?.();
    return {
      invalidate() {},
      dispose() {
        disposed = true;
        clearInterval(timer);
      },
      render(width: number): string[] {
        const snapshot = readRuntimeStatus(agentDir());
        const live = projectRuntimeLive(snapshot, currentSessionId);
        const recentApproval = snapshot.approvalReviews.at(-1);
        const lines = [
          theme.fg("accent", theme.bold("Canvast Runtime")),
          theme.fg("dim", activeRuntimeLine(snapshot, currentSessionId)),
          ...renderTodoBoard(snapshot, currentSessionId).map(line => theme.fg("dim", line)),
          ...renderInputQueue(snapshot, currentSessionId).map(line => theme.fg("dim", line)),
          runtimeModeLine(snapshot),
          ...KEY_HINT_LINES,
          ...runtimeMetricsLines(snapshot),
          recallRuntimeLine(agentDir()),
          ...runtimeManagementLines(),
        ];
        const activePlan = live.plans.find(item => item.id !== "session-runtime");
        const activeWorkflow = live.workflows.find(item => item.status === "in_progress" || item.status === "running");
        const activeAgent = live.subAgents.find(item => item.status === "in_progress" || item.status === "running");
        if (activeWorkflow) lines.push(`Workflow: [${activeWorkflow.status}] ${activeWorkflow.title}${elapsedForItem(activeWorkflow) ? ` (${elapsedForItem(activeWorkflow)})` : ""}`);
        if (activeAgent) lines.push(`Agent: [${activeAgent.status}] ${activeAgent.title}${elapsedForItem(activeAgent) ? ` (${elapsedForItem(activeAgent)})` : ""}`);
        const activeTools = live.toolRuns.filter(item => item.status === "in_progress" || item.status === "running");
        if (activeTools.length) lines.push(`Tools: ${activeTools.length} running (${activeTools.map(item => item.title).slice(0, 3).join(", ")})`);
        const recentAttachment = snapshot.attachments.at(-1);
        if (recentAttachment) lines.push(`Attachment: ${recentAttachment.placeholder} ${recentAttachment.kind}/${recentAttachment.disposition}`);
        if (recentApproval) {
          lines.push(`Last approval: ${recentApproval.decision} · risk ${recentApproval.risk} · auth ${recentApproval.authorization}`);
        }
        if (!activePlan && !activeWorkflow && !activeAgent && !recentApproval && !recentAttachment && visibleTodoItems(snapshot, currentSessionId).length === 0) {
          lines.push("State: no active workflow, sub-agent, or approval review recorded.");
        }
        return lines.map(line => truncate(line, width));
      },
    };
  }, { placement: "belowEditor" });
}
