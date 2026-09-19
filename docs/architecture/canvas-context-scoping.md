# Canvas Context Scoping / 画布上下文作用域

How each turn is grounded in the whole project: the Canvas contributes a bounded "map" of the active task, and Context Recall contributes a query-driven "memory" of prior work. This document explains both, and why neither grows without limit.

每一轮如何扎根于整个项目：Canvas 提供当前任务的有界"地图"，上下文召回提供按需的"记忆"。本文解释两者机制，以及为何都不会无限增长。

## 1. Context assembly / 上下文组装

Before each LLM call, the harness assembles the prompt from a fixed core plus conditional blocks. The core is four layers; the Canvas and the recall manifest are two of them.

每次 LLM 调用前，harness 由固定的核心加上条件块组装提示词。核心是四层，Canvas 与召回 manifest 是其中两层。

| Layer / 层 | Content / 内容 | ~tokens | Source / 来源 |
| --- | --- | --- | --- |
| 1. System Prompt / 系统提示 | role, tools, rules, product identity / 角色、工具、规则、产品身份 | ~3K | fixed / 固定 |
| 2. **Canvas Scoped View / 画布作用域** | graph query: Task → Plan → Decision → Files / 图谱查询 | **~2–5K** | Canvas store / 画布存储 |
| 3. Recent Conversation / 近期对话 | nearest N turns verbatim / 最近 N 轮逐字 | ~5–10K | rolling window / 滚动窗口 |
| 4. Task Files / 任务文件 | file contents, ≤5 files / 文件内容 | ~5–10K | on demand / 按需 |
| **+ Context Recall Manifest / 上下文召回** | relevance-ranked summaries + pointers / 相关性排序的摘要 + 指针 | **≤4 records, ~900** | recall index / 召回索引 |

Additional conditional blocks are injected only when their trigger fires (automatic-orchestration gate, local-search hygiene, prompt-local code analysis, standalone advisory, scope notice, canvas health notice). The hard ceiling on total context is model-derived (28K tokens by default; `modelContextCeiling`).

另有若干条件块仅在触发时注入（自动编排 gate、本地搜索卫生、提示词内代码分析、独立建议、scope 通知、canvas 健康通知）。总上下文硬上限由模型能力推导（默认 28K tokens；`modelContextCeiling`）。

**History is not only the nearest N turns.** Layer 3 is the verbatim rolling window; two more mechanisms carry older work forward: compaction (older turns become `compaction` / `branch_summary` summaries) and Context Recall (query-driven selection from a durable index). Canvas is the map, history is the journey — they are complementary, not interchangeable.

**历史不只是最近 N 轮。** 第 3 层是逐字滚动窗口；还有两个机制把更早的工作向前传递：compaction（更早的轮次变成 `compaction` / `branch_summary` 摘要）与上下文召回（从持久化索引按 query 选择）。Canvas 是地图，历史是旅程——二者互补，不可互相替代。

## 2. Canvas Scoped View — the map / 画布作用域（地图）

The view is assembled by `CanvasStore.assembleScope(taskId)` (`src/graph/canvas-store.ts`) and rendered by `assembleCanvasScopedView` (`src/graph/canvas-scope.ts`). It answers *what do I need to know about this task* with structured metadata, never raw file contents.

视图由 `CanvasStore.assembleScope(taskId)` 组装（`src/graph/canvas-store.ts`）、`assembleCanvasScopedView` 渲染（`src/graph/canvas-scope.ts`）。它以结构化元数据回答"关于这个任务我需要知道什么"，绝不包含原始文件内容。

Recall bounds / 召回边界:

| Part / 部分 | Query / 查询 | Render cap / 渲染上限 |
| --- | --- | --- |
| Parent Plan / 父计划 | 1 node via `DECOMPOSES_INTO` | — |
| Decisions / 决策 | BFS `{maxDepth: 2, maxNodes: 5, nodeTypes:["decision"], edgeTypes:["MOTIVATED_BY"]}` | `slice(0, 3)` |
| Files / 文件 | plan's declared `scope.files` | `slice(0, 5)` |
| AgentRuns / 执行 | direct `EXECUTED_BY` edges | `slice(0, 3)`, completed only |

The BFS in `traverse` stops once it reaches `maxNodes`, independent of total graph size, and uses an index queue (O(V+E)). The injected block is therefore a **fixed-size neighborhood**: at most 3 decisions, 5 files, 3 runs — whether the graph has 100 nodes or 100,000.

`traverse` 的 BFS 一达到 `maxNodes` 即停止，与总图规模无关，并使用索引队列（O(V+E)）。因此注入块是**固定大小的邻域**：最多 3 决策、5 文件、3 运行——无论图有 100 个节点还是 10 万个。

Sample shape (bilingual markdown appended to the system prompt):

样例结构（追加到系统提示的双语 markdown）:

```markdown
## Canvas Scoped View / 画布作用域
### 📋 Current Task —— Goal / Status / Steps（✅🔄⏳）
### 🎯 Parent Plan —— Goal / Status / Scope Files
### 🧭 Why This Work —— Decision + Problem + Rationale + Alternatives
### ⚠️ Constraints
### 📁 Relevant Files —— `path (lang, size)` ⚠️[MAY BE STALE]
### 🔗 Dependent Agent Results —— summary + files produced + duration
---
*Canvas context: queried at BFS depth 2. Use canvas_query tool for deeper exploration.*
```

Every node is rendered as metadata + rationale, not raw graph JSON. Stale files are flagged rather than trusted; deeper exploration is explicit via the `canvas_query` tool or `traceFile` (`{maxDepth: 3, maxNodes: 20}`).

每个节点都以元数据 + 理由呈现，而非原始图 JSON。过期文件被标记而非盲信；更深探索显式走 `canvas_query` 工具或 `traceFile`（`{maxDepth: 3, maxNodes: 20}`）。

## 3. Context Recall — the memory / 上下文召回（记忆）

`src/harness/context-recall.ts` + `context-recall-storage.ts` maintain a durable index under `context-recall/`. Each record stores **title + summary + source pointer** (`sessionFile` / `entryId` / `spillFile`), with `kind ∈ {turn, message, input, compaction, branch_summary, long_text, attachment}` and `source ∈ {session, input, compaction, branch, runtime}`.

`src/harness/context-recall.ts` + `context-recall-storage.ts` 在 `context-recall/` 下维护持久化索引。每条记录存 **标题 + 摘要 + 来源指针**（`sessionFile` / `entryId` / `spillFile`），`kind ∈ {turn, message, input, compaction, branch_summary, long_text, attachment}`，`source ∈ {session, input, compaction, branch, runtime}`。

Selection is **query-driven, not recency-driven** (`selectContextRecallRecords`):

选择是**按 query 相关性而非时间**（`selectContextRecallRecords`）：

- extract up to 120 terms from the current prompt (`recallTerms`); / 从当前提示提取最多 120 词项（`recallTerms`）；
- score every hot + archived record against those terms (`scoreRecallRecord`, hot > archive, recency as tiebreak); / 对热记录+归档记录按词项打分（`scoreRecallRecord`，热 > 归档、时间作 tiebreak）；
- drop content already present in context (`excludeText`) and deduplicate by pointer; / 过滤已注入内容（`excludeText`）并按指针去重；
- cap by `limit` and `tokenBudget`. / 用 `limit` 与 `tokenBudget` 封顶。

At the injection site (`extensions/canvast-harness.ts`), the manifest is rendered as `## Canvast Context Recall Manifest` with `{ tokenBudget: 900, limit: 4 }` — a turn injects **at most 4 records, ~900 tokens**, each as summary + pointer, ordered by score.

注入点（`extensions/canvast-harness.ts`）以 `## Canvast Context Recall Manifest` 渲染，参数 `{ tokenBudget: 900, limit: 4 }` —— 单轮**最多注入 4 条、约 900 tokens**，每条为摘要 + 指针，按分数排序。

Storage is bounded: hot records ≤ 240, archive ≤ 20,000, local storage ≤ 256 MB, warn at 80%, auto-prune the oldest 7-day archive window. Recall follows **summary-first / pointer-first**: the injected block carries summaries + pointers only; excerpts (`spillFile`, ≤700 chars) and the original session JSONL are opened only when deeper source text is needed — the three-level contract summary → excerpt → original.

存储有界：热记录 ≤ 240、归档 ≤ 20,000、本地 ≤ 256 MB、80% 告警、自动裁剪最旧 7 天归档窗口。召回遵循 **summary-first / pointer-first**：注入块只带摘要 + 指针；摘录（`spillFile`，≤700 字符）与原始 session JSONL 仅在需要更深源文本时打开——三级合同 摘要 → 摘录 → 原始。

## 4. Why it stays bounded / 为什么有界

Four independent bounds keep the injected context flat regardless of project size:

四重独立边界保证注入量不随项目规模增长：

1. **Structural / 结构** — Canvas BFS `maxDepth: 2`, `maxNodes: 5`; recall `limit: 4`.
2. **Render / 渲染** — Canvas `slice(0,3)` / `slice(0,5)` / `slice(0,3)`.
3. **Token budget / token 预算** — `canvasScopeMax` = 18% of the hard ceiling (clamped 2K–40K); recall `tokenBudget: 900`.
4. **Hard ceiling / 硬上限** — total context capped, `checkBudget` warns and suggests compaction.

Token estimation is a cheap heuristic (EN ~4 chars/token, CJK ~2 chars/token). The essential property: recall is **constant-bounded by hop count and node cap**, so it does not grow with the graph; the full graph remains reachable only through explicit on-demand exploration.

Token 估算为廉价启发式（英文约 4 字符/token，中日韩约 2 字符/token）。本质属性：召回由**跳数与节点上限常量约束**，不随图规模增长；全图只能通过显式按需探索获取。

## 5. Code references / 代码引用

| Concern / 关注点 | Location / 位置 |
| --- | --- |
| Context assembly / 组装 | `extensions/canvast-harness.ts` (`before_agent_start`), `AGENTS.md` §三 |
| Canvas view renderer + caps / 视图渲染与上限 | `src/graph/canvas-scope.ts` (`assembleCanvasScopedView`) |
| Canvas scope query + BFS bounds / 作用域查询与 BFS 边界 | `src/graph/canvas-store.ts` (`assembleScope`, `traverse`) |
| Canvas injection / 注入 | `src/harness/canvas-scoping.ts` (`onAgentStart`) |
| Recall index + selection / 召回索引与选择 | `src/harness/context-recall.ts`, `src/harness/context-recall-storage.ts` |
| Budget + ceiling / 预算与上限 | `src/harness/context-budgeting.ts`, `src/harness/model-capabilities.ts` |
| Runtime tiers / 运行时档位 | `src/utils/dynamic-config.ts` |
