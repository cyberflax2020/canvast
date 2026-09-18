/**
 * =============================================================================
 * Canvast — Harness: Plan Constraints / 计划约束
 * =============================================================================
 * @file        src/harness/plan-constraints.ts
 * @brief       Enforces Plan scope boundaries on file operations
 * @description Hooks into tool_call events to check Write/Edit/Bash operations
 *              against the active Plan's scope. Out-of-scope operations are
 *              blocked or require Plan amendment. All decisions logged to Canvas.
 *              挂钩 tool_call 事件，检查操作是否在 Plan scope 内。
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * Changes: [2026-08-08] Initial implementation
 * =============================================================================
 */

import type { CanvasStore } from "../graph/canvas-store.js";
import type { PlanNode } from "../graph/types.js";

export interface ScopeCheckResult {
  allowed: boolean;
  reason?: string;
  requiresAmendment?: boolean;
  canvasNodeId?: string; // linked Plan or Decision node
}

/**
 * Check if a file operation is within the active Plan's scope.
 */
export function checkPlanScope(
  store: CanvasStore,
  activePlanId: string | undefined,
  operation: { tool: string; filePath?: string; command?: string },
): ScopeCheckResult {
  // No active plan → no constraints (free mode)
  if (!activePlanId) {
    return { allowed: true };
  }

  const plan = store.getNode<PlanNode>(activePlanId);
  if (!plan || plan.properties.status !== "approved") {
    return { allowed: true }; // plan not active
  }

  const scope = plan.properties.scope;
  const { tool, filePath, command } = operation;

  // Read-only tools: always allowed during planning
  if (["read", "grep", "find", "ls"].includes(tool)) {
    return { allowed: true };
  }

  // Write/Edit: check file path against scope
  if (["write", "edit", "notebook_edit"].includes(tool) && filePath) {
    const inScope = scope.files.some(
      f => filePath.startsWith(f.replace(/\/\*$/, "")) || filePath === f,
    );

    if (inScope) {
      return { allowed: true, canvasNodeId: activePlanId };
    }

    return {
      allowed: false,
      reason: `File "${filePath}" is outside the active Plan scope (${scope.files.join(", ")}). Amend the Plan to include this file, or use enter_plan_mode to update scope. 文件 "${filePath}" 不在当前 Plan 范围内。请修改 Plan 以包含此文件。`,
      requiresAmendment: true,
      canvasNodeId: activePlanId,
    };
  }

  // Bash: check against plan constraints
  if (tool === "bash" && command) {
    // Block destructive commands regardless of scope
    const destructive = [
      /rm\s+-rf/, /sudo\s/, /chmod\s+777/, />\s*\/dev\//, /mkfs\./,
      /git\s+push\s+--force/, /git\s+push\s+-f/,
      /npm\s+unpublish/, /docker\s+rm/,
    ];
    for (const pattern of destructive) {
      if (pattern.test(command)) {
        return {
          allowed: false,
          reason: `Destructive command blocked by Plan Constraints: "${command}". 危险命令被 Plan Constraints 拦截。`,
        };
      }
    }

    // File-creating bash: check paths against scope
    const fileOps = command.match(/(?:cp|mv|touch|mkdir)\s+(\S+)/g);
    if (fileOps && !scope.allowCreate) {
      return {
        allowed: false,
        reason: "Plan does not allow creating new files. Amend the Plan if file creation is needed. Plan 不允许创建新文件。",
        requiresAmendment: true,
        canvasNodeId: activePlanId,
      };
    }
  }

  // Default: allow (non-file-mutating operations)
  return { allowed: true };
}

/**
 * Generate a Plan amendment suggestion when scope is violated.
 */
export function suggestAmendment(
  plan: PlanNode,
  requestedFile: string,
): string {
  const lines = [
    `## Plan Amendment Suggestion / Plan 修改建议`,
    ``,
    `**Current Scope / 当前范围**: ${plan.properties.scope.files.join(", ")}`,
    `**Requested / 请求添加**: \`${requestedFile}\``,
    ``,
    `To add this file to the Plan scope, update the Plan node in Canvas:`,
    `\`\`\``,
    `canvas.updateNode("${plan.id}", {`,
    `  scope: { files: [...currentFiles, "${requestedFile}"] }`,
    `});`,
    `\`\`\``,
  ];
  return lines.join("\n");
}
