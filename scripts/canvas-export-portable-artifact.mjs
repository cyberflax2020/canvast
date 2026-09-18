/**
 * =============================================================================
 * Canvast — Canvas Export Portable Artifact / Canvast 源文件
 * =============================================================================
 * @file        scripts/canvas-export-portable-artifact.mjs
 * @brief       Stable Canvas portable artifact generation and verification.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const portableProofTitle = "Canvas Surface Proof";
export const portableProofFixtureName = "fixture-input.json";

export function portableProofGraph() {
  return {
    nodes: [
      { id: "plan-release", type: "plan", properties: { goal: "Verify Canvas portable artifact", status: "in_progress" } },
      { id: "decision-offline", type: "decision", properties: { chosen: "Keep SVG standalone and disclose the HTML CDN" } },
      { id: "file-export", type: "file", properties: { path: "scripts/export-canvas.mjs", stale: false } },
      { id: "agent-proof", type: "agent_run", properties: { task: "Run the Canvas portable proof", status: "completed" } },
    ],
    edges: [
      { id: "edge-1", type: "MOTIVATED_BY", fromNodeId: "plan-release", toNodeId: "decision-offline" },
      { id: "edge-2", type: "PRODUCED_BY", fromNodeId: "file-export", toNodeId: "agent-proof" },
      { id: "edge-3", type: "DECOMPOSES_INTO", fromNodeId: "plan-release", toNodeId: "file-export" },
      { id: "edge-4", type: "EXECUTED_BY", fromNodeId: "plan-release", toNodeId: "agent-proof" },
    ],
  };
}

function portableProofListing(dir) {
  return fs.readdirSync(dir).sort((left, right) => left.localeCompare(right));
}

function portableFixtureProof(fixturePath, graph, context) {
  return {
    kind: "persisted-canvas-graph",
    path: context.safeDisplayPath(fixturePath),
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    sha256: context.sha256(fs.readFileSync(fixturePath)),
  };
}

function assertPortableProofSet(dir, exportFileNames) {
  const expected = [portableProofFixtureName, ...Object.values(exportFileNames)].sort();
  const actual = portableProofListing(dir);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("portable Canvas artifact produced an unexpected file set");
  }
}

function assertPortableProofSemantics(dir, exportFileNames, d3CdnUrl) {
  const svg = fs.readFileSync(path.join(dir, exportFileNames.svg), "utf8");
  const html = fs.readFileSync(path.join(dir, exportFileNames.html), "utf8");
  if (!svg.startsWith("<svg ") || svg.toLowerCase().includes("<script") || svg.toLowerCase().includes("href=")) {
    throw new Error("portable Canvas artifact SVG is not standalone");
  }
  if (!html.includes(d3CdnUrl) || !html.includes("network required") || !html.includes(exportFileNames.svg)) {
    throw new Error("portable Canvas artifact HTML dependency disclosure is stale");
  }
}

function collectPortableProof(dir, graph, context) {
  assertPortableProofSet(dir, context.exportFileNames);
  assertPortableProofSemantics(dir, context.exportFileNames, context.d3CdnUrl);
  return {
    fixture: portableFixtureProof(path.join(dir, portableProofFixtureName), graph, context),
    outputs: [
      context.fileProof(path.join(dir, context.exportFileNames.json), "application/json"),
      context.fileProof(path.join(dir, context.exportFileNames.markdown), "text/markdown"),
      context.fileProof(path.join(dir, context.exportFileNames.mermaid), "text/vnd.mermaid"),
      context.fileProof(path.join(dir, context.exportFileNames.svg), "image/svg+xml"),
      context.fileProof(path.join(dir, context.exportFileNames.html), "text/html"),
    ],
  };
}

export function portableEntryCommand(dir, safeDisplayPath, redactText) {
  const fixture = path.join(dir, portableProofFixtureName);
  return redactText(
    `npm run export:canvas -- --input ${safeDisplayPath(fixture)} --out ${safeDisplayPath(dir)} --title "${portableProofTitle}"`,
  );
}

export function portableVerificationCommand(dir, safeDisplayPath, redactText) {
  const fixture = path.join(dir, portableProofFixtureName);
  return redactText(
    `node scripts/export-canvas.mjs --input ${safeDisplayPath(fixture)} --out ${safeDisplayPath(dir)} --title "${portableProofTitle}"`,
  );
}

export function writePortableArtifact(dir, context) {
  const graph = context.safeGraph(portableProofGraph());
  fs.mkdirSync(dir, { recursive: true });
  const fixturePath = path.join(dir, portableProofFixtureName);
  fs.writeFileSync(fixturePath, `${JSON.stringify(graph, null, 2)}\n`);
  context.writeCanvasOutputs(graph, dir, portableProofTitle, portableProofFixtureName);
  return collectPortableProof(dir, graph, context);
}

export function verifyPortableArtifact(dir, context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "canvast-portable-proof-"));
  try {
    const expected = writePortableArtifact(root, context);
    const actual = collectPortableProof(dir, context.safeGraph(portableProofGraph()), context);
    const fileNames = [portableProofFixtureName, ...Object.values(context.exportFileNames)];
    for (const fileName of fileNames) {
      const expectedBytes = fs.readFileSync(path.join(root, fileName));
      const actualBytes = fs.readFileSync(path.join(dir, fileName));
      if (!actualBytes.equals(expectedBytes)) {
        if (fileName === portableProofFixtureName) throw new Error("portable Canvas fixture bytes are stale");
        throw new Error(`portable Canvas published output is stale: ${JSON.stringify(fileName)}`);
      }
    }
    return actual;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
