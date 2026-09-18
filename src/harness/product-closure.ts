/**
 * =============================================================================
 * Canvast — Product Closure / Canvast 源文件
 * =============================================================================
 * @file        src/harness/product-closure.ts
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */


export type ClosureState = "pending" | "ran" | "gap" | "implemented" | "closed";
export type ClosureKind =
  | "reference"
  | "parity"
  | "enhanced"
  | "safety"
  | "verification";

export interface ClosureEvidence {
  command: string;
  status: "passed" | "failed" | "blocked";
  note?: string;
  runId?: string;
  recordedAt: string;
}

export interface ClosureItem {
  id: string;
  title: string;
  kind: ClosureKind;
  required: boolean;
  source?: string;
  state: ClosureState;
  selectedMechanism?: string;
  implementation?: string;
  evidence: ClosureEvidence[];
  blockers: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ClosureSummary {
  total: number;
  required: number;
  closedRequired: number;
  openRequired: number;
  deliverable: boolean;
  openItems: ClosureItem[];
}

export const STATE_ORDER: Record<ClosureState, number> = {
  pending: 0,
  ran: 1,
  gap: 2,
  implemented: 3,
  closed: 4,
};

const REFERENCE_PROJECTS: Array<{ id: string; title: string; source: string }> = [
  { id: "ref-reference-harness", title: "Reference harness behavior baseline", source: "reference-harness" },
  { id: "ref-aider", title: "aider repo-map and dry-run workflow", source: "aider-chat" },
  { id: "ref-opencode", title: "opencode headless JSON run", source: "opencode-ai" },
  { id: "ref-goose", title: "goose session and bounded run", source: "aaif-goose/goose" },
  { id: "ref-codex", title: "Codex CLI sandbox and exec protocol", source: "@openai/codex" },
  { id: "ref-cc-sdd", title: "cc-sdd spec decomposition loop", source: "cc-sdd" },
  { id: "ref-oh-my-codex", title: "oh-my-codex durable goals and fanout control", source: "oh-my-codex" },
  { id: "ref-codeman", title: "Codeman plan/session state machine", source: "aicodeman" },
  { id: "ref-symphony", title: "Symphony issue-to-workspace orchestration", source: "openai/symphony" },
];

const PRODUCT_GATES: Array<{ id: string; title: string; kind: ClosureKind }> = [
  { id: "gate-parity", title: "Baseline compatibility suite matches measured reference behavior", kind: "parity" },
  { id: "gate-enhanced", title: "Enhanced mode outperforms baseline on accepted tasks", kind: "enhanced" },
  { id: "gate-safety", title: "Resource safety gates prevent CPU and memory incidents", kind: "safety" },
  { id: "gate-auto-orchestration", title: "Automatic plan, sub-agent, and workflow trigger behavior is enforced", kind: "parity" },
  { id: "gate-tool-coordination", title: "Autonomous multi-tool coordination matches measured reference behavior", kind: "parity" },
  { id: "gate-web-policy", title: "Web tools are used only with concrete external evidence justification and produce cited research", kind: "parity" },
  { id: "gate-tui", title: "Modern Canvast TUI exposes Canvas visualization, task tree, sub-agent, workflow, and all feature entries", kind: "enhanced" },
  { id: "gate-macos-app", title: "macOS app exposes every Canvast control plane with native-grade UX", kind: "enhanced" },
  { id: "gate-business-alignment", title: "Real business scenario gap loop is closed before packaging", kind: "verification" },
  { id: "gate-package", title: "Clean product package is installable and retestable", kind: "verification" },
];

export const REQUIRED_CLOSURE_ITEM_IDS = [
  ...REFERENCE_PROJECTS.map(item => item.id),
  ...PRODUCT_GATES.map(item => item.id),
];

export function canonicalClosureItemId(id: string): string {
  return id;
}

export function createDefaultClosureItems(now = new Date().toISOString()): ClosureItem[] {
  const refs = REFERENCE_PROJECTS.map((p): ClosureItem => ({
    id: p.id,
    title: p.title,
    kind: "reference",
    required: true,
    source: p.source,
    state: "pending",
    evidence: [],
    blockers: [],
    createdAt: now,
    updatedAt: now,
  }));
  const gates = PRODUCT_GATES.map((g): ClosureItem => ({
    id: g.id,
    title: g.title,
    kind: g.kind,
    required: true,
    state: "pending",
    evidence: [],
    blockers: [],
    createdAt: now,
    updatedAt: now,
  }));
  return [...refs, ...gates];
}

export function normalizeClosureItem(input: ClosureItem): ClosureItem {
  const now = new Date().toISOString();
  const canonicalId = canonicalClosureItemId(input.id);
  const defaultItem = createDefaultClosureItems(now).find(item => item.id === canonicalId);
  return {
    ...input,
    id: canonicalId,
    title: defaultItem?.title || input.title,
    source: defaultItem?.source || input.source,
    kind: defaultItem?.kind || input.kind,
    required: input.required !== false,
    state: input.state ?? "pending",
    evidence: Array.isArray(input.evidence) ? input.evidence : [],
    blockers: Array.isArray(input.blockers) ? input.blockers : [],
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now,
  };
}

export function canTransition(from: ClosureState, to: ClosureState): boolean {
  if (from === to) return true;
  if (to === "gap") return true;
  if (from === "closed" && to !== "closed") return false;
  return STATE_ORDER[to] >= STATE_ORDER[from];
}

export function transitionClosureItem(
  item: ClosureItem,
  nextState: ClosureState,
  options: {
    evidence?: Omit<ClosureEvidence, "recordedAt">;
    blocker?: string;
    selectedMechanism?: string;
    implementation?: string;
    now?: string;
  } = {},
): ClosureItem {
  if (!canTransition(item.state, nextState)) {
    throw new Error(`Invalid closure transition: ${item.state} -> ${nextState}`);
  }
  if (nextState === "closed") {
    const hasPassedEvidence =
      item.evidence.some(e => e.status === "passed") ||
      options.evidence?.status === "passed";
    const hasImplementation = Boolean(options.implementation || item.implementation);
    if (!hasPassedEvidence) {
      throw new Error(`Cannot close ${item.id}: passed evidence is required`);
    }
    if (!hasImplementation) {
      throw new Error(`Cannot close ${item.id}: implementation or superseding equivalent is required`);
    }
  }

  const now = options.now || new Date().toISOString();
  const evidence = [...item.evidence];
  if (options.evidence) {
    evidence.push({ ...options.evidence, recordedAt: now });
  }
  const blockers = [...item.blockers];
  if (options.blocker && !blockers.includes(options.blocker)) blockers.push(options.blocker);

  return {
    ...item,
    state: nextState,
    evidence,
    blockers: nextState === "closed" ? [] : blockers,
    selectedMechanism: options.selectedMechanism ?? item.selectedMechanism,
    implementation: options.implementation ?? item.implementation,
    updatedAt: now,
  };
}

export function summarizeClosure(items: ClosureItem[]): ClosureSummary {
  const required = items.filter(i => i.required);
  const openItems = required.filter(i => i.state !== "closed");
  return {
    total: items.length,
    required: required.length,
    closedRequired: required.length - openItems.length,
    openRequired: openItems.length,
    deliverable: openItems.length === 0,
    openItems,
  };
}

export function formatClosureSummary(summary: ClosureSummary): string {
  const header = [
    "# Canvast Product Closure Gate",
    `Deliverable: ${summary.deliverable ? "YES" : "NO"}`,
    `Required closed: ${summary.closedRequired}/${summary.required}`,
  ];
  if (summary.deliverable) return header.join("\n");
  const open = summary.openItems
    .map(i => `- [${i.state}] ${i.id}: ${i.title}${i.blockers.length ? ` (blocked: ${i.blockers.join("; ")})` : ""}`)
    .join("\n");
  return `${header.join("\n")}\n\nOpen required items:\n${open}`;
}
