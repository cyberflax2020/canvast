/**
 * =============================================================================
 * Canvast — Code Review Extension / 代码审查扩展
 * =============================================================================
 * @file        extensions/code-review.ts
 * @brief       Automated code review with structured findings
 * @description Integrates pi-agent-config/review.ts patterns (MIT, 2441 lines)
 *              and Codex CLI code-review skills (Apache 2.0) into a pi extension.
 *              Provides structured code review with severity ranking and fix suggestions.
 *              将 pi-agent-config 和 Codex CLI 的代码审查模式整合为 pi 扩展。
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * Changes: [2026-08-08] Initial — from pi-agent-config review.ts + Codex skills
 * =============================================================================
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "code_review",
    label: "Code Review / 代码审查",
    description: `Perform structured code review with categorized findings.
Analyzes code for: bugs, security issues, performance problems, style violations,
and architectural concerns. Each finding includes severity, location, and fix suggestion.
Based on pi-agent-config/review.ts (MIT) and Codex CLI code-review skill (Apache 2.0).`,
    parameters: Type.Object({
      file_path: Type.String({ description: "File to review / 要审查的文件" }),
      focus: Type.Optional(Type.Union([
        Type.Literal("all"), Type.Literal("security"), Type.Literal("performance"),
        Type.Literal("bugs"), Type.Literal("style"),
      ])),
    }),
    async execute(_id: string, params: any) {
      const { file_path, focus = "all" } = params;

      // Read the file first
      try {
        const fs = await import("fs");
        if (!fs.existsSync(file_path)) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `File not found: ${file_path}` }],
            details: undefined,
          };
        }
        const content = fs.readFileSync(file_path, "utf-8");
        const lines = content.split("\n");

        // Basic static analysis (expand with full review.ts patterns in Phase 2)
        const findings: string[] = [];
        let issueNum = 0;

        // Pattern-based checks adapted from pi-agent-config/review.ts
        const checks: Array<{ pattern: RegExp; category: string; severity: string; message: string }> = [
          { pattern: /console\.(log|warn|error|debug)\(/, category: "style", severity: "low", message: "Console statement found — consider using a logger" },
          { pattern: /TODO|FIXME|HACK|XXX/, category: "style", severity: "low", message: "TODO/FIXME marker found — should be tracked as a task" },
          { pattern: /\.innerHTML\s*=/, category: "security", severity: "high", message: "innerHTML assignment — potential XSS vulnerability" },
          { pattern: /eval\(/, category: "security", severity: "critical", message: "eval() usage — security risk and performance issue" },
          { pattern: /catch\s*\(\s*\)/, category: "bugs", severity: "medium", message: "Empty catch block — errors are silently swallowed" },
          { pattern: /process\.env\.\w+.*(?:KEY|SECRET|TOKEN|PASSWORD)/i, category: "security", severity: "high", message: "Sensitive env var usage — ensure it's not logged or exposed" },
          { pattern: /setTimeout\(\s*\d{5,}/, category: "performance", severity: "low", message: "Long setTimeout — consider if this is intentional" },
          { pattern: /for\s*\([^)]*\)\s*\{\s*\}\s*;?\s*$/, category: "bugs", severity: "medium", message: "Empty loop body — may be unintentional" },
        ];

        for (const check of checks) {
          if (focus !== "all" && check.category !== focus) continue;
          for (let i = 0; i < lines.length; i++) {
            if (check.pattern.test(lines[i])) {
              issueNum++;
              findings.push(
                `**#${issueNum}** [${check.severity.toUpperCase()}] [${check.category}] Line ${i + 1}: ${check.message}\n  \`${lines[i].trim().slice(0, 120)}\``,
              );
              if (findings.length >= 20) break; // max 20 findings
            }
          }
          if (findings.length >= 20) break;
        }

        const summary = findings.length === 0
          ? `# Code Review: ${file_path}\n\n✅ No issues found (basic static analysis).\nFile: ${lines.length} lines.`
          : `# Code Review: ${file_path}\n\n**${findings.length} finding(s)** | File: ${lines.length} lines | Focus: ${focus}\n\n${findings.join("\n\n")}\n\n---\n*Pattern-based static analysis. Full AI review available with Phase 2 integration.*`;

        return {
          content: [{ type: "text" as const, text: summary }],
          details: { file: file_path, lines: lines.length, findingCount: findings.length, focus },
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Review failed: ${err.message}` }],
          details: undefined,
        };
      }
    },
  });
}
