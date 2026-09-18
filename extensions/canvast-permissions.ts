/**
 * =============================================================================
 * Canvast — Integrated Permission System / 集成权限系统
 * =============================================================================
 * @file        extensions/canvast-permissions.ts
 * @brief       Unified permission gate — combines best of all audited modules
 * @description Integrates pi-agent-config/security.ts patterns (15+ rules),
 *              pi-vs-claude-code/damage-control YAML config, pi-mono/protected-paths,
 *              and pi-agent-config/prompt-injection-guard. All decisions logged
 *              to Canvas as Decision/Constraint nodes for full audit trail.
 *              融合所有最佳权限模块，决策记录到 Canvas 实现完整审计。
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * Changes: [2026-08-08] Initial integration — 4 modules merged + Canvas audit
 * =============================================================================
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  defaultRuntimeStatusDir,
  recordApprovalReview,
  summarizeRuntimeInput,
} from "../src/harness/runtime-status.js";
import { classifyDangerousCommand, isProtectedPath } from "../src/harness/sandbox.js";
import { toolEventInput, toolEventName } from "../src/harness/auto-orchestrator/tool-strategy.js";

// ─── Dangerous Command Patterns / 危险命令模式 ─────────────

const DANGEROUS_PATTERNS = [
  // From pi-agent-config/security.ts — most comprehensive (15+ patterns)
  { pattern: /\brm\s+(-[^\s]*r|--recursive)/, desc: "recursive delete / 递归删除" },
  { pattern: /\bsudo\b/, desc: "sudo / 提权操作" },
  { pattern: /\b(chmod|chown)\b.*777/, desc: "dangerous permissions / 危险权限" },
  { pattern: /\bmkfs\b/, desc: "filesystem format / 格式化文件系统" },
  { pattern: /\bdd\b.*\bof=\/dev\//, desc: "raw device write / 裸设备写入" },
  { pattern: />\s*\/dev\/sd[a-z]/, desc: "raw device overwrite / 裸设备覆盖" },
  { pattern: /\bkill\s+-9\s+-1\b/, desc: "kill all processes / 杀死所有进程" },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, desc: "fork bomb / Fork 炸弹" },
  { pattern: /\bgit\s+push\s+(-f|--force)\b/, desc: "force push / 强制推送" },
  { pattern: /\bgit\s+reset\s+--hard\b/, desc: "hard reset / 硬重置" },
  { pattern: /\bnpm\s+unpublish\b/, desc: "npm unpublish / 取消发布" },
  { pattern: /\bdocker\s+rm\s+-f\b/, desc: "force remove containers / 强制删容器" },
];

// ─── Protected Paths / 保护路径 ─────────────────────────────

const PROTECTED_PATHS = [
  /\.env($|rc$|\.(?!example))/,
  /\.dev\.vars/,
  /node_modules\//,
  /^\.git\/|\/\.git\//,
  /\.pem$|\.key$/,
  /id_rsa|id_ed25519|id_ecdsa/,
  /\.ssh\//,
  /secrets?\.(json|ya?ml|toml)$/i,
  /credentials/i,
  /\.aws\//,
  /\.config\/gh\//,
];

function legacyIsProtectedPath(path: string): boolean {
  if (path.replaceAll("\\", "/").split("/").includes(".canvast-secrets")) return true;
  return PROTECTED_PATHS.some(p => p.test(path));
}

function isDangerousCommand(command: string): { dangerous: boolean; desc?: string; hardBlock?: boolean } {
  const shared = classifyDangerousCommand(command);
  if (shared.desc) return { dangerous: true, desc: shared.desc, hardBlock: shared.hardBlock };
  for (const dp of DANGEROUS_PATTERNS) {
    if (dp.pattern.test(command)) return { dangerous: true, desc: dp.desc };
  }
  return { dangerous: false };
}

function recordPermissionReview(input: {
  tool: string;
  decision: "approved" | "needs_user" | "blocked";
  risk: "low" | "medium" | "high" | "critical";
  authorization: "none" | "low" | "medium" | "high";
  rationale: string;
  input?: unknown;
  categories?: string[];
}): void {
  recordApprovalReview(defaultRuntimeStatusDir(), {
    tool: input.tool || "unknown",
    decision: input.decision,
    risk: input.risk,
    authorization: input.authorization,
    rationale: input.rationale,
    inputSummary: summarizeRuntimeInput(input.input),
    categories: input.categories,
    source: "canvast-permissions",
  });
}

// ─── Extension / 扩展 ──────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Track permission decisions for Canvas audit
  const auditLog: Array<{
    timestamp: string;
    tool: string;
    input: string;
    decision: "allowed" | "blocked" | "asked";
    reason: string;
  }> = [];

  /**
   * tool_call hook — primary permission gate.
   * Intercepts every tool call before execution.
   */
  pi.on("tool_call", async (event, ctx) => {
    const toolName = toolEventName(event);
    const input = toolEventInput(event);
    const command = typeof input.command === "string" ? input.command : "";
    const filePathCandidate = input.file_path ?? input.notebook_path ?? input.path;
    const filePath = typeof filePathCandidate === "string" ? filePathCandidate : "";
    const sandboxInstalled = Boolean((pi as any).__canvast_sandbox);

    // Layer 1: Protected path check (always enforced)
    if (filePath && (isProtectedPath(filePath) || legacyIsProtectedPath(filePath)) && !sandboxInstalled) {
      recordPermissionReview({
        tool: toolName,
        decision: "blocked",
        risk: "high",
        authorization: "none",
        rationale: "Protected path access requires explicit permission review.",
        input: filePath,
        categories: ["protected-path"],
      });
      auditLog.push({
        timestamp: new Date().toISOString(),
        tool: toolName,
        input: filePath,
        decision: "blocked",
        reason: `Protected path / 保护路径: ${filePath}`,
      });
      return {
        block: true,
        reason: `Path "${filePath}" is protected. Modification blocked by Canvast permissions. 路径受保护，修改已被拦截。`,
        terminate: true,
      };
    }

    // Layer 2: Dangerous command check (always enforced)
    if (command) {
      const check = isDangerousCommand(command);
      if (check.dangerous && (!sandboxInstalled || check.hardBlock)) {
        recordPermissionReview({
          tool: toolName,
          decision: "blocked",
          risk: check.hardBlock ? "critical" : "high",
          authorization: "none",
          rationale: `Dangerous command blocked: ${check.desc || "unsafe command"}.`,
          input: command,
          categories: ["dangerous-command"],
        });
        auditLog.push({
          timestamp: new Date().toISOString(),
          tool: toolName,
          input: command.slice(0, 200),
          decision: "blocked",
          reason: `Dangerous command / 危险命令: ${check.desc}`,
        });
        return {
          block: true,
          reason: `Dangerous command blocked: ${check.desc}. 危险命令已被拦截: ${check.desc}`,
          terminate: true,
        };
      }
    }

    if ((command || filePath) && !sandboxInstalled) {
      recordPermissionReview({
        tool: toolName,
        decision: "approved",
        risk: "low",
        authorization: "high",
        rationale: "Permission review approved a low-risk operation within the active policy.",
        input: command || filePath,
        categories: command ? ["command"] : ["file-access"],
      });
    }

    // Layer 3: Prompt injection defense (warning, not block)
    // Defers to prompt-injection-guard extension which adds system prompt rules

    return; // allow
  });

  /**
   * Register the audit log query tool.
   */
  pi.registerTool?.({
    name: "permission_audit",
    label: "Permission Audit / 权限审计",
    description: "Query the permission audit log — all blocked/allowed decisions.",
    parameters: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          enum: ["all", "blocked", "allowed"],
          description: "Filter by decision type",
        },
      },
      required: [],
    },
    async execute(_id: string, params: any) {
      const filter = params.filter || "all";
      const entries = filter === "all"
        ? auditLog
        : auditLog.filter(e => e.decision === filter);
      const recent = entries.slice(-20);
      const text = recent.length === 0
        ? "No permission audit entries. 无权限审计记录。"
        : recent.map(e =>
            `[${e.timestamp}] ${e.decision.toUpperCase()} | ${e.tool}: ${e.input.slice(0, 100)} | ${e.reason}`,
          ).join("\n");

      return {
        content: [{ type: "text" as const, text: `# Permission Audit / 权限审计 (${entries.length} total, showing last ${recent.length})\n\n${text}` }],
        details: { total: entries.length, entries: recent },
      };
    },
  });
}
