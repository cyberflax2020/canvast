/**
 * =============================================================================
 * Canvast — Main Entry Point / 主入口
 * =============================================================================
 * @file        src/index.ts
 * @brief       Canvast public API — Canvas, Harness, Agents
 * @description Exports all public APIs for the Canvast agent harness.
 *              Graph Canvas, control planes, stability system, sub-agent
 *              system. Every symbol below is verified to exist in its source
 *              module (2026-08-15 full re-audit after the crash-corrupted
 *              previous version, which contained duplicate re-export blocks
 *              and ~15 phantom symbols).
 *              导出所有公开 API：图谱画布、控制面、稳定性系统、子 agent 系统。
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * Changes: [2026-08-08] Initial implementation
 *          [2026-08-15] Full rewrite: removed duplicate blocks and phantom
 *                       exports; dropped the abandoned output-capping /
 *                       output-harness modules (superseded by cap-or-spill);
 *                       DEFAULT_BUDGET name clash resolved via alias.
 * =============================================================================
 */

// ─── Canvas / 图谱画布 ──────────────────────────────────────
export { CanvasStore } from "./graph/canvas-store.js";
export { assembleCanvasScopedView, estimateScopeTokens } from "./graph/canvas-scope.js";
export type {
  GraphNode, GraphEdge, FileNode, PlanNode, DecisionNode, AgentRunNode,
  NodeType, EdgeType, CanvasScope, TraceChain, ExternalChangeEvent,
  PlanStep, PlanStatus, TaskStatus, AgentRunStatus, DecisionType,
  TraversalOptions, CanvasQuery,
} from "./graph/types.js";

// ─── Harness · Context Budget / 上下文预算控制面 ────────────
export {
  allocateBudget, checkBudget, estimateTokens, trimHistoryToBudget,
  contextBudgetOptionsFromModel, DEFAULT_BUDGET, HARD_CEILING,
  type ContextBudget, type ContextBudgetOptions,
} from "./harness/context-budgeting.js";
export {
  modelBudgetDefaults, modelContextCeiling,
  resolveModelCapabilities, resolveModelIdentity, resolveProviderModelArgs,
  type CanvastModality, type ModelCapabilities, type ModelCapabilitySource,
  type ModelIdentity, type ModelRegistryFormat, type ProviderModelArgs,
  type StructuredOutputReliability, type ToolUseReliability,
} from "./harness/model-capabilities.js";

// ─── Harness · Cap-or-Spill / 输出封顶与溢出控制面 ──────────
// The single surviving output-capping implementation (sync API, SpillStore
// with synchronous writes). The rival async output-capping/output-harness
// pair was abandoned and deleted 2026-08-15 — do not reintroduce.
export {
  capOrSpill, formatSpillPreview,
  SpillStore, OutputBudget, TurnBudget, WallClockBudget,
  createCapOrSpillHarness,
  DEFAULT_SPILL_THRESHOLD_BYTES, DEFAULT_OUTPUT_BUDGET,
  SPILL_HEAD_PREVIEW_CHARS, SPILL_TAIL_PREVIEW_CHARS, SPILL_ELLIPSIS,
  type SpillResult, type OutputBudgetConfig, type BudgetDecision,
  type TurnDecision, type WallClockStart, type WallClockDecision,
  type CapOrSpillHarnessOptions,
} from "./harness/cap-or-spill.js";

// ─── Harness · Turn Budget / 轮次预算控制面 ─────────────────
export {
  Budget, DEFAULT_TURN_LIMIT, TURN_EXHAUSTION_DIRECTIVE,
  // Aliased: context-budgeting owns the bare DEFAULT_BUDGET name above.
  DEFAULT_BUDGET as DEFAULT_BUDGET_CONFIG,
  type BudgetConfig, type BudgetStatus,
} from "./harness/budget.js";

// ─── Harness · Step Budget / 步预算控制面 (Step 2-A) ────────
export {
  StepBudget, windDownInstruction, DEFAULT_STEP_BUDGET,
  type StepBudgetConfig, type StepBudgetStatus, type AxisState, type AxisKind,
} from "./harness/step-budget.js";

// ─── Harness · Plan Constraints & Canvas Scoping ────────────
export { checkPlanScope, suggestAmendment, type ScopeCheckResult } from "./harness/plan-constraints.js";
export { createCanvasScopingHarness } from "./harness/canvas-scoping.js";
export {
  contextRecallDir, contextRecallIndexFile, emptyContextRecallIndex,
  contextRecallArchiveFile, contextRecallRecoveryFile,
  CONTEXT_RECALL_HOT_RECORDS, DEFAULT_CONTEXT_RECALL_MAX_ARCHIVE_RECORDS,
  DEFAULT_CONTEXT_RECALL_MAX_STORAGE_BYTES, DEFAULT_CONTEXT_RECALL_PRUNE_WINDOW_DAYS,
  DEFAULT_CONTEXT_RECALL_WARN_RATIO, CANVAST_DERIVED_PROMPT_MARKERS,
  readContextRecallIndex, writeContextRecallIndex, recordContextRecall,
  readContextRecallArchive, emptyContextRecallArchive,
  recordSessionEntryRecall, syncContextRecallFromSession,
  maintainContextRecallLifecycle, selectContextRecallRecords,
  renderContextRecallManifest, recallIndexSummary, renderContextRecallLines,
  isCanvastDerivedPromptText, stripCanvastDerivedPromptSections,
  type ContextRecallKind, type ContextRecallSource,
  type ContextRecallPointer, type ContextRecallRecord,
  type ContextRecallIndex, type ContextRecallArchive,
  type ContextRecallStorageStatus, type ContextRecallLifecycleOptions,
  type ContextRecallSelectionOptions, type SelectedContextRecallRecord,
  type RecordContextRecallInput,
} from "./harness/context-recall.js";
export {
  runtimeStatusFile, defaultRuntimeStatusDir, emptyRuntimeStatusSnapshot,
  readRuntimeStatus, writeRuntimeStatus, updateRuntimeStatus,
  inferRuntimeLanguage, updateRuntimeLanguage, summarizeRuntimeInput,
  upsertRuntimeStatusItem, updateRuntimeModel, updateRuntimeTokens,
  updateRuntimePermission, recordRuntimeAttachment, recordApprovalReview,
  recordRuntimeEvent, isRuntimeItemOpen, runtimeStatusSummary,
  updateRuntimeResumeProjection,
  renderRuntimeStatusLines,
  type RuntimeLocale, type RuntimeLanguageSource,
  type RuntimeItemStatus, type ApprovalReviewDecision,
  type ApprovalReviewRisk, type ApprovalAuthorization,
  type RuntimeAttachmentKind, type RuntimeAttachmentDisposition,
  type RuntimePermissionMode, type RuntimePermissionSource,
  type RuntimeLanguageState, type RuntimeStatusItem,
  type ApprovalReviewRecord, type RuntimeEventRecord,
  type RuntimeModelState, type RuntimeTokenState,
  type RuntimeAttachmentRecord, type RuntimePermissionState,
  type RuntimeStatusSnapshot, type RuntimeLanguageInput,
  type RuntimeStatusUpsertInput, type RuntimeStatusUpdater,
  type RuntimeResumeSnapshot,
} from "./harness/runtime-status.js";
export {
  readRuntimeResume, writeRuntimeResume, inspectRuntimeResume,
  projectRuntimeResume, reconcileRuntimeResume,
  chooseRuntimeResumeCandidate, claimRuntimeResumeCandidate,
  rebindRuntimeResumeCandidate, retireRuntimeResumeCandidate,
  markRuntimeResumeCandidateRunning, markRuntimeResumeCandidateCompleted,
  stableRuntimeResumeProjectId, candidateReadyForClaim,
  claimedResumeCandidateForSession, selectedResumeCandidate,
  type ResumeAvailability, type ResumeDisposition, type ResumeFreshness,
  type ResumeActionKind, type ResumeUnsupportedReason,
  type ResumeCandidateBinding, type ResumeCandidateClaim,
  type ResumeCandidateValidation, type ResumeCandidate,
  type RuntimeResumeSnapshot as RuntimeResumeProjection,
  type RuntimeResumeUnsupported, type RuntimeResumeState,
  type RuntimeResumeTransition,
} from "./harness/runtime-resume.js";
export {
  assessAutoOrchestration,
  createAutoOrchestrationController,
  renderAutoOrchestrationPrompt,
  shouldBlockForAutoOrchestration,
  validateRecordedDecision,
  type AutoOrchestrationAssessment,
  type ContextHistoryPolicy,
  type ContextInputSource,
  type ContextInputSourceKind,
  type ContextStrategy,
  type DependencyAudit,
  type OrchestrationMode,
  type OrchestrationLifecycleAction,
  type RecordedOrchestrationDecision,
  type ToolBlockDecision,
  type ToolCallPlanItem,
  type ToolDomain,
  type WebUsePolicy,
} from "./harness/auto-orchestrator.js";
export { hasConcreteWebJustification } from "./harness/web-policy.js";
export {
  createDefaultClosureItems, normalizeClosureItem, canTransition,
  transitionClosureItem, summarizeClosure, formatClosureSummary,
  STATE_ORDER, REQUIRED_CLOSURE_ITEM_IDS,
  canonicalClosureItemId,
  type ClosureState, type ClosureKind, type ClosureEvidence,
  type ClosureItem, type ClosureSummary,
} from "./harness/product-closure.js";

// ─── Stability & Performance / 稳定性与性能 ─────────────────
export {
  SystemMonitor, getSystemMonitor, resetSystemMonitor,
  formatBytes, formatHealthSummary,
  type HealthSnapshot, type MemorySnapshot, type CpuSnapshot,
  type ProcessSnapshot, type HealthStatus, type ResourceThresholds,
  type AlertInfo, type AlertCallback, type MonitorConfig,
  DEFAULT_THRESHOLDS,
} from "./utils/system-monitor.js";
export {
  GarbageCollector, getGarbageCollector, resetGarbageCollector,
  deleteEdge, deleteEdgesForNode,
  DEFAULT_GC_CONFIG, DEFAULT_NODE_TTLS,
  type GcConfig, type GcResult, type GcCallback, type NodeTypeTtl,
} from "./utils/gc.js";
export {
  DynamicConfigManager, getDynamicConfig, resetDynamicConfig,
  healthToConcurrencyScale, healthToGcFrequencyScale,
  PRESETS, PRESET_MINIMAL, PRESET_BALANCED, PRESET_PERFORMANCE,
  type DynamicConfig, type ContextBudgetConfig, type ConcurrencyConfig,
  type GcParamsConfig, type MonitorParamsConfig, type CanvasScopeConfig,
  type PresetName, type ConfigChangeCallback,
} from "./utils/dynamic-config.js";
export {
  ProcessLifecycleManager, getProcessLifecycle, resetProcessLifecycle,
  spawnTracked, DEFAULT_PROCESS_CONFIG,
  type TrackedProcess, type ProcessLifecycleConfig,
  type ProcessLifecycleEvents, type ProcessLifecycleStats,
  type ProcessState,
} from "./utils/process-lifecycle.js";
export {
  ResourceAllocator, getResourceAllocator, resetResourceAllocator,
  detectHardware, throttleCurve, throttleInverse, describeThrottle,
  type HardwareProfile, type UserResourcePolicy, type ResourceBudget,
  type AllocationResult, type ResourceGrant,
} from "./utils/resource-allocator.js";

// ─── Agents / Agent 系统 ───────────────────────────────────
export {
  AgentRegistry, AGENT_TYPES, DEFAULT_RECURSION_LIMITS,
  type AgentType, type AgentTypeDefinition, type RecursionLimits,
} from "./agents/agent-registry.js";
export {
  SubAgentSystem, type SubAgentTask, type SubAgentResult,
} from "./agents/sub-agent-system.js";

// ─── Desktop Action Host / 桌面动作宿主 ───────────────────
export {
  DESKTOP_ACTION_PROTOCOL_VERSION, DESKTOP_ACTION_RESULT_TYPE,
  DESKTOP_ACTION_WORKSPACES, DESKTOP_ACTION_KINDS,
  DesktopActionRequestSchema, DesktopActionProtocolError,
  normalizeDesktopActionKind, parseDesktopActionRequest,
  failedDesktopAction, unsupportedDesktopAction,
  DesktopActionDispatcher, registerDesktopActionTool, invokeDesktopActionTool,
  type DesktopActionWorkspace, type DesktopActionKind,
  type DesktopActionStatus, type DesktopActionCapabilityLevel,
  type DesktopJsonValue, type DesktopActionRequest,
  type DesktopActionError, type DesktopActionResult,
  type DesktopActionDispatchContext, type DesktopActionDispatcherOptions,
  type DesktopToolResult,
} from "./desktop-action/index.js";

// ─── Version ────────────────────────────────────────────────
export const CANVAST_VERSION = "0.1.0";
