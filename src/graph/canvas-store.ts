/**
 * =============================================================================
 * Canvast — Universal AI Agent Assistant / 通用 AI 智能助手
 * =============================================================================
 * @file        src/graph/canvas-store.ts
 * @brief       In-memory Canvas graph store with JSON export/import
 *              内存图谱存储（JSON 导出/导入）
 * @description Storage for the 4-node, 4-edge graph canvas. In-memory Maps
 *              with JSON export/import; persistence is the caller's
 *              responsibility (see extensions/canvast-core.ts).
 *              Implements CRUD, BFS traversal, and stale file detection.
 *              4节点4边图谱存储。内存 Map + JSON 导出/导入，
 *              持久化由调用方负责。实现 CRUD、BFS 遍历、文件过期检测。
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * Changes:
 *   [2026-08-08] Initial implementation — in-memory graph storage
 *   [2026-08-09] Header corrected: implementation is in-memory, not SQLite
 * =============================================================================
 */

import { randomUUID } from "node:crypto";
import type {
  GraphNode, GraphEdge, FileNode, PlanNode, DecisionNode, AgentRunNode,
  NodeType, EdgeType, TraversalOptions, ExternalChangeEvent,
} from "./types.js";

// ─── In-Memory Store ───────────────────────────────────────

/**
 * CanvasStore — graph storage.
 * In-memory Maps with JSON export/import; the API is backend-agnostic.
 */
export class CanvasStore {
  private nodes = new Map<string, GraphNode>();
  private edges = new Map<string, GraphEdge>();
  private externalChanges = new Map<string, ExternalChangeEvent[]>();

  // ─── Performance Indexes / 性能索引 ───────────────────────
  // Maintained incrementally on every mutation so hot-path queries
  // (getEdgesFrom/To, findNodesByType/Property) are O(1) lookups
  // instead of O(n) full scans. 增量维护，热路径查询 O(1)。
  private nodesByType = new Map<NodeType, Set<string>>();
  private edgesFrom = new Map<string, Set<string>>(); // nodeId → edgeIds
  private edgesTo = new Map<string, Set<string>>();   // nodeId → edgeIds
  private fileNodesByPath = new Map<string, string>(); // path → nodeId

  // ─── Node CRUD ───────────────────────────────────────────

  createNode<T extends GraphNode>(node: T): T {
    const id = node.id || this.generateId(node.type);
    const now = new Date().toISOString();
    const created = { ...node, id, createdAt: now, updatedAt: now } as T;
    this.nodes.set(id, created);
    // Maintain type index
    let typeSet = this.nodesByType.get(node.type);
    if (!typeSet) {
      typeSet = new Set();
      this.nodesByType.set(node.type, typeSet);
    }
    typeSet.add(id);
    this.indexFileNode(created);
    return created;
  }

  getNode<T extends GraphNode = GraphNode>(id: string): T | undefined {
    return this.nodes.get(id) as T | undefined;
  }

  updateNode<T extends GraphNode>(id: string, updates: Partial<T["properties"]>): T | undefined {
    const node = this.nodes.get(id) as T | undefined;
    if (!node) return undefined;
    this.unindexFileNode(node);
    const updated = {
      ...node,
      properties: { ...node.properties, ...updates },
      updatedAt: new Date().toISOString(),
    } as T;
    this.nodes.set(id, updated);
    this.indexFileNode(updated);
    return updated;
  }

  /**
   * Delete a node from the store.
   * Use with caution — prefer GC-driven deletion over manual.
   * Nodes referenced by active edges should not be deleted without
   * also cleaning up edges (see deleteEdgesForNode).
   * 删除节点。优先使用 GC 驱动删除而非手动。被活跃边引用的节点
   * 在删除前需先清理边。
   */
  deleteNode(id: string): boolean {
    const node = this.nodes.get(id);
    if (!node) return false;
    this.nodes.delete(id);
    // Clean up edges referencing this node (via adjacency index)
    this.deleteEdgesForNode(id);
    // Clean up external changes
    this.externalChanges.delete(id);
    this.unindexFileNode(node);
    // Maintain type index
    const typeSet = this.nodesByType.get(node.type);
    if (typeSet) {
      typeSet.delete(id);
      if (typeSet.size === 0) this.nodesByType.delete(node.type);
    }
    return true;
  }

  /** Delete an edge by its ID */
  deleteEdge(edgeId: string): boolean {
    const edge = this.edges.get(edgeId);
    if (!edge) return false;
    this.edges.delete(edgeId);
    // Maintain adjacency indexes
    this.edgesFrom.get(edge.fromNodeId)?.delete(edgeId);
    this.edgesTo.get(edge.toNodeId)?.delete(edgeId);
    return true;
  }

  /** Delete all edges connected to a node. Returns count removed. */
  deleteEdgesForNode(nodeId: string): number {
    let count = 0;
    const fromIds = this.edgesFrom.get(nodeId);
    if (fromIds) {
      for (const edgeId of fromIds) {
        const edge = this.edges.get(edgeId);
        if (edge) {
          this.edges.delete(edgeId);
          this.edgesTo.get(edge.toNodeId)?.delete(edgeId);
          count++;
        }
      }
      this.edgesFrom.delete(nodeId);
    }
    const toIds = this.edgesTo.get(nodeId);
    if (toIds) {
      for (const edgeId of toIds) {
        const edge = this.edges.get(edgeId);
        if (edge) {
          this.edges.delete(edgeId);
          this.edgesFrom.get(edge.fromNodeId)?.delete(edgeId);
          count++;
        }
      }
      this.edgesTo.delete(nodeId);
    }
    return count;
  }

  findNodesByType<T extends GraphNode = GraphNode>(type: NodeType): T[] {
    const typeSet = this.nodesByType.get(type);
    if (!typeSet) return [];
    const result: T[] = new Array(typeSet.size);
    let i = 0;
    for (const id of typeSet) {
      result[i++] = this.nodes.get(id) as T;
    }
    return result;
  }

  findNodesByProperty<T extends GraphNode = GraphNode>(
    type: NodeType,
    filter: Partial<Record<string, unknown>>,
  ): T[] {
    const typeSet = this.nodesByType.get(type);
    if (!typeSet) return [];
    const keys = Object.keys(filter);
    const result: T[] = [];
    for (const id of typeSet) {
      const n = this.nodes.get(id) as T | undefined;
      if (!n) continue;
      let match = true;
      for (const k of keys) {
        if (n.properties[k] !== filter[k]) { match = false; break; }
      }
      if (match) result.push(n);
    }
    return result;
  }

  // ─── Edge CRUD ───────────────────────────────────────────

  createEdge(edge: Omit<GraphEdge, "id" | "createdAt">): GraphEdge {
    const id = this.generateId("edge");
    const created: GraphEdge = { ...edge, id, createdAt: new Date().toISOString() };
    this.edges.set(id, created);
    // Maintain adjacency indexes
    let fromSet = this.edgesFrom.get(edge.fromNodeId);
    if (!fromSet) { fromSet = new Set(); this.edgesFrom.set(edge.fromNodeId, fromSet); }
    fromSet.add(id);
    let toSet = this.edgesTo.get(edge.toNodeId);
    if (!toSet) { toSet = new Set(); this.edgesTo.set(edge.toNodeId, toSet); }
    toSet.add(id);
    return created;
  }

  getEdgesFrom(nodeId: string, type?: EdgeType): GraphEdge[] {
    const fromSet = this.edgesFrom.get(nodeId);
    if (!fromSet) return [];
    if (!type) {
      const result: GraphEdge[] = new Array(fromSet.size);
      let i = 0;
      for (const edgeId of fromSet) {
        result[i++] = this.edges.get(edgeId)!;
      }
      return result;
    }
    const result: GraphEdge[] = [];
    for (const edgeId of fromSet) {
      const e = this.edges.get(edgeId)!;
      if (e.type === type) result.push(e);
    }
    return result;
  }

  getEdgesTo(nodeId: string, type?: EdgeType): GraphEdge[] {
    const toSet = this.edgesTo.get(nodeId);
    if (!toSet) return [];
    if (!type) {
      const result: GraphEdge[] = new Array(toSet.size);
      let i = 0;
      for (const edgeId of toSet) {
        result[i++] = this.edges.get(edgeId)!;
      }
      return result;
    }
    const result: GraphEdge[] = [];
    for (const edgeId of toSet) {
      const e = this.edges.get(edgeId)!;
      if (e.type === type) result.push(e);
    }
    return result;
  }

  // ─── BFS Traversal ───────────────────────────────────────

  traverse(fromNodeId: string, options: TraversalOptions): GraphNode[] {
    const { maxDepth = 2, maxNodes = 10, edgeTypes, nodeTypes } = options;
    const visited = new Set<string>();
    const result: GraphNode[] = [];
    // Use an index-based queue instead of Array.shift() (O(n) per shift) so
    // BFS stays O(V+E) even on large graphs. 用索引队列替代 shift()，避免 O(n) 出队。
    const queue: Array<{ nodeId: string; depth: number }> = [{ nodeId: fromNodeId, depth: 0 }];
    let head = 0;

    while (head < queue.length && result.length < maxNodes) {
      const current = queue[head++];
      if (visited.has(current.nodeId)) continue;
      if (current.depth > maxDepth) continue;
      visited.add(current.nodeId);

      const node = this.nodes.get(current.nodeId);
      if (node) {
        if (!nodeTypes || nodeTypes.includes(node.type)) {
          result.push(node);
        }
        // Expand outward (follow edges in both directions)
        const outgoing = this.getEdgesFrom(current.nodeId)
          .filter(e => !edgeTypes || edgeTypes.includes(e.type));
        const incoming = this.getEdgesTo(current.nodeId)
          .filter(e => !edgeTypes || edgeTypes.includes(e.type));

        for (const e of [...outgoing, ...incoming]) {
          const nextId = e.fromNodeId === current.nodeId ? e.toNodeId : e.fromNodeId;
          if (!visited.has(nextId)) {
            queue.push({ nodeId: nextId, depth: current.depth + 1 });
          }
        }
      }
    }
    return result;
  }

  // ─── Traceability Chain ──────────────────────────────────

  /** Trace a File back through AgentRun → Plan → Decision */
  traceFile(fileNodeId: string): {
    file?: FileNode;
    agentRuns: AgentRunNode[];
    plans: PlanNode[];
    decisions: DecisionNode[];
    changes: ExternalChangeEvent[];
  } {
    const file = this.nodes.get(fileNodeId) as FileNode | undefined;
    const agentRuns = this.traverse(fileNodeId, {
      maxDepth: 3, maxNodes: 20, nodeTypes: ["agent_run", "plan", "decision"],
    });
    const changes = this.externalChanges.get(fileNodeId) || [];
    return {
      file,
      agentRuns: agentRuns.filter(n => n.type === "agent_run") as AgentRunNode[],
      plans: agentRuns.filter(n => n.type === "plan") as PlanNode[],
      decisions: agentRuns.filter(n => n.type === "decision") as DecisionNode[],
      changes,
    };
  }

  // ─── Stale Detection / 过期检测 ───────────────────────────

  recordExternalChange(fileNodeId: string, change: ExternalChangeEvent): void {
    const changes = this.externalChanges.get(fileNodeId) || [];
    changes.push(change);
    this.externalChanges.set(fileNodeId, changes);
    // Mark the file node as stale
    const file = this.nodes.get(fileNodeId) as FileNode | undefined;
    if (file) {
      this.updateNode<FileNode>(fileNodeId, { stale: true });
    }
  }

  getExternalChanges(fileNodeId: string): ExternalChangeEvent[] {
    return this.externalChanges.get(fileNodeId) || [];
  }

  isFileStale(fileNodeId: string): boolean {
    const file = this.nodes.get(fileNodeId) as FileNode | undefined;
    return file?.properties.stale ?? false;
  }

  /** Detect stale files by comparing checksums */
  async detectStaleFile(
    fileNodeId: string,
    actualChecksum: string,
    source: ExternalChangeEvent["source"] = "unknown",
  ): Promise<boolean> {
    const file = this.nodes.get(fileNodeId) as FileNode | undefined;
    if (!file) return false;
    if (file.properties.checksum === actualChecksum) {
      // File hasn't changed → mark as fresh
      if (file.properties.stale) {
        this.updateNode<FileNode>(fileNodeId, { stale: false });
      }
      return false;
    }
    // File changed externally
    this.recordExternalChange(fileNodeId, {
      id: this.generateId("change"),
      fileNodeId,
      detectedAt: new Date().toISOString(),
      oldChecksum: file.properties.checksum,
      newChecksum: actualChecksum,
      source,
    });
    return true;
  }

  // ─── Canvas Scope Assembly ───────────────────────────────

  /** Assemble a Canvas scope context package for a given task */
  assembleScope(taskId: string): {
    task?: PlanNode;
    plan?: PlanNode;
    decisions: DecisionNode[];
    files: FileNode[];
    agentRuns: AgentRunNode[];
    staleWarnings: string[];
  } {
    const task = this.nodes.get(taskId) as PlanNode | undefined;
    if (!task) return { decisions: [], files: [], agentRuns: [], staleWarnings: [] };

    // Find parent plan
    const planEdges = this.getEdgesTo(taskId, "DECOMPOSES_INTO");
    const planId = planEdges[0]?.fromNodeId;
    const plan = planId ? (this.nodes.get(planId) as PlanNode | undefined) : undefined;

    // Find motivating decisions
    const decisions = planId
      ? this.traverse(planId, { maxDepth: 2, maxNodes: 5, nodeTypes: ["decision"], edgeTypes: ["MOTIVATED_BY"] })
          .filter(n => n.type === "decision") as DecisionNode[]
      : [];

    // Find relevant files (from plan scope)
    const files = (plan?.properties.scope?.files || [])
      .map(path => this.findNodesByProperty<FileNode>("file", { path })[0])
      .filter(Boolean);

    // Find dependent agent runs
    const agentRuns = this.getEdgesTo(taskId, "EXECUTED_BY")
      .map(e => this.nodes.get(e.fromNodeId) as AgentRunNode | undefined)
      .filter(Boolean) as AgentRunNode[];

    // Check for stale files
    const staleWarnings = files
      .filter(f => this.isFileStale(f.id))
      .map(f => `File ${f.properties.path} has been modified externally. Canvas data may be stale.`);

    return { task, plan, decisions, files, agentRuns, staleWarnings };
  }

  // ─── Utilities ───────────────────────────────────────────

  private generateId(prefix: string): string {
    // UUID v4: collision-safe across processes and rapid successive calls
    // (former Date.now()+6-random-chars scheme had birthday collision risk).
    return `${prefix}_${randomUUID()}`;
  }

  /** Export full graph for persistence */
  export(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    return {
      nodes: Array.from(this.nodes.values()),
      edges: Array.from(this.edges.values()),
    };
  }

  /** Import graph from persisted state */
  import(data: { nodes: GraphNode[]; edges: GraphEdge[] }): void {
    this.nodes.clear();
    this.edges.clear();
    this.nodesByType.clear();
    this.edgesFrom.clear();
    this.edgesTo.clear();
    this.fileNodesByPath.clear();
    // Also clear external-change records: after a re-import they would
    // reference node IDs that no longer exist, making isFileStale() lie.
    // 重导入后外部变更记录会指向不存在的节点，必须一并清空。
    this.externalChanges.clear();
    for (const n of data.nodes) {
      this.nodes.set(n.id, n);
      this.indexNode(n);
    }
    for (const e of data.edges) {
      this.edges.set(e.id, e);
      this.indexEdge(e);
    }
  }

  /** Number of nodes */
  get nodeCount(): number { return this.nodes.size; }
  /** Number of edges */
  get edgeCount(): number { return this.edges.size; }

  /** Get node counts by type for monitoring */
  get nodeCountsByType(): Record<NodeType, number> {
    const counts: Record<NodeType, number> = { file: 0, plan: 0, decision: 0, agent_run: 0 };
    for (const [, node] of this.nodes) {
      counts[node.type]++;
    }
    return counts;
  }

  /** Estimated memory usage of the store (bytes, rough estimate) */
  estimateMemoryBytes(): number {
    let total = 0;
    for (const [, node] of this.nodes) {
      total += JSON.stringify(node).length * 2; // UTF-16
    }
    for (const [, edge] of this.edges) {
      total += JSON.stringify(edge).length * 2;
    }
    for (const [, changes] of this.externalChanges) {
      for (const c of changes) {
        total += JSON.stringify(c).length * 2;
      }
    }
    return total;
  }

  /** Check if store exceeds recommended size limits */
  exceedsSizeLimit(maxNodes: number, maxEdges: number): boolean {
    return this.nodes.size > maxNodes || this.edges.size > maxEdges;
  }

  private indexNode(node: GraphNode): void {
    let typeSet = this.nodesByType.get(node.type);
    if (!typeSet) {
      typeSet = new Set();
      this.nodesByType.set(node.type, typeSet);
    }
    typeSet.add(node.id);
    this.indexFileNode(node);
  }

  private indexEdge(edge: GraphEdge): void {
    let fromSet = this.edgesFrom.get(edge.fromNodeId);
    if (!fromSet) {
      fromSet = new Set();
      this.edgesFrom.set(edge.fromNodeId, fromSet);
    }
    fromSet.add(edge.id);

    let toSet = this.edgesTo.get(edge.toNodeId);
    if (!toSet) {
      toSet = new Set();
      this.edgesTo.set(edge.toNodeId, toSet);
    }
    toSet.add(edge.id);
  }

  private indexFileNode(node: GraphNode): void {
    if (node.type !== "file") return;
    const filePath = (node as FileNode).properties.path;
    if (typeof filePath === "string" && filePath.trim()) {
      this.fileNodesByPath.set(filePath, node.id);
    }
  }

  private unindexFileNode(node: GraphNode): void {
    if (node.type !== "file") return;
    const filePath = (node as FileNode).properties.path;
    if (typeof filePath === "string" && this.fileNodesByPath.get(filePath) === node.id) {
      this.fileNodesByPath.delete(filePath);
    }
  }
}
