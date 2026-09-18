# Runtime Orchestration / 运行时编排

Canvast uses one primary runtime owner for a project request and keeps execution bounded when work is delegated. The orchestrator evaluates the task, establishes plan and policy state, selects direct tools, workflows, or delegated child work, and publishes a persisted status projection to terminal and macOS clients. The UI reads and controls supported product actions, but it is not the execution authority.

Canvast 为项目请求使用一个主运行时所有者，并在委派工作时保持执行边界。编排器评估任务、建立计划与策略状态、选择直接工具、workflow 或委派子任务，并向终端和 macOS 客户端发布持久化状态投影。UI 负责读取状态并发起受支持的产品操作，但它不是执行权威。

## Identity at every turn / 每个 turn 的身份

Before every supported agent turn begins, the runtime applies the same Canvast product identity. CLI startup, continuity restoration, lifecycle fallback, and delegated execution all share that contract. If the identity marker is already present, it is not duplicated. User-facing agents identify as Canvast; implementation-specific runtimes remain an internal execution detail.

每个受支持的 agent turn 开始前，运行时都会应用同一份 Canvast 产品身份。CLI 启动、连续性恢复、生命周期兜底和委派执行共享这一合同；若身份标记已经存在，则不会重复写入。面向用户的代理统一以 Canvast 自称；底层运行时实现仍属于内部执行细节。

## Control flow / 控制流

1. The entry layer establishes product identity, project root, request identity, and continuity state.
2. `before_agent_start` assembles bounded Canvas scope, recalled pointers, and current constraints.
3. The orchestrator chooses direct execution, a workflow, or delegated child work and records the choice.
4. Tool-call hooks enforce plan scope, permissions, structured approval decisions, grounding scope, and resource admission before side effects.
5. Tool-result hooks redact credentials and cap, summarize, or spill oversized output while retaining a reference.
6. Completion, failure, cancellation, and shutdown update persisted state exactly once and release owned resources.

1. 入口层建立产品身份、项目根目录、请求身份与连续性状态。
2. `before_agent_start` 组装有界 Canvas 范围、召回指针和当前约束。
3. 编排器选择直接执行、workflow 或委派子进程工作，并记录选择。
4. 工具调用 hook 在副作用发生前执行计划范围、权限、结构化审批、grounding 范围和资源准入。
5. 工具结果 hook 清理凭据，对过大输出进行截断、摘要或落盘，同时保留引用。
6. 完成、失败、取消和关机都只终结一次持久状态，并释放所拥有的资源。

## Delegated work model / 委派工作模型

When Canvast delegates work, the delegated unit runs with bounded scope and independently owned execution state. Delegation is used for concrete, separable work that can return a bounded result without widening the parent request.

当 Canvast 委派工作时，被委派单元会在有边界的范围内运行，并拥有独立的执行状态。委派只用于可以返回有界结果、且不会扩大父请求范围的具体可分离任务。

Each delegated unit receives a narrowly stated task, isolated execution state, and a parent-controlled result path. The parent remains responsible for admission, timeout, cancellation, result collection, and finalization. Delegation does not expand permissions, approval scope, evidence budgets, or plan scope.

每个委派单元都会收到边界明确的任务、隔离的执行状态，以及由父运行时控制的结果返回路径。父运行时仍负责准入、超时、取消、结果收集与终结。委派不会扩大权限、审批范围、证据预算或计划范围。

## Direct tools, workflows, and delegated work / 直接工具、workflow 与委派工作

- Use a **direct tool** for one bounded operation whose inputs, side effects, and result belong to the current turn.
- Use a **workflow** when stages are ordered, share state, need checkpoints, or require repeatable recovery behavior. Stages that can affect the same mutable state remain serialized by the workflow owner.
- Use **delegated work** when a unit has a concrete independent deliverable, can run with isolated context and ownership, and can return a bounded result. Delegation does not replace a workflow's ordered state machine.
- Parallel delegated work is permitted only for genuinely independent local work. Canvast does not use parallel external-API scanning as a substitute for grounded retrieval.
- Neither a workflow nor delegated work may bypass plan scope, permissions, approval, source identity, evidence exhaustion, or lifecycle cleanup.

- 对于输入、副作用和结果都属于当前 turn 的单个有界操作，使用**直接工具**。
- 当阶段有顺序、共享状态、需要检查点，或需要可重复的恢复行为时，使用 **workflow**。可能影响同一可变状态的阶段由 workflow 所有者串行执行。
- 当委派单元具有具体且独立的交付物、可在隔离上下文和所有权下运行、并能返回有界结果时，使用**委派工作**。委派不能替代 workflow 的有序状态机。
- 只有真正独立的本地工作才允许并行委派。Canvast 不会用并行外部 API 扫描替代受约束的事实取证。
- workflow 和委派工作都不得绕过计划范围、权限、审批、来源身份、证据预算耗尽或生命周期清理。

### Sidecar dispatch policy / Sidecar 调度策略

Ordinary follow-up work is first routed as structured request state; wording alone does not decide dispatch. Serial control operations such as `status`, `pause`, `redirect`, and `task_adjustment` remain serialized. A sidecar is delegated only when recorded typed evidence shows that branches are independently bounded, do not compete for the same mutable state, and fit within current capacity and policy budgets. Unknown evidence fails closed to serial execution.

普通追问首先以结构化 request state 路由；系统不会仅根据措辞决定调度方式。`status`、`pause`、`redirect` 与 `task_adjustment` 等串行控制操作保持串行。只有在已记录的类型化证据证明分支相互独立、有明确边界、不会竞争同一可变状态，且满足当前容量与策略预算时，sidecar 才会被委派；证据未知时按安全失败处理为串行执行。

Serial here means the sidecar runs while the primary request is suspended and then returns control to the primary flow. Parallel sidecars are allowed only for genuinely independent read-only work with bounded ownership and explicit admission checks. If safe work temporarily lacks capacity or budget, it is deferred rather than silently folded back into the parent request.

这里的串行是指先暂停 primary 请求、执行 sidecar、再把控制权返回主流程。只有真正独立、只读、所有权明确且通过显式准入检查的工作才允许并行 sidecar。若安全工作暂时缺少容量或预算，则进入延后状态，而不是静默回退到父请求中执行。

## Persisted runtime-status contract / 持久化运行状态合同

Runtime status is a versioned projection, not a command channel. A compatible snapshot contains at least these top-level fields:

运行状态是带版本的投影，不是命令通道。兼容快照至少包含以下顶层字段：

| Plane / 字段 | Minimum meaning / 最小含义 |
| --- | --- |
| `version`, `updatedAt`, `language` | Schema version, projection freshness, and presentation locale. / Schema 版本、投影新鲜度与展示语言。 |
| `tasks`, `plans` | Active and recent task/plan lifecycle items. / 当前及近期任务、计划的生命周期条目。 |
| `subAgents`, `workflows`, `toolRuns` | Delegated, staged, and tool execution state. / 委派、分阶段与工具执行状态。 |
| `model`, `tokens`, `attachments` | Reported model capability, measured usage, and bounded output references. / 已报告的模型能力、测量用量与有界输出引用。 |
| `permission`, `approvalReviews` | Effective permission mode and structured approval evidence. / 生效权限模式与结构化审批证据。 |
| `inputQueue`, `requests` | Queued input and correlated request lifecycle. / 排队输入与可关联请求生命周期。 |
| `continuity` | Compaction, restore, branch, and recovery projection. / 压缩、恢复、分支与恢复投影。 |
| `events` | Bounded, attributable runtime events. / 有界且可归属的运行事件。 |

Additive fields may evolve behind the version contract, but producers must not silently omit a required plane. Persisted status may use a documented zero where its numeric schema requires one; renderers must otherwise show unavailable data as unknown. Elapsed time, token counts, context capacity, and cost are displayed only when measured or supplied by an authoritative runtime source—never fabricated or extrapolated and presented as fact.

可在版本合同下增加字段，但生产者不得静默省略必需 plane。若持久化数值 schema 明确要求零值，可以写零；除此之外，渲染器必须把不可用数据展示为 unknown。耗时、token 数、上下文容量和成本仅在运行时权威来源实际测量或提供时展示，绝不捏造或外推后冒充事实。

While work is active, status-bearing TUI surfaces refresh at a one-second cadence. Header, active runtime widget, and footer have distinct ownership and must not repeat the same task, model, token, or status line. Inactive views may refresh on events. The macOS App reads the same projection and sends supported mutations through correlated, versioned typed actions rather than editing persisted status.

工作处于 active 状态时，承载状态的 TUI 界面按一秒节奏刷新。Header、当前运行 widget 与 footer 各有独立职责，不得重复同一任务、模型、token 或状态行。非活动界面可以按事件刷新。macOS App 读取同一投影，并通过可关联、带版本的类型化 action 发起受支持的变更，而不是编辑持久状态。

## Structured approval / 结构化审批

Approval is durable evidence, not inferred from prose. Before a gated side effect, an approval decision contains these required fields:

审批是持久证据，不能从自然语言中猜测。受控副作用发生前，审批决定包含以下必需字段：

- `tool`
- `decision`: `approved`, `needs_user`, or `blocked`
- `risk`: `low`, `medium`, `high`, or `critical`
- `authorization`: `none`, `low`, `medium`, or `high`
- `rationale`

`inputSummary` and `categories` are optional. Persisted records additionally carry `id`, `timestamp`, and `source` so a decision can be audited and deduplicated. Only an `approved` record with sufficient authorization permits the exact reviewed action; a changed target or materially changed input requires a new review. `needs_user` and `blocked` remain visible states and are never silently upgraded.

`inputSummary` 与 `categories` 可选。持久记录还包含 `id`、`timestamp` 和 `source`，以便审计与去重。只有授权充分的 `approved` 记录才能允许被精确审查过的 action；目标或输入发生实质变化时必须重新审批。`needs_user` 和 `blocked` 始终保持可见，不能被静默升级。

## Grounding and exact-source identity / 事实取证与精确来源身份

Before answering a claim whose correctness depends on current or exact external facts, Canvast creates a typed grounding strategy: facts to verify, freshness, acceptable and preferred source kinds, minimum corroboration, unavailable-source behavior, correction policy, and an optional external-call limit. General model memory is not sufficient to choose an exact source.

当结论依赖当前事实或精确外部事实时，Canvast 在回答前创建类型化 grounding strategy：待验证事实、新鲜度、可接受及优先来源类型、最小交叉验证、来源不可用行为、纠正策略，以及可选的外部调用上限。通用模型记忆不足以决定精确来源。

For exact-source work, identity fields are declared before retrieval—for example jurisdiction, date or year, document/version, clause or question identifier, product model, release tag, authorization entity, or route endpoints. Primary or official material is preferred. When it is unavailable, the answer uses a reputable complete source plus independent corroboration where possible. If identity or required conditions remain unverified, the response states that boundary instead of silently selecting a likely source.

对于精确来源任务，必须在检索前声明身份字段，例如司法辖区、日期或年份、文档/版本、条款或题号、产品型号、release tag、授权主体或路线端点。优先使用一手或官方材料；若不可用，则尽可能使用可信完整来源并进行独立交叉验证。若身份或必要条件仍未核实，回答必须说明边界，不能静默选择“可能正确”的来源。

Evidence accounting is keyed by `grounding_scope`, not by the whole chat session. Follow-ups within the same factual task reuse its scope; an unrelated factual task receives independent scope-local call, time, and error accounting. When a turn explicitly supplies `grounding_strategy.max_external_calls`, however, that value is a fixed turn-wide ceiling shared across scopes: changing scope or later increasing the value cannot multiply or enlarge it. A later call cannot enlarge an already established scope by mutating its limit. User corrections invalidate the affected evidence and conclusion for future use and trigger the declared correction policy, such as retract-and-reverify or preferring newer authority.

证据记账以 `grounding_scope` 为键，而不是整个聊天 session。相同事实任务的追问复用其 scope；无关事实任务获得独立的 scope 级调用、时间与错误记账。但当一个 turn 显式提供 `grounding_strategy.max_external_calls` 时，该值是所有 scope 共享的固定 turn 级上限；切换 scope 或在后续调高数值都不能使其倍增或扩大。后续调用也不能通过修改上限扩大已建立的 scope。用户纠正会使受影响证据和结论在后续使用中失效，并触发已声明的纠正策略，例如撤回后重查或优先采用更新的权威来源。

When a grounding scope is exhausted, dedicated source tools stop for that scope and the answer reports verified and unverified boundaries. The orchestrator must not route around exhaustion with shell networking, `curl`, a workflow, or a sub-agent, and it must not launch parallel external-API scans.

当某个 grounding scope 耗尽时，专用来源工具停止该 scope 的检索，回答说明已验证与未验证边界。编排器不得通过 shell 网络命令、`curl`、workflow 或子代理绕过耗尽状态，也不得启动并行外部 API 扫描。

## Process lifecycle contract / 进程生命周期合同

The component that launches a process is its lifecycle owner. It records ownership before execution, uses a separately addressable process group, and keeps output and diagnostic evidence bounded. Normal completion, launch failure, timeout, cancellation, parent failure, and product shutdown all converge on idempotent finalization. Cancellation and timeout attempt graceful group termination first, escalate to forced termination when required, reap the child, close streams, and persist the terminal state. Shutdown stops admission and drains or terminates owned work; it must not leave an orphaned child or duplicate final event.

启动进程的组件就是其生命周期所有者。它在执行前记录所有权，使用可单独寻址的进程组，并限制输出与诊断证据。正常完成、启动失败、超时、取消、父进程失败和产品关机最终都汇合到幂等终结。取消与超时先尝试优雅终止整个进程组，必要时升级为强制终止，随后回收子进程、关闭流并持久化终态。关机时停止准入，并排空或终止所拥有的工作；不得遗留孤儿进程或重复终结事件。

Watchdog and health evidence must be based on current, identity-verified samples; unknown lifecycle state fails safe. Implementation-specific caps, watchdog mechanics, failure analysis, and prevention checks may change without changing this contract.

Watchdog 与健康证据必须来自当前且身份已核验的采样；生命周期状态未知时按安全失败处理。具体上限、watchdog 机制、故障分析与预防检查可以变化，而不改变本合同。
