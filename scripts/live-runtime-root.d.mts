/**
 * ============================================================================
 * Canvast — Live Runtime Root Manager Types / Canvast source file
 * ============================================================================
 * @file        scripts/live-runtime-root.d.mts
 * @brief       Type declarations for the canonical-live runtime root manager.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * ============================================================================
 */
export interface LiveRuntimeProcessRecord {
  pid: number;
  ppid: number;
  pgid: number;
  startSec: number;
  startUsec: number;
  rssBytes: number;
  cpuUsec: number;
  birth: string;
  command: string;
}

export interface LiveRuntimeAllocationOptions {
  parentPath: string;
  ownerPid: number | string;
  token?: string;
  minimumFreeBytes: number | string;
  processRecords?: LiveRuntimeProcessRecord[];
  log?: (message: string) => void;
}

export interface LiveRuntimeCleanupOptions {
  parentPath: string;
  rootPath: string;
  ownerPid: number | string;
  token: string;
  processRecords?: LiveRuntimeProcessRecord[];
  log?: (message: string) => void;
}

export interface LiveRuntimeAllocation {
  root: string;
  token: string;
  owner: { pid: number; birth: string; pgid: number; command: string };
  availableBytes: number;
  minimumFreeBytes: number;
}

export const LIVE_RUNTIME_SCHEMA_VERSION: number;
export const LIVE_RUNTIME_OWNER_KIND: string;
export const LIVE_RUNTIME_ACTIVE_KIND: string;
export const LIVE_RUNTIME_MARKER: string;
export const LIVE_RUNTIME_ACTIVE_FILE: string;
export const DEFAULT_LIVE_MIN_FREE_BYTES: number;
export function allocateLiveRuntime(options: LiveRuntimeAllocationOptions): Promise<LiveRuntimeAllocation>;
export function cleanupLiveRuntime(options: LiveRuntimeCleanupOptions): Promise<void>;
