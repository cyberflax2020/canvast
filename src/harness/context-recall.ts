/**
 * =============================================================================
 * Canvast — Context Recall / Canvast 源文件
 * =============================================================================
 * @file        src/harness/context-recall.ts
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
import {
  archiveContextRecallRecords,
  contextRecallArchiveFile,
  contextRecallRecoveryFile,
  CONTEXT_RECALL_HOT_RECORDS,
  DEFAULT_CONTEXT_RECALL_MAX_ARCHIVE_RECORDS,
  DEFAULT_CONTEXT_RECALL_MAX_STORAGE_BYTES,
  DEFAULT_CONTEXT_RECALL_PRUNE_WINDOW_DAYS,
  DEFAULT_CONTEXT_RECALL_WARN_RATIO,
  emptyContextRecallArchive,
  maintainContextRecallLifecycle as maintainContextRecallStorageLifecycle,
  readContextRecallArchive,
  renderContextRecallManifest as renderContextRecallStorageManifest,
  selectContextRecallRecords as selectContextRecallStorageRecords,
} from "./context-recall-storage.js";

export {
  contextRecallArchiveFile,
  contextRecallRecoveryFile,
  CONTEXT_RECALL_HOT_RECORDS,
  DEFAULT_CONTEXT_RECALL_MAX_ARCHIVE_RECORDS,
  DEFAULT_CONTEXT_RECALL_MAX_STORAGE_BYTES,
  DEFAULT_CONTEXT_RECALL_PRUNE_WINDOW_DAYS,
  DEFAULT_CONTEXT_RECALL_WARN_RATIO,
  emptyContextRecallArchive,
  readContextRecallArchive,
};

export type ContextRecallKind =
  | "turn"
  | "message"
  | "input"
  | "compaction"
  | "branch_summary"
  | "long_text"
  | "attachment";

export type ContextRecallSource = "session" | "input" | "compaction" | "branch" | "runtime";

export interface ContextRecallPointer {
  sessionFile?: string;
  sessionId?: string;
  entryId?: string;
  parentId?: string | null;
  spillFile?: string;
  managedExcerpt?: boolean;
}

export interface ContextRecallRecord {
  id: string;
  kind: ContextRecallKind;
  source: ContextRecallSource;
  title: string;
  summary: string;
  timestamp: string;
  tokensEstimate: number;
  charCount: number;
  pointer: ContextRecallPointer;
  relatedEntryIds: string[];
  tags: string[];
}

export interface ContextRecallIndex {
  version: 1;
  updatedAt: string;
  records: ContextRecallRecord[];
  storage?: ContextRecallStorageStatus;
}

export interface ContextRecallArchive {
  version: 1;
  updatedAt: string;
  records: ContextRecallRecord[];
  archivedTotal: number;
}

export interface ContextRecallStorageStatus {
  directoryBytes: number;
  excerptBytes: number;
  maxBytes: number;
  warnAtBytes: number;
  overBudget: boolean;
  nearBudget: boolean;
  hotRecords: number;
  archiveRecords: number;
  orphanFiles: number;
  reclaimedBytes: number;
  warning?: string;
}

export interface ContextRecallLifecycleOptions {
  maxStorageBytes?: number;
  warnAtRatio?: number;
  maxArchiveRecords?: number;
  now?: string;
}

export interface ContextRecallSelectionOptions {
  limit?: number;
  tokenBudget?: number;
  includeExcerpts?: boolean;
  maxExcerptChars?: number;
  excludeText?: string;
  minScore?: number;
  referenceTime?: string | number | Date;
  onSelection?: (result: { hits: number; misses: number; denominator: number }) => void;
}

export interface SelectedContextRecallRecord {
  record: ContextRecallRecord;
  source: "hot" | "archive";
  score: number;
  excerpt?: string;
}

export interface RecordContextRecallInput {
  kind: ContextRecallKind;
  source: ContextRecallSource;
  title: string;
  text?: string;
  summary?: string;
  timestamp?: string;
  pointer?: ContextRecallPointer;
  relatedEntryIds?: string[];
  tags?: string[];
  maxInlineChars?: number;
  identityKey?: string;
}

export interface SessionEntryLike {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: unknown;
  summary?: string;
  firstKeptEntryId?: string;
  fromId?: string;
}

const MAX_RECORDS = CONTEXT_RECALL_HOT_RECORDS;
const DEFAULT_INLINE_CHARS = 16_000;
const DEFAULT_TEXT_SUMMARY_CHARS = 220;

export const CANVAST_DERIVED_PROMPT_MARKERS = [
  "## Canvast Product Identity",
  "## Canvas Scoped View / 画布作用域",
  "## Canvast Context Recall Manifest",
  "## Canvast Project Scope Notice",
  "## Canvast Automatic Orchestration Gate",
  "## Canvast Local Search Hygiene",
  "## Canvast Prompt-Local Code Analysis",
  "## Canvast Prompt-Local Evidence Validation",
  "## Canvast Standalone Advisory Answer",
  "## Canvast Canvas",
  "[Canvast context budget]",
] as const;

export function contextRecallDir(agentDir: string): string {
  return path.join(agentDir, "context-recall");
}

export function contextRecallIndexFile(agentDir: string): string {
  return path.join(contextRecallDir(agentDir), "index.json");
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

function normalizeStorageStatus(value: unknown): ContextRecallStorageStatus | undefined {
  if (!isRecord(value)) return undefined;
  return {
    directoryBytes: asNumber(value.directoryBytes),
    excerptBytes: asNumber(value.excerptBytes),
    maxBytes: asNumber(value.maxBytes, DEFAULT_CONTEXT_RECALL_MAX_STORAGE_BYTES),
    warnAtBytes: asNumber(value.warnAtBytes, Math.floor(DEFAULT_CONTEXT_RECALL_MAX_STORAGE_BYTES * DEFAULT_CONTEXT_RECALL_WARN_RATIO)),
    overBudget: value.overBudget === true,
    nearBudget: value.nearBudget === true,
    hotRecords: asNumber(value.hotRecords),
    archiveRecords: asNumber(value.archiveRecords),
    orphanFiles: asNumber(value.orphanFiles),
    reclaimedBytes: asNumber(value.reclaimedBytes),
    warning: asString(value.warning) || undefined,
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

export function emptyContextRecallIndex(now = new Date().toISOString()): ContextRecallIndex {
  return {
    version: 1,
    updatedAt: now,
    records: [],
  };
}

export function readContextRecallIndex(agentDir: string): ContextRecallIndex {
  const now = new Date().toISOString();
  const file = contextRecallIndexFile(agentDir);
  if (!fs.existsSync(file)) return emptyContextRecallIndex(now);
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!isRecord(raw)) return emptyContextRecallIndex(now);
    const records = Array.isArray(raw.records)
      ? raw.records.map((item, index) => normalizeRecord(item, index, now)).filter((item): item is ContextRecallRecord => Boolean(item))
      : [];
    return {
      version: 1,
      updatedAt: asString(raw.updatedAt, now),
      records: records.slice(-MAX_RECORDS),
      storage: normalizeStorageStatus(raw.storage),
    };
  } catch {
    return emptyContextRecallIndex(now);
  }
}

function uniqueRecords(records: ContextRecallRecord[]): ContextRecallRecord[] {
  const byId = new Map<string, ContextRecallRecord>();
  for (const record of records) byId.set(record.id, record);
  return Array.from(byId.values());
}

function writeContextRecallIndexRaw(agentDir: string, index: ContextRecallIndex): void {
  fs.mkdirSync(contextRecallDir(agentDir), { recursive: true });
  const payload: ContextRecallIndex = {
    version: 1,
    updatedAt: index.updatedAt,
    records: index.records.slice(-MAX_RECORDS),
    storage: index.storage,
  };
  fs.writeFileSync(contextRecallIndexFile(agentDir), JSON.stringify(payload, null, 2));
}

export function writeContextRecallIndex(agentDir: string, index: ContextRecallIndex): void {
  const records = uniqueRecords(index.records);
  const overflow = records.slice(0, Math.max(0, records.length - MAX_RECORDS));
  const hot = records.slice(-MAX_RECORDS);
  archiveContextRecallRecords(agentDir, overflow, { now: index.updatedAt });
  writeContextRecallIndexRaw(agentDir, {
    version: 1,
    updatedAt: index.updatedAt,
    records: hot,
    storage: index.storage,
  });
  const storage = maintainContextRecallStorageLifecycle(agentDir, hot, { now: index.updatedAt });
  writeContextRecallIndexRaw(agentDir, {
    version: 1,
    updatedAt: index.updatedAt,
    records: hot,
    storage,
  });
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
  return `${compact.slice(0, Math.max(0, max - 1))}…`;
}

function safeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 80) || "record";
}

function writeSpill(agentDir: string, id: string, text: string): string {
  const file = path.join(contextRecallDir(agentDir), `${safeFilePart(id)}.txt`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

export function recordContextRecall(agentDir: string, input: RecordContextRecallInput): ContextRecallRecord {
  const timestamp = input.timestamp || new Date().toISOString();
  const text = input.text || input.summary || "";
  const basePointer = input.pointer || {};
  const id = `recall-${fingerprint([
    input.kind,
    input.source,
    input.title,
    input.identityKey || timestamp,
    basePointer.sessionFile || "",
    basePointer.entryId || "",
    text.slice(0, 1000),
  ])}`;
  const maxInlineChars = input.maxInlineChars ?? DEFAULT_INLINE_CHARS;
  const pointer: ContextRecallPointer = { ...basePointer };
  if (maxInlineChars > 0 && text.length > 0 && text.length <= maxInlineChars && !pointer.spillFile) {
    pointer.spillFile = writeSpill(agentDir, id, text);
    pointer.managedExcerpt = true;
  }
  const record: ContextRecallRecord = {
    id,
    kind: input.kind,
    source: input.source,
    title: input.title,
    summary: input.summary || summarizeText(text) || input.title,
    timestamp,
    tokensEstimate: estimateTokens(text),
    charCount: text.length,
    pointer,
    relatedEntryIds: Array.from(new Set(input.relatedEntryIds || [])),
    tags: Array.from(new Set(input.tags || [])),
  };
  const index = readContextRecallIndex(agentDir);
  writeContextRecallIndex(agentDir, {
    version: 1,
    updatedAt: timestamp,
    records: [...index.records.filter(item => item.id !== id), record],
  });
  return record;
}

function messageContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(item => {
    if (typeof item === "string") return item;
    if (isRecord(item) && typeof item.text === "string") return item.text;
    if (isRecord(item) && typeof item.type === "string" && item.type.startsWith("image")) return `[${item.type}]`;
    return "";
  }).filter(Boolean).join("\n");
}

export function isCanvastDerivedPromptText(text: string): boolean {
  return CANVAST_DERIVED_PROMPT_MARKERS.some(marker => text.includes(marker));
}

function isProjectPromptRole(role: string): boolean {
  const normalized = role.toLowerCase();
  return normalized !== "user" && normalized !== "assistant";
}

export function stripCanvastDerivedPromptSections(text: string): string {
  if (!isCanvastDerivedPromptText(text)) return text;
  const lines = text.split("\n");
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trimStart();
    const isDerivedHeading = CANVAST_DERIVED_PROMPT_MARKERS.some(marker => trimmed.startsWith(marker));
    if (isDerivedHeading) {
      skipping = true;
      continue;
    }
    if (skipping && trimmed.startsWith("## ")) skipping = false;
    if (!skipping) kept.push(line);
  }
  return kept.join("\n").trim();
}

export function sessionEntryText(entry: SessionEntryLike): string {
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return stripCanvastDerivedPromptSections(asString(entry.summary));
  }
  if (entry.type !== "message" || !isRecord(entry.message)) return "";
  const role = asString(entry.message.role, "message");
  const content = messageContentToText(entry.message.content);
  if (isProjectPromptRole(role) && isCanvastDerivedPromptText(content)) return "";
  if (content) return `${role}: ${content}`;
  if (role === "bashExecution") {
    return [
      `bash: ${asString(entry.message.command)}`,
      asString(entry.message.output),
    ].filter(Boolean).join("\n");
  }
  if (role === "custom") return messageContentToText(entry.message.content);
  return role;
}

function entryTitle(entry: SessionEntryLike): string {
  if (entry.type === "compaction") return "Compaction summary";
  if (entry.type === "branch_summary") return "Branch summary";
  if (entry.type === "message" && isRecord(entry.message)) return `${asString(entry.message.role, "message")} message`;
  return `${entry.type || "session"} entry`;
}

export function recordSessionEntryRecall(
  agentDir: string,
  entry: SessionEntryLike | undefined,
  pointer: Omit<ContextRecallPointer, "entryId" | "parentId"> = {},
): ContextRecallRecord | undefined {
  if (!entry) return undefined;
  const text = sessionEntryText(entry);
  if (!text) return undefined;
  const kind: ContextRecallKind =
    entry.type === "compaction" ? "compaction" :
    entry.type === "branch_summary" ? "branch_summary" :
    "message";
  const source: ContextRecallSource =
    entry.type === "compaction" ? "compaction" :
    entry.type === "branch_summary" ? "branch" :
    "session";
  const relatedEntryIds = [
    asString(entry.id),
    asString((entry as any).firstKeptEntryId),
    asString((entry as any).fromId),
  ].filter(Boolean);
  return recordContextRecall(agentDir, {
    kind,
    source,
    title: entryTitle(entry),
    text,
    timestamp: asString(entry.timestamp) || undefined,
    pointer: {
      ...pointer,
      entryId: asString(entry.id) || undefined,
      parentId: typeof entry.parentId === "string" || entry.parentId === null ? entry.parentId : undefined,
    },
    relatedEntryIds,
    tags: [kind, source],
  });
}

export function syncContextRecallFromSession(agentDir: string, sessionManager: any): ContextRecallIndex {
  const entries = typeof sessionManager?.getEntries === "function"
    ? sessionManager.getEntries()
    : typeof sessionManager?.getBranch === "function"
      ? sessionManager.getBranch()
      : [];
  const sessionFile = typeof sessionManager?.getSessionFile === "function" ? sessionManager.getSessionFile() : undefined;
  const sessionId = typeof sessionManager?.getSessionId === "function" ? sessionManager.getSessionId() : undefined;
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (entry?.type === "message" || entry?.type === "compaction" || entry?.type === "branch_summary") {
        recordSessionEntryRecall(agentDir, entry, { sessionFile, sessionId });
      }
    }
  }
  return readContextRecallIndex(agentDir);
}

export function selectContextRecallRecords(
  agentDir: string,
  query: string,
  options: ContextRecallSelectionOptions = {},
): SelectedContextRecallRecord[] {
  return selectContextRecallStorageRecords(agentDir, readContextRecallIndex(agentDir).records, query, options);
}

export function renderContextRecallManifest(
  agentDir: string,
  query: string,
  options: ContextRecallSelectionOptions = {},
): string {
  return renderContextRecallStorageManifest(agentDir, readContextRecallIndex(agentDir).records, query, options);
}

export function maintainContextRecallLifecycle(
  agentDir: string,
  options: ContextRecallLifecycleOptions = {},
): ContextRecallStorageStatus {
  const index = readContextRecallIndex(agentDir);
  const storage = maintainContextRecallStorageLifecycle(agentDir, index.records, options);
  writeContextRecallIndexRaw(agentDir, {
    version: 1,
    updatedAt: options.now || index.updatedAt,
    records: index.records,
    storage,
  });
  return storage;
}

export function recallIndexSummary(index: ContextRecallIndex): string {
  const compactions = index.records.filter(item => item.kind === "compaction").length;
  const branches = index.records.filter(item => item.kind === "branch_summary").length;
  const messages = index.records.filter(item => item.kind === "message" || item.kind === "input").length;
  const spill = index.records.filter(item => item.pointer.spillFile).length;
  const archiveRecords = index.storage?.archiveRecords ?? 0;
  const storage = index.storage
    ? ` | archive ${archiveRecords} | storage ${index.storage.directoryBytes}/${index.storage.maxBytes} bytes`
    : "";
  return `${index.records.length} recall records | messages ${messages} | compactions ${compactions} | branches ${branches} | local excerpts ${spill}${storage}`;
}

export function renderContextRecallLines(index: ContextRecallIndex, limit = 10): string[] {
  const lines = [
    `Recall index: ${recallIndexSummary(index)}`,
    `Updated: ${index.updatedAt}`,
  ];
  if (index.storage?.warning) lines.push(`Storage warning: ${index.storage.warning}`);
  const recent = index.records.slice(-limit).reverse();
  if (!recent.length) {
    lines.push("No recall records yet. Session input, messages, compactions, and branch summaries will populate this index automatically.");
    return lines;
  }
  for (const record of recent) {
    const pointer = [
      record.pointer.entryId ? `entry=${record.pointer.entryId}` : "",
      record.pointer.spillFile ? `excerpt=${path.basename(record.pointer.spillFile)}` : "",
    ].filter(Boolean).join(" ");
    lines.push(`- [${record.kind}] ${record.title}: ${record.summary}${pointer ? ` (${pointer})` : ""}`);
  }
  return lines;
}
