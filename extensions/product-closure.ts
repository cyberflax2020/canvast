/**
 * =============================================================================
 * Canvast — Product Closure / Canvast 源文件
 * =============================================================================
 * @file        extensions/product-closure.ts
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */


import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "fs";
import * as path from "path";
import {
  createDefaultClosureItems,
  formatClosureSummary,
  normalizeClosureItem,
  summarizeClosure,
  transitionClosureItem,
  type ClosureItem,
  type ClosureState,
} from "../src/harness/product-closure.js";

interface ClosureFile {
  version: 1;
  savedAt: string;
  items: ClosureItem[];
}

function closurePath(agentDir: string): string {
  return path.join(agentDir, "product-closure.json");
}

function loadItems(file: string): ClosureItem[] {
  if (!fs.existsSync(file)) return createDefaultClosureItems();
  const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<ClosureFile>;
  const existing = Array.isArray(raw.items) ? raw.items.map(normalizeClosureItem) : [];
  const byId = new Map(existing.map(item => [item.id, item]));
  for (const item of createDefaultClosureItems()) {
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  return Array.from(byId.values());
}

function saveItems(file: string, items: ClosureItem[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const payload: ClosureFile = { version: 1, savedAt: new Date().toISOString(), items };
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, file);
}

function formatItem(item: ClosureItem): string {
  const latest = item.evidence[item.evidence.length - 1];
  return [
    `## ${item.id} — ${item.title}`,
    `kind=${item.kind} required=${item.required} state=${item.state}`,
    item.source ? `source=${item.source}` : "",
    item.selectedMechanism ? `mechanism=${item.selectedMechanism}` : "",
    item.implementation ? `implementation=${item.implementation}` : "",
    latest ? `latest evidence=${latest.status} :: ${latest.command}${latest.note ? ` :: ${latest.note}` : ""}` : "latest evidence=none",
    item.blockers.length ? `blockers=${item.blockers.join("; ")}` : "",
  ].filter(Boolean).join("\n");
}

export default function (pi: ExtensionAPI) {
  const agentDir =
    process.env.PI_CODING_AGENT_DIR ||
    path.join(process.env.HOME || "/tmp", ".canvast");
  const file = closurePath(agentDir);

  pi.registerTool({
    name: "product_delivery_gate",
    label: "Product Delivery Gate / 产品交付门禁",
    description: `Track and enforce required delivery closure.
Use this for every mandatory reference project, parity gap, enhanced gap,
safety gap, and verification gate. Delivery is blocked until all required
items are closed with passed evidence and an implementation/equivalent.`,
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("init"),
        Type.Literal("list"),
        Type.Literal("record"),
        Type.Literal("summary"),
        Type.Literal("assert_closed"),
      ]),
      item_id: Type.Optional(Type.String({ description: "Closure item id" })),
      state: Type.Optional(Type.Union([
        Type.Literal("pending"),
        Type.Literal("ran"),
        Type.Literal("gap"),
        Type.Literal("implemented"),
        Type.Literal("closed"),
      ])),
      command: Type.Optional(Type.String({ description: "Evidence command or run id" })),
      evidence_status: Type.Optional(Type.Union([
        Type.Literal("passed"),
        Type.Literal("failed"),
        Type.Literal("blocked"),
      ])),
      note: Type.Optional(Type.String({ description: "Short evidence note" })),
      run_id: Type.Optional(Type.String({ description: "reference-eval run id" })),
      selected_mechanism: Type.Optional(Type.String({ description: "Extracted mechanism" })),
      implementation: Type.Optional(Type.String({ description: "Canvast implementation or tested equivalent" })),
      blocker: Type.Optional(Type.String({ description: "Current blocker if any" })),
    }),
    async execute(_id: string, params: any): Promise<any> {
      const action = params.action as string;
      let items = loadItems(file);

      if (action === "init") {
        saveItems(file, items);
        const summary = summarizeClosure(items);
        return {
          content: [{ type: "text" as const, text: `${formatClosureSummary(summary)}\n\nInitialized: ${file}` }],
          details: { path: file, summary },
        };
      }

      if (action === "list") {
        const text = items.map(formatItem).join("\n\n");
        return { content: [{ type: "text" as const, text }], details: { items } };
      }

      if (action === "record") {
        const itemId = String(params.item_id || "");
        const idx = items.findIndex(i => i.id === itemId);
        if (idx < 0) {
          return { isError: true, content: [{ type: "text" as const, text: `Unknown closure item: ${itemId}` }], details: undefined };
        }
        const nextState = (params.state || items[idx].state) as ClosureState;
        try {
          items[idx] = transitionClosureItem(items[idx], nextState, {
            evidence: params.command
              ? {
                  command: String(params.command),
                  status: params.evidence_status || "passed",
                  note: params.note,
                  runId: params.run_id,
                }
              : undefined,
            selectedMechanism: params.selected_mechanism,
            implementation: params.implementation,
            blocker: params.blocker,
          });
        } catch (err: any) {
          return { isError: true, content: [{ type: "text" as const, text: err.message }], details: undefined };
        }
        saveItems(file, items);
        return {
          content: [{ type: "text" as const, text: `Recorded closure update:\n\n${formatItem(items[idx])}` }],
          details: { item: items[idx], summary: summarizeClosure(items) },
        };
      }

      const summary = summarizeClosure(items);
      const text = formatClosureSummary(summary);
      if (action === "assert_closed" && !summary.deliverable) {
        return { isError: true, content: [{ type: "text" as const, text }], details: { summary } };
      }
      return { content: [{ type: "text" as const, text }], details: { summary } };
    },
  });
}
