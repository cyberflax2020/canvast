/**
 * =============================================================================
 * Canvast — Web Tools Types / Canvast 源文件
 * =============================================================================
 * @file        extensions/web-tools/types.ts
 * @brief       Shared contracts for the Canvast web-tools extension.
 * @description Keeps transport, parsing, and registration modules decoupled
 *              without changing the public extension entrypoint.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

export type WebOperation = "web_search" | "web_research" | "web_fetch";
export type WebFailureStatus =
  | "transport_error"
  | "timeout"
  | "cancelled"
  | "http_error"
  | "parse_error"
  | "response_too_large"
  | "unsafe_url";
export type WebOutcomeStatus = "results" | "empty" | WebFailureStatus | "invalid_request";
export type SearchAdapter = "duckduckgo_instant_answer" | "duckduckgo_html";

export type SearchAttemptOutcome = {
  adapter: SearchAdapter;
  status: "results" | "empty" | WebFailureStatus;
  resultCount: number;
  message?: string;
  httpStatus?: number;
};

export type StructuredWebOutcome = {
  operation: WebOperation;
  status: WebOutcomeStatus;
  failed: boolean;
  resultCount: number;
  message?: string;
  httpStatus?: number;
  attempts?: SearchAttemptOutcome[];
};

export type SearchWebOutcome = {
  status: "results" | "empty" | WebFailureStatus;
  failed: boolean;
  resultCount: number;
  results: SearchResult[];
  attempts: SearchAttemptOutcome[];
  message?: string;
};

export type FetchTextResult =
  | { ok: true; text: string; title: string; url: string }
  | { ok: false; status: WebFailureStatus; error: string; url: string; httpStatus?: number };

export type SourceTextProfile = {
  shapes: string[];
  rank: number;
  focusTerms: string[];
  exactQueries: string[];
  confirmationCandidate: boolean;
  fetchCandidate: boolean;
};

export type SourceConvergenceState = {
  exactQueries: string[];
  fetchCandidates: Array<{ url: string; focusTerms: string[] }>;
  confirmationCandidates: Array<{ url: string; shapes: string[] }>;
  focusTerms: string[];
  failedFetchUrls: string[];
  elasticExtensionsUsed: number;
  lastElasticSignature?: string;
};

export type RetrievalStrategy = {
  mode: "general_evidence" | "exact_source_text";
  requiredTerms: string[];
  unitHints: string[];
};

export type WebToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
};

export type WebBudgetRuntime = {
  remainingTimeMs: () => number;
  timeoutFor: (desiredMs: number) => number;
  checkCanContinue: (minRemainingTimeMs?: number) => import("../../src/harness/cap-or-spill.js").BudgetDecision;
};

export type WebSyntax = {
  stripHtml: (text: string) => string;
  decodeHtmlEntities: (text: string) => string;
  hasNumberedSourceUnit: (text: string) => boolean;
  isHeadingFocus: (text: string) => boolean;
  isDocumentResource: (url: string) => boolean;
  normalizeSpaces: (text: string) => string;
  extractHtmlTitle: (text: string) => string | undefined;
  splitEvidenceLines: (text: string) => string[];
  extractDuckDuckGoEntries: (html: string) => Array<{
    rawUrl: string;
    rawTitle: string;
    rawSnippet?: string;
  }>;
};

export type SourceVocabulary = {
  genericSourceText: readonly string[];
  answer: readonly string[];
  overview: readonly string[];
  blocked: readonly string[];
  fullSourceHint: readonly string[];
  lowSignalFocus: readonly string[];
};
