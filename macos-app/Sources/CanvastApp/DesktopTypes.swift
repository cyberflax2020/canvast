import SwiftUI
import CanvastAppCore

enum DesktopWorkspace: String, CaseIterable, Identifiable, Hashable {
  case runConsole
  case canvas
  case taskPlan
  case agentsWorkflow
  case safetyPermissions
  case toolsContextSessions

  var id: String { rawValue }

  var title: String {
    let localizer = CanvastLocalizationRuntime.localizer
    switch self {
    case .runConsole: return localizer.text("Run Console", "运行控制台")
    case .canvas: return localizer.text("Canvas", "画布")
    case .taskPlan: return localizer.text("Tasks & Plans", "任务与计划")
    case .agentsWorkflow: return localizer.text("Agents & Workflows", "Agent 与工作流")
    case .safetyPermissions: return localizer.text("Safety & Permissions", "安全与权限")
    case .toolsContextSessions: return localizer.text("Tools, Context & Sessions", "工具、上下文与会话")
    }
  }

  var shortTitle: String {
    let localizer = CanvastLocalizationRuntime.localizer
    switch self {
    case .runConsole: return localizer.text("Run", "运行")
    case .canvas: return localizer.text("Canvas", "画布")
    case .taskPlan: return localizer.text("Plan", "计划")
    case .agentsWorkflow: return localizer.text("Agents", "Agent")
    case .safetyPermissions: return localizer.text("Safety", "安全")
    case .toolsContextSessions: return localizer.text("Workspace", "工作区")
    }
  }

  var symbol: String {
    switch self {
    case .runConsole: return "terminal"
    case .canvas: return "point.3.connected.trianglepath.dotted"
    case .taskPlan: return "checklist"
    case .agentsWorkflow: return "arrow.triangle.branch"
    case .safetyPermissions: return "checkmark.shield"
    case .toolsContextSessions: return "square.grid.2x2"
    }
  }

  var subtitle: String {
    let localizer = CanvastLocalizationRuntime.localizer
    switch self {
    case .runConsole:
      return localizer.text(
        "Prepare, launch, and monitor a Canvast run.",
        "准备、启动并监控一次 Canvast 运行。"
      )
    case .canvas:
      return localizer.text(
        "Navigate the persistent project graph and its traceability links.",
        "浏览持久化项目图谱及其追踪关系。"
      )
    case .taskPlan:
      return localizer.text(
        "Track plans, task progress, blockers, and completion state.",
        "跟踪计划、任务进度、阻塞项和完成状态。"
      )
    case .agentsWorkflow:
      return localizer.text(
        "Follow delegated work and orchestration as it changes.",
        "跟踪委派工作和编排状态变化。"
      )
    case .safetyPermissions:
      return localizer.text(
        "Inspect execution boundaries and permission decisions.",
        "检查执行边界和权限决策。"
      )
    case .toolsContextSessions:
      return localizer.text(
        "Review capabilities, context use, attachments, and project state.",
        "查看能力目录、上下文使用、附件和项目状态。"
      )
    }
  }
}

enum ToolsWorkspaceSection: String, CaseIterable, Identifiable {
  case tools = "Tools"
  case context = "Context"
  case sessions = "Sessions"

  var id: String { rawValue }

  var title: String {
    let localizer = CanvastLocalizationRuntime.localizer
    switch self {
    case .tools: return localizer.dynamic("tools")
    case .context: return localizer.dynamic("context")
    case .sessions: return localizer.dynamic("sessions")
    }
  }
}

struct DesktopNavigationTarget: Equatable {
  let workspace: DesktopWorkspace
  let feature: CanvastFeatureID
  let toolsSection: ToolsWorkspaceSection
  let canvasNodeID: String?
}

struct DesktopNavigationHistory: Equatable {
  private(set) var backStack: [DesktopNavigationTarget] = []
  private(set) var forwardStack: [DesktopNavigationTarget] = []

  var canGoBack: Bool { !backStack.isEmpty }
  var canGoForward: Bool { !forwardStack.isEmpty }

  mutating func push(_ target: DesktopNavigationTarget) {
    if backStack.last != target { backStack.append(target) }
    if backStack.count > 100 { backStack.removeFirst(backStack.count - 100) }
    forwardStack.removeAll(keepingCapacity: true)
  }

  mutating func goBack(from current: DesktopNavigationTarget) -> DesktopNavigationTarget? {
    guard let target = backStack.popLast() else { return nil }
    if forwardStack.last != current { forwardStack.append(current) }
    return target
  }

  mutating func goForward(from current: DesktopNavigationTarget) -> DesktopNavigationTarget? {
    guard let target = forwardStack.popLast() else { return nil }
    if backStack.last != current { backStack.append(current) }
    return target
  }
}

enum DesktopRunState: Equatable {
  case idle
  case preparing
  case running
  case stopping
  case finished(Int32)
  case failed(String)

  var isActive: Bool {
    switch self {
    case .preparing, .running, .stopping: return true
    case .idle, .finished, .failed: return false
    }
  }

  var label: String {
    let localizer = CanvastLocalizationRuntime.localizer
    switch self {
    case .idle: return localizer.dynamic("ready")
    case .preparing: return localizer.dynamic("preparing")
    case .running: return localizer.dynamic("running")
    case .stopping: return localizer.text("Stopping", "停止中")
    case .finished(let code):
      return code == 0
        ? localizer.text("Completed", "已完成")
        : localizer.text("Exited \(code)", "已退出 \(code)")
    case .failed: return localizer.dynamic("failed")
    }
  }

  var symbol: String {
    switch self {
    case .idle: return "circle"
    case .preparing: return "hourglass"
    case .running: return "play.circle.fill"
    case .stopping: return "stop.circle"
    case .finished(let code): return code == 0 ? "checkmark.circle.fill" : "exclamationmark.circle.fill"
    case .failed: return "xmark.octagon.fill"
    }
  }

  var color: Color {
    switch self {
    case .idle: return .secondary
    case .preparing: return .orange
    case .running: return .blue
    case .stopping: return .orange
    case .finished(let code): return code == 0 ? .green : .orange
    case .failed: return .red
    }
  }
}

enum DesktopActionState: Equatable {
  case idle
  case sending(String)
  case succeeded(String)
  case degraded(String)
  case failed(String)

  var isActive: Bool {
    if case .sending = self { return true }
    return false
  }

  var label: String {
    let localizer = CanvastLocalizationRuntime.localizer
    switch self {
    case .idle: return localizer.dynamic("ready")
    case .sending(let label): return localizer.text("Sending \(label)", "发送中 \(label)")
    case .succeeded(let label): return label
    case .degraded(let label): return label
    case .failed(let label): return label
    }
  }

  var color: Color {
    switch self {
    case .idle: return .secondary
    case .sending: return .blue
    case .succeeded: return .green
    case .degraded: return .orange
    case .failed: return .red
    }
  }
}

enum RunningInputMode: String, CaseIterable, Identifiable {
  case followUp
  case steer

  var id: String { rawValue }

  var title: String {
    let localizer = CanvastLocalizationRuntime.localizer
    switch self {
    case .followUp: return localizer.text("Sidecar", "旁路")
    case .steer: return localizer.text("Redirect", "重定向")
    }
  }
}

enum ConsoleChannel: String, Codable, Hashable {
  case system
  case standardOutput
  case standardError

  var title: String {
    let localizer = CanvastLocalizationRuntime.localizer
    switch self {
    case .system: return localizer.text("Canvast", "Canvast")
    case .standardOutput: return localizer.text("Output", "输出")
    case .standardError: return localizer.text("Error", "错误")
    }
  }

  var symbol: String {
    switch self {
    case .system: return "sparkles"
    case .standardOutput: return "text.alignleft"
    case .standardError: return "exclamationmark.triangle"
    }
  }

  var color: Color {
    switch self {
    case .system: return .blue
    case .standardOutput: return .primary
    case .standardError: return .red
    }
  }
}

struct ConsoleEntry: Identifiable, Hashable {
  let id: UUID
  let timestamp: Date
  let channel: ConsoleChannel
  let text: String

  init(id: UUID = UUID(), timestamp: Date = Date(), channel: ConsoleChannel, text: String) {
    self.id = id
    self.timestamp = timestamp
    self.channel = channel
    self.text = text
  }
}

enum CanvasNodeKind: String, CaseIterable, Codable, Hashable, Identifiable {
  case plan
  case decision
  case file
  case agentRun = "agent_run"

  var id: String { rawValue }

  var title: String {
    let localizer = CanvastLocalizationRuntime.localizer
    switch self {
    case .plan: return localizer.text("Plan", "计划")
    case .decision: return localizer.text("Decision", "决策")
    case .file: return localizer.text("File", "文件")
    case .agentRun: return localizer.text("Agent Run", "Agent 运行")
    }
  }

  var symbol: String {
    switch self {
    case .plan: return "checklist"
    case .decision: return "arrow.triangle.branch"
    case .file: return "doc.text"
    case .agentRun: return "person.crop.circle.badge.checkmark"
    }
  }

  var color: Color {
    switch self {
    case .plan: return .blue
    case .decision: return .purple
    case .file: return .teal
    case .agentRun: return .orange
    }
  }
}

struct CanvasLocalizedText: Hashable {
  let english: String
  let simplifiedChinese: String

  init(_ english: String, _ simplifiedChinese: String) {
    self.english = english
    self.simplifiedChinese = simplifiedChinese
  }

  func text(localizer: CanvastLocalizer = CanvastLocalizationRuntime.localizer) -> String {
    localizer.text(english, simplifiedChinese)
  }
}

struct CanvasGraphNamedValue: Hashable {
  let key: String
  let value: CanvasGraphValue
}

indirect enum CanvasGraphValue: Hashable {
  case text(String)
  case bool(Bool)
  case list([CanvasGraphValue])
  case object([CanvasGraphNamedValue])

  func displayText(localizer: CanvastLocalizer = CanvastLocalizationRuntime.localizer) -> String {
    switch self {
    case .text(let value):
      return value
    case .bool(let value):
      return localizer.boolText(value)
    case .list(let values):
      return values.map { $0.displayText(localizer: localizer) }.filter { !$0.isEmpty }.joined(separator: ", ")
    case .object(let values):
      return values.compactMap { entry in
        let rendered = entry.value.displayText(localizer: localizer)
        return rendered.isEmpty ? nil : "\(entry.key): \(rendered)"
      }
      .joined(separator: ", ")
    }
  }
}

struct CanvasTextLine: Hashable {
  let components: [CanvasGraphValue]
  let fallback: CanvasLocalizedText

  func text(localizer: CanvastLocalizer = CanvastLocalizationRuntime.localizer) -> String {
    let joined = components.map { $0.displayText(localizer: localizer) }.filter { !$0.isEmpty }.joined(separator: " · ")
    return joined.isEmpty ? fallback.text(localizer: localizer) : joined
  }
}

struct CanvasDetailRow: Hashable {
  let labelText: CanvasLocalizedText
  let valueSource: CanvasGraphValue

  var label: String { labelText.text() }
  var value: String { valueSource.displayText() }
}

struct CanvasGraphNode: Identifiable, Equatable, Hashable {
  let id: String
  let type: CanvasNodeKind
  let title: String
  let subtitleText: CanvasTextLine
  let detailRows: [CanvasDetailRow]

  var subtitle: String { subtitleText.text() }

  var searchText: String {
    (
      [id, type.rawValue, title, subtitle] +
        detailRows.flatMap { [$0.label, $0.value] }
    )
    .joined(separator: " ")
    .lowercased()
  }
}

struct CanvasGraphEdge: Identifiable, Hashable {
  let id: String
  let type: String
  let sourceID: String
  let targetID: String
}

enum CanvasGraphSourceDescription: Equatable, Hashable {
  case unavailable
  case noPersistedGraph
  case loaded(nodeCount: Int, edgeCount: Int)
  case decodeFailure(String)
  case exact(String)

  func text(localizer: CanvastLocalizer = CanvastLocalizationRuntime.localizer) -> String {
    switch self {
    case .unavailable:
      return localizer.text("Canvas state is not available yet.", "画布状态暂不可用。")
    case .noPersistedGraph:
      return localizer.text(
        "No persisted Canvas graph exists for this project yet.",
        "该项目尚未生成持久化画布图谱。"
      )
    case .loaded(let nodeCount, let edgeCount):
      return localizer.text(
        "Loaded \(nodeCount) nodes and \(edgeCount) traceability links.",
        "已加载 \(nodeCount) 个节点和 \(edgeCount) 条追踪连线。"
      )
    case .decodeFailure(let message):
      return localizer.text(
        "Canvas graph could not be decoded: \(message)",
        "无法解码画布图谱：\(message)"
      )
    case .exact(let message):
      return localizer.exact(message)
    }
  }
}

struct CanvasGraphSnapshot: Equatable {
  let nodes: [CanvasGraphNode]
  let edges: [CanvasGraphEdge]
  let loadedAt: Date?
  let source: CanvasGraphSourceDescription

  var sourceDescription: String { source.text() }

  static let empty = CanvasGraphSnapshot(
    nodes: [],
    edges: [],
    loadedAt: nil,
    source: .unavailable
  )
}

struct DesktopProjectScope: Equatable {
  let currentProjectRoot: String
  let relation: String
  let canLoadCanvas: Bool?
  let canInjectScopedView: Bool?
  let advisory: String
  let persistedProjectRoot: String
  let updatedAt: String?
  let revision: Int?
  let source: String?
  let canvasReloaded: Bool?
}

struct DesktopRuntimeModeUpdate: Equatable {
  let mode: CanvastRuntimeMode
  let effectiveMode: CanvastRuntimeMode
  let scope: String
  let source: String?
  let updatedAt: String?
  let revision: Int?
  let reason: String?
  let message: String
}

struct DesktopRequestControlResult: Equatable {
  let runtimeRequestID: String
  let policy: CanvastRuntimeRequestControlPolicy
  let queueStatus: String
  let deliveryMode: String
  let requestKind: String
  let affectsActiveWork: Bool
  let message: String
}

struct DesktopPlanLifecycleResult: Equatable {
  let planID: String
  let status: String
  let message: String
}

struct DesktopCanvasTaskSelection: Equatable {
  let nodeID: String
  let currentTaskID: String
  let nodeType: String
  let message: String
}

struct DesktopCanvasPlanSelection: Equatable {
  let planID: String
  let activePlanID: String
  let nodeType: String
  let message: String
}

struct DesktopSandboxGrant: Identifiable, Equatable {
  let id: String
  let scope: String
  let kind: String
  let value: String
  let createdAt: String
  let reason: String?
}

struct DesktopSandboxConfig: Equatable {
  let profile: String
  let permissionMode: String?
  let unattended: Bool?
  let network: String?
  let projectRoot: String?
  let writableRoots: [String]
}

struct DesktopSandboxDecision: Equatable {
  let action: String
  let profile: String
  let severity: String
  let reason: String
  let categories: [String]
  let writePaths: [String]
  let readPaths: [String]
  let missingGrants: [String]
}

struct DesktopSandboxStatus: Equatable {
  let version: Int?
  let revision: Int?
  let config: DesktopSandboxConfig
  let grants: [DesktopSandboxGrant]
  let status: String?
  let message: String?
  let decision: DesktopSandboxDecision?
}

struct DesktopSandboxRevocationReceipt: Equatable {
  let removedGrant: DesktopSandboxGrant
  let revision: Int
  let futureOperationsOnly: Bool
  let message: String
}

struct DesktopSandboxRevokeReconciliation {
  let originalRequestID: String
  let reconciliationID: String
  let grantID: String
  let expectedRevision: Int
}

struct PersistedStateRecord: Identifiable {
  let url: URL
  let name: String
  let isDirectory: Bool
  let sizeBytes: Int?
  let modifiedAt: Date?

  var id: String { url.path }

  var detail: String {
    var parts: [String] = []
    if isDirectory {
      parts.append("Directory")
    } else if let sizeBytes {
      parts.append(ByteCountFormatter.string(fromByteCount: Int64(sizeBytes), countStyle: .file))
    }
    if let modifiedAt {
      parts.append(modifiedAt.formatted(date: .abbreviated, time: .shortened))
    }
    return parts.isEmpty ? "State record" : parts.joined(separator: " · ")
  }
}
