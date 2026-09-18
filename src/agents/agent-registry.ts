/**
 * =============================================================================
 * Canvast — Agent Registry / Agent 注册中心
 * =============================================================================
 * @file        src/agents/agent-registry.ts
 * @brief       Agent type definitions, registry, and lifecycle management
 * @description Manages agent types (general-purpose, explore, plan, review),
 *              tracks active agents, enforces depth/fan-out limits, and
 *              provides ListAgents functionality. All state persisted to Canvas.
 *              管理 Agent 类型、追踪活跃 agent、执行深度/广度限制。
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * Changes: [2026-08-08] Initial implementation
 * =============================================================================
 */

import type { CanvasStore } from "../graph/canvas-store.js";
import type { AgentRunNode, AgentRunStatus } from "../graph/types.js";

// ─── Agent Types / Agent 类型 ──────────────────────────────

export type AgentType = "general-purpose" | "explore" | "plan" | "review";

export interface AgentTypeDefinition {
  type: AgentType;
  label: string;
  description: string;
  /** Tools this agent type has access to. "*" = all. */
  tools: string[] | "*";
  /** Whether this agent can spawn sub-agents (recursive) */
  canSpawnSubAgents: boolean;
  /** Whether this agent can enter plan mode */
  canPlanMode: boolean;
  /** Default model tier */
  defaultModelTier: "best" | "mid" | "cheap";
  /** Read-only? (explore, review agents) */
  readOnly: boolean;
}

// ─── Registry / 注册表 ─────────────────────────────────────

export const AGENT_TYPES: Record<AgentType, AgentTypeDefinition> = {
  "general-purpose": {
    type: "general-purpose",
    label: "General Purpose / 通用",
    description: "Full-capability agent for implementation work. 全功能实现 agent。",
    tools: "*",
    canSpawnSubAgents: true,
    canPlanMode: true,
    defaultModelTier: "best",
    readOnly: false,
  },
  explore: {
    type: "explore",
    label: "Explore / 探索",
    description: "Read-only agent for codebase exploration and search. 只读探索 agent。",
    tools: ["read", "grep", "find", "ls"],
    canSpawnSubAgents: false,
    canPlanMode: false,
    defaultModelTier: "cheap",
    readOnly: true,
  },
  plan: {
    type: "plan",
    label: "Plan / 规划",
    description: "Read-only agent for architecture planning. 只读规划 agent。",
    tools: ["read", "grep", "find", "ls", "web_fetch", "web_search"],
    canSpawnSubAgents: false,
    canPlanMode: true,
    defaultModelTier: "best",
    readOnly: true,
  },
  review: {
    type: "review",
    label: "Review / 审查",
    description: "Read-only agent for code and spec review. 只读审查 agent。",
    tools: ["read", "grep", "find", "ls"],
    canSpawnSubAgents: false,
    canPlanMode: false,
    defaultModelTier: "mid",
    readOnly: true,
  },
};

// ─── Agent Registry Manager / Agent 注册管理器 ─────────────

export interface RecursionLimits {
  maxDepth: number;           // max recursion depth (default 3)
  maxChildrenPerAgent: number; // max children per parent (default 4)
  maxTotalAgents: number;     // global max (default 16)
}

export const DEFAULT_RECURSION_LIMITS: RecursionLimits = {
  maxDepth: 3,
  maxChildrenPerAgent: 4,
  maxTotalAgents: 16,
};

const liveOwnersByStore = new WeakMap<CanvasStore, Map<string, WeakRef<AgentRegistry>>>();

export class AgentRegistry {
  private activeAgents = new Map<string, AgentRunNode>();
  private limits: RecursionLimits;
  private liveOwners: Map<string, WeakRef<AgentRegistry>>;

  constructor(
    private store: CanvasStore,
    limits?: Partial<RecursionLimits>,
  ) {
    this.limits = { ...DEFAULT_RECURSION_LIMITS, ...limits };
    this.liveOwners = liveOwnersByStore.get(store) ?? new Map();
    liveOwnersByStore.set(store, this.liveOwners);
    this.loadFromStore();
  }

  private reconcileHistoricalRunningAgent(agent: AgentRunNode): AgentRunNode {
    const endTime = new Date().toISOString();
    return this.store.updateNode<AgentRunNode>(agent.id, {
      status: "cancelled",
      endTime,
      errorMessage:
        "Recovered historical running agent from store during restart without a live-process proof; reconciled to cancelled so it does not consume active capacity.",
    }) || agent;
  }

  /** Load existing agents from Canvas store */
  private loadFromStore(): void {
    const agents = this.store.findNodesByType<AgentRunNode>("agent_run");
    for (const a of agents) {
      if (a.properties.status === "running") {
        if (!this.liveOwner(a.id)) this.reconcileHistoricalRunningAgent(a);
      }
    }
  }

  private liveOwner(id: string): AgentRegistry | undefined {
    const owner = this.liveOwners.get(id)?.deref();
    if (!owner) this.liveOwners.delete(id);
    return owner;
  }

  private liveAgentCount(): number {
    let count = 0;
    for (const id of this.liveOwners.keys()) {
      if (this.liveOwner(id)) count++;
    }
    return count;
  }

  /** Get agent type definition */
  getType(type: AgentType): AgentTypeDefinition {
    return AGENT_TYPES[type];
  }

  /** Check if spawning a new agent is allowed */
  canSpawn(parentDepth: number, parentId?: string): {
    allowed: boolean;
    reason?: string;
  } {
    // Depth limit
    if (parentDepth >= this.limits.maxDepth) {
      return {
        allowed: false,
        reason: `Max recursion depth reached (${this.limits.maxDepth}). Cannot spawn deeper agents. 已达最大递归深度。`,
      };
    }

    // Children per parent limit
    if (parentId) {
      const children = this.store.findNodesByProperty<AgentRunNode>("agent_run", {
        parentAgentId: parentId,
      });
      if (children.length >= this.limits.maxChildrenPerAgent) {
        return {
          allowed: false,
          reason: `Max children per agent reached (${this.limits.maxChildrenPerAgent}). 已达每 agent 最大子 agent 数。`,
        };
      }
    }

    // Global limit
    if (this.liveAgentCount() >= this.limits.maxTotalAgents) {
      return {
        allowed: false,
        reason: `Max total agents reached (${this.limits.maxTotalAgents}). Wait for some to complete. 已达全局最大 agent 数。`,
      };
    }

    return { allowed: true };
  }

  /** Register a new agent run */
  registerAgent(
    task: string,
    type: AgentType,
    model: string,
    depth: number,
    parentAgentId?: string,
  ): AgentRunNode {
    const admission = this.canSpawn(Math.max(0, depth - 1), parentAgentId);
    if (!admission.allowed) throw new Error(admission.reason);
    const now = new Date().toISOString();
    const node = this.store.createNode<AgentRunNode>({
      id: "",
      type: "agent_run",
      createdAt: now,
      updatedAt: now,
      properties: {
        task,
        agentType: type,
        model,
        depth,
        parentAgentId,
        status: "running",
        startTime: now,
        tokensUsed: 0,
        cost: 0,
        filesProduced: [],
        filesModified: [],
      },
    });
    this.activeAgents.set(node.id, node);
    this.liveOwners.set(node.id, new WeakRef(this));
    return node;
  }

  /** Update agent status */
  updateAgent(
    id: string,
    updates: Partial<AgentRunNode["properties"]>,
  ): AgentRunNode | undefined {
    const updated = this.store.updateNode<AgentRunNode>(id, updates);
    if (updated && updates.status && updates.status !== "running") {
      this.liveOwner(id)?.activeAgents.delete(id);
      this.liveOwners.delete(id);
    }
    return updated;
  }

  /** Get active agent count */
  get activeCount(): number {
    return this.activeAgents.size;
  }

  /** List all agents (for ListAgents tool) */
  listAgents(filter?: { status?: AgentRunStatus; depth?: number }): AgentRunNode[] {
    let agents = this.store.findNodesByType<AgentRunNode>("agent_run");
    if (filter?.status) {
      agents = agents.filter(a => a.properties.status === filter.status);
    }
    if (filter?.depth !== undefined) {
      agents = agents.filter(a => a.properties.depth === filter.depth);
    }
    return agents.sort(
      (a, b) => new Date(b.properties.startTime).getTime() - new Date(a.properties.startTime).getTime(),
    );
  }
}
