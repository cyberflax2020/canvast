/**
 * =============================================================================
 * Canvast — Harness Project Lifecycle Owner / Harness 项目生命周期所有者
 * =============================================================================
 * @file        extensions/canvast-harness/project-lifecycle-owner.ts
 * @brief       Production project lifecycle owner for desktop actions.
 * @description Binds typed project.create/open/reinitialize actions to real
 *              SessionManager files and runtime reload/switch behavior without
 *              faking success receipts.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import { copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  ProjectLifecycleError,
  type ProjectLifecycleMutationRequest,
  type ProjectLifecycleMutationOutcome,
  type ProjectLifecycleOwner,
  type SessionManagerLike,
} from "../../src/desktop-action/project-lifecycle.js";
import { resolveCanvastRuntimePaths, type CanvastRuntimePaths } from "../../src/harness/runtime-paths.js";

const RECOVERABLE_RUNTIME_STATE_FILES = [
  "canvas-graph.json",
  "canvast-project-scope.json",
  "runtime-status.json",
  "sidecar-orchestration.json",
  path.join("context-recall", "index.json"),
  path.join("context-recall", "archive-index.json"),
] as const;

const MANAGED_ENV_KEYS = [
  "CANVAST_PROJECT_ROOT",
  "CANVAST_WORKING_DIR",
  "CANVAST_AGENT_DIR",
  "CANVAST_SESSION_DIR",
  "CANVAST_PERSISTENCE_MODE",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
] as const;

type ManagedEnvKey = typeof MANAGED_ENV_KEYS[number];

interface CreateHarnessProjectLifecycleOwnerOptions {
  installUrl?: string;
  args?: string[];
  onDidActivateProject?: (paths: CanvastRuntimePaths) => void;
}

type ManagedEnvSnapshot = Record<ManagedEnvKey, string | undefined>;

function canonical(value: string): string {
  const resolved = path.resolve(value);
  try {
    return realpathSync.native(resolved);
  } catch {
    let dir = path.dirname(resolved);
    const missing = [path.basename(resolved)];
    while (dir && path.dirname(dir) !== dir && !existsSync(dir)) {
      missing.unshift(path.basename(dir));
      dir = path.dirname(dir);
    }
    try {
      const realParent = realpathSync.native(dir);
      return path.join(realParent, ...missing);
    } catch {
      return resolved;
    }
  }
}

function timestampToken(): string {
  const now = new Date();
  const date = [
    now.getUTCFullYear().toString().padStart(4, "0"),
    (now.getUTCMonth() + 1).toString().padStart(2, "0"),
    now.getUTCDate().toString().padStart(2, "0"),
  ].join("");
  const time = [
    now.getUTCHours().toString().padStart(2, "0"),
    now.getUTCMinutes().toString().padStart(2, "0"),
    now.getUTCSeconds().toString().padStart(2, "0"),
  ].join("");
  return `${date}-${time}-${now.getUTCMilliseconds().toString().padStart(3, "0")}`;
}

function sanitizeName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "Project";
  return trimmed.split("\r").join(" ").split("\n").join(" ").trim();
}

function snapshotManagedEnv(): ManagedEnvSnapshot {
  return {
    CANVAST_PROJECT_ROOT: process.env.CANVAST_PROJECT_ROOT,
    CANVAST_WORKING_DIR: process.env.CANVAST_WORKING_DIR,
    CANVAST_AGENT_DIR: process.env.CANVAST_AGENT_DIR,
    CANVAST_SESSION_DIR: process.env.CANVAST_SESSION_DIR,
    CANVAST_PERSISTENCE_MODE: process.env.CANVAST_PERSISTENCE_MODE,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR,
  };
}

function restoreManagedEnv(snapshot: ManagedEnvSnapshot): void {
  for (const key of MANAGED_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function applyRuntimeEnv(paths: CanvastRuntimePaths, workspaceRoot: string): void {
  process.env.CANVAST_PROJECT_ROOT = paths.projectRoot;
  process.env.CANVAST_WORKING_DIR = workspaceRoot;
  process.env.CANVAST_AGENT_DIR = paths.agentDir;
  process.env.PI_CODING_AGENT_DIR = paths.agentDir;
  process.env.CANVAST_PERSISTENCE_MODE = paths.persistenceMode;
  if (paths.sessionDir) {
    process.env.CANVAST_SESSION_DIR = paths.sessionDir;
    process.env.PI_CODING_AGENT_SESSION_DIR = paths.sessionDir;
  } else {
    delete process.env.CANVAST_SESSION_DIR;
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
  }
}

function resolveProjectRuntime(
  projectRoot: string,
  workspaceRoot: string,
  options: CreateHarnessProjectLifecycleOwnerOptions,
): CanvastRuntimePaths {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CANVAST_PROJECT_ROOT: projectRoot,
    CANVAST_WORKING_DIR: workspaceRoot,
  };
  delete env.CANVAST_AGENT_DIR;
  delete env.CANVAST_SESSION_DIR;
  delete env.PI_CODING_AGENT_DIR;
  delete env.PI_CODING_AGENT_SESSION_DIR;
  return resolveCanvastRuntimePaths({
    installUrl: options.installUrl ?? import.meta.url,
    cwd: projectRoot,
    env,
    args: options.args ?? process.argv.slice(2),
    extensionFiles: [],
  });
}

function ensureCommandActionAvailable(
  request: ProjectLifecycleMutationRequest,
  key: "switchSession" | "reload",
  actionKind: "project.create" | "project.open" | "project.reinitialize" | "project.delete",
): void {
  if (!request.commandContext || typeof request.commandContext[key] !== "function") {
    throw new ProjectLifecycleError(
      "handler_unavailable",
      `${actionKind} requires a live ${key} command context.`,
      { actionKind },
    );
  }
}

function ensurePersistentProjectSessions(
  paths: CanvastRuntimePaths,
  actionKind: "project.create" | "project.open",
): string {
  if (!paths.sessionDir) {
    throw new ProjectLifecycleError(
      "session_persistence_required",
      `${actionKind} requires persistent project sessions.`,
      { actionKind, persistenceMode: paths.persistenceMode },
    );
  }
  return canonical(paths.sessionDir);
}

function sessionTitleForProject(projectRoot: string): string {
  return sanitizeName(`Project ${path.basename(projectRoot) || "session"}`);
}

function ensureRegularSessionFile(sessionPath: string): string {
  const canonicalPath = canonical(sessionPath);
  if (!existsSync(canonicalPath)) {
    throw new ProjectLifecycleError(
      "session_missing",
      `Project session ${canonicalPath} does not exist.`,
      { sessionPath: canonicalPath },
    );
  }
  const stat = lstatSync(canonicalPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new ProjectLifecycleError(
      "invalid_project_session",
      `Project session ${canonicalPath} must be a regular non-symlink file.`,
      { sessionPath: canonicalPath },
    );
  }
  return canonicalPath;
}

async function ensureSwitchableProjectSession(
  projectRoot: string,
  sessionDir: string,
): Promise<{ sessionPath: string; sessionId: string }> {
  const sessions = await SessionManager.list(projectRoot, sessionDir);
  if (sessions.length > 0) {
    return {
      sessionPath: ensureRegularSessionFile(sessions[0].path),
      sessionId: sessions[0].id,
    };
  }

  const sessionManager = SessionManager.create(projectRoot, sessionDir);
  sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: `Canvast project session ready for ${path.basename(projectRoot) || projectRoot}.` }],
  } as never);
  sessionManager.appendSessionInfo(sessionTitleForProject(projectRoot));
  const sessionPath = sessionManager.getSessionFile();
  if (!sessionPath) {
    throw new ProjectLifecycleError(
      "session_missing",
      `Failed to create a persisted project session for ${projectRoot}.`,
      { projectRoot },
    );
  }
  return {
    sessionPath: ensureRegularSessionFile(sessionPath),
    sessionId: sessionManager.getSessionId(),
  };
}

async function switchProjectSession(
  actionKind: "project.create" | "project.open",
  request: ProjectLifecycleMutationRequest,
  runtimePaths: CanvastRuntimePaths,
  created: boolean,
  options: CreateHarnessProjectLifecycleOwnerOptions,
): Promise<ProjectLifecycleMutationOutcome> {
  ensureCommandActionAvailable(request, "switchSession", actionKind);
  const projectRoot = request.preflight.target.canonicalPath;
  const sessionDir = ensurePersistentProjectSessions(runtimePaths, actionKind);
  if (actionKind === "project.create") mkdirSync(projectRoot, { recursive: true });

  const { sessionPath, sessionId } = await ensureSwitchableProjectSession(projectRoot, sessionDir);
  const previousEnv = snapshotManagedEnv();
  applyRuntimeEnv(runtimePaths, request.workspaceRoot);

  let activeSessionPath = sessionPath;
  let activeSessionId = sessionId;
  try {
    const switched = await request.commandContext!.switchSession!(sessionPath, {
      withSession: async nextContext => {
        request.commandContext?.resultRelay?.setResultContext(nextContext);
        const sessionManager = (nextContext as { sessionManager?: SessionManagerLike }).sessionManager;
        activeSessionPath = sessionManager?.getSessionFile?.() || sessionPath;
        activeSessionId = sessionManager?.getSessionId?.() || sessionId;
      },
    });
    if (switched.cancelled) {
      restoreManagedEnv(previousEnv);
      throw new ProjectLifecycleError(
        "cancelled",
        `${actionKind} was cancelled before the target project became active.`,
        { actionKind, projectRoot, sessionPath },
      );
    }
  } catch (error) {
    restoreManagedEnv(previousEnv);
    throw error;
  }
  options.onDidActivateProject?.(runtimePaths);

  return {
    activeProjectRoot: projectRoot,
    created: created ? true : undefined,
    sessionPath: canonical(activeSessionPath),
    sessionId: activeSessionId,
    message: `${created ? "Created" : "Opened"} project session for ${projectRoot}.`,
  };
}

function copyRecoverableRuntimeState(
  projectRoot: string,
  agentDir: string,
  request: ProjectLifecycleMutationRequest,
): string {
  const snapshotRoot = path.join(agentDir, "reinitialize-trash", timestampToken());
  mkdirSync(snapshotRoot, { recursive: true });

  const copiedFiles: string[] = [];
  for (const relativeFile of RECOVERABLE_RUNTIME_STATE_FILES) {
    const source = path.join(agentDir, relativeFile);
    if (!existsSync(source)) continue;
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    const destination = path.join(snapshotRoot, relativeFile);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    copiedFiles.push(relativeFile);
  }

  const manifestPath = path.join(snapshotRoot, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    projectRoot,
    agentDir: canonical(agentDir),
    createdAt: new Date().toISOString(),
    copiedFiles,
    sessionPath: request.commandContext?.sessionManager?.getSessionFile?.() || "",
    sessionId: request.commandContext?.sessionManager?.getSessionId?.() || "",
  }, null, 2));
  return manifestPath;
}

async function reinitializeProjectRuntime(
  request: ProjectLifecycleMutationRequest,
  runtimePaths: CanvastRuntimePaths,
  options: CreateHarnessProjectLifecycleOwnerOptions,
): Promise<ProjectLifecycleMutationOutcome> {
  ensureCommandActionAvailable(request, "reload", "project.reinitialize");
  applyRuntimeEnv(runtimePaths, request.workspaceRoot);
  mkdirSync(runtimePaths.agentDir, { recursive: true });
  const preservedStatePath = copyRecoverableRuntimeState(
    request.preflight.target.canonicalPath,
    runtimePaths.agentDir,
    request,
  );
  await request.commandContext!.reload!();
  options.onDidActivateProject?.(runtimePaths);
  return {
    activeProjectRoot: request.preflight.target.canonicalPath,
    reinitialized: true,
    preservedStatePath,
    sessionPath: request.commandContext?.sessionManager?.getSessionFile?.() || "",
    sessionId: request.commandContext?.sessionManager?.getSessionId?.() || "",
    message: `Reinitialized runtime views for ${request.preflight.target.canonicalPath}.`,
  };
}

function managedProjectContainer(paths: CanvastRuntimePaths): string {
  if (paths.persistenceMode !== "persistent" || !paths.sessionDir) {
    throw new ProjectLifecycleError(
      "persistent_project_required",
      "project.delete can only retire a persistently managed Canvast project.",
      { projectRoot: paths.projectRoot, persistenceMode: paths.persistenceMode },
    );
  }
  const projectsRoot = canonical(path.join(paths.canvastHome, "projects"));
  const projectContainer = canonical(path.dirname(paths.agentDir));
  if (path.dirname(projectContainer) !== projectsRoot
      || path.basename(projectContainer) !== paths.projectKey
      || canonical(path.dirname(paths.sessionDir)) !== projectContainer) {
    throw new ProjectLifecycleError(
      "unmanaged_project_state",
      "project.delete refused state outside the Canvast-managed project registry.",
      { projectRoot: paths.projectRoot, projectContainer, projectsRoot },
    );
  }
  if (!existsSync(projectContainer)) {
    throw new ProjectLifecycleError(
      "project_state_missing",
      "project.delete requires existing Canvast-managed project state.",
      { projectRoot: paths.projectRoot, projectContainer },
    );
  }
  const stat = lstatSync(projectContainer);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ProjectLifecycleError(
      "unmanaged_project_state",
      "project.delete refused a non-directory or symbolic-link project registry entry.",
      { projectRoot: paths.projectRoot, projectContainer },
    );
  }
  return projectContainer;
}

function retiredProjectPath(paths: CanvastRuntimePaths): string {
  const retiredRoot = canonical(path.join(paths.canvastHome, "retired-projects"));
  mkdirSync(retiredRoot, { recursive: true });
  let candidate = path.join(retiredRoot, `${timestampToken()}-${paths.projectKey}`);
  let index = 1;
  while (existsSync(candidate)) {
    candidate = path.join(retiredRoot, `${timestampToken()}-${paths.projectKey}-${index}`);
    index += 1;
  }
  return candidate;
}

async function retireProjectRuntime(
  request: ProjectLifecycleMutationRequest,
  targetPaths: CanvastRuntimePaths,
  options: CreateHarnessProjectLifecycleOwnerOptions,
): Promise<ProjectLifecycleMutationOutcome> {
  const projectContainer = managedProjectContainer(targetPaths);
  const retiredStatePath = retiredProjectPath(targetPaths);
  const targetProjectRoot = request.preflight.target.canonicalPath;
  const isActiveProject = targetProjectRoot === request.preflight.currentProjectRoot;
  const previousEnv = snapshotManagedEnv();
  const previousSessionPath = request.commandContext?.sessionManager?.getSessionFile?.() || "";
  let replacementPaths: CanvastRuntimePaths | undefined;
  let replacementSession: { sessionPath: string; sessionId: string } | undefined;
  let switchedToReplacement = false;

  if (isActiveProject) {
    ensureCommandActionAvailable(request, "switchSession", "project.delete");
    const replacementRoot = request.preflight.replacement?.canonicalPath;
    if (!replacementRoot) {
      throw new ProjectLifecycleError(
        "replacement_project_required",
        "project.delete requires a replacement before retiring the active project.",
        { targetProjectRoot },
      );
    }
    replacementPaths = resolveProjectRuntime(replacementRoot, request.workspaceRoot, options);
    const replacementSessionDir = ensurePersistentProjectSessions(replacementPaths, "project.open");
    replacementSession = await ensureSwitchableProjectSession(replacementRoot, replacementSessionDir);
  }

  try {
    if (replacementPaths && replacementSession) {
      applyRuntimeEnv(replacementPaths, request.workspaceRoot);
      const switched = await request.commandContext!.switchSession!(replacementSession.sessionPath, {
        withSession: async nextContext => {
          request.commandContext?.resultRelay?.setResultContext(nextContext);
        },
      });
      if (switched.cancelled) {
        throw new ProjectLifecycleError(
          "cancelled",
          "project.delete was cancelled before the replacement project became active.",
          { targetProjectRoot, replacementProjectRoot: replacementPaths.projectRoot },
        );
      }
      switchedToReplacement = true;
    }
    renameSync(projectContainer, retiredStatePath);
    if (replacementPaths) options.onDidActivateProject?.(replacementPaths);
  } catch (error) {
    if (existsSync(retiredStatePath) && !existsSync(projectContainer)) {
      renameSync(retiredStatePath, projectContainer);
    }
    restoreManagedEnv(previousEnv);
    if (switchedToReplacement && previousSessionPath && request.commandContext?.switchSession) {
      try {
        await request.commandContext.switchSession(previousSessionPath);
      } catch {
        throw new ProjectLifecycleError(
          "project_retire_rollback_failed",
          "project.delete failed and could not restore the previous active session.",
          { targetProjectRoot, retiredStatePath, cause: String(error) },
        );
      }
    }
    if (error instanceof ProjectLifecycleError) throw error;
    throw new ProjectLifecycleError(
      "project_retire_failed",
      "project.delete failed after restoring the prior managed state and active session.",
      { targetProjectRoot, cause: error instanceof Error ? error.message : String(error) },
    );
  }

  return {
    activeProjectRoot: replacementPaths?.projectRoot ?? request.preflight.currentProjectRoot,
    retired: true,
    retiredStatePath: canonical(retiredStatePath),
    sessionPath: replacementSession?.sessionPath
      ?? request.commandContext?.sessionManager?.getSessionFile?.()
      ?? "",
    sessionId: replacementSession?.sessionId
      ?? request.commandContext?.sessionManager?.getSessionId?.()
      ?? "",
    message: `Retired Canvast-managed state for ${targetProjectRoot} without deleting the project workspace.`,
  };
}

export function createHarnessProjectLifecycleOwner(
  options: CreateHarnessProjectLifecycleOwnerOptions = {},
): ProjectLifecycleOwner {
  return {
    async createProject(request: ProjectLifecycleMutationRequest): Promise<ProjectLifecycleMutationOutcome> {
      const runtimePaths = resolveProjectRuntime(request.preflight.target.canonicalPath, request.workspaceRoot, options);
      return await switchProjectSession("project.create", request, runtimePaths, true, options);
    },

    async openProject(request: ProjectLifecycleMutationRequest): Promise<ProjectLifecycleMutationOutcome> {
      const runtimePaths = resolveProjectRuntime(request.preflight.target.canonicalPath, request.workspaceRoot, options);
      return await switchProjectSession("project.open", request, runtimePaths, false, options);
    },

    async reinitializeProject(request: ProjectLifecycleMutationRequest): Promise<ProjectLifecycleMutationOutcome> {
      const runtimePaths = resolveProjectRuntime(request.preflight.target.canonicalPath, request.workspaceRoot, options);
      return await reinitializeProjectRuntime(request, runtimePaths, options);
    },

    async retireProject(request: ProjectLifecycleMutationRequest): Promise<ProjectLifecycleMutationOutcome> {
      const runtimePaths = resolveProjectRuntime(request.preflight.target.canonicalPath, request.workspaceRoot, options);
      return await retireProjectRuntime(request, runtimePaths, options);
    },
  };
}
