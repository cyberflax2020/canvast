/**
 * =============================================================================
 * Canvast — Runtime Resume Support / Canvast source file
 * =============================================================================
 * @file        src/harness/runtime-resume-support.ts
 * @brief       Support functions for canonical runtime resume state.
 * @description Keeps filesystem/storage and structural validation helpers out
 *              of the main runtime-resume reducer module so the public state
 *              machine stays focused and below the project file-size cap.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import { createHash } from "node:crypto";
import * as path from "node:path";

import { readProtectedTextFile, writeProtectedTextFileAtomic } from "./context-continuity/filesystem.js";
import type { ContextContinuityState, RuntimeContinuityCheckpoint } from "./context-continuity.js";
import type {
  ResumeCandidate,
  ResumeCandidateSource,
  ResumeCandidateValidation,
  ResumeFreshness,
  ResumeAvailability,
} from "./runtime-resume.js";
import type { RuntimeStatusSnapshot } from "./runtime-status.js";

export interface RawCanvasGraph {
  nodes: Array<{ id: string; type: string }>;
  edges: Array<{ type: string; fromNodeId: string; toNodeId: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function runtimeResumeFingerprint(parts: string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}

export function runtimeResumeFile(agentDir: string): string {
  return path.join(agentDir, "runtime-resume.json");
}

export function readStoredRuntimeResume(agentDir: string): unknown | undefined {
  const file = runtimeResumeFile(agentDir);
  try {
    const stored = readProtectedTextFile(file);
    if (stored === undefined) return undefined;
    return JSON.parse(stored);
  } catch {
    return undefined;
  }
}

export function writeStoredRuntimeResume(state: unknown, agentDir: string): void {
  writeProtectedTextFileAtomic(runtimeResumeFile(agentDir), JSON.stringify(state, null, 2));
}

export function emptyCheckpoint(): RuntimeContinuityCheckpoint {
  return { taskIds: [], planIds: [], subAgentIds: [], workflowIds: [], toolRunIds: [] };
}

function dateValue(timestamp: string | undefined): number {
  const value = Date.parse(String(timestamp || ""));
  return Number.isFinite(value) ? value : 0;
}

export function readCanvasGraph(agentDir: string): RawCanvasGraph {
  const file = path.join(agentDir, "canvas-graph.json");
  try {
    const raw = JSON.parse(readProtectedTextFile(file) || "{}") as { nodes?: unknown[]; edges?: unknown[] };
    const nodes = Array.isArray(raw.nodes)
      ? raw.nodes
          .filter((node): node is Record<string, unknown> => isRecord(node))
          .map((node: Record<string, unknown>) => ({ id: asString(node.id), type: asString(node.type) }))
          .filter((node: { id: string; type: string }) => Boolean(node.id))
      : [];
    const edges = Array.isArray(raw.edges)
      ? raw.edges
          .filter((edge): edge is Record<string, unknown> => isRecord(edge))
          .map((edge: Record<string, unknown>) => ({
            type: asString(edge.type),
            fromNodeId: asString(edge.fromNodeId),
            toNodeId: asString(edge.toNodeId),
          }))
          .filter((edge: { type: string; fromNodeId: string; toNodeId: string }) =>
            Boolean(edge.type && edge.fromNodeId && edge.toNodeId),
          )
      : [];
    return { nodes, edges };
  } catch {
    return { nodes: [], edges: [] };
  }
}

export function buildResumeValidation(
  candidate: ResumeCandidateSource,
  prior: ResumeCandidate | undefined,
  graph: RawCanvasGraph,
  continuity: ContextContinuityState,
  now: string,
  projectId: string,
  staleCandidateMs: number,
): ResumeCandidateValidation {
  const issues: string[] = [];
  const binding = prior?.binding;
  const projectMatched = !candidate.projectId || !projectId || candidate.projectId === projectId;
  if (!projectMatched) issues.push("Project scope changed; resume candidate was created under a different project id.");

  const blockingActiveRun = Boolean(
    continuity.activeTurn?.requestId &&
    continuity.activeTurn.requestId !== candidate.requestId &&
    continuity.activeTurn.phase !== "completed" &&
    continuity.activeTurn.phase !== "interrupted",
  );
  if (blockingActiveRun) issues.push("Another active runtime turn is already in progress.");

  const freshness: ResumeFreshness = dateValue(now) - dateValue(candidate.lastActiveAt) > staleCandidateMs ? "stale" : "fresh";
  if (freshness === "stale") issues.push("Resume snapshot is older than 24 hours; verify scope before resuming.");

  if (!binding?.planNodeId || !binding?.taskNodeId) {
    return {
      availability: projectMatched ? blockingActiveRun ? "blocked_active_run" : "needs_rebind" : "project_mismatch",
      freshness,
      issues,
      projectMatched,
      hasBlockingActiveRun: blockingActiveRun,
      missingPlanNode: false,
      missingTaskNode: false,
      parentLinkValid: false,
    };
  }

  const planNode = graph.nodes.find(node => node.id === binding.planNodeId && node.type === "plan");
  const taskNode = graph.nodes.find(node => node.id === binding.taskNodeId && node.type === "plan");
  const parentLinkValid = Boolean(planNode && taskNode && graph.edges.some(edge =>
    edge.type === "DECOMPOSES_INTO" && edge.fromNodeId === binding.planNodeId && edge.toNodeId === binding.taskNodeId,
  ));
  if (!planNode) issues.push(`Canvas plan node ${binding.planNodeId} no longer exists.`);
  if (!taskNode) issues.push(`Canvas task node ${binding.taskNodeId} no longer exists.`);
  if (planNode && taskNode && !parentLinkValid) issues.push(`Canvas task ${binding.taskNodeId} is no longer a child of plan ${binding.planNodeId}.`);

  const availability: ResumeAvailability = !projectMatched
    ? "project_mismatch"
    : blockingActiveRun
      ? "blocked_active_run"
      : !planNode
        ? "missing_plan_node"
        : !taskNode
          ? "missing_task_node"
          : !parentLinkValid
            ? "invalid_parent_link"
            : "ready";
  return {
    availability,
    freshness,
    issues,
    projectMatched,
    hasBlockingActiveRun: blockingActiveRun,
    missingPlanNode: !planNode,
    missingTaskNode: !taskNode,
    parentLinkValid,
  };
}

function summarizeRequest(snapshot: RuntimeStatusSnapshot, requestId: string): { title: string; summary: string } {
  const request = snapshot.requests.find(item => item.requestId === requestId);
  const task = snapshot.tasks.find(item => item.id === "current-user-request");
  const summary = request?.textSummary || task?.summary || "Continue unfinished work from the persisted runtime state.";
  return {
    title: task?.title || "Resume active work",
    summary,
  };
}

export function deriveResumeSources(
  continuity: ContextContinuityState,
  runtime: RuntimeStatusSnapshot,
): ResumeCandidateSource[] {
  const turn = continuity.activeTurn;
  if (!turn || !turn.requestId || turn.phase === "completed") return [];
  const latestCompaction = continuity.compactions.at(-1);
  const requestInfo = summarizeRequest(runtime, turn.requestId);
  return [{
    id: `resume-${turn.turnId || runtimeResumeFingerprint([turn.requestId])}`,
    projectId: continuity.project.id || "",
    requestId: turn.requestId,
    title: requestInfo.title,
    summary: requestInfo.summary,
    createdAt: turn.startedAt || turn.updatedAt || runtime.updatedAt,
    updatedAt: turn.updatedAt || runtime.updatedAt,
    lastActiveAt: turn.updatedAt || runtime.updatedAt,
    sessionId: turn.sessionId || undefined,
    turnId: turn.turnId || undefined,
    continuationOwner: latestCompaction?.owner,
    continuityPhase: turn.phase,
    operationId: latestCompaction?.operationId,
    checkpoint: turn.checkpoint || emptyCheckpoint(),
  }];
}

export function stableRuntimeResumeProjectId(projectRoot?: string): string {
  const scope = projectRoot || process.env.CANVAST_PROJECT_ROOT || process.cwd();
  return `project-${createHash("sha256").update(scope).digest("hex").slice(0, 16)}`;
}
