import Foundation

public struct CanvastUserJourneySnapshot: Equatable {
  public let projectRoot: URL
  public let runtimeMode: CanvastRuntimeMode
  public let selectedFeature: CanvastFeatureID
  public let statusLine: String
  public let prompt: String
  public let thinkingLevel: String
  public let copiedCommand: String?
  public let launchPreview: String?
  public let visitedFeatureIDs: [CanvastFeatureID]
  public let visiblePanels: [String]

  public var text: String {
    let localizer = CanvastLocalizationRuntime.localizer
    return [
      "project=\(projectRoot.path)",
      "mode=\(runtimeMode.rawValue)",
      "selected=\(selectedFeature.rawValue)",
      "status=\(statusLine)",
      "prompt=\(prompt)",
      "thinking=\(thinkingLevel)",
      "copied=\(copiedCommand ?? "")",
      "launch=\(launchPreview ?? "")",
      "visited=\(visitedFeatureIDs.map(\.rawValue).joined(separator: ","))",
      "panels=\(visiblePanels.map { CanvastUserJourneyModel.localizedPanelName($0, localizer: localizer) }.joined(separator: ","))"
    ].joined(separator: "\n")
  }
}

public final class CanvastUserJourneyModel {
  private let store: CanvastStateStore
  private let bridge: CanvastBridge
  private let installRoot: URL
  private var stateDirectory: URL?
  private var projectState: CanvastProjectState
  private var copiedCommand: String?
  private var launchPreview: String?
  private var visited: [CanvastFeatureID] = []
  private var panels: [String] = [
    "Header", "Runtime Status", "Run", "Canvas", "Task Tree", "Sub-Agents", "Feature Catalog", "Inspector",
  ]

  public var projectRoot: URL { projectState.projectRoot }
  public var prompt: String
  public private(set) var thinkingLevel: String
  public private(set) var selectedFeature: CanvastFeatureID
  public private(set) var statusLine: String

  private var localizer: CanvastLocalizer {
    CanvastLocalizationRuntime.localizer
  }

  private func setPanels(_ next: [String]) {
    var merged = next
    if !merged.contains("Runtime Status") {
      let insertIndex = merged.first == "Header" ? 1 : 0
      merged.insert("Runtime Status", at: insertIndex)
    }
    panels = merged
  }

  public init(
    installRoot: URL,
    projectRoot: URL,
    prompt: String = "",
    selectedFeature: CanvastFeatureID = .canvas,
    stateDirectory: URL? = nil,
    store: CanvastStateStore = CanvastStateStore(),
    bridge: CanvastBridge = CanvastBridge()
  ) {
    self.store = store
    self.bridge = bridge
    self.installRoot = installRoot
    self.stateDirectory = stateDirectory
    self.projectState = store.load(projectRoot: projectRoot, stateDirectory: stateDirectory)
    self.prompt = prompt
    self.thinkingLevel = projectState.runtimeStatus.model.thinkingLevel.isEmpty ? "medium" : projectState.runtimeStatus.model.thinkingLevel
    self.selectedFeature = selectedFeature
    self.statusLine = CanvastLocalizationRuntime.localizer.dynamic("ready")
    self.visited = [selectedFeature]
  }

  public var runtimeMode: CanvastRuntimeMode {
    projectState.runtimeMode
  }

  public var features: [CanvastFeature] {
    projectState.features
  }

  @discardableResult
  public func refresh() -> CanvastUserJourneySnapshot {
    projectState = store.load(projectRoot: projectState.projectRoot, stateDirectory: stateDirectory)
    if !projectState.runtimeStatus.model.thinkingLevel.isEmpty {
      thinkingLevel = projectState.runtimeStatus.model.thinkingLevel
    }
    statusLine = localizer.text("State refreshed", "状态已刷新")
    setPanels(["Header", "Run", "Canvas", "Task Tree", "Sub-Agents", "Feature Catalog", "Inspector"])
    return snapshot()
  }

  @discardableResult
  public func setRuntimeMode(_ next: CanvastRuntimeMode) throws -> CanvastUserJourneySnapshot {
    try store.saveMode(projectRoot: projectState.projectRoot, mode: next, stateDirectory: stateDirectory)
    projectState = store.load(projectRoot: projectState.projectRoot, stateDirectory: stateDirectory)
    let localizedMode = humanized(next.rawValue, localizer: localizer)
    statusLine = localizer.text("Mode set to \(localizedMode)", "模式已设为 \(localizedMode)")
    return snapshot()
  }

  @discardableResult
  public func toggleMode() throws -> CanvastUserJourneySnapshot {
    try setRuntimeMode(projectState.runtimeMode == .enhanced ? .parity : .enhanced)
  }

  @discardableResult
  public func selectFeature(_ id: CanvastFeatureID) -> CanvastUserJourneySnapshot {
    selectedFeature = id
    if !visited.contains(id) { visited.append(id) }
    let feature = CanvastFeatureRegistry.feature(id)
    let title = feature?.title ?? humanized(id.rawValue, localizer: localizer)
    let action = feature?.command ?? localizer.text("state view", "状态视图")
    statusLine = "\(title): \(action)"
    setPanels(["Selected Feature", "Run", "Canvas", "Feature Catalog", "Inspector"])
    return snapshot()
  }

  @discardableResult
  public func prepareSelectedFeature() -> CanvastUserJourneySnapshot {
    guard let feature = CanvastFeatureRegistry.feature(selectedFeature) else {
      statusLine = localizer.text(
        "Feature not found: \(selectedFeature.rawValue)",
        "未找到能力：\(selectedFeature.rawValue)"
      )
      return snapshot()
    }
    statusLine = feature.command.map { "\(feature.title): \($0)" }
      ?? "\(feature.title): \(localizer.text("state view", "状态视图"))"
    setPanels(["Selected Feature", "Command", "Inspector"])
    return snapshot()
  }

  @discardableResult
  public func copySelectedCommand() -> CanvastUserJourneySnapshot {
    guard let feature = CanvastFeatureRegistry.feature(selectedFeature),
          let command = feature.command else {
      copiedCommand = nil
      statusLine = localizer.text(
        "No command for \(selectedFeature.rawValue)",
        "\(humanized(selectedFeature.rawValue, localizer: localizer)) 没有可复制命令"
      )
      return snapshot()
    }
    copiedCommand = command
    statusLine = localizer.text("Command copied: \(command)", "已复制命令：\(command)")
    return snapshot()
  }

  @discardableResult
  public func updatePrompt(_ next: String) -> CanvastUserJourneySnapshot {
    prompt = next
    statusLine = localizer.text("Prompt updated", "提示词已更新")
    return snapshot()
  }

  @discardableResult
  public func setThinkingLevel(_ next: String) -> CanvastUserJourneySnapshot {
    let normalized = next.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard ["minimal", "low", "medium", "high", "xhigh", "max"].contains(normalized) else {
      statusLine = localizer.text(
        "Unsupported thinking level: \(next)",
        "不支持的思考等级：\(next)"
      )
      return snapshot()
    }
    thinkingLevel = normalized
    let localizedThinking = humanized(normalized, localizer: localizer)
    statusLine = localizer.text(
      "Thinking level set to \(localizedThinking)",
      "思考等级已设为 \(localizedThinking)"
    )
    return snapshot()
  }

  @discardableResult
  public func buildLaunchPreview(timeoutSeconds: Int = 900) -> CanvastUserJourneySnapshot {
    do {
      let plan = try bridge.buildLaunchPlan(
        installRoot: installRoot,
        workspaceRoot: projectState.projectRoot,
        prompt: prompt.isEmpty ? localizer.text("Summarize current project state.", "总结当前项目状态。") : prompt,
        mode: projectState.runtimeMode,
        thinkingLevel: thinkingLevel,
        timeoutSeconds: timeoutSeconds
      )
      launchPreview = ([plan.executable.path] + plan.arguments).joined(separator: " ")
      statusLine = localizer.text("Launch preview ready", "启动预览已准备好")
    } catch {
      launchPreview = nil
      statusLine = localizer.text(
        "Cannot build launch plan: \(error)",
        "无法构建启动计划：\(error)"
      )
    }
    return snapshot()
  }

  public func verifyFullFeatureReachability() -> [String] {
    var gaps: [String] = []
    let visitedSet = Set(visited)
    for feature in CanvastFeatureRegistry.all where !visitedSet.contains(feature.id) {
      gaps.append(localizer.text(
        "feature not visited: \(feature.id.rawValue)",
        "能力尚未访问：\(feature.title)"
      ))
    }
    let visible = Set(panels)
    for required in ["Runtime Status", "Run", "Canvas", "Task Tree", "Sub-Agents", "Feature Catalog", "Inspector"] {
      if !visible.contains(required) && !panels.contains("Selected Feature") {
        gaps.append(localizer.text(
          "required panel not visible: \(required)",
          "必需面板不可见：\(Self.localizedPanelName(required, localizer: localizer))"
        ))
      }
    }
    return gaps
  }

  public func snapshot() -> CanvastUserJourneySnapshot {
    CanvastUserJourneySnapshot(
      projectRoot: projectState.projectRoot,
      runtimeMode: projectState.runtimeMode,
      selectedFeature: selectedFeature,
      statusLine: statusLine,
      prompt: prompt,
      thinkingLevel: thinkingLevel,
      copiedCommand: copiedCommand,
      launchPreview: launchPreview,
      visitedFeatureIDs: visited,
      visiblePanels: panels.map { Self.localizedPanelName($0, localizer: localizer) }
    )
  }

  fileprivate static func localizedPanelName(
    _ name: String,
    localizer: CanvastLocalizer = CanvastLocalizationRuntime.localizer
  ) -> String {
    switch name {
    case "Header": return localizer.text("Header", "页眉")
    case "Runtime Status": return localizer.text("Runtime Status", "运行时状态")
    case "Run": return localizer.dynamic("run")
    case "Canvas": return localizer.dynamic("canvas")
    case "Task Tree": return localizer.text("Task Tree", "任务树")
    case "Sub-Agents": return localizer.text("Sub-Agents", "子 Agent")
    case "Feature Catalog": return localizer.text("Feature Catalog", "能力目录")
    case "Inspector": return localizer.text("Inspector", "检查器")
    case "Selected Feature": return localizer.text("Selected Feature", "已选能力")
    case "Command": return localizer.dynamic("command")
    default: return localizer.exact(name)
    }
  }
}
