/**
 * =============================================================================
 * Canvast — Extension Runtime Safe Checkpoints / Canvast 源文件
 * =============================================================================
 * @file        src/harness/runtime-safe-checkpoint.ts
 * @brief       Publishes observable, post-commit runtime checkpoints.
 * @description Keeps extension wrappers on the shared events identity and
 *              fails closed when no batch coordinator is bound.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ReevaluateCheckpoint } from "./context-continuity/runtime-queue.js";
import { publishRuntimeSafeCheckpoint, runtimeBatchEventScope } from "./runtime-batch-bridge.js";

/**
 * Publish only through ExtensionAPI.events, whose identity is shared across
 * independently-created extension wrappers. A missing consumer means there is
 * no batch work to dispatch; an exception is contained so a checkpoint cannot
 * turn an already committed plan/workflow transition into a false rollback.
 */
export function publishExtensionRuntimeCheckpoint(
  pi: Pick<ExtensionAPI, "events">,
  checkpoint: ReevaluateCheckpoint,
): boolean {
  const scope = runtimeBatchEventScope(pi);
  if (!scope) return false;
  try {
    return publishRuntimeSafeCheckpoint(scope, checkpoint);
  } catch {
    return false;
  }
}
