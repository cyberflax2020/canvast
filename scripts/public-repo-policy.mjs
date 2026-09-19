#!/usr/bin/env node
/**
 * =============================================================================
 * Canvast — Public Repository Policy / Canvast source file
 * =============================================================================
 * @file        scripts/public-repo-policy.mjs
 * @brief       One positive allowlist for public, npm, and product zip trees.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function failSkillPolicy(message) {
  throw new Error(`public skill policy: ${message}`);
}

function normalizeRelativeEntry(value) {
  return value.split(path.sep).join("/");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSkillName(value) {
  if (typeof value !== "string" || !value || value.length > 64) return false;
  for (const char of value) {
    const code = char.charCodeAt(0);
    const digit = code >= 48 && code <= 57;
    const lower = code >= 97 && code <= 122;
    if (!digit && !lower && char !== "-") return false;
  }
  return !value.startsWith("-") && !value.endsWith("-") && !value.includes("--");
}

function stripTrailingSlashes(value) {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

function pathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function readManagedSkillPolicy() {
  const manifestRelative = "skills/manifest.json";
  const manifestPath = path.join(projectRoot, manifestRelative);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    failSkillPolicy(`cannot read ${manifestRelative}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(manifest) || manifest.version !== 1 || !Array.isArray(manifest.skills)) {
    failSkillPolicy("skills/manifest.json must contain version=1 and a skills array");
  }

  const skillDirectories = [];
  const skillFiles = [manifestRelative];
  const names = new Set();
  const realProjectRoot = fs.realpathSync(projectRoot);
  for (const entry of manifest.skills) {
    if (
      !isRecord(entry)
      || !isSkillName(entry.name)
      || typeof entry.path !== "string"
      || typeof entry.licenseFile !== "string"
      || entry.activation !== "explicit"
      || entry.defaultEnabled !== false
      || entry.allowImplicitInvocation !== false
    ) {
      failSkillPolicy("manifest entries must be explicit-only skill records");
    }
    if (names.has(entry.name)) failSkillPolicy(`duplicate skill name: ${entry.name}`);
    names.add(entry.name);
    const directoryEntry = stripTrailingSlashes(normalizeRelativeEntry(entry.path));
    if (!directoryEntry.startsWith("skills/")) failSkillPolicy(`${entry.name}: path must stay under skills/`);
    const skillRoot = path.resolve(projectRoot, directoryEntry);
    if (!pathInside(projectRoot, skillRoot)) failSkillPolicy(`${entry.name}: path escapes project root`);
    if (!fs.existsSync(skillRoot) || !fs.statSync(skillRoot).isDirectory() || fs.lstatSync(skillRoot).isSymbolicLink()) {
      failSkillPolicy(`${entry.name}: skill directory must be a regular directory`);
    }
    if (!pathInside(realProjectRoot, fs.realpathSync(skillRoot))) failSkillPolicy(`${entry.name}: real skill directory escapes project root`);
    const licensePath = path.resolve(projectRoot, normalizeRelativeEntry(entry.licenseFile));
    if (!pathInside(projectRoot, licensePath)) failSkillPolicy(`${entry.name}: licenseFile escapes project root`);
    if (!fs.existsSync(licensePath) || !fs.statSync(licensePath).isFile() || fs.lstatSync(licensePath).isSymbolicLink()) {
      failSkillPolicy(`${entry.name}: licenseFile must be a regular file`);
    }
    if (!pathInside(realProjectRoot, fs.realpathSync(licensePath))) failSkillPolicy(`${entry.name}: real licenseFile escapes project root`);
    skillDirectories.push(directoryEntry);
  }

  return Object.freeze({
    manifestRelative,
    skillDirectories: Object.freeze(skillDirectories.sort((left, right) => left.localeCompare(right))),
    skillFiles: Object.freeze(skillFiles),
  });
}

const managedSkillPolicy = readManagedSkillPolicy();
export const managedSkillDirectories = managedSkillPolicy.skillDirectories;
export const managedSkillFiles = managedSkillPolicy.skillFiles;

/** Recursively copied product directories. No broad docs/scripts/eval roots. */
export const publicDirectoryEntries = Object.freeze([
  "components",
  "config-templates",
  "docs/assets/user-guide",
  "extensions",
  "macos-app/Config",
  "macos-app/Sources",
  "release/artifacts/canvas-portable",
  ...managedSkillPolicy.skillDirectories,
  "src",
]);

/** Explicit files for the independent public product and its reproducible evidence. */
export const publicFileEntries = Object.freeze([
  ".env.example",
  ".github/CODEOWNERS",
  ".github/ISSUE_TEMPLATE/bug_report.md",
  ".github/ISSUE_TEMPLATE/feature_request.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/workflows/public-release-gate.yml",
  ".gitignore",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "NOTICE",
  "README.md",
  "README.zh-CN.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "VERSION",
  "assets/brand/README.md",
  "assets/brand/asset-manifest.json",
  "assets/brand/canvast-hero.svg",
  "assets/brand/canvast-logo.svg",
  "assets/brand/canvast-logo.tui.txt",
  "bin/canvast",
  "canvast.sh",
  "docs/EFFECTIVENESS_EVIDENCE.md",
  "docs/architecture/open-source-adoption-record.md",
  "docs/architecture/canvas-and-traceability.md",
  "docs/architecture/canvas-context-scoping.md",
  "docs/architecture/overview.md",
  "docs/architecture/runtime-orchestration.md",
  "docs/reference/external-services.md",
  "docs/guides/configuration.md",
  "docs/guides/macos-public-notarization.md",
  "docs/guides/testing.md",
  "docs/guides/user-manual.md",
  "eval-matrix/paired-evidence-contract.mjs",
  "eval-matrix/artifacts/paired-evaluation-latest.json",
  "eval-matrix/artifacts/paired-smoke-latest.json",
  "macos-app/Package.swift",
  "package-lock.json",
  "package.json",
  ...managedSkillPolicy.skillFiles,
  "release/source-manifest.json",
  "scripts/canvas-export-portable-artifact.mjs",
  "scripts/canvas-portable-release-artifact.mjs",
  "scripts/canvas-surface-artifact.mjs",
  "scripts/assert-resource-baseline.mjs",
  "scripts/process-snapshot-client.d.mts",
  "scripts/process-snapshot-client.mjs",
  "scripts/process-snapshot.py",
  "scripts/check-macos-ui-full-text.mjs",
  "scripts/build-macos-app.sh",
  "scripts/export-canvas.mjs",
  "scripts/effectiveness-render.mjs",
  "scripts/effectiveness-summary.mjs",
  "scripts/filter-json-output.mjs",
  "scripts/generate-macos-app-icon.mjs",
  "scripts/generate-effectiveness-evidence.mjs",
  "scripts/live-env.sh",
  "scripts/live-runtime-root.d.mts",
  "scripts/live-runtime-root.mjs",
  "scripts/macos-app-archive.mjs",
  "scripts/notarize-macos-app.sh",
  "scripts/product-runtime.mjs",
  "scripts/public-release-gate.sh",
  "scripts/public-release-guards.mjs",
  "scripts/public-repo-policy.mjs",
  "scripts/public-runtime-shutdown-probe.mjs",
  "scripts/release-impact-evidence.mjs",
  "scripts/release-source-policy.mjs",
  "scripts/resolve-canvast-skill.mjs",
  "scripts/resource-watchdog.sh",
  "scripts/render-macos-app-icon.swift",
  "scripts/safe-run.sh",
  "scripts/source-manifest-validation.mjs",
  "scripts/unattended-gui-guard.sh",
  "scripts/verify-brand-assets.mjs",
  "scripts/verify-macos-app.sh",
  "scripts/verify-public-release-import-closure.mjs",
  "scripts/verify-public-release.mjs",
  "release/artifacts/canvas-portable.json",
  "release/license-inventory.json",
  "tsconfig.json",
]);

export const publicEntries = Object.freeze([
  ...publicDirectoryEntries,
  ...publicFileEntries,
]);

export const authoredPublicMarkdownEntries = Object.freeze([
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "README.md",
  "README.zh-CN.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "assets/brand/README.md",
  "docs/EFFECTIVENESS_EVIDENCE.md",
  "docs/architecture/open-source-adoption-record.md",
  "docs/architecture/canvas-and-traceability.md",
  "docs/architecture/canvas-context-scoping.md",
  "docs/architecture/overview.md",
  "docs/architecture/runtime-orchestration.md",
  "docs/guides/configuration.md",
  "docs/guides/macos-public-notarization.md",
  "docs/guides/testing.md",
  "docs/guides/user-manual.md",
  "docs/reference/external-services.md",
]);

/** Outputs generated only after the source snapshot is frozen. */
export const publicEvidenceEntries = Object.freeze([
  "release/artifacts/effectiveness-summary.json",
  "release/artifacts/macos-ui-impact.json",
  "release/artifacts/model-backend-attestation.json",
  "release/artifacts/screenshots.json",
]);

/** Files required for a runnable npm/product archive, not repository CI. */
export const npmFileEntries = Object.freeze([
  "bin/canvast",
  "src/",
  ".env.example",
  "assets/brand/README.md",
  "assets/brand/asset-manifest.json",
  "assets/brand/canvast-hero.svg",
  "assets/brand/canvast-logo.svg",
  "assets/brand/canvast-logo.tui.txt",
  "macos-app/Sources/CanvastApp/Resources/Assets.xcassets/CanvastLogo.imageset/canvast-logo.svg",
  "components/",
  "extensions/",
  ...managedSkillPolicy.skillDirectories.map(entry => `${entry}/`),
  "config-templates/",
  "macos-app/Config/",
  "macos-app/Sources/",
  "macos-app/Package.swift",
  "docs/assets/user-guide/",
  "docs/architecture/open-source-adoption-record.md",
  "docs/guides/configuration.md",
  "docs/guides/testing.md",
  "docs/guides/user-manual.md",
  "docs/EFFECTIVENESS_EVIDENCE.md",
  "docs/reference/external-services.md",
  "eval-matrix/paired-evidence-contract.mjs",
  "scripts/canvas-surface-artifact.mjs",
  "scripts/assert-resource-baseline.mjs",
  "scripts/process-snapshot-client.d.mts",
  "scripts/process-snapshot-client.mjs",
  "scripts/process-snapshot.py",
  "scripts/check-macos-ui-full-text.mjs",
  "scripts/build-macos-app.sh",
  "scripts/export-canvas.mjs",
  "scripts/canvas-export-portable-artifact.mjs",
  "scripts/canvas-portable-release-artifact.mjs",
  "scripts/effectiveness-render.mjs",
  "scripts/effectiveness-summary.mjs",
  "scripts/filter-json-output.mjs",
  "scripts/generate-macos-app-icon.mjs",
  "scripts/generate-effectiveness-evidence.mjs",
  "scripts/live-env.sh",
  "scripts/live-runtime-root.d.mts",
  "scripts/live-runtime-root.mjs",
  "scripts/macos-app-archive.mjs",
  "scripts/notarize-macos-app.sh",
  "scripts/product-runtime.mjs",
  "scripts/public-release-gate.sh",
  "scripts/public-release-guards.mjs",
  "scripts/public-repo-policy.mjs",
  "scripts/public-runtime-shutdown-probe.mjs",
  "scripts/release-impact-evidence.mjs",
  "scripts/release-source-policy.mjs",
  "scripts/resolve-canvast-skill.mjs",
  "scripts/resource-watchdog.sh",
  "scripts/render-macos-app-icon.swift",
  "scripts/safe-run.sh",
  "scripts/source-manifest-validation.mjs",
  "scripts/unattended-gui-guard.sh",
  "scripts/verify-brand-assets.mjs",
  "scripts/verify-macos-app.sh",
  "scripts/verify-public-release-import-closure.mjs",
  "scripts/verify-public-release.mjs",
  "CHANGELOG.md",
  "LICENSE",
  "NOTICE",
  "README.md",
  "README.zh-CN.md",
  ...managedSkillPolicy.skillFiles,
  "release/source-manifest.json",
  "release/license-inventory.json",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "VERSION",
  "canvast.sh",
  "tsconfig.json",
]);

export const publicPackageScripts = Object.freeze({
  start: "./canvast.sh",
  typecheck: "tsc --noEmit",
  "macos:notarize": "scripts/notarize-macos-app.sh",
  "guard:macos-ui-full-text": "node scripts/check-macos-ui-full-text.mjs",
  "export:canvas": "node scripts/export-canvas.mjs",
  "verify:brand": "node scripts/verify-brand-assets.mjs",
  "verify:skills": "python3 skills/canvast-project-operator/scripts/smoke_check.py --repo .",
  "verify:public": "node scripts/verify-public-release.mjs . --standalone",
});

const managedSkillRuntimeEntries = Object.freeze([
  ...managedSkillPolicy.skillDirectories.map(entry => `${entry}/`),
  ...managedSkillPolicy.skillFiles,
]);

/**
 * Package-owned paths needed before each advertised command can reach its
 * first intentional success or precondition boundary. Keep optional safety
 * companions explicit so a public projection cannot silently weaken them.
 */
export const publicRuntimeDependencies = Object.freeze({
  entrypoints: Object.freeze({
    "scripts/build-macos-app.sh": Object.freeze([
      "macos-app/Config/",
      "macos-app/Sources/",
      "macos-app/Package.swift",
      "assets/brand/canvast-logo.svg",
      "assets/brand/asset-manifest.json",
      "scripts/generate-macos-app-icon.mjs",
      "scripts/render-macos-app-icon.swift",
      "scripts/verify-macos-app.sh",
      "scripts/macos-app-archive.mjs",
      "scripts/product-runtime.mjs",
      "release/source-manifest.json",
      "VERSION",
      "LICENSE",
      "NOTICE",
      "THIRD_PARTY_NOTICES.md",
    ]),
    "scripts/notarize-macos-app.sh": Object.freeze([
      "scripts/verify-macos-app.sh",
      "scripts/macos-app-archive.mjs",
      "scripts/build-macos-app.sh",
      "scripts/product-runtime.mjs",
      "release/source-manifest.json",
    ]),
    "scripts/safe-run.sh": Object.freeze([
      "scripts/resource-watchdog.sh",
      "scripts/process-snapshot.py",
      "scripts/unattended-gui-guard.sh",
    ]),
  }),
  packageScripts: Object.freeze({
    start: Object.freeze([
      "canvast.sh",
      "components/",
      "extensions/",
      ...managedSkillRuntimeEntries,
      "scripts/live-env.sh",
      "scripts/filter-json-output.mjs",
      "scripts/resolve-canvast-skill.mjs",
    ]),
    typecheck: Object.freeze([
      "tsconfig.json",
      "src/",
      "extensions/",
    ]),
    "macos:notarize": Object.freeze([
      "scripts/notarize-macos-app.sh",
      "scripts/verify-macos-app.sh",
      "scripts/macos-app-archive.mjs",
      "scripts/build-macos-app.sh",
      "scripts/product-runtime.mjs",
      "release/source-manifest.json",
    ]),
    "guard:macos-ui-full-text": Object.freeze([
      "macos-app/Sources/CanvastApp/",
      "macos-app/Sources/CanvastAppCore/",
      "scripts/check-macos-ui-full-text.mjs",
    ]),
    "export:canvas": Object.freeze([
      "scripts/canvas-surface-artifact.mjs",
      "scripts/export-canvas.mjs",
      "scripts/canvas-export-portable-artifact.mjs",
      "scripts/canvas-portable-release-artifact.mjs",
      "scripts/source-manifest-validation.mjs",
    ]),
    "verify:brand": Object.freeze([
      "assets/brand/README.md",
      "assets/brand/asset-manifest.json",
      "assets/brand/canvast-logo.svg",
      "assets/brand/canvast-logo.tui.txt",
      "macos-app/Sources/CanvastApp/Resources/Assets.xcassets/CanvastLogo.imageset/canvast-logo.svg",
      "scripts/verify-brand-assets.mjs",
      "scripts/public-repo-policy.mjs",
      "scripts/release-source-policy.mjs",
      "package.json",
      "LICENSE",
    ]),
    "verify:skills": Object.freeze([
      ...managedSkillRuntimeEntries,
      "LICENSE",
      "scripts/resolve-canvast-skill.mjs",
    ]),
    "verify:public": Object.freeze([
      "canvast.sh",
      "scripts/verify-public-release.mjs",
      "scripts/public-release-guards.mjs",
      "scripts/public-repo-policy.mjs",
      "scripts/public-runtime-shutdown-probe.mjs",
      "scripts/assert-resource-baseline.mjs",
      "scripts/process-snapshot-client.mjs",
      "scripts/process-snapshot.py",
      "scripts/generate-effectiveness-evidence.mjs",
      "scripts/effectiveness-summary.mjs",
      "eval-matrix/paired-evidence-contract.mjs",
      "scripts/effectiveness-render.mjs",
      "scripts/release-impact-evidence.mjs",
      "scripts/canvas-surface-artifact.mjs",
      "scripts/export-canvas.mjs",
      "scripts/canvas-export-portable-artifact.mjs",
      "scripts/canvas-portable-release-artifact.mjs",
      "scripts/release-source-policy.mjs",
      "scripts/verify-public-release-import-closure.mjs",
    ]),
  }),
});

export const forbiddenGeneratedSegments = new Set([
  ".build", ".build-release", ".build-release-app", ".canvast-secrets",
  ".data", ".git", ".pi", ".project-contract-harness", ".runtime",
  "__pycache__", "coverage", "dist",
  "node_modules", "pi-data",
]);

export const forbiddenBasenames = new Set([
  ".DS_Store", ".aider.chat.history.md", ".aider.input.history",
  ".env", "AGENTS.md", "ARCHITECTURE.md", "PROJECT_STATE.md",
  "PROGRESS_LOG.md", "PRODUCT_CLOSURE_RECORD.json", "auth.json",
  "package-list.txt",
]);

export const forbiddenRelativePrefixes = new Set([
  "docs/reports",
  "eval-matrix/reports",
  "reference-extensions",
  "release/private",
]);

/** Development-only files nested below otherwise-public directories. */
export const forbiddenRelativePaths = new Set([
  "docs/DECISIONS.md",
  "docs/EXPERIMENT_FRAMEWORK.md",
  "docs/guides/macos-app.md",
  "docs/guides/canvas-export.md",
  "docs/guides/tui-operations.md",
  "macos-app/Sources/CanvastApp/CanvastAppSelfTest.swift",
  "macos-app/Sources/CanvastApp/CanvastAppSelfTestActionSettlementTests.swift",
  "macos-app/Sources/CanvastApp/CanvastAppSelfTestActionLifecycleTests.swift",
  "macos-app/Sources/CanvastApp/CanvastAppSelfTestCanvasExportTests.swift",
  "macos-app/Sources/CanvastApp/CanvastAppSelfTestObservabilityTests.swift",
  "macos-app/Sources/CanvastApp/CanvastAppSelfTestProjectLifecycleTests.swift",
  "macos-app/Sources/CanvastApp/CanvastAppSelfTestRuntimeTests.swift",
  "macos-app/Sources/CanvastApp/CanvastAppSelfTestSafetyPlanningTests.swift",
  "macos-app/Sources/CanvastApp/CanvastAppSelfTestSettingsTests.swift",
  "macos-app/Sources/CanvastApp/CanvastAppSelfTestSupport.swift",
  "macos-app/Sources/CanvastApp/CanvastAppSelfTestViewportTests.swift",
  "macos-app/Sources/CanvastApp/InstalledGUIAcceptance.swift",
  "macos-app/Sources/CanvastApp/InstalledGUIAcceptanceAccessibility.swift",
  "macos-app/Sources/CanvastApp/UserGuideSnapshotRenderer.swift",
  "macos-app/Sources/CanvastAppCoreSelfTest/main.swift",
  "macos-app/Sources/CanvastAppCoreSelfTest/DesktopActionSelfTests.swift",
  "scripts/installed-gui-acceptance.sh",
  "scripts/installed-gui-resource-observer.d.mts",
  "scripts/installed-gui-resource-observer.mjs",
  "src/tui/canvas-panel.ts",
  "tests/unit/installed-gui-acceptance.test.ts",
]);

const forbiddenNestedDevelopmentSegments = new Set([
  "__tests__",
  "cache",
  "fixture",
  "fixtures",
  "handoff",
  "intermediate",
  "private",
  "runtime",
  "self-test",
  "selftest",
  "session",
  "test",
  "tests",
]);

const forbiddenSafeBasenameStems = new Set([
  "cache",
  "handoff",
  "intermediate",
  "private",
  "runtime",
  "selftest",
  "session",
  "test",
  "tests",
]);

export const publicSourceTransformations = Object.freeze([
  { path: "CHANGELOG.md", kind: "public-user-changelog" },
  { path: "macos-app/Package.swift", kind: "public-swift-package" },
  { path: "macos-app/Sources/CanvastApp/CanvastApp.swift", kind: "public-swift-app-entry" },
  { path: "macos-app/Sources/CanvastApp/CanvastWorkbenchView.swift", kind: "public-swift-workbench" },
  { path: "scripts/build-macos-app.sh", kind: "public-macos-build" },
  { path: "scripts/public-repo-policy.mjs", kind: "public-policy-self-projection" },
  { path: "scripts/verify-public-release.mjs", kind: "public-release-verifier-tooling-overlay" },
]);

const publicUserChangelog = [
  "# Canvast Changelog / 变更日志",
  "",
  "This public changelog includes only user-visible product changes in the public Canvast experience.",
  "公开版变更日志仅保留 Canvast 对外产品体验中用户可见的变更。",
  "",
  "## [0.1.0] — 2026-09-18",
  "",
  "First public release. / 首个公开发布版本。",
  "",
  "### Added / 新增",
  "- Terminal workspace (TUI) with project-scoped sessions, resume inspection and claim flows, visible request receipts, input queue, request lifecycle, tool runs, runtime events, and approval history.",
  "- 终端工作空间（TUI）：项目级 session、resume 检查与领取流程，以及可见的 request receipt、input queue、request lifecycle、tool runs、runtime events 与 approval history。",
  "- Native SwiftUI macOS App bringing project navigation, recent conversations, resumable work, runtime activity, permissions, plans, and Canvas views into one workspace.",
  "- 原生 SwiftUI macOS App：将项目导航、最近对话、任务恢复、运行活动、权限、计划与 Canvas 视图整合到同一个工作空间中。",
  "- Persistent project Canvas with File, Plan, Decision, and AgentRun nodes, typed links, scoped task and plan selection, and export to JSON, Markdown, Mermaid, SVG, and interactive HTML.",
  "- 持久化项目 Canvas：File、Plan、Decision、AgentRun 节点与 typed link，作用域 task 与 plan 选择，并支持导出 JSON、Markdown、Mermaid、SVG 与交互式 HTML。",
  "- Safety and permission profiles (`read-only`, `workspace-write`, `full-access`) with typed sandbox inspect, profile, grant, and revoke actions recorded with rationale.",
  "- 安全与权限 profile（`read-only`、`workspace-write`、`full-access`），以及带记录理由的 typed sandbox inspect、profile、grant、revoke 操作。",
  "- Published paired-evaluation evidence against Claude Code as the reference toolchain, with machine-checked README evidence blocks and a documented effectiveness boundary.",
  "- 公开以 Claude Code 为参考工具链的配对评估证据，README 证据区块由机器校验，并附有明确的有效性边界说明。",
  "",
  "### Changed / 变更",
  "- Long-running work now shows clearer preparing, queued, running, waiting, completion, cancellation, retry, and recovery states.",
  "- 长时间运行的工作现在提供更清晰的准备、排队、运行、等待、完成、取消、重试与恢复状态。",
  "",
  "### Known issues / 已知问题",
  "- In the published paired evaluation, Canvast's median run latency is higher than the reference toolchain's; the exact measured values are disclosed in `docs/EFFECTIVENESS_EVIDENCE.md` and the README evidence block, and the overhead is recorded as an optimization target for upcoming releases.",
  "- 在已发布的配对评估中，Canvast 的中位运行时长高于参考工具链；具体测量值已在 `docs/EFFECTIVENESS_EVIDENCE.md` 与 README 证据区块中公开，该开销已记录为后续版本的优化目标。",
  "",
].join("\n");

function replaceProjectionBlock(relativePath, source, before, after) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`public projection anchor must occur exactly once in ${relativePath}`);
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

/** Produce deterministic public-only bytes while leaving the development tree intact. */
export function projectPublicSource(relativePath, bytes) {
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes));
  if (![
    "CHANGELOG.md",
    "macos-app/Package.swift",
    "macos-app/Sources/CanvastApp/CanvastApp.swift",
    "macos-app/Sources/CanvastApp/CanvastWorkbenchView.swift",
    "scripts/build-macos-app.sh",
  ].includes(relativePath)) {
    return Buffer.from(input);
  }
  let source = input.toString("utf8");
  if (relativePath === "CHANGELOG.md") {
    source = publicUserChangelog;
  } else if (relativePath === "macos-app/Package.swift") {
    source = replaceProjectionBlock(
      relativePath,
      source,
      '    .executable(name: "CanvastApp", targets: ["CanvastApp"]),\n    .executable(name: "CanvastAppCoreSelfTest", targets: ["CanvastAppCoreSelfTest"])\n',
      '    .executable(name: "CanvastApp", targets: ["CanvastApp"])\n',
    );
    source = replaceProjectionBlock(
      relativePath,
      source,
      '      dependencies: ["CanvastAppCore"]\n    ),\n    .executableTarget(name: "CanvastAppCoreSelfTest", dependencies: ["CanvastAppCore"])\n',
      '      dependencies: ["CanvastAppCore"]\n    )\n',
    );
  } else if (relativePath === "macos-app/Sources/CanvastApp/CanvastApp.swift") {
    const interpolation = "\\";
    source = replaceProjectionBlock(
      relativePath,
      source,
      '    if CommandLine.arguments.contains("--self-test") {\n      do {\n        try CanvastAppSelfTest.run()\n        Foundation.exit(EXIT_SUCCESS)\n      } catch {\n        FileHandle.standardError.write(Data("Canvast app self-test failed: '
        + interpolation + '(error)\\n".utf8))\n        Foundation.exit(EXIT_FAILURE)\n      }\n    }\n',
      "",
    );
    source = replaceProjectionBlock(
      relativePath,
      source,
      "    do {\n      if try UserGuideSnapshotRenderer.runIfRequested(arguments: CommandLine.arguments) {\n        Foundation.exit(EXIT_SUCCESS)\n      }\n    } catch {\n      FileHandle.standardError.write(Data(\"Canvast screenshot generation failed: "
        + interpolation + "(error)\\n\".utf8))\n      Foundation.exit(EXIT_FAILURE)\n    }\n",
      "",
    );
    const installedGUIRuntimeConfigure = "      InstalledGUIAcceptanceRuntime.configure(\n        try InstalledGUIAcceptanceRequest.parse(arguments: CommandLine.arguments)\n      )\n";
    const installedGUIRequestParse = "        try InstalledGUIAcceptanceRequest.parse(arguments: CommandLine.arguments)\n";
    source = replaceProjectionBlock(
      relativePath,
      source,
      installedGUIRuntimeConfigure,
      installedGUIRuntimeConfigure,
    );
    source = replaceProjectionBlock(
      relativePath,
      source,
      installedGUIRequestParse,
      installedGUIRequestParse,
    );
    source = replaceProjectionBlock(
      relativePath,
      source,
      "    do {\n      InstalledGUIAcceptanceRuntime.configure(\n        try InstalledGUIAcceptanceRequest.parse(arguments: CommandLine.arguments)\n      )\n    } catch {\n      FileHandle.standardError.write(\n        Data(\"Canvast installed GUI acceptance argument error: "
        + interpolation + "(error)\\n\".utf8)\n      )\n      Foundation.exit(EXIT_FAILURE)\n    }\n",
      "",
    );
    source = replaceProjectionBlock(
      relativePath,
      source,
      "    let credentialStore: any CanvastCredentialStore = InstalledGUIAcceptanceRuntime.request == nil\n      ? CanvastKeychainCredentialStore()\n      : InstalledGUIAcceptanceCredentialStore()\n",
      "    let credentialStore: any CanvastCredentialStore = CanvastKeychainCredentialStore()\n",
    );
    source = replaceProjectionBlock(
      relativePath,
      source,
      '    if InstalledGUIAcceptanceRuntime.request != nil {\n      InstalledGUIAcceptanceLog.event("ENTRY")\n    }\n',
      "",
    );
    source = replaceProjectionBlock(
      relativePath,
      source,
      '    if InstalledGUIAcceptanceRuntime.request != nil {\n      InstalledGUIAcceptanceLog.event("SCENE")\n    }\n',
      "",
    );
  } else if (relativePath === "macos-app/Sources/CanvastApp/CanvastWorkbenchView.swift") {
    source = replaceProjectionBlock(
      relativePath,
      source,
      "      if let request = InstalledGUIAcceptanceRuntime.request {\n        InstalledGUIAcceptanceProbe(model: model, request: request)\n          .frame(width: 1, height: 1)\n      }\n",
      "",
    );
    source = replaceProjectionBlock(
      relativePath,
      source,
      "      if InstalledGUIAcceptanceRuntime.request != nil {\n        InstalledGUIAcceptanceSurfaceMarker(model: model)\n      }\n",
      "",
    );
  } else if (relativePath === "scripts/build-macos-app.sh") {
    source = replaceProjectionBlock(
      relativePath,
      source,
      "# @brief       Build and sign the internal Canvast macOS application bundle.\n# @description 构建并签名供内部开发者交付的 Canvast macOS 应用包。\n",
      "# @brief       Build and sign the Canvast macOS application bundle.\n# @description 构建并签名 Canvast macOS 应用包。\n",
    );
    source = replaceProjectionBlock(
      relativePath,
      source,
      'say "No-window release App model and persistent RPC self-test"\nCANVAST_APP_SELF_TEST_SOURCE_DIR="$PACKAGE_DIR/Sources/CanvastApp" "$SOURCE_EXECUTABLE" --self-test\n\n',
      "",
    );
  } else if (relativePath === "scripts/public-repo-policy.mjs") {
    source = source.replace(
      '  "macos-app/Sources/CanvastApp/CanvastAppSelfTestActionSettlementTests.swift",\n',
      "",
    );
    source = source.replace(
      '  { path: "scripts/public-repo-policy.mjs", kind: "public-policy-self-projection" },\n',
      "",
    );
  }
  return Buffer.from(source);
}

function normalized(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function basenameStem(basename) {
  const extensionIndex = basename.lastIndexOf(".");
  return extensionIndex > 0 ? basename.slice(0, extensionIndex) : basename;
}

function compactSafeBasename(value) {
  let compact = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code >= 48 && code <= 57) compact += character;
    else if (code >= 65 && code <= 90) compact += character.toLowerCase();
    else if (code >= 97 && code <= 122) compact += character;
  }
  return compact;
}

function matchesForbiddenSafeBasename(basename) {
  const compactStem = compactSafeBasename(basenameStem(basename));
  return forbiddenSafeBasenameStems.has(compactStem)
    || (compactStem.length > "selftest".length && compactStem.endsWith("selftest"));
}

export function isForbiddenPublicPath(relativePath) {
  const segments = relativePath.split("/");
  const basename = segments.at(-1) || "";
  const isInternalReleaseArtifact = segments[0] === "release"
    && segments.some(segment => segment.toLowerCase() === "raw" || segment.toLowerCase() === "internal");
  return forbiddenRelativePaths.has(relativePath)
    || segments.some(segment => forbiddenGeneratedSegments.has(segment))
    || segments.some(segment => forbiddenNestedDevelopmentSegments.has(segment.toLowerCase()))
    || isInternalReleaseArtifact
    || [...forbiddenRelativePrefixes].some(prefix => relativePath === prefix || relativePath.startsWith(`${prefix}/`))
    || forbiddenBasenames.has(basename)
    || matchesForbiddenSafeBasename(basename)
    || basename.endsWith(".pyc")
    || basename.endsWith(".log")
    || basename.endsWith(".zip");
}

/** Expand policy roots to the sorted regular-file projection used by builders and verifiers. */
export function expandAllowedFiles(root, entries, options = {}) {
  const absoluteRoot = path.resolve(root);
  const files = new Set();

  function visit(absolute) {
    const relative = normalized(path.relative(absoluteRoot, absolute));
    if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) {
      throw new Error(`policy entry escapes root: ${absolute}`);
    }
    if (isForbiddenPublicPath(relative)) return;
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`policy entry is a symlink: ${relative}`);
    if (stat.isFile()) { files.add(relative); return; }
    if (!stat.isDirectory()) throw new Error(`policy entry is not a regular file or directory: ${relative}`);
    for (const name of fs.readdirSync(absolute).sort((left, right) => left.localeCompare(right))) {
      visit(path.join(absolute, name));
    }
  }

  for (const entry of entries) {
    const candidate = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    const absolute = path.resolve(absoluteRoot, candidate);
    const relative = normalized(path.relative(absoluteRoot, absolute));
    if (relative !== candidate || !relative || relative.startsWith("../") || path.isAbsolute(relative)) {
      throw new Error(`invalid policy entry: ${entry}`);
    }
    if (!fs.existsSync(absolute)) {
      if (options.allowMissing === true) continue;
      throw new Error(`required policy entry is missing: ${entry}`);
    }
    visit(absolute);
  }
  return [...files].sort((left, right) => left.localeCompare(right));
}
