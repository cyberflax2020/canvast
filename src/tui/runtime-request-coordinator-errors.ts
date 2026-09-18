/**
 * =============================================================================
 * Canvast — Runtime Request Coordinator Errors / Canvast source file
 * =============================================================================
 * @file        src/tui/runtime-request-coordinator-errors.ts
 * @brief       Typed failures exposed by deterministic runtime resume claims.
 * @description Keeps resume concurrency errors structurally inspectable by
 *              TUI, desktop-action, and regression-test consumers.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

export class RuntimeResumeClaimError extends Error {
  constructor(readonly code: "stale_revision", message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "RuntimeResumeClaimError";
  }
}
