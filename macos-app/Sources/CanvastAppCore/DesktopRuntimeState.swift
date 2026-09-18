import Foundation

public struct CanvastGraphNode: Codable, Equatable, Identifiable {
  public let id: String
  public let type: String
  public let label: String
  public let properties: [String: String]
}

public struct CanvastGraphEdge: Codable, Equatable, Identifiable {
  public let id: String
  public let type: String
  public let fromNodeID: String
  public let toNodeID: String
}

public struct CanvastRuntimePermissionState: Codable, Equatable {
  public let mode: String
  public let source: String
  public let unattended: Bool
  public let updatedAt: String

  public static let empty = CanvastRuntimePermissionState(mode: "ask", source: "default", unattended: false, updatedAt: "")
}

public struct CanvastRuntimeInput: Codable, Equatable, Identifiable {
  public let id: String
  public let timestamp: String?
  public let policy: String
  public let status: String
  public let textSummary: String
  public let source: String?
  public let affectsActiveWork: Bool
  public let requestID: String?
  public let deliveryMode: String?
  public let deliveredAt: String?
  public let answeredAt: String?
  public let hasVisibleReply: Bool?
  public let failureReason: String?

  public init(
    id: String, timestamp: String? = nil, policy: String, status: String,
    textSummary: String, source: String? = nil, affectsActiveWork: Bool,
    requestID: String? = nil, deliveryMode: String? = nil, deliveredAt: String? = nil,
    answeredAt: String? = nil, hasVisibleReply: Bool? = nil, failureReason: String? = nil
  ) {
    self.id = id
    self.timestamp = timestamp
    self.policy = policy
    self.status = status
    self.textSummary = textSummary
    self.source = source
    self.affectsActiveWork = affectsActiveWork
    self.requestID = requestID
    self.deliveryMode = deliveryMode
    self.deliveredAt = deliveredAt
    self.answeredAt = answeredAt
    self.hasVisibleReply = hasVisibleReply
    self.failureReason = failureReason
  }
}

public struct CanvastRuntimeRequest: Codable, Equatable, Identifiable {
  public var id: String { requestID }
  public let requestID: String
  public let parentRequestID: String?
  public let kind: String
  public let status: String
  public let textSummary: String
  public let hasVisibleReply: Bool
  public let createdAt: String?
  public let deliveredAt: String?
  public let answeredAt: String?
  public let updatedAt: String?
  public let deliveryMode: String?
  public let failureReason: String?

  public init(
    requestID: String, parentRequestID: String? = nil, kind: String, status: String,
    textSummary: String, hasVisibleReply: Bool, createdAt: String? = nil,
    deliveredAt: String? = nil, answeredAt: String? = nil, updatedAt: String? = nil,
    deliveryMode: String? = nil, failureReason: String? = nil
  ) {
    self.requestID = requestID
    self.parentRequestID = parentRequestID
    self.kind = kind
    self.status = status
    self.textSummary = textSummary
    self.hasVisibleReply = hasVisibleReply
    self.createdAt = createdAt
    self.deliveredAt = deliveredAt
    self.answeredAt = answeredAt
    self.updatedAt = updatedAt
    self.deliveryMode = deliveryMode
    self.failureReason = failureReason
  }
}

public struct CanvastRuntimeContinuity: Codable, Equatable {
  public let phase: String
  public let projectID: String?
  public let sessionID: String?
  public let turnID: String?
  public let requestID: String?
  public let recoverable: Bool
  public let recoveryMessage: String?
  public let updatedAt: String

  public static let empty = CanvastRuntimeContinuity(phase: "idle", projectID: nil, sessionID: nil, turnID: nil, requestID: nil, recoverable: false, recoveryMessage: nil, updatedAt: "")
}

public struct CanvastRuntimeEvent: Codable, Equatable, Identifiable {
  public let id: String
  public let timestamp: String
  public let kind: String
  public let title: String
  public let summary: String?
  public let source: String
  public let sidecarDispatch: CanvastSidecarDispatch?

  public init(
    id: String, timestamp: String, kind: String, title: String,
    summary: String? = nil, source: String, sidecarDispatch: CanvastSidecarDispatch? = nil
  ) {
    self.id = id
    self.timestamp = timestamp
    self.kind = kind
    self.title = title
    self.summary = summary
    self.source = source
    self.sidecarDispatch = sidecarDispatch
  }
}

public struct CanvastSidecarDispatch: Codable, Equatable {
  public let strategy: String
  public let tool: String
  public let reasonCodes: [String]
  public let explanation: String
  public let revision: Int
  public let executionState: String
  public let concurrencyScope: String
  public let primaryOverlap: Bool
  public let childRunIds: [String]
  public let failureCode: String?
  public let branches: [CanvastSidecarDispatchBranch]

  public init(
    strategy: String, tool: String, reasonCodes: [String], explanation: String, revision: Int,
    executionState: String, concurrencyScope: String, primaryOverlap: Bool,
    childRunIds: [String], failureCode: String? = nil, branches: [CanvastSidecarDispatchBranch] = []
  ) {
    self.strategy = strategy; self.tool = tool; self.reasonCodes = reasonCodes
    self.explanation = explanation; self.revision = revision; self.executionState = executionState
    self.concurrencyScope = concurrencyScope; self.primaryOverlap = primaryOverlap
    self.childRunIds = childRunIds; self.failureCode = failureCode
    self.branches = branches
  }
}

public struct CanvastSidecarDispatchBranch: Codable, Equatable, Identifiable {
  public let id: String
  public let selfContained: Bool
  public let primaryDependency: String
  public let dependsOnBranchIds: [String]
  public let writeTargets: [String]
  public let externalResourceKeys: [String]

  public init(
    id: String, selfContained: Bool, primaryDependency: String,
    dependsOnBranchIds: [String], writeTargets: [String], externalResourceKeys: [String]
  ) {
    self.id = id
    self.selfContained = selfContained
    self.primaryDependency = primaryDependency
    self.dependsOnBranchIds = dependsOnBranchIds
    self.writeTargets = writeTargets
    self.externalResourceKeys = externalResourceKeys
  }
}

public struct CanvastContextRecallRecord: Codable, Equatable, Identifiable {
  public let id: String
  public let kind: String
  public let source: String
  public let title: String
  public let summary: String
  public let timestamp: String
  public let sessionID: String?
  public let sessionFile: String?
}

public struct CanvastContextState: Codable, Equatable {
  public let updatedAt: String
  public let records: [CanvastContextRecallRecord]
  public let hotRecords: Int
  public let archiveRecords: Int
  public let directoryBytes: Int
  public let overBudget: Bool

  public static let empty = CanvastContextState(updatedAt: "", records: [], hotRecords: 0, archiveRecords: 0, directoryBytes: 0, overBudget: false)
}

public struct CanvastSessionSummary: Codable, Equatable, Identifiable {
  public let id: String
  public let file: String?
  public let latestActivityAt: String
  public let recallRecordCount: Int
  public let isActive: Bool
}

enum CanvastJSON {
  static func record(_ value: Any?) -> [String: Any] { value as? [String: Any] ?? [:] }
  static func records(_ value: Any?) -> [[String: Any]] { value as? [[String: Any]] ?? [] }
  static func string(_ value: Any?, _ fallback: String = "") -> String { value as? String ?? fallback }
  static func strings(_ value: Any?) -> [String] { value as? [String] ?? [] }
  static func bool(_ value: Any?) -> Bool { value as? Bool ?? false }
  static func integer(_ value: Any?) -> Int { (value as? NSNumber)?.intValue ?? 0 }
  static func optionalString(_ value: Any?) -> String? {
    let value = string(value)
    return value.isEmpty ? nil : value
  }
  static func flattenedProperties(_ value: Any?) -> [String: String] {
    record(value).reduce(into: [:]) { result, pair in
      if let value = pair.value as? String { result[pair.key] = value }
      else if let value = pair.value as? NSNumber { result[pair.key] = value.stringValue }
    }
  }
}
