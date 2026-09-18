/**
 * =============================================================================
 * Canvast — Shared Sub-Agent Capacity / 共享子 Agent 容量
 * =============================================================================
 * @file        src/agents/sub-agent-capacity.ts
 * @brief       Typed cross-extension inspection of the live child-agent pool.
 * @description The execution owner remains authoritative and rechecks capacity
 *              at admission time; callers never infer slots from UI history.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import type { SubAgentDispatchInvocation } from "./sub-agent-dispatch-contract.js";

export interface SubAgentCapacitySnapshot {
  maxChildren: number;
  occupiedChildren: number;
  reservedChildren: number;
  availableChildSlots: number;
  accepting: boolean;
}

export interface SubAgentCapacityProvider {
  inspectCapacity(): SubAgentCapacitySnapshot;
  tryReserve(reservationId: string, slots: number, dispatch?: SubAgentDispatchInvocation): boolean;
  consumeReservation(
    reservationId: string,
    slots: number,
    dispatch?: SubAgentDispatchInvocation,
  ): boolean | "consumed" | "missing" | "mismatch";
  releaseReservation(reservationId: string): void;
}

const CAPACITY_PROVIDER = Symbol.for("canvast.sub-agent-capacity-provider");

export function installSubAgentCapacityProvider(
  host: object,
  provider: SubAgentCapacityProvider,
): void {
  Object.defineProperty(host, CAPACITY_PROVIDER, {
    configurable: true,
    enumerable: false,
    writable: false,
    value: provider,
  });
}

export function inspectSubAgentCapacity(host: object): SubAgentCapacitySnapshot | undefined {
  const provider = (host as Record<PropertyKey, unknown>)[CAPACITY_PROVIDER] as
    | SubAgentCapacityProvider
    | undefined;
  const snapshot = provider?.inspectCapacity();
  if (!snapshot) return undefined;
  if (
    !Number.isInteger(snapshot.maxChildren) || snapshot.maxChildren < 0 ||
    !Number.isInteger(snapshot.occupiedChildren) || snapshot.occupiedChildren < 0 ||
    !Number.isInteger(snapshot.reservedChildren) || snapshot.reservedChildren < 0 ||
    !Number.isInteger(snapshot.availableChildSlots) || snapshot.availableChildSlots < 0 ||
    snapshot.occupiedChildren + snapshot.reservedChildren > snapshot.maxChildren ||
    snapshot.availableChildSlots !== snapshot.maxChildren - snapshot.occupiedChildren - snapshot.reservedChildren ||
    snapshot.accepting !== (snapshot.availableChildSlots > 0)
  ) return undefined;
  return { ...snapshot };
}

export function reserveSubAgentCapacity(
  host: object,
  reservationId: string,
  slots: number,
  dispatch?: SubAgentDispatchInvocation,
): boolean {
  if (!reservationId.trim() || !Number.isInteger(slots) || slots < 1) return false;
  const provider = (host as Record<PropertyKey, unknown>)[CAPACITY_PROVIDER] as
    | SubAgentCapacityProvider
    | undefined;
  return provider?.tryReserve(reservationId, slots, dispatch) === true;
}

export function releaseSubAgentCapacity(host: object, reservationId: string): void {
  const provider = (host as Record<PropertyKey, unknown>)[CAPACITY_PROVIDER] as
    | SubAgentCapacityProvider
    | undefined;
  provider?.releaseReservation(reservationId);
}

export function consumeSubAgentCapacity(
  host: object,
  reservationId: string,
  slots: number,
  dispatch?: SubAgentDispatchInvocation,
): "consumed" | "missing" | "mismatch" {
  if (!reservationId.trim() || !Number.isInteger(slots) || slots < 1) return "mismatch";
  const provider = (host as Record<PropertyKey, unknown>)[CAPACITY_PROVIDER] as
    | SubAgentCapacityProvider
    | undefined;
  const result = provider?.consumeReservation(reservationId, slots, dispatch);
  if (result === true) return "consumed";
  if (result === false || result === undefined) return "missing";
  return result;
}
