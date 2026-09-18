import Foundation

public enum CanvastDesktopWorkspace: String, CaseIterable, Codable, Hashable {
  case run
  case planning
  case orchestration
  case canvas
  case safety
  case project
}

public enum CanvastDesktopCapabilityLevel: String, Codable, Equatable {
  case executable
  case editable
  case degraded
  case readOnly = "read_only"
  case external
  case unavailable
}

public enum CanvastDesktopActionTransport: String, Codable, Equatable {
  case nativeRPC = "native_rpc"
  case desktopDispatcher = "desktop_dispatcher"
  case localUI = "local_ui"
}

public enum CanvastRuntimeRequestControlPolicy: String, CaseIterable, Codable, Hashable {
  case sidecar
  case status
  case pause
  case redirect
  case taskAdjustment = "task_adjustment"
}

public enum CanvastDesktopActionKind: String, Codable, CaseIterable, Equatable {
  case runPrompt = "runtime.prompt"
  case steerRun = "runtime.steer"
  case followUpRun = "runtime.followUp"
  case stopRun = "runtime.abort"
  case newSession = "session.new"
  case sessionCatalog = "session.catalog"
  case sessionOpen = "session.open"
  case sessionRename = "session.rename"
  case sessionDelete = "session.delete"
  case sessionTranscript = "session.transcript"
  case projectPreflight = "project.preflight"
  case projectCreate = "project.create"
  case projectOpen = "project.open"
  case projectReinitialize = "project.reinitialize"
  case projectDelete = "project.delete"
  case setThinkingLevel = "runtime.thinking"
  case projectRestart = "session.projectRestart"
  case setRuntimeMode = "runtime.mode"
  case requestControl = "runtime.requestControl"
  case inspectResume = "resume.inspect"
  case chooseResume = "resume.choose"
  case claimResume = "resume.claim"
  case rebindResume = "resume.rebind"
  case retireResume = "resume.retire"
  case reconcileResume = "resume.reconcile"
  case setPermissionMode = "permission.set"
  case createPlan = "plan.create"
  case updatePlan = "plan.update"
  case approvePlan = "plan.approve"
  case completePlan = "plan.complete"
  case createTask = "task.create"
  case updateTask = "task.update"
  case spawnAgent = "agent.launch"
  case cancelAgent = "agent.cancel"
  case followUpAgent = "agent.followUp"
  case runWorkflow = "workflow.launch"
  case cancelWorkflow = "workflow.cancel"
  case followUpWorkflow = "workflow.followUp"
  case selectCanvasTask = "canvas.task.select"
  case selectCanvasPlan = "canvas.plan.select"
  case exportCanvas = "canvas.export"
  case cancelCanvasExport = "canvas.export.cancel"
  case inspectProjectScope = "project.scope.inspect"
  case rebindProjectScope = "project.scope.rebind"
  case inspectSandbox = "sandbox.inspect"
  case setSandboxProfile = "sandbox.profile.set"
  case grantSandboxAccess = "sandbox.grant"
  case revokeSandboxAccess = "sandbox.revoke"
  case filterCanvasSnapshot = "canvas.snapshot.filter"
  case reloadPersistedSnapshot = "runtime.snapshot.reload"

  public var transport: CanvastDesktopActionTransport {
    switch self {
    case .runPrompt, .steerRun, .followUpRun, .stopRun, .setThinkingLevel:
      return .nativeRPC
    case .newSession, .sessionCatalog, .sessionOpen, .sessionRename, .sessionDelete, .sessionTranscript,
         .projectPreflight, .projectCreate, .projectOpen, .projectReinitialize, .projectDelete,
         .projectRestart, .setRuntimeMode, .requestControl,
         .inspectResume, .chooseResume, .claimResume, .rebindResume, .retireResume, .reconcileResume,
         .setPermissionMode,
         .createPlan, .updatePlan, .approvePlan, .completePlan, .createTask, .updateTask,
         .spawnAgent, .cancelAgent, .followUpAgent, .runWorkflow, .cancelWorkflow, .followUpWorkflow,
         .selectCanvasTask, .selectCanvasPlan, .exportCanvas, .cancelCanvasExport,
         .inspectProjectScope, .rebindProjectScope,
         .inspectSandbox, .setSandboxProfile, .grantSandboxAccess, .revokeSandboxAccess:
      return .desktopDispatcher
    case .filterCanvasSnapshot, .reloadPersistedSnapshot:
      return .localUI
    }
  }

  public var usesDesktopDispatcher: Bool {
    transport == .desktopDispatcher
  }
}

public enum CanvastDesktopValue: Codable, Equatable {
  case string(String)
  case integer(Int)
  case boolean(Bool)
  case strings([String])

  private enum CodingKeys: String, CodingKey { case type, string, integer, boolean, strings }
  private enum ValueType: String, Codable { case string, integer, boolean, strings }

  public init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    switch try values.decode(ValueType.self, forKey: .type) {
    case .string: self = .string(try values.decode(String.self, forKey: .string))
    case .integer: self = .integer(try values.decode(Int.self, forKey: .integer))
    case .boolean: self = .boolean(try values.decode(Bool.self, forKey: .boolean))
    case .strings: self = .strings(try values.decode([String].self, forKey: .strings))
    }
  }

  public func encode(to encoder: Encoder) throws {
    var values = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .string(let value):
      try values.encode(ValueType.string, forKey: .type)
      try values.encode(value, forKey: .string)
    case .integer(let value):
      try values.encode(ValueType.integer, forKey: .type)
      try values.encode(value, forKey: .integer)
    case .boolean(let value):
      try values.encode(ValueType.boolean, forKey: .type)
      try values.encode(value, forKey: .boolean)
    case .strings(let value):
      try values.encode(ValueType.strings, forKey: .type)
      try values.encode(value, forKey: .strings)
    }
  }
}

public struct CanvastResumeClaimPayload: Equatable {
  public let candidateID: String?
  public let expectedRevision: Int

  public init(candidateID: String?, expectedRevision: Int) {
    self.candidateID = candidateID
    self.expectedRevision = expectedRevision
  }

  public var actionArguments: [String: CanvastDesktopValue] {
    var arguments: [String: CanvastDesktopValue] = [
      "expectedRevision": .integer(expectedRevision),
    ]
    if let candidateID { arguments["candidateId"] = .string(candidateID) }
    return arguments
  }
}

public struct CanvastDesktopAction: Identifiable, Codable, Equatable {
  public static let currentProtocolVersion = 1

  public var id: String { requestID }
  public let protocolVersion: Int
  public let requestID: String
  public let workspace: CanvastDesktopWorkspace
  public let kind: CanvastDesktopActionKind
  public let featureID: CanvastFeatureID
  public let arguments: [String: CanvastDesktopValue]

  private enum CodingKeys: String, CodingKey {
    case protocolVersion
    case requestID = "requestId"
    case workspace
    case kind
    case featureID
    case arguments
  }

  public init(
    protocolVersion: Int = CanvastDesktopAction.currentProtocolVersion,
    requestID: String = UUID().uuidString,
    workspace: CanvastDesktopWorkspace,
    kind: CanvastDesktopActionKind,
    featureID: CanvastFeatureID,
    arguments: [String: CanvastDesktopValue] = [:]
  ) {
    self.protocolVersion = protocolVersion
    self.requestID = requestID
    self.workspace = workspace
    self.kind = kind
    self.featureID = featureID
    self.arguments = arguments
  }

  public func validate() throws {
    guard protocolVersion == Self.currentProtocolVersion else {
      throw CanvastDesktopActionValidationError.unsupportedProtocol(protocolVersion)
    }
    guard !requestID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw CanvastDesktopActionValidationError.invalidArgument("requestId must be a non-empty string.")
    }
    func text(_ names: [String], label: String) throws -> String {
      for name in names {
        if case .string(let value)? = arguments[name],
           !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
          return value.trimmingCharacters(in: .whitespacesAndNewlines)
        }
      }
      throw CanvastDesktopActionValidationError.invalidArgument("\(label) must be a non-empty string.")
    }
    func exactArguments(_ accepted: Set<String>) throws {
      let unexpected = arguments.keys.filter { !accepted.contains($0) }.sorted()
      guard unexpected.isEmpty else {
        throw CanvastDesktopActionValidationError.invalidArgument(
          "\(kind.rawValue) does not accept: \(unexpected.joined(separator: ", "))."
        )
      }
    }
    switch kind {
    case .newSession, .sessionCatalog, .projectRestart, .setRuntimeMode:
      guard workspace == .project, featureID == .sessions else {
        throw CanvastDesktopActionValidationError.invalidArgument("\(kind.rawValue) requires project/sessions routing.")
      }
      if kind == .newSession || kind == .sessionCatalog {
        guard arguments.isEmpty else {
          throw CanvastDesktopActionValidationError.invalidArgument("\(kind.rawValue) does not accept arguments.")
        }
      }
    case .sessionOpen, .sessionDelete, .sessionTranscript:
      guard workspace == .project, featureID == .sessions else {
        throw CanvastDesktopActionValidationError.invalidArgument("\(kind.rawValue) requires project/sessions routing.")
      }
      try exactArguments(["sessionPath", "path"])
      _ = try text(["sessionPath", "path"], label: "Session path")
    case .sessionRename:
      guard workspace == .project, featureID == .sessions else {
        throw CanvastDesktopActionValidationError.invalidArgument("session.rename requires project/sessions routing.")
      }
      _ = try text(["name", "title"], label: "Session name")
      if let value = arguments["sessionPath"], case .string = value {
        break
      } else if arguments["sessionPath"] != nil {
        throw CanvastDesktopActionValidationError.invalidArgument("session.rename sessionPath must be a string when provided.")
      }
    case .projectPreflight:
      guard workspace == .project, featureID == .sessions else {
        throw CanvastDesktopActionValidationError.invalidArgument("project.preflight requires project/sessions routing.")
      }
      try exactArguments(["path", "projectPath", "replacementPath", "operation"])
      _ = try text(["path", "projectPath"], label: "Project path")
      let operation = try text(["operation"], label: "Project operation")
      guard ["create", "open", "reinitialize", "retire"].contains(operation) else {
        throw CanvastDesktopActionValidationError.invalidArgument(
          "project.preflight operation must be create, open, reinitialize, or retire."
        )
      }
      if let value = arguments["replacementPath"], case .string = value {
        _ = value
      } else if arguments["replacementPath"] != nil {
        throw CanvastDesktopActionValidationError.invalidArgument(
          "project.preflight replacementPath must be a string when provided."
        )
      }
    case .projectCreate, .projectOpen, .projectReinitialize, .projectDelete:
      guard workspace == .project, featureID == .sessions else {
        throw CanvastDesktopActionValidationError.invalidArgument("\(kind.rawValue) requires project/sessions routing.")
      }
      try exactArguments([
        "path", "projectPath", "replacementPath", "expectedRevision", "approvedAcknowledgement",
      ])
      _ = try text(["path", "projectPath"], label: "Project path")
      if let value = arguments["replacementPath"], case .string = value {
        _ = value
      } else if arguments["replacementPath"] != nil {
        throw CanvastDesktopActionValidationError.invalidArgument(
          "\(kind.rawValue) replacementPath must be a string when provided."
        )
      }
      if let value = arguments["expectedRevision"] {
        guard case .string(let revision) = value,
              !revision.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
          throw CanvastDesktopActionValidationError.invalidArgument(
            "\(kind.rawValue) expectedRevision must be a non-empty string when provided."
          )
        }
      }
      if let value = arguments["approvedAcknowledgement"] {
        guard case .boolean = value else {
          throw CanvastDesktopActionValidationError.invalidArgument(
            "\(kind.rawValue) approvedAcknowledgement must be a boolean when provided."
          )
        }
      }
    case .requestControl:
      guard workspace == .run, featureID == .chat else {
        throw CanvastDesktopActionValidationError.invalidArgument("runtime.requestControl requires run/chat routing.")
      }
      let policy = try text(["policy"], label: "policy")
      guard CanvastRuntimeRequestControlPolicy(rawValue: policy) != nil else {
        throw CanvastDesktopActionValidationError.invalidArgument("Unsupported request-control policy: \(policy).")
      }
      _ = try text(["text", "message", "request"], label: "request-control text")
    case .inspectResume:
      guard workspace == .run, featureID == .chat else {
        throw CanvastDesktopActionValidationError.invalidArgument("\(kind.rawValue) requires run/chat routing.")
      }
      _ = try text(["candidateId", "id"], label: "Resume candidate id")
    case .claimResume:
      guard workspace == .run, featureID == .chat else {
        throw CanvastDesktopActionValidationError.invalidArgument("resume.claim requires run/chat routing.")
      }
      try exactArguments(["candidateId", "expectedRevision"])
      if let value = arguments["candidateId"] {
        guard case .string(let candidateID) = value,
              !candidateID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
          throw CanvastDesktopActionValidationError.invalidArgument("resume.claim candidateId must be a non-empty string when provided.")
        }
      }
      guard case .integer(let expectedRevision)? = arguments["expectedRevision"], expectedRevision >= 0 else {
        throw CanvastDesktopActionValidationError.invalidArgument("resume.claim expectedRevision must be a nonnegative integer.")
      }
    case .reconcileResume:
      guard workspace == .run, featureID == .chat else {
        throw CanvastDesktopActionValidationError.invalidArgument("resume.reconcile requires run/chat routing.")
      }
      guard arguments.isEmpty else {
        throw CanvastDesktopActionValidationError.invalidArgument("resume.reconcile does not accept arguments.")
      }
    case .chooseResume, .retireResume:
      guard workspace == .run, featureID == .chat else {
        throw CanvastDesktopActionValidationError.invalidArgument("\(kind.rawValue) requires run/chat routing.")
      }
      _ = try text(["candidateId", "id"], label: "Resume candidate id")
    case .rebindResume:
      guard workspace == .run, featureID == .chat else {
        throw CanvastDesktopActionValidationError.invalidArgument("resume.rebind requires run/chat routing.")
      }
      _ = try text(["candidateId", "id"], label: "Resume candidate id")
      let hasPlanNode = {
        if case .string(let value)? = arguments["planNodeId"] {
          return !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        return false
      }()
      let hasTaskNode = {
        if case .string(let value)? = arguments["taskNodeId"] {
          return !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        return false
      }()
      guard hasPlanNode || hasTaskNode else {
        throw CanvastDesktopActionValidationError.invalidArgument("resume.rebind requires at least one of planNodeId or taskNodeId.")
      }
    case .selectCanvasTask:
      guard workspace == .canvas, featureID == .canvas else {
        throw CanvastDesktopActionValidationError.invalidArgument("canvas.task.select requires canvas/canvas routing.")
      }
      _ = try text(["nodeId", "taskId", "id"], label: "Canvas task id")
    case .selectCanvasPlan:
      guard workspace == .planning, featureID == .planMode else {
        throw CanvastDesktopActionValidationError.invalidArgument("canvas.plan.select requires planning/planMode routing.")
      }
      _ = try text(["planId", "nodeId", "id"], label: "Canvas plan id")
    case .exportCanvas:
      guard workspace == .canvas, featureID == .canvas else {
        throw CanvastDesktopActionValidationError.invalidArgument("canvas.export requires canvas/canvas routing.")
      }
      try exactArguments(["outputName"])
      let outputName = try text(["outputName"], label: "Canvas export outputName")
      guard isSafeCanvasExportName(outputName) else {
        throw CanvastDesktopActionValidationError.invalidArgument(
          "Canvas export outputName must be a safe basename of 1-96 letters, digits, hyphens, or underscores."
        )
      }
    case .cancelCanvasExport:
      guard workspace == .canvas, featureID == .canvas else {
        throw CanvastDesktopActionValidationError.invalidArgument("canvas.export.cancel requires canvas/canvas routing.")
      }
      try exactArguments(["targetRequestId"])
      let target = try text(["targetRequestId"], label: "Canvas export target request id")
      guard target.count <= 256 else {
        throw CanvastDesktopActionValidationError.invalidArgument("Canvas export target request id is too long.")
      }
    case .inspectProjectScope, .rebindProjectScope:
      guard workspace == .project, featureID == .sessions else {
        throw CanvastDesktopActionValidationError.invalidArgument("Project scope actions require project/sessions routing.")
      }
      guard arguments.isEmpty else {
        throw CanvastDesktopActionValidationError.invalidArgument("\(kind.rawValue) does not accept arguments.")
      }
    case .revokeSandboxAccess:
      guard workspace == .safety, featureID == .sandbox else {
        throw CanvastDesktopActionValidationError.invalidArgument("sandbox.revoke requires safety/sandbox routing.")
      }
      try exactArguments(["grantId", "expectedRevision"])
      _ = try text(["grantId"], label: "Sandbox grant id")
      guard case .integer(let expectedRevision)? = arguments["expectedRevision"],
            expectedRevision >= 0 else {
        throw CanvastDesktopActionValidationError.invalidArgument(
          "sandbox.revoke expectedRevision must be a nonnegative integer."
        )
      }
    default:
      break
    }
  }
}

public enum CanvastDesktopActionValidationError: LocalizedError, Equatable {
  case unsupportedProtocol(Int)
  case invalidArgument(String)

  public var errorDescription: String? {
    switch self {
    case .unsupportedProtocol(let version):
      return CanvastAppCoreLocalizer.text(
        "Unsupported desktop action protocol version \(version); expected \(CanvastDesktopAction.currentProtocolVersion).",
        "不支持的桌面动作协议版本 \(version)；期望版本为 \(CanvastDesktopAction.currentProtocolVersion)。"
      )
    case .invalidArgument(let message):
      return message
    }
  }
}

private func isSafeCanvasExportName(_ value: String) -> Bool {
  let bytes = Array(value.utf8)
  guard !bytes.isEmpty, bytes.count <= 96 else { return false }
  return bytes.allSatisfy { byte in
    (48...57).contains(byte) || (65...90).contains(byte) || (97...122).contains(byte) ||
      byte == 45 || byte == 95
  }
}

private func isLowercaseSHA256(_ value: String) -> Bool {
  let bytes = Array(value.utf8)
  return bytes.count == 64 && bytes.allSatisfy { byte in
    (48...57).contains(byte) || (97...102).contains(byte)
  }
}

public indirect enum CanvastJSONValue: Codable, Equatable {
  case string(String)
  case number(Double)
  case boolean(Bool)
  case array([CanvastJSONValue])
  case object([String: CanvastJSONValue])
  case null

  public init(from decoder: Decoder) throws {
    let value = try decoder.singleValueContainer()
    if value.decodeNil() { self = .null }
    else if let decoded = try? value.decode(Bool.self) { self = .boolean(decoded) }
    else if let decoded = try? value.decode(Double.self) { self = .number(decoded) }
    else if let decoded = try? value.decode(String.self) { self = .string(decoded) }
    else if let decoded = try? value.decode([CanvastJSONValue].self) { self = .array(decoded) }
    else if let decoded = try? value.decode([String: CanvastJSONValue].self) { self = .object(decoded) }
    else { throw DecodingError.dataCorruptedError(in: value, debugDescription: "Unsupported JSON value") }
  }

  public func encode(to encoder: Encoder) throws {
    var value = encoder.singleValueContainer()
    switch self {
    case .string(let decoded): try value.encode(decoded)
    case .number(let decoded): try value.encode(decoded)
    case .boolean(let decoded): try value.encode(decoded)
    case .array(let decoded): try value.encode(decoded)
    case .object(let decoded): try value.encode(decoded)
    case .null: try value.encodeNil()
    }
  }
}

public enum CanvastDesktopActionResultStatus: String, Codable, Equatable {
  case succeeded
  case failed
  case unsupported
}

public enum CanvastDesktopActionCapability: String, Codable, Equatable {
  case full
  case degraded
  case unsupported
}

public struct CanvastDesktopActionError: Codable, Equatable {
  public let code: String
  public let message: String
  public let details: CanvastJSONValue?

  public init(code: String, message: String, details: CanvastJSONValue? = nil) {
    self.code = code
    self.message = message
    self.details = details
  }
}

public struct CanvastDesktopActionResult: Codable, Equatable {
  public let protocolVersion: Int
  public let requestID: String
  public let status: CanvastDesktopActionResultStatus
  public let result: [String: CanvastJSONValue]?
  public let error: CanvastDesktopActionError?
  public let capabilityLevel: CanvastDesktopActionCapability

  private enum CodingKeys: String, CodingKey {
    case protocolVersion
    case requestID = "requestId"
    case status
    case result
    case error
    case capabilityLevel
  }

  public init(
    protocolVersion: Int = CanvastDesktopAction.currentProtocolVersion,
    requestID: String,
    status: CanvastDesktopActionResultStatus,
    result: [String: CanvastJSONValue]? = nil,
    error: CanvastDesktopActionError? = nil,
    capabilityLevel: CanvastDesktopActionCapability
  ) {
    self.protocolVersion = protocolVersion
    self.requestID = requestID
    self.status = status
    self.result = result
    self.error = error
    self.capabilityLevel = capabilityLevel
  }

  public func validatePayload(for kind: CanvastDesktopActionKind?) throws {
    guard protocolVersion == CanvastDesktopAction.currentProtocolVersion else {
      throw CanvastDesktopActionValidationError.unsupportedProtocol(protocolVersion)
    }
    guard !requestID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw CanvastDesktopActionValidationError.invalidArgument("Result requestId must be non-empty.")
    }
    guard status == .succeeded else {
      if error == nil {
        throw CanvastDesktopActionValidationError.invalidArgument("A failed or unsupported result requires an error.")
      }
      return
    }
    guard error == nil, let result else {
      throw CanvastDesktopActionValidationError.invalidArgument("A successful result requires a result and no error.")
    }
    func requireString(_ key: String) throws -> String {
      guard case .string(let value)? = result[key], !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        throw CanvastDesktopActionValidationError.invalidArgument("Successful \(kind?.rawValue ?? "desktop action") result requires \(key).")
      }
      return value
    }
    func requireObject(_ key: String) throws -> [String: CanvastJSONValue] {
      guard case .object(let value)? = result[key] else {
        throw CanvastDesktopActionValidationError.invalidArgument("Successful \(kind?.rawValue ?? "desktop action") result requires \(key).")
      }
      return value
    }
    func requireString(_ object: [String: CanvastJSONValue], _ key: String) throws -> String {
      guard case .string(let value)? = object[key], !value.isEmpty else {
        throw CanvastDesktopActionValidationError.invalidArgument(
          "Successful \(kind?.rawValue ?? "desktop action") result has an invalid \(key)."
        )
      }
      return value
    }
    func requireObject(_ object: [String: CanvastJSONValue], _ key: String) throws -> [String: CanvastJSONValue] {
      guard case .object(let value)? = object[key] else {
        throw CanvastDesktopActionValidationError.invalidArgument(
          "Successful \(kind?.rawValue ?? "desktop action") result has an invalid \(key)."
        )
      }
      return value
    }
    func requireNonnegativeInteger(
      _ object: [String: CanvastJSONValue], _ key: String
    ) throws -> Int {
      guard case .number(let value)? = object[key], value.isFinite, value >= 0,
            value.rounded() == value, value <= Double(Int.max) else {
        throw CanvastDesktopActionValidationError.invalidArgument(
          "Successful \(kind?.rawValue ?? "desktop action") result has an invalid \(key)."
        )
      }
      return Int(value)
    }
    func requireBoolean(_ key: String) throws -> Bool {
      guard case .boolean(let value)? = result[key] else {
        throw CanvastDesktopActionValidationError.invalidArgument(
          "Successful \(kind?.rawValue ?? "desktop action") result requires \(key)."
        )
      }
      return value
    }
    func requireBoolean(_ object: [String: CanvastJSONValue], _ key: String) throws -> Bool {
      guard case .boolean(let value)? = object[key] else {
        throw CanvastDesktopActionValidationError.invalidArgument(
          "Successful \(kind?.rawValue ?? "desktop action") result has an invalid \(key)."
        )
      }
      return value
    }
    func requireResumeSnapshot() throws -> ([String: CanvastJSONValue], Int) {
      let snapshot = try requireObject("snapshot")
      return (snapshot, try requireNonnegativeInteger(snapshot, "revision"))
    }
    func requireSandboxGrant(_ grant: [String: CanvastJSONValue]) throws -> String {
      let id = try requireString(grant, "id")
      let scope = try requireString(grant, "scope")
      let grantKind = try requireString(grant, "kind")
      _ = try requireString(grant, "value")
      guard scope == "session" || scope == "project" else {
        throw CanvastDesktopActionValidationError.invalidArgument(
          "Successful sandbox result contains an invalid grant scope."
        )
      }
      guard ["command", "write_path", "read_path", "profile"].contains(grantKind) else {
        throw CanvastDesktopActionValidationError.invalidArgument(
          "Successful sandbox result contains an invalid grant kind."
        )
      }
      return id
    }
    func requireSandboxGrantSnapshot() throws -> (revision: Int, grantIDs: Set<String>) {
      guard case .number(2)? = result["version"] else {
        throw CanvastDesktopActionValidationError.invalidArgument(
          "Successful sandbox result requires grant-store version 2."
        )
      }
      let revision = try requireNonnegativeInteger(result, "revision")
      guard case .array(let grants)? = result["grants"] else {
        throw CanvastDesktopActionValidationError.invalidArgument(
          "Successful sandbox result requires a grants snapshot."
        )
      }
      var grantIDs = Set<String>()
      for value in grants {
        guard case .object(let grant) = value else {
          throw CanvastDesktopActionValidationError.invalidArgument(
            "Successful sandbox result contains an invalid grant."
          )
        }
        guard grantIDs.insert(try requireSandboxGrant(grant)).inserted else {
          throw CanvastDesktopActionValidationError.invalidArgument(
            "Successful sandbox result contains duplicate grant IDs."
          )
        }
      }
      return (revision, grantIDs)
    }
    switch kind {
    case .newSession:
      _ = try requireString("sessionPath")
      _ = try requireString("sessionId")
    case .sessionCatalog:
      _ = try requireString("cwd")
      _ = try requireString("sessionDir")
    case .sessionOpen:
      _ = try requireString("sessionPath")
      _ = try requireString("activeSessionPath")
    case .sessionRename:
      _ = try requireString("sessionPath")
      _ = try requireString("name")
    case .sessionDelete:
      _ = try requireString("message")
      guard try requireString("receiptType") == "session-trash" else {
        throw CanvastDesktopActionValidationError.invalidArgument("Session delete receiptType is invalid.")
      }
      _ = try requireString("sessionId")
      _ = try requireString("sessionPath")
      _ = try requireString("trashedSessionPath")
      _ = try requireString("trashRoot")
      _ = try requireString("deletedAt")
    case .sessionTranscript:
      _ = try requireString("sessionPath")
      _ = try requireString("sessionId")
    case .projectPreflight:
      _ = try requireString("message")
      guard try requireString("receiptType") == "project-preflight" else {
        throw CanvastDesktopActionValidationError.invalidArgument("Project preflight receiptType is invalid.")
      }
      let operation = try requireString("operation")
      guard ["create", "open", "reinitialize", "retire"].contains(operation) else {
        throw CanvastDesktopActionValidationError.invalidArgument("Project preflight operation is invalid.")
      }
      _ = try requireString("currentProjectRoot")
      _ = try requireString("workspaceRoot")
      _ = try requireString("revision")
      _ = try requireBoolean("requiresApproval")
      _ = try requireBoolean("canProceed")
      _ = try requireBoolean("canProceedWithApproval")
      let current = try requireObject("current")
      let target = try requireObject("target")
      let currentCounts = try requireObject(current, "counts")
      let currentPaths = try requireObject(current, "paths")
      _ = try requireString(current, "head")
      _ = try requireBoolean(current, "available")
      _ = try requireBoolean(current, "repositoryPresent")
      _ = try requireBoolean(current, "hasChanges")
      _ = try requireNonnegativeInteger(currentCounts, "tracked")
      _ = try requireNonnegativeInteger(currentCounts, "untracked")
      _ = try requireNonnegativeInteger(currentCounts, "conflicts")
      guard case .array? = currentPaths["tracked"],
            case .array? = currentPaths["untracked"],
            case .array? = currentPaths["conflicts"] else {
        throw CanvastDesktopActionValidationError.invalidArgument("Project preflight current paths are invalid.")
      }
      _ = try requireString(target, "inputPath")
      _ = try requireString(target, "resolvedPath")
      _ = try requireString(target, "canonicalPath")
      _ = try requireString(target, "workspaceRoot")
      _ = try requireBoolean(target, "exists")
      _ = try requireBoolean(target, "isDirectory")
      _ = try requireBoolean(target, "withinWorkspace")
      _ = try requireBoolean(target, "containsSymlink")
      _ = try requireNonnegativeInteger(target, "entryCount")
      let targetGit = try requireObject(target, "git")
      let targetCounts = try requireObject(targetGit, "counts")
      let targetPaths = try requireObject(targetGit, "paths")
      _ = try requireString(targetGit, "head")
      _ = try requireBoolean(targetGit, "available")
      _ = try requireBoolean(targetGit, "repositoryPresent")
      _ = try requireBoolean(targetGit, "hasChanges")
      _ = try requireNonnegativeInteger(targetCounts, "tracked")
      _ = try requireNonnegativeInteger(targetCounts, "untracked")
      _ = try requireNonnegativeInteger(targetCounts, "conflicts")
      guard case .array? = targetPaths["tracked"],
            case .array? = targetPaths["untracked"],
            case .array? = targetPaths["conflicts"] else {
        throw CanvastDesktopActionValidationError.invalidArgument("Project preflight target git paths are invalid.")
      }
      guard case .array(let issues)? = result["issues"] else {
        throw CanvastDesktopActionValidationError.invalidArgument("Project preflight issues are invalid.")
      }
      for issue in issues {
        guard case .object(let item) = issue else {
          throw CanvastDesktopActionValidationError.invalidArgument("Project preflight issue is invalid.")
        }
        _ = try requireString(item, "code")
        let scope = try requireString(item, "scope")
        guard ["workspace", "current", "target", "operation"].contains(scope) else {
          throw CanvastDesktopActionValidationError.invalidArgument("Project preflight issue scope is invalid.")
        }
        _ = try requireString(item, "message")
      }
    case .projectCreate, .projectOpen, .projectReinitialize, .projectDelete:
      _ = try requireString("message")
      guard try requireString("receiptType") == "project-lifecycle" else {
        throw CanvastDesktopActionValidationError.invalidArgument("Project lifecycle receiptType is invalid.")
      }
      let actionKind = try requireString("actionKind")
      guard actionKind == kind?.rawValue else {
        throw CanvastDesktopActionValidationError.invalidArgument("Project lifecycle actionKind is invalid.")
      }
      let operation = try requireString("operation")
      guard ["create", "open", "reinitialize", "retire"].contains(operation) else {
        throw CanvastDesktopActionValidationError.invalidArgument("Project lifecycle operation is invalid.")
      }
      _ = try requireString("inputPath")
      _ = try requireString("currentProjectRoot")
      _ = try requireString("workspaceRoot")
      _ = try requireString("targetProjectRoot")
      _ = try requireString("preflightRevision")
      _ = try requireString("activeProjectRoot")
      if kind == .projectCreate {
        guard case .boolean(true)? = result["created"] else {
          throw CanvastDesktopActionValidationError.invalidArgument("project.create must confirm created=true.")
        }
      }
      if kind == .projectReinitialize {
        guard case .boolean(true)? = result["reinitialized"] else {
          throw CanvastDesktopActionValidationError.invalidArgument("project.reinitialize must confirm reinitialized=true.")
        }
        _ = try requireString("preservedStatePath")
      }
      if kind == .projectDelete {
        guard case .boolean(true)? = result["retired"] else {
          throw CanvastDesktopActionValidationError.invalidArgument("project.delete must confirm retired=true.")
        }
        _ = try requireString("retiredStatePath")
      }
    case .requestControl:
      let policy = try requireString("policy")
      guard CanvastRuntimeRequestControlPolicy(rawValue: policy) != nil else {
        throw CanvastDesktopActionValidationError.invalidArgument("Result contains unsupported request-control policy: \(policy).")
      }
      _ = try requireString("runtimeRequestId")
      _ = try requireString("queueStatus")
    case .inspectResume, .chooseResume, .rebindResume, .retireResume:
      _ = try requireResumeSnapshot()
      _ = try requireObject("candidate")
    case .claimResume:
      _ = try requireString("candidateId")
      _ = try requireString("requestId")
      _ = try requireString("claimToken")
      _ = try requireString("dispatchId")
      _ = try requireString("continuationReceiptState")
      guard try requireBoolean("accepted"), try requireBoolean("dispatched") else {
        throw CanvastDesktopActionValidationError.invalidArgument("Successful resume.claim result must be accepted and dispatched.")
      }
      let (_, snapshotRevision) = try requireResumeSnapshot()
      let resultRevision = try requireNonnegativeInteger(result, "revision")
      guard resultRevision == snapshotRevision else {
        throw CanvastDesktopActionValidationError.invalidArgument("resume.claim result revision must match snapshot revision.")
      }
    case .reconcileResume:
      _ = try requireResumeSnapshot()
    case .selectCanvasTask:
      _ = try requireString("nodeId")
      _ = try requireString("currentTaskId")
      _ = try requireString("nodeType")
    case .selectCanvasPlan:
      _ = try requireString("planId")
      _ = try requireString("activePlanId")
      _ = try requireString("nodeType")
    case .updatePlan:
      _ = try requireString("planId")
      let status = try requireString("status")
      guard status == "in_progress" || status == "completed" else {
        throw CanvastDesktopActionValidationError.invalidArgument("Plan update result contains an unsupported canonical status: \(status).")
      }
    case .exportCanvas:
      _ = try requireString("message")
      guard try requireString("receiptType") == "canvas-export" else {
        throw CanvastDesktopActionValidationError.invalidArgument("Canvas export receiptType is invalid.")
      }
      let outputDirectory = try requireString("outputDirectory")
      let prefix = "canvas-exports/"
      guard outputDirectory.hasPrefix(prefix),
            isSafeCanvasExportName(String(outputDirectory.dropFirst(prefix.count))) else {
        throw CanvastDesktopActionValidationError.invalidArgument("Canvas export outputDirectory is unsafe.")
      }
      _ = try requireNonnegativeInteger(result, "nodeCount")
      _ = try requireNonnegativeInteger(result, "edgeCount")
      guard case .array(let values)? = result["files"], values.count == 5 else {
        throw CanvastDesktopActionValidationError.invalidArgument("Canvas export receipt requires five files.")
      }
      let expected = [
        ("json", "canvas-graph-export.json"),
        ("markdown", "canvas-report.md"),
        ("mermaid", "canvas-graph.mmd"),
        ("svg", "canvas-graph.svg"),
        ("html", "canvas-graph.html"),
      ]
      for (value, expectedFile) in zip(values, expected) {
        guard case .object(let file) = value,
              try requireString(file, "format") == expectedFile.0,
              try requireString(file, "name") == expectedFile.1,
              isLowercaseSHA256(try requireString(file, "sha256")) else {
          throw CanvastDesktopActionValidationError.invalidArgument("Canvas export file receipt is invalid.")
        }
        _ = try requireNonnegativeInteger(file, "bytes")
      }
    case .cancelCanvasExport:
      _ = try requireString("message")
      _ = try requireString("targetRequestId")
      guard case .boolean(true)? = result["cancelled"] else {
        throw CanvastDesktopActionValidationError.invalidArgument("Canvas export cancellation receipt is invalid.")
      }
    case .inspectProjectScope, .rebindProjectScope:
      _ = try requireString("currentProjectRoot")
      _ = try requireString("relation")
      guard case .object(let state)? = result["state"], case .string(let persistedRoot)? = state["projectRoot"],
            !persistedRoot.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        throw CanvastDesktopActionValidationError.invalidArgument("Successful project scope result requires state.projectRoot.")
      }
    case .inspectSandbox:
      _ = try requireSandboxGrantSnapshot()
    case .revokeSandboxAccess:
      _ = try requireString("message")
      let snapshot = try requireSandboxGrantSnapshot()
      guard case .boolean(true)? = result["futureOperationsOnly"] else {
        throw CanvastDesktopActionValidationError.invalidArgument(
          "Successful sandbox.revoke result must declare futureOperationsOnly=true."
        )
      }
      let removedGrant = try requireObject("removedGrant")
      let removedGrantID = try requireSandboxGrant(removedGrant)
      guard !snapshot.grantIDs.contains(removedGrantID) else {
        throw CanvastDesktopActionValidationError.invalidArgument(
          "Successful sandbox.revoke result still contains the removed grant."
        )
      }
      guard snapshot.revision > 0 else {
        throw CanvastDesktopActionValidationError.invalidArgument(
          "Successful sandbox.revoke result must advance the revision."
        )
      }
    default:
      break
    }
  }
}

