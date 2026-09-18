/**
 * =============================================================================
 * Canvast — Typed Runtime Terminal Outcome / 类型化运行终态
 * =============================================================================
 * @file        src/tui/runtime-terminal-outcome.ts
 * @brief       Carries host tool termination evidence into root settlement.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

export interface RuntimeToolExecutionEndEvidence {
  result?: { terminate?: boolean } | null;
}

export interface FailedRuntimeSettlement {
  outcome: "failed" | "interrupted";
  requestStatus: "failed" | "interrupted";
  taskStatus: "failed" | "aborted";
  failureReason: string;
  taskSummary: string;
}

export function failedRuntimeSettlement(
  terminal: boolean,
  incomplete: boolean,
  recoveryMessage?: string,
): FailedRuntimeSettlement {
  if (terminal) return {
    outcome: "failed", requestStatus: "failed", taskStatus: "failed",
    failureReason: "Agent run ended after a typed terminal tool outcome.",
    taskSummary: "Agent run ended after a terminal policy or tool outcome.",
  };
  return {
    outcome: incomplete ? "interrupted" : "failed",
    requestStatus: "interrupted", taskStatus: "aborted",
    failureReason: recoveryMessage || "Agent run settled without a complete visible response.",
    taskSummary: incomplete
      ? "Agent run was interrupted before completion; state remains recoverable."
      : "Agent run settled without a complete visible response; state remains recoverable.",
  };
}

/**
 * A terminal tool outcome belongs to one agent run. Pi intentionally omits its
 * internal `terminate` hint from TurnEndEvent.toolResults, but preserves it on
 * ToolExecutionEndEvent.result. Observe that typed result at the extension-event
 * boundary; never infer termination from messages, reasons, or hidden reasoning.
 */
export class RuntimeTerminalOutcomeLatch {
  private terminated = false;

  observe(event: RuntimeToolExecutionEndEvidence | null | undefined): boolean {
    const observed = event?.result?.terminate === true;
    this.terminated ||= observed;
    return this.terminated;
  }

  consume(): boolean {
    const terminated = this.terminated;
    this.terminated = false;
    return terminated;
  }

  reset(): void {
    this.terminated = false;
  }
}
