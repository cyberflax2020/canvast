/**
 * =============================================================================
 * Canvast — Sandbox Configuration / Canvast 沙箱配置
 * =============================================================================
 * @file        src/harness/sandbox-config.ts
 * @brief       Parses sandbox profile, permission, and CLI configuration.
 * @description Keeps configuration parsing independent from runtime
 *              authorization decisions. / 将配置解析与运行时授权决策分离。
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
export type CanvastSandboxProfile = "read-only" | "workspace-write" | "full-access";
export type CanvastPermissionMode = "ask" | "auto";

export interface SplitSandboxArgsResult {
  forwardedArgs: string[];
  profile?: CanvastSandboxProfile;
  unattended?: boolean;
  errors: string[];
}

export function truthy(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

export function normalizeSandboxProfile(value: unknown): CanvastSandboxProfile | undefined {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return undefined;
  if (["read-only", "readonly", "ro"].includes(text)) return "read-only";
  if (["workspace-write", "workspace", "write", "default"].includes(text)) return "workspace-write";
  if (["full-access", "danger-full-access", "dangerously-disable", "off", "none", "disabled"].includes(text)) {
    return "full-access";
  }
  return undefined;
}

export function normalizePermissionMode(value: unknown): CanvastPermissionMode | undefined {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return undefined;
  if (["ask", "manual", "confirm", "interactive"].includes(text)) return "ask";
  if (["auto", "automatic", "autonomous", "no-prompt", "noprompt"].includes(text)) return "auto";
  return undefined;
}

export function splitSandboxArgs(args: string[]): SplitSandboxArgsResult {
  const forwardedArgs: string[] = [];
  const errors: string[] = [];
  let profile: CanvastSandboxProfile | undefined;
  let unattended: boolean | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const nextValue = (flag: string): string | undefined => {
      if (index + 1 >= args.length) {
        errors.push(`${flag} requires read-only, workspace-write, or full-access`);
        return undefined;
      }
      index += 1;
      return args[index];
    };

    if (arg === "--canvast-sandbox" || arg === "--canvest-sandbox") {
      const parsed = normalizeSandboxProfile(nextValue(arg));
      if (parsed) profile = parsed;
      else errors.push(`${arg} must be read-only, workspace-write, or full-access`);
      continue;
    }
    if (arg.startsWith("--canvast-sandbox=") || arg.startsWith("--canvest-sandbox=")) {
      const parsed = normalizeSandboxProfile(arg.slice(arg.indexOf("=") + 1));
      if (parsed) profile = parsed;
      else errors.push(`${arg.split("=")[0]} must be read-only, workspace-write, or full-access`);
      continue;
    }
    if (arg === "--canvast-unattended" || arg === "--canvest-unattended") {
      unattended = true;
      continue;
    }
    if (arg === "--no-canvast-unattended" || arg === "--no-canvest-unattended") {
      unattended = false;
      continue;
    }
    forwardedArgs.push(arg);
  }

  return { forwardedArgs, profile, unattended, errors };
}
