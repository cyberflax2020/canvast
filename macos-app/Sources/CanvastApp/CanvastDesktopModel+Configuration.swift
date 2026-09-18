import Foundation
import CanvastAppCore

@MainActor
extension CanvastDesktopModel {
  var selectedCanvasNode: CanvasGraphNode? {
    guard let selectedCanvasNodeID else { return nil }
    return canvasGraph.nodes.first { $0.id == selectedCanvasNodeID }
  }

  var selectedFeatureValue: CanvastFeature? {
    CanvastFeatureRegistry.feature(selectedFeature)
  }

  var stateDirectory: URL {
    stateDirectoryOverride ?? store.defaultStateDirectory(projectRoot: projectRoot)
  }

  var projectDisplayPath: String {
    guard workspaceIsConfigured else {
      return localizer.text("No workspace selected", "未选择工作区")
    }
    return projectDisplayPathOverride ?? projectRoot.path
  }

  var displayedRuntimeMode: CanvastRuntimeMode {
    pendingRuntimeModeSelection ?? state.runtimeMode
  }

  var providerCredentialIsConfigured: Bool {
    providerAuthStatus.isAuthenticated && settingsDraft.hasCredentialMarker(for: settingsDraft.provider)
  }

  var workbenchIsConfigured: Bool {
    workspaceIsConfigured && providerCredentialIsConfigured
  }

  var canManageSessions: Bool {
    workspaceIsConfigured
  }

  var stateDirectoryDisplayPath: String {
    guard workspaceIsConfigured else {
      return localizer.text("Available after a workspace is selected", "选择工作区后可用")
    }
    return stateDirectoryDisplayPathOverride ?? stateDirectory.path
  }

  func actionSnapshot(_ id: DesktopUIActionID) -> DesktopActionSnapshot? {
    actionCenter.snapshot(for: id)
  }

  func isActionLocked(_ id: DesktopUIActionID) -> Bool {
    actionCenter.isLocked(id)
  }

  func actionLockMessage(_ id: DesktopUIActionID) -> String? {
    actionCenter.lockHolder(for: id)?.message
  }

  var languagePreference: CanvastAppLanguagePreference {
    settingsDraft.languagePreference
  }

  var localizer: CanvastLocalizer {
    CanvastLocalizer(state: resolvedLanguageState)
  }

  var localizedStatusLine: String {
    localizer.exact(statusLine)
  }

  nonisolated static func unconfiguredWorkspaceURL() -> URL {
    let applicationSupport = FileManager.default.urls(
      for: .applicationSupportDirectory, in: .userDomainMask
    ).first ?? FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Application Support", isDirectory: true)
    return applicationSupport
      .appendingPathComponent("Canvast", isDirectory: true)
      .appendingPathComponent("WorkspaceNotConfigured", isDirectory: true)
  }

  nonisolated static func isUnconfiguredWorkspacePath(_ path: String) -> Bool {
    let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return false }
    let standardized = URL(fileURLWithPath: trimmed, isDirectory: true).standardizedFileURL.path
    return standardized == "/CanvastWorkspaceNotConfigured"
      || standardized == unconfiguredWorkspaceURL().standardizedFileURL.path
  }

  nonisolated static func validWorkspaceURL(from path: String) -> URL? {
    let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, !isUnconfiguredWorkspacePath(trimmed) else { return nil }
    let url = URL(fileURLWithPath: trimmed, isDirectory: true)
      .standardizedFileURL
      .resolvingSymlinksInPath()
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory),
          isDirectory.boolValue else { return nil }
    return url
  }

  func workspaceRequiredMessage() -> String {
    localizer.text(
      "Choose or create a workspace before using Canvast.",
      "请先选择或新建工作区，然后再使用 Canvast。"
    )
  }

  func providerCredentialRequiredMessage() -> String {
    localizer.text(
      "Add and save a provider API key in Settings before sending prompts, exporting Canvas, or starting model-backed runtime actions.",
      "请先在设置中添加并保存服务商 API 密钥，然后再发送提示词、导出画布或启动依赖模型的运行时操作。"
    )
  }

  func requiresProviderCredential(_ id: DesktopUIActionID) -> Bool {
    switch id {
    case .saveSettings, .testProviderConnection, .applyProviderSettings,
         .revokeProviderCredential, .clearConsole, .refreshWorkspace,
         .filterCanvasSnapshot, .reloadPersistedSnapshot, .setThinkingLevel,
         .setRuntimeMode,
         .startNewSession, .loadSessionCatalog, .openSession, .renameSession,
         .deleteSession, .loadSessionTranscript,
         .runProjectPreflight, .createProjectSession, .openProjectSession,
         .reinitializeProject, .retireProject,
         .restartProjectRuntime, .inspectProjectScope, .rebindProjectScope,
         .inspectSandbox, .setSandboxProfile, .grantSandboxAccess, .revokeSandboxAccess,
         .setPermissionMode, .selectCanvasTask, .selectCanvasPlan:
      return false
    default:
      return true
    }
  }

  func dispatchRequiresProviderConfiguration(_ id: DesktopUIActionID) -> Bool {
    switch id {
    case .setRuntimeMode,
         .startNewSession, .loadSessionCatalog, .openSession, .renameSession,
         .deleteSession, .loadSessionTranscript,
         .runProjectPreflight, .createProjectSession, .openProjectSession,
         .reinitializeProject, .retireProject,
         .restartProjectRuntime, .inspectProjectScope, .rebindProjectScope,
         .inspectSandbox, .setSandboxProfile, .grantSandboxAccess, .revokeSandboxAccess,
         .setPermissionMode, .selectCanvasTask, .selectCanvasPlan:
      return false
    default:
      return true
    }
  }

  @discardableResult
  func requireConfiguredWorkspace(
    actionID: DesktopUIActionID? = nil,
    actionLabel _: String? = nil
  ) -> Bool {
    if !workspaceIsConfigured {
      let message = workspaceRequiredMessage()
      failLocalGate(actionID: actionID, message: message, label: "Workspace required")
      return false
    }
    if let actionID, requiresProviderCredential(actionID), !providerCredentialIsConfigured {
      let message = providerCredentialRequiredMessage()
      failLocalGate(actionID: actionID, message: message, label: "Provider API key required")
      return false
    }
    if actionID == nil, !providerCredentialIsConfigured {
      let message = providerCredentialRequiredMessage()
      failLocalGate(actionID: nil, message: message, label: "Provider API key required")
      return false
    }
    return true
  }

  func failLocalGate(actionID: DesktopUIActionID?, message: String, label: String) {
    statusLine = message
    appendConsole(.standardError, message)
    if let actionID {
      let correlationID = UUID().uuidString
      let spec = DesktopActionRegistry.spec(for: actionID)
      if case .started = actionCenter.begin(
        spec: spec,
        correlationID: correlationID,
        stage: .init(.localState, label: label, detail: message)
      ) {
        actionCenter.fail(
          actionID,
          correlationID: correlationID,
          message: message,
          stage: .init(.complete, label: label, detail: message)
        )
      }
    }
  }
}
