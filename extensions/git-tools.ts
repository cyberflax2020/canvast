/**
 * =============================================================================
 * Canvast — Git Tools / Git 工具集
 * =============================================================================
 * @file        extensions/git-tools.ts
 * @brief       Git checkpoint, auto-commit, merge — safe git workflows
 * @description Adapted from pi-mono/git-checkpoint.ts + git-merge-and-resolve.ts
 *              + auto-commit-on-exit.ts (all MIT). Provides safe git operations
 *              with Canvas Decision recording.
 *              从 pi-mono 三个 git 扩展 (MIT) 整合的 Git 工作流工具。
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * Changes: [2026-08-08] Initial — from pi-mono git-*.ts (MIT)
 * =============================================================================
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  createSecureGitExecutor,
  secureGitFailureDetails,
} from "./secure-git.js";

const CHECKPOINT_MESSAGE_MAX_LENGTH = 200;
const CHECKPOINT_SCOPE_MAX_LENGTH = 64;
const CHECKPOINT_SCOPE_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$";

function validateCheckpointMessage(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= CHECKPOINT_MESSAGE_MAX_LENGTH
    && value.trim().length > 0
    && !value.includes("\0")
    && !value.includes("\r")
    && !value.includes("\n");
}

function isAsciiLetterOrDigit(character: string): boolean {
  const code = character.charCodeAt(0);
  return (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122);
}

function validateCheckpointScope(value: unknown): value is string {
  if (typeof value !== "string"
    || value.length === 0
    || value.length > CHECKPOINT_SCOPE_MAX_LENGTH
    || !isAsciiLetterOrDigit(value[0])) {
    return false;
  }
  return [...value].every((character) =>
    isAsciiLetterOrDigit(character) || "._/-".includes(character));
}

export default function (pi: ExtensionAPI) {
  let secureGit: ReturnType<typeof createSecureGitExecutor> | undefined;
  const git = () => secureGit ??= createSecureGitExecutor();

  // ─── git_checkpoint ─────────────────────────────────
  pi.registerTool({
    name: "git_checkpoint",
    label: "Git Checkpoint / Git检查点",
    description: `Create a git commit as a checkpoint before making significant changes.
This allows rollback if the changes don't work out. Uses Conventional Commits format.
Adapted from pi-mono/git-checkpoint.ts (MIT).`,
    parameters: Type.Object({
      message: Type.String({
        description: "Checkpoint description / 检查点描述",
        minLength: 1,
        maxLength: CHECKPOINT_MESSAGE_MAX_LENGTH,
        pattern: "^(?=.*\\S)[^\\u0000\\r\\n]+$",
      }),
      scope: Type.Optional(Type.String({
        description: "Scope (e.g., auth, ui) / 范围",
        minLength: 1,
        maxLength: CHECKPOINT_SCOPE_MAX_LENGTH,
        pattern: CHECKPOINT_SCOPE_PATTERN,
      })),
    }),
    async execute(_id: string, params: any) {
      const message = params?.message;
      const scope = params?.scope === undefined ? "canvast" : params.scope;
      if (!validateCheckpointMessage(message)) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: "Invalid checkpoint message: expected a non-empty single-line string of at most 200 characters." }],
          details: undefined,
        };
      }
      if (!validateCheckpointScope(scope)) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: "Invalid checkpoint scope: expected 1-64 characters using letters, digits, '.', '_', '/', or '-'." }],
          details: undefined,
        };
      }
      try {
        git().run(["add", "-A"], { mutates: true });
        const commitMsg = `checkpoint(${scope}): ${message}`;
        const commitResult = git().run(
          ["commit", "-m", commitMsg, "--allow-empty", "--no-verify"],
          { mutates: true },
        ).stdout;
        return {
          content: [{ type: "text" as const, text: `✅ Checkpoint created: "${commitMsg}"\n${commitResult.slice(0, 200)}` }],
          details: { message: commitMsg },
        };
      } catch (err: any) {
        const failure = secureGitFailureDetails(err);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Git checkpoint failed: ${failure.message}. Check if git is available and there are changes to commit.` }],
          details: failure,
        };
      }
    },
  });

  // ─── git_status ────────────────────────────────────
  pi.registerTool({
    name: "git_status",
    label: "Git Status / Git状态",
    description: "Show current git status — branch, changes, untracked files.",
    parameters: Type.Object({}),
    async execute() {
      try {
        const branch = git().run(["branch", "--show-current"]).stdout.trim();
        const status = git().run(["status", "--short"]).stdout;
        const log = git().run(["log", "--oneline", "-5", "--no-ext-diff", "--no-textconv"]).stdout;
        return {
          content: [{
            type: "text" as const,
            text: `# Git Status / Git状态\n**Branch / 分支**: ${branch}\n\n## Recent Commits / 最近提交\n\`\`\`\n${log}\`\`\`\n\n## Changes / 变更\n\`\`\`\n${status || "(clean / 干净)"}\n\`\`\``,
          }],
          details: { branch },
        };
      } catch (err: any) {
        const failure = secureGitFailureDetails(err);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Git status failed: ${failure.message}` }],
          details: { branch: "", ...failure },
        };
      }
    },
  });
}
