/**
 * =============================================================================
 * Canvast — Canvast Project Scope / Canvast 源文件
 * =============================================================================
 * @file        src/harness/canvast-project-scope.ts
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type ProjectScopeRelation =
  | "same"
  | "inside_persisted"
  | "contains_persisted"
  | "unrelated"
  | "unknown";

export interface ProjectScopeState {
  projectRoot: string;
  updatedAt: string;
  revision: number;
  source: "default" | "command" | "auto";
}

export interface ProjectScopeDecision {
  relation: ProjectScopeRelation;
  canLoadCanvas: boolean;
  canInjectScopedView: boolean;
  advisory: string;
  state: ProjectScopeState;
}

export interface ProjectScopeController {
  inspect(cwd?: string): ProjectScopeDecision;
  rebind(cwd?: string, source?: ProjectScopeState["source"]): ProjectScopeState;
  renderStatus(cwd?: string): string;
}

export interface ProjectScopeControllerOptions {
  persist?: boolean;
}

export function projectScopeFile(agentDir: string): string {
  return path.join(agentDir, "canvast-project-scope.json");
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

function relationBetween(current: string, persisted: string): ProjectScopeRelation {
  const cwd = canonical(current);
  const root = canonical(persisted);
  if (!cwd || !root) return "unknown";
  if (cwd === root) return "same";
  const fromRoot = path.relative(root, cwd);
  if (fromRoot && !fromRoot.startsWith("..") && !path.isAbsolute(fromRoot)) return "inside_persisted";
  const fromCwd = path.relative(cwd, root);
  if (fromCwd && !fromCwd.startsWith("..") && !path.isAbsolute(fromCwd)) return "contains_persisted";
  return "unrelated";
}

export function readProjectScopeState(agentDir: string): ProjectScopeState | undefined {
  const file = projectScopeFile(agentDir);
  if (!fs.existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (typeof raw?.projectRoot !== "string" || !raw.projectRoot.trim()) return undefined;
    return {
      projectRoot: canonical(raw.projectRoot),
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
      revision: Number.isFinite(Number(raw.revision)) ? Number(raw.revision) : 0,
      source: raw.source === "command" || raw.source === "auto" ? raw.source : "default",
    };
  } catch {
    return undefined;
  }
}

function writeProjectScopeState(agentDir: string, state: ProjectScopeState): void {
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(projectScopeFile(agentDir), JSON.stringify(state, null, 2));
}

function advisoryFor(relation: ProjectScopeRelation, state: ProjectScopeState, cwd: string): string {
  switch (relation) {
    case "same":
      return "Canvas is bound to the current project root.";
    case "inside_persisted":
      return "Current cwd is inside the persisted Canvast project root. Canvas can be loaded, but a light refresh is recommended before relying on stale file scope.";
    case "contains_persisted":
      return `Current cwd contains the persisted Canvast project root (${state.projectRoot}). The old Canvas is partial for this wider project, so it is kept as history but not automatically injected. Rebind before using enhanced scoped view.`;
    case "unrelated":
      return `Current cwd (${canonical(cwd)}) is unrelated to persisted Canvast project root (${state.projectRoot}). Old Canvas is isolated and will not be injected into this project.`;
    default:
      return "Canvast project scope is unknown; Canvas scoped injection is disabled until rebind.";
  }
}

function decisionFor(state: ProjectScopeState, cwd: string): ProjectScopeDecision {
  const relation = relationBetween(cwd, state.projectRoot);
  const canLoadCanvas = relation === "same" || relation === "inside_persisted";
  return {
    relation,
    canLoadCanvas,
    canInjectScopedView: canLoadCanvas,
    advisory: advisoryFor(relation, state, cwd),
    state,
  };
}

export function createProjectScopeController(
  agentDir: string,
  cwd = process.cwd(),
  now = new Date().toISOString(),
  options: ProjectScopeControllerOptions = {},
): ProjectScopeController {
  const canPersist = options.persist !== false;
  const existingState = canPersist ? readProjectScopeState(agentDir) : undefined;
  let state: ProjectScopeState = existingState || {
      projectRoot: canonical(cwd),
      updatedAt: now,
      revision: 0,
      source: "default",
  };
  if (!existingState && canPersist) {
    writeProjectScopeState(agentDir, state);
  }

  return {
    inspect(currentCwd = process.cwd()) {
      return decisionFor(state, currentCwd);
    },
    rebind(currentCwd = process.cwd(), source: ProjectScopeState["source"] = "command") {
      state = {
        projectRoot: canonical(currentCwd),
        updatedAt: new Date().toISOString(),
        revision: state.revision + 1,
        source,
      };
      if (canPersist) writeProjectScopeState(agentDir, state);
      return state;
    },
    renderStatus(currentCwd = process.cwd()) {
      const decision = decisionFor(state, currentCwd);
      return [
        `Canvast project root: ${state.projectRoot}`,
        `current_cwd=${canonical(currentCwd)}`,
        `relation=${decision.relation}`,
        `can_load_canvas=${decision.canLoadCanvas}`,
        `can_inject_scoped_view=${decision.canInjectScopedView}`,
        `revision=${state.revision}`,
        `updated_at=${state.updatedAt}`,
        decision.advisory,
      ].join("\n");
    },
  };
}
