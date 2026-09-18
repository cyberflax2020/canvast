#!/usr/bin/env node
/**
 * =============================================================================
 * Canvast — Export Canvas / Canvast 源文件
 * =============================================================================
 * @file        scripts/export-canvas.mjs
 * @brief       Export Canvas graphs and verify the three product presentation surfaces.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  verifyPortableArtifact,
  writePortableArtifact,
} from "./canvas-export-portable-artifact.mjs";
import {
  verifyPortableReleaseArtifact,
  writePortableReleaseArtifact,
} from "./canvas-portable-release-artifact.mjs";
import { surfaceArtifact } from "./canvas-surface-artifact.mjs";
import { validateSourceManifestDocument } from "./source-manifest-validation.mjs";
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceManifestScript = path.join(projectDir, "scripts", "source-manifest.mjs");
const D3_CDN_URL = "https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js";
const exportFileNames = {
  json: "canvas-graph-export.json",
  markdown: "canvas-report.md",
  mermaid: "canvas-graph.mmd",
  svg: "canvas-graph.svg",
  html: "canvas-graph.html",
};
const nodeTypeOrder = ["plan", "decision", "file", "agent_run"];
const sourceExtensions = new Set([
  ".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".sh",
  ".swift", ".py", ".yaml", ".yml", ".html", ".css",
]);
const excludedDirs = new Set([
  ".git", ".pi", ".runtime", ".canvast-secrets", ".aider.tags.cache.v4",
  "coverage", "dist", "node_modules", "pi-data",
]);
function usage() {
  console.error([
    "Usage:",
    "  node scripts/export-canvas.mjs [--input <canvas-graph.json>] [--out <dir>] [--title <title>] [--scan-if-empty|--no-scan]",
    "  node scripts/export-canvas.mjs portable-artifact <write|verify> [--source-manifest <file>] [--artifact <file>] [--portable-dir <dir>]",
    "  node scripts/export-canvas.mjs surface-artifact <write|verify> [--source-manifest <file>] [--artifact <file>] [--tui-output <png>] [--macos-output <png>] [--tui-command <command>] [--macos-command <command>] [--allow-pending-source]",
  ].join("\n"));
  process.exit(2);
}
function nextArg(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}
function parseExportArgs(argv) {
  const options = {
    input: path.join(projectDir, "canvas-graph.json"),
    out: path.join(projectDir, "dist", "canvas"),
    title: "Canvast Project Canvas",
    scanIfEmpty: true,
    inputProvided: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--input") {
      options.input = path.resolve(nextArg(argv, index, arg));
      options.inputProvided = true;
      index += 1;
    } else if (arg === "--out") {
      options.out = path.resolve(nextArg(argv, index, arg));
      index += 1;
    } else if (arg === "--title") {
      options.title = nextArg(argv, index, arg);
      index += 1;
    } else if (arg === "--scan-if-empty") {
      options.scanIfEmpty = true;
    } else if (arg === "--no-scan") {
      options.scanIfEmpty = false;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      console.error(`Unexpected argument: ${arg}`);
      usage();
    }
  }
  return options;
}
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateGraph(value) {
  if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    throw new Error("invalid Canvas graph: root must contain nodes[] and edges[]");
  }
  const nodeIds = new Set();
  for (const [index, node] of value.nodes.entries()) {
    if (!isRecord(node) || typeof node.id !== "string" || !node.id || typeof node.type !== "string" || !node.type) {
      throw new Error(`invalid Canvas graph: nodes[${index}] requires non-empty string id and type`);
    }
    if (nodeIds.has(node.id)) throw new Error(`invalid Canvas graph: duplicate node id ${JSON.stringify(node.id)}`);
    if (node.properties !== undefined && !isRecord(node.properties)) {
      throw new Error(`invalid Canvas graph: node ${JSON.stringify(node.id)} properties must be an object`);
    }
    nodeIds.add(node.id);
  }
  for (const [index, edge] of value.edges.entries()) {
    if (
      !isRecord(edge) ||
      typeof edge.type !== "string" ||
      !edge.type ||
      typeof edge.fromNodeId !== "string" ||
      typeof edge.toNodeId !== "string"
    ) {
      throw new Error(`invalid Canvas graph: edges[${index}] requires type, fromNodeId, and toNodeId`);
    }
    if (!nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId)) {
      throw new Error(`invalid Canvas graph: edges[${index}] references a missing node`);
    }
  }
  return value;
}
function readJson(file) {
  if (!fs.existsSync(file)) return undefined;
  try {
    return validateGraph(JSON.parse(fs.readFileSync(file, "utf-8")));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(detail.startsWith("invalid Canvas graph")
      ? detail
      : `cannot read Canvas graph ${JSON.stringify(path.basename(file))}: ${detail}`);
  }
}
function isSensitiveKey(key) {
  const normalized = key.replaceAll("-", "").replaceAll("_", "").toUpperCase();
  return ["APIKEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "PRIVATEKEY", "ACCESSKEY", "AUTHORIZATION"]
    .some(marker => normalized.includes(marker));
}
const secretValueStops = new Set([" ", "\t", "\r", "\n", "'", "\"", ";", ",", ")", "}", "]"]);
const isAsciiLetter = char => Boolean(char) && char.toLowerCase() !== char.toUpperCase() && char.codePointAt(0) < 128;
const isNameChar = char => isAsciiLetter(char) || (char >= "0" && char <= "9") || ["_", "-"].includes(char);
const isTokenChar = char => isNameChar(char) || [".", "~", "+", "/"].includes(char);
const startsIgnoreCase = (value, index, expected) =>
  value.slice(index, index + expected.length).toLowerCase() === expected.toLowerCase();
function replaceSpans(value, spans) {
  let output = "";
  let cursor = 0;
  for (const span of spans.sort((left, right) => left.start - right.start)) {
    if (span.start < cursor) continue;
    output += value.slice(cursor, span.start) + span.replacement;
    cursor = span.end;
  }
  return output + value.slice(cursor);
}
function personalHomeSpan(value, index) {
  const unixRoots = ["file:///Users/", "file:///home/", "/Users/", "/home/"];
  let userStart = -1;
  for (const root of unixRoots) {
    if (startsIgnoreCase(value, index, root)) userStart = index + root.length;
  }
  if (userStart < 0 && isAsciiLetter(value[index]) && value[index + 1] === ":" && ["/", "\\"].includes(value[index + 2])) {
    let cursor = index + 2;
    while (["/", "\\"].includes(value[cursor])) cursor += 1;
    if (startsIgnoreCase(value, cursor, "Users") && ["/", "\\"].includes(value[cursor + 5])) {
      userStart = cursor + 5;
      while (["/", "\\"].includes(value[userStart])) userStart += 1;
    }
  }
  if (userStart < 0) return undefined;
  let end = userStart;
  while (value[end] && !secretValueStops.has(value[end]) && !["/", "\\", "<", ">"].includes(value[end])) end += 1;
  return end > userStart ? { start: index, end, replacement: "<home>" } : undefined;
}
function redactText(value) {
  const text = String(value);
  const spans = [];
  for (let index = 0; index < text.length; index += 1) {
    const home = personalHomeSpan(text, index);
    if (home) {
      spans.push(home);
      index = home.end - 1;
      continue;
    }
    const previousIsName = isNameChar(text[index - 1]);
    let tokenPrefix = "";
    let minTokenLength = 0;
    if (!previousIsName && text.startsWith("sk-", index)) [tokenPrefix, minTokenLength] = ["sk-", 6];
    else if (!previousIsName && text.startsWith("AKIA", index)) [tokenPrefix, minTokenLength] = ["AKIA", 8];
    else if (!previousIsName && text.startsWith("gh", index) &&
      "opusr".includes(text[index + 2]) && text[index + 3] === "_") {
      [tokenPrefix, minTokenLength] = [text.slice(index, index + 4), 12];
    }
    if (tokenPrefix) {
      let end = index + tokenPrefix.length;
      while (isTokenChar(text[end])) end += 1;
      if (end - index - tokenPrefix.length >= minTokenLength) {
        spans.push({ start: index, end, replacement: `${tokenPrefix}***` });
        index = end - 1;
        continue;
      }
    }
    if (!isNameChar(text[index]) || previousIsName) continue;
    let nameEnd = index;
    while (isNameChar(text[nameEnd])) nameEnd += 1;
    const name = text.slice(index, nameEnd);
    let cursor = nameEnd;
    while (text[cursor] === " " || text[cursor] === "\t") cursor += 1;
    if (name.toLowerCase() === "bearer" && cursor > nameEnd) {
      const tokenStart = cursor;
      while (isTokenChar(text[cursor]) || text[cursor] === "=") cursor += 1;
      if (cursor - tokenStart >= 8) spans.push({ start: tokenStart, end: cursor, replacement: "***" });
    } else if ((isSensitiveKey(name) || name.toLowerCase() === "authorization") &&
      [":", "="].includes(text[cursor])) {
      cursor += 1;
      while (text[cursor] === " " || text[cursor] === "\t") cursor += 1;
      if (startsIgnoreCase(text, cursor, "Bearer ")) cursor += 7;
      const quote = ["'", "\""].includes(text[cursor]) ? text[cursor++] : "";
      const secretStart = cursor;
      while (text[cursor] && (quote ? text[cursor] !== quote : !secretValueStops.has(text[cursor]))) cursor += 1;
      if (cursor - secretStart >= 6) spans.push({ start: secretStart, end: cursor, replacement: "***" });
    }
    index = nameEnd - 1;
  }
  return replaceSpans(text, spans);
}
function redactDeep(value, key = "") {
  if (isSensitiveKey(key)) return "***";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(item => redactDeep(item));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
    childKey,
    redactDeep(child, childKey),
  ]));
}
function safeGraph(graph) {
  return validateGraph(redactDeep(graph));
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function safeDisplayPath(file) {
  const relative = path.relative(projectDir, path.resolve(file)).split(path.sep).join("/");
  return relative && !relative.startsWith("../") && !path.isAbsolute(relative) ? relative : path.basename(file);
}
function walkFiles(dir, files = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (excludedDirs.has(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(absolute, files);
    } else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) {
      files.push(path.relative(projectDir, absolute).split(path.sep).join("/"));
    }
  }
  return files;
}
function inferFileLayer(file) {
  const firstPart = file.split("/")[0] || ".";
  if (firstPart === "extensions") return "runtime tools";
  if (firstPart === "src") return "core libraries";
  if (firstPart === "tests") return "verification";
  if (firstPart === "docs") return "documentation";
  if (firstPart === "scripts") return "delivery scripts";
  if (firstPart === "skills") return "skills";
  if (firstPart === "eval-matrix") return "evaluation matrix";
  if (firstPart === "macos-app") return "macOS app";
  return "project root";
}
function graphFromProjectScan() {
  const now = new Date().toISOString();
  const files = walkFiles(projectDir).sort();
  const groupIds = new Map();
  const nodes = [];
  const edges = [];

  function groupId(layer) {
    const existing = groupIds.get(layer);
    if (existing) return existing;
    const id = `plan_${groupIds.size + 1}`;
    groupIds.set(layer, id);
    nodes.push({
      id,
      type: "plan",
      createdAt: now,
      updatedAt: now,
      properties: {
        goal: layer,
        status: "in_progress",
        scope: { files: [], allowCreate: false, allowDelete: false },
        constraints: ["Generated from current repository files for visualization smoke."],
        steps: [],
      },
    });
    return id;
  }

  nodes.push({
    id: "decision_export_canvas",
    type: "decision",
    createdAt: now,
    updatedAt: now,
    properties: {
      problem: "Canvas visualization must be demonstrable on a real project graph.",
      chosen: "Generate a static visualization snapshot from current repository structure when no persisted graph exists.",
      alternatives: ["Require a pre-existing canvas-graph.json"],
      rationale: "A real repository scan gives a bounded, reproducible complex-project canvas without synthetic fixtures.",
      decisionType: "implementation",
      madeBy: "Canvast",
      madeAt: now,
      stillValid: true,
    },
  });

  for (const file of files) {
    const layer = inferFileLayer(file);
    const parent = groupId(layer);
    const fileId = `file_${createHash("sha1").update(file).digest("hex").slice(0, 16)}`;
    const stat = fs.statSync(path.join(projectDir, file));
    nodes.push({
      id: fileId,
      type: "file",
      createdAt: now,
      updatedAt: now,
      properties: {
        path: file,
        checksum: "",
        version: "scan",
        lastModified: now,
        size: stat.size,
        language: path.extname(file).slice(1) || "text",
        stale: false,
      },
    });
    edges.push({
      id: `edge_${edges.length + 1}`,
      type: "PRODUCED_BY",
      fromNodeId: fileId,
      toNodeId: parent,
      createdAt: now,
      properties: { source: "project_scan" },
    });
  }

  for (const id of groupIds.values()) {
    edges.push({
      id: `edge_${edges.length + 1}`,
      type: "MOTIVATED_BY",
      fromNodeId: id,
      toNodeId: "decision_export_canvas",
      createdAt: now,
      properties: { source: "project_scan" },
    });
  }

  return { nodes, edges };
}

function graphStats(graph) {
  const counts = new Map();
  for (const node of graph.nodes) counts.set(node.type, (counts.get(node.type) || 0) + 1);
  const ordered = [
    ...nodeTypeOrder.filter(type => counts.has(type)),
    ...Array.from(counts.keys()).filter(type => !nodeTypeOrder.includes(type)).sort(),
  ];
  return {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    byType: Object.fromEntries(ordered.map(type => [type, counts.get(type)])),
  };
}
function labelNode(node) {
  const properties = node.properties || {};
  for (const key of ["goal", "path", "chosen", "task", "content", "problem", "summary"]) {
    const value = properties[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return node.id;
}
function htmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('\"', "&quot;");
}
function mermaidIdBase(value) {
  const chars = Array.from(String(value));
  const converted = chars.map(ch => {
    if ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) return ch;
    return "_";
  }).join("");
  if (!converted) return "node";
  return converted[0] >= "0" && converted[0] <= "9" ? `n_${converted}` : converted;
}
function mermaidIds(graph) {
  const ids = new Map();
  const used = new Set();
  for (const node of graph.nodes) {
    const base = mermaidIdBase(node.id);
    let candidate = base;
    if (used.has(candidate)) candidate = `${base}_${sha256(node.id).slice(0, 10)}`;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${base}_${sha256(node.id).slice(0, 10)}_${suffix}`;
      suffix += 1;
    }
    used.add(candidate);
    ids.set(node.id, candidate);
  }
  return ids;
}
function scriptJson(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
function markdownInline(value) {
  return redactText(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("`", "\\`")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\r\n", " ")
    .replaceAll("\n", " ")
    .replaceAll("\r", " ");
}
function writeHtml(outFile, graph, title) {
  const data = scriptJson({
    nodes: graph.nodes.map(node => ({ id: node.id, type: node.type, label: labelNode(node) })),
    links: graph.edges.map(edge => ({ source: edge.fromNodeId, target: edge.toNodeId, type: edge.type })),
  });
  const stats = graphStats(graph);
  const typeList = Object.entries(stats.byType).map(([type, count]) => `${type}:${count}`).join(" ");
  const html = [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\" />",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />",
    `<title>${htmlEscape(title)}</title>`,
    "<style>",
    "body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif; background: #0f172a; color: #e5e7eb; }",
    "header { padding: 16px 20px; border-bottom: 1px solid #334155; }",
    "main { height: calc(100vh - 82px); }",
    "svg { width: 100%; height: 100%; display: block; }",
    ".link { stroke: #64748b; stroke-opacity: 0.7; }",
    ".node circle { stroke: #f8fafc; stroke-width: 1.5px; }",
    ".node text { fill: #e5e7eb; font-size: 12px; paint-order: stroke; stroke: #0f172a; stroke-width: 3px; }",
    ".edge-label { fill: #94a3b8; font-size: 10px; }",
    ".meta { color: #94a3b8; margin-top: 4px; }",
    ".dependency { margin: 10px 20px; padding: 10px 12px; border: 1px solid #475569; border-radius: 8px; color: #cbd5e1; }",
    ".dependency a { color: #7dd3fc; }",
    "</style>",
    `<script src="${D3_CDN_URL}"></script>`,
    "</head>",
    "<body>",
    "<header>",
    `  <div>${htmlEscape(title)}</div>`,
    `  <div class="meta">${stats.nodes} nodes / ${stats.edges} edges · ${htmlEscape(typeList)} · drag nodes, scroll to zoom</div>`,
    "</header>",
    `<div id="dependency" class="dependency">Interactive layout: network required for D3 7.9.0 from <a href="${D3_CDN_URL}">jsDelivr CDN</a>. Offline: open <a href="./${exportFileNames.svg}">${exportFileNames.svg}</a>.</div>`,
    `<noscript><div class="dependency">JavaScript is disabled. Open <a href="./${exportFileNames.svg}">${exportFileNames.svg}</a> for the standalone offline view.</div></noscript>`,
    "<main><svg></svg></main>",
    "<script>",
    `const graph = ${data};`,
    "if (!globalThis.d3) {",
    "  document.querySelector(\"main\").innerHTML = '<object data=\"./canvas-graph.svg\" type=\"image/svg+xml\" style=\"width:100%;height:100%\"><a href=\"./canvas-graph.svg\">Open the offline SVG</a></object>';",
    "} else {",
    "const width = window.innerWidth;",
    "const height = window.innerHeight - 82;",
    "const colors = { plan: \"#38bdf8\", decision: \"#f59e0b\", file: \"#22c55e\", agent_run: \"#a78bfa\" };",
    "const svg = d3.select(\"svg\");",
    "const g = svg.append(\"g\");",
    "svg.call(d3.zoom().scaleExtent([0.2, 5]).on(\"zoom\", event => g.attr(\"transform\", event.transform)));",
    "const simulation = d3.forceSimulation(graph.nodes)",
    "  .force(\"link\", d3.forceLink(graph.links).id(d => d.id).distance(80))",
    "  .force(\"charge\", d3.forceManyBody().strength(-220))",
    "  .force(\"center\", d3.forceCenter(width / 2, height / 2))",
    "  .force(\"collide\", d3.forceCollide().radius(34));",
    "const link = g.append(\"g\").selectAll(\"line\").data(graph.links).join(\"line\").attr(\"class\", \"link\").attr(\"stroke-width\", 1.4);",
    "const edgeLabel = g.append(\"g\").selectAll(\"text\").data(graph.links).join(\"text\").attr(\"class\", \"edge-label\").text(d => d.type);",
    "const node = g.append(\"g\").selectAll(\"g\").data(graph.nodes).join(\"g\").attr(\"class\", \"node\").call(d3.drag()",
    "  .on(\"start\", event => { if (!event.active) simulation.alphaTarget(0.3).restart(); event.subject.fx = event.subject.x; event.subject.fy = event.subject.y; })",
    "  .on(\"drag\", event => { event.subject.fx = event.x; event.subject.fy = event.y; })",
    "  .on(\"end\", event => { if (!event.active) simulation.alphaTarget(0); event.subject.fx = null; event.subject.fy = null; }));",
    "node.append(\"circle\").attr(\"r\", 10).attr(\"fill\", d => colors[d.type] || \"#94a3b8\");",
    "node.append(\"title\").text(d => d.type + \": \" + d.id + \"\\n\" + d.label);",
    "node.append(\"text\").attr(\"x\", 14).attr(\"y\", 4).text(d => d.label.length > 64 ? d.label.slice(0, 61) + \"...\" : d.label);",
    "simulation.on(\"tick\", () => {",
    "  link.attr(\"x1\", d => d.source.x).attr(\"y1\", d => d.source.y).attr(\"x2\", d => d.target.x).attr(\"y2\", d => d.target.y);",
    "  edgeLabel.attr(\"x\", d => (d.source.x + d.target.x) / 2).attr(\"y\", d => (d.source.y + d.target.y) / 2);",
    "  node.attr(\"transform\", d => \"translate(\" + d.x + \",\" + d.y + \")\");",
    "});",
    "}",
    "</script>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
  fs.writeFileSync(outFile, html);
}
function orderedNodeTypes(graph) {
  const types = new Set(graph.nodes.map(node => node.type));
  return [
    ...nodeTypeOrder.filter(type => types.has(type)),
    ...Array.from(types).filter(type => !nodeTypeOrder.includes(type)).sort(),
  ];
}
function writeSvg(outFile, graph, title, source) {
  const types = orderedNodeTypes(graph);
  const byType = new Map(types.map(type => [type, []]));
  for (const node of graph.nodes) {
    if (!byType.has(node.type)) byType.set(node.type, []);
    byType.get(node.type).push(node);
  }

  const columnWidth = 320;
  const rowHeight = 34;
  const marginX = 48;
  const headerHeight = 92;
  const width = Math.max(720, marginX * 2 + Math.max(1, byType.size) * columnWidth);
  const maxRows = Math.max(1, ...Array.from(byType.values()).map(nodes => nodes.length));
  const height = Math.max(420, headerHeight + maxRows * rowHeight + 48);
  const colors = {
    plan: "#38bdf8",
    decision: "#f59e0b",
    file: "#22c55e",
    agent_run: "#a78bfa",
  };
  const edgeColors = {
    MOTIVATED_BY: "#f59e0b", PRODUCED_BY: "#22c55e",
    DECOMPOSES_INTO: "#38bdf8", EXECUTED_BY: "#a78bfa",
  };

  const positions = new Map();
  Array.from(byType.entries()).forEach(([type, nodes], column) => {
    nodes.forEach((node, row) => {
      positions.set(node.id, {
        x: marginX + column * columnWidth + 18,
        y: headerHeight + row * rowHeight,
        type,
      });
    });
  });

  const stats = graphStats(graph);
  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    "<rect width=\"100%\" height=\"100%\" fill=\"#0f172a\"/>",
    `<text x="${marginX}" y="32" fill="#e5e7eb" font-family="Arial, sans-serif" font-size="22">${htmlEscape(title)}</text>`,
    `<text x="${marginX}" y="58" fill="#94a3b8" font-family="Arial, sans-serif" font-size="13">${stats.nodes} nodes / ${stats.edges} edges · ${htmlEscape(source)}</text>`,
    "<defs><marker id=\"canvas-arrow\" viewBox=\"0 0 10 10\" refX=\"9\" refY=\"5\" markerWidth=\"6\" markerHeight=\"6\" orient=\"auto-start-reverse\"><path d=\"M 0 0 L 10 5 L 0 10 z\" fill=\"#94a3b8\"/></marker></defs>",
    "<g aria-label=\"Typed Canvas edges\">",
  ];

  for (const edge of graph.edges) {
    const from = positions.get(edge.fromNodeId);
    const to = positions.get(edge.toNodeId);
    if (!from || !to) continue;
    const type = htmlEscape(edge.type);
    const fromId = htmlEscape(edge.fromNodeId);
    const toId = htmlEscape(edge.toNodeId);
    const color = edgeColors[edge.type] || "#64748b";
    lines.push(`<g class="edge" data-edge-type="${type}" data-from-node-id="${fromId}" data-to-node-id="${toId}" role="group" aria-label="${type}: ${fromId} to ${toId}">`);
    lines.push(`<title>${type}: ${fromId} → ${toId}</title>`);
    lines.push(`<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="${color}" stroke-opacity="0.72" stroke-width="1.25" marker-end="url(#canvas-arrow)"/>`);
    lines.push(`<text x="${(from.x + to.x) / 2}" y="${(from.y + to.y) / 2 - 4}" fill="${color}" font-family="Arial, sans-serif" font-size="9" paint-order="stroke" stroke="#0f172a" stroke-width="3">${type}</text>`);
    lines.push("</g>");
  }
  lines.push("</g>");

  Array.from(byType.entries()).forEach(([type, nodes], column) => {
    const x = marginX + column * columnWidth;
    const fill = colors[type] || "#94a3b8";
    lines.push(`<text x="${x}" y="82" fill="#cbd5e1" font-family="Arial, sans-serif" font-size="13">${htmlEscape(type)} (${nodes.length})</text>`);
    for (const node of nodes) {
      const position = positions.get(node.id);
      const label = labelNode(node);
      const shortLabel = label.length > 42 ? `${label.slice(0, 39)}...` : label;
      const nodeId = htmlEscape(node.id);
      const nodeType = htmlEscape(node.type);
      lines.push(`<g class="node" data-node-id="${nodeId}" data-node-type="${nodeType}" role="group" aria-label="${nodeType}: ${nodeId}">`);
      lines.push(`<title>${nodeType}: ${nodeId}</title>`);
      lines.push(`<circle cx="${position.x}" cy="${position.y}" r="7" fill="${fill}" stroke="#f8fafc" stroke-width="1"/>`);
      lines.push(`<text x="${position.x + 13}" y="${position.y + 4}" fill="#e5e7eb" font-family="Arial, sans-serif" font-size="11">${htmlEscape(shortLabel)}</text>`);
      lines.push("</g>");
    }
  });

  lines.push("</svg>");
  fs.writeFileSync(outFile, `${lines.join("\n")}\n`);
}
function writeMermaid(outFile, graph) {
  const lines = ["flowchart LR"];
  const ids = mermaidIds(graph);
  for (const node of graph.nodes) {
    const label = htmlEscape(labelNode(node)).replaceAll("\r\n", " ").replaceAll("\n", " ").replaceAll("\r", " ");
    lines.push(`  %% node ${JSON.stringify({ id: node.id, type: node.type })}`);
    lines.push(`  ${ids.get(node.id)}["${htmlEscape(node.type)}: ${htmlEscape(node.id)} — ${label}"]`);
  }
  for (const edge of graph.edges) {
    const edgeType = mermaidEdgeType(edge.type);
    lines.push(`  %% edge ${JSON.stringify({
      type: edge.type,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
    })}`);
    lines.push(`  ${ids.get(edge.fromNodeId)} -- ${edgeType} --> ${ids.get(edge.toNodeId)}`);
  }
  fs.writeFileSync(outFile, `${lines.join("\n")}\n`);
}
function writeMarkdown(outFile, graph, title, source) {
  const stats = graphStats(graph);
  const lines = [
    `# ${markdownInline(title)}`,
    "",
    `Source: ${markdownInline(source)}`,
    `Nodes: ${stats.nodes}`,
    `Edges: ${stats.edges}`,
    "",
    "## Node counts",
    "",
    "| Type | Count |",
    "| ---- | ----- |",
    ...Object.entries(stats.byType).map(([type, count]) => `| ${markdownInline(type)} | ${count} |`),
    "",
    "## Nodes",
    "",
    ...graph.nodes.map(node =>
      `- ${markdownInline(node.type)}: ${markdownInline(node.id)} — ${markdownInline(labelNode(node))}`),
    "",
    "## Typed edges",
    "",
    "| Type | From node | To node |",
    "| ---- | --------- | ------- |",
    ...graph.edges.map(edge =>
      `| ${markdownInline(edge.type)} | ${markdownInline(edge.fromNodeId)} | ${markdownInline(edge.toNodeId)} |`),
    "",
  ];
  fs.writeFileSync(outFile, lines.join("\n"));
}
function mermaidEdgeType(type) {
  return Array.from(redactText(type))
    .map(char => isNameChar(char) || char === " " ? char : " ").join("").trim() || "RELATED_TO";
}
function assertCanvasOutputSemantics(files, graph) {
  const json = JSON.parse(fs.readFileSync(files.dataFile, "utf8"));
  if (JSON.stringify(json) !== JSON.stringify(graph)) {
    throw new Error("Canvas JSON export does not preserve the graph");
  }

  const markdown = fs.readFileSync(files.reportFile, "utf8");
  const mermaid = fs.readFileSync(files.mermaidFile, "utf8");
  const svg = fs.readFileSync(files.svgFile, "utf8");
  const html = fs.readFileSync(files.htmlFile, "utf8");
  const ids = mermaidIds(graph);
  for (const node of graph.nodes) {
    if (!markdown.includes(`- ${markdownInline(node.type)}: ${markdownInline(node.id)} —`)) {
      throw new Error(`Canvas Markdown export omits node semantics for ${JSON.stringify(node.id)}`);
    }
    if (!mermaid.includes(`%% node ${JSON.stringify({ id: node.id, type: node.type })}`)) {
      throw new Error(`Canvas Mermaid export omits node semantics for ${JSON.stringify(node.id)}`);
    }
    if (!svg.includes(`data-node-id="${htmlEscape(node.id)}" data-node-type="${htmlEscape(node.type)}"`)) {
      throw new Error(`Canvas SVG export omits node semantics for ${JSON.stringify(node.id)}`);
    }
  }
  for (const edge of graph.edges) {
    if (!markdown.includes(`| ${markdownInline(edge.type)} | ${markdownInline(edge.fromNodeId)} | ${markdownInline(edge.toNodeId)} |`)) {
      throw new Error(`Canvas Markdown export omits edge semantics for ${JSON.stringify(edge.type)}`);
    }
    const mermaidMetadata = `%% edge ${JSON.stringify({
      type: edge.type,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
    })}`;
    const mermaidLink = `${ids.get(edge.fromNodeId)} -- ${mermaidEdgeType(edge.type)} --> ${ids.get(edge.toNodeId)}`;
    if (!mermaid.includes(mermaidMetadata) || !mermaid.includes(mermaidLink)) {
      throw new Error(`Canvas Mermaid export omits edge semantics for ${JSON.stringify(edge.type)}`);
    }
    const svgMetadata = `data-edge-type="${htmlEscape(edge.type)}" data-from-node-id="${htmlEscape(edge.fromNodeId)}" data-to-node-id="${htmlEscape(edge.toNodeId)}"`;
    if (!svg.includes(svgMetadata) || !svg.includes(`>${htmlEscape(edge.type)}</text>`)) {
      throw new Error(`Canvas SVG export omits edge semantics for ${JSON.stringify(edge.type)}`);
    }
  }
  const htmlGraph = {
    nodes: graph.nodes.map(node => ({ id: node.id, type: node.type, label: labelNode(node) })),
    links: graph.edges.map(edge => ({ source: edge.fromNodeId, target: edge.toNodeId, type: edge.type })),
  };
  if (!html.includes(`const graph = ${scriptJson(htmlGraph)};`)) {
    throw new Error("Canvas HTML export does not preserve node and edge semantics");
  }
}
function writeCanvasOutputs(graph, outDir, title, sourceLabel) {
  fs.mkdirSync(outDir, { recursive: true });
  const htmlFile = path.join(outDir, exportFileNames.html);
  const svgFile = path.join(outDir, exportFileNames.svg);
  const mermaidFile = path.join(outDir, exportFileNames.mermaid);
  const reportFile = path.join(outDir, exportFileNames.markdown);
  const dataFile = path.join(outDir, exportFileNames.json);
  writeHtml(htmlFile, graph, title);
  writeSvg(svgFile, graph, title, sourceLabel);
  writeMermaid(mermaidFile, graph);
  writeMarkdown(reportFile, graph, title, sourceLabel);
  fs.writeFileSync(dataFile, `${JSON.stringify(graph, null, 2)}\n`);
  const files = {
    htmlFile,
    svgFile,
    mermaidFile,
    reportFile,
    dataFile,
  };
  assertCanvasOutputSemantics(files, graph);
  return files;
}
function exportCanvas(argv) {
  const options = parseExportArgs(argv);
  let source = options.input;
  let graph = readJson(options.input);
  if (!graph && options.inputProvided) {
    throw new Error(`Canvas graph not found: ${JSON.stringify(path.basename(options.input))}`);
  }
  if ((!graph || graph.nodes.length === 0) && options.scanIfEmpty && !options.inputProvided) {
    graph = graphFromProjectScan();
    source = "current repository scan";
  }
  if (!graph) throw new Error(`No Canvas graph found at ${options.input}; pass --scan-if-empty or provide --input.`);
  graph = safeGraph(graph);
  const safeTitle = redactText(options.title);
  const sourceLabel = source === "current repository scan" ? source : path.basename(source);
  const files = writeCanvasOutputs(graph, options.out, safeTitle, sourceLabel);
  console.log(JSON.stringify({
    ok: true,
    source: sourceLabel,
    output: {
      htmlFile: path.basename(files.htmlFile),
      svgFile: path.basename(files.svgFile),
      mermaidFile: path.basename(files.mermaidFile),
      reportFile: path.basename(files.reportFile),
      dataFile: path.basename(files.dataFile),
    },
    stats: graphStats(graph),
  }, null, 2));
}
function parsePortableArtifactArgs(argv) {
  const action = argv[0];
  if (action !== "write" && action !== "verify") usage();
  const options = {
    action,
    sourceManifest: path.join(projectDir, "release", "source-manifest.json"),
    artifact: path.join(projectDir, "release", "artifacts", "canvas-portable.json"),
    portableDir: path.join(projectDir, "release", "artifacts", "canvas-portable"),
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    const fields = new Map([
      ["--source-manifest", "sourceManifest"],
      ["--artifact", "artifact"],
      ["--portable-dir", "portableDir"],
    ]);
    const field = fields.get(arg);
    if (!field) usage();
    options[field] = path.resolve(nextArg(argv, index, arg));
    index += 1;
  }
  return options;
}
function fileProof(file, mediaType) {
  if (!fs.existsSync(file)) throw new Error(`surface output is missing: ${JSON.stringify(path.basename(file))}`);
  const bytes = fs.readFileSync(file);
  const output = {
    path: safeDisplayPath(file),
    mediaType,
    bytes: bytes.length,
    sha256: sha256(bytes),
  };
  if (mediaType === "image/png") {
    const magic = bytes.subarray(0, 8).toString("hex");
    if (magic !== "89504e470d0a1a0a" || bytes.length < 24) {
      throw new Error(`surface output is not a PNG: ${JSON.stringify(path.basename(file))}`);
    }
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width < 1 || height < 1) throw new Error(`surface PNG has invalid dimensions: ${JSON.stringify(path.basename(file))}`);
    return { ...output, magic, width, height };
  }
  return output;
}
function readSourceManifest(file) {
  if (!fs.existsSync(file)) throw new Error(`source manifest is missing: ${JSON.stringify(path.basename(file))}`);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`source manifest is invalid JSON: ${JSON.stringify(path.basename(file))}`);
  }
  try {
    validateSourceManifestDocument(manifest);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`source manifest is invalid: ${detail}`);
  }
  const verification = spawnSync(process.execPath, [sourceManifestScript, "verify"], {
    cwd: projectDir,
    encoding: "utf8",
    env: { ...process.env, CANVAST_SOURCE_MANIFEST: file },
  });
  const safeError = redactText(verification.stderr || "").replaceAll("\r\n", "\n").replaceAll("\r", "\n")
    .split("\n").filter(Boolean).slice(0, 8).join("; ");
  return {
    manifest,
    manifestSha256: sha256(fs.readFileSync(file)),
    fresh: verification.status === 0,
    verificationError: safeError,
  };
}
function portableContext() {
  return {
    d3CdnUrl: D3_CDN_URL,
    exportFileNames,
    fileProof,
    safeDisplayPath,
    safeGraph,
    sha256,
    writeCanvasOutputs,
  };
}
function portableArtifact(argv) {
  const options = parsePortableArtifactArgs(argv);
  const context = {
    d3CdnUrl: D3_CDN_URL,
    portableContext,
    readSourceManifest,
    redactDeep,
    redactText,
    safeDisplayPath,
  };
  if (options.action === "write") writePortableReleaseArtifact(options, context);
  else verifyPortableReleaseArtifact(options, context);
}

function main() {
  try {
    const argv = process.argv.slice(2);
    if (argv[0] === "surface-artifact") surfaceArtifact(argv.slice(1), {
      d3CdnUrl: D3_CDN_URL, fileProof, nextArg, portableContext, projectDir,
      readSourceManifest, redactDeep, redactText, safeDisplayPath, usage,
    });
    else if (argv[0] === "portable-artifact") portableArtifact(argv.slice(1));
    else exportCanvas(argv);
  } catch (error) {
    console.error(`Canvas export failed: ${redactText(error instanceof Error ? error.message : String(error))}`);
    process.exitCode = 1;
  }
}
function directExecutionPath(file) {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return path.resolve(file);
  }
}
if (process.argv[1] && directExecutionPath(process.argv[1]) === directExecutionPath(fileURLToPath(import.meta.url))) {
  main();
}
