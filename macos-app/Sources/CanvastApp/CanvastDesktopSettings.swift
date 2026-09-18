import Foundation
import CanvastAppCore

/// Editable settings shown by the App. This type is intentionally not Codable because it contains
/// an ephemeral credential that must be handed to the Keychain-backed credential store.
struct CanvastSettingsDraft: Equatable, Sendable {
  var workspacePath: String
  var developmentRuntimePath: String
  var provider: String
  var model: String
  var baseURL: String
  var apiKey: String
  var languagePreference: CanvastAppLanguagePreference
  var credentialConfiguredProviders: [String]

  init(
    workspacePath: String,
    developmentRuntimePath: String = "",
    provider: String = "deepseek",
    model: String = "deepseek-v4-pro",
    baseURL: String = "",
    apiKey: String = "",
    languagePreference: CanvastAppLanguagePreference = .system,
    credentialConfiguredProviders: [String] = []
  ) {
    self.workspacePath = workspacePath
    self.developmentRuntimePath = developmentRuntimePath
    self.provider = provider
    self.model = model
    self.baseURL = baseURL
    self.apiKey = apiKey
    self.languagePreference = languagePreference
    self.credentialConfiguredProviders = Self.normalizedProviders(credentialConfiguredProviders)
  }

  init(settings: CanvastPersistedSettings, apiKey: String = "") {
    self.init(
      workspacePath: settings.workspacePath,
      developmentRuntimePath: settings.developmentRuntimePath,
      provider: settings.provider,
      model: settings.model,
      baseURL: settings.baseURL,
      apiKey: apiKey,
      languagePreference: settings.languagePreference,
      credentialConfiguredProviders: settings.credentialConfiguredProviders
    )
  }

  var persistedSettings: CanvastPersistedSettings {
    CanvastPersistedSettings(
      workspacePath: workspacePath,
      developmentRuntimePath: developmentRuntimePath,
      provider: provider,
      model: model,
      baseURL: baseURL,
      languagePreference: languagePreference,
      credentialConfiguredProviders: credentialConfiguredProviders
    )
  }

  func hasCredentialMarker(for provider: String? = nil) -> Bool {
    let account = Self.normalizedProvider(provider ?? self.provider)
    guard !account.isEmpty else { return false }
    return credentialConfiguredProviders.contains(account)
  }

  mutating func markCredentialConfigured(for provider: String? = nil) {
    let account = Self.normalizedProvider(provider ?? self.provider)
    guard !account.isEmpty, !credentialConfiguredProviders.contains(account) else { return }
    credentialConfiguredProviders.append(account)
    credentialConfiguredProviders.sort()
  }

  mutating func clearCredentialMarker(for provider: String? = nil) {
    let account = Self.normalizedProvider(provider ?? self.provider)
    guard !account.isEmpty else { return }
    credentialConfiguredProviders.removeAll { $0 == account }
  }

  static func normalizedProvider(_ provider: String) -> String {
    provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  }

  static func normalizedProviders(_ providers: [String]) -> [String] {
    Array(Set(providers.map(normalizedProvider).filter { !$0.isEmpty })).sorted()
  }
}

/// The complete on-disk schema. Provider credentials cannot enter this representation.
struct CanvastPersistedSettings: Codable, Equatable, Sendable {
  var workspacePath: String
  var developmentRuntimePath: String
  var provider: String
  var model: String
  var baseURL: String
  var languagePreference: CanvastAppLanguagePreference
  var credentialConfiguredProviders: [String]

  init(
    workspacePath: String,
    developmentRuntimePath: String = "",
    provider: String = "deepseek",
    model: String = "deepseek-v4-pro",
    baseURL: String = "",
    languagePreference: CanvastAppLanguagePreference = .system,
    credentialConfiguredProviders: [String] = []
  ) {
    self.workspacePath = workspacePath
    self.developmentRuntimePath = developmentRuntimePath
    self.provider = provider
    self.model = model
    self.baseURL = baseURL
    self.languagePreference = languagePreference
    self.credentialConfiguredProviders = CanvastSettingsDraft.normalizedProviders(credentialConfiguredProviders)
  }

  static func defaults(workspacePath: String) -> Self {
    .init(workspacePath: workspacePath)
  }

  enum CodingKeys: String, CodingKey {
    case workspacePath
    case developmentRuntimePath
    case provider
    case model
    case baseURL
    case languagePreference
    case credentialConfiguredProviders
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    workspacePath = try container.decode(String.self, forKey: .workspacePath)
    developmentRuntimePath = try container.decodeIfPresent(String.self, forKey: .developmentRuntimePath) ?? ""
    provider = try container.decodeIfPresent(String.self, forKey: .provider) ?? "deepseek"
    model = try container.decodeIfPresent(String.self, forKey: .model) ?? "deepseek-v4-pro"
    baseURL = try container.decodeIfPresent(String.self, forKey: .baseURL) ?? ""
    languagePreference = try container.decodeIfPresent(CanvastAppLanguagePreference.self, forKey: .languagePreference) ?? .system
    credentialConfiguredProviders = CanvastSettingsDraft.normalizedProviders(
      try container.decodeIfPresent([String].self, forKey: .credentialConfiguredProviders) ?? []
    )
  }
}

struct CanvastDesktopSettingsStore: @unchecked Sendable {
  let settingsURL: URL

  private let fileManager: FileManager
  private let encoder: JSONEncoder
  private let decoder: JSONDecoder

  init(
    settingsURL: URL? = nil,
    fileManager: FileManager = .default
  ) {
    self.settingsURL = settingsURL ?? Self.defaultSettingsURL(fileManager: fileManager)
    self.fileManager = fileManager

    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    self.encoder = encoder
    self.decoder = JSONDecoder()
  }

  static func defaultSettingsURL(fileManager: FileManager = .default) -> URL {
    if let override = ProcessInfo.processInfo.environment["CANVAST_DESKTOP_SETTINGS_PATH"]?
      .trimmingCharacters(in: .whitespacesAndNewlines),
       !override.isEmpty {
      return URL(fileURLWithPath: override, isDirectory: false).standardizedFileURL
    }
    let applicationSupport = fileManager.urls(
      for: .applicationSupportDirectory, in: .userDomainMask
    ).first ?? fileManager.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Application Support", isDirectory: true)

    return applicationSupport
      .appendingPathComponent("Canvast", isDirectory: true)
      .appendingPathComponent("settings.json", isDirectory: false)
  }

  func load(defaults: CanvastPersistedSettings) throws -> CanvastPersistedSettings {
    guard fileManager.fileExists(atPath: settingsURL.path) else { return defaults }
    return try decoder.decode(CanvastPersistedSettings.self, from: Data(contentsOf: settingsURL))
  }

  func save(_ settings: CanvastPersistedSettings) throws {
    try fileManager.createDirectory(
      at: settingsURL.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    try encoder.encode(settings).write(to: settingsURL, options: .atomic)
  }
}
