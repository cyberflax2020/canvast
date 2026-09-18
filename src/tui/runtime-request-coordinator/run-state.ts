/**
 * =============================================================================
 * Canvast — Runtime Request Run State / 运行时请求运行状态
 * =============================================================================
 * @file        src/tui/runtime-request-coordinator/run-state.ts
 * @brief       Classifies terminal agent events without coordinator duplication.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
export function runtimeRunEndedIncomplete(event: any): boolean {
  return event?.aborted === true || event?.cancelled === true || event?.interrupted === true ||
    (Array.isArray(event?.messages) && event.messages.some((item: any) => {
      const message = item?.message || item;
      const reason = String(message?.stopReason || message?.stop_reason || "");
      return reason === "aborted" || reason === "error" || reason === "length";
    }));
}
