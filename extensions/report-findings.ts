/**
 * =============================================================================
 * Canvast — Report Findings / 报告发现
 * =============================================================================
 * @file        extensions/report-findings.ts
 * @brief       Session-scoped structured code-review finding capture.
 * @description Keeps findings only in the current extension session memory.
 *              This extension does not claim a durable Canvas-backed finding
 *              lifecycle and does not support mark-fixed transitions.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * Changes: [2026-08-25] Make session-memory semantics explicit and fail closed
 *                       on fake durable status transitions.
 * =============================================================================
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";

type FindingStatus = "open";
type FindingSeverity = "critical" | "high" | "medium" | "low";

interface Finding {
  id: string;
  file: string;
  line: number;
  severity: FindingSeverity;
  category: string;
  summary: string;
  description: string;
  status: FindingStatus;
  createdAt: string;
  updatedAt: string;
}

export default function (pi: ExtensionAPI) {
  const findings: Finding[] = [];

  pi.registerTool({
    name: "report_findings",
    label: "Report Findings / 报告发现",
    description: "Record structured code-review findings in current session memory only.",
    parameters: Type.Object({ findings: Type.Array(Type.Object({
      file: Type.String({ description: "File path" }),
      line: Type.Number({ description: "Line number" }),
      severity: Type.Union([Type.Literal("critical"), Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
      category: Type.String({ description: "e.g., security, bug, performance, style" }),
      summary: Type.String({ description: "One-line summary / 一行摘要" }),
      description: Type.Optional(Type.String({ description: "Detailed description / 详细描述" })),
    })) }),
    async execute(_id: string, params: any) {
      const now = new Date().toISOString();
      const added: Finding[] = params.findings.map((finding: any) => ({
        id: `finding_${randomUUID()}`, file: finding.file, line: finding.line,
        severity: finding.severity, category: finding.category, summary: finding.summary,
        description: finding.description || "", status: "open", createdAt: now, updatedAt: now,
      }));
      findings.push(...added);
      const list = added.map((finding, index) =>
        `**#${index + 1}** [${finding.severity.toUpperCase()}] [${finding.category}] \`${finding.file}:${finding.line}\` — ${finding.summary}`,
      ).join("\n");
      return {
        content: [{
          type: "text" as const,
          text: `# Findings / 发现 (${added.length})\n\n${list}\n\nStored in current extension session memory only. Not persisted to Canvas or runtime state. This extension does not support marking findings fixed.`,
        }],
        details: { count: added.length, ids: added.map(finding => finding.id) },
      };
    },
  });

  pi.registerTool({
    name: "report_update",
    label: "Update Finding / 更新发现",
    description: "Unavailable here: session-memory findings do not expose a durable mark-fixed lifecycle.",
    parameters: Type.Object({
      id: Type.String({ description: "Finding ID" }),
      status: Type.Union([Type.Literal("open"), Type.Literal("fixed"), Type.Literal("dismissed")]),
    }),
    async execute(_id: string, params: any) {
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: `report_update is unavailable: report_findings only keeps findings in current session memory and cannot durably mark ${params.id} as ${params.status}.`,
        }],
        details: { id: params.id, status: params.status, lifecycle: "session_memory_only" },
      };
    },
  });

  pi.registerTool({
    name: "report_list",
    label: "List Findings / 发现列表",
    description: "List findings captured in the current extension session only.",
    parameters: Type.Object({
      severity: Type.Optional(Type.Union([Type.Literal("critical"), Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")])),
      status: Type.Optional(Type.Literal("open")),
    }),
    async execute(_id: string, params: any) {
      let filtered = findings;
      if (params.severity) filtered = filtered.filter(finding => finding.severity === params.severity);
      if (params.status) filtered = filtered.filter(finding => finding.status === params.status);
      if (!filtered.length) {
        return {
          content: [{
            type: "text" as const,
            text: "No findings match the filter in the current extension session.",
          }],
          details: { findings: [], lifecycle: "session_memory_only" },
        };
      }
      const list = filtered.map(finding =>
        `- [${finding.severity.toUpperCase()}] [${finding.status}] \`${finding.file}:${finding.line}\` — ${finding.summary}`,
      ).join("\n");
      return {
        content: [{
          type: "text" as const,
          text: `# Findings / 发现 (${filtered.length})\n\n${list}\n\nCurrent extension session only. Not persisted to Canvas or runtime state.`,
        }],
        details: { findings: filtered, lifecycle: "session_memory_only" },
      };
    },
  });
}
