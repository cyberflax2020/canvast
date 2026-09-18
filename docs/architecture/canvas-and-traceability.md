# Canvas and Traceability / Canvas 与可追溯性

The Canvas is a durable, task-scoped project map. It does not replace source files, recent conversation, or the runtime state machine. It gives users and agents bounded answers to four questions: what work is active, which files are in scope, why a decision exists, and which run produced an artifact.

Canvas 是持久化、按任务确定范围的项目地图。它不替代源文件、近期对话或运行时状态机，而是为用户和代理提供有界答案：当前在做什么、哪些文件在范围内、某项决策为何存在、某个产物由哪次运行生成。

## Closed graph vocabulary / 封闭的图词汇表

The stable schema has exactly four node types. A task is represented through a Plan and its decomposition; it is not a fifth node type.

稳定 schema 恰好只有四类节点。任务通过 Plan 及其分解来表示，不增加第五种 Task 节点。

| Node / 节点 | Meaning / 含义 |
| --- | --- |
| File | A source or artifact reference; the file itself remains authoritative. / 源文件或产物引用；文件本身仍是权威来源。 |
| Plan | Intended work, task scope, or an executable decomposition. / 计划工作、任务范围或可执行分解。 |
| Decision | A durable choice with rationale and provenance. / 带依据与来源的持久决策。 |
| AgentRun | An attributable execution record, including delegated work. / 可归属的执行记录，包括委派工作。 |

The stable schema also has exactly four directed edge types.

稳定 schema 也恰好只有四类有向边。

| Edge / 边 | Contract / 合同 |
| --- | --- |
| `MOTIVATED_BY` | Connects a plan or change to the decision or evidence that justifies it. / 将计划或变更连接到支撑它的决策或证据。 |
| `PRODUCED_BY` | Connects an artifact to the run that produced it. / 将产物连接到生成它的运行。 |
| `DECOMPOSES_INTO` | Connects a plan to narrower plans, decisions, or work units. / 将计划连接到更细的计划、决策或工作单元。 |
| `EXECUTED_BY` | Connects planned work to the run responsible for execution. / 将计划工作连接到负责执行的运行。 |

Consumers must not invent node or edge kinds to encode transient UI state. Schema evolution requires an explicit migration rather than silently accepting an expanded vocabulary.

消费者不得为了编码临时 UI 状态而创造新的节点或边类型。Schema 演进必须经过显式迁移，不能静默扩展词汇表。

## Scope, persistence, and provenance / 范围、持久化与来源

For an active Plan, the scoping layer performs bounded traversal across its decisions, files, decomposition, and AgentRuns, ranks relevant nodes, and serializes a task view. File contents are loaded separately and only when needed, so the graph remains structural instead of becoming another repository copy. Scope is explicit runtime state: ordinary graph browsing does not change it, while a named task or plan-selection action may do so.

对于当前 Plan，范围层会在相关决策、文件、分解和 AgentRun 之间进行有界遍历，对节点排序，并序列化任务视图。文件内容在确有需要时单独读取，使图保持结构化而不成为仓库副本。范围是显式运行状态：普通浏览不会修改范围，只有明确命名的任务或计划选择 action 才可以修改。

Canvas state is persisted as JSON and written atomically. Each persisted relation must retain enough identity to trace an artifact to its producing run, its executing plan, and the motivating decision or evidence where those relations exist. Export and import preserve this vocabulary and provenance; they do not turn stale metadata into current truth.

Canvas 状态以 JSON 持久化并原子写入。每条持久关系都应保留足够身份信息，以便在关系存在时把产物追溯到生成运行、执行计划以及作为动机的决策或证据。导入导出保留该词汇表和来源关系，但不会把过期元数据变成当前事实。

## Staleness and conflict handling / 过期与冲突处理

Persisted graph state can lag behind source changes. File checksums and source metadata are used to detect that condition. A stale node keeps its provenance but is marked or presented as uncertain; consumers re-read the source before making a side effect. Source content wins over a stale graph summary.

持久化图状态可能落后于源文件。系统使用文件校验和与来源元数据检测这种情况。过期节点保留来源，但必须被标记或展示为不确定；消费者在产生副作用前重新读取源文件。源文件内容优先于过期的图摘要。

Updates with different provenance or incompatible values must remain distinguishable. Canvast may deduplicate identical records and pointers, but it must not silently overwrite a conflict and present the result as settled. Supersession, correction, pruning, and recovery are visible state transitions.

来源不同或取值不兼容的更新必须保持可区分。Canvast 可以去重相同记录和指针，但不得静默覆盖冲突后把结果展示为已确定。替代、纠正、裁剪与恢复都必须是用户可见的状态变化。

## Governed long-term memory / 受治理的长期记忆

Canvas provenance and context recall are complementary. The Canvas stores project relationships; context recall stores compact continuity records and source pointers. Durable memory follows these rules:

Canvas 来源图与上下文召回互为补充：Canvas 保存项目关系，上下文召回保存紧凑的连续性记录与来源指针。长期记忆遵循以下规则：

- **Provenance first.** A durable recollection identifies its source session, file, record, or managed excerpt closely enough for inspection. A summary without a recoverable origin is not authoritative memory.
- **Pointer first.** Retrieval starts from bounded summaries and pointers, opens a managed excerpt only when useful, and reads the original session JSONL or source file only when required.
- **Deduplication.** Equivalent records and equivalent source pointers are deduplicated so repeated compaction or ingestion does not amplify context.
- **Visible updates.** A correction or conflicting observation invalidates the affected conclusion for future recall until it is re-verified or explicitly reconciled. The old provenance is retained where policy permits.
- **Bounded retention.** Hot records, archives, excerpts, and total storage have configurable bounds. Overflow is archived or pruned deliberately; it is never allowed to grow without limit.
- **Recoverable pruning.** Archive manifests, tombstones or retained pointers, warnings, and a recovery plan explain what moved or was removed and how continuity can be restored.

- **来源优先。** 持久记忆必须能定位到来源会话、文件、记录或受管摘录，以便检查。无法恢复来源的摘要不是权威记忆。
- **指针优先。** 检索先读取有界摘要与指针，仅在有帮助时打开受管摘录，只有确有必要才读取原始 session JSONL 或源文件。
- **去重。** 等价记录和等价来源指针需要去重，避免重复压缩或摄取不断放大上下文。
- **更新可见。** 用户纠正或冲突观察会使受影响结论在后续召回中失效，直至重新核验或显式协调；策略允许时保留旧来源。
- **有界保留。** 热记录、归档、摘录和总存储均受可配置边界约束。溢出内容应被有意归档或裁剪，不得无限增长。
- **可恢复裁剪。** 归档清单、墓碑或保留指针、警告和恢复计划要说明哪些内容被移动或移除，以及如何恢复连续性。

The persisted recall family is a stable recovery surface:

持久化召回文件族是稳定的恢复界面：

- `context-recall/index.json` contains the bounded active recall index and source pointers.
- `context-recall/archive-index.json` identifies archived recall material.
- `context-recall/recovery-plan.json` records actionable recovery information when continuity requires repair.
- Original session JSONL and optional managed excerpt files remain the referenced evidence behind those indexes.

- `context-recall/index.json` 保存有界的当前召回索引和来源指针。
- `context-recall/archive-index.json` 标识已归档的召回材料。
- `context-recall/recovery-plan.json` 在连续性需要修复时记录可执行的恢复信息。
- 原始 session JSONL 与可选的受管摘录文件仍是这些索引所指向的底层证据。

Compaction, resume, and fork restore the active task identity, scope, unresolved work, and evidence pointers without pretending to reconstruct unavailable dialogue. Continuation records are deduplicated. Reset starts a clean continuity boundary rather than silently merging prior state. If required records cannot be restored, the failure and recovery path must be visible.

压缩、恢复和 fork 会恢复当前任务身份、范围、未完成工作和证据指针，但不会假装重建不存在的对话。Continuation 记录必须去重；reset 建立干净的连续性边界，而不是静默合并旧状态。若必要记录无法恢复，失败及恢复路径必须可见。

## Large-graph interaction contract / 大图交互合同

Large graphs open with a bounded overview, not an unbounded wall of nodes. The shared interaction model must provide:

大图首先展示有界总览，而不是无界节点墙。共享交互模型必须提供：

- an overview of layers, types, counts, and the active task before details;
- focus on a node's bounded incoming and outgoing neighborhood;
- search, type filters, pagination or result limits, and branch/layer fold or collapse;
- a persistent visual anchor for the active task and an explicit **Return to current task** action after exploration;
- clear stale, uncertain, selected, and active states; and
- local exploration that remains read-only unless the user invokes an explicitly named scope-changing action.

- 先展示层级、类型、数量和当前任务，再展示细节；
- 聚焦某节点的有界入边与出边邻域；
- 支持搜索、类型过滤、分页或结果上限，以及分支/层级折叠；
- 始终保留当前任务的视觉锚点，并在探索后提供明确的 **返回当前任务** action；
- 清晰区分过期、不确定、已选择和当前状态；
- 局部探索保持只读，除非用户调用明确命名的范围变更 action。

Surfaces may implement different controls, but they must preserve these semantics. The TUI and App inspect the same persisted model; clicks, focus changes, filters, folding, and refresh do not themselves edit the graph. Canvas export remains a product capability covered by the canonical [User Manual](../guides/user-manual.md).

不同界面可以使用不同控件，但必须保持上述语义。TUI 与 App 检查同一份持久化模型；点击、聚焦、过滤、折叠和刷新本身都不会编辑图。Canvas 导出仍是产品能力，并由 canonical [用户手册](../guides/user-manual.md) 覆盖。
