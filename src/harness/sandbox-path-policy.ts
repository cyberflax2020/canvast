/**
 * =============================================================================
 * Canvast — Sandbox Path Policy / Canvast 沙箱路径策略
 * =============================================================================
 * @file        src/harness/sandbox-path-policy.ts
 * @brief       Canonical path checks and macOS Seatbelt path rules.
 * @description Keeps lexical and canonical protected-path enforcement aligned
 *              across shell preflight and the generated operating-system
 *              sandbox profile. / 统一 shell 预检与系统沙箱中的词法及真实路径保护。
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type ProtectedPathKind =
  | "dependency-tree"
  | "environment"
  | "development-vars"
  | "vcs-metadata"
  | "private-key"
  | "secret-file"
  | "credentials"
  | "ssh"
  | "cloud-credentials"
  | "github-config"
  | "canvast-secrets";

export interface ProtectedReadAssessment {
  lexicalPath: string;
  canonicalPath: string;
  kinds: ProtectedPathKind[];
  protectedPaths: string[];
}

interface SbplProtectedPathRule {
  kind: ProtectedPathKind;
  expression: string;
}

interface InlineProgramRule {
  commands: readonly string[];
  options: readonly string[];
}

export interface ResolvedCommandOperand {
  lexicalPath: string;
  canonicalPath: string;
}

// These are audited filesystem-name filters for Apple's Seatbelt profile.
// Command meaning is handled by the typed shell analysis in sandbox.ts.
const protectedPathSbplRules: readonly SbplProtectedPathRule[] = [
  { kind: "environment", expression: String.raw`(^|/)\.env($|rc$|\.(?!example$)[^/]*)` },
  { kind: "development-vars", expression: String.raw`(^|/)\.dev\.vars$` },
  { kind: "dependency-tree", expression: String.raw`(^|/)node_modules(/|$)` },
  { kind: "vcs-metadata", expression: String.raw`(^|/)\.git(/|$)` },
  { kind: "private-key", expression: String.raw`\.(pem|key)$` },
  { kind: "private-key", expression: String.raw`(^|/)id_(rsa|ed25519|ecdsa)$` },
  { kind: "ssh", expression: String.raw`(^|/)\.ssh(/|$)` },
  { kind: "secret-file", expression: String.raw`(^|/)[Ss][Ee][Cc][Rr][Ee][Tt][Ss]?\.(json|ya?ml|toml)$` },
  { kind: "credentials", expression: String.raw`[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll][Ss]` },
  { kind: "cloud-credentials", expression: String.raw`(^|/)\.aws(/|$)` },
  { kind: "github-config", expression: String.raw`(^|/)\.config/gh(/|$)` },
  { kind: "canvast-secrets", expression: String.raw`(^|/)\.canvast-secrets(/|$)` },
];

const inlineProgramRules: readonly InlineProgramRule[] = [
  { commands: ["python", "python3", "bash", "sh", "zsh"], options: ["-c"] },
  { commands: ["node", "deno", "bun"], options: ["-e", "--eval"] },
  { commands: ["perl", "ruby"], options: ["-e"] },
];

export function canonical(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    let dir = path.dirname(resolved);
    const missing = [path.basename(resolved)];
    while (dir && path.dirname(dir) !== dir && !fs.existsSync(dir)) {
      missing.unshift(path.basename(dir));
      dir = path.dirname(dir);
    }
    try {
      return path.join(fs.realpathSync.native(dir), ...missing);
    } catch {
      return resolved;
    }
  }
}

export function samePath(a: string, b: string): boolean {
  return canonical(a) === canonical(b);
}

export function uniqueCanonical(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const next = canonical(value);
    if (!out.some(existing => samePath(existing, next))) out.push(next);
  }
  return out;
}

export function uniqueCanonicalPathRequests<T extends { kind: string; value: string }>(
  requests: readonly T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const request of requests) {
    const value = request.kind.endsWith("_path") ? canonical(request.value) : request.value;
    const key = `${request.kind}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...request, value });
  }
  return out;
}

export function isPathInside(child: string, parent: string): boolean {
  const rel = path.relative(canonical(parent), canonical(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function protectedPathKinds(filePath: string): ProtectedPathKind[] {
  const normalized = filePath.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  const basename = segments.at(-1)?.toLowerCase() || "";
  const lowered = segments.map(segment => segment.toLowerCase());
  const envFile = basename === ".env" || basename === ".envrc" ||
    (basename.startsWith(".env.") && basename !== ".env.example");
  const privateKey = basename === "id_rsa" || basename === "id_ed25519" || basename === "id_ecdsa";
  const secretFile = ["secret.json", "secret.yml", "secret.yaml", "secret.toml",
    "secrets.json", "secrets.yml", "secrets.yaml", "secrets.toml"].includes(basename);
  const ghConfig = lowered.some((segment, index) => segment === ".config" && lowered[index + 1] === "gh");
  const kinds = new Set<ProtectedPathKind>();
  if (envFile) kinds.add("environment");
  if (basename === ".dev.vars") kinds.add("development-vars");
  if (basename.endsWith(".pem") || basename.endsWith(".key") || privateKey) kinds.add("private-key");
  if (secretFile) kinds.add("secret-file");
  if (normalized.toLowerCase().includes("credentials")) kinds.add("credentials");
  if (ghConfig) kinds.add("github-config");
  for (const segment of lowered) {
    if (segment === "node_modules") kinds.add("dependency-tree");
    else if (segment === ".git") kinds.add("vcs-metadata");
    else if (segment === ".ssh") kinds.add("ssh");
    else if (segment === ".aws") kinds.add("cloud-credentials");
    else if (segment === ".canvast-secrets") kinds.add("canvast-secrets");
  }
  return Array.from(kinds);
}

export function isProtectedPath(filePath: string): boolean {
  return protectedPathKinds(filePath).length > 0;
}

export function assessProtectedRead(
  requestedPath: string,
  trustedReadRoots: readonly string[] = [],
): ProtectedReadAssessment {
  const lexicalPath = path.resolve(requestedPath);
  const canonicalPath = canonical(lexicalPath);
  const kinds = new Set([
    ...protectedPathKinds(lexicalPath),
    ...protectedPathKinds(canonicalPath),
  ]);
  const trusted = trustedReadRoots.some(root => isPathInside(canonicalPath, root));
  if (trusted) kinds.delete("dependency-tree");
  return {
    lexicalPath,
    canonicalPath,
    kinds: Array.from(kinds),
    protectedPaths: kinds.size > 0
      ? Array.from(new Set([lexicalPath, canonicalPath]))
      : [],
  };
}

function isAsciiDigit(value: string): boolean {
  return value >= "0" && value <= "9";
}

function hasUriScheme(value: string): boolean {
  const separator = value.indexOf("://");
  if (separator <= 0) return false;
  const scheme = value.slice(0, separator).toLowerCase();
  return [...scheme].every((char, index) =>
    (char >= "a" && char <= "z") ||
    (index > 0 && (isAsciiDigit(char) || char === "+" || char === "." || char === "-")));
}

function isRedirectOperator(value: string): boolean {
  const operator = isAsciiDigit(value[0] || "") ? value.slice(1) : value;
  return operator === "<" || operator === ">" || operator === ">>" || operator === "&>";
}

function hasAttachedOutputRedirect(value: string): boolean {
  const operatorIndex = isAsciiDigit(value[0] || "") ? 1 : 0;
  return value.startsWith("&>", operatorIndex) ||
    value.startsWith(">>", operatorIndex) ||
    value.startsWith(">", operatorIndex);
}

export function resolveCommandOperand(token: string, cwd: string): ResolvedCommandOperand | undefined {
  if (!token || token === "-" || token.startsWith("-")) return undefined;
  const descriptor = token.startsWith("&") ? token.slice(1) : token;
  if (hasUriScheme(token) || (descriptor.length > 0 && [...descriptor].every(isAsciiDigit)) || token === "/dev/null") {
    return undefined;
  }
  const lexicalPath = token.startsWith("~")
    ? path.resolve(path.join(os.homedir(), token.slice(1)))
    : path.resolve(cwd, token);
  const pathShaped = path.isAbsolute(token) || token.startsWith(".") || token.includes("/") ||
    fs.existsSync(lexicalPath) || isProtectedPath(lexicalPath);
  return pathShaped ? { lexicalPath, canonicalPath: canonical(lexicalPath) } : undefined;
}

export function shellReadOperands(tokens: readonly string[]): string[] {
  const operands: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (isRedirectOperator(token)) {
      index += 1;
      continue;
    }
    if (token === "--" || token.startsWith("-") || hasAttachedOutputRedirect(token)) continue;
    operands.push(token);
  }
  return operands;
}

export function hasUnresolvedInlineProgram(commandName: string, tokens: readonly string[]): boolean {
  const normalized = commandName.toLowerCase();
  const rule = inlineProgramRules.find(candidate => candidate.commands.includes(normalized));
  return Boolean(rule?.options.some(option => tokens.includes(option)));
}

function escapeSbplString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

export function renderSbplPath(kind: "subpath" | "literal", value: string): string {
  return renderResolvedSbplPath(kind, canonical(value));
}

function renderResolvedSbplPath(kind: "subpath" | "literal", value: string): string {
  return `(${kind} "${escapeSbplString(value)}")`;
}

function lexicalAndCanonicalPaths(values: readonly string[]): string[] {
  return Array.from(new Set(values.flatMap(value => [path.resolve(value), canonical(value)])));
}

function renderSbplRegex(value: string): string {
  return `(regex #"${value.replaceAll("\"", "\\\"")}")`;
}

export function renderProtectedReadRules(
  protectedPaths: readonly string[],
  trustedReadRoots: readonly string[],
  grantedReadPaths: readonly string[],
  commandApproved: boolean,
): string[] {
  const allDenyFilters = [
    ...protectedPathSbplRules.map(rule => renderSbplRegex(rule.expression)),
    ...Array.from(new Set(protectedPaths)).map(value => `(literal "${escapeSbplString(value)}")`),
  ];
  const trustedFilters = lexicalAndCanonicalPaths(trustedReadRoots)
    .map(value => renderResolvedSbplPath("subpath", value));
  const sensitiveDenyFilters = [
    ...protectedPathSbplRules
      .filter(rule => rule.kind !== "dependency-tree")
      .map(rule => renderSbplRegex(rule.expression)),
    ...Array.from(new Set(protectedPaths)).map(value => `(literal "${escapeSbplString(value)}")`),
  ];
  const grantedFilters = uniqueCanonical([...grantedReadPaths]).map(value => renderSbplPath("subpath", value));
  const rules = commandApproved ? [] : [`(deny file-read* ${allDenyFilters.join(" ")})`];
  if (trustedFilters.length) {
    rules.push(`(allow file-read* ${trustedFilters.join(" ")})`);
    rules.push(`(deny file-read* ${sensitiveDenyFilters.join(" ")})`);
  }
  if (grantedFilters.length) rules.push(`(allow file-read* ${grantedFilters.join(" ")})`);
  return rules;
}

export function renderProtectedWriteRule(): string {
  const denyFilters = protectedPathSbplRules.map(rule => renderSbplRegex(rule.expression));
  return `(deny file-write* ${denyFilters.join(" ")})`;
}
