/**
 * =============================================================================
 * Canvast — Web Tools Registration / Canvast 源文件
 * =============================================================================
 * @file        extensions/web-tools/register-tools.ts
 * @brief       Registers the three public Canvast web tools.
 * @description Preserves the extension's public schemas and result contracts
 *              while composing budget, transport, and source-text modules.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  GROUNDING_CORRECTION_POLICIES,
  GROUNDING_FACT_KINDS,
  GROUNDING_FRESHNESS,
  GROUNDING_SOURCE_KINDS,
  GROUNDING_UNAVAILABLE_POLICIES,
} from "../../src/harness/grounding-policy.js";
import {
  allowedByDomains,
  extractFocusedText,
  headTail,
  hostOf,
  mergeFocusTerms,
  normalizeFocusTerms,
  summarizeEvidence,
} from "./parse.js";
import type { SourceTextTools } from "./source-text.js";
import { errorMessage, fetchText, searchWeb, thrownFailureStatus } from "./transport.js";
import type {
  RetrievalStrategy,
  SourceConvergenceState,
  StructuredWebOutcome,
  WebBudgetRuntime,
  WebSyntax,
  WebToolResult,
} from "./types.js";

const FETCH_TIMEOUT_MS = 15_000;
const SEARCH_TIMEOUT_MS = 20_000;
const MAX_FETCH_CHARS = 50_000;

function literalUnion(values: readonly string[]) {
  return Type.Union(values.map(value => Type.Literal(value)) as any);
}

const groundingStrategyParam = Type.Optional(Type.Object({
  requirements: Type.Array(Type.Object({
    kind: literalUnion(GROUNDING_FACT_KINDS),
    claim: Type.String(),
    freshness: literalUnion(GROUNDING_FRESHNESS),
    source_kinds: Type.Array(literalUnion(GROUNDING_SOURCE_KINDS)),
  })),
  preferred_sources: Type.Array(literalUnion(GROUNDING_SOURCE_KINDS)),
  minimum_sources: Type.Number(),
  max_external_calls: Type.Optional(Type.Number()),
  allow_memory_only: Type.Boolean(),
  unavailable_policy: literalUnion(GROUNDING_UNAVAILABLE_POLICIES),
  correction_policy: literalUnion(GROUNDING_CORRECTION_POLICIES),
}));

const retrievalStrategyParam = Type.Optional(Type.Object({
  mode: Type.Optional(literalUnion([
    "general_evidence",
    "exact_source_text",
  ] as const)),
  required_terms: Type.Optional(Type.Array(Type.String({
    description: "Exact anchors that must appear in source text or search snippets / 原文或摘要中必须出现的明确锚点",
  }))),
  unit_hints: Type.Optional(Type.Array(Type.String({
    description: "Named or numbered unit anchors supplied by the caller / 调用方提供的命名或编号单元锚点",
  }))),
}));

type ToolRegistrationDependencies = {
  syntax: WebSyntax;
  sourceText: SourceTextTools;
  hasEvidenceReason: (justification: string, groundingStrategy: any) => boolean;
  needsGroundedExternalBudget: (groundingStrategy: any) => boolean;
  normalizedScopeText: (value: unknown) => string;
  sourceTextScope: (groundingStrategy: any, explicitScope?: string) => string;
  sourceTextElasticOptions: (
    groundingStrategy: any,
    explicitScope: string | undefined,
    retrievalStrategy: RetrievalStrategy,
  ) => {
    getSourceTextState: () => SourceConvergenceState | undefined;
    onElasticState: (state: SourceConvergenceState) => void;
  } | undefined;
  sourceConvergenceStates: Map<string, SourceConvergenceState>;
  withWebBudget: <T>(
    groundingStrategy: any,
    groundingScope: string | undefined,
    options: {
      getSourceTextState?: () => SourceConvergenceState | undefined;
      onElasticState?: (state: SourceConvergenceState) => void;
    } | undefined,
    run: (runtime: WebBudgetRuntime) => Promise<T>,
  ) => Promise<T | WebToolResult>;
  failedWebToolResult: (
    operation: "web_search" | "web_research" | "web_fetch",
    outcome: {
      status: StructuredWebOutcome["status"];
      message?: string;
      error?: string;
      httpStatus?: number;
      attempts?: StructuredWebOutcome["attempts"];
    },
  ) => WebToolResult;
};

export function registerWebTools(
  pi: ExtensionAPI,
  dependencies: ToolRegistrationDependencies,
): void {
  const {
    syntax,
    sourceText,
    hasEvidenceReason,
    needsGroundedExternalBudget,
    normalizedScopeText,
    sourceTextScope,
    sourceTextElasticOptions,
    sourceConvergenceStates,
    withWebBudget,
    failedWebToolResult,
  } = dependencies;

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "抓取指定URL的内容并提取文本。传入URL获取网页内容。",
    parameters: Type.Object({
      url: Type.String({ description: "要抓取的URL" }),
      justification: Type.Optional(Type.String({
        description: "Concrete current/external evidence reason / 具体外部或当前事实需求",
      })),
      grounding_strategy: groundingStrategyParam,
      retrieval_strategy: retrievalStrategyParam,
      grounding_scope: Type.Optional(Type.String({
        description: "Stable scope id for one factual task. Same scope shares one evidence budget; independent tasks should use different scopes. / 单个事实任务的稳定范围标识；同范围共享预算，独立任务使用不同范围。",
      })),
      focus_terms: Type.Optional(Type.Array(Type.String({
        description: "Exact terms to extract surrounding context for long pages / 长页面定位片段的明确术语",
      }))),
      context_chars: Type.Optional(Type.Number({
        description: "Context characters around each focus term / 每个定位术语前后字符数",
        default: 2500,
      })),
      prompt: Type.Optional(Type.String({ description: "可选分析提示" })),
    }),
    async execute(_id, params, signal) {
      const { url, prompt, justification } = params;
      if (!hasEvidenceReason(
        String(justification || ""),
        params.grounding_strategy,
      )) {
        return failedWebToolResult("web_fetch", {
          status: "invalid_request",
          message: "web_fetch requires either a concrete external/current evidence justification or a typed grounding_strategy. Do not use web tools by default. / web_fetch 必须提供具体外部/当前事实理由，或结构化 grounding_strategy，不能默认联网。",
        });
      }
      try {
        const retrievalStrategy = sourceText.normalizeRetrievalStrategy(
          params.retrieval_strategy,
        );
        return await withWebBudget(
          params.grounding_strategy,
          params.grounding_scope,
          sourceTextElasticOptions(
            params.grounding_strategy,
            params.grounding_scope,
            retrievalStrategy,
          ),
          async runtime => {
            const fetched = await fetchText(
              url,
              syntax,
              signal,
              runtime.timeoutFor(FETCH_TIMEOUT_MS),
            );
            if (!fetched.ok) {
              return failedWebToolResult("web_fetch", fetched);
            }
            const focusTerms = mergeFocusTerms(
              sourceText.cleanFocusTerm,
              normalizeFocusTerms(params.focus_terms),
              sourceText.retrievalAnchorTerms(retrievalStrategy),
            );
            const contextChars = Math.max(
              400,
              Math.min(Number(params.context_chars || 2500), 12_000),
            );
            const body = focusTerms.length > 0
              ? extractFocusedText(
                fetched.text,
                focusTerms,
                contextChars,
                MAX_FETCH_CHARS,
              )
              : {
                ...headTail(fetched.text, MAX_FETCH_CHARS),
                focused: false,
                matchedTerms: [] as string[],
              };
            const scoped = needsGroundedExternalBudget(
              params.grounding_strategy,
            ) || Boolean(normalizedScopeText(params.grounding_scope));
            const scope = sourceTextScope(
              params.grounding_strategy,
              params.grounding_scope,
            );
            const previousConvergence = scoped
              ? sourceConvergenceStates.get(scope)
              : undefined;
            const focusMiss = focusTerms.length > 0 && body.focused !== true;
            if (scoped && focusMiss) {
              const missed = sourceText.markSourceTextFetchMiss(
                previousConvergence,
                fetched.url,
              );
              if (missed) sourceConvergenceStates.set(scope, missed);
            }
            const contextualTerms = sourceText.extractContextualSignalTerms(
              body.text,
              [...focusTerms, ...body.matchedTerms],
            );
            const followUpTerms = Array.from(new Set([
              ...body.matchedTerms.filter(
                sourceText.isReusableSourceTextTerm,
              ),
              ...sourceText
                .extractFocusTermsFromText(body.text, retrievalStrategy)
                .filter(sourceText.isReusableSourceTextTerm),
              ...contextualTerms,
            ])).slice(0, 8);
            const followUpQueries = sourceText.buildExactQueries(
              prompt || fetched.title,
              followUpTerms,
            );
            if (scoped) {
              const current = sourceConvergenceStates.get(scope)
                || previousConvergence;
              const merged = sourceText.mergeFetchedSourceSignals(current, {
                focusTerms: followUpTerms,
                exactQueries: followUpQueries,
              });
              if (merged) sourceConvergenceStates.set(scope, merged);
            }
            const convergenceHint = scoped
              ? sourceText.formatSourceTextNextAction(
                sourceConvergenceStates.get(scope),
              )
              : "";
            const result = [
              `# WebFetch: ${fetched.url}`,
              prompt ? `提示: ${prompt}` : "",
              focusTerms.length > 0
                ? `Focus terms: ${focusTerms.join(", ")}`
                : "",
              body.focused === true
                ? `Matched terms: ${body.matchedTerms.join(", ") || "none"}`
                : "",
              focusMiss
                ? "Focus miss: requested focus_terms were not found in this fetched text. Treat this URL as low-signal for the exact source-text task and move to the next queued fetch/search candidate."
                : "",
              body.capped
                ? "Note: output was capped after extraction; refine focus_terms for narrower evidence."
                : "",
              followUpTerms.length > 0
                ? `Source-text confirmation terms: ${followUpTerms.join(" | ")}`
                : "",
              followUpQueries.length > 0
                ? `Suggested exact follow-up searches: ${followUpQueries.join(" || ")}`
                : "",
              followUpTerms.length > 0
                ? "For source-text verification, use these concrete terms with the original target in the next web_search to find an independent confirming URL; stop when the complete text plus an independent corroboration are present."
                : "",
              convergenceHint,
              "---",
              body.text,
            ].filter(Boolean).join("\n");
            return {
              content: [{ type: "text" as const, text: result }],
              details: {
                title: fetched.title,
                url: fetched.url,
                focused: body.focused,
                matchedTerms: body.matchedTerms,
                capped: body.capped,
                sourceChars: fetched.text.length,
                outcome: {
                  operation: "web_fetch",
                  status: "results",
                  failed: false,
                  resultCount: 1,
                } satisfies StructuredWebOutcome,
              },
            };
          },
        );
      } catch (error) {
        return failedWebToolResult("web_fetch", {
          status: thrownFailureStatus(error),
          message: errorMessage(error),
        });
      }
    },
  });

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search external web content through the configured search adapter. The default adapter calls DuckDuckGo Instant Answer first, then DuckDuckGo HTML fallback.",
    parameters: Type.Object({
      query: Type.String({ description: "搜索查询" }),
      justification: Type.Optional(Type.String({
        description: "Concrete current/external evidence reason / 具体外部或当前事实需求",
      })),
      grounding_strategy: groundingStrategyParam,
      retrieval_strategy: retrievalStrategyParam,
      grounding_scope: Type.Optional(Type.String({
        description: "Stable scope id for one factual task. Same scope shares one evidence budget; independent tasks should use different scopes. / 单个事实任务的稳定范围标识；同范围共享预算，独立任务使用不同范围。",
      })),
      max_results: Type.Optional(Type.Number({
        description: "最大结果数",
        default: 10,
      })),
      allowed_domains: Type.Optional(Type.Array(Type.String({
        description: "Allowed domain suffix / 允许域名后缀",
      }))),
      blocked_domains: Type.Optional(Type.Array(Type.String({
        description: "Blocked domain suffix / 禁止域名后缀",
      }))),
    }),
    async execute(_id, params, signal) {
      const {
        query,
        justification,
        max_results = 10,
        allowed_domains = [],
        blocked_domains = [],
      } = params;
      if (!hasEvidenceReason(
        String(justification || ""),
        params.grounding_strategy,
      )) {
        return failedWebToolResult("web_search", {
          status: "invalid_request",
          message: "web_search requires either a concrete external/current evidence justification or a typed grounding_strategy. Do not use web tools by default. / web_search 必须提供具体外部/当前事实理由，或结构化 grounding_strategy，不能默认联网。",
        });
      }
      try {
        const retrievalStrategy = sourceText.normalizeRetrievalStrategy(
          params.retrieval_strategy,
        );
        return await withWebBudget(
          params.grounding_strategy,
          params.grounding_scope,
          sourceTextElasticOptions(
            params.grounding_strategy,
            params.grounding_scope,
            retrievalStrategy,
          ),
          async runtime => {
            const searchOutcome = await searchWeb(
              query,
              max_results * 2,
              syntax,
              signal,
              runtime.timeoutFor(SEARCH_TIMEOUT_MS),
            );
            if (searchOutcome.failed) {
              return failedWebToolResult("web_search", searchOutcome);
            }
            const results = searchOutcome.results
              .filter(result =>
                allowed_domains.length === 0
                  ? !result.url
                    || allowedByDomains(
                      result.url,
                      allowed_domains,
                      blocked_domains,
                    )
                  : Boolean(result.url)
                    && allowedByDomains(
                      result.url,
                      allowed_domains,
                      blocked_domains,
                    )
              )
              .map((result, index) => ({ result, index }))
              .sort((a, b) =>
                sourceText.profileSearchResultWithStrategy(
                  a.result,
                  query,
                  retrievalStrategy,
                ).rank
                - sourceText.profileSearchResultWithStrategy(
                  b.result,
                  query,
                  retrievalStrategy,
                ).rank
                || a.index - b.index
              )
              .map(item => item.result);

            const visibleResults = results.slice(0, max_results);
            const profiled = visibleResults.map(result => ({
              result,
              profile: sourceText.profileSearchResultWithStrategy(
                result,
                query,
                retrievalStrategy,
              ),
            }));
            const scoped = needsGroundedExternalBudget(
              params.grounding_strategy,
            ) || Boolean(normalizedScopeText(params.grounding_scope));
            const scope = sourceTextScope(
              params.grounding_strategy,
              params.grounding_scope,
            );
            if (
              scoped
              && sourceText.wantsExactSourceText(retrievalStrategy)
            ) {
              sourceConvergenceStates.set(
                scope,
                sourceText.mergeSourceConvergenceState(
                  sourceConvergenceStates.get(scope),
                  profiled,
                ),
              );
            }
            const formatted = profiled.map((item, index) =>
              sourceText.formatSearchResult(
                item.result,
                index,
                item.profile,
              )
            ).join("\n\n");

            const exactHint = sourceText.wantsExactSourceText(
              retrievalStrategy,
            ) && profiled.some(item =>
              item.profile.shapes.includes("exact-fragment candidate")
            )
              ? [
                "",
                "Exact-fragment candidates are ranked first. For exact source-text tasks, fetch those URLs next with focus_terms copied from the visible formula/condition/problem fragments before issuing broader searches.",
                "精确片段候选已优先排序。对于条款、规范、引用段落等精确原文检索，请下一步优先 fetch 这些 URL，并把摘要里的显式锚点/条件片段作为 focus_terms；不要先继续泛搜。",
              ].join("\n")
              : "";
            const triage = sourceText.wantsExactSourceText(retrievalStrategy)
              ? sourceText.formatSourceTextTriage(query, profiled)
              : "";
            const convergenceHint = scoped
              && sourceText.wantsExactSourceText(retrievalStrategy)
              ? sourceText.formatSourceTextNextAction(
                sourceConvergenceStates.get(scope),
              )
              : "";

            const resultCount = profiled.length;
            return {
              content: [{
                type: "text" as const,
                text: `# WebSearch: "${query}"\n${formatted || "无结果"}${exactHint}${triage}${convergenceHint}`,
              }],
              details: {
                outcome: {
                  operation: "web_search",
                  status: resultCount > 0 ? "results" : "empty",
                  failed: false,
                  resultCount,
                  attempts: searchOutcome.attempts,
                } satisfies StructuredWebOutcome,
              },
            };
          },
        );
      } catch (error) {
        return failedWebToolResult("web_search", {
          status: thrownFailureStatus(error),
          message: errorMessage(error),
        });
      }
    },
  });

  pi.registerTool({
    name: "web_research",
    label: "Web Research / 联网研究整理",
    description:
      "Search, fetch, and organize external evidence with source citations. Use only when current/external facts, explicit URLs/downloads, missing dependencies, or a stated evidence gap justify web access.",
    parameters: Type.Object({
      question: Type.String({ description: "Research question / 研究问题" }),
      justification: Type.Optional(Type.String({
        description: "Why web access is needed / 为什么需要联网",
      })),
      grounding_strategy: groundingStrategyParam,
      retrieval_strategy: retrievalStrategyParam,
      grounding_scope: Type.Optional(Type.String({
        description: "Stable scope id for one factual task. Same scope shares one evidence budget; independent tasks should use different scopes. / 单个事实任务的稳定范围标识；同范围共享预算，独立任务使用不同范围。",
      })),
      max_sources: Type.Optional(Type.Number({ default: 4 })),
      allowed_domains: Type.Optional(Type.Array(Type.String())),
      blocked_domains: Type.Optional(Type.Array(Type.String())),
      fetch_top: Type.Optional(Type.Number({ default: 3 })),
    }),
    async execute(_id, params, signal) {
      const question = String(params.question || "");
      const justification = String(params.justification || "");
      if (!hasEvidenceReason(justification, params.grounding_strategy)) {
        return failedWebToolResult("web_research", {
          status: "invalid_request",
          message: "web_research requires either a concrete external/current evidence justification or a typed grounding_strategy. Do not use web tools by default. / web_research 必须提供具体外部/当前事实理由，或结构化 grounding_strategy，不能默认联网。",
        });
      }

      const retrievalStrategy = sourceText.normalizeRetrievalStrategy(
        params.retrieval_strategy,
      );
      try {
        return await withWebBudget(
          params.grounding_strategy,
          params.grounding_scope,
          sourceTextElasticOptions(
            params.grounding_strategy,
            params.grounding_scope,
            retrievalStrategy,
          ),
          async runtime => {
            const maxSources = Math.max(
              1,
              Math.min(Number(params.max_sources || 4), 8),
            );
            const fetchTop = params.fetch_top ?? Math.min(3, maxSources);
            if (typeof fetchTop !== "number"
              || !Number.isFinite(fetchTop)
              || !Number.isInteger(fetchTop)
              || fetchTop < 0 || fetchTop > maxSources) {
              return failedWebToolResult("web_research", {
                status: "invalid_request",
                message: `fetch_top must be a finite integer between 0 and max_sources (${maxSources}).`,
              });
            }
            const allowed = params.allowed_domains || [];
            const blocked = params.blocked_domains || [];
            const searchOutcome = await searchWeb(
              question,
              maxSources * 3,
              syntax,
              signal,
              runtime.timeoutFor(SEARCH_TIMEOUT_MS),
            );
            if (searchOutcome.failed) {
              return failedWebToolResult("web_research", searchOutcome);
            }
            const results = searchOutcome.results
              .filter(result =>
                result.url
                && allowedByDomains(result.url, allowed, blocked)
              )
              .map((result, index) => ({
                result,
                index,
                profile: sourceText.profileSearchResultWithStrategy(
                  result,
                  question,
                  retrievalStrategy,
                ),
              }))
              .sort((a, b) =>
                a.profile.rank - b.profile.rank || a.index - b.index
              )
              .map(item => item.result)
              .slice(0, maxSources);

            const sources: Array<{
              title: string;
              url: string;
              snippet: string;
              fetched?: string;
              error?: string;
            }> = [];
            for (let index = 0; index < results.length; index += 1) {
              const result = results[index];
              const source = {
                title: result.title,
                url: result.url,
                snippet: result.snippet,
              } as {
                title: string;
                url: string;
                snippet: string;
                fetched?: string;
                error?: string;
              };
              if (index < fetchTop) {
                const continueCheck = runtime.checkCanContinue();
                if (!continueCheck.ok) {
                  source.error = continueCheck.message;
                  sources.push(source);
                  break;
                }
                const fetched = await fetchText(
                  result.url,
                  syntax,
                  signal,
                  runtime.timeoutFor(FETCH_TIMEOUT_MS),
                );
                if (fetched.ok) {
                  source.title = fetched.title || source.title;
                  source.url = fetched.url;
                  source.fetched = fetched.text;
                } else {
                  if (fetched.status === "cancelled") {
                    return failedWebToolResult("web_research", fetched);
                  }
                  source.error = fetched.error;
                }
              }
              sources.push(source);
            }

            return {
              content: [{
                type: "text" as const,
                text: summarizeEvidence(question, sources, syntax),
              }],
              details: {
                question,
                justification,
                sourceCount: sources.length,
                sources: sources.map(source => ({
                  title: source.title,
                  url: source.url,
                  host: hostOf(source.url),
                  error: source.error,
                })),
                outcome: {
                  operation: "web_research",
                  status: sources.length > 0 ? "results" : "empty",
                  failed: false,
                  resultCount: sources.length,
                  attempts: searchOutcome.attempts,
                } satisfies StructuredWebOutcome,
              },
            };
          },
        );
      } catch (error) {
        return failedWebToolResult("web_research", {
          status: thrownFailureStatus(error),
          message: errorMessage(error),
        });
      }
    },
  });
}
