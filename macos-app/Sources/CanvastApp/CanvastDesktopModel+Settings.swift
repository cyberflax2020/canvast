import AppKit
import Foundation
import SwiftUI
import CanvastAppCore

private enum CanvastDesktopSettingsError: LocalizedError {
  case missingWorkspace
  case invalidWorkspace(URL)
  case missingProvider
  case missingModel
  case invalidBaseURL
  case missingCredential(String)
  case activeRun
  case runtimeStopTimedOut

  var errorDescription: String? {
    let localizer = CanvastLocalizationRuntime.localizer
    switch self {
    case .missingWorkspace:
      return localizer.text(
        "Choose a workspace directory in Settings.",
        "请在设置中选择工作区目录。"
      )
    case .invalidWorkspace(let url):
      return localizer.text(
        "The selected workspace is not a directory: \(url.path).",
        "所选工作区不是目录：\(url.path)。"
      )
    case .missingProvider:
      return localizer.text(
        "Enter a provider identifier.",
        "请输入服务商标识。"
      )
    case .missingModel:
      return localizer.text(
        "Enter a model identifier.",
        "请输入模型标识。"
      )
    case .invalidBaseURL:
      return localizer.text(
        "Base URL must be a valid HTTPS URL without credentials, query, or fragment.",
        "服务地址必须是有效的 HTTPS URL，且不能包含凭据、查询参数或片段。"
      )
    case .missingCredential(let provider):
      return localizer.text(
        "Add an API key for provider '\(provider)'.",
        "请为服务商 '\(provider)' 添加 API 密钥。"
      )
    case .activeRun:
      return localizer.text(
        "Stop the active run before applying provider settings.",
        "请先停止当前运行，再应用服务商设置。"
      )
    case .runtimeStopTimedOut:
      return localizer.text(
        "The existing runtime host did not stop before the provider switch deadline.",
        "在服务商切换截止时间之前，现有运行时主机未能停止。"
      )
    }
  }
}

private struct PreparedDesktopSettings: Sendable {
  let persisted: CanvastPersistedSettings
  let workspace: URL
  let developmentRuntime: URL?
  let providerSettings: CanvastProviderSettings
  let enteredAPIKey: String?
}

private enum DesktopSettingsMutation: Sendable, Equatable {
  case save
  case apply
}

@MainActor
extension CanvastDesktopModel {
  nonisolated static func configuredWorkspaceURL(
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) -> URL? {
    guard let raw = environment["CANVAST_PROJECT_ROOT"]?
      .trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
      return nil
    }
    return URL(fileURLWithPath: raw, isDirectory: true).standardizedFileURL
  }

  func reloadSettings() {
    settingsReloadTask?.cancel()
    let draft = settingsDraft
    let settingsStore = settingsStore
    let credentialStore = credentialStore
    let bundleResourceURL = bundleResourceURL
    runtimeAvailability = .init(
      state: .checking, source: "validating", installRoot: nil,
      message: "Validating the sealed Canvast runtime."
    )
    statusLine = "Validating runtime and provider settings"
    settingsReloadTask = Task.detached(priority: .userInitiated) { [weak self] in
      do {
        let persisted = try settingsStore.load(defaults: draft.persistedSettings)
        try Task.checkCancellation()
        let loadedDraft = CanvastSettingsDraft(settings: persisted)
        let developmentRoot = Self.pathURL(persisted.developmentRuntimePath)
        let locator = CanvastRuntimeLocator(
          bundleResourceURL: bundleResourceURL, developmentInstallRoot: developmentRoot
        )
        let availability = locator.availability()
        try Task.checkCancellation()
        let authStatus = (try? credentialStore.authStatus(for: persisted.provider)) ?? .missing
        var normalizedDraft = loadedDraft
        if authStatus.isAuthenticated {
          normalizedDraft.markCredentialConfigured(for: persisted.provider)
        } else {
          normalizedDraft.clearCredentialMarker(for: persisted.provider)
        }
        if normalizedDraft.credentialConfiguredProviders != loadedDraft.credentialConfiguredProviders {
          try? settingsStore.save(normalizedDraft.persistedSettings)
        }
        await self?.commitReloadedSettings(
          normalizedDraft, availability: availability, authStatus: authStatus,
          providerConfiguration: nil
        )
      } catch is CancellationError {
        return
      } catch {
        await self?.commitSettingsLoadFailure(error)
      }
    }
  }

  func saveSettings() {
    performSettingsMutation(
      .saveSettings, mutation: .save,
      retry: { [weak self] in self?.saveSettings() }, successMessage: "Settings saved"
    )
  }

  func applyProviderSettings() {
    performSettingsMutation(
      .applyProviderSettings, mutation: .apply,
      retry: { [weak self] in self?.applyProviderSettings() },
      successMessage: "Provider settings applied"
    )
  }

  func testProviderConnection() {
    let id = DesktopUIActionID.testProviderConnection
    let correlationID = UUID().uuidString
    let draft = settingsDraft
    let credentialStore = credentialStore
    let connectionTester = connectionTester
    guard beginAsyncLocalAction(
      id, correlationID: correlationID, retry: { [weak self] in self?.testProviderConnection() },
      cancel: { [weak self] in self?.cancelSettingsTask(id, correlationID: correlationID) },
      stage: .init(.hostPreparation, label: "Preparing provider connection test")
    ) else { return }
    connectionTestStatus = "Testing provider connection."
    reserveLocalActionTask(id, correlationID: correlationID)
    let connectionTask = Task.detached(priority: .userInitiated) { [weak self] in
      do {
        let prepared = try Self.prepareSettings(draft)
        let apiKey: String?
        if let enteredAPIKey = prepared.enteredAPIKey {
          apiKey = enteredAPIKey
        } else {
          apiKey = try credentialStore.apiKey(for: prepared.persisted.provider)
        }
        guard let apiKey, !apiKey.isEmpty else {
          throw CanvastDesktopSettingsError.missingCredential(prepared.persisted.provider)
        }
        let configuration = prepared.providerSettings.runtimeConfiguration(apiKey: apiKey)
        let result = try await connectionTester.testConnection(
          configuration: configuration, timeout: .seconds(15)
        )
        try Task.checkCancellation()
        await self?.commitConnectionTest(
          id: id, correlationID: correlationID, result: result, configuration: configuration
        )
      } catch is CancellationError {
        await self?.commitCancelledSettingsTask(id, correlationID: correlationID)
      } catch {
        await self?.commitSettingsFailure(id, correlationID: correlationID, error: error)
      }
    }
    installLocalActionTask(connectionTask, for: id, correlationID: correlationID)
  }

  func revokeProviderCredential() {
    let id = DesktopUIActionID.revokeProviderCredential
    let correlationID = UUID().uuidString
    let provider = settingsDraft.provider.trimmingCharacters(in: .whitespacesAndNewlines)
    let runtimeWasActive = runState.isActive || runtimeBridge.isRunning
    let credentialStore = credentialStore
    guard beginAsyncLocalAction(
      id, correlationID: correlationID,
      retry: { [weak self] in self?.revokeProviderCredential() },
      cancel: { [weak self] in self?.cancelSettingsTask(id, correlationID: correlationID) },
      stage: .init(.localState, label: "Revoking provider credential")
    ) else { return }
    reserveLocalActionTask(id, correlationID: correlationID)
    let revokeTask = Task.detached(priority: .userInitiated) { [weak self] in
      do {
        guard !provider.isEmpty else { throw CanvastDesktopSettingsError.missingProvider }
        guard !runtimeWasActive else { throw CanvastDesktopSettingsError.activeRun }
        try Task.checkCancellation()
        try credentialStore.removeAPIKey(for: provider)
        let authStatus = try credentialStore.authStatus(for: provider)
        try Task.checkCancellation()
        await self?.commitCredentialRevocation(
          id: id, correlationID: correlationID, provider: provider, authStatus: authStatus
        )
      } catch is CancellationError {
        await self?.commitCancelledSettingsTask(id, correlationID: correlationID)
      } catch {
        await self?.commitSettingsFailure(id, correlationID: correlationID, error: error)
      }
    }
    installLocalActionTask(revokeTask, for: id, correlationID: correlationID)
  }

  func chooseWorkspace() {
    guard let url = chooseDirectory(
      message: "Choose or create the Canvast workspace",
      canCreateDirectories: true
    ) else { return }
    settingsDraft.workspacePath = url.path
  }

  func chooseAndOpenWorkspace() {
    guard let url = chooseDirectory(
      message: "Choose or create the Canvast workspace",
      canCreateDirectories: true
    ) else { return }
    openWorkspace(url)
  }

  func createAndOpenWorkspace() {
    guard let url = chooseDirectory(
      message: "Create or choose a Canvast workspace folder",
      canCreateDirectories: true
    ) else { return }
    openWorkspace(url)
  }

  func openWorkspace(_ url: URL) {
    let standardized = url.standardizedFileURL.resolvingSymlinksInPath()
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: standardized.path, isDirectory: &isDirectory),
          isDirectory.boolValue else {
      let message = CanvastDesktopSettingsError.invalidWorkspace(standardized).localizedDescription
      statusLine = message
      appendConsole(.standardError, message)
      return
    }
    activateWorkspace(standardized, persistSettings: true)
  }

  func openSettingsWindow() {
    if let controller = settingsWindowController {
      controller.showWindow(nil)
      controller.window?.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
      return
    }
    let view = CanvastSettingsView()
      .environmentObject(self)
      .canvastLocalizer(localizer)
    let controller = NSWindowController(window: NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 700, height: 720),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    ))
    controller.window?.title = localizer.text("Canvast Settings", "Canvast 设置")
    controller.window?.contentView = NSHostingView(rootView: view)
    controller.window?.isReleasedWhenClosed = false
    settingsWindowController = controller
    controller.showWindow(nil)
    controller.window?.center()
    controller.window?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  func chooseDevelopmentRuntime() {
    guard let url = chooseDirectory(message: "Choose an unpacked sealed Canvast runtime") else { return }
    settingsDraft.developmentRuntimePath = url.path
    reloadRuntimeAvailability(for: url)
  }

  func clearDevelopmentRuntime() {
    settingsDraft.developmentRuntimePath = ""
    reloadRuntimeAvailability(for: nil)
  }

  func resolvedInstallRoot() throws -> URL {
    if let installRoot { return installRoot }
    do {
      let developmentRoot = Self.pathURL(settingsDraft.developmentRuntimePath)
      let location = try CanvastRuntimeLocator(
        bundleResourceURL: bundleResourceURL, developmentInstallRoot: developmentRoot
      ).locate()
      runtimeAvailability = .init(
        state: .ready, source: location.source, installRoot: location.installRoot,
        message: "Canvast runtime is ready."
      )
      installRoot = location.installRoot
      return location.installRoot
    } catch {
      commitRuntimeResolutionFailure(error)
      throw error
    }
  }

  func resolvedProviderConfiguration() throws -> CanvastProviderRuntimeConfiguration {
    if let providerConfiguration { return providerConfiguration }
    let persisted = settingsDraft.persistedSettings
    guard settingsDraft.hasCredentialMarker(for: persisted.provider) else {
      providerAuthStatus = .missing
      let message = CanvastDesktopSettingsError.missingCredential(persisted.provider).localizedDescription
      statusLine = message
      appendConsole(.standardError, message)
      throw CanvastDesktopSettingsError.missingCredential(persisted.provider)
    }
    let apiKey = try credentialStore.apiKey(for: persisted.provider)
    guard let apiKey, !apiKey.isEmpty else {
      providerAuthStatus = .missing
      settingsDraft.clearCredentialMarker(for: persisted.provider)
      try? settingsStore.save(settingsDraft.persistedSettings)
      let message = CanvastDesktopSettingsError.missingCredential(persisted.provider).localizedDescription
      statusLine = message
      appendConsole(.standardError, message)
      throw CanvastDesktopSettingsError.missingCredential(persisted.provider)
    }
    let configuration = Self.providerConfiguration(settings: persisted, apiKey: apiKey)
    providerConfiguration = configuration
    providerAuthStatus = .available(source: .keychain)
    if !settingsDraft.hasCredentialMarker(for: persisted.provider) {
      settingsDraft.markCredentialConfigured(for: persisted.provider)
      try? settingsStore.save(settingsDraft.persistedSettings)
    }
    return configuration
  }

  private func performSettingsMutation(
    _ id: DesktopUIActionID, mutation: DesktopSettingsMutation,
    retry: @escaping () -> Void, successMessage: String
  ) {
    let correlationID = UUID().uuidString
    let draft = settingsDraft
    let settingsStore = settingsStore
    let credentialStore = credentialStore
    let bundleResourceURL = bundleResourceURL
    let runWasActive = runState.isActive
    let currentRuntimeAvailability = runtimeAvailability
    guard beginAsyncLocalAction(
      id, correlationID: correlationID, retry: retry,
      cancel: { [weak self] in self?.cancelSettingsTask(id, correlationID: correlationID) },
      stage: .init(.localState, label: "Validating settings")
    ) else { return }
    reserveLocalActionTask(id, correlationID: correlationID)
    let settingsTask = Task.detached(priority: .userInitiated) { [weak self] in
      do {
        let prepared = try Self.prepareSettings(draft)
        if mutation == .apply && runWasActive { throw CanvastDesktopSettingsError.activeRun }
        try Task.checkCancellation()
        let storedKey: String?
        var persisted = prepared.persisted
        if let enteredAPIKey = prepared.enteredAPIKey {
          try credentialStore.setAPIKey(enteredAPIKey, for: prepared.persisted.provider)
          storedKey = enteredAPIKey
          var providers = persisted.credentialConfiguredProviders
          let provider = CanvastSettingsDraft.normalizedProvider(persisted.provider)
          if !provider.isEmpty, !providers.contains(provider) {
            providers.append(provider)
            providers.sort()
          }
          persisted.credentialConfiguredProviders = providers
        } else if mutation == .apply {
          storedKey = try credentialStore.apiKey(for: prepared.persisted.provider)
          if storedKey?.isEmpty == false {
            var providers = persisted.credentialConfiguredProviders
            let provider = CanvastSettingsDraft.normalizedProvider(persisted.provider)
            if !provider.isEmpty, !providers.contains(provider) {
              providers.append(provider)
              providers.sort()
            }
            persisted.credentialConfiguredProviders = providers
          }
        } else {
          storedKey = nil
        }
        if mutation == .apply, storedKey?.isEmpty != false {
          throw CanvastDesktopSettingsError.missingCredential(prepared.persisted.provider)
        }
        try settingsStore.save(persisted)
        let normalizedProvider = CanvastSettingsDraft.normalizedProvider(prepared.persisted.provider)
        let authStatus: CanvastProviderAuthStatus = persisted.credentialConfiguredProviders.contains(normalizedProvider)
          ? .available(source: .keychain)
          : .missing
        let locator = CanvastRuntimeLocator(
          bundleResourceURL: bundleResourceURL,
          developmentInstallRoot: prepared.developmentRuntime
        )
        let runtime: CanvastRuntimeLocation?
        let availability: CanvastRuntimeAvailability
        switch mutation {
        case .save:
          availability = currentRuntimeAvailability
          runtime = nil
        case .apply:
          let located = try locator.locate()
          availability = .init(
            state: .ready, source: located.source, installRoot: located.installRoot,
            message: "Canvast runtime is ready."
          )
          runtime = located
        }
        let providerConfiguration = storedKey.flatMap { key in
          key.isEmpty ? nil : CanvastProviderSettings(
            provider: persisted.provider, model: persisted.model,
            baseURL: prepared.providerSettings.baseURL
          ).runtimeConfiguration(apiKey: key)
        }
        let resolved = ResolvedDesktopSettings(
          persisted: persisted, workspace: prepared.workspace, runtime: runtime,
          availability: availability, authStatus: authStatus,
          providerConfiguration: providerConfiguration
        )
        try Task.checkCancellation()
        try await self?.commitSettingsMutation(
          id: id, correlationID: correlationID, mutation: mutation, resolved: resolved,
          message: successMessage
        )
      } catch is CancellationError {
        await self?.commitCancelledSettingsTask(id, correlationID: correlationID)
      } catch {
        await self?.commitSettingsFailure(id, correlationID: correlationID, error: error)
      }
    }
    installLocalActionTask(settingsTask, for: id, correlationID: correlationID)
  }

  private struct ResolvedDesktopSettings: Sendable {
    let persisted: CanvastPersistedSettings
    let workspace: URL
    let runtime: CanvastRuntimeLocation?
    let availability: CanvastRuntimeAvailability
    let authStatus: CanvastProviderAuthStatus
    let providerConfiguration: CanvastProviderRuntimeConfiguration?
  }

  nonisolated private static func prepareSettings(
    _ draft: CanvastSettingsDraft
  ) throws -> PreparedDesktopSettings {
    let workspaceText = draft.workspacePath.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !workspaceText.isEmpty else { throw CanvastDesktopSettingsError.missingWorkspace }
    let workspace = URL(fileURLWithPath: workspaceText, isDirectory: true)
      .standardizedFileURL.resolvingSymlinksInPath()
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: workspace.path, isDirectory: &isDirectory),
          isDirectory.boolValue else { throw CanvastDesktopSettingsError.invalidWorkspace(workspace) }
    let provider = draft.provider.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !provider.isEmpty else { throw CanvastDesktopSettingsError.missingProvider }
    let model = draft.model.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !model.isEmpty else { throw CanvastDesktopSettingsError.missingModel }
    let baseURLText = draft.baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
    var baseURL: URL?
    if !baseURLText.isEmpty {
      guard let candidate = URL(string: baseURLText), candidate.scheme?.lowercased() == "https",
            candidate.host != nil, candidate.user == nil, candidate.password == nil,
            candidate.query == nil, candidate.fragment == nil else {
        throw CanvastDesktopSettingsError.invalidBaseURL
      }
      baseURL = candidate
    }
    let runtimeText = draft.developmentRuntimePath.trimmingCharacters(in: .whitespacesAndNewlines)
    let enteredKey = draft.apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
    let persisted = CanvastPersistedSettings(
      workspacePath: workspace.path, developmentRuntimePath: runtimeText,
      provider: provider, model: model, baseURL: baseURLText,
      languagePreference: draft.languagePreference,
      credentialConfiguredProviders: draft.credentialConfiguredProviders
    )
    return .init(
      persisted: persisted, workspace: workspace,
      developmentRuntime: pathURL(runtimeText),
      providerSettings: .init(provider: provider, model: model, baseURL: baseURL),
      enteredAPIKey: enteredKey.isEmpty ? nil : enteredKey
    )
  }

  nonisolated private static func providerConfiguration(
    settings: CanvastPersistedSettings, apiKey: String
  ) -> CanvastProviderRuntimeConfiguration {
    let baseURLText = settings.baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
    return .init(
      provider: settings.provider, model: settings.model,
      baseURL: baseURLText.isEmpty ? nil : URL(string: baseURLText), apiKey: apiKey
    )
  }

  nonisolated private static func pathURL(_ path: String) -> URL? {
    let value = path.trimmingCharacters(in: .whitespacesAndNewlines)
    return value.isEmpty ? nil : URL(fileURLWithPath: value, isDirectory: true).standardizedFileURL
  }

  private func commitReloadedSettings(
    _ draft: CanvastSettingsDraft, availability: CanvastRuntimeAvailability,
    authStatus: CanvastProviderAuthStatus,
    providerConfiguration: CanvastProviderRuntimeConfiguration?
  ) {
    settingsDraft = draft
    applyLanguagePreference(draft.languagePreference)
    runtimeAvailability = availability
    installRoot = availability.installRoot
    providerAuthStatus = authStatus
    self.providerConfiguration = providerConfiguration
    if !workspaceIsConfigured {
      statusLine = workspaceRequiredMessage()
    } else if !authStatus.isAuthenticated {
      statusLine = providerCredentialRequiredMessage()
    } else {
      statusLine = availability.state == .ready ? "Settings loaded" : availability.message
    }
    settingsReloadTask = nil
  }

  private func commitSettingsLoadFailure(_ error: Error) {
    runtimeAvailability = .init(
      state: .invalid, source: "settings", installRoot: nil, message: error.localizedDescription
    )
    providerAuthStatus = .missing
    providerConfiguration = nil
    statusLine = error.localizedDescription
    settingsReloadTask = nil
  }

  private func commitSettingsMutation(
    id: DesktopUIActionID, correlationID: String, mutation: DesktopSettingsMutation,
    resolved: ResolvedDesktopSettings, message: String
  ) async throws {
    guard actionCenter.isCurrentExecution(id, correlationID: correlationID) else { return }
    let shouldApply = mutation == .apply
    if mutation == .apply {
      guard !runState.isActive else { throw CanvastDesktopSettingsError.activeRun }
      let changedRuntimeConfiguration = projectRoot != resolved.workspace
        || installRoot != resolved.runtime?.installRoot
        || providerConfiguration != resolved.providerConfiguration
      if changedRuntimeConfiguration && runtimeBridge.isRunning {
        actionCenter.markRunning(
          id, correlationID: correlationID, message: "Stopping the existing runtime host",
          token: .cancellation
        )
        runtimeBridge.stopHost()
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while runtimeBridge.isRunning {
          try Task.checkCancellation()
          guard ContinuousClock.now < deadline else {
            throw CanvastDesktopSettingsError.runtimeStopTimedOut
          }
          try await Task.sleep(for: .milliseconds(50))
        }
      }
      activeRuntimeConfigurationSignature = nil
    }
    guard actionCenter.isCurrentExecution(id, correlationID: correlationID) else { return }
    if (shouldApply || !workspaceIsConfigured) && projectRoot != resolved.workspace {
      projectRoot = resolved.workspace
      workspaceIsConfigured = true
      let loaded = store.load(projectRoot: resolved.workspace, stateDirectory: stateDirectoryOverride)
      let graph = graphStore.load(from: stateDirectory)
      applyPersistedWorkspaceState(loaded, canvasGraph: graph)
    } else if shouldApply || !workspaceIsConfigured {
      workspaceIsConfigured = true
    }
    settingsDraft = CanvastSettingsDraft(settings: resolved.persisted)
    applyLanguagePreference(resolved.persisted.languagePreference)
    runtimeAvailability = resolved.availability
    providerAuthStatus = resolved.authStatus
    if shouldApply {
      installRoot = resolved.runtime?.installRoot
      providerConfiguration = resolved.providerConfiguration
    } else {
      providerConfiguration = nil
      activeRuntimeConfigurationSignature = nil
      if !runState.isActive, runtimeBridge.isRunning {
        runtimeBridge.stopHost()
      }
    }
    actionCenter.succeed(id, correlationID: correlationID, message: message)
    statusLine = message
    finishLocalActionTask(id, correlationID: correlationID)
  }

  private func activateWorkspace(_ workspace: URL, persistSettings: Bool) {
    let standardized = workspace.standardizedFileURL.resolvingSymlinksInPath()
    projectRoot = standardized
    workspaceIsConfigured = true
    settingsDraft.workspacePath = standardized.path
    if persistSettings {
      try? settingsStore.save(settingsDraft.persistedSettings)
    }
    let loaded = store.load(projectRoot: standardized, stateDirectory: stateDirectoryOverride)
    let graph = graphStore.load(from: stateDirectory)
    applyPersistedWorkspaceState(loaded, canvasGraph: graph)
    statusLine = providerCredentialIsConfigured
      ? localizer.text(
        "Workspace opened: \(standardized.lastPathComponent)",
        "已打开工作区：\(standardized.lastPathComponent)"
      )
      : providerCredentialRequiredMessage()
  }

  private func commitConnectionTest(
    id: DesktopUIActionID, correlationID: String, result: CanvastConnectionTestResult,
    configuration _: CanvastProviderRuntimeConfiguration
  ) {
    guard actionCenter.isCurrentExecution(id, correlationID: correlationID) else { return }
    let latency = result.latency.components
    let milliseconds = max(
      0, Int(Double(latency.seconds) * 1_000
        + Double(latency.attoseconds) / 1_000_000_000_000_000)
    )
    connectionTestStatus = "Connection succeeded (HTTP \(result.statusCode), \(milliseconds) ms)."
    actionCenter.succeed(id, correlationID: correlationID, message: "Provider connection verified")
    statusLine = "Provider connection verified"
    finishLocalActionTask(id, correlationID: correlationID)
  }

  private func commitCredentialRevocation(
    id: DesktopUIActionID, correlationID: String, provider: String,
    authStatus: CanvastProviderAuthStatus
  ) {
    guard actionCenter.isCurrentExecution(id, correlationID: correlationID) else { return }
    settingsDraft.apiKey = ""
    settingsDraft.clearCredentialMarker(for: provider)
    try? settingsStore.save(settingsDraft.persistedSettings)
    providerAuthStatus = authStatus
    if providerConfiguration?.provider.caseInsensitiveCompare(provider) == .orderedSame {
      providerConfiguration = nil
      activeRuntimeConfigurationSignature = nil
    }
    connectionTestStatus = ""
    let message = localizer.text(
      "Credential revoked from Keychain.",
      "凭据已从 Keychain 撤销。"
    )
    actionCenter.succeed(id, correlationID: correlationID, message: message)
    statusLine = message
    finishLocalActionTask(id, correlationID: correlationID)
  }

  private func commitSettingsFailure(
    _ id: DesktopUIActionID, correlationID: String, error: Error
  ) {
    guard actionCenter.isCurrentExecution(id, correlationID: correlationID) else { return }
    let message = error.localizedDescription
    if id == .testProviderConnection { connectionTestStatus = message }
    actionCenter.fail(id, correlationID: correlationID, message: message)
    statusLine = message
    appendConsole(.standardError, message)
    finishLocalActionTask(id, correlationID: correlationID)
  }

  private func cancelSettingsTask(_ id: DesktopUIActionID, correlationID: String) {
    cancelLocalActionTask(id, correlationID: correlationID)
    commitCancelledSettingsTask(id, correlationID: correlationID)
  }

  private func commitCancelledSettingsTask(_ id: DesktopUIActionID, correlationID: String) {
    guard actionCenter.isCurrentExecution(id, correlationID: correlationID) else { return }
    actionCenter.cancel(id, correlationID: correlationID, message: "Settings operation cancelled")
    if id == .testProviderConnection { connectionTestStatus = "Connection test cancelled." }
    statusLine = "Settings operation cancelled"
    finishLocalActionTask(id, correlationID: correlationID)
  }

  private func reloadRuntimeAvailability(for developmentRoot: URL?) {
    runtimeAvailability = .init(
      state: .checking, source: "validating", installRoot: nil,
      message: "Validating the sealed Canvast runtime."
    )
    let bundleResourceURL = bundleResourceURL
    settingsReloadTask?.cancel()
    settingsReloadTask = Task.detached(priority: .userInitiated) {
      let availability = CanvastRuntimeLocator(
        bundleResourceURL: bundleResourceURL, developmentInstallRoot: developmentRoot
      ).availability()
      guard !Task.isCancelled else { return }
      await self.commitRuntimeAvailability(availability)
    }
  }

  private func commitRuntimeAvailability(_ availability: CanvastRuntimeAvailability) {
    runtimeAvailability = availability
    installRoot = availability.installRoot
    settingsReloadTask = nil
  }

  private func commitRuntimeResolutionFailure(_ error: Error) {
    let state: CanvastRuntimeAvailabilityState
    if case CanvastRuntimeLocatorError.unavailable = error {
      state = .missing
    } else {
      state = .invalid
    }
    let message = error.localizedDescription
    runtimeAvailability = .init(
      state: state, source: "unavailable", installRoot: nil, message: message
    )
    installRoot = nil
    statusLine = message
    appendConsole(.standardError, message)
  }

  private func chooseDirectory(message: String, canCreateDirectories: Bool = false) -> URL? {
    let panel = NSOpenPanel()
    panel.message = message
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.canCreateDirectories = canCreateDirectories
    panel.allowsMultipleSelection = false
    return panel.runModal() == .OK ? panel.url : nil
  }
}
