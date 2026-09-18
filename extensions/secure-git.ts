/**
 * =============================================================================
 * Canvast — Secure Git Executor / 安全 Git 执行器
 * =============================================================================
 * @file        extensions/secure-git.ts
 * @brief       Runs native Git with Canvast sandbox policy and a minimal env.
 * @description Keeps Git argv literal, confines filesystem/network access,
 *              and disables repository-configured external programs.
 *              保持 Git 参数原样，约束文件系统与网络，并禁用仓库配置的外部程序。
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import { constants, accessSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { devNull } from "node:os";
import { spawnSync } from "node:child_process";

import {
  createSandboxController,
  isPathInside,
  type CanvastSandboxConfig,
  type SandboxDecision,
} from "../src/harness/sandbox.js";
import { redactCredentialText } from "../src/harness/credential-redaction.js";

const STATIC_SAFE_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ["core.hooksPath", devNull],
  ["core.fsmonitor", "false"],
  ["core.pager", "cat"],
  ["pager.status", "false"],
  ["pager.log", "false"],
  ["credential.helper", ""],
  ["credential.interactive", "false"],
  ["core.askPass", ""],
  ["core.editor", "false"],
  ["sequence.editor", "false"],
  ["diff.external", ""],
  ["interactive.diffFilter", ""],
  ["commit.verbose", "false"],
  ["commit.gpgSign", "false"],
  ["tag.gpgSign", "false"],
  ["push.gpgSign", "false"],
  ["log.showSignature", "false"],
  ["merge.verifySignatures", "false"],
  ["core.sshCommand", "false"],
  ["core.gitProxy", "none"],
  ["core.alternateRefsCommand", ""],
  ["gc.recentObjectsHook", ""],
  ["gc.auto", "0"],
  ["uploadpack.packObjectsHook", ""],
  ["protocol.ext.allow", "never"],
];

const FILTER_COMMAND_KEYS = new Set(["clean", "smudge", "process"]);
const DIFF_COMMAND_KEYS = new Set(["command", "textconv"]);
const TOOL_COMMAND_KEYS = new Set(["cmd", "command"]);
const DIFF_CAPABLE_COMMANDS = new Set(["diff", "log", "show", "whatchanged"]);
const MAX_DYNAMIC_CONFIG_OVERRIDES = 1_024;

export interface SecureGitRunOptions {
  cwd?: string;
  input?: string;
  mutates?: boolean;
  writePaths?: string[];
  additionalRepositoryRoots?: string[];
}

export interface SecureGitRunResult {
  status: 0;
  stdout: string;
  stderr: string;
}

export interface SecureGitExecutor {
  run(args: string[], options?: SecureGitRunOptions): SecureGitRunResult;
  assertWritePath(target: string, cwd?: string): void;
  config: CanvastSandboxConfig;
}

export interface SecureGitFailureDetails {
  code: "git_execution_failed" | "git_sandbox_blocked" | "git_configuration_unsafe";
  message: string;
  decision?: SandboxDecision;
}

export class SecureGitError extends Error {
  constructor(
    message: string,
    readonly details: SecureGitFailureDetails,
  ) {
    super(message);
    this.name = "SecureGitError";
  }
}

interface RepositoryLayout {
  workTree: string;
  metadataPaths: string[];
}

function canonical(target: string): string {
  const absolute = resolve(target);
  try {
    return realpathSync.native(absolute);
  } catch {
    let existing = absolute;
    const missing: string[] = [];
    while (!existsSync(existing)) {
      const parent = dirname(existing);
      if (parent === existing) return absolute;
      missing.unshift(basename(existing));
      existing = parent;
    }
    try {
      return join(realpathSync.native(existing), ...missing);
    } catch {
      return absolute;
    }
  }
}

function readableExecutable(candidate: string): string | undefined {
  try {
    accessSync(candidate, constants.R_OK | constants.X_OK);
    return realpathSync.native(candidate);
  } catch {
    return undefined;
  }
}

function resolveGitBinary(): string {
  const candidates = process.platform === "darwin"
    ? [
        "/Library/Developer/CommandLineTools/usr/bin/git",
        "/Applications/Xcode.app/Contents/Developer/usr/bin/git",
        "/opt/homebrew/bin/git",
        "/usr/local/bin/git",
        "/usr/bin/git",
      ]
    : process.platform === "win32"
      ? [
          "C:\\Program Files\\Git\\cmd\\git.exe",
          "C:\\Program Files\\Git\\bin\\git.exe",
        ]
      : ["/usr/bin/git", "/bin/git", "/usr/local/bin/git"];
  for (const candidate of candidates) {
    const binary = readableExecutable(candidate);
    if (binary) return binary;
  }
  throw new SecureGitError("Secure Git executable was not found in a trusted system location.", {
    code: "git_execution_failed",
    message: "Git is unavailable in trusted system locations.",
  });
}

function readGitDirPointer(dotGitFile: string): string | undefined {
  try {
    const contents = readFileSync(dotGitFile, "utf-8");
    const newline = contents.indexOf("\n");
    const rawLine = newline >= 0 ? contents.slice(0, newline) : contents;
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const prefix = "gitdir:";
    if (!line.toLowerCase().startsWith(prefix)) return undefined;
    const value = line.slice(prefix.length).trim();
    if (!value) return undefined;
    return canonical(isAbsolute(value) ? value : resolve(dirname(dotGitFile), value));
  } catch {
    return undefined;
  }
}

function discoverRepository(
  start: string,
  authorizeMetadata: (target: string) => void,
): RepositoryLayout | undefined {
  let current = canonical(start);
  while (true) {
    const dotGit = join(current, ".git");
    if (existsSync(dotGit)) {
      authorizeMetadata(canonical(dotGit));
      let gitDir: string | undefined;
      try {
        gitDir = statSync(dotGit).isDirectory() ? canonical(dotGit) : readGitDirPointer(dotGit);
      } catch {
        gitDir = undefined;
      }
      if (!gitDir) return undefined;
      authorizeMetadata(gitDir);
      const metadataPaths = [canonical(dotGit), gitDir];
      const commonDirFile = join(gitDir, "commondir");
      if (existsSync(commonDirFile)) {
        authorizeMetadata(canonical(commonDirFile));
        const commonDirValue = readFileSync(commonDirFile, "utf-8").trim();
        if (commonDirValue) {
          const commonDir = canonical(isAbsolute(commonDirValue)
            ? commonDirValue
            : resolve(gitDir, commonDirValue));
          authorizeMetadata(commonDir);
          metadataPaths.push(commonDir);
        }
      }
      return {
        workTree: current,
        metadataPaths: Array.from(new Set(metadataPaths)),
      };
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function sbplString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

function safeConfigArgs(
  dynamicConfig: ReadonlyArray<readonly [string, string]>,
  repository?: RepositoryLayout,
): string[] {
  const entries = [...STATIC_SAFE_CONFIG, ...dynamicConfig];
  if (repository) {
    entries.push(["core.bare", "false"], ["core.worktree", repository.workTree]);
  }
  return entries.flatMap(([key, value]) => ["-c", `${key}=${value}`]);
}

function secureCommandArgs(args: string[]): string[] {
  if (!DIFF_CAPABLE_COMMANDS.has(args[0])) return [...args];
  const secured = [...args];
  if (!secured.includes("--no-ext-diff")) secured.push("--no-ext-diff");
  if (!secured.includes("--no-textconv")) secured.push("--no-textconv");
  return secured;
}

function dynamicNeutralValue(key: string): string | undefined {
  const parts = key.toLowerCase().split(".");
  const first = parts[0];
  const last = parts.at(-1) || "";
  if (first === "filter" && parts.length >= 3) {
    if (FILTER_COMMAND_KEYS.has(last)) return "";
    if (last === "required") return "false";
  }
  if (first === "diff" && parts.length === 2 && last === "external") return "";
  if (first === "diff" && parts.length >= 3 && DIFF_COMMAND_KEYS.has(last)) return "";
  if (first === "pager" && parts.length >= 2) return "false";
  if (first === "credential" && last === "helper") return "";
  if (first === "gpg" && (last === "program" || last === "defaultkeycommand")) return "";
  if ((first === "difftool" || first === "mergetool" || first === "trailer")
    && TOOL_COMMAND_KEYS.has(last)) return "false";
  if (first === "merge" && last === "driver") return "false";
  if (first === "submodule" && last === "update") return "checkout";
  if (first === "remote" && (last === "uploadpack" || last === "receivepack")) return "";
  if (first === "alias" && parts.length >= 2) return "";
  return undefined;
}

function dynamicConfigOverrides(configNames: string[]): Array<readonly [string, string]> {
  const overrides = new Map<string, readonly [string, string]>();
  for (const rawKey of configNames) {
    let key = rawKey;
    while (key.endsWith("\n") || key.endsWith("\r")) key = key.slice(0, -1);
    if (!key || key.includes("\0") || key.includes("\n")) {
      throw new SecureGitError("Git configuration contains an invalid key.", {
        code: "git_configuration_unsafe",
        message: "Git configuration contains an invalid key.",
      });
    }
    const value = dynamicNeutralValue(key);
    if (value === undefined) continue;
    overrides.set(key.toLowerCase(), [key, value]);
    if (overrides.size > MAX_DYNAMIC_CONFIG_OVERRIDES) {
      throw new SecureGitError("Git configuration contains too many external execution entries.", {
        code: "git_configuration_unsafe",
        message: "Git configuration exceeds the secure override limit.",
      });
    }
  }
  return Array.from(overrides.values());
}

function safeChildEnvironment(
  gitBinary: string,
  dependencyCacheRoot: string,
  projectRoot: string,
): NodeJS.ProcessEnv {
  const gitHome = join(dependencyCacheRoot, "secure-git-home");
  const gitTemp = join(dependencyCacheRoot, "secure-git-tmp");
  mkdirSync(gitHome, { recursive: true });
  mkdirSync(gitTemp, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    HOME: gitHome,
    XDG_CONFIG_HOME: join(gitHome, ".config"),
    TMPDIR: gitTemp,
    PATH: Array.from(new Set([
      dirname(gitBinary),
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ])).join(delimiter),
    LANG: process.env.LANG || "C",
    LC_ALL: process.env.LC_ALL || "C",
    TERM: "dumb",
    NO_COLOR: "1",
    GIT_CONFIG_COUNT: "0",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_EDITOR: "false",
    GIT_SEQUENCE_EDITOR: "false",
    GIT_MERGE_AUTOEDIT: "no",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_ALLOW_PROTOCOL: "",
    GIT_CEILING_DIRECTORIES: dirname(canonical(projectRoot)),
  };
  if (process.platform === "win32") {
    env.PATH = dirname(gitBinary);
  }
  for (const key of ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function structuredSandboxError(message: string, decision?: SandboxDecision): SecureGitError {
  return new SecureGitError(message, {
    code: "git_sandbox_blocked",
    message,
    decision,
  });
}

export function createSecureGitExecutor(): SecureGitExecutor {
  const sandbox = createSandboxController();
  const config = sandbox.getConfig();
  const gitBinary = resolveGitBinary();
  const env = safeChildEnvironment(gitBinary, config.dependencyCacheRoot, config.projectRoot);

  const requireAccess = (
    access: "read" | "write",
    target: string,
    cwd: string,
    allowRepositoryMetadata = false,
    requireConfiguredRoot = false,
  ): void => {
    const canonicalTarget = canonical(target);
    const decision = sandbox.decideFileAccess(access, canonicalTarget, cwd);
    const insideWritableRoot = config.writableRoots.some(root => isPathInside(canonicalTarget, root));
    const insideTrustedReadRoot = config.trustedReadRoots.some(root => isPathInside(canonicalTarget, root));
    if (
      requireConfiguredRoot
      && config.profile !== "full-access"
      && !insideWritableRoot
    ) {
      throw structuredSandboxError(
        `Canvast sandbox blocked Git ${access} access outside configured writable roots: ${canonicalTarget}`,
        decision,
      );
    }
    if (decision.action === "allow") return;
    if (
      allowRepositoryMetadata
      && insideWritableRoot
      && !insideTrustedReadRoot
      && (access === "read" || config.profile !== "read-only")
    ) {
      return;
    }
    throw structuredSandboxError(
      `Canvast sandbox blocked Git ${access} access to ${canonicalTarget}: ${decision.reason}`,
      decision,
    );
  };

  const preparePolicy = (
    cwd: string,
    repository: RepositoryLayout | undefined,
    extraMetadataPaths: string[],
  ): string | undefined => {
    const command = `${shellQuote(gitBinary)} --version`;
    let wrapped: ReturnType<typeof sandbox.buildSandboxedCommand>;
    try {
      wrapped = sandbox.buildSandboxedCommand(command, cwd);
    } catch (error) {
      const message = redactCredentialText(error instanceof Error ? error.message : String(error));
      throw structuredSandboxError(message, sandbox.decideBash(command, cwd));
    }
    if (!wrapped.sandboxed || !wrapped.policy) return undefined;
    const metadataPaths = Array.from(new Set([
      ...(repository?.metadataPaths || []),
      ...extraMetadataPaths,
    ].map(canonical)));
    return [
      wrapped.policy,
      "(deny process-exec)",
      `(allow process-exec (literal "${sbplString(gitBinary)}"))`,
      ...metadataPaths.map(target =>
        `(allow file-read* (subpath "${sbplString(target)}") (literal "${sbplString(target)}"))`),
    ].join("\n");
  };

  const spawnGit = (
    args: string[],
    cwd: string,
    repository: RepositoryLayout | undefined,
    extraMetadataPaths: string[],
    input?: string,
  ): SecureGitRunResult => {
    const policy = preparePolicy(cwd, repository, extraMetadataPaths);
    const executable = policy ? config.sandboxExecPath : gitBinary;
    const invocationArgs = policy ? ["-p", policy, gitBinary, ...args] : args;
    const result = spawnSync(executable, invocationArgs, {
      cwd,
      encoding: "utf-8",
      env,
      input,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
    });
    sandbox.markCommandExecuted([gitBinary, ...args].map(shellQuote).join(" "), cwd);
    if (result.error) {
      throw new SecureGitError(redactCredentialText(result.error.message), {
        code: "git_execution_failed",
        message: redactCredentialText(result.error.message),
      });
    }
    if (result.status !== 0) {
      const message = redactCredentialText(
        (result.stderr || result.stdout || `git ${args.at(-1) || "command"} failed`).trim(),
      );
      throw new SecureGitError(message, {
        code: "git_execution_failed",
        message,
      });
    }
    return {
      status: 0,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
    };
  };

  const run = (args: string[], options: SecureGitRunOptions = {}): SecureGitRunResult => {
    if (!args.length || args.some(arg => typeof arg !== "string" || arg.includes("\0"))) {
      throw new SecureGitError("Invalid Git argv.", {
        code: "git_execution_failed",
        message: "Git arguments must be non-empty strings without null bytes.",
      });
    }
    const cwd = canonical(options.cwd || process.cwd());
    if (options.mutates) requireAccess("write", cwd, cwd);
    for (const writePath of options.writePaths || []) {
      requireAccess("write", writePath, cwd, false, true);
    }
    const repository = discoverRepository(
      cwd,
      target => requireAccess(
        options.mutates ? "write" : "read",
        target,
        cwd,
        true,
        true,
      ),
    );
    const extraLayouts = (options.additionalRepositoryRoots || [])
      .map(root => discoverRepository(
        root,
        target => requireAccess(
          options.mutates ? "write" : "read",
          target,
          cwd,
          true,
          true,
        ),
      ))
      .filter((layout): layout is RepositoryLayout => Boolean(layout));
    const extraMetadataPaths = extraLayouts.flatMap(layout => layout.metadataPaths);

    const auditArgs = [
      "--no-pager",
      ...safeConfigArgs([], repository),
      "config",
      "--includes",
      "--null",
      "--name-only",
      "--list",
    ];
    const audit = spawnGit(auditArgs, cwd, repository, extraMetadataPaths);
    const dynamicConfig = dynamicConfigOverrides(audit.stdout.split("\0").filter(Boolean));
    const securedArgs = [
      "--no-pager",
      ...safeConfigArgs(dynamicConfig, repository),
      ...secureCommandArgs(args),
    ];
    return spawnGit(securedArgs, cwd, repository, extraMetadataPaths, options.input);
  };

  return {
    run,
    assertWritePath(target: string, cwd = process.cwd()): void {
      requireAccess("write", target, canonical(cwd), false, true);
    },
    config: { ...config },
  };
}

export function secureGitFailureDetails(error: unknown): SecureGitFailureDetails {
  if (error instanceof SecureGitError) return error.details;
  const message = redactCredentialText(error instanceof Error ? error.message : String(error));
  return { code: "git_execution_failed", message };
}
