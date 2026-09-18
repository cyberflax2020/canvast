/**
 * =============================================================================
 * Canvast — Web Tools Source Text / Canvast 源文件
 * =============================================================================
 * @file        extensions/web-tools/source-text.ts
 * @brief       Pure exact-source retrieval and convergence logic.
 * @description Ranks structured source candidates and maintains a bounded
 *              convergence queue without performing network or lifecycle I/O.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import { createHash } from "node:crypto";
import { hostOf } from "./parse.js";
import type {
  RetrievalStrategy,
  SearchResult,
  SourceConvergenceState,
  SourceTextProfile,
  SourceVocabulary,
  WebSyntax,
} from "./types.js";

const elasticFirstExtension = 2;
const elasticSecondExtension = 1;

export function createSourceTextTools(
  syntax: WebSyntax,
  vocabulary: SourceVocabulary,
) {
  function normalizeForMatching(text: string): string {
    return text.normalize("NFKC").toLowerCase();
  }

  function containsAny(text: string, terms: readonly string[]): boolean {
    const normalized = normalizeForMatching(text);
    return terms.some(term => normalized.includes(normalizeForMatching(term)));
  }

  function hasGenericSourceTextMarker(text: string): boolean {
    return containsAny(text, vocabulary.genericSourceText);
  }

  function isLowSignalFocusPhrase(text: string): boolean {
    if (syntax.isHeadingFocus(cleanFocusTerm(text))) return true;
    return containsAny(text, vocabulary.lowSignalFocus) && !hasFormulaLikeFragment(text);
  }

  function isAsciiLetterOrDigit(char: string): boolean {
    if (!char) return false;
    const code = char.charCodeAt(0);
    return (code >= 48 && code <= 57)
      || (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122);
  }

  function isCjk(char: string): boolean {
    if (!char) return false;
    const code = char.charCodeAt(0);
    return code >= 0x4e00 && code <= 0x9fff;
  }

  function hasDigitChar(text: string): boolean {
    for (const char of text) {
      const code = char.charCodeAt(0);
      if (code >= 48 && code <= 57) return true;
    }
    return false;
  }

  function hasAsciiLetterChar(text: string): boolean {
    for (const char of text) {
      const code = char.charCodeAt(0);
      if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) return true;
    }
    return false;
  }

  function hasNearbyOperand(text: string, index: number): boolean {
    const start = Math.max(0, index - 8);
    const end = Math.min(text.length, index + 9);
    for (let i = start; i < end; i += 1) {
      if (i === index) continue;
      const char = text[i];
      if (isAsciiLetterOrDigit(char) || isCjk(char)) return true;
    }
    return false;
  }

  function hasFormulaLikeFragment(text: string): boolean {
    const mathSymbols = "≤≥∈∀∃√∞∑∫±≈≠";
    for (const char of text) {
      if (mathSymbols.includes(char)) return true;
    }
    for (let i = 0; i < text.length - 1; i += 1) {
      if (text[i] === "\\" && hasAsciiLetterChar(text.slice(i + 1, i + 2))) return true;
    }
    const operators = "=<>^*/";
    for (let i = 0; i < text.length; i += 1) {
      if (operators.includes(text[i]) && hasNearbyOperand(text, i)) return true;
    }
    return false;
  }

  function isBoundaryChar(char: string): boolean {
    if (!char) return true;
    if (char.trim() === "") return true;
    return "，。；、：,.!?;:|\\/[]{}（）()<>\"'“”‘’`~".includes(char);
  }

  function isSentenceBoundaryChar(char: string): boolean {
    if (!char) return true;
    return "\n\r。；;!?！？".includes(char);
  }

  function cleanFocusTerm(term: string): string {
    let start = 0;
    let end = term.length;
    while (start < end && isBoundaryChar(term[start])) start += 1;
    while (end > start && isBoundaryChar(term[end - 1])) end -= 1;
    let cleaned = "";
    let lastWasSpace = false;
    for (const char of term.slice(start, end).trim()) {
      if (char.trim() === "") {
        if (!lastWasSpace) cleaned += " ";
        lastWasSpace = true;
      } else {
        cleaned += char;
        lastWasSpace = false;
      }
    }
    return cleaned.trim();
  }

  function addUniqueTerm(terms: string[], seen: Set<string>, rawTerm: string): void {
    const term = cleanFocusTerm(rawTerm);
    const key = normalizeForMatching(term);
    if (term.length < 2 || term.length > 80 || seen.has(key)) return;
    seen.add(key);
    terms.push(term);
  }

  function splitCandidatePhrases(text: string): string[] {
    const phrases: string[] = [];
    let current = "";
    for (const char of text) {
      if (isBoundaryChar(char)) {
        const cleaned = cleanFocusTerm(current);
        if (cleaned) phrases.push(cleaned);
        current = "";
      } else {
        current += char;
      }
    }
    const cleaned = cleanFocusTerm(current);
    if (cleaned) phrases.push(cleaned);
    return phrases;
  }

  function normalizeRetrievalStrategy(raw: any): RetrievalStrategy {
    const mode = raw?.mode === "exact_source_text"
      ? "exact_source_text"
      : "general_evidence";
    const requiredTerms = Array.isArray(raw?.required_terms)
      ? raw.required_terms
        .map((item: unknown) => cleanFocusTerm(String(item || "")))
        .filter(Boolean)
        .slice(0, 12)
      : [];
    const unitHints = Array.isArray(raw?.unit_hints)
      ? raw.unit_hints
        .map((item: unknown) => cleanFocusTerm(String(item || "")))
        .filter(Boolean)
        .slice(0, 8)
      : [];
    return { mode, requiredTerms, unitHints };
  }

  function retrievalAnchorTerms(strategy: RetrievalStrategy): string[] {
    const anchors: string[] = [];
    const seen = new Set<string>();
    for (const term of [...strategy.unitHints, ...strategy.requiredTerms]) {
      addUniqueTerm(anchors, seen, term);
    }
    return anchors;
  }

  function wantsExactSourceText(strategy: RetrievalStrategy): boolean {
    return strategy.mode === "exact_source_text"
      || retrievalAnchorTerms(strategy).length > 0;
  }

  function countAnchorHits(text: string, anchors: string[]): number {
    const normalized = normalizeForMatching(text);
    let count = 0;
    for (const anchor of anchors) {
      if (normalized.includes(normalizeForMatching(anchor))) count += 1;
    }
    return count;
  }

  function addAnchorsFoundInText(
    text: string,
    anchors: string[],
    terms: string[],
    seen: Set<string>,
  ): void {
    const normalized = normalizeForMatching(text);
    for (const anchor of anchors) {
      if (normalized.includes(normalizeForMatching(anchor))) {
        addUniqueTerm(terms, seen, anchor);
      }
    }
  }

  function extractNumberedTerms(
    text: string,
    terms: string[],
    seen: Set<string>,
  ): void {
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (!["章", "节", "条", "款", "项", "段", "页"].includes(char)) continue;
      let start = i;
      while (start > 0 && text[start] !== "第" && i - start < 8) start -= 1;
      if (text[start] !== "第") {
        start = i;
        while (start > 0 && !isBoundaryChar(text[start - 1]) && i - start < 4) {
          start -= 1;
        }
      }
      const candidate = text.slice(start, i + 1);
      if (syntax.hasNumberedSourceUnit(candidate)) {
        addUniqueTerm(terms, seen, candidate);
      }
    }
  }

  function readNumericUnitSuffix(
    text: string,
    start: number,
  ): { value: string; end: number } | undefined {
    let cursor = start;
    while (cursor < text.length && text[cursor].trim() === "") cursor += 1;
    let value = "";
    let sawDigit = false;
    let previousWasDot = false;
    while (cursor < text.length) {
      const char = text[cursor];
      const code = char.charCodeAt(0);
      const digit = code >= 48 && code <= 57;
      if (digit) {
        value += char;
        sawDigit = true;
        previousWasDot = false;
        cursor += 1;
        continue;
      }
      if (char === "." && sawDigit && !previousWasDot) {
        value += char;
        previousWasDot = true;
        cursor += 1;
        continue;
      }
      break;
    }
    if (!sawDigit) return undefined;
    while (value.endsWith(".")) value = value.slice(0, -1);
    return value ? { value, end: cursor } : undefined;
  }

  function extractNamedUnitTerms(
    text: string,
    terms: string[],
    seen: Set<string>,
  ): void {
    const normalized = normalizeForMatching(text);
    const unitNames = [
      "section",
      "clause",
      "article",
      "chapter",
      "paragraph",
      "item",
      "part",
      "requirement",
    ];
    for (const name of unitNames) {
      let index = normalized.indexOf(name);
      while (index >= 0) {
        const before = normalized[index - 1];
        const after = normalized[index + name.length];
        const isWholeName = !isAsciiLetterOrDigit(before)
          && !isAsciiLetterOrDigit(after);
        if (isWholeName) {
          const suffix = readNumericUnitSuffix(normalized, index + name.length);
          if (suffix) addUniqueTerm(terms, seen, `${name} ${suffix.value}`);
        }
        index = normalized.indexOf(name, index + Math.max(1, name.length));
      }
    }
  }

  function extractNumberedUnits(text: string): string[] {
    const terms: string[] = [];
    const seen = new Set<string>();
    extractNumberedTerms(text, terms, seen);
    extractNamedUnitTerms(text, terms, seen);
    return terms;
  }

  function isHighSignalFocusPhrase(text: string): boolean {
    const term = cleanFocusTerm(text);
    if (!term || isLowSignalFocusPhrase(term)) return false;
    if (hasFormulaLikeFragment(term) || syntax.hasNumberedSourceUnit(term)) {
      return true;
    }
    return hasGenericSourceTextMarker(term) && hasContextualSourceSignal(term);
  }

  function hasContextualSourceSignal(text: string): boolean {
    const term = cleanFocusTerm(text);
    if (term.length < 4 || term.length > 120 || isLowSignalFocusPhrase(term)) {
      return false;
    }
    if (hasFormulaLikeFragment(term) || syntax.hasNumberedSourceUnit(term)) {
      return true;
    }
    if (!hasDigitChar(term)) return false;
    return hasAsciiLetterChar(term);
  }

  function extractContextualSignalTerms(
    text: string,
    anchors: string[],
  ): string[] {
    const terms: string[] = [];
    const seen = new Set<string>();
    const lower = text.toLowerCase();
    for (const rawAnchor of anchors) {
      const anchor = cleanFocusTerm(rawAnchor);
      if (!anchor) continue;
      const needle = anchor.toLowerCase();
      let from = 0;
      let matches = 0;
      while (matches < 3) {
        const index = lower.indexOf(needle, from);
        if (index < 0) break;
        let start = index;
        let end = index + anchor.length;
        while (
          start > 0
          && !isSentenceBoundaryChar(text[start - 1])
          && index - start < 48
        ) {
          start -= 1;
        }
        while (
          end < text.length
          && !isSentenceBoundaryChar(text[end])
          && end - index < 96
        ) {
          end += 1;
        }
        const candidate = cleanFocusTerm(text.slice(start, end));
        if (hasContextualSourceSignal(candidate)) {
          addUniqueTerm(terms, seen, candidate);
        }
        from = index + Math.max(1, needle.length);
        matches += 1;
      }
      if (terms.length >= 6) break;
    }
    return terms;
  }

  function extractFocusTermsFromText(
    text: string,
    retrievalStrategy: RetrievalStrategy = normalizeRetrievalStrategy(undefined),
  ): string[] {
    const terms: string[] = [];
    const seen = new Set<string>();
    addAnchorsFoundInText(
      text,
      retrievalAnchorTerms(retrievalStrategy),
      terms,
      seen,
    );
    extractNumberedTerms(text, terms, seen);
    extractNamedUnitTerms(text, terms, seen);
    for (const phrase of splitCandidatePhrases(text)) {
      if (
        isHighSignalFocusPhrase(phrase)
        || hasContextualSourceSignal(phrase)
      ) {
        addUniqueTerm(terms, seen, phrase);
      }
      if (terms.length >= 8) break;
    }
    return terms;
  }

  function buildExactQueries(query: string, focusTerms: string[]): string[] {
    if (focusTerms.length < 2) return [];
    const base = cleanFocusTerm(query).slice(0, 120);
    const queries: string[] = [];
    const highSignal = focusTerms.filter(isHighSignalFocusPhrase).slice(0, 4);
    if (highSignal.length >= 2) {
      queries.push(
        [base, ...highSignal.slice(0, 3)].filter(Boolean).join(" "),
      );
    }
    const formulaTerms = focusTerms.filter(hasFormulaLikeFragment).slice(0, 3);
    if (formulaTerms.length >= 1) {
      queries.push([base, ...formulaTerms].filter(Boolean).join(" "));
    }
    const numberedTerms = focusTerms
      .filter(syntax.hasNumberedSourceUnit)
      .slice(0, 2);
    if (numberedTerms.length >= 1 && highSignal.length >= 1) {
      queries.push(
        [base, ...numberedTerms, highSignal[0]].filter(Boolean).join(" "),
      );
    }
    const seen = new Set<string>();
    return queries
      .map(cleanFocusTerm)
      .filter(item => {
        const key = normalizeForMatching(item);
        if (!item || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 3);
  }

  function isReusableSourceTextTerm(term: string): boolean {
    return isHighSignalFocusPhrase(term) || hasContextualSourceSignal(term);
  }

  function profileSearchResultWithStrategy(
    result: SearchResult,
    query: string,
    retrievalStrategy: RetrievalStrategy,
  ): SourceTextProfile {
    const text = `${result.title || ""} ${result.snippet || ""}`;
    const exactSourceRequested = wantsExactSourceText(retrievalStrategy);
    const anchorHits = countAnchorHits(
      text,
      retrievalAnchorTerms(retrievalStrategy),
    );
    const documentCandidate = syntax.isDocumentResource(result.url || "")
      || containsAny(text, ["pdf", "doc", "docx", "文档", "下载"]);
    const sourceTextCandidate = exactSourceRequested && (
      anchorHits > 0
      || hasGenericSourceTextMarker(text)
      || documentCandidate
    );
    const exactFragmentCandidate = exactSourceRequested
      && hasFormulaLikeFragment(text);
    const answerCandidate = containsAny(text, vocabulary.answer);
    const overviewCandidate = containsAny(text, vocabulary.overview);
    const likelyBlocked = containsAny(text, vocabulary.blocked);
    const fullSourceHint = containsAny(text, vocabulary.fullSourceHint);
    const queryUnits = exactSourceRequested ? extractNumberedUnits(query) : [];
    const resultUnits = exactSourceRequested ? extractNumberedUnits(text) : [];
    const queryUnitAligned = queryUnits.length === 0
      || resultUnits.length === 0
      || queryUnits.some(unit => resultUnits.some(
        candidate => normalizeForMatching(candidate) === normalizeForMatching(unit),
      ));
    const shapes: string[] = [];
    if (documentCandidate) shapes.push("document/PDF candidate");
    if (sourceTextCandidate) shapes.push("source-text candidate");
    if (exactFragmentCandidate) shapes.push("exact-fragment candidate");
    if (anchorHits > 0) shapes.push("explicit-anchor candidate");
    if (answerCandidate) shapes.push("answer/analysis candidate");
    if (overviewCandidate) shapes.push("overview candidate");
    if (
      queryUnits.length > 0
      && resultUnits.length > 0
      && !queryUnitAligned
    ) {
      shapes.push("query-number mismatch");
    }
    if (likelyBlocked) shapes.push("likely blocked");

    let rank = 0;
    if (documentCandidate) rank -= 2;
    if (sourceTextCandidate) rank -= 3;
    if (exactFragmentCandidate) rank -= 4;
    if (anchorHits > 0) rank -= 4 + Math.min(anchorHits, 4);
    if (fullSourceHint) rank -= 1;
    if (queryUnits.length > 0 && resultUnits.length > 0 && queryUnitAligned) {
      rank -= 2;
    }
    if (queryUnits.length > 0 && resultUnits.length > 0 && !queryUnitAligned) {
      rank += 5;
    }
    if (answerCandidate) rank += 1;
    if (overviewCandidate) rank += 2;
    if (likelyBlocked) rank += 4;

    const focusTerms = exactSourceRequested
      ? extractFocusTermsFromText(text, retrievalStrategy)
      : [];
    return {
      shapes: shapes.length ? shapes : ["unknown"],
      rank,
      focusTerms,
      exactQueries: buildExactQueries(query, focusTerms),
      confirmationCandidate: !likelyBlocked
        && exactSourceRequested
        && (
          anchorHits > 0
          || sourceTextCandidate
          || exactFragmentCandidate
          || answerCandidate
        ),
      fetchCandidate: !likelyBlocked
        && exactSourceRequested
        && (
          anchorHits > 0
          || sourceTextCandidate
          || exactFragmentCandidate
          || documentCandidate
        ),
    };
  }

  function formatSearchResult(
    result: SearchResult,
    index: number,
    profile: SourceTextProfile,
  ): string {
    return [
      `${index + 1}. **${result.title || "N/A"}**`,
      `   URL: ${result.url || "N/A"}`,
      `   Evidence shape: ${profile.shapes.join(", ")}`,
      profile.focusTerms.length > 0
        ? `   Suggested focus_terms: ${profile.focusTerms.join(" | ")}`
        : "",
      result.snippet ? `   ${result.snippet}` : "",
    ].filter(Boolean).join("\n");
  }

  function independentHosts(results: SearchResult[]): number {
    const hosts = new Set<string>();
    for (const result of results) {
      const host = hostOf(result.url);
      if (host) hosts.add(host);
    }
    return hosts.size;
  }

  function addUniqueNormalized(
    target: string[],
    values: string[],
    limit: number,
  ): void {
    const seen = new Set(target.map(item => normalizeForMatching(item)));
    for (const value of values.map(cleanFocusTerm).filter(Boolean)) {
      const key = normalizeForMatching(value);
      if (seen.has(key)) continue;
      seen.add(key);
      target.push(value);
      if (target.length >= limit) break;
    }
  }

  function initialSourceConvergenceState(): SourceConvergenceState {
    return {
      exactQueries: [],
      fetchCandidates: [],
      confirmationCandidates: [],
      focusTerms: [],
      failedFetchUrls: [],
      elasticExtensionsUsed: 0,
      lastElasticSignature: undefined,
    };
  }

  function copySourceConvergenceState(
    previous: SourceConvergenceState,
  ): SourceConvergenceState {
    return {
      exactQueries: [...previous.exactQueries],
      fetchCandidates: previous.fetchCandidates.map(item => ({
        url: item.url,
        focusTerms: [...item.focusTerms],
      })),
      confirmationCandidates: previous.confirmationCandidates.map(item => ({
        url: item.url,
        shapes: [...item.shapes],
      })),
      focusTerms: [...previous.focusTerms],
      failedFetchUrls: [...previous.failedFetchUrls],
      elasticExtensionsUsed: previous.elasticExtensionsUsed,
      lastElasticSignature: previous.lastElasticSignature,
    };
  }

  function mergeSourceConvergenceState(
    previous: SourceConvergenceState | undefined,
    profiled: Array<{ result: SearchResult; profile: SourceTextProfile }>,
  ): SourceConvergenceState {
    const next = previous
      ? copySourceConvergenceState(previous)
      : initialSourceConvergenceState();

    addUniqueNormalized(
      next.exactQueries,
      profiled.flatMap(item => item.profile.exactQueries),
      8,
    );
    addUniqueNormalized(
      next.focusTerms,
      profiled.flatMap(item => item.profile.focusTerms),
      12,
    );

    const failed = new Set(next.failedFetchUrls);
    for (const item of profiled) {
      const url = item.result.url;
      if (!url || failed.has(url)) continue;
      if (
        item.profile.fetchCandidate
        && !next.fetchCandidates.some(candidate => candidate.url === url)
      ) {
        next.fetchCandidates.push({
          url,
          focusTerms: item.profile.focusTerms.slice(0, 8),
        });
      }
      if (
        item.profile.confirmationCandidate
        && !next.confirmationCandidates.some(candidate => candidate.url === url)
      ) {
        next.confirmationCandidates.push({
          url,
          shapes: item.profile.shapes.slice(0, 5),
        });
      }
    }

    next.fetchCandidates = next.fetchCandidates
      .filter(item => !failed.has(item.url))
      .slice(0, 8);
    next.confirmationCandidates = next.confirmationCandidates
      .filter(item => !failed.has(item.url))
      .slice(0, 8);
    return next;
  }

  function markSourceTextFetchMiss(
    previous: SourceConvergenceState | undefined,
    url: string,
  ): SourceConvergenceState | undefined {
    if (!previous) return previous;
    const failed = [...previous.failedFetchUrls];
    if (url && !failed.includes(url)) failed.push(url);
    return {
      ...previous,
      failedFetchUrls: failed.slice(-12),
      fetchCandidates: previous.fetchCandidates.filter(item => item.url !== url),
      confirmationCandidates: previous.confirmationCandidates
        .filter(item => item.url !== url),
      elasticExtensionsUsed: previous.elasticExtensionsUsed,
      lastElasticSignature: previous.lastElasticSignature,
    };
  }

  function mergeFetchedSourceSignals(
    previous: SourceConvergenceState | undefined,
    signals: { focusTerms: string[]; exactQueries: string[] },
  ): SourceConvergenceState | undefined {
    if (
      !previous
      && signals.focusTerms.length === 0
      && signals.exactQueries.length === 0
    ) {
      return previous;
    }
    const next = previous
      ? copySourceConvergenceState(previous)
      : initialSourceConvergenceState();
    addUniqueNormalized(next.focusTerms, signals.focusTerms, 12);
    addUniqueNormalized(next.exactQueries, signals.exactQueries, 8);
    return next;
  }

  function formatQueuedSourceConvergence(
    state: SourceConvergenceState | undefined,
  ): string {
    if (!state) return "";
    const lines: string[] = [];
    const nextFetch = state.fetchCandidates[0];
    const nextQuery = state.exactQueries[0];
    const nextConfirm = state.confirmationCandidates
      .find(item => item.url !== nextFetch?.url);
    if (nextFetch || nextQuery || nextConfirm) {
      lines.push(
        "## Source-Text Convergence Queue",
        "Use this queue for exact source-text tasks before broad browsing. Do not count a page as complete source text unless the requested named/numbered unit and core conditions appear in fetched text.",
        "精确原文任务先使用这个队列，不要继续泛搜；只有抓取文本中出现目标编号/命名单元和核心条件，才可算完整原文。",
      );
    }
    if (nextFetch) {
      lines.push(`Next fetch: ${nextFetch.url}`);
      if (nextFetch.focusTerms.length > 0) {
        lines.push(
          `focus_terms: ${nextFetch.focusTerms.slice(0, 6).join(" | ")}`,
        );
      }
    }
    if (nextConfirm) {
      lines.push(
        `Next independent confirmation: ${nextConfirm.url} (${nextConfirm.shapes.join(", ")})`,
      );
    }
    if (nextQuery) lines.push(`Next exact search: ${nextQuery}`);
    if (state.failedFetchUrls.length > 0) {
      lines.push(
        `Already low-signal/blocked for this source-text task: ${state.failedFetchUrls.slice(-4).join(" | ")}`,
      );
    }
    return lines.length > 0 ? `\n\n${lines.join("\n")}` : "";
  }

  function formatSourceTextNextAction(
    state: SourceConvergenceState | undefined,
  ): string {
    const queued = formatQueuedSourceConvergence(state);
    if (!queued) return "";
    return [
      "",
      "## Recommended Next Source-Text Action",
      "Follow the queue below. Prefer `web_fetch` on the next fetch URL with the listed focus_terms. If it misses the requested text, use the next exact search; avoid overview, blocked, video-title, directory, or answer-only pages until a full source-text candidate is exhausted.",
      "按下面队列执行：优先对 Next fetch 做 `web_fetch` 并传入 focus_terms。若未命中目标原文，再用 Next exact search；在完整原文候选耗尽前，避免概述页、受阻页、视频标题页、目录页或只有答案结论的页面。",
      queued.trimStart(),
    ].join("\n");
  }

  function hasHighSignalFetchCandidate(
    state: SourceConvergenceState | undefined,
  ): boolean {
    if (!state) return false;
    return state.fetchCandidates.some(candidate =>
      candidate.focusTerms.some(term =>
        isHighSignalFocusPhrase(term) || hasContextualSourceSignal(term)
      ) || candidate.focusTerms.length >= 2
    );
  }

  function hasIndependentConfirmation(
    state: SourceConvergenceState | undefined,
  ): boolean {
    if (!state) return false;
    const fetchHost = hostOf(state.fetchCandidates[0]?.url || "");
    return state.confirmationCandidates.some(candidate => {
      const confirmHost = hostOf(candidate.url);
      return Boolean(confirmHost && confirmHost !== fetchHost);
    });
  }

  function hasElasticSourceTextProgress(
    state: SourceConvergenceState | undefined,
  ): boolean {
    if (!state) return false;
    if (
      state.fetchCandidates.length === 0
      && state.exactQueries.length === 0
    ) {
      return false;
    }
    const highSignalFetch = hasHighSignalFetchCandidate(state);
    const hasExactPath = state.exactQueries.length > 0;
    const hasConfirmPath = hasIndependentConfirmation(state);
    if (state.elasticExtensionsUsed === 0) {
      return highSignalFetch
        && (
          hasExactPath
          || hasConfirmPath
          || state.fetchCandidates.length >= 2
        );
    }
    if (state.elasticExtensionsUsed === 1) {
      return highSignalFetch && hasExactPath && hasConfirmPath;
    }
    return false;
  }

  function sourceConvergenceSignature(state: SourceConvergenceState): string {
    const payload = [
      ...state.fetchCandidates.map(item =>
        `fetch:${hostOf(item.url)}:${item.url}:${item.focusTerms.join("|")}`
      ),
      ...state.confirmationCandidates.map(item =>
        `confirm:${hostOf(item.url)}:${item.url}:${item.shapes.join("|")}`
      ),
      ...state.exactQueries.map(item => `query:${item}`),
      ...state.focusTerms.map(item => `focus:${item}`),
      ...state.failedFetchUrls.map(item => `failed:${item}`),
    ].join("\n");
    return createHash("sha256").update(payload).digest("hex").slice(0, 16);
  }

  function consumeElasticSourceTextProgress(
    state: SourceConvergenceState | undefined,
    maxCalls: number,
  ): { state: SourceConvergenceState; addCalls: number; notice: string } | undefined {
    if (!hasElasticSourceTextProgress(state)) return undefined;
    if (!state) return undefined;
    if (state.elasticExtensionsUsed >= 2) return undefined;
    const signature = sourceConvergenceSignature(state);
    if (
      state.elasticExtensionsUsed > 0
      && state.lastElasticSignature === signature
    ) {
      return undefined;
    }
    const preferred = state.elasticExtensionsUsed === 0
      ? elasticFirstExtension
      : elasticSecondExtension;
    const addCalls = Math.max(0, Math.min(preferred, maxCalls));
    if (addCalls <= 0) return undefined;
    const nextState: SourceConvergenceState = {
      ...state,
      fetchCandidates: state.fetchCandidates.map(item => ({
        url: item.url,
        focusTerms: [...item.focusTerms],
      })),
      confirmationCandidates: state.confirmationCandidates.map(item => ({
        url: item.url,
        shapes: [...item.shapes],
      })),
      exactQueries: [...state.exactQueries],
      focusTerms: [...state.focusTerms],
      failedFetchUrls: [...state.failedFetchUrls],
      elasticExtensionsUsed: state.elasticExtensionsUsed + 1,
      lastElasticSignature: signature,
    };
    const nextFetch = nextState.fetchCandidates[0]?.url || "none";
    const notice = [
      "",
      "---",
      "",
      "# Elastic Source Evidence Budget / 弹性原文证据预算",
      "",
      `Canvast added ${addCalls} bounded external call(s) because the exact-source queue contains structured anchors, unspent fetch candidates, and remaining time. Extension ${nextState.elasticExtensionsUsed}/2; the second extension also requires an exact query plus independent-host confirmation and a changed queue signature.`,
      `已追加 ${addCalls} 次有界外部调用，因为精确原文队列中存在结构化锚点、未消耗候选和剩余时间。当前为第 ${nextState.elasticExtensionsUsed}/2 次扩展；第二次扩展还要求精确查询、独立域名确认以及队列签名变化。`,
      `Next candidate: ${nextFetch}`,
      "",
    ].join("\n");
    return { state: nextState, addCalls, notice };
  }

  function formatSourceTextTriage(
    query: string,
    profiled: Array<{ result: SearchResult; profile: SourceTextProfile }>,
  ): string {
    const fetchCandidates = profiled
      .filter(item => item.profile.fetchCandidate)
      .slice(0, 4);
    const confirmationCandidates = profiled
      .filter(item => item.profile.confirmationCandidate)
      .filter((item, index, all) => {
        const host = hostOf(item.result.url);
        return host
          && all.findIndex(other => hostOf(other.result.url) === host) === index;
      })
      .slice(0, 4);
    const exactQueries = Array.from(
      new Set(profiled.flatMap(item => item.profile.exactQueries)),
    ).slice(0, 4);
    const focusTerms = Array.from(
      new Set(
        fetchCandidates.flatMap(item => item.profile.focusTerms),
      ),
    ).slice(0, 8);
    if (
      fetchCandidates.length === 0
      && confirmationCandidates.length === 0
      && exactQueries.length === 0
    ) {
      return "";
    }

    const lines = [
      "",
      "## Source-Text Retrieval Triage",
      "For exact source-text tasks, spend the next call on a listed fetch candidate with the suggested focus_terms before issuing another broad search. A second independent host may corroborate identity, role, or key conditions when the fetched source contains the complete text.",
      "For exact-source tasks, autonomous retrieval must identify the requested named/numbered unit or explicit anchor set before using the text as complete evidence; overview pages or answer-only pages are not enough.",
      "对精确原文任务，下一次调用优先抓取下列候选 URL，并使用 Suggested focus_terms 定位；当一个 fetch 返回完整原文时，另一个独立域名可用于确认身份、角色或核心条件。",
      "对精确原文任务，自主检索必须先确认请求的命名/编号单元或显式锚点集合，再把文本作为完整证据；只有概述页或答案页不算完整原文证据。",
    ];

    if (fetchCandidates.length > 0) {
      lines.push("", "Fetch candidates:");
      fetchCandidates.forEach((item, index) => {
        lines.push(`${index + 1}. ${item.result.url}`);
        if (item.profile.focusTerms.length > 0) {
          lines.push(
            `   focus_terms: ${item.profile.focusTerms.slice(0, 6).join(" | ")}`,
          );
        }
      });
    }

    if (confirmationCandidates.length > 0) {
      lines.push(
        "",
        `Independent confirmation candidates (${independentHosts(confirmationCandidates.map(item => item.result))} hosts):`,
      );
      confirmationCandidates.forEach((item, index) => {
        lines.push(
          `${index + 1}. ${item.result.url} — ${item.profile.shapes.join(", ")}`,
        );
      });
    }

    if (exactQueries.length > 0) {
      lines.push(
        "",
        "Suggested exact follow-up queries if no fetch candidate contains the full text:",
      );
      exactQueries.forEach((item, index) =>
        lines.push(`${index + 1}. ${item || query}`)
      );
    }

    if (focusTerms.length > 0) {
      lines.push("", `Reusable focus_terms: ${focusTerms.join(" | ")}`);
    }

    return lines.join("\n");
  }

  return {
    buildExactQueries,
    cleanFocusTerm,
    consumeElasticSourceTextProgress,
    extractContextualSignalTerms,
    extractFocusTermsFromText,
    formatSearchResult,
    formatSourceTextNextAction,
    formatSourceTextTriage,
    isReusableSourceTextTerm,
    markSourceTextFetchMiss,
    mergeFetchedSourceSignals,
    mergeSourceConvergenceState,
    normalizeRetrievalStrategy,
    profileSearchResultWithStrategy,
    retrievalAnchorTerms,
    wantsExactSourceText,
  };
}

export type SourceTextTools = ReturnType<typeof createSourceTextTools>;
