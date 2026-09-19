#!/usr/bin/env node
/**
 * =============================================================================
 * Canvast — Release Impact Evidence / Canvast source file
 * =============================================================================
 * @file        scripts/release-impact-evidence.mjs
 * @brief       Validates scoped release impact evidence without rerunning live.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateSourceManifestDocument } from "./source-manifest-validation.mjs";

export const MACOS_UI_IMPACT_RELATIVE_PATH = "release/artifacts/macos-ui-impact.json";
export const DEFAULT_PAIRED_EVALUATION_RELATIVE_PATH = "eval-matrix/artifacts/paired-evaluation-latest.json";
export const DEFAULT_PAIRED_SMOKE_RELATIVE_PATH = "eval-matrix/artifacts/paired-smoke-latest.json";
export const DEFAULT_EFFECTIVENESS_SUMMARY_RELATIVE_PATH = "release/artifacts/effectiveness-summary.json";
export const DEFAULT_SOURCE_MANIFEST_RELATIVE_PATH = "release/source-manifest.json";

const REQUIRED_IMPACT_FLAGS = Object.freeze({
  macosUiAffected: true,
  installedAppAffected: true,
  llmEvaluationAffected: false,
  agentRuntimeAffected: false,
  nodeRuntimeAffected: false,
  evaluationHarnessAffected: false,
  requiresLiveRerun: false,
});

const RELEASE_PRESENTATION_IMPACT_FLAGS = Object.freeze({
  llmEvaluationAffected: false,
  agentRuntimeAffected: false,
  nodeRuntimeAffected: false,
  evaluationHarnessAffected: false,
  requiresLiveRerun: false,
});

const IMPACT_CLASSIFICATION_MACOS_UI = "macos-ui-focused-interaction";
const IMPACT_CLASSIFICATION_RELEASE_PRESENTATION = "release-presentation";
const IMPACT_CLASSIFICATIONS = Object.freeze([
  IMPACT_CLASSIFICATION_MACOS_UI,
  IMPACT_CLASSIFICATION_RELEASE_PRESENTATION,
]);

const MACOS_UI_PRODUCT_PATHS = new Set([
  "macos-app/Sources/CanvastApp/CanvastDesktopModel+Actions.swift",
  "macos-app/Sources/CanvastApp/CanvastDesktopModel+Bridge.swift",
  "macos-app/Sources/CanvastApp/CanvastDesktopModel+Configuration.swift",
  "macos-app/Sources/CanvastApp/CanvastDesktopModel+LiveSession.swift",
  "macos-app/Sources/CanvastApp/CanvastDesktopModel.swift",
  "macos-app/Sources/CanvastApp/DesktopActionRegistry.swift",
  "macos-app/Sources/CanvastApp/DesktopSessionModels.swift",
  "macos-app/Sources/CanvastApp/RunConsoleOutputViews.swift",
  "macos-app/Sources/CanvastApp/RunConsoleView.swift",
  "macos-app/Sources/CanvastApp/SessionChatComponents.swift",
  "macos-app/Sources/CanvastApp/SessionWorkspaceView.swift",
  "macos-app/Sources/CanvastApp/UserGuideSnapshotRenderer.swift",
  "macos-app/Sources/CanvastAppCore/CanvastBridge.swift",
]);

const RELEASE_TOOLING_PATHS = new Set([
  "THIRD_PARTY_NOTICES.md",
  "eval-matrix/paired-enhanced-probes.ts",
  "eval-matrix/paired-evidence-contract.mjs",
  "eval-matrix/paired-enhanced-track.ts",
  "eval-matrix/paired-public-artifact.ts",
  "eval-matrix/paired-runner.ts",
  "eval-matrix/paired-launch.ts",
  "eval-matrix/runner-command.ts",
  "package.json",
  "scripts/build-public-repo.mjs",
  "scripts/check-delivery-readiness.mjs",
  "scripts/check-product-closure.mjs",
  "scripts/effectiveness-render.mjs",
  "scripts/effectiveness-summary.mjs",
  "scripts/generate-effectiveness-evidence.mjs",
  "scripts/public-release-guards.mjs",
  "scripts/public-repo-policy.mjs",
  "scripts/release-source-policy.mjs",
  "scripts/release-artifacts.mjs",
  "scripts/release-impact-evidence.mjs",
  "scripts/release-manifest.mjs",
  "scripts/release-profile.mjs",
  "scripts/source-manifest.mjs",
  "scripts/update-artifact-index.mjs",
  "scripts/update-closure-record.mjs",
  "scripts/verify-brand-assets.mjs",
  "scripts/verify-public-release.mjs",
]);

const RELEASE_PRESENTATION_EXACT_PATHS = new Set([
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "NOTICE",
  "README.md",
  "README.zh-CN.md",
  "SECURITY.md",
]);

const RELEASE_PRESENTATION_PREFIXES = Object.freeze([
  ".github/",
  "assets/",
  "docs/",
]);

const FOCUSED_TEST_PATHS = new Set([
  "macos-app/Sources/CanvastApp/CanvastAppSelfTest.swift",
  "macos-app/Sources/CanvastApp/CanvastAppSelfTestActionLifecycleTests.swift",
  "macos-app/Sources/CanvastApp/CanvastAppSelfTestRuntimeTests.swift",
  "macos-app/Sources/CanvastApp/CanvastAppSelfTestSettingsTests.swift",
  "macos-app/Sources/CanvastApp/CanvastAppSelfTestSupport.swift",
  "tests/helpers/effectiveness-evidence-fixture.ts",
  "tests/unit/delivery-readiness-gate.test.ts",
  "tests/unit/effectiveness-evidence.test.ts",
  "tests/unit/installed-gui-acceptance.test.ts",
  "tests/unit/macos-observability-mount.test.ts",
  "tests/unit/public-repo-build.test.ts",
  "tests/unit/public-repo-policy.test.ts",
  "tests/unit/public-release-guards.test.ts",
  "tests/unit/public-release-verifier.test.ts",
  "tests/unit/release-artifacts.test.ts",
  "tests/unit/release-manifest.test.ts",
  "tests/unit/release-profile.test.ts",
  "tests/unit/update-artifact-index.test.ts",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSha256(value) {
  return typeof value === "string"
    && value.length === 64
    && [...value].every(character => "0123456789abcdef".includes(character));
}

function canonicalTimestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO-8601 timestamp`);
  }
  return value;
}

function portableRelativePath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\")
    || value.includes("\0") || value.includes("\n") || value.includes("\r")
    || path.posix.isAbsolute(value) || path.posix.normalize(value) !== value) {
    throw new Error(`${label} must be a canonical portable relative path`);
  }
  const segments = value.split("/");
  if (segments.some(segment => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`${label} must be a canonical portable relative path`);
  }
  return value;
}

function resolveInside(projectDir, relative, label) {
  const normalized = portableRelativePath(relative, label);
  const root = fs.realpathSync(projectDir);
  const absolute = path.resolve(root, ...normalized.split("/"));
  const rel = path.relative(root, absolute);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`${label} escapes the project root`);
  }
  return { absolute, relative: normalized };
}

function readJsonFile(projectDir, relative, label) {
  const resolved = resolveInside(projectDir, relative, label);
  const raw = fs.readFileSync(resolved.absolute);
  return {
    path: resolved.relative,
    raw,
    sha256: sha256(raw),
    document: JSON.parse(raw.toString("utf8")),
  };
}

function manifestBindingFromFile(projectDir, relative = DEFAULT_SOURCE_MANIFEST_RELATIVE_PATH) {
  const file = readJsonFile(projectDir, relative, "source manifest");
  const validated = validateSourceManifestDocument(file.document);
  return {
    path: file.path,
    sha256: file.sha256,
    generatedAt: validated.generatedAt,
    sourceTreeSha256: validated.sourceTreeSha256,
    document: file.document,
  };
}

function manifestBindingFromEmbedded(value, label) {
  if (!isRecord(value) || value.path !== DEFAULT_SOURCE_MANIFEST_RELATIVE_PATH
    || !isRecord(value.document) || !isSha256(value.sha256)) {
    throw new Error(`${label} must embed a release/source-manifest.json snapshot`);
  }
  const serialized = Buffer.from(canonicalJson(value.document));
  const actualSha256 = sha256(serialized);
  if (actualSha256 !== value.sha256) {
    throw new Error(`${label} embedded source manifest SHA-256 mismatch`);
  }
  const validated = validateSourceManifestDocument(value.document);
  if (value.generatedAt !== validated.generatedAt
    || value.sourceTreeSha256 !== validated.sourceTreeSha256) {
    throw new Error(`${label} embedded source manifest metadata mismatch`);
  }
  return {
    path: value.path,
    sha256: value.sha256,
    generatedAt: validated.generatedAt,
    sourceTreeSha256: validated.sourceTreeSha256,
    document: value.document,
  };
}

function sameBinding(actual, expected) {
  return isRecord(actual)
    && actual.path === expected.path
    && actual.sha256 === expected.sha256
    && actual.generatedAt === expected.generatedAt
    && actual.sourceTreeSha256 === expected.sourceTreeSha256;
}

function currentSourceBindingForManifest(manifest) {
  return {
    path: manifest.path,
    sha256: manifest.rawSha256 || manifest.sha256,
    generatedAt: manifest.generatedAt,
    sourceTreeSha256: manifest.sourceTreeSha256,
    document: manifest.document,
  };
}

function sourceBindingFromPaired(document, label) {
  const provenance = isRecord(document?.provenance) ? document.provenance : {};
  const releaseManifest = isRecord(document?.source?.releaseManifest)
    ? document.source.releaseManifest
    : {};
  return {
    path: provenance.sourceManifestPath,
    sha256: provenance.sourceManifestSha256,
    generatedAt: provenance.sourceManifestGeneratedAt || releaseManifest.generatedAt,
    sourceTreeSha256: releaseManifest.declaredTreeSha256,
    label,
  };
}

function sourceBindingFromEffectiveness(document, label) {
  const source = isRecord(document?.inputs?.sourceManifest) ? document.inputs.sourceManifest : {};
  return {
    path: source.path,
    sha256: source.sha256,
    generatedAt: source.generatedAt,
    sourceTreeSha256: source.sourceTreeSha256,
    label,
  };
}

function requireBinding(actual, expected, label) {
  if (!sameBinding(actual, expected)) {
    throw new Error(`${label} does not bind the expected source manifest`);
  }
}

function fileMap(manifest) {
  return new Map(manifest.document.files.map(file => [file.path, file]));
}

function sourceDiff(base, current) {
  const baseByPath = fileMap(base);
  const currentByPath = fileMap(current);
  const paths = [...new Set([...baseByPath.keys(), ...currentByPath.keys()])]
    .sort((left, right) => left.localeCompare(right));
  const changes = [];
  for (const pathName of paths) {
    const previous = baseByPath.get(pathName) || null;
    const currentEntry = currentByPath.get(pathName) || null;
    if (previous && currentEntry
      && previous.sha256 === currentEntry.sha256
      && previous.size === currentEntry.size
      && previous.mode === currentEntry.mode) {
      continue;
    }
    changes.push({ path: pathName, previous, current: currentEntry });
  }
  return changes;
}

export function classifyMacosUiImpactPath(relativePath) {
  const normalized = portableRelativePath(relativePath, "impact path");
  if (MACOS_UI_PRODUCT_PATHS.has(normalized)) return "macos-ui-product";
  if (FOCUSED_TEST_PATHS.has(normalized)) return "focused-test";
  if (RELEASE_TOOLING_PATHS.has(normalized)) return "release-tooling";
  if (RELEASE_PRESENTATION_EXACT_PATHS.has(normalized)) return "release-presentation";
  if (RELEASE_PRESENTATION_PREFIXES.some(prefix => normalized.startsWith(prefix))) {
    return "release-presentation";
  }
  return null;
}

function impactEntry(change) {
  return {
    path: change.path,
    classification: classifyMacosUiImpactPath(change.path),
    previous: change.previous ? {
      sha256: change.previous.sha256,
      size: change.previous.size,
      mode: change.previous.mode,
    } : null,
    current: change.current ? {
      sha256: change.current.sha256,
      size: change.current.size,
      mode: change.current.mode,
    } : null,
  };
}

function sameImpactEntry(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function verifyChangedPaths(document, evaluationSource, currentSource) {
  const classification = document.classification;
  const computed = sourceDiff(evaluationSource, currentSource).map(impactEntry);
  if (computed.length === 0) throw new Error("macOS UI impact must declare at least one source change");
  const declared = Array.isArray(document.changedPaths) ? document.changedPaths : [];
  if (declared.length !== computed.length) {
    throw new Error(`macOS UI impact changedPaths count mismatch: expected ${computed.length}, got ${declared.length}`);
  }
  for (let index = 0; index < computed.length; index += 1) {
    const actual = declared[index];
    const expected = computed[index];
    if (!isRecord(actual) || !sameImpactEntry(actual, expected)) {
      throw new Error(`macOS UI impact changedPaths[${index}] does not match computed source diff`);
    }
    if (!actual.classification) {
      throw new Error(`macOS UI impact path is outside the UI-only allowlist: ${expected.path}`);
    }
    if (actual.previous === null) {
      if (!["macos-ui-product", "release-tooling", "focused-test", "release-presentation"].includes(actual.classification)) {
        throw new Error(`macOS UI impact may only add macOS UI product, release tooling, focused test, or release presentation files: ${expected.path}`);
      }
    }
    if (actual.current === null) {
      throw new Error(`macOS UI impact may not remove source files: ${expected.path}`);
    }
  }
  const hasMacosUiProduct = computed.some(entry => entry.classification === "macos-ui-product");
  if (classification === IMPACT_CLASSIFICATION_MACOS_UI && !hasMacosUiProduct) {
    throw new Error("macOS UI impact must include at least one macOS UI product source change");
  }
  if (classification === IMPACT_CLASSIFICATION_RELEASE_PRESENTATION
    && !computed.some(entry => ["release-presentation", "release-tooling", "focused-test"].includes(entry.classification))) {
    throw new Error("release-presentation impact must include at least one non-runtime source change");
  }
  return computed;
}

function validateFocusedVerification(document, currentSource, changedPaths) {
  const focused = isRecord(document.focusedVerification) ? document.focusedVerification : {};
  const required = [];
  if (document.classification === IMPACT_CLASSIFICATION_RELEASE_PRESENTATION) {
    required.push(["evidenceProjection", "node scripts/generate-effectiveness-evidence.mjs verify --readme README.md"]);
    if (changedPaths.some(entry => entry.classification === "macos-ui-product")) {
      required.push(["swiftBuild", "swift build --package-path macos-app"]);
      required.push(["appSelfTest", "swift run --package-path macos-app CanvastApp --self-test"]);
    }
  } else {
    required.push(["swiftBuild", "swift build --package-path macos-app"]);
    required.push(["appSelfTest", "swift run --package-path macos-app CanvastApp --self-test"]);
  }
  for (const [key, command] of required) {
    const entry = focused[key];
    if (!isRecord(entry) || entry.command !== command || entry.status !== "passed") {
      throw new Error(`macOS UI impact focusedVerification.${key} must record a passed ${command}`);
    }
    canonicalTimestamp(entry.completedAt, `focusedVerification.${key}.completedAt`);
    if (Date.parse(entry.completedAt) < Date.parse(currentSource.generatedAt)) {
      throw new Error(`macOS UI impact focusedVerification.${key} predates the current source manifest`);
    }
    if (!sameBinding(entry.sourceManifest, currentSource)) {
      throw new Error(`macOS UI impact focusedVerification.${key} is not bound to the current source manifest`);
    }
  }
}

function validateImpactAssessment(document, changedPaths) {
  const impact = isRecord(document.impactAssessment) ? document.impactAssessment : {};
  const required = document.classification === IMPACT_CLASSIFICATION_RELEASE_PRESENTATION
    ? RELEASE_PRESENTATION_IMPACT_FLAGS
    : REQUIRED_IMPACT_FLAGS;
  for (const [key, value] of Object.entries(required)) {
    if (impact[key] !== value) {
      throw new Error(`macOS UI impact impactAssessment.${key} must be ${String(value)}`);
    }
  }
  if (document.classification === IMPACT_CLASSIFICATION_RELEASE_PRESENTATION) {
    const hasMacosUiProduct = changedPaths.some(entry => entry.classification === "macos-ui-product");
    for (const key of ["macosUiAffected", "installedAppAffected"]) {
      if (impact[key] !== hasMacosUiProduct) {
        throw new Error(`macOS UI impact impactAssessment.${key} must be ${String(hasMacosUiProduct)} for the declared change set`);
      }
    }
  }
}

function evidenceRecord(projectDir, relative, label) {
  const artifact = readJsonFile(projectDir, relative, label);
  const generatedAt = canonicalTimestamp(artifact.document.generatedAt, `${label} generatedAt`);
  const status = artifact.document.status;
  if (status !== "passed") throw new Error(`${label} status must be passed`);
  return {
    path: artifact.path,
    sha256: artifact.sha256,
    generatedAt,
    document: artifact.document,
  };
}

function declaredEvidenceRecord(record, actual, source, label) {
  if (!isRecord(record)
    || record.path !== actual.path
    || record.sha256 !== actual.sha256
    || record.generatedAt !== actual.generatedAt
    || record.sourceManifestSha256 !== source.sha256
    || record.sourceTreeSha256 !== source.sourceTreeSha256) {
    throw new Error(`macOS UI impact ${label} evidence record is stale`);
  }
}

export function validateMacosUiImpactEvidence(projectDir, options = {}) {
  const currentSource = currentSourceBindingForManifest(
    options.currentManifest || manifestBindingFromFile(projectDir),
  );
  const artifactPath = options.artifactPath || MACOS_UI_IMPACT_RELATIVE_PATH;
  const impact = readJsonFile(projectDir, artifactPath, "macOS UI impact evidence");
  const document = impact.document;
  if (!isRecord(document)
    || document.schemaVersion !== 1
    || document.kind !== "canvast-macos-ui-impact"
    || document.status !== "passed"
    || !IMPACT_CLASSIFICATIONS.includes(document.classification)) {
    throw new Error("macOS UI impact schema, kind, status, or classification is invalid");
  }
  const generatedAt = canonicalTimestamp(document.generatedAt, "macOS UI impact generatedAt");
  if (Date.parse(generatedAt) < Date.parse(currentSource.generatedAt)) {
    throw new Error("macOS UI impact predates the current source manifest");
  }
  if (!sameBinding(document.currentSourceManifest, currentSource)) {
    throw new Error("macOS UI impact is not bound to the current source manifest");
  }
  const evaluationSource = manifestBindingFromEmbedded(
    document.evaluationSourceManifest,
    "macOS UI impact evaluationSourceManifest",
  );
  if (sameBinding(evaluationSource, currentSource)) {
    throw new Error("macOS UI impact is unnecessary when evaluation and current source match");
  }
  const changedPaths = verifyChangedPaths(document, evaluationSource, currentSource);
  validateImpactAssessment(document, changedPaths);
  validateFocusedVerification(document, currentSource, changedPaths);

  const paired = options.pairedEvaluation || evidenceRecord(
    projectDir,
    options.pairedEvaluationPath || DEFAULT_PAIRED_EVALUATION_RELATIVE_PATH,
    "paired evaluation",
  );
  const smoke = options.smokeArtifact || evidenceRecord(
    projectDir,
    options.smokeArtifactPath || DEFAULT_PAIRED_SMOKE_RELATIVE_PATH,
    "paired smoke",
  );
  const effectiveness = options.effectivenessSummary || evidenceRecord(
    projectDir,
    options.effectivenessSummaryPath || DEFAULT_EFFECTIVENESS_SUMMARY_RELATIVE_PATH,
    "effectiveness summary",
  );

  requireBinding(sourceBindingFromPaired(paired.document, "paired evaluation"), evaluationSource, "paired evaluation");
  requireBinding(sourceBindingFromPaired(smoke.document, "paired smoke"), evaluationSource, "paired smoke");
  requireBinding(sourceBindingFromEffectiveness(effectiveness.document, "effectiveness summary"), evaluationSource, "effectiveness summary");
  const inherited = isRecord(document.inheritedEvaluationEvidence) ? document.inheritedEvaluationEvidence : {};
  declaredEvidenceRecord(inherited.pairedEvaluation, paired, evaluationSource, "pairedEvaluation");
  declaredEvidenceRecord(inherited.pairedSmoke, smoke, evaluationSource, "pairedSmoke");
  declaredEvidenceRecord(inherited.effectivenessSummary, effectiveness, evaluationSource, "effectivenessSummary");

  return {
    artifactPath: impact.path,
    artifactSha256: impact.sha256,
    generatedAt,
    currentSource,
    evaluationSource,
    changedPaths,
    paired,
    smoke,
    effectiveness,
  };
}

export function buildMacosUiImpactDocument({
  currentSource,
  evaluationSource,
  paired,
  smoke,
  effectiveness,
  completedAt,
  classification = IMPACT_CLASSIFICATION_MACOS_UI,
}) {
  if (!IMPACT_CLASSIFICATIONS.includes(classification)) {
    throw new Error(`unsupported impact classification: ${classification}`);
  }
  const generatedAt = new Date().toISOString();
  const source = currentSourceBindingForManifest(currentSource);
  const evaluation = currentSourceBindingForManifest(evaluationSource);
  const changedPaths = sourceDiff(evaluation, source).map(impactEntry);
  const completed = canonicalTimestamp(completedAt || generatedAt, "completedAt");
  const sourceManifest = {
    path: source.path,
    sha256: source.sha256,
    generatedAt: source.generatedAt,
    sourceTreeSha256: source.sourceTreeSha256,
  };
  const presentation = classification === IMPACT_CLASSIFICATION_RELEASE_PRESENTATION;
  const hasMacosUiProduct = changedPaths.some(entry => entry.classification === "macos-ui-product");
  const impactAssessment = presentation
    ? {
      macosUiAffected: hasMacosUiProduct,
      installedAppAffected: hasMacosUiProduct,
      ...RELEASE_PRESENTATION_IMPACT_FLAGS,
    }
    : { ...REQUIRED_IMPACT_FLAGS };
  const swiftVerification = {
    swiftBuild: {
      command: "swift build --package-path macos-app",
      status: "passed",
      completedAt: completed,
      sourceManifest,
    },
    appSelfTest: {
      command: "swift run --package-path macos-app CanvastApp --self-test",
      status: "passed",
      completedAt: completed,
      sourceManifest,
    },
  };
  const focusedVerification = presentation
    ? {
      evidenceProjection: {
        command: "node scripts/generate-effectiveness-evidence.mjs verify --readme README.md",
        status: "passed",
        completedAt: completed,
        sourceManifest,
      },
      ...(hasMacosUiProduct ? swiftVerification : {}),
    }
    : swiftVerification;
  return {
    schemaVersion: 1,
    kind: "canvast-macos-ui-impact",
    status: "passed",
    classification,
    generatedAt,
    currentSourceManifest: sourceManifest,
    evaluationSourceManifest: {
      path: evaluation.path,
      sha256: evaluation.sha256,
      generatedAt: evaluation.generatedAt,
      sourceTreeSha256: evaluation.sourceTreeSha256,
      document: evaluation.document,
    },
    impactAssessment,
    changedPaths,
    focusedVerification,
    inheritedEvaluationEvidence: {
      pairedEvaluation: {
        path: paired.path,
        sha256: paired.sha256,
        generatedAt: paired.generatedAt,
        sourceManifestSha256: evaluation.sha256,
        sourceTreeSha256: evaluation.sourceTreeSha256,
      },
      pairedSmoke: {
        path: smoke.path,
        sha256: smoke.sha256,
        generatedAt: smoke.generatedAt,
        sourceManifestSha256: evaluation.sha256,
        sourceTreeSha256: evaluation.sourceTreeSha256,
      },
      effectivenessSummary: {
        path: effectiveness.path,
        sha256: effectiveness.sha256,
        generatedAt: effectiveness.generatedAt,
        sourceManifestSha256: evaluation.sha256,
        sourceTreeSha256: evaluation.sourceTreeSha256,
      },
    },
  };
}

function parseArgs(argv) {
  const options = { command: argv[0] || "verify", classification: IMPACT_CLASSIFICATION_MACOS_UI };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--evaluation-source-manifest") {
      options.evaluationSourceManifest = argv[index + 1];
      index += 1;
    } else if (argument === "--completed-at") {
      options.completedAt = argv[index + 1];
      index += 1;
    } else if (argument === "--classification") {
      options.classification = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (options.command !== "write" && options.command !== "verify") {
    throw new Error("usage: node scripts/release-impact-evidence.mjs <write|verify> [--evaluation-source-manifest PATH] [--completed-at ISO] [--classification CLASS]");
  }
  if (!IMPACT_CLASSIFICATIONS.includes(options.classification)) {
    throw new Error(`unsupported impact classification: ${options.classification}`);
  }
  if (options.command === "write" && !options.evaluationSourceManifest) {
    throw new Error("write requires --evaluation-source-manifest");
  }
  return options;
}

function main() {
  const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "verify") {
    const result = validateMacosUiImpactEvidence(projectDir);
    console.log(
      `macOS UI impact verified: current=${result.currentSource.sha256} evaluation=${result.evaluationSource.sha256} changes=${result.changedPaths.length}`,
    );
    return;
  }

  const currentSource = manifestBindingFromFile(projectDir);
  const evaluationSourceFile = path.isAbsolute(options.evaluationSourceManifest)
    ? options.evaluationSourceManifest
    : path.resolve(projectDir, options.evaluationSourceManifest);
  const evaluationRaw = fs.readFileSync(evaluationSourceFile);
  const evaluationDocument = JSON.parse(evaluationRaw.toString("utf8"));
  const evaluationValidated = validateSourceManifestDocument(evaluationDocument);
  const evaluationSource = {
    path: DEFAULT_SOURCE_MANIFEST_RELATIVE_PATH,
    sha256: sha256(evaluationRaw),
    generatedAt: evaluationValidated.generatedAt,
    sourceTreeSha256: evaluationValidated.sourceTreeSha256,
    document: evaluationDocument,
  };
  const paired = evidenceRecord(projectDir, DEFAULT_PAIRED_EVALUATION_RELATIVE_PATH, "paired evaluation");
  const smoke = evidenceRecord(projectDir, DEFAULT_PAIRED_SMOKE_RELATIVE_PATH, "paired smoke");
  const effectiveness = evidenceRecord(projectDir, DEFAULT_EFFECTIVENESS_SUMMARY_RELATIVE_PATH, "effectiveness summary");
  const document = buildMacosUiImpactDocument({
    currentSource,
    evaluationSource,
    paired,
    smoke,
    effectiveness,
    completedAt: options.completedAt,
    classification: options.classification,
  });
  const out = resolveInside(projectDir, MACOS_UI_IMPACT_RELATIVE_PATH, "macOS UI impact output");
  fs.mkdirSync(path.dirname(out.absolute), { recursive: true });
  fs.writeFileSync(out.absolute, canonicalJson(document));
  validateMacosUiImpactEvidence(projectDir);
  console.log(`macOS UI impact written: ${MACOS_UI_IMPACT_RELATIVE_PATH}`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    console.error(`macOS UI impact evidence failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
