/**
 * =============================================================================
 * Canvast — Project Delivery Closure / 全项目交付闭环
 * =============================================================================
 * @file        src/harness/project-delivery-closure.ts
 * @brief       Prevents a local reply from closing an unfinished project.
 * @description Reads the typed project-contract ledgers at the settlement
 *              boundary and persists one recoverable continuation whenever
 *              required delivery work is not yet accepted.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, type Stats } from "node:fs";
import * as path from "node:path";

import {
  upsertRuntimeStatusItem,
  type RuntimeRequestDeliveryScope,
  type RuntimeStatusItem,
} from "./runtime-status.js";

export type ProjectDeliveryLedgerKind = "task" | "gap" | "eval" | "gate";
export type ProjectDeliveryClosureReason = "incomplete" | "malformed" | "unstable_snapshot";

export interface PendingProjectDeliveryItem {
  kind: ProjectDeliveryLedgerKind;
  id: string;
  state: string;
  nextAction: string;
}

export type ProjectDeliveryClosureInspection =
  | { applicable: false }
  | { applicable: true; accepted: true; fingerprint: string; pending: [] }
  | {
      applicable: true;
      accepted: false;
      reason: ProjectDeliveryClosureReason;
      fingerprint?: string;
      pending: PendingProjectDeliveryItem[];
      nextAction: string;
    };

interface LedgerSpec {
  file: string;
  collection: string;
  kind: ProjectDeliveryLedgerKind;
  stateField: "state" | "status";
  actionField: "acceptance" | "targeted_rerun" | "command";
}

interface StableLedgerFile {
  spec: LedgerSpec;
  raw: string;
}

const LEDGER_DIRECTORY = ".project-contract-harness";
const LEDGER_SPECS: readonly LedgerSpec[] = [
  { file: "tasks.json", collection: "tasks", kind: "task", stateField: "state", actionField: "acceptance" },
  { file: "gaps.json", collection: "gaps", kind: "gap", stateField: "state", actionField: "targeted_rerun" },
  { file: "eval-matrix.json", collection: "cases", kind: "eval", stateField: "status", actionField: "command" },
  { file: "gates.json", collection: "gates", kind: "gate", stateField: "state", actionField: "acceptance" },
];
const VALID_STATES = new Set([
  "open", "in_progress", "implemented_unverified", "verified",
  "blocked", "dropped", "not_applicable",
]);
const ACCEPTED_STATES = new Set(["verified", "not_applicable"]);
const REPAIR_ACTION = "Repair and validate the typed project-contract ledgers before closing the project.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function readRegularFile(file: string): string {
  const before = lstatSync(file);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error("ledger entry is not a regular file");
  const raw = readFileSync(file, "utf8");
  const after = lstatSync(file);
  if (!sameFile(before, after)) throw new Error("ledger entry changed while being read");
  return raw;
}

function malformed(): ProjectDeliveryClosureInspection {
  return { applicable: true, accepted: false, reason: "malformed", pending: [], nextAction: REPAIR_ACTION };
}

function isWholeProjectDeliveryScope(scope: RuntimeRequestDeliveryScope | undefined): boolean {
  return scope?.kind === "whole_project_delivery";
}

function shouldEnforceProjectDeliveryClosure(input: {
  requestDeliveryScope?: RuntimeRequestDeliveryScope;
  currentTask?: RuntimeStatusItem;
  existingContinuation?: RuntimeStatusItem;
  rootRequestId: string;
}): boolean {
  if (input.existingContinuation?.rootRequestId === input.rootRequestId) return true;
  return isWholeProjectDeliveryScope(input.requestDeliveryScope);
}

function loadStableLedgerFiles(directory: string): StableLedgerFile[] | ProjectDeliveryClosureInspection {
  try {
    const first = LEDGER_SPECS.map(spec => ({ spec, raw: readRegularFile(path.join(directory, spec.file)) }));
    const second = LEDGER_SPECS.map(spec => ({ spec, raw: readRegularFile(path.join(directory, spec.file)) }));
    if (first.some((entry, index) => entry.raw !== second[index]?.raw)) {
      return {
        applicable: true, accepted: false, reason: "unstable_snapshot", pending: [],
        nextAction: "Retry project-contract inspection after the ledger writers reach a stable checkpoint.",
      };
    }
    return second;
  } catch {
    return malformed();
  }
}

function parseLedgerFiles(files: StableLedgerFile[]): ProjectDeliveryClosureInspection {
  const pending: PendingProjectDeliveryItem[] = [];
  let requiredCount = 0;
  const digest = createHash("sha256");
  for (const { spec, raw } of files) {
    digest.update(spec.file).update("\0").update(raw).update("\0");
    let document: unknown;
    try {
      document = JSON.parse(raw);
    } catch {
      return malformed();
    }
    if (!isRecord(document) || document.version !== 1 || !Array.isArray(document[spec.collection])) {
      return malformed();
    }
    const entries = document[spec.collection] as unknown[];
    const seen = new Set<string>();
    for (const value of entries) {
      if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim() ||
          typeof value.required !== "boolean" || typeof value[spec.stateField] !== "string") {
        return malformed();
      }
      const id = value.id.trim();
      const state = value[spec.stateField] as string;
      if (seen.has(id) || !VALID_STATES.has(state)) return malformed();
      seen.add(id);
      if (!value.required) continue;
      requiredCount += 1;
      if (ACCEPTED_STATES.has(state)) continue;
      const declaredAction = value[spec.actionField];
      pending.push({
        kind: spec.kind, id, state,
        nextAction: typeof declaredAction === "string" && declaredAction.trim()
          ? declaredAction.trim()
          : `Review ${spec.file} entry ${id} and run its acceptance gate.`,
      });
    }
  }
  if (requiredCount === 0) return malformed();
  const fingerprint = digest.digest("hex");
  if (pending.length === 0) return { applicable: true, accepted: true, fingerprint, pending: [] };
  return {
    applicable: true, accepted: false, reason: "incomplete", fingerprint, pending,
    nextAction: pending[0].nextAction,
  };
}

export function inspectProjectDeliveryClosure(projectRoot?: string): ProjectDeliveryClosureInspection {
  if (!projectRoot) return { applicable: false };
  const directory = path.join(projectRoot, LEDGER_DIRECTORY);
  try {
    const stats = lstatSync(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return malformed();
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") return { applicable: false };
    return malformed();
  }
  const files = loadStableLedgerFiles(directory);
  return Array.isArray(files) ? parseLedgerFiles(files) : files;
}

export function preserveIncompleteProjectDelivery(input: {
  agentDir: string;
  projectRoot?: string;
  rootRequestId: string;
  requestDeliveryScope?: RuntimeRequestDeliveryScope;
  sessionId?: string;
  currentTask?: RuntimeStatusItem;
  existingContinuation?: RuntimeStatusItem;
  timestamp: string;
}): boolean {
  if (!shouldEnforceProjectDeliveryClosure(input)) return false;
  const closure = inspectProjectDeliveryClosure(input.projectRoot);
  if (!closure.applicable) return false;
  if (closure.accepted) {
    if (input.existingContinuation?.rootRequestId === input.rootRequestId &&
        input.existingContinuation.status !== "completed") {
      upsertRuntimeStatusItem(input.agentDir, {
        plane: "tasks",
        item: {
          id: "whole-project-delivery-continuation",
          title: input.existingContinuation.title,
          status: "completed", required: true, rootRequestId: input.rootRequestId, sessionId: input.sessionId,
          summary: "All required project-contract ledger entries are verified.",
          startedAt: input.existingContinuation.startedAt, completedAt: input.timestamp,
        },
      });
    }
    return false;
  }
  const existing = input.currentTask;
  upsertRuntimeStatusItem(input.agentDir, {
    plane: "tasks",
    item: {
      id: "whole-project-delivery-continuation",
      title: "Continue whole-project delivery",
      status: "pending", required: true, rootRequestId: input.rootRequestId, sessionId: input.sessionId,
      summary: `Whole-project delivery remains ${closure.reason}. Next action: ${closure.nextAction}`,
      startedAt: input.existingContinuation?.startedAt || input.timestamp,
    },
  });
  upsertRuntimeStatusItem(input.agentDir, {
    plane: "tasks",
    item: {
      id: "current-user-request", title: existing?.title || "Current user request", status: "in_progress",
      rootRequestId: input.rootRequestId, sessionId: input.sessionId,
      summary: existing?.summary, startedAt: existing?.startedAt || input.timestamp,
    },
  });
  return true;
}
