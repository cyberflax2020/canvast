/**
 * =============================================================================
 * Canvast — Intent Signal Text Utilities / Canvast 源文件
 * =============================================================================
 * @file        src/harness/intent-signals/text.ts
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import type { TermHits } from "./types.js";

export function isAsciiWordChar(char: string | undefined): boolean {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95;
}

function hasAsciiWordChar(value: string): boolean {
  for (const char of value) {
    if (isAsciiWordChar(char)) return true;
  }
  return false;
}

function hasCjkChar(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code >= 0x4e00 && code <= 0x9fff) return true;
  }
  return false;
}

export function isWhitespaceChar(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\v" || char === "\f";
}

export function removeWhitespace(value: string): string {
  let result = "";
  for (const char of value) {
    if (!isWhitespaceChar(char)) result += char;
  }
  return result;
}

function hasAsciiPhrase(text: string, phrase: string): boolean {
  let index = text.indexOf(phrase);
  while (index >= 0) {
    if (!isAsciiWordChar(text[index - 1]) && !isAsciiWordChar(text[index + phrase.length])) return true;
    index = text.indexOf(phrase, index + 1);
  }
  return false;
}

function hasLatinTerm(text: string, term: string): boolean {
  return hasAsciiPhrase(text, term.toLowerCase());
}

export function hasTerm(text: string, term: string): boolean {
  const normalized = term.toLowerCase();
  if (hasAsciiWordChar(normalized) && !hasCjkChar(normalized)) {
    return hasLatinTerm(text, normalized);
  }
  return text.includes(normalized);
}

function isLatinBoundary(char: string | undefined): boolean {
  return !isAsciiWordChar(char);
}

function replaceLatinTerm(value: string, term: string, replacement: string): string {
  let result = "";
  let cursor = 0;
  let index = value.indexOf(term);
  while (index >= 0) {
    const before = value[index - 1];
    const after = value[index + term.length];
    if (isLatinBoundary(before) && isLatinBoundary(after)) {
      result += value.slice(cursor, index) + replacement;
      cursor = index + term.length;
    }
    index = value.indexOf(term, index + term.length);
  }
  return result + value.slice(cursor);
}

export function replacePlainTerm(value: string, term: string, replacement: string): string {
  return value.split(term).join(replacement);
}

export function replaceTerm(value: string, term: string, replacement: string): string {
  return hasAsciiWordChar(term) && !hasCjkChar(term)
    ? replaceLatinTerm(value, term, replacement)
    : replacePlainTerm(value, term, replacement);
}

function isUrlBoundary(char: string): boolean {
  return char.trim() === "" || "，。；、：,;()[]{}<>\"'“”‘’`".includes(char);
}

function cleanUrlCandidate(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isUrlBoundary(value[start])) start += 1;
  while (end > start && isUrlBoundary(value[end - 1])) end -= 1;
  while (end > start && ".!?".includes(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

function extractUrlCandidates(text: string): string[] {
  const candidates: string[] = [];
  let current = "";
  for (const char of text) {
    if (isUrlBoundary(char)) {
      const candidate = cleanUrlCandidate(current);
      if (candidate) candidates.push(candidate);
      current = "";
    } else {
      current += char;
    }
  }
  const candidate = cleanUrlCandidate(current);
  if (candidate) candidates.push(candidate);
  return candidates;
}

export function detectExplicitExternalResources(text: string): TermHits {
  const hits: string[] = [];
  for (const candidate of extractUrlCandidates(text)) {
    try {
      const url = new URL(candidate);
      if (url.protocol === "http:" || url.protocol === "https:") hits.push("url:http");
    } catch {
      // Not a URL token; leave semantic web decisions to typed evidence signals.
    }
  }
  return { count: hits.length, hits: Array.from(new Set(hits)) };
}

export function countTerms(text: string, terms: string[]): TermHits {
  const hits: string[] = [];
  for (const term of terms) {
    if (hasTerm(text, term)) hits.push(term);
  }
  return { count: hits.length, hits };
}

export function hasAny(text: string, terms: string[]): boolean {
  return countTerms(text, terms).count > 0;
}

export function mergeHits(...groups: TermHits[]): TermHits {
  const hits = Array.from(new Set(groups.flatMap(group => group.hits)));
  return { count: hits.length, hits };
}

export function countPlainOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = text.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

export function hasLatinLetter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) return true;
  }
  return false;
}

export function hasAnyChar(value: string, chars: string): boolean {
  for (const char of value) {
    if (chars.includes(char)) return true;
  }
  return false;
}

function normalizeTokenEdge(value: string): string {
  let end = value.length;
  while (end > 0 && ".!?".includes(value[end - 1])) end -= 1;
  return value.slice(0, end);
}

export function startsWithAny(value: string, prefixes: string[]): boolean {
  return prefixes.some(prefix => value.startsWith(prefix));
}

export function termPositions(text: string, term: string): number[] {
  const positions: number[] = [];
  let index = text.indexOf(term);
  while (index >= 0) {
    if (!hasAsciiWordChar(term) || hasCjkChar(term) || (
      !isAsciiWordChar(text[index - 1]) &&
      !isAsciiWordChar(text[index + term.length])
    )) {
      positions.push(index);
    }
    index = text.indexOf(term, index + Math.max(1, term.length));
  }
  return positions;
}

export function hasTermsWithin(text: string, leftTerms: string[], rightTerms: string[], maxDistance: number): boolean {
  for (const left of leftTerms) {
    const leftPositions = termPositions(text, left);
    if (leftPositions.length === 0) continue;
    for (const right of rightTerms) {
      const rightPositions = termPositions(text, right);
      if (rightPositions.length === 0) continue;
      for (const leftPos of leftPositions) {
        for (const rightPos of rightPositions) {
          if (Math.abs(rightPos - leftPos) <= maxDistance) return true;
        }
      }
    }
  }
  return false;
}

export function hasOrderedTermsWithin(text: string, firstTerms: string[], secondTerms: string[], maxDistance: number): boolean {
  for (const first of firstTerms) {
    for (const firstPos of termPositions(text, first)) {
      for (const second of secondTerms) {
        for (const secondPos of termPositions(text, second)) {
          if (secondPos >= firstPos && secondPos - firstPos <= maxDistance) return true;
        }
      }
    }
  }
  return false;
}

const TOKEN_DELIMITERS = " \t\n\r\v\f,，、;；:：(\"'[]{}<>“”‘’`|";

function isTokenDelimiter(char: string): boolean {
  return TOKEN_DELIMITERS.includes(char);
}

export function mapDelimitedTokens(text: string, mapper: (token: string) => string): string {
  let result = "";
  let token = "";
  const flush = () => {
    if (token) {
      result += mapper(token);
      token = "";
    }
  };
  for (const char of text) {
    if (isTokenDelimiter(char)) {
      flush();
      result += char;
    } else {
      token += char;
    }
  }
  flush();
  return result;
}

export function countNonEmptyLines(value: string): number {
  let count = 0;
  let hasContent = false;
  for (const char of value) {
    if (char === "\n") {
      if (hasContent) count += 1;
      hasContent = false;
    } else if (!isWhitespaceChar(char)) {
      hasContent = true;
    }
  }
  return hasContent ? count + 1 : count;
}

export function countAnyOf(value: string, chars: string[]): number {
  let count = 0;
  for (const char of value) {
    if (chars.includes(char)) count += 1;
  }
  return count;
}

function stripTokenEdges(value: string): string {
  let start = 0;
  let end = value.length;
  const edgeChars = ".,;:!?()[]{}<>\"'“”‘’`，。；：！？（）【】";
  while (start < end && edgeChars.includes(value[start])) start += 1;
  while (end > start && edgeChars.includes(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

function stripRelativePathPrefix(value: string): string {
  let result = value;
  while (result.startsWith("./")) result = result.slice(2);
  while (result.startsWith("../")) result = result.slice(3);
  return result;
}

export function isAbsolutePathToken(token: string): boolean {
  const stripped = stripTokenEdges(token);
  return stripped.startsWith("/") && stripped.length > 1;
}

const LOCAL_PATH_ROOTS = [
  "src", "test", "tests", "doc", "docs", "extension", "extensions",
  "script", "scripts", "package", "packages", "app", "apps", "lib",
  "libs", "bin", "config", "configs",
];

export function isLocalPathToken(token: string): boolean {
  const stripped = stripRelativePathPrefix(stripTokenEdges(token).toLowerCase());
  if (!stripped.includes("/")) return false;
  const firstSlash = stripped.indexOf("/");
  const root = firstSlash >= 0 ? stripped.slice(0, firstSlash) : stripped;
  return LOCAL_PATH_ROOTS.includes(root);
}

const LOCAL_FILE_EXTENSIONS = [
  "json", "ts", "tsx", "js", "jsx", "md", "yml", "yaml", "toml",
  "lock", "txt", "py", "go", "rs", "swift", "java", "kt", "sh",
  "sql", "ipynb",
];

const COMMON_LOCAL_FILE_NAMES = [
  "package.json", "package-lock.json", "tsconfig.json", "jsconfig.json",
  "readme.md", "vite.config.ts", "vitest.config.ts", "eslint.config.js",
  "prettier.config.js", "tailwind.config.js",
];

export function isLocalFileToken(token: string): boolean {
  const stripped = stripTokenEdges(token).toLowerCase();
  if (stripped === ".env") return true;
  if (COMMON_LOCAL_FILE_NAMES.includes(stripped)) return true;
  const slash = Math.max(stripped.lastIndexOf("/"), stripped.lastIndexOf("\\"));
  if (slash < 0 && !stripped.startsWith(".")) return false;
  const name = slash >= 0 ? stripped.slice(slash + 1) : stripped;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return false;
  return LOCAL_FILE_EXTENSIONS.includes(name.slice(dot + 1));
}
