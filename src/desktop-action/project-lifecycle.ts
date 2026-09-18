/**
 * =============================================================================
 * Canvast — Project Lifecycle / 项目生命周期
 * =============================================================================
 * @file        src/desktop-action/project-lifecycle.ts
 * @brief       Shared typed session and project lifecycle contracts.
 * @description Keeps App and TUI on one fail-closed path for session trash
 *              deletion, project preflight, and live project switching.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type ProjectLifecycleOperation = "create" | "open" | "reinitialize" | "retire";

export interface ReplacementSessionResultRelay {
  readonly sessionContext?: ReplacementSessionContext;
  setResultContext(ctx: ReplacementSessionContext): void;
}

interface SessionCatalogItem {
  path: string;
  id: string;
  cwd: string;
  name?: string;
}

export interface SessionManagerLike {
  getCwd(): string;
  getSessionDir(): string;
  getSessionFile(): string | undefined;
  getSessionId(): string;
  getSessionName(): string | undefined;
}

export interface ReplacementSessionContext {
  sessionManager: SessionManagerLike;
  sendMessage?: ExtensionAPI["sendMessage"];
}

export interface ProjectLifecycleCommandContext {
  reload?: () => Promise<void>;
  newSession?: (options?: {
    parentSession?: string;
    setup?: (sessionManager: unknown) => Promise<void>;
    withSession?: (ctx: ReplacementSessionContext) => Promise<void>;
  }) => Promise<{ cancelled: boolean }>;
  switchSession?: (sessionPath: string, options?: {
    withSession?: (ctx: ReplacementSessionContext) => Promise<void>;
  }) => Promise<{ cancelled: boolean }>;
  sessionManager?: SessionManagerLike;
  resultRelay?: ReplacementSessionResultRelay;
}

export interface SessionDeleteReceipt {
  receiptType: "session-trash";
  sessionId: string;
  sessionName: string;
  sessionPath: string;
  trashedSessionPath: string;
  trashRoot: string;
  deletedAt: string;
  message: string;
}

export interface GitPreflightState {
  available: boolean;
  repositoryPresent: boolean;
  head: string;
  hasChanges: boolean;
  counts: {
    tracked: number;
    untracked: number;
    conflicts: number;
  };
  paths: {
    tracked: string[];
    untracked: string[];
    conflicts: string[];
  };
  errorCode?: string;
  errorMessage?: string;
}

export interface ProjectTargetInspection {
  inputPath: string;
  resolvedPath: string;
  canonicalPath: string;
  workspaceRoot: string;
  exists: boolean;
  isDirectory: boolean;
  entryCount: number;
  withinWorkspace: boolean;
  containsSymlink: boolean;
  git: GitPreflightState;
}

export interface ProjectPreflightIssue {
  code: string;
  scope: "workspace" | "current" | "target" | "operation";
  message: string;
}

export interface ProjectPreflightReceipt {
  receiptType: "project-preflight";
  operation: ProjectLifecycleOperation;
  currentProjectRoot: string;
  workspaceRoot: string;
  current: GitPreflightState;
  target: ProjectTargetInspection;
  replacement?: ProjectTargetInspection;
  revision: string;
  requiresApproval: boolean;
  canProceed: boolean;
  canProceedWithApproval: boolean;
  issues: ProjectPreflightIssue[];
  message: string;
}

export interface ProjectLifecycleMutationRequest {
  actionKind: "project.create" | "project.open" | "project.reinitialize" | "project.delete";
  operation: ProjectLifecycleOperation;
  inputPath: string;
  currentProjectRoot: string;
  workspaceRoot: string;
  expectedRevision?: string;
  approvedAcknowledgement?: boolean;
  preflight: ProjectPreflightReceipt;
  commandContext?: ProjectLifecycleCommandContext;
}

export interface ProjectLifecycleMutationOutcome {
  activeProjectRoot: string;
  created?: boolean;
  reinitialized?: boolean;
  retired?: boolean;
  retiredStatePath?: string;
  preservedStatePath?: string;
  sessionPath?: string;
  sessionId?: string;
  message?: string;
}

export interface ProjectLifecycleOwner {
  createProject(
    request: ProjectLifecycleMutationRequest,
  ): Promise<ProjectLifecycleMutationOutcome> | ProjectLifecycleMutationOutcome;
  openProject(
    request: ProjectLifecycleMutationRequest,
  ): Promise<ProjectLifecycleMutationOutcome> | ProjectLifecycleMutationOutcome;
  reinitializeProject(
    request: ProjectLifecycleMutationRequest,
  ): Promise<ProjectLifecycleMutationOutcome> | ProjectLifecycleMutationOutcome;
  retireProject(
    request: ProjectLifecycleMutationRequest,
  ): Promise<ProjectLifecycleMutationOutcome> | ProjectLifecycleMutationOutcome;
}

export interface ProjectLifecycleActionReceipt extends ProjectLifecycleMutationOutcome {
  receiptType: "project-lifecycle";
  actionKind: "project.create" | "project.open" | "project.reinitialize" | "project.delete";
  operation: ProjectLifecycleOperation;
  inputPath: string;
  currentProjectRoot: string;
  workspaceRoot: string;
  targetProjectRoot: string;
  preflightRevision: string;
  message: string;
}

export class ProjectLifecycleError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ProjectLifecycleError";
  }
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    let parent = path.dirname(resolved);
    const missing: string[] = [path.basename(resolved)];
    while (parent && path.dirname(parent) !== parent && !fs.existsSync(parent)) {
      missing.unshift(path.basename(parent));
      parent = path.dirname(parent);
    }
    try {
      const realParent = fs.realpathSync.native(parent);
      return path.join(realParent, ...missing);
    } catch {
      return resolved;
    }
  }
}

function pathInside(parent: string, candidate: string): boolean {
  const canonicalParent = canonicalPath(parent);
  const canonicalCandidate = canonicalPath(candidate);
  if (canonicalParent === canonicalCandidate) return true;
  const relative = path.relative(canonicalParent, canonicalCandidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function sanitizePathComponent(value: string): string {
  let output = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    const allowed = (code >= 48 && code <= 57)
      || (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || character === "-"
      || character === "_"
      || character === ".";
    output += allowed ? character : "_";
  }
  return output || "entry";
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

function uniqueTrashPath(root: string, baseName: string): string {
  let candidate = path.join(root, baseName);
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(root, `${baseName}-${index}`);
    index += 1;
  }
  return candidate;
}

async function listSessionCatalog(
  sessionManager: SessionManagerLike,
): Promise<SessionCatalogItem[]> {
  return await Promise.resolve(SessionManager.list(
    sessionManager.getCwd(),
    sessionManager.getSessionDir(),
  )) as SessionCatalogItem[];
}

function ensureSafeTrashRoot(root: string): string {
  if (fs.existsSync(root)) {
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ProjectLifecycleError(
        "unsafe_trash_root",
        `Trash root ${root} must be a real directory.`,
        { trashRoot: root },
      );
    }
  } else {
    fs.mkdirSync(root, { recursive: true });
  }
  return canonicalPath(root);
}

export async function trashSession(
  sessionManager: SessionManagerLike,
  sessionPath: string,
): Promise<SessionDeleteReceipt> {
  const catalog = await listSessionCatalog(sessionManager);
  const sessionDir = canonicalPath(sessionManager.getSessionDir());
  const activePath = sessionManager.getSessionFile();
  const canonicalTarget = canonicalPath(sessionPath);
  const catalogEntry = catalog.find(item => canonicalPath(item.path) === canonicalTarget);
  if (!catalogEntry) {
    throw new ProjectLifecycleError(
      "not_found",
      `Session ${sessionPath} is not present in the live session catalog.`,
      { sessionPath },
    );
  }
  if (!pathInside(sessionDir, canonicalTarget)) {
    throw new ProjectLifecycleError(
      "unsafe_session_path",
      `Session ${canonicalTarget} is outside the live session directory.`,
      { sessionPath: canonicalTarget, sessionDir },
    );
  }
  if (activePath && canonicalPath(activePath) === canonicalTarget) {
    throw new ProjectLifecycleError(
      "active_session",
      `Session ${canonicalTarget} is active and cannot be deleted.`,
      { sessionPath: canonicalTarget, activeSessionPath: canonicalPath(activePath) },
    );
  }
  const trashRoot = ensureSafeTrashRoot(path.join(sessionDir, ".trash"));
  const trashPath = uniqueTrashPath(
    trashRoot,
    `${timestampToken()}-${sanitizePathComponent(path.basename(canonicalTarget))}`,
  );
  fs.renameSync(canonicalTarget, trashPath);
  return {
    receiptType: "session-trash",
    sessionId: catalogEntry.id,
    sessionName: catalogEntry.name || "",
    sessionPath: canonicalTarget,
    trashedSessionPath: trashPath,
    trashRoot,
    deletedAt: new Date().toISOString(),
    message: `Moved session ${catalogEntry.id} to trash.`,
  };
}

function gitCommand(
  cwd: string,
  args: string[],
): { stdout: string; stderr: string; status: number | null; error?: NodeJS.ErrnoException } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status,
    error: result.error,
  };
}

function emptyGitState(
  available: boolean,
  repositoryPresent: boolean,
  errorCode?: string,
  errorMessage?: string,
): GitPreflightState {
  return {
    available,
    repositoryPresent,
    head: repositoryPresent ? "unknown" : "not_repo",
    hasChanges: false,
    counts: { tracked: 0, untracked: 0, conflicts: 0 },
    paths: { tracked: [], untracked: [], conflicts: [] },
    errorCode,
    errorMessage,
  };
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function parseGitStatus(stdout: string): Pick<GitPreflightState, "hasChanges" | "counts" | "paths"> {
  const tracked: string[] = [];
  const untracked: string[] = [];
  const conflicts: string[] = [];
  const records = stdout.split("\0").filter(item => item.length > 0);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const status = record.slice(0, 2);
    const entryPath = record.length > 3 ? record.slice(3) : "";
    if (status === "??") {
      untracked.push(entryPath);
      continue;
    }
    const isConflict = status.includes("U") || status === "AA" || status === "DD";
    if (isConflict) {
      conflicts.push(entryPath);
      continue;
    }
    tracked.push(entryPath);
    const renamed = status[0] === "R" || status[0] === "C" || status[1] === "R" || status[1] === "C";
    if (renamed && index + 1 < records.length) index += 1;
  }
  const trackedPaths = uniqueSorted(tracked);
  const untrackedPaths = uniqueSorted(untracked);
  const conflictPaths = uniqueSorted(conflicts);
  return {
    hasChanges: trackedPaths.length > 0 || untrackedPaths.length > 0 || conflictPaths.length > 0,
    counts: {
      tracked: trackedPaths.length,
      untracked: untrackedPaths.length,
      conflicts: conflictPaths.length,
    },
    paths: {
      tracked: trackedPaths,
      untracked: untrackedPaths,
      conflicts: conflictPaths,
    },
  };
}

function inspectGitState(projectRoot: string): GitPreflightState {
  const canonicalRoot = canonicalPath(projectRoot);
  if (!fs.existsSync(canonicalRoot)) return emptyGitState(true, false);
  const stat = fs.lstatSync(canonicalRoot);
  if (!stat.isDirectory()) return emptyGitState(true, false);

  const topLevel = gitCommand(canonicalRoot, ["rev-parse", "--show-toplevel"]);
  if (topLevel.error) {
    return emptyGitState(false, false, "git_unavailable", topLevel.error.message);
  }
  if (topLevel.status !== 0) {
    return emptyGitState(true, false);
  }

  const head = gitCommand(canonicalRoot, ["rev-parse", "--verify", "HEAD"]);
  const status = gitCommand(canonicalRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (status.error) {
    return emptyGitState(false, true, "git_status_failed", status.error.message);
  }
  if (status.status !== 0) {
    return emptyGitState(false, true, "git_status_failed", status.stderr.trim() || "git status failed.");
  }
  const parsed = parseGitStatus(status.stdout);
  return {
    available: true,
    repositoryPresent: true,
    head: head.status === 0 ? head.stdout.trim() : "initial",
    hasChanges: parsed.hasChanges,
    counts: parsed.counts,
    paths: parsed.paths,
  };
}

function hasWorkspaceRelativeSymlink(targetPath: string, workspaceRoot: string): boolean {
  const resolved = path.resolve(targetPath);
  const canonicalWorkspaceRoot = canonicalPath(workspaceRoot);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  let insideWorkspace = current === canonicalWorkspaceRoot;
  const remainder = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const segment of remainder) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) break;
    if (insideWorkspace && fs.lstatSync(current).isSymbolicLink()) return true;
    const canonicalCurrent = canonicalPath(current);
    if (canonicalCurrent === canonicalWorkspaceRoot || pathInside(canonicalWorkspaceRoot, canonicalCurrent)) {
      insideWorkspace = true;
    }
  }
  return false;
}

function inspectTargetPath(inputPath: string, workspaceRoot: string): ProjectTargetInspection {
  const resolvedPath = path.resolve(inputPath);
  const canonicalTarget = canonicalPath(resolvedPath);
  const exists = fs.existsSync(canonicalTarget);
  const isDirectory = exists ? fs.lstatSync(canonicalTarget).isDirectory() : false;
  const entryCount = exists && isDirectory ? fs.readdirSync(canonicalTarget).length : 0;
  return {
    inputPath,
    resolvedPath,
    canonicalPath: canonicalTarget,
    workspaceRoot: canonicalPath(workspaceRoot),
    exists,
    isDirectory,
    entryCount,
    withinWorkspace: pathInside(workspaceRoot, canonicalTarget),
    containsSymlink: hasWorkspaceRelativeSymlink(resolvedPath, workspaceRoot),
    git: inspectGitState(canonicalTarget),
  };
}

function issue(code: string, scope: ProjectPreflightIssue["scope"], message: string): ProjectPreflightIssue {
  return { code, scope, message };
}

function stableRevision(preflight: Omit<ProjectPreflightReceipt, "revision" | "message">): string {
  return createHash("sha256")
    .update(JSON.stringify(preflight))
    .digest("hex");
}

function preflightMessage(preflight: ProjectPreflightReceipt): string {
  if (preflight.canProceed) {
    return `Project ${preflight.operation} preflight passed for ${preflight.target.canonicalPath}.`;
  }
  if (preflight.canProceedWithApproval) {
    return `Project ${preflight.operation} preflight requires approved acknowledgement for ${preflight.target.canonicalPath}.`;
  }
  return `Project ${preflight.operation} preflight blocked for ${preflight.target.canonicalPath}.`;
}

export function inspectProjectPreflight(options: {
  operation: ProjectLifecycleOperation;
  inputPath: string;
  replacementPath?: string;
  currentProjectRoot: string;
  workspaceRoot: string;
}): ProjectPreflightReceipt {
  const currentProjectRoot = canonicalPath(options.currentProjectRoot);
  const workspaceRoot = canonicalPath(options.workspaceRoot);
  const current = inspectGitState(currentProjectRoot);
  const target = inspectTargetPath(options.inputPath, workspaceRoot);
  const replacement = options.replacementPath
    ? inspectTargetPath(options.replacementPath, workspaceRoot)
    : undefined;
  const issues: ProjectPreflightIssue[] = [];

  if (!pathInside(workspaceRoot, currentProjectRoot)) {
    issues.push(issue(
      "current_project_outside_workspace",
      "workspace",
      `Current project root ${currentProjectRoot} is outside workspace ${workspaceRoot}.`,
    ));
  }
  if (!target.withinWorkspace) {
    issues.push(issue(
      "unsafe_project_path",
      "workspace",
      `Target project path ${target.canonicalPath} is outside workspace ${workspaceRoot}.`,
    ));
  }
  if (target.containsSymlink) {
    issues.push(issue(
      "symlink_path_blocked",
      "workspace",
      `Target project path ${target.inputPath} contains a symbolic link and is rejected.`,
    ));
  }
  if (!current.available && current.repositoryPresent) {
    issues.push(issue(
      "current_git_unavailable",
      "current",
      current.errorMessage || "Current project git state could not be inspected.",
    ));
  }
  if (!target.git.available && target.git.repositoryPresent) {
    issues.push(issue(
      "target_git_unavailable",
      "target",
      target.git.errorMessage || "Target project git state could not be inspected.",
    ));
  }
  switch (options.operation) {
    case "create":
      if (target.exists && !target.isDirectory) {
        issues.push(issue(
          "target_not_directory",
          "target",
          `Target project path ${target.canonicalPath} exists and is not a directory.`,
        ));
      }
      if (target.exists && target.isDirectory && target.entryCount > 0) {
        issues.push(issue(
          "target_not_empty",
          "target",
          `Target project directory ${target.canonicalPath} is not empty.`,
        ));
      }
      break;
    case "open":
      if (!target.exists) {
        issues.push(issue(
          "target_missing",
          "target",
          `Target project path ${target.canonicalPath} does not exist.`,
        ));
      } else if (!target.isDirectory) {
        issues.push(issue(
          "target_not_directory",
          "target",
          `Target project path ${target.canonicalPath} is not a directory.`,
        ));
      }
      break;
    case "reinitialize":
      if (!target.exists) {
        issues.push(issue(
          "target_missing",
          "target",
          `Target project path ${target.canonicalPath} does not exist.`,
        ));
      } else if (!target.isDirectory) {
        issues.push(issue(
          "target_not_directory",
          "target",
          `Target project path ${target.canonicalPath} is not a directory.`,
        ));
      }
      if (target.canonicalPath !== currentProjectRoot) {
        issues.push(issue(
          "reinitialize_requires_active_project",
          "operation",
          `Project reinitialize is only allowed for the active project root ${currentProjectRoot}.`,
        ));
      }
      break;
    case "retire":
      if (!target.exists) {
        issues.push(issue(
          "target_missing",
          "target",
          `Target project path ${target.canonicalPath} does not exist.`,
        ));
      } else if (!target.isDirectory) {
        issues.push(issue(
          "target_not_directory",
          "target",
          `Target project path ${target.canonicalPath} is not a directory.`,
        ));
      }
      if (target.canonicalPath === currentProjectRoot) {
        if (!replacement) {
          issues.push(issue(
            "replacement_project_required",
            "operation",
            "Retiring the active project requires an existing replacement project.",
          ));
        } else if (!replacement.withinWorkspace || replacement.containsSymlink) {
          issues.push(issue(
            "unsafe_replacement_project",
            "workspace",
            `Replacement project path ${replacement.canonicalPath} must be a non-symlink path inside the workspace.`,
          ));
        } else if (!replacement.exists || !replacement.isDirectory) {
          issues.push(issue(
            "replacement_project_missing",
            "operation",
            `Replacement project path ${replacement.canonicalPath} must be an existing directory.`,
          ));
        } else if (replacement.canonicalPath === target.canonicalPath) {
          issues.push(issue(
            "replacement_project_matches_target",
            "operation",
            "Replacement project must differ from the project being retired.",
          ));
        }
      }
      break;
  }

  const requiresApproval = options.operation === "retire" || current.hasChanges || target.git.hasChanges;
  if (current.hasChanges) {
    issues.push(issue(
      "current_workspace_dirty",
      "current",
      `Current project root ${currentProjectRoot} has tracked, untracked, or conflict changes.`,
    ));
  }
  if (target.git.hasChanges) {
    issues.push(issue(
      "target_workspace_dirty",
      "target",
      `Target project root ${target.canonicalPath} has tracked, untracked, or conflict changes.`,
    ));
  }

  const blockingIssues = issues.filter(item =>
    item.code !== "current_workspace_dirty" && item.code !== "target_workspace_dirty",
  );
  const withoutRevision = {
    receiptType: "project-preflight" as const,
    operation: options.operation,
    currentProjectRoot,
    workspaceRoot,
    current,
    target,
    replacement,
    requiresApproval,
    canProceed: blockingIssues.length === 0 && !requiresApproval,
    canProceedWithApproval: blockingIssues.length === 0,
    issues,
  };
  const revision = stableRevision(withoutRevision);
  const preflight: ProjectPreflightReceipt = {
    ...withoutRevision,
    revision,
    message: "",
  };
  preflight.message = preflightMessage(preflight);
  return preflight;
}

export function requireApprovedPreflight(
  actionKind: "project.create" | "project.open" | "project.reinitialize" | "project.delete",
  preflight: ProjectPreflightReceipt,
  expectedRevision: string | undefined,
  approvedAcknowledgement: boolean | undefined,
): void {
  if (!preflight.canProceedWithApproval) {
    throw new ProjectLifecycleError(
      "project_preflight_blocked",
      `${actionKind} is blocked by project preflight.`,
      {
        actionKind,
        revision: preflight.revision,
        issues: preflight.issues,
        targetProjectRoot: preflight.target.canonicalPath,
      },
    );
  }
  if (preflight.requiresApproval) {
    if (!expectedRevision) {
      throw new ProjectLifecycleError(
        "expected_revision_required",
        `${actionKind} requires expectedRevision from project.preflight when approval is required.`,
        { actionKind, revision: preflight.revision },
      );
    }
    if (expectedRevision !== preflight.revision) {
      throw new ProjectLifecycleError(
        "stale_preflight",
        `${actionKind} expectedRevision does not match the current project preflight.`,
        { actionKind, expectedRevision, actualRevision: preflight.revision },
      );
    }
    if (approvedAcknowledgement !== true) {
      throw new ProjectLifecycleError(
        "approved_acknowledgement_required",
        `${actionKind} requires approvedAcknowledgement=true when approval is required.`,
        { actionKind, revision: preflight.revision },
      );
    }
  }
}

function canonicalOrThrow(value: string, label: string): string {
  if (!value.trim()) {
    throw new ProjectLifecycleError(
      "invalid_owner_receipt",
      `${label} must not be blank.`,
      { value },
    );
  }
  return canonicalPath(value);
}

export async function runProjectLifecycleAction(options: {
  actionKind: "project.create" | "project.open" | "project.reinitialize" | "project.delete";
  inputPath: string;
  currentProjectRoot: string;
  workspaceRoot: string;
  expectedRevision?: string;
  approvedAcknowledgement?: boolean;
  preflight: ProjectPreflightReceipt;
  owner?: ProjectLifecycleOwner;
  commandContext?: ProjectLifecycleCommandContext;
}): Promise<ProjectLifecycleActionReceipt> {
  requireApprovedPreflight(
    options.actionKind,
    options.preflight,
    options.expectedRevision,
    options.approvedAcknowledgement,
  );
  if (!options.owner) {
    throw new ProjectLifecycleError(
      "handler_unavailable",
      `${options.actionKind} requires a live project lifecycle owner.`,
      { actionKind: options.actionKind },
    );
  }
  const request: ProjectLifecycleMutationRequest = {
    actionKind: options.actionKind,
    operation: options.preflight.operation,
    inputPath: options.inputPath,
    currentProjectRoot: options.preflight.currentProjectRoot,
    workspaceRoot: options.preflight.workspaceRoot,
    expectedRevision: options.expectedRevision,
    approvedAcknowledgement: options.approvedAcknowledgement,
    preflight: options.preflight,
    commandContext: options.commandContext,
  };
  const outcome = options.actionKind === "project.create"
    ? await options.owner.createProject(request)
    : options.actionKind === "project.open"
      ? await options.owner.openProject(request)
      : options.actionKind === "project.reinitialize"
        ? await options.owner.reinitializeProject(request)
        : await options.owner.retireProject(request);

  const activeProjectRoot = canonicalOrThrow(outcome.activeProjectRoot, "activeProjectRoot");
  const expectedActiveProjectRoot = options.actionKind === "project.delete"
    ? options.preflight.replacement?.canonicalPath ?? options.preflight.currentProjectRoot
    : options.preflight.target.canonicalPath;
  if (activeProjectRoot !== expectedActiveProjectRoot) {
    throw new ProjectLifecycleError(
      "project_switch_not_confirmed",
      `${options.actionKind} did not confirm the requested project root.`,
      {
        actionKind: options.actionKind,
        expectedProjectRoot: expectedActiveProjectRoot,
        activeProjectRoot,
      },
    );
  }
  if (options.actionKind === "project.create" && outcome.created !== true) {
    throw new ProjectLifecycleError(
      "project_create_not_confirmed",
      "project.create did not confirm a created project root.",
      { activeProjectRoot },
    );
  }
  if (options.actionKind === "project.reinitialize") {
    if (outcome.reinitialized !== true) {
      throw new ProjectLifecycleError(
        "project_reinitialize_not_confirmed",
        "project.reinitialize did not confirm reinitialization.",
        { activeProjectRoot },
      );
    }
    if (typeof outcome.preservedStatePath !== "string" || !outcome.preservedStatePath.trim()) {
      throw new ProjectLifecycleError(
        "preserved_state_required",
        "project.reinitialize must report a recoverable preservedStatePath.",
        { activeProjectRoot },
      );
    }
  }
  if (options.actionKind === "project.delete") {
    if (outcome.retired !== true) {
      throw new ProjectLifecycleError(
        "project_retire_not_confirmed",
        "project.delete did not confirm retirement.",
        { activeProjectRoot },
      );
    }
    if (typeof outcome.retiredStatePath !== "string" || !outcome.retiredStatePath.trim()) {
      throw new ProjectLifecycleError(
        "retired_state_path_required",
        "project.delete must report a recoverable retiredStatePath.",
        { activeProjectRoot },
      );
    }
  }
  return {
    ...outcome,
    activeProjectRoot,
    receiptType: "project-lifecycle",
    actionKind: options.actionKind,
    operation: options.preflight.operation,
    inputPath: options.inputPath,
    currentProjectRoot: options.preflight.currentProjectRoot,
    workspaceRoot: options.preflight.workspaceRoot,
    targetProjectRoot: options.preflight.target.canonicalPath,
    preflightRevision: options.preflight.revision,
    message: outcome.message || `${options.actionKind} accepted for ${activeProjectRoot}.`,
  };
}

export function workspaceRootFromContext(
  commandContext: ProjectLifecycleCommandContext | undefined,
  fallbackProjectRoot: string,
): string {
  const workingRoot = process.env.CANVAST_WORKING_DIR;
  const projectRoot = process.env.CANVAST_PROJECT_ROOT;
  if (workingRoot && workingRoot.trim() && projectRoot && projectRoot.trim()) {
    const canonicalWorkingRoot = canonicalPath(workingRoot);
    const canonicalProjectRoot = canonicalPath(projectRoot);
    if (canonicalWorkingRoot !== canonicalProjectRoot) return canonicalWorkingRoot;
  }
  const sessionRoot = commandContext?.sessionManager?.getCwd();
  return canonicalPath(sessionRoot && sessionRoot.trim() ? sessionRoot : fallbackProjectRoot);
}
