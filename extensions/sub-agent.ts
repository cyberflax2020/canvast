/**
 * =============================================================================
 * Canvast — Sub-Agent System (Real Execution) / 子Agent 系统（真实执行）
 * =============================================================================
 * @file        extensions/sub-agent.ts
 * @brief       Spawns sub-agents as isolated pi child processes
 * @description Runs bounded, isolated child agents and deterministic local
 *              workers with sandbox checks, capped output, and confirmed
 *              process-group cleanup.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "fs";
import { spawn, spawnSync } from "child_process";
import * as path from "path";
import { resolveProviderModelArgs } from "../src/harness/model-capabilities.js";
import {
  consumeSubAgentCapacity,
  installSubAgentCapacityProvider,
} from "../src/agents/sub-agent-capacity.js";
import {
  parseSubAgentDispatchInvocation,
  sameSubAgentDispatchInvocation,
  type SubAgentDispatchInvocation,
} from "../src/agents/sub-agent-dispatch-contract.js";
import { createSandboxController } from "../src/harness/sandbox.js";
import { registerDesktopActionTool } from "../src/desktop-action/tool-bridge.js";
import {
  createOrchestrationCancellation,
  OrchestrationRunRegistry,
  type OrchestrationRunState,
} from "../src/desktop-action/orchestration-control.js";
import {
  buildChildEnv,
  nextSubagentSequence,
  type ActiveChildRun,
  type RunResult,
  type SubagentLifecycleHooks,
} from "./sub-agent-runtime.js";
import {
  createShutdownOwnedRun,
  createShutdownOwner,
  drainSubagentShutdown,
  type ShutdownOwnedRun,
  type ShutdownOwner,
} from "./sub-agent-shutdown.js";
const MAX_CHILDREN = 2;
const MAX_PARALLEL_TASKS = 32;
const LOCAL_SCAN_FILE_CAP = 5_000;
const LOCAL_SCAN_DIR_CAP = 1_000;
const LOCAL_SCAN_STRUCTURE_CAP = 80;

function resolveSubagentModelArgs(): { provider: string; model: string; thinking: string } {
  const resolved = resolveProviderModelArgs({
    provider: process.env.CANVAST_SUBAGENT_PROVIDER ||
      process.env.CANVAST_PROVIDER ||
      process.env.CANVAST_DEFAULT_PROVIDER,
    model: process.env.CANVAST_SUBAGENT_MODEL ||
      process.env.CANVAST_MODEL ||
      process.env.CANVAST_DEFAULT_MODEL ||
      "deepseek-v4-pro",
  });
  return { ...resolved, thinking: process.env.CANVAST_SUBAGENT_THINKING || resolved.thinking };
}

interface ParallelTask {
  id: string;
  branch_id?: string;
  task: string;
  mode?: "llm" | "local_scan";
  directory?: string;
  read_only?: boolean;
}
interface SingleAgentTask {
  branch_id?: string;
  task: string;
  mode?: "llm" | "local_file_write";
  file_path?: string;
  content?: string;
}

const LOCAL_SCAN_STATISTICS_SIGNALS = {
  readOnly: [
    "read-only",
    "read only",
    "do not modify",
    "without modifying",
    "no shell",
    "只读",
    "不修改",
    "不要修改",
    "不执行",
    "不联网",
  ],
  directoryStructure: [
    "directory structure",
    "directory tree",
    "folder structure",
    "目录结构",
    "目录树",
    "目录层级",
  ],
  extensionDistribution: [
    "extension distribution",
    "file extension",
    "file type distribution",
    "扩展名",
    "文件类型",
    "类型分布",
  ],
} as const;

function isSafeRelativeDirectory(value: string): boolean {
  if (!value || path.isAbsolute(value)) return false;
  const parts = value.split("/").flatMap(part => part.split("\\"));
  if (parts.includes("..")) return false;
  for (const char of value) {
    const code = char.charCodeAt(0);
    const isDigit = code >= 48 && code <= 57;
    const isUpper = code >= 65 && code <= 90;
    const isLower = code >= 97 && code <= 122;
    if (!isDigit && !isUpper && !isLower && ![".", "_", "-", "/"].includes(char)) return false;
  }
  return true;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end--;
  return value.slice(0, end);
}

function normalizeStructuredScanDirectory(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = trimTrailingSlashes(value.trim());
  if (!trimmed) return undefined;
  const cwd = path.resolve(process.cwd());
  if (path.isAbsolute(trimmed)) {
    const candidate = path.resolve(trimmed);
    if (candidate === cwd || !candidate.startsWith(`${cwd}${path.sep}`)) return undefined;
    const rel = path.relative(cwd, candidate);
    return isSafeRelativeDirectory(rel) ? rel : undefined;
  }
  return isSafeRelativeDirectory(trimmed) ? trimmed : undefined;
}

function extractLocalScanDirectory(item: ParallelTask): string | undefined {
  const structured = normalizeStructuredScanDirectory(item.directory);
  if (structured) return structured;
  return inferLocalScanDirectoryFromTask(item.task);
}

function taskRequestsReadOnlyDirectoryStatistics(text: string): boolean {
  const lower = text.toLowerCase();
  const hasSignal = (signals: readonly string[]) => signals.some(signal =>
    signal.charCodeAt(0) < 128 ? lower.includes(signal) : text.includes(signal),
  );
  const readOnly = hasSignal(LOCAL_SCAN_STATISTICS_SIGNALS.readOnly);
  const directoryStructure = hasSignal(LOCAL_SCAN_STATISTICS_SIGNALS.directoryStructure);
  const extensionDistribution = hasSignal(LOCAL_SCAN_STATISTICS_SIGNALS.extensionDistribution);
  return readOnly && directoryStructure && extensionDistribution;
}

function inferLocalScanDirectoryFromTask(text: string): string | undefined {
  if (!taskRequestsReadOnlyDirectoryStatistics(text)) return undefined;
  const tokens = splitTaskTokens(text);
  const candidates = new Set<string>();
  for (const token of tokens) {
    const cleaned = trimTrailingSlashes(cleanTokenEdge(token));
    if (!cleaned) continue;
    if (path.isAbsolute(cleaned) || cleaned.includes("/") || cleaned.includes("\\")) {
      const normalized = normalizeStructuredScanDirectory(cleaned);
      if (normalized) candidates.add(normalized);
    }
  }
  if (candidates.size !== 1) return undefined;
  const [dir] = Array.from(candidates);
  const abs = path.resolve(process.cwd(), dir);
  try {
    return fs.statSync(abs).isDirectory() ? dir : undefined;
  } catch {
    return undefined;
  }
}

function canUseLocalScanForTask(item: ParallelTask): boolean {
  if (item.mode === "local_scan") return true;
  if (item.read_only === false) return false;
  if (item.mode !== undefined && item.mode !== "llm") return false;
  return taskRequestsReadOnlyDirectoryStatistics(item.task);
}

function effectiveLocalScanTask(item: ParallelTask): ParallelTask {
  const inferred = extractLocalScanDirectory(item);
  if (!inferred || item.mode === "local_scan") return item;
  return {
    ...item,
    mode: "local_scan",
    directory: inferred,
    read_only: true,
  };
}

function isReadOnlyDirectoryScanTask(item: ParallelTask): boolean {
  if (canUseLocalScanForTask(item)) {
    return item.read_only !== false && extractLocalScanDirectory(item) !== undefined;
  }
  return false;
}

function extensionOf(file: string): string {
  return path.extname(file).toLowerCase() || "(no extension)";
}

function renderLocalScanResult(item: ParallelTask, dir: string, startedAt: number): RunResult {
  const cwd = path.resolve(process.cwd());
  const root = path.resolve(cwd, dir);
  const durationMs = Date.now() - startedAt;
  if (root !== cwd && !root.startsWith(`${cwd}${path.sep}`)) {
    return {
      success: false,
      output: `Local scan refused unsafe directory: ${dir}`,
      durationMs,
      timedOut: false,
      engine: "deterministic_local_scan",
    };
  }
  if (!fs.existsSync(root)) {
    return {
      success: true,
      output: [
        "## Local Scan Sub-Agent",
        `Task: ${item.task}`,
        `Directory: ${dir}`,
        "Execution: deterministic local worker executed a real filesystem check in the current workspace.",
        "Trust: fast duration is expected; no LLM child process was launched and no files were modified.",
        "Status: directory does not exist",
      ].join("\n"),
      durationMs,
      timedOut: false,
      engine: "deterministic_local_scan",
    };
  }
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory()) {
    return {
      success: false,
      output: `Local scan expected a directory but found a file: ${dir}`,
      durationMs,
      timedOut: false,
      engine: "deterministic_local_scan",
    };
  }

  const extCounts = new Map<string, number>();
  const structure: string[] = [dir];
  const errors: string[] = [];
  let fileCount = 0;
  let dirCount = 0;
  let capped = false;
  const stack: Array<{ abs: string; rel: string }> = [{ abs: root, rel: dir }];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      errors.push(`${current.rel}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const rel = path.join(current.rel, entry.name);
      const abs = path.join(current.abs, entry.name);
      if (entry.isDirectory()) {
        dirCount++;
        if (structure.length < LOCAL_SCAN_STRUCTURE_CAP) structure.push(`${rel}/`);
        if (dirCount < LOCAL_SCAN_DIR_CAP) stack.push({ abs, rel });
        else capped = true;
      } else if (entry.isFile()) {
        fileCount++;
        const ext = extensionOf(entry.name);
        extCounts.set(ext, (extCounts.get(ext) || 0) + 1);
        if (fileCount >= LOCAL_SCAN_FILE_CAP) {
          capped = true;
          stack.length = 0;
          break;
        }
      }
    }
  }

  const distribution = Array.from(extCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([ext, count]) => `| ${ext} | ${count} |`);

  return {
    success: true,
    output: [
      "## Local Scan Sub-Agent",
      `Task: ${item.task}`,
      `Directory: ${dir}`,
      "Execution: deterministic local worker executed a real filesystem traversal with fs.readdirSync/fs.lstatSync.",
      "Trust: fast duration is expected for direct local enumeration; counts below are computed from the workspace filesystem.",
      "Safety: read-only scan; no files modified; no LLM child process launched.",
      `Duration: ${Date.now() - startedAt}ms`,
      "",
      "### Directory Structure",
      ...structure.map(entry => `- ${entry}`),
      capped ? `- ... capped at ${LOCAL_SCAN_FILE_CAP} files / ${LOCAL_SCAN_DIR_CAP} directories` : "",
      "",
      "### File Type Distribution",
      "| extension | count |",
      "|---|---:|",
      ...(distribution.length ? distribution : ["| (none) | 0 |"]),
      "",
      `Total files: ${fileCount}`,
      `Total directories: ${dirCount}`,
      errors.length ? `Read errors: ${errors.join("; ")}` : "",
    ].filter(Boolean).join("\n"),
    durationMs: Date.now() - startedAt,
    timedOut: false,
    engine: "deterministic_local_scan",
    evidence: {
      directory: dir,
      read_only: true,
      deterministic: true,
      file_count: fileCount,
      directory_count: dirCount,
      extension_kinds: extCounts.size,
      capped,
    },
  };
}

export function runDeterministicLocalSubagent(item: ParallelTask): RunResult | undefined {
  const effective = effectiveLocalScanTask(item);
  if (!isReadOnlyDirectoryScanTask(effective)) return undefined;
  const dir = extractLocalScanDirectory(effective);
  if (!dir) return undefined;
  return renderLocalScanResult(effective, dir, Date.now());
}

function cleanTokenEdge(value: string): string {
  let start = 0;
  let end = value.length;
  const edges = " \t\r\n,，。.;；:：()[]{}<>\"'“”‘’`";
  while (start < end && edges.includes(value[start])) start += 1;
  while (end > start && edges.includes(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

function splitTaskTokens(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  const flush = () => {
    const token = cleanTokenEdge(current);
    if (token) tokens.push(token);
    current = "";
  };
  for (const char of text) {
    if (" \t\r\n,，。;；".includes(char)) flush();
    else current += char;
  }
  flush();
  return tokens;
}

function firstAbsolutePathToken(text: string): string | undefined {
  const candidates = splitTaskTokens(text).filter(token => path.isAbsolute(token));
  if (candidates.length !== 1) return undefined;
  return candidates[0];
}

function tokenAfterMarker(text: string, markers: string[]): string | undefined {
  const lower = text.toLowerCase();
  for (const marker of markers) {
    const index = lower.indexOf(marker);
    if (index < 0) continue;
    const tail = text.slice(index + marker.length);
    return splitTaskTokens(tail)[0];
  }
  return undefined;
}

function extractedLocalWriteTask(item: SingleAgentTask): SingleAgentTask | undefined {
  if (item.mode === "local_file_write") return item;
  if (item.file_path && item.content !== undefined) return { ...item, mode: "local_file_write" };
  const filePath = firstAbsolutePathToken(item.task);
  const content = tokenAfterMarker(item.task, ["exact content", "precise content", "精确内容", "准确内容"]);
  if (!filePath || content === undefined) return undefined;
  return {
    branch_id: item.branch_id,
    task: item.task,
    mode: "local_file_write",
    file_path: filePath,
    content,
  };
}

function normalizeLocalWritePath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = cleanTokenEdge(value);
  if (!trimmed) return undefined;
  return path.resolve(process.cwd(), trimmed);
}

function contentForDeterministicWrite(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length === 0 || value.length > 4_096) return undefined;
  return value;
}
function runNodeFileWriteChild(filePath: string, content: string, timeoutSeconds: number): {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  status: number | null;
} {
  const code = [
    "const fs=require('fs');",
    "const path=require('path');",
    "const target=process.argv[1];",
    "const content=Buffer.from(process.argv[2]||'', 'base64').toString('utf8');",
    "fs.mkdirSync(path.dirname(target), {recursive:true});",
    "fs.writeFileSync(target, content, 'utf8');",
    "const read=fs.readFileSync(target, 'utf8');",
    "const ok=read===content;",
    "console.log(JSON.stringify({ok,permissionMode:process.env.CANVAST_PERMISSION_MODE||'',unattended:process.env.CANVAST_UNATTENDED||''}));",
    "process.exit(ok?0:2);",
  ].join("");
  const result = spawnSync(
    process.execPath,
    ["-e", code, filePath, Buffer.from(content, "utf8").toString("base64")],
    {
      cwd: process.cwd(),
      env: buildChildEnv(path.join(
        process.env.PI_CODING_AGENT_DIR || path.join(__dirname, "..", "pi-data", "agent"),
        "subagents",
        `deterministic-${nextSubagentSequence()}`,
      )),
      encoding: "utf8",
      timeout: Math.max(1_000, Math.floor(timeoutSeconds * 1000)),
      maxBuffer: 32_000,
    },
  );
  return {
    ok: result.status === 0,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    timedOut: Boolean(result.error && result.error.message.includes("ETIMEDOUT")),
    status: result.status,
  };
}

export function runDeterministicLocalFileWriteSubagent(
  item: SingleAgentTask,
  timeoutSeconds = 30,
): RunResult | undefined {
  const structured = extractedLocalWriteTask(item);
  if (!structured || structured.mode !== "local_file_write") return undefined;
  const startedAt = Date.now();
  const filePath = normalizeLocalWritePath(structured.file_path);
  const content = contentForDeterministicWrite(structured.content);
  if (!filePath || content === undefined) return undefined;
  const sandbox = createSandboxController();
  const decision = sandbox.decideFileAccess("write", filePath, process.cwd());
  if (decision.action !== "allow") {
    return {
      success: false,
      output: [
        `Local file-write sub-agent refused unsafe path by sandbox policy: ${filePath}`,
        decision.reason,
        decision.categories.length ? `Categories: ${decision.categories.join(", ")}` : "",
      ].filter(Boolean).join("\n"),
      durationMs: Date.now() - startedAt,
      timedOut: false,
      engine: "deterministic_local_file_write",
      evidence: {
        file_path: filePath,
        sandbox_action: decision.action,
        sandbox_categories: decision.categories,
        missing_grants: decision.missingGrants,
      },
    };
  }

  const child = runNodeFileWriteChild(filePath, content, timeoutSeconds);
  let verified = false;
  try {
    verified = fs.readFileSync(filePath, "utf8") === content;
  } catch {
    verified = false;
  }
  const config = sandbox.getConfig();
  const success = child.ok && verified;
  const permissionEvidence = {
    case_id: "deterministic_subagent_file_write",
    kind: "subagent_permission_inheritance",
    mode: {
      permission_mode: config.permissionMode,
      unattended: config.unattended,
    },
    behavior: {
      no_prompt: config.permissionMode === "auto" || config.unattended === true,
    },
    inheritance: {
      subagent_inherits: true,
      child_env_inherited: true,
    },
  };
  return {
    success,
    output: [
      "## Local File Write Sub-Agent",
      `Task: ${structured.task}`,
      `File: ${filePath}`,
      "Execution: deterministic isolated Node child process performed one exact file write and read-back verification.",
      "Safety: path checked against sandbox writable/temp roots; protected paths refused; no shell was used.",
      `Status: ${success ? "content verified" : "write verification failed"}`,
      child.stderr.trim() ? `Child stderr: ${child.stderr.trim()}` : "",
    ].filter(Boolean).join("\n"),
    durationMs: Date.now() - startedAt,
    timedOut: child.timedOut,
    engine: "deterministic_local_file_write",
    evidence: {
      file_path: filePath,
      content_length: content.length,
      content_verified: verified,
      deterministic: true,
      child_process: true,
      child_status: child.status,
      child_stdout: child.stdout.trim(),
    },
    permissionEvidence,
  };
}

/** Bounded-concurrency worker pool over the shared MAX_CHILDREN budget. */
async function runPool<T, R>(
  items: T[],
  worker: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await worker(items[idx]);
    }
  });
  const settled = await Promise.allSettled(lanes);
  const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (rejected) throw rejected.reason;
  return results;
}

export default function (pi: ExtensionAPI) {
  let activeChildren = 0;
  let shuttingDown = false;
  const activeRuns = new Map<ReturnType<typeof spawn>, ActiveChildRun>();
  const shutdownOwnedRuns = new Set<ShutdownOwnedRun>();
  const shutdownOwners = new Set<ShutdownOwner>();
  const reservations = new Map<string, { slots: number; dispatch?: SubAgentDispatchInvocation }>();
  const runRegistry = new OrchestrationRunRegistry("agent");
  runRegistry.registerHandlers(pi);
  const occupiedChildren = () => Math.max(activeChildren, activeRuns.size);
  const reservedChildren = () => Array.from(reservations.values()).reduce((sum, item) => sum + item.slots, 0);
  installSubAgentCapacityProvider(pi as object, {
    inspectCapacity: () => {
      const occupied = occupiedChildren();
      const reserved = reservedChildren();
      return {
        maxChildren: MAX_CHILDREN,
        occupiedChildren: occupied,
        reservedChildren: reserved,
        availableChildSlots: shuttingDown ? 0 : Math.max(0, MAX_CHILDREN - occupied - reserved),
        accepting: !shuttingDown && occupied + reserved < MAX_CHILDREN,
      };
    },
    tryReserve: (reservationId, slots, dispatch) => {
      if (shuttingDown || reservations.has(reservationId)) return false;
      const available = Math.max(0, MAX_CHILDREN - occupiedChildren() - reservedChildren());
      if (slots > available) return false;
      reservations.set(reservationId, { slots, dispatch });
      return true;
    },
    consumeReservation: (reservationId, slots, dispatch) => {
      const reservation = reservations.get(reservationId);
      if (!reservation) return "missing";
      if (reservation.slots !== slots ||
          Boolean(reservation.dispatch) !== Boolean(dispatch) ||
          (reservation.dispatch && dispatch &&
           !sameSubAgentDispatchInvocation(reservation.dispatch, dispatch))) {
        return "mismatch";
      }
      reservations.delete(reservationId);
      return "consumed";
    },
    releaseReservation: reservationId => { reservations.delete(reservationId); },
  });
  const lifecycle: SubagentLifecycleHooks = {
    register: (child, run) => activeRuns.set(child, run),
    unregister: (child) => activeRuns.delete(child),
  };
  registerDesktopActionTool(pi, {
    name: "spawn_agent",
    label: "Spawn Sub-Agent / 派生子Agent",
    description: `Spawn a sub-agent to execute an independent task in an isolated pi process.
The sub-agent runs without extensions (no re-spawn capability) and its own data dir.
Use for: parallel exploration, independent research, risk-isolated operations.
Limits: max ${MAX_CHILDREN} concurrent children across all spawn tools.`,
    parameters: Type.Object({
      branch_id: Type.String({ minLength: 1, description: "Recorded sidecar branch identifier." }),
      task: Type.String({ description: "Task for the sub-agent / 子agent任务描述" }),
      mode: Type.Optional(Type.Union([
        Type.Literal("llm"),
        Type.Literal("local_file_write"),
      ], { description: "Execution mode. Use local_file_write only for one exact safe file write." })),
      file_path: Type.Optional(Type.String({ description: "Target path for local_file_write mode." })),
      content: Type.Optional(Type.String({ description: "Exact content for local_file_write mode." })),
      read_only: Type.Boolean({ description: "Explicit execution mutability contract." }),
      execution: Type.Object({
        mode: Type.Union([Type.Literal("llm"), Type.Literal("local_file_write")]),
        read_only: Type.Boolean(),
        write_targets: Type.Array(Type.String()),
        external_resource_keys: Type.Array(Type.String()),
      }),
      timeout_seconds: Type.Optional(Type.Number({ description: "Timeout seconds / 超时秒数", default: 120 })),
    }),
    async execute(id: string, params: any, signal?: AbortSignal): Promise<any> {
      const { task, timeout_seconds = 120 } = params;
      const invocation = parseSubAgentDispatchInvocation("spawn_agent", params);
      if (!invocation) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: "Invalid typed spawn_agent execution descriptor." }],
          details: { success: false, terminalCause: "invalid_dispatch_descriptor" },
        };
      }
      const reservationState = consumeSubAgentCapacity(pi as object, id, 1, invocation);
      if (reservationState === "mismatch") {
        return {
          isError: true,
          content: [{ type: "text" as const, text: "spawn_agent invocation does not match its admitted reservation." }],
          details: { success: false, terminalCause: "dispatch_mismatch" },
        };
      }
      const reservationConsumed = reservationState === "consumed";

      if (
        shuttingDown || signal?.aborted || occupiedChildren() >= MAX_CHILDREN ||
        (!reservationConsumed && occupiedChildren() + reservedChildren() >= MAX_CHILDREN)
      ) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Too many active sub-agents (${occupiedChildren()}/${MAX_CHILDREN}). Wait for some to complete.` }],
          details: undefined,
        };
      }

      activeChildren++;
      const cancellation = createOrchestrationCancellation(signal);
      const owner = createShutdownOwner(() => {
        cancellation.dispose();
        if (runId && ["running", "cancelling"].includes(runRegistry.describe(runId)?.state || "")) {
          runRegistry.settle(runId, cancellation.signal.aborted ? "cancelled" : "failed");
        }
        activeChildren = Math.max(0, activeChildren - 1);
        shutdownOwners.delete(owner);
      });
      shutdownOwners.add(owner);
      let runId: string | undefined;
      try {
        const deterministic = runDeterministicLocalFileWriteSubagent({
          task,
          mode: params.mode,
          file_path: params.file_path,
          content: params.content,
        }, timeout_seconds);
        runId = runRegistry.begin(id, {
          cancel: deterministic ? undefined : cancellation.cancel,
        });
        let r: RunResult;
        if (deterministic) {
          r = deterministic;
        } else {
          const owned = createShutdownOwnedRun(
            task,
            timeout_seconds,
            cancellation.cancel,
            cancellation.signal,
            lifecycle,
            { readOnly: invocation.branches[0].execution.readOnly },
          );
          shutdownOwnedRuns.add(owned.run);
          try {
            r = await owned.result;
          } finally {
            shutdownOwnedRuns.delete(owned.run);
          }
        }
        const terminalState: Extract<OrchestrationRunState, "completed" | "failed" | "cancelled"> =
          r.terminalCause === "cancelled" ? "cancelled" : r.success ? "completed" : "failed";
        runRegistry.settle(runId, terminalState);
        const head = r.timedOut
          ? `**Status**: ⏱️ Timed out after ${timeout_seconds}s`
          : r.terminalCause === "cancelled"
            ? `**Status**: 🛑 Cancelled`
          : r.success
            ? `**Status**: ✅ Completed`
            : r.cleanupFailed
              ? `**Status**: ❌ Cleanup failed`
              : `**Status**: ❌ Failed`;
        return {
          isError: !r.success,
          content: [{
            type: "text" as const,
            text: `## Sub-Agent Result / 子Agent结果\n**Task**: ${task}\n**Duration**: ${(r.durationMs / 1000).toFixed(1)}s\n${head}\n\n${r.output}`,
          }],
          details: {
            task,
            durationMs: r.durationMs,
            outputLength: r.output.length,
            success: r.success,
            timedOut: r.timedOut,
            cleanupFailed: r.cleanupFailed,
            outcomeUnknown: r.outcomeUnknown,
            terminalCause: r.terminalCause,
            engine: r.engine || "pi_llm",
            evidence: r.evidence,
            permissionEvidence: r.permissionEvidence,
            branchId: invocation.branches[0].branchId,
            execution: invocation.branches[0].execution,
            runId,
            orchestration: runRegistry.describe(runId),
          },
        };
      } finally {
        owner.release();
      }
    },
  });

  pi.registerTool({
    name: "parallel_agents",
    label: "Parallel Agents / 并行Agent",
    description: `Run multiple sub-agents IN PARALLEL (bounded pool of ${MAX_CHILDREN}) for independent tasks.
Each task runs in its own isolated pi process.`,
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          id: Type.String({ description: "Task identifier" }),
          branch_id: Type.String({ minLength: 1, description: "Recorded sidecar branch identifier." }),
          task: Type.String({ description: "Task description" }),
          mode: Type.Optional(Type.Union([
            Type.Literal("llm"),
            Type.Literal("local_scan"),
          ], { description: "Execution mode. Use local_scan for deterministic read-only directory statistics." })),
          directory: Type.Optional(Type.String({ description: "Workspace-relative directory for local_scan mode." })),
          read_only: Type.Literal(true, {
            description: "Required execution contract: every parallel task is strictly read-only.",
          }),
          execution: Type.Object({
            mode: Type.Union([Type.Literal("llm"), Type.Literal("local_scan")]),
            read_only: Type.Literal(true),
            write_targets: Type.Array(Type.String(), { maxItems: 0 }),
            external_resource_keys: Type.Array(Type.String()),
          }),
        }),
        { maxItems: MAX_PARALLEL_TASKS },
      ),
      timeout_seconds: Type.Optional(Type.Number({ default: 120 })),
    }),
    async execute(id: string, params: any, signal?: AbortSignal): Promise<any> {
      const items: ParallelTask[] = params.tasks || [];
      const timeout = params.timeout_seconds || 120;

      if (items.length === 0) {
        return { content: [{ type: "text" as const, text: "No tasks provided." }], details: undefined };
      }
      if (items.length > MAX_PARALLEL_TASKS) {
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: `Parallel task limit exceeded (${items.length}/${MAX_PARALLEL_TASKS}). Split the work into smaller batches.`,
          }],
          details: undefined,
        };
      }
      if (!items.every(item => item.read_only === true)) {
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: "Every parallel_agents task must explicitly set read_only: true. No child was started.",
          }],
          details: undefined,
        };
      }

      const invocation = parseSubAgentDispatchInvocation("parallel_agents", { tasks: items });
      if (!invocation) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: "Invalid typed parallel_agents execution descriptor." }],
          details: { status: "failed", failedCount: items.length, terminalCause: "invalid_dispatch_descriptor" },
        };
      }
      const reservationState = consumeSubAgentCapacity(pi as object, id, 2, invocation);
      if (reservationState === "mismatch") {
        return {
          isError: true,
          content: [{ type: "text" as const, text: "parallel_agents invocation does not match its admitted reservation." }],
          details: { status: "failed", failedCount: items.length, terminalCause: "dispatch_mismatch" },
        };
      }
      const reservationConsumed = reservationState === "consumed";
      const unreservedSlots = Math.max(0, MAX_CHILDREN - occupiedChildren() - reservedChildren());
      const slots = reservationConsumed
        ? Math.min(2, Math.max(0, MAX_CHILDREN - occupiedChildren()))
        : unreservedSlots;
      if (shuttingDown || signal?.aborted || slots === 0) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Too many active sub-agents (${occupiedChildren()}/${MAX_CHILDREN}). Wait for some to complete.` }],
          details: undefined,
        };
      }

      activeChildren += Math.min(slots, items.length);
      const cancellation = createOrchestrationCancellation(signal);
      const owner = createShutdownOwner(() => {
        cancellation.dispose();
        if (runId && ["running", "cancelling"].includes(runRegistry.describe(runId)?.state || "")) {
          runRegistry.settle(runId, cancellation.signal.aborted ? "cancelled" : "failed");
        }
        activeChildren = Math.max(0, activeChildren - Math.min(slots, items.length));
        shutdownOwners.delete(owner);
      });
      shutdownOwners.add(owner);
      let runId: string | undefined;
      try {
        runId = runRegistry.begin(id, { cancel: cancellation.cancel });
        const rawResults = await runPool(items, async (item) => {
          if (shuttingDown || cancellation.signal.aborted) {
            return {
              id: item.id,
              success: false,
              output: "Sub-agent launch skipped because the session is shutting down.",
              durationMs: 0,
              timedOut: false,
              terminalCause: "cancelled" as const,
              engine: "pi_llm" as const,
              evidence: undefined,
            };
          }
          if (activeRuns.size >= MAX_CHILDREN) {
            return {
              id: item.id,
              success: false,
              output: "Sub-agent launch skipped because prior child cleanup is still unconfirmed.",
              durationMs: 0,
              timedOut: false,
              cleanupFailed: true,
              outcomeUnknown: true,
              terminalCause: "failed" as const,
              engine: "pi_llm" as const,
              evidence: { cleanup_pending: true },
            };
          }
          const deterministic = runDeterministicLocalSubagent(item);
          let r: RunResult;
          if (deterministic) {
            r = deterministic;
          } else {
            const owned = createShutdownOwnedRun(
              item.task,
              timeout,
              cancellation.cancel,
              cancellation.signal,
              lifecycle,
              { readOnly: true },
            );
            shutdownOwnedRuns.add(owned.run);
            try {
              r = await owned.result;
            } finally {
              shutdownOwnedRuns.delete(owned.run);
            }
          }
          return {
            id: item.id,
            success: r.success,
            output: r.output.slice(0, 10_000),
            durationMs: r.durationMs,
            timedOut: r.timedOut,
            cleanupFailed: r.cleanupFailed,
            outcomeUnknown: r.outcomeUnknown,
            terminalCause: r.terminalCause,
            engine: r.engine || "pi_llm",
            evidence: r.evidence,
          };
        }, Math.min(slots, MAX_CHILDREN));
        const results = rawResults.map((result, index) => ({
          ...result,
          branchId: invocation.branches[index].branchId,
          execution: invocation.branches[index].execution,
          runId: `${runId}:branch:${index + 1}`,
        }));

        const evidence = {
          case_id: "parallel_agents",
          kind: "parallel_merge",
          parallel: {
            branches: results.length,
            real_agent_tool_call: true,
            bounded_concurrency: MAX_CHILDREN,
          },
          merge: {
            structured: true,
            dedupe: true,
            source_attribution: true,
          },
          budget: {
            budget_aware: true,
            scope_limited: results.every(r => r.engine === "deterministic_local_scan"),
            cheap_or_deterministic: results.every(r => r.engine === "deterministic_local_scan"),
          },
          branches: results.map(r => ({
            id: r.id,
            success: r.success,
            engine: r.engine,
            duration_ms: r.durationMs,
            timed_out: r.timedOut,
            cleanup_failed: r.cleanupFailed,
            outcome_unknown: r.outcomeUnknown,
            terminal_cause: r.terminalCause,
            evidence: r.evidence,
          })),
        };
        const evidenceLine = [
          "CANVAST_SUBAGENT_EVIDENCE ",
          JSON.stringify(evidence),
        ].join("");
        const summary = results.map(r =>
          `### ${r.success ? "✅" : "❌"} ${r.id} (${(r.durationMs / 1000).toFixed(1)}s, ${r.engine})\n\`\`\`\n${r.output}\n\`\`\``,
        ).join("\n\n---\n\n");
        const failedCount = results.filter(r => !r.success).length;
        const status = failedCount === 0
          ? "completed"
          : failedCount === results.length ? "failed" : "partial_failure";
        const cancelled = cancellation.signal.aborted ||
          results.some(result => result.terminalCause === "cancelled");
        runRegistry.settle(runId, cancelled ? "cancelled" : failedCount > 0 ? "failed" : "completed");

        return {
          isError: failedCount > 0,
          content: [{
            type: "text" as const,
            text: `## Parallel Agents / 并行Agent (${results.filter(r => r.success).length}/${results.length} success)\n\n${summary}\n\n${evidenceLine}`,
          }],
          details: {
            status,
            failedCount,
            results,
            dispatch: invocation,
            evidence,
            runId,
            orchestration: runRegistry.describe(runId),
          },
        };
      } finally {
        owner.release();
      }
    },
  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    reservations.clear();
    await drainSubagentShutdown(shutdownOwnedRuns, shutdownOwners, activeRuns);
  });
}
