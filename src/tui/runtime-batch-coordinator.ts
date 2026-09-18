/**
 * =============================================================================
 * Canvast — Runtime Batch Coordinator / 运行时批量协调器
 * =============================================================================
 * @file        src/tui/runtime-batch-coordinator.ts
 * @brief       Stages queued input as one exact, typed safe-checkpoint batch.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import { randomUUID } from "node:crypto";

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

import {
  batchCandidateHash,
  batchCandidates,
} from "../harness/auto-orchestrator/batch-admission.js";
import type { ReevaluateCheckpoint, RuntimeInputQueueItem } from "../harness/context-continuity/runtime-queue.js";
import { readRuntimeInputPayload } from "../harness/runtime-input-payload.js";
import { stageRuntimeBatch, type RuntimeBatchStage } from "../harness/runtime-batch-bridge.js";
import { readRuntimeStatus } from "../harness/runtime-status.js";
import type { RuntimeInputBinding } from "./runtime-request-coordinator/types.js";

export const RUNTIME_BATCH_MESSAGE_TYPE = "canvast-runtime-input-batch/v1";

export interface RuntimeBatchDispatch {
  stage: RuntimeBatchStage;
  content: Array<TextContent | ImageContent>;
  details: {
    type: typeof RUNTIME_BATCH_MESSAGE_TYPE;
    batchId: string;
    revision: number;
    checkpoint: ReevaluateCheckpoint;
    candidateHash: string;
    items: RuntimeInputBinding[];
  };
}

interface MaterializedQueueInput {
  text: string;
  content: Array<TextContent | ImageContent>;
}

function isVisiblyTruncatedLegacySummary(text: string): boolean {
  return text.length >= 180 && text.endsWith("…");
}

function materializeQueueInput(
  agentDir: string,
  item: RuntimeInputQueueItem,
  expectedScope?: { projectId: string; sessionId: string },
): MaterializedQueueInput | undefined {
  if (!item.payload) {
    const legacyText = item.textSummary.trim();
    if (!legacyText || isVisiblyTruncatedLegacySummary(item.textSummary)) return undefined;
    return { text: legacyText, content: [{ type: "text", text: legacyText }] };
  }
  try {
    const payload = readRuntimeInputPayload(agentDir, item.payload, expectedScope);
    const content = payload.parts.map((part): TextContent | ImageContent => part.kind === "text"
      ? { type: "text", text: part.text }
      : { type: "image", data: part.bytes.toString("base64"), mimeType: part.mimeType });
    const text = payload.parts.map(part => part.kind === "text"
      ? part.text
      : `[image:${part.mimeType}:${part.bytes.length} bytes]`).join("\n");
    return { text, content };
  } catch {
    return undefined;
  }
}

function inputHeader(index: number, item: RuntimeInputQueueItem): TextContent {
  return {
    type: "text",
    text: [
      `### Input ${index + 1}`,
      `id=${item.id}`,
      `request_id=${item.requestId}`,
      `sequence=${item.sequence}`,
      `timestamp=${item.timestamp}`,
      `status=${item.status}`,
      `prior_policy=${item.policy}`,
      `defer_attempt_count=${item.deferInfo?.attemptCount || 0}`,
    ].join("\n"),
  };
}

export function prepareRuntimeBatchDispatch(
  scope: object,
  agentDir: string,
  checkpoint: ReevaluateCheckpoint,
  createId: () => string = randomUUID,
): RuntimeBatchDispatch | undefined {
  const snapshot = readRuntimeStatus(agentDir);
  const manifest = batchCandidates(snapshot.inputQueue, checkpoint);
  if (manifest.length === 0) return undefined;
  const byId = new Map(snapshot.inputQueue.map(item => [item.id, item]));
  const expectedScope = snapshot.continuity.projectId && snapshot.continuity.sessionId
    ? { projectId: snapshot.continuity.projectId, sessionId: snapshot.continuity.sessionId }
    : undefined;
  const materialized = manifest.map(candidate => {
    const item = byId.get(candidate.id);
    if (!item?.requestId) return undefined;
    const payload = materializeQueueInput(agentDir, item, expectedScope);
    return payload ? { item, payload } : undefined;
  });
  if (materialized.some(item => item === undefined)) return undefined;
  const candidateHash = batchCandidateHash(manifest);
  const stage: RuntimeBatchStage = {
    batchId: `batch-${createId()}`,
    revision: snapshot.continuity.inputQueueRevision,
    checkpoint,
    candidateHash,
    candidates: manifest.map((candidate, index) => {
      const item = materialized[index]!.item;
      return {
        ...candidate,
        text: materialized[index]!.payload.text,
        policy: item.policy,
        deferAttemptCount: item.deferInfo?.attemptCount || 0,
      };
    }),
  };
  if (!stageRuntimeBatch(scope, stage)) return undefined;
  const instructions: TextContent = {
    type: "text",
    text: [
      "# Canvast Safe-Checkpoint Input Batch",
      `batch_id=${stage.batchId}`,
      `queue_revision=${stage.revision}`,
      `checkpoint=${checkpoint}`,
      `candidate_hash=${candidateHash}`,
      "Treat the entries below as distinct time-ordered user inputs, but make one atomic typed decision for all of them before further work.",
      "Choose per-item policy from supersede_merge, amend_current, parallel_independent, serial_after_current, defer, pause, cancel.",
      "Use supersede_merge for a refinement that subsumes current work; reuse existing evidence and cancel only redundant remaining steps.",
      "Use defer when acting now would block, destabilize, or violate a dependency. Preserve the defer history and name the next safe checkpoint.",
      "Call auto_orchestration_decision once with batch_plan copied exactly from this manifest. Any missing, reordered, stale, or altered binding fails closed.",
    ].join("\n"),
  };
  const content: Array<TextContent | ImageContent> = [instructions];
  for (const [index, entry] of materialized.entries()) {
    content.push(inputHeader(index, entry!.item), ...entry!.payload.content);
  }
  const items = manifest.map(item => ({
    id: item.id, requestId: item.requestId, sequence: item.sequence, timestamp: item.timestamp,
  }));
  return {
    stage,
    content,
    details: {
      type: RUNTIME_BATCH_MESSAGE_TYPE, batchId: stage.batchId, revision: stage.revision,
      checkpoint, candidateHash, items,
    },
  };
}

export function hasRuntimeBatchCandidates(agentDir: string, checkpoint: ReevaluateCheckpoint): boolean {
  return batchCandidates(readRuntimeStatus(agentDir).inputQueue, checkpoint).length > 0;
}
