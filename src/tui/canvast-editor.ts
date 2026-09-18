/**
 * =============================================================================
 * Canvast — Canvast Editor / Canvast 源文件
 * =============================================================================
 * @file        src/tui/canvast-editor.ts
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */


import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { CustomEditor, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { recordContextRecall } from "../harness/context-recall.js";
import { recordRuntimeAttachment, readRuntimeStatus } from "../harness/runtime-status.js";

export const CANVAST_LONG_TEXT_THRESHOLD = 4000;

const START_PASTE = "\x1b[200~";
const END_PASTE = "\x1b[201~";
const TEXT_PLACEHOLDER_RE = /\[canvast:text:([A-Fa-f0-9]{12}):(\d+)chars\]/g;
const IMAGE_PLACEHOLDER_RE = /\[canvast:image:(\d+):([^\]\s]+)\]/g;

type EditorAttachmentKind = "text" | "image";

interface EditorAttachmentRecord {
  placeholder: string;
  kind: EditorAttachmentKind;
  file: string;
  createdAt: string;
  sizeBytes: number;
  mimeType?: string;
  source: string;
}

interface EditorAttachmentIndex {
  version: 1;
  updatedAt: string;
  records: EditorAttachmentRecord[];
}

export interface ExpandedEditorPlaceholders {
  text: string;
  images: any[];
  changed: boolean;
  expandedLongText: boolean;
}

function attachmentDir(agentDir: string): string {
  return path.join(agentDir, "editor-attachments");
}

function attachmentIndexFile(agentDir: string): string {
  return path.join(attachmentDir(agentDir), "index.json");
}

function emptyIndex(now = new Date().toISOString()): EditorAttachmentIndex {
  return { version: 1, updatedAt: now, records: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readIndex(agentDir: string): EditorAttachmentIndex {
  const file = attachmentIndexFile(agentDir);
  const now = new Date().toISOString();
  if (!fs.existsSync(file)) return emptyIndex(now);
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!isRecord(raw) || !Array.isArray(raw.records)) return emptyIndex(now);
    return {
      version: 1,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now,
      records: raw.records.filter(isRecord).map((record): EditorAttachmentRecord | undefined => {
        if (typeof record.placeholder !== "string" || typeof record.file !== "string" || typeof record.kind !== "string") return undefined;
        if (record.kind !== "text" && record.kind !== "image") return undefined;
        return {
          placeholder: record.placeholder,
          kind: record.kind,
          file: record.file,
          createdAt: typeof record.createdAt === "string" ? record.createdAt : now,
          sizeBytes: Number.isFinite(Number(record.sizeBytes)) ? Number(record.sizeBytes) : 0,
          mimeType: typeof record.mimeType === "string" ? record.mimeType : undefined,
          source: typeof record.source === "string" ? record.source : "editor",
        };
      }).filter((record): record is EditorAttachmentRecord => Boolean(record)).slice(-120),
    };
  } catch {
    return emptyIndex(now);
  }
}

function writeIndex(agentDir: string, index: EditorAttachmentIndex): void {
  fs.mkdirSync(attachmentDir(agentDir), { recursive: true });
  fs.writeFileSync(attachmentIndexFile(agentDir), JSON.stringify(index, null, 2));
}

function upsertAttachment(agentDir: string, record: EditorAttachmentRecord): void {
  const now = new Date().toISOString();
  const current = readIndex(agentDir);
  writeIndex(agentDir, {
    version: 1,
    updatedAt: now,
    records: [...current.records.filter(item => item.placeholder !== record.placeholder), record].slice(-120),
  });
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function normalizePastedText(text: string): string {
  return text
    .replace(/\x1b\[(\d+);5u/g, (match, code) => {
      const cp = Number(code);
      if (cp >= 97 && cp <= 122) return String.fromCharCode(cp - 96);
      if (cp >= 65 && cp <= 90) return String.fromCharCode(cp - 64);
      return match;
    })
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, "    ")
    .split("")
    .filter(char => char === "\n" || char.charCodeAt(0) >= 32)
    .join("");
}

export function textPlaceholder(text: string): string {
  return `[canvast:text:${hashText(text)}:${text.length}chars]`;
}

export function storeLongTextPlaceholder(agentDir: string, text: string, source = "editor"): string {
  const normalized = normalizePastedText(text);
  const placeholder = textPlaceholder(normalized);
  const [, hash, chars] = TEXT_PLACEHOLDER_RE.exec(placeholder) || [];
  TEXT_PLACEHOLDER_RE.lastIndex = 0;
  const file = path.join(attachmentDir(agentDir), `text-${hash}-${chars}.txt`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, normalized);
  const sizeBytes = Buffer.byteLength(normalized, "utf-8");
  upsertAttachment(agentDir, {
    placeholder,
    kind: "text",
    file,
    createdAt: new Date().toISOString(),
    sizeBytes,
    source,
  });
  recordRuntimeAttachment(agentDir, {
    kind: "text",
    disposition: "placeholder",
    placeholder,
    summary: `Long pasted text staged in the editor, ${normalized.length.toLocaleString()} characters.`,
    sizeBytes,
    source,
  });
  recordContextRecall(agentDir, {
    kind: "long_text",
    source: "input",
    title: "Long pasted text placeholder",
    summary: `Long pasted text available through ${placeholder}.`,
    pointer: { spillFile: file },
    tags: ["tui-editor", "placeholder", "long-text"],
    maxInlineChars: 0,
  });
  return placeholder;
}

function mimeFromPath(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  return undefined;
}

function imageIndexFromPlaceholder(placeholder: string): number {
  const match = /\[canvast:image:(\d+):/.exec(placeholder);
  return match ? Number(match[1]) : 0;
}

function nextImageIndex(agentDir: string): number {
  const existing = readIndex(agentDir).records
    .filter(record => record.kind === "image")
    .map(record => imageIndexFromPlaceholder(record.placeholder))
    .filter(Number.isFinite);
  return Math.max(0, ...existing) + 1;
}

export function storeImageFilePlaceholder(agentDir: string, filePath: string, source = "editor"): string | undefined {
  const resolved = path.resolve(filePath);
  const mimeType = mimeFromPath(resolved);
  if (!mimeType || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return undefined;
  const data = fs.readFileSync(resolved);
  const placeholder = `[canvast:image:${nextImageIndex(agentDir)}:${mimeType}]`;
  const hash = createHash("sha256").update(data).digest("hex").slice(0, 12);
  const target = path.join(attachmentDir(agentDir), `image-${hash}${path.extname(resolved).toLowerCase() || ".img"}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
  upsertAttachment(agentDir, {
    placeholder,
    kind: "image",
    file: target,
    createdAt: new Date().toISOString(),
    sizeBytes: data.length,
    mimeType,
    source,
  });
  recordRuntimeAttachment(agentDir, {
    kind: "image",
    disposition: "placeholder",
    placeholder,
    summary: "Image staged in the editor; forwarding is decided when the prompt is submitted.",
    sizeBytes: data.length,
    mimeType,
    source,
  });
  return placeholder;
}

function lookupAttachment(agentDir: string, placeholder: string, kind: EditorAttachmentKind): EditorAttachmentRecord | undefined {
  return readIndex(agentDir).records.find(record => record.kind === kind && record.placeholder === placeholder);
}

function hasLongTextBlock(text: string, placeholder: string): boolean {
  return text.includes(`<canvast-long-text placeholder="${placeholder}"`);
}

function expandTextPlaceholders(agentDir: string, text: string): { text: string; changed: boolean; expandedLongText: boolean } {
  let changed = false;
  let expandedLongText = false;
  const expanded = text.replace(TEXT_PLACEHOLDER_RE, (placeholder: string) => {
    if (hasLongTextBlock(text, placeholder)) return placeholder;
    const record = lookupAttachment(agentDir, placeholder, "text");
    if (!record || !fs.existsSync(record.file)) {
      changed = true;
      return `${placeholder}\n\n[Canvast note: original text for this placeholder is unavailable in local attachment storage.]`;
    }
    const original = fs.readFileSync(record.file, "utf-8");
    changed = true;
    expandedLongText = true;
    return `${placeholder}\n\n<canvast-long-text placeholder="${placeholder}" chars="${original.length}">\n${original}\n</canvast-long-text>`;
  });
  TEXT_PLACEHOLDER_RE.lastIndex = 0;
  return { text: expanded, changed, expandedLongText };
}

function imageSupport(agentDir: string, ctx: any): boolean {
  if (Array.isArray(ctx?.model?.input)) return ctx.model.input.includes("image");
  return readRuntimeStatus(agentDir).model.imageInput === "supported";
}

function expandImagePlaceholders(agentDir: string, text: string, ctx: any): { text: string; images: any[]; changed: boolean } {
  const supportsImages = imageSupport(agentDir, ctx);
  const placeholders = Array.from(text.matchAll(IMAGE_PLACEHOLDER_RE), match => match[0]);
  IMAGE_PLACEHOLDER_RE.lastIndex = 0;
  if (!placeholders.length) return { text, images: [], changed: false };

  const images: any[] = [];
  const omitted: string[] = [];
  for (const placeholder of Array.from(new Set(placeholders))) {
    const record = lookupAttachment(agentDir, placeholder, "image");
    if (!record || !record.mimeType || !fs.existsSync(record.file)) {
      omitted.push(placeholder);
      continue;
    }
    if (supportsImages) {
      images.push({
        type: "image",
        data: fs.readFileSync(record.file).toString("base64"),
        mimeType: record.mimeType,
      });
      recordRuntimeAttachment(agentDir, {
        kind: "image",
        disposition: "placeholder",
        placeholder,
        summary: "Image placeholder forwarded to the active model.",
        sizeBytes: record.sizeBytes,
        mimeType: record.mimeType,
        source: "submit",
      });
    } else {
      omitted.push(placeholder);
      recordRuntimeAttachment(agentDir, {
        kind: "image",
        disposition: "omitted",
        placeholder,
        summary: "Image placeholder omitted because the active model does not advertise image input support.",
        sizeBytes: record.sizeBytes,
        mimeType: record.mimeType,
        source: "submit",
      });
    }
  }

  if (!omitted.length) return { text, images, changed: images.length > 0 };
  return {
    text: [
      text,
      "",
      `Canvast received ${omitted.length} image placeholder(s), but the active model does not advertise image input support or the local attachment is unavailable.`,
      `Omitted attachments: ${omitted.join(" ")}`,
    ].join("\n"),
    images,
    changed: true,
  };
}

export function expandEditorPlaceholders(agentDir: string, text: string, existingImages: any[] = [], ctx?: any): ExpandedEditorPlaceholders {
  const textExpanded = expandTextPlaceholders(agentDir, text);
  const imageExpanded = expandImagePlaceholders(agentDir, textExpanded.text, ctx);
  return {
    text: imageExpanded.text,
    images: [...existingImages, ...imageExpanded.images],
    changed: textExpanded.changed || imageExpanded.changed,
    expandedLongText: textExpanded.expandedLongText,
  };
}

function shouldUseCanvastTextPlaceholder(text: string): boolean {
  return normalizePastedText(text).length >= CANVAST_LONG_TEXT_THRESHOLD;
}

export class CanvastEditor extends CustomEditor {
  private readonly agentDir: string;
  private bufferingPaste = false;
  private canvastPasteBuffer = "";

  constructor(tui: any, theme: any, keybindings: any, agentDir: string) {
    super(tui, theme, keybindings);
    this.agentDir = agentDir;
  }

  override handleInput(data: string): void {
    if (this.bufferingPaste || data.includes(START_PASTE)) {
      this.handleBracketedPasteInput(data);
      return;
    }
    super.handleInput(data);
  }

  override insertTextAtCursor(text: string): void {
    const placeholder = storeImageFilePlaceholder(this.agentDir, text.trim(), "editor");
    super.insertTextAtCursor(placeholder || text);
  }

  private handleBracketedPasteInput(data: string): void {
    let input = data;
    if (!this.bufferingPaste) {
      const start = input.indexOf(START_PASTE);
      if (start > 0) super.handleInput(input.slice(0, start));
      input = input.slice(start + START_PASTE.length);
      this.bufferingPaste = true;
      this.canvastPasteBuffer = "";
    }

    const end = input.indexOf(END_PASTE);
    if (end === -1) {
      this.canvastPasteBuffer += input;
      return;
    }

    const pasted = this.canvastPasteBuffer + input.slice(0, end);
    const remaining = input.slice(end + END_PASTE.length);
    this.bufferingPaste = false;
    this.canvastPasteBuffer = "";
    const normalized = normalizePastedText(pasted);
    const replacement = shouldUseCanvastTextPlaceholder(normalized)
      ? storeLongTextPlaceholder(this.agentDir, normalized, "editor")
      : normalized;
    super.insertTextAtCursor(replacement);
    if (remaining) super.handleInput(remaining);
  }
}

export function installCanvastEditor(ctx: ExtensionCommandContext, agentDir: string): void {
  if (ctx.mode !== "tui" || typeof ctx.ui.setEditorComponent !== "function") return;
  ctx.ui.setEditorComponent((tui, theme, keybindings) => new CanvastEditor(tui, theme, keybindings, agentDir));
}
