/**
 * =============================================================================
 * Canvast — Grounding Policy / Canvast 源文件
 * =============================================================================
 * @file        src/harness/grounding-policy.ts
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */


export const GROUNDING_FACT_KINDS = [
  "current_external",
  "official_authorization",
  "local_business",
  "route_or_transit",
  "availability_or_status",
  "price_or_market",
  "technical_release",
  "other_external",
] as const;

export const GROUNDING_SOURCE_KINDS = [
  "official",
  "primary",
  "map_or_transit",
  "reputable_secondary",
  "user_provided",
  "local_project",
  "none",
] as const;

export const GROUNDING_FRESHNESS = [
  "stable",
  "current",
  "real_time",
] as const;

export const GROUNDING_UNAVAILABLE_POLICIES = [
  "state_unverified",
  "ask_for_source",
  "refuse_specific_claim",
  "answer_with_caveats",
] as const;

export const GROUNDING_CORRECTION_POLICIES = [
  "retract_and_reverify",
  "prefer_newer_authority",
  "keep_user_provided_as_claim",
] as const;

export type GroundingFactKind = typeof GROUNDING_FACT_KINDS[number];
export type GroundingSourceKind = typeof GROUNDING_SOURCE_KINDS[number];
export type GroundingFreshness = typeof GROUNDING_FRESHNESS[number];
export type GroundingUnavailablePolicy = typeof GROUNDING_UNAVAILABLE_POLICIES[number];
export type GroundingCorrectionPolicy = typeof GROUNDING_CORRECTION_POLICIES[number];

export interface GroundingRequirement {
  kind: GroundingFactKind;
  claim: string;
  freshness: GroundingFreshness;
  sourceKinds: GroundingSourceKind[];
}

export interface GroundingStrategy {
  requirements: GroundingRequirement[];
  preferredSources: GroundingSourceKind[];
  minimumSources: number;
  maxExternalCalls?: number;
  allowMemoryOnly: boolean;
  unavailablePolicy: GroundingUnavailablePolicy;
  correctionPolicy: GroundingCorrectionPolicy;
}

function isOneOf<T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
  return typeof value === "string" && allowed.includes(value);
}

function nonEmptyText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length >= 8;
}

function sourceKinds(value: unknown): GroundingSourceKind[] {
  if (!Array.isArray(value)) return [];
  return value.filter(item => isOneOf(item, GROUNDING_SOURCE_KINDS));
}

const INTERNAL_OR_USER_SOURCE_KINDS = new Set<GroundingSourceKind>([
  "local_project",
  "user_provided",
  "none",
]);

export function validateGroundingStrategy(value: unknown): string[] {
  const errors: string[] = [];
  if (!value || typeof value !== "object") return ["grounding_strategy must be an object"];
  const strategy = value as Partial<GroundingStrategy>;
  if (!Array.isArray(strategy.requirements) || strategy.requirements.length < 1) {
    errors.push("grounding_strategy.requirements must include at least one fact requirement");
  } else {
    strategy.requirements.forEach((requirement, index) => {
      const item = requirement as Partial<GroundingRequirement>;
      if (!isOneOf(item.kind, GROUNDING_FACT_KINDS)) {
        errors.push(`grounding_strategy.requirements[${index}].kind is invalid`);
      }
      if (!nonEmptyText(item.claim)) {
        errors.push(`grounding_strategy.requirements[${index}].claim must describe the fact to verify`);
      }
      if (!isOneOf(item.freshness, GROUNDING_FRESHNESS)) {
        errors.push(`grounding_strategy.requirements[${index}].freshness is invalid`);
      }
      if (sourceKinds(item.sourceKinds).length < 1) {
        errors.push(`grounding_strategy.requirements[${index}].source_kinds must include at least one source kind`);
      }
    });
  }
  if (sourceKinds(strategy.preferredSources).length < 1) {
    errors.push("grounding_strategy.preferred_sources must include at least one source kind");
  }
  if (!Number.isInteger(strategy.minimumSources) || Number(strategy.minimumSources) < 1) {
    errors.push("grounding_strategy.minimum_sources must be a positive integer");
  }
  if (
    strategy.maxExternalCalls !== undefined &&
    (!Number.isInteger(strategy.maxExternalCalls) || Number(strategy.maxExternalCalls) < 1)
  ) {
    errors.push("grounding_strategy.max_external_calls must be a positive integer when provided");
  }
  if (typeof strategy.allowMemoryOnly !== "boolean") {
    errors.push("grounding_strategy.allow_memory_only must be boolean");
  }
  if (!isOneOf(strategy.unavailablePolicy, GROUNDING_UNAVAILABLE_POLICIES)) {
    errors.push("grounding_strategy.unavailable_policy is invalid");
  }
  if (!isOneOf(strategy.correctionPolicy, GROUNDING_CORRECTION_POLICIES)) {
    errors.push("grounding_strategy.correction_policy is invalid");
  }
  return errors;
}

export function hasUsableGroundingStrategy(value: unknown): value is GroundingStrategy {
  return validateGroundingStrategy(value).length === 0;
}

export function groundingRequiresExternalEvidence(strategy: GroundingStrategy): boolean {
  return strategy.requirements.some(requirement =>
    requirement.sourceKinds.some(kind => !INTERNAL_OR_USER_SOURCE_KINDS.has(kind)),
  );
}

export function groundingStrategySummary(strategy: GroundingStrategy): string {
  const facts = strategy.requirements
    .map(item => `${item.kind}/${item.freshness}`)
    .join(", ");
  return [
    `facts=${facts}`,
    `sources=${strategy.preferredSources.join(",")}`,
    `minimum_sources=${strategy.minimumSources}`,
    strategy.maxExternalCalls === undefined ? "" : `max_external_calls=${strategy.maxExternalCalls}`,
    `allow_memory_only=${strategy.allowMemoryOnly}`,
    `unavailable=${strategy.unavailablePolicy}`,
    `correction=${strategy.correctionPolicy}`,
  ].filter(Boolean).join("; ");
}
