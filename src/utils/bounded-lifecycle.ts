/**
 * =============================================================================
 * Canvast — Bounded Lifecycle Helpers / 有界生命周期辅助
 * =============================================================================
 * @file        src/utils/bounded-lifecycle.ts
 * @brief       Shared deadline, terminal-cause, and process-identity helpers
 * @description Consolidates the narrow lifecycle rules shared by runtime child
 *              processes and SDK-backed sub-agents:
 *              - absolute deadlines measured from initialization start
 *              - irreversible terminal-cause latching
 *              - finite bounded waits for cleanup phases
 *              - OS PID/start-identity verification before signalling
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import { sampleProcessSnapshot } from "../../scripts/process-snapshot-client.mjs";

export interface DeadlineWindow {
  startedAt: number;
  deadlineAt: number;
}

export class DeadlineExceededError extends Error {
  constructor(
    readonly stage: string,
    readonly timeoutMs: number,
  ) {
    super(`${stage} exceeded its bounded deadline after ${timeoutMs}ms`);
    this.name = "DeadlineExceededError";
  }
}

export interface LatchedTerminalState<TCause extends string> {
  cause?: TCause;
  cleanupFailed: boolean;
  outcomeUnknown: boolean;
}

export interface ProcessStartIdentity {
  pid: number;
  startKey: string;
  pgid: number;
  birth: string;
}

export type VerifiedSignalResult =
  | "sent"
  | "gone"
  | "identity_mismatch"
  | "unverifiable"
  | "failed";

let processStartIdentityReader: ((pid: number) => string | undefined) | undefined;
let processIdentityReader: ((pid: number) => ProcessStartIdentity | undefined) | undefined;

function readProcessIdentity(pid: number): ProcessStartIdentity | undefined {
  if (processIdentityReader) return processIdentityReader(pid);
  if (processStartIdentityReader) {
    const startKey = processStartIdentityReader(pid);
    return startKey ? { pid, startKey, pgid: pid, birth: startKey } : undefined;
  }
  try {
    const record = sampleProcessSnapshot({ pid })[0];
    return record
      ? { pid: record.pid, startKey: record.birth, pgid: record.pgid, birth: record.birth }
      : undefined;
  } catch {
    return undefined;
  }
}

export function createDeadlineWindow(timeoutMs: number, startedAt = Date.now()): DeadlineWindow {
  const boundedTimeout = Math.max(1, Math.floor(timeoutMs));
  return {
    startedAt,
    deadlineAt: startedAt + boundedTimeout,
  };
}

export function remainingDeadlineMs(window: DeadlineWindow | number, now = Date.now()): number {
  const deadlineAt = typeof window === "number" ? window : window.deadlineAt;
  return Math.max(0, deadlineAt - now);
}

export async function runWithDeadline<T>(
  stage: string,
  window: DeadlineWindow | number,
  task: Promise<T> | (() => Promise<T>),
): Promise<T> {
  const timeoutMs = remainingDeadlineMs(window);
  if (timeoutMs <= 0) throw new DeadlineExceededError(stage, 0);
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineExceededError(stage, timeoutMs)), timeoutMs);
    timer.unref?.();
    const work = typeof task === "function" ? task() : task;
    Promise.resolve(work).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function settleWithin<T>(
  stage: string,
  timeoutMs: number,
  task: Promise<T> | (() => Promise<T>),
): Promise<
  | { ok: true; value: T }
  | { ok: false; timedOut: true }
  | { ok: false; timedOut: false; error: unknown }
> {
  const boundedTimeout = Math.max(1, Math.floor(timeoutMs));
  try {
    return { ok: true, value: await runWithDeadline(stage, createDeadlineWindow(boundedTimeout), task) };
  } catch (error) {
    if (error instanceof DeadlineExceededError) return { ok: false, timedOut: true };
    return { ok: false, timedOut: false, error };
  }
}

export function createTerminalCauseLatch<TCause extends string>(
  initial?: Partial<LatchedTerminalState<TCause>>,
): {
  current: () => LatchedTerminalState<TCause>;
  latch: (cause: TCause) => LatchedTerminalState<TCause>;
  markCleanupFailed: () => LatchedTerminalState<TCause>;
  markOutcomeUnknown: () => LatchedTerminalState<TCause>;
} {
  const state: LatchedTerminalState<TCause> = {
    cause: initial?.cause,
    cleanupFailed: initial?.cleanupFailed === true,
    outcomeUnknown: initial?.outcomeUnknown === true,
  };
  return {
    current: () => ({ ...state }),
    latch: (cause: TCause) => {
      if (state.cause === undefined) state.cause = cause;
      return { ...state };
    },
    markCleanupFailed: () => {
      state.cleanupFailed = true;
      return { ...state };
    },
    markOutcomeUnknown: () => {
      state.outcomeUnknown = true;
      return { ...state };
    },
  };
}

export function readProcessStartIdentity(pid: number): string | undefined {
  return readProcessIdentity(pid)?.startKey;
}

export function setProcessStartIdentityReaderForTests(
  reader?: (pid: number) => string | undefined,
): void {
  processStartIdentityReader = reader;
}

export function setProcessIdentityReaderForTests(
  reader?: (pid: number) => ProcessStartIdentity | undefined,
): void {
  processIdentityReader = reader;
}

export function captureProcessIdentity(pid: number | undefined): ProcessStartIdentity | undefined {
  if (pid === undefined) return undefined;
  return readProcessIdentity(pid);
}

function sameProcessBirth(identity: ProcessStartIdentity, current: ProcessStartIdentity): boolean {
  return identity.pid === current.pid && identity.birth === current.birth;
}

export function signalProcessVerified(
  pid: number | undefined,
  identity: ProcessStartIdentity | undefined,
  signal: NodeJS.Signals,
): VerifiedSignalResult {
  if (pid === undefined) return "gone";
  if (!processExists(pid)) return "gone";
  if (!identity) return "unverifiable";
  const current = readProcessIdentity(pid);
  if (!current) return processExists(pid) ? "unverifiable" : "gone";
  if (!sameProcessBirth(identity, current)) return "identity_mismatch";
  try {
    process.kill(pid, signal);
    return "sent";
  } catch (error: any) {
    return error?.code === "ESRCH" ? "gone" : "failed";
  }
}

export function signalProcessGroupVerified(
  pid: number | undefined,
  identity: ProcessStartIdentity | undefined,
  signal: NodeJS.Signals,
): VerifiedSignalResult {
  if (pid === undefined) return "gone";
  if (processTreeGone(pid)) return "gone";
  if (!identity) return "unverifiable";
  if (identity.pid !== pid || identity.pgid !== pid) return "unverifiable";
  const current = readProcessIdentity(pid);
  if (!current) return processTreeGone(pid) ? "gone" : "unverifiable";
  if (!sameProcessBirth(identity, current)) return "identity_mismatch";
  if (current.pid !== pid || current.pgid !== pid) return "unverifiable";
  try {
    process.kill(-pid, signal);
    return "sent";
  } catch (groupError: any) {
    const groupGone = groupError?.code === "ESRCH";
    try {
      process.kill(pid, signal);
      return "sent";
    } catch (error: any) {
      return groupGone && error?.code === "ESRCH" ? "gone" : "failed";
    }
  }
}

export function processExists(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (error: any) {
    return error?.code !== "ESRCH";
  }
}

export function processTreeGone(pid: number | undefined): boolean {
  if (pid === undefined) return true;
  const groupGone = !processExists(-pid);
  const pidGone = !processExists(pid);
  return groupGone && pidGone;
}
