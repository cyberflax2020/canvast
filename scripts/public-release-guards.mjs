#!/usr/bin/env node
/**
 * =============================================================================
 * Canvast — Public Release Guards / Canvast source file
 * =============================================================================
 * @file        scripts/public-release-guards.mjs
 * @brief       Shared runtime, license, notice, and secret release policies.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

export const prohibitedPublicLicenseFamilies = Object.freeze([
  "AGPL",
  "BUSL",
  "BSL",
  "GPL",
  "LGPL",
]);

export const thirdPartyNoticeStart = "<!-- CANVAST_LICENSE_INVENTORY_START -->";
export const thirdPartyNoticeEnd = "<!-- CANVAST_LICENSE_INVENTORY_END -->";

export const publicDocumentSchemas = Object.freeze({
  "README.md": Object.freeze({
    h1: "Canvast",
    english: Object.freeze([
      "What is Canvast",
      "Why Canvast",
      "See it in action",
      "Advanced harness capabilities",
      "Measured effectiveness",
      "Get started",
      "Documentation",
      "License",
    ]),
    chinese: Object.freeze([
      "Canvast 是什么",
      "为什么选择 Canvast",
      "界面实录",
      "高级 harness 能力",
      "实测有效性",
      "快速开始",
      "文档导航",
      "许可证",
    ]),
  }),
  "CONTRIBUTING.md": Object.freeze({ h1: "Contributing to Canvast" }),
  "docs/guides/testing.md": Object.freeze({ h1: "Verification and Evidence" }),
  "docs/EFFECTIVENESS_EVIDENCE.md": Object.freeze({
    h1: "Effectiveness Evidence",
    english: Object.freeze([
      "What this document is",
      "Evidence boundary",
      "Current public claims",
      "How to verify",
      "How to read the results",
    ]),
    chinese: Object.freeze([
      "这份文档是什么",
      "证据边界",
      "当前公开声明",
      "如何验证",
      "如何理解结果",
    ]),
  }),
});

export const forbiddenPublicDocumentHeadings = Object.freeze([
  "Development-only policy guards",
  "Resource-safe live and heavy checks",
  "Recovery, retirement, and provenance",
  "Maintainer-only product and release commands",
  "Maintainer-only public release check",
  "Three-surface release evidence / 三形态发布证据",
  "仅开发源码使用的策略守卫",
  "资源安全的 live 与重型检查",
  "恢复、退役与来源核验",
  "仅维护者使用的产品与发布命令",
  "仅维护者使用的公开发布检查",
]);

const forbiddenPublicDocumentWorkflowPhrases = Object.freeze([
  "benchmark phase",
  "closure gate",
  "closure record",
  "delivery gate",
  "handoff",
  "implementation phase",
  "phase 0",
  "phase 1",
  "phase 2",
  "phase 3",
  "phase 4",
  "phase 5",
  "phase 6",
  "phase 7",
  "phase 8",
  "phase 9",
  "product closure",
  "research phase",
  "takeover",
  "产品闭环",
  "交接",
  "接管",
  "阶段 0",
  "阶段 1",
  "阶段 2",
  "阶段 3",
  "阶段 4",
  "阶段 5",
]);

const forbiddenPublicDocumentComparativePhrases = Object.freeze([
  "outperforms",
  "reference evaluation",
  "reference side",
  "superior to",
  "superiority",
  "参考侧",
  "优于",
  "超越",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sortedObject(value) {
  return Object.fromEntries(Object.entries(value || {}).sort(([left], [right]) => left.localeCompare(right)));
}

function normalizeLicense(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "UNKNOWN";
}

function tokenizeSpdxExpression(expression) {
  const tokens = [];
  let index = 0;
  while (index < expression.length) {
    const character = expression[index];
    if (character === " " || character === "\n" || character === "\r" || character === "\t") {
      index += 1;
      continue;
    }
    if (character === "(" || character === ")") {
      tokens.push({ type: character, value: character });
      index += 1;
      continue;
    }
    let end = index;
    while (end < expression.length) {
      const current = expression[end];
      if (current === " " || current === "\n" || current === "\r" || current === "\t" || current === "(" || current === ")") break;
      end += 1;
    }
    const value = expression.slice(index, end);
    const upper = value.toUpperCase();
    tokens.push({ type: upper === "AND" || upper === "OR" || upper === "WITH" ? upper : "LICENSE", value });
    index = end;
  }
  return tokens;
}

function parseSpdxExpression(expression) {
  const tokens = tokenizeSpdxExpression(expression);
  let index = 0;

  function consume(expected) {
    const token = tokens[index];
    if (!token || token.type !== expected) throw new Error(`expected ${expected} at token ${index}`);
    index += 1;
    return token;
  }

  function primary() {
    const token = tokens[index];
    if (!token) throw new Error("unexpected end of expression");
    if (token.type === "(") {
      consume("(");
      const node = orExpression();
      consume(")");
      return node;
    }
    const license = consume("LICENSE").value;
    if (tokens[index]?.type === "WITH") {
      consume("WITH");
      return { type: "WITH", license, exception: consume("LICENSE").value };
    }
    return { type: "LICENSE", license };
  }

  function andExpression() {
    let node = primary();
    while (tokens[index]?.type === "AND") {
      consume("AND");
      node = { type: "AND", left: node, right: primary() };
    }
    return node;
  }

  function orExpression() {
    let node = andExpression();
    while (tokens[index]?.type === "OR") {
      consume("OR");
      node = { type: "OR", left: node, right: andExpression() };
    }
    return node;
  }

  if (tokens.length === 0) throw new Error("empty expression");
  const root = orExpression();
  if (index !== tokens.length) throw new Error(`unexpected trailing token at index ${index}`);
  return root;
}

function prohibitedLicenseIdentifier(identifier) {
  const upper = identifier.toUpperCase();
  return prohibitedPublicLicenseFamilies.some(family => upper === family || upper.startsWith(`${family}-`));
}

function collectProhibitedLicenses(node, findings = new Set()) {
  if (!node || typeof node !== "object") return findings;
  if ((node.type === "LICENSE" || node.type === "WITH") && prohibitedLicenseIdentifier(node.license)) {
    findings.add(node.license);
  } else {
    collectProhibitedLicenses(node.left, findings);
    collectProhibitedLicenses(node.right, findings);
  }
  return findings;
}

export function prohibitedLicensesForSpdxExpression(expression) {
  const normalized = normalizeLicense(expression);
  if (normalized === "UNKNOWN") return [];
  return [...collectProhibitedLicenses(parseSpdxExpression(normalized))]
    .sort((left, right) => left.localeCompare(right));
}

export function createLicenseInventory(lockBytes, generatedAt = new Date().toISOString()) {
  const bytes = Buffer.isBuffer(lockBytes) ? lockBytes : Buffer.from(lockBytes);
  const lock = JSON.parse(bytes.toString("utf8"));
  const packages = [];
  for (const [packagePath, metadata] of Object.entries(lock.packages || {})) {
    if (!packagePath || !metadata || typeof metadata !== "object") continue;
    const license = normalizeLicense(metadata.license);
    const name = typeof metadata.name === "string" ? metadata.name : packagePath.slice("node_modules/".length);
    packages.push({ path: packagePath, name, version: metadata.version || null, license, dev: metadata.dev === true });
  }
  packages.sort((left, right) => left.path.localeCompare(right.path));
  const counts = {};
  for (const entry of packages) counts[entry.license] = (counts[entry.license] || 0) + 1;
  return {
    schemaVersion: 1,
    kind: "npm-lockfile-license-inventory",
    generatedAt,
    source: { path: "package-lock.json", sha256: sha256(bytes), lockfileVersion: lock.lockfileVersion },
    packageCount: packages.length,
    licenseCounts: sortedObject(counts),
    packages,
  };
}

export function licenseInventoryPolicyErrors(document) {
  const findings = [];
  const packages = Array.isArray(document?.packages) ? document.packages : [];
  for (const entry of packages) {
    if (!entry || typeof entry !== "object") continue;
    const label = String(entry.name || entry.path || "<unknown>");
    const license = normalizeLicense(entry.license);
    if (license === "UNKNOWN") {
      findings.push(`package has no license metadata: ${label}`);
      continue;
    }
    try {
      const prohibited = prohibitedLicensesForSpdxExpression(license);
      if (prohibited.length > 0) {
        findings.push(`prohibited license expression for ${label}: ${license} [${prohibited.join(", ")}]`);
      }
    } catch (error) {
      findings.push(`invalid SPDX expression for ${label}: ${license} (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return findings;
}

function directRuntimeDependencies(inventory, packageJson, lock) {
  const declared = sortedObject(packageJson?.dependencies);
  const locked = sortedObject(lock?.packages?.[""]?.dependencies);
  if (JSON.stringify(declared) !== JSON.stringify(locked)) {
    throw new Error("package.json dependencies differ from the package-lock root dependency closure");
  }
  const inventoryByPath = new Map((inventory.packages || []).map(entry => [entry.path, entry]));
  return Object.entries(declared).map(([name, requested]) => {
    const dependencyPath = `node_modules/${name}`;
    const entry = inventoryByPath.get(dependencyPath);
    if (!entry) throw new Error(`direct runtime dependency is missing from the license inventory: ${name}`);
    return { name, requested: String(requested), version: entry.version, license: entry.license };
  });
}

function markdownCell(value) {
  return String(value ?? "UNKNOWN").replaceAll("|", "\\|").replaceAll("`", "\\`");
}

export function renderThirdPartyNoticeRegion(inventory, inventoryBytes, packageJson, lock) {
  const direct = directRuntimeDependencies(inventory, packageJson, lock);
  const lines = [
    thirdPartyNoticeStart,
    "## Machine-Verified Inventory / 机器校验清单",
    "",
    "> This block is generated by `scripts/license-inventory.mjs` from the checked-in",
    "> lockfile and package manifest. Do not edit it by hand.",
    "> 本区块由 `scripts/license-inventory.mjs` 根据已检入的锁文件和包清单生成，请勿手工修改。",
    "",
    `- Inventory SHA-256: \`${sha256(inventoryBytes)}\``,
    `- Package-lock SHA-256: \`${inventory.source.sha256}\``,
    `- Inventory package count: \`${inventory.packageCount}\``,
    `- Direct runtime dependency count: \`${direct.length}\``,
    "",
    "### License Counts / 许可证计数",
    "",
    "| License | Packages |",
    "|---|---:|",
    ...Object.entries(inventory.licenseCounts || {}).map(([license, count]) => `| \`${markdownCell(license)}\` | ${count} |`),
    "",
    "### Direct Runtime Dependencies / 直接运行时依赖",
    "",
    "| Package | Requested | Resolved | License |",
    "|---|---|---|---|",
    ...direct.map(entry => `| \`${markdownCell(entry.name)}\` | \`${markdownCell(entry.requested)}\` | \`${markdownCell(entry.version)}\` | \`${markdownCell(entry.license)}\` |`),
    thirdPartyNoticeEnd,
  ];
  return `${lines.join("\n")}\n`;
}

function noticeMarkerBounds(noticeText) {
  const firstStart = noticeText.indexOf(thirdPartyNoticeStart);
  const secondStart = firstStart < 0 ? -1 : noticeText.indexOf(thirdPartyNoticeStart, firstStart + thirdPartyNoticeStart.length);
  const firstEnd = noticeText.indexOf(thirdPartyNoticeEnd);
  const secondEnd = firstEnd < 0 ? -1 : noticeText.indexOf(thirdPartyNoticeEnd, firstEnd + thirdPartyNoticeEnd.length);
  if (firstStart < 0 || firstEnd < firstStart || secondStart >= 0 || secondEnd >= 0) {
    throw new Error("THIRD_PARTY_NOTICES.md must contain exactly one ordered machine inventory marker pair");
  }
  return { start: firstStart, end: firstEnd + thirdPartyNoticeEnd.length };
}

export function replaceThirdPartyNoticeRegion(noticeText, expectedRegion) {
  if (!noticeText.includes(thirdPartyNoticeStart) && !noticeText.includes(thirdPartyNoticeEnd)) {
    return `${noticeText.trimEnd()}\n\n${expectedRegion}`;
  }
  const bounds = noticeMarkerBounds(noticeText);
  const suffixStart = noticeText[bounds.end] === "\r" && noticeText[bounds.end + 1] === "\n"
    ? bounds.end + 2
    : noticeText[bounds.end] === "\n" ? bounds.end + 1 : bounds.end;
  return `${noticeText.slice(0, bounds.start)}${expectedRegion}${noticeText.slice(suffixStart)}`;
}

export function thirdPartyNoticePolicyErrors(noticeText, inventory, inventoryBytes, packageJson, lock) {
  try {
    const expected = renderThirdPartyNoticeRegion(inventory, inventoryBytes, packageJson, lock);
    const bounds = noticeMarkerBounds(noticeText);
    const actual = `${noticeText.slice(bounds.start, bounds.end)}\n`;
    return actual === expected ? [] : ["THIRD_PARTY_NOTICES.md machine inventory region is stale"];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

function markdownHeadings(text) {
  const headings = [];
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) { fenced = !fenced; continue; }
    if (fenced) continue;
    let level = 0;
    while (line[level] === "#") level += 1;
    if (level < 1 || level > 6 || line[level] !== " ") continue;
    headings.push({ level, title: line.slice(level + 1).trim() });
  }
  return headings;
}

function markdownReadableLines(text) {
  const lines = [];
  let fenced = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    let line = "";
    let inlineCode = false;
    for (const character of rawLine) {
      if (character === "`") {
        inlineCode = !inlineCode;
        continue;
      }
      if (!inlineCode) line += character;
    }
    lines.push(line);
  }
  return lines;
}

function pushDocumentPhraseFindings(relativePath, findings, readableLines, phrases, label) {
  const seen = new Set();
  for (const line of readableLines) {
    const lower = line.toLowerCase();
    for (const phrase of phrases) {
      if (!lower.includes(phrase) || seen.has(phrase)) continue;
      seen.add(phrase);
      findings.push(`${relativePath} contains ${label}: ${phrase}`);
    }
  }
}

export function publicDocumentPolicyErrors(relativePath, text) {
  const findings = [];
  const headings = markdownHeadings(text);
  const readableLines = markdownReadableLines(text);
  const schema = publicDocumentSchemas[relativePath];
  if (schema) {
    if (headings[0]?.level !== 1 || headings[0]?.title !== schema.h1) {
      findings.push(`${relativePath} must start with # ${schema.h1}`);
    }
    const languageHeadings = headings.filter(heading => heading.level === 2).map(heading => heading.title);
    if (JSON.stringify(languageHeadings) !== JSON.stringify(["English", "中文"])) {
      findings.push(`${relativePath} must contain exactly ## English then ## 中文`);
    }
    if (schema.english && schema.chinese) {
      const englishIndex = headings.findIndex(heading => heading.level === 2 && heading.title === "English");
      const chineseIndex = headings.findIndex(heading => heading.level === 2 && heading.title === "中文");
      const english = headings.slice(englishIndex + 1, chineseIndex).filter(heading => heading.level === 3).map(heading => heading.title);
      const chinese = headings.slice(chineseIndex + 1).filter(heading => heading.level === 3).map(heading => heading.title);
      if (JSON.stringify(english) !== JSON.stringify(schema.english)) findings.push(`${relativePath} English product sections are not canonical`);
      if (JSON.stringify(chinese) !== JSON.stringify(schema.chinese)) findings.push(`${relativePath} Chinese product sections are not canonical`);
    }
  }
  for (const heading of headings) {
    if (forbiddenPublicDocumentHeadings.includes(heading.title)) {
      findings.push(`${relativePath} contains source-only heading: ${heading.title}`);
    }
  }
  pushDocumentPhraseFindings(
    relativePath,
    findings,
    readableLines,
    forbiddenPublicDocumentWorkflowPhrases,
    "source-only workflow language",
  );
  pushDocumentPhraseFindings(
    relativePath,
    findings,
    readableLines,
    forbiddenPublicDocumentComparativePhrases,
    "unsupported comparative language",
  );
  return findings;
}

function validRuntimePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0")
    || value.includes("\n") || value.includes("\r") || path.posix.isAbsolute(value)) return false;
  const key = value.endsWith("/") ? value.slice(0, -1) : value;
  return Boolean(key) && path.posix.normalize(key) === key && key !== ".." && !key.startsWith("../");
}

function runtimePathCovered(runtimePath, files, directories) {
  const key = runtimePath.endsWith("/") ? runtimePath.slice(0, -1) : runtimePath;
  if (files.some(entry => (entry.endsWith("/") ? entry.slice(0, -1) : entry) === key)) return true;
  return directories.some(entry => {
    const directory = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    return key === directory || key.startsWith(`${directory}/`);
  });
}

export function publicRuntimePolicyErrors(options) {
  const {
    root, publicDirectoryEntries, publicFileEntries, publicEvidenceEntries, npmFileEntries,
    publicPackageScripts, publicRuntimeDependencies, isForbiddenPublicPath,
  } = options;
  const findings = [];
  if (!publicRuntimeDependencies || typeof publicRuntimeDependencies !== "object") {
    return ["publicRuntimeDependencies must be an object"];
  }
  const runtimeKeys = Object.keys(publicRuntimeDependencies).sort();
  if (JSON.stringify(runtimeKeys) !== JSON.stringify(["entrypoints", "packageScripts"])) {
    findings.push("publicRuntimeDependencies keys must be exactly entrypoints and packageScripts");
  }
  const expectedScripts = Object.keys(publicPackageScripts || {}).sort();
  const runtimeScripts = Object.keys(publicRuntimeDependencies.packageScripts || {}).sort();
  if (JSON.stringify(expectedScripts) !== JSON.stringify(runtimeScripts)) {
    findings.push(`runtime packageScripts keys differ from publicPackageScripts: expected ${expectedScripts.join(", ")}; got ${runtimeScripts.join(", ")}`);
  }

  const closures = [
    ...Object.entries(publicRuntimeDependencies.entrypoints || {}).map(([name, dependencies]) => ["entrypoint", name, dependencies]),
    ...Object.entries(publicRuntimeDependencies.packageScripts || {}).map(([name, dependencies]) => ["package script", name, dependencies]),
  ];
  const runtimePaths = new Set();
  for (const [kind, name, dependencies] of closures) {
    if (kind === "entrypoint") runtimePaths.add(name);
    if (!Array.isArray(dependencies) || dependencies.length === 0) {
      findings.push(`${kind} ${name} must declare a non-empty runtime dependency closure`);
      continue;
    }
    if (new Set(dependencies).size !== dependencies.length) findings.push(`${kind} ${name} has duplicate runtime dependencies`);
    for (const dependency of dependencies) runtimePaths.add(dependency);
  }

  const npmDirectories = npmFileEntries.filter(entry => entry.endsWith("/"));
  // npm always includes package.json even when it is omitted from package.json#files.
  const npmFiles = ["package.json", ...npmFileEntries.filter(entry => !entry.endsWith("/"))];
  for (const runtimePath of [...runtimePaths].sort((left, right) => String(left).localeCompare(String(right)))) {
    if (!validRuntimePath(runtimePath)) {
      findings.push(`runtime dependency is not a canonical relative path: ${String(runtimePath)}`);
      continue;
    }
    const key = runtimePath.endsWith("/") ? runtimePath.slice(0, -1) : runtimePath;
    if (isForbiddenPublicPath(key)) findings.push(`runtime dependency is forbidden by public policy: ${runtimePath}`);
    if (!runtimePathCovered(runtimePath, [...publicFileEntries, ...publicEvidenceEntries], publicDirectoryEntries)) {
      findings.push(`runtime dependency is outside the public policy: ${runtimePath}`);
    }
    if (!runtimePathCovered(runtimePath, npmFiles, npmDirectories)) {
      findings.push(`runtime dependency is outside the npm policy: ${runtimePath}`);
    }
    if (!root) continue;
    const absolute = path.join(root, key);
    if (!fs.existsSync(absolute)) {
      findings.push(`runtime dependency is missing: ${runtimePath}`);
      continue;
    }
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) findings.push(`runtime dependency must not be a symlink: ${runtimePath}`);
    else if (runtimePath.endsWith("/") && !stat.isDirectory()) findings.push(`runtime dependency must be a directory: ${runtimePath}`);
    else if (!runtimePath.endsWith("/") && !stat.isFile()) findings.push(`runtime dependency must be a regular file: ${runtimePath}`);
  }
  for (const entrypoint of Object.keys(publicRuntimeDependencies.entrypoints || {})) {
    if (!root || !validRuntimePath(entrypoint)) continue;
    const absolute = path.join(root, entrypoint);
    if (fs.existsSync(absolute) && fs.lstatSync(absolute).isFile() && (fs.statSync(absolute).mode & 0o111) === 0) {
      findings.push(`runtime entrypoint must be executable: ${entrypoint}`);
    }
  }
  return findings;
}

export function assertPublicPackageRuntimeClosure(packageJson, publicPackageScripts, publicRuntimeDependencies) {
  const findings = [];
  if (JSON.stringify(packageJson?.scripts) !== JSON.stringify(publicPackageScripts)) {
    findings.push("package.json scripts differ from the public-safe script set");
  }
  const advertised = Object.keys(publicPackageScripts || {}).sort();
  const declared = Object.keys(publicRuntimeDependencies?.packageScripts || {}).sort();
  if (JSON.stringify(advertised) !== JSON.stringify(declared)) {
    findings.push("package.json script keys do not have an exact publicRuntimeDependencies closure");
  }
  return findings;
}

const knownSecretPatterns = Object.freeze([
  ["private key block", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  ["AWS access key", /(?:^|[^A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?:$|[^A-Z0-9])/],
  ["GitHub token", /(?:^|[^A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})(?:$|[^A-Za-z0-9_])/],
  ["GitLab token", /(?:^|[^A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}(?:$|[^A-Za-z0-9_-])/],
  ["Google API key", /(?:^|[^A-Za-z0-9])AIza[0-9A-Za-z_-]{35}(?:$|[^A-Za-z0-9_-])/],
  ["npm token", /(?:^|[^A-Za-z0-9])npm_[A-Za-z0-9]{36}(?:$|[^A-Za-z0-9])/],
  ["Slack token", /(?:^|[^A-Za-z0-9])xox[baprs]-[0-9A-Za-z-]{20,}(?:$|[^0-9A-Za-z-])/],
  ["SendGrid API key", /(?:^|[^A-Za-z0-9])SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}(?:$|[^A-Za-z0-9_-])/],
  ["live Stripe key", /(?:^|[^A-Za-z0-9])(?:sk|rk)_live_[A-Za-z0-9]{16,}(?:$|[^A-Za-z0-9])/],
  ["provider API token", /(?:^|[^A-Za-z0-9])sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}(?:$|[^A-Za-z0-9_-])/],
]);

function entropy(value) {
  const frequencies = new Map();
  for (const character of value) frequencies.set(character, (frequencies.get(character) || 0) + 1);
  let result = 0;
  for (const count of frequencies.values()) {
    const probability = count / value.length;
    result -= probability * Math.log2(probability);
  }
  return result;
}

function likelyPlaceholder(value) {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith("$") || trimmed.includes("process.env") || trimmed.includes("os.environ")) return true;
  if ((trimmed.startsWith("<") && trimmed.endsWith(">")) || (trimmed.startsWith("{{") && trimmed.endsWith("}}"))) return true;
  const compact = trimmed.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!compact || /^(?:x+|0+)$/.test(compact)) return true;
  return /^(?:example|sample|dummy|fake|fixture|test|placeholder|replace|changeme|redacted|unset|notset|your|stringvalue)/.test(compact)
    || compact.includes("insertkey") || compact.includes("minimumlength");
}

function highEntropyCredential(value) {
  if (value.length < 20 || value.length > 512 || likelyPlaceholder(value)) return false;
  const unique = new Set(value).size;
  if (unique < 10) return false;
  if (/^[0-9a-f]+$/i.test(value)) return value.length >= 32 && entropy(value) >= 3.4;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(pattern => pattern.test(value)).length;
  return classes >= 2 && entropy(value) >= 4;
}

function likelyRuntimeCredentialExpression(value) {
  const trimmed = value.trim();
  if (/^[A-Za-z_$][\w$]*\((?:"[^"\r\n]*"|'[^'\r\n]*')\)$/.test(trimmed)) return true;
  if (/^(?:this|opts|options|config|settings|credentials|input)\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(trimmed)) return true;
  if (/^[A-Za-z_$][\w$]*\.getApiKey\([A-Za-z_$][\w$]*\)$/.test(trimmed)) return true;
  if (/^(?:key|credential|token|secret|apiKey|authToken)$/.test(trimmed)) return true;
  return false;
}

function likelyBundledRuntimeCredentialVariableAssignment(text, index, key) {
  if (key !== "apikey") return false;
  const line = lineAt(text, index).trim();
  if (/^const\s+apiKey\s*=\s*getEnvApiKey\(\s*model\.provider\s*,\s*options\?\.env\s*\)\s*;?$/.test(line)) {
    return true;
  }
  if (/^auth\s*:\s*\{\s*apiKey\s*:\s*cloudflare(?:AIGateway|WorkersAI)Auth\(\s*\)\s*\}\s*,?$/.test(line)) {
    return true;
  }
  return /^(?:auth\s*:\s*\{\s*)?apiKey\s*:\s*envApiKeyAuth\(\s*"[^"\r\n]*(?:API key|token)"\s*,\s*\[\s*"[A-Z][A-Z0-9_]*(?:_API_KEY|_TOKEN)"\s*\]\s*\)\s*,?\s*\}?\s*,?$/.test(line);
}

function likelyBundledRuntimeCredentialNameConstantAssignment(text, index, key, value) {
  if (key !== "secret_key" || value !== "AWS_SECRET_KEY") return false;
  const line = lineAt(text, index).trim();
  return /^(?:readonly\s+)?AWS_SECRET_KEY\s*:\s*["']AWS_SECRET_KEY["']\s*[,;]?$/.test(line);
}

function lineAt(text, index) {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  const next = text.indexOf("\n", index);
  const end = next === -1 ? text.length : next;
  return text.slice(start, end);
}

function likelyBundledRuntimeDeclarationSecretPatternExample(text, index, matchedValue, label) {
  if (label !== "AWS access key") return false;
  const line = lineAt(text, index).trimStart();
  if (!line.startsWith("*")) return false;
  if (!/^(?:AKIA|ASIA)[0-9A-Z]{16}$/.test(matchedValue) || !matchedValue.includes("EXAMPLE")) return false;
  return new RegExp(`\\bAccessKeyId\\s*:\\s*["']${matchedValue}["']`).test(line);
}

function likelyBundledRuntimeDeclarationExample(text, index, value) {
  const line = lineAt(text, index).trimStart();
  if (!line.startsWith("*")) return false;
  const trimmed = value.trim();
  const compact = value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (compact === "STRINGVALUE") return true;
  if (compact.includes("EXAMPLE")
    && /(?:CLIENTID|CLIENTSECRET|ACCESSTOKEN|REFRESHTOKEN|DEVICECODE|TOKEN|SECRET|KEY)$/.test(compact)) {
    return true;
  }
  return /^VERYLONGSECRET[A-Za-z0-9_+/=-]{24,}$/.test(trimmed);
}

function assignedCredentialFindings(text, options = {}) {
  const findings = [];
  // Regex is intentionally limited to syntactic credential assignments; semantic policy does not depend on it.
  const assignment = /["']?(api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?key|private[_-]?key|password|passwd)["']?\s*[:=]\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s,;#}\]]+))/gi;
  let match;
  while ((match = assignment.exec(text)) !== null) {
    const value = String(match[2] ?? match[3] ?? match[4] ?? "").trim();
    if (likelyPlaceholder(value)) continue;
    const quoted = match[2] !== undefined || match[3] !== undefined;
    const key = match[1].toLowerCase();
    if (!quoted && options.allowRuntimeExpressions
      && (likelyRuntimeCredentialExpression(value)
        || likelyBundledRuntimeCredentialVariableAssignment(text, match.index, key))) continue;
    if (quoted && options.allowRuntimeExpressions
      && likelyBundledRuntimeCredentialNameConstantAssignment(text, match.index, key, value)) continue;
    if (quoted && options.allowBundledRuntimeDeclarationExamples
      && likelyBundledRuntimeDeclarationExample(text, match.index, value)) continue;
    if (highEntropyCredential(value)) findings.push(`high-entropy value assigned to ${key}`);
    else if (quoted && value.length >= 12 && (key.includes("secret") || key.includes("password") || key.includes("private"))) {
      findings.push(`literal credential assigned to ${key}`);
    }
  }
  return findings;
}

function decodedText(bytes) {
  if (bytes.includes(0)) return undefined;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return undefined; }
}

function containsPersonalAbsolutePath(text) {
  for (const root of ["/Users/", "/home/"]) {
    let cursor = text.indexOf(root);
    while (cursor >= 0) {
      const start = cursor + root.length;
      let end = start;
      while (end < text.length) {
        const code = text.charCodeAt(end);
        const isDigit = code >= 48 && code <= 57;
        const isUpper = code >= 65 && code <= 90;
        const isLower = code >= 97 && code <= 122;
        const isSafePunctuation = text[end] === "." || text[end] === "_" || text[end] === "-";
        if (!(isDigit || isUpper || isLower || isSafePunctuation)) break;
        end += 1;
      }
      if (end > start && text[end] === "/") return true;
      cursor = text.indexOf(root, start);
    }
  }
  return false;
}

const runtimeScanProfiles = Object.freeze(new Set(["strict", "bundled-third-party-runtime"]));

function secretPatternFindings(searchable, options) {
  const findings = [];
  const allowDeclarationExamples = options.allowBundledRuntimeDeclarationExamples === true;
  for (const [label, pattern] of options.patterns) {
    if (allowDeclarationExamples && label === "AWS access key") {
      const matcher = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
      let blocked = false;
      let match;
      while ((match = matcher.exec(searchable)) !== null) {
        const matchedValue = /(?:AKIA|ASIA)[0-9A-Z]{16}/.exec(match[0])?.[0] || "";
        if (!likelyBundledRuntimeDeclarationSecretPatternExample(searchable, match.index, matchedValue, label)) {
          blocked = true;
          break;
        }
      }
      if (blocked) findings.push(label);
      continue;
    }
    if (pattern.test(searchable)) findings.push(label);
  }
  return findings;
}

export function scanPublicReleaseFile(bytes, options = {}) {
  const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const text = decodedText(value);
  const binaryProfile = options.binaryProfile || "strict";
  const textProfile = options.textProfile || "strict";
  if (!runtimeScanProfiles.has(binaryProfile)) {
    throw new Error(`unknown binary privacy scan profile: ${String(binaryProfile)}`);
  }
  if (!runtimeScanProfiles.has(textProfile)) {
    throw new Error(`unknown text privacy scan profile: ${String(textProfile)}`);
  }
  // Binary files are allowed, but their printable ASCII strings still pass the
  // deterministic signature and assignment checks. Entropy is never computed
  // over arbitrary binary bytes, which avoids flagging compressed media.
  const searchable = text ?? value.toString("latin1").replace(/[^\x09\x0a\x0d\x20-\x7e]/g, "\n");
  const findings = [];
  const isBundledThirdPartyRuntimeBinary = text === undefined && binaryProfile === "bundled-third-party-runtime";
  const isBundledThirdPartyRuntimeText = text !== undefined && textProfile === "bundled-third-party-runtime";
  const patterns = isBundledThirdPartyRuntimeBinary
    ? knownSecretPatterns.filter(([label]) => label === "private key block")
    : knownSecretPatterns;
  findings.push(...secretPatternFindings(searchable, {
    patterns,
    allowBundledRuntimeDeclarationExamples: options.allowBundledRuntimeDeclarationExamples === true,
  }));
  if (!isBundledThirdPartyRuntimeBinary) {
    findings.push(...assignedCredentialFindings(searchable, {
      allowRuntimeExpressions: isBundledThirdPartyRuntimeText,
      allowBundledRuntimeDeclarationExamples: options.allowBundledRuntimeDeclarationExamples === true,
    }));
  }
  if (containsPersonalAbsolutePath(searchable)) findings.push("personal absolute path");
  return { binary: text === undefined, text, findings: [...new Set(findings)] };
}
