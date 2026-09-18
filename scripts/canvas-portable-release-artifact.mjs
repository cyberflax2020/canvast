/**
 * =============================================================================
 * Canvast — Canvas Portable Release Artifact / Canvast 源文件
 * =============================================================================
 * @file        scripts/canvas-portable-release-artifact.mjs
 * @brief       Formal source-bound release artifact for the five portable outputs.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import fs from "node:fs";
import path from "node:path";

import {
  portableEntryCommand,
  portableVerificationCommand,
  verifyPortableArtifact,
  writePortableArtifact,
} from "./canvas-export-portable-artifact.mjs";

function portableReleaseDocument(options, context, source, portable) {
  return context.redactDeep({
    schemaVersion: 1,
    kind: "canvast-canvas-portable-release",
    generatedAt: new Date().toISOString(),
    sourceManifest: {
      path: context.safeDisplayPath(options.sourceManifest),
      status: "verified",
      sourceTreeSha256: source.manifest.sourceTreeSha256,
      manifestSha256: source.manifestSha256,
    },
    entry: portableEntryCommand(options.portableDir, context.safeDisplayPath, context.redactText),
    verificationCommand: portableVerificationCommand(options.portableDir, context.safeDisplayPath, context.redactText),
    fixture: portable.fixture,
    outputs: portable.outputs,
    assertions: [
      "The real CLI produces exactly JSON, Markdown, Mermaid, standalone SVG, and interactive HTML.",
      "All formats preserve the four Canvas node types and four traceability edges after credential and personal-home redaction.",
      `SVG has no runtime dependency; HTML declares its pinned ${context.d3CdnUrl} dependency and links the offline SVG fallback.`,
    ],
  });
}

function verifiedSource(options, context) {
  const source = context.readSourceManifest(options.sourceManifest);
  if (!source.fresh) {
    throw new Error(`source manifest is stale${source.verificationError ? `: ${source.verificationError}` : ""}`);
  }
  return source;
}

export function buildPortableReleaseArtifact(options, context) {
  const source = verifiedSource(options, context);
  const portable = writePortableArtifact(options.portableDir, context.portableContext());
  return portableReleaseDocument(options, context, source, portable);
}

export function writePortableReleaseArtifact(options, context) {
  const artifact = buildPortableReleaseArtifact(options, context);
  fs.mkdirSync(path.dirname(options.artifact), { recursive: true });
  fs.writeFileSync(options.artifact, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`Canvas portable artifact written: ${path.basename(options.artifact)}`);
  console.log(`Source binding: ${artifact.sourceManifest.sourceTreeSha256}`);
}

export function verifyPortableReleaseArtifact(options, context) {
  if (!fs.existsSync(options.artifact)) throw new Error(`Canvas portable artifact is missing: ${JSON.stringify(path.basename(options.artifact))}`);
  let declared;
  try {
    declared = JSON.parse(fs.readFileSync(options.artifact, "utf8"));
  } catch {
    throw new Error(`Canvas portable artifact is invalid JSON: ${JSON.stringify(path.basename(options.artifact))}`);
  }
  if (declared?.schemaVersion !== 1 || declared?.kind !== "canvast-canvas-portable-release") {
    throw new Error("Canvas portable artifact has an invalid schema or kind");
  }
  const source = verifiedSource(options, context);
  if (
    declared.sourceManifest?.status !== "verified" ||
    declared.sourceManifest?.sourceTreeSha256 !== source.manifest.sourceTreeSha256 ||
    declared.sourceManifest?.manifestSha256 !== source.manifestSha256
  ) {
    throw new Error("Canvas portable artifact does not match source-manifest.json");
  }
  const portable = verifyPortableArtifact(options.portableDir, context.portableContext());
  const current = portableReleaseDocument(options, context, source, portable);
  const comparableDeclared = {
    ...declared,
    generatedAt: "<ignored>",
    outputs: (declared.outputs || []).map(output => ({ ...output, path: path.basename(output.path) })),
  };
  const comparableCurrent = {
    ...current,
    generatedAt: "<ignored>",
    outputs: current.outputs.map(output => ({ ...output, path: path.basename(output.path) })),
  };
  if (JSON.stringify(comparableDeclared) !== JSON.stringify(comparableCurrent)) {
    throw new Error("Canvas portable artifact outputs or functional assertions are stale");
  }
  const serialized = JSON.stringify(declared);
  if (context.redactText(serialized) !== serialized) {
    throw new Error("Canvas portable artifact contains a personal home path");
  }
  console.log(`Canvas portable artifact verified: ${source.manifest.sourceTreeSha256}`);
}
