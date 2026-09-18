import Foundation

public enum CanvastAppLanguage: String, Codable, CaseIterable, Sendable {
  case english = "en"
  case simplifiedChinese = "zh-Hans"

  public var localeIdentifier: String {
    switch self {
    case .english: return "en"
    case .simplifiedChinese: return "zh-Hans"
    }
  }
}

public enum CanvastAppLanguagePreference: String, Codable, CaseIterable, Identifiable, Sendable {
  case system
  case english
  case simplifiedChinese

  public var id: String { rawValue }

  public var resolvedOverride: CanvastAppLanguage? {
    switch self {
    case .system: return nil
    case .english: return .english
    case .simplifiedChinese: return .simplifiedChinese
    }
  }
}

public struct CanvastResolvedLanguageState: Equatable, Sendable {
  public let preference: CanvastAppLanguagePreference
  public let resolvedLanguage: CanvastAppLanguage

  public init(
    preference: CanvastAppLanguagePreference,
    resolvedLanguage: CanvastAppLanguage
  ) {
    self.preference = preference
    self.resolvedLanguage = resolvedLanguage
  }
}

public enum CanvastAppLanguageResolver {
  public static func resolve(
    preference: CanvastAppLanguagePreference,
    preferredLanguages: [String] = Locale.preferredLanguages
  ) -> CanvastResolvedLanguageState {
    if let resolvedOverride = preference.resolvedOverride {
      return .init(preference: preference, resolvedLanguage: resolvedOverride)
    }
    return .init(
      preference: preference,
      resolvedLanguage: resolveSystemLanguage(preferredLanguages: preferredLanguages)
    )
  }

  private static func resolveSystemLanguage(
    preferredLanguages: [String]
  ) -> CanvastAppLanguage {
    for identifier in preferredLanguages {
      let normalized = identifier
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .replacingOccurrences(of: "_", with: "-")
        .lowercased()
      guard !normalized.isEmpty else { continue }
      if normalized.hasPrefix("zh-hans")
        || normalized.hasPrefix("zh-cn")
        || normalized.hasPrefix("zh-sg")
        || normalized == "zh"
      {
        return .simplifiedChinese
      }
      if normalized.hasPrefix("en") {
        return .english
      }
    }
    return .english
  }
}
