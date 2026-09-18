/**
 * =============================================================================
 * Canvast — Owned Handle Shutdown Diagnostics / 自有句柄关闭诊断
 * =============================================================================
 * @file        src/utils/owned-handle-diagnostics.ts
 * @brief       Validates diagnostic controls and persists quit-time evidence.
 * @description Keeps Canvast-only CLI arguments out of the upstream runtime
 *              and binds the final registry snapshot to one invocation ID.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import * as path from "node:path";

import { writeSafeJson } from "../harness/safe-json-file.js";
import {
  getOwnedHandleRegistry,
  type OwnedHandleRegistrySnapshot,
} from "./owned-handle-registry.js";

export const OWNED_HANDLE_SNAPSHOT_OPTION = "--canvast-owned-handle-snapshot" as const;
export const OWNED_HANDLE_INVOCATION_ID_OPTION = "--canvast-owned-handle-invocation-id" as const;
export const OWNED_HANDLE_SNAPSHOT_ENV = "CANVAST_OWNED_HANDLE_SNAPSHOT" as const;
export const OWNED_HANDLE_INVOCATION_ID_ENV = "CANVAST_OWNED_HANDLE_INVOCATION_ID" as const;
export const OWNED_HANDLE_SHUTDOWN_EVIDENCE_VERSION = 1 as const;
export const OWNED_HANDLE_SHUTDOWN_EVIDENCE_KIND =
  "canvast-owned-handle-shutdown-evidence" as const;
export const OWNED_HANDLE_INVOCATION_ID_MAX_LENGTH = 256;

export interface OwnedHandleDiagnosticsConfiguration {
  snapshotPath: string;
  invocationId: string;
}

export interface OwnedHandleDiagnosticsArgs {
  forwardedArgs: string[];
  configuration?: OwnedHandleDiagnosticsConfiguration;
  errors: string[];
}

export interface OwnedHandleShutdownEvidence {
  version: typeof OWNED_HANDLE_SHUTDOWN_EVIDENCE_VERSION;
  kind: typeof OWNED_HANDLE_SHUTDOWN_EVIDENCE_KIND;
  invocationId: string;
  shutdown: {
    reason: "quit";
    completedAt: string;
    producerPid: number;
  };
  registry: OwnedHandleRegistrySnapshot;
}

function validSnapshotPath(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0
    && !value.includes("\0") && path.isAbsolute(value);
}

function validInvocationId(value: string | undefined): value is string {
  if (typeof value !== "string" || value.length === 0
    || value.length > OWNED_HANDLE_INVOCATION_ID_MAX_LENGTH) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

function validateConfiguration(
  snapshotPath: string | undefined,
  invocationId: string | undefined,
  snapshotPresent: boolean,
  invocationPresent: boolean,
): { configuration?: OwnedHandleDiagnosticsConfiguration; errors: string[] } {
  const errors: string[] = [];
  if (snapshotPresent && !validSnapshotPath(snapshotPath)) {
    errors.push(`${OWNED_HANDLE_SNAPSHOT_OPTION} requires an absolute path without NUL`);
  }
  if (invocationPresent && !validInvocationId(invocationId)) {
    errors.push(
      `${OWNED_HANDLE_INVOCATION_ID_OPTION} must be a printable string of at most ${OWNED_HANDLE_INVOCATION_ID_MAX_LENGTH} characters`,
    );
  }
  if (snapshotPresent !== invocationPresent) {
    errors.push(
      `${OWNED_HANDLE_SNAPSHOT_OPTION} and ${OWNED_HANDLE_INVOCATION_ID_OPTION} must be provided together`,
    );
  }
  return {
    configuration: errors.length === 0 && snapshotPath !== undefined && invocationId !== undefined
      ? { snapshotPath, invocationId }
      : undefined,
    errors,
  };
}

export function splitOwnedHandleDiagnosticsArgs(args: readonly string[]): OwnedHandleDiagnosticsArgs {
  const forwardedArgs: string[] = [];
  const errors: string[] = [];
  let snapshotPath: string | undefined;
  let invocationId: string | undefined;
  let snapshotPresent = false;
  let invocationPresent = false;

  const assign = (option: string, value: string | undefined): void => {
    if (option === OWNED_HANDLE_SNAPSHOT_OPTION) {
      if (snapshotPresent) errors.push(`${option} may only be specified once`);
      snapshotPresent = true;
      snapshotPath = value;
      return;
    }
    if (invocationPresent) errors.push(`${option} may only be specified once`);
    invocationPresent = true;
    invocationId = value;
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === OWNED_HANDLE_SNAPSHOT_OPTION
      || argument === OWNED_HANDLE_INVOCATION_ID_OPTION) {
      const candidate = index + 1 < args.length ? args[index + 1] : undefined;
      const value = candidate?.startsWith("--") ? undefined : candidate;
      if (value !== undefined) index += 1;
      assign(argument, value);
      continue;
    }
    if (argument.startsWith(`${OWNED_HANDLE_SNAPSHOT_OPTION}=`)) {
      assign(OWNED_HANDLE_SNAPSHOT_OPTION, argument.slice(OWNED_HANDLE_SNAPSHOT_OPTION.length + 1));
      continue;
    }
    if (argument.startsWith(`${OWNED_HANDLE_INVOCATION_ID_OPTION}=`)) {
      assign(
        OWNED_HANDLE_INVOCATION_ID_OPTION,
        argument.slice(OWNED_HANDLE_INVOCATION_ID_OPTION.length + 1),
      );
      continue;
    }
    forwardedArgs.push(argument);
  }

  const validated = validateConfiguration(
    snapshotPath, invocationId, snapshotPresent, invocationPresent,
  );
  return {
    forwardedArgs,
    configuration: validated.configuration,
    errors: [...errors, ...validated.errors],
  };
}

export function ownedHandleDiagnosticsFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): { configuration?: OwnedHandleDiagnosticsConfiguration; errors: string[] } {
  const snapshotPresent = env[OWNED_HANDLE_SNAPSHOT_ENV] !== undefined;
  const invocationPresent = env[OWNED_HANDLE_INVOCATION_ID_ENV] !== undefined;
  return validateConfiguration(
    env[OWNED_HANDLE_SNAPSHOT_ENV],
    env[OWNED_HANDLE_INVOCATION_ID_ENV],
    snapshotPresent,
    invocationPresent,
  );
}

export function applyOwnedHandleDiagnosticsEnvironment(
  env: NodeJS.ProcessEnv,
  configuration: OwnedHandleDiagnosticsConfiguration | undefined,
): void {
  if (!configuration) return;
  env[OWNED_HANDLE_SNAPSHOT_ENV] = configuration.snapshotPath;
  env[OWNED_HANDLE_INVOCATION_ID_ENV] = configuration.invocationId;
}

export function writeOwnedHandleShutdownEvidence(
  configuration: OwnedHandleDiagnosticsConfiguration,
): OwnedHandleShutdownEvidence {
  const validated = validateConfiguration(
    configuration.snapshotPath, configuration.invocationId, true, true,
  );
  if (!validated.configuration || validated.errors.length > 0) {
    throw new Error(`Owned handle diagnostics configuration error: ${validated.errors.join("; ")}`);
  }
  const registry = getOwnedHandleRegistry().diagnosticSnapshot();
  const evidence: OwnedHandleShutdownEvidence = {
    version: OWNED_HANDLE_SHUTDOWN_EVIDENCE_VERSION,
    kind: OWNED_HANDLE_SHUTDOWN_EVIDENCE_KIND,
    invocationId: validated.configuration.invocationId,
    shutdown: {
      reason: "quit",
      completedAt: new Date().toISOString(),
      producerPid: process.pid,
    },
    registry,
  };
  writeSafeJson(validated.configuration.snapshotPath, evidence);
  return evidence;
}
