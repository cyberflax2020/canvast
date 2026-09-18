import Foundation

/// Persistable provider preferences. Credentials deliberately live outside this value.
public struct CanvastProviderSettings: Codable, Equatable, Sendable {
  public var provider: String
  public var model: String
  public var baseURL: URL?

  public init(provider: String, model: String, baseURL: URL? = nil) {
    self.provider = provider
    self.model = model
    self.baseURL = baseURL
  }

  public func runtimeConfiguration(apiKey: String) -> CanvastProviderRuntimeConfiguration {
    CanvastProviderRuntimeConfiguration(
      provider: provider, model: model, baseURL: baseURL, apiKey: apiKey
    )
  }
}

/// Ephemeral configuration used to launch the local runtime. Do not persist this value.
public struct CanvastProviderRuntimeConfiguration:
  Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible
{
  public let provider: String
  public let model: String
  public let baseURL: URL?
  public let apiKey: String

  public init(provider: String, model: String, baseURL: URL?, apiKey: String) {
    self.provider = provider
    self.model = model
    self.baseURL = baseURL
    self.apiKey = apiKey
  }

  /// Environment additions for a child process. The credential is never placed in argv or a URL.
  public var runtimeEnvironment: [String: String] {
    var environment = [
      "CANVAST_PROVIDER": provider,
      "CANVAST_MODEL": model,
    ]
    if let credentialVariable = Self.credentialEnvironmentVariable(for: provider), !apiKey.isEmpty {
      environment[credentialVariable] = apiKey
    }
    if let baseURL {
      environment["CANVAST_BASE_URL"] = baseURL.absoluteString
      switch Self.normalizedProvider(provider) {
      case "openai", "deepseek":
        environment["OPENAI_BASE_URL"] = baseURL.absoluteString
      case "anthropic":
        environment["ANTHROPIC_BASE_URL"] = baseURL.absoluteString
      default:
        break
      }
    }
    return environment
  }

  public func applying(to environment: [String: String]) -> [String: String] {
    var result = environment
    for (key, value) in runtimeEnvironment { result[key] = value }
    return result
  }

  public var description: String {
    let endpoint = baseURL?.absoluteString ?? "nil"
    return "CanvastProviderRuntimeConfiguration(provider: \(provider), model: \(model), baseURL: \(endpoint), apiKey: <redacted>)"
  }

  public var debugDescription: String { description }

  public static func credentialEnvironmentVariable(for provider: String) -> String? {
    switch normalizedProvider(provider) {
    case "deepseek": return "DEEPSEEK_API_KEY"
    case "openai": return "OPENAI_API_KEY"
    case "anthropic": return "ANTHROPIC_API_KEY"
    default: return nil
    }
  }

  private static func normalizedProvider(_ provider: String) -> String {
    provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  }
}
