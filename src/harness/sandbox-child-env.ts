/**
 * =============================================================================
 * Canvast — Sandbox Child Environment / Canvast 沙箱子进程环境
 * =============================================================================
 * @file        src/harness/sandbox-child-env.ts
 * @brief       Builds a minimal environment for sandboxed child processes.
 * @description Copies only non-secret terminal/runtime values and relocates
 *              home, temp, package caches, and install roots under the
 *              Canvast-owned dependency cache. / 仅复制非敏感终端与运行时变量，
 *              并将主目录、临时目录、包缓存及安装目录隔离到 Canvast 缓存中。
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import * as fs from "node:fs";
import * as path from "node:path";

const SAFE_PASSTHROUGH_KEYS = [
  "PATH",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "TZ",
  "CANVAST_SANDBOX_PROFILE",
  "CANVAST_SANDBOX_NETWORK",
] as const;

const WINDOWS_RUNTIME_KEYS = [
  "ComSpec",
  "COMSPEC",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
] as const;

function enabled(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

function copyString(
  source: NodeJS.ProcessEnv,
  target: NodeJS.ProcessEnv,
  key: string,
): void {
  const value = source[key];
  if (typeof value === "string" && value.length > 0) target[key] = value;
}

function ensureDirectories(values: Iterable<string>): void {
  for (const value of values) fs.mkdirSync(value, { recursive: true });
}

export function buildSandboxChildEnvironment(
  base: NodeJS.ProcessEnv,
  dependencyCacheRoot: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_PASSTHROUGH_KEYS) copyString(base, env, key);
  if (process.platform === "win32") {
    for (const key of WINDOWS_RUNTIME_KEYS) copyString(base, env, key);
  }

  const root = dependencyCacheRoot;
  const home = path.join(root, "home");
  const temporary = path.join(root, "tmp");
  const cacheEntries: Record<string, string> = {
    CANVAST_DEPENDENCY_CACHE_ROOT: root,
    npm_config_cache: path.join(root, "npm"),
    NPM_CONFIG_CACHE: path.join(root, "npm"),
    YARN_CACHE_FOLDER: path.join(root, "yarn"),
    PNPM_HOME: path.join(root, "pnpm-home"),
    PNPM_STORE_DIR: path.join(root, "pnpm-store"),
    PIP_CACHE_DIR: path.join(root, "pip"),
    UV_CACHE_DIR: path.join(root, "uv"),
    CARGO_HOME: path.join(root, "cargo"),
    GOMODCACHE: path.join(root, "go", "pkg", "mod"),
    GOCACHE: path.join(root, "go", "build"),
  };
  const installEntries: Record<string, string> = {
    npm_config_prefix: path.join(root, "npm-prefix"),
    NPM_CONFIG_PREFIX: path.join(root, "npm-prefix"),
    PIP_TARGET: path.join(root, "python", "site-packages"),
    PYTHONUSERBASE: path.join(root, "python", "userbase"),
    UV_TOOL_DIR: path.join(root, "uv", "tools"),
    UV_PYTHON_INSTALL_DIR: path.join(root, "uv", "python"),
    BUN_INSTALL: path.join(root, "bun"),
    GOPATH: path.join(root, "go"),
    GOBIN: path.join(root, "go", "bin"),
  };

  const allowExternalCache = enabled(base.CANVAST_ALLOW_EXTERNAL_DEPENDENCY_CACHE);
  for (const [key, value] of Object.entries(cacheEntries)) {
    env[key] = allowExternalCache && base[key] ? base[key] : value;
  }
  Object.assign(env, installEntries, {
    HOME: home,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    XDG_CACHE_HOME: path.join(root, "xdg", "cache"),
    XDG_CONFIG_HOME: path.join(root, "xdg", "config"),
    XDG_DATA_HOME: path.join(root, "xdg", "data"),
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PYTHONNOUSERSITE: "1",
  });

  ensureDirectories([
    home,
    temporary,
    ...Object.values(cacheEntries),
    ...Object.values(installEntries),
    env.XDG_CACHE_HOME!,
    env.XDG_CONFIG_HOME!,
    env.XDG_DATA_HOME!,
  ]);
  const binPaths = [
    path.join(root, "npm-prefix", "bin"),
    path.join(root, "pnpm-home"),
    path.join(root, "cargo", "bin"),
    path.join(root, "bun", "bin"),
    path.join(root, "go", "bin"),
  ];
  env.PATH = [...binPaths, env.PATH].filter(Boolean).join(path.delimiter);
  env.PYTHONPATH = installEntries.PIP_TARGET;
  return env;
}
