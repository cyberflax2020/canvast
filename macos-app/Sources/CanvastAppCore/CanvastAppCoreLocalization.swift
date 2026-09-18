import Foundation

public struct CanvastLocalizedString: Equatable, Sendable {
  public let english: String
  public let simplifiedChinese: String

  public init(_ english: String, _ simplifiedChinese: String) {
    self.english = english
    self.simplifiedChinese = simplifiedChinese
  }

  public func text(for language: CanvastAppLanguage) -> String {
    switch language {
    case .english: return english
    case .simplifiedChinese: return simplifiedChinese
    }
  }
}

public struct CanvastLocalizer: Equatable, Sendable {
  public let state: CanvastResolvedLanguageState

  public init(state: CanvastResolvedLanguageState) {
    self.state = state
  }

  public var language: CanvastAppLanguage { state.resolvedLanguage }
  public var locale: Locale { Locale(identifier: language.localeIdentifier) }

  public func text(_ value: CanvastLocalizedString) -> String {
    value.text(for: language)
  }

  public func text(_ english: String, _ simplifiedChinese: String) -> String {
    text(.init(english, simplifiedChinese))
  }

  public func boolText(_ value: Bool) -> String {
    value ? dynamic("yes") : dynamic("no")
  }

  public func counted(
    _ count: Int,
    singularEnglish: String,
    pluralEnglish: String,
    simplifiedChineseSuffix: String
  ) -> String {
    switch language {
    case .english:
      return "\(count) \(count == 1 ? singularEnglish : pluralEnglish)"
    case .simplifiedChinese:
      return "\(count)\(simplifiedChineseSuffix)"
    }
  }

  public func exact(_ english: String) -> String {
    if let localized = CanvastExactLocalizationCatalog.lookup(english) {
      return text(localized)
    }
    return english
  }

  public func dynamic(_ key: String) -> String {
    switch key {
    case "all": return text("All", "全部")
    case "none": return text("None", "无")
    case "unknown": return text("Unknown", "未知")
    case "visible_reply": return text("Visible reply", "已显示回复")
    case "reply_pending": return text("Reply pending", "回复待返回")
    case "visible": return text("Visible", "可见")
    case "pending": return text("Pending", "待处理")
    case "requested": return text("Requested", "请求值")
    case "effective": return text("Effective", "生效值")
    case "profile": return text("Profile", "配置")
    case "mode": return text("Mode", "模式")
    case "thinking": return text("Thinking", "思考")
    case "updated": return text("Updated", "更新时间")
    case "created": return text("Created", "创建时间")
    case "reason": return text("Reason", "原因")
    case "current": return text("Current", "当前")
    case "open": return text("Open", "打开")
    case "refresh": return text("Refresh", "刷新")
    case "inspect": return text("Inspect", "检查")
    case "save": return text("Save", "保存")
    case "cancel": return text("Cancel", "取消")
    case "clear": return text("Clear", "清空")
    case "run": return text("Run", "运行")
    case "stop": return text("Stop", "停止")
    case "preview": return text("Preview", "预览")
    case "prepare": return text("Prepare", "准备")
    case "copy": return text("Copy", "复制")
    case "search": return text("Search", "搜索")
    case "attachments": return text("Attachments", "附件")
    case "context": return text("Context", "上下文")
    case "tools": return text("Tools", "工具")
    case "sessions": return text("Sessions", "会话")
    case "canvas": return text("Canvas", "画布")
    case "tasks": return text("Tasks", "任务")
    case "plans": return text("Plans", "计划")
    case "agents": return text("Agents", "Agent")
    case "workflows": return text("Workflows", "工作流")
    case "safety": return text("Safety", "安全")
    case "permissions": return text("Permissions", "权限")
    case "settings": return text("Settings", "设置")
    case "workspace": return text("Workspace", "工作区")
    case "state_not_recorded": return text("State not recorded", "状态尚未记录")
    case "not_recorded": return text("Not recorded", "未记录")
    case "yes": return text("Yes", "是")
    case "no": return text("No", "否")
    case "read": return text("Read", "读")
    case "write": return text("Write", "写")
    case "once": return text("Once", "一次")
    case "session": return text("Session", "会话")
    case "project": return text("Project", "项目")
    case "command": return text("Command", "命令")
    case "path": return text("Path", "路径")
    case "language": return text("Language", "语言")
    case "system": return text("System", "系统")
    case "english": return text("English", "English")
    case "simplified_chinese": return text("Simplified Chinese", "简体中文")
    case "idle": return text("Idle", "空闲")
    case "ready": return text("Ready", "就绪")
    case "preparing": return text("Preparing", "准备中")
    case "queued": return text("Queued", "排队中")
    case "running": return text("Running", "运行中")
    case "waiting": return text("Waiting", "等待中")
    case "reconciling": return text("Reconciling", "对账中")
    case "outcome_unknown": return text("Outcome Unknown", "结果未知")
    case "succeeded": return text("Succeeded", "成功")
    case "failed": return text("Failed", "失败")
    case "cancelled": return text("Cancelled", "已取消")
    case "timed_out": return text("Timed Out", "已超时")
    case "review_required": return text("Review Required", "需要复核")
    case "read_only": return text("Read Only", "只读")
    case "workspace_write": return text("Workspace Write", "工作区可写")
    case "full_access": return text("Full Access", "完全访问")
    case "allow": return text("Allow", "允许")
    case "deny": return text("Deny", "拒绝")
    case "ask": return text("Ask", "询问")
    case "low": return text("Low", "低")
    case "medium": return text("Medium", "中")
    case "high": return text("High", "高")
    case "critical": return text("Critical", "严重")
    default:
      return humanizeFallback(key)
    }
  }

  private func humanizeFallback(_ raw: String) -> String {
    let normalized = raw.replacingOccurrences(of: "_", with: " ")
    guard language == .english else { return normalized }
    return normalized
      .split(separator: " ")
      .map { $0.prefix(1).uppercased() + $0.dropFirst() }
      .joined(separator: " ")
  }
}

public enum CanvastLocalizationRuntime {
  private static let lock = NSLock()
  private static var currentState = CanvastAppLanguageResolver.resolve(preference: .system)

  public static var state: CanvastResolvedLanguageState {
    lock.lock()
    defer { lock.unlock() }
    return currentState
  }

  public static var localizer: CanvastLocalizer {
    CanvastLocalizer(state: state)
  }

  public static func update(_ state: CanvastResolvedLanguageState) {
    lock.lock()
    currentState = state
    lock.unlock()
  }
}

public func humanized(_ raw: String, localizer: CanvastLocalizer? = nil) -> String {
  let normalized = raw.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !normalized.isEmpty else { return normalized }
  let key = normalized
    .replacingOccurrences(of: "-", with: "_")
    .replacingOccurrences(of: " ", with: "_")
    .lowercased()
  let effectiveLocalizer = localizer ?? CanvastLocalizationRuntime.localizer
  let localized = effectiveLocalizer.dynamic(key)
  if localized != key {
    return localized
  }
  return normalized.replacingOccurrences(of: "_", with: " ")
    .split(separator: " ")
    .map { $0.prefix(1).uppercased() + $0.dropFirst() }
    .joined(separator: " ")
}

enum CanvastAppCoreLocalizer {
  static func text(_ english: String, _ simplifiedChinese: String) -> String {
    CanvastLocalizationRuntime.localizer.text(english, simplifiedChinese)
  }
}

private enum CanvastExactLocalizationCatalog {
  private static let table: [String: CanvastLocalizedString] = [
    "Preparing action": .init("Preparing action", "准备操作"),
    "Applied local change": .init("Applied local change", "已应用本地更改"),
    "Refresh": .init("Refresh", "刷新"),
    "Live mode": .init("Live mode", "实时模式"),
    "Workspace": .init("Workspace", "工作区"),
    "Current run": .init("Current run", "当前运行"),
    "Clear Canvas selection": .init("Clear Canvas selection", "清除画布选择"),
    "Use as Active Task": .init("Use as Active Task", "设为当前任务"),
    "Use as Active Plan": .init("Use as Active Plan", "设为当前计划"),
    "Prepare in Run Console": .init("Prepare in Run Console", "在运行控制台中准备"),
    "Copy command": .init("Copy command", "复制命令"),
    "Open connected node": .init("Open connected node", "打开关联节点"),
    "Request policy": .init("Request policy", "请求策略"),
    "Control request": .init("Control request", "控制请求"),
    "Send Control": .init("Send Control", "发送控制"),
    "Prompt": .init("Prompt", "提示词"),
    "Timeout": .init("Timeout", "超时"),
    "Follow output": .init("Follow output", "跟随输出"),
    "Plan or task title": .init("Plan or task title", "计划或任务标题"),
    "Create Plan": .init("Create Plan", "创建计划"),
    "Create Task": .init("Create Task", "创建任务"),
    "Lifecycle note": .init("Lifecycle note", "生命周期说明"),
    "Search plans and tasks": .init("Search plans and tasks", "搜索计划和任务"),
    "Show completed": .init("Show completed", "显示已完成"),
    "Approve Current Plan": .init("Approve Current Plan", "批准当前计划"),
    "Complete Current Plan": .init("Complete Current Plan", "完成当前计划"),
    "Target status": .init("Target status", "目标状态"),
    "Request Plan Update": .init("Request Plan Update", "请求计划更新"),
    "Mark In Progress": .init("Mark In Progress", "标记为进行中"),
    "Mark Completed": .init("Mark Completed", "标记为已完成"),
    "Show on Canvas": .init("Show on Canvas", "在画布中显示"),
    "Select plan or task": .init("Select plan or task", "选择计划或任务"),
    "Open persisted plan on Canvas": .init("Open persisted plan on Canvas", "在画布中打开持久化计划"),
    "Prepare status request": .init("Prepare status request", "准备状态请求"),
    "Workspace section": .init("Workspace section", "工作区分区"),
    "Search capabilities": .init("Search capabilities", "搜索能力"),
    "Capability card": .init("Capability card", "能力卡片"),
    "Copy TUI command": .init("Copy TUI command", "复制 TUI 命令"),
    "Prepare Context Review": .init("Prepare Context Review", "准备上下文审查"),
    "Copy Project Path": .init("Copy Project Path", "复制项目路径"),
    "Copy State Path": .init("Copy State Path", "复制状态路径"),
    "New Session": .init("New Session", "新建会话"),
    "Load History": .init("Load History", "加载历史"),
    "Open Session": .init("Open Session", "打开会话"),
    "Rename Session": .init("Rename Session", "重命名会话"),
    "Load Transcript": .init("Load Transcript", "加载转录"),
    "Inspect Candidate": .init("Inspect Candidate", "检查候选项"),
    "Select Candidate": .init("Select Candidate", "选择候选项"),
    "Resume Candidate": .init("Resume Candidate", "恢复候选项"),
    "Repair Binding": .init("Repair Binding", "修复绑定"),
    "Retire Candidate": .init("Retire Candidate", "退役候选项"),
    "Refresh Resume State": .init("Refresh Resume State", "刷新恢复状态"),
    "Restart Project Runtime": .init("Restart Project Runtime", "重启项目运行时"),
    "Reload Persisted State": .init("Reload Persisted State", "重新加载持久化状态"),
    "Inspect Scope": .init("Inspect Scope", "检查范围"),
    "Rebind to Current Project": .init("Rebind to Current Project", "重新绑定到当前项目"),
    "Confirm Rebind": .init("Confirm Rebind", "确认重新绑定"),
    "Copy persisted-state path": .init("Copy persisted-state path", "复制持久化状态路径"),
    "Copy attachment placeholder": .init("Copy attachment placeholder", "复制附件占位符"),
    "Inspect": .init("Inspect", "检查"),
    "Profile": .init("Profile", "配置"),
    "Apply Profile": .init("Apply Profile", "应用配置"),
    "Open full-access confirmation": .init("Open full-access confirmation", "打开完全访问确认"),
    "Request Full Access": .init("Request Full Access", "请求完全访问"),
    "Target": .init("Target", "目标"),
    "Grant value": .init("Grant value", "授权值"),
    "Access": .init("Access", "访问"),
    "Scope": .init("Scope", "范围"),
    "Reason": .init("Reason", "原因"),
    "Grant Explicit Access": .init("Grant Explicit Access", "授予显式访问"),
    "Search active grants": .init("Search active grants", "搜索活动授权"),
    "Grant revoke unavailable": .init("Grant revoke unavailable", "授权撤销不可用"),
    "Stop Active Run": .init("Stop Active Run", "停止当前运行"),
    "Set Ask Every Time": .init("Set Ask Every Time", "设为每次询问"),
    "Set Automatic": .init("Set Automatic", "设为自动"),
    "Search permission decisions": .init("Search permission decisions", "搜索权限决策"),
    "Risk filter": .init("Risk filter", "风险筛选"),
    "Decision filter": .init("Decision filter", "决策筛选"),
    "Prepare an audit request": .init("Prepare an audit request", "准备审计请求"),
    "Copy rationale": .init("Copy rationale", "复制理由"),
    "Prepare Permission Audit": .init("Prepare Permission Audit", "准备权限审计"),
    "Search agents and workflows": .init("Search agents and workflows", "搜索 Agent 和工作流"),
    "Agent task or workflow goal": .init("Agent task or workflow goal", "Agent 任务或工作流目标"),
    "Launch Agent": .init("Launch Agent", "启动 Agent"),
    "Launch Workflow": .init("Launch Workflow", "启动工作流"),
    "Select agent or workflow": .init("Select agent or workflow", "选择 Agent 或工作流"),
    "Open persisted agent run on Canvas": .init("Open persisted agent run on Canvas", "在画布中打开持久化 Agent 运行"),
    "Search node id, title, or details": .init("Search node id, title, or details", "搜索节点 ID、标题或详情"),
    "Type": .init("Type", "类型"),
    "Zoom in": .init("Zoom in", "放大"),
    "Zoom out": .init("Zoom out", "缩小"),
    "Fit": .init("Fit", "适配"),
    "Focus or Show All": .init("Focus or Show All", "聚焦或显示全部"),
    "Select or clear node": .init("Select or clear node", "选择或清除节点"),
    "Pan graph": .init("Pan graph", "平移图谱"),
    "Zoom graph": .init("Zoom graph", "缩放图谱"),
    "Refresh Workspace": .init("Refresh Workspace", "刷新工作区"),
    "Switch To Enhanced/Standard": .init("Switch To Enhanced/Standard", "切换到增强/标准模式"),
    "Save": .init("Save", "保存"),
    "Test Connection": .init("Test Connection", "测试连接"),
    "Apply Provider": .init("Apply Provider", "应用提供方"),
    "Retry": .init("Retry", "重试"),
    "Rollback": .init("Rollback", "回滚"),
    "Refresh State": .init("Refresh State", "刷新状态"),
    "Confirm Succeeded": .init("Confirm Succeeded", "确认成功"),
    "Confirm Failed": .init("Confirm Failed", "确认失败"),
    "Refresh workspace": .init("Refresh workspace", "刷新工作区"),
    "Set runtime mode": .init("Set runtime mode", "设置运行模式"),
    "Set thinking level": .init("Set thinking level", "设置思考等级"),
    "Preview run": .init("Preview run", "预览运行"),
    "Start run": .init("Start run", "开始运行"),
    "Stop run": .init("Stop run", "停止运行"),
    "Clear console": .init("Clear console", "清空控制台"),
    "Send request control": .init("Send request control", "发送请求控制"),
    "Create plan": .init("Create plan", "创建计划"),
    "Create task": .init("Create task", "创建任务"),
    "Approve current plan": .init("Approve current plan", "批准当前计划"),
    "Complete current plan": .init("Complete current plan", "完成当前计划"),
    "Update plan": .init("Update plan", "更新计划"),
    "Update task": .init("Update task", "更新任务"),
    "Launch agent": .init("Launch agent", "启动 Agent"),
    "Launch workflow": .init("Launch workflow", "启动工作流"),
    "Start new session": .init("Start new session", "新建会话"),
    "Load session history": .init("Load session history", "加载会话历史"),
    "Open session": .init("Open session", "打开会话"),
    "Rename session": .init("Rename session", "重命名会话"),
    "Load session transcript": .init("Load session transcript", "加载会话转录"),
    "Inspect resume candidate": .init("Inspect resume candidate", "检查恢复候选项"),
    "Select resume candidate": .init("Select resume candidate", "选择恢复候选项"),
    "Resume interrupted work": .init("Resume interrupted work", "恢复中断工作"),
    "Repair resume binding": .init("Repair resume binding", "修复恢复绑定"),
    "Retire resume candidate": .init("Retire resume candidate", "退役恢复候选项"),
    "Restart project runtime": .init("Restart project runtime", "重启项目运行时"),
    "Inspect project scope": .init("Inspect project scope", "检查项目范围"),
    "Rebind project scope": .init("Rebind project scope", "重新绑定项目范围"),
    "Inspect sandbox": .init("Inspect sandbox", "检查沙箱"),
    "Set sandbox profile": .init("Set sandbox profile", "设置沙箱配置"),
    "Grant sandbox access": .init("Grant sandbox access", "授予沙箱访问"),
    "Set permission mode": .init("Set permission mode", "设置权限模式"),
    "Select canvas task": .init("Select canvas task", "选择画布任务"),
    "Select canvas plan": .init("Select canvas plan", "选择画布计划"),
    "Export canvas": .init("Export canvas", "导出画布"),
    "Refresh canvas": .init("Refresh canvas", "刷新画布"),
    "Filter local snapshot": .init("Filter local snapshot", "筛选本地快照"),
    "Reload persisted snapshot": .init("Reload persisted snapshot", "重新加载持久化快照"),
    "Save settings": .init("Save settings", "保存设置"),
    "Test provider connection": .init("Test provider connection", "测试提供方连接"),
    "Apply provider settings": .init("Apply provider settings", "应用提供方设置"),
    "Workspace refresh timed out before state reload completed.": .init("Workspace refresh timed out before state reload completed.", "工作区刷新在状态重新加载完成前超时。"),
    "Workspace refresh is already running.": .init("Workspace refresh is already running.", "工作区刷新已在运行。"),
    "Runtime mode change timed out before the desktop dispatcher replied.": .init("Runtime mode change timed out before the desktop dispatcher replied.", "运行模式切换在桌面调度器回复前超时。"),
    "A runtime mode change is already in progress.": .init("A runtime mode change is already in progress.", "运行模式切换已在进行中。"),
    "Thinking level update timed out before the runtime replied.": .init("Thinking level update timed out before the runtime replied.", "思考等级更新在运行时回复前超时。"),
    "A thinking level update is already in progress.": .init("A thinking level update is already in progress.", "思考等级更新已在进行中。"),
    "Run preview timed out while preparing the launch plan.": .init("Run preview timed out while preparing the launch plan.", "运行预览在准备启动计划时超时。"),
    "Run preview is already being prepared.": .init("Run preview is already being prepared.", "运行预览已在准备中。"),
    "Run start timed out before the RPC host accepted the prompt.": .init("Run start timed out before the RPC host accepted the prompt.", "运行开始在 RPC 主机接受提示词前超时。"),
    "A run is already active or starting.": .init("A run is already active or starting.", "已有运行处于活动或启动中。"),
    "Run stop timed out before the runtime acknowledged abort.": .init("Run stop timed out before the runtime acknowledged abort.", "运行停止在运行时确认中止前超时。"),
    "A run stop request is already in progress.": .init("A run stop request is already in progress.", "停止运行请求已在进行中。"),
    "Console clear did not complete in time.": .init("Console clear did not complete in time.", "控制台清空未能及时完成。"),
    "Console clear is already in progress.": .init("Console clear is already in progress.", "控制台清空已在进行中。"),
    "Request control timed out before the runtime queue acknowledged it.": .init("Request control timed out before the runtime queue acknowledged it.", "请求控制在运行时队列确认前超时。"),
    "A request control action is already in progress.": .init("A request control action is already in progress.", "请求控制操作已在进行中。"),
    "Plan creation timed out before a structured result arrived.": .init("Plan creation timed out before a structured result arrived.", "计划创建在结构化结果到达前超时。"),
    "Task creation timed out before a structured result arrived.": .init("Task creation timed out before a structured result arrived.", "任务创建在结构化结果到达前超时。"),
    "Another planning mutation is already running.": .init("Another planning mutation is already running.", "另一个计划变更已在运行。"),
    "Plan approval timed out before the runtime replied.": .init("Plan approval timed out before the runtime replied.", "计划批准在运行时回复前超时。"),
    "Plan completion timed out before the runtime replied.": .init("Plan completion timed out before the runtime replied.", "计划完成在运行时回复前超时。"),
    "Plan update timed out before the runtime replied.": .init("Plan update timed out before the runtime replied.", "计划更新在运行时回复前超时。"),
    "Task update timed out before the runtime replied.": .init("Task update timed out before the runtime replied.", "任务更新在运行时回复前超时。"),
    "Another plan lifecycle action is already in progress.": .init("Another plan lifecycle action is already in progress.", "另一个计划生命周期操作已在进行中。"),
    "Agent launch timed out before the dispatcher returned a structured result.": .init("Agent launch timed out before the dispatcher returned a structured result.", "Agent 启动在调度器返回结构化结果前超时。"),
    "Workflow launch timed out before the dispatcher returned a structured result.": .init("Workflow launch timed out before the dispatcher returned a structured result.", "工作流启动在调度器返回结构化结果前超时。"),
    "Another orchestration launch is already in progress.": .init("Another orchestration launch is already in progress.", "另一个编排启动已在进行中。"),
    "New session timed out before the runtime acknowledged it.": .init("New session timed out before the runtime acknowledged it.", "新会话在运行时确认前超时。"),
    "Another session control action is already in progress.": .init("Another session control action is already in progress.", "另一个会话控制操作已在进行中。"),
    "Session history is already loading.": .init("Session history is already loading.", "会话历史已在加载中。"),
    "A session transcript is already loading.": .init("A session transcript is already loading.", "会话转录已在加载中。"),
    "Project runtime restart timed out before reload completed.": .init("Project runtime restart timed out before reload completed.", "项目运行时重启在重新加载完成前超时。"),
    "Project scope inspection timed out before the runtime replied.": .init("Project scope inspection timed out before the runtime replied.", "项目范围检查在运行时回复前超时。"),
    "Project scope rebind timed out before the runtime replied.": .init("Project scope rebind timed out before the runtime replied.", "项目范围重新绑定在运行时回复前超时。"),
    "A project scope action is already in progress.": .init("A project scope action is already in progress.", "项目范围操作已在进行中。"),
    "Sandbox inspection timed out before the runtime replied.": .init("Sandbox inspection timed out before the runtime replied.", "沙箱检查在运行时回复前超时。"),
    "Sandbox profile change timed out before the runtime replied.": .init("Sandbox profile change timed out before the runtime replied.", "沙箱配置切换在运行时回复前超时。"),
    "Sandbox grant timed out before the runtime replied.": .init("Sandbox grant timed out before the runtime replied.", "沙箱授权在运行时回复前超时。"),
    "A sandbox action is already in progress.": .init("A sandbox action is already in progress.", "沙箱操作已在进行中。"),
    "A sandbox grant action is already in progress.": .init("A sandbox grant action is already in progress.", "沙箱授权操作已在进行中。"),
    "Permission mode change timed out before the runtime replied.": .init("Permission mode change timed out before the runtime replied.", "权限模式切换在运行时回复前超时。"),
    "A permission mode action is already in progress.": .init("A permission mode action is already in progress.", "权限模式操作已在进行中。"),
    "Canvas task selection timed out before the runtime replied.": .init("Canvas task selection timed out before the runtime replied.", "画布任务选择在运行时回复前超时。"),
    "Canvas plan selection timed out before the runtime replied.": .init("Canvas plan selection timed out before the runtime replied.", "画布计划选择在运行时回复前超时。"),
    "A canvas scope action is already in progress.": .init("A canvas scope action is already in progress.", "画布范围操作已在进行中。"),
    "Canvas export timed out before a structured receipt arrived.": .init("Canvas export timed out before a structured receipt arrived.", "画布导出在结构化回执到达前超时。"),
    "A Canvas export is already in progress.": .init("A Canvas export is already in progress.", "画布导出已在进行中。"),
    "Canvas refresh timed out before state reload completed.": .init("Canvas refresh timed out before state reload completed.", "画布刷新在状态重新加载完成前超时。"),
    "Canvas refresh is already in progress.": .init("Canvas refresh is already in progress.", "画布刷新已在进行中。"),
    "Local filter update timed out.": .init("Local filter update timed out.", "本地筛选更新已超时。"),
    "The same local filter update is already in progress.": .init("The same local filter update is already in progress.", "相同的本地筛选更新已在进行中。"),
    "Persisted snapshot reload timed out before state refresh completed.": .init("Persisted snapshot reload timed out before state refresh completed.", "持久化快照重新加载在状态刷新完成前超时。"),
    "Another workspace reload is already in progress.": .init("Another workspace reload is already in progress.", "另一个工作区重新加载已在进行中。"),
    "Settings save timed out before local storage completed.": .init("Settings save timed out before local storage completed.", "设置保存于本地存储完成前超时。"),
    "Another settings operation is already in progress.": .init("Another settings operation is already in progress.", "另一个设置操作已在进行中。"),
    "Provider connection test timed out.": .init("Provider connection test timed out.", "提供方连接测试已超时。"),
    "Provider switch timed out before configuration was applied.": .init("Provider switch timed out before configuration was applied.", "提供方切换在配置应用前超时。"),
    "Another resume operation is already in progress.": .init("Another resume operation is already in progress.", "另一个恢复操作已在进行中。")
  ]

  static func lookup(_ english: String) -> CanvastLocalizedString? {
    table[english]
  }
}
