/**
 * =============================================================================
 * Canvast — Harness Control-Plane Wiring / 控制面接线
 * =============================================================================
 * @file        extensions/canvast-harness.ts
 * @brief       Wires the Canvast harness control planes (Canvas scoping, Plan
 *              constraints, context budgeting, capOrSpill) into pi's hooks.
 * @description Runtime wiring from docs/architecture/canvas-and-traceability.md
 *              and docs/architecture/runtime-orchestration.md. Registers `before_agent_start`
 *              to inject the Canvas Scoped View assembled by createCanvasScopingHarness,
 *              `tool_call` to enforce the active Plan's scope bounds via
 *              checkPlanScope, and `tool_result` to cap-or-spill oversized tool
 *              output (Step 2-A). State is shared with canvast-core.ts through
 *              the same persisted `canvas-graph.json` — this extension re-imports
 *              the graph before every agent start so in-session `canvas_record`
 *              calls are reflected in the scoped view.
 *
 *              pi 扩展接线：把 Canvas 作用域组装、计划约束、上下文预算、统一输出
 *              封顶（capOrSpill）四个控制面挂到 pi 的 before_agent_start /
 *              tool_call / tool_result 钩子上。将通过 canvast-core 落盘的
 *              canvas-graph.json 二次载入 src/graph 的 CanvasStore，保证每次
 *              agent 启动前都拿到最新图画布。
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * Changes: [2026-08-15] Initial wiring — harness control planes into pi hooks
 *          [2026-08-15] Step 2-A: wire capOrSpill tool_result hook + budget system
 * =============================================================================
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "fs";
import * as path from "path";

import {
  currentProjectRoot,
  ensureNativeLocalSearchTools,
  registerHarnessSearchTools,
  setActiveProjectRoot,
} from "./canvast-harness/search-tools.js";
import { createHarnessProjectLifecycleOwner } from "./canvast-harness/project-lifecycle-owner.js";
import { registerAutoOrchestrationTool } from "./canvast-harness/auto-orchestration-tool.js";
import { CanvasStore } from "../src/graph/canvas-store.js";
import {
  inspectSubAgentCapacity,
  releaseSubAgentCapacity,
  reserveSubAgentCapacity,
} from "../src/agents/sub-agent-capacity.js";
import { createHarnessBudgetLifecycle } from "../src/harness/budget-lifecycle.js";
import {
  projectSidecarDispatchRecord,
  registerSidecarDispatchTool,
} from "../src/harness/sidecar-dispatch-tool.js";
import { registerHarnessDesktopActionHandlers } from "../src/desktop-action/live-handlers.js";
import { createCanvasScopingHarness } from "../src/harness/canvas-scoping.js";
import { createCapOrSpillHarness, SpillStore, WallClockBudget } from "../src/harness/cap-or-spill.js";
import { createCanvastModeController, normalizeCanvastMode } from "../src/harness/canvast-mode.js";
import { createProjectScopeController } from "../src/harness/canvast-project-scope.js";
import { renderContextRecallManifest } from "../src/harness/context-recall.js";
import { assessPromptIntent, hasAny, LOCAL_SCAN_TERMS } from "../src/harness/intent-signals.js";
import {
  appendCanvastIdentityPrompt,
  enforceCanvastInternalInfoBoundary,
} from "../src/harness/product-identity.js";
import { recordOrchestrationPlanTree } from "../src/harness/runtime-plan-tree.js";
import {
  createSidecarOrchestrationController,
  registerSidecarOrchestrationHooks,
} from "../src/harness/sidecar-orchestration.js";
import { readSafeJson } from "../src/harness/safe-json-file.js";
import {
  clearRuntimeBatchStage,
  inspectRuntimeBatchStage,
  publishRuntimeBatchDecision,
  runtimeBatchEventScope,
} from "../src/harness/runtime-batch-bridge.js";

/** Persisted graph file written by canvast-core.ts (same storage contract). */
function graphFile(agentDir: string): string {
  return path.join(agentDir, "canvas-graph.json");
}

interface GraphLoadCache {
  mtimeByFile: Map<string, number>;
  healthError?: string;
}

/**
 * Load the persisted Canvas graph into a src/graph CanvasStore (the control-plane
 * store with assembleScope). Returns false when nothing was persisted yet.
 *
 * Runs on EVERY tool_call hook, so it is mtime-cached: the JSON is only
 * re-read and re-parsed when the file actually changed (2026-08-15
 * adversarial-review fix — previously blocked the event loop on every call).
 * @returns 是否成功载入已持久化的图画布
 */
function loadPersisted(store: CanvasStore, agentDir: string, cache: GraphLoadCache): boolean {
  const file = graphFile(agentDir);
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) {
      cache.healthError = "Canvas graph must be a regular non-symlink file.";
      return false;
    }
    const lastMtime = cache.mtimeByFile.get(file) || 0;
    if (st.mtimeMs <= lastMtime && !cache.healthError) return true;
    const loaded = readSafeJson<{ nodes?: unknown[]; edges?: unknown[] }>(file, true);
    if (loaded.status === "missing") {
      cache.healthError = undefined;
      return false;
    }
    if (loaded.status === "corrupt") {
      cache.healthError = `Canvas graph is corrupt: ${loaded.error}`;
      return false;
    }
    if (!Array.isArray(loaded.value.nodes) || !Array.isArray(loaded.value.edges)) {
      cache.healthError = "Canvas graph has an invalid schema.";
      return false;
    }
    store.import({ nodes: loaded.value.nodes as any[], edges: loaded.value.edges as any[] });
    cache.mtimeByFile.set(file, st.mtimeMs);
    cache.healthError = loaded.source === "last-known-good"
      ? "Canvas primary graph was corrupt; last-known-good state is loaded."
      : undefined;
    return loaded.source === "primary";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    cache.healthError = `Canvas graph load failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  return false;
}

function taskDeadlineFromEnv(): WallClockBudget | undefined {
  const raw = process.env.CANVAST_TASK_DEADLINE_MS;
  if (!raw) return undefined;
  const deadlineMs = Number(raw);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) return undefined;
  return new WallClockBudget(deadlineMs);
}

function localSearchHygienePrompt(prompt: string): string {
  const signals = assessPromptIntent(prompt);
  if (!signals.localScanLike && !hasAny(signals.intentText, ["todo", "import", ".ts", "local_file", ...LOCAL_SCAN_TERMS])) return "";
  return [
    "## Canvast Local Search Hygiene",
    "For local search/list/read tasks, prefer native project tools (`content_search`, `grep`, `find`, `ls`, `read`) and avoid broad recursive shell scans.",
    "When the user asks for files containing text, use `content_search` with `output: \"files\"`, extensions, and bounded roots so the result is a unique file list without Bash.",
    "For multiple literal terms, use one `content_search` call with `queries`, `extensions`, and `case_sensitive: false` when appropriate; use `grep` only for bounded snippets and do not switch to Bash just because a grep result limit is reached.",
    "If using bash search as an explicitly planned fallback, bound output and exclude generated/dependency directories: node_modules, .runtime, .git, dist, build, coverage.",
    "Examples: use `content_search` for files containing literal text, `grep` with a path/glob/limit for small snippets, `find` with `path: \"src\"` + `pattern: \"*.ts\"` or directly `pattern: \"src/**/*.ts\"` for file discovery, `ls` for directory listing, and `read` with offset/limit for small snippets.",
    "Do not run broad commands like `grep -rn pattern .` unless the user explicitly asks to include generated/dependency directories.",
    "中文：本地搜索优先使用原生 `content_search`、`grep`、`find`、`ls`、`read` 工具；需要“包含某文本的文件列表”时用 `content_search` 的 files 输出；多字面量搜索用一次 `content_search` 的 `queries` + `extensions` + 适当的 `case_sensitive:false`；`grep` 只用于有界小片段，不能因为 grep 到达 limit 就切 Bash；shell 搜索只能作为已显式规划的有界兜底，默认排除 node_modules、.runtime、.git、dist、build、coverage；不要直接 `grep -rn ... .` 扫全仓库。",
  ].join("\n");
}

function promptLocalCodeAnalysisPrompt(prompt: string): string {
  const signals = assessPromptIntent(prompt);
  if (!signals.promptLocalCodeAnalysis) return "";
  return [
    "## Canvast Prompt-Local Code Analysis",
    "The user provided the relevant code or logic in the prompt. Analyze that snippet and stated requirement directly.",
    "Do not inspect, search, list, or read repository files unless the user explicitly asks for local project evidence.",
    "中文：用户已在 prompt 中提供代码片段时，直接基于片段和需求分析；除非用户明确要求查本地仓库，否则不要搜索、列目录或读取项目文件。",
  ].join("\n");
}

function standaloneAdvisoryPrompt(prompt: string): string {
  const signals = assessPromptIntent(prompt);
  if (!signals.standaloneAdvisoryIntent) return "";
  return [
    "## Canvast Standalone Advisory Answer",
    "The user is asking a self-contained advisory, architecture, comparison, or recommendation question.",
    "Answer from the prompt constraints and general engineering knowledge when the claims are stable. Do not inspect, search, list, or read repository files unless the user explicitly asks to relate the answer to this local project.",
    "If the answer needs current external facts, official authorization, local business status, availability/status, price/market facts, route_or_transit facts, or other external source-of-record claims, first record a typed `grounding_strategy` and use authoritative evidence. If evidence cannot be obtained, say what is unverified instead of giving specific memory-only facts.",
    "中文：用户在问自足的咨询/架构/选型/对比/推荐问题时，稳定知识可直接基于 prompt 约束和通用工程知识回答；除非用户明确要求结合本地项目，否则不要搜索、列目录或读取仓库文件。",
    "但如果答案依赖当前外部事实、官方授权、本地商家状态、可用性/状态、价格/市场、route_or_transit 或其他外部主来源事实，先记录结构化 `grounding_strategy` 并使用权威证据；拿不到证据时说明未验证，不要凭记忆输出具体事实。",
  ].join("\n");
}

function normalizeToolCallEvent(event: any): any {
  const toolName = event?.toolName || event?.tool_name || event?.name;
  const input = event?.input || event?.args || event?.arguments;
  if (toolName === event?.toolName && input === event?.input) return event;
  return {
    ...event,
    toolName,
    input,
  };
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    let dir = path.dirname(resolved);
    const missing = [path.basename(resolved)];
    while (dir && path.dirname(dir) !== dir && !fs.existsSync(dir)) {
      missing.unshift(path.basename(dir));
      dir = path.dirname(dir);
    }
    try {
      const realParent = fs.realpathSync.native(dir);
      return path.join(realParent, ...missing);
    } catch {
      return resolved;
    }
  }
}

export default function (pi: ExtensionAPI) {
  const batchScope = runtimeBatchEventScope(pi);
  const publishBatchDecision = (decision: Parameters<typeof publishRuntimeBatchDecision>[1]): boolean =>
    batchScope ? publishRuntimeBatchDecision(batchScope, decision) : decision.batchPlan === undefined;
  // Same agent dir convention as canvast-core.ts (~/.canvast or $PI_CODING_AGENT_DIR).
  let activeAgentDir =
    process.env.PI_CODING_AGENT_DIR ||
    path.join(process.env.HOME || "/tmp", ".canvast");
  activeAgentDir = canonicalPath(activeAgentDir);
  const initialProjectRoot = canonicalPath(currentProjectRoot());
  setActiveProjectRoot(initialProjectRoot);
  fs.mkdirSync(activeAgentDir, { recursive: true });
  registerHarnessSearchTools(pi);

  const store = new CanvasStore();
  const graphCache: GraphLoadCache = { mtimeByFile: new Map() };
  const harness = createCanvasScopingHarness(store);
  const modeController = createCanvastModeController(activeAgentDir);
  const projectScopeRoot = initialProjectRoot;
  const canPersistCanvastState = process.env.CANVAST_PERSISTENCE_MODE !== "ephemeral";
  const agentDir = () => activeAgentDir;
  let projectScope = createProjectScopeController(agentDir(), projectScopeRoot, new Date().toISOString(), {
    persist: canPersistCanvastState,
  });
  const applyActivatedProject = (next: { projectRoot: string; agentDir: string }) => {
    const nextProjectRoot = canonicalPath(next.projectRoot);
    const nextAgentDir = canonicalPath(next.agentDir);
    fs.mkdirSync(nextAgentDir, { recursive: true });
    autoOrchestration.rebindProject(nextAgentDir);
    activeAgentDir = nextAgentDir;
    setActiveProjectRoot(nextProjectRoot);
    store.import({ nodes: [], edges: [] });
    graphCache.mtimeByFile.clear();
    graphCache.healthError = undefined;
    harness.setActivePlan("");
    harness.setCurrentTask("");
    projectScope.rebind(nextProjectRoot, "auto");
    if (projectScope.inspect(nextProjectRoot).canLoadCanvas) {
      loadPersisted(store, agentDir(), graphCache);
    }
    autoOrchestration.reconcilePersistedDispatches();
  };
  const capOrSpill = createCapOrSpillHarness({
    spillStore: new SpillStore(path.join(agentDir(), "spill")),
    wallClock: taskDeadlineFromEnv(),
  });
  const budgetLifecycle = createHarnessBudgetLifecycle({
    turnBudget: capOrSpill.turnBudget,
    wallClock: capOrSpill.wallClock,
  });
  const autoOrchestration = createSidecarOrchestrationController({
    agentDir: () => activeAgentDir,
    resolveDispatchRuntime: () => {
      const capacity = inspectSubAgentCapacity(pi as object);
      const budget = budgetLifecycle.inspect();
      return {
        availableChildSlots: capacity?.accepting ? capacity.availableChildSlots : 0,
        budgetAvailable: !budget.pendingWindDown &&
          budget.turnBudget.remaining > 0 &&
          budget.wallClock?.exhausted !== true,
        // Current spawn_agent/parallel_agents calls await their children.
        // Do not advertise primary/sidecar overlap until a durable async owner,
        // receipt, join, cancellation, and crash-recovery path exists.
        asyncDispatchAvailable: false,
      };
    },
    reserveDispatchCapacity: (reservationId, slots, dispatch) =>
      reserveSubAgentCapacity(pi as object, reservationId, slots, dispatch),
    releaseDispatchCapacity: reservationId =>
      releaseSubAgentCapacity(pi as object, reservationId),
    onDispatchUpdate: record => projectSidecarDispatchRecord(activeAgentDir, record),
    resolveRuntimeBatch: identity => {
      const stage = batchScope ? inspectRuntimeBatchStage(batchScope) : undefined;
      return stage && stage.batchId === identity.batchId && stage.revision === identity.revision &&
        stage.checkpoint === identity.checkpoint ? stage : undefined;
    },
    onProjectRebind: () => {
      const stage = batchScope ? inspectRuntimeBatchStage(batchScope) : undefined;
      if (stage && batchScope) clearRuntimeBatchStage(batchScope, stage.batchId);
    },
  });
  registerSidecarDispatchTool(pi, autoOrchestration);
  autoOrchestration.reconcilePersistedDispatches();

  pi.on("message_end", async (event: any) => {
    autoOrchestration.onMessageEnd(event?.message);
    const guarded = enforceCanvastInternalInfoBoundary(event?.message);
    return guarded.redacted ? { message: guarded.message } : undefined;
  });

  registerSidecarOrchestrationHooks(pi, autoOrchestration, {
    isEnhanced: () => modeController.isEnhanced(),
    projectDecision: (decision, source) => recordOrchestrationPlanTree(agentDir(), decision, { source }),
  });
  const projectLifecycle = createHarnessProjectLifecycleOwner({
    installUrl: import.meta.url,
    args: process.argv.slice(2),
    onDidActivateProject: paths => applyActivatedProject({
      projectRoot: paths.projectRoot,
      agentDir: paths.agentDir,
    }),
  });
  if (projectScope.inspect().canLoadCanvas) loadPersisted(store, agentDir(), graphCache);
  registerHarnessDesktopActionHandlers(pi, {
    store,
    harness,
    modeController,
    projectScope,
    projectLifecycle,
    currentProjectRoot,
    reloadCanvas: () => loadPersisted(store, agentDir(), graphCache),
  });

  pi.on("session_start", async (event: any) => {
    ensureNativeLocalSearchTools(pi);
    const reason = String(event?.reason || "");
    if (reason === "new" || reason === "fork") budgetLifecycle.resetBudgets();
  });

  // ─── capOrSpill + budget system (docs/architecture/runtime-orchestration.md) ───
  // Oversized tool results are spilled to <agentDir>/spill; the default
  // wall-clock deadline comes from CANVAST_TASK_DEADLINE_MS when provided.
  // ─── Tool: record automatic orchestration + tool strategy ───────────────
  registerAutoOrchestrationTool(pi, {
    controller: autoOrchestration,
    publishDecision: publishBatchDecision,
    projectDecision: decision => recordOrchestrationPlanTree(agentDir(), decision),
  });
  /* Legacy inline definition retained nowhere: the extracted module keeps this
     production entrypoint below the source-file budget while preserving API. */
  /*
  pi.registerTool({
    name: "auto_orchestration_decision",
    label: "Auto Orchestration Decision / 自动编排决策",
    description:
      "Record the automatic plan/sub-agent/workflow decision and coordinated tool strategy before mutating, web, sub-agent, or workflow tools. Web is conditional and requires a concrete reason. / 在修改、联网、子 agent 或 workflow 前记录自动规划与工具协调策略。联网不是默认动作，必须有具体理由。",
    parameters: Type.Object({
      mode: Type.Union([
        Type.Literal("direct"),
        Type.Literal("plan"),
        Type.Literal("subagents"),
        Type.Literal("workflow"),
      ]),
      lifecycle_action: Type.Optional(Type.Union([
        Type.Literal("enter"),
        Type.Literal("update"),
        Type.Literal("switch"),
        Type.Literal("exit"),
      ])),
      task_summary: Type.String({ description: "Concise user-facing task summary / 面向用户的任务摘要" }),
      rationale: Type.String({ description: "Short external rationale, not private chain-of-thought / 简短外部理由，不包含私有思维链" }),
      observable_reasoning_summary: Type.Optional(Type.Array(Type.String({
        description: "Visible reasoning/process summary; do not include hidden chain-of-thought / 可观察推理与过程摘要，不包含隐藏思维链",
      }))),
      plan_steps: Type.Optional(Type.Array(Type.String())),
      subagent_tasks: Type.Optional(Type.Array(Type.String())),
      workflow_steps: Type.Optional(Type.Array(Type.String())),
      scope_files: Type.Optional(Type.Array(Type.String())),
      tool_call_plan: Type.Optional(Type.Array(Type.Object({
        domain: Type.Union([
          Type.Literal("local_search"),
          Type.Literal("file_read"),
          Type.Literal("file_write"),
          Type.Literal("shell"),
          Type.Literal("web"),
          Type.Literal("task"),
          Type.Literal("agent"),
          Type.Literal("workflow"),
          Type.Literal("canvas"),
          Type.Literal("test"),
          Type.Literal("review"),
          Type.Literal("monitor"),
          Type.Literal("package"),
          Type.Literal("tui"),
        ]),
        tools: Type.Array(Type.String()),
        purpose: Type.String(),
        order: Type.Union([
          Type.Literal("before_edit"),
          Type.Literal("during_edit"),
          Type.Literal("after_edit"),
          Type.Literal("as_needed"),
        ]),
        parallel_safe: Type.Boolean(),
        web_justification: Type.Optional(Type.String()),
      }))),
      verification_steps: Type.Optional(Type.Array(Type.String())),
      web_use: Type.Optional(Type.Union([
        Type.Literal("not_needed"),
        Type.Literal("conditional"),
        Type.Literal("required"),
      ])),
      web_justification: Type.Optional(Type.String()),
      dependency_audit: Type.Optional(Type.Object({
        isolated_cache_verified: Type.Optional(Type.Boolean()),
      })),
      local_evidence_used: Type.Optional(Type.Boolean()),
      grounding_strategy: Type.Optional(Type.Object({
        requirements: Type.Array(Type.Object({
          kind: literalUnion(GROUNDING_FACT_KINDS),
          claim: Type.String(),
          freshness: literalUnion(GROUNDING_FRESHNESS),
          source_kinds: Type.Array(literalUnion(GROUNDING_SOURCE_KINDS)),
        })),
        preferred_sources: Type.Array(literalUnion(GROUNDING_SOURCE_KINDS)),
        minimum_sources: Type.Number(),
        max_external_calls: Type.Optional(Type.Number()),
        allow_memory_only: Type.Boolean(),
        unavailable_policy: literalUnion(GROUNDING_UNAVAILABLE_POLICIES),
        correction_policy: literalUnion(GROUNDING_CORRECTION_POLICIES),
      })),
      context_strategy: Type.Optional(Type.Object({
        history_policy: Type.Union([
          Type.Literal("recent_window"),
          Type.Literal("compact"),
          Type.Literal("recall"),
          Type.Literal("resume"),
        ]),
        compression_trigger: Type.String(),
        recall_sources: Type.Array(Type.String()),
        resume_plan: Type.Array(Type.String()),
        input_sources: Type.Optional(Type.Array(Type.Object({
          kind: Type.Union([
            Type.Literal("session_recent"),
            Type.Literal("harness_controls"),
            Type.Literal("canvas_scope"),
            Type.Literal("context_recall"),
            Type.Literal("long_term_memory"),
            Type.Literal("tools_skills"),
            Type.Literal("task_files"),
          ]),
          budget: Type.String(),
          provenance: Type.String(),
          inject_policy: Type.Union([
            Type.Literal("inline"),
            Type.Literal("manifest"),
            Type.Literal("pointer"),
            Type.Literal("on_demand"),
            Type.Literal("none"),
          ]),
        }))),
      })),
      batch_plan: Type.Optional(Type.Object({
        batch_id: Type.String(),
        revision: Type.Integer({ minimum: 0 }),
        checkpoint: Type.Union([
          Type.Literal("on_tool_success"),
          Type.Literal("on_tool_error"),
          Type.Literal("on_turn_settle"),
          Type.Literal("on_plan_approved"),
          Type.Literal("on_workflow_stage"),
        ]),
        candidate_hash: Type.String(),
        admitted_at: Type.String(),
        items: Type.Array(Type.Object({
          id: Type.String(),
          request_id: Type.String(),
          sequence: Type.Integer({ minimum: 0 }),
          timestamp: Type.String(),
          status: Type.Union([Type.Literal("queued"), Type.Literal("interrupt"), Type.Literal("deferred")]),
          policy: Type.Union([
            Type.Literal("supersede_merge"),
            Type.Literal("amend_current"),
            Type.Literal("parallel_independent"),
            Type.Literal("serial_after_current"),
            Type.Literal("defer"),
            Type.Literal("pause"),
            Type.Literal("cancel"),
          ]),
          relation: Type.Object({
            target_task_id: Type.Optional(Type.String()),
            dependency_ids: Type.Optional(Type.Array(Type.String())),
            priority: Type.Optional(Type.Integer()),
          }),
          defer_info: Type.Optional(Type.Object({
            reason_code: Type.String(),
            blocker_task_ids: Type.Array(Type.String()),
            reevaluate_at: Type.Union([
              Type.Literal("on_tool_success"), Type.Literal("on_tool_error"),
              Type.Literal("on_turn_settle"), Type.Literal("on_plan_approved"),
              Type.Literal("on_workflow_stage"),
            ]),
          })),
        })),
      })),
    }),
    async execute(_id: string, params: any): Promise<any> {
      const result = autoOrchestration.record({
        mode: params.mode,
        lifecycleAction: params.lifecycle_action,
        taskSummary: String(params.task_summary || ""),
        rationale: String(params.rationale || ""),
        observableReasoningSummary: params.observable_reasoning_summary || [],
        planSteps: params.plan_steps || [],
        subagentTasks: params.subagent_tasks || [],
        workflowSteps: params.workflow_steps || [],
        scopeFiles: params.scope_files || [],
        toolCallPlan: (params.tool_call_plan || []).map((item: any) => ({
          domain: item.domain,
          tools: item.tools || [],
          purpose: String(item.purpose || ""),
          order: item.order || "as_needed",
          parallelSafe: item.parallel_safe === true,
          webJustification: item.web_justification,
        })),
        verificationSteps: params.verification_steps || [],
        webUse: params.web_use || "not_needed",
        webJustification: params.web_justification,
        dependencyAudit: params.dependency_audit
          ? {
              isolatedCacheVerified: params.dependency_audit.isolated_cache_verified === true,
            }
          : undefined,
        groundingStrategy: normalizeGroundingStrategyParam(
          params.grounding_strategy,
          autoOrchestration.assessment?.webUsePolicy,
          params.web_use || "not_needed",
        ),
        localEvidenceUsed: params.local_evidence_used,
        contextStrategy: params.context_strategy
          ? {
              historyPolicy: params.context_strategy.history_policy,
              compressionTrigger: String(params.context_strategy.compression_trigger || ""),
              recallSources: params.context_strategy.recall_sources || [],
              resumePlan: params.context_strategy.resume_plan || [],
              inputSources: Array.isArray(params.context_strategy.input_sources)
                ? params.context_strategy.input_sources.map((source: any) => ({
                    kind: source.kind,
                    budget: String(source.budget || ""),
                    provenance: String(source.provenance || ""),
                    injectPolicy: source.inject_policy || "manifest",
                  }))
                : undefined,
            }
          : undefined,
        batchPlan: params.batch_plan
          ? {
              batchId: String(params.batch_plan.batch_id || ""),
              revision: Number(params.batch_plan.revision),
              checkpoint: params.batch_plan.checkpoint,
              candidateHash: String(params.batch_plan.candidate_hash || ""),
              admittedAt: String(params.batch_plan.admitted_at || ""),
              items: (params.batch_plan.items || []).map((item: any) => ({
                id: String(item.id || ""),
                requestId: String(item.request_id || ""),
                sequence: Number(item.sequence),
                timestamp: String(item.timestamp || ""),
                status: item.status,
                policy: item.policy,
                relation: {
                  targetTaskId: item.relation?.target_task_id,
                  dependencyIds: item.relation?.dependency_ids || [],
                  priority: item.relation?.priority,
                },
                deferInfo: item.defer_info
                  ? {
                      reasonCode: String(item.defer_info.reason_code || ""),
                      blockerTaskIds: item.defer_info.blocker_task_ids || [],
                      reevaluateAt: item.defer_info.reevaluate_at,
                    }
                  : undefined,
              })),
            }
          : undefined,
      });

      if (!result.ok) {
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: `Automatic orchestration decision rejected:\n- ${result.errors.join("\n- ")}`,
          }],
          details: { errors: result.errors, assessment: autoOrchestration.assessment },
        };
      }

      const d = result.decision;
      if (!publishBatchDecision(d)) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: "Automatic orchestration decision rejected: the batch coordinator is unavailable; no queue transition was committed." }],
          details: { errors: ["batch coordinator unavailable"], assessment: autoOrchestration.assessment },
        };
      }
      recordOrchestrationPlanTree(agentDir(), d);
      const planLines = d.toolCallPlan.map((item, i) =>
        `${i + 1}. ${item.domain}: ${item.tools.join(", ") || "n/a"} — ${item.purpose}`,
      ).join("\n");
      return {
        content: [{
          type: "text" as const,
          text: [
            `# Auto Orchestration Recorded`,
            `mode=${d.mode}`,
            d.lifecycleAction ? `lifecycle_action=${d.lifecycleAction}` : "",
            `assessment=${d.assessmentId}`,
            `web_use=${d.webUse}`,
            d.dependencyAudit ? `dependency_audit.isolated_cache_verified=${d.dependencyAudit.isolatedCacheVerified === true}` : "",
            d.localEvidenceUsed === undefined ? "" : `local_evidence_used=${d.localEvidenceUsed}`,
            d.contextStrategy ? `context=${d.contextStrategy.historyPolicy}` : "",
            "",
            "## Observable Reasoning Summary",
            d.observableReasoningSummary.map((s, i) => `${i + 1}. ${s}`).join("\n") || "(none)",
            "",
            "## Tool Strategy",
            planLines || "(no tool plan)",
            "",
            "## Context Strategy",
            d.contextStrategy
              ? [
                  `history_policy=${d.contextStrategy.historyPolicy}`,
                  `compression_trigger=${d.contextStrategy.compressionTrigger}`,
                  `recall_sources=${d.contextStrategy.recallSources.join(", ")}`,
                  `resume_plan=${d.contextStrategy.resumePlan.join(" -> ")}`,
                ].join("\n")
              : "(recent window only)",
            "",
            "## Verification",
            d.verificationSteps.map((s, i) => `${i + 1}. ${s}`).join("\n") || "(none)",
          ].join("\n"),
        }],
        details: { decision: d, assessment: autoOrchestration.assessment },
      };
    },
  });
  */

  pi.registerTool({
    name: "canvast_mode",
    label: "Canvast Mode / Canvast模式",
    description:
      "Inspect or switch Canvast runtime mode. parity disables enhanced harness injection/gates for baseline behavior; enhanced enables Canvas/orchestration/task-tree controls. / 查看或切换 Canvast 运行模式：parity 关闭增强控制面，enhanced 开启 Canvas/编排/任务树控制面。",
    parameters: Type.Object({
      action: Type.Optional(Type.Union([
        Type.Literal("status"),
        Type.Literal("set"),
      ])),
      mode: Type.Optional(Type.Union([
        Type.Literal("parity"),
        Type.Literal("enhanced"),
      ])),
      scope: Type.Optional(Type.Union([
        Type.Literal("session"),
        Type.Literal("turn"),
      ])),
      reason: Type.Optional(Type.String()),
    }),
    async execute(_id: string, params: any): Promise<any> {
      const action = params.action || (params.mode ? "set" : "status");
      if (action === "status") {
        return { content: [{ type: "text" as const, text: modeController.renderStatus() }], details: { state: modeController.getState(), effectiveMode: modeController.getEffectiveMode() } };
      }
      const mode = normalizeCanvastMode(params.mode);
      if (!mode) {
        return { isError: true, content: [{ type: "text" as const, text: "mode must be parity or enhanced" }], details: undefined };
      }
      const scope = params.scope || "session";
      if (scope === "turn") modeController.setTurnMode(mode, params.reason || "Tool-requested one-turn Canvast mode override.");
      else modeController.setMode(mode, "tool", params.reason || "Tool-requested Canvast mode switch.");
      return { content: [{ type: "text" as const, text: modeController.renderStatus() }], details: { state: modeController.getState(), effectiveMode: modeController.getEffectiveMode(), scope } };
    },
  });

  // ─── Hook: inject Canvas Scoped View at agent start ─────────────────────
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    const toolsChanged = ensureNativeLocalSearchTools(pi);
    // Opportunistic spill-store GC once per agent start so spill files do
    // not accumulate unbounded in long-lived sessions.
    // 每次 agent 启动顺带清理溢出文件，防止长会话无限堆积。
    try { capOrSpill.spillStore.gc(); } catch { /* best effort */ }

    // Re-import the latest persisted graph so in-session canvas_record calls
    // (written by canvast-core) are visible to the scoped view.
    const scopeDecision = projectScope.inspect(currentProjectRoot());
    if (scopeDecision.canLoadCanvas) loadPersisted(store, agentDir(), graphCache);
    const canvasHealthNotice = graphCache.healthError
      ? [
          "## Canvas Persistence Health Failure",
          graphCache.healthError,
          "Persisted Canvas scope is unavailable and must not be inferred from an empty graph.",
        ].join("\n")
      : "";

    const prompt = String(event?.prompt || "");
    modeController.beginTurn(prompt);
    if (!modeController.isEnhanced()) {
      autoOrchestration.beginPrimary("");
      const basePrompt =
        (toolsChanged ? ctx?.getSystemPrompt?.() : undefined) ||
        event?.systemPrompt ||
        ctx?.getSystemPrompt?.() ||
        "";
      return { systemPrompt: appendCanvastIdentityPrompt(basePrompt) };
    }
    if (!autoOrchestration.resumeRestoredPrimary()) autoOrchestration.beginPrimary(prompt);

    // The Canvas scoped view is optional; the auto-orchestration gate is not
    // task-node dependent and can trigger for any complex user prompt.
    const scoped = scopeDecision.canInjectScopedView && !graphCache.healthError
      ? await harness.onAgentStart(event, ctx ?? {})
      : undefined;
    const autoPrompt = autoOrchestration.renderPrompt();
    const searchPrompt = localSearchHygienePrompt(prompt);
    const promptLocalPrompt = promptLocalCodeAnalysisPrompt(prompt);
    const advisoryPrompt = standaloneAdvisoryPrompt(prompt);
    const existingContextText = [
      scoped?.systemPrompt || "",
      event?.systemPrompt || "",
      ctx?.getSystemPrompt?.() || "",
    ].join("\n");
    const recallPrompt = renderContextRecallManifest(agentDir(), prompt, {
      excludeText: existingContextText,
      tokenBudget: 900,
      limit: 4,
      onSelection: result => {
        const sourceId = process.env.CANVAST_EVAL_TELEMETRY_SOURCE_ID;
        const runId = process.env.CANVAST_EVAL_TELEMETRY_RUN_ID;
        if (!sourceId || !runId) return;
        process.stdout.write(`${JSON.stringify({
          type: "canvast_telemetry",
          telemetry: {
            kind: "recall",
            sourceId,
            runId,
            queryId: `${runId}/project-recall`,
            ...result,
            measurement: "observed",
            trusted: true,
          },
        })}\n`);
      },
    });
    const scopeNotice = scopeDecision.canInjectScopedView ? "" : [
      "## Canvast Project Scope Notice",
      scopeDecision.advisory,
      "Old Canvas is not automatically injected; it is available only as history until /canvast-project rebind confirms this project root.",
    ].join("\n");
    if (!autoPrompt && !searchPrompt && !promptLocalPrompt && !advisoryPrompt && !recallPrompt && !scopeNotice && !canvasHealthNotice) {
      const basePrompt = scoped?.systemPrompt || event?.systemPrompt || ctx?.getSystemPrompt?.() || "";
      return { ...(scoped || {}), systemPrompt: appendCanvastIdentityPrompt(basePrompt) };
    }

    const basePrompt =
      scoped?.systemPrompt ||
      (toolsChanged ? ctx?.getSystemPrompt?.() : undefined) ||
      event?.systemPrompt ||
      ctx?.getSystemPrompt?.() ||
      "";
    return {
      ...(scoped || {}),
      systemPrompt: `${appendCanvastIdentityPrompt(basePrompt)}\n\n${[canvasHealthNotice, scopeNotice, autoPrompt, searchPrompt, promptLocalPrompt, advisoryPrompt, recallPrompt].filter(Boolean).join("\n\n")}`,
    };
  });

  // ─── Hook: enforce automatic orchestration and Plan scope bounds ────────
  pi.on("turn_start", async (event: any) => {
    budgetLifecycle.onTurnStart(event);
  });

  pi.on("tool_call", async (event: any, _ctx: any) => {
    const budgetGate = budgetLifecycle.onToolCall(event);
    if (budgetGate?.block) return budgetGate;
    if (!modeController.isEnhanced()) return undefined;
    const normalizedEvent = normalizeToolCallEvent(event);
    const toolCallId = typeof normalizedEvent?.toolCallId === "string" ? normalizedEvent.toolCallId.trim() : "";
    const rollbackAdmission = (reason: string) => {
      if (!toolCallId) return;
      autoOrchestration.rollbackToolAdmission(toolCallId, reason);
    };
    const autoBlock = autoOrchestration.shouldBlock(normalizedEvent);
    if (autoBlock.block) return autoBlock;

    if (!projectScope.inspect(currentProjectRoot()).canLoadCanvas) return undefined;
    loadPersisted(store, agentDir(), graphCache);
    if (graphCache.healthError) {
      rollbackAdmission("canvas_scope_health_block");
      return {
        block: true,
        reason: `Canvas scope enforcement unavailable: ${graphCache.healthError}`,
      };
    }
    try {
      const scopedDecision = await harness.onToolCall(normalizedEvent, _ctx);
      if (scopedDecision?.block) rollbackAdmission("canvas_scope_block");
      return scopedDecision;
    } catch (error) {
      rollbackAdmission("canvas_scope_throw");
      throw error;
    }
  });

  // ─── Hook: cap-or-spill oversized tool results (Step 2-A) ───────────────
  pi.on("tool_result", async (event: any, ctx: any) => {
    return await capOrSpill.onToolResult(event, ctx);
  });

  // ─── Commands: set the active task / plan (selects the scoped view) ─────
  pi.registerCommand("canvas-task", {
    description:
      "Set the active Canvas task node. Its parent plan/decisions/files shape the Canvas Scoped View. / 设置当前任务节点，其父计划/决策/文件将构成 Canvas 作用域视图。",
    handler: async (args, ctx) => {
      const taskId = String(args || "").trim();
      if (!taskId) {
        ctx.ui?.notify("Usage: /canvas-task <nodeId>", "warning");
        return;
      }
      const node = store.getNode(taskId);
      if (!node) {
        ctx.ui?.notify(`No Canvas node with id "${taskId}".`, "error");
        return;
      }
      harness.setCurrentTask(taskId);
      ctx.ui?.notify(`Canvas current task → ${taskId}`, "info");
    },
  });

  pi.registerCommand("canvast-mode", {
    description:
      "Switch or inspect Canvast runtime mode: parity|enhanced|status. / 切换或查看 Canvast 运行模式：parity|enhanced|status。",
    handler: async (args, ctx) => {
      const raw = String(args || "").trim();
      if (!raw || /^status$/i.test(raw)) {
        ctx.ui?.notify(modeController.renderStatus(), "info");
        return;
      }
      const mode = normalizeCanvastMode(raw.split(/\s+/)[0]);
      if (!mode) {
        ctx.ui?.notify("Usage: /canvast-mode parity|enhanced|status", "warning");
        return;
      }
      modeController.setMode(mode, "command", "User switched Canvast mode with /canvast-mode.");
      ctx.ui?.notify(modeController.renderStatus(), "info");
    },
  });

  pi.registerCommand("canvast-project", {
    description:
      "Inspect or rebind Canvast project scope: status|rebind. / 查看或重绑定 Canvast 项目作用域。",
    handler: async (args, ctx) => {
      const raw = String(args || "").trim();
      if (/^rebind$/i.test(raw)) {
        projectScope.rebind(currentProjectRoot(), "command");
        loadPersisted(store, agentDir(), graphCache);
      }
      ctx.ui?.notify(projectScope.renderStatus(currentProjectRoot()), "info");
    },
  });

  pi.registerCommand("canvas-plan", {
    description:
      "Set the active approved Plan whose scope guides tool_call enforcement. / 设置作为 tool_call 约束依据的活动计划。",
    handler: async (args, ctx) => {
      const planId = String(args || "").trim();
      if (!planId) {
        ctx.ui?.notify("Usage: /canvas-plan <planId>", "warning");
        return;
      }
      const node = store.getNode(planId);
      if (!node) {
        ctx.ui?.notify(`No Canvas node with id "${planId}".`, "error");
        return;
      }
      harness.setActivePlan(planId);
      ctx.ui?.notify(`Active Plan for enforcement → ${planId}`, "info");
    },
  });

  // Make the wired harness inspectable by tests and other extensions.
  (pi as any).__canvast_harness = {
    store,
    setActivePlan: harness.setActivePlan,
    setCurrentTask: harness.setCurrentTask,
    onAgentStart: harness.onAgentStart,
    onToolCall: harness.onToolCall,
    autoOrchestration,
    sidecarOrchestration: autoOrchestration,
    modeController,
    projectScope,
    projectLifecycle,
    currentProjectRoot,
    agentDir,
    capOrSpill,
    budgetLifecycle,
    onToolResult: capOrSpill.onToolResult,
    consumeTurn: capOrSpill.consumeTurn,
  };
}
