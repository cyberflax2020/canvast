/**
 * =============================================================================
 * Canvast — Sandbox Command Identity / Canvast 沙箱命令身份
 * =============================================================================
 * @file        src/harness/sandbox-command-identity.ts
 * @brief       Derives context-bound identities for shell command grants.
 * @description Binds approval to the canonical cwd, resolved read/write set,
 *              executable script contents, and active policy state.
 *              / 将授权绑定到规范化 cwd、解析后的读写集合、脚本内容与策略状态。
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { canonical, resolveCommandOperand } from "./sandbox-path-policy.js";

export interface SandboxCommandIdentityInput {
  command: string;
  cwd: string;
  commandTokens: readonly string[];
  readPaths: readonly string[];
  writePaths: readonly string[];
  profile: string;
  network: string;
  writableRoots: readonly string[];
  trustedReadRoots: readonly string[];
}

export function commandFingerprint(command: string): string {
  return createHash("sha256").update(command.trim()).digest("hex").slice(0, 16);
}

const SHELL_OPERATORS = new Set(["|", "||", "&", "&&", ";"]);
const SCRIPT_INTERPRETERS = new Set([
  "bash", "sh", "zsh", "dash",
  "python", "python3", "node", "deno", "bun", "perl", "ruby",
]);

function commandSegments(tokens: readonly string[]): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  for (const token of tokens) {
    if (SHELL_OPERATORS.has(token)) {
      if (current.length > 0) segments.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

function hashFile(filePath: string): string {
  let descriptor: number | undefined;
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) return "";
    descriptor = fs.openSync(filePath, "r");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
    return hash.digest("hex");
  } catch {
    return "";
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function hasShebang(filePath: string): boolean {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, "r");
    const prefix = Buffer.alloc(2);
    return fs.readSync(descriptor, prefix, 0, prefix.length, 0) === 2 &&
      prefix[0] === 0x23 && prefix[1] === 0x21;
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function isShellAssignment(token: string): boolean {
  const separator = token.indexOf("=");
  if (separator <= 0) return false;
  const name = token.slice(0, separator);
  const first = name[0];
  if (!first || !(
    (first >= "A" && first <= "Z") ||
    (first >= "a" && first <= "z") ||
    first === "_"
  )) return false;
  return Array.from(name.slice(1)).every(char =>
    (char >= "A" && char <= "Z") ||
    (char >= "a" && char <= "z") ||
    (char >= "0" && char <= "9") ||
    char === "_");
}

function scriptCandidates(tokens: readonly string[], cwd: string): string[] {
  const candidates = new Set<string>();
  for (const segment of commandSegments(tokens)) {
    const commandIndex = segment.findIndex(token => !isShellAssignment(token));
    if (commandIndex < 0) continue;
    const command = segment[commandIndex];
    const commandName = path.basename(command).toLowerCase();
    const direct = resolveCommandOperand(command, cwd);
    if (direct && hasShebang(direct.canonicalPath)) {
      candidates.add(direct.canonicalPath);
    }
    if (!SCRIPT_INTERPRETERS.has(commandName)) continue;
    const operands = segment.slice(commandIndex + 1);
    if (operands.includes("-c") || operands.includes("-e") || operands.includes("--eval")) continue;
    const script = operands.find(token => token !== "--" && !token.startsWith("-"));
    const resolved = script ? resolveCommandOperand(script, cwd) : undefined;
    if (resolved) candidates.add(resolved.canonicalPath);
  }
  return Array.from(candidates).sort();
}

function executableScripts(tokens: readonly string[], cwd: string): string[] {
  const scripts = new Set<string>();
  for (const candidate of scriptCandidates(tokens, cwd)) {
    const digest = hashFile(candidate);
    if (digest) scripts.add(`${candidate}:${digest}`);
  }
  return Array.from(scripts).sort();
}

export function commandReferencesExecutableScript(
  tokens: readonly string[],
  cwd: string,
): boolean {
  return scriptCandidates(tokens, cwd).length > 0;
}

export function contextualCommandFingerprint(
  input: SandboxCommandIdentityInput,
): string {
  const payload = {
    version: 1,
    command: input.command.trim(),
    cwd: canonical(input.cwd),
    reads: [...new Set(input.readPaths.map(canonical))].sort(),
    writes: [...new Set(input.writePaths.map(canonical))].sort(),
    scripts: executableScripts(input.commandTokens, input.cwd),
    policy: {
      profile: input.profile,
      network: input.network,
      writableRoots: [...new Set(input.writableRoots.map(canonical))].sort(),
      trustedReadRoots: [...new Set(input.trustedReadRoots.map(canonical))].sort(),
    },
  };
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 32);
}
