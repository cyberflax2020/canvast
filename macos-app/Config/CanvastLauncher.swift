// ============================================================================
// Canvast — macOS Project Launcher / Canvast 源文件
// ============================================================================
// @file        macos-app/Config/CanvastLauncher.swift
// @brief       Select a stable project root before the SwiftUI payload starts.
// @description 在 SwiftUI 主程序启动前选择稳定项目目录，避免依赖 Finder 当前目录。
// @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
// ============================================================================
import Darwin
import Foundation

private let payloadName = "CanvastAppPayload"
private let environmentPolicyPath = "Resources/CanvastRuntime/package/config-templates/sealed-runtime-environment.txt"
private let opensslConfigurationPath = "Resources/CanvastRuntime/package/config-templates/openssl.cnf"

private func fail(_ message: String, code: Int32 = 64) -> Never {
  FileHandle.standardError.write(Data("Canvast launcher: \(message)\n".utf8))
  exit(code)
}

private func currentExecutableURL() -> URL {
  var capacity: UInt32 = 0
  guard _NSGetExecutablePath(nil, &capacity) != 0, capacity > 0 else {
    fail("cannot determine launcher executable path", code: 71)
  }
  var buffer = [CChar](repeating: 0, count: Int(capacity))
  let status = buffer.withUnsafeMutableBufferPointer { pointer in
    _NSGetExecutablePath(pointer.baseAddress, &capacity)
  }
  guard status == 0 else {
    fail("cannot determine launcher executable path", code: 71)
  }
  return URL(fileURLWithPath: String(cString: buffer)).resolvingSymlinksInPath()
}

private func expandedURL(_ path: String, relativeTo base: URL) -> URL {
  let expanded = NSString(string: path).expandingTildeInPath
  if expanded.hasPrefix("/") {
    return URL(fileURLWithPath: expanded).standardizedFileURL
  }
  return base.appendingPathComponent(expanded).standardizedFileURL
}

private struct LauncherSettings: Decodable {
  let workspacePath: String?
}

private func settingsProjectRoot(home: URL) -> URL? {
  let settingsURL = home
    .appendingPathComponent("Library/Application Support/Canvast", isDirectory: true)
    .appendingPathComponent("settings.json")
  guard let data = try? Data(contentsOf: settingsURL),
        let settings = try? JSONDecoder().decode(LauncherSettings.self, from: data),
        let value = settings.workspacePath else {
    return nil
  }
  let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
  return trimmed.isEmpty ? nil : expandedURL(trimmed, relativeTo: home)
}

private func legacyConfiguredProjectRoot(home: URL) -> URL? {
  let configURL = home
    .appendingPathComponent("Library/Application Support/Canvast", isDirectory: true)
    .appendingPathComponent("project-root")
  guard let value = try? String(contentsOf: configURL, encoding: .utf8) else {
    return nil
  }
  let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
  return trimmed.isEmpty ? nil : expandedURL(trimmed, relativeTo: home)
}

private func parseArguments(_ raw: [String], home: URL) -> (projectRoot: URL?, forwarded: [String]) {
  var projectRoot: URL?
  var forwarded: [String] = []
  var index = 0
  while index < raw.count {
    let argument = raw[index]
    if argument == "--project-root" {
      guard index + 1 < raw.count else {
        fail("--project-root requires a directory")
      }
      projectRoot = expandedURL(raw[index + 1], relativeTo: home)
      index += 2
    } else if argument.hasPrefix("--project-root=") {
      let value = String(argument.dropFirst("--project-root=".count))
      guard !value.isEmpty else {
        fail("--project-root requires a directory")
      }
      projectRoot = expandedURL(value, relativeTo: home)
      index += 1
    } else {
      forwarded.append(argument)
      index += 1
    }
  }
  return (projectRoot, forwarded)
}

private func validateDirectory(_ url: URL, source: String) -> URL {
  var isDirectory: ObjCBool = false
  guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory), isDirectory.boolValue else {
    fail("project root from \(source) is not a directory: \(url.path)")
  }
  return url.resolvingSymlinksInPath()
}

private func isEnvironmentName(_ value: String) -> Bool {
  guard let first = value.unicodeScalars.first,
        isASCIIEnvironmentLetter(first) || first.value == 95 else {
    return false
  }
  return value.unicodeScalars.dropFirst().allSatisfy { scalar in
    isASCIIEnvironmentLetter(scalar)
      || (scalar.value >= 48 && scalar.value <= 57) || scalar.value == 95
  }
}

private func isASCIIEnvironmentLetter(_ scalar: UnicodeScalar) -> Bool {
  (scalar.value >= 65 && scalar.value <= 90) || (scalar.value >= 97 && scalar.value <= 122)
}

private func sanitizeEnvironment(contentsURL: URL) {
  let policyURL = contentsURL.appendingPathComponent(environmentPolicyPath)
  let opensslURL = contentsURL.appendingPathComponent(opensslConfigurationPath)
  guard let policyValues = try? policyURL.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]),
        policyValues.isRegularFile == true, policyValues.isSymbolicLink != true,
        let policy = try? String(contentsOf: policyURL, encoding: .utf8) else {
    fail("sealed runtime environment policy is unavailable", code: 72)
  }
  guard let opensslValues = try? opensslURL.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]),
        opensslValues.isRegularFile == true, opensslValues.isSymbolicLink != true else {
    fail("sealed runtime OpenSSL configuration is unavailable", code: 72)
  }
  for rawLine in policy.components(separatedBy: .newlines) {
    let name = rawLine
    if name.isEmpty { continue }
    guard isEnvironmentName(name) else {
      fail("sealed runtime environment policy contains an invalid entry", code: 72)
    }
    unsetenv(name)
  }
  setenv("OPENSSL_CONF", opensslURL.path, 1)
}

let home = FileManager.default.homeDirectoryForCurrentUser.standardizedFileURL
// Resolve the process image before changing cwd. argv[0] may be relative (or a
// bare PATH lookup), so deriving the App bundle from it after chdir is unsafe.
let launcherURL = currentExecutableURL()
let parsed = parseArguments(Array(CommandLine.arguments.dropFirst()), home: home)
let environmentRoot = ProcessInfo.processInfo.environment["CANVAST_PROJECT_ROOT"]
  .flatMap { $0.isEmpty ? nil : expandedURL($0, relativeTo: home) }
let settingsRoot = settingsProjectRoot(home: home)
let legacyFileRoot = legacyConfiguredProjectRoot(home: home)
let selection: (URL, String)?
if let explicitRoot = parsed.projectRoot {
  selection = (explicitRoot, "--project-root")
} else if let environmentRoot {
  selection = (environmentRoot, "CANVAST_PROJECT_ROOT")
} else if let settingsRoot {
  selection = (settingsRoot, "~/Library/Application Support/Canvast/settings.json")
} else if let legacyFileRoot {
  selection = (legacyFileRoot, "~/Library/Application Support/Canvast/project-root")
} else {
  selection = nil
}

if let selection {
  let projectRoot = validateDirectory(selection.0, source: selection.1)
  guard FileManager.default.changeCurrentDirectoryPath(projectRoot.path) else {
    fail("cannot change directory to project root: \(projectRoot.path)", code: 71)
  }
  setenv("CANVAST_PROJECT_ROOT", projectRoot.path, 1)
} else {
  unsetenv("CANVAST_PROJECT_ROOT")
}

let contentsURL = launcherURL.deletingLastPathComponent().deletingLastPathComponent()
sanitizeEnvironment(contentsURL: contentsURL)
let payloadURL = contentsURL.appendingPathComponent("Helpers", isDirectory: true).appendingPathComponent(payloadName)
guard FileManager.default.isExecutableFile(atPath: payloadURL.path) else {
  fail("payload is missing or not executable: \(payloadURL.path)", code: 72)
}

let execArguments = [payloadURL.path] + parsed.forwarded
var cArguments = execArguments.map { strdup($0) } + [nil]
defer {
  for argument in cArguments where argument != nil {
    free(argument)
  }
}
_ = cArguments.withUnsafeMutableBufferPointer { buffer in
  execv(payloadURL.path, buffer.baseAddress!)
}
fail("cannot start payload: \(String(cString: strerror(errno)))", code: 74)
