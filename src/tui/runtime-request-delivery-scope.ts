/**
 * =============================================================================
 * Canvast — Runtime Request Delivery Scope / 运行时请求交付范围
 * =============================================================================
 * @file        src/tui/runtime-request-delivery-scope.ts
 * @brief       Resolves typed delivery-closure scope from explicit metadata.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import type { RuntimeRequestDeliveryScope } from "../harness/runtime-status.js";

export interface RuntimeRequestDeliveryScopeSource {
  deliveryScope?: unknown;
  metadata?: unknown;
  requestMetadata?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRuntimeRequestDeliveryScope(value: unknown): RuntimeRequestDeliveryScope | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "ambient" || value.kind === "whole_project_delivery") {
    return { kind: value.kind };
  }
  return undefined;
}

function nestedCanvastScope(value: unknown): RuntimeRequestDeliveryScope | undefined {
  if (!isRecord(value)) return undefined;
  return normalizeRuntimeRequestDeliveryScope(value.deliveryScope) ||
    normalizeRuntimeRequestDeliveryScope(value.delivery_scope) ||
    nestedCanvastScope(value.canvast);
}

export function resolveRuntimeRequestDeliveryScope(
  ctx: RuntimeRequestDeliveryScopeSource | undefined,
  explicitScope?: RuntimeRequestDeliveryScope,
): RuntimeRequestDeliveryScope | undefined {
  if (explicitScope) return explicitScope;
  if (!ctx) return undefined;
  return normalizeRuntimeRequestDeliveryScope(ctx.deliveryScope) ||
    nestedCanvastScope(ctx.requestMetadata) ||
    nestedCanvastScope(ctx.metadata);
}
