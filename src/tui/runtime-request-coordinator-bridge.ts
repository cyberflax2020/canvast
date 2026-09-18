/**
 * =============================================================================
 * Canvast — Runtime Request Coordinator / Canvast source file
 * =============================================================================
 * @file        src/tui/runtime-request-coordinator-bridge.ts
 * @brief       Shared bridge for runtime orchestration decisions.
 * @description Provides a typed registry to connect harness decisions with
 *              TUI-level coordinators.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import type { RecordedOrchestrationDecision } from "../harness/auto-orchestrator/types.js";

export type OrchestrationDecisionHandler = (decision: RecordedOrchestrationDecision) => void;

class RuntimeOrchestrationBridge {
  private handler: OrchestrationDecisionHandler | undefined;

  registerHandler(handler: OrchestrationDecisionHandler): void {
    this.handler = handler;
  }

  notifyDecision(decision: RecordedOrchestrationDecision): void {
    if (this.handler) {
      this.handler(decision);
    }
  }
}

export const orchestrationBridge = new RuntimeOrchestrationBridge();
