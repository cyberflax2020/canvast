/**
 * =============================================================================
 * Canvast — Canvas Surface Artifact / Canvast source file
 * =============================================================================
 * @file        scripts/canvas-surface-artifact.mjs
 * @brief       Build and verify the three Canvas product presentation surfaces.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  portableEntryCommand,
  portableVerificationCommand,
  verifyPortableArtifact,
  writePortableArtifact,
} from "./canvas-export-portable-artifact.mjs";

const PENDING_SOURCE_HASH = "pending-final-freeze";

function parseArgs(argv, context) {
  const action = argv[0];
  if (action !== "write" && action !== "verify") context.usage();
  const options = {
    action,
    sourceManifest: path.join(context.projectDir, "release", "source-manifest.json"),
    artifact: path.join(context.projectDir, "release", "artifacts", "canvas-surfaces.json"),
    tuiOutput: path.join(context.projectDir, "docs", "assets", "user-guide", "tui-canvas-safety.png"),
    macosOutput: path.join(context.projectDir, "docs", "assets", "user-guide", "macos-canvas.png"),
    portableDir: path.join(context.projectDir, "release", "artifacts", "canvas-portable"),
    tuiCommand: "node scripts/verify-tui-screenshot-provenance.mjs docs/assets/user-guide release/artifacts/tui-captures",
    macosCommand: "scripts/verify-user-guide-screenshots.sh docs/assets/user-guide",
    allowPendingSource: false,
  };
  const fields = new Map([
    ["--source-manifest", "sourceManifest"], ["--artifact", "artifact"],
    ["--tui-output", "tuiOutput"], ["--macos-output", "macosOutput"],
    ["--portable-dir", "portableDir"], ["--tui-command", "tuiCommand"],
    ["--macos-command", "macosCommand"],
  ]);
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--allow-pending-source") { options.allowPendingSource = true; continue; }
    const field = fields.get(arg);
    if (!field) context.usage();
    const value = context.nextArg(argv, index, arg);
    options[field] = field.endsWith("Output") || ["sourceManifest", "artifact", "portableDir"].includes(field)
      ? path.resolve(value) : value;
    index += 1;
  }
  return options;
}

function expectedSurfaces(options, portable, context) {
  return [{
    id: "tui", presentation: "terminal-runtime", access: "interactive",
    entry: "/canvast-canvas [focus <node-id> | type <node-type> | search <text> | page <n> | limit <n>]",
    verificationCommand: context.redactText(options.tuiCommand),
    outputs: [context.fileProof(options.tuiOutput, "image/png")],
    assertions: [
      "Production renderCanvasLines reads persisted canvas-graph.json.",
      "The command exposes overview, focus, type, search, page, and limit navigation.",
      "The runtime widget exposes the active Canvas mode; the graph itself opens through /canvast-canvas.",
    ],
  }, {
    id: "macos-native", presentation: "native-swiftui-canvas", access: "read-only",
    entry: "Canvast.app > Canvas workspace",
    verificationCommand: context.redactText(options.macosCommand),
    outputs: [context.fileProof(options.macosOutput, "image/png")],
    assertions: [
      "CanvasGraphStore decodes the project state directory canvas-graph.json and rejects dangling edges.",
      "The native view renders real node and edge items with search, type filter, pan, zoom, refresh, selection, and direct-neighbor focus.",
      "Node selection drives the inspector incoming/outgoing edge controls; the graph view does not wire record or export mutations.",
    ],
  }, {
    id: "portable-export", presentation: "generated-files", access: "read-only",
    entry: portableEntryCommand(options.portableDir, context.safeDisplayPath, context.redactText),
    verificationCommand: portableVerificationCommand(options.portableDir, context.safeDisplayPath, context.redactText),
    outputs: portable.outputs, fixture: portable.fixture,
    assertions: [
      "The real CLI produces exactly JSON, Markdown, Mermaid, standalone SVG, and interactive HTML.",
      "All formats preserve the four Canvas node types and four traceability edges after credential and personal-home redaction.",
      `SVG has no runtime dependency; HTML declares its pinned ${context.d3CdnUrl} dependency and links the offline SVG fallback.`,
    ],
  }];
}

function comparable(surfaces) {
  return surfaces.map(surface => ({
    ...surface, outputs: surface.outputs.map(output => ({ ...output, path: path.basename(output.path) })),
  }));
}

function build(options, context) {
  const source = context.readSourceManifest(options.sourceManifest);
  if (!source.fresh) throw new Error(`source manifest is stale${source.verificationError ? `: ${source.verificationError}` : ""}`);
  const portable = writePortableArtifact(options.portableDir, context.portableContext());
  return context.redactDeep({
    schemaVersion: 1, kind: "canvast-canvas-surfaces", generatedAt: new Date().toISOString(),
    sourceManifest: {
      path: context.safeDisplayPath(options.sourceManifest), status: "verified",
      sourceTreeSha256: source.manifest.sourceTreeSha256, manifestSha256: source.manifestSha256,
    },
    surfaces: expectedSurfaces(options, portable, context),
  });
}

function write(options, context) {
  const artifact = build(options, context);
  fs.mkdirSync(path.dirname(options.artifact), { recursive: true });
  fs.writeFileSync(options.artifact, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`Canvas surfaces artifact written: ${path.basename(options.artifact)}`);
  console.log(`Source binding: ${artifact.sourceManifest.sourceTreeSha256}`);
}

function runVerifier(label, command, context) {
  const result = spawnSync("/bin/sh", ["-c", command], {
    cwd: context.projectDir, encoding: "utf8", env: { ...process.env }, timeout: 120_000,
  });
  if (result.error) throw new Error(`${label} Canvas surface verifier could not run: ${context.redactText(result.error.message)}`);
  if (result.status === 0) return;
  const detail = [result.stderr, result.stdout].map(value => context.redactText(value || "").trim()).filter(Boolean).join("; ");
  throw new Error(`${label} Canvas surface verifier failed${detail ? `: ${detail}` : ` with status ${String(result.status)}`}`);
}

function verify(options, context) {
  if (!fs.existsSync(options.artifact)) throw new Error(`Canvas surfaces artifact is missing: ${JSON.stringify(path.basename(options.artifact))}`);
  let declared;
  try { declared = JSON.parse(fs.readFileSync(options.artifact, "utf8")); }
  catch { throw new Error(`Canvas surfaces artifact is invalid JSON: ${JSON.stringify(path.basename(options.artifact))}`); }
  if (declared?.schemaVersion !== 1 || declared?.kind !== "canvast-canvas-surfaces") {
    throw new Error("Canvas surfaces artifact has an invalid schema or kind");
  }
  const source = context.readSourceManifest(options.sourceManifest);
  if (!source.fresh && !options.allowPendingSource) throw new Error("source manifest is stale");
  if (source.fresh) {
    if (declared.sourceManifest?.status !== "verified" ||
      declared.sourceManifest?.sourceTreeSha256 !== source.manifest.sourceTreeSha256 ||
      declared.sourceManifest?.manifestSha256 !== source.manifestSha256) {
      throw new Error("Canvas surfaces artifact does not match source-manifest.json");
    }
  } else if (declared.sourceManifest?.status !== PENDING_SOURCE_HASH ||
    declared.sourceManifest?.sourceTreeSha256 !== PENDING_SOURCE_HASH ||
    declared.sourceManifest?.manifestSha256 !== PENDING_SOURCE_HASH) {
    throw new Error("pending Canvas surfaces artifact has an invalid source binding");
  }
  const current = expectedSurfaces(options, verifyPortableArtifact(options.portableDir, context.portableContext()), context);
  if (JSON.stringify(comparable(declared.surfaces || [])) !== JSON.stringify(comparable(current))) {
    throw new Error("Canvas surface outputs or functional assertions are stale");
  }
  const serialized = JSON.stringify(declared);
  if (context.redactText(serialized) !== serialized) throw new Error("Canvas surfaces artifact contains a personal home path");
  if (!source.fresh && options.allowPendingSource) {
    console.log(`Canvas surfaces artifact NON-RELEASE pending verification passed: ${PENDING_SOURCE_HASH}`);
    return;
  }
  runVerifier("tui", options.tuiCommand, context);
  runVerifier("macos", options.macosCommand, context);
  console.log(`Canvas surfaces artifact verified: ${source.manifest.sourceTreeSha256}`);
}

export function surfaceArtifact(argv, context) {
  const options = parseArgs(argv, context);
  if (options.action === "write") write(options, context);
  else verify(options, context);
}
