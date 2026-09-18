/**
 * =============================================================================
 * Canvast — Ask User Question / 结构化用户提问
 * =============================================================================
 * @file        extensions/ask-user.ts
 * @brief       Structured multi-choice questions
 * @description Adapted from pi-agent-config/questionnaire.ts (MIT).
 *              Allows the agent to ask the user structured questions with options.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * Changes: [2026-08-08] Initial — from pi-agent-config questionnaire.ts (MIT)
 * =============================================================================
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User / 询问用户",
    description: `Ask the user one or more structured questions when clarification is needed.
Each question can have multiple choice options, support multi-select, and include previews.
Use when: task is ambiguous, multiple valid approaches exist, or user preference matters.`,
    parameters: Type.Object({
      questions: Type.Array(Type.Object({
        question: Type.String({ description: "The question to ask" }),
        header: Type.String({ description: "Short label (max 12 chars)" }),
        options: Type.Array(Type.Object({
          label: Type.String({ description: "Option display text" }),
          description: Type.String({ description: "What this option means" }),
        })),
        multiSelect: Type.Optional(Type.Boolean({ description: "Allow multiple selections" })),
      })),
    }),
    async execute(_id: string, params: any) {
      const { questions } = params;

      // In TUI mode, this would render interactive widgets.
      // In print/non-interactive mode, present the questions and use defaults.
      const formatted = questions.map((q: any, qi: number) => {
        const opts = q.options.map((o: any, oi: number) =>
          `  ${oi + 1}. **${o.label}** — ${o.description}`,
        ).join("\n");
        const multi = q.multiSelect ? " (multi-select / 多选)" : "";
        return `### Q${qi + 1}: ${q.question}${multi}\n${opts}`;
      }).join("\n\n");
      const visibleFallbackText = [
        "我需要你确认下面的选项；如果界面没有渲染交互选择器，请直接按编号回复：",
        "",
        formatted,
        "",
        "例如：`Q1: 2` 或 `Q1: 1,3`。",
      ].join("\n");

      return {
        content: [{
          type: "text" as const,
          text: [
            "## Questions / 需要确认",
            "",
            formatted,
            "",
            "---",
            "Visible restatement required: if the native chooser is not visibly rendered to the user, restate every question and option in the next user-visible assistant message before waiting for an answer.",
            "Please respond with your choices (e.g., \"Q1: 2, Q2: 1,3\"). 请回复你的选择。",
          ].join("\n"),
        }],
        details: {
          questionCount: questions.length,
          requiresVisibleRestatement: true,
          visibleFallbackText,
          questions,
        },
      };
    },
  });
}
