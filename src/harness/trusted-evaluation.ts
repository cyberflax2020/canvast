/**
 * =============================================================================
 * Canvast — Trusted Paired Evaluation Capability / Canvast 源文件
 * =============================================================================
 * @file        src/harness/trusted-evaluation.ts
 * @brief       Exact-command capability for paired evaluation under a host sandbox.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

export const PAIRED_EXACT_TEST_ARGV_ENV = "CANVAST_PAIRED_EXACT_TEST_ARGV";

export type PairedExactCommandCapability =
  | { readonly kind: "inactive" }
  | { readonly kind: "invalid"; readonly reason: string }
  | {
      readonly kind: "active";
      readonly argv: readonly string[];
      readonly joinedCommand: string;
    };

export type PairedExactCommandCheck =
  | { readonly action: "normal-sandbox" }
  | { readonly action: "use-outer-seatbelt" }
  | {
      readonly action: "reject";
      readonly code: "invalid-capability" | "non-canonical-command";
      readonly reason: string;
    };

const SAFE_ARGUMENT_CHARACTERS = new Set(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._/:@%+=".split(""),
);

function invalid(reason: string): PairedExactCommandCapability {
  return { kind: "invalid", reason };
}

export function resolvePairedExactCommandCapability(
  env: NodeJS.ProcessEnv = process.env,
): PairedExactCommandCapability {
  const encodedArgv = env[PAIRED_EXACT_TEST_ARGV_ENV];
  if (encodedArgv === undefined) return { kind: "inactive" };
  if (env.CANVAST_MODE !== "parity" || env.CANVAST_UNATTENDED !== "1") {
    return invalid("the paired command capability requires unattended parity mode");
  }
  if (encodedArgv.length > 16_384) return invalid("the paired argv payload is too large");

  let parsed: unknown;
  try {
    parsed = JSON.parse(encodedArgv);
  } catch {
    return invalid("the paired argv payload is not valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 64) {
    return invalid("the paired argv payload must be a non-empty bounded array");
  }
  if (parsed.some(argument =>
    typeof argument !== "string" ||
    argument.length === 0 ||
    argument.length > 1_024 ||
    [...argument].some(character => !SAFE_ARGUMENT_CHARACTERS.has(character)))) {
    return invalid("the paired argv payload contains an unsafe argument");
  }
  const argv = parsed as string[];
  if (argv.filter(argument => argument === "--no-cache").length !== 1) {
    return invalid("the paired argv payload must contain exactly one --no-cache argument");
  }

  const immutableArgv = Object.freeze([...argv]);
  return Object.freeze({
    kind: "active" as const,
    argv: immutableArgv,
    joinedCommand: immutableArgv.join(" "),
  });
}

export function checkPairedExactCommand(
  capability: PairedExactCommandCapability,
  command: string,
): PairedExactCommandCheck {
  if (capability.kind === "inactive") return { action: "normal-sandbox" };
  if (capability.kind === "invalid") {
    return {
      action: "reject",
      code: "invalid-capability",
      reason: `Canvast paired command rejected: ${capability.reason}.`,
    };
  }
  if (command === capability.joinedCommand) return { action: "use-outer-seatbelt" };
  return {
    action: "reject",
    code: "non-canonical-command",
    reason: "Canvast paired command rejected: command does not exactly match the canonical paired argv.",
  };
}
