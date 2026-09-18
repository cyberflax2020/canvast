/**
 * =============================================================================
 * Canvast — Universal AI Agent Assistant / 通用 AI 智能助手
 * =============================================================================
 * @file        src/graph/types.ts
 * @brief       Canvas graph type definitions / 图谱画布类型定义
 * @description Core type system for the 4-node, 4-edge graph canvas.
 *              File, Plan, Decision, AgentRun nodes with typed edges.
 *              图谱画布核心类型：4 节点类型 + 4 边类型。
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * Changes:
 *   [2026-08-08] Initial implementation — 4 node types, 4 edge types
 * =============================================================================
 */

// ─── Node Types / 节点类型 ─────────────────────────────────

export type NodeType = "file" | "plan" | "decision" | "agent_run";

export interface GraphNode {
  id: string;
  type: NodeType;
  createdAt: string;       // ISO 8601
  updatedAt: string;       // ISO 8601
  properties: Record<string, unknown>;
}

// ─── Asset Layer / 资产层 ──────────────────────────────────

export interface FileNode extends GraphNode {
  type: "file";
  properties: {
    path: string;          // relative to project root
    checksum: string;      // SHA-256 of last known content
    version: string;       // git commit hash or incremental version
    producedBy?: string;   // AgentRun ID that created this file
    lastModified: string;
    size: number;          // bytes
    language?: string;     // programming language
    stale: boolean;        // whether Canvas knows the file has been modified externally
  };
}

export interface ExternalChangeEvent {
  id: string;
  fileNodeId: string;
  detectedAt: string;
  oldChecksum: string;
  newChecksum: string;
  diff?: string;           // git diff summary if available
  source: "human" | "other_agent" | "git_operation" | "unknown";
}

// ─── Plan Layer / 计划层 ───────────────────────────────────

export type PlanStatus = "draft" | "proposed" | "approved" | "in_progress" | "completed" | "cancelled";
export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface PlanNode extends GraphNode {
  type: "plan";
  properties: {
    goal: string;          // what this plan aims to achieve
    status: PlanStatus;
    scope: {               // files within plan scope
      files: string[];     // allowed file paths
      allowCreate: boolean;
      allowDelete: boolean;
    };
    constraints: string[]; // constraints that apply
    parentPlanId?: string; // if this is a sub-plan
    steps: PlanStep[];     // decomposed tasks
    approvedBy?: string;   // who approved
    approvedAt?: string;
  };
}

export interface PlanStep {
  id: string;
  order: number;
  description: string;
  taskId?: string;         // linked Task node ID
  status: TaskStatus;
}

// ─── Decision Layer / 决策层 ───────────────────────────────

export type DecisionType = "architecture" | "technology" | "implementation" | "constraint" | "lesson";

export interface DecisionNode extends GraphNode {
  type: "decision";
  properties: {
    problem: string;       // what problem this decision addresses
    chosen: string;        // the chosen solution
    alternatives: string[];// alternatives considered
    rationale: string;     // why this was chosen
    decisionType: DecisionType;
    madeBy: string;        // agent or human who made the decision
    madeAt: string;
    supersededBy?: string; // if this decision was later replaced
    stillValid: boolean;
  };
}

// ─── Agent Layer / 执行层 ──────────────────────────────────

export type AgentRunStatus = "running" | "completed" | "failed" | "cancelled";

export interface AgentRunNode extends GraphNode {
  type: "agent_run";
  properties: {
    task: string;          // task description
    agentType: string;     // general-purpose | explore | plan | review
    model: string;         // model used
    depth: number;         // recursion depth (0 = root)
    parentAgentId?: string;// parent AgentRun ID
    status: AgentRunStatus;
    startTime: string;
    endTime?: string;
    summary?: string;      // result summary
    errorMessage?: string;
    cleanupFailed?: boolean;
    outcomeUnknown?: boolean;
    terminalCause?: "timeout" | "emergency_stop" | "cleanup_failed";
    tokensUsed: number;
    cost: number;
    filesProduced: string[]; // FileNode IDs
    filesModified: string[]; // FileNode IDs
  };
}

// ─── Edge Types / 边类型 ───────────────────────────────────

export type EdgeType = "MOTIVATED_BY" | "PRODUCED_BY" | "DECOMPOSES_INTO" | "EXECUTED_BY";

export interface GraphEdge {
  id: string;
  type: EdgeType;
  fromNodeId: string;     // source node
  toNodeId: string;       // target node
  createdAt: string;
  properties?: Record<string, unknown>;
}

// ─── Canvas Scope / 画布作用域 ──────────────────────────────

/** Assembled context for an agent about to execute a task */
export interface CanvasScope {
  task: {
    id: string;
    description: string;
    parentPlanId?: string;
  };
  plan?: PlanNode;         // parent plan (if exists)
  decisions: DecisionNode[]; // motivating decisions
  files: FileNode[];       // relevant files
  relatedAgentRuns: AgentRunNode[]; // dependent agent results
  constraints: string[];   // applicable constraints
  staleWarnings: string[]; // files that may be out of date
}

// ─── Query Types / 查询类型 ────────────────────────────────

export interface TraversalOptions {
  maxDepth: number;        // max BFS depth (default 2)
  maxNodes: number;         // max nodes to return (default 10)
  edgeTypes?: EdgeType[];  // filter edge types
  nodeTypes?: NodeType[];  // filter node types
}

export interface CanvasQuery {
  /** Get the full traceability chain for a file */
  traceFile(fileNodeId: string): Promise<TraceChain>;
  /** Get the scope context for a task */
  scopeForTask(taskId: string): Promise<CanvasScope>;
  /** Search nodes by type and property */
  searchNodes(type: NodeType, propertyFilter?: Partial<Record<string, unknown>>): Promise<GraphNode[]>;
}

export interface TraceChain {
  file: FileNode;
  producedBy?: AgentRunNode;
  plan?: PlanNode;
  decision?: DecisionNode;
  externalChanges: ExternalChangeEvent[];
}
