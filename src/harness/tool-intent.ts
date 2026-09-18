/**
 * =============================================================================
 * Canvast — Tool Intent / Canvast 源文件
 * =============================================================================
 * @file        src/harness/tool-intent.ts
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
/**
 * Small prompt intent helpers for tool-domain inference.
 */

import { hasAny } from "./intent-signals.js";
import { splitShellTokens } from "./sandbox.js";

function isAsciiWordChar(char: string | undefined): boolean {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95;
}

function hasCjkChar(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code >= 0x4e00 && code <= 0x9fff) return true;
  }
  return false;
}

function termPositions(text: string, term: string): number[] {
  const positions: number[] = [];
  let index = text.indexOf(term);
  while (index >= 0) {
    if (hasCjkChar(term) || (
      !isAsciiWordChar(text[index - 1]) &&
      !isAsciiWordChar(text[index + term.length])
    )) {
      positions.push(index);
    }
    index = text.indexOf(term, index + Math.max(1, term.length));
  }
  return positions;
}

function hasOrderedTermsWithin(text: string, firstTerms: string[], secondTerms: string[], maxDistance: number): boolean {
  for (const first of firstTerms) {
    for (const firstPos of termPositions(text, first)) {
      for (const second of secondTerms) {
        for (const secondPos of termPositions(text, second)) {
          if (secondPos >= firstPos && secondPos - firstPos <= maxDistance) return true;
        }
      }
    }
  }
  return false;
}

function stripTokenEdges(value: string): string {
  let start = 0;
  let end = value.length;
  const edgeChars = ".,;:!?()[]{}<>\"'“”‘’`，。；：！？（）【】";
  while (start < end && edgeChars.includes(value[start])) start += 1;
  while (end > start && edgeChars.includes(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

const SOURCE_FILE_EXTENSIONS = [
  "ts", "tsx", "js", "jsx", "json", "md", "txt", "py", "go", "rs",
  "swift", "java", "kt", "sh", "sql", "yml", "yaml", "toml",
];

function hasConcreteSourceToken(normalized: string): boolean {
  if (normalized.includes("src/") || normalized.includes("tests/") || normalized.includes("test/") || normalized.includes("docs/")) {
    return true;
  }
  for (const raw of splitShellTokens(normalized)) {
    const token = stripTokenEdges(raw).toLowerCase();
    if (token === ".env" || token === "readme.md") return true;
    const slash = Math.max(token.lastIndexOf("/"), token.lastIndexOf("\\"));
    const name = slash >= 0 ? token.slice(slash + 1) : token;
    const dot = name.lastIndexOf(".");
    if (dot > 0 && SOURCE_FILE_EXTENSIONS.includes(name.slice(dot + 1))) return true;
  }
  return false;
}

export function needsPackageDomain(normalized: string): boolean {
  const packagingTerms = ["package", "deliver", "ship", "archive", "打包", "交付", "归档"];
  if (hasAny(normalized, packagingTerms)) return true;
  const releaseDocs =
    hasOrderedTermsWithin(normalized, ["release"], ["doc", "docs", "documentation", "note", "notes", "文档", "说明", "日志"], 24) ||
    hasOrderedTermsWithin(normalized, ["发布"], ["文档", "说明", "日志"], 8);
  return !releaseDocs && hasAny(normalized, ["release", "发布"]);
}

export function hasPackageManagerMutation(normalized: string): boolean {
  const tokens = splitShellTokens(normalized).map(token => {
    const lastSlash = Math.max(token.lastIndexOf("/"), token.lastIndexOf("\\"));
    return (lastSlash >= 0 ? token.slice(lastSlash + 1) : token).toLowerCase();
  });
  const next = (index: number): string | undefined => tokens[index + 1];
  const afterNext = (index: number): string | undefined => tokens[index + 2];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (["npm", "pnpm", "yarn", "bun"].includes(token) && ["install", "i", "add", "update", "upgrade"].includes(next(i) || "")) {
      return true;
    }
    if (["pip", "pip3"].includes(token) && ["install", "uninstall"].includes(next(i) || "")) {
      return true;
    }
    if (token === "uv") {
      const sub = next(i);
      if (["add", "remove", "sync"].includes(sub || "")) return true;
      if (sub === "pip" && ["install", "uninstall"].includes(afterNext(i) || "")) return true;
    }
    if (token === "cargo" && ["add", "remove", "update", "install"].includes(next(i) || "")) {
      return true;
    }
    if (token === "go" && ["get", "install"].includes(next(i) || "")) {
      return true;
    }
  }
  return false;
}

export function hasDependencyInstallIntent(normalized: string): boolean {
  // Keep the enforcement boundary syntactic and auditable. Natural-language
  // dependency decisions are made by the agent's recorded strategy; hard policy
  // enforcement happens when a visible package-manager command is about to run.
  return hasPackageManagerMutation(normalized);
}

export function hasConcreteFileMutationTarget(normalized: string): boolean {
  return hasAny(normalized, [
    "write", "edit", "modify", "patch", "delete", "save", "file",
    "readme", "source", "code",
    "文件", "源码", "代码", "写入", "修改", "编辑", "补丁", "删除", "保存",
  ]) || hasConcreteSourceToken(normalized);
}

export function hasConcreteShellExecutionTarget(normalized: string): boolean {
  return hasAny(normalized, [
    "bash", "shell", "command", "cmd", "terminal", "npm", "pnpm",
    "yarn", "node", "npx", "vitest", "pytest", "cargo", "go test",
    "install", "test", "verify", "package", "build",
    "命令", "终端", "脚本", "安装", "测试", "验证", "打包", "构建",
    "运行 npm", "运行脚本", "运行命令", "执行 npm", "执行脚本", "执行命令",
  ]);
}

const TASK_TOOL_TERMS = ["task_create", "task_update", "task_list", "task_get"];
const TASK_STATUS_TERMS = ["pending", "in_progress", "completed", "blocked", "待处理", "进行中", "已完成", "阻塞"];
const TASK_TRACKING_SUBJECT_TERMS = [
  "task tracking",
  "task lifecycle",
  "task status",
  "任务追踪",
  "任务项",
  "任务状态",
  "状态流转",
  "状态变化",
];
const TASK_STATUS_UPDATE_TERMS = ["mark as", "set status", "update status", "标记为", "更新状态", "状态改为"];

export function hasTaskTrackingIntent(normalized: string): boolean {
  const hasTaskTool = hasAny(normalized, TASK_TOOL_TERMS);
  const hasTrackingSubject = hasAny(normalized, TASK_TRACKING_SUBJECT_TERMS);
  const hasExplicitStatus = hasAny(normalized, TASK_STATUS_TERMS);
  const hasStatusUpdateAction = hasAny(normalized, TASK_STATUS_UPDATE_TERMS);
  const hasTaskSubject = hasAny(normalized, ["task", "任务"]);
  return hasTaskTool || hasTrackingSubject || (hasExplicitStatus && (hasStatusUpdateAction || hasTaskSubject));
}

const TASK_TRACKING_ONLY_TERMS = [
  "plan→task",
  "plan->task",
  "plan-task linkage",
  "task tracking",
  "task lifecycle",
  "任务追踪",
  "任务项",
  "任务状态",
  "联动",
];
const NO_FILE_MUTATION_TERMS = [
  "do not modify files",
  "no file changes",
  "不要修改文件",
  "不修改文件",
  "无需修改文件",
  "不要改文件",
];
const NO_SHELL_EXECUTION_TERMS = [
  "do not run shell",
  "no shell",
  "不要执行 shell",
  "不执行 shell",
  "无需执行 shell",
];

export function isPureTaskTrackingIntent(normalized: string): boolean {
  const hasExplicitTaskTool = hasAny(normalized, TASK_TOOL_TERMS);
  return hasTaskTrackingIntent(normalized) &&
    (hasExplicitTaskTool || hasAny(normalized, TASK_TRACKING_ONLY_TERMS)) &&
    hasAny(normalized, NO_FILE_MUTATION_TERMS) &&
    hasAny(normalized, NO_SHELL_EXECUTION_TERMS);
}

const APPROVED_PLAN_TERMS = ["approved plan", "批准计划", "批准该计划", "已批准计划"];
const FIRST_STEP_TERMS = ["first step", "step 1", "step one", "第一步"];
const STEP_EXECUTION_TERMS = ["execute", "implement", "start implementation", "立即实施", "开始实施", "执行", "实施"];
const NO_REPLAN_TERMS = ["no replan", "do not replan", "无需重新规划", "不用重新规划", "不要重新规划", "无需规划"];
const SINGLE_STEP_TERMS = ["only the first step", "only step 1", "只执行第一步", "仅执行第一步", "立即实施第一步", "执行第一步"];
const RECOVERY_SNAPSHOT_TERMS = [
  "recovery snapshot",
  "resume snapshot",
  "session recovery",
  "resume session",
  "恢复快照",
  "会话恢复",
  "模拟会话恢复",
  "中断恢复",
];
const BOUNDED_RECOVERY_STEP_TERMS = [
  "only step",
  "complete only",
  "continue from step",
  "只完成 step",
  "仅完成 step",
  "只完成",
  "仅完成",
  "从 step",
  "从当前 step",
  "从第",
];
const FUTURE_PENDING_TERMS = [
  "remain pending",
  "still pending",
  "仍为 pending",
  "保持 pending",
  "仍待后续",
  "待后续执行",
];

export function hasApprovedPlanStepExecutionIntent(normalized: string): boolean {
  const approvedPlan = hasAny(normalized, APPROVED_PLAN_TERMS);
  const firstStep = hasAny(normalized, FIRST_STEP_TERMS);
  const executesStep = hasAny(normalized, STEP_EXECUTION_TERMS);
  const boundedExecution = hasAny(normalized, NO_REPLAN_TERMS) || hasAny(normalized, SINGLE_STEP_TERMS);
  return approvedPlan && firstStep && executesStep && boundedExecution;
}

export function hasRecoveredPlanStepExecutionIntent(normalized: string): boolean {
  const recoverySnapshot = hasAny(normalized, RECOVERY_SNAPSHOT_TERMS);
  const boundedStep = hasAny(normalized, BOUNDED_RECOVERY_STEP_TERMS);
  const noReplan = hasAny(normalized, NO_REPLAN_TERMS);
  const futurePending = hasAny(normalized, FUTURE_PENDING_TERMS);
  const writesAndVerifies = hasAny(normalized, ["write", "create", "写入", "创建"]) &&
    hasAny(normalized, ["read back", "confirm", "verify", "读回", "确认", "校验"]);
  return recoverySnapshot && boundedStep && noReplan && futurePending && writesAndVerifies;
}

export function hasExplicitPlanModeIntent(normalized: string): boolean {
  return hasAny(normalized, ["plan-mode", "plan mode", "planning mode", "进入计划模式", "计划模式"]);
}

export function isPlanResearchProposalIntent(normalized: string): boolean {
  if (!hasExplicitPlanModeIntent(normalized)) return false;
  const proposalLike =
    hasAny(normalized, [
      "research", "inspect", "study", "propose", "proposal", "plan",
      "planning", "refactor plan", "研究", "调研", "阅读", "重构计划",
      "提案", "方案",
    ]) ||
    hasOrderedTermsWithin(normalized, ["制定"], ["计划"], 16);
  const implementationLike =
    hasAny(normalized, [
      "approve", "approved", "start implementation", "implement", "edit",
      "modify", "write", "create", "fix", "repair", "build", "execute",
      "run", "批准", "开始实施", "立即开始", "执行第一步", "实施",
      "修改", "写入", "创建", "修复", "构建", "运行", "执行",
    ]);
  return proposalLike && !implementationLike;
}

export function isPlanProposalIntent(normalized: string): boolean {
  if (isPlanResearchProposalIntent(normalized)) return true;
  const proposalAction =
    hasAny(normalized, [
      "re-propose", "re propose", "propose plan", "propose a plan",
      "revise plan", "revise the plan", "update plan", "update the plan",
      "amend plan", "amend the plan", "adjust plan", "adjust the plan",
      "重新 propose plan", "修订计划", "修订方案", "修改计划", "修改方案",
      "调整计划", "调整方案", "更新计划", "更新方案",
    ]) ||
    hasOrderedTermsWithin(normalized, ["重新"], ["提交", "制定", "提出", "生成", "计划", "方案"], 24);
  const approvalBoundary =
    hasAny(normalized, [
      "wait for approval", "await for approval", "await approval",
      "do not modify", "do not edit", "do not write", "do not run shell",
      "do not execute shell", "等待审批", "等待批准", "不要修改", "不修改",
      "不要执行 shell", "不要执行shell", "不执行 shell", "不执行shell",
    ]);
  return proposalAction && approvalBoundary;
}

export function isSimpleWriteVerification(input: {
  normalized: string;
  planCount: number;
  complexityCount: number;
  subagentCount: number;
  workflowCount: number;
  listShape: boolean;
  longPrompt: boolean;
  readOnlyIntent: boolean;
  planOnlyIntent: boolean;
  localScanLike: boolean;
  requiresTaskAdjustment: boolean;
  taskControlLike: boolean;
}): boolean {
  const hasWrite = hasAny(input.normalized, ["write", "create", "save", "file", "创建", "写入", "保存", "文件"]);
  const hasVerify = hasAny(input.normalized, ["read", "verify", "check", "confirm", "validate", "读取", "验证", "确认", "检查", "校验"]);
  const hasConcreteFileOutput = hasConcreteFileMutationTarget(input.normalized);
  const approvedPlanStepExecution = hasApprovedPlanStepExecutionIntent(input.normalized);
  const recoveredPlanStepExecution = hasRecoveredPlanStepExecutionIntent(input.normalized);
  const boundedExistingPlanStep = approvedPlanStepExecution || recoveredPlanStepExecution;
  const structuredEvidenceContract =
    input.normalized.includes("canvast_") &&
    input.normalized.includes("_evidence");
  if (
    input.readOnlyIntent ||
    input.planOnlyIntent ||
    input.requiresTaskAdjustment ||
    (input.taskControlLike && !(hasWrite && hasVerify && hasConcreteFileOutput)) ||
    input.subagentCount > 0 ||
    input.workflowCount > 0 ||
    (input.listShape && !boundedExistingPlanStep && !structuredEvidenceContract) ||
    (input.longPrompt && !boundedExistingPlanStep && !structuredEvidenceContract) ||
    (input.complexityCount > 0 && !boundedExistingPlanStep) ||
    (input.planCount > 3 && !boundedExistingPlanStep)
  ) {
    return false;
  }
  return hasWrite && hasVerify && hasConcreteFileOutput;
}
