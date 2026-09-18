#!/usr/bin/env node
/**
 * =============================================================================
 * Canvast — Resolve Canvast Skill / Canvast 源文件
 * =============================================================================
 * @file        scripts/resolve-canvast-skill.mjs
 * @brief       Resolves explicitly requested Canvast-managed custom skills.
 * @description Shell entrypoint helper for mapping --canvast-skill names to
 *              manifest-approved skill paths without default skill injection.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import fs from "node:fs";
import path from "node:path";

const [, , installDirArg, namesArg] = process.argv;

function fail(message) {
  console.error(`Canvast skill error: ${message}`);
  process.exit(2);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSkillName(value) {
  if (!value || value.length > 64) return false;
  for (const char of value) {
    const code = char.charCodeAt(0);
    const digit = code >= 48 && code <= 57;
    const lower = code >= 97 && code <= 122;
    if (!digit && !lower && char !== "-") return false;
  }
  return !value.startsWith("-") && !value.endsWith("-") && !value.includes("--");
}

function normalizeRelative(value) {
  return value.split("\\").join("/");
}

function pathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function splitSkillNames(value) {
  return value.split(",").map(item => item.trim()).filter(Boolean);
}

if (!installDirArg || !namesArg) fail("usage: resolve-canvast-skill.mjs <install-dir> <skill-name[,skill-name]>");

const installDir = path.resolve(installDirArg);
const manifestPath = path.join(installDir, "skills", "manifest.json");
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
} catch (error) {
  fail(`cannot read skills/manifest.json: ${error instanceof Error ? error.message : String(error)}`);
}

if (!isRecord(manifest) || manifest.version !== 1 || !Array.isArray(manifest.skills)) {
  fail("invalid skills/manifest.json");
}

const byName = new Map();
for (const entry of manifest.skills) {
  if (!isRecord(entry) || typeof entry.name !== "string") continue;
  byName.set(entry.name, entry);
}

const emitted = new Set();
for (const name of splitSkillNames(namesArg)) {
  if (!isSkillName(name)) fail(`invalid skill name: ${name}`);
  const entry = byName.get(name);
  if (!entry) fail(`unknown Canvast skill: ${name}`);
  if (entry.activation !== "explicit" || entry.defaultEnabled !== false || entry.allowImplicitInvocation !== false) {
    fail(`${name}: Canvast-managed skills must be explicit-only`);
  }
  if (typeof entry.path !== "string" || typeof entry.licenseFile !== "string") {
    fail(`${name}: manifest entry is incomplete`);
  }
  const skillPath = path.resolve(installDir, normalizeRelative(entry.path));
  if (!pathInside(installDir, skillPath)) fail(`${name}: skill path escapes the Canvast package`);
  if (!fs.existsSync(path.join(skillPath, "SKILL.md"))) fail(`${name}: missing SKILL.md`);
  if (!fs.existsSync(path.join(skillPath, "agents", "openai.yaml"))) fail(`${name}: missing agents/openai.yaml`);
  const licensePath = path.resolve(installDir, normalizeRelative(entry.licenseFile));
  if (!pathInside(installDir, licensePath)) fail(`${name}: license path escapes the Canvast package`);
  if (!fs.existsSync(licensePath)) fail(`${name}: missing license file`);
  if (!emitted.has(name)) {
    console.log(skillPath);
    emitted.add(name);
  }
}
