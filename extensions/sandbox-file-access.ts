/**
 * =============================================================================
 * Canvast — Sandbox-aware File Access / 沙箱感知文件访问
 * =============================================================================
 * @file        extensions/sandbox-file-access.ts
 * @brief       Canonical, policy-checked, identity-pinned read-only file access.
 * @description Reuses the active sandbox read decision and binds the approved
 *              path to the file descriptor that is actually read.
 *              复用现有沙箱读取决策，并将授权路径绑定到实际读取的文件描述符。
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import * as path from "node:path";

import {
  createSandboxController,
  type SandboxDecision,
} from "../src/harness/sandbox.js";

export type SandboxFileAccessErrorCode =
  | "cancelled"
  | "deadline_exceeded"
  | "file_too_large"
  | "identity_changed"
  | "invalid_path"
  | "io_error"
  | "not_regular_file"
  | "outside_workspace"
  | "protected_read"
  | "sandbox_denied";

export interface FileIdentity {
  dev: number;
  ino: number;
}

export interface SandboxedTextFile {
  requestedPath: string;
  canonicalPath: string;
  identity: FileIdentity;
  bytes: number;
  text: string;
}

export interface SandboxedReadOptions {
  maxBytes: number;
  signal?: AbortSignal;
  deadlineAt?: number;
  expectedIdentity?: FileIdentity;
  expectedRootIdentity?: FileIdentity;
  now?: () => number;
}

interface SandboxReadController {
  decideFileAccess(toolName: string, filePath: string, cwd?: string): SandboxDecision;
}

export class SandboxFileAccessError extends Error {
  readonly code: SandboxFileAccessErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: SandboxFileAccessErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "SandboxFileAccessError";
    this.code = code;
    this.details = details;
  }
}

const fallbackControllers = new WeakMap<object, Map<string, SandboxReadController>>();
const READ_CHUNK_BYTES = 64 * 1024;

function optionalOpenFlag(name: string): number {
  const value = (constants as unknown as Record<string, unknown>)[name];
  return typeof value === "number" ? value : 0;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function identityOf(stat: Stats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code || "")
    : undefined;
}

function checkControl(options: Pick<SandboxedReadOptions, "signal" | "deadlineAt" | "now">): void {
  if (options.signal?.aborted) {
    throw new SandboxFileAccessError("cancelled", "LSP file read was cancelled.");
  }
  if (options.deadlineAt !== undefined && (options.now || Date.now)() >= options.deadlineAt) {
    throw new SandboxFileAccessError("deadline_exceeded", "LSP file read exceeded its deadline.");
  }
}

function controllerFor(pi: ExtensionAPI, root: string): SandboxReadController {
  const installed = (pi as any).__canvast_sandbox as SandboxReadController | undefined;
  if (installed && typeof installed.decideFileAccess === "function") return installed;

  let byRoot = fallbackControllers.get(pi as object);
  if (!byRoot) {
    byRoot = new Map();
    fallbackControllers.set(pi as object, byRoot);
  }
  const existing = byRoot.get(root);
  if (existing) return existing;
  const fallback = createSandboxController({ workingDir: root, projectRoot: root });
  byRoot.set(root, fallback);
  return fallback;
}

function deniedError(decision: SandboxDecision): SandboxFileAccessError {
  const protectedRead = decision.categories.some(category =>
    category === "protected-path" || category === "protected-read");
  return new SandboxFileAccessError(
    protectedRead ? "protected_read" : "sandbox_denied",
    protectedRead
      ? "LSP read blocked because the target is protected and has no read-path grant."
      : `LSP read blocked by sandbox policy: ${decision.reason}`,
    {
      action: decision.action,
      categories: decision.categories,
      missingGrants: decision.missingGrants,
    },
  );
}

async function canonicalRoot(
  root: string,
  expectedIdentity?: FileIdentity,
): Promise<{ path: string; identity: FileIdentity }> {
  const requestedRoot = path.resolve(root);
  try {
    const canonicalPath = await realpath(requestedRoot);
    const stat = await lstat(canonicalPath);
    const identity = identityOf(stat);
    if (!stat.isDirectory()) {
      throw new SandboxFileAccessError("invalid_path", `LSP workspace root is not a directory: ${requestedRoot}`);
    }
    if (expectedIdentity && (!sameIdentity(expectedIdentity, identity) || canonicalPath !== requestedRoot)) {
      throw new SandboxFileAccessError("identity_changed", "LSP workspace root identity changed.");
    }
    return { path: canonicalPath, identity };
  } catch (error) {
    if (error instanceof SandboxFileAccessError) throw error;
    throw new SandboxFileAccessError(
      "invalid_path",
      `LSP workspace root is unavailable: ${requestedRoot}`,
      { causeCode: errorCode(error) },
    );
  }
}

async function revalidateRootBinding(root: string, expectedIdentity: FileIdentity): Promise<void> {
  let current;
  try {
    current = await canonicalRoot(root, expectedIdentity);
  } catch (error) {
    if (error instanceof SandboxFileAccessError && error.code === "identity_changed") throw error;
    throw new SandboxFileAccessError(
      "identity_changed",
      "LSP workspace root identity changed.",
      { causeCode: errorCode(error) },
    );
  }
  if (current.path !== root || !sameIdentity(current.identity, expectedIdentity)) {
    throw new SandboxFileAccessError("identity_changed", "LSP workspace root identity changed.");
  }
}

async function revalidatePathBinding(
  root: string,
  lexicalPath: string,
  canonicalPath: string,
  expectedIdentity: FileIdentity,
  phase: string,
): Promise<void> {
  let currentCanonical: string;
  let currentStat: Stats;
  try {
    currentCanonical = await realpath(lexicalPath);
    if (!isWithinRoot(root, currentCanonical) || currentCanonical !== canonicalPath) {
      throw new SandboxFileAccessError(
        "identity_changed",
        `LSP file target changed ${phase}.`,
      );
    }
    currentStat = await lstat(currentCanonical);
  } catch (error) {
    if (error instanceof SandboxFileAccessError) throw error;
    throw new SandboxFileAccessError(
      "identity_changed",
      `LSP file target changed ${phase}.`,
      { causeCode: errorCode(error) },
    );
  }
  if (!currentStat.isFile() || !sameIdentity(expectedIdentity, identityOf(currentStat))) {
    throw new SandboxFileAccessError(
      "identity_changed",
      `LSP file identity changed ${phase}.`,
    );
  }
}

async function readDescriptor(
  handle: Awaited<ReturnType<typeof open>>,
  options: SandboxedReadOptions,
): Promise<{ bytes: number; text: string }> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  while (true) {
    checkControl(options);
    const capacity = Math.min(READ_CHUNK_BYTES, Math.max(1, options.maxBytes - bytes + 1));
    const buffer = Buffer.allocUnsafe(capacity);
    const read = await handle.read(buffer, 0, capacity, null);
    checkControl(options);
    if (read.bytesRead === 0) break;
    bytes += read.bytesRead;
    if (bytes > options.maxBytes) {
      throw new SandboxFileAccessError(
        "file_too_large",
        `LSP file exceeds the ${options.maxBytes} byte read limit.`,
        { limit: options.maxBytes, observed: bytes },
      );
    }
    chunks.push(buffer.subarray(0, read.bytesRead));
  }
  return { bytes, text: Buffer.concat(chunks, bytes).toString("utf-8") };
}

export async function readSandboxedTextFile(
  pi: ExtensionAPI,
  workspaceRoot: string,
  requestedPath: string,
  options: SandboxedReadOptions,
): Promise<SandboxedTextFile> {
  checkControl(options);
  if (!requestedPath.trim()) {
    throw new SandboxFileAccessError("invalid_path", "file_path must be a non-empty path.");
  }
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new SandboxFileAccessError("invalid_path", "maxBytes must be a non-negative safe integer.");
  }

  const rootInfo = await canonicalRoot(workspaceRoot, options.expectedRootIdentity);
  const root = rootInfo.path;
  const rootIdentity = options.expectedRootIdentity || rootInfo.identity;
  const lexicalPath = path.resolve(root, requestedPath);

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(lexicalPath);
  } catch (error) {
    throw new SandboxFileAccessError(
      "invalid_path",
      `LSP file is unavailable: ${requestedPath}`,
      { causeCode: errorCode(error) },
    );
  }
  if (!isWithinRoot(root, canonicalPath)) {
    throw new SandboxFileAccessError(
      "outside_workspace",
      `file_path must resolve within the workspace: ${requestedPath}`,
    );
  }

  let validated: Stats;
  try {
    validated = await lstat(canonicalPath);
  } catch (error) {
    throw new SandboxFileAccessError(
      "invalid_path",
      `LSP file is unavailable: ${requestedPath}`,
      { causeCode: errorCode(error) },
    );
  }
  if (!validated.isFile() || validated.isSymbolicLink()) {
    throw new SandboxFileAccessError("not_regular_file", `Not a regular file: ${requestedPath}`);
  }
  const validatedIdentity = identityOf(validated);
  if (options.expectedIdentity && !sameIdentity(options.expectedIdentity, validatedIdentity)) {
    throw new SandboxFileAccessError(
      "identity_changed",
      "LSP file identity changed before sandbox authorization.",
    );
  }

  checkControl(options);
  const decision = controllerFor(pi, root).decideFileAccess("read", lexicalPath, root);
  if (decision.action !== "allow") throw deniedError(decision);
  checkControl(options);
  await revalidateRootBinding(root, rootIdentity);
  await revalidatePathBinding(
    root,
    lexicalPath,
    canonicalPath,
    validatedIdentity,
    "after sandbox authorization",
  );

  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new SandboxFileAccessError(
      "io_error",
      "This platform does not provide O_NOFOLLOW for identity-pinned LSP reads.",
    );
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      canonicalPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | optionalOpenFlag("O_CLOEXEC"),
    );
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(validatedIdentity, identityOf(opened))) {
      throw new SandboxFileAccessError(
        "identity_changed",
        "LSP file identity changed between validation and descriptor open.",
      );
    }
    await revalidateRootBinding(root, rootIdentity);
    await revalidatePathBinding(
      root,
      lexicalPath,
      canonicalPath,
      identityOf(opened),
      "after descriptor open",
    );
    if (opened.size > options.maxBytes) {
      throw new SandboxFileAccessError(
        "file_too_large",
        `LSP file exceeds the ${options.maxBytes} byte read limit.`,
        { limit: options.maxBytes, observed: opened.size },
      );
    }

    const content = await readDescriptor(handle, options);
    const after = await handle.stat();
    if (!sameIdentity(identityOf(opened), identityOf(after))) {
      throw new SandboxFileAccessError(
        "identity_changed",
        "LSP file identity changed while its descriptor was being read.",
      );
    }
    return {
      requestedPath: lexicalPath,
      canonicalPath,
      identity: identityOf(opened),
      bytes: content.bytes,
      text: content.text,
    };
  } catch (error) {
    if (error instanceof SandboxFileAccessError) throw error;
    const causeCode = errorCode(error);
    if (causeCode === "ELOOP" || causeCode === "ENOENT" || causeCode === "ENOTDIR") {
      throw new SandboxFileAccessError(
        "identity_changed",
        "LSP file target changed before its descriptor could be opened.",
        { causeCode },
      );
    }
    throw new SandboxFileAccessError(
      "io_error",
      `LSP file read failed: ${error instanceof Error ? error.message : String(error)}`,
      { causeCode },
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
