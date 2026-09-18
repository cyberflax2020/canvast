/**
 * =============================================================================
 * Canvast — Shared Process Snapshot Client Types / 共享进程快照客户端类型
 * =============================================================================
 * @file        scripts/process-snapshot-client.d.mts
 * @brief       Type declarations for the strict process-snapshot.py V1 client.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import type { SpawnSyncReturns } from "node:child_process";

export const PROCESS_SNAPSHOT_SOURCE: "shared-process-snapshot-v1";
export const PROCESS_SNAPSHOT_HEADER: "CANVAST_PROCESS_SNAPSHOT_V1";
export const PROCESS_SNAPSHOT_FIELDS: "pid\tppid\tpgid\tstart_sec\tstart_usec\trss_bytes\tcpu_usec\tcommand";

export interface ProcessSnapshotRecord {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly startSec: number;
  readonly startUsec: number;
  readonly rssBytes: number;
  readonly cpuUsec: number;
  readonly birth: string;
  readonly command: string;
}

export class ProcessSnapshotError extends Error {
  readonly code: string;
  constructor(message: string, code?: string);
}

export function formatProcessSnapshotBirth(startSec: number, startUsec: number): string;
export function parseProcessSnapshotV1(
  stdout: string,
  options?: { requestedPid?: number },
): readonly ProcessSnapshotRecord[];
export function sampleProcessSnapshot(options?: {
  pid?: number;
  helperPath?: string;
  pythonBin?: string;
  env?: NodeJS.ProcessEnv;
  spawnSyncImpl?: typeof import("node:child_process").spawnSync;
}): readonly ProcessSnapshotRecord[];
