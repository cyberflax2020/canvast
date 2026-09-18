/**
 * =============================================================================
 * Canvast — Runtime Plan Tree Projection / Canvast 源文件
 * =============================================================================
 * @file        src/harness/runtime-plan-tree.ts
 * @brief       Projects orchestration plans into the live runtime task tree.
 * @description Keeps the TUI task tree aligned with auto orchestration records
 *              without coupling display code to the orchestrator controller.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import type { RecordedOrchestrationDecision } from "./auto-orchestrator.js";
import {
  recordRuntimeEvent,
  summarizeRuntimeInput,
  updateRuntimeStatus,
  type RuntimeStatusItem,
  type RuntimeItemStatus,
} from "./runtime-status.js";

export interface RuntimePlanTreeProjectionOptions {
  now?: string;
  source?: string;
  rootRequestId?: string;
  sessionId?: string;
}

function orchestrationPlanId(decision: Pick<RecordedOrchestrationDecision, "assessmentId">): string {
  return `auto-orchestration-${decision.assessmentId}`;
}

function orchestrationStepId(planId: string, index: number): string {
  return `${planId}-step-${index + 1}`;
}

function planStatus(decision: Pick<RecordedOrchestrationDecision, "lifecycleAction">): RuntimeItemStatus {
  if (decision.lifecycleAction === "exit") return "completed";
  return "in_progress";
}

function isActiveStatus(status: RuntimeItemStatus): boolean {
  return status === "in_progress" || status === "running";
}

function isExecutableStatus(status: RuntimeItemStatus): boolean {
  return status === "pending" || status === "unknown";
}

function orchestrationSteps(decision: Pick<RecordedOrchestrationDecision, "planSteps" | "workflowSteps" | "subagentTasks">): string[] {
  if (decision.planSteps.length > 0) return decision.planSteps;
  if (decision.workflowSteps.length > 0) return decision.workflowSteps;
  return decision.subagentTasks;
}

export function shouldProjectRuntimePlanTree(decision: RecordedOrchestrationDecision): boolean {
  return decision.mode !== "direct" ||
    Boolean(decision.lifecycleAction) ||
    orchestrationSteps(decision).length > 0;
}

function priorPlanSteps(items: RuntimeStatusItem[], planId: string): RuntimeStatusItem[] {
  const prefix = `${planId}-step-`;
  return items
    .filter(item => item.id.startsWith(prefix))
    .sort((left, right) => {
      const leftIndex = Number(left.id.slice(prefix.length));
      const rightIndex = Number(right.id.slice(prefix.length));
      return leftIndex - rightIndex;
    });
}

function matchPriorStep(
  existing: RuntimeStatusItem[],
  usedIds: Set<string>,
  planId: string,
  title: string,
  index: number,
): RuntimeStatusItem | undefined {
  const indexedId = orchestrationStepId(planId, index);
  const indexed = existing.find(item => item.id === indexedId && item.title === title);
  if (indexed && !usedIds.has(indexed.id)) return indexed;
  return existing.find(item => item.title === title && !usedIds.has(item.id));
}

function projectedSteps(
  planId: string,
  titles: string[],
  existing: RuntimeStatusItem[],
  decision: RecordedOrchestrationDecision,
  now: string,
  rootRequestId?: string,
  sessionId?: string,
): RuntimeStatusItem[] {
  const usedIds = new Set<string>();
  const items = titles.map((title, index): RuntimeStatusItem => {
    const prior = matchPriorStep(existing, usedIds, planId, title, index);
    if (prior) usedIds.add(prior.id);
    const status = decision.lifecycleAction === "exit" ? "completed" : prior?.status || "pending";
    return {
      id: orchestrationStepId(planId, index),
      title,
      status,
      rootRequestId,
      sessionId,
      summary: `Auto orchestration step ${index + 1}/${titles.length}: ${summarizeRuntimeInput(decision.taskSummary, 100)}`,
      updatedAt: now,
      startedAt: prior?.startedAt || decision.recordedAt,
      completedAt: status === "completed" ? prior?.completedAt || now : undefined,
      elapsedMs: prior?.elapsedMs,
    };
  });

  if (decision.lifecycleAction !== "exit" && !items.some(item => isActiveStatus(item.status))) {
    const firstExecutable = items.find(item => isExecutableStatus(item.status));
    if (firstExecutable) firstExecutable.status = "in_progress";
  }
  return items;
}

export function recordOrchestrationPlanTree(
  agentDir: string,
  decision: RecordedOrchestrationDecision,
  options: RuntimePlanTreeProjectionOptions = {},
): void {
  if (!shouldProjectRuntimePlanTree(decision)) return;
  const now = options.now || new Date().toISOString();
  const source = options.source || "auto_orchestration_decision";
  const planId = orchestrationPlanId(decision);
  let projectedStepCount = 0;
  updateRuntimeStatus(agentDir, snapshot => {
    const previousPlan = snapshot.plans.find(item => item.id === planId);
    const previousSteps = priorPlanSteps(snapshot.tasks, planId);
    const decisionSteps = orchestrationSteps(decision);
    const stepTitles = decisionSteps.length > 0 ? decisionSteps : previousSteps.map(item => item.title);
    const rootRequestId = options.rootRequestId || snapshot.rootExecution.rootRequestId || previousPlan?.rootRequestId;
    const sessionId = options.sessionId || snapshot.rootExecution.sessionId || previousPlan?.sessionId;
    const steps = projectedSteps(planId, stepTitles, previousSteps, decision, now, rootRequestId, sessionId);
    projectedStepCount = steps.length;
    const plan: RuntimeStatusItem = {
      id: planId,
      title: decision.taskSummary || "Auto orchestration plan",
      status: planStatus(decision),
      rootRequestId,
      sessionId,
      summary: summarizeRuntimeInput(`${decision.mode}${decision.lifecycleAction ? `/${decision.lifecycleAction}` : ""}: ${decision.rationale}`, 180),
      updatedAt: now,
      startedAt: previousPlan?.startedAt || decision.recordedAt,
      completedAt: decision.lifecycleAction === "exit" ? previousPlan?.completedAt || now : undefined,
      elapsedMs: previousPlan?.elapsedMs,
    };
    return {
      ...snapshot,
      updatedAt: now,
      plans: [...snapshot.plans.filter(item => item.id !== planId), plan].slice(-30),
      tasks: [
        ...snapshot.tasks.filter(item => !item.id.startsWith(`${planId}-step-`)),
        ...steps,
      ].slice(-30),
    };
  });

  recordRuntimeEvent(agentDir, {
    kind: "plan_tree",
    title: "Runtime plan tree updated",
    summary: `${decision.mode}${decision.lifecycleAction ? `/${decision.lifecycleAction}` : ""}: ${projectedStepCount} step(s) projected`,
    source,
    timestamp: now,
  });
}
