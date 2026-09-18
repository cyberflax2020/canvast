#!/usr/bin/env node
/**
 * =============================================================================
 * Canvast — Release Source Policy / Canvast source file
 * =============================================================================
 * @file        scripts/release-source-policy.mjs
 * @brief       Defines the non-circular source snapshot used by release proof.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

/**
 * These entries are inputs to product behavior, verification, or release
 * policy. They intentionally omit human-facing and generated evidence so an
 * evaluation, screenshot, or package can bind the manifest without the
 * manifest depending on that output in return.
 */
export const sourceSnapshotEntries = Object.freeze([
  "assets/brand/README.md",
  "assets/brand/asset-manifest.json",
  "assets/brand/canvast-hero.svg",
  "assets/brand/canvast-logo.svg",
  "assets/brand/canvast-logo.tui.txt",
  "components",
  "config-templates",
  "eval-matrix",
  "extensions",
  "macos-app/Config",
  "macos-app/Package.swift",
  "macos-app/Sources",
  "scripts",
  "skills",
  "src",
  "tests",
  ".env.example",
  "THIRD_PARTY_NOTICES.md",
  "VERSION",
  "canvast.sh",
  "package-lock.json",
  "package.json",
  "tsconfig.json",
  "vitest.config.ts",
]);

/** Generated evaluation evidence is never a source-snapshot input. */
export const sourceSnapshotExcludedPrefixes = Object.freeze([
  "eval-matrix/artifacts",
  "eval-matrix/reports",
]);

/** Generated directories and files are excluded even below an allowed root. */
export const sourceSnapshotExcludedSegments = Object.freeze([
  ".build",
  ".build-release",
  ".build-release-app",
  ".canvast-secrets",
  ".git",
  ".pi",
  ".runtime",
  "__pycache__",
  "coverage",
  "dist",
  "node_modules",
  "pi-data",
]);

export const sourceSnapshotExcludedBasenames = Object.freeze([
  ".DS_Store",
]);

export const sourceSnapshotExcludedSuffixes = Object.freeze([
  ".log",
  ".pyc",
  ".zip",
]);

/**
 * These paths are documented here to make the no-cycle boundary auditable.
 * They are already outside sourceSnapshotEntries, except for the explicit
 * eval-matrix exclusions above.
 */
export const derivedReleaseOutputs = Object.freeze([
  "README.md",
  "docs/EFFECTIVENESS_EVIDENCE.md",
  "docs/guides/user-manual.md",
  "docs/assets/user-guide",
  "eval-matrix/artifacts",
  "eval-matrix/reports",
  "release/artifacts",
  "release/license-inventory.json",
  "release/release-manifest.json",
  "release/source-manifest.json",
  "dist",
]);
