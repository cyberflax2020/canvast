/**
 * =============================================================================
 * Canvast — Resume Command / Canvast 源文件
 * =============================================================================
 * @file        src/tui/canvast-resume-command.ts
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { readRuntimeStatus, runtimeStatusSummary } from "../harness/runtime-status.js";
import { renderResumeLines } from "./canvast-tui-panels.js";
import type { RuntimeRequestCoordinator } from "./runtime-request-coordinator.js";

interface ResumeCommandOptions {
  agentDir: () => string;
  appendPanel: (title: string, lines: string[]) => void;
}

function isReadyCandidate(candidate: {
  validation: { availability: string };
  disposition: string;
}): boolean {
  return candidate.validation.availability === "ready" &&
    candidate.disposition !== "retired" &&
    candidate.disposition !== "completed";
}

function dispatchedLines(candidateId: string, dispatchId: string): string[] {
  return [
    "",
    `Claimed and dispatched: ${candidateId}`,
    `Dispatch id: ${dispatchId}`,
  ];
}

export function registerCanvastResumeCommand(
  pi: ExtensionAPI,
  requests: RuntimeRequestCoordinator,
  options: ResumeCommandOptions,
): void {
  pi.registerCommand("canvast-resume", {
    description: "Inspect or trigger the shared runtime resume surface.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const candidateId = String(args || "").trim() || undefined;
      const inspected = requests.inspectResumeState(candidateId ? { candidateId } : {});
      const readyCandidates = inspected.snapshot.candidates.filter(isReadyCandidate);
      let panelLines = renderResumeLines(inspected.snapshot);

      if (candidateId) {
        const claimed = requests.claimAndDispatchResume(ctx, candidateId, {
          expectedRevision: inspected.snapshot.revision,
        });
        if (!claimed) {
          ctx.ui.notify(`Resume candidate ${candidateId} is not claimable.`, "warning");
          panelLines = [
            ...panelLines,
            "",
            `Explicit claim rejected for ${candidateId}. Inspect the candidate state and choose a ready candidate.`,
          ];
        } else {
          ctx.ui.notify(`Resume continuation dispatched for ${candidateId}.`, "info");
          panelLines = [...panelLines, ...dispatchedLines(candidateId, claimed.dispatchId)];
        }
      } else if (readyCandidates.length === 0) {
        ctx.ui.notify("No ready runtime resume candidate is available.", "info");
        panelLines = [
          ...panelLines,
          "",
          "No ready candidate to claim.",
          "Use /canvast-resume <candidateId> only after a candidate becomes ready.",
        ];
      } else if (readyCandidates.length === 1) {
        const onlyCandidateId = readyCandidates[0].id;
        const claimed = requests.claimAndDispatchResume(ctx, onlyCandidateId, {
          expectedRevision: inspected.snapshot.revision,
        });
        if (!claimed) {
          ctx.ui.notify(`Resume candidate ${onlyCandidateId} could not be dispatched.`, "warning");
          panelLines = [
            ...panelLines,
            "",
            `Ready candidate ${onlyCandidateId} could not be dispatched.`,
          ];
        } else {
          ctx.ui.notify(`Resume continuation dispatched for ${onlyCandidateId}.`, "info");
          panelLines = [...panelLines, ...dispatchedLines(onlyCandidateId, claimed.dispatchId)];
        }
      } else {
        ctx.ui.notify("Multiple ready resume candidates exist; provide an explicit candidate id.", "warning");
        panelLines = [
          ...panelLines,
          "",
          "Multiple ready candidates are available.",
          "Run /canvast-resume <candidateId> to choose and claim one explicitly.",
        ];
      }

      options.appendPanel("Runtime Resume", panelLines);
      ctx.ui.setStatus("canvast", runtimeStatusSummary(readRuntimeStatus(options.agentDir())));
    },
  });
}
