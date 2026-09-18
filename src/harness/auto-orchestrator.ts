/**
 * =============================================================================
 * Canvast — Auto Orchestrator / Canvast 源文件
 * =============================================================================
 * @file        src/harness/auto-orchestrator.ts
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import {
  ORCHESTRATION_EXECUTION_GUIDANCE,
  ORCHESTRATION_EXECUTION_GUIDANCE_ZH,
} from "./orchestration-guidance.js";
import { groundingRequiresExternalEvidence } from "./grounding-policy.js";
import { hasDependencyInstallIntent } from "./tool-intent.js";
import {
  isNonMutatingBash,
  isReadOnlyBash,
  shellUsesNetworkFetch,
} from "./auto-orchestrator-shell.js";
import {
  renderPromptLocalValidationPrompt,
  shouldBlockPromptLocalValidationTool,
} from "./prompt-local-validation.js";
import {
  hasNoShellConstraint,
  isAgentLaunchTool,
  normalizeToolName,
  requiresParallelAgentsTool,
} from "./auto-orchestrator-constraints.js";
import { assessAutoOrchestration } from "./auto-orchestrator/assessment.js";
import {
  normalizeRecordedDecision,
  validateRecordedDecision,
} from "./auto-orchestrator/decision.js";
import { createOrchestrationToolLifecycle } from "./auto-orchestrator/tool-lifecycle.js";
import {
  defaultToolPlanItem,
  emergentStrategyDomain,
  FILE_MUTATING_TOOLS,
  formatDomainExamples,
  hasLocalSearchReadTool,
  hasPlanApprovalBoundary,
  isSandboxCommandGrant,
  ORCHESTRATION_TOOLS,
  SHELL_GRANT_TOOLS,
  STRATEGY_TOOLS,
  toolDomain,
  toolEventInput,
  toolEventName,
  toolPlanDomains,
} from "./auto-orchestrator/tool-strategy.js";
import type {
  AutoOrchestrationAssessment,
  OrchestrationExecutionState,
  OrchestrationLifecycleAction,
  RecordedOrchestrationDecision,
  ToolBlockDecision,
  ToolCallEvent,
  ToolResultEvent,
  ToolDomain,
} from "./auto-orchestrator/types.js";

export { assessAutoOrchestration } from "./auto-orchestrator/assessment.js";
export {
  normalizeRecordedDecision,
  validateRecordedDecision,
} from "./auto-orchestrator/decision.js";
export type {
  AutoOrchestrationAssessment,
  ContextHistoryPolicy,
  ContextInputSource,
  ContextInputSourceKind,
  ContextStrategy,
  DependencyAudit,
  OrchestrationLifecycleAction,
  OrchestrationMode,
  RecordedOrchestrationDecision,
  ToolBlockDecision,
  ToolCallPlanItem,
  ToolResultEvent,
  ToolDomain,
  WebUsePolicy,
} from "./auto-orchestrator/types.js";

export function renderAutoOrchestrationPrompt(assessment: AutoOrchestrationAssessment): string {
  const promptLocalValidationPrompt = renderPromptLocalValidationPrompt(assessment);
  if (promptLocalValidationPrompt) return promptLocalValidationPrompt;
  if (!assessment.requiresGate) return "";
  const needsStructuredPlanProposal =
    assessment.triggers.includes("plan-mode:research-proposal") ||
    assessment.planProposalIntent === true;
  const required = [
    assessment.requiresPlan ? "plan" : "",
    assessment.requiresSubagents ? "sub-agents" : "",
    assessment.requiresWorkflow ? "workflow" : "",
  ].filter(Boolean).join(", ");

  return [
    "## Canvast Automatic Orchestration Gate",
    "",
    `Detected mode: ${assessment.mode}`,
    `Required controls: ${required || "direct"}`,
    `Decision id: ${assessment.id}`,
    `Required tool domains: ${assessment.requiredToolDomains.join(", ") || "none"}`,
    `Optional tool domains: ${assessment.optionalToolDomains.join(", ") || "none"}`,
    `Canonical tools for required domains: ${formatDomainExamples(assessment.requiredToolDomains) || "none"}`,
    `Canonical tools for optional domains: ${formatDomainExamples(assessment.optionalToolDomains) || "none"}`,
    `Web use policy: ${assessment.webUsePolicy}${assessment.webTriggers.length ? ` (${assessment.webTriggers.join(", ")})` : ""}`,
    `Context management: ${assessment.requiresContextManagement ? "required" : "recent_window"}${assessment.contextTriggers.length ? ` (${assessment.contextTriggers.join(", ")})` : ""}`,
    `Follow-up policy: ${assessment.followUpPolicy}${assessment.followUpTriggers.length ? ` (${assessment.followUpTriggers.join(", ")})` : ""}`,
    `Plan/task adjustment: ${assessment.requiresTaskAdjustment ? "required" : "not_required"}`,
    assessment.planOnlyIntent ? "Plan-only/no-code request: do not inspect, search, read, mutate repository files, or persist Canvas records unless the user explicitly asks for local evidence or durable project state. Provide a plan with assumptions and approval checkpoints; use `propose_plan` directly when available." : "",
    needsStructuredPlanProposal ? "Plan proposal request: inspect/search/read only when local evidence is explicitly part of the task, then call `propose_plan` with files_affected, estimated_steps, and risk_level. Do not mutate files before approval. If the prompt provides a complete plan/task-state snapshot, use that user-provided state directly; record at most the required task status evidence, then call `propose_plan` without trying to reconstruct absent persisted state. If the named target is absent or ambiguous, still call `propose_plan` with the discovery result, candidate scopes, assumptions, unresolved questions, and risks; do not end with `ask_user` before a proposal." : "",
    assessment.ambiguousOptimizationIntent ? "Ambiguous optimization request: do not inspect the repository, edit files, or run shell/profiling yet. Ask at least two clarifying questions covering target scope and success metric, and suggest profiling/benchmarking as the next evidence step after scope is confirmed." : "",
    assessment.requiresLocalSearchStrategy ? "Local search request: call `auto_orchestration_decision` first, plan the `local_search` domain with native pi search/list/read tools (`content_search`, `grep`, `find`, `ls`, or `read` metadata), and keep output bounded to unique file paths or small snippets. For files containing literal text, prefer `content_search` with files output so Bash grep/find is unnecessary. Shell commands such as `rg` or `fd` must be planned under the `shell` domain as an explicit bounded fallback, never as the first broad recursive scan." : "",
    assessment.requiredToolDomains.includes("shell") ? "Direct shell execution detected: call `auto_orchestration_decision` before the first bash/shell call, and do not add file_write unless the user explicitly asks to edit files." : "",
    "",
    "This is automatic. Do not ask the user to type a slash command, enter plan mode, or explicitly request sub-agents.",
    "For complex plan/sub-agent/workflow/context tasks, call `auto_orchestration_decision` before any repository inspection or tool use, including read/search/list tools.",
    "Call `auto_orchestration_decision` as the only tool call in that first assistant step. After it returns success, continue with `enter_plan_mode`, search/read tools, `propose_plan`, sub-agents, workflows, or edits as recorded.",
    assessment.requiresPlan ? "For detected plan mode, do not record `lifecycle_action=exit` or `mode=direct` before plan mode has actually been entered and a plan has been proposed. Before plan approval, Bash is limited to non-mutating evidence collection; submit `propose_plan` and wait for approval before state-changing shell or file writes." : "",
    "Use the detected mode unless you intentionally choose a stronger mode. When recording a lifecycle transition, `mode` is the current orchestration state for that visible step, so an execution loop may enter `plan`, update it, switch to `workflow`, and later exit with `mode: direct` even if the original prompt eventually contains workflow-level needs.",
    "Every Required tool domain must appear in `tool_call_plan`, even when a domain is only planned for a later delivery stage.",
    "If you omit a Required tool domain, Canvast will normalize the missing domain into the recorded strategy; you are still responsible for actually calling the planned tools when the mode requires them.",
    "For workflow mode, include at least two `workflow_steps`. For sub-agent mode, include the required `subagent_tasks` (one explicit agent launch may have one task; parallel branches should list at least two); workflow mode may include sub-agent tasks as planned/deferred branches.",
    "Use canonical tool names in `tool_call_plan`: local_search with content_search/grep/find/ls/read, file reading with read, shell fallback with bash/rg/fd/cat/sed only under the shell domain, task tracking with task/task_create/task_update, agents with spawn_agent/parallel_agents, workflows with run_workflow, and Canvas with canvas_query/canvas_record.",
    "When mode is subagents, call `spawn_agent` or `parallel_agents` before doing the local read/search/shell work yourself. Do not degrade a sub-agent decision into direct Bash scanning.",
    "If the user text explicitly says spawn/launch/delegate/派生 an agent, treat it as an execution requirement, not as a documentation question or permission-policy discussion.",
    requiresParallelAgentsTool(assessment) ? "The user explicitly named `parallel_agents`; record and call `parallel_agents`. Do not substitute `spawn_agent`." : "",
    hasNoShellConstraint(assessment.prompt) ? "The user explicitly forbids shell for this task; do not include shell in `tool_call_plan`, even as a fallback." : "",
    "Before any mutating, state-changing shell, web, sub-agent, or workflow tool call, call `auto_orchestration_decision` with a concise plan, decomposition, workflow, and tool strategy.",
    "If a new tool need emerges during execution, such as installing a missing dependency, browsing for evidence, launching a sub-agent, starting a workflow, or writing files, update `auto_orchestration_decision` before taking that tool action. This is based on the visible tool call, not hidden chain-of-thought.",
    "Set `lifecycle_action` when orchestration state changes: `enter` for the first automatic move into plan/subagents/workflow, `update` for revising the active orchestration, `switch` for changing orchestration family, and `exit` with `mode: direct` when orchestration is complete.",
    "For independent research or implementation branches, use `spawn_agent` or `parallel_agents` under the bounded concurrency rules.",
    "For multi-stage delivery work, use `run_workflow` or task dependencies before implementation. Keep evidence and closure gates up to date.",
    "Do not browse the web by default. Use web tools only for current/external facts, explicit URLs/downloads, missing dependencies, or a stated evidence gap; record the reason.",
    assessment.requiredToolDomains.includes("shell") ? "If shell work turns into a package-manager dependency mutation, update `auto_orchestration_decision` before the install so the strategy includes the `package` audit domain and isolated dependency-cache verification." : "",
    assessment.requiredToolDomains.includes("package") ? "Package/dependency work may install missing libraries autonomously when needed, but it must use the sandbox-provided isolated dependency cache (`CANVAST_DEPENDENCY_CACHE_ROOT`, npm/pip/uv/yarn/pnpm/cargo/go cache env vars), must not write to global HOME caches, and must leave package.json/lockfile plus THIRD_PARTY_NOTICES.md auditable when a project dependency is added." : "",
    "For factual answers that may depend on current external state, official authorization, local business facts, availability/status, routes/transit, prices/markets, or technical releases, record a typed `grounding_strategy`: fact kinds, freshness, preferred source kinds, minimum source count, optional max_external_calls when the task gives an evidence-call budget, whether memory-only is allowed, unavailable-source behavior, and correction policy. Do not rely on keyword matching or memory-only specificity for these claims.",
    "When `grounding_strategy` requires external evidence, collect evidence through the dedicated web/source tools. Do not switch to shell network fetches or ad hoc text scraping to bypass unavailable web evidence; if authoritative sources cannot be reached, follow the unavailable-source policy and state what remains unverified.",
    "For long, resumed, or multi-session tasks, explicitly plan context compaction, Canvas/session recall, long-term memory, skills/tools capability context, and recovery continuity. Summaries must be observable; do not expose private chain-of-thought.",
    "Keep context sources layered: pi session/recent history is session-scoped; harness controls/internal instructions are control context; Canvas scoped view, context-recall, long-term memory, and skills/tools capability manifests are project/runtime sources. Do not feed Canvast-derived prompt sections back into recall as original session text.",
    "For follow-up questions or additional requests, preserve existing work unless the user explicitly pauses, stops, replaces, or reprioritizes it. Treat non-conflicting follow-ups as sidecar work or plan/task amendments, then continue the active workflow.",
    "Use a queue/interrupt/amendment model: ordinary follow-ups are sidecar queue items, explicit stop/replace/priority changes are interrupts, and critical constraints or scope changes become plan/task amendments.",
    "When a follow-up changes scope or priority, update task/canvas state before changing execution order. If it is only a status or side question, answer briefly and resume the previous task.",
    ...ORCHESTRATION_EXECUTION_GUIDANCE,
    "",
    "Required decision fields:",
    "- mode: direct | plan | subagents | workflow",
    "- lifecycle_action: optional enter | update | switch | exit when automatic orchestration state changes",
    "- task_summary: user-facing summary of the task",
    "- rationale: short external rationale, not private chain-of-thought",
    "- observable_reasoning_summary: brief visible reasoning/process summary, not hidden chain-of-thought",
    "- plan_steps: concrete implementation/verification steps",
    "- subagent_tasks: independent subtasks when useful",
    "- workflow_steps: ordered or DAG stages for end-to-end work",
    "- scope_files: expected file/module boundary",
    "- tool_call_plan: planned tool domains, tools, purpose, order, and parallel safety",
    "- verification_steps: concrete checks before claiming completion",
    "- web_use: not_needed | conditional | required",
    "- web_justification: required whenever web_use is conditional/required",
    "- dependency_audit: set isolated_cache_verified=true before any package-manager dependency mutation; do not encode this as wording inside verification_steps",
    "- grounding_strategy: preferred for current/external factual answers; use typed fact/source/freshness/max_external_calls/unavailable/correction fields instead of regex-like wording",
    "- local_evidence_used: optional; use it only when local evidence is part of the strategy",
    "- context_strategy: history_policy, compression_trigger, recall_sources, resume_plan, and input_sources when context management is relevant",
    "  - input_sources: list { kind, budget, provenance, inject_policy } for active layers such as session_recent, harness_controls, canvas_scope, context_recall or long_term_memory, and tools_skills; use inject_policy=none with a provenance note when an expected layer is intentionally unavailable",
    "- follow-up handling: preserve_active_work, sidecar_answer, plan/task adjustment, or explicit redirect/pause as appropriate",
    "",
    "中文：这是自动编排门禁。不要要求用户输入 /plan、显式进入计划模式或显式要求子 agent。",
    "复杂 plan、子 agent、workflow 或上下文恢复任务，在读取/搜索/列目录之前也必须先调用 `auto_orchestration_decision`。",
    "第一次助手步骤只调用 `auto_orchestration_decision` 一个工具；成功返回后，再按已记录策略调用 `enter_plan_mode`、搜索/读取、`propose_plan`、子 agent、workflow 或编辑工具。",
    assessment.requiresPlan ? "检测到计划模式时，在真正进入计划模式并提交计划前，不要记录 `lifecycle_action=exit` 或 `mode=direct`。计划批准前，Bash 仅限非变更类取证；状态变更 shell 或文件写入必须等 `propose_plan` 后获批再执行。" : "",
    assessment.planOnlyIntent ? "仅制定计划且明确不改代码的请求，不要先搜索/读取/修改仓库文件，也不要默认写入 Canvas；先输出计划、假设和需用户确认的检查点。可用 `propose_plan` 时直接提交计划。" : "",
    needsStructuredPlanProposal ? "计划提案请求：仅在任务明确需要本地证据时做搜索/读取/调研，然后调用 `propose_plan` 提交包含 files_affected、estimated_steps、risk_level 的结构化计划；批准前不要修改文件。若 prompt 已给出完整计划/任务状态快照，直接使用该用户提供状态；最多记录必要任务状态证据，然后立即调用 `propose_plan`，不要花额外轮次重建不存在的持久状态。若命名目标不存在或不明确，也要先用 `propose_plan` 写明发现、候选范围、假设、待确认问题与风险，不要在提案前以 `ask_user` 收尾。" : "",
    assessment.ambiguousOptimizationIntent ? "模糊优化请求：尚未明确目标范围、成功指标和是否允许改动前，不要读取仓库、修改文件或运行 shell/profiling；先提出至少两个澄清问题，并建议确认范围后先做 profiling/benchmark 取证。" : "",
    assessment.requiresLocalSearchStrategy ? "本地搜索请求：先调用 `auto_orchestration_decision`，在策略中规划 `local_search` 域并优先使用 pi 原生搜索/列举/读取工具（`content_search`、`grep`、`find`、`ls` 或 `read` 元数据），输出限定为唯一文件路径或小片段；查找包含字面文本的文件列表时优先用 `content_search` 的 files 输出，不需要 Bash grep/find；`rg`、`fd` 这类 shell 命令只能放在 `shell` 域作为已显式规划的有界兜底，不能作为第一步宽泛递归扫描。" : "",
    assessment.requiredToolDomains.includes("shell") ? "检测到直接 shell 执行：第一次 bash/shell 前先调用 `auto_orchestration_decision`；除非用户明确要求编辑文件，否则不要加入 file_write。" : "",
    "通常使用检测到的 mode。记录 lifecycle transition 时，`mode` 表示当前可见步骤的编排状态；因此同一个执行循环可以先进入 `plan`，再更新计划，再切换到 `workflow`，最后用 `mode: direct` 退出，即使原始提示最终包含 workflow 级需求。",
    "每一个 Required tool domain 都必须出现在 `tool_call_plan` 中，即便该域只是后续交付阶段的计划项。",
    "如果遗漏 Required tool domain，Canvast 会把缺失域规范化补入已记录策略；但对应 mode 要求的工具仍必须真实调用。",
    "workflow 模式至少写两个 `workflow_steps`；sub-agent 模式写入所需的 `subagent_tasks`（明确派生单个 agent 的场景可写一个任务，并行分支通常至少两个）；workflow 模式可把子 agent 分支写为计划/延后执行。",
    "sub-agent 模式下，必须先调用 `spawn_agent` 或 `parallel_agents`，再自行做本地 read/search/shell；不能把子 agent 决策退化成直接 Bash 扫描。",
    "如果用户文本明确说 spawn/launch/delegate/派生 agent，把它当作执行要求，不要改写成文档咨询或权限策略讨论。",
    requiresParallelAgentsTool(assessment) ? "用户明确点名 `parallel_agents`；决策和实际执行都必须使用 `parallel_agents`，不要替换成 `spawn_agent`。" : "",
    hasNoShellConstraint(assessment.prompt) ? "用户明确禁止本任务执行 shell；`tool_call_plan` 里不要加入 shell，即使作为兜底也不允许。" : "",
    "在任何会修改文件/状态、执行会改变状态的 shell、联网、派生子 agent 或运行 workflow 的工具调用前，先调用 `auto_orchestration_decision` 记录自动规划、工具协调与验证闭环。",
    "如果执行中途发现新的工具需求，例如需要安装缺失依赖、联网取证、启动子 agent、启动 workflow 或写文件，也必须先更新 `auto_orchestration_decision` 再调用对应工具。触发依据是可见工具调用，不是隐藏思维链。",
    "编排状态变化时填写 `lifecycle_action`：首次自动进入 plan/subagents/workflow 用 `enter`，修订当前编排用 `update`，切换编排类型用 `switch`，全部完成并退出编排时用 `exit` 且 `mode: direct`。",
    "不要遇事就联网；只有当前外部事实、显式 URL/下载、缺失依赖或明确证据缺口时才使用 web，并写清理由。",
    "对可能依赖当前外部状态、官方授权、本地商家事实、营业/可用状态、route_or_transit、价格/行情或技术发布的回答，优先记录结构化 `grounding_strategy`：事实类型、时效性、首选来源类型、最少来源数、当任务给出证据调用预算时填写 max_external_calls、是否允许只凭记忆、来源不可用时怎么输出、用户纠错时如何回收并重查。不要把这类判断做成关键词或正则补丁。",
    "`grounding_strategy` 需要外部证据时，证据收集走专用 web/source 工具；不要切到 shell 网络抓取或临时文本 scraping 来绕过不可用证据。权威来源拿不到时，按 unavailable_policy 说明未验证。",
    "长会话、恢复会话或跨 session 任务必须记录上下文压缩、Canvas/session 召回和恢复连续性策略；只输出可观察推理摘要，不输出隐藏思维链。",
    "追加提问或补充要求默认不打断已有工作；除非用户明确暂停、停止、替换目标或调整优先级，否则应作为 sidecar 或 plan/task 修订处理，然后继续当前主线。",
    "采用队列/中断/修订模型：普通追问进入 sidecar 队列，明确停止/替换/优先级变化是中断，关键约束或范围变化进入 plan/task 修订。",
    "如果追加要求改变范围或优先级，先更新 task/canvas 状态再改变执行顺序；如果只是状态或顺手问题，简短回答后恢复原任务。",
    ...ORCHESTRATION_EXECUTION_GUIDANCE_ZH,
  ].join("\n");
}


function requiresPreToolDecision(assessment: AutoOrchestrationAssessment): boolean {
  return assessment.requiresPlan ||
    assessment.requiresSubagents ||
    assessment.requiresWorkflow ||
    assessment.requiresContextManagement ||
    assessment.requiresLocalSearchStrategy ||
    assessment.ambiguousOptimizationIntent;
}

function exitedToDirectMode(decision: RecordedOrchestrationDecision | undefined): boolean {
  return decision?.lifecycleAction === "exit" && decision.mode === "direct";
}

function hasEnteredLifecycle(actions: readonly OrchestrationLifecycleAction[]): boolean {
  return actions.some(action => action === "enter" || action === "switch");
}

function normalizePrematureLifecycleExit(
  assessment: AutoOrchestrationAssessment,
  input: Omit<RecordedOrchestrationDecision, "assessmentId" | "recordedAt">,
  lifecycleActions: readonly OrchestrationLifecycleAction[],
): Omit<RecordedOrchestrationDecision, "assessmentId" | "recordedAt"> {
  if (
    input.lifecycleAction === "exit" &&
    input.mode === "direct" &&
    !hasEnteredLifecycle(lifecycleActions) &&
    assessment.mode !== "direct"
  ) {
    const planSteps = input.planSteps.length >= 2
      ? input.planSteps
      : ["Enter the required orchestration lifecycle", "Prepare a proposal before any state-changing action"];
    const toolCallPlan = input.toolCallPlan.length > 0
      ? input.toolCallPlan
      : [defaultToolPlanItem("task")];
    return {
      ...input,
      mode: assessment.mode,
      lifecycleAction: "enter",
      planSteps,
      toolCallPlan,
      rationale: `${input.rationale} Normalized from a premature direct exit to the required ${assessment.mode} lifecycle entry.`,
    };
  }
  return input;
}

function directModeEmergentBlock(toolName: string, input: Record<string, unknown>, stage: "during_execution" | "after_exit"): ToolBlockDecision {
  const emergent = emergentStrategyDomain(toolName, input);
  if (!emergent) return { block: false };
  const stageText = stage === "after_exit" ? "after orchestration exited" : "during execution";
  const stageTextZh = stage === "after_exit" ? "编排退出后又" : "执行中途";
  return {
    block: true,
    reason: `A new ${emergent} tool need emerged ${stageText}. Record or update auto_orchestration_decision before using ${toolName}; this trigger is based on the visible tool call, not hidden chain-of-thought. / ${stageTextZh}出现新的 ${emergent} 工具需求，请先记录或更新 auto_orchestration_decision 再使用 ${toolName}；触发依据是可见工具调用，不是隐藏思维链。`,
  };
}

export function shouldBlockForAutoOrchestration(
  assessment: AutoOrchestrationAssessment | undefined,
  decision: RecordedOrchestrationDecision | undefined,
  event: ToolCallEvent,
  executionState: OrchestrationExecutionState = {},
  policy: { trustedAgentTool?: "spawn_agent" | "parallel_agents" } = {},
): ToolBlockDecision {
  if (!assessment) return { block: false };
  const toolName = toolEventName(event);
  const normalizedToolName = normalizeToolName(toolName);
  const input = toolEventInput(event);
  const promptLocalBlock = shouldBlockPromptLocalValidationTool(assessment, toolName);
  if (promptLocalBlock) return promptLocalBlock;
  if (exitedToDirectMode(decision)) {
    if (ORCHESTRATION_TOOLS.has(normalizedToolName)) return { block: false };
    const emergentBlock = directModeEmergentBlock(toolName, input, "after_exit");
    if (emergentBlock.block) return emergentBlock;
    return { block: false };
  }
  if (!assessment.requiresGate && !decision) {
    if (ORCHESTRATION_TOOLS.has(normalizedToolName)) return { block: false };
    const emergent = emergentStrategyDomain(toolName, input);
    if (emergent && assessment.requiredToolDomains.includes(emergent)) return { block: false };
    const emergentBlock = directModeEmergentBlock(toolName, input, "during_execution");
    if (emergentBlock.block) return emergentBlock;
    return { block: false };
  }
  if (decision) {
    if (ORCHESTRATION_TOOLS.has(normalizedToolName)) return { block: false };
    const planned = toolPlanDomains(decision.toolCallPlan);
    const domain = toolDomain(toolName);
    const localSearchReadAsFileRead =
      normalizeToolName(toolName) === "read" &&
      planned.has("local_search") &&
      hasLocalSearchReadTool(decision.toolCallPlan);
    const effectiveDomain: ToolDomain | undefined = isSandboxCommandGrant(toolName, input)
      ? "shell"
      : localSearchReadAsFileRead
        ? "local_search"
        : domain;
    if (assessment.requiresLocalSearchStrategy && isSandboxCommandGrant(toolName, input)) {
      return {
        block: true,
        reason: "This local search task cannot use sandbox_grant to authorize a shell search fallback. Use native content_search/grep/find/ls/read tools instead. / 本地搜索任务不能用 sandbox_grant 授权 shell 搜索兜底；请使用原生 content_search/grep/find/ls/read 工具。",
      };
    }
    if (
      assessment.externalSourceAnswerIntent &&
      effectiveDomain &&
      ["local_search", "file_read", "file_write", "shell", "task", "agent", "workflow", "canvas"].includes(effectiveDomain)
    ) {
      return {
        block: true,
        reason: "External source answer tasks should use dedicated web/source evidence and then answer directly. Do not persist Canvas/task/workflow state unless the user explicitly asked for local project state. / 外部事实问答任务应使用专用 web/source 取证后直接作答；除非用户明确要求本地项目状态持久化，否则不要写 Canvas/task/workflow。",
      };
    }
    if (effectiveDomain === "web" && decision.webUse === "not_needed") {
      return {
        block: true,
        reason: "Web tools were not part of the recorded strategy. Update auto_orchestration_decision with a concrete external-evidence justification before browsing. / 当前策略未计划联网；如确需联网，请先更新 auto_orchestration_decision 并说明外部证据理由。",
      };
    }
    if (
      (assessment.planProposalIntent === true || assessment.planOnlyIntent === true) &&
      normalizeToolName(toolName) === "ask_user" &&
      executionState.planProposed !== true
    ) {
      return {
        block: true,
        reason: "This prompt asks for a no-code plan proposal. Call propose_plan first with assumptions, steps, approval checkpoints, unresolved questions, and risks; do not replace the proposal with ask_user. / 用户要求先制定不改代码的计划，请先调用 propose_plan 写明假设、步骤、审批检查点、待确认问题和风险；不要用 ask_user 代替计划提案。",
      };
    }
    const hasApprovalBoundary =
      (
        assessment.planOnlyIntent === true ||
        assessment.planProposalIntent === true ||
        assessment.triggers.includes("plan-mode:explicit") ||
        hasPlanApprovalBoundary(decision.toolCallPlan)
      );
    const inPlanBeforeApproval =
      hasApprovalBoundary && executionState.planApproved !== true;
    if (inPlanBeforeApproval && FILE_MUTATING_TOOLS.has(toolName)) {
      return {
        block: true,
        reason: "Plan mode has not received a successful approval result yet. Submit propose_plan, wait for its successful result, then approve_plan and wait for its successful result before file writes. / 计划模式尚未收到成功的审批结果；请先提交 propose_plan 并等待成功结果，再调用 approve_plan 并等待成功结果，之后才能写文件。",
      };
    }
    const readOnlyLocalShell =
      toolName === "bash" &&
      isReadOnlyBash(String(input.command || "")) &&
      (planned.has("local_search") || planned.has("file_read"));
    if (
      readOnlyLocalShell &&
      assessment.requiresLocalSearchStrategy &&
      planned.has("local_search") &&
      !planned.has("shell")
    ) {
      return {
        block: true,
        reason: "This local search task requires the dedicated local_search path first. Use native content_search/grep/find/ls/read tools, or update auto_orchestration_decision to include an explicitly bounded shell fallback. / 本地搜索任务需要先走专用 local_search 路径；请使用原生 content_search/grep/find/ls/read 工具，或先更新自动编排决策并显式规划有界 shell 兜底。",
      };
    }
    if ((STRATEGY_TOOLS.has(toolName) || SHELL_GRANT_TOOLS.has(toolName) || effectiveDomain) && effectiveDomain && !planned.has(effectiveDomain)) {
      if (readOnlyLocalShell) {
        // Treat safe `bash find/ls/rg/...` as the execution substrate for
        // planned local_search/file_read. Mutating or compound shell remains
        // gated by the explicit shell domain below.
      } else {
      return {
        block: true,
        reason: `${effectiveDomain} was not part of the recorded tool strategy. Update auto_orchestration_decision before using it. / 当前工具策略未规划 ${effectiveDomain}，请先更新自动编排决策。`,
      };
      }
    }
    const mustLaunchAgentFirst =
      (assessment.mode === "subagents" || decision.mode === "subagents") &&
      planned.has("agent") &&
      !executionState.agentLaunched &&
      effectiveDomain !== undefined &&
      !["task", "canvas", "monitor", "review"].includes(effectiveDomain);
    if (mustLaunchAgentFirst && !isAgentLaunchTool(toolName)) {
      return {
        block: true,
        reason: "Sub-agent orchestration was recorded, so launch spawn_agent or parallel_agents before doing local read/search/shell work directly. / 已记录子 agent 编排，请先真实调用 spawn_agent 或 parallel_agents，再自行做本地读取、搜索或 shell。",
      };
    }
    const trustedAgentTool = policy.trustedAgentTool === normalizedToolName;
    if (requiresParallelAgentsTool(assessment) && isAgentLaunchTool(toolName) && normalizedToolName !== "parallel_agents" && !trustedAgentTool) {
      return {
        block: true,
        reason: "The user explicitly requested parallel_agents, so use parallel_agents rather than replacing it with spawn_agent. / 用户明确要求 parallel_agents，请使用 parallel_agents，不要替换为 spawn_agent。",
      };
    }
    if (FILE_MUTATING_TOOLS.has(toolName) && !planned.has("file_write")) {
      return {
        block: true,
        reason: "file_write was not part of the recorded tool strategy. Update auto_orchestration_decision before editing. / 当前工具策略未规划 file_write，请先更新自动编排决策。",
      };
    }
    if (toolName === "bash") {
      const command = String(input.command || "");
      if (inPlanBeforeApproval && !isNonMutatingBash(command)) {
        return {
          block: true,
          reason: "Plan mode has not received a successful approval result yet. Bash is limited to non-mutating evidence collection before approve_plan succeeds; do not execute state-changing shell commands such as deletes or installs. / 计划模式尚未收到成功的审批结果；approve_plan 成功前 Bash 仅限非变更类取证，不要执行删除、安装等状态变更命令。",
        };
      }
      if (hasDependencyInstallIntent(command.toLowerCase()) && !planned.has("package")) {
        return {
          block: true,
          reason: "Dependency installation emerged from the visible shell command. Update auto_orchestration_decision to include the package/dependency audit domain and isolated dependency-cache verification before running it. / 可见 shell 命令中出现依赖安装，请先更新 auto_orchestration_decision，加入 package/依赖审计域和隔离依赖缓存验证后再执行。",
        };
      }
      if (
        hasDependencyInstallIntent(command.toLowerCase()) &&
        decision.dependencyAudit?.isolatedCacheVerified !== true
      ) {
        return {
          block: true,
          reason: "Dependency installation emerged from the visible shell command, but dependency_audit.isolated_cache_verified is not true. Update auto_orchestration_decision with structured isolated-cache verification before running it. / 可见 shell 命令中出现依赖安装，但 dependency_audit.isolated_cache_verified 未设为 true；请先更新 auto_orchestration_decision，加入结构化隔离缓存验证。",
        };
      }
      if (hasNoShellConstraint(assessment.prompt)) {
        return {
          block: true,
          reason: "The user explicitly forbids shell execution for this task. Keep the recorded strategy within non-shell tools, or state that the requested evidence is unavailable under that constraint. / 用户明确禁止本任务执行 shell；请保持非 shell 工具策略，或说明在该约束下无法取得所需证据。",
        };
      }
      if (
        decision.groundingStrategy &&
        groundingRequiresExternalEvidence(decision.groundingStrategy) &&
        decision.webUse !== "not_needed" &&
        shellUsesNetworkFetch(command)
      ) {
        return {
          block: true,
          reason: "grounding_strategy requires dedicated web/source tools for external evidence; shell network fetches are not an evidence path. Use web_search/web_fetch/web_research, or state the authoritative source remains unverified. / grounding_strategy 要求外部证据时必须使用专用 web/source 工具；shell 网络抓取不能作为取证路径。请使用 web_search/web_fetch/web_research，或说明权威来源未验证。",
        };
      }
      if (!isReadOnlyBash(command) && !planned.has("shell")) {
        return {
          block: true,
          reason: "shell was not part of the recorded tool strategy. Update auto_orchestration_decision before state-changing bash. / 当前工具策略未规划 shell，请先更新自动编排决策。",
        };
      }
    }
    return { block: false };
  }

  if (normalizedToolName === "auto_orchestration_decision" || normalizedToolName === "sidecar_dispatch_decision") {
    return { block: false };
  }
  if (assessment.ambiguousOptimizationIntent && toolName === "ask_user") return { block: false };
  if (requiresPreToolDecision(assessment)) {
    return {
      block: true,
      reason: `Automatic ${assessment.mode} orchestration must be recorded before any repository inspection or tool use. Call auto_orchestration_decision first; do not ask the user to enter a mode. / 复杂任务需要先记录自动${assessment.mode}编排，再读取仓库或调用工具；请先调用 auto_orchestration_decision，不要要求用户手动进入模式。`,
    };
  }
  if (ORCHESTRATION_TOOLS.has(normalizedToolName)) return { block: false };
  if (
    assessment.mode === "direct" &&
    assessment.requiredToolDomains.includes("file_write") &&
    !assessment.requiresPlan &&
    !assessment.requiresSubagents &&
    !assessment.requiresWorkflow
  ) {
    const inferredDomain = toolDomain(toolName);
    if (["local_search", "file_read"].includes(String(inferredDomain))) {
      return { block: false };
    }
    if (toolName === "bash" && isReadOnlyBash(String(input.command || ""))) {
      return { block: false };
    }
  }
  if (STRATEGY_TOOLS.has(toolName)) {
    return {
      block: true,
      reason: `Automatic ${assessment.mode} orchestration and tool coordination are required before ${toolName}. Call auto_orchestration_decision first. / 使用 ${toolName} 前必须先记录自动编排和工具协调决策。`,
    };
  }
  const inferredDomain = toolDomain(toolName);
  if (inferredDomain && !["local_search", "file_read", "review", "monitor"].includes(inferredDomain)) {
    return {
      block: true,
      reason: `Automatic ${assessment.mode} orchestration and tool coordination are required before ${toolName}. Call auto_orchestration_decision first; do not ask the user to enter a mode. / 该任务需要先自动${assessment.mode}编排并规划工具调用，请先调用 auto_orchestration_decision，不要要求用户手动进入模式。`,
    };
  }
  if (toolName === "bash") {
    const command = String(input.command || "");
    if (!isReadOnlyBash(command)) {
      return {
        block: true,
        reason: `Automatic ${assessment.mode} orchestration and tool coordination are required before state-changing bash. Call auto_orchestration_decision first. / 会改变状态的 bash 前必须先完成自动编排和工具协调决策。`,
      };
    }
  }
  return { block: false };
}

export function createAutoOrchestrationController() {
  let currentAssessment: AutoOrchestrationAssessment | undefined;
  let currentDecision: RecordedOrchestrationDecision | undefined;
  const lifecycleActions: OrchestrationLifecycleAction[] = [];
  const toolLifecycle = createOrchestrationToolLifecycle();

  return {
    assess(prompt: string, now?: string) {
      currentAssessment = assessAutoOrchestration(prompt, now);
      currentDecision = undefined;
      lifecycleActions.length = 0;
      toolLifecycle.reset();
      return currentAssessment;
    },
    get assessment() { return currentAssessment; },
    get decision() { return currentDecision; },
    get lifecycleActions() { return [...lifecycleActions]; },
    renderPrompt() {
      return currentAssessment ? renderAutoOrchestrationPrompt(currentAssessment) : "";
    },
    record(
      input: Omit<RecordedOrchestrationDecision, "assessmentId" | "recordedAt">,
      now = new Date().toISOString(),
    ): { ok: true; decision: RecordedOrchestrationDecision } | { ok: false; errors: string[] } {
      if (!currentAssessment) {
        return { ok: false, errors: ["no active auto orchestration assessment"] };
      }
      const lifecycleInput = normalizePrematureLifecycleExit(currentAssessment, input, lifecycleActions);
      const normalized = {
        ...lifecycleInput,
        planSteps: lifecycleInput.planSteps || [],
        subagentTasks: lifecycleInput.subagentTasks || [],
        workflowSteps: lifecycleInput.workflowSteps || [],
        scopeFiles: lifecycleInput.scopeFiles || [],
        toolCallPlan: lifecycleInput.toolCallPlan || [],
        verificationSteps: lifecycleInput.verificationSteps || [],
        webUse: lifecycleInput.webUse || "not_needed",
        dependencyAudit: lifecycleInput.dependencyAudit,
        localEvidenceUsed: lifecycleInput.localEvidenceUsed,
        lifecycleAction: lifecycleInput.lifecycleAction,
      };
      const completed = normalizeRecordedDecision(currentAssessment, normalized);
      const errors = validateRecordedDecision(currentAssessment, completed);
      if (completed.lifecycleAction === "exit" && !hasEnteredLifecycle(lifecycleActions)) {
        errors.push("lifecycle_action=exit requires an active recorded orchestration lifecycle");
      }
      if (errors.length) return { ok: false, errors };
      currentDecision = {
        ...completed,
        assessmentId: currentAssessment.id,
        recordedAt: now,
      };
      if (currentDecision.lifecycleAction) lifecycleActions.push(currentDecision.lifecycleAction);
      return { ok: true, decision: currentDecision };
    },
    shouldBlock(
      event: ToolCallEvent,
      policy: { trustedAgentTool?: "spawn_agent" | "parallel_agents" } = {},
    ) {
      const decision = shouldBlockForAutoOrchestration(
        currentAssessment,
        currentDecision,
        event,
        toolLifecycle.executionState(),
        policy,
      );
      if (!decision.block) return toolLifecycle.admit(event);
      return decision;
    },
    onToolResult(event: ToolResultEvent) {
      toolLifecycle.resolve(event);
    },
    resetPendingToolCalls() {
      toolLifecycle.resetPending();
    },
  };
}
