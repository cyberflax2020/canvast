/**
 * =============================================================================
 * Canvast — Canvas RepoMap / 画布代码地图
 * =============================================================================
 * @file        extensions/canvas-repomap.ts
 * @brief       Code structure awareness — file tags, imports, symbol extraction
 * @description Ported from aider/repomap.py (Apache 2.0). Maps codebase structure
 *              into Canvas File nodes with symbol-level detail. Gives agents
 *              "project perception" without reading every file.
 *              从 aider repomap.py (Apache 2.0) 移植。将代码结构映射到 Canvas。
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * Changes: [2026-08-08] Initial — from aider/repomap.py algorithm (Apache 2.0)
 * =============================================================================
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

interface FileTag {
  name: string;
  kind: string;       // function, class, method, interface, const, import
  line: number;
  signature?: string;
}

/**
 * Extract symbols from a file using regex-based parsing.
 * (Phase 2: replace with tree-sitter for accuracy matching aider's approach)
 */
function extractSymbols(filePath: string, content: string): FileTag[] {
  const tags: FileTag[] = [];
  const lines = content.split("\n");
  const ext = extname(filePath);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // TypeScript/JavaScript
    if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx") {
      const fnMatch = line.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
      if (fnMatch) { tags.push({ name: fnMatch[1], kind: "function", line: lineNum, signature: line.trim() }); continue; }

      const classMatch = line.match(/(?:export\s+)?class\s+(\w+)/);
      if (classMatch) { tags.push({ name: classMatch[1], kind: "class", line: lineNum, signature: line.trim() }); continue; }

      const methodMatch = line.match(/(?:async\s+)?(\w+)\s*\([^)]*\)\s*{/);
      if (methodMatch && !line.includes("function") && !line.includes("if") && !line.includes("for") && !line.includes("while")) {
        tags.push({ name: methodMatch[1], kind: "method", line: lineNum, signature: line.trim() }); continue;
      }

      const constMatch = line.match(/(?:export\s+)?const\s+(\w+)\s*[=:]/);
      if (constMatch) { tags.push({ name: constMatch[1], kind: "const", line: lineNum }); continue; }

      const intMatch = line.match(/(?:export\s+)?interface\s+(\w+)/);
      if (intMatch) { tags.push({ name: intMatch[1], kind: "interface", line: lineNum, signature: line.trim() }); continue; }

      const importMatch = line.match(/import\s+.*from\s*['"]([^'"]+)['"]/);
      if (importMatch) { tags.push({ name: importMatch[1], kind: "import", line: lineNum }); }
    }

    // Python
    if (ext === ".py") {
      const defMatch = line.match(/(?:async\s+)?def\s+(\w+)/);
      if (defMatch) { tags.push({ name: defMatch[1], kind: "function", line: lineNum }); continue; }
      const classMatch = line.match(/class\s+(\w+)/);
      if (classMatch) { tags.push({ name: classMatch[1], kind: "class", line: lineNum }); continue; }
    }
  }

  return tags;
}

/**
 * Scan a directory recursively, extracting symbols from code files.
 * Ported from aider's RepoMap.get_repo_files() + get_tags() algorithm.
 */
const DEFAULT_MAX_FILES = 200;
const DEFAULT_MAX_DEPTH = 20;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const MAX_SOURCE_FILE_BYTES = 500_000;

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function readPinnedFile(file: string, expected: Stats): string | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino) return undefined;
    const content = readFileSync(descriptor, "utf-8");
    const after = fstatSync(descriptor);
    if (after.dev !== opened.dev || after.ino !== opened.ino) return undefined;
    return content;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function scanProject(
  requestedRoot: string,
  options: { maxFiles?: number; maxDepth?: number; maxBytes?: number } = {},
): Array<{ file: string; tags: FileTag[]; size: number }> {
  const results: Array<{ file: string; tags: FileTag[]; size: number }> = [];
  const ignore = new Set(["node_modules", ".git", "dist", "__pycache__", ".venv", "pi-data"]);
  const maxFiles = Math.max(1, Math.min(10_000, Math.floor(options.maxFiles ?? DEFAULT_MAX_FILES)));
  const maxDepth = Math.max(0, Math.min(100, Math.floor(options.maxDepth ?? DEFAULT_MAX_DEPTH)));
  const maxBytes = Math.max(1, Math.min(1024 * 1024 * 1024, Math.floor(options.maxBytes ?? DEFAULT_MAX_BYTES)));
  const requestedStat = lstatSync(requestedRoot);
  if (!requestedStat.isDirectory() || requestedStat.isSymbolicLink()) {
    throw new Error("RepoMap root must be a regular non-symlink directory.");
  }
  const rootDir = realpathSync.native(requestedRoot);
  const visited = new Set<string>();
  let scannedBytes = 0;

  function walk(dir: string, depth: number) {
    if (results.length >= maxFiles || scannedBytes >= maxBytes || depth > maxDepth) return;
    try {
      const canonicalDir = realpathSync.native(dir);
      if (!isContained(rootDir, canonicalDir)) return;
      const directoryStat = lstatSync(canonicalDir);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return;
      const identity = `${directoryStat.dev}:${directoryStat.ino}`;
      if (visited.has(identity)) return;
      visited.add(identity);
      for (const entry of readdirSync(dir)) {
        if (results.length >= maxFiles || scannedBytes >= maxBytes) break;
        if (ignore.has(entry) || entry.startsWith(".")) continue;
        const fullPath = join(dir, entry);
        try {
          const stat = lstatSync(fullPath);
          if (stat.isSymbolicLink()) continue;
          if (stat.isDirectory()) {
            walk(fullPath, depth + 1);
          } else if (stat.isFile() && stat.size < MAX_SOURCE_FILE_BYTES && /\.(ts|tsx|js|jsx|py|rs|go|java)$/.test(entry)) {
            const fileIdentity = `${stat.dev}:${stat.ino}`;
            if (visited.has(fileIdentity)) continue;
            visited.add(fileIdentity);
            const canonicalFile = realpathSync.native(fullPath);
            if (!isContained(rootDir, canonicalFile)) continue;
            if (scannedBytes + stat.size > maxBytes) break;
            const content = readPinnedFile(canonicalFile, stat);
            if (content === undefined) continue;
            const relPath = relative(rootDir, canonicalFile);
            const tags = extractSymbols(relPath, content);
            results.push({ file: relPath, tags, size: stat.size });
            scannedBytes += stat.size;
          }
        } catch { /* skip unreadable */ }
      }
    } catch { /* skip unreadable dirs */ }
  }

  walk(rootDir, 0);
  return results;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "canvas_repomap",
    label: "Canvas RepoMap / 代码地图",
    description: `Scan the project and build a code structure map in Canvas.
Extracts functions, classes, interfaces, imports from all source files.
Gives agents "project perception" — know what's in the codebase without
reading every file. Ported from aider/repomap.py (Apache 2.0).`,
    parameters: Type.Object({
      directory: Type.Optional(Type.String({ description: "Directory to scan (default: cwd)" })),
      max_files: Type.Optional(Type.Number({ description: "Max files to scan (default: 200)", default: 200 })),
      max_depth: Type.Optional(Type.Number({ description: "Max directory depth (default: 20)", default: 20 })),
      max_bytes: Type.Optional(Type.Number({ description: "Max source bytes read (default: 10 MiB)", default: DEFAULT_MAX_BYTES })),
    }),
    async execute(_id: string, params: any) {
      const dir = resolve(params.directory || process.cwd());

      if (!existsSync(dir)) {
        return { isError: true, content: [{ type: "text" as const, text: `Directory not found: ${dir}` }], details: undefined };
      }

      let results: ReturnType<typeof scanProject>;
      try {
        results = scanProject(dir, {
          maxFiles: params.max_files,
          maxDepth: params.max_depth,
          maxBytes: params.max_bytes,
        });
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `RepoMap scan failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: undefined,
        };
      }
      const totalSymbols = results.reduce((sum, r) => sum + r.tags.length, 0);

      // Build summary by kind
      const byKind: Record<string, number> = {};
      for (const r of results) {
        for (const t of r.tags) {
          byKind[t.kind] = (byKind[t.kind] || 0) + 1;
        }
      }

      // Top files by symbol count
      const topFiles = results
        .sort((a, b) => b.tags.length - a.tags.length)
        .slice(0, 15)
        .map(r => `- \`${r.file}\` (${r.tags.length} symbols, ${r.size} bytes)`)
        .join("\n");

      const summary = [
        "# RepoMap / 代码地图",
        `Scanned: ${results.length} files, ${totalSymbols} symbols`,
        "",
        "## Symbols by Kind / 按类型",
        ...Object.entries(byKind).map(([k, v]) => `  ${k}: ${v}`),
        "",
        "## Top Files / 符号最多的文件",
        topFiles,
        "",
        `---`,
        `*RepoMap data can be stored as Canvas File nodes for persistent project perception.*`,
      ].join("\n");

      return {
        content: [{ type: "text" as const, text: summary }],
        details: { filesScanned: results.length, totalSymbols, byKind },
      };
    },
  });
}
