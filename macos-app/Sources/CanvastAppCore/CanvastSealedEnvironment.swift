// ============================================================================
// Canvast — Sealed Runtime Environment / Canvast 源文件
// ============================================================================
// @file        macos-app/Sources/CanvastAppCore/CanvastSealedEnvironment.swift
// @brief       Remove host runtime-loader controls before bundled Node starts.
// @description 使用清单绑定的策略和 OpenSSL 配置隔离宿主运行时环境。
// @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
// ============================================================================
import Foundation

public enum CanvastSealedEnvironmentError: LocalizedError, Equatable {
  case missingPolicy(URL)
  case invalidPolicyEntry(String)
  case missingOpenSSLConfiguration(URL)

  public var errorDescription: String? {
    switch self {
    case .missingPolicy(let url):
      return CanvastAppCoreLocalizer.text(
        "Canvast sealed runtime environment policy is unavailable at \(url.path).",
        "Canvast 封闭运行时环境策略不可用：\(url.path)。"
      )
    case .invalidPolicyEntry(let value):
      return CanvastAppCoreLocalizer.text(
        "Canvast sealed runtime environment policy contains an invalid entry: \(value)",
        "Canvast 封闭运行时环境策略包含无效条目：\(value)"
      )
    case .missingOpenSSLConfiguration(let url):
      return CanvastAppCoreLocalizer.text(
        "Canvast sealed runtime OpenSSL configuration is unavailable at \(url.path).",
        "Canvast 封闭运行时 OpenSSL 配置不可用：\(url.path)。"
      )
    }
  }
}

/// Removes host runtime-loader controls while retaining ordinary user, proxy,
/// locale, credential, and Canvast settings. The policy and OpenSSL config are
/// both manifest-bound files inside the sealed runtime.
public enum CanvastSealedEnvironment {
  public static let policyPath = "package/config-templates/sealed-runtime-environment.txt"
  public static let opensslConfigurationPath = "package/config-templates/openssl.cnf"

  public static func applying(
    to inherited: [String: String], runtimeRoot: URL,
    fileManager: FileManager = .default
  ) throws -> [String: String] {
    let root = runtimeRoot.standardizedFileURL.resolvingSymlinksInPath()
    let policyURL = root.appendingPathComponent(policyPath)
    let opensslURL = root.appendingPathComponent(opensslConfigurationPath)
    guard isRegularFile(policyURL, fileManager: fileManager),
          let policyText = try? String(contentsOf: policyURL, encoding: .utf8) else {
      throw CanvastSealedEnvironmentError.missingPolicy(policyURL)
    }
    guard isRegularFile(opensslURL, fileManager: fileManager) else {
      throw CanvastSealedEnvironmentError.missingOpenSSLConfiguration(opensslURL)
    }

    var environment = inherited
    for rawLine in policyText.components(separatedBy: .newlines) {
      let name = rawLine
      if name.isEmpty { continue }
      guard isEnvironmentName(name) else {
        throw CanvastSealedEnvironmentError.invalidPolicyEntry(name)
      }
      environment.removeValue(forKey: name)
    }
    environment["OPENSSL_CONF"] = opensslURL.path
    return environment
  }

  private static func isRegularFile(_ url: URL, fileManager: FileManager) -> Bool {
    guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]) else {
      return false
    }
    return values.isRegularFile == true && values.isSymbolicLink != true
  }

  private static func isEnvironmentName(_ value: String) -> Bool {
    guard let first = value.unicodeScalars.first, isASCIIEnvironmentLetter(first) || first.value == 95 else {
      return false
    }
    return value.unicodeScalars.dropFirst().allSatisfy { scalar in
      isASCIIEnvironmentLetter(scalar) || (scalar.value >= 48 && scalar.value <= 57) || scalar.value == 95
    }
  }

  private static func isASCIIEnvironmentLetter(_ scalar: UnicodeScalar) -> Bool {
    (scalar.value >= 65 && scalar.value <= 90) || (scalar.value >= 97 && scalar.value <= 122)
  }
}
