/**
 * =============================================================================
 * Canvast — Auto Orchestrator Types / Canvast 源文件
 * =============================================================================
 * @file        src/harness/auto-orchestrator/types.ts
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import type { GroundingStrategy } from "../grounding-policy.js";
import type { FollowUpPolicy, WebUsePolicy } from "../intent-signals.js";

export type OrchestrationMode = "direct" | "plan" | "subagents" | "workflow";
export type ContextHistoryPolicy = "recent_window" | "compact" | "recall" | "resume";
export type OrchestrationLifecycleAction = "enter" | "update" | "switch" | "exit";

export const explicitAgentLaunchSignalSchema = {
  spawnAgentTool: "spawn_agent",
  parallelAgentsTool: "parallel_agents",
  spawnAgentPhrase: "spawn agent",
  launchAgentPhrase: "launch agent",
  delegateAgentPhrase: "delegate agent",
  spawnAgentZhCompact: "派生agent",
  spawnAgentZh: "派生 agent",
  launchAgentZhCompact: "启动agent",
  launchAgentZh: "启动 agent",
} as const;

export type ExplicitAgentLaunchSignal =
  typeof explicitAgentLaunchSignalSchema[keyof typeof explicitAgentLaunchSignalSchema];

export function isExplicitAgentLaunchSignal(value: string): value is ExplicitAgentLaunchSignal {
  return Object.values(explicitAgentLaunchSignalSchema).some(signal => signal === value);
}

export type ToolDomain =
  | "local_search"
  | "file_read"
  | "file_write"
  | "shell"
  | "web"
  | "task"
  | "agent"
  | "workflow"
  | "canvas"
  | "test"
  | "review"
  | "monitor"
  | "package"
  | "tui";

export type { WebUsePolicy } from "../intent-signals.js";

export interface ContextStrategy {
  historyPolicy: ContextHistoryPolicy;
  compressionTrigger: string;
  recallSources: string[];
  resumePlan: string[];
  inputSources?: ContextInputSource[];
}

export type ContextInputSourceKind =
  | "session_recent"
  | "canvas_scope"
  | "context_recall"
  | "long_term_memory"
  | "tools_skills"
  | "harness_controls"
  | "task_files";

export interface ContextInputSource {
  kind: ContextInputSourceKind;
  budget: string;
  provenance: string;
  injectPolicy: "inline" | "manifest" | "pointer" | "on_demand" | "none";
}

export interface ToolCallPlanItem {
  domain: ToolDomain;
  tools: string[];
  purpose: string;
  order: "before_edit" | "during_edit" | "after_edit" | "as_needed";
  parallelSafe: boolean;
  webJustification?: string;
}

export interface DependencyAudit {
  isolatedCacheVerified?: boolean;
}

export interface AutoOrchestrationAssessment {
  id: string;
  prompt: string;
  mode: OrchestrationMode;
  requiresGate: boolean;
  requiresPlan: boolean;
  requiresSubagents: boolean;
  requiresWorkflow: boolean;
  complexityScore: number;
  triggers: string[];
  requiredToolDomains: ToolDomain[];
  optionalToolDomains: ToolDomain[];
  webUsePolicy: WebUsePolicy;
  webTriggers: string[];
  planOnlyIntent: boolean;
  requiresContextManagement: boolean;
  contextTriggers: string[];
  followUpPolicy: FollowUpPolicy;
  followUpTriggers: string[];
  requiresTaskAdjustment: boolean;
  ambiguousOptimizationIntent: boolean;
  planProposalIntent?: boolean;
  localSearchLike: boolean;
  requiresLocalSearchStrategy: boolean;
  simpleWriteVerification?: boolean;
  promptLocalContextValidation?: boolean;
  promptLocalSubagentValidation?: boolean;
  promptLocalEnhancedValidation?: boolean;
  externalSourceAnswerIntent?: boolean;
  createdAt: string;
}

export type OrchestrationBatchCheckpoint =
  | "on_tool_success"
  | "on_tool_error"
  | "on_turn_settle"
  | "on_plan_approved"
  | "on_workflow_stage";

export type OrchestrationBatchCandidateStatus = "queued" | "interrupt" | "deferred";
export type OrchestrationRuntimeStatusPlane =
  | "tasks"
  | "plans"
  | "subAgents"
  | "workflows"
  | "toolRuns";
export type OrchestrationRuntimeItemStatus =
  | "pending"
  | "in_progress"
  | "running"
  | "completed"
  | "blocked"
  | "failed"
  | "aborted"
  | "stale"
  | "unknown";
export type SupersedeMergeDisposition =
  | "continue_under_replacement"
  | "cancel_as_redundant"
  | "preserve_completed_evidence";

export interface SupersedeMergeItemEvidence {
  plane: OrchestrationRuntimeStatusPlane;
  itemId: string;
  status: OrchestrationRuntimeItemStatus;
  updatedAt: string;
  disposition: SupersedeMergeDisposition;
}

export interface SupersedeMergeEvidence {
  targetRootRequestId: string;
  items: SupersedeMergeItemEvidence[];
}

export type OrchestrationBatchPrimaryDependency = "none" | "snapshot" | "live";

export interface OrchestrationBatchBranchEvidence {
  selfContained: boolean;
  primaryDependency: OrchestrationBatchPrimaryDependency;
  dependsOnBranchIds: string[];
  writeTargets: string[];
  externalResourceKeys: string[];
}

export interface OrchestrationBatchPlan {
  batchId: string;
  revision: number;
  checkpoint: OrchestrationBatchCheckpoint;
  candidateHash: string;
  admittedAt: string;
  items: OrchestrationBatchItem[];
}

export interface OrchestrationBatchItem {
  id: string;
  requestId: string;
  sequence: number;
  timestamp: string;
  status: OrchestrationBatchCandidateStatus;
  policy: "supersede_merge" | "amend_current" | "parallel_independent" | "serial_after_current" | "defer" | "pause" | "cancel";
  relation: {
    targetTaskId?: string;
    dependencyIds?: string[];
    priority?: number;
    branchEvidence?: OrchestrationBatchBranchEvidence;
  };
  supersedeEvidence?: SupersedeMergeEvidence;
  deferInfo?: {
    reasonCode: string;
    blockerTaskIds: string[];
    reevaluateAt: OrchestrationBatchCheckpoint;
  };
}

export interface RecordedOrchestrationDecision {
  assessmentId: string;
  mode: OrchestrationMode;
  lifecycleAction?: OrchestrationLifecycleAction;
  batchPlan?: OrchestrationBatchPlan;
  taskSummary: string;
  rationale: string;
  observableReasoningSummary: string[];
  planSteps: string[];
  subagentTasks: string[];
  workflowSteps: string[];
  scopeFiles: string[];
  toolCallPlan: ToolCallPlanItem[];
  verificationSteps: string[];
  webUse: WebUsePolicy;
  webJustification?: string;
  dependencyAudit?: DependencyAudit;
  groundingStrategy?: GroundingStrategy;
  localEvidenceUsed?: boolean;
  contextStrategy?: ContextStrategy;
  recordedAt: string;
}

export interface ToolBlockDecision {
  block: boolean;
  reason?: string;
}

export interface ToolCallEvent {
  toolCallId?: string;
  toolName?: string;
  tool_name?: string;
  name?: string;
  input?: Record<string, unknown>;
  args?: Record<string, unknown>;
  arguments?: Record<string, unknown> | string;
}

export interface ToolResultEvent {
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  aborted?: boolean;
  cancelled?: boolean;
  interrupted?: boolean;
  details?: unknown;
}

export interface OrchestrationExecutionState {
  agentLaunched?: boolean;
  planProposed?: boolean;
  planApproved?: boolean;
}
