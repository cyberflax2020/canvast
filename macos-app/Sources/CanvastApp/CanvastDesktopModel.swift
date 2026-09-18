import Foundation
import CryptoKit
import SwiftUI
import AppKit
import CanvastAppCore

@MainActor
final class CanvastDesktopModel: ObservableObject {
  @Published var projectRoot: URL
  @Published var prompt: String
  @Published var state: CanvastProjectState
  @Published var workspaceIsConfigured: Bool
  @Published var selectedFeature: CanvastFeatureID
  @Published var selectedWorkspace: DesktopWorkspace
  @Published var statusLine: String
  @Published var thinkingLevel: String
  @Published var timeoutSeconds: Int
  @Published var runningInputDraft: String
  @Published var runState: DesktopRunState
  @Published var consoleEntries: [ConsoleEntry]
  @Published var launchPreview: String?
  @Published var actionState: DesktopActionState
  @Published private(set) var primaryActionSnapshot: DesktopActionSnapshot?
  @Published private(set) var recentActionSnapshots: [DesktopActionSnapshot]
  @Published var lastActionResult: CanvastDesktopActionResult?
  @Published var canvasGraph: CanvasGraphSnapshot
  @Published var selectedCanvasNodeID: String?
  @Published var canvasSearch: String
  @Published var canvasTypeFilter: CanvasNodeKind?
  @Published var toolsWorkspaceSection: ToolsWorkspaceSection
  @Published var navigationHistory: DesktopNavigationHistory
  @Published private(set) var selectedCanvasTaskID: String?
  @Published private(set) var selectedCanvasPlanID: String?
  @Published private(set) var projectScope: DesktopProjectScope?
  @Published private(set) var sandboxStatus: DesktopSandboxStatus?
  @Published var sandboxRevocationReceipt: DesktopSandboxRevocationReceipt?
  @Published private(set) var runtimeModeUpdate: DesktopRuntimeModeUpdate?
  @Published var pendingRuntimeModeSelection: CanvastRuntimeMode?
  @Published private(set) var requestControlResult: DesktopRequestControlResult?
  @Published private(set) var planLifecycleResult: DesktopPlanLifecycleResult?
  @Published private(set) var canvasTaskSelection: DesktopCanvasTaskSelection?
  @Published private(set) var canvasPlanSelection: DesktopCanvasPlanSelection?
  @Published var sessionCatalog: DesktopSessionCatalog?
  @Published var sessionTranscript: DesktopSessionTranscript?
  @Published var liveSessionMessages: [DesktopLiveSessionMessage]
  @Published private(set) var sessionOpenResult: DesktopSessionOpenResult?
  @Published private(set) var sessionRenameResult: DesktopSessionRenameResult?
  @Published private(set) var sessionCreationResult: DesktopSessionCreationResult?
  @Published private(set) var sessionDeleteReceipt: DesktopSessionDeleteReceipt?
  @Published private(set) var projectPreflightReceipt: DesktopProjectPreflightReceipt?
  @Published private(set) var projectLifecycleReceipt: DesktopProjectLifecycleReceipt?
  @Published private(set) var resumeActionResult: DesktopResumeActionResult?
  @Published private(set) var rootStatusSummary: DesktopRootStatusSummary
  @Published var settingsDraft: CanvastSettingsDraft
  @Published var runtimeAvailability: CanvastRuntimeAvailability
  @Published var providerAuthStatus: CanvastProviderAuthStatus
  @Published var connectionTestStatus: String
  @Published private(set) var resolvedLanguageState: CanvastResolvedLanguageState
  var projectDisplayPathOverride: String?
  var stateDirectoryDisplayPathOverride: String?
  var persistedStateRecordTimestampOverride: Date?
  var liveSessionTimestampOverride: Date?

  let store: CanvastStateStore
  let runtimeBridge: DesktopRuntimeBridging
  let graphStore: CanvasGraphStore
  let actionCenter: DesktopActionCenter
  let stateDirectoryOverride: URL?
  let settingsStore: CanvastDesktopSettingsStore
  let credentialStore: any CanvastCredentialStore
  let connectionTester: any CanvastConnectionTesting
  let bundleResourceURL: URL?
  var installRoot: URL?
  var providerConfiguration: CanvastProviderRuntimeConfiguration?
  var activeRuntimeConfigurationSignature: String?
  var settingsReloadTask: Task<Void, Never>?
  var settingsWindowController: NSWindowController?
  private var runtimeObserverToken: UUID?
  var activeRunRequestID: String?
  var pendingNativeCommands: [String: String] = [:]
  var pendingNativeActionIDs: [String: DesktopUIActionID] = [:]
  var pendingAbortTargets: [String: String] = [:]
  var forcedStopMessagesByTargetRequestID: [String: String] = [:]
  var pendingThinkingLevels: [String: String] = [:]
  var pendingThinkingConfirmations: [String: String] = [:]
  var pendingActionIDs: Set<String> = []
  var pendingActionKinds: [String: CanvastDesktopActionKind] = [:]
  var pendingUIActionIDs: [String: DesktopUIActionID] = [:]
  var pendingSandboxRevokeReconciliations: [String: DesktopSandboxRevokeReconciliation] = [:]
  var pendingCanvasExportCancellationTargets: [String: String] = [:]
  var localActionTasks: [DesktopUIActionID: Task<Void, Never>] = [:]
  var localActionTaskCorrelationIDs: [DesktopUIActionID: String] = [:]
  var observedProcessID: UUID?
  var observedStderrCount = 0
  var outputBuffers: [ConsoleChannel: String] = [:]
  private var persistedRefreshGeneration = 0
  private(set) var isPollingRefreshInFlight = false
  private var pollingRefreshCompletions: [() -> Void] = []
  private var needsProjectLifecycleWorkspaceRefresh = false
  private var needsProjectLifecycleSessionCatalogRefresh = false
  var liveSessionBaselineEntryCounts: [String: Int] = [:]
  var liveSessionRequestAliases: [String: String] = [:]

  init(
    projectRoot: URL? = nil,
    stateDirectory: URL? = nil,
    store: CanvastStateStore = CanvastStateStore(),
    runtimeBridge: DesktopRuntimeBridging = DesktopRuntimeBridgeAdapter(),
    graphStore: CanvasGraphStore = CanvasGraphStore(),
    actionCenter: DesktopActionCenter? = nil,
    initialSessionCatalog: DesktopSessionCatalog? = nil,
    settingsStore: CanvastDesktopSettingsStore? = nil,
    credentialStore: any CanvastCredentialStore = CanvastKeychainCredentialStore(),
    connectionTester: any CanvastConnectionTesting = CanvastConnectionTester(),
    bundleResourceURL: URL? = Bundle.main.resourceURL,
    automaticallyReloadSettings: Bool = true
  ) {
    self.store = store
    self.runtimeBridge = runtimeBridge
    self.graphStore = graphStore
    self.actionCenter = actionCenter ?? DesktopActionCenter()
    self.stateDirectoryOverride = stateDirectory
    let environmentWorkspace = CanvastDesktopModel.configuredWorkspaceURL()
    let bootstrapWorkspace = projectRoot ?? environmentWorkspace
    let resolvedSettingsStore = settingsStore ?? (projectRoot == nil
      ? CanvastDesktopSettingsStore()
      : CanvastDesktopSettingsStore(settingsURL: (stateDirectory
          ?? store.defaultStateDirectory(projectRoot: projectRoot!))
        .appendingPathComponent("app-settings.json")))
    self.settingsStore = resolvedSettingsStore
    self.credentialStore = credentialStore
    self.connectionTester = connectionTester
    self.bundleResourceURL = bundleResourceURL
    var initialPersistedSettings = (try? resolvedSettingsStore.load(
      defaults: .defaults(workspacePath: bootstrapWorkspace?.path ?? "")
    )) ?? .defaults(workspacePath: bootstrapWorkspace?.path ?? "")
    if Self.isUnconfiguredWorkspacePath(initialPersistedSettings.workspacePath) {
      initialPersistedSettings.workspacePath = ""
    }
    let initialResolvedLanguageState = CanvastAppLanguageResolver.resolve(
      preference: initialPersistedSettings.languagePreference
    )
    CanvastLocalizationRuntime.update(initialResolvedLanguageState)
    let savedWorkspace = initialPersistedSettings.workspacePath.trimmingCharacters(in: .whitespacesAndNewlines)
    let persistedWorkspace = Self.validWorkspaceURL(from: savedWorkspace)
    let configuredWorkspace = projectRoot ?? environmentWorkspace ?? persistedWorkspace
    if configuredWorkspace == nil {
      initialPersistedSettings.workspacePath = ""
    }
    let effectiveWorkspace = configuredWorkspace ?? Self.unconfiguredWorkspaceURL()
    self.projectRoot = effectiveWorkspace
    self.workspaceIsConfigured = configuredWorkspace != nil
    self.settingsDraft = CanvastSettingsDraft(settings: initialPersistedSettings)
    self.runtimeAvailability = .init(
      state: .missing, source: "unavailable", installRoot: nil,
      message: "Checking the bundled Canvast runtime."
    )
    self.providerAuthStatus = .missing
    self.connectionTestStatus = ""
    self.resolvedLanguageState = initialResolvedLanguageState
    self.installRoot = nil
    self.providerConfiguration = nil
    self.activeRuntimeConfigurationSignature = nil
    self.settingsReloadTask = nil
    self.settingsWindowController = nil
    let loadedState = store.load(projectRoot: effectiveWorkspace, stateDirectory: stateDirectory)
    self.state = loadedState
    self.prompt = ""
    self.selectedFeature = .canvas
    self.selectedWorkspace = .runConsole
    self.thinkingLevel = loadedState.runtimeStatus.model.thinkingLevel.isEmpty
      ? "medium"
      : loadedState.runtimeStatus.model.thinkingLevel
    self.timeoutSeconds = 900
    self.runningInputDraft = ""
    self.runState = .idle
    self.consoleEntries = []
    self.launchPreview = nil
    self.actionState = .idle
    self.primaryActionSnapshot = nil
    self.recentActionSnapshots = []
    self.lastActionResult = nil
    self.selectedCanvasNodeID = nil
    self.canvasSearch = ""
    self.canvasTypeFilter = nil
    self.toolsWorkspaceSection = .tools
    self.navigationHistory = DesktopNavigationHistory()
    self.selectedCanvasTaskID = nil
    self.selectedCanvasPlanID = nil
    self.projectScope = nil
    self.sandboxStatus = nil
    self.sandboxRevocationReceipt = nil
    self.runtimeModeUpdate = nil
    self.pendingRuntimeModeSelection = nil
    self.requestControlResult = nil
    self.planLifecycleResult = nil
    self.canvasTaskSelection = nil
    self.canvasPlanSelection = nil
    self.sessionCatalog = initialSessionCatalog
    self.sessionTranscript = nil
    self.liveSessionMessages = []
    self.sessionOpenResult = nil
    self.sessionRenameResult = nil
    self.sessionCreationResult = nil
    self.sessionDeleteReceipt = nil
    self.projectPreflightReceipt = nil
    self.projectLifecycleReceipt = nil
    self.resumeActionResult = nil
    self.rootStatusSummary = DesktopRootStatusSummary(loadedState.runtimeStatus.rootExecution)
    self.statusLine = configuredWorkspace == nil
      ? "Choose or create a workspace to start Canvast"
      : "Ready"
    self.canvasGraph = graphStore.load(from: stateDirectory ?? store.defaultStateDirectory(projectRoot: effectiveWorkspace))
    self.actionCenter.onChange = { [weak self] in
      Task { @MainActor [weak self] in self?.syncActionLifecycle() }
    }
    self.actionCenter.startAutoTick()
    self.runtimeObserverToken = runtimeBridge.observe { [weak self] event in
      Task { @MainActor [weak self] in self?.handleBridgeEvent(event) }
    }
    syncActionLifecycle()
    if automaticallyReloadSettings {
      reloadSettings()
    }
  }

  deinit {
    settingsReloadTask?.cancel()
    localActionTasks.values.forEach { $0.cancel() }
    if let runtimeObserverToken { runtimeBridge.removeObserver(runtimeObserverToken) }
    runtimeBridge.stopHost()
  }

  func applyLanguagePreference(_ preference: CanvastAppLanguagePreference) {
    let nextState = CanvastAppLanguageResolver.resolve(preference: preference)
    resolvedLanguageState = nextState
    CanvastLocalizationRuntime.update(nextState)
  }

  func retryAction(_ id: DesktopUIActionID) {
    actionCenter.retry(id)
  }

  func cancelAction(_ id: DesktopUIActionID) {
    actionCenter.requestCancel(id)
  }

  func rollbackAction(_ id: DesktopUIActionID) {
    actionCenter.rollback(id)
  }

  func reconcileAction(_ id: DesktopUIActionID) {
    actionCenter.reconcile(id)
  }

  var persistedStateRecords: [PersistedStateRecord] {
    guard workspaceIsConfigured else { return [] }
    let keys: Set<URLResourceKey> = [.isDirectoryKey, .fileSizeKey, .contentModificationDateKey]
    guard let urls = try? FileManager.default.contentsOfDirectory(
      at: stateDirectory,
      includingPropertiesForKeys: Array(keys),
      options: [.skipsHiddenFiles]
    ) else { return [] }
    return urls.sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }.map { url in
      let values = try? url.resourceValues(forKeys: keys)
      return PersistedStateRecord(
        url: url,
        name: url.lastPathComponent,
        isDirectory: values?.isDirectory == true,
        sizeBytes: values?.fileSize,
        modifiedAt: persistedStateRecordTimestampOverride ?? values?.contentModificationDate
      )
    }
  }

  func syncActionLifecycle() {
    primaryActionSnapshot = actionCenter.primarySnapshot
    recentActionSnapshots = actionCenter.recentSnapshots
    drainProjectLifecycleRefreshIntents()
    guard let snapshot = primaryActionSnapshot else {
      actionState = .idle
      return
    }
    switch snapshot.status {
    case .idle:
      actionState = .idle
    case .preparing, .queued, .running, .waiting, .reconciling:
      actionState = .sending(snapshot.message)
    case .succeeded:
      actionState = .succeeded(snapshot.message)
    case .failed, .timedOut:
      actionState = .failed(snapshot.message)
    case .cancelled, .outcomeUnknown:
      actionState = .degraded(snapshot.message)
    case .reconciled:
      actionState = .degraded(snapshot.message)
    }
  }

  func refresh() {
    guard workspaceIsConfigured else {
      statusLine = workspaceRequiredMessage()
      appendConsole(.standardError, statusLine)
      return
    }
    beginWorkspaceRefresh(.refreshWorkspace, message: "Workspace refreshed")
  }

  func refreshRuntimeState(completion: (() -> Void)? = nil) {
    guard workspaceIsConfigured else { return }
    if let completion { pollingRefreshCompletions.append(completion) }
    guard !isPollingRefreshInFlight else { return }
    isPollingRefreshInFlight = true
    let generation = persistedRefreshGeneration
    let projectRoot = projectRoot
    let stateDirectoryOverride = stateDirectoryOverride
    let stateDirectory = stateDirectory
    let store = store
    let graphStore = graphStore
    Task.detached(priority: .utility) {
      let loadedState = store.load(projectRoot: projectRoot, stateDirectory: stateDirectoryOverride)
      let loadedGraph = graphStore.load(from: stateDirectory)
      await MainActor.run { [weak self] in
        guard let self else { return }
        if self.isLatestPersistedRefresh(generation) {
          self.applyPersistedWorkspaceState(loadedState, canvasGraph: loadedGraph)
        }
        self.isPollingRefreshInFlight = false
        let completions = self.pollingRefreshCompletions
        self.pollingRefreshCompletions.removeAll(keepingCapacity: true)
        completions.forEach { $0() }
      }
    }
  }

  var hasCurrentPlanLifecycle: Bool {
    guard workspaceIsConfigured else { return false }
    let file = stateDirectory.appendingPathComponent("plan-mode-state.json")
    guard let data = try? Data(contentsOf: file),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          (object["version"] as? NSNumber)?.intValue == 1,
          let planID = object["planId"] as? String, !planID.isEmpty,
          object["task"] is String,
          let startedAt = object["startedAt"] as? String, !startedAt.isEmpty,
          object["approved"] is Bool,
          let stepIDs = object["stepIds"] as? [Any],
          stepIDs.allSatisfy({ $0 is String }) else { return false }
    return object["markdown"] == nil || object["markdown"] is NSNull || object["markdown"] is String
  }

  func refreshRuntimeState(
    actionID: DesktopUIActionID, correlationID: String, reconciliationID: String,
    completion: @escaping () -> Void
  ) {
    guard workspaceIsConfigured else {
      _ = actionCenter.returnToOutcomeUnknown(
        actionID, correlationID: correlationID, reconciliationID: reconciliationID,
        message: workspaceRequiredMessage()
      )
      return
    }
    let generation = nextPersistedRefreshGeneration()
    let projectRoot = projectRoot
    let stateDirectoryOverride = stateDirectoryOverride
    let stateDirectory = stateDirectory
    let store = store
    let graphStore = graphStore
    Task.detached(priority: .utility) {
      let loadedState = store.load(projectRoot: projectRoot, stateDirectory: stateDirectoryOverride)
      let loadedGraph = graphStore.load(from: stateDirectory)
      await MainActor.run { [weak self] in
        self?.commitReconciledRuntimeState(
          loadedState, canvasGraph: loadedGraph, actionID: actionID,
          correlationID: correlationID, reconciliationID: reconciliationID,
          refreshGeneration: generation, completion: completion
        )
      }
    }
  }

  func commitReconciledRuntimeState(
    _ loadedState: CanvastProjectState, canvasGraph loadedGraph: CanvasGraphSnapshot,
    actionID: DesktopUIActionID, correlationID: String, reconciliationID: String,
    refreshGeneration: Int,
    completion: () -> Void
  ) {
    guard isLatestPersistedRefresh(refreshGeneration) else {
      _ = actionCenter.returnToOutcomeUnknown(
        actionID, correlationID: correlationID, reconciliationID: reconciliationID,
        message: "A newer persisted-state refresh superseded this reconciliation. Refresh again to verify the outcome."
      )
      return
    }
    guard actionCenter.isCurrentReconciliation(
      actionID, correlationID: correlationID, reconciliationID: reconciliationID
    ) else { return }
    applyPersistedWorkspaceState(loadedState, canvasGraph: loadedGraph)
    completion()
  }

  func refreshCanvas() {
    guard requireConfiguredWorkspace(actionID: .refreshCanvas) else { return }
    let id = DesktopUIActionID.refreshCanvas
    let correlationID = UUID().uuidString
    let stateDirectory = stateDirectory
    let graphStore = graphStore
    guard beginAsyncLocalAction(id, correlationID: correlationID, retry: { [weak self] in self?.refreshCanvas() }) else { return }
    let generation = nextPersistedRefreshGeneration()
    reserveLocalActionTask(id, correlationID: correlationID)
    let refreshTask = Task.detached(priority: .userInitiated) {
      let graph = graphStore.load(from: stateDirectory)
      guard !Task.isCancelled else { return }
      await self.commitCanvasRefresh(
        graph, id: id, correlationID: correlationID, refreshGeneration: generation
      )
    }
    installLocalActionTask(refreshTask, for: id, correlationID: correlationID)
  }

  func focusCanvasNode(_ id: String?) {
    navigate(to: .canvas, feature: .canvas, canvasNodeID: id)
    if let id {
      statusLine = localizer.text(
        "Focused Canvas node \(id)",
        "已聚焦画布节点 \(id)"
      )
    }
  }

  func searchCanvas(for text: String, type: CanvasNodeKind? = nil) {
    canvasSearch = text
    canvasTypeFilter = type
    navigate(to: .canvas, feature: .canvas)
    recordLocalFilterAction(.filterCanvasSnapshot, message: "Searching Canvas for \(text)")
  }

  private func beginWorkspaceRefresh(_ id: DesktopUIActionID, message: String) {
    guard workspaceIsConfigured else {
      failLocalGate(actionID: id, message: workspaceRequiredMessage(), label: "Workspace required")
      return
    }
    let correlationID = UUID().uuidString
    let projectRoot = projectRoot
    let stateDirectoryOverride = stateDirectoryOverride
    let stateDirectory = stateDirectory
    let store = store
    let graphStore = graphStore
    guard beginAsyncLocalAction(id, correlationID: correlationID, retry: { [weak self] in self?.refresh() }) else { return }
    let generation = nextPersistedRefreshGeneration()
    reserveLocalActionTask(id, correlationID: correlationID)
    let refreshTask = Task.detached(priority: .userInitiated) {
      let loadedState = store.load(projectRoot: projectRoot, stateDirectory: stateDirectoryOverride)
      let loadedGraph = graphStore.load(from: stateDirectory)
      guard !Task.isCancelled else { return }
      await self.commitWorkspaceRefresh(
        loadedState, canvasGraph: loadedGraph, id: id, correlationID: correlationID,
        refreshGeneration: generation, message: message
      )
    }
    installLocalActionTask(refreshTask, for: id, correlationID: correlationID)
  }

  private func commitWorkspaceRefresh(
    _ loadedState: CanvastProjectState, canvasGraph loadedGraph: CanvasGraphSnapshot,
    id: DesktopUIActionID, correlationID: String, refreshGeneration: Int, message: String
  ) {
    guard isLatestPersistedRefresh(refreshGeneration) else {
      actionCenter.succeed(id, correlationID: correlationID, message: "Superseded by a newer workspace refresh")
      finishLocalActionTask(id, correlationID: correlationID)
      return
    }
    guard actionCenter.isCurrentExecution(id, correlationID: correlationID) else { return }
    applyPersistedWorkspaceState(loadedState, canvasGraph: loadedGraph)
    actionCenter.succeed(id, correlationID: correlationID, message: message)
    statusLine = message
    finishLocalActionTask(id, correlationID: correlationID)
  }

  func commitCanvasRefresh(
    _ graph: CanvasGraphSnapshot, id: DesktopUIActionID, correlationID: String,
    refreshGeneration: Int
  ) {
    guard isLatestPersistedRefresh(refreshGeneration) else {
      actionCenter.succeed(id, correlationID: correlationID, message: "Superseded by a newer persisted-state refresh")
      finishLocalActionTask(id, correlationID: correlationID)
      return
    }
    guard actionCenter.isCurrentExecution(id, correlationID: correlationID) else { return }
    applyCanvasGraph(graph)
    actionCenter.succeed(id, correlationID: correlationID, message: "Canvas refreshed")
    statusLine = "Canvas refreshed"
    finishLocalActionTask(id, correlationID: correlationID)
  }

  func applyPersistedWorkspaceState(_ loadedState: CanvastProjectState, canvasGraph loadedGraph: CanvasGraphSnapshot) {
    let resolvedRuntimeMode = pendingRuntimeModeSelection ?? loadedState.runtimeMode
    state = CanvastProjectState(
      projectRoot: loadedState.projectRoot,
      runtimeMode: resolvedRuntimeMode,
      graph: loadedState.graph,
      closure: loadedState.closure,
      runtimeStatus: loadedState.runtimeStatus,
      context: loadedState.context,
      sessions: loadedState.sessions,
      features: loadedState.features
    )
    if !loadedState.runtimeStatus.model.thinkingLevel.isEmpty { thinkingLevel = loadedState.runtimeStatus.model.thinkingLevel }
    rootStatusSummary = DesktopRootStatusSummary(loadedState.runtimeStatus.rootExecution)
    applyCanvasGraph(loadedGraph)
  }

  func nextPersistedRefreshGeneration() -> Int {
    persistedRefreshGeneration += 1
    return persistedRefreshGeneration
  }

  func isLatestPersistedRefresh(_ generation: Int) -> Bool {
    generation == persistedRefreshGeneration
  }

  private func applyCanvasGraph(_ loadedGraph: CanvasGraphSnapshot) {
    canvasGraph = loadedGraph
    if let selectedCanvasNodeID, !canvasGraph.nodes.contains(where: { $0.id == selectedCanvasNodeID }) {
      self.selectedCanvasNodeID = nil
    }
  }

  func prepareRequest(_ request: String, status: String) {
    guard requireConfiguredWorkspace(actionLabel: status) else { return }
    prompt = request
    navigate(to: .runConsole, feature: .chat)
    statusLine = status
  }

  func copyText(_ text: String, status: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
    statusLine = status
  }

  func selectFeature(_ feature: CanvastFeature) {
    let workspace = workspace(for: feature.id)
    navigate(to: workspace, feature: feature.id, toolsSection: toolsSection(for: feature.id))
    statusLine = "\(feature.title): \(feature.command ?? "state view")"
  }

  func prepareFeature(_ feature: CanvastFeature) {
    guard requireConfiguredWorkspace(actionLabel: "feature preparation") else { return }
    if let command = feature.command {
      prompt = command + (prompt.isEmpty ? " " : "\n\n\(prompt)")
      navigate(to: .runConsole, feature: feature.id)
      statusLine = "Prepared \(feature.title) in Run Console"
    } else {
      navigate(to: workspace(for: feature.id), feature: feature.id, toolsSection: toolsSection(for: feature.id))
      statusLine = "Inspecting \(feature.title)"
    }
  }

  func copyFeatureCommand(_ feature: CanvastFeature) {
    guard let command = feature.command else { return }
    copyText(command, status: "Copied \(feature.title) command")
  }

  func makeLaunchPlan() throws -> CanvastLaunchPlan {
    guard workspaceIsConfigured else { throw AppSelfContainedError(workspaceRequiredMessage()) }
    guard providerCredentialIsConfigured else {
      throw AppSelfContainedError(providerCredentialRequiredMessage())
    }
    let providerConfiguration = try resolvedProviderConfiguration()
    return try runtimeBridge.makePlan(
      installRoot: try resolvedInstallRoot(),
      workspaceRoot: projectRoot,
      mode: displayedRuntimeMode,
      thinkingLevel: thinkingLevel,
      timeoutSeconds: timeoutSeconds,
      providerConfiguration: providerConfiguration
    )
  }

  func runtimeConfigurationSignature(_ configuration: CanvastProviderRuntimeConfiguration?) -> String {
    guard let configuration else {
      return [
        projectRoot.standardizedFileURL.resolvingSymlinksInPath().path,
        "__provider_not_required__",
        displayedRuntimeMode.rawValue,
        thinkingLevel,
      ].joined(separator: "\u{1F}")
    }
    return [
      projectRoot.standardizedFileURL.resolvingSymlinksInPath().path,
      configuration.provider,
      configuration.model,
      configuration.baseURL?.absoluteString ?? "",
      SHA256.hash(data: Data(configuration.apiKey.utf8)).map { String(format: "%02x", $0) }.joined(),
    ].joined(separator: "\u{1F}")
  }

  var runPrompt: String {
    let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? "Summarize the current project state." : trimmed
  }

  func ensureRuntimeHost(plan: CanvastLaunchPlan? = nil) throws {
    let providerConfiguration = try resolvedProviderConfiguration()
    try ensureRuntimeHost(providerConfiguration: providerConfiguration, plan: plan)
  }

  func ensureRuntimeHost(
    providerConfiguration: CanvastProviderRuntimeConfiguration?,
    plan: CanvastLaunchPlan? = nil
  ) throws {
    if providerConfiguration == nil, runtimeBridge.isRunning {
      return
    }
    let signature = runtimeConfigurationSignature(providerConfiguration)
    if runtimeBridge.isRunning, activeRuntimeConfigurationSignature != signature {
      runtimeBridge.stopHost()
      activeRuntimeConfigurationSignature = nil
      if runtimeBridge.isRunning {
        throw AppSelfContainedError(localizer.text(
          "Provider settings changed. The runtime host is restarting; try again in a moment.",
          "服务商配置已变化。运行时正在重启，请稍后再试。"
        ))
      }
    }
    guard !runtimeBridge.isRunning else { return }
    observedProcessID = nil
    observedStderrCount = 0
    try runtimeBridge.start(plan: plan ?? runtimeBridge.makePlan(
      installRoot: try resolvedInstallRoot(),
      workspaceRoot: projectRoot,
      mode: displayedRuntimeMode,
      thinkingLevel: thinkingLevel,
      timeoutSeconds: timeoutSeconds,
      providerConfiguration: providerConfiguration
    ))
    activeRuntimeConfigurationSignature = signature
    appendConsole(.system, "Persistent RPC host started.")
  }

  func applyTypedResult(_ response: CanvastDesktopActionResult, kind pendingKind: CanvastDesktopActionKind?) {
    guard let result = response.result else { return }
    let kind = pendingKind?.rawValue ?? stringValue(result["acceptedKind"]) ?? stringValue(result["kind"])
    switch kind {
    case CanvastDesktopActionKind.newSession.rawValue:
      if let decoded = decodeSessionCreationResult(result, fallback: actionResultSummary(response)) {
        sessionCreationResult = decoded
      }
    case CanvastDesktopActionKind.sessionCatalog.rawValue:
      if let decoded = decodeSessionCatalog(result, fallback: actionResultSummary(response)) {
        sessionCatalog = decoded
        Task { @MainActor [weak self] in
          await Task.yield()
          self?.synchronizeCurrentConversationStateIfPossible()
        }
      }
    case CanvastDesktopActionKind.sessionOpen.rawValue:
      if let decoded = decodeSessionOpenResult(result, fallback: actionResultSummary(response)) {
        sessionOpenResult = decoded
      }
    case CanvastDesktopActionKind.sessionRename.rawValue:
      if let decoded = decodeSessionRenameResult(result, fallback: actionResultSummary(response)) {
        sessionRenameResult = decoded
      }
    case CanvastDesktopActionKind.sessionDelete.rawValue:
      if let decoded = decodeSessionDeleteReceipt(result, fallback: actionResultSummary(response)) {
        sessionDeleteReceipt = decoded
      }
    case CanvastDesktopActionKind.sessionTranscript.rawValue:
      if let decoded = decodeSessionTranscript(result, fallback: actionResultSummary(response)) {
        sessionTranscript = decoded
      }
    case CanvastDesktopActionKind.projectPreflight.rawValue:
      if let decoded = decodeProjectPreflightReceipt(result, fallback: actionResultSummary(response)) {
        projectPreflightReceipt = decoded
      }
    case CanvastDesktopActionKind.projectCreate.rawValue,
         CanvastDesktopActionKind.projectOpen.rawValue,
         CanvastDesktopActionKind.projectReinitialize.rawValue,
         CanvastDesktopActionKind.projectDelete.rawValue:
      if let decoded = decodeProjectLifecycleReceipt(result, fallback: actionResultSummary(response)) {
        applyProjectLifecycleReceipt(decoded)
      }
    case CanvastDesktopActionKind.setRuntimeMode.rawValue:
      applyRuntimeModeResult(result)
    case CanvastDesktopActionKind.requestControl.rawValue:
      applyRequestControlResult(result, actionRequestID: response.requestID)
    case CanvastDesktopActionKind.inspectResume.rawValue,
         CanvastDesktopActionKind.chooseResume.rawValue,
         CanvastDesktopActionKind.claimResume.rawValue,
         CanvastDesktopActionKind.rebindResume.rawValue,
         CanvastDesktopActionKind.retireResume.rawValue,
         CanvastDesktopActionKind.reconcileResume.rawValue:
      if let decoded = decodeResumeActionResult(result, fallback: actionResultSummary(response)) {
        resumeActionResult = decoded
      }
    case CanvastDesktopActionKind.approvePlan.rawValue, CanvastDesktopActionKind.completePlan.rawValue:
      planLifecycleResult = DesktopPlanLifecycleResult(
        planID: stringValue(result["planId"]) ?? "",
        status: stringValue(result["status"]) ?? "",
        message: stringValue(result["message"]) ?? actionResultSummary(response)
      )
    case CanvastDesktopActionKind.selectCanvasTask.rawValue:
      let nodeID = stringValue(result["nodeId"]) ?? ""
      let currentTaskID = stringValue(result["currentTaskId"]) ?? nodeID
      selectedCanvasTaskID = currentTaskID
      canvasTaskSelection = DesktopCanvasTaskSelection(
        nodeID: nodeID, currentTaskID: currentTaskID,
        nodeType: stringValue(result["nodeType"]) ?? "",
        message: stringValue(result["message"]) ?? actionResultSummary(response)
      )
    case CanvastDesktopActionKind.selectCanvasPlan.rawValue:
      let planID = stringValue(result["planId"]) ?? ""
      let activePlanID = stringValue(result["activePlanId"]) ?? planID
      selectedCanvasPlanID = activePlanID
      canvasPlanSelection = DesktopCanvasPlanSelection(
        planID: planID, activePlanID: activePlanID,
        nodeType: stringValue(result["nodeType"]) ?? "",
        message: stringValue(result["message"]) ?? actionResultSummary(response)
      )
    case CanvastDesktopActionKind.inspectProjectScope.rawValue, CanvastDesktopActionKind.rebindProjectScope.rawValue:
      projectScope = decodeProjectScope(result)
    case CanvastDesktopActionKind.inspectSandbox.rawValue, CanvastDesktopActionKind.setSandboxProfile.rawValue,
         CanvastDesktopActionKind.grantSandboxAccess.rawValue,
         CanvastDesktopActionKind.revokeSandboxAccess.rawValue:
      sandboxStatus = decodeSandboxStatus(result)
      if pendingKind == .revokeSandboxAccess {
        sandboxRevocationReceipt = decodeSandboxRevocationReceipt(result)
      }
    default:
      // Older test/runtime adapters may only echo acceptedKind. The action
      // still completed, but there is no richer typed projection to apply.
      break
    }
  }

  func applyRuntimeModeResult(_ result: [String: CanvastJSONValue]) {
    let modeState = objectValue(result["state"]) ?? [:]
    guard let rawMode = stringValue(modeState["mode"]),
          let mode = CanvastRuntimeMode(rawValue: rawMode) else { return }
    let effective = CanvastRuntimeMode(rawValue: stringValue(result["effectiveMode"]) ?? rawMode) ?? mode
    pendingRuntimeModeSelection = nil
    runtimeModeUpdate = DesktopRuntimeModeUpdate(
      mode: mode, effectiveMode: effective, scope: stringValue(result["scope"]) ?? "session",
      source: stringValue(modeState["source"]), updatedAt: stringValue(modeState["updatedAt"]),
      revision: integerValue(modeState["revision"]), reason: stringValue(modeState["reason"]),
      message: stringValue(result["message"]) ?? "Runtime mode set to \(effective.rawValue)"
    )
    state = CanvastProjectState(
      projectRoot: state.projectRoot, runtimeMode: effective, graph: state.graph, closure: state.closure,
      runtimeStatus: state.runtimeStatus, context: state.context, sessions: state.sessions, features: state.features
    )
  }

  func commitLocalRuntimeMode(
    _ next: CanvastRuntimeMode,
    source: String,
    reason: String,
    message: String
  ) {
    pendingRuntimeModeSelection = nil
    runtimeModeUpdate = DesktopRuntimeModeUpdate(
      mode: next,
      effectiveMode: next,
      scope: "session",
      source: source,
      updatedAt: ISO8601DateFormatter().string(from: Date()),
      revision: nil,
      reason: reason,
      message: message
    )
    state = CanvastProjectState(
      projectRoot: state.projectRoot,
      runtimeMode: next,
      graph: state.graph,
      closure: state.closure,
      runtimeStatus: state.runtimeStatus,
      context: state.context,
      sessions: state.sessions,
      features: state.features
    )
  }

  func applyRequestControlResult(_ result: [String: CanvastJSONValue], actionRequestID: String) {
    guard let rawPolicy = stringValue(result["policy"]),
          let policy = CanvastRuntimeRequestControlPolicy(rawValue: rawPolicy) else { return }
    let runtimeRequestID = stringValue(result["runtimeRequestId"]) ?? ""
    let queueStatus = stringValue(result["queueStatus"]) ?? ""
    let deliveryMode = stringValue(result["deliveryMode"]) ?? ""
    let requestKind = stringValue(result["requestKind"]) ?? ""
    let affectsActiveWork = booleanValue(result["affectsActiveWork"]) ?? false
    let message = stringValue(result["message"]) ?? "Request control accepted"
    requestControlResult = DesktopRequestControlResult(
      runtimeRequestID: runtimeRequestID, policy: policy, queueStatus: queueStatus,
      deliveryMode: deliveryMode, requestKind: requestKind,
      affectsActiveWork: affectsActiveWork, message: message
    )
    if !runtimeRequestID.isEmpty {
      linkLiveSessionRequestAlias(runtimeRequestID, to: actionRequestID)
    }
    appendLiveProcessMessage(message, eventType: "request_control", requestID: actionRequestID)
  }

  func applyProjectLifecycleReceipt(_ receipt: DesktopProjectLifecycleReceipt) {
    projectLifecycleReceipt = receipt

    let activeProjectURL = URL(
      fileURLWithPath: receipt.activeProjectRoot,
      isDirectory: true
    ).standardizedFileURL

    projectRoot = activeProjectURL
    workspaceIsConfigured = true
    settingsDraft.workspacePath = activeProjectURL.path
    pendingRuntimeModeSelection = nil
    state = CanvastProjectState(
      projectRoot: activeProjectURL,
      runtimeMode: displayedRuntimeMode,
      graph: state.graph,
      closure: state.closure,
      runtimeStatus: state.runtimeStatus,
      context: state.context,
      sessions: state.sessions,
      features: state.features
    )

    needsProjectLifecycleWorkspaceRefresh = true
    needsProjectLifecycleSessionCatalogRefresh = true
    Task { @MainActor [weak self] in
      await Task.yield()
      self?.drainProjectLifecycleRefreshIntents()
    }
  }

  private func drainProjectLifecycleRefreshIntents() {
    if needsProjectLifecycleWorkspaceRefresh, !isActionLocked(.refreshWorkspace) {
      needsProjectLifecycleWorkspaceRefresh = false
      refresh()
    }
    if needsProjectLifecycleSessionCatalogRefresh, !isActionLocked(.loadSessionCatalog) {
      needsProjectLifecycleSessionCatalogRefresh = false
      loadSessionCatalog()
    }
  }

  func decodeProjectScope(_ result: [String: CanvastJSONValue]) -> DesktopProjectScope? {
    let scopeState = objectValue(result["state"]) ?? objectValue(legacyDetails(result)["state"]) ?? [:]
    guard let relation = stringValue(result["relation"]),
          let persistedRoot = stringValue(scopeState["projectRoot"]) else { return nil }
    return DesktopProjectScope(
      currentProjectRoot: stringValue(result["currentProjectRoot"]) ?? projectRoot.path, relation: relation,
      canLoadCanvas: booleanValue(result["canLoadCanvas"]),
      canInjectScopedView: booleanValue(result["canInjectScopedView"]),
      advisory: stringValue(result["advisory"]) ?? "", persistedProjectRoot: persistedRoot,
      updatedAt: stringValue(scopeState["updatedAt"]), revision: integerValue(scopeState["revision"]),
      source: stringValue(scopeState["source"]), canvasReloaded: booleanValue(result["canvasReloaded"])
    )
  }

  func decodeSandboxStatus(_ result: [String: CanvastJSONValue]) -> DesktopSandboxStatus? {
    let details = legacyDetails(result)
    let config = objectValue(result["config"]) ?? objectValue(details["config"]) ?? [:]
    guard let profile = stringValue(config["profile"]) ?? stringValue(result["profile"]) else { return nil }
    let grantValues = arrayValue(result["grants"]) ?? arrayValue(details["grants"]) ?? []
    let grants = grantValues.compactMap(objectValue).map { grant in
      DesktopSandboxGrant(
        id: stringValue(grant["id"]) ?? "", scope: stringValue(grant["scope"]) ?? "",
        kind: stringValue(grant["kind"]) ?? "", value: stringValue(grant["value"]) ?? "",
        createdAt: stringValue(grant["createdAt"]) ?? "", reason: stringValue(grant["reason"])
      )
    }
    return DesktopSandboxStatus(
      version: integerValue(result["version"]) ?? integerValue(details["version"]),
      revision: integerValue(result["revision"]) ?? integerValue(details["revision"]),
      config: DesktopSandboxConfig(
        profile: profile, permissionMode: stringValue(config["permissionMode"]),
        unattended: booleanValue(config["unattended"]), network: stringValue(config["network"]),
        projectRoot: stringValue(config["projectRoot"]), writableRoots: stringsValue(config["writableRoots"])
      ),
      grants: grants, status: stringValue(result["status"]) ?? stringValue(details["status"]),
      message: stringValue(result["message"]), decision: decodeSandboxDecision(result["decision"] ?? details["decision"])
    )
  }

  func applyReconciledSandboxStatus(_ status: DesktopSandboxStatus) {
    sandboxStatus = status
  }

  func consume(_ chunk: String, channel: ConsoleChannel) {
    let buffered = outputBuffers[channel, default: ""] + chunk
    let parts = buffered.components(separatedBy: .newlines)
    outputBuffers[channel] = parts.last ?? ""
    for line in parts.dropLast() where !line.isEmpty {
      appendConsole(channel, line)
    }
  }

  func completeRun(exitCode: Int32) {
    if let remainder = outputBuffers[.standardOutput], !remainder.isEmpty { appendConsole(.standardOutput, remainder) }
    if let remainder = outputBuffers[.standardError], !remainder.isEmpty { appendConsole(.standardError, remainder) }
    outputBuffers.removeAll()
    let settledRequestID = activeRunRequestID
    let forcedStopMessage = settledRequestID.flatMap { forcedStopMessagesByTargetRequestID.removeValue(forKey: $0) }
    let hadPendingAbort = settledRequestID.map { requestID in
      pendingAbortTargets.contains { $0.value == requestID }
    } ?? false
    let normalizedExitCode: Int32 = (forcedStopMessage != nil || hadPendingAbort) ? 130 : exitCode
    activeRunRequestID = nil
    runState = .finished(normalizedExitCode)
    if forcedStopMessage != nil {
      statusLine = "Timed-out Canvast run was terminated and settled"
    } else if hadPendingAbort {
      statusLine = "Canvast run stopped"
    } else {
      statusLine = normalizedExitCode == 0 ? "Canvast run completed" : "Canvast run exited with code \(normalizedExitCode)"
    }
    if let settledRequestID {
      pendingNativeCommands.removeValue(forKey: settledRequestID)
      completeNativeRPCAction(
        settledRequestID,
        message: statusLine,
        failed: forcedStopMessage == nil && !hadPendingAbort && normalizedExitCode != 0,
        cancelled: forcedStopMessage != nil || hadPendingAbort
      )
      if forcedStopMessage != nil || hadPendingAbort {
        settlePendingAbortRequest(for: settledRequestID, message: statusLine)
      }
    }
    appendConsole(.system, statusLine)
    refreshRuntimeState()
    finalizeLiveSessionTurn(requestID: settledRequestID, succeeded: normalizedExitCode == 0)
    refreshActiveSessionTranscriptIfVisible()
  }

  func appendConsole(_ channel: ConsoleChannel, _ text: String) {
    consoleEntries.append(ConsoleEntry(channel: channel, text: text))
    if consoleEntries.count > 5_000 { consoleEntries.removeFirst(consoleEntries.count - 5_000) }
  }

}

private enum DesktopModelError: LocalizedError {
  case unavailable
  var errorDescription: String? { "The desktop runtime is unavailable." }
}

struct AppSelfContainedError: LocalizedError {
  let detail: String
  init(_ detail: String) { self.detail = detail }
  var errorDescription: String? { detail }
}
