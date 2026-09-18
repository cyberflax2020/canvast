/**
 * =============================================================================
 * Canvast — Auto Orchestrator Shell / Canvast 源文件
 * =============================================================================
 * @file        src/harness/auto-orchestrator-shell.ts
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */


import { analyzeBashCommand } from "./sandbox.js";

export const READ_ONLY_SHELL_PLAN_TOOLS = new Set([
  "pwd",
  "ls",
  "find",
  "fd",
  "fd_find",
  "grep",
  "rg",
  "ripgrep",
  "cat",
  "echo",
  "printf",
  "sed",
  "sort",
  "uniq",
  "nl",
  "wc",
  "head",
  "tail",
  "git",
  "test",
  "[",
  "which",
]);

const NETWORK_FETCH_SHELL_COMMANDS = new Set([
  "curl",
  "wget",
  "fetch",
  "http",
  "https",
  "aria2c",
  "ftp",
  "sftp",
  "scp",
  "rsync",
]);

function normalizeShellCommandName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function shellUsesNetworkFetch(command: string): boolean {
  const analysis = analyzeBashCommand(command);
  return analysis.commandNames.some(name => NETWORK_FETCH_SHELL_COMMANDS.has(normalizeShellCommandName(name)));
}

export function isReadOnlyBash(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (isSimpleReadOnlyBash(trimmed)) return true;
  return isCompoundReadOnlyBash(trimmed);
}

export function isNonMutatingBash(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  const analysis = analyzeBashCommand(trimmed);
  if (analysis.hardBlock || analysis.dangerousReason || analysis.mutatesCwd) return false;
  return !analysis.categories.some(category =>
    ["visible-write", "in-place-edit", "cwd-mutation", "dangerous", "hard-danger"].includes(category),
  );
}

function isSimpleReadOnlyBash(trimmed: string): boolean {
  if (/[;&|`$<>]/.test(trimmed)) return false;
  if (/^\w+=/.test(trimmed)) return false;
  if (/(^|\s)(-exec|-delete|-ok|--in-place|--output=)/.test(trimmed)) return false;
  if (/\bsed\b.*\s-i(\s|$)/.test(trimmed)) return false;
  return [
    /^pwd$/,
    /^ls(\s|$)/,
    /^git\s+(status|diff|log|show|branch)(\s|$)/,
    /^rg(\s|$)/,
    /^grep(\s|$)/,
    /^find(\s|$)/,
    /^cat\s+/,
    /^sed\s+-n\s+/,
    /^nl\s+/,
    /^wc\s+/,
    /^head\s+/,
    /^tail\s+/,
    /^node\s+--version$/,
    /^npm\s+--version$/,
    /^which\s+/,
  ].some(pattern => pattern.test(trimmed));
}

function isCompoundReadOnlyBash(command: string): boolean {
  if (command.length > 2_000) return false;
  if (/`|\$\(|<|>\s*(?!\/dev\/null)/.test(command)) return false;
  if (/^\w+=/.test(command)) return false;
  if (/(^|\s)(-exec|-delete|-ok|--in-place|--output=)/.test(command)) return false;
  if (/\bsed\b[^;|]*\s-i(\s|$)/.test(command)) return false;
  if (/\bgit\s+(?!status|diff|log|show|branch)\w+/.test(command)) return false;
  if (/(^|[;&|]\s*)(rm|mv|cp|curl|wget|python|python3|node|npm|pnpm|yarn|chmod|chown|mkdir|touch|tee|dd|truncate|perl|ruby|osascript|open|sh|bash)\b/.test(command)) {
    return false;
  }

  const allowedCommands = new Set([
    "for",
    "do",
    "done",
    "if",
    "then",
    "else",
    "fi",
    "echo",
    "printf",
    "find",
    "sed",
    "sort",
    "uniq",
    "wc",
    "head",
    "tail",
    "ls",
    "rg",
    "fd",
    "fd_find",
    "grep",
    "cat",
    "pwd",
    "test",
  ]);
  const withoutStrings = command.replace(/"[^"]*"|'[^']*'/g, " ");
  const commandPattern = /(?:^|[;|]\s*|\bthen\s+|\bdo\s+|\belse\s+)([A-Za-z_][\w.-]*)/g;
  const found: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = commandPattern.exec(withoutStrings)) !== null) {
    const name = match[1].toLowerCase();
    found.push(name);
    if (!allowedCommands.has(name)) return false;
  }
  return found.some(name => ["find", "ls", "rg", "fd", "fd_find", "grep", "cat", "sed", "wc", "head", "tail"].includes(name));
}
