/**
 * =============================================================================
 * Canvast — Context Recall Storage / Canvast 源文件
 * =============================================================================
 * @file        src/harness/context-recall-storage.ts
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { estimateTokens } from "./context-budgeting.js";
import { readSafeJson, writeSafeJson } from "./safe-json-file.js";
import type {
  ContextRecallArchive,
  ContextRecallKind,
  ContextRecallLifecycleOptions,
  ContextRecallPointer,
  ContextRecallRecord,
  ContextRecallSelectionOptions,
  ContextRecallSource,
  ContextRecallStorageStatus,
  SelectedContextRecallRecord,
} from "./context-recall.js";

export const CONTEXT_RECALL_HOT_RECORDS = 240;
export const DEFAULT_CONTEXT_RECALL_MAX_ARCHIVE_RECORDS = 20_000;
export const DEFAULT_CONTEXT_RECALL_MAX_STORAGE_BYTES = 256 * 1024 * 1024;
export const DEFAULT_CONTEXT_RECALL_WARN_RATIO = 0.8;
export const DEFAULT_CONTEXT_RECALL_PRUNE_WINDOW_DAYS = 7;

const DEFAULT_TEXT_SUMMARY_CHARS = 220;
const DEFAULT_RECALL_SELECTION_LIMIT = 5;
const DEFAULT_RECALL_TOKEN_BUDGET = 1_200;
const DEFAULT_RECALL_EXCERPT_CHARS = 700;

function contextRecallDir(agentDir: string): string {
  return path.join(agentDir, "context-recall");
}

export function contextRecallArchiveFile(agentDir: string): string {
  return path.join(contextRecallDir(agentDir), "archive-index.json");
}

export function contextRecallRecoveryFile(agentDir: string): string {
  return path.join(contextRecallDir(agentDir), "recovery-plan.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(item => typeof item === "string") : [];
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeKind(value: unknown): ContextRecallKind {
  if (
    value === "turn" ||
    value === "message" ||
    value === "input" ||
    value === "compaction" ||
    value === "branch_summary" ||
    value === "long_text" ||
    value === "attachment"
  ) return value;
  return "message";
}

function normalizeSource(value: unknown): ContextRecallSource {
  if (value === "session" || value === "input" || value === "compaction" || value === "branch" || value === "runtime") return value;
  return "session";
}

function normalizePointer(value: unknown): ContextRecallPointer {
  const pointer = isRecord(value) ? value : {};
  return {
    sessionFile: asString(pointer.sessionFile) || undefined,
    sessionId: asString(pointer.sessionId) || undefined,
    entryId: asString(pointer.entryId) || undefined,
    parentId: typeof pointer.parentId === "string" || pointer.parentId === null ? pointer.parentId : undefined,
    spillFile: asString(pointer.spillFile) || undefined,
    managedExcerpt: pointer.managedExcerpt === true || undefined,
  };
}

function normalizeRecord(value: unknown, index: number, now: string): ContextRecallRecord | undefined {
  if (!isRecord(value)) return undefined;
  const id = asString(value.id, `recall-${index}`);
  const title = asString(value.title, "Recall record");
  const summary = asString(value.summary, "");
  if (!id || !title) return undefined;
  return {
    id,
    kind: normalizeKind(value.kind),
    source: normalizeSource(value.source),
    title,
    summary,
    timestamp: asString(value.timestamp, now),
    tokensEstimate: asNumber(value.tokensEstimate),
    charCount: asNumber(value.charCount),
    pointer: normalizePointer(value.pointer),
    relatedEntryIds: asStringArray(value.relatedEntryIds),
    tags: asStringArray(value.tags),
  };
}

function uniqueRecords(records: ContextRecallRecord[]): ContextRecallRecord[] {
  const byId = new Map<string, ContextRecallRecord>();
  for (const record of records) byId.set(record.id, record);
  return Array.from(byId.values());
}

export function emptyContextRecallArchive(now = new Date().toISOString()): ContextRecallArchive {
  return {
    version: 1,
    updatedAt: now,
    records: [],
    archivedTotal: 0,
  };
}

export function readContextRecallArchive(agentDir: string): ContextRecallArchive {
  const now = new Date().toISOString();
  const file = contextRecallArchiveFile(agentDir);
  const loaded = readSafeJson<unknown>(file);
  if (loaded.status === "missing") return emptyContextRecallArchive(now);
  if (loaded.status === "corrupt") {
    throw new Error(`Context recall archive is corrupt: ${loaded.error}`);
  }
  if (!isRecord(loaded.value) || !Array.isArray(loaded.value.records)) {
    throw new Error("Context recall archive has an invalid schema.");
  }
  const records = loaded.value.records
    .map((item, index) => normalizeRecord(item, index, now))
    .filter((item): item is ContextRecallRecord => Boolean(item));
  return {
    version: 1,
    updatedAt: asString(loaded.value.updatedAt, now),
    records,
    archivedTotal: asNumber(loaded.value.archivedTotal, records.length),
  };
}

function writeContextRecallArchive(agentDir: string, archive: ContextRecallArchive, options: ContextRecallLifecycleOptions = {}): void {
  const maxArchiveRecords = options.maxArchiveRecords ?? DEFAULT_CONTEXT_RECALL_MAX_ARCHIVE_RECORDS;
  writeSafeJson(contextRecallArchiveFile(agentDir), {
    version: 1,
    updatedAt: archive.updatedAt,
    records: uniqueRecords(archive.records).slice(-maxArchiveRecords),
    archivedTotal: archive.archivedTotal,
  });
}

export function archiveContextRecallRecords(agentDir: string, records: ContextRecallRecord[], options: ContextRecallLifecycleOptions = {}): void {
  if (!records.length) return;
  const now = options.now || new Date().toISOString();
  const archive = readContextRecallArchive(agentDir);
  writeContextRecallArchive(agentDir, {
    version: 1,
    updatedAt: now,
    records: [...archive.records.filter(item => !records.some(record => record.id === item.id)), ...records],
    archivedTotal: archive.archivedTotal + records.length,
  }, options);
}

function fingerprint(parts: string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 12);
}

function compactWhitespace(text: string): string {
  let out = "";
  let pendingSpace = false;
  for (const char of text) {
    if (char.trim() === "") {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) out += " ";
    out += char;
    pendingSpace = false;
  }
  return out.trim();
}

function summarizeText(text: string, max = DEFAULT_TEXT_SUMMARY_CHARS): string {
  const compact = compactWhitespace(text);
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(0, max - 1))}...`;
}

function pathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function listRecallFiles(agentDir: string): string[] {
  const root = contextRecallDir(agentDir);
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) out.push(file);
    }
  };
  visit(root);
  return out;
}

function fileBytes(file: string): number {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() ? stat.size : 0;
  } catch {
    return 0;
  }
}

function managedExcerptPath(agentDir: string, file: string | undefined): string | undefined {
  if (!file) return undefined;
  const root = contextRecallDir(agentDir);
  const resolved = path.resolve(file);
  if (!pathInside(root, resolved)) return undefined;
  return resolved;
}

function pointerIdentity(pointer: ContextRecallPointer): string {
  return [
    pointer.sessionFile || "",
    pointer.sessionId || "",
    pointer.entryId || "",
    pointer.parentId || "",
    pointer.spillFile || "",
  ].join("\u0000");
}

function hasDurableOriginalPointer(record: ContextRecallRecord): boolean {
  const pointer = record.pointer;
  if (pointer.sessionFile && (pointer.entryId || pointer.sessionId)) return true;
  return Boolean(pointer.spillFile && pointer.managedExcerpt !== true);
}

function canReclaimManagedExcerpt(agentDir: string, record: ContextRecallRecord): string | undefined {
  if (record.pointer.managedExcerpt !== true) return undefined;
  if (!hasDurableOriginalPointer({ ...record, pointer: { ...record.pointer, spillFile: undefined, managedExcerpt: undefined } })) {
    return undefined;
  }
  return managedExcerptPath(agentDir, record.pointer.spillFile);
}

function readFilePrefix(file: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  let fd: number | undefined;
  try {
    const expected = fs.lstatSync(file);
    if (!expected.isFile() || expected.isSymbolicLink()) return "";
    const size = Math.min(expected.size, Math.max(256, maxChars * 4));
    const buffer = Buffer.alloc(size);
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino) return "";
    const bytes = fs.readSync(fd, buffer, 0, size, 0);
    const after = fs.fstatSync(fd);
    if (after.dev !== opened.dev || after.ino !== opened.ino) return "";
    return buffer.subarray(0, bytes).toString("utf-8").slice(0, maxChars);
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function archiveOrphanExcerpts(agentDir: string, referenced: Set<string>, now: string): number {
  const root = contextRecallDir(agentDir);
  const orphanFiles = listRecallFiles(agentDir)
    .filter(file => file.endsWith(".txt"))
    .filter(file => pathInside(root, file))
    .filter(file => !referenced.has(path.resolve(file)));
  if (!orphanFiles.length) return 0;
  const archive = readContextRecallArchive(agentDir);
  const recovered = orphanFiles.map((file): ContextRecallRecord => {
    const summary = summarizeText(readFilePrefix(file, DEFAULT_TEXT_SUMMARY_CHARS), DEFAULT_TEXT_SUMMARY_CHARS) || path.basename(file);
    return {
      id: `recall-${fingerprint(["orphan", file, String(fileBytes(file))])}`,
      kind: "attachment",
      source: "runtime",
      title: "Recovered recall excerpt",
      summary,
      timestamp: now,
      tokensEstimate: estimateTokens(summary),
      charCount: fileBytes(file),
      pointer: { spillFile: file },
      relatedEntryIds: [],
      tags: ["archive", "orphan-excerpt", "original-pointer"],
    };
  });
  writeContextRecallArchive(agentDir, {
    version: 1,
    updatedAt: now,
    records: [...archive.records, ...recovered],
    archivedTotal: archive.archivedTotal + recovered.length,
  });
  return recovered.length;
}

function storageStatusFor(
  agentDir: string,
  hotRecords: ContextRecallRecord[],
  archiveRecords: ContextRecallRecord[],
  options: ContextRecallLifecycleOptions,
  reclaimedBytes: number,
  orphanFiles: number,
): ContextRecallStorageStatus {
  const maxBytes = options.maxStorageBytes ?? DEFAULT_CONTEXT_RECALL_MAX_STORAGE_BYTES;
  const warnAtRatio = options.warnAtRatio ?? DEFAULT_CONTEXT_RECALL_WARN_RATIO;
  const warnAtBytes = Math.max(1, Math.floor(maxBytes * warnAtRatio));
  const files = listRecallFiles(agentDir);
  const directoryBytes = files.reduce((sum, file) => sum + fileBytes(file), 0);
  const excerptPointers = new Set(
    [...hotRecords, ...archiveRecords]
      .map(record => managedExcerptPath(agentDir, record.pointer.spillFile))
      .filter((file): file is string => Boolean(file)),
  );
  const excerptBytes = Array.from(excerptPointers).reduce((sum, file) => sum + fileBytes(file), 0);
  const overBudget = directoryBytes > maxBytes;
  const nearBudget = directoryBytes >= warnAtBytes;
  const warning = overBudget
    ? `Context recall storage is over budget (${directoryBytes}/${maxBytes} bytes). Original pointers are preserved; expand CANVAST_CONTEXT_RECALL_MAX_BYTES or archive the project state directory.`
    : nearBudget
      ? `Context recall storage is near budget (${directoryBytes}/${maxBytes} bytes). Canvast will keep hot summaries and source pointers, and reclaim only redundant managed excerpts.`
      : undefined;
  return {
    directoryBytes,
    excerptBytes,
    maxBytes,
    warnAtBytes,
    overBudget,
    nearBudget,
    hotRecords: hotRecords.length,
    archiveRecords: archiveRecords.length,
    orphanFiles,
    reclaimedBytes,
    warning,
  };
}

function archiveRecordTime(record: ContextRecallRecord): number {
  const parsed = Date.parse(record.timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function oldestArchiveWindow(records: ContextRecallRecord[], days: number): Set<string> {
  const timed = records
    .filter(record => !record.tags.includes("storage-pruned"))
    .map(record => ({ record, time: archiveRecordTime(record) }))
    .filter(item => item.time > 0)
    .sort((a, b) => a.time - b.time);
  if (!timed.length) return new Set();
  const start = timed[0].time;
  const cutoff = start + Math.max(1, days) * 24 * 60 * 60 * 1000;
  return new Set(timed.filter(item => item.time <= cutoff).map(item => item.record.id));
}

function pruneOldestArchiveWindow(
  agentDir: string,
  archive: ContextRecallArchive,
  status: ContextRecallStorageStatus,
  now: string,
  options: ContextRecallLifecycleOptions,
): { archive: ContextRecallArchive; reclaimedBytes: number; prunedRecords: number } {
  if (!status.overBudget || archive.records.length === 0) {
    return { archive, reclaimedBytes: 0, prunedRecords: 0 };
  }
  const pruneIds = oldestArchiveWindow(archive.records, DEFAULT_CONTEXT_RECALL_PRUNE_WINDOW_DAYS);
  if (!pruneIds.size) return { archive, reclaimedBytes: 0, prunedRecords: 0 };
  let reclaimedBytes = 0;
  let prunedRecords = 0;
  const nextRecords = archive.records.map(record => {
    if (!pruneIds.has(record.id)) return record;
    prunedRecords += 1;
    const file = canReclaimManagedExcerpt(agentDir, record);
    let nextPointer = record.pointer;
    if (file && fs.existsSync(file)) {
      const expected = fs.lstatSync(file);
      const size = expected.isFile() && !expected.isSymbolicLink() ? expected.size : 0;
      try {
        const current = fs.lstatSync(file);
        if (!current.isFile() || current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino) {
          throw new Error("Recall excerpt identity changed before prune.");
        }
        fs.unlinkSync(file);
        reclaimedBytes += size;
        nextPointer = { ...record.pointer, spillFile: undefined, managedExcerpt: undefined };
      } catch {
        nextPointer = record.pointer;
      }
    }
    return {
      ...record,
      pointer: nextPointer,
      summary: summarizeText(record.summary, DEFAULT_TEXT_SUMMARY_CHARS),
      tokensEstimate: estimateTokens(record.summary),
      tags: Array.from(new Set([
        ...record.tags,
        "storage-pruned",
        `prune-window-${DEFAULT_CONTEXT_RECALL_PRUNE_WINDOW_DAYS}d`,
      ])),
    };
  });
  const nextArchive = {
    version: 1 as const,
    updatedAt: now,
    records: nextRecords,
    archivedTotal: archive.archivedTotal,
  };
  writeContextRecallArchive(agentDir, nextArchive, options);
  return { archive: nextArchive, reclaimedBytes, prunedRecords };
}

function writeRecoveryPlan(agentDir: string, status: ContextRecallStorageStatus, now: string): void {
  if (!status.nearBudget && !status.overBudget) return;
  writeSafeJson(contextRecallRecoveryFile(agentDir), {
    version: 1,
    updatedAt: now,
    status,
    policy: "hot-index-plus-archive-pointers",
    recovery: [
      "Keep context-recall/index.json for the hot 240-record project recall window.",
      "Keep context-recall/archive-index.json for older summary records and original source pointers.",
      "Reload canvas-graph.json and runtime-status.json before resuming active work.",
      `When storage remains over budget, Canvast auto-prunes local files from the oldest ${DEFAULT_CONTEXT_RECALL_PRUNE_WINDOW_DAYS}-day archive window without prompting; summary tombstones and source pointers remain in archive-index.json.`,
      "Increase CANVAST_CONTEXT_RECALL_MAX_BYTES or move the project state directory to a larger volume before long 7-day-plus runs that must retain all local excerpts.",
    ],
  });
}

function recallStorageBudgetFromEnv(): number | undefined {
  const raw = process.env.CANVAST_CONTEXT_RECALL_MAX_BYTES;
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function maintainContextRecallLifecycle(
  agentDir: string,
  hotRecords: ContextRecallRecord[],
  options: ContextRecallLifecycleOptions = {},
): ContextRecallStorageStatus {
  const now = options.now || new Date().toISOString();
  const maxStorageBytes = options.maxStorageBytes ?? recallStorageBudgetFromEnv() ?? DEFAULT_CONTEXT_RECALL_MAX_STORAGE_BYTES;
  const lifecycleOptions = { ...options, maxStorageBytes };
  let archive = readContextRecallArchive(agentDir);
  const referenced = new Set(
    [...hotRecords, ...archive.records]
      .map(record => managedExcerptPath(agentDir, record.pointer.spillFile))
      .filter((file): file is string => Boolean(file))
      .map(file => path.resolve(file)),
  );
  const orphanFiles = archiveOrphanExcerpts(agentDir, referenced, now);
  if (orphanFiles > 0) archive = readContextRecallArchive(agentDir);

  let status = storageStatusFor(agentDir, hotRecords, archive.records, lifecycleOptions, 0, orphanFiles);
  let reclaimedBytes = 0;
  if (status.overBudget || status.nearBudget) {
    const reclaimableRecords = [...hotRecords, ...archive.records];
    for (const record of reclaimableRecords) {
      if (status.directoryBytes - reclaimedBytes <= status.warnAtBytes) break;
      const file = canReclaimManagedExcerpt(agentDir, record);
      if (!file || !fs.existsSync(file)) continue;
      const expected = fs.lstatSync(file);
      const size = expected.isFile() && !expected.isSymbolicLink() ? expected.size : 0;
      try {
        const current = fs.lstatSync(file);
        if (!current.isFile() || current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino) {
          throw new Error("Recall excerpt identity changed before reclaim.");
        }
        fs.unlinkSync(file);
        reclaimedBytes += size;
        record.pointer = { ...record.pointer, spillFile: undefined, managedExcerpt: undefined };
        record.tags = Array.from(new Set([...record.tags, "managed-excerpt-reclaimed"]));
      } catch {
        // Keep the pointer if reclaim fails.
      }
    }
    const nextArchiveRecords = [...archive.records];
    if (reclaimedBytes > 0) {
      writeContextRecallArchive(agentDir, {
        version: 1,
        updatedAt: now,
        records: nextArchiveRecords,
        archivedTotal: archive.archivedTotal,
      }, lifecycleOptions);
      archive = readContextRecallArchive(agentDir);
    }
    status = storageStatusFor(agentDir, hotRecords, archive.records, lifecycleOptions, reclaimedBytes, orphanFiles);
  }
  if (status.overBudget) {
    const pruned = pruneOldestArchiveWindow(agentDir, archive, status, now, lifecycleOptions);
    if (pruned.prunedRecords > 0) {
      archive = pruned.archive;
      status = storageStatusFor(
        agentDir,
        hotRecords,
        archive.records,
        lifecycleOptions,
        status.reclaimedBytes + pruned.reclaimedBytes,
        orphanFiles,
      );
      status.warning = [
        status.warning,
        `Auto-pruned oldest ${DEFAULT_CONTEXT_RECALL_PRUNE_WINDOW_DAYS}-day archive window records=${pruned.prunedRecords}, bytes=${pruned.reclaimedBytes}.`,
      ].filter(Boolean).join(" ");
    }
  }
  writeRecoveryPlan(agentDir, status, now);
  return status;
}

function isAsciiWordCode(code: number): boolean {
  return (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95;
}

function isCjkCode(code: number): boolean {
  return (code >= 0x3400 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0xac00 && code <= 0xd7af);
}

function recallTerms(text: string, maxTerms = 120): Set<string> {
  const terms = new Set<string>();
  let token = "";
  const flush = (): void => {
    const normalized = token.toLowerCase();
    token = "";
    if (normalized.length < 2) return;
    terms.add(normalized);
    if (terms.size >= maxTerms) return;
    const chars = Array.from(normalized);
    if (chars.length >= 6 && chars.some(char => isCjkCode(char.codePointAt(0) || 0))) {
      for (let index = 0; index < chars.length - 1 && terms.size < maxTerms; index += 1) {
        terms.add(`${chars[index]}${chars[index + 1]}`);
      }
    }
  };
  for (const char of text) {
    if (terms.size >= maxTerms) break;
    const code = char.codePointAt(0) || 0;
    if (isAsciiWordCode(code) || isCjkCode(code)) token += char;
    else flush();
  }
  flush();
  return terms;
}

function recordSearchText(record: ContextRecallRecord): string {
  return [
    record.title,
    record.summary,
    record.kind,
    record.source,
    ...record.tags,
    ...record.relatedEntryIds,
    record.pointer.entryId || "",
    record.pointer.sessionId || "",
  ].filter(Boolean).join(" ");
}

function isAlreadyPresent(record: ContextRecallRecord, excludeText: string): boolean {
  if (!excludeText) return false;
  const haystack = compactWhitespace(excludeText).toLowerCase();
  if (!haystack) return false;
  const summary = compactWhitespace(record.summary).toLowerCase();
  if (summary.length >= 40 && haystack.includes(summary.slice(0, 40))) return true;
  const title = compactWhitespace(record.title).toLowerCase();
  return title.length >= 30 && haystack.includes(title);
}

function recencyScore(timestamp: string, referenceTimeMs: number): number {
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time)) return 0;
  const ageMs = referenceTimeMs - time;
  if (ageMs <= 24 * 60 * 60 * 1000) return 3;
  if (ageMs <= 7 * 24 * 60 * 60 * 1000) return 2;
  if (ageMs <= 30 * 24 * 60 * 60 * 1000) return 1;
  return 0;
}

function scoreRecallRecord(
  record: ContextRecallRecord,
  queryTerms: Set<string>,
  source: "hot" | "archive",
  referenceTimeMs: number,
): number {
  if (queryTerms.size === 0) return source === "hot" ? 1 : 0;
  const recordTerms = recallTerms(recordSearchText(record));
  let overlap = 0;
  for (const term of queryTerms) {
    if (recordTerms.has(term)) overlap += 1;
  }
  return overlap * 10 + recencyScore(record.timestamp, referenceTimeMs) + (source === "hot" ? 2 : 0);
}

function parsedTimestamp(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function selectionReferenceTime(
  options: ContextRecallSelectionOptions,
  records: ContextRecallRecord[],
): number {
  if (options.referenceTime instanceof Date) return options.referenceTime.getTime();
  if (typeof options.referenceTime === "number" && Number.isFinite(options.referenceTime)) return options.referenceTime;
  if (typeof options.referenceTime === "string") {
    const parsed = Date.parse(options.referenceTime);
    if (Number.isFinite(parsed)) return parsed;
  }
  const timestamps = records.map(record => parsedTimestamp(record.timestamp)).filter(Number.isFinite);
  return timestamps.length > 0 ? Math.max(...timestamps) : 0;
}

function readRecallExcerpt(record: ContextRecallRecord, maxChars: number): string | undefined {
  const file = record.pointer.spillFile;
  if (!file || maxChars <= 0 || !fs.existsSync(file)) return undefined;
  const text = readFilePrefix(file, maxChars);
  return text ? summarizeText(text, maxChars) : undefined;
}

export function selectContextRecallRecords(
  agentDir: string,
  hotRecords: ContextRecallRecord[],
  query: string,
  options: ContextRecallSelectionOptions = {},
): SelectedContextRecallRecord[] {
  const limit = Math.max(0, Math.floor(options.limit ?? DEFAULT_RECALL_SELECTION_LIMIT));
  if (limit === 0) return [];
  const tokenBudget = Math.max(120, Math.floor(options.tokenBudget ?? DEFAULT_RECALL_TOKEN_BUDGET));
  const includeExcerpts = options.includeExcerpts === true;
  const maxExcerptChars = Math.max(0, Math.floor(options.maxExcerptChars ?? DEFAULT_RECALL_EXCERPT_CHARS));
  const minScore = options.minScore ?? 1;
  const queryTerms = recallTerms(query);
  const excludeText = options.excludeText || "";
  const hot = hotRecords.map(record => ({ record, source: "hot" as const }));
  const archive = readContextRecallArchive(agentDir).records.map(record => ({ record, source: "archive" as const }));
  const allRecords = [...hot, ...archive];
  const referenceTimeMs = selectionReferenceTime(options, allRecords.map(item => item.record));
  const candidates = allRecords
    .filter(item => !isAlreadyPresent(item.record, excludeText))
    .map(item => ({
      ...item,
      score: scoreRecallRecord(item.record, queryTerms, item.source, referenceTimeMs),
    }))
    .filter(item => item.score >= minScore)
    .sort((a, b) =>
      b.score - a.score ||
      parsedTimestamp(b.record.timestamp) - parsedTimestamp(a.record.timestamp) ||
      a.record.id.localeCompare(b.record.id),
    );

  const selected: SelectedContextRecallRecord[] = [];
  let usedTokens = 0;
  const seenPointers = new Set<string>();
  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    const pointerKey = pointerIdentity(candidate.record.pointer) || candidate.record.id;
    if (seenPointers.has(pointerKey)) continue;
    const excerpt = includeExcerpts ? readRecallExcerpt(candidate.record, maxExcerptChars) : undefined;
    const estimated = estimateTokens([
      candidate.record.title,
      candidate.record.summary,
      excerpt || "",
      candidate.record.pointer.entryId || "",
      candidate.record.pointer.spillFile || "",
    ].join("\n"));
    if (usedTokens > 0 && usedTokens + estimated > tokenBudget) continue;
    selected.push({
      record: candidate.record,
      source: candidate.source,
      score: candidate.score,
      excerpt,
    });
    seenPointers.add(pointerKey);
    usedTokens += estimated;
  }
  options.onSelection?.({
    hits: selected.length > 0 ? 1 : 0,
    misses: selected.length > 0 ? 0 : 1,
    denominator: 1,
  });
  return selected;
}

function pointerLine(record: ContextRecallRecord): string {
  const pointer = record.pointer;
  const parts = [
    pointer.sessionId ? `session=${pointer.sessionId}` : "",
    pointer.entryId ? `entry=${pointer.entryId}` : "",
    pointer.sessionFile ? `sessionFile=${pointer.sessionFile}` : "",
    pointer.spillFile ? `file=${pointer.spillFile}` : "",
  ].filter(Boolean);
  return parts.join(" ");
}

function recallLevels(record: ContextRecallRecord): string {
  const levels = ["summary"];
  if (record.pointer.spillFile) levels.push("excerpt");
  if (hasDurableOriginalPointer(record) || (record.pointer.spillFile && record.pointer.managedExcerpt !== true)) levels.push("original");
  return levels.join("/");
}

export function renderContextRecallManifest(
  agentDir: string,
  hotRecords: ContextRecallRecord[],
  query: string,
  options: ContextRecallSelectionOptions = {},
): string {
  const status = maintainContextRecallLifecycle(agentDir, hotRecords);
  const selected = selectContextRecallRecords(agentDir, hotRecords, query, {
    includeExcerpts: false,
    ...options,
  });
  if (!selected.length && !status.nearBudget && !status.overBudget) return "";
  const lines = [
    "## Canvast Context Recall Manifest",
    "Purpose: project-level recall complements pi recent history and the Canvas scoped view; do not treat it as a full transcript.",
    "Default use: rely on the summary first. Read excerpt/original pointers only when the current task needs deeper source text.",
    `Storage: hot=${status.hotRecords}/${CONTEXT_RECALL_HOT_RECORDS}, archive=${status.archiveRecords}, bytes=${status.directoryBytes}/${status.maxBytes}${status.warning ? `, warning=${status.warning}` : ""}`,
  ];
  if (!selected.length) {
    lines.push("Selected records: none for this turn.");
    return lines.join("\n");
  }
  lines.push("Selected records:");
  selected.forEach((item, index) => {
    const record = item.record;
    lines.push(`${index + 1}. [${item.source}/${record.kind}/score=${item.score}] ${record.title}`);
    lines.push(`   summary: ${record.summary}`);
    lines.push(`   levels: ${recallLevels(record)}`);
    const pointer = pointerLine(record);
    if (pointer) lines.push(`   pointer: ${pointer}`);
    if (record.tags.length) lines.push(`   tags: ${record.tags.join(", ")}`);
  });
  return lines.join("\n");
}
