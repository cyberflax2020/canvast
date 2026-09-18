import Foundation
import CanvastAppCore

@MainActor
extension CanvastDesktopModel {
  func decodeSandboxGrant(_ value: CanvastJSONValue?) -> DesktopSandboxGrant? {
    guard let grant = objectValue(value),
          let id = stringValue(grant["id"]),
          let scope = stringValue(grant["scope"]),
          let kind = stringValue(grant["kind"]),
          let target = stringValue(grant["value"]) else { return nil }
    return DesktopSandboxGrant(
      id: id, scope: scope, kind: kind, value: target,
      createdAt: stringValue(grant["createdAt"]) ?? "", reason: stringValue(grant["reason"])
    )
  }

  func decodeSandboxRevocationReceipt(
    _ result: [String: CanvastJSONValue]
  ) -> DesktopSandboxRevocationReceipt? {
    guard let removedGrant = decodeSandboxGrant(result["removedGrant"]),
          let revision = integerValue(result["revision"]),
          let futureOperationsOnly = booleanValue(result["futureOperationsOnly"]),
          let message = stringValue(result["message"]) else { return nil }
    return .init(
      removedGrant: removedGrant, revision: revision,
      futureOperationsOnly: futureOperationsOnly, message: message
    )
  }

  func decodeSandboxDecision(_ value: CanvastJSONValue?) -> DesktopSandboxDecision? {
    guard let decision = objectValue(value) else { return nil }
    let missing = arrayValue(decision["missingGrants"])?.compactMap { item -> String? in
      guard let grant = objectValue(item) else { return nil }
      return [stringValue(grant["kind"]), stringValue(grant["value"])].compactMap { $0 }.joined(separator: ":")
    } ?? []
    return DesktopSandboxDecision(
      action: stringValue(decision["action"]) ?? "", profile: stringValue(decision["profile"]) ?? "",
      severity: stringValue(decision["severity"]) ?? "", reason: stringValue(decision["reason"]) ?? "",
      categories: stringsValue(decision["categories"]), writePaths: stringsValue(decision["writePaths"]),
      readPaths: stringsValue(decision["readPaths"]), missingGrants: missing
    )
  }

  func optionalStringArguments(_ key: String, _ value: String?) -> [String: CanvastDesktopValue] {
    guard let value else { return [:] }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? [:] : [key: .string(trimmed)]
  }

  func legacyDetails(_ result: [String: CanvastJSONValue]) -> [String: CanvastJSONValue] {
    objectValue(result["details"]) ?? [:]
  }

  func stringValue(_ value: CanvastJSONValue?) -> String? {
    guard case .string(let decoded) = value else { return nil }
    return decoded
  }

  func booleanValue(_ value: CanvastJSONValue?) -> Bool? {
    guard case .boolean(let decoded) = value else { return nil }
    return decoded
  }

  func integerValue(_ value: CanvastJSONValue?) -> Int? {
    guard case .number(let decoded) = value, decoded.rounded() == decoded else { return nil }
    return Int(decoded)
  }

  func arrayValue(_ value: CanvastJSONValue?) -> [CanvastJSONValue]? {
    guard case .array(let decoded) = value else { return nil }
    return decoded
  }

  func objectValue(_ value: CanvastJSONValue?) -> [String: CanvastJSONValue]? {
    guard case .object(let decoded) = value else { return nil }
    return decoded
  }

  func stringsValue(_ value: CanvastJSONValue?) -> [String] {
    arrayValue(value)?.compactMap(stringValue) ?? []
  }

  func actionResultSummary(_ result: CanvastDesktopActionResult) -> String {
    switch result.status {
    case .succeeded: return "Desktop action completed"
    case .unsupported: return "This targeted action is not supported by the current runtime"
    case .failed: return "Desktop action failed"
    }
  }

  func shellDisplay(_ argument: String) -> String {
    guard argument.contains(where: { $0.isWhitespace || $0 == "'" || $0 == "\"" }) else { return argument }
    return "'" + argument.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
  }

  func workspace(for id: CanvastFeatureID) -> DesktopWorkspace {
    switch id {
    case .chat, .reasoningTrace, .models, .modelRegistry: return .runConsole
    case .canvas, .dynamicCanvas, .offscreenSnapshot: return .canvas
    case .autoOrchestration, .planMode, .taskTree, .closure, .evaluation, .codeReview: return .taskPlan
    case .subAgents, .workflow, .dynamicWorkflow, .backgroundTasks, .monitor, .cron: return .agentsWorkflow
    case .sandbox, .permissions, .safety, .guiGuard, .askUser: return .safetyPermissions
    default: return .toolsContextSessions
    }
  }

  func toolsSection(for id: CanvastFeatureID) -> ToolsWorkspaceSection? {
    switch id {
    case .context: return .context
    case .sessions: return .sessions
    default: return .tools
    }
  }
}
