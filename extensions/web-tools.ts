/**
 * =============================================================================
 * Canvast — Web Tools / Canvast 源文件
 * =============================================================================
 * @file        extensions/web-tools.ts
 * @brief       Web/source tools for grounded external evidence.
 * @description Canvast-native web search, fetch, and research control layer.
 *              It calls configured external search/fetch endpoints, but does
 *              not vendor DuckDuckGo or third-party web-search source code.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import {
  groundingRequiresExternalEvidence,
  hasUsableGroundingStrategy,
} from "../src/harness/grounding-policy.js";
import {
  OutputBudget,
  type BudgetDecision,
} from "../src/harness/cap-or-spill.js";
import { hasConcreteWebJustification } from "../src/harness/web-policy.js";
import { registerWebTools } from "./web-tools/register-tools.js";
import { createSourceTextTools } from "./web-tools/source-text.js";
import type {
  RetrievalStrategy,
  SearchAttemptOutcome,
  SourceConvergenceState,
  StructuredWebOutcome,
  WebBudgetRuntime,
  WebOperation,
  WebOutcomeStatus,
  WebSyntax,
  WebToolResult,
} from "./web-tools/types.js";

const WEB_BUDGET_WRAP_UP_RESERVE_MS = 5_000;
const WEB_MIN_START_TIME_MS = 1_500;
const DEFAULT_GROUNDING_SCOPE = "default";

function positiveIntEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function stripHtml(text: string): string {
  const stripped = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<h([1-6])[^>]*>/gi, (_match, level) =>
      `\n${"#".repeat(Number(level))} `
    )
    .replace(/<\/(p|div|section|article|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s{2,}/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return stripped.length >= 100 || text.length < 100 ? stripped : text;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_match, number) =>
      String.fromCharCode(parseInt(number, 10))
    );
}

const SPECIFIC_NUMBERED_UNIT_RE =
  /第\s*[0-9一二三四五六七八九十百]+\s*(?:章|节|条|款|项|段|页|部分)|(?:section|clause|article|chapter|paragraph|item|part|requirement)\s*\d+/i;

const GENERIC_SOURCE_TEXT_TERMS = [
  "source text", "full text", "quoted text", "verbatim", "original text",
  "complete text", "source excerpt", "source statement", "clause", "section",
  "article", "chapter", "paragraph", "specification", "requirement", "policy",
  "law", "standard", "protocol", "contract",
  "全文", "原文", "完整文本", "引用原文", "原始文本", "条款", "章节", "小节",
  "段落", "规范", "要求", "政策", "法律", "标准", "协议", "合同",
] as const;

const ANSWER_TERMS = [
  "answer", "solution", "analysis", "解析", "答案", "解答", "详解",
] as const;

const OVERVIEW_TERMS = [
  "summary", "overview", "directory", "video", "catalog", "汇总", "目录",
  "结构", "概述", "标题", "视频",
] as const;

const BLOCKED_TERMS = [
  "verification", "captcha", "forbidden", "access denied", "验证码", "403",
  "禁止访问",
] as const;

const SOURCE_FULL_HINT_TERMS = [
  "pdf", "doc", "docx", "full text", "source text", "complete text",
  "全文", "完整文本", "原文",
] as const;

const LOW_SIGNAL_FOCUS_TERMS = [
  "概述", "汇总", "目录", "视频", "标题", "精选推荐", "关注公众号", "报名",
  "趋势", "总结", "lang=", "charset=", "name=", "content=",
  "width=device-width", "initial-scale", "overview", "summary", "directory",
  "video", "catalog",
] as const;

const WEB_SYNTAX: WebSyntax = {
  stripHtml,
  decodeHtmlEntities,
  hasNumberedSourceUnit: text =>
    SPECIFIC_NUMBERED_UNIT_RE.test(text.normalize("NFKC").toLowerCase()),
  isHeadingFocus: text => /^#+\s*focus\b/i.test(text),
  isDocumentResource: url =>
    /\.pdf(?:[?#]|$)/i.test(url) || /\.(?:docx?|pptx?)(?:[?#]|$)/i.test(url),
  normalizeSpaces: text => text.replace(/\s+/g, " ").trim(),
  extractHtmlTitle: text =>
    text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1],
  splitEvidenceLines: text => text.split(/\n+/),
  extractDuckDuckGoEntries: html => {
    const entries: Array<{
      rawUrl: string;
      rawTitle: string;
      rawSnippet?: string;
    }> = [];
    const anchorPattern =
      /<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null;
    while ((match = anchorPattern.exec(html))) {
      const block = html.slice(
        match.index,
        Math.min(html.length, match.index + 2500),
      );
      const snippet = block.match(
        /class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/i,
      );
      entries.push({
        rawUrl: match[1],
        rawTitle: match[2],
        rawSnippet: snippet?.[1],
      });
    }
    return entries;
  },
};

const sourceText = createSourceTextTools(WEB_SYNTAX, {
  genericSourceText: GENERIC_SOURCE_TEXT_TERMS,
  answer: ANSWER_TERMS,
  overview: OVERVIEW_TERMS,
  blocked: BLOCKED_TERMS,
  fullSourceHint: SOURCE_FULL_HINT_TERMS,
  lowSignalFocus: LOW_SIGNAL_FOCUS_TERMS,
});

function normalizeGroundingStrategy(raw: any) {
  if (!raw || typeof raw !== "object") return undefined;
  return {
    requirements: (raw.requirements || []).map((item: any) => ({
      kind: item.kind,
      claim: String(item.claim || ""),
      freshness: item.freshness,
      sourceKinds: item.source_kinds || [],
    })),
    preferredSources: raw.preferred_sources || [],
    minimumSources: Number(raw.minimum_sources || 0),
    maxExternalCalls:
      Number.isInteger(Number(raw.max_external_calls))
      && Number(raw.max_external_calls) > 0
        ? Number(raw.max_external_calls)
        : undefined,
    allowMemoryOnly: raw.allow_memory_only === true,
    unavailablePolicy: raw.unavailable_policy,
    correctionPolicy: raw.correction_policy,
  };
}

function hasEvidenceReason(
  justification: string,
  groundingStrategy: any,
): boolean {
  return hasConcreteWebJustification(justification)
    || hasUsableGroundingStrategy(
      normalizeGroundingStrategy(groundingStrategy),
    );
}

function needsGroundedExternalBudget(groundingStrategy: any): boolean {
  const normalized = normalizeGroundingStrategy(groundingStrategy);
  return hasUsableGroundingStrategy(normalized)
    && groundingRequiresExternalEvidence(normalized);
}

function groundedMaxCalls(
  groundingStrategy: any,
  fallback: number,
  ceiling: number,
): number {
  const normalized = normalizeGroundingStrategy(groundingStrategy);
  const requested = normalized?.maxExternalCalls;
  if (!Number.isInteger(requested) || Number(requested) < 1) return fallback;
  return Math.max(1, Math.min(Number(requested), ceiling));
}

function explicitGroundedMaxCalls(
  groundingStrategy: any,
  ceiling: number,
): number | undefined {
  const normalized = normalizeGroundingStrategy(groundingStrategy);
  const requested = normalized?.maxExternalCalls;
  if (!Number.isInteger(requested) || Number(requested) < 1) return undefined;
  return Math.max(1, Math.min(Number(requested), ceiling));
}

function normalizedScopeText(value: unknown): string {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function groundingBudgetScope(
  groundingStrategy: any,
  explicitScope?: string,
): string {
  const explicit = normalizedScopeText(explicitScope);
  if (explicit) return explicit.slice(0, 160);

  const normalized = normalizeGroundingStrategy(groundingStrategy);
  if (!hasUsableGroundingStrategy(normalized)) {
    return DEFAULT_GROUNDING_SCOPE;
  }

  const requirements = normalized.requirements
    .map((item: {
      kind: string;
      claim: string;
      freshness: string;
      sourceKinds: string[];
    }) => ({
      kind: item.kind,
      claim: normalizedScopeText(item.claim),
      freshness: item.freshness,
      sourceKinds: [...item.sourceKinds].sort(),
    }))
    .sort((a: {
      kind: string;
      claim: string;
      freshness: string;
      sourceKinds: string[];
    }, b: {
      kind: string;
      claim: string;
      freshness: string;
      sourceKinds: string[];
    }) =>
      a.kind.localeCompare(b.kind)
      || a.freshness.localeCompare(b.freshness)
      || a.claim.localeCompare(b.claim)
      || a.sourceKinds.join(",").localeCompare(b.sourceKinds.join(","))
    );

  const payload = JSON.stringify({
    requirements,
    preferredSources: [...normalized.preferredSources].sort(),
    minimumSources: normalized.minimumSources,
    allowMemoryOnly: normalized.allowMemoryOnly,
    unavailablePolicy: normalized.unavailablePolicy,
    correctionPolicy: normalized.correctionPolicy,
  });
  return `strategy:${createHash("sha256").update(payload).digest("hex").slice(0, 16)}`;
}

function budgetWindDown(decision: Exclude<BudgetDecision, { ok: true }>) {
  return {
    content: [{
      type: "text" as const,
      text: [
        "# Web Evidence Budget Exhausted / 外部证据预算耗尽",
        "",
        decision.message,
        "",
        "Stop using web tools now. Answer with the evidence already collected. If official, primary, route_or_transit, or other authoritative evidence is incomplete, state what remains unverified instead of guessing.",
        "立即停止继续调用 web 工具。请基于已经取得的证据作答；如果官方、主来源、route_or_transit 或其他权威证据不足，明确说明未验证，不要猜测。",
      ].join("\n"),
    }],
    details: { budget: decision },
  };
}

function finalAllowedCallNotice(): string {
  return [
    "",
    "---",
    "",
    "# Web Evidence Budget Now Exhausted / 外部证据预算现已用完",
    "",
    "This was the final allowed external evidence call. Stop using web tools now and answer from the evidence already collected.",
    "If official, primary, route_or_transit, source-text, or other required authoritative evidence is incomplete, state the unverified boundary instead of searching again or guessing.",
    "这是最后一次允许的外部证据调用。请立即停止继续调用 web 工具，基于已取得证据作答；如果官方、主来源、route_or_transit、原文或其他必需权威证据不完整，请说明未验证边界，不要继续搜索或猜测。",
  ].join("\n");
}

function structuredWebOutcome(
  details: unknown,
): StructuredWebOutcome | undefined {
  if (!details || typeof details !== "object") return undefined;
  const outcome = (details as { outcome?: unknown }).outcome;
  if (!outcome || typeof outcome !== "object") return undefined;
  const candidate = outcome as Partial<StructuredWebOutcome>;
  if (
    typeof candidate.status !== "string"
    || typeof candidate.failed !== "boolean"
  ) {
    return undefined;
  }
  return candidate as StructuredWebOutcome;
}

function resultHasFailedWebOutcome(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  return structuredWebOutcome(
    (result as { details?: unknown }).details,
  )?.failed === true;
}

function resultHasCancelledWebOutcome(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  return structuredWebOutcome(
    (result as { details?: unknown }).details,
  )?.status === "cancelled";
}

function failedWebToolResult(
  operation: WebOperation,
  outcome: {
    status: WebOutcomeStatus;
    message?: string;
    error?: string;
    httpStatus?: number;
    attempts?: SearchAttemptOutcome[];
  },
): WebToolResult {
  const label = operation === "web_research"
    ? "WebResearch"
    : operation === "web_search"
      ? "WebSearch"
      : "WebFetch";
  const message = outcome.message || outcome.error || outcome.status;
  const detailsOutcome: StructuredWebOutcome = {
    operation,
    status: outcome.status,
    failed: true,
    resultCount: 0,
    message,
    ...(outcome.httpStatus !== undefined
      ? { httpStatus: outcome.httpStatus }
      : {}),
    ...(outcome.attempts ? { attempts: outcome.attempts } : {}),
  };
  return {
    isError: true,
    content: [{
      type: "text",
      text: `${label} failed [${outcome.status}]: ${message}\nSearch/fetch did not complete; this is not a verified empty result. / 检索或抓取未完成，这不代表经确认的无结果。`,
    }],
    details: { outcome: detailsOutcome },
  };
}

function appendBudgetNotice<T>(
  result: T,
  notice: string | undefined,
): T {
  if (!notice || !result || typeof result !== "object") return result;
  const maybeResult = result as unknown as WebToolResult;
  if (!Array.isArray(maybeResult.content)) return result;
  const content = maybeResult.content.map((part, index) => {
    if (index !== 0 || part?.type !== "text") return part;
    return { ...part, text: `${String(part.text || "")}${notice}` };
  });
  return { ...maybeResult, content } as unknown as T;
}

export default function (pi: ExtensionAPI) {
  const groundedDefaultMaxCalls = positiveIntEnv(
    "CANVAST_GROUNDED_WEB_MAX_CALLS",
    3,
  );
  const groundedHardMaxCalls = Math.max(
    groundedDefaultMaxCalls,
    positiveIntEnv("CANVAST_GROUNDED_WEB_MAX_CALLS_HARD_MAX", 7),
  );
  const createDefaultExternalBudget = () => new OutputBudget({
    maxCalls: positiveIntEnv("CANVAST_WEB_MAX_CALLS", 20),
    maxConsecutiveErrors: positiveIntEnv(
      "CANVAST_WEB_MAX_CONSECUTIVE_ERRORS",
      3,
    ),
    maxTotalTimeMs: positiveIntEnv(
      "CANVAST_WEB_MAX_TOTAL_TIME_MS",
      180_000,
    ),
  });
  const groundedBudgets = new Map<string, OutputBudget>();
  const sourceConvergenceStates = new Map<string, SourceConvergenceState>();
  let explicitTurnGroundedBudget: OutputBudget | undefined;
  let defaultTurnExternalBudget = createDefaultExternalBudget();

  pi.on?.("tool_result", (event: any) => {
    const isWebTool = event?.toolName === "web_search"
      || event?.toolName === "web_research"
      || event?.toolName === "web_fetch";
    if (
      !isWebTool
      || structuredWebOutcome(event.details)?.failed !== true
    ) {
      return undefined;
    }
    return { isError: true };
  });

  pi.on?.("turn_start", () => {
    explicitTurnGroundedBudget = undefined;
    groundedBudgets.clear();
    sourceConvergenceStates.clear();
    defaultTurnExternalBudget = createDefaultExternalBudget();
  });

  function groundedExternalBudget(
    groundingStrategy: any,
    explicitScope?: string,
  ): OutputBudget {
    const explicitMaxCalls = explicitGroundedMaxCalls(
      groundingStrategy,
      groundedHardMaxCalls,
    );
    if (explicitTurnGroundedBudget) return explicitTurnGroundedBudget;
    if (explicitMaxCalls !== undefined) {
      explicitTurnGroundedBudget = new OutputBudget({
        maxCalls: explicitMaxCalls,
        maxConsecutiveErrors: positiveIntEnv(
          "CANVAST_GROUNDED_WEB_MAX_CONSECUTIVE_ERRORS",
          2,
        ),
        maxTotalTimeMs: positiveIntEnv(
          "CANVAST_GROUNDED_WEB_MAX_TOTAL_TIME_MS",
          90_000,
        ),
      });
      return explicitTurnGroundedBudget;
    }

    const maxCalls = groundedMaxCalls(
      groundingStrategy,
      groundedDefaultMaxCalls,
      groundedHardMaxCalls,
    );
    const scope = groundingBudgetScope(groundingStrategy, explicitScope);
    const existing = groundedBudgets.get(scope);
    if (existing) return existing;
    const budget = new OutputBudget({
      maxCalls,
      maxConsecutiveErrors: positiveIntEnv(
        "CANVAST_GROUNDED_WEB_MAX_CONSECUTIVE_ERRORS",
        2,
      ),
      maxTotalTimeMs: positiveIntEnv(
        "CANVAST_GROUNDED_WEB_MAX_TOTAL_TIME_MS",
        90_000,
      ),
    });
    groundedBudgets.set(scope, budget);
    return budget;
  }

  function sourceTextScope(
    groundingStrategy: any,
    explicitScope?: string,
  ): string {
    return groundingBudgetScope(groundingStrategy, explicitScope);
  }

  function sourceTextElasticOptions(
    groundingStrategy: any,
    explicitScope: string | undefined,
    retrievalStrategy: RetrievalStrategy,
  ) {
    if (!sourceText.wantsExactSourceText(retrievalStrategy)) return undefined;
    const scope = sourceTextScope(groundingStrategy, explicitScope);
    return {
      getSourceTextState: () => sourceConvergenceStates.get(scope),
      onElasticState: (state: SourceConvergenceState) =>
        sourceConvergenceStates.set(scope, state),
    };
  }

  async function withWebBudget<T>(
    groundingStrategy: any,
    groundingScope: string | undefined,
    options: {
      getSourceTextState?: () => SourceConvergenceState | undefined;
      onElasticState?: (state: SourceConvergenceState) => void;
    } | undefined,
    run: (runtime: WebBudgetRuntime) => Promise<T>,
  ): Promise<T | WebToolResult> {
    const grounded = needsGroundedExternalBudget(groundingStrategy)
      || Boolean(normalizedScopeText(groundingScope));
    const budget = grounded
      ? groundedExternalBudget(groundingStrategy, groundingScope)
      : defaultTurnExternalBudget;
    const minStartTimeMs =
      WEB_BUDGET_WRAP_UP_RESERVE_MS + WEB_MIN_START_TIME_MS;
    let elasticNotice: string | undefined;
    let check = budget.checkCanStart(minStartTimeMs);
    if (!check.ok && grounded && check.axis === "calls") {
      const timeCheck = budget.checkTimeRemaining(minStartTimeMs);
      const remainingElasticHardCap = Math.max(
        0,
        groundedHardMaxCalls + 3 - budget.maxCalls(),
      );
      const sourceTextState = options?.getSourceTextState?.();
      const elastic = timeCheck.ok
        ? sourceText.consumeElasticSourceTextProgress(
          sourceTextState,
          remainingElasticHardCap,
        )
        : undefined;
      if (elastic) {
        budget.extendCalls(
          elastic.addCalls,
          "source-text high-signal convergence",
        );
        options?.onElasticState?.(elastic.state);
        elasticNotice = elastic.notice;
        check = budget.checkCanStart(minStartTimeMs);
      }
    }
    if (!check.ok) return budgetWindDown(check);
    budget.registerCall();
    const started = Date.now();
    const runtime: WebBudgetRuntime = {
      remainingTimeMs: () =>
        budget.remainingTimeMs(Date.now() - started),
      timeoutFor: desiredMs => {
        const desired = Math.max(1, Math.floor(desiredMs));
        const available = Math.max(
          1,
          budget.remainingTimeMs(Date.now() - started)
            - WEB_BUDGET_WRAP_UP_RESERVE_MS,
        );
        return Math.max(1, Math.min(desired, available));
      },
      checkCanContinue: (
        minRemainingTimeMs = WEB_MIN_START_TIME_MS,
      ) => budget.checkTimeRemaining(
        WEB_BUDGET_WRAP_UP_RESERVE_MS
          + Math.max(0, Math.floor(minRemainingTimeMs)),
        Date.now() - started,
      ),
    };
    try {
      const result = await run(runtime);
      budget.registerElapsed(Date.now() - started);
      if (resultHasCancelledWebOutcome(result)) {
        // User cancellation is neutral: preserve any existing error streak.
      } else if (resultHasFailedWebOutcome(result)) budget.registerError();
      else budget.registerSuccess();
      const after = budget.checkCanStart(minStartTimeMs);
      let notice: string | undefined;
      if (grounded && !after.ok) {
        if (after.axis === "calls") {
          const timeCheck = budget.checkTimeRemaining(minStartTimeMs);
          const remainingElasticHardCap = Math.max(
            0,
            groundedHardMaxCalls + 3 - budget.maxCalls(),
          );
          const sourceTextState = options?.getSourceTextState?.();
          const elastic = timeCheck.ok
            ? sourceText.consumeElasticSourceTextProgress(
              sourceTextState,
              remainingElasticHardCap,
            )
            : undefined;
          if (elastic) {
            budget.extendCalls(
              elastic.addCalls,
              "source-text high-signal convergence",
            );
            options?.onElasticState?.(elastic.state);
            notice = elastic.notice;
          } else {
            notice = finalAllowedCallNotice();
          }
        } else {
          notice = finalAllowedCallNotice();
        }
      }
      return appendBudgetNotice(
        result,
        [elasticNotice, notice].filter(Boolean).join(""),
      );
    } catch (error) {
      budget.registerElapsed(Date.now() - started);
      budget.registerError();
      throw error;
    }
  }

  registerWebTools(pi, {
    syntax: WEB_SYNTAX,
    sourceText,
    hasEvidenceReason,
    needsGroundedExternalBudget,
    normalizedScopeText,
    sourceTextScope,
    sourceTextElasticOptions,
    sourceConvergenceStates,
    withWebBudget,
    failedWebToolResult,
  });
}
