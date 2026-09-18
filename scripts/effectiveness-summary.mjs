/**
 * =============================================================================
 * Canvast — Effectiveness Summary / Canvast 源文件
 * =============================================================================
 * @file        scripts/effectiveness-summary.mjs
 * @brief       Validate bound public evidence and build a deterministic summary.
 * @description 校验绑定的公开证据，并构建确定性的机器可读有效性摘要。
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  executionHealthFromEvidence,
} from "../eval-matrix/paired-evidence-contract.mjs";

const REAL_SMOKE_TASK_IDS = [
  "paired-runtime-paths-001",
  "paired-product-identity-001",
  "paired-live-env-001",
];

export const REAL_FORMAL_TASK_IDS = [
  "paired-runtime-paths-001",
  "paired-product-identity-001",
  "paired-live-env-001",
];

export const COMPARATIVE_OUTCOME_THRESHOLDS = {
  minimumCompletePairs: 4,
  minimumPassRateDelta: 0.1,
  maximumDurationRatio: 1,
  requireStrictSameModelVerified: true,
  requireZeroInfrastructureExclusions: true,
};

export const PUBLICATION_COMPARATIVE_OUTCOME_THRESHOLDS = {
  ...COMPARATIVE_OUTCOME_THRESHOLDS,
  maximumExactTwoSidedPValue: 0.05,
};

function fail(message) {
  throw new Error(message);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function safeInvocationPart(value) {
  return typeof value === "string" && value.length > 0 && [...value].every(character => {
    const code = character.charCodeAt(0);
    return code >= 48 && code <= 57 || code >= 65 && code <= 90 || code >= 97 && code <= 122
      || character === "." || character === "_" || character === "-";
  });
}

function validPairedInvocationId(value) {
  if (typeof value !== "string" || value.length > 256 || !value.startsWith("paired-")) return false;
  const nonce = value.slice(-32);
  const nonceValid = nonce.length === 32 && [...nonce].every(character =>
    character >= "0" && character <= "9" || character >= "a" && character <= "f");
  if (!nonceValid) return false;
  const prefix = value.slice(0, -(nonce.length + 1));
  const orderSeparator = prefix.lastIndexOf("-");
  const repeatSeparator = prefix.lastIndexOf("-", orderSeparator - 1);
  if (repeatSeparator <= "paired-".length || orderSeparator <= repeatSeparator + 1) return false;
  const identity = prefix.slice("paired-".length, repeatSeparator);
  const repeat = prefix.slice(repeatSeparator + 1, orderSeparator);
  const order = prefix.slice(orderSeparator + 1);
  const repeatValid = repeat.length > 0 && repeat[0] !== "0"
    && [...repeat].every(character => character >= "0" && character <= "9");
  return safeInvocationPart(identity) && safeInvocationPart(order) && repeatValid;
}

export function ownedHandleShutdownVerified(record, required) {
  if (!exactKeys(record, ["required", "verified", "invocationId", "evidenceSha256", "failure"])
    || record.required !== required || record.verified !== true || record.failure !== null) return false;
  if (!required) return record.invocationId === null && record.evidenceSha256 === null;
  return validPairedInvocationId(record.invocationId) && isLowercaseSha256(record.evidenceSha256);
}

function stringValue(value, field) {
  if (typeof value !== "string" || !value.trim()) fail(`${field} must be a non-empty string`);
  return value;
}

function integer(value, field) {
  if (typeof value !== "number" || !Number.isInteger(value)) fail(`${field} must be an integer`);
  return value;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
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

function arraysEqual(left, right) {
  return Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function equalGate(left, right) {
  return isRecord(left) &&
    isRecord(right) &&
    left.passed === right.passed &&
    left.expectedRuns === right.expectedRuns &&
    left.observedRuns === right.observedRuns &&
    left.passedRuns === right.passedRuns &&
    JSON.stringify(left.failures) === JSON.stringify(right.failures);
}

function ensureObject(value, label) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  return value;
}

function ensureStringArray(value, label) {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== "string")) {
    fail(`${label} must be an array of strings`);
  }
  if (new Set(value).size !== value.length) fail(`${label} must not contain duplicates`);
  return value;
}

function assertSameArray(actual, expected, label) {
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  if (JSON.stringify(sortedActual) !== JSON.stringify(sortedExpected)) {
    fail(`${label} does not match recomputed evidence`);
  }
}

function assertBooleanEquals(actual, expected, label) {
  if (actual !== expected) fail(`${label} does not match recomputed evidence`);
}

function isLowercaseSha256(value) {
  return typeof value === "string" &&
    value.length === 64 &&
    Array.from(value).every(character =>
      (character >= "0" && character <= "9") || (character >= "a" && character <= "f"));
}

export function validatePairedRun(run, task, index) {
  const label = `runs[${index}]`;
  ensureObject(run, label);
  ensureObject(task, `${label} task`);
  if (!isLowercaseSha256(run.baselineTreeSha256) || !isLowercaseSha256(run.initialWorkspaceTreeSha256)) {
    fail(`${label} baseline hashes must be lowercase SHA-256 digests`);
  }
  if (run.initialWorkspaceTreeSha256 !== run.baselineTreeSha256) {
    fail(`${label} initial workspace does not match its baseline`);
  }
  if (!Number.isInteger(run.exitCode) && run.exitCode !== null) {
    fail(`${label}.exitCode must be an integer or null`);
  }
  if (typeof run.timedOut !== "boolean" || ![null, "outer_runner", "inner_safe_run"].includes(run.timeoutSource)) {
    fail(`${label} timeout evidence is invalid`);
  }
  if (run.timedOut !== (run.timeoutSource !== null)) {
    fail(`${label} timeout evidence is inconsistent`);
  }

  const metrics = ensureObject(run.metrics, `${label}.metrics`);
  if (!Number.isInteger(metrics.unrecoveredModelErrorEvents) || metrics.unrecoveredModelErrorEvents < 0) {
    fail(`${label}.metrics.unrecoveredModelErrorEvents must be a non-negative integer`);
  }
  const executionHealthy = executionHealthFromEvidence(run);
  const ownedHandleVerified = ownedHandleShutdownVerified(
    run.ownedHandleShutdown, run.side === "canvast",
  );
  assertBooleanEquals(run.executionHealthy, executionHealthy, `${label}.executionHealthy`);
  assertBooleanEquals(
    run.infrastructureBlocked, !executionHealthy || !ownedHandleVerified, `${label}.infrastructureBlocked`,
  );
  if (!ownedHandleVerified) fail(`${label}.ownedHandleShutdown is invalid or unverified`);

  const requiredPaths = ensureStringArray(task.requiredArtifactPaths, `${label} task.requiredArtifactPaths`);
  const allowedPaths = ensureStringArray(task.allowedArtifactPaths, `${label} task.allowedArtifactPaths`);
  const protectedPaths = ensureStringArray(task.protectedPaths, `${label} task.protectedPaths`);
  const artifactChanges = ensureObject(run.artifactChanges, `${label}.artifactChanges`);
  const changedPaths = ensureStringArray(artifactChanges.changedPaths, `${label}.artifactChanges.changedPaths`);
  const declaredRequiredChangedPaths = ensureStringArray(
    artifactChanges.requiredChangedPaths,
    `${label}.artifactChanges.requiredChangedPaths`,
  );
  const declaredAgentEditedChangedPaths = ensureStringArray(
    artifactChanges.agentEditedChangedPaths,
    `${label}.artifactChanges.agentEditedChangedPaths`,
  );
  const requiredChangedPaths = requiredPaths.filter(file => changedPaths.includes(file));

  const actionEvidence = ensureObject(run.actionEvidence, `${label}.actionEvidence`);
  const editedPaths = ensureStringArray(actionEvidence.editedPaths, `${label}.actionEvidence.editedPaths`);
  const editActions = Array.isArray(actionEvidence.editActions) ? actionEvidence.editActions : null;
  const testInvocations = Array.isArray(actionEvidence.testInvocations) ? actionEvidence.testInvocations : null;
  if (!editActions || !testInvocations) {
    fail(`${label}.actionEvidence must contain editActions and testInvocations`);
  }
  const agentEditedChangedPaths = editedPaths.filter(file => changedPaths.includes(file));
  assertSameArray(declaredRequiredChangedPaths, requiredChangedPaths, `${label}.artifactChanges.requiredChangedPaths`);
  assertSameArray(
    declaredAgentEditedChangedPaths,
    agentEditedChangedPaths,
    `${label}.artifactChanges.agentEditedChangedPaths`,
  );

  const successfulEditActions = editActions.filter(action =>
    action && typeof action === "object" && action.resultStatus === "succeeded");
  const successfulEditedPaths = successfulEditActions
    .map(action => action.path)
    .filter(file => typeof file === "string");
  assertSameArray(editedPaths, [...new Set(successfulEditedPaths)], `${label}.actionEvidence.editedPaths`);
  if (actionEvidence.editToolCallCount !== editActions.length
    || actionEvidence.successfulEditToolCallCount !== successfulEditActions.length) {
    fail(`${label}.actionEvidence edit counts do not match recorded actions`);
  }
  const requiredArtifactEditObserved = successfulEditedPaths.some(file => requiredChangedPaths.includes(file));
  const matchedTestInvocations = testInvocations.filter(invocation =>
    invocation && typeof invocation === "object" && invocation.matchedExpectedCommand === true);
  const successfulTestInvocations = matchedTestInvocations.filter(invocation => invocation.resultStatus === "succeeded");
  if (actionEvidence.testInvocationCount !== matchedTestInvocations.length
    || actionEvidence.successfulTestInvocationCount !== successfulTestInvocations.length) {
    fail(`${label}.actionEvidence test counts do not match recorded invocations`);
  }
  assertBooleanEquals(
    actionEvidence.requiredArtifactEditObserved,
    requiredArtifactEditObserved,
    `${label}.actionEvidence.requiredArtifactEditObserved`,
  );
  assertBooleanEquals(
    actionEvidence.agentTestInvoked,
    matchedTestInvocations.length > 0,
    `${label}.actionEvidence.agentTestInvoked`,
  );
  assertBooleanEquals(
    actionEvidence.agentTestCompletedSuccessfully,
    successfulTestInvocations.length > 0,
    `${label}.actionEvidence.agentTestCompletedSuccessfully`,
  );

  const requiredArtifactsChanged = requiredChangedPaths.length === requiredPaths.length;
  const agentEditMatchedChangedArtifact = requiredArtifactEditObserved;
  assertBooleanEquals(artifactChanges.changed, changedPaths.length > 0, `${label}.artifactChanges.changed`);
  assertBooleanEquals(
    artifactChanges.requiredArtifactsChanged,
    requiredArtifactsChanged,
    `${label}.artifactChanges.requiredArtifactsChanged`,
  );
  assertBooleanEquals(
    artifactChanges.agentEditMatchedChangedArtifact,
    agentEditMatchedChangedArtifact,
    `${label}.artifactChanges.agentEditMatchedChangedArtifact`,
  );

  const rubric = ensureObject(run.rubric, `${label}.rubric`);
  const rubricChangedPaths = ensureStringArray(rubric.changedPaths, `${label}.rubric.changedPaths`);
  const missingRequiredPaths = ensureStringArray(rubric.missingRequiredPaths, `${label}.rubric.missingRequiredPaths`);
  const unchangedRequiredPaths = ensureStringArray(rubric.unchangedRequiredPaths, `${label}.rubric.unchangedRequiredPaths`);
  const protectedPathViolations = ensureStringArray(
    rubric.protectedPathViolations,
    `${label}.rubric.protectedPathViolations`,
  );
  const unexpectedChangedPaths = ensureStringArray(
    rubric.unexpectedChangedPaths,
    `${label}.rubric.unexpectedChangedPaths`,
  );
  assertSameArray(rubricChangedPaths, changedPaths, `${label}.rubric.changedPaths`);
  if (missingRequiredPaths.some(file => !requiredPaths.includes(file))
    || unchangedRequiredPaths.some(file => !requiredPaths.includes(file))) {
    fail(`${label}.rubric required-path evidence references a non-required path`);
  }
  assertSameArray(
    protectedPathViolations,
    protectedPaths.filter(file => changedPaths.includes(file)),
    `${label}.rubric.protectedPathViolations`,
  );
  assertSameArray(
    unexpectedChangedPaths,
    changedPaths.filter(file => !allowedPaths.includes(file)),
    `${label}.rubric.unexpectedChangedPaths`,
  );
  assertBooleanEquals(
    rubric.requiredArtifactsPresent,
    missingRequiredPaths.length === 0,
    `${label}.rubric.requiredArtifactsPresent`,
  );
  assertBooleanEquals(
    rubric.requiredArtifactsChanged,
    unchangedRequiredPaths.length === 0,
    `${label}.rubric.requiredArtifactsChanged`,
  );
  assertBooleanEquals(
    rubric.protectedArtifactsUnchanged,
    protectedPathViolations.length === 0,
    `${label}.rubric.protectedArtifactsUnchanged`,
  );
  assertBooleanEquals(
    rubric.onlyAllowedArtifactsChanged,
    unexpectedChangedPaths.length === 0,
    `${label}.rubric.onlyAllowedArtifactsChanged`,
  );
  if (!Number.isInteger(rubric.testExitCode) && rubric.testExitCode !== null) {
    fail(`${label}.rubric.testExitCode must be an integer or null`);
  }
  if (typeof rubric.testTimedOut !== "boolean"
    || ![null, "outer_runner", "inner_safe_run"].includes(rubric.testTimeoutSource)) {
    fail(`${label}.rubric timeout evidence is invalid`);
  }
  if (rubric.testTimedOut !== (rubric.testTimeoutSource !== null)) {
    fail(`${label}.rubric timeout evidence is inconsistent`);
  }
  if (typeof rubric.testProcessGroupCleanupVerified !== "boolean") {
    fail(`${label}.rubric.testProcessGroupCleanupVerified must be boolean`);
  }
  const rubricPassed = rubric.requiredArtifactsPresent === true
    && rubric.requiredArtifactsChanged === true
    && rubric.protectedArtifactsUnchanged === true
    && rubric.onlyAllowedArtifactsChanged === true
    && rubric.testExitCode === 0
    && !rubric.testTimedOut;
  assertBooleanEquals(rubric.passed, rubricPassed, `${label}.rubric.passed`);

  const passed = executionHealthy
    && ownedHandleVerified
    && rubricPassed
    && run.processGroupCleanupVerified === true
    && rubric.testProcessGroupCleanupVerified === true
    && agentEditMatchedChangedArtifact
    && actionEvidence.agentTestCompletedSuccessfully === true;
  assertBooleanEquals(run.passed, passed, `${label}.passed`);
  if (run.includedInModelQualityAggregate === true && (
    !executionHealthy
    || !ownedHandleVerified
    || run.infrastructureBlocked !== false
    || run.processGroupCleanupVerified !== true
    || rubric.testProcessGroupCleanupVerified !== true
  )) {
    fail(`${label} model-quality execution or process cleanup is invalid`);
  }
  return { ...run, passed };
}

export function validatePairedEvaluationRuns(artifact) {
  ensureObject(artifact, "paired evaluation artifact");
  if (!Array.isArray(artifact.tasks) || artifact.tasks.length === 0) {
    fail("paired evaluation artifact tasks must be a non-empty array");
  }
  if (!Array.isArray(artifact.runs) || artifact.runs.length === 0) {
    fail("paired evaluation artifact runs must be a non-empty array");
  }
  const tasks = new Map();
  for (const [index, task] of artifact.tasks.entries()) {
    ensureObject(task, `tasks[${index}]`);
    if (typeof task.id !== "string" || task.id.length === 0 || tasks.has(task.id)) {
      fail(`tasks[${index}].id must be unique and non-empty`);
    }
    tasks.set(task.id, task);
  }
  const identities = new Set();
  return artifact.runs.map((run, index) => {
    const task = tasks.get(run?.caseId);
    if (!task) fail(`runs[${index}] references an unknown task`);
    const identity = `${run.caseId}:${String(run.repeat)}:${String(run.side)}`;
    if (identities.has(identity)) fail(`runs[${index}] duplicates run identity ${identity}`);
    identities.add(identity);
    return validatePairedRun(run, task, index);
  });
}

export function comparisonOutcomeFromAggregate(
  aggregate,
  strictSameModelVerified,
  thresholds = COMPARATIVE_OUTCOME_THRESHOLDS,
) {
  if (aggregate.completedPairs < thresholds.minimumCompletePairs) {
    return {
      status: "inconclusive",
      reason: `Only ${aggregate.completedPairs} complete pairs were available; at least ${thresholds.minimumCompletePairs} are required for any superiority claim.`,
      thresholds,
    };
  }
  if (thresholds.requireStrictSameModelVerified && !strictSameModelVerified) {
    return {
      status: "inconclusive",
      reason: "Strict same-model identity is unverified, so superiority remains inconclusive even if protocol execution is complete.",
      thresholds,
    };
  }
  if (thresholds.requireZeroInfrastructureExclusions && aggregate.excludedInfrastructurePairs !== 0) {
    return {
      status: "inconclusive",
      reason: "At least one paired outcome was excluded for infrastructure reasons, so superiority remains inconclusive.",
      thresholds,
    };
  }
  if (
    aggregate.canvastPassRate === null ||
    aggregate.claudePassRate === null ||
    aggregate.passRateDelta === null ||
    aggregate.durationRatio === null
  ) {
    return {
      status: "inconclusive",
      reason: "Aggregate pass-rate or duration evidence is incomplete, so superiority remains inconclusive.",
      thresholds,
    };
  }
  if (
    aggregate.passRateDelta >= thresholds.minimumPassRateDelta &&
    aggregate.durationRatio <= thresholds.maximumDurationRatio
  ) {
    return {
      status: "canvast_superior",
      reason: `Canvast met the predeclared superiority thresholds: pass-rate delta ${aggregate.passRateDelta} and duration ratio ${aggregate.durationRatio}.`,
      thresholds,
    };
  }
  if (
    -aggregate.passRateDelta >= thresholds.minimumPassRateDelta &&
    aggregate.durationRatio >= 1 / Math.max(thresholds.maximumDurationRatio, 0.0001)
  ) {
    return {
      status: "reference_superior",
      reason: `The reference side met the predeclared superiority thresholds: pass-rate delta ${aggregate.passRateDelta} and duration ratio ${aggregate.durationRatio}.`,
      thresholds,
    };
  }
  return {
    status: "inconclusive",
    reason: "Protocol execution may be complete, but the predeclared superiority thresholds were not met.",
    thresholds,
  };
}

export function publicationComparisonOutcomeFromAggregate(
  aggregate,
  strictSameModelVerified,
  thresholds = PUBLICATION_COMPARATIVE_OUTCOME_THRESHOLDS,
) {
  const directionalOutcome = comparisonOutcomeFromAggregate(
    aggregate,
    strictSameModelVerified,
    thresholds,
  );
  if (directionalOutcome.status === "inconclusive") return directionalOutcome;

  const pValue = aggregate.pairedExactTwoSidedPValue;
  if (typeof pValue !== "number" || !Number.isFinite(pValue)) {
    return {
      status: "inconclusive",
      reason: "The directional thresholds were met, but the exact two-sided paired sign-test p-value is unavailable, so the public relative-performance conclusion remains inconclusive.",
      thresholds,
    };
  }
  if (pValue > thresholds.maximumExactTwoSidedPValue) {
    return {
      status: "inconclusive",
      reason: `The directional thresholds were met, but the exact two-sided paired sign-test p-value ${pValue} exceeds the publication threshold ${thresholds.maximumExactTwoSidedPValue}, so the public relative-performance conclusion remains inconclusive.`,
      thresholds,
    };
  }

  const subject = directionalOutcome.status === "canvast_superior" ? "Canvast" : "The reference side";
  return {
    status: directionalOutcome.status,
    reason: `${subject} met the claim-scoped publication thresholds: pass-rate delta ${aggregate.passRateDelta}, duration ratio ${aggregate.durationRatio}, and exact two-sided paired sign-test p-value ${pValue}.`,
    thresholds,
  };
}

export function verdictForEnhancedDimension(canvastStatus, referenceStatus) {
  if (
    canvastStatus === "passed" &&
    (referenceStatus === "unsupported" || referenceStatus === "absent" || referenceStatus === "failed")
  ) {
    return "pass";
  }
  if (canvastStatus === "passed" && referenceStatus === "passed") return "tie";
  if (canvastStatus === "failed" && referenceStatus === "passed") return "fail";
  if (
    canvastStatus === "failed" &&
    (referenceStatus === "unsupported" || referenceStatus === "absent" || referenceStatus === "failed")
  ) {
    return "inconclusive";
  }
  return "inconclusive";
}

export function includedInEnhancedClaim(verdict) {
  return verdict === "pass" || verdict === "tie" || verdict === "fail";
}

export function rationaleForEnhancedDimension(canvastSummary, referenceSummary) {
  return `${canvastSummary} / ${referenceSummary}`;
}

export function readJsonArtifact(file, label) {
  if (!fs.existsSync(file)) fail(`${label} is missing`);
  const raw = fs.readFileSync(file);
  let document;
  try {
    document = JSON.parse(raw.toString("utf8"));
  } catch {
    fail(`${label} is not valid JSON`);
  }
  return { document, raw, sha256: digest(raw) };
}

export function inferProjectRoot(actualFile, declaredPath, field) {
  const relative = relativePath(declaredPath, field);
  const parts = relative.split("/");
  let cursor = path.resolve(actualFile);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (path.basename(cursor) !== parts[index]) fail(`${field} does not match the selected file`);
    cursor = path.dirname(cursor);
  }
  return cursor;
}

export function assertBoundPath(root, actualFile, declaredPath, field) {
  const relative = relativePath(declaredPath, field);
  if (path.resolve(actualFile) !== path.resolve(root, relative)) {
    fail(`${field} does not match the selected file`);
  }
  return relative;
}

export function relativeOutputPath(root, actualFile, field) {
  return relativePath(path.relative(root, path.resolve(actualFile)).split(path.sep).join("/"), field);
}

export function validateSourceManifest(source) {
  const manifest = source.document;
  if (!isRecord(manifest) || manifest.schemaVersion !== 2 || manifest.kind !== "canvast-source-snapshot") {
    fail("source manifest must be a schemaVersion 2 Canvast source snapshot");
  }
  if (manifest.algorithm !== "sha256") fail("source manifest algorithm must be sha256");
  const generatedAt = timestamp(manifest.generatedAt, "source manifest generatedAt");
  const sourceTreeSha256 = sha256Value(manifest.sourceTreeSha256, "source manifest sourceTreeSha256");
  if (!isRecord(manifest.scope)) fail("source manifest scope must be present");
  for (const field of [
    "entries",
    "excludedPrefixes",
    "excludedSegments",
    "excludedBasenames",
    "excludedSuffixes",
    "derivedOutputsExcluded",
  ]) {
    if (!Array.isArray(manifest.scope[field]) || manifest.scope[field].some(value => typeof value !== "string")) {
      fail(`source manifest scope.${field} must be a string array`);
    }
  }
  if (!isRecord(manifest.policy)) fail("source manifest policy must be present");
  const policyPath = relativePath(manifest.policy.path, "source manifest policy.path");
  const policySha256 = sha256Value(manifest.policy.sha256, "source manifest policy.sha256");
  if (!Array.isArray(manifest.files)) fail("source manifest files must be an array");

  const entries = manifest.files.map((entry, index) => {
    if (!isRecord(entry)) fail(`source manifest files[${index}] must be an object`);
    const entryPath = relativePath(entry.path, `source manifest files[${index}].path`);
    const size = integer(entry.size, `source manifest files[${index}].size`);
    if (size < 0) fail(`source manifest files[${index}].size must be non-negative`);
    const mode = integer(entry.mode, `source manifest files[${index}].mode`);
    if (mode !== 0o644 && mode !== 0o755) {
      fail(`source manifest files[${index}].mode must be 0644 or 0755`);
    }
    return {
      path: entryPath,
      size,
      mode,
      sha256: sha256Value(entry.sha256, `source manifest files[${index}].sha256`),
    };
  });
  const sortedPaths = entries.map(entry => entry.path).sort((left, right) => left.localeCompare(right));
  if (!arraysEqual(entries.map(entry => entry.path), sortedPaths)) fail("source manifest files must be sorted");
  if (new Set(sortedPaths).size !== sortedPaths.length) fail("source manifest files contains duplicate paths");
  if (manifest.fileCount !== entries.length) fail("source manifest fileCount does not match files");
  const totalBytes = entries.reduce((total, entry) => total + entry.size, 0);
  if (manifest.totalBytes !== totalBytes) fail("source manifest totalBytes does not match files");
  const treePayload = entries
    .map(entry => `${entry.sha256} ${entry.size} ${entry.mode} ${entry.path}\n`)
    .join("");
  if (digest(treePayload) !== sourceTreeSha256) {
    fail("source manifest sourceTreeSha256 does not match its file entries");
  }
  return { generatedAt, sourceTreeSha256, policyPath, policySha256 };
}

export function validateEmbeddedSourcePolicy(root, source) {
  const policyFile = path.resolve(root, source.policyPath);
  const relative = path.relative(root, policyFile).split(path.sep).join("/");
  relativePath(relative, "source manifest policy.path");
  if (!fs.existsSync(policyFile)) fail("source manifest policy file is missing");
  if (digest(fs.readFileSync(policyFile)) !== source.policySha256) {
    fail("source manifest policy hash is stale");
  }
}

function smokeOrder(repeat) {
  const orders = [
    ["claude", "canvast"],
    ["canvast", "claude"],
    ["canvast", "claude"],
  ];
  return orders[repeat - 1];
}

function validateSmokeRun(run, taskIds, identities) {
  if (!isRecord(run) || !taskIds.has(run.caseId)) fail("smoke artifact contains an unknown run");
  const repeat = integer(run.repeat, "smoke run repeat");
  const order = smokeOrder(repeat);
  if (!order || !["claude", "canvast"].includes(run.side)) fail("smoke artifact contains an invalid run identity");
  if (run.orderPosition !== order.indexOf(run.side) + 1) fail("smoke artifact violates crossover order");
  const identity = `${run.caseId}/repeat-${repeat}/${run.side}`;
  if (identities.has(identity)) fail("smoke artifact contains duplicate run identities");
  identities.add(identity);
  if (
    run.exitCode !== 0 ||
    run.executionHealthy !== true ||
    run.infrastructureBlocked !== false ||
    run.timedOut !== false ||
    run.timeoutSource !== null ||
    run.processGroupCleanupVerified !== true ||
    run.passed !== true ||
    run.includedInModelQualityAggregate !== false
  ) {
    fail("smoke artifact contains a failed or unhealthy run");
  }
  const baselineTreeSha256 = sha256Value(run.baselineTreeSha256, "smoke run baselineTreeSha256");
  if (sha256Value(run.initialWorkspaceTreeSha256, "smoke run initialWorkspaceTreeSha256") !== baselineTreeSha256) {
    fail("smoke artifact run does not start from its declared baseline");
  }
  const expectedMode = run.side === "claude" ? "reference_bare_print" : "canvast_parity_print";
  if (run.executionMode !== expectedMode) fail("smoke artifact used an unsupported execution mode");
  if (!ownedHandleShutdownVerified(run.ownedHandleShutdown, run.side === "canvast")) {
    fail("smoke artifact owned-handle shutdown evidence is invalid or unverified");
  }
  if (
    run.artifactChanges?.changed !== true ||
    run.artifactChanges?.requiredArtifactsChanged !== true ||
    run.artifactChanges?.agentEditMatchedChangedArtifact !== true ||
    run.actionEvidence?.requiredArtifactEditObserved !== true ||
    run.actionEvidence?.agentTestInvoked !== true ||
    run.actionEvidence?.agentTestCompletedSuccessfully !== true
  ) {
    fail("smoke artifact lacks required edit or test evidence");
  }
  const requiredPaths = run.artifactChanges.requiredChangedPaths;
  if (!Array.isArray(requiredPaths)) fail("smoke artifact lacks required changed paths");
  const editObserved = Array.isArray(run.actionEvidence.editActions) &&
    run.actionEvidence.editActions.some(action =>
      action?.resultStatus === "succeeded" && requiredPaths.includes(action.path));
  const testObserved = Array.isArray(run.actionEvidence.testInvocations) &&
    run.actionEvidence.testInvocations.some(invocation =>
      invocation?.matchedExpectedCommand === true && invocation?.resultStatus === "succeeded");
  if (!editObserved || !testObserved) fail("smoke artifact lacks successful action evidence");
  if (
    run.rubric?.passed !== true ||
    run.rubric?.testExitCode !== 0 ||
    run.rubric?.testTimedOut !== false ||
    run.rubric?.testTimeoutSource !== null ||
    run.rubric?.testProcessGroupCleanupVerified !== true ||
    run.rubric?.requiredArtifactsPresent !== true ||
    run.rubric?.requiredArtifactsChanged !== true ||
    run.rubric?.protectedArtifactsUnchanged !== true ||
    run.rubric?.onlyAllowedArtifactsChanged !== true
  ) {
    fail("smoke artifact independent rubric failed");
  }
}

export function validateSmokeArtifact(smoke, binding) {
  const artifact = smoke.document;
  if (!isRecord(artifact) || artifact.schemaVersion !== 1 || artifact.kind !== "canvast-paired-smoke") {
    fail("smoke artifact must be a schemaVersion 1 paired smoke artifact");
  }
  if (artifact.status !== "passed") fail("smoke artifact status must be passed");
  if (!isRecord(artifact.provenance) || artifact.provenance.verified !== true) {
    fail("smoke artifact provenance must be verified");
  }
  if (!Array.isArray(artifact.provenance.errors) || artifact.provenance.errors.length !== 0) {
    fail("smoke artifact provenance errors must be empty");
  }
  if (
    artifact.provenance.sourceManifestPath !== binding.sourceManifestPath ||
    artifact.provenance.sourceManifestSha256 !== binding.sourceManifestSha256 ||
    artifact.provenance.sourceManifestGeneratedAt !== binding.sourceManifestGeneratedAt
  ) {
    fail("smoke artifact is not bound to the selected source manifest");
  }
  const generatedAt = timestamp(artifact.generatedAt, "smoke artifact generatedAt");
  if (Date.parse(generatedAt) < Date.parse(binding.sourceManifestGeneratedAt)) {
    fail("smoke artifact predates the selected source manifest");
  }
  if (
    artifact.protocol?.repeats !== 3 ||
    artifact.protocol.isolatedWorkspacePerSideRepeat !== true ||
    artifact.protocol.allInitialCopiesMatch !== true
  ) {
    fail("smoke artifact must use three repeats with matching isolated workspaces");
  }
  if (!Array.isArray(artifact.tasks) || !Array.isArray(artifact.runs)) {
    fail("smoke artifact lacks a machine-readable task and run matrix");
  }
  const taskIds = artifact.tasks.map((task, index) => {
    if (!isRecord(task)) fail(`smoke tasks[${index}] must be an object`);
    if (task.fixtureKind !== "real_repository_snapshot" || task.smokeEligible !== true) {
      fail("smoke artifact tasks must be smoke-eligible real_repository_snapshot cases");
    }
    return stringValue(task.id, `smoke tasks[${index}].id`);
  });
  if (JSON.stringify(taskIds) !== JSON.stringify(REAL_SMOKE_TASK_IDS)) {
    fail("smoke artifact must contain exactly the current real smoke task ids");
  }
  const identities = new Set();
  const allowedTaskIds = new Set(taskIds);
  for (const run of artifact.runs) validateSmokeRun(run, allowedTaskIds, identities);
  const expectedIdentities = taskIds.flatMap(caseId =>
    [1, 2, 3].flatMap(repeat =>
      ["claude", "canvast"].map(side => `${caseId}/repeat-${repeat}/${side}`)));
  if (
    artifact.runs.length !== expectedIdentities.length ||
    !expectedIdentities.every(identity => identities.has(identity))
  ) {
    fail("smoke artifact run matrix is incomplete");
  }
  const gate = {
    passed: true,
    expectedRuns: expectedIdentities.length,
    observedRuns: expectedIdentities.length,
    passedRuns: expectedIdentities.length,
    failures: [],
  };
  if (!equalGate(artifact.smokeGate, gate)) fail("smoke artifact gate does not match its run matrix");
  return {
    artifactPath: relativePath(artifact.artifactPath, "smoke artifact artifactPath"),
    generatedAt,
    gate,
  };
}

export function assertSmokeBindings(result, smoke, source) {
  if (result.provenance.manifestSha !== source.sha256) {
    fail("paired artifact source manifest hash does not match the selected source manifest");
  }
  if (result.provenance.manifestGeneratedAt !== source.generatedAt) {
    fail("paired artifact source manifest timestamp does not match the selected source manifest");
  }
  if (result.provenance.sourceTreeSha256 !== source.sourceTreeSha256) {
    fail("paired artifact source tree hash does not match the selected source manifest");
  }
  if (result.formalPrerequisite.artifactSha256 !== smoke.sha256) {
    fail("paired artifact smoke hash does not match the selected smoke artifact");
  }
  if (
    result.formalPrerequisite.artifactPath !== smoke.artifactPath ||
    result.formalPrerequisite.generatedAt !== smoke.generatedAt ||
    !equalGate(result.formalPrerequisite.gate, smoke.gate) ||
    !equalGate(result.smokeGate, smoke.gate)
  ) {
    fail("paired artifact smoke prerequisite does not match the selected smoke artifact");
  }
}

export function buildEffectivenessSummary({
  result,
  artifactSha256,
  source,
  smoke,
  document,
  documentPath,
  attestation,
}) {
  const metrics = result.metrics;
  const tokens = result.tokens;
  return {
    schemaVersion: 1,
    kind: "canvast-effectiveness-summary",
    status: "passed",
    generatedAt: result.provenance.generatedAt,
    inputs: {
      pairedEvaluation: {
        path: result.artifactPath,
        sha256: artifactSha256,
        generatedAt: result.provenance.generatedAt,
      },
      sourceManifest: {
        path: result.provenance.manifestPath,
        sha256: source.sha256,
        sourceTreeSha256: source.sourceTreeSha256,
        generatedAt: source.generatedAt,
      },
      smokeArtifact: {
        path: smoke.artifactPath,
        sha256: smoke.sha256,
        generatedAt: smoke.generatedAt,
      },
      ...(attestation
        ? {
          modelBackendAttestation: {
            path: attestation.path,
            sha256: attestation.sha256,
            attestedAt: attestation.document.attestedAt,
          },
        }
        : {}),
    },
    document: {
      path: documentPath,
      sha256: digest(document),
    },
    comparisonOutcome: result.comparisonOutcome,
    modelComparability: {
      strictSameModelVerified: result.modelComparability.strictSameModelVerified === true,
      status: result.modelComparability.status || "unknown",
      ownerAttestation: attestation
        ? {
          attestedAt: attestation.document.attestedAt,
          attestedBy: attestation.document.attestedBy,
          statement: attestation.document.statement,
          statementZh: attestation.document.statementZh,
          scope: attestation.document.scope,
          scopeZh: attestation.document.scopeZh,
        }
        : null,
    },
    referenceToolchain: result.referenceToolchain || null,
    metrics: {
      pairCount: metrics.pairCount,
      sideRunCount: metrics.runs.length,
      passes: {
        canvast: metrics.canvastPasses,
        reference: metrics.referencePasses,
      },
      passRates: {
        canvast: metrics.canvastPassRate,
        reference: metrics.referencePassRate,
        delta: metrics.passRateDelta,
      },
      pairedOutcomes: {
        bothPassed: metrics.bothPassed,
        bothFailed: metrics.bothFailed,
        canvastOnlyPassed: metrics.canvastOnlyPassed,
        referenceOnlyPassed: metrics.referenceOnlyPassed,
      },
      latencyMs: {
        canvastMedian: metrics.canvastMedianDurationMs,
        referenceMedian: metrics.referenceMedianDurationMs,
        difference: metrics.canvastMedianDurationMs - metrics.referenceMedianDurationMs,
        ratio: metrics.durationRatio,
      },
      exactSignTest: {
        discordantPairs: metrics.discordantPairs,
        twoSidedPValue: metrics.pValue,
      },
      tokenComparison: tokens
        ? {
          effectiveTokens: {
            canvast: tokens.canvastEffectiveTokens,
            reference: tokens.claudeEffectiveTokens,
            difference: tokens.canvastEffectiveTokens - tokens.claudeEffectiveTokens,
            ratio: tokens.ratio,
          },
          cacheReadTokens: {
            canvast: tokens.canvastCacheReadTokens,
            reference: tokens.claudeCacheReadTokens,
          },
          cacheWriteTokens: {
            canvast: tokens.canvastCacheWriteTokens,
            reference: tokens.claudeCacheWriteTokens,
          },
        }
        : null,
    },
    bilateralEnhancedProbes: {
      summary: result.enhanced.summary,
      dimensions: result.enhanced.dimensions.map(dimension => ({
        id: dimension.id,
        title: dimension.title,
        verdict: dimension.verdict,
        includedInClaim: dimension.includedInClaim,
        canvastStatus: dimension.canvast.status,
        referenceStatus: dimension.reference.status,
        rationale: dimension.rationale,
      })),
    },
  };
}

export function serializeSummary(summary) {
  return `${JSON.stringify(summary, null, 2)}\n`;
}

export function verifyExactFile(file, expected, label) {
  if (!fs.existsSync(file)) fail(`${label} is missing`);
  const actual = fs.readFileSync(file);
  const expectedBytes = Buffer.isBuffer(expected) ? expected : Buffer.from(expected);
  if (!actual.equals(expectedBytes)) fail(`${label} does not match regenerated bytes`);
}
