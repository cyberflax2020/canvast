/**
 * =============================================================================
 * Canvast — Worktree Isolation / Git工作树隔离
 * =============================================================================
 * @file        extensions/worktree.ts
 * @brief       Git worktree create/enter/exit for sub-agent isolation
 * @description Adapted from Tallow/worktree (MIT) and pi-agent-config worktree skill (MIT).
 *              Creates isolated git worktrees for parallel or experimental work.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * Changes: [2026-08-08] Initial — from Tallow/worktree + pi-agent-config
 * =============================================================================
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { join } from "path";
import {
  createSecureGitExecutor,
  secureGitFailureDetails,
} from "./secure-git.js";

const WORKTREE_ROOT = ".canvast-worktrees";

function validateName(name: string): string | undefined {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    return "Worktree name may contain only letters, numbers, dot, underscore, and hyphen.";
  }
  if (name === "." || name === ".." || name.includes("..")) {
    return "Worktree name must not traverse directories.";
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  let secureGit: ReturnType<typeof createSecureGitExecutor> | undefined;
  const git = () => secureGit ??= createSecureGitExecutor();

  pi.registerTool({
    name: "enter_worktree",
    label: "Enter Worktree / 进入工作树",
    description: `Create and enter an isolated git worktree for safe experimentation.
Changes in the worktree don't affect the main working directory.`,
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Worktree name / 工作树名称" })),
      base_branch: Type.Optional(Type.String({ description: "Base branch (default: current) / 基准分支" })),
    }),
    async execute(_id: string, params: any) {
      const name = params.name || `canvast-wt-${Date.now().toString(36)}`;
      const base = params.base_branch;
      const invalid = validateName(name);
      if (invalid) {
        return { isError: true, content: [{ type: "text" as const, text: invalid }], details: undefined };
      }
      const wtRelPath = join(WORKTREE_ROOT, name);

      try {
        const wtPath = join(process.cwd(), wtRelPath);
        git().assertWritePath(wtPath);
        git().run(base
          ? ["worktree", "add", "--", wtRelPath, base]
          : ["worktree", "add", "--", wtRelPath, "HEAD"], {
          mutates: true,
          writePaths: [wtPath],
        });
        return {
          content: [{ type: "text" as const, text: `✅ Worktree created: **${name}**\nPath: ${wtRelPath}\nBased on: ${base || "current HEAD"}\n\nUse enter_worktree/list_worktrees for isolated worktree management.` }],
          details: { name, path: wtRelPath, baseBranch: base || "HEAD" },
        };
      } catch (err: any) {
        const failure = secureGitFailureDetails(err);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Worktree creation failed: ${failure.message}` }],
          details: failure as any,
        };
      }
    },
  });

  pi.registerTool({
    name: "exit_worktree",
    label: "Exit Worktree / 退出工作树",
    description: "Remove a git worktree and clean up.",
    parameters: Type.Object({
      name: Type.String({ description: "Worktree name to remove" }),
      discard_changes: Type.Optional(Type.Boolean({ description: "Force remove even with changes", default: false })),
    }),
    async execute(_id: string, params: any) {
      const invalid = validateName(params.name);
      if (invalid) {
        return { isError: true, content: [{ type: "text" as const, text: invalid }], details: undefined };
      }
      const wtRelPath = join(WORKTREE_ROOT, params.name);
      try {
        const args = ["worktree", "remove"];
        if (params.discard_changes) args.push("--force");
        args.push("--", wtRelPath);
        git().run(args, {
          mutates: true,
          writePaths: [join(process.cwd(), wtRelPath)],
          additionalRepositoryRoots: [join(process.cwd(), wtRelPath)],
        });
        return { content: [{ type: "text" as const, text: `✅ Worktree **${params.name}** removed.` }], details: undefined };
      } catch (err: any) {
        const failure = secureGitFailureDetails(err);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Worktree removal failed: ${failure.message}${params.discard_changes ? "" : ". Use discard_changes=true to force."}` }],
          details: failure as any,
        };
      }
    },
  });

  pi.registerTool({
    name: "list_worktrees",
    label: "List Worktrees / 工作树列表",
    description: "List all git worktrees.",
    parameters: Type.Object({}),
    async execute() {
      try {
        const output = git().run(["worktree", "list"]).stdout;
        return { content: [{ type: "text" as const, text: `# Git Worktrees\n\`\`\`\n${output}\`\`\`` }], details: undefined };
      } catch (err: any) {
        const failure = secureGitFailureDetails(err);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Failed: ${failure.message}` }],
          details: failure as any,
        };
      }
    },
  });
}
