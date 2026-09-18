/**
 * =============================================================================
 * Canvast — Sandbox Path Identity / Canvast 沙箱路径身份
 * =============================================================================
 * @file        src/harness/sandbox-path-identity.ts
 * @brief       Pins retained path grants to filesystem object identity.
 * @description Captures device and inode for an approved path so replacing the
 *              object at the same pathname invalidates the grant.
 *              / 记录授权路径的设备号与 inode，同路径对象被替换后授权立即失效。
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import * as fs from "node:fs";

import { canonical } from "./sandbox-path-policy.js";

export interface SandboxPathIdentity {
  dev: number;
  ino: number;
}

export function captureSandboxPathIdentity(filePath: string): SandboxPathIdentity | undefined {
  try {
    const stats = fs.lstatSync(canonical(filePath));
    return { dev: stats.dev, ino: stats.ino };
  } catch {
    return undefined;
  }
}

export function sameSandboxPathIdentity(
  left: SandboxPathIdentity,
  right: SandboxPathIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
