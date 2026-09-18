/**
 * =============================================================================
 * Canvast — Web Tools Transport / Canvast 源文件
 * =============================================================================
 * @file        extensions/web-tools/transport.ts
 * @brief       Network transport for Canvast web fetch and search tools.
 * @description Owns request deadlines and adapter calls while delegating
 *              parsing details through explicitly injected syntax helpers.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import { lookup } from "node:dns/promises";
import { request as requestHttp } from "node:http";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { request as requestHttps } from "node:https";
import { extractPdfText, isLikelyPdfResource } from "../../src/harness/pdf-text.js";
import { parseDuckDuckGoHtml } from "./parse.js";
import type {
  FetchTextResult,
  SearchAttemptOutcome,
  SearchResult,
  SearchWebOutcome,
  WebFailureStatus,
  WebSyntax,
} from "./types.js";

const MAX_RAW_FETCH_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;
const USER_AGENT = "Canvast/0.1 (+https://github.com/canvast; evidence-focused research)";

class WebTransportFailure extends Error {
  constructor(
    readonly status: WebFailureStatus,
    message: string,
  ) {
    super(message);
    this.name = "WebTransportFailure";
  }
}

const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as Array<[string, number]>) {
  blockedAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as Array<[string, number]>) {
  blockedAddresses.addSubnet(network, prefix, "ipv6");
}

function makeAbort(
  timeoutMs: number,
  signal?: AbortSignal,
): {
  signal: AbortSignal;
  timedOut: () => boolean;
  externallyAborted: () => boolean;
  clear: () => void;
} {
  const controller = new AbortController();
  let abortKind: "none" | "timeout" | "external" = "none";
  const timeout = setTimeout(() => {
    if (abortKind !== "none") return;
    abortKind = "timeout";
    controller.abort();
  }, timeoutMs);
  const forwardAbort = () => {
    if (abortKind !== "none") return;
    abortKind = "external";
    controller.abort(signal?.reason);
  };
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener("abort", forwardAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => abortKind === "timeout",
    externallyAborted: () => abortKind === "external",
    clear: () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", forwardAbort);
    },
  };
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("Web request was aborted.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

async function lookupWithAbort(
  hostname: string,
  signal?: AbortSignal,
): Promise<Array<{ address: string; family: number }>> {
  throwIfAborted(signal);
  if (!signal) return lookup(hostname, { all: true, verbatim: true });

  const pendingLookup = lookup(hostname, { all: true, verbatim: true });
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();

    void pendingLookup.then(
      addresses => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(addresses);
      },
      error => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function thrownFailureStatus(
  error: unknown,
  timedOut = false,
  externallyAborted = false,
): WebFailureStatus {
  if (error instanceof WebTransportFailure) return error.status;
  if (timedOut || (error instanceof Error && error.name === "TimeoutError")) return "timeout";
  if (externallyAborted) return "cancelled";
  return "transport_error";
}

function httpFailureMessage(status: number, statusText: string): string {
  return `HTTP ${status}${statusText ? `: ${statusText}` : ""}`;
}

function normalizedHostname(url: URL): string {
  return url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
}

function addressIsBlocked(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blockedAddresses.check(address, "ipv4");
  if (family === 6) {
    const lowerAddress = address.toLowerCase();
    if (lowerAddress.startsWith("::ffff:")) {
      const suffix = lowerAddress.slice("::ffff:".length);
      if (isIP(suffix) === 4) {
        return blockedAddresses.check(suffix, "ipv4");
      }
      const words = suffix.split(":");
      if (words.length === 2) {
        const high = Number.parseInt(words[0], 16);
        const low = Number.parseInt(words[1], 16);
        if (
          words.every(word => word.length > 0)
          && Number.isInteger(high)
          && Number.isInteger(low)
          && high >= 0
          && high <= 0xffff
          && low >= 0
          && low <= 0xffff
        ) {
          const ipv4 = [
            high >>> 8,
            high & 0xff,
            low >>> 8,
            low & 0xff,
          ].join(".");
          return blockedAddresses.check(ipv4, "ipv4");
        }
      }
    }
    return blockedAddresses.check(address, "ipv6");
  }
  return true;
}

type ValidatedWebTarget = {
  url: URL;
  addresses: Array<{ address: string; family: 4 | 6 }>;
};

async function validatePublicWebUrl(
  rawUrl: string,
  signal?: AbortSignal,
): Promise<ValidatedWebTarget> {
  throwIfAborted(signal);
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new WebTransportFailure("unsafe_url", "Invalid web URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new WebTransportFailure(
      "unsafe_url",
      `Blocked URL protocol: ${parsed.protocol || "unknown"}. Only http and https are allowed.`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new WebTransportFailure("unsafe_url", "URLs containing credentials are not allowed.");
  }
  const hostname = normalizedHostname(parsed);
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : await lookupWithAbort(hostname, signal);
  throwIfAborted(signal);
  if (addresses.length === 0) {
    throw new WebTransportFailure("transport_error", `DNS returned no addresses for ${hostname}.`);
  }
  const unsafe = addresses.find(entry => addressIsBlocked(entry.address));
  if (unsafe) {
    throw new WebTransportFailure(
      "unsafe_url",
      `Blocked non-public destination address for ${hostname}.`,
    );
  }
  return {
    url: parsed,
    addresses: addresses.map(entry => ({
      address: entry.address,
      family: entry.family as 4 | 6,
    })),
  };
}

function redirectLocation(response: Response, currentUrl: URL): string | undefined {
  if (![301, 302, 303, 307, 308].includes(response.status)) return undefined;
  const location = response.headers.get("location");
  if (!location) return undefined;
  return new URL(location, currentUrl).toString();
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (!response.body) return;
  try {
    const reader = response.body.getReader();
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  } catch {
    // Best-effort connection cleanup must not hide the primary policy outcome.
  }
}

function pinnedLookup(
  hostname: string,
  addresses: Array<{ address: string; family: 4 | 6 }>,
): LookupFunction {
  return (
    requestedHostname,
    options,
    callback,
  ) => {
    if (requestedHostname !== hostname) {
      callback(new WebTransportFailure(
        "unsafe_url",
        "Connection hostname changed after URL validation.",
      ), "", 4);
      return;
    }
    const requestedFamily = typeof options === "number"
      ? options
      : options?.family || 0;
    const selected = addresses.find(entry =>
      requestedFamily === 0 || entry.family === requestedFamily
    ) || addresses[0];
    if (typeof options === "object" && options?.all) {
      callback(null, addresses);
      return;
    }
    callback(null, selected.address, selected.family);
  };
}

const originalGlobalFetch = globalThis.fetch;

async function fetchPinnedTarget(
  target: ValidatedWebTarget,
  init: RequestInit,
): Promise<Response> {
  if (process.env.VITEST && globalThis.fetch !== originalGlobalFetch) {
    return fetch(target.url.toString(), init);
  }
  const hostname = normalizedHostname(target.url);
  const requestHeaders = new Headers(init.headers);
  requestHeaders.set("Accept-Encoding", "identity");
  const headers = Object.fromEntries(requestHeaders.entries());
  const request = target.url.protocol === "https:" ? requestHttps : requestHttp;
  return new Promise<Response>((resolve, reject) => {
    const outgoing = request(target.url, {
      method: init.method || "GET",
      headers,
      signal: init.signal || undefined,
      lookup: pinnedLookup(hostname, target.addresses),
      agent: false,
    }, incoming => {
      const responseHeaders = new Headers();
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
        responseHeaders.append(
          incoming.rawHeaders[index],
          incoming.rawHeaders[index + 1],
        );
      }
      const status = incoming.statusCode || 500;
      const body = [204, 205, 304].includes(status)
        ? null
        : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      resolve(new Response(body, {
        status,
        statusText: incoming.statusMessage,
        headers: responseHeaders,
      }));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

async function fetchWithValidatedRedirects(
  rawUrl: string,
  init: RequestInit,
  redirectChain: string[],
): Promise<{ response: Response; url: string }> {
  let current = rawUrl;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    throwIfAborted(init.signal || undefined);
    const target = await validatePublicWebUrl(current, init.signal || undefined);
    const targetUrl = target.url.toString();
    redirectChain.push(targetUrl);
    const response = await fetchPinnedTarget(target, {
      ...init,
      redirect: "manual",
    });
    try {
      throwIfAborted(init.signal || undefined);
      const next = redirectLocation(response, target.url);
      if (!next) {
        await validatePublicWebUrl(targetUrl, init.signal || undefined);
        return { response, url: targetUrl };
      }
      if (redirects === MAX_REDIRECTS) {
        throw new WebTransportFailure(
          "transport_error",
          `Too many redirects (maximum ${MAX_REDIRECTS}).`,
        );
      }
      current = next;
    } catch (error) {
      await cancelResponseBody(response);
      throw error;
    }
    await cancelResponseBody(response);
  }
  throw new WebTransportFailure("transport_error", "Redirect processing failed.");
}

function declaredContentLength(response: Response): number | undefined {
  const raw = response.headers.get("content-length");
  if (raw === null || raw.trim() === "") return undefined;
  const length = Number(raw);
  return Number.isSafeInteger(length) && length >= 0 ? length : undefined;
}

async function readBoundedBody(
  response: Response,
  byteLimit = MAX_RAW_FETCH_BYTES,
): Promise<Uint8Array> {
  const declared = declaredContentLength(response);
  if (declared !== undefined && declared > byteLimit) {
    await cancelResponseBody(response);
    throw new WebTransportFailure(
      "response_too_large",
      `Response Content-Length ${declared} bytes exceeds the ${byteLimit}-byte limit.`,
    );
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > byteLimit) {
        await reader.cancel("response body exceeded byte limit");
        throw new WebTransportFailure(
          "response_too_large",
          `Response body exceeds the ${byteLimit}-byte limit.`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readBoundedText(response: Response): Promise<string> {
  return new TextDecoder().decode(await readBoundedBody(response));
}

export async function fetchText(
  url: string,
  syntax: WebSyntax,
  signal?: AbortSignal,
  timeoutMs = 15_000,
): Promise<FetchTextResult & { redirectChain: string[] }> {
  const abort = makeAbort(Math.max(1, Math.floor(timeoutMs)), signal);
  const redirectChain: string[] = [];
  try {
    const fetched = await fetchWithValidatedRedirects(url, {
      signal: abort.signal,
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,text/plain,application/json,application/pdf",
      },
    }, redirectChain);
    const { response } = fetched;
    if (!response.ok) {
      await cancelResponseBody(response);
      return {
        ok: false,
        status: "http_error",
        error: httpFailureMessage(response.status, response.statusText),
        url: fetched.url,
        httpStatus: response.status,
        redirectChain: [...redirectChain],
      };
    }
    const contentType = response.headers.get("content-type") || "";
    if (isLikelyPdfResource(fetched.url, contentType)) {
      const pdfBytes = await readBoundedBody(response);
      try {
        const pdf = await extractPdfText(pdfBytes);
        const text = pdf.text.length > MAX_RAW_FETCH_BYTES
          ? pdf.text.slice(0, MAX_RAW_FETCH_BYTES) + "\n...(raw PDF text truncated)"
          : pdf.text;
        return {
          ok: true,
          text,
          title: pdf.pages ? `${fetched.url} (${pdf.pages} PDF pages)` : fetched.url,
          url: fetched.url,
          redirectChain: [...redirectChain],
        };
      } catch (error) {
        return {
          ok: false,
          status: "parse_error",
          error: `PDF text extraction failed: ${errorMessage(error)}`,
          url: fetched.url,
          redirectChain: [...redirectChain],
        };
      }
    }

    const responseText = await readBoundedText(response);
    let text = responseText;
    if (contentType.includes("application/json")) {
      try {
        text = JSON.stringify(JSON.parse(responseText), null, 2);
      } catch (error) {
        return {
          ok: false,
          status: "parse_error",
          error: `JSON parsing failed: ${errorMessage(error)}`,
          url: fetched.url,
          redirectChain: [...redirectChain],
        };
      }
    }
    if (text.length > MAX_RAW_FETCH_BYTES) {
      text = text.slice(0, MAX_RAW_FETCH_BYTES) + "\n...(raw page truncated)";
    }
    const title = syntax.extractHtmlTitle(text);
    return {
      ok: true,
      text: syntax.stripHtml(text),
      title: syntax.normalizeSpaces(title || "") || fetched.url,
      url: fetched.url,
      redirectChain: [...redirectChain],
    };
  } catch (error) {
    return {
      ok: false,
      status: thrownFailureStatus(
        error,
        abort.timedOut(),
        abort.externallyAborted(),
      ),
      error: errorMessage(error),
      url: redirectChain.at(-1) || url,
      redirectChain: [...redirectChain],
    };
  } finally {
    abort.clear();
  }
}

export async function searchWeb(
  query: string,
  maxResults: number,
  syntax: WebSyntax,
  signal?: AbortSignal,
  timeoutMs = 20_000,
): Promise<SearchWebOutcome> {
  const abort = makeAbort(Math.max(1, Math.floor(timeoutMs)), signal);
  const attempts: SearchAttemptOutcome[] = [];
  const results: SearchResult[] = [];
  try {
    const instantAnswerUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`;
    try {
      const response = await fetch(instantAnswerUrl, {
        signal: abort.signal,
        headers: { "User-Agent": USER_AGENT },
      });
      if (!response.ok) {
        await cancelResponseBody(response);
        attempts.push({
          adapter: "duckduckgo_instant_answer",
          status: "http_error",
          resultCount: 0,
          message: httpFailureMessage(response.status, response.statusText),
          httpStatus: response.status,
        });
      } else {
        const body = await readBoundedText(response);
        try {
          const data = body.trim() ? JSON.parse(body) : {};
          const before = results.length;
          if (data.AbstractText) {
            results.push({
              title: data.Heading || query,
              url: data.AbstractURL || "",
              snippet: data.AbstractText,
            });
          }
          for (const topic of data.RelatedTopics || []) {
            if (results.length >= maxResults) break;
            if (topic.Text && topic.FirstURL) {
              results.push({
                title: topic.FirstURL.split("/").pop() || topic.Text.slice(0, 50),
                url: topic.FirstURL,
                snippet: topic.Text,
              });
            } else if (Array.isArray(topic.Topics)) {
              for (const subtopic of topic.Topics) {
                if (results.length >= maxResults) break;
                if (subtopic.Text && subtopic.FirstURL) {
                  results.push({
                    title: subtopic.FirstURL.split("/").pop() || subtopic.Text.slice(0, 50),
                    url: subtopic.FirstURL,
                    snippet: subtopic.Text,
                  });
                }
              }
            }
          }
          const resultCount = results.length - before;
          attempts.push({
            adapter: "duckduckgo_instant_answer",
            status: resultCount > 0 ? "results" : "empty",
            resultCount,
          });
        } catch (error) {
          attempts.push({
            adapter: "duckduckgo_instant_answer",
            status: "parse_error",
            resultCount: 0,
            message: `DuckDuckGo Instant Answer returned invalid JSON: ${errorMessage(error)}`,
          });
        }
      }
    } catch (error) {
      const status = thrownFailureStatus(
        error,
        abort.timedOut(),
        abort.externallyAborted(),
      );
      attempts.push({
        adapter: "duckduckgo_instant_answer",
        status,
        resultCount: 0,
        message: errorMessage(error),
      });
      if (status === "cancelled" || status === "timeout") {
        return {
          status,
          failed: true,
          resultCount: 0,
          results: [],
          attempts,
          message: errorMessage(error),
        };
      }
    }

    if (results.length < maxResults) {
      if (abort.signal.aborted) {
        const status = abort.externallyAborted() ? "cancelled" : "timeout";
        return {
          status,
          failed: true,
          resultCount: 0,
          results: [],
          attempts,
          message: errorMessage(abortReason(abort.signal)),
        };
      }
      const htmlUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      try {
        const { response } = await fetchWithValidatedRedirects(htmlUrl, {
          signal: abort.signal,
          headers: { "User-Agent": USER_AGENT, "Accept": "text/html" },
        }, []);
        if (!response.ok) {
          await cancelResponseBody(response);
          attempts.push({
            adapter: "duckduckgo_html",
            status: "http_error",
            resultCount: 0,
            message: httpFailureMessage(response.status, response.statusText),
            httpStatus: response.status,
          });
        } else {
          const html = await readBoundedText(response);
          try {
            const htmlResults = parseDuckDuckGoHtml(html, maxResults * 2, syntax);
            const seen = new Set(results.map(result => result.url));
            const before = results.length;
            for (const item of htmlResults) {
              if (results.length >= maxResults) break;
              if (item.url && !seen.has(item.url)) {
                seen.add(item.url);
                results.push(item);
              }
            }
            const resultCount = results.length - before;
            attempts.push({
              adapter: "duckduckgo_html",
              status: resultCount > 0 ? "results" : "empty",
              resultCount,
            });
          } catch (error) {
            attempts.push({
              adapter: "duckduckgo_html",
              status: "parse_error",
              resultCount: 0,
              message: `DuckDuckGo HTML parsing failed: ${errorMessage(error)}`,
            });
          }
        }
      } catch (error) {
        const status = thrownFailureStatus(
          error,
          abort.timedOut(),
          abort.externallyAborted(),
        );
        attempts.push({
          adapter: "duckduckgo_html",
          status,
          resultCount: 0,
          message: errorMessage(error),
        });
        if (status === "cancelled") {
          return {
            status,
            failed: true,
            resultCount: 0,
            results: [],
            attempts,
            message: errorMessage(error),
          };
        }
      }
    }

    const visibleResults = results.slice(0, maxResults);
    if (visibleResults.length > 0) {
      return {
        status: "results",
        failed: false,
        resultCount: visibleResults.length,
        results: visibleResults,
        attempts,
      };
    }
    const failure = attempts.find(attempt => attempt.status === "timeout")
      || attempts.find(attempt => attempt.status !== "empty" && attempt.status !== "results");
    if (failure && failure.status !== "empty" && failure.status !== "results") {
      const messages = attempts
        .filter(attempt => attempt.message)
        .map(attempt => `${attempt.adapter}: ${attempt.message}`);
      return {
        status: failure.status,
        failed: true,
        resultCount: 0,
        results: [],
        attempts,
        message: messages.join("; ") || failure.status,
      };
    }
    return {
      status: "empty",
      failed: false,
      resultCount: 0,
      results: [],
      attempts,
    };
  } finally {
    abort.clear();
  }
}
