/**
 * =============================================================================
 * Canvast — Credential Redaction / Canvast 源文件
 * =============================================================================
 * @file        src/harness/credential-redaction.ts
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
/**
 * Narrow output-boundary credential redaction.
 *
 * This intentionally uses pattern matching only at log/tool-output boundaries,
 * not for semantic routing or policy decisions.
 */

const SECRET_WORD_PATTERN = String.raw`(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY|ACCESS[_-]?KEY)`;
const SECRET_NAME_PATTERN = String.raw`(?:${SECRET_WORD_PATTERN}[A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*${SECRET_WORD_PATTERN}[A-Za-z0-9_]*)`;

const SECRET_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`\b(${SECRET_NAME_PATTERN})(\s*[:=]\s*)(['"]?)([^\s'";,)}\]]{6,})\3`,
  "gi",
);

const AUTHORIZATION_PATTERN = /\b(Authorization\s*[:=]\s*)(Bearer\s+)?([^\s'";,)}\]]{8,})/gi;
const BEARER_PATTERN = /\b(Bearer\s+)([A-Za-z0-9._~+/-]{8,}=*)/gi;

const TOKEN_PATTERNS: Array<{ pattern: RegExp; replacement: string | ((...args: any[]) => string) }> = [
  { pattern: /\bsk-[A-Za-z0-9][A-Za-z0-9._-]{5,}\b/g, replacement: "sk-***" },
  { pattern: /\bak-[A-Za-z0-9][A-Za-z0-9._-]{12,}\b/g, replacement: "ak-***" },
  {
    pattern: /\b(gh[opusr]_[A-Za-z0-9_]{12,})\b/g,
    replacement: (match: string) => `${match.slice(0, 4)}***`,
  },
  { pattern: /\b(AKIA[0-9A-Z]{8,})\b/g, replacement: "AKIA***" },
];

const MIN_STREAM_HOLDBACK_CHARS = 256;
const MAX_STREAM_HOLDBACK_CHARS = 4096;
const MAX_STREAM_PENDING_CHARS = MAX_STREAM_HOLDBACK_CHARS * 2;

type OpenCredentialCandidate = {
  start: number;
  replacement: string;
  acceptsContinuation: (character: string) => boolean;
  closingQuote?: string;
};

function isAssignmentValueCharacter(character: string): boolean {
  return character.trim() !== "" && !"'\";,)}]".includes(character);
}

function isBearerValueCharacter(character: string): boolean {
  return isAsciiAlphaNumeric(character) || "._~+/=-".includes(character);
}

function isAsciiAlphaNumeric(character: string): boolean {
  const code = character.charCodeAt(0);
  return (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122);
}

function isUppercaseAlphaNumeric(character: string): boolean {
  const code = character.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90);
}

function lastMatchEndingAt(
  pattern: RegExp,
  value: string,
  expectedEnd: number,
): RegExpExecArray | undefined {
  pattern.lastIndex = 0;
  let found: RegExpExecArray | undefined;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) {
    if (match.index + match[0].length === expectedEnd) found = match;
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
  pattern.lastIndex = 0;
  return found;
}

function candidateFromMatch(
  match: RegExpExecArray | undefined,
  replacement: string,
  acceptsContinuation: (character: string) => boolean,
  closingQuote?: string,
): OpenCredentialCandidate | undefined {
  if (!match) return undefined;
  return {
    start: match.index,
    replacement,
    acceptsContinuation,
    closingQuote,
  };
}

function findOpenCredentialCandidate(value: string): OpenCredentialCandidate | undefined {
  const terminated = `${value} `;
  const candidates: OpenCredentialCandidate[] = [];

  const authorization = lastMatchEndingAt(
    AUTHORIZATION_PATTERN,
    terminated,
    value.length,
  );
  const authorizationCandidate = candidateFromMatch(
    authorization,
    authorization
      ? `${authorization[1]}${authorization[2] || ""}***`
      : "",
    isAssignmentValueCharacter,
  );
  if (authorizationCandidate) candidates.push(authorizationCandidate);

  const assignment = lastMatchEndingAt(
    SECRET_ASSIGNMENT_PATTERN,
    terminated,
    value.length,
  );
  if (assignment && !assignment[3]) {
    candidates.push({
      start: assignment.index,
      replacement: `${assignment[1]}${assignment[2]}***`,
      acceptsContinuation: isAssignmentValueCharacter,
    });
  }
  for (const quote of ["\"", "'"]) {
    const syntheticallyClosed = `${value}${quote} `;
    const quotedAssignment = lastMatchEndingAt(
      SECRET_ASSIGNMENT_PATTERN,
      syntheticallyClosed,
      value.length + 1,
    );
    if (quotedAssignment?.[3] === quote) {
      candidates.push({
        start: quotedAssignment.index,
        replacement: `${quotedAssignment[1]}${quotedAssignment[2]}***`,
        acceptsContinuation: isAssignmentValueCharacter,
        closingQuote: quote,
      });
    }
  }

  const bearer = lastMatchEndingAt(BEARER_PATTERN, terminated, value.length);
  const bearerCandidate = candidateFromMatch(
    bearer,
    bearer ? `${bearer[1]}***` : "",
    isBearerValueCharacter,
  );
  if (bearerCandidate) candidates.push(bearerCandidate);

  for (const [index, rule] of TOKEN_PATTERNS.entries()) {
    const match = lastMatchEndingAt(rule.pattern, terminated, value.length);
    if (!match) continue;
    const replacement = typeof rule.replacement === "function"
      ? rule.replacement(match[0])
      : rule.replacement;
    candidates.push({
      start: match.index,
      replacement,
      acceptsContinuation: index === 3
        ? isUppercaseAlphaNumeric
        : index === 2
          ? character => isAsciiAlphaNumeric(character) || character === "_"
          : character =>
            isAsciiAlphaNumeric(character) || "._-".includes(character),
    });
  }

  return candidates.sort((left, right) => left.start - right.start)[0];
}

function safeCredentialBoundary(value: string, proposedBoundary: number): number {
  let boundary = proposedBoundary;
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of [
      AUTHORIZATION_PATTERN,
      SECRET_ASSIGNMENT_PATTERN,
      BEARER_PATTERN,
      ...TOKEN_PATTERNS.map(rule => rule.pattern),
    ]) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(value))) {
        const end = match.index + match[0].length;
        if (match.index < boundary && end > boundary) {
          boundary = end;
          changed = true;
        }
        if (match[0].length === 0) pattern.lastIndex += 1;
      }
      pattern.lastIndex = 0;
    }
  }
  return boundary;
}

function isSecretKey(key: string): boolean {
  return new RegExp(`^(?:${SECRET_NAME_PATTERN})$`, "i").test(key);
}

export function redactCredentialText(value: string): string {
  let redacted = value.replace(
    AUTHORIZATION_PATTERN,
    (_match, prefix: string, bearer: string | undefined) => `${prefix}${bearer || ""}***`,
  );
  redacted = redacted.replace(
    SECRET_ASSIGNMENT_PATTERN,
    (_match, name: string, separator: string) => `${name}${separator}***`,
  );
  redacted = redacted.replace(BEARER_PATTERN, (_match, prefix: string) => `${prefix}***`);
  for (const rule of TOKEN_PATTERNS) {
    redacted = redacted.replace(rule.pattern, rule.replacement as any);
  }
  return redacted;
}

export function redactCredentialsDeep<T>(value: T): T {
  if (typeof value === "string") return redactCredentialText(value) as T;
  if (Array.isArray(value)) return value.map(item => redactCredentialsDeep(item)) as T;
  if (!value || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretKey(key) && typeof child === "string" && child.trim()) {
      out[key] = "***";
    } else {
      out[key] = redactCredentialsDeep(child);
    }
  }
  return out as T;
}

export class CredentialStreamRedactor {
  private pending = "";
  private suppression?: Pick<
    OpenCredentialCandidate,
    "acceptsContinuation" | "closingQuote"
  >;
  private readonly holdbackChars: number;

  constructor(holdbackChars = MIN_STREAM_HOLDBACK_CHARS) {
    const requested = Number.isFinite(holdbackChars)
      ? Math.floor(holdbackChars)
      : MIN_STREAM_HOLDBACK_CHARS;
    this.holdbackChars = Math.max(
      MIN_STREAM_HOLDBACK_CHARS,
      Math.min(requested, MAX_STREAM_HOLDBACK_CHARS),
    );
  }

  push(chunk: string): string {
    let incoming = chunk;
    let output = "";
    if (this.suppression) {
      let index = 0;
      while (
        index < incoming.length
        && this.suppression.acceptsContinuation(incoming[index])
      ) {
        index += 1;
      }
      if (index === incoming.length) return "";

      const terminator = incoming[index];
      const dropTerminator = this.suppression.closingQuote === terminator;
      this.suppression = undefined;
      incoming = incoming.slice(index + (dropTerminator ? 1 : 0));
    }

    this.pending += incoming;
    if (this.pending.length <= this.holdbackChars) return "";

    const proposedBoundary = this.pending.length - this.holdbackChars;
    const openCandidate = findOpenCredentialCandidate(this.pending);
    if (openCandidate && openCandidate.start < proposedBoundary) {
      output += redactCredentialText(this.pending.slice(0, openCandidate.start));
      output += openCandidate.replacement;
      this.pending = "";
      this.suppression = {
        acceptsContinuation: openCandidate.acceptsContinuation,
        closingQuote: openCandidate.closingQuote,
      };
      return output;
    }

    const boundary = safeCredentialBoundary(this.pending, proposedBoundary);
    output += redactCredentialText(this.pending.slice(0, boundary));
    this.pending = this.pending.slice(boundary);
    if (this.pending.length > MAX_STREAM_PENDING_CHARS) {
      const overflow = this.pending.length - this.holdbackChars;
      output += redactCredentialText(this.pending.slice(0, overflow));
      this.pending = this.pending.slice(overflow);
    }
    return output;
  }

  flush(): string {
    const flushed = redactCredentialText(this.pending);
    this.pending = "";
    this.suppression = undefined;
    return flushed;
  }
}

export function createCredentialStreamRedactor(holdbackChars?: number): CredentialStreamRedactor {
  return new CredentialStreamRedactor(holdbackChars);
}
