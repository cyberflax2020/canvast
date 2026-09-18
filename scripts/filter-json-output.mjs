#!/usr/bin/env node
/**
 * =============================================================================
 * Canvast — Filter Json Output / Canvast 源文件
 * =============================================================================
 * @file        scripts/filter-json-output.mjs
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import readline from "node:readline";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  redactCredentialsDeep,
  redactCredentialText,
} from "../src/harness/credential-redaction.ts";

const TOOL_RESULT_TEXT_LIMIT = 2_000;
const TOOL_DETAIL_TEXT_LIMIT = 1_200;

export function scrubHiddenThinking(value) {
  if (Array.isArray(value)) {
    return value
      .filter(item => !(item && typeof item === "object" && item.type === "thinking"))
      .map(item => scrubHiddenThinking(item));
  }
  if (!value || typeof value !== "object") return value;

  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "thinking" || key === "thinkingSignature" || key === "reasoning_content") continue;
    out[key] = scrubHiddenThinking(child);
  }
  return out;
}

function textFromContent(content) {
  if (!Array.isArray(content)) return "";
  return content.map((item) => {
    if (item && typeof item === "object" && typeof item.text === "string") {
      return item.text;
    }
    return "";
  }).filter(Boolean).join("\n");
}

function textLengthFromContent(content) {
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum, item) => {
    if (item && typeof item === "object" && typeof item.text === "string") {
      return sum + item.text.length;
    }
    return sum;
  }, 0);
}

function containsUnsafeControl(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return true;
  }
  return false;
}

function compactString(value, limit = TOOL_DETAIL_TEXT_LIMIT) {
  if (containsUnsafeControl(value)) {
    return `[binary-like text omitted: ${value.length} chars; full output retained only in tool-side spill/log when available]`;
  }
  if (value.length <= limit) return value;
  const headLimit = Math.max(1, Math.floor(limit / 2));
  const tailLimit = Math.max(1, limit - headLimit);
  return `${value.slice(0, headLimit)}\n...[compacted ${value.length - limit} chars]...\n${value.slice(value.length - tailLimit)}`;
}

function compactDetails(value) {
  if (Array.isArray(value)) return value.map(item => compactDetails(item));
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? compactString(value) : value;
  }
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && (child.length > TOOL_DETAIL_TEXT_LIMIT || containsUnsafeControl(child))) {
      out[key] = compactString(child);
    } else {
      out[key] = compactDetails(child);
    }
  }
  return out;
}

function compactToolResultTarget(target) {
  if (!target) return target;
  const originalLength = textLengthFromContent(target.content);
  const originalText = textFromContent(target.content);
  const shouldCompact = originalLength > TOOL_RESULT_TEXT_LIMIT || containsUnsafeControl(originalText);
  const details = target.details === undefined ? undefined : compactDetails(target.details);
  if (!shouldCompact) {
    return details === target.details ? target : { ...target, details };
  }

  return {
    ...target,
    content: [{
      type: "text",
      text: [
        `[tool result compacted: ${originalLength} chars; structured details retained with large text summarized]`,
        compactString(originalText, 800),
      ].join("\n"),
    }],
    details,
  };
}

function compactToolResultEvent(event) {
  let out = event;
  if (event?.message?.role === "toolResult") {
    out = { ...out, message: compactToolResultTarget(event.message) };
  }
  if (event?.result) {
    out = { ...out, result: compactToolResultTarget(event.result) };
  }
  if (event?.partialResult) {
    out = { ...out, partialResult: compactToolResultTarget(event.partialResult) };
  }
  if (Array.isArray(event?.toolResults)) {
    out = { ...out, toolResults: event.toolResults.map(toolResult => compactToolResultTarget(toolResult)) };
  }
  return out;
}

export function sanitizeJsonEventLine(line) {
  if (!line.trim()) return line;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return redactCredentialText(line);
  }

  const assistantEvent = event?.assistantMessageEvent;
  if (event?.type === "message_update" && typeof assistantEvent?.type === "string" && assistantEvent.type.startsWith("thinking")) {
    return undefined;
  }
  if (event?.type === "message_update" && assistantEvent?.type === "toolcall_delta") {
    return undefined;
  }
  if (event?.type === "agent_end" && Array.isArray(event?.messages)) {
    return JSON.stringify(redactCredentialsDeep(scrubHiddenThinking({ ...event, messages: undefined })));
  }
  return JSON.stringify(redactCredentialsDeep(scrubHiddenThinking(compactToolResultEvent(event))));
}

function main() {
  let stdoutClosed = false;
  let terminationRequested = false;
  process.stdout.on("error", error => {
    if (error?.code !== "EPIPE") throw error;
    stdoutClosed = true;
  });
  const requestTermination = () => {
    terminationRequested = true;
  };
  process.on("SIGTERM", requestTermination);
  process.on("SIGINT", requestTermination);
  const writeSanitized = (text) => {
    if (stdoutClosed) return;
    try {
      const accepted = process.stdout.write(text);
      if (!accepted && process.stdout.destroyed) stdoutClosed = true;
    } catch (error) {
      if (error?.code !== "EPIPE") throw error;
      stdoutClosed = true;
    }
  };
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", line => {
    const sanitized = sanitizeJsonEventLine(line);
    if (sanitized !== undefined) writeSanitized(`${sanitized}\n`);
  });
  rl.on("close", () => {
    if (terminationRequested) process.exitCode = 143;
  });
}

function isMainModule(moduleUrl, argvPath) {
  if (!argvPath) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath);
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url, process.argv[1])) main();
