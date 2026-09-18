/**
 * =============================================================================
 * Canvast — Web Tools Parse / Canvast 源文件
 * =============================================================================
 * @file        extensions/web-tools/parse.ts
 * @brief       Pure parsing and output-shaping helpers for web tools.
 * @description Keeps URL, result, focus-window, and evidence formatting logic
 *              independent from transport and extension registration.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import type { SearchResult, WebSyntax } from "./types.js";

export function hostOf(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
  } catch {
    return "";
  }
}

export function allowedByDomains(
  url: string,
  allowed: string[] = [],
  blocked: string[] = [],
): boolean {
  const host = hostOf(url);
  if (!host) return false;
  if (blocked.some(domain => host === domain || host.endsWith(`.${domain}`))) return false;
  if (allowed.length === 0) return true;
  return allowed.some(domain => host === domain || host.endsWith(`.${domain}`));
}

export function headTail(text: string, maxChars: number): { text: string; capped: boolean } {
  if (text.length <= maxChars) return { text, capped: false };
  const marker = "\n...[middle omitted by Canvast web_fetch; use focus_terms for a specific section]...\n";
  const headChars = Math.max(1, Math.floor((maxChars - marker.length) * 0.55));
  const tailChars = Math.max(1, maxChars - marker.length - headChars);
  return {
    text: `${text.slice(0, headChars)}${marker}${text.slice(Math.max(0, text.length - tailChars))}`,
    capped: true,
  };
}

export function normalizeFocusTerms(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const term = String(item || "").trim();
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= 8) break;
  }
  return terms;
}

export function mergeFocusTerms(
  normalizeTerm: (term: string) => string,
  ...groups: string[][]
): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const rawTerm of group) {
      const term = normalizeTerm(rawTerm);
      const key = term.normalize("NFKC").toLowerCase();
      if (term.length < 2 || term.length > 80 || seen.has(key)) continue;
      seen.add(key);
      merged.push(term);
      if (merged.length >= 8) return merged;
    }
  }
  return merged;
}

export function extractFocusedText(
  text: string,
  focusTerms: string[],
  contextChars: number,
  maxChars: number,
): { text: string; focused: boolean; matchedTerms: string[]; capped: boolean } {
  const lower = text.toLowerCase();
  const ranges: Array<{ start: number; end: number; term: string }> = [];
  for (const term of focusTerms) {
    const needle = term.toLowerCase();
    let from = 0;
    let matches = 0;
    while (needle && matches < 3) {
      const index = lower.indexOf(needle, from);
      if (index < 0) break;
      ranges.push({
        start: Math.max(0, index - contextChars),
        end: Math.min(text.length, index + term.length + contextChars),
        term,
      });
      from = index + Math.max(1, needle.length);
      matches += 1;
    }
  }

  if (ranges.length === 0) {
    const capped = headTail(text, maxChars);
    return { text: capped.text, focused: false, matchedTerms: [], capped: capped.capped };
  }

  const sorted = ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number; terms: string[] }> = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 200) {
      last.end = Math.max(last.end, range.end);
      if (!last.terms.includes(range.term)) last.terms.push(range.term);
    } else {
      merged.push({ start: range.start, end: range.end, terms: [range.term] });
    }
  }

  const snippets = merged.map((range, index) => [
    `## Focus ${index + 1}: ${range.terms.join(", ")}`,
    text.slice(range.start, range.end).trim(),
  ].join("\n"));
  const combined = snippets.join("\n\n---\n\n");
  const capped = headTail(combined, maxChars);
  return {
    text: capped.text,
    focused: true,
    matchedTerms: Array.from(new Set(merged.flatMap(range => range.terms))),
    capped: capped.capped,
  };
}

function normalizeDuckDuckGoUrl(rawUrl: string, syntax: WebSyntax): string {
  const decoded = syntax.decodeHtmlEntities(rawUrl);
  const url = decoded.startsWith("//") ? `https:${decoded}` : decoded;
  try {
    const parsed = new URL(url);
    const target = parsed.searchParams.get("uddg");
    if (target) return decodeURIComponent(target);
    return parsed.href;
  } catch {
    return decoded;
  }
}

export function parseDuckDuckGoHtml(
  html: string,
  maxResults: number,
  syntax: WebSyntax,
): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (const entry of syntax.extractDuckDuckGoEntries(html)) {
    if (results.length >= maxResults) break;
    const url = normalizeDuckDuckGoUrl(entry.rawUrl, syntax);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = syntax.normalizeSpaces(
      syntax.stripHtml(syntax.decodeHtmlEntities(entry.rawTitle)),
    );
    const snippet = entry.rawSnippet
      ? syntax.normalizeSpaces(syntax.stripHtml(syntax.decodeHtmlEntities(entry.rawSnippet)))
      : "";
    results.push({ title: title || url, url, snippet });
  }
  return results;
}

export function summarizeEvidence(
  question: string,
  sources: Array<{ title: string; url: string; snippet: string; fetched?: string; error?: string }>,
  syntax: WebSyntax,
): string {
  const evidence = sources.map((source, index) => {
    const body = syntax.splitEvidenceLines(source.fetched || source.snippet || "")
      .map(item => item.trim())
      .filter(Boolean)
      .slice(0, 6)
      .join(" ");
    return `[${index + 1}] ${source.title || source.url}\nURL: ${source.url || "N/A"}\nEvidence: ${body.slice(0, 900) || source.error || "No extractable text"}`;
  }).join("\n\n");
  return [
    "# Web Research Evidence",
    `Question: ${question}`,
    "",
    "Use this as evidence, not as a final answer. Cross-check against local project facts before editing.",
    "When producing structured evidence, copy exact source URLs from the URL lines. Do not replace URL fields with titles, organization names, or page names.",
    "",
    "## Sources",
    evidence || "No sources found.",
  ].join("\n");
}
