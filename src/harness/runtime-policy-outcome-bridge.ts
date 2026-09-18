/**
 * =============================================================================
 * Canvast — Runtime Policy Outcome Bridge / 运行时策略结果桥
 * =============================================================================
 * @file        src/harness/runtime-policy-outcome-bridge.ts
 * @brief       Correlates typed policy decisions across host tool event phases.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import type { RuntimePolicyOutcome } from "./runtime-status.js";

const MAX_PENDING_OUTCOMES = 256;
const pendingByOwner = new WeakMap<object, Map<string, RuntimePolicyOutcome>>();

export function runtimePolicyOutcomeScope(api: { events?: unknown }): object | undefined {
  const events = api.events;
  return events !== null && (typeof events === "object" || typeof events === "function")
    ? events as object
    : undefined;
}

const POLICY_OUTCOME_CHANNEL = "canvast:runtime:policy-outcome";

interface RuntimePolicyOutcomeEvent {
  toolCallId: string;
  outcome: RuntimePolicyOutcome;
}

export function publishRuntimePolicyOutcome(
  api: { events?: { emit?: (channel: string, data: unknown) => void } },
  toolCallId: unknown,
  outcome: RuntimePolicyOutcome,
): void {
  const id = typeof toolCallId === "string" ? toolCallId.trim() : "";
  if (!id || typeof api.events?.emit !== "function") return;
  api.events.emit(POLICY_OUTCOME_CHANNEL, { toolCallId: id, outcome: copyOutcome(outcome) } satisfies RuntimePolicyOutcomeEvent);
}

export function registerRuntimePolicyOutcomeConsumer(
  api: { events?: { on?: (channel: string, handler: (data: unknown) => void) => (() => void) | void } },
  consumer: (toolCallId: string, outcome: RuntimePolicyOutcome) => void,
): () => void {
  if (typeof api.events?.on !== "function") return () => undefined;
  const unsubscribe = api.events.on(POLICY_OUTCOME_CHANNEL, payload => {
    if (!payload || typeof payload !== "object") return;
    const event = payload as Partial<RuntimePolicyOutcomeEvent>;
    const id = typeof event.toolCallId === "string" ? event.toolCallId.trim() : "";
    const outcome = runtimePolicyOutcomeFromUnknown(event.outcome);
    if (id && outcome) consumer(id, outcome);
  });
  return typeof unsubscribe === "function" ? unsubscribe : () => undefined;
}

function copyOutcome(outcome: RuntimePolicyOutcome): RuntimePolicyOutcome {
  return { ...outcome, categories: outcome.categories ? [...outcome.categories] : undefined };
}

export function runtimePolicyOutcomeFromUnknown(value: unknown): RuntimePolicyOutcome | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind !== "policy_block") return undefined;
  if (record.disposition !== "fallback_allowed" && record.disposition !== "terminal") return undefined;
  if (typeof record.source !== "string" || !record.source.trim()) return undefined;
  const categories = Array.isArray(record.categories)
    ? record.categories.filter((item): item is string => typeof item === "string")
    : undefined;
  return {
    kind: "policy_block",
    disposition: record.disposition,
    source: record.source,
    categories,
  };
}

export function recordRuntimePolicyOutcome(
  owner: object,
  toolCallId: unknown,
  outcome: RuntimePolicyOutcome,
): void {
  const id = typeof toolCallId === "string" ? toolCallId.trim() : "";
  if (!id) return;
  let pending = pendingByOwner.get(owner);
  if (!pending) {
    pending = new Map();
    pendingByOwner.set(owner, pending);
  }
  const existing = pending.get(id);
  if (!existing || outcome.disposition === "terminal") pending.set(id, copyOutcome(outcome));
  while (pending.size > MAX_PENDING_OUTCOMES) {
    const oldest = pending.keys().next().value;
    if (typeof oldest !== "string") break;
    pending.delete(oldest);
  }
}

export function peekRuntimePolicyOutcome(owner: object, toolCallId: unknown): RuntimePolicyOutcome | undefined {
  const id = typeof toolCallId === "string" ? toolCallId.trim() : "";
  if (!id) return undefined;
  const pending = pendingByOwner.get(owner);
  const outcome = pending?.get(id);
  return outcome ? copyOutcome(outcome) : undefined;
}

export function acknowledgeRuntimePolicyOutcome(owner: object, toolCallId: unknown): void {
  const id = typeof toolCallId === "string" ? toolCallId.trim() : "";
  if (!id) return;
  const pending = pendingByOwner.get(owner);
  pending?.delete(id);
  if (pending?.size === 0) pendingByOwner.delete(owner);
}

export function clearRuntimePolicyOutcomes(owner: object): void {
  pendingByOwner.delete(owner);
}
