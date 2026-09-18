/**
 * =============================================================================
 * Canvast — Sandbox / Canvast 源文件
 * =============================================================================
 * @file        src/harness/sandbox.ts
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readRuntimeStatus, updateRuntimePermission, type RuntimePermissionSource } from "./runtime-status.js";
import { buildSandboxChildEnvironment } from "./sandbox-child-env.js";
import {
  commandReferencesExecutableScript,
  contextualCommandFingerprint,
} from "./sandbox-command-identity.js";
import {
  normalizePermissionMode,
  normalizeSandboxProfile,
  splitSandboxArgs,
  truthy,
  type CanvastPermissionMode,
  type CanvastSandboxProfile,
} from "./sandbox-config.js";
import {
  getSandboxGrantStore,
  type SandboxGrant,
  type SandboxGrantKind,
  type SandboxGrantRevokeReceipt,
  type SandboxGrantScope,
  type SandboxGrantSnapshot,
  type SandboxGrantStore,
} from "./sandbox-grant-store.js";
import {
  captureSandboxPathIdentity,
  sameSandboxPathIdentity,
  type SandboxPathIdentity,
} from "./sandbox-path-identity.js";
import {
  assessProtectedRead,
  canonical,
  hasUnresolvedInlineProgram,
  isPathInside,
  isProtectedPath,
  renderProtectedReadRules,
  renderProtectedWriteRule,
  renderSbplPath,
  resolveCommandOperand,
  samePath,
  shellReadOperands,
  uniqueCanonical,
  uniqueCanonicalPathRequests,
} from "./sandbox-path-policy.js";
export { isPathInside, isProtectedPath } from "./sandbox-path-policy.js";
export {
  normalizePermissionMode,
  normalizeSandboxProfile,
  splitSandboxArgs,
} from "./sandbox-config.js";
export { commandFingerprint } from "./sandbox-command-identity.js";
export type {
  CanvastPermissionMode,
  CanvastSandboxProfile,
  SplitSandboxArgsResult,
} from "./sandbox-config.js";
export type SandboxDecisionAction = "allow" | "confirm" | "block";
export type SandboxSeverity = "info" | "caution" | "critical";
export type {
  SandboxGrant,
  SandboxGrantKind,
  SandboxGrantRevokeReceipt,
  SandboxGrantScope,
  SandboxGrantSnapshot,
} from "./sandbox-grant-store.js";

export interface SandboxCommandAnalysis {
  command: string;
  commandName?: string;
  commandNames: string[];
  visibleWritePaths: string[];
  visibleReadPaths: string[];
  protectedReadPaths: string[];
  mutatesCwd: boolean;
  categories: string[];
  hardBlock: boolean;
  dangerousReason?: string;
}
export interface SandboxDecision {
  action: SandboxDecisionAction;
  profile: CanvastSandboxProfile;
  severity: SandboxSeverity;
  reason: string;
  commandFingerprint?: string;
  categories: string[];
  writePaths: string[];
  readPaths: string[];
  protectedReadPaths?: string[];
  missingGrants: Array<{ kind: SandboxGrantKind; value: string }>;
  approvedOnceGrants?: Array<{
    kind: SandboxGrantKind;
    value: string;
    pathIdentity?: SandboxPathIdentity;
  }>;
}
export interface CanvastSandboxConfig {
  profile: CanvastSandboxProfile;
  permissionMode: CanvastPermissionMode;
  permissionSource: RuntimePermissionSource;
  unattended: boolean;
  useOsSandbox: boolean;
  assumeOsSandbox: boolean;
  network: "enabled" | "disabled";
  promptTimeoutMs: number;
  agentDir: string;
  projectRoot: string;
  workingDir: string;
  writableRoots: string[];
  trustedReadRoots: string[];
  tempRoots: string[];
  dependencyCacheRoot: string;
  platform: NodeJS.Platform;
  sandboxExecPath: string;
  persistenceMode: "persistent" | "ephemeral";
}
export interface ResolveSandboxConfigOptions {
  env?: NodeJS.ProcessEnv;
  agentDir?: string;
  projectRoot?: string;
  workingDir?: string;
  platform?: NodeJS.Platform;
}
export interface SandboxAutoResolution {
  action: "approve" | "block";
  scope?: Extract<SandboxGrantScope, "session">;
  reason: string;
}
const DEFAULT_PROMPT_TIMEOUT_MS = 30_000;

const HARD_BLOCK_COMMANDS = [
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, desc: "fork bomb" },
  { pattern: /\bmkfs(?:\.[\w-]+)?\b/, desc: "filesystem format" },
  { pattern: /\bdiskutil\s+(erase|partition|apfs\s+delete)/i, desc: "disk erase or partition" },
  { pattern: /\bdd\b[\s\S]*\bof=\/dev\/(?:disk|sd|rdisk)/i, desc: "raw device write" },
  { pattern: />\s*\/dev\/(?:disk|sd|rdisk)/i, desc: "raw device overwrite" },
  { pattern: /\bkill\s+-9\s+-1\b/, desc: "kill all processes" },
  { pattern: /\b(shutdown|reboot|halt)\b/i, desc: "system shutdown" },
];

const CONFIRM_COMMANDS = [
  { pattern: /\brm\s+(-[^\s]*r|--recursive)\b/i, desc: "recursive delete" },
  { pattern: /\bsudo\b/i, desc: "privileged command" },
  { pattern: /\b(chmod|chown)\b[\s\S]*\b777\b/i, desc: "world-writable permission change" },
  { pattern: /\bgit\s+push\b[\s\S]*\s(?:-f|--force)(?:\s|$)/i, desc: "force push" },
  { pattern: /\bgit\s+reset\s+--hard\b/i, desc: "hard reset" },
  { pattern: /\bnpm\s+unpublish\b/i, desc: "package unpublish" },
  { pattern: /\bdocker\s+rm\s+-f\b/i, desc: "force remove containers" },
  { pattern: /\b(?:curl|wget)\b[\s\S]*\|\s*(?:sh|bash|zsh)\b/i, desc: "downloaded script execution" },
  { pattern: /\blaunchctl\s+(load|bootstrap|enable)\b/i, desc: "launch service modification" },
  { pattern: /\bcrontab\s+[^-\s]/i, desc: "cron table replacement" },
];

const AUTO_BLOCK_CATEGORIES = new Set([
  "dangerous",
  "hard-danger",
  "protected-path",
  "protected-read",
  "unresolved-read-set",
  "outside-workspace-write",
  "read-only-write",
  "unbounded-search",
]);

const SHELL_OPERATORS = new Set(["|", "||", "&", "&&", ";"]);
const FILE_WRITE_TOOLS = new Set(["write", "edit", "notebook_edit"]);
const WRITE_ALL_OPERANDS = new Set(["touch", "mkdir", "rm", "rmdir", "unlink"]);
const WRITE_DESTINATION_COMMANDS = new Set(["cp", "mv", "ln", "install", "rsync"]);
const MUTATES_CWD_PATTERNS = [
  /^npm:(install|i|add|update|ci)$/,
  /^pnpm:(install|add|update)$/,
  /^yarn:(install|add|upgrade)$/,
  /^bun:(install|add)$/,
  /^pip:(install|uninstall)$/,
  /^uv:(add|remove|sync|pip)$/,
  /^cargo:(build|test|run|update|add|remove)$/,
  /^go:(get|mod|build|test)$/,
  /^git:(commit|checkout|switch|merge|rebase|cherry-pick|pull|clean|reset)$/,
];

function resolveMaybePath(token: string, cwd: string): string | undefined {
  return resolveCommandOperand(token, cwd)?.canonicalPath;
}

function userFacingPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return resolved.startsWith("/private/var/") ? resolved.slice("/private".length) : resolved;
}

export function splitShellTokens(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;

  const push = () => {
    if (current) tokens.push(current);
    current = "";
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    if ((ch === ">" || ch === "<") && next === ">") {
      push();
      tokens.push(`${ch}${next}`);
      i += 1;
      continue;
    }
    if ((ch === ">" || ch === "<" || ch === "|" || ch === "&" || ch === ";")) {
      if ((ch === "|" || ch === "&") && next === ch) {
        push();
        tokens.push(`${ch}${next}`);
        i += 1;
      } else {
        push();
        tokens.push(ch);
      }
      continue;
    }
    if (/\d/.test(ch) && (next === ">" || next === "<")) {
      push();
      tokens.push(`${ch}${next}`);
      i += 1;
      continue;
    }
    current += ch;
  }
  push();
  return tokens;
}

function commandSegments(tokens: string[]): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  for (const token of tokens) {
    if (SHELL_OPERATORS.has(token)) {
      if (current.length) segments.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length) segments.push(current);
  return segments;
}

function nonOptionArgs(tokens: string[]): string[] {
  return tokens.filter(token => token !== "--" && !token.startsWith("-"));
}

function hasSearchBound(tokens: string[]): boolean {
  return tokens.some(token =>
    /^(?:--max-count|-m|--max-filesize|--files-with-matches|-l|--count|-c)$/.test(token) ||
    /^-(?:m|l|c|[A-Za-z]*m\d*)/.test(token) ||
    /^--max-count=/.test(token),
  );
}

function excludesLargeSearchDirs(tokens: string[]): boolean {
  const joined = tokens.join(" ");
  return /(?:--exclude(?:-dir)?|-E|-g|--glob)\s+['"]?(?:node_modules|\.runtime|\.git)(?:['"]?|\/|\b)/.test(joined) ||
    /--glob\s+['"]?!\{?(?:node_modules|\.runtime|\.git)/.test(joined) ||
    /(?:^|\s)grep\s+-v\s+['"]?(?:node_modules|\.runtime|\.git)/.test(joined);
}

function isBroadSearchTarget(token: string): boolean {
  return token === "." || token === "./" || token === "" || token === "*";
}

function isRecursiveSearchSegment(cmd: string, rest: string[], args: string[]): boolean {
  if (cmd === "find") return args.some(isBroadSearchTarget);
  if (!["grep", "rg"].includes(cmd)) return false;
  const recursive = cmd === "rg" || rest.some(token => /^-[A-Za-z]*r[A-Za-z]*$/.test(token) || token === "--recursive");
  return recursive && args.some(isBroadSearchTarget);
}

function addPath(targets: Set<string>, token: string | undefined, cwd: string): void {
  if (!token) return;
  const resolved = resolveMaybePath(token, cwd);
  if (resolved) targets.add(resolved);
}

function addReadPath(
  targets: Set<string>,
  protectedTargets: Set<string>,
  token: string | undefined,
  cwd: string,
  trustedReadRoots: readonly string[],
): void {
  if (!token) return;
  const resolved = resolveCommandOperand(token, cwd);
  if (!resolved) return;
  targets.add(resolved.canonicalPath);
  const assessment = assessProtectedRead(resolved.lexicalPath, trustedReadRoots);
  for (const protectedPath of assessment.protectedPaths) protectedTargets.add(protectedPath);
}

function commandKey(cmd: string | undefined, sub: string | undefined): string {
  return `${cmd || ""}:${sub || ""}`.toLowerCase();
}

export function classifyDangerousCommand(command: string): { hardBlock: boolean; desc?: string } {
  for (const rule of HARD_BLOCK_COMMANDS) {
    if (rule.pattern.test(command)) return { hardBlock: true, desc: rule.desc };
  }
  for (const rule of CONFIRM_COMMANDS) {
    if (rule.pattern.test(command)) return { hardBlock: false, desc: rule.desc };
  }
  return { hardBlock: false };
}

export function analyzeBashCommand(
  command: string,
  cwd = process.cwd(),
  trustedReadRoots: readonly string[] = [],
): SandboxCommandAnalysis {
  const tokens = splitShellTokens(command);
  const visibleWritePaths = new Set<string>();
  const visibleReadPaths = new Set<string>();
  const lexicalProtectedReads = new Set<string>();
  const categories = new Set<string>();
  const commandNames: string[] = [];
  let commandName: string | undefined;
  let mutatesCwd = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (/^(?:\d?>|>|>>|&>)$/.test(token)) {
      addPath(visibleWritePaths, tokens[i + 1], cwd);
      i += 1;
    } else if (/^(?:\d?<|<)$/.test(token)) {
      addReadPath(visibleReadPaths, lexicalProtectedReads, tokens[i + 1], cwd, trustedReadRoots);
      i += 1;
    } else if (/^(?:\d?>>?|&>)(.+)$/.test(token)) {
      const operand = token.replace(/^(?:\d?>>?|&>)/, "");
      addPath(visibleWritePaths, operand, cwd);
    }
  }

  for (const segment of commandSegments(tokens)) {
    const first = segment.find(token => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
    if (!first) continue;
    const cmd = path.basename(first);
    commandName ||= cmd;
    if (!commandNames.includes(cmd)) commandNames.push(cmd);
    const rest = segment.slice(segment.indexOf(first) + 1);
    const args = nonOptionArgs(rest);
    addReadPath(visibleReadPaths, lexicalProtectedReads, first, cwd, trustedReadRoots);
    for (const arg of shellReadOperands(rest)) {
      addReadPath(visibleReadPaths, lexicalProtectedReads, arg, cwd, trustedReadRoots);
    }
    if (hasUnresolvedInlineProgram(cmd, rest)) categories.add("unresolved-read-set");
    if (WRITE_ALL_OPERANDS.has(cmd)) {
      categories.add("visible-write");
      for (const arg of args) addPath(visibleWritePaths, arg, cwd);
    }
    if (WRITE_DESTINATION_COMMANDS.has(cmd) && args.length) {
      categories.add("visible-write");
      addPath(visibleWritePaths, args[args.length - 1], cwd);
    }
    if (cmd === "tee") {
      categories.add("visible-write");
      for (const arg of args) addPath(visibleWritePaths, arg, cwd);
    }
    if ((cmd === "sed" && rest.some(arg => /^-.*i/.test(arg))) || (cmd === "perl" && rest.some(arg => /^-.*i/.test(arg)))) {
      categories.add("in-place-edit");
      for (const arg of args.slice(1)) addPath(visibleWritePaths, arg, cwd);
    }
    if (MUTATES_CWD_PATTERNS.some(pattern => pattern.test(commandKey(cmd, rest[0])))) {
      categories.add("cwd-mutation");
      mutatesCwd = true;
      visibleWritePaths.add(canonical(cwd));
    }
    if (isRecursiveSearchSegment(cmd, rest, args) && (!hasSearchBound(rest) || !excludesLargeSearchDirs(rest))) {
      categories.add("unbounded-search");
    }
  }

  const dangerous = classifyDangerousCommand(command);
  if (commandReferencesExecutableScript(tokens, cwd)) categories.add("indirect-execution");
  if (lexicalProtectedReads.size > 0) categories.add("protected-read");
  if (dangerous.desc) categories.add(dangerous.hardBlock ? "hard-danger" : "dangerous");

  return {
    command,
    commandName,
    commandNames,
    visibleWritePaths: Array.from(visibleWritePaths),
    visibleReadPaths: Array.from(visibleReadPaths),
    protectedReadPaths: Array.from(lexicalProtectedReads),
    mutatesCwd,
    categories: Array.from(categories),
    hardBlock: dangerous.hardBlock,
    dangerousReason: dangerous.desc,
  };
}

export function resolveSandboxConfig(options: ResolveSandboxConfigOptions = {}): CanvastSandboxConfig {
  const env = options.env ?? process.env;
  const workingDir = canonical(options.workingDir || env.CANVAST_WORKING_DIR || process.cwd());
  const projectRoot = canonical(options.projectRoot || env.CANVAST_PROJECT_ROOT || workingDir);
  const agentDir = canonical(options.agentDir || env.PI_CODING_AGENT_DIR || path.join(env.HOME || os.homedir() || os.tmpdir(), ".canvast"));
  const platform = options.platform || process.platform;
  const profile = normalizeSandboxProfile(env.CANVAST_SANDBOX || env.CANVAST_SANDBOX_MODE) || "workspace-write";
  const configuredPermissionMode = normalizePermissionMode(env.CANVAST_PERMISSION_MODE);
  const legacyAutoApprove = truthy(env.CANVAST_AUTO_APPROVE);
  const permissionMode = configuredPermissionMode || (legacyAutoApprove ? "auto" : "ask");
  const permissionSource: RuntimePermissionSource = configuredPermissionMode || legacyAutoApprove ? "env" : "default";
  const promptTimeoutMs = Number.isFinite(Number(env.CANVAST_PERMISSION_PROMPT_TIMEOUT_MS))
    ? Math.max(1_000, Number(env.CANVAST_PERMISSION_PROMPT_TIMEOUT_MS))
    : DEFAULT_PROMPT_TIMEOUT_MS;
  const tempRoots = uniqueCanonical([
    os.tmpdir(),
    env.TMPDIR || "",
    "/tmp",
    "/private/tmp",
  ].filter(Boolean));
  const dependencyCacheRoot = canonical(env.CANVAST_DEPENDENCY_CACHE_ROOT || path.join(agentDir, "dependency-cache"));
  const extraWritableRoots = String(env.CANVAST_SANDBOX_WRITABLE_ROOTS || "")
    .split(path.delimiter)
    .map(item => item.trim())
    .filter(Boolean);
  const trustedReadRoots = String(env.CANVAST_SANDBOX_TRUSTED_READ_ROOTS || "")
    .split(path.delimiter)
    .map(item => item.trim())
    .filter(Boolean);
  return {
    profile,
    permissionMode,
    permissionSource,
    unattended: truthy(env.CANVAST_UNATTENDED),
    useOsSandbox: !truthy(env.CANVAST_DISABLE_OS_SANDBOX),
    assumeOsSandbox: truthy(env.CANVAST_ASSUME_OS_SANDBOX),
    network: String(env.CANVAST_SANDBOX_NETWORK || "").trim().toLowerCase() === "enabled" &&
      !truthy(env.CANVAST_SANDBOX_DISABLE_NETWORK)
      ? "enabled"
      : "disabled",
    promptTimeoutMs,
    agentDir,
    projectRoot,
    workingDir,
    writableRoots: uniqueCanonical([projectRoot, workingDir, ...extraWritableRoots]),
    trustedReadRoots: uniqueCanonical(trustedReadRoots),
    tempRoots,
    dependencyCacheRoot,
    platform,
    sandboxExecPath: env.CANVAST_SANDBOX_EXEC || "/usr/bin/sandbox-exec",
    persistenceMode: env.CANVAST_PERSISTENCE_MODE === "ephemeral" ? "ephemeral" : "persistent",
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export class CanvastSandboxController {
  private config: CanvastSandboxConfig;
  private grantStore: SandboxGrantStore;
  private onceCommandGrants = new Map<string, Array<{
    kind: SandboxGrantKind;
    value: string;
    pathIdentity?: SandboxPathIdentity;
  }>>();
  private sessionProfile?: CanvastSandboxProfile;
  private osSandboxAvailable?: boolean;

  constructor(config: CanvastSandboxConfig = resolveSandboxConfig()) {
    this.config = config;
    fs.mkdirSync(this.config.dependencyCacheRoot, { recursive: true });
    this.grantStore = getSandboxGrantStore(config.agentDir, config.persistenceMode);
    this.persistPermissionMode(config.permissionMode, config.permissionSource);
  }

  getConfig(): CanvastSandboxConfig {
    return {
      ...this.config, profile: this.profile(), permissionMode: this.permissionMode(),
      unattended: this.isUnattended(),
    };
  }

  profile(): CanvastSandboxProfile {
    return this.sessionProfile || this.config.profile;
  }

  permissionMode(): CanvastPermissionMode {
    try {
      const mode = readRuntimeStatus(this.config.agentDir).permission.mode;
      return mode || this.config.permissionMode;
    } catch {
      return this.config.permissionMode;
    }
  }

  isUnattended(): boolean {
    try {
      return readRuntimeStatus(this.config.agentDir).permission.unattended;
    } catch {
      return this.config.unattended;
    }
  }

  dependencyInstallEnv(base: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return buildSandboxChildEnvironment(base, this.config.dependencyCacheRoot);
  }

  setSessionProfile(profile: CanvastSandboxProfile): void {
    this.sessionProfile = profile;
  }

  setPermissionMode(
    mode: CanvastPermissionMode,
    source: RuntimePermissionSource = "command",
    unattended = this.config.unattended,
  ): void {
    this.config = { ...this.config, unattended };
    this.persistPermissionMode(mode, source);
  }

  resolveAutoDecision(decision: SandboxDecision): SandboxAutoResolution {
    if (decision.action !== "confirm") {
      return { action: "approve", scope: "session", reason: "Decision does not require approval." };
    }
    const blockedCategory = decision.categories.find(category => AUTO_BLOCK_CATEGORIES.has(category));
    if (decision.severity === "critical" || blockedCategory) {
      return {
        action: "block",
        reason: blockedCategory
          ? `Auto permission mode does not prompt for ${blockedCategory}; the agent must choose a safer bounded action or request an explicit grant.`
          : "Auto permission mode does not prompt for critical sandbox decisions.",
      };
    }
    return {
      action: "approve",
      scope: "session",
      reason: "Auto permission mode approved a routine sandbox expansion without interrupting the session.",
    };
  }

  grants(): SandboxGrant[] {
    return this.grantSnapshot().grants;
  }

  grantSnapshot(): SandboxGrantSnapshot {
    return this.grantStore.snapshot();
  }

  revokeGrant(grantId: string, expectedRevision: number): SandboxGrantRevokeReceipt {
    return this.grantStore.revoke({ grantId, expectedRevision });
  }

  decideBash(command: string, cwd = this.config.workingDir): SandboxDecision {
    const profile = this.profile();
    const analysis = analyzeBashCommand(command, cwd, this.config.trustedReadRoots);
    const fingerprint = contextualCommandFingerprint({
      command,
      cwd,
      commandTokens: splitShellTokens(command),
      readPaths: analysis.visibleReadPaths,
      writePaths: analysis.visibleWritePaths,
      profile,
      network: this.config.network,
      writableRoots: this.config.writableRoots,
      trustedReadRoots: this.config.trustedReadRoots,
    });
    const missing: Array<{ kind: SandboxGrantKind; value: string }> = [];
    const presentMissing = (): Array<{ kind: SandboxGrantKind; value: string }> =>
      uniqueCanonicalPathRequests(missing).map(request => ({
        ...request,
        value: request.kind === "read_path" || request.kind === "write_path"
          ? userFacingPath(request.value)
          : request.value,
      }));
    const categories = new Set(analysis.categories);
    const commandGranted = this.hasCommandGrant(fingerprint);

    if (analysis.hardBlock) {
      return {
        action: "block",
        profile,
        severity: "critical",
        reason: `Blocked hard-danger command: ${analysis.dangerousReason || "unsafe shell pattern"}.`,
        commandFingerprint: fingerprint,
        categories: analysis.categories,
        writePaths: analysis.visibleWritePaths,
        readPaths: analysis.visibleReadPaths,
        protectedReadPaths: analysis.protectedReadPaths,
        missingGrants: [{ kind: "command", value: fingerprint }],
      };
    }

    if (commandGranted) {
      categories.add("approved-command");
    }

    if (analysis.dangerousReason && !commandGranted) {
      missing.push({ kind: "command", value: fingerprint });
      categories.add("needs-command-approval");
    }
    if (analysis.categories.includes("unbounded-search") && !commandGranted) {
      missing.push({ kind: "command", value: fingerprint });
      categories.add("needs-command-approval");
    }
    if (analysis.categories.includes("unresolved-read-set") && !commandGranted) {
      missing.push({ kind: "command", value: fingerprint });
      categories.add("needs-command-approval");
    }
    if (analysis.categories.includes("indirect-execution") && !commandGranted) {
      missing.push({ kind: "command", value: fingerprint });
      categories.add("needs-command-approval");
    }

    for (const target of analysis.visibleWritePaths) {
      if (profile === "full-access") {
        continue;
      } else if (isProtectedPath(target) && !this.hasPathGrant("write_path", target, fingerprint)) {
        missing.push({ kind: "write_path", value: target });
        categories.add("protected-path");
      } else if (profile === "read-only" && !this.hasPathGrant("write_path", target, fingerprint)) {
        missing.push({ kind: "write_path", value: target });
        categories.add("read-only-write");
      } else if (profile === "workspace-write" && !this.isWritable(target, true, fingerprint)) {
        missing.push({ kind: "write_path", value: target });
        categories.add("outside-workspace-write");
      }
    }
    for (const target of profile === "full-access" ? [] : analysis.protectedReadPaths) {
      const resolved = canonical(target);
      if (!this.hasPathGrant("read_path", resolved, fingerprint)) {
        missing.push({ kind: "read_path", value: resolved });
        categories.add("protected-read");
      }
    }

    if (profile === "full-access" && missing.length === 0) {
      return this.allowDecision(
        profile,
        analysis,
        categories,
        "Full-access sandbox profile is active; command still passed critical safety checks.",
        fingerprint,
      );
    }

    if (missing.length) {
      const reason = analysis.dangerousReason
        ? `Command requires approval: ${analysis.dangerousReason}.`
        : analysis.categories.includes("unbounded-search")
          ? "Command requires approval because recursive local search must exclude large generated/dependency directories and bound output."
          : analysis.categories.includes("unresolved-read-set")
            ? "Command requires approval because an inline program hides its complete filesystem read set."
          : analysis.categories.includes("indirect-execution")
            ? "Command requires approval because it executes a script whose contents are part of the grant identity."
        : "Command requires approval for sandbox boundary expansion.";
      return {
        action: "confirm",
        profile,
        severity: analysis.dangerousReason ? "critical" : "caution",
        reason,
        commandFingerprint: fingerprint,
        categories: Array.from(categories),
        writePaths: analysis.visibleWritePaths,
        readPaths: analysis.visibleReadPaths,
        protectedReadPaths: analysis.protectedReadPaths,
        missingGrants: presentMissing(),
      };
    }

    return this.allowDecision(
      profile,
      analysis,
      categories,
      commandGranted
        ? "Exact command was approved by a sandbox grant; independent path grants remain enforced."
        : "Command is within the active sandbox policy.",
      fingerprint,
    );
  }

  decideFileAccess(toolName: string, filePath: string, cwd = this.config.workingDir): SandboxDecision {
    const profile = this.profile();
    const requested = path.resolve(cwd, filePath);
    const resolved = canonical(requested);
    const writes = FILE_WRITE_TOOLS.has(toolName);
    const notebookWrite = toolName === "notebook_edit";
    const missing: Array<{ kind: SandboxGrantKind; value: string }> = [];
    const categories = new Set<string>(["file-tool"]);

    if ((isProtectedPath(requested) || isProtectedPath(resolved)) && !this.hasPathGrant(writes ? "write_path" : "read_path", resolved)) {
      missing.push({ kind: writes ? "write_path" : "read_path", value: resolved });
      categories.add("protected-path");
    }
    if (writes && profile === "read-only" && !this.hasPathGrant("write_path", resolved)) {
      missing.push({ kind: "write_path", value: resolved });
      categories.add("read-only-write");
    }
    if (writes && profile === "workspace-write" && !this.isWritable(resolved, !notebookWrite)) {
      missing.push({ kind: "write_path", value: resolved });
      categories.add("outside-workspace-write");
    }

    return {
      action: missing.length ? "confirm" : "allow",
      profile,
      severity: missing.length ? "caution" : "info",
      reason: missing.length ? "File access requires sandbox permission approval." : "File access is within the active sandbox policy.",
      categories: Array.from(categories),
      writePaths: writes ? [resolved] : [],
      readPaths: writes ? [] : [resolved],
      missingGrants: uniqueCanonicalPathRequests(missing).map(request => ({
        ...request,
        value: request.kind === "read_path" || request.kind === "write_path"
          ? userFacingPath(request.value)
          : request.value,
      })),
    };
  }

  rememberApproval(decision: SandboxDecision, scope: SandboxGrantScope, reason = "User approved sandbox permission."): SandboxGrant[] {
    if (scope === "once") {
      if (decision.commandFingerprint) {
        const requests = decision.missingGrants.length > 0
          ? decision.missingGrants
          : decision.approvedOnceGrants ?? [];
        this.onceCommandGrants.set(
          decision.commandFingerprint,
          requests.map(request => ({
            ...request,
            pathIdentity: request.kind === "read_path" || request.kind === "write_path"
              ? captureSandboxPathIdentity(request.value)
              : undefined,
          })),
        );
      }
      return [];
    }
    const retainedScope = scope === "project" && this.config.persistenceMode === "ephemeral"
      ? "session"
      : scope;
    return this.grantStore.grant({
      scope: retainedScope,
      requests: decision.missingGrants.map(request => ({
        ...request,
        pathIdentity: request.kind === "read_path" || request.kind === "write_path"
          ? captureSandboxPathIdentity(request.value)
          : undefined,
      })),
      reason,
    }).createdGrants;
  }

  buildSandboxedCommand(command: string, cwd = this.config.workingDir): { command: string; sandboxed: boolean; degraded: boolean; policy?: string } {
    const profile = this.profile();
    const decision = this.decideBash(command, cwd);
    if (decision.action !== "allow") {
      throw new Error(`Canvast sandbox blocked command: ${decision.reason}`);
    }
    if (profile === "full-access" && this.config.network === "enabled") {
      return { command, sandboxed: false, degraded: false };
    }
    if (!this.canApplyOsSandbox()) {
      throw new Error(
        `Canvast sandbox isolation is unavailable for the ${profile} profile; refusing to execute the command without OS enforcement.`,
      );
    }
    const policy = this.buildSeatbeltPolicy(decision);
    return {
      command: `${shellQuote(this.config.sandboxExecPath)} -p ${shellQuote(policy)} /bin/bash -lc ${shellQuote(command)}`,
      sandboxed: true,
      degraded: false,
      policy,
    };
  }

  markDecisionUsed(decision: SandboxDecision): void {
    if (decision.commandFingerprint) this.onceCommandGrants.delete(decision.commandFingerprint);
  }

  markCommandExecuted(command: string, cwd = this.config.workingDir): void {
    const decision = this.decideBash(command, cwd);
    if (decision.commandFingerprint) this.onceCommandGrants.delete(decision.commandFingerprint);
  }

  renderStatus(): string {
    const config = this.getConfig();
    const grants = this.grants();
    const projectCount = grants.filter(grant => grant.scope === "project").length;
    const sessionCount = grants.filter(grant => grant.scope === "session").length;
    return [
      `Canvast sandbox: ${config.profile}`,
      `permission_mode=${config.permissionMode}`,
      `os_sandbox=${config.useOsSandbox ? "enabled" : "disabled"}`,
      `unattended=${config.unattended}`,
      `network=${config.network}`,
      `project_root=${config.projectRoot}`,
      `writable_roots=${config.writableRoots.join(path.delimiter)}`,
      `trusted_read_roots=${config.trustedReadRoots.join(path.delimiter)}`,
      `dependency_cache_root=${config.dependencyCacheRoot}`,
      `grants=session:${sessionCount}, project:${projectCount}, once:${this.onceCommandGrants.size}`,
    ].join("\n");
  }

  private persistPermissionMode(mode: CanvastPermissionMode, source: RuntimePermissionSource): void {
    this.config = { ...this.config, permissionMode: mode, permissionSource: source };
    try {
      updateRuntimePermission(this.config.agentDir, {
        mode,
        source,
        unattended: this.config.unattended,
      });
    } catch {
      // Runtime status is a visibility plane. Sandbox decisions still work if it is unavailable.
    }
  }

  private allowDecision(
    profile: CanvastSandboxProfile,
    analysis: SandboxCommandAnalysis,
    categories: Set<string>,
    reason: string,
    commandFingerprint: string,
  ): SandboxDecision {
    const approvedOnceGrants = this.onceCommandGrants.get(commandFingerprint);
    return {
      action: "allow",
      profile,
      severity: "info",
      reason,
      commandFingerprint,
      categories: Array.from(categories),
      writePaths: analysis.visibleWritePaths,
      readPaths: analysis.visibleReadPaths,
      protectedReadPaths: analysis.protectedReadPaths,
      missingGrants: [],
      approvedOnceGrants: approvedOnceGrants?.map(grant => ({
        ...grant,
        pathIdentity: grant.pathIdentity ? { ...grant.pathIdentity } : undefined,
      })),
    };
  }

  private isWritable(
    target: string,
    includeOperationalRoots = true,
    commandFingerprint?: string,
  ): boolean {
    if (this.config.trustedReadRoots.some(root => isPathInside(target, root))) {
      return this.hasPathGrant("write_path", target, commandFingerprint);
    }
    if (includeOperationalRoots && isPathInside(target, this.config.dependencyCacheRoot)) return true;
    if (includeOperationalRoots && this.config.tempRoots.some(root => isPathInside(target, root))) return true;
    if (this.config.writableRoots.some(root => isPathInside(target, root))) return true;
    return this.hasPathGrant("write_path", target, commandFingerprint);
  }

  private hasCommandGrant(fingerprint: string): boolean {
    if (this.onceCommandGrants.has(fingerprint)) return true;
    return this.grants().some(grant => grant.kind === "command" && grant.value === fingerprint);
  }

  private hasPathGrant(
    kind: "write_path" | "read_path",
    target: string,
    commandFingerprint?: string,
  ): boolean {
    const onceGranted = commandFingerprint
      ? (this.onceCommandGrants.get(commandFingerprint) ?? [])
        .some(grant => {
          if (grant.kind !== kind || !isPathInside(target, grant.value)) return false;
          if (!grant.pathIdentity) return captureSandboxPathIdentity(grant.value) === undefined;
          const current = captureSandboxPathIdentity(grant.value);
          return Boolean(current && sameSandboxPathIdentity(current, grant.pathIdentity));
        })
      : false;
    if (onceGranted) return true;
    return this.grants().some(grant => {
      if (grant.kind !== kind || !isPathInside(target, grant.value)) return false;
      if (!grant.pathIdentity) return captureSandboxPathIdentity(grant.value) === undefined;
      const current = captureSandboxPathIdentity(grant.value);
      return Boolean(current && sameSandboxPathIdentity(current, grant.pathIdentity));
    });
  }

  private buildSeatbeltPolicy(decision: SandboxDecision): string {
    const writableRoots = new Set<string>();
    writableRoots.add(this.config.dependencyCacheRoot);
    for (const root of this.config.tempRoots) writableRoots.add(root);
    if (decision.profile === "full-access") {
      writableRoots.add("/");
    } else if (decision.profile === "workspace-write") {
      for (const root of this.config.writableRoots) writableRoots.add(root);
    }
    for (const grant of this.grants()) {
      if (grant.kind === "write_path") writableRoots.add(grant.value);
    }
    const onceGrants = decision.commandFingerprint
      ? this.onceCommandGrants.get(decision.commandFingerprint) ?? []
      : [];
    for (const grant of onceGrants) {
      if (grant.kind === "write_path") writableRoots.add(grant.value);
    }

    const writeRules = Array.from(writableRoots).map(root => renderSbplPath("subpath", root)).join(" ");
    const trustedReadOnlyRules = decision.profile === "full-access"
      ? ""
      : this.config.trustedReadRoots.map(root => renderSbplPath("subpath", root)).join(" ");
    const grantedWriteRules = this.grants()
      .filter(grant => grant.kind === "write_path")
      .map(grant => renderSbplPath("subpath", grant.value));
    for (const grant of onceGrants) {
      if (grant.kind === "write_path") grantedWriteRules.push(renderSbplPath("subpath", grant.value));
    }
    const allowedReadPaths = this.grants()
      .filter(grant => grant.kind === "read_path")
      .map(grant => grant.value);
    const protectedReadRules = renderProtectedReadRules(
      decision.protectedReadPaths ??
        decision.readPaths.flatMap(target => assessProtectedRead(target, this.config.trustedReadRoots).protectedPaths),
      decision.profile === "full-access" ? [] : this.config.trustedReadRoots,
      decision.profile === "full-access"
        ? ["/"]
        : [...allowedReadPaths, ...onceGrants
          .filter(grant => grant.kind === "read_path")
          .map(grant => grant.value)],
      decision.profile === "full-access",
    );
    const protectedWriteRule = decision.profile === "full-access"
      ? ""
      : renderProtectedWriteRule();
    return [
      "(version 1)",
      "(deny default)",
      "(allow process*)",
      "(allow sysctl-read)",
      this.config.network === "enabled" ? "(allow network*)" : "(deny network*)",
      "(allow file-read*)",
      ...protectedReadRules,
      writeRules ? `(allow file-write* ${writeRules})` : "",
      trustedReadOnlyRules ? `(deny file-write* ${trustedReadOnlyRules})` : "",
      protectedWriteRule,
      grantedWriteRules.length ? `(allow file-write* ${grantedWriteRules.join(" ")})` : "",
      "(allow file-write* (literal \"/dev/null\"))",
    ].filter(Boolean).join("\n");
  }

  private canApplyOsSandbox(): boolean {
    if (this.config.platform !== "darwin" || !this.config.useOsSandbox || !fs.existsSync(this.config.sandboxExecPath)) {
      return false;
    }
    if (this.config.assumeOsSandbox) return true;
    if (this.osSandboxAvailable !== undefined) return this.osSandboxAvailable;
    const probe = spawnSync(this.config.sandboxExecPath, [
      "-p",
      "(version 1)\n(allow default)",
      "/usr/bin/true",
    ], { timeout: 1_000, stdio: "ignore" });
    this.osSandboxAvailable = probe.status === 0 && !probe.error;
    return this.osSandboxAvailable;
  }
}

export function createSandboxController(options: ResolveSandboxConfigOptions = {}): CanvastSandboxController {
  return new CanvastSandboxController(resolveSandboxConfig(options));
}
