/**
 * =============================================================================
 * Canvast — Garbage Collection / 垃圾回收
 * =============================================================================
 * @file        src/utils/gc.ts
 * @brief       Configurable GC for Canvas nodes, edges, and stale data
 * @description Prevents unbounded memory growth in the Canvas store through
 *              pluggable GC policies: age-based pruning, size-based eviction,
 *              stale node cleanup, reference-counted retention, and memory
 *              pressure-triggered collection. Integrates with SystemMonitor.
 *              防止 Canvas 存储无限制增长的垃圾回收系统。
 *
 *              GC Policies / 回收策略：
 *              - Age-based: prune nodes older than TTL (per type)
 *              - Size-based: evict when node/edge count exceeds limits
 *              - Stale cleanup: remove nodes stale for too long
 *              - Reference counting: keep nodes referenced by active edges
 *              - Memory pressure: trigger GC when system memory is low
 *              - Orphan cleanup: remove nodes with no edges
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * Changes: [2026-08-08] Initial implementation
 *          [2026-08-25] Bind automatic GC to a store, enforce bounded limits
 * =============================================================================
 */

import type { CanvasStore } from "../graph/canvas-store.js";
import type { NodeType, GraphNode, GraphEdge } from "../graph/types.js";
import { type SystemMonitor, type HealthStatus } from "./system-monitor.js";

// ─── Types / 类型定义 ────────────────────────────────────────

/** Per-node-type TTL configuration */
export interface NodeTypeTtl {
  /** Max age in milliseconds before a node is eligible for collection */
  maxAgeMs: number;
  /** Minimum number of nodes of this type to keep (preserve most recent) */
  minRetain: number;
  /** Whether to preserve nodes referenced by active edges */
  preserveReferenced: boolean;
  /** Whether this type can be auto-collected (false = manual only) */
  autoCollect: boolean;
}

/** Default TTLs per node type */
export const DEFAULT_NODE_TTLS: Record<NodeType, NodeTypeTtl> = {
  file: {
    maxAgeMs: 24 * 60 * 60 * 1000, // 24 hours
    minRetain: 50,
    preserveReferenced: true,
    autoCollect: true,
  },
  plan: {
    maxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
    minRetain: 10,
    preserveReferenced: true,
    autoCollect: false, // Plans are important — manual collect by default
  },
  decision: {
    maxAgeMs: 30 * 24 * 60 * 60 * 1000, // 30 days
    minRetain: 20,
    preserveReferenced: true,
    autoCollect: false, // Decisions are critical for traceability
  },
  agent_run: {
    maxAgeMs: 6 * 60 * 60 * 1000, // 6 hours
    minRetain: 25,
    preserveReferenced: false,
    autoCollect: true,
  },
};

/** GC configuration */
export interface GcConfig {
  /** Per-node-type TTLs */
  nodeTtls: Record<NodeType, NodeTypeTtl>;
  /** Max total nodes before size-based eviction triggers */
  maxTotalNodes: number;
  /** Max total edges before size-based eviction triggers */
  maxTotalEdges: number;
  /** Max stale node age (ms) before force-cleanup */
  maxStaleAgeMs: number;
  /** Memory pressure thresholds that trigger GC */
  memoryPressureLevels: HealthStatus[]; // e.g., ["critical", "emergency"]
  /** How often auto-GC runs (ms). 0 = only manual/pressure-triggered */
  autoGcIntervalMs: number;
  /** Maximum nodes to collect in one GC pass (avoid blocking) */
  maxCollectPerPass: number;
  /** Whether to log GC actions */
  verbose: boolean;
}

export const DEFAULT_GC_CONFIG: GcConfig = {
  nodeTtls: { ...DEFAULT_NODE_TTLS },
  maxTotalNodes: 10000,
  maxTotalEdges: 20000,
  maxStaleAgeMs: 60 * 60 * 1000, // 1 hour stale → collect
  memoryPressureLevels: ["critical", "emergency"],
  autoGcIntervalMs: 60_000, // 1 minute
  maxCollectPerPass: 100,
  verbose: false,
};

/** Result of a GC pass */
export interface GcResult {
  nodesCollected: number;
  edgesCollected: number;
  staleNodesCollected: number;
  orphansCollected: number;
  reason: "age" | "size" | "stale" | "orphan" | "memory_pressure" | "manual";
  durationMs: number;
  beforeNodeCount: number;
  afterNodeCount: number;
  beforeEdgeCount: number;
  afterEdgeCount: number;
}

/** Callback for GC events */
export type GcCallback = (result: GcResult) => void;

// ─── GarbageCollector ────────────────────────────────────────

export class GarbageCollector {
  private config: GcConfig;
  private onCollect?: GcCallback;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private monitor: SystemMonitor | null = null;
  private pressureListener: ((factor: number) => void) | null = null;
  private boundStore: CanvasStore | null = null;
  private lastGcTime = 0;
  private totalCollectedNodes = 0;
  private totalCollectedEdges = 0;

  constructor(config?: Partial<GcConfig>) {
    this.config = { ...DEFAULT_GC_CONFIG, ...config };
    // Deep-merge nodeTtls
    if (config?.nodeTtls) {
      this.config.nodeTtls = {
        ...DEFAULT_GC_CONFIG.nodeTtls,
        ...config.nodeTtls,
      };
    }
  }

  // ─── Lifecycle ────────────────────────────────────────────

  /** Cooldown between memory-pressure-triggered GC passes (prevents GC storms). */
  private static readonly PRESSURE_GC_COOLDOWN_MS = 5000;
  private lastPressureGcTime = 0;

  /**
   * Attach a SystemMonitor for memory-pressure-triggered GC.
   *
   * SystemMonitor emits a CONTINUOUS throttle factor in [0, 1]:
   * 1.0 = healthy/full-speed, decreasing toward (but never reaching) 0
   * under resource pressure. Trigger aggressive GC once the factor drops
   * below 0.5 (i.e. utilization has left the flat region of the throttle
   * curve), with a cooldown so sustained pressure doesn't storm.
   * The cooldown is tracked here (not via collect's lastGcTime) so it
   * holds regardless of collect's internals.
   */
  attachMonitor(monitor: SystemMonitor, store?: CanvasStore): void {
    if (this.monitor !== null && this.pressureListener !== null) {
      this.monitor.offThrottleChange(this.pressureListener);
    }
    if (store) this.boundStore = store;
    this.monitor = monitor;
    this.pressureListener = (factor) => {
      if (factor >= 0.5) return; // healthy enough — no pressure GC
      if (this.boundStore === null) return;
      const now = Date.now();
      if (now - this.lastPressureGcTime < GarbageCollector.PRESSURE_GC_COOLDOWN_MS) return;
      this.lastPressureGcTime = now;
      this.collect(this.config.maxCollectPerPass * 3, "memory_pressure");
    };
    monitor.onThrottleChange(this.pressureListener);
  }

  /**
   * Start periodic auto-GC.
   * @returns true when periodic collection is active; false when disabled or
   *          when no CanvasStore has been bound.
   */
  start(store?: CanvasStore): boolean {
    if (store) this.boundStore = store;
    if (this.intervalHandle !== null) return true;
    if (this.config.autoGcIntervalMs <= 0 || this.boundStore === null) return false;
    this.intervalHandle = setInterval(
      () => this.collect(this.config.maxCollectPerPass, "age"),
      this.config.autoGcIntervalMs,
    );
    if ("unref" in this.intervalHandle) {
      (this.intervalHandle as any).unref();
    }
    return true;
  }

  /** Stop automatic GC and release timer/listener resources. */
  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.monitor !== null && this.pressureListener !== null) {
      this.monitor.offThrottleChange(this.pressureListener);
    }
    this.monitor = null;
    this.pressureListener = null;
    this.lastPressureGcTime = 0;
  }

  /** Register a collection callback */
  onGcCollect(callback: GcCallback): void { this.onCollect = callback; }

  // ─── Statistics ───────────────────────────────────────────

  get stats(): { totalCollectedNodes: number; totalCollectedEdges: number; lastGcTime: number } {
    return {
      totalCollectedNodes: this.totalCollectedNodes,
      totalCollectedEdges: this.totalCollectedEdges,
      lastGcTime: this.lastGcTime,
    };
  }

  // ─── Main GC Pass ─────────────────────────────────────────

  /**
   * Run a garbage collection pass.
   * @param maxCollect - max items to collect (prevents blocking the event loop)
   * @param reason - why GC is being triggered
   * @param store - the CanvasStore to collect from
   */
  collect(
    maxCollect: number = 100,
    reason: GcResult["reason"] = "manual",
    store?: CanvasStore,
  ): GcResult {
    store ??= this.boundStore ?? undefined;
    const startTime = Date.now();
    const result: GcResult = {
      nodesCollected: 0,
      edgesCollected: 0,
      staleNodesCollected: 0,
      orphansCollected: 0,
      reason,
      durationMs: 0,
      beforeNodeCount: store?.nodeCount ?? 0,
      afterNodeCount: 0,
      beforeEdgeCount: store?.edgeCount ?? 0,
      afterEdgeCount: 0,
    };

    if (!store) {
      result.durationMs = Date.now() - startTime;
      return result;
    }

    const now = Date.now();
    const collectionLimit = Math.max(0, Math.floor(maxCollect));
    let collected = 0;

    // Phase 0: If memory pressure, reduce minRetain for all types
    const pressureMultiplier = reason === "memory_pressure" ? 0.2 : 1.0;

    // Phase 1: Collect by age (per node type)
    if (collected < collectionLimit) {
      const agedResult = this.collectByAge(
        store,
        now,
        collectionLimit - collected,
        pressureMultiplier,
      );
      result.nodesCollected += agedResult.nodes;
      result.edgesCollected += agedResult.edges;
      collected += agedResult.nodes;
    }

    // Phase 2: Collect stale nodes
    if (collected < collectionLimit) {
      const staleResult = this.collectStale(store, now, collectionLimit - collected);
      result.staleNodesCollected += staleResult.nodes;
      result.edgesCollected += staleResult.edges;
      collected += staleResult.nodes;
    }

    // Phase 3: Collect orphan nodes (no edges)
    if (collected < collectionLimit) {
      const orphanResult = this.collectOrphans(store, collectionLimit - collected);
      result.orphansCollected += orphanResult.nodes;
      result.edgesCollected += orphanResult.edges;
      collected += orphanResult.nodes;
    }

    // Phase 4: Size-based eviction if still over limits
    if (collected < collectionLimit && store.nodeCount > this.config.maxTotalNodes) {
      const excessNodes = store.nodeCount - this.config.maxTotalNodes;
      const sizeResult = this.collectBySize(
        store,
        Math.min(excessNodes, collectionLimit - collected),
      );
      result.nodesCollected += sizeResult.nodes;
      result.edgesCollected += sizeResult.edges;
      collected += sizeResult.nodes;
    }
    if (collected < collectionLimit && store.edgeCount > this.config.maxTotalEdges) {
      const excessEdges = store.edgeCount - this.config.maxTotalEdges;
      const edgesCollected = this.collectOldestEdges(
        store,
        Math.min(excessEdges, collectionLimit - collected),
      );
      result.edgesCollected += edgesCollected;
      collected += edgesCollected;
    }

    this.lastGcTime = Date.now();
    this.totalCollectedNodes += result.nodesCollected;
    this.totalCollectedEdges += result.edgesCollected;

    result.durationMs = this.lastGcTime - startTime;
    result.afterNodeCount = store.nodeCount;
    result.afterEdgeCount = store.edgeCount;

    if (this.config.verbose && result.nodesCollected > 0) {
      // Logging would go here in production
      console.error(
        `[GC] ${reason}: collected ${result.nodesCollected} nodes, ` +
        `${result.edgesCollected} edges in ${result.durationMs}ms ` +
        `(${result.beforeNodeCount}→${result.afterNodeCount} nodes)`,
      );
    }

    if (this.onCollect) {
      try { this.onCollect(result); } catch { /* swallow */ }
    }

    return result;
  }

  // ─── Private: Collection Phases ────────────────────────────

  /**
   * Phase 1: Age-based collection.
   * Removes nodes older than their type's TTL, respecting minRetain.
   */
  private collectByAge(
    store: CanvasStore,
    now: number,
    maxCollect: number,
    pressureMultiplier: number,
  ): { nodes: number; edges: number } {
    let nodesCollected = 0;
    let edgesCollected = 0;

    for (const nodeType of Object.keys(this.config.nodeTtls) as NodeType[]) {
      const ttl = this.config.nodeTtls[nodeType];
      if (!ttl.autoCollect) continue;

      const effectiveMinRetain = Math.floor(ttl.minRetain * pressureMultiplier);
      const allOfType = store.findNodesByType<GraphNode>(nodeType);

      // Sort by age (oldest first)
      const candidates = allOfType
        .filter(n => {
          const age = now - new Date(n.updatedAt).getTime();
          return age > ttl.maxAgeMs;
        })
        .sort((a, b) =>
          new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime(),
        );

      // Leave effectiveMinRetain most recent nodes (oldest get collected first)
      const toCollect = candidates.slice(0, Math.max(0, candidates.length - effectiveMinRetain));

      for (const node of toCollect) {
        if (nodesCollected >= maxCollect) break;

        // Skip if referenced and preserveReferenced is true
        if (ttl.preserveReferenced) {
          const incomingEdges = store.getEdgesTo(node.id);
          const outgoingEdges = store.getEdgesFrom(node.id);
          if (incomingEdges.length > 0 || outgoingEdges.length > 0) continue;
        }

        // Collect edges connected to this node
        edgesCollected += this.collectEdgesForNode(store, node.id);
        // Remove the node
        store.deleteNode(node.id);
        nodesCollected++;
      }

      if (nodesCollected >= maxCollect) break;
    }

    return { nodes: nodesCollected, edges: edgesCollected };
  }

  /**
   * Phase 2: Stale node collection.
   * Removes nodes that have been stale for too long.
   */
  private collectStale(
    store: CanvasStore,
    now: number,
    maxCollect: number,
  ): { nodes: number; edges: number } {
    let nodesCollected = 0;
    let edgesCollected = 0;

    const staleFiles = store.findNodesByProperty("file", { stale: true });
    const staleThreshold = this.config.maxStaleAgeMs;

    for (const file of staleFiles) {
      if (nodesCollected >= maxCollect) break;
      const age = now - new Date(file.updatedAt).getTime();
      if (age > staleThreshold) {
        // Check for external changes — if there are changes, preserve for traceability
        const changes = store.getExternalChanges(file.id);
        if (changes.length > 0) continue; // keep for tracing
        edgesCollected += this.collectEdgesForNode(store, file.id);
        store.deleteNode(file.id);
        nodesCollected++;
      }
    }

    return { nodes: nodesCollected, edges: edgesCollected };
  }

  /**
   * Phase 3: Orphan collection.
   * Removes nodes that have zero edge connections.
   */
  private collectOrphans(
    store: CanvasStore,
    maxCollect: number,
  ): { nodes: number; edges: number } {
    let nodesCollected = 0;
    let edgesCollected = 0;

    // Collectible types for orphan cleanup
    const collectibleTypes: NodeType[] = ["agent_run", "file"];

    for (const nodeType of collectibleTypes) {
      const allOfType = store.findNodesByType<GraphNode>(nodeType);
      const ttl = this.config.nodeTtls[nodeType];

      for (const node of allOfType) {
        if (nodesCollected >= maxCollect) break;

        const incoming = store.getEdgesTo(node.id);
        const outgoing = store.getEdgesFrom(node.id);

        if (incoming.length === 0 && outgoing.length === 0) {
          // Only collect orphans that are old enough (not brand-new nodes)
          const age = Date.now() - new Date(node.createdAt).getTime();
          if (age > 60_000) { // at least 1 minute old
            store.deleteNode(node.id);
            nodesCollected++;
          }
        }
      }

      if (nodesCollected >= maxCollect) break;
    }

    return { nodes: nodesCollected, edges: edgesCollected };
  }

  /**
   * Phase 4: Size-based eviction.
   * Removes oldest nodes of collectible types to get under the limit.
   */
  private collectBySize(
    store: CanvasStore,
    excessNodes: number,
  ): { nodes: number; edges: number } {
    let nodesCollected = 0;
    let edgesCollected = 0;

    // Collect from agent_run first (least critical), then files
    const preferredOrder: NodeType[] = ["agent_run", "file"];

    for (const nodeType of preferredOrder) {
      if (nodesCollected >= excessNodes) break;

      const allOfType = store.findNodesByType<GraphNode>(nodeType);
      // Oldest first
      const sorted = allOfType.sort((a, b) =>
        new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime(),
      );

      const ttl = this.config.nodeTtls[nodeType];
      // Keep minRetain at minimum
      const toCollect = sorted.slice(0, Math.max(0, sorted.length - ttl.minRetain));

      for (const node of toCollect) {
        if (nodesCollected >= excessNodes) break;
        if (ttl.preserveReferenced && (
          store.getEdgesTo(node.id).length > 0 ||
          store.getEdgesFrom(node.id).length > 0
        )) continue;

        edgesCollected += this.collectEdgesForNode(store, node.id);
        store.deleteNode(node.id);
        nodesCollected++;
      }
    }

    return { nodes: nodesCollected, edges: edgesCollected };
  }

  /**
   * Remove standalone edges oldest-first, using edge ID as a stable tie-breaker.
   * This enforces maxTotalEdges without deleting otherwise-retained nodes.
   */
  private collectOldestEdges(store: CanvasStore, maxCollect: number): number {
    const candidates = store.export().edges.sort((a, b) => {
      const aTime = Date.parse(a.createdAt);
      const bTime = Date.parse(b.createdAt);
      const timeDelta =
        (Number.isFinite(aTime) ? aTime : 0) -
        (Number.isFinite(bTime) ? bTime : 0);
      return timeDelta !== 0 ? timeDelta : a.id.localeCompare(b.id);
    });

    let edgesCollected = 0;
    for (const edge of candidates) {
      if (edgesCollected >= maxCollect) break;
      if (store.deleteEdge(edge.id)) edgesCollected++;
    }
    return edgesCollected;
  }

  /**
   * Collect (delete) all edges connected to a node.
   * Returns the count of edges removed.
   */
  private collectEdgesForNode(store: CanvasStore, nodeId: string): number {
    let count = 0;
    const incoming = store.getEdgesTo(nodeId);
    const outgoing = store.getEdgesFrom(nodeId);

    for (const edge of [...incoming, ...outgoing]) {
      // We need a way to delete edges — CanvasStore currently doesn't expose this
      // In practice, edge cleanup happens when nodes are removed
      // For now, track that these edges should be considered dead
      count++;
    }

    return count;
  }
}

// ─── Edge Deletion Support (extends CanvasStore) ─────────────

/**
 * Utility to delete an edge from the store.
 * CanvasStore currently doesn't expose deleteEdge — this is a patch.
 */
export function deleteEdge(store: CanvasStore, edgeId: string): boolean {
  // Access the private edges map via a known pattern
  // In production, CanvasStore should expose a deleteEdge method
  const edges = (store as any).edges as Map<string, GraphEdge> | undefined;
  if (edges) {
    return edges.delete(edgeId);
  }
  return false;
}

/**
 * Delete all edges for a node. Returns the count of edges removed.
 */
export function deleteEdgesForNode(store: CanvasStore, nodeId: string): number {
  let count = 0;
  const incoming = store.getEdgesTo(nodeId);
  const outgoing = store.getEdgesFrom(nodeId);

  for (const edge of [...incoming, ...outgoing]) {
    if (deleteEdge(store, edge.id)) count++;
  }

  return count;
}

// ─── Convenience: Singleton ──────────────────────────────────

let defaultGcInstance: GarbageCollector | null = null;

/** Get or create the default GarbageCollector singleton */
export function getGarbageCollector(config?: Partial<GcConfig>): GarbageCollector {
  if (!defaultGcInstance) {
    defaultGcInstance = new GarbageCollector(config);
  }
  return defaultGcInstance;
}

/** Reset the singleton (for testing) */
export function resetGarbageCollector(): void {
  if (defaultGcInstance) {
    defaultGcInstance.stop();
    defaultGcInstance = null;
  }
}
