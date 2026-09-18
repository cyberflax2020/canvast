/**
 * =============================================================================
 * Canvast — Cron Scheduler / 定时任务调度
 * =============================================================================
 * @file        extensions/cron-scheduler.ts
 * @brief       Schedule recurring or one-shot agent tasks
 * @description Session-level scheduled task control (in-memory, no disk
 *              persistence) with explicit delivery and cleanup semantics.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * Changes: [2026-08-08] Initial implementation
 *          [2026-08-15] Real firing and honest supported-expression boundary
 *          [2026-08-25] Follow-up delivery and session-owned timer cleanup
 * =============================================================================
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

interface CronJob {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  createdAt: string;
  timer?: NodeJS.Timeout;
  intervalMs: number;
  fired: number;
}

/** Parse the supported five-field subset: every N minutes. / 解析支持的五段式每 N 分钟子集。 */
function parseSimpleCron(parts: string[]): number | null {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  if (!minute?.startsWith("*/") || hour !== "*" || dayOfMonth !== "*" || month !== "*" || dayOfWeek !== "*") {
    return null;
  }
  const minutes = Number(minute.slice(2));
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return null;
  return minutes * 60 * 1000;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function (pi: ExtensionAPI) {
  const jobs = new Map<string, CronJob>();
  let jobSeq = 0;
  let shuttingDown = false;

  const clearJob = (job: CronJob): void => {
    if (job.timer) clearTimeout(job.timer);
    job.timer = undefined;
    jobs.delete(job.id);
  };

  const publishDeliveryFailure = (job: CronJob, error: unknown): void => {
    if (shuttingDown) return;
    try {
      pi.sendMessage({
        customType: "canvast-cron-event",
        content: `Cron job ${job.id} could not deliver its prompt: ${errorText(error)}`,
        display: true,
        details: { jobId: job.id, event: "delivery_failed", error: errorText(error) },
      }, { triggerTurn: false });
    } catch {
      // The owning session may already be closing. / 所属会话可能已经关闭。
    }
  };

  pi.registerTool({
    name: "cron_create",
    label: "Cron Create / 创建定时任务",
    description: `Schedule a recurring or one-shot task. Session-level only (lost on restart).
SUPPORTED pattern: "*/N * * * *" (every N minutes, 1..1440). Other cron features are rejected explicitly.`,
    parameters: Type.Object({
      cron: Type.String({ description: "5-field cron expression / 5字段cron表达式" }),
      prompt: Type.String({ description: "Prompt to run / 要运行的提示" }),
      recurring: Type.Optional(Type.Boolean({ description: "Recurring or one-shot", default: true })),
    }),
    async execute(_id: string, params: any) {
      if (shuttingDown) {
        return { isError: true, content: [{ type: "text" as const, text: "Cron session is shutting down." }], details: undefined };
      }
      const parts = String(params.cron).trim().split(/\s+/);
      if (parts.length !== 5) {
        return { isError: true, content: [{ type: "text" as const, text: "Invalid cron format. Use 5 fields: min hour dom month dow" }], details: undefined };
      }
      const intervalMs = parseSimpleCron(parts);
      const recurring = params.recurring !== false;
      if (intervalMs === null) {
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: `Unsupported cron expression: "${params.cron}".\nImplemented subset: "*/N * * * *" (every N minutes). Hour/day pinning, lists and ranges are not implemented.`,
          }],
          details: undefined,
        };
      }

      const id = `cron_${++jobSeq}`;
      const job: CronJob = {
        id,
        cron: params.cron,
        prompt: params.prompt,
        recurring,
        createdAt: new Date().toISOString(),
        intervalMs,
        fired: 0,
      };

      const fire = (): void => {
        if (shuttingDown || !jobs.has(id)) return;
        job.fired++;
        if (!recurring) clearJob(job);
        try {
          const delivery = pi.sendUserMessage(`[cron ${id}] ${job.prompt}`, {
            deliverAs: "followUp",
            expandPromptTemplates: false,
          });
          void Promise.resolve(delivery).catch(error => publishDeliveryFailure(job, error));
        } catch (error) {
          publishDeliveryFailure(job, error);
        }
      };

      job.timer = recurring ? setInterval(fire, intervalMs) : setTimeout(fire, intervalMs);
      job.timer.unref?.();
      jobs.set(id, job);

      return {
        content: [{
          type: "text" as const,
          text: `✅ Cron job created: **${id}**\nCron: \`${params.cron}\` → every ${intervalMs / 60000} min\nPrompt: "${params.prompt}"\nRecurring: ${recurring}\nDelivery: queued as a follow-up turn\nNote: Session-level only — lost on restart.`,
        }],
        details: { jobId: id, cron: params.cron, intervalMs, recurring },
      };
    },
  });

  pi.registerTool({
    name: "cron_list",
    label: "Cron List / 定时任务列表",
    description: "List all scheduled cron jobs.",
    parameters: Type.Object({}),
    async execute() {
      if (jobs.size === 0) return { content: [{ type: "text" as const, text: "No scheduled cron jobs." }], details: undefined };
      const list = Array.from(jobs.values()).map(job =>
        `- **${job.id}**: \`${job.cron}\` — "${job.prompt}" (${job.recurring ? "recurring" : "one-shot"}, fired ${job.fired}×)`,
      ).join("\n");
      return { content: [{ type: "text" as const, text: `# Cron Jobs / 定时任务 (${jobs.size})\n\n${list}\n\n⚠️ Session-level — lost on restart.` }], details: undefined };
    },
  });

  pi.registerTool({
    name: "cron_delete",
    label: "Cron Delete / 删除定时任务",
    description: "Cancel a scheduled cron job.",
    parameters: Type.Object({ job_id: Type.String({ description: "Cron job ID" }) }),
    async execute(_id: string, params: any) {
      const job = jobs.get(params.job_id);
      if (!job) return { isError: true, content: [{ type: "text" as const, text: `Job ${params.job_id} not found.` }], details: undefined };
      clearJob(job);
      return { content: [{ type: "text" as const, text: `✅ Cron job ${params.job_id} cancelled.` }], details: undefined };
    },
  });

  pi.on("session_shutdown", () => {
    shuttingDown = true;
    for (const job of Array.from(jobs.values())) clearJob(job);
  });
}
