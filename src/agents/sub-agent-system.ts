/**
 * =============================================================================
 * Canvast — Sub-Agent Dispatch System / 子 Agent 调度系统
 * =============================================================================
 * @file        src/agents/sub-agent-system.ts
 * @brief       SDK-level sub-agent spawn with Canvas context packages
 * @description Spawns sub-agents as IN-PROCESS pi SDK sessions (createAgentSession),
 *              not bash child processes. This realizes the single-process doctrine
 *              (docs/architecture/runtime-orchestration.md): each sub-agent is an isolated context window
 *              + role-restricted toolset in the SAME process, so process/RAM count
 *              does not grow with the task tree.
 *
 *              Structural safety (D-A2):
 *              - No extensions loaded in the sub-session → a sub-agent has no
 *                spawn/derive tool → depth is enforced by CONSTRUCTION, not counting.
 *              - Concurrency bounded by a fixed slot pool (activeAgentCount) →
 *                never dynamic expansion.
 *              - Roles are read-only or coding; implemented via createReadOnlyTools /
 *                createCodingTools (decided at construction time, not runtime monitor).
 *              - Token/bytes budgets are structural: read-only tools return capped
 *                output; session killed by timeout, never hung.
 *
 *              Each sub-agent receives a Canvas-scoped context package injected as
 *              the system prompt, and its result (text + token usage) is merged back
 *              to Canvas as an AgentRun node. (In-process SDK path supersedes the
 *              process-forking transition fallback in extensions/sub-agent.ts; see
 *              docs/architecture/runtime-orchestration.md.)
 *              通过 pi SDK 在进程内派生隔离上下文子 agent，每个子 agent 接收
 *              Canvas 作用域上下文包；产物（文本+token 用量）回写 Canvas AgentRun。
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * Changes:
 *   [2026-08-08] Initial implementation
 *   [2026-08-15] Step 2-C: executeAgent → true in-process pi SDK session
 * =============================================================================
 */

import type { CanvasStore } from "../graph/canvas-store.js";
import { assembleCanvasScopedView } from "../graph/canvas-scope.js";
import type { AgentRunNode, PlanNode, FileNode } from "../graph/types.js";
import { AgentRegistry, type AgentType, type RecursionLimits } from "./agent-registry.js";
import { type DynamicConfigManager, getDynamicConfig } from "../utils/dynamic-config.js";
import { type ProcessLifecycleManager, getProcessLifecycle } from "../utils/process-lifecycle.js";
import { type SystemMonitor, getSystemMonitor } from "../utils/system-monitor.js";
import {
  createDeadlineWindow,
  createTerminalCauseLatch,
  type DeadlineWindow,
  DeadlineExceededError,
  settleWithin,
  runWithDeadline,
} from "../utils/bounded-lifecycle.js";
import { resolveProviderModelArgs } from "../harness/model-capabilities.js";
import {
  createAgentSession,
  createCodingTools,
  createReadOnlyTools,
  DefaultResourceLoader,
  SessionManager,
  type AgentSession,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  getOwnedHandleRegistry,
  type OwnedHandleLease,
} from "../utils/owned-handle-registry.js";

export interface SubAgentTask {
  id: string;
  description: string;
  parentPlanId?: string;
  agentType: AgentType;
  timeoutMs?: number;
}

export interface SubAgentResult {
  taskId: string;
  agentRunId: string;
  success: boolean;
  summary: string;
  filesProduced: string[];
  tokensUsed: number;
  durationMs: number;
  errorMessage?: string;
  cleanupFailed?: boolean;
  outcomeUnknown?: boolean;
  terminalCause?: SubAgentTerminalCause;
}

const SLOT_WAIT_TIMEOUT_MS = 30_000;
const SESSION_CLEANUP_GRACE_MS = 2_000;

export type SubAgentTerminalCause = "timeout" | "emergency_stop" | "cleanup_failed";

interface AgentExecutionResult {
  success: boolean;
  summary: string;
  tokensUsed: number;
  filesProduced: string[];
  errorMessage?: string;
  cleanupFailed?: boolean;
  outcomeUnknown?: boolean;
  terminalCause?: SubAgentTerminalCause;
}

interface SlotWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface ActiveSessionState {
  terminal: ReturnType<typeof createTerminalCauseLatch<SubAgentTerminalCause>>;
  interrupted: Promise<void>;
  notifyInterrupted: () => void;
  abortAttempt?: Promise<void>;
  ownedHandle: OwnedHandleLease;
}

function createActiveSessionState(ownedHandle: OwnedHandleLease): ActiveSessionState {
  let notifyInterrupted!: () => void;
  const interrupted = new Promise<void>(resolve => {
    notifyInterrupted = resolve;
  });
  return {
    terminal: createTerminalCauseLatch<SubAgentTerminalCause>(),
    interrupted,
    notifyInterrupted,
    ownedHandle,
  };
}

function markCleanupUnknown(state: ActiveSessionState): void {
  state.terminal.markCleanupFailed();
  state.terminal.markOutcomeUnknown();
}

/**
 * SubAgentSystem — manages sub-agent lifecycle with Canvas integration.
 *
 * Key features:
 * - Canvas-scoped context packages (具现化信息包)
 * - Recursion depth enforcement
 * - Deliverable review pipeline
 * - Result merge back to Canvas
 */
export class SubAgentSystem {
  private config: DynamicConfigManager;
  private lifecycle: ProcessLifecycleManager;
  private monitor: SystemMonitor;
  private activeAgentCount = 0;
  private spawnQueue: SlotWaiter[] = [];
  private activeSessions = new Map<AgentSession, ActiveSessionState>();

  constructor(
    private store: CanvasStore,
    private registry: AgentRegistry,
    private limits?: Partial<RecursionLimits>,
    config?: DynamicConfigManager,
    lifecycle?: ProcessLifecycleManager,
    monitor?: SystemMonitor,
  ) {
    this.config = config ?? getDynamicConfig();
    this.lifecycle = lifecycle ?? getProcessLifecycle();
    this.monitor = monitor ?? getSystemMonitor();

    // Start monitoring if not already running
    if (!this.monitor.isRunning) this.monitor.start();
    this.lifecycle.start();

    // React to system throttle changes (continuous factor, not hard switch)
    this.monitor.onThrottleChange((factor) => {
      if (factor <= 0.05) {
        // Near-zero throttle: gracefully stop accepting new work,
        // but let in-flight agents finish — don't kill them
        this.cancelQueuedSpawns(
          "Sub-agent slot wait cancelled because system throttling paused new work",
        );
      }
      // At other levels, the ResourceAllocator handles throttling
      // via reduced concurrency and smaller memory grants — no
      // emergency stop needed, just natural slowdown
    });
  }

  /**
   * Dispatch a single sub-agent with Canvas context.
   */
  async dispatch(
    task: SubAgentTask,
    parentDepth: number = 0,
    parentAgentId?: string,
  ): Promise<SubAgentResult> {
    // 0. Check system health — continuous throttle, not a hard gate
    // Only refuse at the extreme end (factor ≤ 0.03 = essentially stopped)
    // At all other levels, ResourceAllocator handles throttling gracefully
    if (this.monitor.throttleFactor <= 0.03) {
      return {
        taskId: task.id, agentRunId: "", success: false,
        summary: "", filesProduced: [], tokensUsed: 0, durationMs: 0,
        errorMessage: `System throttle at ${(this.monitor.throttleFactor * 100).toFixed(1)}% — refusing new spawn to protect host. 系统资源极度紧张，暂停新任务以保护宿主机。`,
      };
    }

    // 0.5 Check total-agent limit before joining the bounded slot queue.
    const concurrency = this.config.concurrency;
    if (this.registry.activeCount >= concurrency.maxTotalAgents) {
      return {
        taskId: task.id, agentRunId: "", success: false,
        summary: "", filesProduced: [], tokensUsed: 0, durationMs: 0,
        errorMessage: `Max total agents (${concurrency.maxTotalAgents}) reached`,
      };
    }

    // 1. Check recursion limits
    const canSpawn = this.registry.canSpawn(parentDepth, parentAgentId);
    if (!canSpawn.allowed) {
      return {
        taskId: task.id, agentRunId: "", success: false,
        summary: "", filesProduced: [], tokensUsed: 0, durationMs: 0,
        errorMessage: canSpawn.reason,
      };
    }

    // 1.5 Check process lifecycle capacity
    if (this.lifecycle.atCapacity) {
      return {
        taskId: task.id, agentRunId: "", success: false,
        summary: "", filesProduced: [], tokensUsed: 0, durationMs: 0,
        errorMessage: `Process capacity (${this.lifecycle.countAlive()} alive) exceeded`,
      };
    }

    // 2. Get agent type definition
    const agentType = this.registry.getType(task.agentType);
    const depth = parentDepth + 1;
    const model = this.resolveModel(depth, agentType.defaultModelTier);

    // Atomically reserve capacity before registering or starting the agent.
    // 原子获取 permit 后才注册/启动，避免多个 waiter 同时穿透并发上限。
    try {
      await this.waitForSlot();
    } catch (err: any) {
      return {
        taskId: task.id, agentRunId: "", success: false,
        summary: "", filesProduced: [], tokensUsed: 0, durationMs: 0,
        errorMessage: err?.message || String(err),
      };
    }

    const startTime = Date.now();
    let agentRun: AgentRunNode | undefined;

    try {
      // 3. Register agent in Canvas + Registry
      agentRun = this.registry.registerAgent(
        task.description,
        task.agentType,
        model,
        depth,
        parentAgentId,
      );

      // 4. Assemble Canvas context package (具现化)
      const canvasContext = this.buildContextPackage(task, agentRun);

      // 5. Execute (SDK-level — AgentSessionRuntime)
      //    In Phase 0-1, this falls back to process-level spawn.
      //    Phase 2 migrates to true SDK-level AgentSessionRuntime.
      const result = await this.executeAgent(task, agentRun, canvasContext, agentType);

      const durationMs = Date.now() - startTime;

      // 6. Update Canvas with results
      this.registry.updateAgent(agentRun.id, {
        status: result.success ? "completed" : "failed",
        endTime: new Date().toISOString(),
        summary: result.summary,
        tokensUsed: result.tokensUsed,
        cost: this.estimateCost(result.tokensUsed, model),
        filesProduced: result.filesProduced,
        filesModified: result.filesProduced, // simplified
        errorMessage: result.errorMessage,
        cleanupFailed: result.cleanupFailed,
        outcomeUnknown: result.outcomeUnknown,
        terminalCause: result.terminalCause,
      });

      // 7. Create Canvas edges
      if (task.parentPlanId) {
        // Link agent to plan
        this.store.createEdge({
          type: "EXECUTED_BY",
          fromNodeId: agentRun.id,
          toNodeId: task.parentPlanId,
        });
      }
      for (const fileId of result.filesProduced) {
        this.store.createEdge({
          type: "PRODUCED_BY",
          fromNodeId: fileId,
          toNodeId: agentRun.id,
        });
      }

      return {
        taskId: task.id,
        agentRunId: agentRun.id,
        success: result.success,
        summary: result.summary,
        filesProduced: result.filesProduced,
        tokensUsed: result.tokensUsed,
        durationMs,
        errorMessage: result.errorMessage,
        cleanupFailed: result.cleanupFailed,
        outcomeUnknown: result.outcomeUnknown,
        terminalCause: result.terminalCause,
      };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      if (agentRun) {
        this.registry.updateAgent(agentRun.id, {
          status: "failed",
          endTime: new Date().toISOString(),
          errorMessage: err?.message || String(err),
        });
      }
      return {
        taskId: task.id,
        agentRunId: agentRun?.id ?? "",
        success: false,
        summary: "",
        filesProduced: [],
        tokensUsed: 0,
        durationMs,
        errorMessage: err?.message || String(err),
      };
    } finally {
      this.releaseSlot();
    }
  }

  /** Emergency stop — kill all running agent processes */
  emergencyStop(): void {
    this.cancelQueuedSpawns("Sub-agent slot wait cancelled by emergency stop");
    for (const [session, state] of this.activeSessions.entries()) {
      void this.stopActiveSession(session, state, "emergency_stop");
    }
    this.lifecycle.killAll("SIGTERM", "emergency").catch(() => {
      // Force kill if graceful fails
      this.lifecycle.killAll("SIGKILL", "emergency_force").catch(() => {});
    });
  }

  /**
   * Atomically acquire one FIFO concurrency permit.
   * 原子获取一个 FIFO 并发许可；超时明确失败，绝不无许可继续执行。
   */
  private waitForSlot(): Promise<void> {
    const maxParallelAgents = this.config.concurrency.maxParallelAgents;
    if (this.spawnQueue.length === 0 && this.activeAgentCount < maxParallelAgents) {
      this.activeAgentCount++;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: SlotWaiter = {
        resolve,
        reject,
      };
      waiter.timer = setTimeout(() => {
        const index = this.spawnQueue.indexOf(waiter);
        if (index < 0) return;
        this.spawnQueue.splice(index, 1);
        reject(new Error(
          `Timed out after ${SLOT_WAIT_TIMEOUT_MS}ms waiting for a sub-agent concurrency slot`,
        ));
      }, SLOT_WAIT_TIMEOUT_MS);
      this.spawnQueue.push(waiter);

      // Preserve FIFO order if capacity grew while older waiters were queued.
      // 若排队期间容量增大，仍只把当前空槽交给队首。
      this.grantNextSlot();
    });
  }

  /** Release one permit and hand it to at most one queued waiter. */
  private releaseSlot(): void {
    if (this.activeAgentCount <= 0) return;
    this.activeAgentCount--;
    this.grantNextSlot();
  }

  /** Reserve a free permit for the oldest waiter before waking it. */
  private grantNextSlot(): void {
    if (this.spawnQueue.length === 0) return;
    if (this.activeAgentCount >= this.config.concurrency.maxParallelAgents) return;

    const waiter = this.spawnQueue.shift();
    if (!waiter) return;
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    this.activeAgentCount++;
    waiter.resolve();
  }

  /** Reject every queued waiter without changing permits held by running agents. */
  private cancelQueuedSpawns(message: string): void {
    const waiters = this.spawnQueue.splice(0);
    for (const waiter of waiters) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.reject(new Error(message));
    }
  }

  /** Get current active agent count */
  get activeCount(): number { return this.activeAgentCount; }

  /**
   * Dispatch multiple sub-agents in parallel.
   */
  async dispatchParallel(
    tasks: SubAgentTask[],
    parentDepth: number = 0,
    parentAgentId?: string,
  ): Promise<SubAgentResult[]> {
    const results = await Promise.allSettled(
      tasks.map(t => this.dispatch(t, parentDepth, parentAgentId)),
    );
    return results.map(r =>
      r.status === "fulfilled" ? r.value : {
        taskId: "unknown", agentRunId: "", success: false,
        summary: "", filesProduced: [], tokensUsed: 0, durationMs: 0,
        errorMessage: r.reason?.message || "Unknown error",
      },
    );
  }

  /**
   * Dispatch in chain (A→B→C, each receives previous result).
   */
  async dispatchChain(
    tasks: SubAgentTask[],
    parentDepth: number = 0,
  ): Promise<SubAgentResult[]> {
    const results: SubAgentResult[] = [];
    for (const task of tasks) {
      // Enrich task description with previous result
      if (results.length > 0) {
        const prev = results[results.length - 1];
        task.description = `${task.description}\n\nPrevious agent output: ${prev.summary}`;
      }
      const result = await this.dispatch(task, parentDepth);
      results.push(result);
      if (!result.success) break; // stop chain on failure
    }
    return results;
  }

  // ─── Private ────────────────────────────────────────────

  /** Build the Canvas context package for a sub-agent */
  private buildContextPackage(task: SubAgentTask, agentRun: AgentRunNode): string {
    const scopeText = assembleCanvasScopedView(this.store, task.id);
    return [
      `## Sub-Agent Context / 子 Agent 上下文`,
      ``,
      `**Agent ID**: ${agentRun.id}`,
      `**Depth**: ${agentRun.properties.depth}`,
      `**Type**: ${agentRun.properties.agentType}`,
      ``,
      scopeText,
      ``,
      `---`,
      `Complete your assigned task. Report results back to the parent agent.`,
      `完成分配的任务。将结果报告给父 agent。`,
    ].join("\n");
  }

  /** Resolve model based on depth and tier */
  private resolveModel(depth: number, tier: "best" | "mid" | "cheap"): string {
    const tierModel =
      tier === "cheap"
        ? process.env.CANVAST_SUBAGENT_CHEAP_MODEL
        : tier === "mid" || depth > 1
          ? process.env.CANVAST_SUBAGENT_MID_MODEL
          : process.env.CANVAST_SUBAGENT_BEST_MODEL;
    const model = tierModel ||
      process.env.CANVAST_SUBAGENT_MODEL ||
      process.env.CANVAST_MODEL ||
      process.env.CANVAST_DEFAULT_MODEL ||
      (tier === "cheap" || depth > 1 ? "deepseek-v4-flash" : "deepseek-v4-pro");
    const provider = process.env.CANVAST_SUBAGENT_PROVIDER ||
      process.env.CANVAST_PROVIDER ||
      process.env.CANVAST_DEFAULT_PROVIDER;
    const resolved = resolveProviderModelArgs({ provider, model });
    return `${resolved.provider}/${resolved.model}`;
  }

  private resolveSdkModel(modelId: string): Model<Api> {
    const [rawProvider, ...rest] = modelId.includes("/") ? modelId.split("/") : [];
    const provider = rawProvider || process.env.CANVAST_PROVIDER || "deepseek";
    const model = rest.length ? rest.join("/") : modelId;
    const selected = getModel(provider as any, model as any) as Model<Api> | undefined;
    if (selected) return selected;
    const fallbackProvider = process.env.CANVAST_SDK_FALLBACK_PROVIDER || "deepseek";
    const fallbackModel = process.env.CANVAST_SDK_FALLBACK_MODEL || "deepseek-v4-flash";
    const fallback = getModel(fallbackProvider as any, fallbackModel as any) as Model<Api> | undefined;
    if (!fallback) throw new Error(`No SDK model available for ${modelId} or fallback ${fallbackProvider}/${fallbackModel}`);
    return fallback;
  }

  private resolveSdkThinkingLevel(): CreateAgentSessionOptions["thinkingLevel"] {
    const value = process.env.CANVAST_SUBAGENT_THINKING || "minimal";
    return value === "minimal" ||
      value === "low" ||
      value === "medium" ||
      value === "high" ||
      value === "xhigh" ||
      value === "max"
      ? value
      : "minimal";
  }

  /**
   * Build the SDK session options for a sub-agent.
   * PURE: no I/O, no LLM — fully unit-testable.
   *
   * Structural properties (D-A1 / D-A2):
   * - noExtensions / noSkills / noThemes / noPromptTemplates / noContextFiles
   *   → isolated session with NO spawn capability (depth by construction).
   * - Role-restricted toolset decided here (constructor-time), not runtime-monitored.
   * - SessionManager.inMemory → sub-session transcript never clobbers the parent.
   *
   * @param modelId  provider-qualified model id, e.g. "deepseek-v4-flash".
   * @param context  assembled Canvas-scoped context (system prompt).
   * @param role     agent role definition (tools / readOnly).
   */
  buildSubSessionOptions(
    modelId: string,
    context: string,
    role: { tools: string[] | "*"; readOnly: boolean },
    cwd: string = process.cwd(),
  ): CreateAgentSessionOptions {
    // Toolset by construction: read-only agents get read tools only; coding agents
    // get the full built-in coding toolset. No sub-session ever loads extensions,
    // so none of them can re-spawn a child regardless of role.
    // createReadOnlyTools already excludes write/edit/bash mutation tools by
    // construction; createCodingTools grants the full built-in coding set.
    const tools = role.readOnly
      ? createReadOnlyTools(cwd)
      : createCodingTools(cwd);

    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: this.dataDir(),
      systemPrompt: context,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });

    return {
      cwd,
      agentDir: this.dataDir(),
      model: this.resolveSdkModel(modelId),
      thinkingLevel: this.resolveSdkThinkingLevel(),
      // NOTE: the SDK treats `tools` as an ALLOWLIST gating ALL tools
      // (built-ins included). The names below intentionally include the
      // built-in tool names provided by createReadOnlyTools/createCodingTools;
      // adding new custom tools requires ALSO listing their names here.
      // SDK 把 tools 当作所有工具（含内置）的白名单；新增自定义工具
      // 时必须把其名字同时加入此列表。
      tools: tools.map((t) => (t as any).name).filter(Boolean),
      customTools: tools,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      noTools: undefined,
    };
  }

  /** Private data dir for sub-session agent/non-session state. */
  private dataDir(): string {
    return process.env.PI_CODING_AGENT_DIR ||
      (process.env.HOME ? `${process.env.HOME}/.canvast` : "/tmp/canvast");
  }

  /**
   * Extract the accumulated assistant free-text from a session's message list.
   * PURE, unit-testable. Concatenates text parts of assistant messages (skips
   * thinking and tool-call parts, like the SDK replay helper used by btw-ref).
   */
  extractAssistantText(messages: readonly unknown[]): string {
    const parts: string[] = [];
    for (const m of messages) {
      const msg = m as { role?: string; content?: unknown };
      if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
      for (const part of msg.content) {
        const p = part as { type?: string; text?: string };
        if (p?.type === "text" && typeof p.text === "string" && p.text.trim()) {
          parts.push(p.text.trim());
        }
      }
    }
    return parts.join("\n\n");
  }

  /**
   * Extract total token usage from the last assistant message of a session.
   * PURE, unit-testable. Returns 0 when unavailable.
   */
  extractUsage(messages: readonly unknown[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i] as { role?: string; usage?: { totalTokens?: number } };
      if (msg?.role === "assistant" && msg?.usage && typeof msg.usage.totalTokens === "number") {
        return msg.usage.totalTokens;
      }
    }
    return 0;
  }

  /**
   * Execute a sub-agent as an IN-PROCESS pi SDK session.
   * SDK path described by docs/architecture/runtime-orchestration.md: replaces the process-forking transition
   * fallback with a same-process isolated context window.
   */
  private async executeAgent(
    task: SubAgentTask,
    agentRun: AgentRunNode,
    context: string,
    type: { tools: string[] | "*"; readOnly: boolean },
  ): Promise<AgentExecutionResult> {
    const timeoutMs = task.timeoutMs ?? this.config.concurrency.defaultAgentTimeoutMs;
    const deadline = createDeadlineWindow(timeoutMs);
    const model = agentRun.properties.model || "deepseek-v4-flash";
    const opts = this.buildSubSessionOptions(model, context, type);

    let session: AgentSession | undefined;
    let sessionState: ActiveSessionState | undefined;
    let ownedHandle: OwnedHandleLease | undefined;
    let creationOutcomeUnknown = false;
    let finalResult: AgentExecutionResult | undefined;
    const readSessionOutput = (): { summary: string; tokensUsed: number } => {
      const messages = session?.state?.messages ?? [];
      return {
        summary: this.extractAssistantText(messages),
        tokensUsed: this.extractUsage(messages),
      };
    };
    const terminalResult = (): AgentExecutionResult | undefined => {
      if (!sessionState) return undefined;
      const { summary, tokensUsed } = readSessionOutput();
      const terminalState = sessionState.terminal.current();
      const lifecycleSuffix = terminalState.cleanupFailed || terminalState.outcomeUnknown
        ? ` Cleanup failed=${terminalState.cleanupFailed}; outcome unknown=${terminalState.outcomeUnknown}.`
        : "";
      const lifecycle = {
        cleanupFailed: terminalState.cleanupFailed || undefined,
        outcomeUnknown: terminalState.outcomeUnknown || undefined,
        terminalCause: terminalState.cause,
      };
      if (terminalState.cause === "timeout") {
        return {
          success: false,
          summary,
          tokensUsed,
          filesProduced: [],
          errorMessage: `Sub-agent timed out after ${timeoutMs}ms.${lifecycleSuffix}`,
          ...lifecycle,
        };
      }
      if (terminalState.cause === "emergency_stop") {
        return {
          success: false,
          summary,
          tokensUsed,
          filesProduced: [],
          errorMessage: `Sub-agent cancelled by emergency stop.${lifecycleSuffix}`,
          ...lifecycle,
        };
      }
      if (terminalState.cleanupFailed || terminalState.outcomeUnknown) {
        return {
          success: false,
          summary,
          tokensUsed,
          filesProduced: [],
          errorMessage: `Sub-agent cleanup failed within the bounded lifecycle window.${lifecycleSuffix}`,
          ...lifecycle,
        };
      }
      return undefined;
    };

    try {
      ownedHandle = getOwnedHandleRegistry().register({
        type: "sdk-session",
        owner: "sub-agent-system",
        source: "pi-agent-sdk",
        scope: "sdk-sub-agent",
        metadata: { taskId: task.id },
      });
      // CRITICAL: the SDK only calls resourceLoader.reload() for loaders it
      // creates itself — an externally supplied loader is used as-is, so the
      // Canvas context package (systemPrompt) would never load without this.
      // SDK 只会 reload 自己创建的 loader；外部传入的必须自行 reload，
      // 否则子会话拿不到 Canvas 作用域系统提示。
      await this.runSdkStageWithinDeadline(deadline, "reload", async () => {
        await (opts.resourceLoader as any)?.reload?.();
      });

      const created = await this.createSdkSessionWithinDeadline(deadline, opts, ownedHandle);
      const liveSession = created.session;
      session = liveSession;
      sessionState = createActiveSessionState(ownedHandle);
      this.activeSessions.set(liveSession, sessionState);

      // Run the task against a fresh context window. source: "extension" tells
      // pi this is programmatic (no TUI render needed).
      await this.runSdkPromptWithinDeadline(
        deadline,
        liveSession,
        sessionState,
        `${context}\n\n---\n${task.description}`,
      );

      const interrupted = terminalResult();
      if (interrupted) {
        finalResult = interrupted;
      } else {
        const { summary, tokensUsed } = readSessionOutput();
        finalResult = { success: true, summary: summary || "(no text output)", tokensUsed, filesProduced: [] };
      }
    } catch (err: any) {
      const interrupted = terminalResult();
      const deadlineFailure = err instanceof DeadlineExceededError;
      const unresolvedCreation = deadlineFailure && err.stage === "create";
      creationOutcomeUnknown = unresolvedCreation;
      finalResult = interrupted || {
        success: false,
        summary: "",
        tokensUsed: 0,
        filesProduced: [],
        errorMessage: err?.message || String(err),
        cleanupFailed: unresolvedCreation || undefined,
        outcomeUnknown: unresolvedCreation || undefined,
        terminalCause: deadlineFailure ? "timeout" : undefined,
      };
    } finally {
      if (session && sessionState) {
        const liveSession = session;
        sessionState.ownedHandle.markSettling();
        const disposeResult = await settleWithin("dispose", SESSION_CLEANUP_GRACE_MS, async () => {
          await liveSession.dispose();
        });
        if (!disposeResult.ok) {
          sessionState.terminal.latch("cleanup_failed");
          markCleanupUnknown(sessionState);
          sessionState.ownedHandle.markUnconfirmed("SDK session dispose did not complete within the cleanup deadline.");
        } else {
          sessionState.ownedHandle.release();
        }
        this.activeSessions.delete(liveSession);
      } else if (ownedHandle) {
        if (creationOutcomeUnknown) {
          ownedHandle.markUnconfirmed("SDK session creation outcome is unknown after the deadline.");
        } else {
          ownedHandle.release();
        }
      }
    }
    const postCleanup = terminalResult();
    if (postCleanup) return postCleanup;
    return finalResult || {
      success: false,
      summary: "",
      tokensUsed: 0,
      filesProduced: [],
      errorMessage: "Sub-agent execution finished without a terminal result",
    };
  }

  private async runSdkStageWithinDeadline(
    deadline: DeadlineWindow,
    stage: "reload" | "create",
    action: () => Promise<void> | Promise<{ session: AgentSession }>,
  ): Promise<any> {
    return await runWithDeadline(stage, deadline, async () => await action());
  }

  private async createSdkSessionWithinDeadline(
    deadline: DeadlineWindow,
    options: CreateAgentSessionOptions,
    ownedHandle: OwnedHandleLease,
  ): Promise<{ session: AgentSession }> {
    const creation = createAgentSession(options);
    try {
      return await runWithDeadline("create", deadline, creation);
    } catch (error) {
      if (error instanceof DeadlineExceededError) {
        void creation.then(async created => {
          const disposed = await settleWithin("late-create-dispose", SESSION_CLEANUP_GRACE_MS, async () => {
            await created.session.dispose();
          });
          if (disposed.ok) releaseLateSdkHandle(ownedHandle);
        }).catch(() => { releaseLateSdkHandle(ownedHandle); });
      }
      throw error;
    }
  }

  private stopActiveSession(
    session: AgentSession,
    state: ActiveSessionState,
    cause: "timeout" | "emergency_stop",
  ): Promise<void> {
    state.terminal.latch(cause);
    state.ownedHandle.markSettling();
    state.notifyInterrupted();
    state.abortAttempt ??= settleWithin("abort", SESSION_CLEANUP_GRACE_MS, async () => {
      await session.abort();
    }).then(result => {
      if (!result.ok) markCleanupUnknown(state);
    });
    return state.abortAttempt;
  }

  private async runSdkPromptWithinDeadline(
    deadline: DeadlineWindow,
    session: AgentSession,
    sessionState: ActiveSessionState,
    promptText: string,
  ): Promise<void> {
    try {
      await Promise.race([
        runWithDeadline("prompt", deadline, async () => {
          await session.prompt(promptText, { source: "extension" });
        }),
        sessionState.interrupted,
      ]);
    } catch (error) {
      if (!(error instanceof DeadlineExceededError)) throw error;
      await this.stopActiveSession(session, sessionState, "timeout");
    }
    if (sessionState.terminal.current().cause) {
      await sessionState.abortAttempt;
    }
  }

  private estimateCost(tokens: number, _model: string): number {
    return tokens * 0.000001; // rough estimate
  }
}

function releaseLateSdkHandle(ownedHandle: OwnedHandleLease): void {
  if (ownedHandle.snapshot().state === "unconfirmed") {
    getOwnedHandleRegistry().acknowledge(ownedHandle.id);
    return;
  }
  ownedHandle.release();
}
