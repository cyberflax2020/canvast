/**
 * =============================================================================
 * Canvast — Harness Search Tools / 搜索工具
 * =============================================================================
 * @file        extensions/canvast-harness/search-tools.ts
 * @brief       Read-only local search helpers for the Canvast harness.
 * @description Keeps native local-search tool registration and activation
 *              outside the main harness extension so the control-plane wiring
 *              stays focused on lifecycle hooks and runtime gating.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "fs";
import * as path from "path";

const DEFAULT_CONTENT_SEARCH_EXCLUDES = [
  "node_modules",
  ".git",
  ".runtime",
  "dist",
  "build",
  "coverage",
  ".next",
  "out",
];

function canonical(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    let dir = path.dirname(resolved);
    const missing = [path.basename(resolved)];
    while (dir && path.dirname(dir) !== dir && !fs.existsSync(dir)) {
      missing.unshift(path.basename(dir));
      dir = path.dirname(dir);
    }
    try {
      const realParent = fs.realpathSync.native(dir);
      return path.join(realParent, ...missing);
    } catch {
      return resolved;
    }
  }
}

let activeProjectRootOverride: string | undefined;

export function setActiveProjectRoot(projectRoot: string | undefined): void {
  activeProjectRootOverride = projectRoot?.trim() ? canonical(projectRoot) : undefined;
}

export function currentProjectRoot(): string {
  return process.env.CANVAST_PROJECT_ROOT ||
    process.env.CANVAST_WORKING_DIR ||
    process.cwd() ||
    activeProjectRootOverride ||
    path.resolve(".");
}

export function ensureNativeLocalSearchTools(pi: ExtensionAPI): boolean {
  const getActiveTools = (pi as any).getActiveTools;
  const setActiveTools = (pi as any).setActiveTools;
  if (typeof getActiveTools !== "function" || typeof setActiveTools !== "function") return false;
  try {
    const active = getActiveTools.call(pi);
    if (!Array.isArray(active)) return false;
    const next = Array.from(new Set([...active, "content_search", "grep", "find", "ls"]));
    if (next.length === active.length) return false;
    setActiveTools.call(pi, next);
    return true;
  } catch {
    return false;
  }
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeExtension(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return "";
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function isNonEmptyString(value: string): value is string {
  return value.length > 0;
}

function outputPath(cwd: string, file: string): string {
  const relative = path.relative(cwd, file);
  return relative && !relative.startsWith("..") ? relative : file;
}

function pathParts(value: string): string[] {
  return value.split(path.sep).filter(isNonEmptyString);
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function shouldSkipDirectory(entryName: string, excludes: Set<string>): boolean {
  return excludes.has(entryName);
}

function matchesFindPattern(relativePath: string, pattern: string): boolean {
  const normalizedPattern = pattern.trim() || "**";
  const normalizedPath = toPosixPath(relativePath);
  if ((path as any).matchesGlob?.(normalizedPath, normalizedPattern)) return true;
  if (!normalizedPattern.includes("/")) {
    return (path as any).matchesGlob?.(path.posix.basename(normalizedPath), normalizedPattern) === true;
  }
  return false;
}

function inferFindSearchRoot(
  cwd: string,
  rawPattern: string,
  rawSearchPath: unknown,
): { searchRoot: string; pattern: string; requestedPath: string } {
  const requestedPath = typeof rawSearchPath === "string" && rawSearchPath.trim() ? rawSearchPath.trim() : ".";
  const pattern = String(rawPattern || "**").trim() || "**";
  const searchRoot = path.resolve(cwd, requestedPath);
  return { searchRoot, pattern, requestedPath };
}

function registerFindTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "find",
    label: "Find / 文件查找",
    description:
      "Read-only file discovery by glob pattern with built-in generated-directory excludes. Supports path-containing patterns such as src/**/*.ts without shell or fd.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Glob pattern such as *.ts, **/*.json, or src/**/*.spec.ts." }),
      path: Type.Optional(Type.String({ description: "Directory to search in. Defaults to current project root." })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 5000 })),
      exclude_dirs: Type.Optional(Type.Array(Type.String({ description: "Directory names to skip." }))),
    }),
    async execute(_id: string, params: any, _signal?: AbortSignal) {
      const cwd = currentProjectRoot();
      const { searchRoot, pattern, requestedPath } = inferFindSearchRoot(cwd, params.pattern, params.path);
      if (!isPathInside(cwd, searchRoot)) {
        return { isError: true, content: [{ type: "text" as const, text: "path must stay inside the current project root" }], details: undefined };
      }
      const excludes = new Set([
        ...DEFAULT_CONTENT_SEARCH_EXCLUDES,
        ...(Array.isArray(params.exclude_dirs) ? params.exclude_dirs.map((item: unknown) => String(item || "").trim()).filter(isNonEmptyString) : []),
      ]);
      const maxResults = Math.max(1, Math.min(5000, Number(params.limit || 1000)));
      const results: string[] = [];
      let skipped = 0;
      let scanned = 0;
      let truncated = false;

      const visitFile = (file: string): void => {
        if (results.length >= maxResults) {
          truncated = true;
          return;
        }
        const relative = outputPath(cwd, file);
        scanned += 1;
        if (matchesFindPattern(relative, pattern)) results.push(relative);
      };

      const visit = (target: string): void => {
        if (results.length >= maxResults) {
          truncated = true;
          return;
        }
        let stat: fs.Stats;
        try {
          stat = fs.statSync(target);
        } catch {
          skipped += 1;
          return;
        }
        if (stat.isFile()) {
          visitFile(target);
          return;
        }
        if (!stat.isDirectory()) return;
        if (target !== searchRoot) {
          const parts = pathParts(path.relative(searchRoot, target));
          if (parts.some(part => shouldSkipDirectory(part, excludes))) {
            skipped += 1;
            return;
          }
        }
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(target, { withFileTypes: true });
        } catch {
          skipped += 1;
          return;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory() && shouldSkipDirectory(entry.name, excludes)) {
            skipped += 1;
            continue;
          }
          visit(path.join(target, entry.name));
          if (results.length >= maxResults) {
            truncated = true;
            return;
          }
        }
      };

      visit(searchRoot);
      return {
        content: [{ type: "text" as const, text: results.length ? results.join("\n") : "No files found matching pattern" }],
        details: {
          pattern,
          path: requestedPath,
          returned: results.length,
          files: results,
          scannedFiles: scanned,
          skippedEntries: skipped,
          truncated,
        },
      };
    },
  });
}

function registerContentSearchTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "content_search",
    label: "Content Search / 内容搜索",
    description:
      "Read-only local content search that uses one or more literal text queries, extension filters, default generated-directory excludes, and can return unique matching file paths. Prefer this over bash grep/find for local_search tasks that need file lists or multi-pattern scans.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Literal text to search for. This is not a regex." })),
      queries: Type.Optional(Type.Array(Type.String({ description: "Literal text queries. A file matches when any query is present." }))),
      roots: Type.Optional(Type.Array(Type.String({ description: "Relative roots to scan. Defaults to current project root." }))),
      extensions: Type.Optional(Type.Array(Type.String({ description: "File extensions such as .ts or ts." }))),
      output: Type.Optional(Type.Union([Type.Literal("files"), Type.Literal("snippets")])),
      case_sensitive: Type.Optional(Type.Boolean()),
      max_results: Type.Optional(Type.Number({ minimum: 1, maximum: 2000 })),
      max_file_bytes: Type.Optional(Type.Number({ minimum: 1, maximum: 5_000_000 })),
      exclude_dirs: Type.Optional(Type.Array(Type.String({ description: "Directory names to skip." }))),
    }),
    async execute(_id: string, params: any, _signal?: AbortSignal) {
      const cwd = currentProjectRoot();
      const queries = Array.from(new Set([
        ...(typeof params.query === "string" && params.query ? [params.query] : []),
        ...(Array.isArray(params.queries) ? params.queries : []),
      ].map((item: unknown) => String(item || "").trim()).filter(isNonEmptyString)));
      if (queries.length === 0) {
        return { isError: true, content: [{ type: "text" as const, text: "query or queries is required" }], details: undefined };
      }
      const roots = Array.isArray(params.roots) && params.roots.length > 0
        ? params.roots.map((item: unknown) => String(item || "."))
        : ["."];
      const extensions: string[] = Array.isArray(params.extensions)
        ? params.extensions.map((item: unknown) => normalizeExtension(String(item || ""))).filter(isNonEmptyString)
        : [];
      const excludes = Array.from(new Set([
        ...DEFAULT_CONTENT_SEARCH_EXCLUDES,
        ...(Array.isArray(params.exclude_dirs) ? params.exclude_dirs.map((item: unknown) => String(item || "").trim()).filter(isNonEmptyString) : []),
      ]));
      const output = params.output === "snippets" ? "snippets" : "files";
      const caseSensitive = params.case_sensitive !== false;
      const maxResults = Math.max(1, Math.min(2000, Number(params.max_results || 500)));
      const maxFileBytes = Math.max(1, Math.min(5_000_000, Number(params.max_file_bytes || 1_000_000)));
      const needles = caseSensitive ? queries : queries.map(query => query.toLowerCase());
      const files: string[] = [];
      const snippets: string[] = [];
      let scannedFiles = 0;
      let skippedFiles = 0;
      let truncated = false;

      const scanFile = (file: string): void => {
        if (files.length >= maxResults && output === "files") {
          truncated = true;
          return;
        }
        if (extensions.length > 0 && !extensions.some(ext => file.toLowerCase().endsWith(ext))) return;
        let stat: fs.Stats;
        try {
          stat = fs.statSync(file);
        } catch {
          skippedFiles += 1;
          return;
        }
        if (!stat.isFile() || stat.size > maxFileBytes) {
          skippedFiles += 1;
          return;
        }
        let text: string;
        try {
          text = fs.readFileSync(file, "utf-8");
        } catch {
          skippedFiles += 1;
          return;
        }
        scannedFiles += 1;
        const haystack = caseSensitive ? text : text.toLowerCase();
        const matchingNeedles = needles.filter(needle => haystack.includes(needle));
        if (matchingNeedles.length === 0) return;
        const relative = outputPath(cwd, file);
        if (!files.includes(relative)) files.push(relative);
        if (output === "snippets") {
          const lines = text.split("\n");
          for (let i = 0; i < lines.length; i += 1) {
            const line = caseSensitive ? lines[i] : lines[i].toLowerCase();
            if (!needles.some(needle => line.includes(needle))) continue;
            snippets.push(`${relative}:${i + 1}: ${lines[i].slice(0, 500)}`);
            if (snippets.length >= maxResults) {
              truncated = true;
              return;
            }
          }
        }
      };

      const scanDir = (dir: string): void => {
        if ((output === "files" ? files.length : snippets.length) >= maxResults) {
          truncated = true;
          return;
        }
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          skippedFiles += 1;
          return;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue;
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (!excludes.includes(entry.name)) scanDir(fullPath);
          } else {
            scanFile(fullPath);
          }
          if ((output === "files" ? files.length : snippets.length) >= maxResults) {
            truncated = true;
            return;
          }
        }
      };

      for (const root of roots) {
        const resolved = path.resolve(cwd, root);
        if (!isPathInside(cwd, resolved)) {
          skippedFiles += 1;
          continue;
        }
        if (resolved !== cwd && excludes.includes(path.basename(resolved))) {
          skippedFiles += 1;
          continue;
        }
        try {
          const stat = fs.statSync(resolved);
          if (stat.isDirectory()) scanDir(resolved);
          else scanFile(resolved);
        } catch {
          skippedFiles += 1;
        }
      }

      const result = output === "snippets" ? snippets : files;
      return {
        content: [{ type: "text" as const, text: result.length > 0 ? result.join("\n") : "No matches found" }],
        details: {
          query: queries[0],
          queries,
          roots,
          extensions,
          output,
          files,
          returned: result.length,
          matchedFiles: files.length,
          scannedFiles,
          skippedFiles,
          truncated,
        },
      };
    },
  });
}

export function registerHarnessSearchTools(pi: ExtensionAPI): void {
  registerFindTool(pi);
  registerContentSearchTool(pi);
}
