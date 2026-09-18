/**
 * =============================================================================
 * Canvast — Intent Signals / Canvast 源文件
 * =============================================================================
 * @file        src/harness/intent-signals.ts
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */


import * as chrono from "chrono-node";
import {
  classifyFollowUp,
  classifyWebUse,
  needsPackageDomain,
} from "./intent-signals/classifiers.js";
import {
  countAnyOf,
  countNonEmptyLines,
  countPlainOccurrences,
  countTerms,
  detectExplicitExternalResources,
  hasAny,
  hasAnyChar,
  hasLatinLetter,
  hasOrderedTermsWithin,
  hasTerm,
  hasTermsWithin,
  isAbsolutePathToken,
  isAsciiWordChar,
  isLocalFileToken,
  isLocalPathToken,
  isWhitespaceChar,
  mapDelimitedTokens,
  mergeHits,
  removeWhitespace,
  replacePlainTerm,
  replaceTerm,
  startsWithAny,
  termPositions,
} from "./intent-signals/text.js";
import type {
  FollowUpPolicy,
  IntentSignals,
  TermHits,
  WebUsePolicy,
} from "./intent-signals/types.js";
import { detectExternalEvidenceContract } from "./web-policy.js";

export { countTerms, hasAny, needsPackageDomain };
export type { FollowUpPolicy, IntentSignals, TermHits, WebUsePolicy };

export const PLAN_TERMS = [
  "implement", "build", "create", "modify", "edit", "fix", "repair",
  "refactor", "integrate", "package", "deliver", "ship", "optimize",
  "architecture", "design", "migrate", "test", "verify",
  "实现", "构建", "创建", "修改", "修复", "重构", "集成", "打包",
  "交付", "优化", "架构", "设计", "迁移", "测试", "验证",
];

export const COMPLEXITY_TERMS = [
  "complete", "full", "end-to-end", "all", "every", "product",
  "parity", "baseline", "compare", "evaluation", "accepted", "closure",
  "无人值守", "完整", "全功能", "全部", "所有", "产品", "对齐",
  "对标", "测评", "评估", "闭环", "持续迭代", "一个不漏",
];

export const SUBAGENT_TERMS = [
  "sub-agent", "subagent", "parallel", "independent", "reference",
  "spawn_agent", "parallel_agents", "spawn agent", "launch agent",
  "delegate agent", "simultaneously", "separately", "at the same time",
  "aider", "opencode", "goose", "codex", "codeman",
  "symphony", "cc-sdd", "oh-my-codex",
  "子agent", "子 agent", "派生agent", "派生 agent", "启动agent", "启动 agent",
  "并行", "独立", "参考项目", "开源项目",
  "对比", "评测", "同时", "分别",
];

export const WORKFLOW_TERMS = [
  "workflow", "pipeline", "orchestration", "multi-step", "end-to-end",
  "handover", "product", "package", "release", "iterate", "closure",
  "工作流", "自动规划", "自动workflow", "编排", "多步骤", "交接",
  "产品", "打包", "发布", "持续迭代", "闭环",
];

const WEB_ACCESS_TERMS = [
  "web", "internet", "online", "url", "http", "download", "github",
  "联网", "网上", "在线", "网址", "下载", "官网",
];

const CONTEXT_SNAPSHOT_TERMS = [
  "given", "provided", "snapshot", "summary", "checkpoint", "scenario",
  "给定", "下面是", "假设", "快照", "恢复摘要", "压缩摘要", "摘要", "场景",
];

const CONTEXT_VALIDATION_TERMS = [
  "canvast_context_evidence", "validate", "validation", "verify",
  "只验证", "仅验证", "验证",
];

const SUBAGENT_VALIDATION_TERMS = [
  "canvast_subagent_evidence", "validate", "validation", "verify",
  "只验证", "仅验证", "验证",
];

const ENHANCED_VALIDATION_TERMS = [
  "canvast_enhanced_evidence", "validate", "validation", "verify",
  "只验证", "仅验证", "验证",
];

const CURRENT_FACT_TERMS = [
  "latest", "realtime", "real-time", "live", "release",
  "official current", "source current", "as of now", "up to date",
  "最新", "实时", "发布", "截至目前", "最新来源", "当前来源",
];

const LIVE_FACT_TERMS = [
  "live status", "current status", "availability", "schedule", "opening hours",
  "route", "directions", "market data", "quote", "current event",
  "当前状态", "实时状态", "可用状态", "营业状态", "时刻表", "路线", "导航",
  "市场数据", "报价", "当前事件",
];

const OPTIMIZATION_ACTION_TERMS = [
  "optimize", "improve performance", "tune", "speed up", "make faster",
  "优化", "提升性能", "提速", "调优", "加速",
];

const PERFORMANCE_SUBJECT_TERMS = [
  "performance", "latency", "throughput", "speed", "slow", "memory", "cpu",
  "性能", "延迟", "吞吐", "速度", "慢", "内存", "cpu",
];

const OPTIMIZATION_SCOPE_TERMS = [
  "local_file", "local_path", "function", "class", "component", "page", "route",
  "endpoint", "api", "query", "sql", "database", "db", "bundle", "render",
  "函数", "类", "组件", "页面", "路由", "接口", "查询", "数据库", "渲染",
];

const OPTIMIZATION_METRIC_TERMS = [
  "p50", "p90", "p95", "p99", "qps", "tps", "fps", "baseline", "profile",
  "profiling", "benchmark", "trace", "flamegraph", "heap", "load test",
  "基线", "指标", "压测", "画像", "火焰图", "耗时", "峰值", "首屏", "卡顿",
];

const OPTIMIZATION_EXECUTION_AUTH_TERMS = [
  "edit the code", "modify the code", "change the code", "patch it", "implement the optimization",
  "run profiling", "run benchmark", "run tests", "allowed to edit", "you may edit",
  "修改代码", "改代码", "直接改", "直接修改", "可以改", "允许修改", "开始改",
  "跑 profiling", "跑 profile", "跑压测", "执行压测", "跑测试",
];

export const WEB_TERMS = [
  ...WEB_ACCESS_TERMS,
  ...CURRENT_FACT_TERMS,
  ...LIVE_FACT_TERMS,
];

export const SHELL_TERMS = [
  "run", "execute", "install", "test", "verify", "package", "build",
  "跑", "运行", "执行", "安装", "测试", "验证", "打包", "构建",
];

export const TASK_CONTROL_TERMS = [
  "task", "tasks", "task_create", "task_update", "task_list", "task_get",
  "pending", "in_progress", "completed", "blocked",
  "任务", "状态流转", "状态变化", "待处理", "进行中", "已完成", "阻塞",
];

export const TEST_TERMS = ["test", "verify", "regression", "e2e", "测评", "测试", "验证", "回归", "复测"];
export const TUI_TERMS = ["tui", "terminal", "graph canvas", "canvas view", "canvas visualization", "visual", "dashboard", "task tree", "画布", "可视化", "任务树", "仪表盘"];
export const RESOURCE_TERMS = ["cpu", "memory", "resource", "watchdog", "monitor", "内存", "资源", "监控", "守护"];
export const REVIEW_TERMS = ["review", "audit", "gap", "compare", "审查", "评审", "缺口", "差距", "对比"];

export const CONTEXT_TERMS = [
  "context", "session", "history", "compress", "compact", "recall", "retrieve",
  "resume", "restore", "conversation", "checkpoint", "continue",
  "previous turn", "previous question", "previous message",
  "last turn", "last question", "last message",
  "上下文", "会话", "历史", "压缩", "召回", "检索", "恢复", "续接", "继续",
  "上一轮", "上轮", "上一条", "上个问题", "前面说", "之前说", "刚才的问题", "刚刚的问题",
];

export const FOLLOW_UP_TERMS = [
  "also", "one more", "another", "by the way", "quick question",
  "follow up", "while you work", "continue working", "keep going",
  "还有", "另外", "顺便", "补充", "追加", "继续完成", "继续做", "接着做",
];

const STATUS_FOLLOW_UP_TERMS = [
  "status update", "project status", "work status", "progress", "where are we", "what is done", "what remains",
  "进度", "进展", "做到哪", "完成了什么", "还剩什么", "现在怎样", "当前进展",
];

const TASK_ADJUSTMENT_TERMS = [
  "adjust plan", "update plan", "revise plan", "adjust task", "update task",
  "add task", "split task", "replan", "prioritize", "priority",
  "调整计划", "更新计划", "修订计划", "调整plan", "调整 task", "调整task",
  "新增任务", "拆分任务", "更新任务", "视情况", "自动调整", "优先级",
];

const CRITICAL_FOLLOW_UP_TERMS = [
  "must", "required", "critical", "blocker", "blocking", "priority", "important",
  "必须", "一定", "关键", "阻塞", "卡点", "优先", "重要", "不能", "不允许",
];

const REDIRECT_TERMS = [
  "instead", "replace", "switch to", "change priority", "new priority",
  "先别做这个", "优先做", "改优先级",
];

const PAUSE_TERMS = [
  "pause", "stop", "cancel", "hold off", "do not continue",
  "暂停", "停止", "取消", "先停", "别继续", "不要继续",
];

export const LOCAL_SCAN_TERMS = [
  "explore", "scan", "list", "count", "structure", "distribution", "directory",
  "directories", "tree", "files", "file types",
  "探索", "扫描", "列出", "统计", "结构", "目录", "文件", "文件类型", "分布",
];

const LOCAL_SEARCH_ACTION_TERMS = [
  "search", "find", "grep", "rg", "ripgrep", "fd", "match", "contains",
  "containing", "all files", "every file",
  "搜索", "查找", "找到", "匹配", "包含", "含有", "所有文件", "全部文件",
];

const TEMPORAL_FIXED_TERMS = [
  "today", "tomorrow", "yesterday", "tonight", "this morning",
  "this afternoon", "this evening", "this week", "this month",
  "this year", "right now", "now",
  "今天", "明天", "昨天", "今晚", "今早", "明早", "本周", "这周",
  "本月", "今年", "下周", "上周", "刚才", "刚刚", "现在",
];

const CONTEXT_REFERENCE_TERMS = [
  "previous turn", "previous question", "previous message", "previous answer",
  "previous reply", "last turn", "last question", "last message",
  "last answer", "last reply",
  "上一轮", "上轮", "上一条", "上个问题", "上次问", "你刚才", "我刚才",
  "刚才的问题", "刚才回答", "刚才说", "刚才提", "刚才问", "刚才那", "刚才这个",
];

const FOLLOW_UP_PHRASE_TERMS = [
  "also", "one more thing", "another thing", "by the way",
  "quick question", "follow-up", "follow up",
  "还有", "另外", "顺便", "补充", "追加",
];

const NEGATED_SUBAGENT_MARKERS = [
  "do not", "don't", "dont", "no ", "without", "avoid", "never", "forbid", "forbidden",
  "不要", "不许", "禁止", "无需", "不用", "别", "不要再", "不派生", "不启动",
];

const NEGATED_ACCESS_MARKERS = [
  "do not", "don't", "dont", "no ", "without", "avoid", "never", "forbid", "forbidden",
  "不要", "不许", "禁止", "无需", "不用", "别",
];

const SOURCE_ANSWER_PLAN_HITS = new Set(["test", "verify", "测试", "验证"]);
const SOURCE_RETRIEVAL_CONTEXT_HITS = new Set(["retrieve", "continue", "检索", "继续"]);

const LOCAL_RUNTIME_SCOPE_TERMS = [
  "runtime", "sandbox", "permission", "permissions", "unattended",
  "session", "agent", "tool", "workflow", "task", "workspace",
  "运行态", "沙箱", "权限", "无人值守", "会话", "agent", "工具", "任务", "工作流",
];

const LOCAL_RUNTIME_STATE_TERMS = [
  "live check", "live status", "current status", "current state",
  "active status", "active state", "active permission state",
  "实时检查", "实时状态", "当前状态", "当前权限状态", "活跃状态",
];

function isNegatedTerm(text: string, term: string): boolean {
  let index = text.indexOf(term);
  while (index >= 0) {
    const before = text.slice(Math.max(0, index - 24), index);
    const after = text.slice(index + term.length, index + term.length + 12);
    const window = `${before}${after}`;
    if (NEGATED_SUBAGENT_MARKERS.some(marker => window.includes(marker))) return true;
    index = text.indexOf(term, index + term.length);
  }
  return false;
}

function isNegatedAccessTerm(text: string, term: string): boolean {
  let index = text.indexOf(term);
  while (index >= 0) {
    const before = text.slice(Math.max(0, index - 24), index);
    const after = text.slice(index + term.length, index + term.length + 12);
    const window = `${before}${after}`;
    const compactBefore = removeWhitespace(before);
    if (
      NEGATED_ACCESS_MARKERS.some(marker => window.includes(marker)) ||
      compactBefore.endsWith("不") ||
      compactBefore.endsWith("无") ||
      compactBefore.endsWith("非")
    ) {
      return true;
    }
    index = text.indexOf(term, index + term.length);
  }
  return false;
}

function chronoTemporalHits(text: string): TermHits {
  if (!hasLatinLetter(text)) return { count: 0, hits: [] };
  try {
    const hits = chrono.parse(text).slice(0, 3).map(result => `chrono:${result.text.toLowerCase()}`);
    return { count: hits.length, hits };
  } catch {
    return { count: 0, hits: [] };
  }
}

function detectTemporalSignals(text: string): TermHits {
  return mergeHits(
    countTerms(text, TEMPORAL_FIXED_TERMS),
    chronoTemporalHits(text),
  );
}

function detectContextReferenceHits(text: string): TermHits {
  const hits: string[] = [];
  for (const term of CONTEXT_REFERENCE_TERMS) {
    if (hasTerm(text, term)) hits.push(`context-ref:${term}`);
  }
  if (hasTermsWithin(text, ["what", "which"], ["asked", "said", "mentioned"], 80)) {
    hits.push("context-ref:prior-utterance-question");
  }
  if (hasOrderedTermsWithin(
    text,
    ["前面", "之前", "以前", "最开始", "上次", "早期", "前几轮"],
    ["说", "提", "问", "讨论", "聊", "谈", "提到", "说过", "问过", "谈过", "记得", "回忆"],
    40,
  )) {
    hits.push("context-ref:prior-utterance-zh");
  }
  return { count: hits.length, hits: Array.from(new Set(hits)) };
}

function detectFollowUpPhraseHits(text: string): TermHits {
  const hits: string[] = [];
  const trimmed = text.trimStart();
  for (const term of FOLLOW_UP_PHRASE_TERMS) {
    if (hasTerm(text, term)) hits.push(term);
  }
  if (startsWithAny(trimmed, ["还有", "另外", "顺便", "补充", "追加"])) {
    hits.push("follow-up:start");
  }
  if (
    hasOrderedTermsWithin(text, ["不影响"], ["工作"], 40) ||
    hasOrderedTermsWithin(text, ["不影响"], ["任务"], 40) ||
    hasOrderedTermsWithin(text, ["继续"], ["工作"], 40)
  ) {
    hits.push("follow-up:non-blocking-work");
  }
  return { count: hits.length, hits: Array.from(new Set(hits)) };
}

function hasListShape(prompt: string): boolean {
  const withoutAbsolutePaths = mapDelimitedTokens(prompt, token => isAbsolutePathToken(token) ? "local_path" : token);
  const slashCount = countPlainOccurrences(withoutAbsolutePaths, "/");
  const commaCount = countAnyOf(prompt, [",", "，", "、"]);
  const lineCount = countNonEmptyLines(prompt);
  return slashCount >= 3 || commaCount >= 4 || lineCount >= 4;
}

function maskLocalPathTokens(text: string): string {
  return mapDelimitedTokens(text, token => isLocalPathToken(token) ? "local_path" : token);
}

function maskLocalFileNameTokens(text: string): string {
  return mapDelimitedTokens(text, token => isLocalFileToken(token) ? "local_file" : token);
}

function maskQuotedLiterals(text: string): string {
  let result = "";
  let quote: string | undefined;
  let quoted = "";
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (escaped) {
        escaped = false;
        quoted += char;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        quoted += char;
        continue;
      }
      if (char === quote) {
        quote = undefined;
        quoted = "";
        result += " quoted_literal ";
      } else {
        quoted += char;
      }
      continue;
    }
    if (char === "'" && isAsciiWordChar(text[index - 1]) && isAsciiWordChar(text[index + 1])) {
      result += char;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      quoted = "";
      continue;
    }
    result += char;
  }
  if (quote) result += quote + quoted;
  return result;
}

function maskLocalCurrentContext(text: string): string {
  let masked = text;
  for (const noun of ["项目", "工程", "仓库", "代码库", "目录", "文件夹", "工作区", "workspace", "repo", "repository"]) {
    masked = replacePlainTerm(masked, `当前${noun}`, `本地${noun}`);
  }
  for (const noun of ["project", "workspace", "repo", "repository", "directory", "folder", "codebase"]) {
    masked = replaceTerm(masked, `current ${noun}`, `local ${noun}`);
  }
  return masked;
}

function maskLocalRuntimeStateTerms(text: string): string {
  const hasLocalRuntimeScope =
    hasTermsWithin(text, LOCAL_RUNTIME_SCOPE_TERMS, LOCAL_RUNTIME_STATE_TERMS, 96) ||
    hasTermsWithin(text, LOCAL_RUNTIME_STATE_TERMS, LOCAL_RUNTIME_SCOPE_TERMS, 96) ||
    hasAny(text, ["sandbox_status", "sandbox_permission_mode"]);
  if (!hasLocalRuntimeScope) return text;

  let masked = text;
  for (const term of LOCAL_RUNTIME_STATE_TERMS) {
    masked = replaceTerm(masked, term, "local_runtime_state");
  }
  masked = replaceTerm(masked, "live check", "local_runtime_check");
  return masked;
}

function maskDirectoryExclusionWindows(text: string): string {
  const markers = ["exclude", "excluding", "ignore", "skip", "排除", "忽略", "跳过"];
  const directoryNames = ["build", "dist", "coverage", "node_modules", ".git", ".runtime"];
  const windows: Array<[number, number]> = [];
  for (const marker of markers) {
    let index = text.indexOf(marker);
    while (index >= 0) {
      const nextLine = text.indexOf("\n", index);
      const end = nextLine >= 0 ? Math.min(nextLine, index + 160) : Math.min(text.length, index + 160);
      windows.push([index, end]);
      index = text.indexOf(marker, index + marker.length);
    }
  }
  if (windows.length === 0) return text;

  let cursor = 0;
  let masked = "";
  for (const [start, end] of windows.sort((a, b) => a[0] - b[0])) {
    if (start < cursor) continue;
    let windowText = text.slice(start, end);
    for (const name of directoryNames) {
      windowText = replaceTerm(windowText, name, " local_dir ");
    }
    masked += text.slice(cursor, start) + windowText;
    cursor = end;
  }
  return masked + text.slice(cursor);
}

function maskNonActionContextTerms(text: string): string {
  return replacePlainTerm(
    replacePlainTerm(
      replacePlainTerm(maskDirectoryExclusionWindows(text), "停止并说明", "conditional_stop_note"),
      "未验证",
      "unverified_state",
    ),
    "未校验",
    "unchecked_state",
  );
}

function maskRealtimeDomainTerms(text: string): string {
  let masked = text;
  const zhDomains = ["协作", "协同", "编辑", "编辑器", "通信", "通讯", "消息", "推送", "系统", "应用", "数据", "同步", "音视频", "聊天", "看板", "渲染", "控制"];
  for (const domain of zhDomains) masked = replacePlainTerm(masked, `实时${domain}`, `domain_realtime${domain}`);
  const enRealtimeTerms = ["real-time", "real time", "realtime"];
  const enDomains = ["collaboration", "collaborative", "editor", "editing", "communication", "messaging", "sync", "synchronization", "system", "application", "app", "dashboard", "chat", "rendering", "control"];
  for (const realtime of enRealtimeTerms) {
    for (const domain of enDomains) {
      masked = replaceTerm(masked, `${realtime} ${domain}`, `domain_realtime ${domain}`);
    }
  }
  return masked;
}

function maskHistoricalRecallFactTerms(text: string): string {
  const historicalRecall = hasOrderedTermsWithin(
    text,
    ["之前", "以前", "最开始", "前面", "上次", "刚才", "早期", "前几轮", "上一轮", "previous", "earlier", "before", "last time", "at the beginning"],
    ["讨论", "聊", "提到", "说过", "问过", "谈过", "记得", "回忆", "是什么", "discussed", "talked", "mentioned", "remember", "recall", "what was"],
    80,
  );
  if (!historicalRecall) return text;
  let masked = text;
  for (const term of LIVE_FACT_TERMS) masked = replaceTerm(masked, term.toLowerCase(), "historical_fact");
  return masked;
}

function hasExplicitProjectEvidenceRequest(normalized: string): boolean {
  return hasOrderedTermsWithin(
    normalized,
    ["结合", "基于", "针对", "in", "for"],
    ["本项目", "当前项目", "这个项目", "该项目", "此项目", "本工程", "当前工程", "本仓库", "当前仓库", "本代码库", "当前代码库", "this project", "current project", "local project", "this repo", "current repo", "local repo", "this repository", "current repository", "this codebase", "current codebase", "this workspace", "current workspace"],
    24,
  );
}

function forbidsLocalEvidenceAccess(normalized: string): boolean {
  return hasAny(normalized, [
    "do not read local files", "do not inspect local files", "do not use local files",
    "no local files", "without local files",
    "不要读本地文件", "不要读取本地文件", "不要查看本地文件", "不要使用本地文件",
    "不读本地文件", "不读取本地文件", "不看本地文件", "不用本地文件",
  ]);
}

function hasExplicitReadOnlyIntent(normalized: string): boolean {
  return hasAny(normalized, [
    "read-only", "read only", "no mutation", "do not modify", "without modifying",
    "inspect only", "analysis only",
    "不修改", "不改", "不要修改", "不要改", "无需修改", "禁止修改",
    "先不要改", "只读", "仅读取", "只评估", "仅评估", "只分析", "仅分析",
  ]);
}

function hasPlanOnlyIntent(intentText: string, readOnlyIntent: boolean): boolean {
  const asksLocalEvidence =
    hasAny(intentText, ["read", "inspect", "explore", "scan", "repo", "repository", "codebase", "local_file"]) ||
    hasAny(intentText, ["阅读", "读取", "查看", "调研", "探索", "扫描", "仓库", "代码库", "本地文件", "目录", "文件"]);
  return readOnlyIntent && (
    hasAny(intentText, ["plan", "planning", "proposal", "roadmap", "计划", "规划", "方案"])
  ) && !asksLocalEvidence;
}

function hasExplicitLocalEvidenceRequest(normalized: string, intentText: string): boolean {
  const hasConcreteLocalToken = hasAny(intentText, ["local_file", "local_path", "repo", "repository", "codebase", "workspace"]);
  const hasLocalEvidence =
    hasConcreteLocalToken ||
    hasAny(normalized, ["read", "inspect", "explore", "scan", "search", "grep", "rg", "find", "list"]) ||
    hasExplicitProjectEvidenceRequest(normalized) ||
    hasAny(normalized, [
      "当前项目", "当前工程", "当前仓库", "当前代码库", "当前目录", "当前文件夹",
      "本地项目", "本地工程", "本地仓库", "本地代码库", "本地目录", "本地文件", "本地文件夹",
      "仓库", "代码库", "目录", "文件", "搜索", "查找", "读取", "查看", "扫描", "列出",
    ]);
  if (!hasLocalEvidence) return false;
  return !(forbidsLocalEvidenceAccess(normalized) && !hasConcreteLocalToken);
}

function hasPromptLocalCodeAnalysisIntent(normalized: string, intentText: string): boolean {
  if (hasExplicitLocalEvidenceRequest(normalized, intentText)) return false;
  const analysisAsk =
    hasAny(normalized, ["review", "bug", "issue", "problem", "wrong", "fix", "debug", "test", "snippet", "code"]) ||
    hasAny(normalized, ["这段代码", "这段函数", "这段逻辑", "代码有问题", "有问题吗", "哪里错", "需求是", "审查", "检查", "评审", "修复建议"]) ||
    hasOrderedTermsWithin(normalized, ["为什么"], ["测试", "通过"], 24);
  if (!analysisAsk) return false;
  return normalized.includes("```") ||
    hasAny(normalized, ["def", "function", "class", "return", "if", "else", "const", "let", "var", "import", "export"]) ||
    hasAnyChar(normalized, "{};");
}

function hasLocalSearchIntent(normalized: string, intentText: string, explicitProjectEvidence: boolean): boolean {
  if (!explicitProjectEvidence && !hasExplicitLocalEvidenceRequest(normalized, intentText)) return false;
  if (hasLocalMutationIntent(intentText)) return false;
  const asksParserBackedStats =
    hasAny(normalized, ["typescript compiler api", "ast", "解析器", "parser"]) &&
    hasAny(normalized, ["统计", "count", "analyze", "analyse", "分析"]);
  if (asksParserBackedStats) return false;
  const namesLocalScope =
    explicitProjectEvidence ||
    hasAny(intentText, ["local_file", "local_path", "repo", "repository", "codebase", "workspace"]) ||
    hasAny(normalized, [
      "当前项目", "当前工程", "当前仓库", "当前代码库", "当前目录", "当前文件夹",
      "本地项目", "本地工程", "本地仓库", "本地代码库", "本地目录", "本地文件", "本地文件夹",
      "仓库", "代码库", "目录",
    ]);
  if (!namesLocalScope) return false;
  const hasSearchAction = hasAny(intentText, LOCAL_SEARCH_ACTION_TERMS);
  const hasBatchShape =
    hasOrderedTermsWithin(intentText, ["all", "every"], ["local_file", "file", "files"], 48) ||
    hasOrderedTermsWithin(normalized, ["所有", "全部"], ["文件", "目录"], 24);
  const outputFormatMentionsContain =
    hasOrderedTermsWithin(normalized, ["最终", "最后", "回答", "输出", "结果", "必须"], ["包含", "含有"], 18) ||
    hasOrderedTermsWithin(normalized, ["answer", "output", "result", "must"], ["contain", "contains", "include"], 40);
  const hasContentPredicate = (
    hasAny(intentText, ["contains", "containing", "match", "pattern"]) ||
    hasAny(normalized, ["包含", "含有", "匹配"])
  ) && !outputFormatMentionsContain;
  return hasSearchAction || hasBatchShape || hasContentPredicate;
}

function hasStandaloneAdvisoryIntent(normalized: string, intentText: string): boolean {
  if (hasExplicitLocalEvidenceRequest(normalized, intentText)) return false;
  if (hasAny(intentText, ["implement", "build", "create", "modify", "edit", "fix", "repair", "refactor", "package", "ship", "test", "verify", "run", "execute", "install"])) return false;
  if (hasAny(intentText, ["实现", "构建", "创建", "修改", "修复", "重构", "打包", "交付", "测试", "验证", "运行", "执行", "安装"])) return false;
  const advisoryAsk =
    hasAny(normalized, ["analyze", "analyse", "compare", "recommend", "trade-off", "trade off", "pros and cons", "architecture", "design", "selection", "choose", "advice", "proposal"]) ||
    hasAny(normalized, ["分析", "对比", "比较", "推荐", "权衡", "取舍", "架构", "设计", "方案", "选型", "建议"]);
  const domainShape =
    hasAny(normalized, ["vs", "versus", "concurrency", "latency", "offline", "throughput", "security", "scalability"]) ||
    hasAnyChar(normalized, "：:、，,") ||
    hasAny(normalized, ["并发", "延迟", "离线", "吞吐", "安全", "扩展", "成本", "复杂度"]);
  return advisoryAsk && domainShape;
}

function hasAmbiguousOptimizationIntent(normalized: string, intentText: string): boolean {
  const asksOptimization = hasAny(intentText, OPTIMIZATION_ACTION_TERMS);
  const namesPerformance = hasAny(intentText, PERFORMANCE_SUBJECT_TERMS);
  if (!asksOptimization || !namesPerformance) return false;
  if (hasExplicitReadOnlyIntent(normalized)) return false;
  if (hasPromptLocalCodeAnalysisIntent(normalized, intentText)) return false;
  const hasScope = hasAny(intentText, OPTIMIZATION_SCOPE_TERMS);
  const hasMetricOrEvidence = hasAny(intentText, OPTIMIZATION_METRIC_TERMS);
  const hasExecutionAuth = hasAny(normalized, OPTIMIZATION_EXECUTION_AUTH_TERMS) || hasLocalMutationIntent(intentText);
  return !hasScope && !hasMetricOrEvidence && !hasExecutionAuth;
}

function hasLocalMutationIntent(intentText: string): boolean {
  return hasTermsWithin(intentText, ["local_file"], ["改成", "改为", "修改", "编辑", "替换", "写入", "保存", "删除"], intentText.length);
}

function isSimpleParallelFileRead(intentText: string): boolean {
  const fileRefs = termPositions(intentText, "local_file").length;
  const asksRead = hasAny(intentText, ["read", "view", "show", "print", "读取", "查看", "展示", "输出"]);
  const asksExploration = hasAny(intentText, [
    "explore", "scan", "analyze", "analyse", "directory", "directories", "structure",
    "distribution", "independent", "separately",
    "探索", "扫描", "分析", "目录", "结构", "分布", "独立", "分别",
  ]);
  return fileRefs >= 2 && asksRead && !asksExploration;
}

function isSingleFileChunkedRead(intentText: string): boolean {
  const fileRefs = termPositions(intentText, "local_file").length;
  const asksRead = hasAny(intentText, ["read", "view", "show", "print", "读取", "查看", "展示", "输出"]);
  const chunkSignals =
    hasAny(intentText, ["offset", "limit", "line", "lines", "range", "chunk", "chunks", "分段", "分批", "分两段", "两段", "行", "范围"]);
  const forbidsShell =
    hasOrderedTermsWithin(intentText, ["do not use", "without"], ["shell", "cat", "head", "sed", "bash"], 80) ||
    hasOrderedTermsWithin(intentText, ["不要", "不用"], ["shell", "cat", "head", "sed", "bash"], 40);
  return fileRefs === 1 && asksRead && chunkSignals && forbidsShell;
}

function forbidsSubagentDelegation(intentText: string): boolean {
  return hasAnyPhrase(intentText, [
    "do not spawn", "do not launch", "do not delegate", "no sub-agent",
    "no subagent", "no agent delegation", "without sub-agent",
    "without subagent", "不要启动子 agent", "不要启动子agent",
    "不要派生子 agent", "不要派生子agent", "不要委托",
    "禁止启动子 agent", "禁止启动子agent", "禁止派生",
    "不启动子 agent", "不启动子agent", "不派生子 agent",
    "不派生子agent",
  ]);
}

function forbidsWorkflowOrchestration(intentText: string): boolean {
  return hasAnyPhrase(intentText, [
    "do not enter workflow", "do not use workflow", "no workflow",
    "without workflow", "avoid workflow",
    "不要进入 workflow", "不要进入workflow", "不要使用 workflow", "不要使用workflow",
    "不进入 workflow", "不进入workflow", "不用 workflow", "不用workflow",
    "禁止进入 workflow", "禁止进入workflow",
  ]);
}

function filterSubagentHits(intentText: string, hits: TermHits): TermHits {
  if (forbidsSubagentDelegation(intentText)) return { count: 0, hits: [] };
  let filtered = hits.hits.filter(hit => !isNegatedTerm(intentText, hit));
  if (!isSimpleParallelFileRead(intentText) && !isSingleFileChunkedRead(intentText)) {
    return { count: filtered.length, hits: filtered };
  }
  const weakParallelTerms = new Set(["simultaneously", "at the same time", "separately", "同时", "分别"]);
  filtered = filtered.filter(hit => !weakParallelTerms.has(hit));
  return { count: filtered.length, hits: filtered };
}

function filterWorkflowHits(intentText: string, hits: TermHits): TermHits {
  if (forbidsWorkflowOrchestration(intentText)) return { count: 0, hits: [] };
  const filtered = hits.hits.filter(hit => !isNegatedAccessTerm(intentText, hit));
  return { count: filtered.length, hits: filtered };
}

function filterNegatedAccessHits(intentText: string, hits: TermHits): TermHits {
  const filtered = hits.hits.filter(hit => !isNegatedAccessTerm(intentText, hit));
  return { count: filtered.length, hits: filtered };
}

const GENERIC_SESSION_CONTEXT_HITS = new Set(["会话", "session"]);
const GENERIC_SESSION_CONTINUITY_NEIGHBORS = [
  "same", "current", "this", "previous", "last", "active", "ongoing",
  "history", "context", "resume", "restore", "continue", "compact",
  "compress", "recall", "conversation",
  "同一个", "当前", "这个", "本次", "本轮", "上一", "上个", "活跃",
  "历史", "上下文", "恢复", "续接", "继续", "压缩", "召回", "原文",
  "对话",
];

function hasAnyPhrase(text: string, phrases: string[]): boolean {
  return phrases.some(phrase => text.includes(phrase));
}

function hasOnlyGenericSessionContext(hits: TermHits): boolean {
  return hits.hits.length > 0 && hits.hits.every(hit => GENERIC_SESSION_CONTEXT_HITS.has(hit));
}

function hasGenericSessionContinuityContext(intentText: string): boolean {
  return hasTermsWithin(
    intentText,
    ["session", "会话"],
    GENERIC_SESSION_CONTINUITY_NEIGHBORS,
    48,
  ) || hasTermsWithin(
    intentText,
    GENERIC_SESSION_CONTINUITY_NEIGHBORS,
    ["session", "会话"],
    48,
  );
}

function isParentAgentCoordinationPrompt(intentText: string, subagents: TermHits): boolean {
  if (subagents.count < 1) return false;
  const namesParentSessionRole = hasAnyPhrase(intentText, [
    "父会话", "主会话", "parent session", "main session",
  ]);
  const coordinatesBranchResults = hasAnyPhrase(intentText, [
    "合并", "汇总", "报告", "标注", "来源", "中转",
    "merge", "combine", "summarize", "report", "attribute", "source", "relay",
  ]);
  return namesParentSessionRole && coordinatesBranchResults;
}

function isParentSessionRolePrompt(intentText: string, subagents: TermHits): boolean {
  if (subagents.count < 1) return false;
  return hasAnyPhrase(intentText, [
    "父会话", "主会话", "parent session", "main session",
  ]);
}

function isPermissionInheritancePrompt(intentText: string, subagents: TermHits): boolean {
  if (subagents.count < 1) return false;
  const namesParentSessionRole = hasAnyPhrase(intentText, [
    "主会话", "父会话", "main session", "parent session",
  ]);
  const permissionTerms = hasAnyPhrase(intentText, [
    "always allow", "permission", "permissions", "sandbox", "授权", "权限",
  ]);
  return namesParentSessionRole && permissionTerms;
}

function filterContextHits(intentText: string, hits: TermHits, subagents: TermHits): TermHits {
  if (!hasOnlyGenericSessionContext(hits)) {
    return hits;
  }
  if (hasGenericSessionContinuityContext(intentText)) return hits;
  if (
    !isParentSessionRolePrompt(intentText, subagents) &&
    !isPermissionInheritancePrompt(intentText, subagents) &&
    !isParentAgentCoordinationPrompt(intentText, subagents)
  ) {
    return { count: 0, hits: [] };
  }
  const filtered = hits.hits.filter(hit => !GENERIC_SESSION_CONTEXT_HITS.has(hit));
  return { count: filtered.length, hits: filtered };
}

function filterExternalSourceAnswerContextHits(hits: TermHits, externalSourceAnswerIntent: boolean): TermHits {
  if (!externalSourceAnswerIntent) return hits;
  const filtered = hits.hits.filter(hit => !SOURCE_RETRIEVAL_CONTEXT_HITS.has(hit));
  return { count: filtered.length, hits: filtered };
}

function hasPromptLocalContextValidation(normalized: string, intentText: string, readOnlyIntent: boolean): boolean {
  const hasEvidenceContract = hasAny(normalized, ["canvast_context_evidence"]);
  if (!hasEvidenceContract) return false;
  const hasContextSignal =
    hasEvidenceContract ||
    hasAny(intentText, CONTEXT_TERMS);
  const hasSnapshot = hasAny(normalized, CONTEXT_SNAPSHOT_TERMS);
  const asksValidation = hasAny(normalized, CONTEXT_VALIDATION_TERMS);
  const forbidsExternalWork = hasAny(normalized, [
    "不修改文件", "不要修改文件", "不执行 shell", "不要执行 shell", "不联网",
    "do not modify", "do not run shell", "no shell", "do not browse", "no web",
  ]);
  return readOnlyIntent && hasContextSignal && (hasSnapshot || hasEvidenceContract) && asksValidation && forbidsExternalWork;
}

function hasPromptLocalSubagentValidation(normalized: string, intentText: string, readOnlyIntent: boolean): boolean {
  const hasEvidenceContract = hasAny(normalized, ["canvast_subagent_evidence"]);
  const hasSubagentSignal =
    hasEvidenceContract ||
    hasAny(intentText, SUBAGENT_TERMS);
  const asksValidation = hasAny(normalized, SUBAGENT_VALIDATION_TERMS);
  const forbidsExternalWork = hasAny(normalized, [
    "不修改文件", "不要修改文件", "不执行 shell", "不要执行 shell", "不联网",
    "do not modify", "do not run shell", "no shell", "do not browse", "no web",
  ]);
  const forbidsRealAgent = hasAny(normalized, [
    "不要派生真实 agent", "不要启动真实 agent", "不要派生真实agent", "不要启动真实agent",
    "不要派生", "不要启动", "不派生真实 agent", "不启动真实 agent",
    "do not spawn", "do not launch", "no real agent", "without spawning",
  ]);
  return readOnlyIntent && hasEvidenceContract && hasSubagentSignal && asksValidation && forbidsExternalWork && forbidsRealAgent;
}

function hasPromptLocalEnhancedValidation(normalized: string, readOnlyIntent: boolean): boolean {
  const hasEvidenceContract = hasAny(normalized, ["canvast_enhanced_evidence"]);
  const asksValidation = hasAny(normalized, ENHANCED_VALIDATION_TERMS);
  const forbidsExternalWork = hasAny(normalized, [
    "不修改文件", "不要修改文件", "不执行 shell", "不要执行 shell", "不联网",
    "do not modify", "do not run shell", "no shell", "do not browse", "no web",
  ]);
  const forbidsRealOrchestration = hasAny(normalized, [
    "不真实派生 agent", "不真实启动 workflow", "不要真实派生 agent", "不要真实启动 workflow",
    "不派生 agent", "不启动 workflow", "不要派生 agent", "不要启动 workflow",
    "do not spawn", "do not launch", "no real agent", "do not start workflow",
    "do not run workflow", "no workflow",
  ]);
  return readOnlyIntent && hasEvidenceContract && asksValidation && forbidsExternalWork && forbidsRealOrchestration;
}

function filterQuantityFollowUpHits(intentText: string, hits: TermHits): TermHits {
  const quantityQuestion =
    hasTermsWithin(intentText, ["还有"], ["多少"], 12) ||
    hasOrderedTermsWithin(intentText, ["how many", "how much"], ["left", "remaining", "available"], 80);
  if (!quantityQuestion) return hits;
  const filtered = hits.hits.filter(hit => hit !== "还有" && hit !== "follow-up:1");
  return { count: filtered.length, hits: filtered };
}

function hasExternalSourceAnswerIntent(input: {
  normalized: string;
  intentText: string;
  explicitProjectEvidence: boolean;
  explicitWeb: TermHits;
  currentFacts: TermHits;
  liveFacts: TermHits;
  evidenceContract: TermHits;
  temporal: TermHits;
  plan: TermHits;
  subagents: TermHits;
  workflow: TermHits;
}): boolean {
  const needsExternalEvidence =
    input.explicitWeb.count > 0 ||
    input.currentFacts.count > 0 ||
    input.liveFacts.count > 0 ||
    input.evidenceContract.count > 0 ||
    (input.temporal.count > 0 && input.explicitWeb.count > 0);
  if (!needsExternalEvidence || input.explicitProjectEvidence) return false;
  if (input.subagents.count > 0 || input.workflow.count > 0) return false;
  if (hasAny(input.intentText, ["local_file", "local_path", "repo", "repository", "codebase", "workspace"])) return false;
  if (hasLocalMutationIntent(input.intentText)) return false;

  const planFitsAnswering = input.plan.hits.every(hit => SOURCE_ANSWER_PLAN_HITS.has(hit));
  return planFitsAnswering && (forbidsLocalEvidenceAccess(input.normalized) || input.explicitWeb.count > 0);
}

export function assessPromptIntent(prompt: string): IntentSignals {
  const normalized = prompt.toLowerCase();
  const intentText = maskNonActionContextTerms(maskHistoricalRecallFactTerms(maskRealtimeDomainTerms(maskLocalRuntimeStateTerms(maskLocalCurrentContext(maskLocalFileNameTokens(maskLocalPathTokens(maskQuotedLiterals(normalized))))))));
  const promptLocalCodeAnalysis = hasPromptLocalCodeAnalysisIntent(normalized, intentText);
  const explicitProjectEvidence = hasExplicitProjectEvidenceRequest(normalized);
  const subagents = filterSubagentHits(intentText, countTerms(intentText, SUBAGENT_TERMS));
  const workflow = filterWorkflowHits(intentText, countTerms(intentText, WORKFLOW_TERMS));
  const explicitWeb = filterNegatedAccessHits(intentText, countTerms(intentText, WEB_ACCESS_TERMS));
  const explicitExternalResources = filterNegatedAccessHits(normalized, detectExplicitExternalResources(prompt));
  const currentFacts = countTerms(intentText, CURRENT_FACT_TERMS);
  const liveFacts = countTerms(intentText, LIVE_FACT_TERMS);
  const evidenceContract = detectExternalEvidenceContract(prompt);
  const evidenceContractHits: TermHits = evidenceContract.required
    ? { count: evidenceContract.hits.length, hits: evidenceContract.hits }
    : { count: 0, hits: [] };
  const temporal = detectTemporalSignals(normalized);
  const web = mergeHits(explicitWeb, explicitExternalResources, currentFacts, liveFacts, evidenceContractHits);
  const rawPlan = countTerms(intentText, PLAN_TERMS);
  const ambiguousOptimizationIntent = hasAmbiguousOptimizationIntent(normalized, intentText);
  const externalSourceAnswerIntent = hasExternalSourceAnswerIntent({
    normalized,
    intentText,
    explicitProjectEvidence,
    explicitWeb,
    currentFacts,
    liveFacts,
    evidenceContract: evidenceContractHits,
    temporal,
    plan: rawPlan,
    subagents,
    workflow,
  });
  const standaloneAdvisoryIntent = !promptLocalCodeAnalysis && !externalSourceAnswerIntent && hasStandaloneAdvisoryIntent(normalized, intentText);
  const taskControl = externalSourceAnswerIntent ? { count: 0, hits: [] } : countTerms(intentText, TASK_CONTROL_TERMS);
  const rawContext = filterContextHits(intentText, mergeHits(
    countTerms(intentText, CONTEXT_TERMS),
    detectContextReferenceHits(normalized),
  ), subagents);
  const context = filterExternalSourceAnswerContextHits(rawContext, externalSourceAnswerIntent);
  const rawFollowUp = filterQuantityFollowUpHits(intentText, mergeHits(
    countTerms(intentText, FOLLOW_UP_TERMS),
    detectFollowUpPhraseHits(normalized),
  ));
  const followUp = externalSourceAnswerIntent ? { count: 0, hits: [] } : rawFollowUp;
  const statusFollowUp = externalSourceAnswerIntent ? { count: 0, hits: [] } : countTerms(intentText, STATUS_FOLLOW_UP_TERMS);
  const taskAdjustment = externalSourceAnswerIntent ? { count: 0, hits: [] } : countTerms(intentText, TASK_ADJUSTMENT_TERMS);
  const criticalFollowUp = externalSourceAnswerIntent ? { count: 0, hits: [] } : countTerms(intentText, CRITICAL_FOLLOW_UP_TERMS);
  const redirectFollowUp = externalSourceAnswerIntent ? { count: 0, hits: [] } : countTerms(intentText, REDIRECT_TERMS);
  const pauseFollowUp = externalSourceAnswerIntent ? { count: 0, hits: [] } : countTerms(intentText, PAUSE_TERMS);
  const followUpPolicy = classifyFollowUp({
    text: normalized,
    followUp,
    status: statusFollowUp,
    adjustment: taskAdjustment,
    critical: criticalFollowUp,
    redirect: redirectFollowUp,
    pause: pauseFollowUp,
  });
  const plan = (promptLocalCodeAnalysis || standaloneAdvisoryIntent || externalSourceAnswerIntent) ? { count: 0, hits: [] } : rawPlan;
  const localScanLike = hasAny(intentText, LOCAL_SCAN_TERMS) || explicitProjectEvidence;
  const localSearchLike = hasLocalSearchIntent(normalized, intentText, explicitProjectEvidence);
  const readOnlyLocalScan =
    localScanLike &&
    !hasLocalMutationIntent(intentText) &&
    !hasAny(intentText, ["write", "edit", "modify", "patch", "delete", "save", "写入", "修改", "编辑", "删除", "保存"]) &&
    !hasAny(intentText, ["install", "package", "安装", "打包"]);
  const readOnlyIntent =
    hasExplicitReadOnlyIntent(normalized) ||
    readOnlyLocalScan ||
    promptLocalCodeAnalysis ||
    standaloneAdvisoryIntent ||
    externalSourceAnswerIntent;
  const promptLocalContextValidation = hasPromptLocalContextValidation(normalized, intentText, readOnlyIntent);
  const promptLocalSubagentValidation = hasPromptLocalSubagentValidation(normalized, intentText, readOnlyIntent);
  const promptLocalEnhancedValidation = hasPromptLocalEnhancedValidation(normalized, readOnlyIntent);
  const planOnlyIntent = standaloneAdvisoryIntent ? false : hasPlanOnlyIntent(intentText, readOnlyIntent);
  const requiresTaskAdjustment =
    followUpPolicy === "task_adjustment" ||
    followUpPolicy === "redirect" ||
    (followUpPolicy === "sidecar" && (plan.count > 0 || taskAdjustment.count > 0));

  return {
    normalized,
    intentText,
    plan,
    complexity: countTerms(intentText, COMPLEXITY_TERMS),
    subagents,
    workflow,
    web,
    context,
    taskControl,
    temporal,
    followUp,
    listShape: promptLocalCodeAnalysis ? false : hasListShape(prompt),
    longPrompt: prompt.length >= 180,
    readOnlyIntent,
    planOnlyIntent,
    promptLocalCodeAnalysis,
    promptLocalContextValidation,
    promptLocalSubagentValidation,
    promptLocalEnhancedValidation,
    externalSourceAnswerIntent,
    standaloneAdvisoryIntent,
    ambiguousOptimizationIntent,
    localScanLike,
    localSearchLike,
    webUsePolicy: classifyWebUse({ explicitWeb, explicitExternalResources, currentFacts, liveFacts, evidenceContract: evidenceContractHits, temporal }),
    followUpPolicy,
    requiresTaskAdjustment,
    stateChangingTask: !ambiguousOptimizationIntent && !readOnlyIntent && !planOnlyIntent && !promptLocalCodeAnalysis && !standaloneAdvisoryIntent && !externalSourceAnswerIntent && (plan.count >= 1 || hasLocalMutationIntent(intentText) || hasAny(intentText, SHELL_TERMS)),
  };
}
