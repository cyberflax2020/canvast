/**
 * =============================================================================
 * Canvast — Owned Handle Registry / 自有句柄注册表
 * =============================================================================
 * @file        src/utils/owned-handle-registry.ts
 * @brief       Typed ownership and cleanup-evidence registry for runtime handles.
 * @description Tracks only resources explicitly owned by Canvast. Unknown OS
 *              cleanup remains visible until a process snapshot proves that
 *              the recorded PID/birth identity is gone or an operator
 *              explicitly acknowledges it. Host unified-exec handles are
 *              outside this registry's observation and kill boundary.
 *              跟踪 Canvast 明确拥有的运行时资源；未知清理结果会保留，直到
 *              进程快照确认对应 PID/出生标识已消失或操作员显式确认。宿主
 *              unified-exec 句柄不属于本注册表的观测与终止边界。
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import { randomUUID } from "node:crypto";

export const OWNED_HANDLE_REGISTRY_SNAPSHOT_VERSION = 1 as const;
export const OWNED_HANDLE_REGISTRY_SNAPSHOT_KIND = "canvast-owned-handle-registry" as const;

export const OWNED_HANDLE_TYPES = [
  "os-process",
  "sdk-session",
  "timer",
  "listener",
  "watcher",
  "server",
] as const;

export const OWNED_HANDLE_STATES = [
  "active",
  "settling",
  "unconfirmed",
  "released",
] as const;

export type OwnedHandleType = (typeof OWNED_HANDLE_TYPES)[number];
export type OwnedHandleState = (typeof OWNED_HANDLE_STATES)[number];
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type OwnedHandleMetadata = Readonly<Record<string, JsonValue>>;

interface OwnedHandleRegistrationBase {
  owner: string;
  source: string;
  scope?: string;
  metadata?: OwnedHandleMetadata;
}

export interface OwnedOsProcessRegistration extends OwnedHandleRegistrationBase {
  type: "os-process";
  pid: number;
  pgid: number;
  birth: string;
}

export interface OwnedInProcessHandleRegistration extends OwnedHandleRegistrationBase {
  type: Exclude<OwnedHandleType, "os-process">;
  pid?: never;
  pgid?: never;
  birth?: never;
}

export type OwnedHandleRegistration =
  | OwnedOsProcessRegistration
  | OwnedInProcessHandleRegistration;

export interface OwnedOsProcessRecord {
  pid: number;
  pgid: number;
  birth: string;
}

export interface OwnedOsProcessIdentity {
  pid: number;
  pgid: number;
  birth: string;
}

export interface OwnedHandleSnapshotEntry {
  id: string;
  type: OwnedHandleType;
  state: OwnedHandleState;
  owner: string;
  source: string;
  scope: string | null;
  registeredAt: string;
  updatedAt: string;
  unconfirmedReason: string | null;
  process: OwnedOsProcessIdentity | null;
  metadata: Record<string, JsonValue>;
}

export interface OwnedHandleRegistrySnapshot {
  version: typeof OWNED_HANDLE_REGISTRY_SNAPSHOT_VERSION;
  kind: typeof OWNED_HANDLE_REGISTRY_SNAPSHOT_KIND;
  capturedAt: string;
  activeCount: number;
  unconfirmedCount: number;
  settlingCount: number;
  admission: {
    globallyFrozen: boolean;
    frozenScopes: string[];
  };
  boundary: {
    hostUnifiedExec: {
      excluded: true;
      observedAsOsProcess: false;
      killAllowed: false;
      reason: "host-unified-exec-handles-are-not-owned-os-processes";
    };
  };
  entries: OwnedHandleSnapshotEntry[];
}

export interface OwnedHandleReconciliation {
  releasedIds: string[];
  retainedIds: string[];
}

export interface OwnedHandleLease {
  readonly id: string;
  markSettling(): OwnedHandleSnapshotEntry;
  markUnconfirmed(reason: string): OwnedHandleSnapshotEntry;
  release(): OwnedHandleSnapshotEntry;
  snapshot(): OwnedHandleSnapshotEntry;
}

export interface OwnedHandleAdmissionFreeze {
  readonly scope: string | null;
  release(): void;
}

export interface OwnedHandleRegistryOptions {
  now?: () => Date | string | number;
  createId?: () => string;
}

interface MutableOwnedHandleEntry extends OwnedHandleSnapshotEntry {
  metadata: Record<string, JsonValue>;
}

const HOST_UNIFIED_EXEC_BOUNDARY = Object.freeze({
  excluded: true as const,
  observedAsOsProcess: false as const,
  killAllowed: false as const,
  reason: "host-unified-exec-handles-are-not-owned-os-processes" as const,
});

export class OwnedHandleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnedHandleValidationError";
  }
}

export class OwnedHandleAdmissionError extends Error {
  constructor(readonly scope: string | null) {
    super(scope === null
      ? "Owned handle admission is globally frozen."
      : `Owned handle admission is frozen for scope ${scope}.`);
    this.name = "OwnedHandleAdmissionError";
  }
}

export class OwnedHandleStateError extends Error {
  constructor(readonly handleId: string, message: string) {
    super(message);
    this.name = "OwnedHandleStateError";
  }
}

export class OwnedHandleRegistry {
  private readonly entries = new Map<string, MutableOwnedHandleEntry>();
  private readonly globalAdmissionFreezes = new Set<string>();
  private readonly scopedAdmissionFreezes = new Map<string, Set<string>>();
  private readonly now: () => Date | string | number;
  private readonly createId: () => string;

  constructor(options: OwnedHandleRegistryOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  register(input: OwnedHandleRegistration): OwnedHandleLease {
    const normalized = normalizeRegistration(input);
    if (!this.accepting(normalized.scope ?? undefined)) {
      throw new OwnedHandleAdmissionError(
        this.globalAdmissionFreezes.size > 0 ? null : normalized.scope,
      );
    }

    const id = requireNonEmpty(this.createId(), "generated handle id");
    if (this.entries.has(id)) {
      throw new OwnedHandleValidationError(`Duplicate owned handle id: ${id}`);
    }
    const timestamp = this.timestamp();
    const entry: MutableOwnedHandleEntry = {
      id,
      type: normalized.type,
      state: "active",
      owner: normalized.owner,
      source: normalized.source,
      scope: normalized.scope,
      registeredAt: timestamp,
      updatedAt: timestamp,
      unconfirmedReason: null,
      process: normalized.process,
      metadata: normalized.metadata,
    };
    this.entries.set(id, entry);

    return {
      id,
      markSettling: () => this.markSettling(entry),
      markUnconfirmed: (reason) => this.markUnconfirmed(entry, reason),
      release: () => this.release(entry),
      snapshot: () => snapshotEntry(entry),
    };
  }

  freezeAdmission(scope?: string): OwnedHandleAdmissionFreeze {
    const normalizedScope = scope === undefined ? null : requireNonEmpty(scope, "scope");
    const token = requireNonEmpty(this.createId(), "generated admission freeze id");
    const tokens = normalizedScope === null
      ? this.globalAdmissionFreezes
      : this.scopedAdmissionFreezes.get(normalizedScope) ?? new Set<string>();
    tokens.add(token);
    if (normalizedScope !== null) this.scopedAdmissionFreezes.set(normalizedScope, tokens);

    let released = false;
    return {
      scope: normalizedScope,
      release: () => {
        if (released) return;
        released = true;
        tokens.delete(token);
        if (normalizedScope !== null && tokens.size === 0) {
          this.scopedAdmissionFreezes.delete(normalizedScope);
        }
      },
    };
  }

  accepting(scope?: string): boolean {
    if (this.globalAdmissionFreezes.size > 0) return false;
    if (scope === undefined) return true;
    const normalizedScope = requireNonEmpty(scope, "scope");
    return (this.scopedAdmissionFreezes.get(normalizedScope)?.size ?? 0) === 0;
  }

  diagnosticSnapshot(): OwnedHandleRegistrySnapshot {
    const entries = Array.from(this.entries.values(), snapshotEntry)
      .sort((left, right) => left.registeredAt.localeCompare(right.registeredAt)
        || left.id.localeCompare(right.id));
    return {
      version: OWNED_HANDLE_REGISTRY_SNAPSHOT_VERSION,
      kind: OWNED_HANDLE_REGISTRY_SNAPSHOT_KIND,
      capturedAt: this.timestamp(),
      activeCount: entries.filter((entry) => entry.state === "active").length,
      unconfirmedCount: entries.filter((entry) => entry.state === "unconfirmed").length,
      settlingCount: entries.filter((entry) => entry.state === "settling").length,
      admission: {
        globallyFrozen: this.globalAdmissionFreezes.size > 0,
        frozenScopes: Array.from(this.scopedAdmissionFreezes.keys()).sort(),
      },
      boundary: { hostUnifiedExec: { ...HOST_UNIFIED_EXEC_BOUNDARY } },
      entries,
    };
  }

  reconcileProcesses(records: readonly OwnedOsProcessRecord[]): OwnedHandleReconciliation {
    const identities = new Set(records.map((record) => {
      validateProcessIdentity(record);
      return processIdentityKey(record.pid, record.birth);
    }));
    const releasedIds: string[] = [];
    const retainedIds: string[] = [];

    for (const entry of this.entries.values()) {
      if (entry.type !== "os-process" || entry.state !== "unconfirmed" || !entry.process) continue;
      if (identities.has(processIdentityKey(entry.process.pid, entry.process.birth))) {
        retainedIds.push(entry.id);
        continue;
      }
      this.completeRelease(entry);
      releasedIds.push(entry.id);
    }

    releasedIds.sort();
    retainedIds.sort();
    return { releasedIds, retainedIds };
  }

  acknowledge(id: string): boolean {
    const normalizedId = requireNonEmpty(id, "handle id");
    const entry = this.entries.get(normalizedId);
    if (!entry || entry.state !== "unconfirmed") return false;
    this.completeRelease(entry);
    return true;
  }

  private markSettling(entry: MutableOwnedHandleEntry): OwnedHandleSnapshotEntry {
    this.assertTracked(entry);
    if (entry.state === "unconfirmed") {
      throw new OwnedHandleStateError(entry.id, "An unconfirmed handle cannot return to settling.");
    }
    if (entry.state === "active") this.updateState(entry, "settling");
    return snapshotEntry(entry);
  }

  private markUnconfirmed(
    entry: MutableOwnedHandleEntry,
    reason: string,
  ): OwnedHandleSnapshotEntry {
    this.assertTracked(entry);
    entry.state = "unconfirmed";
    entry.unconfirmedReason = requireNonEmpty(reason, "unconfirmed reason");
    entry.updatedAt = this.timestamp();
    return snapshotEntry(entry);
  }

  private release(entry: MutableOwnedHandleEntry): OwnedHandleSnapshotEntry {
    if (entry.state === "released") return snapshotEntry(entry);
    this.assertTracked(entry);
    if (entry.state === "unconfirmed") {
      throw new OwnedHandleStateError(
        entry.id,
        "Unconfirmed cleanup must be reconciled or explicitly acknowledged before release.",
      );
    }
    this.completeRelease(entry);
    return snapshotEntry(entry);
  }

  private completeRelease(entry: MutableOwnedHandleEntry): void {
    entry.state = "released";
    entry.updatedAt = this.timestamp();
    this.entries.delete(entry.id);
  }

  private updateState(entry: MutableOwnedHandleEntry, state: OwnedHandleState): void {
    entry.state = state;
    entry.updatedAt = this.timestamp();
  }

  private assertTracked(entry: MutableOwnedHandleEntry): void {
    if (this.entries.get(entry.id) !== entry || entry.state === "released") {
      throw new OwnedHandleStateError(entry.id, "Owned handle is already released.");
    }
  }

  private timestamp(): string {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new OwnedHandleValidationError("Registry clock returned an invalid timestamp.");
    }
    return date.toISOString();
  }
}

let globalOwnedHandleRegistry: OwnedHandleRegistry | undefined;

export function createOwnedHandleRegistry(
  options: OwnedHandleRegistryOptions = {},
): OwnedHandleRegistry {
  return new OwnedHandleRegistry(options);
}

export function getOwnedHandleRegistry(): OwnedHandleRegistry {
  globalOwnedHandleRegistry ??= createOwnedHandleRegistry();
  return globalOwnedHandleRegistry;
}

function normalizeRegistration(input: OwnedHandleRegistration): {
  type: OwnedHandleType;
  owner: string;
  source: string;
  scope: string | null;
  process: OwnedOsProcessIdentity | null;
  metadata: Record<string, JsonValue>;
} {
  if (!OWNED_HANDLE_TYPES.includes(input.type)) {
    throw new OwnedHandleValidationError(`Unsupported owned handle type: ${String(input.type)}`);
  }
  const owner = requireNonEmpty(input.owner, "owner");
  const source = requireNonEmpty(input.source, "source");
  const scope = input.scope === undefined ? null : requireNonEmpty(input.scope, "scope");
  const metadata = cloneMetadata(input.metadata ?? {});

  if (input.type === "os-process") {
    validateProcessIdentity(input);
    return {
      type: input.type, owner, source, scope, metadata,
      process: { pid: input.pid, pgid: input.pgid, birth: input.birth },
    };
  }
  const looseInput = input as OwnedHandleRegistrationBase & {
    pid?: unknown; pgid?: unknown; birth?: unknown;
  };
  if (looseInput.pid !== undefined || looseInput.pgid !== undefined || looseInput.birth !== undefined) {
    throw new OwnedHandleValidationError(
      "pid, pgid, and birth are valid only for os-process handles.",
    );
  }
  return { type: input.type, owner, source, scope, metadata, process: null };
}

function validateProcessIdentity(identity: OwnedOsProcessRecord): void {
  if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0) {
    throw new OwnedHandleValidationError("os-process pid must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(identity.pgid) || identity.pgid <= 0) {
    throw new OwnedHandleValidationError("os-process pgid must be a positive safe integer.");
  }
  requireNonEmpty(identity.birth, "os-process birth");
}

function requireNonEmpty(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new OwnedHandleValidationError(`${label} must be a non-empty string.`);
  }
  return value;
}

function cloneMetadata(metadata: OwnedHandleMetadata): Record<string, JsonValue> {
  if (!isPlainObject(metadata)) {
    throw new OwnedHandleValidationError("metadata must be a JSON object.");
  }
  const seen = new Set<object>();
  return cloneJsonObject(metadata, seen, "metadata");
}

function cloneJsonObject(
  value: Readonly<Record<string, JsonValue>>,
  seen: Set<object>,
  path: string,
): Record<string, JsonValue> {
  if (seen.has(value)) throw new OwnedHandleValidationError(`${path} must not contain cycles.`);
  seen.add(value);
  const clone: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    clone[key] = cloneJsonValue(child, seen, `${path}.${key}`);
  }
  seen.delete(value);
  return clone;
}

function cloneJsonValue(value: JsonValue, seen: Set<object>, path: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new OwnedHandleValidationError(`${path} must be finite.`);
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new OwnedHandleValidationError(`${path} must not contain cycles.`);
    seen.add(value);
    const clone = value.map((child, index) => cloneJsonValue(child, seen, `${path}[${index}]`));
    seen.delete(value);
    return clone;
  }
  if (!isPlainObject(value)) {
    throw new OwnedHandleValidationError(`${path} must contain only JSON values.`);
  }
  return cloneJsonObject(value, seen, path);
}

function isPlainObject(value: unknown): value is Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function snapshotEntry(entry: MutableOwnedHandleEntry): OwnedHandleSnapshotEntry {
  return {
    ...entry,
    process: entry.process ? { ...entry.process } : null,
    metadata: cloneMetadata(entry.metadata),
  };
}

function processIdentityKey(pid: number, birth: string): string {
  return `${pid}\u0000${birth}`;
}
