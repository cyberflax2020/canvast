/**
 * =============================================================================
 * Canvast — LSP Tools / 语言服务器协议工具
 * =============================================================================
 * @file        extensions/lsp-tools.ts
 * @brief       Bounded, shell-free code-intelligence fallback operations.
 * @description Adapted from Tallow/lsp (MIT) and opencode LSP patterns (MIT).
 *              Values supplied to the tool remain data and are never evaluated
 *              by a command shell.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * Changes: [2026-08-24] Replace shell-string fallback with bounded native IO.
 * =============================================================================
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { lstat, opendir, realpath } from "node:fs/promises";
import * as path from "node:path";

import {
  readSandboxedTextFile,
  SandboxFileAccessError,
  type FileIdentity,
} from "./sandbox-file-access.js";

type LspOperation = "goToDefinition" | "findReferences" | "hover" | "documentSymbol" | "workspaceSymbol";
type LspFailureCode = "cancelled" | "deadline_exceeded" | "scan_budget_exceeded";

export interface LspScanLimits {
  maxDepth: number;
  maxDirectories: number;
  maxNodes: number;
  maxFiles: number;
  maxTotalBytes: number;
  deadlineMs: number;
  yieldEveryNodes: number;
}

export interface LspScanStats {
  directories: number;
  nodes: number;
  files: number;
  sourceFiles: number;
  totalBytes: number;
  maxDepthSeen: number;
}

interface LspExtensionOptions {
  scanLimits?: Partial<LspScanLimits>;
  now?: () => number;
}

interface SourceFile {
  filePath: string;
  identity: FileIdentity;
}

interface ScanContext {
  signal?: AbortSignal;
  deadlineAt: number;
  limits: LspScanLimits;
  now: () => number;
  rootIdentity: FileIdentity;
}

const MAX_FILE_BYTES = 2_000_000;
export const DEFAULT_LSP_SCAN_LIMITS: Readonly<LspScanLimits> = Object.freeze({
  maxDepth: 32,
  maxDirectories: 10_000,
  maxNodes: 100_000,
  maxFiles: 20_000,
  maxTotalBytes: 64 * 1024 * 1024,
  deadlineMs: 5_000,
  yieldEveryNodes: 128,
});
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"]);
const EXCLUDED_DIRECTORIES = new Set([".git", ".runtime", ".pi", "dist", "node_modules", "coverage"]);
const DECLARATION_TOKENS = ["export ", "function ", "class ", "interface ", "const ", "def ", "async "];

class LspOperationError extends Error {
  readonly code: LspFailureCode;
  readonly details: Record<string, unknown>;

  constructor(code: LspFailureCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "LspOperationError";
    this.code = code;
    this.details = details;
  }
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function identityOf(stat: { dev: number; ino: number }): FileIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function scanStats(): LspScanStats {
  return { directories: 0, nodes: 0, files: 0, sourceFiles: 0, totalBytes: 0, maxDepthSeen: 0 };
}

function limitsFrom(options: LspExtensionOptions): LspScanLimits {
  const values = { ...DEFAULT_LSP_SCAN_LIMITS, ...options.scanLimits };
  const integer = (name: keyof LspScanLimits, minimum: number): number => {
    const value = values[name];
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
    }
    return value;
  };
  return {
    maxDepth: integer("maxDepth", 0),
    maxDirectories: integer("maxDirectories", 1),
    maxNodes: integer("maxNodes", 1),
    maxFiles: integer("maxFiles", 1),
    maxTotalBytes: integer("maxTotalBytes", 1),
    deadlineMs: integer("deadlineMs", 0),
    yieldEveryNodes: integer("yieldEveryNodes", 1),
  };
}

function controlFailure(context: ScanContext, stats: LspScanStats): void {
  if (context.signal?.aborted) {
    throw new LspOperationError("cancelled", "LSP operation was cancelled.", { stats: { ...stats } });
  }
  if (context.now() >= context.deadlineAt) {
    throw new LspOperationError(
      "deadline_exceeded",
      "LSP operation exceeded its scan deadline.",
      { deadlineMs: context.limits.deadlineMs, stats: { ...stats } },
    );
  }
}

function budgetFailure(
  budget: keyof Pick<LspScanLimits, "maxDepth" | "maxDirectories" | "maxNodes" | "maxFiles" | "maxTotalBytes">,
  observed: number,
  context: ScanContext,
  stats: LspScanStats,
): never {
  throw new LspOperationError(
    "scan_budget_exceeded",
    `LSP workspace scan exceeded ${budget}.`,
    { budget, limit: context.limits[budget], observed, stats: { ...stats } },
  );
}

async function yieldForCancellation(context: ScanContext, stats: LspScanStats): Promise<void> {
  if (stats.nodes % context.limits.yieldEveryNodes !== 0) return;
  await new Promise<void>(resolve => setImmediate(resolve));
  controlFailure(context, stats);
}

async function canonicalWorkspaceRoot(): Promise<{ path: string; identity: FileIdentity }> {
  const canonicalPath = await realpath(
    process.env.CANVAST_PROJECT_ROOT ||
    process.env.CANVAST_WORKING_DIR ||
    process.cwd(),
  );
  const stat = await lstat(canonicalPath);
  if (!stat.isDirectory()) throw new Error(`LSP workspace root is not a directory: ${canonicalPath}`);
  return { path: canonicalPath, identity: identityOf(stat) };
}

function isIdentifierCharacter(char: string): boolean {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    char === "_" || char === "$";
}

function firstIdentifier(line: string, preferredCharacter: number): string {
  const preferred = Math.max(0, Math.min(line.length - 1, Math.floor(preferredCharacter) - 1));
  if (line && isIdentifierCharacter(line[preferred])) {
    let start = preferred;
    let end = preferred + 1;
    while (start > 0 && isIdentifierCharacter(line[start - 1])) start -= 1;
    while (end < line.length && isIdentifierCharacter(line[end])) end += 1;
    return line.slice(start, end);
  }
  let start = 0;
  while (start < line.length && !isIdentifierCharacter(line[start])) start += 1;
  let end = start;
  while (end < line.length && isIdentifierCharacter(line[end])) end += 1;
  return line.slice(start, end);
}

async function scanWorkspaceSourceFiles(
  root: string,
  context: ScanContext,
): Promise<{ files: SourceFile[]; stats: LspScanStats }> {
  const files: SourceFile[] = [];
  const pending: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
  const visited = new Set<string>();
  const stats = scanStats();

  while (pending.length > 0) {
    controlFailure(context, stats);
    const current = pending.pop()!;
    stats.maxDepthSeen = Math.max(stats.maxDepthSeen, current.depth);
    if (current.depth > context.limits.maxDepth) {
      budgetFailure("maxDepth", current.depth, context, stats);
    }

    let directoryStat;
    try {
      directoryStat = await lstat(current.directory);
    } catch {
      continue;
    }
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) continue;

    let canonicalDirectory: string;
    try {
      canonicalDirectory = await realpath(current.directory);
    } catch {
      continue;
    }
    if (!isWithinRoot(root, canonicalDirectory)) continue;
    let canonicalStat;
    try {
      canonicalStat = await lstat(canonicalDirectory);
    } catch {
      continue;
    }
    if (!canonicalStat.isDirectory() || canonicalStat.isSymbolicLink()) continue;
    if (canonicalStat.dev !== directoryStat.dev || canonicalStat.ino !== directoryStat.ino) {
      throw new SandboxFileAccessError(
        "identity_changed",
        "LSP directory identity changed during workspace traversal.",
      );
    }
    const directoryIdentity = `d:${canonicalStat.dev}:${canonicalStat.ino}`;
    if (visited.has(directoryIdentity)) continue;
    visited.add(directoryIdentity);
    stats.directories += 1;
    if (stats.directories > context.limits.maxDirectories) {
      budgetFailure("maxDirectories", stats.directories, context, stats);
    }

    const directory = await opendir(canonicalDirectory);
    try {
      for await (const entry of directory) {
        controlFailure(context, stats);
        stats.nodes += 1;
        if (stats.nodes > context.limits.maxNodes) {
          budgetFailure("maxNodes", stats.nodes, context, stats);
        }
        await yieldForCancellation(context, stats);
        if (entry.isSymbolicLink() || EXCLUDED_DIRECTORIES.has(entry.name)) continue;

        const absolute = path.join(canonicalDirectory, entry.name);
        let stat;
        try {
          stat = await lstat(absolute);
        } catch {
          continue;
        }
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          const nextDepth = current.depth + 1;
          if (nextDepth > context.limits.maxDepth) {
            budgetFailure("maxDepth", nextDepth, context, stats);
          }
          pending.push({ directory: absolute, depth: nextDepth });
          continue;
        }
        if (!stat.isFile()) continue;

        const fileIdentity = `f:${stat.dev}:${stat.ino}`;
        if (visited.has(fileIdentity)) continue;
        visited.add(fileIdentity);
        stats.files += 1;
        if (stats.files > context.limits.maxFiles) {
          budgetFailure("maxFiles", stats.files, context, stats);
        }
        if (!SOURCE_EXTENSIONS.has(path.extname(entry.name)) || stat.size > MAX_FILE_BYTES) continue;
        const nextBytes = stats.totalBytes + stat.size;
        if (nextBytes > context.limits.maxTotalBytes) {
          stats.totalBytes = nextBytes;
          budgetFailure("maxTotalBytes", nextBytes, context, stats);
        }
        stats.totalBytes = nextBytes;
        stats.sourceFiles += 1;
        files.push({ filePath: absolute, identity: identityOf(stat) });
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
  }
  files.sort((left, right) => left.filePath.localeCompare(right.filePath));
  return { files, stats };
}

async function lineMatches(
  pi: ExtensionAPI,
  root: string,
  needle: string,
  maxMatches: number,
  context: ScanContext,
): Promise<string[]> {
  if (!needle) return [];
  const matches: string[] = [];
  const scanned = await scanWorkspaceSourceFiles(root, context);
  scanned.stats.totalBytes = 0;
  for (const file of scanned.files) {
    controlFailure(context, scanned.stats);
    const remainingBytes = context.limits.maxTotalBytes - scanned.stats.totalBytes;
    let opened;
    try {
      opened = await readSandboxedTextFile(pi, root, file.filePath, {
        maxBytes: Math.min(MAX_FILE_BYTES, remainingBytes),
        signal: context.signal,
        deadlineAt: context.deadlineAt,
        expectedIdentity: file.identity,
      expectedRootIdentity: context.rootIdentity,
        now: context.now,
      });
    } catch (error) {
      if (
        error instanceof SandboxFileAccessError &&
        error.code === "file_too_large" &&
        remainingBytes < MAX_FILE_BYTES
      ) {
        const observedFileBytes = Number(error.details.observed);
        budgetFailure(
          "maxTotalBytes",
          scanned.stats.totalBytes + (
            Number.isFinite(observedFileBytes) ? observedFileBytes : remainingBytes + 1
          ),
          context,
          scanned.stats,
        );
      }
      throw error;
    }
    scanned.stats.totalBytes += opened.bytes;
    const lines = opened.text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].includes(needle)) continue;
      matches.push(`${path.relative(root, opened.canonicalPath)}:${index + 1}:${lines[index]}`);
      if (matches.length >= maxMatches) return matches;
    }
  }
  return matches;
}

function documentSymbols(text: string): string[] {
  const lines = text.split("\n");
  const symbols: string[] = [];
  for (let index = 0; index < lines.length && symbols.length < 30; index += 1) {
    const trimmed = lines[index].trimStart();
    if (DECLARATION_TOKENS.some(token => trimmed.includes(token))) symbols.push(`${index + 1}:${lines[index]}`);
  }
  return symbols;
}

function failure(operation: LspOperation, error: unknown) {
  if (error instanceof SandboxFileAccessError || error instanceof LspOperationError) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: `LSP operation failed [${error.code}]: ${error.message}` }],
      details: { code: error.code, operation, ...error.details },
    };
  }
  return {
    isError: true,
    content: [{
      type: "text" as const,
      text: `LSP operation failed: ${error instanceof Error ? error.message : String(error)}`,
    }],
    details: { code: "operation_failed", operation },
  };
}

export function registerLspTools(pi: ExtensionAPI, options: LspExtensionOptions = {}): void {
  const limits = limitsFrom(options);
  const now = options.now || Date.now;
  pi.registerTool({
    name: "lsp",
    label: "LSP / 语言服务器",
    description: `Bounded code-intelligence fallback operations.
Operations: goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol.`,
    parameters: Type.Object({
      operation: Type.Union([
        Type.Literal("goToDefinition"), Type.Literal("findReferences"),
        Type.Literal("hover"), Type.Literal("documentSymbol"), Type.Literal("workspaceSymbol"),
      ]),
      file_path: Type.String({ description: "File path / 文件路径" }),
      line: Type.Number({ description: "Line number (1-based)" }),
      character: Type.Number({ description: "Character offset (1-based)" }),
      query: Type.Optional(Type.String({ description: "Symbol query (workspaceSymbol only)" })),
    }),
    async execute(_id: string, params: any, signal?: AbortSignal) {
      const operation = params.operation as LspOperation;
      const line = Number(params.line);
      const character = Number(params.character);
      try {
        if (!Number.isInteger(line) || line < 1 || !Number.isInteger(character) || character < 1) {
          throw new Error("line and character must be positive integers");
        }
        const startedAt = now();
        const workspace = await canonicalWorkspaceRoot();
        const root = workspace.path;
        const context: ScanContext = {
          signal,
          deadlineAt: startedAt + limits.deadlineMs,
          limits,
          now,
          rootIdentity: workspace.identity,
        };
        controlFailure(context, scanStats());
        const suppliedFilePath = String(params.file_path || "");
        const opened = await readSandboxedTextFile(pi, root, suppliedFilePath, {
          maxBytes: MAX_FILE_BYTES,
          signal,
          deadlineAt: context.deadlineAt,
          expectedRootIdentity: context.rootIdentity,
          now,
        });
        let result: string;
        if (operation === "documentSymbol") {
          const symbols = documentSymbols(opened.text);
          result = `# Document Symbols: ${path.relative(root, opened.canonicalPath)}\n\`\`\`\n${symbols.join("\n") || "No matches."}\n\`\`\``;
        } else if (operation === "workspaceSymbol") {
          const query = typeof params.query === "string" ? params.query : "";
          if (!query) throw new Error("query required for workspaceSymbol");
          const hits = await lineMatches(pi, root, query, 20, context);
          result = `# Workspace Symbols: ${JSON.stringify(query)}\n\`\`\`\n${hits.join("\n") || "No matches."}\n\`\`\``;
        } else if (operation === "goToDefinition" || operation === "findReferences") {
          const sourceLine = opened.text.split("\n")[line - 1];
          if (sourceLine === undefined) throw new Error(`Line ${line} is outside ${suppliedFilePath}`);
          const word = firstIdentifier(sourceLine, character);
          if (!word) throw new Error(`No identifier found at ${suppliedFilePath}:${line}:${character}`);
          const hits = await lineMatches(
            pi,
            root,
            word,
            operation === "goToDefinition" ? 10 : 20,
            context,
          );
          const title = operation === "goToDefinition" ? "Go to Definition" : "Find References";
          result = `# ${title}: ${JSON.stringify(word)}\n\`\`\`\n${hits.join("\n") || "No matches."}\n\`\`\``;
        } else {
          result = `# Hover: ${path.relative(root, opened.canonicalPath)}:${line}:${character}\n(bounded fallback — use a configured language server for semantic hover details.)`;
        }
        return { content: [{ type: "text" as const, text: result }], details: undefined };
      } catch (error) {
        return failure(operation, error);
      }
    },
  });
}

export default function (pi: ExtensionAPI) {
  registerLspTools(pi);
}
