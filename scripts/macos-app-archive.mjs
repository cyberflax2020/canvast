#!/usr/bin/env node
/**
 * =============================================================================
 * Canvast — macOS App Archive Verification / Canvast source file
 * =============================================================================
 * @file        scripts/macos-app-archive.mjs
 * @brief       Safely projects, extracts, and verifies a Canvast App ZIP.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const SOURCE_MANIFEST_PATH = "release/source-manifest.json";
const BUILDER_PATH = "scripts/build-macos-app.sh";
const PROVENANCE_PATH = "Canvast.app/Contents/Resources/CanvastBuildProvenance.json";
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_SENTINEL = 0xffffffff;
const EXTENDED_TIMESTAMP_EXTRA_FIELD = 0x5455;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function isLowerSha256(value) {
  if (typeof value !== "string" || value.length !== 64) return false;
  return [...value].every(character => (character >= "0" && character <= "9")
    || (character >= "a" && character <= "f"));
}

function canonicalTimestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${label} must be a canonical UTC ISO-8601 timestamp`);
  }
  if (Date.parse(value) > Date.now()) throw new Error(`${label} is in the future`);
  return value;
}

function validateSourceManifestDocument(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)
    || document.schemaVersion !== 2 || document.kind !== "canvast-source-snapshot"
    || document.algorithm !== "sha256") {
    throw new Error("source manifest must use canvast-source-snapshot schemaVersion 2 with sha256");
  }
  const generatedAt = canonicalTimestamp(document.generatedAt, "source manifest generatedAt");
  if (!isLowerSha256(document.sourceTreeSha256)) {
    throw new Error("source manifest sourceTreeSha256 must be a lowercase SHA-256 digest");
  }
  if (!Array.isArray(document.files) || document.files.length === 0) {
    throw new Error("source manifest files must be a non-empty array");
  }
  const expectedKeys = ["mode", "path", "sha256", "size"];
  const files = document.files.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`source manifest files[${index}] must be an object`);
    }
    if (entry.mode !== 0o644 && entry.mode !== 0o755) {
      throw new Error(`source manifest files[${index}].mode must be 0644 or 0755`);
    }
    const keys = Object.keys(entry).sort();
    if (keys.length !== expectedKeys.length
      || keys.some((key, keyIndex) => key !== expectedKeys[keyIndex])) {
      throw new Error(`source manifest files[${index}] must contain exactly path, size, mode, and sha256`);
    }
    const entryPath = entry.path;
    if (typeof entryPath !== "string" || !entryPath || entryPath.includes("\\")
      || entryPath.includes("\0") || entryPath.includes("\n") || entryPath.includes("\r")
      || path.posix.isAbsolute(entryPath) || path.win32.parse(entryPath).root !== ""
      || path.posix.normalize(entryPath) !== entryPath
      || entryPath.split("/").some(segment => !segment || segment === "." || segment === "..")) {
      throw new Error(`source manifest files[${index}].path must be a canonical portable relative path`);
    }
    if (!Number.isInteger(entry.size) || entry.size < 0) {
      throw new Error(`source manifest files[${index}].size must be a non-negative integer`);
    }
    if (!isLowerSha256(entry.sha256)) {
      throw new Error(`source manifest files[${index}].sha256 must be a lowercase SHA-256 digest`);
    }
    return { path: entryPath, size: entry.size, mode: entry.mode, sha256: entry.sha256 };
  });
  const paths = files.map(file => file.path);
  const sortedPaths = [...paths].sort((left, right) => left.localeCompare(right));
  if (!paths.every((value, index) => value === sortedPaths[index])) {
    throw new Error("source manifest files must be sorted by path");
  }
  if (new Set(paths).size !== paths.length) {
    throw new Error("source manifest files contains duplicate paths");
  }
  if (document.fileCount !== files.length) {
    throw new Error(`source manifest fileCount mismatch: expected ${files.length}, got ${String(document.fileCount)}`);
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (document.totalBytes !== totalBytes) {
    throw new Error(`source manifest totalBytes mismatch: expected ${totalBytes}, got ${String(document.totalBytes)}`);
  }
  const treePayload = files
    .map(file => `${file.sha256} ${file.size} ${file.mode} ${file.path}\n`)
    .join("");
  if (document.sourceTreeSha256 !== sha256(treePayload)) {
    throw new Error("source manifest sourceTreeSha256 does not match files");
  }
  return { generatedAt, sourceTreeSha256: document.sourceTreeSha256 };
}

function decodeName(bytes, label) {
  let value;
  try {
    value = UTF8.decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
  if (value.normalize("NFC") !== value) throw new Error(`${label} must use canonical Unicode`);
  return value;
}

function canonicalArchivePath(value) {
  if (!value || value.includes("\\") || value.includes("\0") || value.startsWith("/")) {
    throw new Error(`archive entry must be a canonical portable path: ${JSON.stringify(value)}`);
  }
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code < 32 || code === 127) {
      throw new Error(`archive entry must be a canonical portable path: ${JSON.stringify(value)}`);
    }
  }
  const directory = value.endsWith("/");
  const comparable = directory ? value.slice(0, -1) : value;
  if (!comparable || path.posix.normalize(comparable) !== comparable) {
    throw new Error(`archive entry must be a canonical portable path: ${value}`);
  }
  const segments = comparable.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === "..")) {
    throw new Error(`archive entry must be a canonical portable path: ${value}`);
  }
  return { value: directory ? `${comparable}/` : comparable, comparable, directory };
}

function bufferArchiveSource(bytes) {
  return {
    size: bytes.length,
    read(offset, length) {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
        || offset + length > bytes.length) {
        throw new Error("macOS artifact is not a complete ZIP archive");
      }
      return bytes.subarray(offset, offset + length);
    },
  };
}

function descriptorArchiveSource(descriptor, size) {
  return {
    size,
    read(offset, length) {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
        || offset + length > size) {
        throw new Error("macOS artifact is not a complete ZIP archive");
      }
      const bytes = Buffer.allocUnsafe(length);
      let cursor = 0;
      while (cursor < length) {
        const count = fs.readSync(descriptor, bytes, cursor, length - cursor, offset + cursor);
        if (count === 0) throw new Error("macOS artifact is not a complete ZIP archive");
        cursor += count;
      }
      return bytes;
    },
  };
}

function findEndRecord(source) {
  const tailOffset = Math.max(0, source.size - 65_557);
  const tail = source.read(tailOffset, source.size - tailOffset);
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    const commentLength = tail.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength !== tail.length) continue;
    if (commentLength !== 0) throw new Error("macOS archive must not contain a ZIP comment");
    return tailOffset + offset;
  }
  throw new Error("macOS artifact is not a complete ZIP archive");
}

function entryType(versionMadeBy, externalAttributes, directoryByName) {
  const host = versionMadeBy >>> 8;
  const mode = host === 3 ? (externalAttributes >>> 16) & 0xffff : 0;
  const kind = mode & 0xf000;
  if (kind === 0xa000) return { type: "symlink", mode };
  if (directoryByName || kind === 0x4000) return { type: "directory", mode };
  if (kind === 0 || kind === 0x8000) return { type: "file", mode };
  throw new Error("macOS archive contains an unsupported special file");
}

function parseExtraFields(bytes, label, location) {
  const fields = new Map();
  let cursor = 0;
  while (cursor < bytes.length) {
    if (cursor + 4 > bytes.length) throw new Error(`${label} is truncated`);
    const identifier = bytes.readUInt16LE(cursor);
    const size = bytes.readUInt16LE(cursor + 2);
    const end = cursor + 4 + size;
    if (end > bytes.length) throw new Error(`${label} is truncated`);
    if (fields.has(identifier)) throw new Error(`${label} repeats field 0x${identifier.toString(16).padStart(4, "0")}`);
    if (identifier !== EXTENDED_TIMESTAMP_EXTRA_FIELD) {
      throw new Error(`${label} contains unsupported field 0x${identifier.toString(16).padStart(4, "0")}`);
    }
    const payload = bytes.subarray(cursor + 4, end);
    if (payload.length < 1 || (payload[0] & 0xf8) !== 0 || (payload[0] & 1) === 0) {
      throw new Error(`${label} has a non-canonical extended timestamp`);
    }
    const expectedSize = location === "local"
      ? 1 + 4 * ((payload[0] & 1) + ((payload[0] >>> 1) & 1) + ((payload[0] >>> 2) & 1))
      : 5;
    if (payload.length !== expectedSize) throw new Error(`${label} has a non-canonical extended timestamp`);
    fields.set(identifier, Buffer.from(payload));
    cursor = end;
  }
  return fields;
}

function extendedTimestamp(fields) {
  const field = fields.get(EXTENDED_TIMESTAMP_EXTRA_FIELD);
  return field ? field.readUInt32LE(1) : undefined;
}

function assertTimestampExtrasAgree(localFields, centralFields, entryPath) {
  const localExtended = extendedTimestamp(localFields);
  const centralExtended = extendedTimestamp(centralFields);
  if ((localExtended === undefined) !== (centralExtended === undefined)
    || (localExtended !== undefined && localExtended !== centralExtended)) {
    throw new Error(`macOS archive timestamp extra fields disagree: ${entryPath}`);
  }
}

function inflateEntry(source, entry, nextOffset) {
  const offset = entry.localOffset;
  if (offset + 30 > entry.centralOffset) {
    throw new Error(`macOS archive has an invalid local header: ${entry.path}`);
  }
  const header = source.read(offset, 30);
  if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    throw new Error(`macOS archive has an invalid local header: ${entry.path}`);
  }
  const localFlags = header.readUInt16LE(6);
  const localMethod = header.readUInt16LE(8);
  const localModifiedTime = header.readUInt16LE(10);
  const localModifiedDate = header.readUInt16LE(12);
  const localCrc32 = header.readUInt32LE(14);
  const localCompressedSize = header.readUInt32LE(18);
  const localSize = header.readUInt32LE(22);
  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  const nameStart = offset + 30;
  const dataStart = nameStart + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > nextOffset) throw new Error(`macOS archive entry overlaps the next ZIP record: ${entry.path}`);
  const localMetadata = source.read(nameStart, nameLength + extraLength);
  const localName = decodeName(localMetadata.subarray(0, nameLength), "local ZIP entry name");
  const localExtras = parseExtraFields(
    localMetadata.subarray(nameLength),
    `local ZIP extra fields for ${entry.path}`,
    "local",
  );
  const usesDataDescriptor = (entry.flags & 0x0008) !== 0;
  const localSizesAgree = usesDataDescriptor
    ? localCrc32 === 0 && localCompressedSize === 0 && localSize === 0
    : localCrc32 === entry.crc32 && localCompressedSize === entry.compressedSize && localSize === entry.size;
  if (localName !== entry.path || localFlags !== entry.flags || localMethod !== entry.method
    || localModifiedTime !== entry.modifiedTime || localModifiedDate !== entry.modifiedDate || !localSizesAgree) {
    throw new Error(`macOS archive local header disagrees with its central record: ${entry.path}`);
  }
  let entryEnd = dataEnd;
  if (usesDataDescriptor) {
    let descriptorStart = dataEnd;
    if (descriptorStart + 4 <= nextOffset && source.read(descriptorStart, 4).readUInt32LE(0) === 0x08074b50) descriptorStart += 4;
    const descriptor = descriptorStart + 12 <= nextOffset ? source.read(descriptorStart, 12) : undefined;
    if (!descriptor || descriptor.readUInt32LE(0) !== entry.crc32
      || descriptor.readUInt32LE(4) !== entry.compressedSize
      || descriptor.readUInt32LE(8) !== entry.size) {
      throw new Error(`macOS archive has an invalid data descriptor: ${entry.path}`);
    }
    entryEnd = descriptorStart + 12;
  }
  if (entryEnd !== nextOffset) {
    throw new Error(`macOS archive has unaccounted bytes after entry data: ${entry.path}`);
  }
  assertTimestampExtrasAgree(localExtras, entry.extraFields, entry.path);
  const compressed = source.read(dataStart, entry.compressedSize);
  let bytes;
  if (entry.method === 0) bytes = Buffer.from(compressed);
  else if (entry.method === 8) {
    try {
      bytes = inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.size) });
    } catch {
      throw new Error(`macOS archive entry checksum or size mismatch: ${entry.path}`);
    }
  }
  else throw new Error(`macOS archive uses unsupported compression method ${entry.method}: ${entry.path}`);
  if (bytes.length !== entry.size || crc32(bytes) !== entry.crc32) {
    throw new Error(`macOS archive entry checksum or size mismatch: ${entry.path}`);
  }
  return bytes;
}

function inspectMacosZipSource(source, options = {}) {
  const endOffset = findEndRecord(source);
  const endRecord = source.read(endOffset, 22);
  const disk = endRecord.readUInt16LE(4);
  const centralDisk = endRecord.readUInt16LE(6);
  const diskEntries = endRecord.readUInt16LE(8);
  const entryCount = endRecord.readUInt16LE(10);
  const centralSize = endRecord.readUInt32LE(12);
  const centralOffset = endRecord.readUInt32LE(16);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount) throw new Error("split ZIP archives are not supported");
  if (centralSize === ZIP64_SENTINEL || centralOffset === ZIP64_SENTINEL || centralOffset + centralSize !== endOffset) {
    throw new Error("ZIP64 or malformed central directories are not supported");
  }
  if (entryCount === 0) throw new Error("macOS archive contains no entries");

  const entries = [];
  const names = new Set();
  const foldedNames = new Set();
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > endOffset) {
      throw new Error("macOS archive central directory is malformed");
    }
    const header = source.read(cursor, 46);
    if (header.readUInt32LE(0) !== CENTRAL_SIGNATURE) {
      throw new Error("macOS archive central directory is malformed");
    }
    const versionMadeBy = header.readUInt16LE(4);
    const flags = header.readUInt16LE(8);
    const method = header.readUInt16LE(10);
    const modifiedTime = header.readUInt16LE(12);
    const modifiedDate = header.readUInt16LE(14);
    const checksum = header.readUInt32LE(16);
    const compressedSize = header.readUInt32LE(20);
    const size = header.readUInt32LE(24);
    const nameLength = header.readUInt16LE(28);
    const extraLength = header.readUInt16LE(30);
    const commentLength = header.readUInt16LE(32);
    const diskStart = header.readUInt16LE(34);
    const externalAttributes = header.readUInt32LE(38);
    const localOffset = header.readUInt32LE(42);
    if (diskStart !== 0 || compressedSize === ZIP64_SENTINEL || size === ZIP64_SENTINEL || localOffset === ZIP64_SENTINEL) {
      throw new Error("ZIP64 or split ZIP entries are not supported");
    }
    if ((flags & 1) !== 0) throw new Error("encrypted ZIP entries are not supported");
    if ((flags & ~(0x0008 | 0x0800)) !== 0) throw new Error("macOS archive contains unsupported ZIP flags");
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > endOffset) throw new Error("macOS archive central entry is truncated");
    const metadata = source.read(cursor + 46, nameLength + extraLength + commentLength);
    const parsedPath = canonicalArchivePath(decodeName(metadata.subarray(0, nameLength), "ZIP entry name"));
    const extraFields = parseExtraFields(
      metadata.subarray(nameLength, nameLength + extraLength),
      `central ZIP extra fields for ${parsedPath.value}`,
      "central",
    );
    const metadataSegments = parsedPath.comparable.split("/");
    if (metadataSegments.some(segment => {
      const foldedSegment = segment.toLocaleLowerCase("en-US");
      return foldedSegment === "__macosx" || foldedSegment === ".appledouble" || segment.startsWith("._");
    })) {
      throw new Error(`macOS archive contains forbidden AppleDouble metadata: ${parsedPath.value}`);
    }
    if (!parsedPath.comparable.startsWith("Canvast.app/") && parsedPath.comparable !== "Canvast.app") {
      throw new Error("macOS archive must contain exactly one Canvast.app top-level bundle");
    }
    const folded = parsedPath.value.toLocaleLowerCase("en-US");
    if (names.has(parsedPath.value) || foldedNames.has(folded)) throw new Error(`macOS archive duplicates an entry path: ${parsedPath.value}`);
    names.add(parsedPath.value);
    foldedNames.add(folded);
    const type = entryType(versionMadeBy, externalAttributes, parsedPath.directory);
    if (type.type === "directory" && (compressedSize !== 0 || size !== 0)) {
      throw new Error(`macOS archive directory contains data: ${parsedPath.value}`);
    }
    const entry = {
      path: parsedPath.value, comparable: parsedPath.comparable, type: type.type, mode: type.mode, flags, method,
      crc32: checksum, compressedSize, size, modifiedTime, modifiedDate, localOffset, centralOffset, extraFields,
    };
    entries.push(entry);
    cursor = end;
  }
  if (cursor !== endOffset) throw new Error("macOS archive central directory size is inconsistent");
  const entriesByOffset = entries.slice().sort((left, right) => left.localOffset - right.localOffset);
  if (entriesByOffset[0]?.localOffset !== 0) throw new Error("macOS archive contains bytes before the first local entry");
  const projected = [];
  for (let index = 0; index < entriesByOffset.length; index += 1) {
    const entry = entriesByOffset[index];
    const nextOffset = entriesByOffset[index + 1]?.localOffset ?? centralOffset;
    const bytes = inflateEntry(source, entry, nextOffset);
    if (entry.type === "symlink") {
      throw new Error(`macOS archive contains an unsupported symbolic link: ${entry.path}`);
    }
    if (entry.type !== "directory") {
      projected.push({
        path: entry.path, type: entry.type, size: bytes.length, sha256: sha256(bytes),
        ...(entry.type === "symlink" ? { target: entry.target } : {}),
      });
    }
    options.consume?.(entry, bytes);
    if (options.retainBytes) entry.bytes = bytes;
  }
  if (!entries.some(entry => entry.type === "file" && entry.path.startsWith("Canvast.app/Contents/"))) {
    throw new Error("macOS archive must contain exactly one Canvast.app top-level bundle");
  }

  projected.sort((left, right) => left.path.localeCompare(right.path));
  const totalBytes = projected.reduce((sum, entry) => sum + entry.size, 0);
  const treeSha256 = sha256(projected.map(entry => `${entry.type} ${entry.sha256} ${entry.size} ${entry.path}${entry.target ? ` -> ${entry.target}` : ""}\n`).join(""));
  return { entries, projection: { root: "Canvast.app", fileCount: projected.length, totalBytes, treeSha256, files: projected } };
}

export function inspectMacosZip(archive) {
  if (!Buffer.isBuffer(archive) || archive.length === 0) throw new Error("macOS artifact must be a non-empty ZIP archive");
  return inspectMacosZipSource(bufferArchiveSource(archive), { retainBytes: true });
}

function assertBinding(actual, expected, label) {
  if (!actual || typeof actual !== "object" || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} mismatch`);
  }
}

function validateProvenance(document, sourceManifest, builder) {
  if (!document || document.schemaVersion !== 1 || document.kind !== "canvast-macos-build-provenance") {
    throw new Error("embedded build provenance schema/kind is invalid");
  }
  canonicalTimestamp(document.generatedAt, "embedded build provenance generatedAt");
  assertBinding(document.sourceManifest, sourceManifest, "embedded source manifest binding");
  assertBinding(document.generator, builder, "embedded build generator binding");
}

function materializeEntry(entry, bytes, destination) {
  const absolute = path.join(destination, ...entry.comparable.split("/"));
  if (entry.type === "directory") {
    fs.mkdirSync(absolute, { recursive: true });
    return;
  }
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  if (entry.type === "file") {
    fs.writeFileSync(absolute, bytes, { flag: "wx", mode: entry.mode ? entry.mode & 0o777 : 0o644 });
    if (entry.mode) fs.chmodSync(absolute, entry.mode & 0o777);
    return;
  }
  fs.symlinkSync(entry.target, absolute);
}

function materializedBundle(destination) {
  const bundle = path.join(destination, "Canvast.app");
  const realDestination = fs.realpathSync(destination);
  const realBundle = fs.realpathSync(bundle);
  if (path.relative(realDestination, realBundle).startsWith(`..${path.sep}`)) throw new Error("extracted Canvast.app resolves outside its extraction root");
  return bundle;
}

function verifierEnvironment() {
  return { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: "C", LC_ALL: "C" };
}

function validateVerificationOptions(options) {
  if (options.signingPolicy !== "adhoc" && options.signingPolicy !== "trusted") {
    throw new Error("macOS archive signing policy must be adhoc or trusted");
  }
  if (options.signingPolicy === "trusted") {
    if (typeof options.expectedTeamId !== "string" || !options.expectedTeamId) {
      throw new Error("trusted macOS archive verification requires an expected Team ID");
    }
    if (typeof options.expectedSignerCn !== "string" || !options.expectedSignerCn) {
      throw new Error("trusted macOS archive verification requires an expected signer CN");
    }
  } else if (options.expectedTeamId !== undefined || options.expectedSignerCn !== undefined) {
    throw new Error("ad-hoc macOS archive verification must not receive trusted signer identity options");
  }
}

function verifyMacosZipSource(source, options) {
  const temporary = fs.mkdtempSync(path.join(options.temporaryParent || os.tmpdir(), "canvast-app-archive-check-"));
  try {
    let provenance;
    const inspected = inspectMacosZipSource(source, {
      consume(entry, bytes) {
        if (entry.path === PROVENANCE_PATH && entry.type === "file") {
          try {
            provenance = JSON.parse(bytes.toString("utf8"));
          } catch (error) {
            throw new Error(`embedded build provenance is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        materializeEntry(entry, bytes, temporary);
      },
    });
    if (!provenance) throw new Error(`macOS archive is missing ${PROVENANCE_PATH}`);
    validateProvenance(provenance, options.sourceManifest, options.builder);
    const bundle = materializedBundle(temporary);
    const verifierArguments = [options.verifierPath, "--signing-policy", options.signingPolicy];
    if (options.signingPolicy === "trusted") {
      verifierArguments.push("--expected-team-id", options.expectedTeamId, "--expected-signer-cn", options.expectedSignerCn);
    }
    verifierArguments.push(bundle);
    const result = spawnSync("/bin/bash", verifierArguments, {
      cwd: options.projectDir, encoding: "utf8", env: verifierEnvironment(), timeout: 120_000,
    });
    if (result.error) throw new Error(`macOS App verifier could not run: ${result.error.message}`);
    if (result.status !== 0) {
      const detail = [result.stderr, result.stdout].map(value => String(value || "").trim()).filter(Boolean).join("\n");
      throw new Error(detail || `macOS App verifier failed with status ${String(result.status)}`);
    }
    return inspected.projection;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

export function verifyMacosZipBytes(options) {
  validateVerificationOptions(options);
  if (!Buffer.isBuffer(options.archiveBytes) || options.archiveBytes.length === 0) {
    throw new Error("macOS artifact must be a non-empty ZIP archive");
  }
  return verifyMacosZipSource(bufferArchiveSource(options.archiveBytes), options);
}

function sameFileState(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function withStableArchiveFile(file, label, callback) {
  const before = fs.lstatSync(file);
  if (before.isSymbolicLink() || !before.isFile() || before.size <= 0) {
    throw new Error(`${label} must be a non-empty regular file`);
  }
  const descriptor = fs.openSync(file, "r");
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || !sameFileState(before, opened)) throw new Error(`${label} changed while it was being read`);
    const result = callback(descriptorArchiveSource(descriptor, opened.size));
    const afterDescriptor = fs.fstatSync(descriptor);
    let afterPath;
    try {
      afterPath = fs.lstatSync(file);
    } catch {
      throw new Error(`${label} changed while it was being read`);
    }
    if (afterPath.isSymbolicLink() || !afterPath.isFile()
      || !sameFileState(opened, afterDescriptor) || !sameFileState(opened, afterPath)) {
      throw new Error(`${label} changed while it was being read`);
    }
    return result;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function verifyMacosZipFile(options) {
  validateVerificationOptions(options);
  return withStableArchiveFile(options.archivePath, "macOS archive", source => verifyMacosZipSource(source, options));
}

function stableFile(file, label) {
  const before = fs.lstatSync(file);
  if (before.isSymbolicLink() || !before.isFile() || before.size <= 0) throw new Error(`${label} must be a non-empty regular file`);
  const bytes = fs.readFileSync(file);
  const after = fs.lstatSync(file);
  if (bytes.length !== after.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error(`${label} changed while it was being read`);
  }
  return bytes;
}

export function readSourceBinding(manifestPath) {
  const bytes = stableFile(manifestPath, "source manifest");
  const document = JSON.parse(bytes.toString("utf8"));
  const validated = validateSourceManifestDocument(document);
  canonicalTimestamp(validated.generatedAt, "source manifest generatedAt");
  return {
    path: SOURCE_MANIFEST_PATH,
    sha256: sha256(bytes),
    generatedAt: validated.generatedAt,
    sourceTreeSha256: validated.sourceTreeSha256,
  };
}

function parseCli(argv) {
  if (argv[0] !== "verify" && argv[0] !== "write-provenance") {
    throw new Error("usage: node scripts/macos-app-archive.mjs <write-provenance|verify> [options]");
  }
  const command = argv[0];
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    const allowed = command === "verify"
      ? ["--archive", "--source-manifest", "--bundle-builder", "--verifier", "--signing-policy", "--expected-team-id", "--expected-signer-cn"]
      : ["--output", "--source-manifest", "--bundle-builder"];
    if (!allowed.includes(option) || !value || values[option]) {
      throw new Error(`invalid archive verifier argument: ${String(option)}`);
    }
    values[option] = value;
  }
  const required = command === "verify"
    ? ["--archive", "--source-manifest", "--bundle-builder", "--verifier", "--signing-policy"]
    : ["--output", "--source-manifest", "--bundle-builder"];
  for (const option of required) {
    if (!values[option]) throw new Error(`missing archive verifier argument: ${option}`);
  }
  if (command === "verify" && values["--signing-policy"] === "trusted") {
    for (const option of ["--expected-team-id", "--expected-signer-cn"]) {
      if (!values[option]) throw new Error(`missing archive verifier argument: ${option}`);
    }
  }
  if (command === "verify" && values["--signing-policy"] === "adhoc"
    && (values["--expected-team-id"] || values["--expected-signer-cn"])) {
    throw new Error("ad-hoc archive verification must not receive trusted signer identity arguments");
  }
  return { command, values };
}

function writeProvenance(values) {
  const manifest = readSourceBinding(values["--source-manifest"]);
  const builderBytes = stableFile(values["--bundle-builder"], "bundle builder");
  const document = {
    schemaVersion: 1,
    kind: "canvast-macos-build-provenance",
    generatedAt: new Date().toISOString(),
    sourceManifest: manifest,
    generator: { path: BUILDER_PATH, sha256: sha256(builderBytes) },
  };
  const output = path.resolve(values["--output"]);
  const parent = path.dirname(output);
  if (!fs.existsSync(parent) || !fs.lstatSync(parent).isDirectory() || fs.lstatSync(parent).isSymbolicLink()) {
    throw new Error("build provenance output parent must be a real directory");
  }
  if (fs.existsSync(output) && (fs.lstatSync(output).isSymbolicLink() || !fs.lstatSync(output).isFile())) {
    throw new Error("build provenance output must be a regular file");
  }
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { flag: "wx", mode: 0o644 });
    fs.renameSync(temporary, output);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  console.log(`macOS build provenance written: ${output}`);
}

function runCli() {
  const { command, values } = parseCli(process.argv.slice(2));
  if (command === "write-provenance") {
    writeProvenance(values);
    return;
  }
  const manifest = readSourceBinding(values["--source-manifest"]);
  const builderBytes = stableFile(values["--bundle-builder"], "bundle builder");
  const projection = verifyMacosZipFile({
    archivePath: values["--archive"], sourceManifest: manifest,
    builder: { path: BUILDER_PATH, sha256: sha256(builderBytes) }, verifierPath: values["--verifier"],
    signingPolicy: values["--signing-policy"], expectedTeamId: values["--expected-team-id"],
    expectedSignerCn: values["--expected-signer-cn"],
    projectDir: path.dirname(path.dirname(values["--bundle-builder"])), temporaryParent: path.dirname(values["--archive"]),
  });
  console.log(`macOS archive verified: ${values["--archive"]} (${projection.fileCount} projected files)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    runCli();
  } catch (error) {
    console.error(`macOS archive verification failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
