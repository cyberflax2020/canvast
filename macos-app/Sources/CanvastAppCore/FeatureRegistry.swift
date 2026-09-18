import Foundation

public enum CanvastFeatureID: String, CaseIterable, Codable, Hashable {
  case chat
  case reasoningTrace
  case autoOrchestration
  case planMode
  case canvas
  case dynamicCanvas
  case taskTree
  case subAgents
  case workflow
  case dynamicWorkflow
  case tools
  case webResearch
  case context
  case sessions
  case askUser
  case sandbox
  case permissions
  case models
  case modelRegistry
  case lsp
  case notebooks
  case artifacts
  case cron
  case monitor
  case backgroundTasks
  case worktrees
  case git
  case mcp
  case codeReview
  case usage
  case closure
  case evaluation
  case packaging
  case safety
  case guiGuard
  case offscreenSnapshot
  case macApp
}

public struct CanvastFeature: Identifiable, Codable, Equatable {
  public let id: CanvastFeatureID
  public let title: String
  public let symbolName: String
  public let command: String?
  public let controlPlane: String
  public let detail: String
  public let isEnhanced: Bool
  public let isPrimary: Bool

  public init(
    id: CanvastFeatureID,
    title: String,
    symbolName: String,
    command: String?,
    controlPlane: String,
    detail: String,
    isEnhanced: Bool,
    isPrimary: Bool = false
  ) {
    self.id = id
    self.title = title
    self.symbolName = symbolName
    self.command = command
    self.controlPlane = controlPlane
    self.detail = detail
    self.isEnhanced = isEnhanced
    self.isPrimary = isPrimary
  }
}

public enum CanvastFeatureRegistry {
  public static let all: [CanvastFeature] = [
    .init(id: .chat, title: CanvastAppCoreLocalizer.text("Run", "运行"), symbolName: "terminal", command: "canvast.sh", controlPlane: "agent", detail: CanvastAppCoreLocalizer.text("Interactive and print-mode execution through the same local harness.", "通过同一套本地 harness 进行交互式与 print 模式执行。"), isEnhanced: false, isPrimary: true),
    .init(id: .reasoningTrace, title: CanvastAppCoreLocalizer.text("Reasoning Trace", "推理轨迹"), symbolName: "text.bubble", command: "auto_orchestration_decision", controlPlane: "orchestration", detail: CanvastAppCoreLocalizer.text("Visible reasoning summaries, tool strategy, and verification notes without exposing hidden chain-of-thought.", "展示可见的推理摘要、工具策略和验证说明，但不暴露隐藏思维链。"), isEnhanced: true, isPrimary: true),
    .init(id: .autoOrchestration, title: CanvastAppCoreLocalizer.text("Auto Orchestration", "自动编排"), symbolName: "wand.and.stars", command: "auto_orchestration_decision", controlPlane: "orchestration", detail: CanvastAppCoreLocalizer.text("Automatic plan, sub-agent, workflow, web, context, and verification decision gate.", "自动决策计划、子 Agent、工作流、Web、上下文和验证门禁。"), isEnhanced: true, isPrimary: true),
    .init(id: .planMode, title: CanvastAppCoreLocalizer.text("Plan", "计划"), symbolName: "checklist", command: "enter_plan_mode", controlPlane: "planning", detail: CanvastAppCoreLocalizer.text("Plan proposal, approval, scope constraints, amendments, and execution readiness.", "支持计划提议、批准、范围约束、修订和执行就绪检查。"), isEnhanced: true, isPrimary: true),
    .init(id: .canvas, title: CanvastAppCoreLocalizer.text("Canvas", "画布"), symbolName: "point.3.connected.trianglepath.dotted", command: "/canvast-canvas", controlPlane: "canvas", detail: CanvastAppCoreLocalizer.text("Graph state for files, plans, decisions, and agent runs.", "展示文件、计划、决策和 Agent 运行的图谱状态。"), isEnhanced: true, isPrimary: true),
    .init(id: .dynamicCanvas, title: CanvastAppCoreLocalizer.text("Dynamic Canvas", "动态画布"), symbolName: "arrow.triangle.2.circlepath", command: "canvas_record", controlPlane: "canvas", detail: CanvastAppCoreLocalizer.text("Live graph updates for scope, traceability, stale file detection, and recovery.", "实时更新范围、可追溯关系、过期文件检测和恢复信息。"), isEnhanced: true, isPrimary: true),
    .init(id: .taskTree, title: CanvastAppCoreLocalizer.text("Tasks", "任务"), symbolName: "list.bullet.indent", command: "/canvast-tasks", controlPlane: "planning", detail: CanvastAppCoreLocalizer.text("Task tree, dependencies, blockers, and plan/task adjustment.", "展示任务树、依赖、阻塞项以及计划/任务调整。"), isEnhanced: true, isPrimary: true),
    .init(id: .subAgents, title: CanvastAppCoreLocalizer.text("Agents", "Agent"), symbolName: "person.2", command: "/canvast-agents", controlPlane: "agent", detail: CanvastAppCoreLocalizer.text("Bounded sub-agent branches, isolated state, and result merge.", "支持受限子 Agent 分支、隔离状态和结果合并。"), isEnhanced: true, isPrimary: true),
    .init(id: .workflow, title: CanvastAppCoreLocalizer.text("Workflow", "工作流"), symbolName: "arrow.triangle.branch", command: "/canvast-workflow", controlPlane: "orchestration", detail: CanvastAppCoreLocalizer.text("Sequential, parallel, and DAG workflow entry.", "支持串行、并行和 DAG 工作流入口。"), isEnhanced: true, isPrimary: true),
    .init(id: .dynamicWorkflow, title: CanvastAppCoreLocalizer.text("Dynamic Workflow", "动态工作流"), symbolName: "flowchart", command: "run_workflow", controlPlane: "orchestration", detail: CanvastAppCoreLocalizer.text("Runtime workflow planning, bounded worker pools, cycle detection, and verification gates.", "支持运行时工作流规划、受限 worker 池、环检测和验证门禁。"), isEnhanced: true, isPrimary: true),
    .init(id: .tools, title: CanvastAppCoreLocalizer.text("Tools", "工具"), symbolName: "wrench.and.screwdriver", command: "/canvast-tools", controlPlane: "tools", detail: CanvastAppCoreLocalizer.text("Coordinated tool strategy for reads, writes, shell, tests, web, agents, workflow, and package steps.", "协调读写、Shell、测试、Web、Agent、工作流和打包阶段的工具策略。"), isEnhanced: false, isPrimary: true),
    .init(id: .webResearch, title: CanvastAppCoreLocalizer.text("Web", "Web"), symbolName: "network", command: "/canvast-web", controlPlane: "research", detail: CanvastAppCoreLocalizer.text("Current/external evidence search, fetch, research synthesis, source URLs, and domain filters.", "支持当前/外部证据搜索、抓取、研究总结、来源 URL 和域名过滤。"), isEnhanced: false, isPrimary: true),
    .init(id: .context, title: CanvastAppCoreLocalizer.text("Context", "上下文"), symbolName: "clock.arrow.circlepath", command: "/canvast-context", controlPlane: "memory", detail: CanvastAppCoreLocalizer.text("Compaction, recall, resume continuity, active task recovery, and cross-session state.", "支持压缩、召回、续接连续性、活动任务恢复和跨会话状态。"), isEnhanced: true, isPrimary: true),
    .init(id: .sessions, title: CanvastAppCoreLocalizer.text("Sessions", "会话"), symbolName: "rectangle.stack", command: nil, controlPlane: "memory", detail: CanvastAppCoreLocalizer.text("Project-scoped persistent sessions, ephemeral mode, and state directory policy.", "支持项目级持久化会话、临时模式和状态目录策略。"), isEnhanced: false),
    .init(id: .askUser, title: CanvastAppCoreLocalizer.text("Ask User", "询问用户"), symbolName: "questionmark.bubble", command: "ask_user", controlPlane: "interaction", detail: CanvastAppCoreLocalizer.text("Structured confirmation requests with unattended non-blocking behavior.", "提供结构化确认请求，并支持 unattended 非阻塞行为。"), isEnhanced: false),
    .init(id: .sandbox, title: CanvastAppCoreLocalizer.text("Sandbox", "沙箱"), symbolName: "lock.shield", command: "/canvast-sandbox", controlPlane: "safety", detail: CanvastAppCoreLocalizer.text("Read-only, workspace-write, and full-access profiles with grants.", "支持只读、工作区可写和完全访问配置及显式授权。"), isEnhanced: false, isPrimary: true),
    .init(id: .permissions, title: CanvastAppCoreLocalizer.text("Permissions", "权限"), symbolName: "checkmark.shield", command: "permission_audit", controlPlane: "safety", detail: CanvastAppCoreLocalizer.text("Protected paths, dangerous command blocks, approval policy, and audit trail.", "覆盖受保护路径、危险命令拦截、审批策略和审计轨迹。"), isEnhanced: false),
    .init(id: .models, title: CanvastAppCoreLocalizer.text("Models", "模型"), symbolName: "cpu", command: nil, controlPlane: "runtime", detail: CanvastAppCoreLocalizer.text("Provider, model, thinking level, context budget, and modality capability display.", "展示服务商、模型、思考等级、上下文预算和模态能力。"), isEnhanced: false),
    .init(id: .modelRegistry, title: CanvastAppCoreLocalizer.text("Model Registry", "模型注册表"), symbolName: "externaldrive.connected.to.line.below", command: nil, controlPlane: "runtime", detail: CanvastAppCoreLocalizer.text("Commercial-use registry adapters for context windows, tool use, multimodal and structured output capabilities.", "提供商用注册表适配，覆盖上下文窗口、工具使用、多模态和结构化输出能力。"), isEnhanced: false),
    .init(id: .lsp, title: CanvastAppCoreLocalizer.text("LSP", "LSP"), symbolName: "curlybraces", command: "lsp", controlPlane: "code-intel", detail: CanvastAppCoreLocalizer.text("Definition, references, hover, document symbols, and workspace symbols.", "支持定义、引用、悬停、文档符号和工作区符号。"), isEnhanced: false),
    .init(id: .notebooks, title: CanvastAppCoreLocalizer.text("Notebooks", "Notebook"), symbolName: "tablecells", command: "notebook_edit", controlPlane: "editing", detail: CanvastAppCoreLocalizer.text("Notebook cell replace, insert, and delete operations.", "支持 Notebook 单元格替换、插入和删除。"), isEnhanced: false),
    .init(id: .artifacts, title: CanvastAppCoreLocalizer.text("Artifacts", "产物"), symbolName: "doc.richtext", command: "create_artifact", controlPlane: "delivery", detail: CanvastAppCoreLocalizer.text("Standalone HTML artifact creation and local review.", "支持独立 HTML 产物生成和本地审阅。"), isEnhanced: false),
    .init(id: .cron, title: CanvastAppCoreLocalizer.text("Cron", "Cron"), symbolName: "calendar.badge.clock", command: "cron_create", controlPlane: "automation", detail: CanvastAppCoreLocalizer.text("Session-level scheduled tasks with explicit supported cron subset.", "支持会话级定时任务和明确受支持的 cron 子集。"), isEnhanced: false),
    .init(id: .monitor, title: CanvastAppCoreLocalizer.text("Monitor", "监控"), symbolName: "waveform.path.ecg", command: "monitor_start", controlPlane: "observability", detail: CanvastAppCoreLocalizer.text("File watches and command polling with visible status.", "支持文件监听和命令轮询，并展示可见状态。"), isEnhanced: false),
    .init(id: .backgroundTasks, title: CanvastAppCoreLocalizer.text("Background", "后台"), symbolName: "play.rectangle.on.rectangle", command: "bg_bash", controlPlane: "execution", detail: CanvastAppCoreLocalizer.text("Bounded background shell tasks with output caps and process-group cleanup.", "支持受限后台 Shell 任务，并具备输出上限和进程组清理。"), isEnhanced: false),
    .init(id: .worktrees, title: CanvastAppCoreLocalizer.text("Worktrees", "Worktree"), symbolName: "square.stack.3d.up", command: "enter_worktree", controlPlane: "isolation", detail: CanvastAppCoreLocalizer.text("Isolated git worktrees for experiments and parallel work.", "提供隔离的 git worktree 用于实验和并行工作。"), isEnhanced: false),
    .init(id: .git, title: CanvastAppCoreLocalizer.text("Git", "Git"), symbolName: "arrow.triangle.branch", command: "git_status", controlPlane: "source", detail: CanvastAppCoreLocalizer.text("Status, diff, and checkpoint entry points.", "提供状态、diff 和检查点入口。"), isEnhanced: false),
    .init(id: .mcp, title: CanvastAppCoreLocalizer.text("MCP", "MCP"), symbolName: "point.topleft.down.curvedto.point.bottomright.up", command: "mcp_list", controlPlane: "integration", detail: CanvastAppCoreLocalizer.text("MCP registration, listing, and tool bridge entry.", "支持 MCP 注册、列出和工具桥接入口。"), isEnhanced: false),
    .init(id: .codeReview, title: CanvastAppCoreLocalizer.text("Review", "审查"), symbolName: "magnifyingglass", command: "report_findings", controlPlane: "quality", detail: CanvastAppCoreLocalizer.text("Structured findings, severity, location, status, and verification.", "支持结构化问题、严重度、位置、状态和验证信息。"), isEnhanced: false),
    .init(id: .usage, title: CanvastAppCoreLocalizer.text("Usage", "使用量"), symbolName: "chart.bar", command: "usage_stats", controlPlane: "observability", detail: CanvastAppCoreLocalizer.text("Tool calls, turns, token estimates, and cost estimates.", "展示工具调用、轮次、token 估算和成本估算。"), isEnhanced: false),
    .init(id: .closure, title: CanvastAppCoreLocalizer.text("Closure", "闭环"), symbolName: "checklist.checked", command: "/canvast-closure", controlPlane: "delivery", detail: CanvastAppCoreLocalizer.text("Evidence-backed product delivery gates with no open required gaps.", "提供基于证据的产品交付门禁，确保没有未闭合的必需缺口。"), isEnhanced: true, isPrimary: true),
    .init(id: .evaluation, title: CanvastAppCoreLocalizer.text("Quality Validation", "质量验证"), symbolName: "gauge.with.dots.needle.50percent", command: "verify:product", controlPlane: "verification", detail: CanvastAppCoreLocalizer.text("Canvast quality scenarios, evidence-backed checks, remediation loops, and verification reports.", "支持 Canvast 质量场景、证据化检查、修复闭环和验证报告。"), isEnhanced: true),
    .init(id: .packaging, title: CanvastAppCoreLocalizer.text("Package", "打包"), symbolName: "shippingbox", command: "package:product", controlPlane: "delivery", detail: CanvastAppCoreLocalizer.text("Clean product verification, exclusions, archive, and retest path.", "支持干净产品验证、排除项、归档和复测路径。"), isEnhanced: false),
    .init(id: .safety, title: CanvastAppCoreLocalizer.text("Safety", "安全"), symbolName: "speedometer", command: "/canvast-safety", controlPlane: "safety", detail: CanvastAppCoreLocalizer.text("Watchdog, safe-run, process lifecycle, and resource thresholds.", "覆盖 watchdog、安全运行、进程生命周期和资源阈值。"), isEnhanced: false, isPrimary: true),
    .init(id: .guiGuard, title: CanvastAppCoreLocalizer.text("GUI Guard", "GUI 防护"), symbolName: "display.trianglebadge.exclamationmark", command: "unattended-gui-guard", controlPlane: "safety", detail: CanvastAppCoreLocalizer.text("Scoped unattended guard for frontend tests that prevents Canvast-launched GUI/browser popups.", "为前端测试提供受限 unattended 防护，阻止 Canvast 启动 GUI/浏览器弹窗。"), isEnhanced: false),
    .init(id: .offscreenSnapshot, title: CanvastAppCoreLocalizer.text("Offscreen Snapshot", "离屏快照"), symbolName: "camera.viewfinder", command: "render_snapshot", controlPlane: "frontend", detail: CanvastAppCoreLocalizer.text("No-window render model for UI inspection and regression checks.", "提供无窗口渲染模型，用于 UI 检查和回归校验。"), isEnhanced: true),
    .init(id: .macApp, title: CanvastAppCoreLocalizer.text("macOS App", "macOS App"), symbolName: "macwindow", command: nil, controlPlane: "frontend", detail: CanvastAppCoreLocalizer.text("Native desktop front end exposing the full Canvast control surface.", "原生桌面前端，暴露完整的 Canvast 控制面。"), isEnhanced: true)
  ]

  public static var primary: [CanvastFeature] {
    all.filter(\.isPrimary)
  }

  public static func feature(_ id: CanvastFeatureID) -> CanvastFeature? {
    all.first { $0.id == id }
  }
}
