/**
 * =============================================================================
 * Canvast — Core Canvas Integration (Persistent) / 核心画布集成（持久化）
 * =============================================================================
 * @file        extensions/canvast-core.ts
 * @brief       Wires persistent CanvasStore into pi runtime.
 * @description This is THE Canvast extension. Canvas state survives restarts
 *              via JSON file persistence (atomic temp-file + rename writes).
 *              Provides canvas_record, canvas_query, canvas_trace tools.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * Changes:
 *   [2026-08-08] Initial version with in-memory store
 *   [2026-08-08] Added JSON file persistence — canvas survives restarts
 * =============================================================================
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as path from "path";

import {
  appendCanvastIdentityPrompt,
  enforceCanvastInternalInfoBoundary,
} from "../src/harness/product-identity.js";
import { readSafeJson, writeSafeJson } from "../src/harness/safe-json-file.js";

function registerDesktopProviderEndpoint(pi: ExtensionAPI): void {
  const provider = String(process.env.CANVAST_PROVIDER || "").trim();
  const rawBaseUrl = String(process.env.CANVAST_BASE_URL || "").trim();
  if (!rawBaseUrl) return;
  if (!provider) throw new Error("CANVAST_PROVIDER is required when CANVAST_BASE_URL is configured.");

  let endpoint: URL;
  try {
    endpoint = new URL(rawBaseUrl);
  } catch {
    throw new Error("CANVAST_BASE_URL must be a valid HTTPS URL.");
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("CANVAST_BASE_URL must be an HTTPS URL without credentials, query, or fragment.");
  }

  // This override is intentionally endpoint-only. The API key remains ephemeral in the
  // provider's environment variable and never enters models.json or another state file.
  const endpointText = endpoint.toString();
  pi.registerProvider(provider, {
    baseUrl: endpointText.endsWith("/") ? endpointText.slice(0, -1) : endpointText,
  });
}

// ─── Persistent Canvas Store ───────────────────────────────

interface GraphNode { id: string; type: string; createdAt: string; updatedAt: string; properties: Record<string, unknown>; }
interface GraphEdge { id: string; type: string; fromNodeId: string; toNodeId: string; createdAt: string; }

class CanvasStore {
  private nodes = new Map<string, GraphNode>();
  private edges = new Map<string, GraphEdge>();
  private persistPath: string;
  private persistenceHealth: { healthy: boolean; message?: string } = { healthy: true };

  constructor(storageDir: string) {
    this.persistPath = path.join(storageDir, "canvas-graph.json");
    this.load();
  }

  // ─── Persistence ──────────────────────────────────────
  private save(): void {
    const data = {
      nodes: Array.from(this.nodes.values()),
      edges: Array.from(this.edges.values()),
      savedAt: new Date().toISOString(),
    };
    try {
      writeSafeJson(this.persistPath, data, true);
      this.persistenceHealth = { healthy: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.persistenceHealth = { healthy: false, message };
      throw new Error(`Canvas persistence failed: ${message}`);
    }
  }

  private load(): void {
    const loaded = readSafeJson<{ nodes?: GraphNode[]; edges?: GraphEdge[] }>(this.persistPath, true);
    if (loaded.status === "missing") return;
    if (loaded.status === "corrupt") {
      this.persistenceHealth = { healthy: false, message: `Canvas state is corrupt: ${loaded.error}` };
      return;
    }
    if (!Array.isArray(loaded.value.nodes) || !Array.isArray(loaded.value.edges)) {
      this.persistenceHealth = { healthy: false, message: "Canvas state has an invalid graph schema." };
      return;
    }
    for (const node of loaded.value.nodes) this.nodes.set(node.id, node);
    for (const edge of loaded.value.edges) this.edges.set(edge.id, edge);
    this.persistenceHealth = loaded.source === "last-known-good"
      ? { healthy: false, message: "Canvas primary state was corrupt; loaded last-known-good state." }
      : { healthy: true };
  }

  // ─── Node CRUD ────────────────────────────────────────
  createNode<T extends GraphNode>(node: T): T {
    const id = node.id || `${node.type}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const created = { ...node, id, createdAt: now, updatedAt: now } as T;
    this.nodes.set(id, created);
    try {
      this.save();
    } catch (error) {
      this.nodes.delete(id);
      throw error;
    }
    return created;
  }

  getNode<T extends GraphNode = GraphNode>(id: string): T | undefined {
    return this.nodes.get(id) as T | undefined;
  }

  findNodesByType<T extends GraphNode = GraphNode>(type: string): T[] {
    return Array.from(this.nodes.values()).filter(n => n.type === type) as T[];
  }

  // ─── Edge CRUD ────────────────────────────────────────
  createEdge(edge: Omit<GraphEdge, "id" | "createdAt">): GraphEdge {
    const id = `edge_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const created: GraphEdge = { ...edge, id, createdAt: new Date().toISOString() };
    this.edges.set(id, created);
    try {
      this.save();
    } catch (error) {
      this.edges.delete(id);
      throw error;
    }
    return created;
  }

  getEdgesFrom(nodeId: string, type?: string): GraphEdge[] {
    return Array.from(this.edges.values()).filter(e => e.fromNodeId === nodeId && (!type || e.type === type));
  }

  getEdgesTo(nodeId: string, type?: string): GraphEdge[] {
    return Array.from(this.edges.values()).filter(e => e.toNodeId === nodeId && (!type || e.type === type));
  }

  // ─── BFS Traversal ────────────────────────────────────
  traverse(fromNodeId: string, maxDepth: number = 2, maxNodes: number = 20): GraphNode[] {
    const visited = new Set<string>();
    const result: GraphNode[] = [];
    const queue: Array<{ nodeId: string; depth: number }> = [{ nodeId: fromNodeId, depth: 0 }];
    while (queue.length > 0 && result.length < maxNodes) {
      const cur = queue.shift()!;
      if (visited.has(cur.nodeId) || cur.depth > maxDepth) continue;
      visited.add(cur.nodeId);
      const node = this.nodes.get(cur.nodeId);
      if (node) {
        result.push(node);
        for (const e of [...this.getEdgesFrom(cur.nodeId), ...this.getEdgesTo(cur.nodeId)]) {
          const next = e.fromNodeId === cur.nodeId ? e.toNodeId : e.fromNodeId;
          if (!visited.has(next)) queue.push({ nodeId: next, depth: cur.depth + 1 });
        }
      }
    }
    return result;
  }

  get nodeCount(): number { return this.nodes.size; }
  get edgeCount(): number { return this.edges.size; }
  get health(): { healthy: boolean; message?: string } { return { ...this.persistenceHealth }; }
}

// ─── Extension ────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  registerDesktopProviderEndpoint(pi);
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME || "/tmp", ".canvast");
  const store = new CanvasStore(agentDir);

  pi.on("message_end", async (event: any) => {
    const guarded = enforceCanvastInternalInfoBoundary(event?.message);
    return guarded.redacted ? { message: guarded.message } : undefined;
  });

  // ─── canvas_record ────────────────────────────────────
  pi.registerTool({
    name: "canvas_record",
    label: "Canvas Record / 画布记录",
    description: `Record a decision, plan, file reference, or agent run to the Canvas.
The Canvas survives session restarts — recorded knowledge persists.
Use for architecture decisions, design choices, project plans, and lessons learned.`,
    parameters: Type.Object({
      type: Type.Union([Type.Literal("decision"), Type.Literal("plan"), Type.Literal("file"), Type.Literal("agent_run")]),
      content: Type.String({ description: "What to record" }),
      rationale: Type.Optional(Type.String({ description: "For decisions: why this was chosen" })),
      alternatives: Type.Optional(Type.String({ description: "Alternatives considered (comma-separated)" })),
      links: Type.Optional(Type.Array(Type.String({ description: "Node IDs to link to" }))),
    }),
    async execute(_id: string, params: any, _signal, _onUpdate) {
      if (!store.health.healthy) {
        return { isError: true, content: [{ type: "text" as const, text: `Canvas persistence unhealthy: ${store.health.message}` }], details: { health: store.health } };
      }
      const { type, content, rationale, alternatives, links } = params;
      const now = new Date().toISOString();
      let node: GraphNode;
      try {
        node = store.createNode({
          id: "", type, createdAt: now, updatedAt: now,
          properties: type === "decision"
            ? { chosen: content, rationale: rationale || "", alternatives: alternatives ? alternatives.split(",").map((s: string) => s.trim()) : [], madeAt: now, stillValid: true }
            : type === "plan"
            ? { goal: content, status: "draft", scope: { files: [], allowCreate: true, allowDelete: false }, constraints: [], steps: [] }
            : type === "file"
            ? { path: content, checksum: "", version: "initial", lastModified: now, stale: false, size: 0 }
            : { task: content, agentType: "general-purpose", model: "n/a", depth: 0, startTime: now, status: "running", tokensUsed: 0, cost: 0, filesProduced: [], filesModified: [] },
        } as any);
        if (links) for (const lid of links) store.createEdge({ type: "MOTIVATED_BY", fromNodeId: node.id, toNodeId: lid });
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], details: { health: store.health } };
      }
      return {
        content: [{ type: "text" as const, text: `✅ Recorded [${type}]: ${content}\nNode ID: ${node.id}\nCanvas: ${store.nodeCount} nodes, ${store.edgeCount} edges (persisted to disk)` }],
        details: { nodeId: node.id, type, canvasStats: { nodes: store.nodeCount, edges: store.edgeCount } },
      };
    },
  });

  // ─── canvas_query ──────────────────────────────────────
  pi.registerTool({
    name: "canvas_query",
    label: "Canvas Query / 画布查询",
    description: `Query the Canvast Graph Canvas. Actions: search, trace, stats.
The canvas contains persistent, queryable project knowledge that survives restarts.`,
    parameters: Type.Object({
      action: Type.Union([Type.Literal("search"), Type.Literal("trace"), Type.Literal("stats")]),
      query: Type.Optional(Type.String({ description: "Search term or node ID" })),
      node_type: Type.Optional(Type.Union([Type.Literal("file"), Type.Literal("plan"), Type.Literal("decision"), Type.Literal("agent_run")])),
    }),
    async execute(_id: string, params: any, _signal, _onUpdate) {
      if (!store.health.healthy) {
        return { isError: true, content: [{ type: "text" as const, text: `Canvas persistence unhealthy: ${store.health.message}` }], details: { health: store.health } };
      }
      const { action, query, node_type } = params;
      if (action === "trace" && query) {
        const nodes = store.traverse(query, 3, 20);
        const text = nodes.length === 0 ? "No trace found. 未找到溯源链。" : nodes.map(n => {
          const p = n.properties as any;
          return `[${n.type}] ${p.goal || p.path || p.chosen || p.task || n.id}${p.rationale ? ` — ${p.rationale}` : ""}`;
        }).join("\n  → ");
        return { content: [{ type: "text" as const, text: `## Canvas Trace\n\n${text}` }], details: undefined };
      }
      if (action === "search") {
        const nodes = node_type ? store.findNodesByType(node_type) : Array.from(store["nodes"].values()) as GraphNode[];
        const filtered = query ? nodes.filter(n => JSON.stringify(n.properties).toLowerCase().includes(query.toLowerCase())) : nodes;
        const text = filtered.slice(-20).map(n => {
          const p = n.properties as any;
          return `[${n.type}] ${p.goal || p.path || p.chosen || p.task || n.id}`;
        }).join("\n");
        return { content: [{ type: "text" as const, text: `# Canvas Search (${filtered.length} results)\n\n${text || "No matches."}` }], details: undefined };
      }
      // stats
      const byType: Record<string, number> = {};
      for (const n of store["nodes"].values()) byType[(n as GraphNode).type] = (byType[(n as GraphNode).type] || 0) + 1;
      return { content: [{ type: "text" as const, text: `# Canvas Stats\nNodes: ${store.nodeCount} | Edges: ${store.edgeCount}\n${Object.entries(byType).map(([t,c]) => `  ${t}: ${c}`).join("\n")}\n\n💾 Persisted to disk — survives restarts.` }], details: undefined };
    },
  });

  // ─── Context injection ─────────────────────────────────
  // pi contract: a before_agent_start handler must RETURN { systemPrompt }
  // (or { message }) to inject context. There is NO ctx.appendSystemPrompt on
  // pi's ExtensionContext, so the old append-based injection was silently
  // dropped (2026-08-15: found in Step 2-B wiring audit). Return the digest via
  // the chained prompt like the harness extension does.
  pi.on("before_agent_start", async (event: any, _ctx: any) => {
    const base = appendCanvastIdentityPrompt(event?.systemPrompt || "");
    if (!store.health.healthy) {
      return { systemPrompt: `${base}\n\n## Canvas Persistence Health Failure\n${store.health.message}\nCanvas scope and persisted claims must be treated as unavailable.` };
    }
    if (store.nodeCount === 0) return { systemPrompt: base };
    const decisions = store.findNodesByType("decision");
    const plans = store.findNodesByType("plan").filter(p => (p.properties as any).status !== "completed");
    const lines = [`## Canvast Canvas (${store.nodeCount} nodes, 💾 persisted)`];
    if (decisions.length) {
      lines.push("### Recent Decisions:");
      for (const d of decisions.slice(-5)) lines.push(`- 🧭 ${(d.properties as any).chosen}`);
    }
    if (plans.length) {
      lines.push("### Active Plans:");
      for (const p of plans.slice(-3)) lines.push(`- 🎯 [${(p.properties as any).status}] ${(p.properties as any).goal}`);
    }
    // Base prompt from the event (chained), append the digest, return it.
    return { systemPrompt: base + "\n\n" + lines.join("\n") };
  });

  (pi as any).__canvast_store = store;
}

export { CanvasStore };
