import Foundation
import LocalAuthentication
import Security

public enum CanvastCredentialSource: String, Codable, Equatable, Sendable {
  case keychain
}

public enum CanvastProviderAuthStatus: Equatable, Sendable {
  case missing
  case available(source: CanvastCredentialSource)

  public var isAuthenticated: Bool {
    if case .available = self { return true }
    return false
  }

  public var source: CanvastCredentialSource? {
    guard case .available(let source) = self else { return nil }
    return source
  }
}

public enum CanvastKeychainError: Error, Equatable, Sendable {
  case invalidProvider
  case emptyCredential
  case invalidCredentialData
  case unexpectedStatus(OSStatus)
}

extension CanvastKeychainError: LocalizedError {
  public var errorDescription: String? {
    switch self {
    case .invalidProvider:
      return CanvastAppCoreLocalizer.text(
        "A provider identifier is required to access its credential.",
        "访问凭据时必须提供服务商标识。"
      )
    case .emptyCredential:
      return CanvastAppCoreLocalizer.text(
        "An empty provider credential cannot be stored.",
        "不能为空凭据写入存储。"
      )
    case .invalidCredentialData:
      return CanvastAppCoreLocalizer.text(
        "The stored provider credential cannot be read.",
        "无法读取已存储的服务商凭据。"
      )
    case .unexpectedStatus(let status):
      let message = SecCopyErrorMessageString(status, nil) as String?
      return message.map {
        CanvastAppCoreLocalizer.text(
          "Keychain operation failed: \($0)",
          "Keychain 操作失败：\($0)"
        )
      } ?? CanvastAppCoreLocalizer.text(
        "Keychain operation failed with status \(status).",
        "Keychain 操作失败，状态码为 \(status)。"
      )
    }
  }
}

public protocol CanvastCredentialStore: Sendable {
  func apiKey(for provider: String) throws -> String?
  func setAPIKey(_ apiKey: String, for provider: String) throws
  func removeAPIKey(for provider: String) throws
  func authStatus(for provider: String) throws -> CanvastProviderAuthStatus
}

/// Stores provider credentials exclusively as generic-password entries in the system Keychain.
public struct CanvastKeychainCredentialStore: CanvastCredentialStore, Sendable {
  public static let defaultService = "app.canvast.provider-credentials"

  public let service: String
  public let accessGroup: String?

  public init(
    service: String = CanvastKeychainCredentialStore.defaultService,
    accessGroup: String? = nil
  ) {
    self.service = service
    self.accessGroup = accessGroup
  }

  public func apiKey(for provider: String) throws -> String? {
    let account = try normalizedAccount(for: provider)
    var query = baseQuery(account: account)
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    query[kSecReturnData as String] = true

    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    switch status {
    case errSecSuccess:
      guard let data = item as? Data,
            let apiKey = String(data: data, encoding: .utf8),
            !apiKey.isEmpty else {
        throw CanvastKeychainError.invalidCredentialData
      }
      return apiKey
    case errSecItemNotFound:
      return nil
    default:
      throw CanvastKeychainError.unexpectedStatus(status)
    }
  }

  public func setAPIKey(_ apiKey: String, for provider: String) throws {
    guard !apiKey.isEmpty else { throw CanvastKeychainError.emptyCredential }
    let account = try normalizedAccount(for: provider)
    let secretData = Data(apiKey.utf8)
    let query = baseQuery(account: account)
    let updates = [kSecValueData as String: secretData]

    let updateStatus = SecItemUpdate(query as CFDictionary, updates as CFDictionary)
    switch updateStatus {
    case errSecSuccess:
      return
    case errSecItemNotFound:
      var newItem = query
      newItem[kSecValueData as String] = secretData
      newItem[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      let addStatus = SecItemAdd(newItem as CFDictionary, nil)
      if addStatus == errSecDuplicateItem {
        let retryStatus = SecItemUpdate(query as CFDictionary, updates as CFDictionary)
        guard retryStatus == errSecSuccess else {
          throw CanvastKeychainError.unexpectedStatus(retryStatus)
        }
      } else if addStatus != errSecSuccess {
        throw CanvastKeychainError.unexpectedStatus(addStatus)
      }
    default:
      throw CanvastKeychainError.unexpectedStatus(updateStatus)
    }
  }

  public func removeAPIKey(for provider: String) throws {
    let account = try normalizedAccount(for: provider)
    let status = SecItemDelete(baseQuery(account: account) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw CanvastKeychainError.unexpectedStatus(status)
    }
  }

  public func authStatus(for provider: String) throws -> CanvastProviderAuthStatus {
    let account = try normalizedAccount(for: provider)
    let context = LAContext()
    context.interactionNotAllowed = true
    var query = baseQuery(account: account)
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    query[kSecReturnAttributes as String] = true
    query[kSecUseAuthenticationContext as String] = context

    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    switch status {
    case errSecSuccess:
      return .available(source: .keychain)
    case errSecItemNotFound:
      return .missing
    default:
      throw CanvastKeychainError.unexpectedStatus(status)
    }
  }

  private func normalizedAccount(for provider: String) throws -> String {
    let account = provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !account.isEmpty else { throw CanvastKeychainError.invalidProvider }
    return account
  }

  private func baseQuery(account: String) -> [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
    return query
  }
}
