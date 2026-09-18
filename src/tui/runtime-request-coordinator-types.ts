/**
 * =============================================================================
 * Canvast — Runtime Request Coordinator / Canvast source file
 * =============================================================================
 * @file        src/tui/runtime-request-coordinator-types.ts
 * @brief       Types and interfaces for the request coordinator.
 * @description Part of the Canvast product codebase.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import type { RuntimeInputQueuePolicy } from "../harness/runtime-status.js";

export interface RuntimeRequestCoordinatorOptions {
  agentDir: () => string;
  projectId?: () => string;
}

export interface ResumeBinding {
  candidateId: string;
  claimToken: string;
}

export interface ResumeDispatchResult {
  claimToken: string;
  candidateId: string;
  requestId: string;
  dispatched: boolean;
  dispatchId: string;
  revert(): void;
}

export interface PendingDelivery {
  requestId: string;
  text: string;
  policy: RuntimeInputQueuePolicy;
}

export type RuntimeInputTransform =
  | { action: "continue" }
  | { action: "transform"; text: string; images?: any[] };
