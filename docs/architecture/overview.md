# Architecture Overview / 架构总览

Canvast is the user-visible product and project-governance layer built around the Pi coding-agent runtime. Pi is an implementation and process boundary; it is not the product identity shown to users or delegated agents. Canvast combines a persistent project graph, governed context recall, runtime policy, isolated delegation, and shared status projections so long-running work remains attributable and recoverable.

Canvast 是面向用户的产品，也是构建在 Pi coding-agent runtime 之上的项目治理层。Pi 是实现与进程边界，不是展示给用户或委派代理的产品身份。Canvast 将持久化项目图、受治理的上下文召回、运行时策略、隔离委派和共享状态投影结合起来，使长期任务保持可追溯、可恢复。

## Product identity / 产品身份

Every supported agent-turn start path must apply the same Canvast identity contract before work begins. This includes main-session startup, harness entry paths, lifecycle fallbacks, resumed or compacted turns, and delegated-agent launch. Identity injection is marker-guarded and idempotent: composing multiple entry paths must not duplicate or weaken the contract. If continuity restores a turn without the marker, the runtime reapplies it.

每一条受支持的 agent-turn 启动路径都必须在工作开始前应用同一份 Canvast 身份合同，包括主会话启动、harness 入口、生命周期兜底、恢复或压缩后的 turn，以及委派代理启动。身份注入由标记保护并保持幂等：多条入口路径叠加时不得重复或削弱合同；若连续性恢复后缺少标记，运行时必须重新补充。

Product-facing UI, prompts, reports, and delegated-task context use the Canvast name and behavior contract. Pi may be named only where the underlying executable, compatibility surface, or child-process boundary is technically relevant.

面向用户的 UI、提示、报告和委派任务上下文都使用 Canvast 名称与行为合同。只有在说明底层可执行程序、兼容层或子进程边界确有必要时，才使用 Pi 名称。

## Architectural layers / 架构分层

1. **Entry and identity.** The CLI and product extensions establish the Canvast identity, project root, session mode, and supported UI surface.
2. **Canvas and scope.** A persistent graph records project structure and provenance. Bounded traversal assembles only the plans, decisions, files, and prior runs relevant to the current task.
3. **Harness and policy.** Structured controls govern plan scope, permissions, approvals, grounding, output handling, context continuity, and resource admission.
4. **Execution and delegation.** The primary runtime owns execution. Delegated work runs in bounded, independent Pi child processes with isolated data ownership; workflows coordinate ordered multi-stage work.
5. **Durable runtime state.** Canvas state, context-recall indexes, runtime status, and lifecycle evidence are persisted locally with explicit retention and recovery behavior.
6. **Presentation.** The TUI and macOS App consume shared Canvas and runtime-status projections. UI projections do not own the execution state machine, and mutations travel through explicit typed actions.

1. **入口与身份。** CLI 和产品扩展建立 Canvast 身份、项目根目录、会话模式和受支持的 UI 界面。
2. **Canvas 与范围。** 持久化图记录项目结构和来源；有界遍历只组装与当前任务相关的计划、决策、文件和历史运行。
3. **Harness 与策略。** 结构化控制负责计划范围、权限、审批、事实取证、输出处理、上下文连续性和资源准入。
4. **执行与委派。** 主运行时拥有执行权；委派工作在有界、相互独立且数据隔离的 Pi 子进程中运行，workflow 用于编排有顺序的多阶段工作。
5. **持久运行状态。** Canvas 状态、上下文召回索引、运行状态和生命周期证据在本地持久化，并具有明确的保留与恢复行为。
6. **展示层。** TUI 与 macOS App 消费共享的 Canvas 和运行状态投影。UI 投影不拥有执行状态机；变更必须通过显式的类型化 action 传递。

## Core graph model / 核心图模型

The Canvas has exactly four node types—File, Plan, Decision, and AgentRun—and four edge types: `MOTIVATED_BY`, `PRODUCED_BY`, `DECOMPOSES_INTO`, and `EXECUTED_BY`. It is persisted as JSON and scoped per active task. Conversation history remains useful for recent dialogue, while governed context recall supplies durable, pointer-backed memory; neither replaces source files as the authority for current code.

Canvas 恰好包含四类节点——File、Plan、Decision、AgentRun——以及四类边：`MOTIVATED_BY`、`PRODUCED_BY`、`DECOMPOSES_INTO`、`EXECUTED_BY`。图以 JSON 持久化，并按当前任务确定范围。对话历史仍用于近期交流，受治理的上下文召回提供带来源指针的长期记忆；二者都不能替代源文件作为当前代码的权威依据。

Large tool results are spilled to local runtime storage and represented in model context by bounded previews and references. Context recall follows the same pointer-first principle instead of loading unbounded history into a prompt.

大型工具结果写入本地运行时存储，在模型上下文中仅保留有界预览和引用。上下文召回遵循同样的“指针优先”原则，不把无界历史整体塞入提示。

## System-wide invariants / 全局不变量

- File-changing tools remain inside explicit plan scope; permissions and approvals are structured runtime state, not prompt-only suggestions.
- Persisted knowledge retains provenance, exposes stale or conflicting state, deduplicates repeated records, and has bounded retention plus visible recovery behavior.
- Exact-source factual work declares source identity and a task-scoped evidence budget. Budget exhaustion cannot be bypassed through shell or ad hoc network commands.
- The runtime admits at most one heavy task at a time and never performs parallel external-API scanning. Independent local work may be parallelized only within configured bounds.
- Sub-agent ownership, output, timeout, cancellation, finalization, and shutdown cleanup are bounded even when implementation limits change.
- Time and token displays come from measured or supplied data. Missing values stay visibly unavailable (or use a documented zero required by the persisted schema); estimates are never presented as facts.
- Runtime, credential, cache, report, and build artifacts remain outside the public release allowlist.

- 文件修改工具必须处于显式计划范围内；权限与审批是结构化运行状态，而不是只存在于提示中的建议。
- 持久知识必须保留来源、暴露过期或冲突状态、去重重复记录，并具有有界保留和可见恢复行为。
- 依赖精确来源的事实任务必须声明来源身份和任务级证据预算；预算耗尽后不得通过 shell 或临时网络命令绕过。
- 运行时同一时间最多接纳一个重任务，且不得并行扫描外部 API。只有相互独立的本地工作可以在配置上限内并行。
- 即使实现限额调整，子代理的所有权、输出、超时、取消、终结与关机清理仍必须有界。
- 时间和 token 只显示测量值或上游提供值。缺失值应明确显示为不可用（或使用持久化 schema 明文要求的零值），不得把估算伪装成事实。
- 运行时、凭据、缓存、报告和构建产物均不得进入公开发布白名单。

See [Canvas and traceability](canvas-and-traceability.md) for graph, memory, and large-graph interaction contracts; [runtime orchestration](runtime-orchestration.md) for process, status, approval, workflow, and grounding contracts; and the canonical [User Manual](../guides/user-manual.md) for supported behavior.

图、记忆和大图交互合同见 [Canvas 与可追溯性](canvas-and-traceability.md)；进程、状态、审批、workflow 与事实取证合同见 [运行时编排](runtime-orchestration.md)；受支持的用户行为见 canonical [用户手册](../guides/user-manual.md)。
