/**
 * =============================================================================
 * Canvast — Component Verifier / 组件校验器
 * =============================================================================
 * @file        src/harness/component-verifier.ts
 * @brief       Verifies bundled search components before they enter PATH or UI.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const COMPONENT_NAMES = ["fd", "rg"] as const;
export type ComponentName = typeof COMPONENT_NAMES[number];

interface TrustedArtifact {
  version?: unknown;
  sha256?: unknown;
  format?: unknown;
  arch?: unknown;
}

interface ComponentEntry {
  path?: unknown;
}

interface ComponentManifest {
  components?: Partial<Record<ComponentName, ComponentEntry>>;
  trustedArtifacts?: Partial<Record<ComponentName, Record<string, TrustedArtifact>>>;
}

export interface ComponentVerification {
  name: ComponentName;
  path?: string;
  trusted: boolean;
  reason: string;
  version?: string;
}

export interface ComponentPackVerification {
  trusted: boolean;
  binDir?: string;
  components: ComponentVerification[];
}

export interface ComponentVerifierOptions {
  installDir: string;
  componentsDir?: string;
  platform?: string;
  arch?: string;
}

function fail(name: ComponentName, reason: string, componentPath?: string): ComponentVerification {
  return { name, path: componentPath, trusted: false, reason };
}

function insideProject(projectDir: string, target: string): boolean {
  const relative = path.relative(projectDir, target);
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function containsSymlink(projectDir: string, target: string): boolean {
  let current = target;
  while (insideProject(projectDir, current)) {
    if (fs.lstatSync(current).isSymbolicLink()) return true;
    current = path.dirname(current);
  }
  return false;
}

function trustedArtifactFor(
  manifest: ComponentManifest,
  name: ComponentName,
  platformKey: string,
): TrustedArtifact | undefined {
  return manifest.trustedArtifacts?.[name]?.[platformKey] ?? manifest.trustedArtifacts?.[name]?.any;
}

function validatePlatform(
  artifact: TrustedArtifact,
  platformName: string,
  architecture: string,
): string | undefined {
  const declaredArch = typeof artifact.arch === "string" ? artifact.arch : "";
  const declaredFormat = typeof artifact.format === "string" ? artifact.format : "";
  if (!declaredFormat) return "trusted artifact format is missing";
  if (declaredArch === "architecture-neutral") {
    return declaredFormat === "script" ? undefined : "architecture-neutral artifacts must use script format";
  }
  if (declaredArch !== architecture) return `architecture mismatch: expected ${architecture}, manifest declares ${declaredArch || "missing"}`;
  if (declaredFormat !== "native") return `architecture-specific artifacts must use native format, got ${declaredFormat}`;
  const declaredPlatform = typeof (artifact as Record<string, unknown>).platform === "string"
    ? String((artifact as Record<string, unknown>).platform)
    : "";
  if (declaredPlatform !== platformName) {
    return `platform mismatch: expected ${platformName}, manifest declares ${declaredPlatform || "missing"}`;
  }
  return undefined;
}

function nativeArchitecture(bytes: Buffer, platformName: string): string | undefined {
  if (platformName === "darwin" && bytes.length >= 8) {
    const magic = bytes.readUInt32LE(0);
    if (magic !== 0xfeedfacf) return undefined;
    const cpuType = bytes.readUInt32LE(4);
    if (cpuType === 0x0100000c) return "arm64";
    if (cpuType === 0x01000007) return "x64";
  }
  if (platformName === "linux" && bytes.length >= 20 && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    const machine = bytes.readUInt16LE(18);
    if (machine === 183) return "arm64";
    if (machine === 62) return "x64";
  }
  if (platformName === "win32" && bytes.length >= 64 && bytes.readUInt16LE(0) === 0x5a4d) {
    const peOffset = bytes.readUInt32LE(60);
    if (peOffset + 6 > bytes.length || bytes.toString("ascii", peOffset, peOffset + 4) !== "PE\u0000\u0000") return undefined;
    const machine = bytes.readUInt16LE(peOffset + 4);
    if (machine === 0xaa64) return "arm64";
    if (machine === 0x8664) return "x64";
  }
  return undefined;
}

function verifyOne(
  manifest: ComponentManifest,
  name: ComponentName,
  projectDir: string,
  platformName: string,
  architecture: string,
): ComponentVerification {
  const relativePath = manifest.components?.[name]?.path;
  if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath)) {
    return fail(name, "manifest path is missing or not project-relative");
  }
  const componentPath = path.resolve(projectDir, relativePath);
  if (!insideProject(projectDir, componentPath)) return fail(name, "manifest path escapes the install directory", componentPath);
  try {
    if (containsSymlink(projectDir, componentPath)) return fail(name, "component path contains a symlink", componentPath);
    const stat = fs.statSync(componentPath);
    if (!stat.isFile()) return fail(name, "component is not a regular file", componentPath);
    if (platformName !== "win32" && (stat.mode & 0o111) === 0) {
      return fail(name, "component is not executable", componentPath);
    }
  } catch {
    return fail(name, "component file is missing or unreadable", componentPath);
  }

  const platformKey = `${platformName}-${architecture}`;
  const artifact = trustedArtifactFor(manifest, name, platformKey);
  if (!artifact) return fail(name, `no trusted artifact for ${platformKey} or any`, componentPath);
  const platformFailure = validatePlatform(artifact, platformName, architecture);
  if (platformFailure) return fail(name, platformFailure, componentPath);

  const bytes = fs.readFileSync(componentPath);
  const expectedHash = typeof artifact.sha256 === "string" ? artifact.sha256 : "";
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (expectedHash.length !== 64 || actualHash !== expectedHash) return fail(name, "sha256 mismatch", componentPath);
  if (artifact.format === "script" && (bytes[0] !== 0x23 || bytes[1] !== 0x21)) {
    return fail(name, "script artifact is missing a shebang", componentPath);
  }
  if (artifact.format === "native") {
    const actualArch = nativeArchitecture(bytes, platformName);
    if (actualArch !== architecture) {
      return fail(name, `binary architecture mismatch: expected ${architecture}, got ${actualArch || "unknown"}`, componentPath);
    }
  }

  const versionResult = spawnSync(componentPath, ["--version"], { encoding: "utf8" });
  if (versionResult.error || versionResult.status !== 0) return fail(name, "component version command failed", componentPath);
  const versionOutput = `${versionResult.stdout || ""}${versionResult.stderr || ""}`.trim();
  const actualVersion = (versionOutput.split("\n")[0] || "").replaceAll("\r", "");
  const expectedVersion = typeof artifact.version === "string" ? artifact.version : "";
  if (!expectedVersion || actualVersion !== expectedVersion) return fail(name, "exact version mismatch", componentPath);
  return { name, path: componentPath, trusted: true, reason: "verified", version: actualVersion };
}

export function verifyComponentPack(options: ComponentVerifierOptions): ComponentPackVerification {
  const projectDir = path.resolve(options.installDir);
  const componentsDir = path.resolve(options.componentsDir ?? path.join(projectDir, "components"));
  const manifestPath = path.join(componentsDir, "component-manifest.json");
  let manifest: ComponentManifest;
  try {
    if (!insideProject(projectDir, manifestPath) || containsSymlink(projectDir, manifestPath)) {
      throw new Error("manifest path is unsafe");
    }
    const stat = fs.statSync(manifestPath);
    if (!stat.isFile()) throw new Error("manifest is not a regular file");
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ComponentManifest;
  } catch (error) {
    const reason = `component manifest unavailable or unsafe: ${error instanceof Error ? error.message : String(error)}`;
    return { trusted: false, components: COMPONENT_NAMES.map(name => fail(name, reason)) };
  }

  const platformName = options.platform ?? process.platform;
  const architecture = options.arch ?? process.arch;
  const components = COMPONENT_NAMES.map(name => verifyOne(manifest, name, projectDir, platformName, architecture));
  const trusted = components.every(component => component.trusted);
  const paths = components.map(component => component.path);
  const binDir = trusted && paths.every(Boolean) && paths.every(componentPath => path.dirname(componentPath!) === path.dirname(paths[0]!))
    ? path.dirname(paths[0]!)
    : undefined;
  return { trusted, binDir, components };
}
