/**
 * =============================================================================
 * Canvast — Canvas Graph Renderer / Canvast 源文件
 * =============================================================================
 * @file        src/tui/canvas-graph-renderer.ts
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */


export interface CanvasGraphNode {
  id: string;
  type: string;
  properties?: Record<string, unknown>;
}

export interface CanvasGraphEdge {
  id?: string;
  type: string;
  fromNodeId: string;
  toNodeId: string;
  properties?: Record<string, unknown>;
}

export interface CanvasGraphSnapshot {
  nodes: CanvasGraphNode[];
  edges: CanvasGraphEdge[];
}

export interface CanvasGraphRenderOptions {
  focusId?: string;
  maxNodes?: number;
  maxEdgesPerNode?: number;
  typeFilter?: string;
  searchText?: string;
  page?: number;
}

const CANVAS_LAYER_ORDER = [
  { type: "plan", title: "Plan and task layer" },
  { type: "decision", title: "Decision layer" },
  { type: "file", title: "File asset layer" },
  { type: "agent_run", title: "Agent run layer" },
] as const;

function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function firstText(properties: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = textValue(properties[key]).trim();
    if (value) return value;
  }
  return "";
}

function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, max);
  return `${text.slice(0, max - 1)}...`;
}

export function labelCanvasNode(node: CanvasGraphNode): string {
  const properties = node.properties || {};
  return firstText(properties, ["goal", "path", "chosen", "task", "content", "problem", "summary"]) || node.id;
}

export function formatCanvasStats(graph: CanvasGraphSnapshot): string {
  const byType = new Map<string, number>();
  for (const node of graph.nodes) byType.set(node.type, (byType.get(node.type) || 0) + 1);
  const orderedTypes = [
    ...CANVAS_LAYER_ORDER.map(layer => layer.type).filter(type => byType.has(type)),
    ...Array.from(byType.keys()).filter(type => !CANVAS_LAYER_ORDER.some(layer => layer.type === type)).sort(),
  ];
  const parts = orderedTypes.map(type => `${type}:${byType.get(type)}`);
  return `${graph.nodes.length} nodes/${graph.edges.length} edges${parts.length ? ` | ${parts.join(" ")}` : ""}`;
}

export function formatCanvasRelationStats(graph: CanvasGraphSnapshot): string {
  const byType = new Map<string, number>();
  for (const edge of graph.edges) byType.set(edge.type, (byType.get(edge.type) || 0) + 1);
  const parts = Array.from(byType.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, count]) => `${type} x ${count}`);
  return `Relations: ${parts.length ? parts.join(" | ") : "none"}`;
}

function groupedNodes(graph: CanvasGraphSnapshot): Array<{ title: string; nodes: CanvasGraphNode[] }> {
  const seen = new Set<string>();
  const groups: Array<{ title: string; nodes: CanvasGraphNode[] }> = [];
  for (const layer of CANVAS_LAYER_ORDER) {
    const nodes = graph.nodes.filter(node => node.type === layer.type);
    if (nodes.length) {
      groups.push({ title: layer.title, nodes });
      seen.add(layer.type);
    }
  }
  const otherTypes = Array.from(new Set(graph.nodes.map(node => node.type).filter(type => !seen.has(type)))).sort();
  for (const type of otherTypes) {
    groups.push({ title: `${type} layer`, nodes: graph.nodes.filter(node => node.type === type) });
  }
  return groups;
}

function groupedFromNodes(nodes: CanvasGraphNode[]): Array<{ title: string; nodes: CanvasGraphNode[] }> {
  return groupedNodes({ nodes, edges: [] });
}

function graphWithFilteredNodes(graph: CanvasGraphSnapshot, options: CanvasGraphRenderOptions): CanvasGraphSnapshot {
  const search = options.searchText?.trim().toLowerCase() || "";
  const typeFilter = options.typeFilter?.trim();
  const nodes = graph.nodes.filter(node => {
    if (typeFilter && node.type !== typeFilter) return false;
    if (!search) return true;
    return `${node.id} ${node.type} ${labelCanvasNode(node)}`.toLowerCase().includes(search);
  });
  if (nodes.length === graph.nodes.length) return graph;
  const kept = new Set(nodes.map(node => node.id));
  return {
    nodes,
    edges: graph.edges.filter(edge => kept.has(edge.fromNodeId) && kept.has(edge.toNodeId)),
  };
}

function describeNode(node: CanvasGraphNode | undefined): string {
  if (!node) return "[missing]";
  return `[${node.type}] ${node.id} ${truncateText(labelCanvasNode(node), 48)}`;
}

function renderEdgeLines(
  edgePrefix: string,
  edges: CanvasGraphEdge[],
  nodeById: Map<string, CanvasGraphNode>,
  targetOf: (edge: CanvasGraphEdge) => string,
  maxEdges: number,
): string[] {
  const shown = edges.slice(0, maxEdges);
  const lines = shown.map(edge => `    ${edgePrefix} ${edge.type} ${describeNode(nodeById.get(targetOf(edge)))}`);
  if (edges.length > shown.length) lines.push(`    ... +${edges.length - shown.length} more edges`);
  return lines;
}

function renderFocus(
  graph: CanvasGraphSnapshot,
  focusId: string,
  nodeById: Map<string, CanvasGraphNode>,
  maxEdgesPerNode: number,
): string[] {
  const focus = nodeById.get(focusId);
  if (!focus) {
    return [
      `Focus: ${focusId}`,
      "- Node not found in canvas-graph.json.",
      "",
    ];
  }
  const incoming = graph.edges.filter(edge => edge.toNodeId === focus.id);
  const outgoing = graph.edges.filter(edge => edge.fromNodeId === focus.id);
  return [
    `Focus: ${describeNode(focus)}`,
    "  Incoming:",
    ...(incoming.length ? renderEdgeLines("<-", incoming, nodeById, edge => edge.fromNodeId, maxEdgesPerNode) : ["    none"]),
    "  Outgoing:",
    ...(outgoing.length ? renderEdgeLines("->", outgoing, nodeById, edge => edge.toNodeId, maxEdgesPerNode) : ["    none"]),
    "",
  ];
}

export function renderCanvasGraphLines(
  graph: CanvasGraphSnapshot,
  options: CanvasGraphRenderOptions = {},
): string[] {
  const filteredGraph = graphWithFilteredNodes(graph, options);
  const maxNodes = Math.max(1, options.maxNodes ?? 12);
  const maxEdgesPerNode = options.maxEdgesPerNode ?? 4;
  const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
  const page = Math.max(1, options.page ?? 1);
  const start = (page - 1) * maxNodes;
  const pageCount = Math.max(1, Math.ceil(filteredGraph.nodes.length / maxNodes));
  const shownNodes = filteredGraph.nodes.slice(start, start + maxNodes);
  const lines = [
    `Canvas ${formatCanvasStats(graph)}`,
    formatCanvasRelationStats(graph),
    "View: layered terminal graph from canvas-graph.json",
    "Large graph UX: overview first, then focus/search/type/page; full node dumps are intentionally avoided.",
    "Commands: /canvast-canvas focus <node-id> | type <node-type> | search <text> | page <n> limit <n>",
  ];
  if (graph.nodes.length === 0) {
    lines.push("No Canvas nodes yet. Use canvas_record or automatic closure tools to persist project state.");
    return lines;
  }

  const focusId = options.focusId?.trim();
  if (focusId) lines.push("", ...renderFocus(graph, focusId, nodeById, maxEdgesPerNode));

  if (options.typeFilter || options.searchText) {
    lines.push(`Filter: type=${options.typeFilter || "*"} search=${options.searchText || "*"}`);
  }
  if (filteredGraph.nodes.length === 0) {
    lines.push("No nodes match the current filter. Clear type/search filters or use a different query.");
    return lines;
  }

  lines.push("Layer Summary:");
  for (const group of groupedNodes(filteredGraph)) {
    lines.push(`+ ${group.title} (${group.nodes.length})`);
  }
  lines.push(`Layered Graph Map: page ${page}/${pageCount}, limit ${maxNodes}, showing ${shownNodes.length}/${filteredGraph.nodes.length} nodes`);
  if (shownNodes.length === 0) {
    lines.push(`Page is beyond the filtered graph. Use page 1-${pageCount}.`);
  }
  for (const group of groupedFromNodes(shownNodes)) {
    lines.push(`+ ${group.title} (${group.nodes.length} shown)`);
    for (const node of group.nodes) {
      lines.push(`  - ${node.id} ${truncateText(labelCanvasNode(node), 72)}`);
      const outgoing = graph.edges.filter(edge => edge.fromNodeId === node.id);
      lines.push(...renderEdgeLines("->", outgoing, nodeById, edge => edge.toNodeId, maxEdgesPerNode));
    }
  }
  if (start > 0) lines.push(`... ${Math.min(start, filteredGraph.nodes.length)} nodes before this page`);
  if (filteredGraph.nodes.length > start + shownNodes.length) lines.push(`... +${filteredGraph.nodes.length - start - shownNodes.length} more nodes`);
  lines.push("");
  lines.push(`Navigation: /canvast-canvas focus <node-id> · type <node-type> · search <text> · page <n> · limit <n>`);
  lines.push("Use /canvast-tasks for the plan tree and focused task progress.");
  return lines;
}
