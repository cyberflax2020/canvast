/**
 * =============================================================================
 * Canvast — Runtime Input Payload / Canvast 源文件
 * =============================================================================
 * @file        src/harness/runtime-input-payload.ts
 * @brief       Durable runtime input payload storage and verification helpers.
 * @description Stores large text/image payload bytes under agentDir/runtime-inputs
 *              with content addressing and fail-closed reads.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const INLINE_TEXT_BYTE_LIMIT = 256;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const TEXT_MIME = "text/plain; charset=utf-8";

export interface RuntimeInputBlobReference {
  path: string;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
}

export interface RuntimeInputTextInlinePart {
  kind: "text";
  mimeType: string;
  text: string;
}

export interface RuntimeInputBlobBackedPart {
  kind: "text" | "image";
  mimeType: string;
  blob: RuntimeInputBlobReference;
}

export type RuntimeInputPayloadPart = RuntimeInputTextInlinePart | RuntimeInputBlobBackedPart;

export interface RuntimeInputPayloadV1 {
  version: 1;
  projectId: string;
  sessionId: string;
  parts: RuntimeInputPayloadPart[];
}

export interface RuntimeInputTextInputPart {
  kind: "text";
  text: string;
}

export interface RuntimeInputImageInputPart {
  kind: "image";
  mimeType: string;
  dataBase64: string;
}

export type RuntimeInputPayloadInputPart = RuntimeInputTextInputPart | RuntimeInputImageInputPart;

export interface RuntimeInputPayloadInput {
  projectId: string;
  sessionId: string;
  parts: RuntimeInputPayloadInputPart[];
}

export type PersistableRuntimeInputPayload = RuntimeInputPayloadInput | RuntimeInputPayloadV1;

export interface MaterializedRuntimeInputTextPart {
  kind: "text";
  mimeType: string;
  text: string;
}

export interface MaterializedRuntimeInputImagePart {
  kind: "image";
  mimeType: string;
  bytes: Buffer;
}

export type MaterializedRuntimeInputPayloadPart =
  | MaterializedRuntimeInputTextPart
  | MaterializedRuntimeInputImagePart;

export interface MaterializedRuntimeInputPayload {
  version: 1;
  projectId: string;
  sessionId: string;
  parts: MaterializedRuntimeInputPayloadPart[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function isLexicallyWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function canonicalResolvedPath(value: string): string {
  let resolved = path.resolve(value);
  while (resolved.length > 1 && resolved.endsWith(path.sep)) resolved = resolved.slice(0, -1);
  return resolved;
}

function canonicalExistingDirectory(dir: string): string {
  return canonicalResolvedPath(fs.realpathSync.native(dir));
}

function ensurePrivateDirectory(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  fs.chmodSync(dir, PRIVATE_DIRECTORY_MODE);
  return canonicalExistingDirectory(dir);
}

function runtimeInputsRoot(agentDir: string): string {
  return ensurePrivateDirectory(path.join(agentDir, "runtime-inputs"));
}

function sha256Bytes(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isHexCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 70) ||
    (code >= 97 && code <= 102)
  );
}

function isSha256Hex(value: string): boolean {
  if (value.length !== 64) return false;
  for (const character of value) {
    if (!isHexCharacter(character)) return false;
  }
  return true;
}

export function runtimeInputPayloadDigest(value: RuntimeInputPayloadV1 | undefined): string {
  return createHash("sha256").update(canonicalJSON(value || null)).digest("hex");
}

function blobRelativePath(sha256: string): string {
  return path.posix.join(sha256.slice(0, 2), sha256);
}

function bufferFromBase64(value: string): Buffer {
  try {
    return Buffer.from(value, "base64");
  } catch {
    throw new Error("Runtime input payload image data must be valid base64.");
  }
}

function durableBlobReference(agentDir: string, bytes: Buffer, mimeType: string): RuntimeInputBlobReference {
  const root = runtimeInputsRoot(agentDir);
  const sha256 = sha256Bytes(bytes);
  const relativePath = blobRelativePath(sha256);
  const targetDirectory = ensurePrivateDirectory(path.join(root, path.dirname(relativePath)));
  const targetFile = path.join(targetDirectory, path.basename(relativePath));

  if (fs.existsSync(targetFile)) {
    const existing = readBlobFile(agentDir, {
      path: relativePath,
      sha256,
      sizeBytes: bytes.length,
      mimeType,
    });
    if (!existing.equals(bytes)) {
      throw new Error(`Runtime input payload blob hash collision detected: ${relativePath}`);
    }
    return { path: relativePath, sha256, sizeBytes: bytes.length, mimeType };
  }

  const temporary = path.join(targetDirectory, `.${sha256}.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    fs.writeFileSync(fd, bytes);
    fs.fchmodSync(fd, PRIVATE_FILE_MODE);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, targetFile);
    fs.chmodSync(targetFile, PRIVATE_FILE_MODE);
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Best-effort cleanup only.
      }
    }
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Best-effort cleanup only.
    }
    throw error;
  }
  return { path: relativePath, sha256, sizeBytes: bytes.length, mimeType };
}

function normalizeBlobReference(value: unknown): RuntimeInputBlobReference | undefined {
  if (!isRecord(value)) return undefined;
  const blobPath = asString(value.path);
  const sha256 = asString(value.sha256);
  const sizeBytes = Number(value.sizeBytes);
  const mimeType = asString(value.mimeType);
  if (!blobPath || !sha256 || !mimeType) return undefined;
  if (!Number.isInteger(sizeBytes) || sizeBytes < 0) return undefined;
  if (path.isAbsolute(blobPath)) return undefined;
  if (!isSha256Hex(sha256)) return undefined;
  const normalized = path.posix.normalize(blobPath);
  if (normalized.startsWith("../") || normalized === "..") return undefined;
  return { path: normalized, sha256: sha256.toLowerCase(), sizeBytes, mimeType };
}

export function normalizeRuntimeInputPayload(value: unknown): RuntimeInputPayloadV1 | undefined {
  if (!isRecord(value)) return undefined;
  if (Number(value.version) !== 1) return undefined;
  const projectId = asString(value.projectId);
  const sessionId = asString(value.sessionId);
  if (!projectId || !sessionId || !Array.isArray(value.parts)) return undefined;
  const parts: RuntimeInputPayloadPart[] = [];
  for (const rawPart of value.parts) {
    if (!isRecord(rawPart)) return undefined;
    const kind = asString(rawPart.kind);
    const mimeType = asString(rawPart.mimeType);
    if ((kind !== "text" && kind !== "image") || !mimeType) return undefined;
    const text = rawPart.text;
    const blob = normalizeBlobReference(rawPart.blob);
    if (kind === "text" && typeof text === "string" && blob === undefined) {
      parts.push({ kind: "text", mimeType, text });
      continue;
    }
    if (blob) {
      parts.push({ kind: kind as "text" | "image", mimeType, blob });
      continue;
    }
    return undefined;
  }
  return { version: 1, projectId, sessionId, parts };
}

function isDurablePayload(value: PersistableRuntimeInputPayload): value is RuntimeInputPayloadV1 {
  return normalizeRuntimeInputPayload(value) !== undefined;
}

export function persistRuntimeInputPayload(
  agentDir: string,
  payload: PersistableRuntimeInputPayload,
): RuntimeInputPayloadV1 {
  if (isDurablePayload(payload)) return normalizeRuntimeInputPayload(payload)!;
  if (!payload.projectId.trim() || !payload.sessionId.trim()) {
    throw new Error("Runtime input payload requires non-empty projectId and sessionId.");
  }
  return {
    version: 1,
    projectId: payload.projectId,
    sessionId: payload.sessionId,
    parts: payload.parts.map(part => {
      if (part.kind === "text") {
        const bytes = Buffer.from(part.text, "utf8");
        if (bytes.length <= INLINE_TEXT_BYTE_LIMIT) {
          return { kind: "text", mimeType: TEXT_MIME, text: part.text };
        }
        return {
          kind: "text",
          mimeType: TEXT_MIME,
          blob: durableBlobReference(agentDir, bytes, TEXT_MIME),
        };
      }
      const bytes = bufferFromBase64(part.dataBase64);
      return {
        kind: "image",
        mimeType: part.mimeType,
        blob: durableBlobReference(agentDir, bytes, part.mimeType),
      };
    }),
  };
}

function verifiedBlobPath(agentDir: string, relativePath: string): string {
  const root = runtimeInputsRoot(agentDir);
  const candidate = canonicalResolvedPath(path.join(root, relativePath));
  if (!isLexicallyWithin(root, candidate)) {
    throw new Error(`Runtime input payload blob escapes runtime-inputs root: ${relativePath}`);
  }

  let current = root;
  const segments = relativePath.split("/").filter(Boolean);
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    const stats = fs.lstatSync(current);
    if (stats.isSymbolicLink()) throw new Error(`Runtime input payload blob parent is a symlink: ${relativePath}`);
    if (!stats.isDirectory()) throw new Error(`Runtime input payload blob parent is not a directory: ${relativePath}`);
    const real = canonicalResolvedPath(fs.realpathSync.native(current));
    if (real !== current) throw new Error(`Runtime input payload blob parent is non-canonical: ${relativePath}`);
  }
  return candidate;
}

function readBlobFile(agentDir: string, blob: RuntimeInputBlobReference): Buffer {
  const target = verifiedBlobPath(agentDir, blob.path);
  let fd: number | undefined;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | O_NOFOLLOW);
    const stats = fs.fstatSync(fd);
    if (!stats.isFile()) throw new Error(`Runtime input payload blob is not a regular file: ${blob.path}`);
    if (stats.size !== blob.sizeBytes) {
      throw new Error(`Runtime input payload blob size mismatch: ${blob.path}`);
    }
    const bytes = fs.readFileSync(fd);
    if (sha256Bytes(bytes) !== blob.sha256) {
      throw new Error(`Runtime input payload blob hash mismatch: ${blob.path}`);
    }
    return bytes;
  } catch (error: any) {
    if (error?.code === "ELOOP") {
      throw new Error(`Runtime input payload blob is a symlink: ${blob.path}`);
    }
    throw error;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Best-effort cleanup only.
      }
    }
  }
}

export function readRuntimeInputPayload(
  agentDir: string,
  payload: RuntimeInputPayloadV1,
  expectedScope?: { projectId: string; sessionId: string },
): MaterializedRuntimeInputPayload {
  const normalized = normalizeRuntimeInputPayload(payload);
  if (!normalized) throw new Error("Runtime input payload is invalid.");
  if (
    expectedScope &&
    (normalized.projectId !== expectedScope.projectId || normalized.sessionId !== expectedScope.sessionId)
  ) {
    throw new Error("Runtime input payload scope mismatch.");
  }
  return {
    version: 1,
    projectId: normalized.projectId,
    sessionId: normalized.sessionId,
    parts: normalized.parts.map(part => {
      if (part.kind === "text" && "text" in part) {
        return { kind: "text", mimeType: part.mimeType, text: part.text };
      }
      const bytes = readBlobFile(agentDir, part.blob);
      if (part.kind === "text") {
        return { kind: "text", mimeType: part.mimeType, text: bytes.toString("utf8") };
      }
      return { kind: "image", mimeType: part.mimeType, bytes };
    }),
  };
}
