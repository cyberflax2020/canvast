/**
 * =============================================================================
 * Canvast — Tool Domains / Canvast 源文件
 * =============================================================================
 * @file        src/harness/tool-domains.ts
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import type { ToolDomain } from "./auto-orchestrator.js";
import {
  hasAny,
  PLAN_TERMS,
  RESOURCE_TERMS,
  REVIEW_TERMS,
  SHELL_TERMS,
  TEST_TERMS,
  TUI_TERMS,
} from "./intent-signals.js";
import type { WebUsePolicy } from "./intent-signals.js";
import {
  hasConcreteFileMutationTarget,
  hasConcreteShellExecutionTarget,
  hasDependencyInstallIntent,
  hasPackageManagerMutation,
  hasTaskTrackingIntent,
  needsPackageDomain,
} from "./tool-intent.js";

export interface ToolDomainInferenceInput {
  normalized: string;
  requiresGate: boolean;
  requiresPlan: boolean;
  requiresSubagents: boolean;
  requiresWorkflow: boolean;
  requiresContextManagement: boolean;
  requiresTaskAdjustment: boolean;
  stateChangingTask: boolean;
  taskControlLike: boolean;
  webUsePolicy: WebUsePolicy;
  readOnlyIntent: boolean;
  planOnlyIntent: boolean;
  promptLocalContextValidation?: boolean;
  localScanLike: boolean;
  localSearchLike: boolean;
  ambiguousOptimizationIntent: boolean;
  planResearchProposal: boolean;
  planProposalIntent?: boolean;
  planRevisionFromProvidedState?: boolean;
  simpleWriteVerification: boolean;
}

function uniqueDomains(domains: ToolDomain[]): ToolDomain[] {
  return Array.from(new Set(domains));
}

export function inferToolDomains(input: ToolDomainInferenceInput): {
  requiredToolDomains: ToolDomain[];
  optionalToolDomains: ToolDomain[];
} {
  const required: ToolDomain[] = [];
  const optional: ToolDomain[] = [];
  const hasOrchestration = input.requiresPlan || input.requiresSubagents || input.requiresWorkflow;
  const needsFileWrite = !input.ambiguousOptimizationIntent &&
    !input.planProposalIntent &&
    (hasAny(input.normalized, PLAN_TERMS) || (input.stateChangingTask && hasConcreteFileMutationTarget(input.normalized))) &&
    !input.readOnlyIntent &&
    (!input.taskControlLike || hasConcreteFileMutationTarget(input.normalized));
  const needsShell = hasAny(input.normalized, SHELL_TERMS) &&
    !input.simpleWriteVerification &&
    !input.readOnlyIntent &&
    (!input.taskControlLike || hasConcreteShellExecutionTarget(input.normalized));
  const needsDependencyInstall = hasDependencyInstallIntent(input.normalized);
  const needsTaskTracking =
    input.ambiguousOptimizationIntent ||
    (input.taskControlLike && (!input.simpleWriteVerification || hasTaskTrackingIntent(input.normalized)));
  if (!input.requiresGate || !hasOrchestration) {
    const directToolDomainsNeeded = input.requiresGate || input.simpleWriteVerification;
    if (directToolDomainsNeeded && needsFileWrite) required.push("file_write");
    if (directToolDomainsNeeded && input.simpleWriteVerification) required.push("file_read");
    if (input.requiresGate && (needsShell || needsDependencyInstall)) required.push("shell");
    if (input.requiresGate && hasAny(input.normalized, TEST_TERMS) && !input.readOnlyIntent && !input.simpleWriteVerification) required.push("test");
    if (input.requiresGate && (needsPackageDomain(input.normalized) || needsDependencyInstall) && !input.readOnlyIntent) required.push("package");
    if (input.requiresGate && hasAny(input.normalized, TUI_TERMS)) required.push("tui");
    if (input.requiresGate && hasAny(input.normalized, RESOURCE_TERMS)) required.push("monitor");
    if (input.requiresGate && hasAny(input.normalized, REVIEW_TERMS)) optional.push("review");
    if (input.requiresGate && needsTaskTracking) required.push("task");
    if (input.requiresGate && input.localSearchLike) required.push("local_search");
    if (input.requiresGate && input.localScanLike && !input.localSearchLike) optional.push("shell");
    if (input.requiresContextManagement) required.push("canvas");
    if (input.requiresTaskAdjustment) required.push("task", "canvas");
    if (input.webUsePolicy === "required") required.push("web");
    else if (input.webUsePolicy === "conditional") optional.push("web");
    return {
      requiredToolDomains: uniqueDomains(required),
      optionalToolDomains: uniqueDomains(optional.filter(domain => !required.includes(domain))),
    };
  }

  if (input.planOnlyIntent) required.push("task");
  else if (input.planRevisionFromProvidedState) required.push("task", "canvas");
  else if (input.planProposalIntent) required.push("local_search", "file_read", "task", "canvas");
  else required.push("local_search", "file_read", "task", "canvas");
  if ((input.requiresPlan || needsFileWrite) && !input.readOnlyIntent && !input.planOnlyIntent && !input.planProposalIntent) required.push("file_write");
  if (input.simpleWriteVerification) required.push("file_read");
  if (input.requiresSubagents) required.push("agent");
  if (input.requiresWorkflow) required.push("workflow");
  if (needsShell || needsDependencyInstall) required.push("shell");
  if (hasAny(input.normalized, TEST_TERMS) && !input.readOnlyIntent && !input.simpleWriteVerification) required.push("test");
  if ((needsPackageDomain(input.normalized) || needsDependencyInstall) && !input.readOnlyIntent) required.push("package");
  if (hasAny(input.normalized, TUI_TERMS)) required.push("tui");
  if (hasAny(input.normalized, RESOURCE_TERMS)) required.push("monitor");
  if (hasAny(input.normalized, REVIEW_TERMS)) optional.push("review");
  if (needsTaskTracking) required.push("task");
  if (input.localScanLike) optional.push("shell");
  if (input.requiresTaskAdjustment) required.push("task", "canvas");
  if (input.webUsePolicy === "required") required.push("web");
  else if (input.webUsePolicy === "conditional") optional.push("web");

  return {
    requiredToolDomains: uniqueDomains(required),
    optionalToolDomains: uniqueDomains(optional.filter(domain => !required.includes(domain))),
  };
}
