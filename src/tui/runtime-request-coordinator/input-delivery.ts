/**
 * =============================================================================
 * Canvast — Runtime Input Delivery / 运行时输入投递
 * =============================================================================
 * @file        src/tui/runtime-request-coordinator/input-delivery.ts
 * @brief       Persists complete input payloads and returns exact queue bindings.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import type { RuntimeInputPayloadInput } from "../../harness/runtime-input-payload.js";
import {
  readRuntimeStatus,
  recordRuntimeInputQueueItem,
  recordRuntimeRequest,
  summarizeRuntimeInput,
  transitionRuntimeInputQueueItem,
  transitionRuntimeRequest,
  type RuntimeInputDeliveryMode,
  type RuntimeInputQueuePolicy,
} from "../../harness/runtime-status.js";
import { queueStatus, requestKind, sessionId, stableProjectId } from "../runtime-request-coordinator-support.js";
import type { RuntimeInputBinding } from "./types.js";

export interface RuntimeInputImage {
  type: "image";
  data: string;
  mimeType: string;
}

function payloadParts(text: string, images: unknown): RuntimeInputPayloadInput["parts"] {
  const parts: RuntimeInputPayloadInput["parts"] = [{ kind: "text", text }];
  if (!Array.isArray(images)) return parts;
  for (const image of images) {
    if (!image || typeof image !== "object") {
      throw new Error("Runtime input image payload must be an image content object.");
    }
    const candidate = image as Partial<RuntimeInputImage>;
    if (candidate.type !== "image" || typeof candidate.data !== "string" ||
        typeof candidate.mimeType !== "string" || !candidate.mimeType.trim()) {
      throw new Error("Runtime input image payload requires type, data, and mimeType.");
    }
    parts.push({ kind: "image", mimeType: candidate.mimeType, dataBase64: candidate.data });
  }
  return parts;
}

export class RuntimeInputDeliveryStore {
  constructor(
    private readonly agentDir: () => string,
    private readonly configuredProjectId?: () => string,
  ) {}

  record(input: {
    policy: RuntimeInputQueuePolicy;
    text: string;
    images?: unknown;
    source: string;
    affectsActiveWork: boolean;
    deliveryMode: RuntimeInputDeliveryMode;
    parentRequestId?: string;
    context?: unknown;
    requestId: string;
  }): RuntimeInputBinding {
    const dir = this.agentDir();
    const current = readRuntimeStatus(dir);
    const payload: RuntimeInputPayloadInput = {
      projectId: current.continuity.projectId || stableProjectId(dir, this.configuredProjectId?.()),
      sessionId: current.continuity.sessionId || sessionId(input.context),
      parts: payloadParts(input.text, input.images),
    };
    const snapshot = recordRuntimeInputQueueItem(dir, {
      requestId: input.requestId,
      policy: input.policy,
      textSummary: summarizeRuntimeInput(input.text, 180),
      payload,
      source: input.source,
      affectsActiveWork: input.affectsActiveWork,
      status: queueStatus(input.policy),
      deliveryMode: input.deliveryMode,
    });
    recordRuntimeRequest(dir, {
      requestId: input.requestId,
      parentRequestId: input.parentRequestId,
      kind: requestKind(input.policy),
      textSummary: input.text,
      status: "queued",
      deliveryMode: input.deliveryMode,
    });
    const queued = snapshot.inputQueue.find(item => item.requestId === input.requestId);
    if (!queued) throw new Error(`Runtime input queue did not persist request ${input.requestId}.`);
    return {
      id: queued.id,
      requestId: input.requestId,
      sequence: queued.sequence,
      timestamp: queued.timestamp,
    };
  }

  fail(binding: RuntimeInputBinding, failureReason: string): void {
    const message = summarizeRuntimeInput(failureReason || "Request delivery failed.", 500);
    transitionRuntimeInputQueueItem(this.agentDir(), {
      id: binding.id,
      patch: { status: "failed", failureReason: message },
    });
    transitionRuntimeRequest(this.agentDir(), {
      requestId: binding.requestId,
      status: "failed",
      failureReason: message,
    });
  }
}
