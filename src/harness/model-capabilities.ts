/**
 * =============================================================================
 * Canvast — Model Capabilities / Canvast 源文件
 * =============================================================================
 * @file        src/harness/model-capabilities.ts
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type CanvastModality = "text" | "image" | "audio" | "video";
export type ToolUseReliability = "none" | "basic" | "stable";
export type StructuredOutputReliability = "none" | "basic" | "stable";
export type ModelRegistryFormat = "canvast" | "litellm" | "openrouter";

export interface ModelCapabilitySource {
  kind: "registry" | "fallback";
  format?: ModelRegistryFormat;
  path?: string;
  license?: string;
  matchedModel?: string;
}

export interface ModelCapabilities {
  provider: string;
  model: string;
  contextWindowTokens: number;
  usableContextWindowTokens: number;
  recommendedMaxOutputTokens: number;
  recommendedToolResultTokens: number;
  recommendedInlineToolResultBytes: number;
  autoCompactAtTokens: number;
  reasoningEffort: "off" | "low" | "medium" | "high";
  modalities: CanvastModality[];
  toolUse: ToolUseReliability;
  structuredOutput: StructuredOutputReliability;
  supportsParallelToolCalls: boolean;
  supportsWebSearch: boolean;
  supportsReasoning: boolean;
  source: ModelCapabilitySource;
}

export interface ResolveModelCapabilitiesOptions {
  provider?: string;
  model?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  registryPaths?: string[];
  registryDocuments?: unknown[];
}

export interface ModelIdentity {
  provider: string;
  model: string;
  modelRef: string;
}

export interface ProviderModelArgs {
  provider: string;
  model: string;
  thinking: string;
}

type CapabilityPreset = Omit<
  ModelCapabilities,
  "provider" | "model" | "source"
>;

interface RegistryModelCapabilities {
  id: string;
  provider?: string;
  contextWindowTokens?: number;
  recommendedMaxOutputTokens?: number;
  reasoningEffort?: ModelCapabilities["reasoningEffort"];
  modalities?: CanvastModality[];
  toolUse?: ToolUseReliability;
  structuredOutput?: StructuredOutputReliability;
  supportsParallelToolCalls?: boolean;
  supportsWebSearch?: boolean;
  supportsReasoning?: boolean;
  source: ModelCapabilitySource;
}

const DEFAULT_CONTEXT_WINDOW = 128_000;
const MIN_CONTEXT_WINDOW = 8_000;
const DEFAULT_USABLE_CONTEXT_CAP = 200_000;

const FALLBACK_PRESET: CapabilityPreset = {
  contextWindowTokens: DEFAULT_CONTEXT_WINDOW,
  usableContextWindowTokens: Math.floor(DEFAULT_CONTEXT_WINDOW * 0.7),
  recommendedMaxOutputTokens: 8_192,
  recommendedToolResultTokens: 8_000,
  recommendedInlineToolResultBytes: 256 * 1024,
  autoCompactAtTokens: Math.floor(DEFAULT_CONTEXT_WINDOW * 0.65),
  reasoningEffort: "medium",
  modalities: ["text"],
  toolUse: "stable",
  structuredOutput: "basic",
  supportsParallelToolCalls: true,
  supportsWebSearch: false,
  supportsReasoning: false,
};

const COMMERCIAL_OPEN_SOURCE_LICENSES = new Set([
  "apache-2.0",
  "bsd-2-clause",
  "bsd-3-clause",
  "isc",
  "mit",
  "mpl-2.0",
]);

let registryCache:
  | { key: string; entries: RegistryModelCapabilities[] }
  | undefined;

function positiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function boolFromEnv(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  return undefined;
}

export function resolveModelIdentity(options: ResolveModelCapabilitiesOptions = {}): ModelIdentity {
  const env = options.env ?? process.env;
  const explicitProvider = options.provider ?? env.CANVAST_PROVIDER ?? env.CANVAST_DEFAULT_PROVIDER;
  const modelText = String(options.model ?? env.CANVAST_MODEL ?? env.CANVAST_DEFAULT_MODEL ?? "deepseek-v4-pro").trim();
  if (modelText.includes("/") && !explicitProvider) {
    const [prefix, ...rest] = modelText.split("/");
    const model = rest.join("/");
    return { provider: prefix.toLowerCase(), model, modelRef: modelText };
  }

  const provider = String(explicitProvider || "deepseek").trim().toLowerCase();
  if (modelText.toLowerCase().startsWith(`${provider}/`)) {
    return { provider, model: modelText.slice(provider.length + 1), modelRef: modelText };
  }
  return { provider, model: modelText || "deepseek-v4-pro", modelRef: modelText || "deepseek-v4-pro" };
}

export function resolveProviderModelArgs(options: ResolveModelCapabilitiesOptions = {}): ProviderModelArgs {
  const identity = resolveModelIdentity(options);
  const capabilities = resolveModelCapabilities({
    ...options,
    provider: identity.provider,
    model: identity.modelRef,
  });
  return {
    provider: identity.provider,
    model: identity.model,
    thinking: capabilities.reasoningEffort,
  };
}

function parseModalities(value: string | undefined): CanvastModality[] | undefined {
  if (!value) return undefined;
  const allowed = new Set<CanvastModality>(["text", "image", "audio", "video"]);
  const parsed = value.split(",").map(item => item.trim().toLowerCase()).filter(Boolean) as CanvastModality[];
  const filtered = parsed.filter(item => allowed.has(item));
  return filtered.length ? Array.from(new Set(filtered)) : undefined;
}

function clampContextWindow(value: number): number {
  return Math.max(MIN_CONTEXT_WINDOW, value);
}

function isCommercialOpenSourceLicense(license: string | undefined): boolean {
  if (!license) return true;
  return COMMERCIAL_OPEN_SOURCE_LICENSES.has(license.trim().toLowerCase());
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizeModalities(values: unknown): CanvastModality[] | undefined {
  const allowed = new Set<CanvastModality>(["text", "image", "audio", "video"]);
  const modalities = asStringArray(values)
    .map(item => item.trim().toLowerCase())
    .filter((item): item is CanvastModality => allowed.has(item as CanvastModality));
  return modalities.length ? Array.from(new Set(modalities)) : undefined;
}

function deriveModalities(record: Record<string, unknown>): CanvastModality[] {
  const explicit = normalizeModalities(record.supported_modalities ?? record.modalities ?? record.input_modalities);
  const modalities = new Set<CanvastModality>(explicit || ["text"]);
  if (record.supports_vision === true || record.supportsVision === true) modalities.add("image");
  if (record.supports_audio_input === true || record.supportsAudioInput === true) modalities.add("audio");
  return Array.from(modalities);
}

function reliabilityFromFlag(flag: unknown): ToolUseReliability {
  return flag === true ? "stable" : "none";
}

function structuredFromRecord(record: Record<string, unknown>): StructuredOutputReliability {
  return record.supports_response_schema === true ||
    record.supportsResponseSchema === true ||
    record.structuredOutput === true
    ? "stable"
    : "basic";
}

function normalizeLicense(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeCanvastRegistry(doc: unknown, source: ModelCapabilitySource): RegistryModelCapabilities[] {
  const root = asRecord(doc);
  const models = Array.isArray(root?.models) ? root.models : Array.isArray(doc) ? doc : [];
  const license = normalizeLicense(root?.license) || source.license;
  return models.flatMap((item) => {
    const record = asRecord(item);
    if (!record) return [];
    const id = String(record.id ?? record.model ?? "").trim();
    if (!id) return [];
    const provider = typeof record.provider === "string" ? record.provider.trim().toLowerCase() : undefined;
    return [{
      id,
      provider,
      contextWindowTokens: positiveInt(record.contextWindowTokens ?? record.context_window_tokens ?? record.contextLength),
      recommendedMaxOutputTokens: positiveInt(record.recommendedMaxOutputTokens ?? record.maxOutputTokens ?? record.max_output_tokens),
      reasoningEffort: parseReasoningEffort(record.reasoningEffort),
      modalities: normalizeModalities(record.modalities),
      toolUse: parseToolUse(record.toolUse),
      structuredOutput: parseStructuredOutput(record.structuredOutput),
      supportsParallelToolCalls: typeof record.supportsParallelToolCalls === "boolean" ? record.supportsParallelToolCalls : undefined,
      supportsWebSearch: typeof record.supportsWebSearch === "boolean" ? record.supportsWebSearch : undefined,
      supportsReasoning: typeof record.supportsReasoning === "boolean" ? record.supportsReasoning : undefined,
      source: { ...source, format: "canvast" as const, license },
    }];
  });
}

function normalizeLiteLlmRegistry(doc: unknown, source: ModelCapabilitySource): RegistryModelCapabilities[] {
  const root = asRecord(doc);
  if (!root) return [];
  const license = normalizeLicense(root.license) || source.license || "MIT";
  return Object.entries(root).flatMap(([id, value]) => {
    const record = asRecord(value);
    if (!record) return [];
    if (id === "sample_spec" || typeof record.mode !== "string") return [];
    const provider = typeof record.litellm_provider === "string"
      ? record.litellm_provider.trim().toLowerCase()
      : undefined;
    const supportsReasoning = record.supports_reasoning === true;
    return [{
      id,
      provider,
      contextWindowTokens: positiveInt(record.max_input_tokens ?? record.context_window ?? record.context_length ?? record.max_tokens),
      recommendedMaxOutputTokens: positiveInt(record.max_output_tokens ?? record.max_tokens),
      reasoningEffort: supportsReasoning ? "high" as const : undefined,
      modalities: deriveModalities(record),
      toolUse: reliabilityFromFlag(record.supports_function_calling),
      structuredOutput: structuredFromRecord(record),
      supportsParallelToolCalls: record.supports_parallel_function_calling === true,
      supportsWebSearch: record.supports_web_search === true,
      supportsReasoning,
      source: { ...source, format: "litellm" as const, license },
    }];
  });
}

function normalizeOpenRouterRegistry(doc: unknown, source: ModelCapabilitySource): RegistryModelCapabilities[] {
  const root = asRecord(doc);
  const models = Array.isArray(root?.data) ? root.data : Array.isArray(root?.models) ? root.models : [];
  const license = normalizeLicense(root?.license) || source.license;
  return models.flatMap((item) => {
    const record = asRecord(item);
    const architecture = asRecord(record?.architecture);
    if (!record) return [];
    const id = String(record.id ?? record.slug ?? "").trim();
    if (!id) return [];
    const supported = new Set(asStringArray(record.supported_parameters).map(value => value.toLowerCase()));
    const modalities = normalizeModalities(architecture?.input_modalities ?? record.input_modalities);
    return [{
      id,
      provider: id.includes("/") ? id.split("/")[0].toLowerCase() : undefined,
      contextWindowTokens: positiveInt(record.context_length ?? record.contextLength),
      recommendedMaxOutputTokens: positiveInt(record.top_provider && asRecord(record.top_provider)?.max_completion_tokens),
      modalities,
      toolUse: supported.has("tools") || supported.has("tool_choice") ? "stable" as const : "none" as const,
      structuredOutput: supported.has("response_format") || supported.has("structured_outputs") ? "stable" as const : "basic" as const,
      supportsParallelToolCalls: supported.has("parallel_tool_calls"),
      supportsWebSearch: supported.has("web_search"),
      supportsReasoning: supported.has("reasoning"),
      reasoningEffort: supported.has("reasoning") ? "high" as const : undefined,
      source: { ...source, format: "openrouter" as const, license },
    }];
  });
}

function detectAndNormalizeRegistry(doc: unknown, source: ModelCapabilitySource): RegistryModelCapabilities[] {
  const root = asRecord(doc);
  if (Array.isArray(root?.data)) return normalizeOpenRouterRegistry(doc, source);
  if (Array.isArray(root?.models) || Array.isArray(doc)) return normalizeCanvastRegistry(doc, source);
  const values = root ? Object.values(root).slice(0, 20) : [];
  if (values.some(value => Boolean(asRecord(value)?.litellm_provider))) {
    return normalizeLiteLlmRegistry(doc, source);
  }
  return normalizeCanvastRegistry(doc, source);
}

function registryPathsFromEnv(env: NodeJS.ProcessEnv, cwd: string): string[] {
  const paths: string[] = [];
  const append = (value: string | undefined) => {
    if (!value) return;
    for (const item of value.split(path.delimiter)) {
      const trimmed = item.trim();
      if (trimmed) paths.push(trimmed);
    }
  };
  append(env.CANVAST_MODEL_REGISTRY_PATH);
  append(env.CANVAST_MODEL_REGISTRY_PATHS);

  const projectRoot = env.CANVAST_PROJECT_ROOT || cwd;
  const canvastHome = env.CANVAST_HOME || (env.HOME ? path.join(env.HOME, ".canvast") : undefined);
  paths.push(path.join(projectRoot, ".canvast", "model-registry.json"));
  paths.push(path.join(projectRoot, ".canvast-model-registry.json"));
  if (canvastHome) paths.push(path.join(canvastHome, "model-registry.json"));
  return Array.from(new Set(paths));
}

function loadRegistryEntries(
  env: NodeJS.ProcessEnv,
  cwd: string,
  registryPaths: string[],
  registryDocuments: unknown[] = [],
): RegistryModelCapabilities[] {
  const fileKeys = registryPaths.map((file) => {
    try {
      const stat = fs.statSync(file);
      return `${path.resolve(file)}:${stat.mtimeMs}:${stat.size}`;
    } catch {
      return `${path.resolve(file)}:missing`;
    }
  });
  const key = JSON.stringify({ fileKeys, inlineCount: registryDocuments.length });
  if (!registryDocuments.length && registryCache?.key === key) return registryCache.entries;

  const entries: RegistryModelCapabilities[] = [];
  for (const doc of registryDocuments) {
    entries.push(...detectAndNormalizeRegistry(doc, { kind: "registry" }));
  }
  for (const file of registryPaths) {
    if (!fs.existsSync(file)) continue;
    try {
      const doc = JSON.parse(fs.readFileSync(file, "utf-8"));
      const source: ModelCapabilitySource = { kind: "registry", path: path.resolve(file) };
      entries.push(...detectAndNormalizeRegistry(doc, source));
    } catch {
      if (boolFromEnv(env.CANVAST_MODEL_REGISTRY_STRICT)) throw new Error(`Invalid model registry: ${file}`);
    }
  }

  const requireCommercial = boolFromEnv(env.CANVAST_REQUIRE_COMMERCIAL_MODEL_REGISTRY) === true;
  const filtered = requireCommercial
    ? entries.filter(entry => isCommercialOpenSourceLicense(entry.source.license))
    : entries;
  if (!registryDocuments.length) registryCache = { key, entries: filtered };
  return filtered;
}

function normalizeId(value: string): string {
  return value.trim().toLowerCase();
}

function matchScore(entry: RegistryModelCapabilities, identity: ModelIdentity): number {
  const entryId = normalizeId(entry.id);
  const provider = normalizeId(identity.provider);
  const model = normalizeId(identity.model);
  const modelRef = normalizeId(identity.modelRef);
  const providerModel = `${provider}/${model}`;
  const entryProvider = entry.provider ? normalizeId(entry.provider) : undefined;

  if (entryId === providerModel) return 100;
  if (entryProvider === provider && entryId === model) return 95;
  if (entryId === modelRef) return 90;
  if (entryProvider === provider && entryId.endsWith(`/${model}`)) return 80;
  if (!entryProvider && entryId === model) return 70;
  return 0;
}

function findRegistryMatch(entries: RegistryModelCapabilities[], identity: ModelIdentity): RegistryModelCapabilities | undefined {
  return entries
    .map(entry => ({ entry, score: matchScore(entry, identity) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.entry;
}

function parseReasoningEffort(value: unknown): ModelCapabilities["reasoningEffort"] | undefined {
  return value === "off" || value === "low" || value === "medium" || value === "high"
    ? value
    : undefined;
}

function parseToolUse(value: unknown): ToolUseReliability | undefined {
  return value === "none" || value === "basic" || value === "stable" ? value : undefined;
}

function parseStructuredOutput(value: unknown): StructuredOutputReliability | undefined {
  return value === "none" || value === "basic" || value === "stable" ? value : undefined;
}

function deriveUsableContext(contextWindowTokens: number, env: NodeJS.ProcessEnv): number {
  const configured = positiveInt(env.CANVAST_CONTEXT_BUDGET_CEILING_TOKENS);
  const safetyCap = configured ?? DEFAULT_USABLE_CONTEXT_CAP;
  return Math.max(4_000, Math.min(Math.floor(contextWindowTokens * 0.7), safetyCap));
}

function deriveToolBudget(contextWindowTokens: number, usableContextWindowTokens: number): { toolTokens: number; inlineBytes: number; compactAt: number } {
  const toolTokens = Math.max(2_000, Math.min(32_000, Math.floor(usableContextWindowTokens * 0.08)));
  const inlineBytes = Math.max(64 * 1024, Math.min(1024 * 1024, toolTokens * 4));
  const compactAt = Math.max(6_000, Math.min(usableContextWindowTokens, Math.floor(contextWindowTokens * 0.72)));
  return { toolTokens, inlineBytes, compactAt };
}

export function resolveModelCapabilities(options: ResolveModelCapabilitiesOptions = {}): ModelCapabilities {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const identity = resolveModelIdentity(options);
  const registryPaths = options.registryPaths ?? registryPathsFromEnv(env, cwd);
  const entries = loadRegistryEntries(env, cwd, registryPaths, options.registryDocuments);
  const registry = findRegistryMatch(entries, identity);

  const contextWindowTokens = clampContextWindow(
    positiveInt(env.CANVAST_CONTEXT_WINDOW_TOKENS) ??
      registry?.contextWindowTokens ??
      FALLBACK_PRESET.contextWindowTokens,
  );
  const usableContextWindowTokens = positiveInt(env.CANVAST_USABLE_CONTEXT_WINDOW_TOKENS) ??
    deriveUsableContext(contextWindowTokens, env);
  const derived = deriveToolBudget(contextWindowTokens, usableContextWindowTokens);
  const modalities = parseModalities(env.CANVAST_MODEL_MODALITIES) ||
    registry?.modalities ||
    FALLBACK_PRESET.modalities;
  const supportsReasoning = boolFromEnv(env.CANVAST_MODEL_SUPPORTS_REASONING) ??
    registry?.supportsReasoning ??
    FALLBACK_PRESET.supportsReasoning;

  return {
    provider: identity.provider,
    model: identity.model,
    contextWindowTokens,
    usableContextWindowTokens,
    recommendedMaxOutputTokens: positiveInt(env.CANVAST_MAX_OUTPUT_TOKENS) ??
      registry?.recommendedMaxOutputTokens ??
      FALLBACK_PRESET.recommendedMaxOutputTokens,
    recommendedToolResultTokens: positiveInt(env.CANVAST_TOOL_RESULT_TOKENS) ?? derived.toolTokens,
    recommendedInlineToolResultBytes: positiveInt(env.CANVAST_TOOL_RESULT_BYTES) ?? derived.inlineBytes,
    autoCompactAtTokens: positiveInt(env.CANVAST_AUTO_COMPACT_TOKENS) ?? derived.compactAt,
    reasoningEffort: parseReasoningEffort(env.CANVAST_THINKING) ||
      registry?.reasoningEffort ||
      (supportsReasoning ? "high" : FALLBACK_PRESET.reasoningEffort),
    modalities,
    toolUse: parseToolUse(env.CANVAST_MODEL_TOOL_USE) || registry?.toolUse || FALLBACK_PRESET.toolUse,
    structuredOutput: parseStructuredOutput(env.CANVAST_MODEL_STRUCTURED_OUTPUT) ||
      registry?.structuredOutput ||
      FALLBACK_PRESET.structuredOutput,
    supportsParallelToolCalls: env.CANVAST_DISABLE_PARALLEL_TOOL_CALLS === "1"
      ? false
      : registry?.supportsParallelToolCalls ?? FALLBACK_PRESET.supportsParallelToolCalls,
    supportsWebSearch: boolFromEnv(env.CANVAST_MODEL_SUPPORTS_WEB_SEARCH) ??
      registry?.supportsWebSearch ??
      FALLBACK_PRESET.supportsWebSearch,
    supportsReasoning,
    source: registry
      ? { ...registry.source, matchedModel: registry.id }
      : { kind: "fallback" },
  };
}

export function modelContextCeiling(capabilities: ModelCapabilities): number {
  return Math.max(4_000, capabilities.usableContextWindowTokens);
}

export function modelBudgetDefaults(capabilities: ModelCapabilities): {
  hardCeiling: number;
  canvasScopeMax: number;
  recentHistoryMin: number;
  perFileTokens: number;
  maxFiles: number;
} {
  const hardCeiling = modelContextCeiling(capabilities);
  return {
    hardCeiling,
    canvasScopeMax: Math.max(2_000, Math.min(40_000, Math.floor(hardCeiling * 0.18))),
    recentHistoryMin: Math.max(2_000, Math.min(40_000, Math.floor(hardCeiling * 0.2))),
    perFileTokens: Math.max(800, Math.min(16_000, Math.floor(hardCeiling * 0.06))),
    maxFiles: capabilities.contextWindowTokens >= 200_000 ? 12 : capabilities.contextWindowTokens >= 100_000 ? 8 : 5,
  };
}
