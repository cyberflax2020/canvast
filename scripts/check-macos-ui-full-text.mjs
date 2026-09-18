#!/usr/bin/env node
/**
 * =============================================================================
 * Canvast — macOS Full-Text UI Guard / macOS 完整文本界面门禁
 * =============================================================================
 * @file        scripts/check-macos-ui-full-text.mjs
 * @brief       Rejects source-level SwiftUI text truncation contracts.
 * @description Keeps product text complete by rejecting Unicode ellipsis,
 *              finite layout truncation, and lossy visible-text slicing.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = path.resolve(scriptDirectory, "..");
const productionRoots = Object.freeze([
  "macos-app/Sources/CanvastApp",
  "macos-app/Sources/CanvastAppCore",
]);
const visibleTextCalls = new Map([
  ["Text", { member: false, labels: new Set(["", "verbatim"]) }],
  ["Label", { member: false, labels: new Set([""]) }],
  ["Button", { member: false, labels: new Set([""]) }],
  ["Link", { member: false, labels: new Set([""]) }],
  ["Toggle", { member: false, labels: new Set([""]) }],
  ["Picker", { member: false, labels: new Set([""]) }],
  ["Section", { member: false, labels: new Set([""]) }],
  ["Menu", { member: false, labels: new Set([""]) }],
  ["TextField", { member: false, labels: new Set([""]) }],
  ["SecureField", { member: false, labels: new Set([""]) }],
  ["NavigationLink", { member: false, labels: new Set([""]) }],
  ["help", { member: true, labels: new Set([""]) }],
  ["accessibilityLabel", { member: true, labels: new Set([""]) }],
  ["accessibilityValue", { member: true, labels: new Set([""]) }],
  ["navigationTitle", { member: true, labels: new Set([""]) }],
  ["navigationSubtitle", { member: true, labels: new Set([""]) }],
]);
const lossyTextMethods = new Set(["prefix", "suffix", "dropFirst", "dropLast"]);
const collectionSliceConsumers = new Set([
  "compactMap",
  "count",
  "enumerated",
  "filter",
  "first",
  "flatMap",
  "isEmpty",
  "joined",
  "last",
  "map",
  "reduce",
]);

function swiftFiles(root) {
  const results = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith(".swift")) results.push(absolute);
    }
  };
  if (fs.existsSync(root)) visit(root);
  return results.sort();
}

function lineNumberAt(source, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function isIdentifierStart(character) {
  if (!character) return false;
  const code = character.charCodeAt(0);
  return character === "_" ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122);
}

function isIdentifierPart(character) {
  if (isIdentifierStart(character)) return true;
  if (!character) return false;
  const code = character.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function isWhitespace(character) {
  return character === " " || character === "\t" || character === "\n" || character === "\r";
}

function swiftStringDelimiterAt(source, offset) {
  let cursor = offset;
  while (source[cursor] === "#") cursor += 1;
  if (source.startsWith('"""', cursor)) {
    return { hashes: cursor - offset, quotes: 3, contentStart: cursor + 3 };
  }
  if (source[cursor] === '"') {
    return { hashes: cursor - offset, quotes: 1, contentStart: cursor + 1 };
  }
  return null;
}

function swiftCodeMask(source) {
  const mask = new Array(source.length).fill(" ");
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") mask[index] = "\n";
  }

  const skipBlockComment = start => {
    let cursor = start + 2;
    let depth = 1;
    while (cursor < source.length && depth > 0) {
      if (source.startsWith("/*", cursor)) {
        depth += 1;
        cursor += 2;
      } else if (source.startsWith("*/", cursor)) {
        depth -= 1;
        cursor += 2;
      } else {
        cursor += 1;
      }
    }
    return cursor;
  };

  const scanString = (delimiter, limit) => {
    const hashes = "#".repeat(delimiter.hashes);
    const quotes = '"'.repeat(delimiter.quotes);
    const closing = `${quotes}${hashes}`;
    const interpolation = `\\${hashes}(`;
    let cursor = delimiter.contentStart;
    while (cursor < limit) {
      if (source.startsWith(closing, cursor)) return cursor + closing.length;
      if (source.startsWith(interpolation, cursor)) {
        const openParenthesis = cursor + interpolation.length - 1;
        mask[openParenthesis] = "(";
        cursor = scanCode(openParenthesis + 1, limit, true);
        continue;
      }
      if (source[cursor] === "\\" && delimiter.hashes === 0) {
        cursor += 2;
        continue;
      }
      const rawEscape = `\\${hashes}`;
      if (delimiter.hashes > 0 && source.startsWith(rawEscape, cursor)) {
        cursor += rawEscape.length + 1;
        continue;
      }
      cursor += 1;
    }
    return cursor;
  };

  function scanCode(start, limit, stopsAtInterpolationEnd) {
    let cursor = start;
    let parenthesisDepth = 0;
    while (cursor < limit) {
      if (source.startsWith("//", cursor)) {
        const newline = source.indexOf("\n", cursor + 2);
        cursor = newline < 0 ? limit : newline;
        continue;
      }
      if (source.startsWith("/*", cursor)) {
        cursor = skipBlockComment(cursor);
        continue;
      }
      const delimiter = swiftStringDelimiterAt(source, cursor);
      if (delimiter) {
        cursor = scanString(delimiter, limit);
        continue;
      }

      const character = source[cursor];
      mask[cursor] = character;
      if (stopsAtInterpolationEnd && character === ")") {
        if (parenthesisDepth === 0) return cursor + 1;
        parenthesisDepth -= 1;
      } else if (stopsAtInterpolationEnd && character === "(") {
        parenthesisDepth += 1;
      }
      cursor += 1;
    }
    return cursor;
  }

  scanCode(0, source.length, false);
  return mask.join("");
}

function nextNonWhitespace(source, offset, limit = source.length) {
  let cursor = offset;
  while (cursor < limit && isWhitespace(source[cursor])) cursor += 1;
  return cursor;
}

function previousNonWhitespace(source, offset, limit = 0) {
  let cursor = offset;
  while (cursor >= limit && isWhitespace(source[cursor])) cursor -= 1;
  return cursor;
}

function closingDelimiter(source, openOffset, opening, closing) {
  let depth = 1;
  for (let cursor = openOffset + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] === opening) depth += 1;
    else if (source[cursor] === closing) {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }
  return -1;
}

function firstArgumentRange(mask, openParenthesis, closeParenthesis) {
  const start = nextNonWhitespace(mask, openParenthesis + 1, closeParenthesis);
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  let end = closeParenthesis;
  for (let cursor = start; cursor < closeParenthesis; cursor += 1) {
    const character = mask[cursor];
    if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (character === "{") braces += 1;
    else if (character === "}") braces -= 1;
    else if (character === "," && parentheses === 0 && brackets === 0 && braces === 0) {
      end = cursor;
      break;
    }
  }
  while (end > start && isWhitespace(mask[end - 1])) end -= 1;
  return { start, end };
}

function argumentLabel(mask, range) {
  let cursor = range.start;
  if (!isIdentifierStart(mask[cursor])) return { label: "", expressionStart: range.start };
  cursor += 1;
  while (cursor < range.end && isIdentifierPart(mask[cursor])) cursor += 1;
  const labelEnd = cursor;
  cursor = nextNonWhitespace(mask, cursor, range.end);
  if (mask[cursor] !== ":") return { label: "", expressionStart: range.start };
  return {
    label: mask.slice(range.start, labelEnd),
    expressionStart: nextNonWhitespace(mask, cursor + 1, range.end),
  };
}

function followingMember(mask, offset, end) {
  let cursor = nextNonWhitespace(mask, offset, end);
  while (cursor < end && (mask[cursor] === "?" || mask[cursor] === "!")) {
    cursor = nextNonWhitespace(mask, cursor + 1, end);
  }
  if (mask[cursor] !== ".") return "";
  cursor = nextNonWhitespace(mask, cursor + 1, end);
  if (!isIdentifierStart(mask[cursor])) return "";
  const start = cursor;
  cursor += 1;
  while (cursor < end && isIdentifierPart(mask[cursor])) cursor += 1;
  return mask.slice(start, cursor);
}

function isCollectionSlice(mask, offset, end) {
  return collectionSliceConsumers.has(followingMember(mask, offset, end));
}

function hasStringIndexEvidence(subscript) {
  return subscript.includes("startIndex") ||
    subscript.includes("endIndex") ||
    subscript.includes(".index(") ||
    subscript.includes("String.Index");
}

function lossyVisibleTextFindings(mask, start, end) {
  const findings = [];
  for (let cursor = start; cursor < end; cursor += 1) {
    if (mask[cursor] === ".") {
      let nameStart = cursor + 1;
      if (!isIdentifierStart(mask[nameStart])) continue;
      let nameEnd = nameStart + 1;
      while (nameEnd < end && isIdentifierPart(mask[nameEnd])) nameEnd += 1;
      const method = mask.slice(nameStart, nameEnd);
      const openParenthesis = nextNonWhitespace(mask, nameEnd, end);
      if (lossyTextMethods.has(method) && mask[openParenthesis] === "(") {
        const closeParenthesis = closingDelimiter(mask, openParenthesis, "(", ")");
        if (closeParenthesis < 0 || closeParenthesis >= end ||
            !isCollectionSlice(mask, closeParenthesis + 1, end)) {
          findings.push({
            rule: "lossy-visible-text",
            offset: cursor,
            detail: `${method}(...)`,
          });
        }
      }
      cursor = nameEnd - 1;
      continue;
    }

    if (mask[cursor] !== "[") continue;
    const previous = previousNonWhitespace(mask, cursor - 1, start);
    if (previous < start ||
        (!isIdentifierPart(mask[previous]) && !")]}!?".includes(mask[previous]))) continue;
    const closeBracket = closingDelimiter(mask, cursor, "[", "]");
    if (closeBracket < 0 || closeBracket >= end) continue;
    const subscript = mask.slice(cursor + 1, closeBracket);
    const isRange = subscript.includes("..<") || subscript.includes("...");
    if (isRange && hasStringIndexEvidence(subscript) &&
        !isCollectionSlice(mask, closeBracket + 1, end)) {
      findings.push({
        rule: "lossy-visible-text",
        offset: cursor,
        detail: "range subscript",
      });
    }
    cursor = closeBracket;
  }
  return findings;
}

function visibleTextLossFindings(source) {
  const mask = swiftCodeMask(source);
  const findings = [];
  for (let cursor = 0; cursor < mask.length;) {
    if (!isIdentifierStart(mask[cursor])) {
      cursor += 1;
      continue;
    }
    const nameStart = cursor;
    cursor += 1;
    while (cursor < mask.length && isIdentifierPart(mask[cursor])) cursor += 1;
    const name = mask.slice(nameStart, cursor);
    const specification = visibleTextCalls.get(name);
    if (!specification) continue;

    const previous = previousNonWhitespace(mask, nameStart - 1);
    if (specification.member && (previous < 0 || mask[previous] !== ".")) continue;
    const openParenthesis = nextNonWhitespace(mask, cursor);
    if (mask[openParenthesis] !== "(") continue;
    const closeParenthesis = closingDelimiter(mask, openParenthesis, "(", ")");
    if (closeParenthesis < 0) continue;

    const range = firstArgumentRange(mask, openParenthesis, closeParenthesis);
    const { label, expressionStart } = argumentLabel(mask, range);
    if (!specification.labels.has(label)) continue;
    findings.push(...lossyVisibleTextFindings(mask, expressionStart, range.end));
  }
  return findings;
}

function callArguments(source, marker, findings, rule) {
  let offset = 0;
  while (offset < source.length) {
    const start = source.indexOf(marker, offset);
    if (start < 0) return;
    let cursor = start + marker.length;
    let depth = 1;
    let quote = "";
    let escaped = false;
    for (; cursor < source.length && depth > 0; cursor += 1) {
      const character = source[cursor];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = "";
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        depth -= 1;
      }
    }
    if (depth !== 0) {
      findings.push({ rule, offset: start, detail: "unterminated call" });
      return;
    }
    findings.push({ rule, offset: start, detail: source.slice(start + marker.length, cursor - 1).trim() });
    offset = cursor;
  }
}

export function inspectSwiftFullText(source) {
  const findings = [];
  let ellipsis = source.indexOf("…");
  while (ellipsis >= 0) {
    findings.push({ rule: "unicode-ellipsis", offset: ellipsis, detail: "…" });
    ellipsis = source.indexOf("…", ellipsis + 1);
  }
  callArguments(source, ".truncationMode(", findings, "truncation-mode");
  const lineLimits = [];
  callArguments(source, ".lineLimit(", lineLimits, "finite-line-limit");
  findings.push(...lineLimits.filter(item => item.detail !== "nil"));
  findings.push(...visibleTextLossFindings(source));
  const unique = new Map(
    findings.map(finding => [`${finding.rule}:${finding.offset}`, finding]),
  );
  return [...unique.values()].sort((left, right) => left.offset - right.offset);
}

export function inspectMacOSFullText(projectRoot = defaultProjectRoot) {
  const findings = [];
  for (const relativeRoot of productionRoots) {
    for (const absolute of swiftFiles(path.join(projectRoot, relativeRoot))) {
      const source = fs.readFileSync(absolute, "utf8");
      for (const finding of inspectSwiftFullText(source)) {
        findings.push({
          ...finding,
          file: path.relative(projectRoot, absolute).split(path.sep).join("/"),
          line: lineNumberAt(source, finding.offset),
        });
      }
    }
  }
  return findings;
}

export function runMacOSFullTextGuard(projectRoot = defaultProjectRoot) {
  const findings = inspectMacOSFullText(projectRoot);
  if (findings.length > 0) {
    const details = findings.map(item =>
      `- ${item.file}:${item.line} [${item.rule}] ${item.detail || "forbidden UI contract"}`,
    ).join("\n");
    throw new Error(
      `macOS full-text UI guard failed with ${findings.length} finding(s):\n${details}`,
    );
  }
  return { files: productionRoots.flatMap(root => swiftFiles(path.join(projectRoot, root))).length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = runMacOSFullTextGuard();
    process.stdout.write(`macOS full-text UI guard passed: ${result.files} production Swift file(s) scanned.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
