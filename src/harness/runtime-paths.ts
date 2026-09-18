/**
 * =============================================================================
 * Canvast — Runtime Paths / Canvast 源文件
 * =============================================================================
 * @file        src/harness/runtime-paths.ts
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type CanvastPersistenceMode = "persistent" | "ephemeral";

export interface ResolveCanvastRuntimePathOptions {
  installUrl?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  args?: string[];
  extensionFiles: readonly string[];
}

export interface CanvastRuntimePaths {
  projectDir: string;
  installDir: string;
  workingDir: string;
  projectRoot: string;
  piCli: string;
  agentDir: string;
  sessionDir?: string;
  canvastHome: string;
  projectKey: string;
  persistenceMode: CanvastPersistenceMode;
  extensionPaths: string[];
}

export interface NormalizedSessionArgs {
  forwardedArgs: string[];
  noSessionPersistence: boolean;
}

function canonical(value: string): string {
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
      const realParent = fs.realpathSync.native(dir);
      return path.join(realParent, ...missing);
    } catch {
      return resolved;
    }
  }
}

function findInstallDir(startDir: string): string {
  let dir = startDir;
  for (;;) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pkg, "utf-8"));
        if (parsed?.name === "canvast") return dir;
      } catch {
        // Keep walking upward.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return startDir;
    dir = parent;
  }
}

function findWorkingProjectRoot(startDir: string): string {
  let dir = canonical(startDir);
  const rootMarkers = [".git", "package.json", "pyproject.toml", "go.mod", "Cargo.toml", "pnpm-workspace.yaml"];
  for (;;) {
    if (rootMarkers.some(marker => fs.existsSync(path.join(dir, marker)))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return canonical(startDir);
    dir = parent;
  }
}

function truthy(value: unknown): boolean {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

export function normalizeCanvastSessionArgs(args: string[]): NormalizedSessionArgs {
  const forwardedArgs: string[] = [];
  let noSessionPersistence = false;
  let sawNoSession = false;

  for (const arg of args) {
    if (arg === "--no-session" || arg === "--no-session-persistence" || arg === "--canvast-no-session-persistence") {
      noSessionPersistence = true;
      if (!sawNoSession) {
        forwardedArgs.push("--no-session");
        sawNoSession = true;
      }
      continue;
    }
    forwardedArgs.push(arg);
  }

  return { forwardedArgs, noSessionPersistence };
}

export function hasNoSessionPersistence(args: string[], env: NodeJS.ProcessEnv = process.env): boolean {
  return normalizeCanvastSessionArgs(args).noSessionPersistence ||
    truthy(env.CANVAST_NO_SESSION_PERSISTENCE) ||
    truthy(env.CANVAST_EPHEMERAL);
}

export function projectKeyForRoot(projectRoot: string): string {
  const root = canonical(projectRoot);
  const base = (path.basename(root) || "project").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48) || "project";
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 12);
  return `${base}-${hash}`;
}

export function resolveCanvastRuntimePaths(options: ResolveCanvastRuntimePathOptions): CanvastRuntimePaths {
  const env = options.env ?? process.env;
  const args = options.args ?? [];
  const moduleDir = path.dirname(fileURLToPath(options.installUrl ?? import.meta.url));
  const installDir = canonical(findInstallDir(moduleDir));
  const workingDir = canonical(env.CANVAST_WORKING_DIR || options.cwd || process.cwd());
  const projectRoot = canonical(env.CANVAST_PROJECT_ROOT || findWorkingProjectRoot(workingDir));
  const projectKey = projectKeyForRoot(projectRoot);
  const canvastHome = canonical(env.CANVAST_HOME || path.join(env.HOME || os.homedir() || os.tmpdir(), ".canvast"));
  const ephemeral = hasNoSessionPersistence(args, env);
  const persistenceMode: CanvastPersistenceMode = ephemeral ? "ephemeral" : "persistent";

  const agentDir = ephemeral
    ? canonical(path.join(env.CANVAST_TMPDIR || os.tmpdir(), "canvast", "ephemeral", `${projectKey}-${process.pid}`, "state"))
    : canonical(env.CANVAST_AGENT_DIR || env.PI_CODING_AGENT_DIR || path.join(canvastHome, "projects", projectKey, "state"));
  const sessionDir = ephemeral
    ? undefined
    : canonical(env.CANVAST_SESSION_DIR || env.PI_CODING_AGENT_SESSION_DIR || path.join(canvastHome, "projects", projectKey, "sessions"));
  const piCli = path.join(installDir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  const extensionPaths = options.extensionFiles
    .map(file => path.join(installDir, "extensions", file))
    .filter(file => fs.existsSync(file));

  return {
    projectDir: installDir,
    installDir,
    workingDir,
    projectRoot,
    piCli,
    agentDir,
    sessionDir,
    canvastHome,
    projectKey,
    persistenceMode,
    extensionPaths,
  };
}
