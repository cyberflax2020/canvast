# Open-Source Adoption Record

## English

This record documents the current open-source-first adoption choices for the
Canvast product surface covered by `task-002`: user interface foundations,
graph and Canvas infrastructure, and semantic or code-intelligence helpers. It
is a maintained product-facing summary of what was adopted, what remained
custom, and why.

### Scope and acceptance boundary

This record is limited to currently shipped or documented product dependencies
and implementation boundaries. Historical research notes remain useful evidence,
but they are not the canonical public record for current adoption status.

The acceptance target for `task-002` is:

- mature reusable options were considered before custom implementation;
- adopted dependencies retain clear license disclosure; and
- custom code is justified by a concrete product gap or boundary.

### Adoption summary

| Area | Adopted dependency or source | License | Current role | Why adopted or retained |
| --- | --- | --- | --- | --- |
| Core runtime loop | `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` | MIT | Foundation for model integration, coding-agent runtime, and terminal UI | Reused an existing maintained runtime stack instead of building an agent loop and TUI foundation from scratch |
| Structured tool schemas | `@sinclair/typebox`, `typebox` | MIT | Structured tool/input schemas | Reused typed schema libraries rather than maintaining custom ad hoc validators |
| Time parsing | `chrono-node` | MIT | Date and time parsing | Reused a maintained parser instead of custom natural-language date parsing |
| PDF ingestion | `pdf-parse` | Apache-2.0 | PDF text extraction | Reused an existing parser boundary instead of introducing custom PDF decoding |
| Canvas graph model | Canvast JSON graph persistence and traversal | Apache-2.0 project code | Persistent File/Plan/Decision/AgentRun graph and scoped traversal | Product model is small, typed, and task-scoped; current implementation uses a bounded custom graph layer rather than adopting a database product |
| Canvas export visualization | Static SVG and HTML export with optional `d3` runtime reference in HTML | `d3`: ISC | Shareable Canvas export artifacts | Export path is product-specific; HTML viewer uses a pinned client-side library while SVG stays fully standalone |
| Repo structure scan | `canvas_repomap` with adoption evidence from aider repo-map study | Canvast project code; reference study from aider | Bounded repository structure summary for Canvas and agent context | Product retained a lightweight structural scan because it is sufficient for scoped file and symbol overview without claiming full semantic indexing |
| Code-intelligence helper | `lsp` fallback tool | Canvast project code | Bounded definition/reference/search and hover fallback | Current surface is intentionally limited and shell-free; it documents the boundary instead of claiming a full language-server transport |

### Adopted foundations

Canvast is not a from-scratch agent shell. It adopts the Pi runtime family as
its execution foundation and then layers product identity, Canvas, continuity,
runtime policy, and public-facing UI behavior on top. This keeps the product
focused on Canvast-specific governance and project-state capabilities instead of
rebuilding the basic agent loop, provider transport, and terminal UI.

The direct runtime dependency inventory and license disclosures are maintained
in [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md). The current direct
runtime dependencies observed from `package.json` are:

- `@earendil-works/pi-ai` — MIT
- `@earendil-works/pi-coding-agent` — MIT
- `@earendil-works/pi-tui` — MIT
- `@sinclair/typebox` — MIT
- `chrono-node` — MIT
- `pdf-parse` — Apache-2.0
- `typebox` — MIT

### Graph and Canvas infrastructure

The product keeps a small, explicit graph vocabulary with four node types
(`File`, `Plan`, `Decision`, `AgentRun`) and four typed edges. The current
implementation persists that graph as JSON and performs bounded traversal over
the active task scope.

This is a deliberate product choice rather than a claim that no open-source
graph storage exists. The current graph model is narrow, local-first, and tied
to Canvast task scoping, export, and provenance semantics. A heavier embedded or
server-style graph database was not required to satisfy the current product
boundary.

Canvas export remains open-source-first where it helps:

- generated HTML can use pinned `d3` from jsDelivr for interactive viewing;
- generated SVG remains fully standalone with no script dependency; and
- export JSON, Markdown, Mermaid, SVG, and HTML are all produced from the same
  persisted graph contract.

### Semantic and code-intelligence boundary

Canvast does not currently claim a full semantic indexing or full language
server transport surface.

The current shipped behavior is narrower:

- `canvas_repomap` is a bounded structural scan with regex-based symbol
  extraction and repository summary output;
- `lsp` is a bounded, shell-free fallback helper for operations such as
  definition, references, document symbols, workspace symbols, and a limited
  hover response; and
- the hover path explicitly remains informational fallback text rather than a
  claim of live semantic hover from an integrated language server.

This boundary is intentional. The product adopts lightweight reusable runtime
foundations first, then keeps custom code only where the Canvast product needs
typed task scope, local persistence, and explicit public honesty about current
limits.

### Evidence sources

- `release/source-manifest.json` records the byte-exact frozen source snapshot that
  ships this record, and `release/public-tree-manifest.json` records the published
  tree derived from it.
- `THIRD_PARTY_NOTICES.md` is the maintained license inventory for current npm
  dependencies; its machine-verified block is regenerated from `package-lock.json`.
- `package.json` is the direct dependency and shipped-package source of truth.
- `docs/EFFECTIVENESS_EVIDENCE.md` records the maintained paired-evaluation evidence
  for product outcomes around these adoption choices.
- `docs/architecture/overview.md`,
  [canvas-and-traceability.md](./canvas-and-traceability.md), and
  [runtime-orchestration.md](./runtime-orchestration.md) describe the maintained
  product architecture around these choices.

## 中文

本记录用于满足 `task-002` 当前要求，说明 Canvast 在 UI 基础层、图与 Canvas
基础设施、以及语义/代码辅助能力上的开源优先采用情况。它是当前产品边界下的维护中
记录，用来说明哪些能力直接采用了成熟开源能力，哪些部分保留为 Canvast 自研实现，
以及原因是什么。

### 范围与验收边界

本记录只覆盖当前随产品分发或在公开文档中声明的依赖与实现边界。历史调研材料仍然是
重要证据，但它们不是当前采用状态的公开规范文档。

`task-002` 的验收目标是：

- 先评估成熟可复用方案，再决定是否自研；
- 已采用依赖具备清晰的许可证披露；
- 保留自研代码时，必须有明确的产品边界或能力缺口作为理由。

### 采用概览

| 领域 | 已采用依赖或来源 | 许可证 | 当前作用 | 采用或保留原因 |
| --- | --- | --- | --- | --- |
| 核心运行时循环 | `@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui` | MIT | 模型集成、agent 运行时与终端 UI 基础 | 复用已有维护中的运行时栈，而不是从零构建 agent loop 与 TUI 基础 |
| 结构化工具 schema | `@sinclair/typebox`、`typebox` | MIT | 工具与输入的结构化 schema | 复用类型化 schema 库，避免维护零散的自定义校验 |
| 时间解析 | `chrono-node` | MIT | 日期时间解析 | 复用成熟解析器，避免自写自然语言时间解析 |
| PDF 解析 | `pdf-parse` | Apache-2.0 | PDF 文本提取 | 复用现成解析边界，避免引入自定义 PDF 解码 |
| Canvas 图模型 | Canvast 自有 JSON 图持久化与遍历 | 项目代码 Apache-2.0 | 持久化 File/Plan/Decision/AgentRun 图与作用域遍历 | 当前产品图模型小而明确，采用有界自定义图层即可，不需要额外引入数据库产品 |
| Canvas 导出可视化 | 静态 SVG 与 HTML 导出，HTML 可选引用 `d3` | `d3` 为 ISC | 生成可分享的 Canvas 导出产物 | 导出路径是产品特有能力；HTML 使用固定版本前端库，SVG 保持完全离线 |
| 仓库结构扫描 | `canvas_repomap`，并参考 aider repo-map 调研 | Canvast 项目代码；aider 为参考来源 | 为 Canvas 与 agent 提供有界的仓库结构摘要 | 当前需求是结构感知而不是完整语义索引，轻量结构扫描已满足产品边界 |
| 代码辅助 | `lsp` fallback 工具 | Canvast 项目代码 | 有界 definition/reference/search 与 hover fallback | 当前能力刻意保持有限且无 shell，明确文档边界而不虚报完整 LSP 传输能力 |

### 已采用的基础层

Canvast 不是从零开始实现的 agent shell。它采用 Pi 运行时家族作为执行基础，再在其上
叠加 Canvast 自己的产品身份、Canvas、连续性、运行时策略以及面向用户的 UI 行为。
这样做的目标，是把工程工作集中在 Canvast 特有的项目治理与状态管理能力上，而不是重复
建设基础 agent loop、provider 传输和终端 UI。

当前直接运行时依赖及其许可证披露维护在
[THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) 中。根据当前 `package.json`
与清单，直接运行时依赖包括：

- `@earendil-works/pi-ai` — MIT
- `@earendil-works/pi-coding-agent` — MIT
- `@earendil-works/pi-tui` — MIT
- `@sinclair/typebox` — MIT
- `chrono-node` — MIT
- `pdf-parse` — Apache-2.0
- `typebox` — MIT

### 图与 Canvas 基础设施

Canvast 保持了一个小而明确的图词汇表：四类节点（`File`、`Plan`、`Decision`、
`AgentRun`）和四类 typed edge。当前实现把这张图持久化为 JSON，并围绕当前任务做
有界遍历。

这并不是在宣称“没有图数据库可用”，而是当前产品边界下的工程选择：图模型本地优先、
范围受控，并且和 Canvast 的任务作用域、导出与来源语义紧密耦合。现阶段并不需要为了
满足当前产品需求而引入更重的嵌入式或服务式图数据库。

在可视化导出层面，产品依然遵循开源优先：

- 生成的 HTML 可以使用固定版本的 `d3` 做交互浏览；
- 生成的 SVG 保持完全独立、无脚本依赖；
- JSON、Markdown、Mermaid、SVG、HTML 五种导出格式共享同一份持久图契约。

### 语义与代码辅助边界

Canvast 当前并不宣称提供完整语义索引，也不宣称已经具备完整的 language server 传输
能力。

当前实际公开边界更窄：

- `canvas_repomap` 是有界结构扫描，符号提取基于 regex fallback；
- `lsp` 是有界、无 shell 的 fallback helper，可提供 definition、references、
  document symbols、workspace symbols 和受限 hover；
- hover 路径明确是信息性 fallback 文本，而不是“已经接入实时语义 hover”的承诺。

这是有意保留的产品边界。Canvast 先采用轻量、成熟、可复用的开源运行时基础；只有在
任务作用域、本地持久化以及公开能力边界需要明确表达时，才保留 Canvast 自有实现。

### 证据来源

- `release/source-manifest.json` 记录了随附本记录的逐字节冻结源码快照，
  `release/public-tree-manifest.json` 记录了由其派生的已发布目录树。
- `THIRD_PARTY_NOTICES.md` 是当前 npm 依赖的维护中许可证清单；其机器校验区块
  由 `package-lock.json` 重新生成。
- `package.json` 是直接依赖与已分发 package 内容的权威来源。
- `docs/EFFECTIVENESS_EVIDENCE.md` 记录了围绕这些采用选择的产品结果配对评估证据。
- `docs/architecture/overview.md`、
  [canvas-and-traceability.md](./canvas-and-traceability.md) 和
  [runtime-orchestration.md](./runtime-orchestration.md) 描述了围绕这些选择的当前产品架构。
