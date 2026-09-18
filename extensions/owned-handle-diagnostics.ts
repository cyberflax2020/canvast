/**
 * =============================================================================
 * Canvast — Owned Handle Diagnostics Extension / 自有句柄诊断扩展
 * =============================================================================
 * @file        extensions/owned-handle-diagnostics.ts
 * @brief       Persists final invocation-bound registry evidence on real quit.
 * @description Runs last so every earlier extension has completed cleanup
 *              before the globally frozen registry snapshot is persisted.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  ownedHandleDiagnosticsFromEnvironment,
  writeOwnedHandleShutdownEvidence,
} from "../src/utils/owned-handle-diagnostics.js";
import {
  getOwnedHandleRegistry,
  type OwnedHandleAdmissionFreeze,
} from "../src/utils/owned-handle-registry.js";

export default function ownedHandleDiagnosticsExtension(pi: ExtensionAPI): void {
  const resolved = ownedHandleDiagnosticsFromEnvironment();
  if (resolved.errors.length > 0) {
    throw new Error(`Owned handle diagnostics configuration error: ${resolved.errors.join("; ")}`);
  }
  if (!resolved.configuration) return;

  let quitFreeze: OwnedHandleAdmissionFreeze | undefined;
  let persisted = false;
  const removeProcessFallback = (): void => {
    process.removeListener("exit", persistTerminationFallback);
  };
  const persistQuitEvidence = (): void => {
    if (persisted) return;
    removeProcessFallback();
    quitFreeze ??= getOwnedHandleRegistry().freezeAdmission();
    writeOwnedHandleShutdownEvidence(resolved.configuration!);
    persisted = true;
  };
  const persistTerminationFallback = (code: number | string | null | undefined): void => {
    if (code === 130 || code === 143) persistQuitEvidence();
  };
  pi.on("session_shutdown", (event) => {
    if (event.reason === "quit") persistQuitEvidence();
    else removeProcessFallback();
  });
  process.on("exit", persistTerminationFallback);
}
