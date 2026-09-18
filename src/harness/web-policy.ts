/**
 * =============================================================================
 * Canvast — Web Policy / Canvast 源文件
 * =============================================================================
 * @file        src/harness/web-policy.ts
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
/**
 * Shared web-use policy helpers.
 *
 * Keep this small and dependency-free so runtime extensions and harness code
 * use the same justification rule.
 */

const WEB_EVIDENCE_NEED_TERMS = [
  "current", "latest", "external", "online", "internet", "web", "release",
  "download", "url", "real-time", "realtime", "compatibility", "evidence",
  "source", "citation",
  "当前", "最新", "外部", "联网", "在线", "实时", "发布", "下载", "网址",
  "兼容", "证据", "来源", "引用",
];

const WEB_SUBJECT_TERMS = [
  "github", "release", "doc", "docs", "documentation", "url", "package",
  "dependency", "api", "version", "license", "compatibility", "source",
  "citation",
  "官网", "文档", "网址", "依赖", "版本", "许可证", "兼容", "来源", "引用",
];

const VAGUE_ONLY_TERMS = [
  "just because", "because", "curious", "i am curious", "need web",
  "need docs", "需要联网", "想看看", "好奇",
];

function hasHttpUrl(text: string): boolean {
  for (const raw of splitWhitespace(text)) {
    const candidate = trimUrlPunctuation(raw.trim());
    try {
      const url = new URL(candidate);
      if (url.protocol === "http:" || url.protocol === "https:") return true;
    } catch {
      // Ordinary justification text is expected to contain non-URL tokens.
    }
  }
  return false;
}

function splitWhitespace(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  for (const char of value) {
    if (char.trim() === "") {
      if (current) tokens.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function trimUrlPunctuation(value: string): string {
  let start = 0;
  let end = value.length;
  const leading = new Set(["<", "(", "\"", "'", "“", "‘"]);
  const trailing = new Set([">", ")", ",", "\"", "'", ".", "!", "?", "，", "。", "；", ";", "”", "’"]);
  while (start < end && leading.has(value[start])) start += 1;
  while (end > start && trailing.has(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

export function hasConcreteWebJustification(text: string | undefined): boolean {
  const raw = String(text || "").trim();
  const normalized = raw.toLowerCase();
  if (normalized.length < 12) return false;
  if (VAGUE_ONLY_TERMS.includes(normalized)) return false;
  const hasUrl = hasHttpUrl(raw);
  const evidenceNeed = hasUrl || hasAnyTerm(normalized, WEB_EVIDENCE_NEED_TERMS);
  const concreteSubject = hasUrl || hasAnyTerm(normalized, WEB_SUBJECT_TERMS);
  return evidenceNeed && concreteSubject;
}

export interface ExternalEvidenceContract {
  required: boolean;
  hits: string[];
  maxExternalCalls?: number;
}

const EVIDENCE_ACTION_TERMS = [
  "verify", "confirm", "cross-check", "cite", "citation", "evidence",
  "source", "ground", "reverify", "fact-check",
  "核实", "确认", "交叉确认", "引用", "证据", "来源", "取证", "重查",
];

const AUTHORITATIVE_SOURCE_TERMS = [
  "official", "authoritative", "primary source", "authorized", "authorization",
  "government", "regulator", "primary", "source of record",
  "官方", "权威", "一手来源", "主来源", "授权", "官网", "主数据源",
];

const MEMORY_EXCLUSION_TERMS = [
  "do not rely on memory", "without relying on memory", "not from memory",
  "不要凭记忆", "不要靠记忆", "不凭记忆", "不能凭记忆", "别凭记忆",
];

function hasAnyTerm(text: string, terms: readonly string[]): boolean {
  return terms.some(term => text.includes(term));
}

function isAsciiDigitAt(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 48 && code <= 57;
}

function isListEnumerator(text: string, start: number, end: number): boolean {
  let before = start - 1;
  while (before >= 0 && (text[before] === " " || text[before] === "\t")) before -= 1;
  const beginsLine = before < 0 || text[before] === "\n" || text[before] === "\r";
  if (!beginsLine) return false;
  let after = end;
  while (after < text.length && (text[after] === " " || text[after] === "\t")) after += 1;
  return [".", ")", "、", "．", "）"].includes(text[after] || "");
}

function collectEvidenceContractHits(text: string): string[] {
  const normalized = String(text || "").toLowerCase();
  const hits: string[] = [];
  const asksEvidenceAction = hasAnyTerm(normalized, EVIDENCE_ACTION_TERMS);
  const namesAuthoritativeSource = hasAnyTerm(normalized, AUTHORITATIVE_SOURCE_TERMS);
  if (asksEvidenceAction && namesAuthoritativeSource) hits.push("evidence_contract:authoritative_source");
  if (hasAnyTerm(normalized, MEMORY_EXCLUSION_TERMS) && (asksEvidenceAction || namesAuthoritativeSource)) {
    hits.push("evidence_contract:no_memory_specifics");
  }
  if (hasConcreteWebJustification(normalized) && namesAuthoritativeSource) {
    hits.push("evidence_contract:concrete_external_source");
  }
  return Array.from(new Set(hits));
}

export function externalEvidenceCallLimit(text: string): number | undefined {
  const normalized = String(text || "").toLowerCase();
  for (let index = 0; index < normalized.length; index++) {
    if (!isAsciiDigitAt(normalized, index)) continue;
    let end = index + 1;
    while (end < normalized.length && isAsciiDigitAt(normalized, end)) end += 1;
    if (isListEnumerator(normalized, index, end)) {
      index = end - 1;
      continue;
    }
    const value = Number(normalized.slice(index, end));
    if (Number.isInteger(value) && value > 0 && value <= 99) {
      const window = [
        normalized.slice(Math.max(0, index - 32), index),
        normalized.slice(end, Math.min(normalized.length, end + 32)),
      ].join("");
      const explicitStructuredBudget = window.includes("max_external_calls");
      const namesExternalBudget = hasAnyTerm(window, [
        "max_external_calls", "external", "web", "source", "联网", "外部", "来源",
      ]);
      const namesCallLimit = hasAnyTerm(window, [
        "call", "调用", "最多", "maximum", "at most", "no more than",
      ]);
      if (explicitStructuredBudget || (namesExternalBudget && namesCallLimit)) return value;
    }
    index = end - 1;
  }
  return undefined;
}

export function detectExternalEvidenceContract(text: string | undefined): ExternalEvidenceContract {
  const hits = collectEvidenceContractHits(String(text || ""));
  return {
    required: hits.length > 0,
    hits,
    maxExternalCalls: externalEvidenceCallLimit(text || ""),
  };
}
