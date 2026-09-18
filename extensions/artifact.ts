/**
 * =============================================================================
 * Canvast — Artifact Renderer / 制品渲染
 * =============================================================================
 * @file        extensions/artifact.ts
 * @brief       Render HTML/Markdown content to shareable pages
 * @description Writes standalone artifacts to local files and provides a
 *              browser-openable URL for review. Phase 2: publish to web.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * Changes: [2026-08-08] Initial implementation
 * =============================================================================
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createHash } from "node:crypto";
import { existsSync, writeFileSync, mkdirSync, renameSync, rmSync } from "fs";
import { join } from "path";

function safeArtifactSlug(title: string): string {
  const normalized = title.normalize("NFKC").trim().toLowerCase();
  const pieces = normalized
    .replace(/['"]/g, "")
    .split(/[^a-z0-9]+/i)
    .map((piece) => piece.trim())
    .filter(Boolean)
    .slice(0, 8);
  return pieces.join("-") || "artifact";
}

function uniqueArtifactPath(artifactsDir: string, slug: string, title: string, content: string, favicon: string): string {
  const identity = createHash("sha256").update(`${title}\0${content}\0${favicon}`).digest("hex").slice(0, 12);
  const titleHash = createHash("sha256").update(title.normalize("NFKC")).digest("hex").slice(0, 8);
  let attempt = 0;
  while (attempt < 10_000) {
    const suffix = attempt === 0 ? `${titleHash}-${identity}` : `${titleHash}-${identity}-${attempt}`;
    const candidate = join(artifactsDir, `${slug}-${suffix}.html`);
    if (!existsSync(candidate)) return candidate;
    attempt += 1;
  }
  throw new Error(`Could not allocate a unique artifact filename for title: ${title}`);
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "create_artifact",
    label: "Create Artifact / 创建制品",
    description: `Create a standalone HTML artifact file from content.
Renders in browser with light/dark theme support.`,
    parameters: Type.Object({
      title: Type.String({ description: "Artifact title / 制品标题" }),
      content: Type.String({ description: "HTML or Markdown content / HTML或Markdown内容" }),
      favicon: Type.Optional(Type.String({ description: "Emoji favicon / Emoji图标", default: "📄" })),
    }),
    async execute(_id: string, params: any) {
      const { title, content, favicon = "📄" } = params;
      const artifactsDir = join(process.cwd(), ".canvast-artifacts");
      mkdirSync(artifactsDir, { recursive: true });

      const slug = safeArtifactSlug(title);
      const filepath = uniqueArtifactPath(artifactsDir, slug, title, content, favicon);

      const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>${favicon}</text></svg>">
<style>:root{--bg:#faf9f7;--text:#1a1a1a}@media(prefers-color-scheme:dark){:root{--bg:#1a1a1a;--text:#e5e5e5}}
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:var(--bg);color:var(--text);max-width:900px;margin:0 auto;padding:2rem;line-height:1.6}
</style></head><body>${content}</body></html>`;

      const temporary = `${filepath}.${process.pid}.${process.hrtime.bigint()}.tmp`;
      try {
        writeFileSync(temporary, html, { flag: "wx" });
        renameSync(temporary, filepath);
      } finally {
        if (existsSync(temporary)) rmSync(temporary, { force: true });
      }
      return {
        content: [{ type: "text" as const, text: `✅ Artifact created: **${title}**\nFile: \`${filepath}\`\nOpen: file://${filepath}` }],
        details: { title, filepath, size: html.length },
      };
    },
  });
}
