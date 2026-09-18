import CryptoKit
import Foundation

public enum CanvastRuntimeAvailabilityState: String, Equatable, Sendable {
  case checking
  case ready
  case missing
  case invalid
}

public struct CanvastRuntimeAvailability: Equatable, Sendable {
  public let state: CanvastRuntimeAvailabilityState
  public let source: String
  public let installRoot: URL?
  public let message: String

  public init(
    state: CanvastRuntimeAvailabilityState, source: String,
    installRoot: URL?, message: String
  ) {
    self.state = state
    self.source = source
    self.installRoot = installRoot
    self.message = message
  }

  public var isRecoverable: Bool { state != .ready }
}

public struct CanvastRuntimeLocation: Equatable, Sendable {
  public let installRoot: URL
  public let launcher: URL
  public let node: URL
  public let coreEntrypoint: URL
  public let extensionURLs: [URL]
  public let source: String
}

public enum CanvastRuntimeLocatorError: LocalizedError, Equatable, Sendable {
  case unavailable(URL)
  case invalidManifest(URL, String)
  case invalidEntry(String)
  case missingEntry(String)
  case hashMismatch(String)
  case missingExecutable(String)

  public var errorDescription: String? {
    switch self {
    case .unavailable(let url):
      return CanvastAppCoreLocalizer.text(
        "Canvast runtime is unavailable at \(url.path). Reinstall Canvast or repair the app bundle. Developers can choose a validated fallback runtime in Settings.",
        "Canvast 运行时在 \(url.path) 不可用。请重新安装 Canvast 或修复应用包；开发调试时可在设置中选择已校验的备用运行时。"
      )
    case .invalidManifest(let url, let detail):
      return CanvastAppCoreLocalizer.text(
        "Invalid Canvast runtime manifest at \(url.path): \(detail)",
        "Canvast 运行时清单无效：\(url.path)：\(detail)"
      )
    case .invalidEntry(let path):
      return CanvastAppCoreLocalizer.text(
        "Canvast runtime manifest contains an unsafe entry: \(path)",
        "Canvast 运行时清单包含不安全条目：\(path)"
      )
    case .missingEntry(let path):
      return CanvastAppCoreLocalizer.text(
        "Canvast runtime manifest does not include \(path).",
        "Canvast 运行时清单缺少 \(path)。"
      )
    case .hashMismatch(let path):
      return CanvastAppCoreLocalizer.text(
        "Canvast runtime verification failed for \(path).",
        "Canvast 运行时对 \(path) 的校验失败。"
      )
    case .missingExecutable(let path):
      return CanvastAppCoreLocalizer.text(
        "Canvast runtime executable is unavailable: \(path).",
        "Canvast 运行时可执行文件不可用：\(path)。"
      )
    }
  }
}

public struct CanvastRuntimeLocator {
  public static let manifestName = "CanvastRuntimeManifest.json"
  public static let coreEntrypointPath =
    "package/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
  public static let extensionPaths = [
    "canvast-core.ts", "canvast-harness.ts", "canvast-tui.ts",
    "product-closure.ts", "sandbox-bash.ts", "canvast-permissions.ts",
    "desktop-action.ts", "plan-mode.ts", "task-manager.ts",
    "web-tools.ts", "sub-agent.ts", "code-review.ts", "ask-user.ts",
    "mcp-bridge.ts", "git-tools.ts", "token-tracker.ts",
    "background-task.ts", "canvas-repomap.ts", "notebook-edit.ts",
    "lsp-tools.ts", "workflow.ts", "cron-scheduler.ts", "worktree.ts",
    "artifact.ts", "agent-comms.ts", "report-findings.ts", "monitor.ts",
    "owned-handle-diagnostics.ts",
  ].map { "package/extensions/\($0)" }

  private let fileManager: FileManager
  private let bundleResourceURL: URL?
  private let developmentInstallRoot: URL?

  public init(
    bundleResourceURL: URL? = Bundle.main.resourceURL,
    developmentInstallRoot: URL? = nil,
    fileManager: FileManager = .default
  ) {
    self.bundleResourceURL = bundleResourceURL
    self.developmentInstallRoot = developmentInstallRoot
    self.fileManager = fileManager
  }

  public func locate() throws -> CanvastRuntimeLocation {
    if let bundleRoot = bundledRuntimeRoot(), fileManager.fileExists(atPath: bundleRoot.path) {
      return try validate(bundleRoot, source: "bundle")
    }
    if let developmentInstallRoot {
      return try validate(developmentInstallRoot, source: "development")
    }
    let expected = bundleResourceURL?.appendingPathComponent("CanvastRuntime", isDirectory: true)
      ?? URL(fileURLWithPath: "/CanvastRuntime", isDirectory: true)
    throw CanvastRuntimeLocatorError.unavailable(expected)
  }

  private func bundledRuntimeRoot() -> URL? {
    guard let resources = bundleResourceURL?.standardizedFileURL else { return nil }
    let direct = resources.appendingPathComponent("CanvastRuntime", isDirectory: true)
    if fileManager.fileExists(atPath: direct.path) { return direct }
    guard resources.lastPathComponent == "Helpers",
          resources.deletingLastPathComponent().lastPathComponent == "Contents" else {
      return direct
    }
    return resources.deletingLastPathComponent()
      .appendingPathComponent("Resources/CanvastRuntime", isDirectory: true)
  }

  public func availability() -> CanvastRuntimeAvailability {
    do {
      let location = try locate()
      return .init(
        state: .ready, source: location.source, installRoot: location.installRoot,
        message: "Canvast runtime is ready."
      )
    } catch let error as CanvastRuntimeLocatorError {
      let state: CanvastRuntimeAvailabilityState
      if case .unavailable = error { state = .missing } else { state = .invalid }
      return .init(state: state, source: "unavailable", installRoot: nil, message: error.localizedDescription)
    } catch {
      return .init(state: .invalid, source: "unavailable", installRoot: nil, message: error.localizedDescription)
    }
  }

  public func validate(_ root: URL, source: String = "explicit") throws -> CanvastRuntimeLocation {
    let requestedRoot = root.standardizedFileURL
    guard !isSymbolicLink(requestedRoot) else {
      throw CanvastRuntimeLocatorError.invalidEntry(requestedRoot.path)
    }
    let canonicalRoot = requestedRoot.resolvingSymlinksInPath()
    var isDirectory: ObjCBool = false
    guard fileManager.fileExists(atPath: canonicalRoot.path, isDirectory: &isDirectory), isDirectory.boolValue else {
      throw CanvastRuntimeLocatorError.unavailable(canonicalRoot)
    }
    let manifestURL = canonicalRoot.appendingPathComponent(Self.manifestName)
    let manifestValues = try? manifestURL.resourceValues(
      forKeys: [.isRegularFileKey, .isSymbolicLinkKey]
    )
    guard manifestValues?.isRegularFile == true, manifestValues?.isSymbolicLink != true else {
      throw CanvastRuntimeLocatorError.invalidManifest(manifestURL, "manifest must be a regular file")
    }
    guard let data = try? Data(contentsOf: manifestURL),
          let document = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let manifest = try? JSONDecoder().decode(Manifest.self, from: data) else {
      throw CanvastRuntimeLocatorError.invalidManifest(manifestURL, "missing or unreadable")
    }
    guard manifest.schemaVersion == 1, manifest.kind == "canvast-sealed-runtime",
          manifest.algorithm == "sha256", isSHA256(manifest.treeSha256) else {
      throw CanvastRuntimeLocatorError.invalidManifest(
        manifestURL, "schemaVersion, kind, algorithm, or treeSha256 is invalid"
      )
    }
    guard let dependencies = document["dependencies"] as? [Any], !dependencies.isEmpty else {
      throw CanvastRuntimeLocatorError.invalidManifest(
        manifestURL, "dependency license inventory is empty"
      )
    }
    let records = manifest.files
    guard !records.isEmpty else {
      throw CanvastRuntimeLocatorError.invalidManifest(manifestURL, "file allowlist is empty")
    }
    for record in records {
      guard isSafeRelativePath(record.path), record.type == "file",
            record.size >= 0, record.size <= 9_007_199_254_740_991,
            isSHA256(record.sha256), (0...0o777).contains(record.mode) else {
        throw CanvastRuntimeLocatorError.invalidManifest(
          manifestURL, "invalid file record for \(record.path)"
        )
      }
    }
    let declared = Set(records.map(\.path))
    guard declared.count == records.count else {
      throw CanvastRuntimeLocatorError.invalidManifest(manifestURL, "duplicate file entries")
    }
    let requiredPaths = [
      "bin/canvast", "bin/node", Self.coreEntrypointPath, "package/package.json",
      "package/licenses/dependencies.json", CanvastSealedEnvironment.policyPath,
      CanvastSealedEnvironment.opensslConfigurationPath,
    ] + Self.extensionPaths
    for required in requiredPaths where !declared.contains(required) {
      throw CanvastRuntimeLocatorError.missingEntry(required)
    }
    let actualRecords = try actualRecords(under: canonicalRoot)
    let actual = Set(actualRecords.map(\.path))
    guard declared == actual else {
      let missing = declared.subtracting(actual).sorted().joined(separator: ", ")
      let unexpected = actual.subtracting(declared).sorted().joined(separator: ", ")
      throw CanvastRuntimeLocatorError.invalidManifest(
        manifestURL, "file allowlist mismatch (missing: [\(missing)], unexpected: [\(unexpected)])"
      )
    }
    let declaredByPath = Dictionary(uniqueKeysWithValues: records.map { ($0.path, $0) })
    for actualRecord in actualRecords {
      guard declaredByPath[actualRecord.path] == actualRecord else {
        throw CanvastRuntimeLocatorError.hashMismatch(actualRecord.path)
      }
    }
    guard treeSHA256(actualRecords) == manifest.treeSha256 else {
      throw CanvastRuntimeLocatorError.invalidManifest(manifestURL, "treeSha256 mismatch")
    }
    let launcher = canonicalRoot.appendingPathComponent("bin/canvast")
    let node = canonicalRoot.appendingPathComponent("bin/node")
    let coreEntrypoint = canonicalRoot.appendingPathComponent(Self.coreEntrypointPath)
    let extensionURLs = Self.extensionPaths.map { canonicalRoot.appendingPathComponent($0) }
    for (path, executable) in [("bin/canvast", launcher), ("bin/node", node)] {
      guard let record = declaredByPath[path], record.mode & 0o111 != 0 else {
        throw CanvastRuntimeLocatorError.missingExecutable(executable.path)
      }
    }
    return .init(
      installRoot: canonicalRoot, launcher: launcher, node: node,
      coreEntrypoint: coreEntrypoint, extensionURLs: extensionURLs, source: source
    )
  }

  private struct Manifest: Decodable {
    let schemaVersion: Int
    let kind: String
    let algorithm: String
    let files: [Record]
    let treeSha256: String
  }

  private struct Record: Decodable, Equatable {
    let path: String
    let type: String
    let size: Int
    let sha256: String
    let mode: Int
  }

  private func actualRecords(under root: URL) throws -> [Record] {
    var records: [Record] = []
    func visit(_ directory: URL, prefix: String) throws {
      let children = try fileManager.contentsOfDirectory(
        at: directory,
        includingPropertiesForKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey],
        options: []
      )
      for child in children {
        let relative = prefix.isEmpty ? child.lastPathComponent : "\(prefix)/\(child.lastPathComponent)"
        guard isSafeRelativePath(relative) else {
          throw CanvastRuntimeLocatorError.invalidEntry(relative)
        }
        let values = try child.resourceValues(
          forKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey]
        )
        guard values.isSymbolicLink != true else {
          throw CanvastRuntimeLocatorError.invalidEntry(relative)
        }
        if values.isDirectory == true {
          try visit(child, prefix: relative)
          continue
        }
        guard values.isRegularFile == true else {
          throw CanvastRuntimeLocatorError.invalidEntry(relative)
        }
        if relative == Self.manifestName { continue }
        let bytes = try Data(contentsOf: child)
        let attributes = try fileManager.attributesOfItem(atPath: child.path)
        guard let mode = (attributes[.posixPermissions] as? NSNumber)?.intValue else {
          throw CanvastRuntimeLocatorError.invalidEntry(relative)
        }
        records.append(Record(
          path: relative, type: "file", size: bytes.count, sha256: sha256(bytes), mode: mode
        ))
      }
    }
    try visit(root, prefix: "")
    return records.sorted { $0.path.localizedCompare($1.path) == .orderedAscending }
  }

  private func treeSHA256(_ records: [Record]) -> String {
    let input = records.map { "\($0.sha256) \($0.size) \($0.path)\n" }.joined()
    return sha256(Data(input.utf8))
  }

  private func sha256(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  private func isSafeRelativePath(_ path: String) -> Bool {
    guard !path.isEmpty, !path.hasPrefix("/"), !path.contains("\0"), !path.contains("\\") else { return false }
    return path.split(separator: "/", omittingEmptySubsequences: false).allSatisfy { $0 != "." && $0 != ".." && !$0.isEmpty }
  }

  private func isSHA256(_ value: String) -> Bool {
    value.count == 64 && value.unicodeScalars.allSatisfy { scalar in
      (48...57).contains(scalar.value) || (97...102).contains(scalar.value)
    }
  }

  private func isSymbolicLink(_ url: URL) -> Bool {
    (try? fileManager.destinationOfSymbolicLink(atPath: url.path)) != nil
  }
}
