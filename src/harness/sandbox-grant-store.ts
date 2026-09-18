/**
 * =============================================================================
 * Canvast — Sandbox Grant Store / Canvast 沙箱授权存储
 * =============================================================================
 * @file        src/harness/sandbox-grant-store.ts
 * @brief       Revisioned shared ownership for retained sandbox grants.
 * @description Shares session grants between controllers in one process and
 *              serializes project grants across processes without stale writes.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  readProtectedTextFile,
  withOwnedFileLock,
  writeProtectedTextFileAtomic,
} from "./context-continuity/filesystem.js";
import {
  captureSandboxPathIdentity,
  type SandboxPathIdentity,
} from "./sandbox-path-identity.js";
import { canonical } from "./sandbox-path-policy.js";

export type SandboxGrantScope = "session" | "project" | "once";
export type SandboxGrantKind = "command" | "write_path" | "read_path" | "profile";
export type RetainedSandboxGrantScope = Exclude<SandboxGrantScope, "once">;

export interface SandboxGrant {
  id: string;
  scope: RetainedSandboxGrantScope;
  kind: SandboxGrantKind;
  value: string;
  pathIdentity?: SandboxPathIdentity;
  createdAt: string;
  reason: string;
}

export interface SandboxGrantSnapshot {
  version: 2;
  revision: number;
  grants: SandboxGrant[];
}

export interface SandboxGrantMutationResult extends SandboxGrantSnapshot {
  createdGrants: SandboxGrant[];
}

export interface SandboxGrantRevokeReceipt extends SandboxGrantSnapshot {
  removedGrant: SandboxGrant;
  futureOperationsOnly: true;
  message: string;
}

export type SandboxGrantStoreErrorCode =
  | "grant_not_found"
  | "revision_conflict"
  | "ambiguous_grant";

export class SandboxGrantStoreError extends Error {
  constructor(
    readonly code: SandboxGrantStoreErrorCode,
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SandboxGrantStoreError";
  }
}

interface PersistedGrantState {
  version: 2;
  revision: number;
  updatedAt: string;
  grants: SandboxGrant[];
}

interface GrantRequest {
  kind: SandboxGrantKind;
  value: string;
  pathIdentity?: SandboxPathIdentity;
}

interface GrantInput {
  scope: RetainedSandboxGrantScope;
  requests: GrantRequest[];
  reason: string;
}

interface RevokeInput {
  grantId: string;
  expectedRevision: number;
}

interface ReducedGrantMutation {
  sessionGrants: SandboxGrant[];
  projectGrants: SandboxGrant[];
  createdGrants: SandboxGrant[];
}

type SandboxGrantPersistenceMode = "persistent" | "ephemeral";

interface AgentDirGrantState {
  sessionGrants: SandboxGrant[];
  stores: Partial<Record<SandboxGrantPersistenceMode, SandboxGrantStore>>;
}

const LOCK_OPTIONS = { timeoutMs: 5_000, retryMs: 10 };
const stores = new Map<string, AgentDirGrantState>();

function grantStateFor(agentDir: string): AgentDirGrantState {
  let state = stores.get(agentDir);
  if (!state) {
    state = { sessionGrants: [], stores: {} };
    stores.set(agentDir, state);
  }
  return state;
}

function isRetainedScope(value: unknown): value is RetainedSandboxGrantScope {
  return value === "session" || value === "project";
}

function isGrantKind(value: unknown): value is SandboxGrantKind {
  return value === "command" || value === "write_path" ||
    value === "read_path" || value === "profile";
}

function normalizePathIdentity(value: unknown): SandboxPathIdentity | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const identity = value as Partial<SandboxPathIdentity>;
  if (
    typeof identity.dev !== "number" || !Number.isSafeInteger(identity.dev) ||
    typeof identity.ino !== "number" || !Number.isSafeInteger(identity.ino)
  ) return undefined;
  return { dev: identity.dev, ino: identity.ino };
}

function normalizeGrant(value: unknown): SandboxGrant | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const grant = value as Partial<SandboxGrant>;
  if (
    typeof grant.id !== "string" || !grant.id ||
    !isRetainedScope(grant.scope) ||
    !isGrantKind(grant.kind) ||
    typeof grant.value !== "string" || !grant.value ||
    typeof grant.createdAt !== "string" ||
    typeof grant.reason !== "string"
  ) return undefined;
  return {
    id: grant.id,
    scope: grant.scope,
    kind: grant.kind,
    value: canonicalGrantValue(grant.kind, grant.value),
    pathIdentity: normalizePathIdentity(grant.pathIdentity),
    createdAt: grant.createdAt,
    reason: grant.reason,
  };
}

function canonicalGrantValue(kind: SandboxGrantKind, value: string): string {
  const normalized = value.trim();
  return kind === "read_path" || kind === "write_path"
    ? canonical(normalized)
    : normalized;
}

function cloneGrant(grant: SandboxGrant): SandboxGrant {
  return {
    ...grant,
    pathIdentity: grant.pathIdentity ? { ...grant.pathIdentity } : undefined,
  };
}

function cloneGrants(grants: readonly SandboxGrant[]): SandboxGrant[] {
  return grants.map(cloneGrant);
}

function parsePersistedState(raw: string | undefined): PersistedGrantState {
  const now = new Date().toISOString();
  if (raw === undefined) return { version: 2, revision: 0, updatedAt: now, grants: [] };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { version: 2, revision: 0, updatedAt: now, grants: [] };
  }
  if (typeof value !== "object" || value === null) {
    return { version: 2, revision: 0, updatedAt: now, grants: [] };
  }
  const record = value as {
    version?: unknown;
    revision?: unknown;
    updatedAt?: unknown;
    grants?: unknown;
  };
  const grants = Array.isArray(record.grants)
    ? record.grants.map(normalizeGrant).filter((grant): grant is SandboxGrant => grant?.scope === "project")
    : [];
  return {
    version: 2,
    revision: record.version === 2 && Number.isInteger(record.revision) &&
      Number(record.revision) >= 0 ? Number(record.revision) : 0,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : now,
    grants,
  };
}

export class SandboxGrantStore {
  private readonly agentDir: string;
  private readonly targetFile: string;
  private readonly persistenceMode: SandboxGrantPersistenceMode;
  private readonly sharedState: AgentDirGrantState;
  private ephemeralProjectGrants: SandboxGrant[] = [];
  private ephemeralRevision = 0;

  constructor(agentDir: string, persistenceMode: SandboxGrantPersistenceMode) {
    this.agentDir = canonical(agentDir);
    this.targetFile = path.join(this.agentDir, "canvast-sandbox-grants.json");
    this.persistenceMode = persistenceMode;
    this.sharedState = grantStateFor(this.agentDir);
    fs.mkdirSync(this.agentDir, { recursive: true });
  }

  snapshot(): SandboxGrantSnapshot {
    const project = this.persistenceMode === "persistent"
      ? this.readPersisted()
      : {
        version: 2 as const,
        revision: this.ephemeralRevision,
        updatedAt: new Date().toISOString(),
        grants: this.ephemeralProjectGrants,
      };
    return this.snapshotFrom(project.revision, project.grants);
  }

  grant(input: GrantInput): SandboxGrantMutationResult {
    const requests = input.requests.map(request => ({
      kind: request.kind,
      value: canonicalGrantValue(request.kind, request.value),
      pathIdentity: request.pathIdentity ??
        (request.kind === "read_path" || request.kind === "write_path"
          ? captureSandboxPathIdentity(request.value)
          : undefined),
    }));
    if (this.persistenceMode === "ephemeral") {
      const reduced = this.reduceGrant(input.scope, requests, input.reason, this.ephemeralProjectGrants);
      this.sharedState.sessionGrants = reduced.sessionGrants;
      this.ephemeralProjectGrants = reduced.projectGrants;
      this.ephemeralRevision += 1;
      const snapshot = this.snapshotFrom(this.ephemeralRevision, this.ephemeralProjectGrants);
      return { ...snapshot, createdGrants: cloneGrants(reduced.createdGrants) };
    }
    return withOwnedFileLock(this.targetFile, LOCK_OPTIONS, () => {
      const current = this.readPersisted();
      const reduced = this.reduceGrant(input.scope, requests, input.reason, current.grants);
      const next = this.nextPersistedState(current, reduced.projectGrants);
      this.writePersisted(next);
      this.sharedState.sessionGrants = reduced.sessionGrants;
      return {
        ...this.snapshotFrom(next.revision, next.grants),
        createdGrants: cloneGrants(reduced.createdGrants),
      };
    });
  }

  revoke(input: RevokeInput): SandboxGrantRevokeReceipt {
    if (this.persistenceMode === "ephemeral") {
      return this.revokeCurrent(input, this.ephemeralRevision, this.ephemeralProjectGrants, next => {
        this.ephemeralProjectGrants = next;
        this.ephemeralRevision += 1;
        return this.ephemeralRevision;
      });
    }
    return withOwnedFileLock(this.targetFile, LOCK_OPTIONS, () => {
      const current = this.readPersisted();
      return this.revokeCurrent(input, current.revision, current.grants, nextProjectGrants => {
        const next = this.nextPersistedState(current, nextProjectGrants);
        this.writePersisted(next);
        return next.revision;
      });
    });
  }

  private reduceGrant(
    scope: RetainedSandboxGrantScope,
    requests: GrantRequest[],
    reason: string,
    currentProjectGrants: readonly SandboxGrant[],
  ): ReducedGrantMutation {
    const sessionGrants = cloneGrants(this.sharedState.sessionGrants);
    const projectGrants = cloneGrants(currentProjectGrants);
    const target = scope === "session" ? sessionGrants : projectGrants;
    const now = new Date().toISOString();
    const created: SandboxGrant[] = [];
    for (const request of requests) {
      const grant: SandboxGrant = {
        id: this.freshGrantId([...sessionGrants, ...projectGrants, ...created]),
        scope,
        kind: request.kind,
        value: request.value,
        pathIdentity: request.pathIdentity,
        createdAt: now,
        reason,
      };
      const index = target.findIndex(item =>
        item.scope === scope && item.kind === grant.kind && item.value === grant.value);
      if (index >= 0) target[index] = grant;
      else target.push(grant);
      created.push(grant);
    }
    return { sessionGrants, projectGrants, createdGrants: created };
  }

  private revokeCurrent(
    input: RevokeInput,
    revision: number,
    projectGrants: SandboxGrant[],
    commit: (nextProjectGrants: SandboxGrant[]) => number,
  ): SandboxGrantRevokeReceipt {
    if (input.expectedRevision !== revision) {
      throw new SandboxGrantStoreError(
        "revision_conflict",
        `Sandbox grant revision changed from ${input.expectedRevision} to ${revision}.`,
        { expectedRevision: input.expectedRevision, actualRevision: revision },
      );
    }
    const matches = [...projectGrants, ...this.sharedState.sessionGrants]
      .filter(grant => grant.id === input.grantId);
    if (matches.length === 0) {
      throw new SandboxGrantStoreError(
        "grant_not_found",
        `Sandbox grant no longer exists: ${input.grantId}.`,
        { grantId: input.grantId, revision },
      );
    }
    if (matches.length !== 1) {
      throw new SandboxGrantStoreError(
        "ambiguous_grant",
        `Sandbox grant ID is not unique: ${input.grantId}.`,
        { grantId: input.grantId, revision, matches: matches.length },
      );
    }
    const removedGrant = matches[0];
    const nextSessionGrants = removedGrant.scope === "session"
      ? this.sharedState.sessionGrants.filter(grant => grant.id !== input.grantId)
      : this.sharedState.sessionGrants;
    const nextProjectGrants = removedGrant.scope === "project"
      ? projectGrants.filter(grant => grant.id !== input.grantId)
      : projectGrants;
    const nextRevision = commit(nextProjectGrants);
    this.sharedState.sessionGrants = nextSessionGrants;
    const snapshot = this.snapshotFrom(nextRevision, nextProjectGrants);
    return {
      ...snapshot,
      removedGrant: cloneGrant(removedGrant),
      futureOperationsOnly: true,
      message: "Grant revoked for subsequent authorization checks. Already-started operations were not terminated. / 授权已撤销，后续鉴权将生效；已启动的操作不会被终止。",
    };
  }

  private freshGrantId(existing: readonly SandboxGrant[]): string {
    const ids = new Set(existing.map(grant => grant.id));
    let id = randomUUID();
    while (ids.has(id)) id = randomUUID();
    return id;
  }

  private snapshotFrom(revision: number, projectGrants: readonly SandboxGrant[]): SandboxGrantSnapshot {
    return {
      version: 2,
      revision,
      grants: cloneGrants([...projectGrants, ...this.sharedState.sessionGrants]),
    };
  }

  private readPersisted(): PersistedGrantState {
    return parsePersistedState(readProtectedTextFile(this.targetFile));
  }

  private nextPersistedState(
    current: PersistedGrantState,
    grants: readonly SandboxGrant[],
  ): PersistedGrantState {
    return {
      version: 2,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
      grants: cloneGrants(grants.filter(grant => grant.scope === "project")),
    };
  }

  private writePersisted(state: PersistedGrantState): void {
    writeProtectedTextFileAtomic(this.targetFile, `${JSON.stringify(state, null, 2)}\n`);
  }
}

export function getSandboxGrantStore(
  agentDir: string,
  persistenceMode: SandboxGrantPersistenceMode = "persistent",
): SandboxGrantStore {
  const canonicalAgentDir = canonical(agentDir);
  const state = grantStateFor(canonicalAgentDir);
  let store = state.stores[persistenceMode];
  if (!store) {
    store = new SandboxGrantStore(canonicalAgentDir, persistenceMode);
    state.stores[persistenceMode] = store;
  }
  return store;
}
