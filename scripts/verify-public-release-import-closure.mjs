/**
 * =============================================================================
 * Canvast — Public Release Import Closure / Canvast source file
 * =============================================================================
 * @file        scripts/verify-public-release-import-closure.mjs
 * @brief       Local module import closure checks for public release verification.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import path from "node:path";

const moduleExtensions = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);

function moduleTokens(text) {
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    const next = text[index + 1];
    if (character === "/" && next === "/") {
      index += 2;
      while (index < text.length && text[index] !== "\n") index += 1;
    } else if (character === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      index += 2;
    } else if (character === "`") {
      index += 1;
      while (index < text.length) {
        if (text[index] === "\\") index += 2;
        else if (text[index] === "`") { index += 1; break; }
        else index += 1;
      }
    } else if (character === "\"" || character === "'") {
      const quote = character;
      let value = "";
      index += 1;
      while (index < text.length && text[index] !== quote) {
        if (text[index] === "\\" && index + 1 < text.length) { value += text[index + 1]; index += 2; }
        else { value += text[index]; index += 1; }
      }
      index += 1;
      tokens.push({ type: "string", value });
    } else if ((character >= "A" && character <= "Z") || (character >= "a" && character <= "z") || character === "_" || character === "$") {
      const start = index;
      index += 1;
      while (index < text.length) {
        const current = text[index];
        const identifier = (current >= "A" && current <= "Z")
          || (current >= "a" && current <= "z")
          || (current >= "0" && current <= "9")
          || current === "_"
          || current === "$";
        if (!identifier) break;
        index += 1;
      }
      tokens.push({ type: "identifier", value: text.slice(start, index) });
    } else {
      if (!character.trim()) index += 1;
      else { tokens.push({ type: "punctuation", value: character }); index += 1; }
    }
  }
  return tokens;
}

function localModuleSpecifiers(text) {
  const tokens = moduleTokens(text);
  const specifiers = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "identifier" && token.value === "require" && tokens[index + 1]?.value === "(" && tokens[index + 2]?.type === "string") {
      specifiers.push(tokens[index + 2].value);
      continue;
    }
    if (token.type !== "identifier" || (token.value !== "import" && token.value !== "export")) continue;
    if (token.value === "import" && tokens[index + 1]?.type === "string") specifiers.push(tokens[index + 1].value);
    else if (token.value === "import" && tokens[index + 1]?.value === "(" && tokens[index + 2]?.type === "string") specifiers.push(tokens[index + 2].value);
    else {
      for (let cursor = index + 1; cursor < tokens.length && tokens[cursor].value !== ";"; cursor += 1) {
        if (tokens[cursor].value === "from" && tokens[cursor + 1]?.type === "string") { specifiers.push(tokens[cursor + 1].value); break; }
      }
    }
  }
  return specifiers.filter(specifier => specifier.startsWith("."));
}

function localImportCandidates(importer, specifier) {
  const clean = specifier.split("#")[0].split("?")[0];
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(importer), clean));
  const candidates = [resolved];
  const extension = path.posix.extname(resolved);
  if (extension === ".js") candidates.push(`${resolved.slice(0, -3)}.ts`, `${resolved.slice(0, -3)}.tsx`);
  else if (extension === ".jsx") candidates.push(`${resolved.slice(0, -4)}.tsx`);
  else if (extension === ".mjs") candidates.push(`${resolved.slice(0, -4)}.mts`);
  else if (extension === ".cjs") candidates.push(`${resolved.slice(0, -4)}.cts`);
  else if (!extension) {
    for (const suffix of [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", "/index.ts", "/index.js"]) candidates.push(`${resolved}${suffix}`);
  }
  return candidates;
}

export function verifyPublicReleaseLocalImportClosure(expectedPaths, readText, validRelative) {
  const unresolved = [];
  for (const importer of expectedPaths) {
    if (!moduleExtensions.has(path.posix.extname(importer))) continue;
    const text = readText(importer);
    for (const specifier of localModuleSpecifiers(text)) {
      const candidates = localImportCandidates(importer, specifier);
      if (!candidates.some(candidate => validRelative(candidate) && expectedPaths.has(candidate))) {
        unresolved.push(`unresolved local import in ${importer}: ${specifier}`);
      }
    }
  }
  return unresolved;
}
