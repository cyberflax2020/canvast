/**
 * =============================================================================
 * Canvast — Runtime Language / 运行时语言
 * =============================================================================
 * @file        src/harness/runtime-language.ts
 * @brief       Pure runtime language inference and normalization. /
 *              纯运行时语言推断与归一化。
 * @description Keeps locale policy independent from persistence and aggregate
 *              mutation. / 使语言策略与持久化及聚合状态变更保持解耦。
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

export type RuntimeLocale = "en" | "zh-Hans";
export type RuntimeLanguageSource = "default" | "explicit" | "user-input" | "model-output";

export interface RuntimeLanguageState {
  defaultLocale: "en";
  activeLocale: RuntimeLocale;
  source: RuntimeLanguageSource;
  updatedAt: string;
}

export interface RuntimeLanguageInput {
  explicitLocale?: string;
  userInput?: string;
  modelOutput?: string;
  now?: string;
}

export function normalizeRuntimeLocale(value: unknown): RuntimeLocale {
  return value === "zh-Hans" ? "zh-Hans" : "en";
}

export function normalizeRuntimeLanguageSource(value: unknown): RuntimeLanguageSource {
  if (value === "explicit" || value === "user-input" || value === "model-output") return value;
  return "default";
}

function containsCjk(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) || 0;
    if ((code >= 0x3400 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff)) return true;
  }
  return false;
}

export function inferRuntimeLanguage(input: RuntimeLanguageInput): RuntimeLanguageState {
  const now = input.now || new Date().toISOString();
  const explicit = input.explicitLocale?.trim().toLowerCase();
  if (explicit?.startsWith("zh")) {
    return { defaultLocale: "en", activeLocale: "zh-Hans", source: "explicit", updatedAt: now };
  }
  if (explicit?.startsWith("en")) {
    return { defaultLocale: "en", activeLocale: "en", source: "explicit", updatedAt: now };
  }
  if (input.userInput && containsCjk(input.userInput)) {
    return { defaultLocale: "en", activeLocale: "zh-Hans", source: "user-input", updatedAt: now };
  }
  if (input.modelOutput && containsCjk(input.modelOutput)) {
    return { defaultLocale: "en", activeLocale: "zh-Hans", source: "model-output", updatedAt: now };
  }
  return { defaultLocale: "en", activeLocale: "en", source: "default", updatedAt: now };
}
