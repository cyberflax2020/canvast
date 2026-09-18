/**
 * =============================================================================
 * Canvast — Skill Registry / Canvast 源文件
 * =============================================================================
 * @file        src/harness/skill-registry.ts
 * @brief       Resolves Canvast-managed custom skills from an explicit manifest.
 * @description Keeps bundled custom skills discoverable without injecting them
 *              by default or letting them collide with native Canvast behavior.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type CanvastSkillActivation = "explicit";

export interface CanvastSkillManifestEntry {
  name: string;
  path: string;
  activation: CanvastSkillActivation;
  defaultEnabled: boolean;
  allowImplicitInvocation: boolean;
  license: string;
  licenseFile: string;
  provenance: string;
}

export interface CanvastSkillManifest {
  version: 1;
  skills: CanvastSkillManifestEntry[];
}

export interface CanvastSkillArgs {
  forwardedArgs: string[];
  skillArgs: string[];
  requestedSkills: string[];
  errors: string[];
}

const SKILL_FLAG_NAMES = new Set(["--canvast-skill", "--canvest-skill"]);
const SKILL_FLAG_PREFIXES = ["--canvast-skill=", "--canvest-skill="];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSkillName(value: string): boolean {
  if (!value || value.length > 64) return false;
  for (const char of value) {
    const code = char.charCodeAt(0);
    const digit = code >= 48 && code <= 57;
    const lower = code >= 97 && code <= 122;
    if (!digit && !lower && char !== "-") return false;
  }
  return !value.startsWith("-") && !value.endsWith("-") && !value.includes("--");
}

function normalizedSkillNames(value: string): string[] {
  const names: string[] = [];
  for (const part of value.split(",")) {
    const name = part.trim();
    if (name) names.push(name);
  }
  return names;
}

function normalizeRelative(value: string): string {
  return value.replaceAll("\\", "/");
}

function baseName(value: string): string {
  const parts = normalizeRelative(value).split("/").filter(Boolean);
  return parts.at(-1) || "";
}

function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isIgnoredSkillAuxiliaryName(name: string): boolean {
  return name === "manifest.json" || name === ".DS_Store" || name === "__pycache__";
}

function detectUnmanagedSkillDirectories(installDir: string, manifest: CanvastSkillManifest): string[] {
  const skillsRoot = path.join(installDir, "skills");
  if (!fs.existsSync(skillsRoot) || !fs.statSync(skillsRoot).isDirectory()) return [];
  const managed = new Set(manifest.skills.map(entry => entry.name));
  const unexpected: string[] = [];
  for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
    if (isIgnoredSkillAuxiliaryName(entry.name) || entry.isSymbolicLink()) continue;
    if (!entry.isDirectory()) continue;
    if (managed.has(entry.name)) continue;
    const candidate = path.join(skillsRoot, entry.name);
    const markerFiles = [
      path.join(candidate, "SKILL.md"),
      path.join(candidate, "agents", "openai.yaml"),
    ];
    if (markerFiles.some(file => fs.existsSync(file))) {
      unexpected.push(`skills/${entry.name}`);
    }
  }
  return unexpected.sort((left, right) => left.localeCompare(right));
}

function parseManifestEntry(value: unknown): CanvastSkillManifestEntry | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.name !== "string" ||
    typeof value.path !== "string" ||
    value.activation !== "explicit" ||
    typeof value.defaultEnabled !== "boolean" ||
    typeof value.allowImplicitInvocation !== "boolean" ||
    typeof value.license !== "string" ||
    typeof value.licenseFile !== "string" ||
    typeof value.provenance !== "string"
  ) return undefined;
  return {
    name: value.name,
    path: value.path,
    activation: value.activation,
    defaultEnabled: value.defaultEnabled,
    allowImplicitInvocation: value.allowImplicitInvocation,
    license: value.license,
    licenseFile: value.licenseFile,
    provenance: value.provenance,
  };
}

export function skillManifestPath(installDir: string): string {
  return path.join(installDir, "skills", "manifest.json");
}

export function readCanvastSkillManifest(installDir: string): CanvastSkillManifest {
  const file = skillManifestPath(installDir);
  const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.skills)) {
    throw new Error(`Invalid Canvast skill manifest: ${file}`);
  }
  const skills = parsed.skills.map(parseManifestEntry);
  if (skills.some(item => !item)) {
    throw new Error(`Invalid Canvast skill manifest entry: ${file}`);
  }
  return {
    version: 1,
    skills: skills as CanvastSkillManifestEntry[],
  };
}

export function validateCanvastSkillManifest(installDir: string): string[] {
  const errors: string[] = [];
  let manifest: CanvastSkillManifest;
  try {
    manifest = readCanvastSkillManifest(installDir);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }

  const names = new Set<string>();
  for (const entry of manifest.skills) {
    if (!isSkillName(entry.name)) errors.push(`invalid skill name: ${entry.name}`);
    if (names.has(entry.name)) errors.push(`duplicate skill name: ${entry.name}`);
    names.add(entry.name);
    if (entry.defaultEnabled) errors.push(`${entry.name}: defaultEnabled must be false`);
    if (entry.allowImplicitInvocation) errors.push(`${entry.name}: allowImplicitInvocation must be false`);
    const relativePath = normalizeRelative(entry.path);
    if (path.isAbsolute(relativePath) || relativePath.includes("../") || relativePath === "..") {
      errors.push(`${entry.name}: path must stay within the Canvast package`);
      continue;
    }
    if (!relativePath.startsWith("skills/")) {
      errors.push(`${entry.name}: path must live under skills/`);
      continue;
    }
    if (baseName(relativePath) !== entry.name) {
      errors.push(`${entry.name}: path directory name must match skill name`);
      continue;
    }
    const skillDir = path.resolve(installDir, relativePath);
    if (!pathInside(path.resolve(installDir), skillDir)) {
      errors.push(`${entry.name}: resolved path escapes the Canvast package`);
      continue;
    }
    if (!fs.existsSync(path.join(skillDir, "SKILL.md"))) errors.push(`${entry.name}: missing SKILL.md`);
    if (!fs.existsSync(path.join(skillDir, "agents", "openai.yaml"))) errors.push(`${entry.name}: missing agents/openai.yaml`);
    const licensePath = path.resolve(installDir, normalizeRelative(entry.licenseFile));
    if (!pathInside(path.resolve(installDir), licensePath)) errors.push(`${entry.name}: license file escapes the Canvast package`);
    else if (!fs.existsSync(licensePath)) errors.push(`${entry.name}: missing license file ${entry.licenseFile}`);
  }
  for (const relative of detectUnmanagedSkillDirectories(installDir, manifest)) {
    errors.push(`unmanaged skill directory is present outside skills/manifest.json: ${relative}`);
  }
  return errors;
}

export function splitCanvastSkillArgs(userArgs: string[], installDir: string): CanvastSkillArgs {
  const forwardedArgs: string[] = [];
  const requestedSkills: string[] = [];
  const errors: string[] = [];

  for (let i = 0; i < userArgs.length; i++) {
    const arg = userArgs[i];
    if (SKILL_FLAG_NAMES.has(arg)) {
      const value = userArgs[i + 1];
      if (!value) errors.push(`${arg} requires a skill name from skills/manifest.json`);
      else {
        requestedSkills.push(...normalizedSkillNames(value));
        i += 1;
      }
      continue;
    }
    const prefix = SKILL_FLAG_PREFIXES.find(item => arg.startsWith(item));
    if (prefix) {
      requestedSkills.push(...normalizedSkillNames(arg.slice(prefix.length)));
      continue;
    }
    forwardedArgs.push(arg);
  }

  if (requestedSkills.length === 0) return { forwardedArgs, skillArgs: [], requestedSkills, errors };

  let manifest: CanvastSkillManifest | undefined;
  try {
    manifest = readCanvastSkillManifest(installDir);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const skillArgs: string[] = [];
  const emitted = new Set<string>();
  const byName = new Map((manifest?.skills || []).map(entry => [entry.name, entry]));
  for (const name of requestedSkills) {
    if (!isSkillName(name)) {
      errors.push(`invalid Canvast skill name: ${name}`);
      continue;
    }
    const entry = byName.get(name);
    if (!entry) {
      errors.push(`unknown Canvast skill: ${name}`);
      continue;
    }
    if (entry.defaultEnabled || entry.allowImplicitInvocation || entry.activation !== "explicit") {
      errors.push(`${name}: Canvast-managed skills must be explicit-only`);
      continue;
    }
    const skillPath = path.resolve(installDir, normalizeRelative(entry.path));
    if (!pathInside(path.resolve(installDir), skillPath)) {
      errors.push(`${name}: resolved path escapes the Canvast package`);
      continue;
    }
    if (!emitted.has(name)) {
      skillArgs.push("--skill", skillPath);
      emitted.add(name);
    }
  }

  return { forwardedArgs, skillArgs, requestedSkills, errors };
}
