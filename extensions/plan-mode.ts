/**
 * =============================================================================
 * Canvast — Plan Mode / Canvast 源文件
 * =============================================================================
 * @file        extensions/plan-mode.ts
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
/**
 * pi agent 扩展: Plan Mode (计划模式)
 * 使用方式: pi --extension extensions/plan-mode.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  defaultRuntimeStatusDir,
  summarizeRuntimeInput,
  upsertRuntimeStatusItem,
} from "../src/harness/runtime-status.js";
import {
  DesktopActionHandlerError,
  registerDesktopActionHandler,
  registerDesktopActionTool,
} from "../src/desktop-action/tool-bridge.js";
import { PLAN_UPDATE_STATUSES } from "../src/desktop-action/protocol.js";
import { publishExtensionRuntimeCheckpoint } from "../src/harness/runtime-safe-checkpoint.js";

interface ActivePlanState {
  version: 1;
  planId: string;
  task: string;
  markdown: string | null;
  startedAt: string;
  approved: boolean;
  stepIds: string[];
}

const PLAN_MODE_STATE_FILE = "plan-mode-state.json";

function runtimeDir(): string {
  return defaultRuntimeStatusDir();
}

function planModeStateFile(agentDir: string): string {
  return path.join(agentDir, PLAN_MODE_STATE_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readActivePlan(agentDir: string): ActivePlanState | null {
  const file = planModeStateFile(agentDir);
  if (!fs.existsSync(file)) return null;
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!isRecord(value) ||
        value.version !== 1 ||
        typeof value.planId !== "string" || !value.planId ||
        typeof value.task !== "string" ||
        (value.markdown !== null && typeof value.markdown !== "string") ||
        typeof value.startedAt !== "string" || !value.startedAt ||
        typeof value.approved !== "boolean" ||
        !Array.isArray(value.stepIds) ||
        value.stepIds.some(id => typeof id !== "string")) {
      return null;
    }
    return {
      version: 1,
      planId: value.planId,
      task: value.task,
      markdown: value.markdown as string | null,
      startedAt: value.startedAt,
      approved: value.approved,
      stepIds: [...value.stepIds] as string[],
    };
  } catch {
    return null;
  }
}

function writeActivePlan(agentDir: string, state: ActivePlanState | null): void {
  fs.mkdirSync(agentDir, { recursive: true });
  const target = planModeStateFile(agentDir);
  if (state === null) {
    fs.rmSync(target, { force: true });
    return;
  }
  const temporary = `${target}.${process.pid}.${process.hrtime.bigint()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function noActivePlanResult() {
  return {
    isError: true,
    content: [{ type: "text" as const, text: "No active plan. Call enter_plan_mode first." }],
    details: { code: "no_active_plan" },
  };
}

function planId(task: string): string {
  let hash = 0;
  for (const char of task) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return `plan-mode-${Math.abs(hash).toString(36) || "current"}`;
}

function parsePlanSteps(plan: string): string[] {
  return plan
    .split(/\r?\n/)
    .map(line => line.trim())
    .map(line => line
      .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, "")
      .replace(/^\s*[-*+]\s+/, "")
      .replace(/^\s*\d+[.)]\s+/, "")
      .trim())
    .filter(line => line.length > 0 && !line.startsWith("#"))
    .slice(0, 12);
}

function stepId(plan: string, index: number): string {
  return `${plan}-step-${index + 1}`;
}

export default function (pi: ExtensionAPI) {
  const statusDir = runtimeDir();
  let activePlan = readActivePlan(statusDir);

  type PlanTransitionStatus = "in_progress" | "completed" | "blocked";

  class PlanTransitionError extends Error {
    constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) {
      super(message);
      this.name = "PlanTransitionError";
    }
  }

  function transitionPlan(
    requestedPlanId: string, targetStatus: PlanTransitionStatus, summary?: string,
  ): { planId: string; status: PlanTransitionStatus; message: string; idempotent: boolean } {
    const current = activePlan;
    if (!current) {
      throw new PlanTransitionError("no_active_plan", "No active plan. Call enter_plan_mode first.", {
        planId: requestedPlanId,
      });
    }
    if (requestedPlanId !== current.planId) {
      throw new PlanTransitionError(
        "not_active_plan",
        `Plan ${requestedPlanId} is not the runtime-owned active plan.`,
        { planId: requestedPlanId, activePlanId: current.planId },
      );
    }
    if (targetStatus === "completed" && !current.approved) {
      throw new PlanTransitionError(
        "invalid_transition",
        `Plan ${requestedPlanId} must be approved before it can be completed.`,
        { planId: requestedPlanId, targetStatus, approved: false },
      );
    }
    if (targetStatus === "in_progress" && current.approved) {
      return {
        planId: current.planId, status: targetStatus,
        message: `Plan ${current.planId} is already in progress.`, idempotent: true,
      };
    }

    const now = new Date().toISOString();
    const elapsedMs = Math.max(0, Date.parse(now) - Date.parse(current.startedAt));
    const stepTitles = parsePlanSteps(current.markdown || "");

    if (targetStatus === "in_progress") {
      const candidate: ActivePlanState = { ...current, stepIds: [...current.stepIds], approved: true };
      // The canonical owner commits first. Projection writes happen only after
      // the atomic rename succeeds, so a persistence failure is fail-closed.
      writeActivePlan(statusDir, candidate);
      activePlan = candidate;
      upsertRuntimeStatusItem(statusDir, {
        plane: "plans",
        item: {
          id: candidate.planId, title: candidate.task, status: "in_progress",
          summary: summary ? `Approved: ${summarizeRuntimeInput(summary, 160)}` : "Plan approved; implementation may proceed.",
          startedAt: candidate.startedAt,
        },
      });
      for (const [index, id] of candidate.stepIds.entries()) {
        upsertRuntimeStatusItem(statusDir, {
          plane: "tasks",
          item: {
            id, title: stepTitles[index] || `Plan step ${index + 1}`,
            status: index === 0 ? "in_progress" : "pending",
            summary: index === 0 ? "Plan approved; first step is active." : "Waiting for earlier plan steps.",
            startedAt: now,
          },
        });
      }
      return {
        planId: candidate.planId, status: targetStatus,
        message: `Plan ${candidate.planId} is in progress.`, idempotent: false,
      };
    }

    // Removing the active-state file is the canonical terminal commit. Keep the
    // in-memory owner unchanged until it succeeds.
    writeActivePlan(statusDir, null);
    activePlan = null;
    upsertRuntimeStatusItem(statusDir, {
      plane: "plans",
      item: {
        id: current.planId, title: current.task, status: targetStatus,
        summary: summary ? summarizeRuntimeInput(summary, 200) : "Plan mode exited.",
        startedAt: current.startedAt, completedAt: now, elapsedMs,
      },
    });
    for (const [index, id] of current.stepIds.entries()) {
      upsertRuntimeStatusItem(statusDir, {
        plane: "tasks",
        item: {
          id, title: stepTitles[index] || `Plan step ${index + 1}`, status: targetStatus,
          summary: summary ? summarizeRuntimeInput(summary, 160) : "Plan mode exited.",
          startedAt: current.startedAt, completedAt: now, elapsedMs,
        },
      });
    }
    return {
      planId: current.planId, status: targetStatus,
      message: `Plan ${current.planId} is ${targetStatus}.`, idempotent: false,
    };
  }

  registerDesktopActionHandler(pi, "plan.update", args => {
    const requestedPlanId = typeof args.planId === "string" && args.planId.trim()
      ? args.planId.trim()
      : typeof args.id === "string" ? args.id.trim() : "";
    const status = typeof args.status === "string" ? args.status.trim() : "";
    if (!requestedPlanId) throw new DesktopActionHandlerError("invalid_arguments", "planId is required.");
    if (!(PLAN_UPDATE_STATUSES as readonly string[]).includes(status)) {
      throw new DesktopActionHandlerError(
        "invalid_arguments", `Unsupported canonical plan status: ${status}.`,
        { planId: requestedPlanId, status, acceptedStatuses: [...PLAN_UPDATE_STATUSES] },
      );
    }
    try {
      const transition = transitionPlan(requestedPlanId, status as PlanTransitionStatus);
      if (status === "in_progress" && !transition.idempotent) {
        publishExtensionRuntimeCheckpoint(pi, "on_plan_approved");
      }
      return transition;
    } catch (error) {
      if (error instanceof PlanTransitionError) {
        throw new DesktopActionHandlerError(error.code, error.message, error.details);
      }
      throw error;
    }
  });

  registerDesktopActionTool(pi, {
    name: "enter_plan_mode",
    label: "Enter Plan Mode",
    description: "进入计划模式。先研究代码库再提交方案。调用后不要修改文件，先用propose_plan提交方案。",
    parameters: Type.Object({
      task: Type.String({ description: "计划要解决的任务" }),
      reason: Type.Optional(Type.String({ description: "为何需要计划模式" })),
    }),
    async execute(_id, params) {
      activePlan = {
        version: 1,
        planId: planId(params.task),
        task: params.task,
        markdown: null,
        startedAt: new Date().toISOString(),
        approved: false,
        stepIds: [],
      };
      writeActivePlan(statusDir, activePlan);
      upsertRuntimeStatusItem(statusDir, {
        plane: "plans",
        item: {
          id: activePlan.planId,
          title: params.task,
          status: "in_progress",
          summary: params.reason ? `Plan mode entered: ${summarizeRuntimeInput(params.reason, 140)}` : "Plan mode entered.",
          startedAt: activePlan.startedAt,
        },
      });
      return {
        content: [{
          type: "text" as const,
          text: `📋 **计划模式** | 任务: ${params.task}\n\n研究代码库后调用 propose_plan 提交方案。方案批准前不要修改文件。${params.reason ? `\n原因: ${params.reason}` : ""}`,
        }],
        details: undefined,
      };
    },
  });

  registerDesktopActionTool(pi, {
    name: "propose_plan",
    label: "Propose Plan",
    description: "提交实施计划。包括涉及文件、修改步骤、架构决策。",
    parameters: Type.Object({
      plan: Type.String({ description: "实施计划 (markdown)" }),
      files_affected: Type.Array(Type.String({ description: "影响的文件" })),
      estimated_steps: Type.Optional(Type.Number()),
      risk_level: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
    }),
    async execute(_id, params) {
      if (!activePlan) return noActivePlanResult();
      const plan = activePlan;
      const previousPlan = plan.markdown;
      const previousSteps = parsePlanSteps(previousPlan || "");
      const previousStepIds = plan.stepIds;
      const steps = parsePlanSteps(params.plan);
      const revisedStepIds = steps.map((_step, index) => stepId(plan.planId, index));
      const revisedStepIdSet = new Set(revisedStepIds);
      const supersededAt = new Date().toISOString();
      const supersededElapsedMs = Math.max(0, Date.parse(supersededAt) - Date.parse(plan.startedAt));
      for (const [index, id] of previousStepIds.entries()) {
        if (revisedStepIdSet.has(id)) continue;
        upsertRuntimeStatusItem(statusDir, {
          plane: "tasks",
          item: {
            id,
            title: previousSteps[index] || `Plan step ${index + 1}`,
            status: "aborted",
            summary: "Superseded by revised plan.",
            startedAt: plan.startedAt,
            completedAt: supersededAt,
            elapsedMs: supersededElapsedMs,
          },
        });
      }
      plan.markdown = params.plan;
      plan.stepIds = revisedStepIds;
      writeActivePlan(statusDir, plan);
      upsertRuntimeStatusItem(statusDir, {
        plane: "plans",
        item: {
          id: plan.planId,
          title: plan.task,
          status: "pending",
          summary: `Plan proposed. Files: ${params.files_affected.join(", ").slice(0, 160)}; risk=${params.risk_level || "N/A"}`,
          startedAt: plan.startedAt,
        },
      });
      steps.forEach((step, index) => {
        upsertRuntimeStatusItem(statusDir, {
          plane: "tasks",
          item: {
            id: revisedStepIds[index],
            title: step,
            status: "pending",
            summary: `Plan step ${index + 1}/${steps.length}: ${summarizeRuntimeInput(plan.task, 100)}`,
            startedAt: plan.startedAt,
          },
        });
      });
      const summary = `# 📝 实施计划\n${params.plan}\n\n**影响文件**: ${params.files_affected.join(", ")}\n**步骤**: ${params.estimated_steps || "N/A"}\n**风险**: ${params.risk_level || "N/A"}\n\n⚠️ 等待批准。批准后调用 approve_plan。`;
      return {
        content: [{ type: "text" as const, text: summary }],
        details: { status: "proposed", planId: plan.planId },
      };
    },
  });

  registerDesktopActionTool(pi, {
    name: "approve_plan",
    label: "Approve Plan",
    description: "批准计划开始实施。仅在用户明确同意后调用。",
    parameters: Type.Object({
      notes: Type.Optional(Type.String({ description: "审批备注" })),
    }),
    async execute(_id, params) {
      if (!activePlan) return noActivePlanResult();
      const plan = activePlan;
      const transition = transitionPlan(plan.planId, "in_progress", params.notes);
      if (!transition.idempotent) {
        publishExtensionRuntimeCheckpoint(pi, "on_plan_approved");
      }
      return {
        content: [{
          type: "text" as const,
          text: `✅ **计划已批准**, 开始实施${params.notes ? `。备注: ${params.notes}` : ""}`,
        }],
        details: { status: "approved", planId: plan.planId },
      };
    },
  });

  registerDesktopActionTool(pi, {
    name: "exit_plan_mode",
    label: "Exit Plan Mode",
    description: "退出计划模式，实施完成。",
    parameters: Type.Object({
      summary: Type.Optional(Type.String({ description: "实施总结" })),
    }),
    async execute(_id, params) {
      if (!activePlan) return noActivePlanResult();
      const plan = activePlan;
      const prev = plan.markdown;
      transitionPlan(plan.planId, plan.approved ? "completed" : "blocked", params.summary);
      return { content: [{ type: "text" as const, text: `🏁 **计划模式结束**${params.summary ? `\n${params.summary}` : ""}${prev ? `\n\n原计划: ${prev.slice(0, 1000)}` : ""}` }], details: undefined };
    },
  });
}
