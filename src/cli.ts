/**
 * =============================================================================
 * Canvast — CLI Entry Point / 命令行入口
 * =============================================================================
 * @file        src/cli.ts
 * @brief       Canvast CLI — interactive, print, daemon, and watch modes
 * @description Main entry point for the Canvast agent harness. Supports:
 *              - Interactive TUI mode (default)
 *              - Print mode (-p, single execution)
 *              - JSON mode (--mode json, structured output)
 *              - Daemon mode (--serve, HTTP+WebSocket)
 *              - Watch mode (--watch, file-change triggered)
 *              - Experiment mode (--experiment, run evaluation matrix)
 *              Extends pi's CLI with Canvast-specific flags.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * Changes: [2026-08-08] Initial implementation
 * =============================================================================
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { splitCanvastModeArgs } from "./harness/canvast-mode.js";
import { redactCredentialsDeep, redactCredentialText } from "./harness/credential-redaction.js";
import {
  canvastIdentityPrompt,
  enforceCanvastInternalInfoBoundary,
} from "./harness/product-identity.js";
import {
  normalizeCanvastSessionArgs,
  resolveCanvastRuntimePaths,
  type CanvastRuntimePaths,
} from "./harness/runtime-paths.js";
import { verifyComponentPack } from "./harness/component-verifier.js";
import { resolveProviderModelArgs } from "./harness/model-capabilities.js";
import { splitSandboxArgs } from "./harness/sandbox.js";
import { splitCanvastSkillArgs } from "./harness/skill-registry.js";
import {
  captureProcessIdentity,
  signalProcessVerified,
  type ProcessStartIdentity,
  type VerifiedSignalResult,
} from "./utils/bounded-lifecycle.js";
import {
  getOwnedHandleRegistry,
  type OwnedHandleAdmissionFreeze,
  type OwnedHandleLease,
  type OwnedHandleRegistry,
} from "./utils/owned-handle-registry.js";
import {
  applyOwnedHandleDiagnosticsEnvironment,
  splitOwnedHandleDiagnosticsArgs,
} from "./utils/owned-handle-diagnostics.js";
import { PROCESS_SNAPSHOT_SOURCE } from "../scripts/process-snapshot-client.mjs";

/** Production extensions loaded by the Canvast product entrypoint. */
export const CANVAST_EXTENSION_FILES = [
  "canvast-core.ts",
  "canvast-harness.ts",
  "canvast-tui.ts",
  "product-closure.ts",
  "sandbox-bash.ts",
  "canvast-permissions.ts",
  "desktop-action.ts",
  "plan-mode.ts",
  "task-manager.ts",
  "web-tools.ts",
  "sub-agent.ts",
  "code-review.ts",
  "ask-user.ts",
  "mcp-bridge.ts",
  "git-tools.ts",
  "token-tracker.ts",
  "background-task.ts",
  "canvas-repomap.ts",
  "notebook-edit.ts",
  "lsp-tools.ts",
  "workflow.ts",
  "cron-scheduler.ts",
  "worktree.ts",
  "artifact.ts",
  "agent-comms.ts",
  "report-findings.ts",
  "monitor.ts",
  "owned-handle-diagnostics.ts",
] as const;

export type { CanvastRuntimePaths };

export function resolveRuntimePaths(
  fromUrl = import.meta.url,
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = [],
): CanvastRuntimePaths {
  return resolveCanvastRuntimePaths({
    installUrl: fromUrl,
    cwd,
    env,
    args,
    extensionFiles: CANVAST_EXTENSION_FILES,
  });
}

function hasOption(args: string[], longName: string, shortName?: string): boolean {
  return args.some(arg => arg === longName || arg.startsWith(`${longName}=`) || (shortName ? arg === shortName : false));
}

function optionValue(args: string[], longName: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith(`${longName}=`)) return arg.slice(longName.length + 1);
    if (arg === longName) return args[i + 1];
  }
  return undefined;
}

function modeValue(args: string[]): string | undefined {
  return optionValue(args, "--mode");
}

export function shouldFilterJsonThinking(args: string[]): boolean {
  return modeValue(args) === "json" && process.env.CANVAST_EXPOSE_THINKING !== "1";
}

function shouldDefaultProvider(args: string[]): boolean {
  if (hasOption(args, "--provider")) return false;
  const model = optionValue(args, "--model");
  return !model?.includes("/");
}

function prependPathEntry(pathValue: string | undefined, entry: string): string {
  if (!pathValue) return entry;
  const parts = pathValue.split(path.delimiter).filter(Boolean);
  return parts.includes(entry) ? pathValue : [entry, ...parts].join(path.delimiter);
}

function defaultModelArgs(userArgs: string[], env: NodeJS.ProcessEnv = process.env): {
  provider: string;
  model: string;
  thinking: string;
} {
  return resolveProviderModelArgs({
    env,
    provider: optionValue(userArgs, "--provider") ?? env.CANVAST_PROVIDER ?? env.CANVAST_DEFAULT_PROVIDER,
    model: optionValue(userArgs, "--model") ?? env.CANVAST_MODEL ?? env.CANVAST_DEFAULT_MODEL,
  });
}

export function buildPiArgs(userArgs: string[], paths?: CanvastRuntimePaths): string[] {
  const runtimePaths = paths || resolveRuntimePaths(import.meta.url, process.cwd(), process.env, userArgs);
  const diagnosticsArgs = splitOwnedHandleDiagnosticsArgs(userArgs);
  if (diagnosticsArgs.errors.length > 0) {
    throw new Error(diagnosticsArgs.errors.join("; "));
  }
  const skillArgs = splitCanvastSkillArgs(diagnosticsArgs.forwardedArgs, runtimePaths.installDir);
  const { forwardedArgs } = splitCanvastModeArgs(skillArgs.forwardedArgs);
  const sandboxArgs = splitSandboxArgs(forwardedArgs);
  const sessionArgs = normalizeCanvastSessionArgs(sandboxArgs.forwardedArgs);
  const modelDefaults = defaultModelArgs(sessionArgs.forwardedArgs, process.env);
  const args: string[] = [];

  if (shouldDefaultProvider(sessionArgs.forwardedArgs)) args.push("--provider", modelDefaults.provider);
  if (!hasOption(sessionArgs.forwardedArgs, "--model")) args.push("--model", modelDefaults.model);
  if (!hasOption(sessionArgs.forwardedArgs, "--thinking")) args.push("--thinking", modelDefaults.thinking);
  if (runtimePaths.sessionDir && !hasOption(sessionArgs.forwardedArgs, "--session-dir")) {
    args.push("--session-dir", runtimePaths.sessionDir);
  }

  args.push("--append-system-prompt", canvastIdentityPrompt());
  for (const ext of runtimePaths.extensionPaths) args.push("--extension", ext);
  args.push(...skillArgs.skillArgs);
  args.push(...sessionArgs.forwardedArgs);
  return args;
}

export function buildCanvastChildEnv(
  paths: CanvastRuntimePaths,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const componentDir = env.CANVAST_COMPONENTS_DIR || path.join(paths.installDir, "components");
  const componentBinDir = env.CANVAST_COMPONENT_BIN_DIR || path.join(componentDir, "bin");
  const componentPack = verifyComponentPack({
    installDir: paths.installDir,
    componentsDir: componentDir,
  });
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    CANVAST_HOME: paths.canvastHome,
    CANVAST_INSTALL_DIR: paths.installDir,
    CANVAST_PROJECT_ROOT: paths.projectRoot,
    CANVAST_WORKING_DIR: paths.workingDir,
    CANVAST_PERSISTENCE_MODE: paths.persistenceMode,
    CANVAST_COMPONENTS_DIR: componentDir,
    CANVAST_COMPONENT_BIN_DIR: componentBinDir,
    PATH: componentPack.trusted && componentPack.binDir
      ? prependPathEntry(env.PATH, componentPack.binDir)
      : env.PATH,
    PI_CODING_AGENT_DIR: paths.agentDir,
  };
  childEnv.PI_OFFLINE = "1";
  if (paths.sessionDir) childEnv.PI_CODING_AGENT_SESSION_DIR = paths.sessionDir;
  else delete childEnv.PI_CODING_AGENT_SESSION_DIR;
  return childEnv;
}

const LIVE_SECRET_NAMES = new Set(["DEEPSEEK_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);

function envNameAllowed(name: string): boolean {
  if (!name) return false;
  const first = name.charCodeAt(0);
  const firstValid = (first >= 65 && first <= 90) || (first >= 97 && first <= 122) || first === 95;
  if (!firstValid) return false;
  for (let i = 1; i < name.length; i++) {
    const code = name.charCodeAt(i);
    const digit = code >= 48 && code <= 57;
    const upper = code >= 65 && code <= 90;
    const lower = code >= 97 && code <= 122;
    if (!digit && !upper && !lower && code !== 95) return false;
  }
  return true;
}

function assignEnvValue(
  env: NodeJS.ProcessEnv,
  name: string,
  value: string,
  source: "legacy" | "secret",
  originalNames: Set<string>,
): void {
  if (!envNameAllowed(name)) return;
  if (source === "secret" && !LIVE_SECRET_NAMES.has(name)) return;
  if (source === "legacy" && env[name] !== undefined) return;
  if (source === "secret" && originalNames.has(name)) return;
  env[name] = value;
}

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

export function loadLiveEnv(projectDir: string, env: NodeJS.ProcessEnv = process.env): void {
  const originalNames = new Set([...LIVE_SECRET_NAMES].filter(name => env[name] !== undefined));
  loadEnvAssignments(env, path.join(projectDir, ".env"), "legacy", originalNames);
  loadEnvAssignments(env, env.CANVAST_LIVE_SECRET_FILE || path.join(projectDir, ".canvast-secrets", "live.env"), "secret", originalNames);
}

function loadEnvAssignments(
  env: NodeJS.ProcessEnv,
  file: string,
  source: "legacy" | "secret",
  originalNames: Set<string>,
): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf-8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const raw = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
    const separator = raw.indexOf("=");
    if (separator <= 0) continue;
    const name = raw.slice(0, separator);
    const value = unquoteEnvValue(raw.slice(separator + 1));
    assignEnvValue(env, name, value, source, originalNames);
  }
}

function scrubHiddenThinking(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .filter(item => !(item && typeof item === "object" && (item as any).type === "thinking"))
      .map(item => scrubHiddenThinking(item));
  }
  if (!value || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "thinking" || key === "thinkingSignature" || key === "reasoning_content") continue;
    out[key] = scrubHiddenThinking(child);
  }
  return out;
}

const TOOL_RESULT_TEXT_LIMIT = 2_000;
const TOOL_DETAIL_TEXT_LIMIT = 1_200;

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.map((item) => {
    if (item && typeof item === "object" && typeof (item as any).text === "string") {
      return (item as any).text;
    }
    return "";
  }).filter(Boolean).join("\n");
}

function textLengthFromContent(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum, item) => {
    if (item && typeof item === "object" && typeof (item as any).text === "string") {
      return sum + (item as any).text.length;
    }
    return sum;
  }, 0);
}

function compactString(value: string, limit = TOOL_DETAIL_TEXT_LIMIT): string {
  const safeValue = redactCredentialText(value);
  if (containsUnsafeControl(value)) {
    return `[binary-like text omitted: ${safeValue.length} chars; full output retained only in tool-side spill/log when available]`;
  }
  if (safeValue.length <= limit) return safeValue;
  const headLimit = Math.max(1, Math.floor(limit / 2));
  const tailLimit = Math.max(1, limit - headLimit);
  return `${safeValue.slice(0, headLimit)}\n...[compacted ${safeValue.length - limit} chars]...\n${safeValue.slice(safeValue.length - tailLimit)}`;
}

function containsUnsafeControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return true;
  }
  return false;
}

function extractLocalScanSummary(output: string): string | undefined {
  if (!/Local Scan Sub-Agent/.test(output)) return undefined;
  const line = (label: string) => new RegExp(`^${label}:\\s*(.+)$`, "m").exec(output)?.[1]?.trim();
  const tableRows = Array.from(output.matchAll(/^\|\s*([^|\n]+?)\s*\|\s*(\d+)\s*\|$/gm))
    .map(match => `${match[1].trim()}=${match[2].trim()}`)
    .filter(row => !/^extension=/i.test(row));
  return [
    `Directory: ${line("Directory") || "unknown"}`,
    `Engine: ${line("Execution") || "deterministic local filesystem scan"}`,
    `Trust: ${line("Trust") || "fast local enumeration is expected"}`,
    `Safety: ${line("Safety") || "read-only"}`,
    `File types: ${tableRows.join(", ") || "(none)"}`,
    `Total files: ${line("Total files") || "0"}`,
    `Total directories: ${line("Total directories") || "0"}`,
  ].join("\n");
}

function summarizeParallelAgentDetails(details: any, originalLength: number): string | undefined {
  const results = details?.results;
  if (!Array.isArray(results) || results.length === 0) return undefined;
  const lines = [
    `[tool result compacted: ${originalLength} chars; structured details retained with large text summarized]`,
    "Parallel agent evidence:",
  ];
  for (const result of results.slice(0, 8)) {
    const output = typeof result?.output === "string" ? result.output : "";
    const localSummary = extractLocalScanSummary(output);
    lines.push(`- ${result?.id ?? "agent"}: ${result?.success === false ? "failed" : "success"}; engine=${result?.engine || "unknown"}; durationMs=${result?.durationMs ?? "unknown"}`);
    if (localSummary) {
      for (const summaryLine of localSummary.split("\n")) lines.push(`  ${summaryLine}`);
    } else if (output) {
      lines.push(`  Output: ${compactString(output.replace(/\s+/g, " ").trim(), 500)}`);
    }
  }
  if (results.length > 8) lines.push(`- ... ${results.length - 8} more results summarized in details`);
  return lines.join("\n");
}

function compactDetails(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => compactDetails(item));
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? compactString(value) : value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (typeof child === "string" && child.length > TOOL_DETAIL_TEXT_LIMIT) {
      out[key] = extractLocalScanSummary(child) || compactString(child);
    } else {
      out[key] = compactDetails(child);
    }
  }
  return out;
}

function compactToolResultTarget(target: any, toolName: string | undefined): any {
  if (!target) return target;
  const originalLength = textLengthFromContent(target.content);
  const originalText = redactCredentialText(textFromContent(target.content));
  const shouldCompact = originalLength > TOOL_RESULT_TEXT_LIMIT || containsUnsafeControl(originalText);
  const details = target.details === undefined ? undefined : compactDetails(target.details);
  if (!shouldCompact) {
    const content = redactCredentialsDeep(target.content);
    return { ...target, content, details };
  }
  const detailSummary = toolName === "parallel_agents"
    ? summarizeParallelAgentDetails(target.details, originalLength)
    : undefined;
  const compactContent = [{
    type: "text",
    text: detailSummary || [
      `[tool result compacted: ${originalLength} chars; structured details retained with large text summarized]`,
      compactString(originalText, 800),
    ].join("\n"),
  }];
  return {
    ...target,
    content: compactContent,
    details,
  };
}

function compactToolResultEvent(event: any): any {
  const message = event?.message;
  const result = event?.result;
  const partialResult = event?.partialResult;
  const toolName = event?.toolName || message?.toolName || result?.toolName;
  const compactedToolResults = Array.isArray(event?.toolResults)
    ? event.toolResults.map((toolResult: any) => compactToolResultTarget(toolResult, toolResult?.toolName || toolName))
    : undefined;
  const compactedPartialResult = partialResult
    ? compactToolResultTarget(partialResult, toolName)
    : undefined;
  if (message?.role === "toolResult") {
    return {
      ...event,
      message: compactToolResultTarget(message, message.toolName || toolName),
      ...(compactedPartialResult ? { partialResult: compactedPartialResult } : {}),
      ...(compactedToolResults ? { toolResults: compactedToolResults } : {}),
    };
  }
  if (result) {
    return {
      ...event,
      result: compactToolResultTarget(result, toolName),
      ...(compactedPartialResult ? { partialResult: compactedPartialResult } : {}),
      ...(compactedToolResults ? { toolResults: compactedToolResults } : {}),
    };
  }
  if (compactedPartialResult) {
    return {
      ...event,
      partialResult: compactedPartialResult,
      ...(compactedToolResults ? { toolResults: compactedToolResults } : {}),
    };
  }
  if (compactedToolResults) return { ...event, toolResults: compactedToolResults };
  return {
    ...event,
  };
}

function enforceInternalBoundaryOnEvent(event: any): any {
  if (event?.message?.role === "assistant") {
    const guarded = enforceCanvastInternalInfoBoundary(event.message);
    if (guarded.redacted) return { ...event, message: guarded.message };
  }
  if (Array.isArray(event?.messages)) {
    let changed = false;
    const messages = event.messages.map((message: any) => {
      const guarded = enforceCanvastInternalInfoBoundary(message);
      if (guarded.redacted) changed = true;
      return guarded.message;
    });
    if (changed) return { ...event, messages };
  }
  return event;
}

export function sanitizeJsonEventLine(line: string): string | undefined {
  if (!line.trim()) return line;
  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    return redactCredentialText(line);
  }

  const assistantEvent = event?.assistantMessageEvent;
  if (event?.type === "message_update" && typeof assistantEvent?.type === "string" && assistantEvent.type.startsWith("thinking")) {
    return undefined;
  }
  if (event?.type === "message_update" && assistantEvent?.type === "toolcall_delta") {
    return undefined;
  }
  if (event?.type === "agent_end" && Array.isArray(event?.messages)) {
    const compact = redactCredentialsDeep(scrubHiddenThinking({ ...event, messages: undefined }));
    return JSON.stringify(compact);
  }
  const bounded = enforceInternalBoundaryOnEvent(event);
  const compacted = compactToolResultEvent(bounded);
  const scrubbed = redactCredentialsDeep(scrubHiddenThinking(compacted));
  return JSON.stringify(scrubbed);
}

function pipeFilteredJsonOutput(child: ReturnType<typeof spawn>): void {
  let buffered = "";
  let stdoutClosed = false;
  process.stdout.on("error", error => {
    if ((error as NodeJS.ErrnoException).code !== "EPIPE") throw error;
    stdoutClosed = true;
  });
  const writeSanitized = (text: string): void => {
    if (stdoutClosed) return;
    try {
      const accepted = process.stdout.write(text);
      if (!accepted && process.stdout.destroyed) stdoutClosed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPIPE") throw error;
      stdoutClosed = true;
    }
  };
  child.stdout?.on("data", (chunk: Buffer | string) => {
    buffered += chunk.toString();
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() || "";
    for (const line of lines) {
      const sanitized = sanitizeJsonEventLine(line);
      if (sanitized !== undefined) writeSanitized(`${sanitized}\n`);
    }
  });
  child.stdout?.on("end", () => {
    if (!buffered) return;
    const sanitized = sanitizeJsonEventLine(buffered);
    if (sanitized !== undefined) writeSanitized(sanitized);
    buffered = "";
  });
}

const CLI_TERMINATION_GRACE_MS = 2_000;
const CLI_KILL_CONFIRMATION_MS = 1_000;

export interface CanvastCliSignalHost {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

/** Narrow dependency seam for deterministic lifecycle tests. */
export interface CanvastCliLifecycleAdapter {
  parent?: CanvastCliSignalHost;
  registry?: OwnedHandleRegistry;
  captureIdentity?: typeof captureProcessIdentity;
  signalVerified?: typeof signalProcessVerified;
  terminationGraceMs?: number;
  killConfirmationMs?: number;
}

function signalExitCode(signal: NodeJS.Signals): number {
  return signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 129;
}

function completeOwnedCliHandle(
  lease: OwnedHandleLease | undefined,
  confirmed: boolean,
  reason?: string,
): void {
  if (!lease) return;
  if (confirmed) lease.release();
  else lease.markUnconfirmed(reason || "Canvast CLI child cleanup could not be confirmed.");
}

/**
 * Wait for the non-detached pi child while owning its exact PID identity.
 * Parent signals are never forwarded to a process group: PID reuse must fail
 * closed instead of risking an unrelated host process.
 */
export async function waitForCanvastChild(
  child: ChildProcess,
  adapter: CanvastCliLifecycleAdapter = {},
): Promise<number> {
  const parent = adapter.parent ?? process;
  const registry = adapter.registry ?? getOwnedHandleRegistry();
  const captureIdentity = adapter.captureIdentity ?? captureProcessIdentity;
  const signalVerified = adapter.signalVerified ?? signalProcessVerified;
  const terminationGraceMs = Math.max(1, Math.floor(
    adapter.terminationGraceMs ?? CLI_TERMINATION_GRACE_MS,
  ));
  const killConfirmationMs = Math.max(1, Math.floor(
    adapter.killConfirmationMs ?? CLI_KILL_CONFIRMATION_MS,
  ));

  return await new Promise<number>((resolve) => {
    let settled = false;
    let spawnConfirmed = false;
    let terminationStarted = false;
    let identity: ProcessStartIdentity | undefined;
    let ownedHandle: OwnedHandleLease | undefined;
    let admissionFreeze: OwnedHandleAdmissionFreeze | undefined;
    let parentSignal: "SIGINT" | "SIGTERM" | undefined;
    let postSpawnError: Error | undefined;
    let cleanupFailure: string | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let confirmationTimer: ReturnType<typeof setTimeout> | undefined;

    const onSigint = () => requestTermination("SIGINT");
    const onSigterm = () => requestTermination("SIGTERM");

    const removeParentListeners = (): void => {
      parent.removeListener("SIGINT", onSigint);
      parent.removeListener("SIGTERM", onSigterm);
    };

    const finish = (
      code: number,
      cleanupConfirmed: boolean,
      unconfirmedReason?: string,
    ): void => {
      if (settled) return;
      settled = true;
      if (graceTimer) clearTimeout(graceTimer);
      if (confirmationTimer) clearTimeout(confirmationTimer);
      removeParentListeners();
      completeOwnedCliHandle(ownedHandle, cleanupConfirmed, unconfirmedReason);
      admissionFreeze?.release();
      resolve(code);
    };

    const recordSignalFailure = (result: VerifiedSignalResult, phase: string): void => {
      if (result !== "sent" && result !== "gone" && result !== "identity_mismatch") {
        cleanupFailure = `Canvast CLI child ${phase} signal result: ${result}.`;
      }
    };

    const awaitCloseOrMarkUnconfirmed = (): void => {
      if (settled || confirmationTimer) return;
      confirmationTimer = setTimeout(() => {
        confirmationTimer = undefined;
        if (settled) return;
        finish(
          parentSignal ? signalExitCode(parentSignal) : 1,
          false,
          cleanupFailure || "Canvast CLI child did not emit close within the bounded shutdown window.",
        );
      }, killConfirmationMs);
      confirmationTimer.unref?.();
    };

    const beginTermination = (): void => {
      if (settled || terminationStarted || !spawnConfirmed || !parentSignal) return;
      terminationStarted = true;
      ownedHandle?.markSettling();

      const firstResult = signalVerified(child.pid, identity, parentSignal);
      recordSignalFailure(firstResult, "initial");
      if (firstResult === "gone" || firstResult === "identity_mismatch") {
        awaitCloseOrMarkUnconfirmed();
        return;
      }

      graceTimer = setTimeout(() => {
        graceTimer = undefined;
        if (settled) return;
        const killResult = signalVerified(child.pid, identity, "SIGKILL");
        recordSignalFailure(killResult, "SIGKILL");
        if (killResult === "sent") {
          cleanupFailure = "Canvast CLI child did not emit close after verified SIGKILL.";
        }
        awaitCloseOrMarkUnconfirmed();
      }, terminationGraceMs);
      graceTimer.unref?.();
    };

    function requestTermination(signal: "SIGINT" | "SIGTERM"): void {
      if (settled) return;
      parentSignal ??= signal;
      admissionFreeze ??= registry.freezeAdmission();
      // A pre-spawn signal is latched. The subsequent admission freeze can
      // intentionally exclude a child whose identity was never confirmed.
      if (spawnConfirmed) beginTermination();
    }

    parent.on("SIGINT", onSigint);
    parent.on("SIGTERM", onSigterm);

    child.once("spawn", () => {
      if (settled) return;
      spawnConfirmed = true;
      identity = captureIdentity(child.pid);
      if (
        child.pid !== undefined
        && identity?.pid === child.pid
        && Number.isSafeInteger(identity.pgid)
        && identity.pgid > 0
        && identity.birth.length > 0
      ) {
        try {
          ownedHandle = registry.register({
            type: "os-process",
            owner: "canvast-cli",
            source: PROCESS_SNAPSHOT_SOURCE,
            scope: "cli",
            pid: child.pid,
            pgid: identity.pgid,
            birth: identity.birth,
            metadata: { detached: false },
          });
        } catch {
          // An earlier global shutdown may have won admission. Exact identity
          // still governs signalling; the registry never receives partial data.
        }
      }
      beginTermination();
    });

    child.once("close", (code, signal) => {
      const resultCode = parentSignal
        ? signalExitCode(parentSignal)
        : postSpawnError ? 1 : signal ? signalExitCode(signal) : (code ?? 1);
      finish(resultCode, true);
    });
    child.once("error", (error) => {
      console.error(`Canvast failed to launch pi runtime: ${error.message}`);
      if (!spawnConfirmed) {
        finish(1, true);
        return;
      }
      postSpawnError = error;
      cleanupFailure = `Canvast CLI child emitted an error after spawn: ${error.message}`;
      awaitCloseOrMarkUnconfirmed();
    });
  });
}

export async function runCanvastCli(userArgs: string[] = process.argv.slice(2)): Promise<number> {
  const diagnosticsArgs = splitOwnedHandleDiagnosticsArgs(userArgs);
  let paths = resolveRuntimePaths(
    import.meta.url, process.cwd(), process.env, diagnosticsArgs.forwardedArgs,
  );
  loadLiveEnv(paths.projectDir);
  paths = resolveRuntimePaths(
    import.meta.url, process.cwd(), process.env, diagnosticsArgs.forwardedArgs,
  );
  const skillArgs = splitCanvastSkillArgs(diagnosticsArgs.forwardedArgs, paths.installDir);
  const modeArgs = splitCanvastModeArgs(skillArgs.forwardedArgs);
  const sandboxArgs = splitSandboxArgs(modeArgs.forwardedArgs);
  const cliErrors = [
    ...diagnosticsArgs.errors, ...skillArgs.errors, ...modeArgs.errors, ...sandboxArgs.errors,
  ];
  if (cliErrors.length) {
    for (const error of cliErrors) process.stderr.write(`Canvast CLI error: ${error}\n`);
    return 2;
  }
  fs.mkdirSync(paths.agentDir, { recursive: true });
  if (paths.sessionDir) fs.mkdirSync(paths.sessionDir, { recursive: true });
  const filterJsonThinking = shouldFilterJsonThinking(sandboxArgs.forwardedArgs);

  const childEnv = buildCanvastChildEnv(paths, process.env);
  applyOwnedHandleDiagnosticsEnvironment(childEnv, diagnosticsArgs.configuration);
  if (modeArgs.mode) {
    childEnv.CANVAST_MODE = modeArgs.mode;
    childEnv.CANVAST_MODE_SOURCE = modeArgs.source || "argv";
  }
  if (sandboxArgs.profile) childEnv.CANVAST_SANDBOX = sandboxArgs.profile;
  if (sandboxArgs.unattended !== undefined) childEnv.CANVAST_UNATTENDED = sandboxArgs.unattended ? "1" : "0";

  const child = spawn(process.execPath, [
    paths.piCli, ...buildPiArgs(diagnosticsArgs.forwardedArgs, paths),
  ], {
    cwd: paths.workingDir,
    stdio: filterJsonThinking ? ["inherit", "pipe", "inherit"] : "inherit",
    env: childEnv,
  });
  if (filterJsonThinking) pipeFilteredJsonOutput(child);

  return await waitForCanvastChild(child);
}

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const code = await runCanvastCli(args);
  process.exit(code);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error("Canvast error:", err); process.exit(1); });
}
