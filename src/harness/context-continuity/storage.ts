/**
 * =============================================================================
 * Canvast — Context Continuity Storage / Canvast source file
 * =============================================================================
 * @file        src/harness/context-continuity/storage.ts
 * @brief       Persists context-continuity state with atomic file replacement.
 * @description Owns the continuity-state path and filesystem boundary while
 *              leaving normalization and state transitions in the main module.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import * as path from "node:path";

import { readProtectedTextFile, writeProtectedTextFileAtomic } from "./filesystem.js";

export function contextContinuityFile(agentDir: string): string {
  return path.join(agentDir, "context-continuity.json");
}

export function readStoredContextContinuity(agentDir: string): unknown | undefined {
  const file = contextContinuityFile(agentDir);
  try {
    const stored = readProtectedTextFile(file);
    if (stored === undefined) return undefined;
    return JSON.parse(stored);
  } catch {
    return undefined;
  }
}

export function writeStoredContextContinuity(state: unknown, agentDir: string): void {
  const target = contextContinuityFile(agentDir);
  writeProtectedTextFileAtomic(target, JSON.stringify(state, null, 2));
}
