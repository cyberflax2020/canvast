/**
 * =============================================================================
 * Canvast — TUI Capture Handshake / Canvast source file
 * =============================================================================
 * @file        src/tui/capture-handshake.ts
 * @brief       Shared capture-state and acknowledgement helpers.
 * @description Keeps production TUI capture synchronization narrow and
 *              deterministic without injecting synthetic panel content.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import * as fs from "fs";
import * as path from "path";

let capturePanelVersion = 0;

function resolvedEnvFile(name: string): string {
  const configured = process.env[name];
  return configured ? path.resolve(configured) : "";
}

function writeCaptureJson(file: string, payload: unknown): void {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(payload)}\n`);
  fs.renameSync(temp, file);
}

export function startupReadyFile(): string {
  return resolvedEnvFile("CANVAST_TUI_STARTUP_READY_FILE");
}

export function captureStateFile(): string {
  return resolvedEnvFile("CANVAST_TUI_CAPTURE_STATE_FILE");
}

export function captureAckFile(): string {
  return resolvedEnvFile("CANVAST_TUI_CAPTURE_ACK_FILE");
}

export function publishStartupReady(mode: string, sessionId: string | undefined, currentAgentDir: string): void {
  const readyFile = startupReadyFile();
  if (!readyFile) return;
  writeCaptureJson(readyFile, {
    schemaVersion: 1,
    kind: "canvast-tui-startup-ready",
    timestamp: new Date().toISOString(),
    mode,
    sessionId,
    agentDir: currentAgentDir,
  });
}

export function publishCapturePanel(title: string, lines: string[]): void {
  const stateFile = captureStateFile();
  if (!stateFile) return;
  capturePanelVersion += 1;
  const finalLine = [...lines].reverse().find(line => line.trim().length > 0) || "";
  writeCaptureJson(stateFile, {
    schemaVersion: 1,
    kind: "canvast-tui-capture-panel",
    version: capturePanelVersion,
    timestamp: new Date().toISOString(),
    title,
    lines,
    finalLine,
  });
}

export function readCaptureVersion(file: string): number {
  if (!file) return 0;
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    const version = Number(parsed?.version);
    return Number.isSafeInteger(version) && version > 0 ? version : 0;
  } catch {
    return 0;
  }
}

export function capturePanelPendingAck(): boolean {
  const stateFile = captureStateFile();
  const ackFile = captureAckFile();
  if (!stateFile || !ackFile) return false;
  const panelVersion = readCaptureVersion(stateFile);
  if (panelVersion <= 0) return false;
  const ackVersion = readCaptureVersion(ackFile);
  return ackVersion < panelVersion;
}
