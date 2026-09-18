# Canvast Changelog / 变更日志

This public changelog includes only user-visible product changes in the public Canvast experience.
公开版变更日志仅保留 Canvast 对外产品体验中用户可见的变更。

## [0.1.0] — 2026-09-18

First public release. / 首个公开发布版本。

### Added / 新增
- Terminal workspace (TUI) with project-scoped sessions, resume inspection and claim flows, visible request receipts, input queue, request lifecycle, tool runs, runtime events, and approval history.
- 终端工作空间（TUI）：项目级 session、resume 检查与领取流程，以及可见的 request receipt、input queue、request lifecycle、tool runs、runtime events 与 approval history。
- Native SwiftUI macOS App bringing project navigation, recent conversations, resumable work, runtime activity, permissions, plans, and Canvas views into one workspace.
- 原生 SwiftUI macOS App：将项目导航、最近对话、任务恢复、运行活动、权限、计划与 Canvas 视图整合到同一个工作空间中。
- Persistent project Canvas with File, Plan, Decision, and AgentRun nodes, typed links, scoped task and plan selection, and export to JSON, Markdown, Mermaid, SVG, and interactive HTML.
- 持久化项目 Canvas：File、Plan、Decision、AgentRun 节点与 typed link，作用域 task 与 plan 选择，并支持导出 JSON、Markdown、Mermaid、SVG 与交互式 HTML。
- Safety and permission profiles (`read-only`, `workspace-write`, `full-access`) with typed sandbox inspect, profile, grant, and revoke actions recorded with rationale.
- 安全与权限 profile（`read-only`、`workspace-write`、`full-access`），以及带记录理由的 typed sandbox inspect、profile、grant、revoke 操作。
- Published paired-evaluation evidence against Claude Code as the reference toolchain, with machine-checked README evidence blocks and a documented effectiveness boundary.
- 公开以 Claude Code 为参考工具链的配对评估证据，README 证据区块由机器校验，并附有明确的有效性边界说明。

### Changed / 变更
- Long-running work now shows clearer preparing, queued, running, waiting, completion, cancellation, retry, and recovery states.
- 长时间运行的工作现在提供更清晰的准备、排队、运行、等待、完成、取消、重试与恢复状态。

### Known issues / 已知问题
- In the published paired evaluation, Canvast's median run latency is higher than the reference toolchain's; the exact measured values are disclosed in `docs/EFFECTIVENESS_EVIDENCE.md` and the README evidence block, and the overhead is recorded as an optimization target for upcoming releases.
- 在已发布的配对评估中，Canvast 的中位运行时长高于参考工具链；具体测量值已在 `docs/EFFECTIVENESS_EVIDENCE.md` 与 README 证据区块中公开，该开销已记录为后续版本的优化目标。
