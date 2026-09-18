/**
 * =============================================================================
 * Canvast — Addressable Orchestration Control / 可寻址编排控制
 * =============================================================================
 * @file        src/desktop-action/orchestration-control.ts
 * @brief       Stable run IDs and live-owner lifecycle controls.
 * @description Keeps cancellation on the extension that owns the real
 *              process/session handle and reports unsupported follow-up
 *              transport without fabricating message delivery.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  DesktopActionHandlerError,
  registerDesktopActionHandler,
} from "./tool-bridge.js";

export type OrchestrationRunKind = "agent" | "workflow";
export type OrchestrationRunState =
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

type AcceptedOperation = boolean | Promise<boolean>;

interface OrchestrationRunControls {
  cancel?: () => AcceptedOperation;
  followUp?: (message: string) => AcceptedOperation;
}

interface OrchestrationRunRecord extends OrchestrationRunControls {
  runId: string;
  invocationId: string;
  state: OrchestrationRunState;
  cancelSupported: boolean;
  followUpSupported: boolean;
  sequence: number;
}

export interface OrchestrationRunSnapshot {
  runId: string;
  invocationId: string;
  kind: OrchestrationRunKind;
  state: OrchestrationRunState;
  capabilities: {
    cancel: { supported: boolean; available: boolean; reason?: string };
    followUp: { supported: boolean; available: boolean; reason?: string };
  };
}

export interface OrchestrationCancellation {
  signal: AbortSignal;
  cancel(): boolean;
  dispose(): void;
}

const DEFAULT_RETAINED_RUNS = 256;

export function orchestrationRunId(kind: OrchestrationRunKind, invocationId: string): string {
  return `${kind}-${invocationId}`;
}

/** Link owner-local cancellation to an optional tool-level AbortSignal. */
export function createOrchestrationCancellation(parent?: AbortSignal): OrchestrationCancellation {
  const controller = new AbortController();
  const forwardParentAbort = () => controller.abort();
  if (parent?.aborted) forwardParentAbort();
  else parent?.addEventListener("abort", forwardParentAbort, { once: true });
  return {
    signal: controller.signal,
    cancel: () => {
      if (controller.signal.aborted) return false;
      controller.abort();
      return true;
    },
    dispose: () => parent?.removeEventListener("abort", forwardParentAbort),
  };
}

function isActive(state: OrchestrationRunState): boolean {
  return state === "running" || state === "cancelling";
}

function requiredTargetId(
  kind: OrchestrationRunKind,
  args: Record<string, unknown>,
): string {
  const names = kind === "agent"
    ? ["agentId", "runId", "id"]
    : ["workflowId", "runId", "id"];
  for (const name of names) {
    const value = args[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  throw new DesktopActionHandlerError(
    "invalid_arguments",
    `Missing non-empty ${kind} run ID.`,
    { acceptedNames: names },
  );
}

function requiredFollowUpMessage(args: Record<string, unknown>): string {
  for (const name of ["message", "text", "prompt"]) {
    const value = args[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  throw new DesktopActionHandlerError(
    "invalid_arguments",
    "Missing non-empty follow-up message.",
    { acceptedNames: ["message", "text", "prompt"] },
  );
}

/**
 * Session-scoped index of durable run IDs to the live controls owned by the
 * extension that launched them. Terminal records remain addressable so callers
 * can distinguish a finished run from an unknown ID.
 */
export class OrchestrationRunRegistry {
  private readonly runs = new Map<string, OrchestrationRunRecord>();
  private sequence = 0;

  constructor(
    readonly kind: OrchestrationRunKind,
    private readonly retainedRuns = DEFAULT_RETAINED_RUNS,
  ) {}

  registerHandlers(pi: ExtensionAPI): void {
    registerDesktopActionHandler(pi, `${this.kind}.cancel`, args =>
      this.cancel(requiredTargetId(this.kind, args)));
    registerDesktopActionHandler(pi, `${this.kind}.followUp`, args =>
      this.followUp(requiredTargetId(this.kind, args), requiredFollowUpMessage(args)));
  }

  begin(invocationId: string, controls: OrchestrationRunControls): string {
    const normalizedInvocationId = invocationId.trim();
    if (!normalizedInvocationId) {
      throw new DesktopActionHandlerError(
        "invalid_arguments",
        `${this.kind} invocation ID must not be blank.`,
      );
    }
    const runId = orchestrationRunId(this.kind, normalizedInvocationId);
    const existing = this.runs.get(runId);
    if (existing && isActive(existing.state)) {
      throw new DesktopActionHandlerError(
        "run_id_conflict",
        `${this.kind} run ${runId} is already active.`,
        this.snapshot(existing),
      );
    }
    this.runs.delete(runId);
    this.runs.set(runId, {
      ...controls,
      runId,
      invocationId: normalizedInvocationId,
      state: "running",
      cancelSupported: Boolean(controls.cancel),
      followUpSupported: Boolean(controls.followUp),
      sequence: ++this.sequence,
    });
    this.prune();
    return runId;
  }

  settle(runId: string, state: Extract<OrchestrationRunState, "completed" | "failed" | "cancelled">): void {
    const record = this.runs.get(runId);
    if (!record) return;
    record.state = state;
    record.cancel = undefined;
    record.followUp = undefined;
    this.prune();
  }

  describe(runId: string): OrchestrationRunSnapshot | undefined {
    const record = this.runs.get(runId);
    return record ? this.snapshot(record) : undefined;
  }

  private async cancel(runId: string): Promise<Record<string, unknown>> {
    const record = this.requireRun(runId);
    if (record.state !== "running") throw this.notActive(record, "cancel");
    if (!record.cancel) throw this.capabilityUnavailable(record, "cancel");

    record.state = "cancelling";
    let accepted = false;
    try {
      accepted = await record.cancel();
    } catch (error) {
      record.state = "running";
      throw new DesktopActionHandlerError(
        "operation_failed",
        `${this.kind} run ${runId} rejected cancellation: ${error instanceof Error ? error.message : String(error)}`,
        { ...this.snapshot(record), operation: "cancel", accepted: false },
      );
    }
    if (!accepted) {
      record.state = "running";
      throw new DesktopActionHandlerError(
        "operation_not_accepted",
        `${this.kind} run ${runId} did not accept cancellation.`,
        { ...this.snapshot(record), operation: "cancel", accepted: false },
      );
    }
    return {
      ...this.snapshot(record),
      operation: "cancel",
      accepted: true,
      message: `Cancellation accepted by ${this.kind} run ${runId}.`,
    };
  }

  private async followUp(runId: string, message: string): Promise<Record<string, unknown>> {
    const record = this.requireRun(runId);
    if (record.state !== "running") throw this.notActive(record, "followUp");
    if (!record.followUp) throw this.capabilityUnavailable(record, "followUp");

    const accepted = await record.followUp(message);
    if (!accepted) {
      throw new DesktopActionHandlerError(
        "operation_not_accepted",
        `${this.kind} run ${runId} did not accept the follow-up message.`,
        { ...this.snapshot(record), operation: "followUp", accepted: false },
      );
    }
    return {
      ...this.snapshot(record),
      operation: "followUp",
      accepted: true,
      message: `Follow-up accepted by ${this.kind} run ${runId}.`,
    };
  }

  private requireRun(runId: string): OrchestrationRunRecord {
    const record = this.runs.get(runId);
    if (record) return record;
    throw new DesktopActionHandlerError(
      "not_found",
      `${this.kind} run ${runId} is not known to this live runtime.`,
      { runId, kind: this.kind, accepted: false },
    );
  }

  private notActive(record: OrchestrationRunRecord, operation: "cancel" | "followUp"): DesktopActionHandlerError {
    return new DesktopActionHandlerError(
      "run_not_active",
      `${this.kind} run ${record.runId} is ${record.state} and cannot accept ${operation}.`,
      {
        ...this.snapshot(record),
        operation,
        accepted: false,
        recovery: this.recovery(),
      },
      operation === "followUp" ? "degraded" : "full",
    );
  }

  private capabilityUnavailable(
    record: OrchestrationRunRecord,
    operation: "cancel" | "followUp",
  ): DesktopActionHandlerError {
    return new DesktopActionHandlerError(
      "capability_unavailable",
      operation === "followUp"
        ? `${this.kind} run ${record.runId} uses a one-shot transport and cannot accept live follow-up input.`
        : `${this.kind} run ${record.runId} cannot accept cancellation.`,
      {
        ...this.snapshot(record),
        operation,
        accepted: false,
        recovery: this.recovery(),
      },
      "degraded",
    );
  }

  private snapshot(record: OrchestrationRunRecord): OrchestrationRunSnapshot {
    const active = record.state === "running";
    return {
      runId: record.runId,
      invocationId: record.invocationId,
      kind: this.kind,
      state: record.state,
      capabilities: {
        cancel: {
          supported: record.cancelSupported,
          available: active && Boolean(record.cancel),
          reason: record.cancelSupported
            ? (active && record.cancel ? undefined : "run_not_active")
            : "transport_unsupported",
        },
        followUp: {
          supported: record.followUpSupported,
          available: active && Boolean(record.followUp),
          reason: record.followUpSupported ? (active ? undefined : "run_not_active") : "one_shot_transport",
        },
      },
    };
  }

  private recovery(): Record<string, unknown> {
    return {
      strategy: "start_new_run",
      action: `${this.kind}.launch`,
      preservesLiveContext: false,
      message: `Start a new ${this.kind} run with the additional instruction and any required context.`,
    };
  }

  private prune(): void {
    if (this.runs.size <= this.retainedRuns) return;
    const terminal = [...this.runs.values()]
      .filter(record => !isActive(record.state))
      .sort((left, right) => left.sequence - right.sequence);
    for (const record of terminal) {
      if (this.runs.size <= this.retainedRuns) break;
      this.runs.delete(record.runId);
    }
  }
}
