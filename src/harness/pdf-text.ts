/**
 * =============================================================================
 * Canvast — Pdf Text / Canvast 源文件
 * =============================================================================
 * @file        src/harness/pdf-text.ts
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
/**
 * PDF text extraction for source-evidence web fetching.
 *
 * This keeps binary document parsing out of the web tool extension. The parser
 * is a maintained library, so Canvast does not depend on brittle PDF scraping.
 */

import { PDFParse } from "pdf-parse";

export interface PdfTextResult {
  text: string;
  pages?: number;
}

export function isLikelyPdfResource(url: string, contentType: string | null | undefined): boolean {
  const type = String(contentType || "").toLowerCase();
  return type.includes("application/pdf") || /\.pdf(?:[?#]|$)/i.test(url);
}

export async function extractPdfText(data: ArrayBuffer | Uint8Array | Buffer): Promise<PdfTextResult> {
  const bytes = Buffer.isBuffer(data)
    ? data
    : data instanceof Uint8Array
      ? Buffer.from(data)
      : Buffer.from(data);
  const parser = new PDFParse({ data: bytes });
  try {
    const result = await parser.getText();
    return {
      text: String(result.text || "").trim(),
      pages: Array.isArray(result.pages) ? result.pages.length : undefined,
    };
  } finally {
    await parser.destroy();
  }
}
