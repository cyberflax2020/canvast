// ============================================================================
// Canvast — macOS App Bootstrap / Canvast 源文件
// ============================================================================
// @file        CanvastAppBootstrap.swift
// @brief       Prepares the installed App process before SwiftUI construction.
// @description 在同一主进程中选择工作区并隔离封闭运行时环境。
// @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
// ============================================================================
import Darwin
import Foundation
import CanvastAppCore

enum CanvastAppBootstrapError: LocalizedError {
  case missingProjectRootValue
  case invalidProjectRoot(URL, String)
  case cannotChangeDirectory(URL)
  case missingBundleResources

  var errorDescription: String? {
    switch self {
    case .missingProjectRootValue:
      return "--project-root requires a directory"
    case .invalidProjectRoot(let url, let source):
      return "project root from \(source) is not a directory: \(url.path)"
    case .cannotChangeDirectory(let url):
      return "cannot change directory to project root: \(url.path)"
    case .missingBundleResources:
      return "installed application resources are unavailable"
    }
  }
}

enum CanvastAppBootstrap {
  private struct BootstrapSettings: Decodable {
    let workspacePath: String?
  }

  static func prepare(
    arguments: [String],
    inheritedEnvironment: [String: String] = ProcessInfo.processInfo.environment,
    bundle: Bundle = .main,
    fileManager: FileManager = .default,
    loadsPersistedWorkspace: Bool = true
  ) throws {
    let home = fileManager.homeDirectoryForCurrentUser.standardizedFileURL
    let settingsPathOverride = inheritedEnvironment["CANVAST_DESKTOP_SETTINGS_PATH"]?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let explicitRoot = try explicitProjectRoot(arguments: arguments, home: home)
    let environmentRoot = inheritedEnvironment["CANVAST_PROJECT_ROOT"]
      .flatMap { persistedWorkspaceURL($0, home: home, fileManager: fileManager) }
    let settingsRoot = loadsPersistedWorkspace
      ? settingsProjectRoot(
        home: home,
        fileManager: fileManager,
        settingsPathOverride: settingsPathOverride
      )
      : nil
    let legacyRoot = loadsPersistedWorkspace && settingsPathOverride?.isEmpty != false
      ? legacyProjectRoot(home: home, fileManager: fileManager)
      : nil

    let selection: (url: URL, source: String)?
    if let explicitRoot {
      selection = (explicitRoot, "--project-root")
    } else if let environmentRoot {
      selection = (environmentRoot, "CANVAST_PROJECT_ROOT")
    } else if let settingsRoot {
      selection = (settingsRoot, "~/Library/Application Support/Canvast/settings.json")
    } else if let legacyRoot {
      selection = (legacyRoot, "~/Library/Application Support/Canvast/project-root")
    } else {
      selection = nil
    }

    var bootstrapEnvironment = inheritedEnvironment
    if let selection {
      let root = try validateDirectory(selection.url, source: selection.source, fileManager: fileManager)
      guard fileManager.changeCurrentDirectoryPath(root.path) else {
        throw CanvastAppBootstrapError.cannotChangeDirectory(root)
      }
      setenv("CANVAST_PROJECT_ROOT", root.path, 1)
      bootstrapEnvironment["CANVAST_PROJECT_ROOT"] = root.path
    } else {
      unsetenv("CANVAST_PROJECT_ROOT")
      bootstrapEnvironment.removeValue(forKey: "CANVAST_PROJECT_ROOT")
    }

    guard bundle.bundleURL.pathExtension == "app" else { return }
    guard let resources = bundle.resourceURL else {
      throw CanvastAppBootstrapError.missingBundleResources
    }
    let runtimeRoot = resources.appendingPathComponent("CanvastRuntime", isDirectory: true)
    let sealed = try CanvastSealedEnvironment.applying(
      to: bootstrapEnvironment, runtimeRoot: runtimeRoot, fileManager: fileManager
    )
    applyEnvironment(sealed, replacing: inheritedEnvironment)
  }

  private static func explicitProjectRoot(arguments: [String], home: URL) throws -> URL? {
    var selected: URL?
    var index = 1
    while index < arguments.count {
      let argument = arguments[index]
      if argument == "--project-root" {
        guard arguments.indices.contains(index + 1), !arguments[index + 1].hasPrefix("--") else {
          throw CanvastAppBootstrapError.missingProjectRootValue
        }
        selected = expandedURL(arguments[index + 1], relativeTo: home)
        index += 2
      } else if argument.hasPrefix("--project-root=") {
        let value = String(argument.dropFirst("--project-root=".count))
        guard !value.isEmpty else { throw CanvastAppBootstrapError.missingProjectRootValue }
        selected = expandedURL(value, relativeTo: home)
        index += 1
      } else {
        index += 1
      }
    }
    return selected
  }

  private static func expandedURL(_ path: String, relativeTo base: URL) -> URL? {
    let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    let expanded = NSString(string: trimmed).expandingTildeInPath
    return (expanded.hasPrefix("/")
      ? URL(fileURLWithPath: expanded, isDirectory: true)
      : base.appendingPathComponent(expanded, isDirectory: true))
      .standardizedFileURL
  }

  private static func settingsProjectRoot(
    home: URL,
    fileManager: FileManager,
    settingsPathOverride: String?
  ) -> URL? {
    let url = settingsPathOverride.flatMap { override -> URL? in
      let trimmed = override.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmed.isEmpty else { return nil }
      return URL(fileURLWithPath: trimmed, isDirectory: false).standardizedFileURL
    } ?? home.appendingPathComponent(
      "Library/Application Support/Canvast/settings.json", isDirectory: false
    )
    guard let data = try? Data(contentsOf: url),
          let settings = try? JSONDecoder().decode(BootstrapSettings.self, from: data),
          let path = settings.workspacePath else {
      return nil
    }
    return persistedWorkspaceURL(path, home: home, fileManager: fileManager)
  }

  private static func legacyProjectRoot(home: URL, fileManager: FileManager) -> URL? {
    let url = home.appendingPathComponent(
      "Library/Application Support/Canvast/project-root", isDirectory: false
    )
    guard let path = try? String(contentsOf: url, encoding: .utf8) else { return nil }
    return persistedWorkspaceURL(path, home: home, fileManager: fileManager)
  }

  private static func persistedWorkspaceURL(
    _ path: String, home: URL, fileManager: FileManager
  ) -> URL? {
    let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    guard !CanvastDesktopModel.isUnconfiguredWorkspacePath(trimmed) else { return nil }
    guard let url = expandedURL(trimmed, relativeTo: home) else { return nil }
    var isDirectory: ObjCBool = false
    guard fileManager.fileExists(atPath: url.path, isDirectory: &isDirectory),
          isDirectory.boolValue else { return nil }
    return url
  }

  private static func validateDirectory(
    _ url: URL, source: String, fileManager: FileManager
  ) throws -> URL {
    var isDirectory: ObjCBool = false
    guard fileManager.fileExists(atPath: url.path, isDirectory: &isDirectory),
          isDirectory.boolValue else {
      throw CanvastAppBootstrapError.invalidProjectRoot(url, source)
    }
    return url.resolvingSymlinksInPath()
  }

  private static func applyEnvironment(
    _ environment: [String: String],
    replacing inherited: [String: String]
  ) {
    for name in inherited.keys where environment[name] == nil {
      unsetenv(name)
    }
    for (name, value) in environment {
      setenv(name, value, 1)
    }
  }
}
