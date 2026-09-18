/**
 * =============================================================================
 * Canvast — Runtime Pending Delivery Queue / 运行时待投递队列
 * =============================================================================
 * @file        src/tui/runtime-request-coordinator/pending-delivery.ts
 * @brief       Tracks pending native deliveries and resolves exact queue items.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import { readRuntimeStatus } from "../../harness/runtime-status.js";
import type { RuntimeInputQueueItem } from "../../harness/context-continuity.js";
import type { PendingDelivery, RuntimeInputBinding } from "./types.js";

export function removePendingDelivery(pending: PendingDelivery[], id: string): void {
  const index = pending.findIndex(item => item.binding.id === id);
  if (index >= 0) pending.splice(index, 1);
}

export function prunePendingDeliveries(pending: PendingDelivery[], ids: ReadonlySet<string>): void {
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    if (ids.has(pending[index].binding.id)) pending.splice(index, 1);
  }
}

export function exactQueuedInput(
  agentDir: () => string,
  binding: RuntimeInputBinding | undefined,
): RuntimeInputQueueItem | undefined {
  return binding ? readRuntimeStatus(agentDir()).inputQueue.find(item =>
    item.id === binding.id && item.requestId === binding.requestId &&
    item.sequence === binding.sequence && item.timestamp === binding.timestamp) : undefined;
}

export function consumePendingDelivery(
  agentDir: () => string,
  pending: PendingDelivery[],
): RuntimeInputQueueItem | undefined {
  const delivery = pending.shift();
  return delivery ? exactQueuedInput(agentDir, delivery.binding) : undefined;
}
