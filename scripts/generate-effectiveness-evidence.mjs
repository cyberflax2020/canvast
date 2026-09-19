#!/usr/bin/env node
/**
 * =============================================================================
 * Canvast — Generate Effectiveness Evidence / Canvast 源文件
 * =============================================================================
 * @file        scripts/generate-effectiveness-evidence.mjs
 * @brief       Generate deterministic bilingual evidence from a formal paired evaluation.
 * @description 从通过严格门禁的正式配对评估产物生成确定性的双语有效性证据。
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  assertBoundPath,
  assertSmokeBindings,
  buildEffectivenessSummary,
  comparisonOutcomeFromAggregate,
  COMPARATIVE_OUTCOME_THRESHOLDS,
  includedInEnhancedClaim,
  inferProjectRoot,
  publicationComparisonOutcomeFromAggregate,
  rationaleForEnhancedDimension,
  readJsonArtifact,
  REAL_FORMAL_TASK_IDS,
  relativeOutputPath,
  serializeSummary,
  validateEmbeddedSourcePolicy,
  validatePairedEvaluationRuns,
  validateSmokeArtifact,
  validateSourceManifest,
  verdictForEnhancedDimension,
  verifyExactFile,
} from "./effectiveness-summary.mjs";
import {
  renderEffectivenessDocument,
  renderProjectedReadme,
} from "./effectiveness-render.mjs";
import { validateMacosUiImpactEvidence } from "./release-impact-evidence.mjs";
import {
  deriveModelComparability,
  recomputeEnhancedCapabilityTrack,
} from "../eval-matrix/paired-evidence-contract.mjs";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const relativeDefaults = {
  artifact: "eval-matrix/artifacts/paired-evaluation-latest.json",
  sourceManifest: "release/source-manifest.json",
  smokeArtifact: "eval-matrix/artifacts/paired-smoke-latest.json",
  out: "docs/EFFECTIVENESS_EVIDENCE.md",
  summary: "release/artifacts/effectiveness-summary.json",
};
const defaults = {
  artifact: path.join(projectDir, relativeDefaults.artifact),
  sourceManifest: path.join(projectDir, relativeDefaults.sourceManifest),
  smokeArtifact: path.join(projectDir, relativeDefaults.smokeArtifact),
  out: path.join(projectDir, relativeDefaults.out),
  summary: path.join(projectDir, relativeDefaults.summary),
};
const sides = ["claude", "canvast"];
const expectedOrders = [
  ["claude", "canvast"],
  ["canvast", "claude"],
  ["canvast", "claude"],
  ["claude", "canvast"],
];

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = { ...defaults, command: "write", embeddedSourceSnapshot: false, readme: undefined };
  const provided = new Set();
  let start = 0;
  if (argv[0] && !argv[0].startsWith("-")) {
    if (argv[0] !== "write" && argv[0] !== "verify") fail(`unknown command: ${argv[0]}`);
    options.command = argv[0];
    start = 1;
  }
  const seen = new Set();
  for (let index = start; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--help" || option === "-h") {
      console.log(
        "Usage: node scripts/generate-effectiveness-evidence.mjs [write|verify] " +
        "[--artifact FILE] [--source-manifest FILE] [--smoke-artifact FILE] " +
        "[--out FILE] [--summary FILE] [--readme FILE] [--embedded-source-snapshot]",
      );
      return undefined;
    }
    if (option === "--embedded-source-snapshot") {
      if (seen.has(option)) fail(`duplicate option: ${option}`);
      seen.add(option);
      options.embeddedSourceSnapshot = true;
      continue;
    }
    const fields = {
      "--artifact": "artifact",
      "--source-manifest": "sourceManifest",
      "--smoke-artifact": "smokeArtifact",
      "--out": "out",
      "--summary": "summary",
      "--readme": "readme",
    };
    if (!Object.hasOwn(fields, option)) fail(`unknown option: ${option}`);
    if (seen.has(option)) fail(`duplicate option: ${option}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${option} requires a value`);
    seen.add(option);
    const field = fields[option];
    options[field] = path.resolve(value);
    provided.add(field);
    index += 1;
  }
  if (provided.has("artifact") && path.resolve(options.artifact) !== path.resolve(defaults.artifact)) {
    let fixtureRoot;
    try {
      fixtureRoot = inferProjectRoot(options.artifact, relativeDefaults.artifact, "--artifact");
    } catch {
      fail(
        "a custom --artifact must use the declared eval-matrix path; " +
        "otherwise pass --source-manifest, --smoke-artifact, and --summary explicitly",
      );
    }
    for (const field of ["sourceManifest", "smokeArtifact", "summary"]) {
      if (!provided.has(field)) options[field] = path.join(fixtureRoot, relativeDefaults[field]);
    }
    if (!provided.has("out")) options.out = path.join(fixtureRoot, relativeDefaults.out);
  }
  if (options.embeddedSourceSnapshot && options.command !== "verify") {
    fail("--embedded-source-snapshot is only valid with verify");
  }
  return options;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${field} must be a finite number`);
  return value;
}

function nonNegativeNumber(value, field) {
  const number = finiteNumber(value, field);
  if (number < 0) fail(`${field} must be non-negative`);
  return number;
}

function integer(value, field) {
  const number = finiteNumber(value, field);
  if (!Number.isInteger(number)) fail(`${field} must be an integer`);
  return number;
}

function stringValue(value, field) {
  if (typeof value !== "string" || !value.trim()) fail(`${field} must be a non-empty string`);
  return value;
}

function sha256Value(value, field) {
  const text = stringValue(value, field);
  if (text.length !== 64 || Array.from(text).some(char => !"0123456789abcdef".includes(char))) {
    fail(`${field} must be a lowercase SHA-256 digest`);
  }
  return text;
}

function timestamp(value, field) {
  const text = stringValue(value, field);
  if (!Number.isFinite(Date.parse(text))) fail(`${field} must be a valid timestamp`);
  return text;
}

function relativePath(value, field) {
  const text = stringValue(value, field);
  const normalized = text.split("\\").join("/");
  const first = normalized.charCodeAt(0);
  const driveLetter = first >= 65 && first <= 90 || first >= 97 && first <= 122;
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized === ".." ||
    (normalized.length >= 3 && driveLetter && normalized[1] === ":" && normalized[2] === "/")
  ) {
    fail(`${field} must be a relative path`);
  }
  return normalized;
}

function isSensitiveField(name) {
  const normalized = name.toLowerCase().split("_").join("").split("-").join("");
  return [
    "apikey",
    "authtoken",
    "accesstoken",
    "credentialvalue",
    "password",
    "secretvalue",
    "workspacepath",
    "evidencedir",
    "testevidencedir",
    "loadedfiles",
  ].some(marker => normalized.includes(marker));
}

function hasWindowsAbsolutePath(value) {
  for (let index = 0; index + 2 < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const letter = code >= 65 && code <= 90 || code >= 97 && code <= 122;
    const boundary = index === 0 || [" ", "\t", "\n", "\r", "\"", "'", "("].includes(value[index - 1]);
    if (letter && boundary && value[index + 1] === ":" && ["/", "\\"].includes(value[index + 2])) return true;
  }
  return false;
}

function hasTokenPrefix(value, prefix, minimumSuffix) {
  for (let index = 0; index <= value.length - prefix.length; index += 1) {
    if (value.slice(index, index + prefix.length).toLowerCase() !== prefix.toLowerCase()) continue;
    const previous = value[index - 1];
    if (previous) {
      const code = previous.charCodeAt(0);
      const asciiLetter = code >= 65 && code <= 90 || code >= 97 && code <= 122;
      const asciiDigit = code >= 48 && code <= 57;
      if (asciiLetter || asciiDigit || previous === "_") continue;
    }
    let end = index + prefix.length;
    while (value[end] && ![" ", "\t", "\n", "\r", "\"", "'", ",", ";", ")", "]", "}"].includes(value[end])) end += 1;
    if (end - index - prefix.length >= minimumSuffix) return true;
  }
  return false;
}

function containsCredential(value) {
  const lower = value.toLowerCase();
  if (lower.includes("authorization: bearer ") || lower.includes("authorization=bearer ")) return true;
  return [
    ["sk-", 6],
    ["ghp_", 12],
    ["gho_", 12],
    ["ghu_", 12],
    ["ghs_", 12],
    ["ghr_", 12],
    ["akia", 8],
  ].some(([prefix, minimum]) => hasTokenPrefix(value, prefix, minimum));
}

function assertPublicSafe(value) {
  const visit = current => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (isRecord(current)) {
      for (const [key, child] of Object.entries(current)) {
        if (isSensitiveField(key)) fail("artifact contains unsafe private or credential data");
        visit(child);
      }
      return;
    }
    if (typeof current !== "string") return;
    const normalized = current.split("\\").join("/");
    if (
      normalized.startsWith("/") ||
      normalized.includes("/Users/") ||
      normalized.includes("/home/") ||
      hasWindowsAbsolutePath(current) ||
      containsCredential(current)
    ) {
      fail("artifact contains unsafe private or credential data");
    }
  };
  visit(value);
}

function readArtifact(file) {
  if (!fs.existsSync(file)) fail("paired evaluation artifact is missing");
  const raw = fs.readFileSync(file);
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    fail("paired evaluation artifact is not valid JSON");
  }
  assertPublicSafe(parsed);
  return {
    document: parsed,
    sha256: createHash("sha256").update(raw).digest("hex"),
  };
}

function assertPassedGate(gate, field) {
  if (!isRecord(gate) || gate.passed !== true) fail(`${field} must be passed`);
  const expected = integer(gate.expectedRuns, `${field}.expectedRuns`);
  const observed = integer(gate.observedRuns, `${field}.observedRuns`);
  const passed = integer(gate.passedRuns, `${field}.passedRuns`);
  if (expected <= 0 || expected !== observed || observed !== passed) fail(`${field} must contain a complete passing run matrix`);
  if (!Array.isArray(gate.failures) || gate.failures.length !== 0) fail(`${field}.failures must be empty`);
  return {
    passed: true,
    expectedRuns: expected,
    observedRuns: observed,
    passedRuns: passed,
    failures: [],
  };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function roundedRatio(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null;
}

function combination(n, k) {
  let result = 1;
  const count = Math.min(k, n - k);
  for (let index = 1; index <= count; index += 1) result = result * (n - count + index) / index;
  return result;
}

function exactTwoSidedPValue(canvastWins, referenceWins) {
  const discordant = canvastWins + referenceWins;
  if (discordant === 0) return null;
  let probability = 0;
  for (let index = 0; index <= Math.min(canvastWins, referenceWins); index += 1) {
    probability += combination(discordant, index) * (0.5 ** discordant);
  }
  return Number(Math.min(1, probability * 2).toFixed(6));
}

function sameNumber(actual, expected, field) {
  if (actual !== expected) fail(`${field} does not match the complete run matrix`);
}

function validateProvenance(artifact) {
  if (!isRecord(artifact.provenance) || artifact.provenance.verified !== true) fail("provenance.verified must be true");
  if (!Array.isArray(artifact.provenance.errors) || artifact.provenance.errors.length !== 0) {
    fail("provenance.errors must be empty");
  }
  const manifestPath = relativePath(artifact.provenance.sourceManifestPath, "provenance.sourceManifestPath");
  const manifestSha = sha256Value(artifact.provenance.sourceManifestSha256, "provenance.sourceManifestSha256");
  const manifestGeneratedAt = timestamp(
    artifact.provenance.sourceManifestGeneratedAt,
    "provenance.sourceManifestGeneratedAt",
  );
  const generatedAt = timestamp(artifact.generatedAt, "generatedAt");
  timestamp(artifact.provenance.checkedAt, "provenance.checkedAt");
  if (Date.parse(generatedAt) < Date.parse(manifestGeneratedAt)) fail("artifact predates its source manifest");

  const releaseManifest = artifact.source?.releaseManifest;
  if (!isRecord(releaseManifest) || releaseManifest.verified !== true) fail("source.releaseManifest must be verified");
  if (
    relativePath(releaseManifest.path, "source.releaseManifest.path") !== manifestPath ||
    sha256Value(releaseManifest.sha256, "source.releaseManifest.sha256") !== manifestSha
  ) {
    fail("source release-manifest binding does not match provenance");
  }
  const releaseManifestGeneratedAt = timestamp(
    releaseManifest.generatedAt,
    "source.releaseManifest.generatedAt",
  );
  const sourceTreeSha256 = sha256Value(
    releaseManifest.declaredTreeSha256,
    "source.releaseManifest.declaredTreeSha256",
  );
  if (releaseManifestGeneratedAt !== manifestGeneratedAt) {
    fail("source release-manifest timestamp does not match provenance");
  }
  return { manifestPath, manifestSha, manifestGeneratedAt, sourceTreeSha256, generatedAt };
}

function validateFormalPrerequisite(artifact, manifestSha) {
  const prerequisite = artifact.formalPrerequisite;
  if (!isRecord(prerequisite) || prerequisite.verified !== true) fail("formalPrerequisite.verified must be true");
  relativePath(prerequisite.artifactPath, "formalPrerequisite.artifactPath");
  sha256Value(prerequisite.artifactSha256, "formalPrerequisite.artifactSha256");
  const prerequisiteGeneratedAt = timestamp(prerequisite.generatedAt, "formalPrerequisite.generatedAt");
  if (Date.parse(artifact.generatedAt) < Date.parse(prerequisiteGeneratedAt)) {
    fail("formal paired artifact predates its smoke prerequisite");
  }
  const manifestGeneratedAt = timestamp(
    artifact.provenance.sourceManifestGeneratedAt,
    "provenance.sourceManifestGeneratedAt",
  );
  if (Date.parse(prerequisiteGeneratedAt) < Date.parse(manifestGeneratedAt)) {
    fail("formal prerequisite predates the evaluation source manifest");
  }
  if (sha256Value(prerequisite.sourceManifestSha256, "formalPrerequisite.sourceManifestSha256") !== manifestSha) {
    fail("formal prerequisite is not bound to the evaluation source manifest");
  }
  const prerequisiteGate = assertPassedGate(prerequisite.gate, "formalPrerequisite.gate");
  const smokeGate = assertPassedGate(artifact.smokeGate, "smokeGate");
  if (JSON.stringify(prerequisiteGate) !== JSON.stringify(smokeGate)) {
    fail("formal prerequisite and smoke gates disagree");
  }
  return {
    artifactPath: prerequisite.artifactPath,
    artifactSha256: prerequisite.artifactSha256,
    generatedAt: prerequisiteGeneratedAt,
    gate: prerequisiteGate,
  };
}

function validateProtocol(artifact) {
  if (!isRecord(artifact.protocol) || artifact.protocol.repeats !== 4) {
    fail("formal paired evaluation must use exactly 4 repeats");
  }
  if (artifact.protocol.isolatedWorkspacePerSideRepeat !== true || artifact.protocol.allInitialCopiesMatch !== true) {
    fail("formal paired evaluation must use matching isolated workspaces");
  }
  if (!Array.isArray(artifact.protocol.orderByRepeat) || artifact.protocol.orderByRepeat.length !== 4) {
    fail("protocol order matrix must contain 4 repeats");
  }
  for (let index = 0; index < expectedOrders.length; index += 1) {
    const entry = artifact.protocol.orderByRepeat[index];
    if (!isRecord(entry) || entry.repeat !== index + 1 || JSON.stringify(entry.order) !== JSON.stringify(expectedOrders[index])) {
      fail("protocol order matrix must be AB/BA/BA/AB");
    }
  }
}

function validateFormalTasks(artifact) {
  if (!Array.isArray(artifact.tasks)) fail("artifact must contain tasks[]");
  const taskIds = artifact.tasks.map((task, index) => {
    if (!isRecord(task)) fail(`tasks[${index}] must be an object`);
    if (task.fixtureKind !== "real_repository_snapshot") {
      fail("formal paired evaluation tasks must use real_repository_snapshot");
    }
    return stringValue(task.id, `tasks[${index}].id`);
  });
  if (JSON.stringify(taskIds) !== JSON.stringify(REAL_FORMAL_TASK_IDS)) {
    fail("formal paired evaluation must contain exactly the canonical formal task ids");
  }
  return taskIds;
}

function validateTaskPreparations(artifact, taskIds) {
  if (!Array.isArray(artifact.taskPreparations) || artifact.taskPreparations.length !== taskIds.length) {
    fail("taskPreparations must cover every canonical formal task exactly once");
  }
  const seen = new Set();
  for (const [index, preparation] of artifact.taskPreparations.entries()) {
    if (!isRecord(preparation)) fail(`taskPreparations[${index}] must be an object`);
    const taskId = stringValue(preparation.taskId, `taskPreparations[${index}].taskId`);
    if (!taskIds.includes(taskId) || seen.has(taskId)) {
      fail("taskPreparations must match the canonical formal task ids without duplication");
    }
    seen.add(taskId);
    const gate = preparation.largeRepoGate;
    if (!isRecord(gate) || gate.passed !== true) fail("taskPreparations[].largeRepoGate.passed must be true");
    if (!isRecord(gate.thresholds) || !isRecord(gate.observed)) {
      fail("taskPreparations[].largeRepoGate must include thresholds and observed metrics");
    }
    integer(gate.thresholds.minFiles, "taskPreparations[].largeRepoGate.thresholds.minFiles");
    integer(gate.thresholds.minSourceLines, "taskPreparations[].largeRepoGate.thresholds.minSourceLines");
    integer(gate.thresholds.minTestFiles, "taskPreparations[].largeRepoGate.thresholds.minTestFiles");
    integer(gate.observed.files, "taskPreparations[].largeRepoGate.observed.files");
    integer(gate.observed.sourceLines, "taskPreparations[].largeRepoGate.observed.sourceLines");
    integer(gate.observed.testFiles, "taskPreparations[].largeRepoGate.observed.testFiles");
    stringValue(gate.reason, "taskPreparations[].largeRepoGate.reason");
  }
}

function pairedMetrics(artifact, taskIds, validatedRuns) {
  const allowedTasks = new Set(taskIds);
  const runs = validatedRuns.filter(run => run.includedInModelQualityAggregate === true);
  const expectedPairCount = taskIds.length * 4;
  if (runs.length !== expectedPairCount * 2) fail("model-quality run count does not contain complete pairs");

  const pairs = new Map();
  for (const run of runs) {
    const caseId = stringValue(run.caseId, "runs[].caseId");
    if (!allowedTasks.has(caseId)) fail("model-quality run references an unknown task");
    const repeat = integer(run.repeat, "runs[].repeat");
    if (repeat < 1 || repeat > 4 || !sides.includes(run.side)) fail("model-quality run has an invalid repeat or side");
    if (run.orderPosition !== expectedOrders[repeat - 1].indexOf(run.side) + 1) {
      fail("model-quality run violates crossover order");
    }
    if (run.infrastructureBlocked !== false) fail("model-quality run is infrastructure-blocked");
    nonNegativeNumber(run.durationMs, "runs[].durationMs");
    if (!isRecord(run.cacheTrust) || typeof run.cacheTrust.trusted !== "boolean") {
      fail("runs[].cacheTrust must be present");
    }
    const key = `${caseId}:${repeat}`;
    const pair = pairs.get(key) || {};
    if (pair[run.side]) fail("model-quality run matrix contains a duplicate side");
    pair[run.side] = run;
    pairs.set(key, pair);
  }
  for (const taskId of taskIds) {
    for (let repeat = 1; repeat <= 4; repeat += 1) {
      const pair = pairs.get(`${taskId}:${repeat}`);
      if (!pair?.claude || !pair?.canvast) fail("model-quality run matrix contains an incomplete pair");
    }
  }

  const completePairs = [...pairs.values()];
  let bothPassed = 0;
  let bothFailed = 0;
  let canvastOnlyPassed = 0;
  let referenceOnlyPassed = 0;
  for (const pair of completePairs) {
    if (pair.canvast.passed && pair.claude.passed) bothPassed += 1;
    else if (!pair.canvast.passed && !pair.claude.passed) bothFailed += 1;
    else if (pair.canvast.passed) canvastOnlyPassed += 1;
    else referenceOnlyPassed += 1;
  }
  const pairCount = completePairs.length;
  if (completePairs.some(pair => pair.canvast.passed !== true)) {
    fail("passed formal artifact must have every Canvast model-quality run passing");
  }
  const canvastPasses = bothPassed + canvastOnlyPassed;
  const referencePasses = bothPassed + referenceOnlyPassed;
  const canvastPassRate = Number((canvastPasses / pairCount).toFixed(4));
  const referencePassRate = Number((referencePasses / pairCount).toFixed(4));
  const canvastMedianDurationMs = median(completePairs.map(pair => pair.canvast.durationMs));
  const referenceMedianDurationMs = median(completePairs.map(pair => pair.claude.durationMs));
  return {
    runs,
    pairCount,
    canvastPasses,
    referencePasses,
    bothPassed,
    bothFailed,
    canvastOnlyPassed,
    referenceOnlyPassed,
    canvastPassRate,
    referencePassRate,
    passRateDelta: Number((canvastPassRate - referencePassRate).toFixed(4)),
    canvastMedianDurationMs,
    referenceMedianDurationMs,
    durationRatio: roundedRatio(canvastMedianDurationMs, referenceMedianDurationMs),
    discordantPairs: canvastOnlyPassed + referenceOnlyPassed,
    pValue: exactTwoSidedPValue(canvastOnlyPassed, referenceOnlyPassed),
  };
}

function validateAggregate(artifact, metrics) {
  const aggregate = artifact.aggregates?.modelQuality;
  if (!isRecord(aggregate)) fail("aggregates.modelQuality must be present");
  const expected = {
    plannedPairs: metrics.pairCount,
    completedPairs: metrics.pairCount,
    excludedInfrastructurePairs: 0,
    bothPassed: metrics.bothPassed,
    bothFailed: metrics.bothFailed,
    canvastOnlyPassed: metrics.canvastOnlyPassed,
    claudeOnlyPassed: metrics.referenceOnlyPassed,
    canvastPassRate: metrics.canvastPassRate,
    claudePassRate: metrics.referencePassRate,
    passRateDelta: metrics.passRateDelta,
    canvastMedianDurationMs: metrics.canvastMedianDurationMs,
    claudeMedianDurationMs: metrics.referenceMedianDurationMs,
    durationRatio: metrics.durationRatio,
    discordantPairs: metrics.discordantPairs,
    pairedExactTwoSidedPValue: metrics.pValue,
  };
  for (const [field, value] of Object.entries(expected)) sameNumber(aggregate[field], value, `aggregates.modelQuality.${field}`);

  const passedRuns = metrics.runs.filter(run => run.passed).length;
  const summary = artifact.runSummary;
  if (
    !isRecord(summary) ||
    summary.totalRuns !== metrics.runs.length ||
    summary.passedRuns !== passedRuns ||
    summary.failedRuns !== metrics.runs.length - passedRuns ||
    summary.timedOutRuns !== 0
  ) {
    fail("runSummary does not match the complete model-quality run matrix");
  }
  return aggregate;
}

function validateModelComparability(artifact, runs) {
  const recomputed = deriveModelComparability(runs);
  if (!recomputed.valid) fail(`modelComparability cannot be derived: ${recomputed.failures.join("; ")}`);
  if (!isRecord(artifact.modelComparability)) fail("modelComparability must be present");
  for (const field of ["configuredSameProviderModel", "strictSameModelVerified", "status"]) {
    if (artifact.modelComparability[field] !== recomputed[field]) {
      fail(`modelComparability.${field} does not match recomputed run evidence`);
    }
  }
  const configuredModels = new Set();
  const configuredProviders = new Set();
  for (const run of Array.isArray(runs) ? runs : []) {
    const model = isRecord(run) && isRecord(run.model) ? run.model : {};
    if (typeof model.configuredUpstreamModel === "string" && model.configuredUpstreamModel) {
      configuredModels.add(model.configuredUpstreamModel);
    }
    if (typeof model.configuredUpstreamProvider === "string" && model.configuredUpstreamProvider) {
      configuredProviders.add(model.configuredUpstreamProvider);
    }
  }
  recomputed.configuredModel = configuredModels.size === 1 ? [...configuredModels][0] : null;
  recomputed.configuredProvider = configuredProviders.size === 1 ? [...configuredProviders][0] : null;
  return recomputed;
}

function validateComparisonOutcome(artifact, aggregate, strictSameModelVerified) {
  const expected = comparisonOutcomeFromAggregate(aggregate, strictSameModelVerified, COMPARATIVE_OUTCOME_THRESHOLDS);
  if (!isRecord(artifact.comparisonOutcome)) fail("comparisonOutcome must be present");
  if (
    artifact.comparisonOutcome.status !== expected.status ||
    artifact.comparisonOutcome.reason !== expected.reason ||
    JSON.stringify(artifact.comparisonOutcome.thresholds) !== JSON.stringify(expected.thresholds)
  ) {
    fail("comparisonOutcome must be recomputable from the validated aggregate and model-identity gate");
  }
  return expected;
}

function comparisonValues(aggregate, metrics) {
  const cache = aggregate.cacheComparison;
  const effective = aggregate.effectiveTokenComparison;
  if (!isRecord(cache) || !isRecord(effective) || typeof cache.allowed !== "boolean" || typeof effective.allowed !== "boolean") {
    fail("cache and effective-token comparison gates must be present");
  }
  const everyRunTrusted = metrics.runs.every(run =>
    run.cacheTrust.trusted === true && run.cacheTrust.telemetryObserved === true);
  const allowed = everyRunTrusted && cache.allowed === true && effective.allowed === true;
  if (!allowed) {
    if (cache.allowed === true || effective.allowed === true || cache.values !== null || effective.values !== null) {
      fail("untrusted cache evidence must not expose cross-side token values");
    }
    return null;
  }
  if (!isRecord(cache.values) || !isRecord(effective.values)) fail("trusted token comparison values are missing");
  const sums = {
    claudeCacheReadTokens: 0,
    canvastCacheReadTokens: 0,
    claudeCacheWriteTokens: 0,
    canvastCacheWriteTokens: 0,
    claudeEffectiveTokens: 0,
    canvastEffectiveTokens: 0,
  };
  for (const run of metrics.runs) {
    if (!isRecord(run.metrics)) fail("trusted runs must contain metrics");
    const prefix = run.side === "claude" ? "claude" : "canvast";
    sums[`${prefix}CacheReadTokens`] += nonNegativeNumber(run.metrics.cacheReadTokens, "runs[].metrics.cacheReadTokens");
    sums[`${prefix}CacheWriteTokens`] += nonNegativeNumber(run.metrics.cacheWriteTokens, "runs[].metrics.cacheWriteTokens");
    sums[`${prefix}EffectiveTokens`] += nonNegativeNumber(run.metrics.effectiveTokens, "runs[].metrics.effectiveTokens");
  }
  for (const field of ["claudeCacheReadTokens", "canvastCacheReadTokens", "claudeCacheWriteTokens", "canvastCacheWriteTokens"]) {
    sameNumber(cache.values[field], sums[field], `cacheComparison.values.${field}`);
  }
  for (const field of ["claudeEffectiveTokens", "canvastEffectiveTokens"]) {
    sameNumber(effective.values[field], sums[field], `effectiveTokenComparison.values.${field}`);
  }
  const ratio = roundedRatio(sums.canvastEffectiveTokens, sums.claudeEffectiveTokens);
  sameNumber(effective.values.ratio, ratio, "effectiveTokenComparison.values.ratio");
  return { ...sums, ratio };
}

function validateEnhancedCapabilityTrack(artifact) {
  const track = artifact.enhancedCapabilityTrack;
  if (
    !isRecord(track) ||
    track.status !== "paired_capability_comparison" ||
    !isRecord(track.summary) ||
    !Array.isArray(track.dimensions) ||
    track.dimensions.length === 0
  ) {
    fail("enhancedCapabilityTrack has an invalid boundary");
  }
  const recomputed = recomputeEnhancedCapabilityTrack(track, artifact.protocol?.repeats);
  if (recomputed.failures.length > 0) fail(recomputed.failures.join("; "));
  const dimensions = recomputed.dimensions.map((derived, index) => {
    const dimension = track.dimensions[index];
    const canvast = dimension.canvast;
    const reference = dimension.reference;
    const canvastSummary = stringValue(canvast.summary, `enhancedCapabilityTrack.dimensions[${index}].canvast.summary`);
    const referenceSummary = stringValue(reference.summary, `enhancedCapabilityTrack.dimensions[${index}].reference.summary`);
    const expectedRationale = rationaleForEnhancedDimension(canvastSummary, referenceSummary);
    if (dimension.rationale !== expectedRationale) fail("enhancedCapabilityTrack rationale must be recomputable from bilateral observations");
    if (canvast.observableTaskId !== undefined && canvast.observableTaskId !== derived.id) {
      fail("enhancedCapabilityTrack canvast observableTaskId must match the dimension id");
    }
    if (reference.observableTaskId !== undefined && reference.observableTaskId !== derived.id) {
      fail("enhancedCapabilityTrack reference observableTaskId must match the dimension id");
    }
    return {
      id: derived.id,
      title: derived.title,
      verdict: derived.verdict,
      includedInClaim: derived.includedInClaim,
      rationale: expectedRationale,
      canvast: { status: derived.canvastStatus },
      reference: { status: derived.referenceStatus },
    };
  });
  return {
    reason: stringValue(track.reason, "enhancedCapabilityTrack.reason"),
    summary: recomputed.summary,
    dimensions,
  };
}

function validateArtifact(artifact) {
  if (!isRecord(artifact) || artifact.schemaVersion !== 1 || artifact.kind !== "canvast-paired-evaluation") {
    fail("artifact must be a schemaVersion 1 formal paired evaluation");
  }
  if (artifact.status !== "passed") fail("artifact status must be passed");
  const artifactPath = relativePath(artifact.artifactPath, "artifactPath");
  const provenance = validateProvenance(artifact);
  const formalPrerequisite = validateFormalPrerequisite(artifact, provenance.manifestSha);
  validateProtocol(artifact);
  const taskIds = validateFormalTasks(artifact);
  validateTaskPreparations(artifact, taskIds);
  if (artifact.resourceSafety?.allProcessGroupsCleaned !== true) {
    fail("resourceSafety.allProcessGroupsCleaned must be true");
  }
  const validatedRuns = validatePairedEvaluationRuns(artifact);
  const metrics = pairedMetrics(artifact, taskIds, validatedRuns);
  const aggregate = validateAggregate(artifact, metrics);
  const modelComparability = validateModelComparability(artifact, metrics.runs);
  validateComparisonOutcome(artifact, aggregate, modelComparability.strictSameModelVerified);
  const referenceToolchain = validateReferenceToolchain(artifact);
  return {
    artifactPath,
    provenance,
    formalPrerequisite,
    smokeGate: formalPrerequisite.gate,
    metrics,
    tokens: comparisonValues(aggregate, metrics),
    enhanced: validateEnhancedCapabilityTrack(artifact),
    modelComparability,
    referenceToolchain,
    comparisonOutcome: publicationComparisonOutcomeFromAggregate(
      aggregate,
      modelComparability.strictSameModelVerified,
    ),
  };
}

function validateReferenceToolchain(artifact) {
  if (!isRecord(artifact.toolchains) || !isRecord(artifact.toolchains.claudeCode)) {
    return null;
  }
  const claudeCode = artifact.toolchains.claudeCode;
  return {
    version: stringValue(claudeCode.version, "toolchains.claudeCode.version"),
    mode: stringValue(claudeCode.mode, "toolchains.claudeCode.mode"),
  };
}

const MODEL_BACKEND_ATTESTATION_RELATIVE_PATH = "release/artifacts/model-backend-attestation.json";

function readModelBackendAttestation(root, result) {
  const file = path.resolve(root, MODEL_BACKEND_ATTESTATION_RELATIVE_PATH);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file);
  const sha256 = createHash("sha256").update(raw).digest("hex");
  let document;
  try {
    document = JSON.parse(raw.toString("utf8"));
  } catch {
    fail("model backend attestation is not valid JSON");
  }
  if (!isRecord(document)
    || document.schemaVersion !== 1
    || document.kind !== "canvast-model-backend-attestation") {
    fail("model backend attestation schema or kind is invalid");
  }
  timestamp(document.attestedAt, "attestation.attestedAt");
  stringValue(document.attestedBy, "attestation.attestedBy");
  stringValue(document.statement, "attestation.statement");
  stringValue(document.statementZh, "attestation.statementZh");
  stringValue(document.scope, "attestation.scope");
  stringValue(document.scopeZh, "attestation.scopeZh");
  if (!isRecord(document.evaluationArtifact)
    || document.evaluationArtifact.path !== result.artifactPath
    || document.evaluationArtifact.sha256 !== result.artifactSha256) {
    fail("model backend attestation is not bound to the selected paired evaluation artifact");
  }
  assertPublicSafe(document);
  return {
    path: MODEL_BACKEND_ATTESTATION_RELATIVE_PATH,
    sha256,
    document,
  };
}

function writeAtomically(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporary, content, { flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function sameExistingFile(left, right) {
  if (!fs.existsSync(left) || !fs.existsSync(right)) return path.resolve(left) === path.resolve(right);
  return fs.realpathSync(left) === fs.realpathSync(right);
}

function verifyDefaultSourceManifest(sourceManifestFile) {
  if (!sameExistingFile(sourceManifestFile, defaults.sourceManifest)) return;
  const result = spawnSync(
    process.execPath,
    [path.join(projectDir, "scripts", "source-manifest.mjs"), "verify"],
    {
      cwd: projectDir,
      env: { ...process.env, CANVAST_SOURCE_MANIFEST: sourceManifestFile },
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  if (result.error) fail(`source manifest freshness verifier failed: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout]
      .map(value => String(value || "").trim())
      .filter(Boolean)
      .join("\n");
    fail(`source manifest is not current${detail ? `:\n${detail}` : ""}`);
  }
}

function ensureDistinctPaths(options) {
  const entries = [
    ["paired artifact", options.artifact],
    ["source manifest", options.sourceManifest],
    ["smoke artifact", options.smokeArtifact],
    ["Markdown document", options.out],
    ["summary artifact", options.summary],
    ...(options.readme ? [["README projection", options.readme]] : []),
  ];
  const seen = new Map();
  for (const [label, file] of entries) {
    const resolved = path.resolve(file);
    if (seen.has(resolved)) fail(`${label} path conflicts with ${seen.get(resolved)}`);
    seen.set(resolved, label);
  }
}

function prepareEffectivenessEvidence(options) {
  ensureDistinctPaths(options);
  if (!options.embeddedSourceSnapshot) verifyDefaultSourceManifest(options.sourceManifest);
  const artifact = readArtifact(options.artifact);
  const result = {
    ...validateArtifact(artifact.document),
    artifactSha256: artifact.sha256,
  };
  const root = inferProjectRoot(options.artifact, result.artifactPath, "artifactPath");
  assertBoundPath(root, options.sourceManifest, result.provenance.manifestPath, "provenance.sourceManifestPath");
  assertBoundPath(
    root,
    options.smokeArtifact,
    result.formalPrerequisite.artifactPath,
    "formalPrerequisite.artifactPath",
  );
  const sourceArtifact = readJsonArtifact(options.sourceManifest, "source manifest");
  assertPublicSafe(sourceArtifact.document);
  const sourceMetadata = validateSourceManifest(sourceArtifact);
  const source = {
    ...sourceMetadata,
    sha256: sourceArtifact.sha256,
  };
  if (options.embeddedSourceSnapshot) validateEmbeddedSourcePolicy(root, source);
  const smokeArtifact = readJsonArtifact(options.smokeArtifact, "smoke artifact");
  assertPublicSafe(smokeArtifact.document);
  let evaluationSource = source;
  if (result.provenance.manifestSha !== source.sha256
    || result.provenance.sourceTreeSha256 !== source.sourceTreeSha256) {
    if (result.provenance.sourceTreeSha256 === source.sourceTreeSha256) {
      fail("source manifest raw hash does not match the evaluation source manifest");
    }
    const impact = validateMacosUiImpactEvidence(root, {
      currentManifest: {
        path: result.provenance.manifestPath,
        rawSha256: source.sha256,
        generatedAt: source.generatedAt,
        sourceTreeSha256: source.sourceTreeSha256,
        document: sourceArtifact.document,
      },
      pairedEvaluation: {
        path: result.artifactPath,
        sha256: artifact.sha256,
        generatedAt: result.provenance.generatedAt,
        document: artifact.document,
      },
    });
    evaluationSource = {
      path: impact.evaluationSource.path,
      sha256: impact.evaluationSource.sha256,
      generatedAt: impact.evaluationSource.generatedAt,
      sourceTreeSha256: impact.evaluationSource.sourceTreeSha256,
      policyPath: source.policyPath,
      policySha256: source.policySha256,
    };
  }
  const smokeMetadata = validateSmokeArtifact(smokeArtifact, {
    sourceManifestPath: result.provenance.manifestPath,
    sourceManifestSha256: evaluationSource.sha256,
    sourceManifestGeneratedAt: evaluationSource.generatedAt,
  });
  const smoke = {
    ...smokeMetadata,
    sha256: smokeArtifact.sha256,
  };
  assertSmokeBindings(result, smoke, evaluationSource);
  const documentPath = relativeOutputPath(root, options.out, "document path");
  const summaryPath = relativeOutputPath(root, options.summary, "summary path");
  const attestation = readModelBackendAttestation(root, result);
  const summary = buildEffectivenessSummary({
    result,
    artifactSha256: artifact.sha256,
    source: evaluationSource,
    smoke,
    document: "",
    documentPath,
    attestation,
  });
  const document = renderEffectivenessDocument(summary);
  summary.document.sha256 = createHash("sha256").update(document).digest("hex");
  assertPublicSafe(summary);
  assertPublicSafe(document);
  let projectedReadme;
  if (options.readme) {
    if (!fs.existsSync(options.readme)) fail("README is missing");
    projectedReadme = renderProjectedReadme(fs.readFileSync(options.readme, "utf8"), summary);
    assertPublicSafe(projectedReadme);
  }
  return {
    document,
    summary: serializeSummary(summary),
    documentPath,
    summaryPath,
    projectedReadme,
  };
}

export function generateEffectivenessEvidence(
  artifactFile,
  outputFile,
  {
    sourceManifestFile = defaults.sourceManifest,
    smokeArtifactFile = defaults.smokeArtifact,
    summaryFile = defaults.summary,
  } = {},
) {
  const options = {
    artifact: artifactFile,
    sourceManifest: sourceManifestFile,
    smokeArtifact: smokeArtifactFile,
    out: outputFile,
    summary: summaryFile,
  };
  const generated = prepareEffectivenessEvidence(options);
  writeAtomically(outputFile, generated.document);
  writeAtomically(summaryFile, generated.summary);
  if (options.readme && generated.projectedReadme !== undefined) writeAtomically(options.readme, generated.projectedReadme);
  return generated.document;
}

function verifyEffectivenessEvidence(options) {
  const generated = prepareEffectivenessEvidence(options);
  verifyExactFile(options.out, generated.document, "effectiveness Markdown");
  verifyExactFile(options.summary, generated.summary, "effectiveness summary");
  if (options.readme && generated.projectedReadme !== undefined) {
    verifyExactFile(options.readme, generated.projectedReadme, "README projection");
  }
  return generated;
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (!options) return;
    if (options.command === "verify") {
      const generated = verifyEffectivenessEvidence(options);
      console.log(
        `Effectiveness evidence verified: ${generated.documentPath} and ${generated.summaryPath}`,
      );
    } else {
      const generated = prepareEffectivenessEvidence(options);
      writeAtomically(options.out, generated.document);
      writeAtomically(options.summary, generated.summary);
      if (options.readme && generated.projectedReadme !== undefined) writeAtomically(options.readme, generated.projectedReadme);
      console.log(
        `Effectiveness evidence written: ${generated.documentPath} and ${generated.summaryPath}`,
      );
    }
  } catch (error) {
    console.error(`Effectiveness evidence ${process.argv[2] === "verify" ? "verification" : "generation"} failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
