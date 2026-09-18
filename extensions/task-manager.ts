/**
 * =============================================================================
 * Canvast — Task Manager / Canvast 源文件
 * =============================================================================
 * @file        extensions/task-manager.ts
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
/**
 * pi agent 扩展: Task Manager (任务管理)
 *
 * 使用方式: pi --extension extensions/task-manager.ts
 *
 * 任务状态保存在当前 runtime 目录，扩展重载时会恢复；不同 runtime 目录之间不共享。
 * Canvas 节点仍用于跨 runtime 的长期任务图谱。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  defaultRuntimeStatusDir,
  readRuntimeStatus,
  summarizeRuntimeInput,
  upsertRuntimeStatusItem,
} from "../src/harness/runtime-status.js";
import { registerDesktopActionTool } from "../src/desktop-action/tool-bridge.js";

interface Task {
  id: string;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "blocked" | "deleted";
  blockedBy: string[];
  blocks: string[];
  createdAt: string;
}

interface TaskManagerState {
  version: 1;
  nextId: number;
  tasks: Task[];
}

const TASK_MANAGER_STATE_FILE = "task-manager-state.json";
const TASK_MANAGER_STATE_VERSION = 1;
const TASK_STATUSES = new Set<Task["status"]>([
  "pending",
  "in_progress",
  "completed",
  "blocked",
  "deleted",
]);

const TASK_STATUS_SCHEMA = Type.Union([
  Type.Literal("pending"),
  Type.Literal("in_progress"),
  Type.Literal("completed"),
  Type.Literal("blocked"),
  Type.Literal("deleted"),
]);

function uniqueIds(ids: string[] | undefined): string[] {
  return Array.from(new Set((ids ?? []).map(id => id.trim()).filter(Boolean)));
}

function addUnique(ids: string[], id: string): void {
  if (!ids.includes(id)) ids.push(id);
}

function unfinishedBlockers(tasks: Map<string, Task>, task: Task): Array<{ id: string; status: Task["status"] | "missing" }> {
  return task.blockedBy
    .map(id => {
      const blocker = tasks.get(id);
      const status: Task["status"] | "missing" = blocker?.status ?? "missing";
      return { id, status };
    })
    .filter(blocker => blocker.status !== "completed");
}

function formatTask(t: Task): string {
  const statusIcons: Record<string, string> = {
    pending: "⏳", in_progress: "🔄", completed: "✅", blocked: "⛔", deleted: "❌",
  };
  return `${statusIcons[t.status]} **#${t.id}** [${t.status}] ${t.subject}\n   ${t.description}${t.blockedBy.length ? `\n   阻塞于: ${t.blockedBy.join(", ")}` : ""}${t.blocks.length ? `\n   阻塞: ${t.blocks.join(", ")}` : ""}`;
}

function runtimeDir(): string {
  return defaultRuntimeStatusDir();
}

function runtimeTaskId(id: string): string {
  return `task-${id}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalTaskId(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  for (const char of value) {
    if (char < "0" || char > "9") return false;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && String(parsed) === value;
}

function parseTask(value: unknown): Task | undefined {
  if (!isRecord(value) ||
      !isCanonicalTaskId(value.id) ||
      typeof value.subject !== "string" ||
      typeof value.description !== "string" ||
      typeof value.status !== "string" ||
      !TASK_STATUSES.has(value.status as Task["status"]) ||
      !Array.isArray(value.blockedBy) ||
      value.blockedBy.some(id => typeof id !== "string") ||
      !Array.isArray(value.blocks) ||
      value.blocks.some(id => typeof id !== "string") ||
      typeof value.createdAt !== "string") {
    return undefined;
  }
  return {
    id: value.id,
    subject: value.subject,
    description: value.description,
    status: value.status as Task["status"],
    blockedBy: uniqueIds(value.blockedBy as string[]),
    blocks: uniqueIds(value.blocks as string[]),
    createdAt: value.createdAt,
  };
}

function taskManagerStateFile(agentDir: string): string {
  return path.join(agentDir, TASK_MANAGER_STATE_FILE);
}

function readTaskManagerState(agentDir: string): TaskManagerState | undefined {
  const file = taskManagerStateFile(agentDir);
  if (!fs.existsSync(file)) return undefined;
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!isRecord(raw) ||
        raw.version !== TASK_MANAGER_STATE_VERSION ||
        !Array.isArray(raw.tasks)) {
      return undefined;
    }
    const parsedTasks = raw.tasks.map(parseTask);
    if (parsedTasks.some(task => task === undefined)) return undefined;
    const tasks = parsedTasks as Task[];
    if (new Set(tasks.map(task => task.id)).size !== tasks.length) return undefined;
    const maxTaskId = tasks.reduce((max, task) => Math.max(max, Number(task.id)), 0);
    const persistedNextId = Number(raw.nextId);
    const nextId = Number.isSafeInteger(persistedNextId) && persistedNextId > 0
      ? Math.max(persistedNextId, maxTaskId + 1)
      : maxTaskId + 1;
    return { version: 1, nextId, tasks };
  } catch {
    return undefined;
  }
}

function taskIdFromRuntimeId(runtimeId: string): string | undefined {
  const prefix = "task-";
  if (!runtimeId.startsWith(prefix)) return undefined;
  const id = runtimeId.slice(prefix.length);
  return isCanonicalTaskId(id) ? id : undefined;
}

function taskStatusFromRuntime(status: string): Task["status"] | undefined {
  if (status === "pending" ||
      status === "in_progress" ||
      status === "completed" ||
      status === "blocked") {
    return status;
  }
  return undefined;
}

function recoverTaskManagerState(agentDir: string): TaskManagerState {
  const tasks = new Map<string, Task>();
  let maxTaskId = 0;
  for (const item of readRuntimeStatus(agentDir).tasks) {
    const id = taskIdFromRuntimeId(item.id);
    if (!id) continue;
    maxTaskId = Math.max(maxTaskId, Number(id));
    const status = taskStatusFromRuntime(item.status);
    if (!status) continue;
    tasks.set(id, {
      id,
      subject: item.title,
      description: item.summary || "",
      status,
      blockedBy: [],
      blocks: [],
      createdAt: item.startedAt || item.updatedAt,
    });
  }
  return { version: 1, nextId: maxTaskId + 1, tasks: Array.from(tasks.values()) };
}

function loadTaskManagerState(agentDir: string): TaskManagerState {
  return readTaskManagerState(agentDir) || recoverTaskManagerState(agentDir);
}

function writeTaskManagerState(agentDir: string, tasks: Map<string, Task>, nextId: number): void {
  fs.mkdirSync(agentDir, { recursive: true });
  const target = taskManagerStateFile(agentDir);
  const temporary = `${target}.${process.pid}.${process.hrtime.bigint()}.tmp`;
  const snapshot: TaskManagerState = {
    version: 1,
    nextId,
    tasks: Array.from(tasks.values()),
  };
  try {
    fs.writeFileSync(temporary, JSON.stringify(snapshot, null, 2));
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function persistTask(task: Task): void {
  upsertRuntimeStatusItem(runtimeDir(), {
    plane: "tasks",
    item: {
      id: runtimeTaskId(task.id),
      title: task.subject,
      status: task.status === "deleted" ? "completed" : task.status,
      summary: summarizeRuntimeInput(task.description, 180),
      startedAt: task.status === "in_progress" ? task.createdAt : undefined,
      completedAt: task.status === "completed" || task.status === "deleted" ? new Date().toISOString() : undefined,
    },
  });
}

export default function (pi: ExtensionAPI) {
  const restored = loadTaskManagerState(runtimeDir());
  const tasks = new Map(restored.tasks.map(task => [task.id, task]));
  let nextId = restored.nextId;

  registerDesktopActionTool(pi, {
    name: "task_create",
    label: "Create Task",
    description: "创建一个新任务。用于跟踪复杂多步骤工作的进度。",
    parameters: Type.Object({
      subject: Type.String({ description: "任务标题" }),
      description: Type.String({ description: "任务详细描述" }),
      status: Type.Optional(TASK_STATUS_SCHEMA),
      blocked_by: Type.Optional(Type.Array(Type.String({ description: "阻塞此任务的任务ID" }))),
    }),
    async execute(_id, params): Promise<any> {
      const { subject, description, blocked_by } = params;
      const id = String(nextId);
      nextId += 1;
      const status = params.status || "pending";
      const task: Task = { id, subject, description, status, blockedBy: uniqueIds(blocked_by), blocks: [], createdAt: new Date().toISOString() };
      if (status === "in_progress" || status === "completed") {
        const blockers = unfinishedBlockers(tasks, task);
        if (blockers.length) {
          const blockerText = blockers.map(blocker => `#${blocker.id} [${blocker.status}]`).join(", ");
          writeTaskManagerState(runtimeDir(), tasks, nextId);
          return {
            isError: true,
            content: [{ type: "text" as const, text: `Cannot create task #${task.id} as ${status}: blocked by unfinished dependencies: ${blockerText}` }],
            details: { task_id: task.id, requested_status: status, unfinished_blockers: blockers },
          };
        }
      }
      tasks.set(id, task);
      for (const blockerId of task.blockedBy) {
        const blocker = tasks.get(blockerId);
        if (blocker) addUnique(blocker.blocks, id);
      }
      writeTaskManagerState(runtimeDir(), tasks, nextId);
      persistTask(task);
      return { content: [{ type: "text" as const, text: `✅ 任务已创建:\n${formatTask(task)}` }], details: { id, task } };
    },
  });

  registerDesktopActionTool(pi, {
    name: "task_update",
    label: "Update Task",
    description: "更新任务状态。状态: pending → in_progress → completed / blocked (或 deleted)",
    parameters: Type.Object({
      task_id: Type.String({ description: "任务ID" }),
      status: Type.Optional(TASK_STATUS_SCHEMA),
      subject: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      add_blocks: Type.Optional(Type.Array(Type.String())),
      add_blocked_by: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params): Promise<any> {
      const ownedRuntimeId = taskIdFromRuntimeId(params.task_id);
      const localTaskId = ownedRuntimeId && tasks.has(ownedRuntimeId)
        ? ownedRuntimeId
        : params.task_id;
      const task = tasks.get(localTaskId);
      if (!task) {
        const runtimeTasks = readRuntimeStatus(runtimeDir()).tasks;
        const runtimeTask = runtimeTasks.find(item => item.id === params.task_id) ||
          runtimeTasks.find(item => item.id === runtimeTaskId(params.task_id));
        if (!runtimeTask) {
          return { isError: true, content: [{ type: "text" as const, text: `任务 #${params.task_id} 不存在` }], details: undefined };
        }
        const runtimeId = runtimeTask.id;
        upsertRuntimeStatusItem(runtimeDir(), {
          plane: "tasks",
          item: {
            ...runtimeTask,
            title: params.subject || runtimeTask.title,
            status: params.status === "deleted" ? "completed" : (params.status || runtimeTask.status),
            summary: params.description ? summarizeRuntimeInput(params.description, 180) : runtimeTask.summary,
            completedAt: params.status === "completed" || params.status === "deleted"
              ? new Date().toISOString()
              : params.status
                ? undefined
                : runtimeTask.completedAt,
          },
        });
        return { content: [{ type: "text" as const, text: `📝 运行状态任务已更新:\n- [${params.status || runtimeTask.status}] ${params.subject || runtimeTask.title}` }], details: { task_id: runtimeId, status: params.status || runtimeTask.status } };
      }
      const candidateTasks = new Map(Array.from(tasks, ([id, value]) => [id, {
        ...value,
        blockedBy: [...value.blockedBy],
        blocks: [...value.blocks],
      }]));
      const candidateTask = candidateTasks.get(localTaskId)!;
      if (params.subject) candidateTask.subject = params.subject;
      if (params.description) candidateTask.description = params.description;
      if (params.add_blocks) {
        for (const bId of uniqueIds(params.add_blocks)) {
          addUnique(candidateTask.blocks, bId);
          const blocked = candidateTasks.get(bId);
          if (blocked) addUnique(blocked.blockedBy, candidateTask.id);
        }
      }
      if (params.add_blocked_by) {
        for (const bId of uniqueIds(params.add_blocked_by)) {
          addUnique(candidateTask.blockedBy, bId);
          const blocker = candidateTasks.get(bId);
          if (blocker) addUnique(blocker.blocks, candidateTask.id);
        }
      }
      if (params.status === "in_progress" || params.status === "completed") {
        const blockers = unfinishedBlockers(candidateTasks, candidateTask);
        if (blockers.length) {
          const blockerText = blockers.map(blocker => `#${blocker.id} [${blocker.status}]`).join(", ");
          return {
            isError: true,
            content: [{ type: "text" as const, text: `Cannot move task #${candidateTask.id} to ${params.status}: blocked by unfinished dependencies: ${blockerText}` }],
            details: { task_id: candidateTask.id, requested_status: params.status, unfinished_blockers: blockers },
          };
        }
      }
      if (params.status) candidateTask.status = params.status;
      tasks.clear();
      for (const [id, value] of candidateTasks) tasks.set(id, value);
      writeTaskManagerState(runtimeDir(), tasks, nextId);
      persistTask(candidateTask);
      return { content: [{ type: "text" as const, text: `📝 任务已更新:\n${formatTask(candidateTask)}` }], details: { task_id: candidateTask.id, status: candidateTask.status, task: candidateTask } };
    },
  });

  pi.registerTool({
    name: "task_list",
    label: "List Tasks",
    description: "列出所有任务",
    parameters: Type.Object({
      status_filter: Type.Optional(TASK_STATUS_SCHEMA),
    }),
    async execute(_id, params) {
      let all = Array.from(tasks.values());
      if (params.status_filter) all = all.filter(t => t.status === params.status_filter);
      if (all.length === 0) return { content: [{ type: "text" as const, text: "📋 无任务" }], details: undefined };
      const sorted = all.sort((a, b) => Number(a.id) - Number(b.id));
      const summary = `# 📋 任务列表\n| 待处理: ${sorted.filter(t => t.status === "pending").length} | 进行中: ${sorted.filter(t => t.status === "in_progress").length} | 已阻塞: ${sorted.filter(t => t.status === "blocked").length} | 已完成: ${sorted.filter(t => t.status === "completed").length} |\n|---|\n${sorted.map(formatTask).join("\n")}`;
      return { content: [{ type: "text" as const, text: summary }], details: undefined };
    },
  });

  pi.registerTool({
    name: "task_get",
    label: "Get Task",
    description: "获取单个任务详情",
    parameters: Type.Object({ task_id: Type.String({ description: "任务ID" }) }),
    async execute(_id, params) {
      const task = tasks.get(params.task_id);
      if (!task) return { isError: true, content: [{ type: "text" as const, text: `任务 #${params.task_id} 不存在` }], details: undefined };
      return { content: [{ type: "text" as const, text: `# 任务详情\n${formatTask(task)}\n创建: ${task.createdAt}` }], details: undefined };
    },
  });
}
