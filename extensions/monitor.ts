/**
 * =============================================================================
 * Canvast — Monitor / 事件监控
 * =============================================================================
 * @file        extensions/monitor.ts
 * @brief       Watch files/commands and publish observable change events
 * @description Watches files or polls sandbox-approved commands, delivers
 *              visible change events, and owns every resource until stop or
 *              session shutdown.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * Changes: [2026-08-08] Initial implementation
 *          [2026-08-25] Sandboxed polling, observable events, full cleanup
 * =============================================================================
 */

import {
  createLocalBashOperations,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { watch, type FSWatcher } from "fs";
import path from "node:path";

import { redactCredentialText } from "../src/harness/credential-redaction.js";
import {
  createSandboxController,
  type SandboxDecision,
  type SandboxGrantScope,
} from "../src/harness/sandbox.js";

const DEFAULT_INTERVAL_MS = 5_000;
const MIN_INTERVAL_MS = 250;
const MAX_INTERVAL_MS = 86_400_000;
const COMMAND_TIMEOUT_SECONDS = 10;
const MAX_EVENT_OUTPUT_CHARS = 4_000;

interface MonitorBase {
  id: string;
  active: boolean;
  target: string;
}

interface FileMonitor extends MonitorBase {
  type: "file";
  watcher: FSWatcher;
}

interface CommandMonitor extends MonitorBase {
  type: "command";
  command: string;
  cwd: string;
  intervalMs: number;
  timer?: ReturnType<typeof setTimeout>;
  abortController?: AbortController;
  pollPromise?: Promise<void>;
  lastSnapshot?: string;
}

type Monitor = FileMonitor | CommandMonitor;

function decisionSummary(decision: SandboxDecision): string {
  return [
    decision.reason,
    decision.categories.length ? `Categories: ${decision.categories.join(", ")}` : "",
    decision.missingGrants.length
      ? `Required grants: ${decision.missingGrants.map(grant => `${grant.kind}:${grant.value}`).join(", ")}`
      : "",
  ].filter(Boolean).join("\n");
}

function persistentGrantScope(choice: string | undefined): SandboxGrantScope | undefined {
  if (choice === "Allow for session") return "session";
  if (choice === "Allow for project") return "project";
  return undefined;
}

function intervalFrom(value: unknown): number | undefined {
  if (value === undefined) return DEFAULT_INTERVAL_MS;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  if (normalized < MIN_INTERVAL_MS || normalized > MAX_INTERVAL_MS) return undefined;
  return normalized;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function monitorCommandEnv(
  sandbox: ReturnType<typeof createSandboxController>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.DEEPSEEK_API_KEY;
  return sandbox.dependencyInstallEnv(env);
}

export default function (pi: ExtensionAPI) {
  const monitors = new Map<string, Monitor>();
  const sandbox = createSandboxController();
  const localOps = createLocalBashOperations();
  let monitorSeq = 0;
  let shuttingDown = false;

  const publish = (monitor: Monitor, event: string, summary: string): void => {
    if (!monitor.active || shuttingDown || monitors.get(monitor.id) !== monitor) return;
    const safeSummary = redactCredentialText(summary).slice(-MAX_EVENT_OUTPUT_CHARS);
    try {
      pi.sendMessage({
        customType: "canvast-monitor-event",
        content: `Monitor ${monitor.id} detected ${event}:\n${safeSummary}`,
        display: true,
        details: { monitorId: monitor.id, type: monitor.type, target: monitor.target, event },
      }, { triggerTurn: false });
    } catch {
      // Notification delivery is best-effort; monitor ownership remains intact.
      // 通知投递为尽力而为；监控资源仍由当前扩展持有。
    }
  };

  const stopMonitor = async (monitor: Monitor): Promise<void> => {
    if (!monitor.active) return;
    monitor.active = false;
    monitors.delete(monitor.id);
    if (monitor.type === "file") {
      try { monitor.watcher.close(); } catch { /* already closed / 已关闭 */ }
      return;
    }
    if (monitor.timer) clearTimeout(monitor.timer);
    monitor.timer = undefined;
    monitor.abortController?.abort();
    monitor.abortController = undefined;
    if (monitor.pollPromise) await monitor.pollPromise.catch(() => {});
  };

  const authorize = async (
    decision: SandboxDecision,
    ctx: any,
  ): Promise<{ allowed: true } | { allowed: false; reason: string }> => {
    if (decision.action === "allow") return { allowed: true };
    if (decision.action === "block") {
      return { allowed: false, reason: decisionSummary(decision) };
    }

    let scope: SandboxGrantScope | undefined;
    if (sandbox.permissionMode() === "auto") {
      const resolution = sandbox.resolveAutoDecision(decision);
      if (resolution.action === "block" || !resolution.scope) {
        return { allowed: false, reason: `${resolution.reason}\n${decisionSummary(decision)}` };
      }
      scope = resolution.scope;
    } else if (!sandbox.isUnattended() && ctx?.hasUI) {
      const choice = await ctx.ui.select(
        `Persistent monitor permission\n\n${decisionSummary(decision)}`,
        ["Deny", "Allow for session", "Allow for project"],
        { timeout: 30_000 },
      );
      scope = persistentGrantScope(choice);
    }

    if (!scope) {
      return { allowed: false, reason: `Sandbox permission is required for this persistent monitor.\n${decisionSummary(decision)}` };
    }
    sandbox.rememberApproval(decision, scope, "Approved for persistent monitor.");
    return { allowed: true };
  };

  const scheduleCommandPoll = (monitor: CommandMonitor, delayMs: number): void => {
    if (!monitor.active || shuttingDown) return;
    monitor.timer = setTimeout(() => {
      monitor.timer = undefined;
      const pollPromise = pollCommand(monitor);
      monitor.pollPromise = pollPromise;
      void pollPromise.finally(() => {
        if (monitor.pollPromise === pollPromise) monitor.pollPromise = undefined;
      });
    }, delayMs);
    monitor.timer.unref?.();
  };

  const pollCommand = async (monitor: CommandMonitor): Promise<void> => {
    if (!monitor.active || shuttingDown || monitors.get(monitor.id) !== monitor) return;
    const controller = new AbortController();
    monitor.abortController = controller;
    let snapshot: string;
    let failed = false;
    try {
      const wrapped = sandbox.buildSandboxedCommand(monitor.command, monitor.cwd);
      let output = "";
      const result = await localOps.exec(wrapped.command, monitor.cwd, {
        onData: data => { output = `${output}${data.toString("utf-8")}`.slice(-MAX_EVENT_OUTPUT_CHARS); },
        timeout: COMMAND_TIMEOUT_SECONDS,
        signal: controller.signal,
        env: monitorCommandEnv(sandbox),
      });
      sandbox.markCommandExecuted(monitor.command, monitor.cwd);
      const safeOutput = redactCredentialText(output);
      snapshot = [
        `exit=${result.exitCode ?? "signal"}`,
        safeOutput ? `output:\n${safeOutput}` : "",
      ].filter(Boolean).join("\n").slice(-MAX_EVENT_OUTPUT_CHARS);
      failed = result.exitCode !== 0;
    } catch (error) {
      failed = true;
      snapshot = `poll failed: ${redactCredentialText(errorText(error))}`;
    } finally {
      if (monitor.abortController === controller) monitor.abortController = undefined;
    }

    if (!monitor.active || shuttingDown || monitors.get(monitor.id) !== monitor) return;
    const previous = monitor.lastSnapshot;
    monitor.lastSnapshot = snapshot;
    if ((previous !== undefined && previous !== snapshot) || (previous === undefined && failed)) {
      publish(monitor, failed ? "command failure" : "command output change", snapshot);
    }
    scheduleCommandPoll(monitor, monitor.intervalMs);
  };

  pi.registerTool({
    name: "monitor_start",
    label: "Monitor Start / 开始监控",
    description: `Start monitoring a file for changes or polling a sandbox-approved command for output.
Publishes visible monitor events without starting another agent turn.`,
    parameters: Type.Object({
      type: Type.Union([Type.Literal("file"), Type.Literal("command")]),
      target: Type.String({ description: "File path to watch or command to poll" }),
      interval_ms: Type.Optional(Type.Number({ description: "Poll interval for commands / 轮询间隔(毫秒)", default: DEFAULT_INTERVAL_MS })),
    }),
    async execute(_id: string, params: any, _signal?: AbortSignal, _onUpdate?: unknown, ctx?: any): Promise<any> {
      if (shuttingDown) {
        return { isError: true, content: [{ type: "text" as const, text: "Monitor session is shutting down." }], details: undefined };
      }
      const id = `monitor_${++monitorSeq}`;
      const target = String(params.target ?? "");
      const cwd = ctx?.cwd || process.cwd();

      if (params.type === "file") {
        const decision = sandbox.decideFileAccess("read", target, cwd);
        const authorization = await authorize(decision, ctx);
        if (!authorization.allowed) {
          return { isError: true, content: [{ type: "text" as const, text: `Canvast sandbox blocked file monitor.\n${authorization.reason}` }], details: { decision } };
        }
        try {
          const resolvedTarget = path.resolve(cwd, target);
          let monitor!: FileMonitor;
          const watcher = watch(resolvedTarget, (event, filename) => {
            const suffix = filename ? ` (${String(filename)})` : "";
            publish(monitor, event, `${target}${suffix}`);
          });
          monitor = { id, type: "file", target, active: true, watcher };
          watcher.on("error", error => {
            publish(monitor, "watch error", errorText(error));
            void stopMonitor(monitor);
          });
          watcher.unref?.();
          monitors.set(id, monitor);
          return {
            content: [{ type: "text" as const, text: `✅ Monitoring file: **${target}** (ID: ${id})\nChanges will be published as monitor events.` }],
            details: { monitorId: id, type: "file", target },
          };
        } catch (error) {
          return { isError: true, content: [{ type: "text" as const, text: `Monitor failed: ${errorText(error)}` }], details: undefined };
        }
      }

      const intervalMs = intervalFrom(params.interval_ms);
      if (intervalMs === undefined) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Monitor interval must be between ${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS} milliseconds.` }],
          details: undefined,
        };
      }
      const decision = sandbox.decideBash(target, cwd);
      const authorization = await authorize(decision, ctx);
      if (!authorization.allowed) {
        return { isError: true, content: [{ type: "text" as const, text: `Canvast sandbox blocked command monitor.\n${authorization.reason}` }], details: { decision } };
      }

      const monitor: CommandMonitor = {
        id, type: "command", target, command: target, cwd, intervalMs, active: true,
      };
      monitors.set(id, monitor);
      scheduleCommandPoll(monitor, 0);
      return {
        content: [{ type: "text" as const, text: `✅ Monitoring command: \`${target}\` (ID: ${id}, poll: ${intervalMs}ms)` }],
        details: { monitorId: id, type: "command", target, intervalMs },
      };
    },
  });

  pi.registerTool({
    name: "monitor_stop",
    label: "Monitor Stop / 停止监控",
    description: "Stop an active monitor and release its resources.",
    parameters: Type.Object({ monitor_id: Type.String({ description: "Monitor ID" }) }),
    async execute(_id: string, params: any) {
      const monitor = monitors.get(params.monitor_id);
      if (!monitor) return { isError: true, content: [{ type: "text" as const, text: `Monitor ${params.monitor_id} not found.` }], details: undefined };
      await stopMonitor(monitor);
      return { content: [{ type: "text" as const, text: `✅ Monitor ${params.monitor_id} stopped.` }], details: undefined };
    },
  });

  pi.registerTool({
    name: "monitor_list",
    label: "Monitor List / 监控列表",
    description: "List all active monitors.",
    parameters: Type.Object({}),
    async execute() {
      if (monitors.size === 0) return { content: [{ type: "text" as const, text: "No active monitors." }], details: undefined };
      const list = Array.from(monitors.values()).map(monitor =>
        `- **${monitor.id}**: ${monitor.type === "file" ? `📁 ${monitor.target}` : `🔄 \`${monitor.command}\``}`,
      ).join("\n");
      return { content: [{ type: "text" as const, text: `# Monitors / 监控 (${monitors.size})\n\n${list}` }], details: undefined };
    },
  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    await Promise.allSettled(Array.from(monitors.values(), monitor => stopMonitor(monitor)));
  });
}
