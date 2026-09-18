import Foundation
import CryptoKit

public enum CanvastRuntimeMode: String, Codable, Equatable {
  case parity
  case enhanced
}

public struct CanvastGraphSummary: Codable, Equatable {
  public let nodes: Int
  public let edges: Int
  public let byType: [String: Int]
  public let nodeItems: [CanvastGraphNode]
  public let edgeItems: [CanvastGraphEdge]

  public init(nodes: Int, edges: Int, byType: [String: Int], nodeItems: [CanvastGraphNode] = [], edgeItems: [CanvastGraphEdge] = []) {
    self.nodes = nodes
    self.edges = edges
    self.byType = byType
    self.nodeItems = nodeItems
    self.edgeItems = edgeItems
  }

  public static let empty = CanvastGraphSummary(nodes: 0, edges: 0, byType: [:])
}

public struct CanvastClosureSummary: Codable, Equatable {
  public let required: Int
  public let closed: Int
  public let open: Int
  public let deliverable: Bool

  public init(required: Int, closed: Int, open: Int, deliverable: Bool) {
    self.required = required
    self.closed = closed
    self.open = open
    self.deliverable = deliverable
  }

  public static let empty = CanvastClosureSummary(required: 0, closed: 0, open: 0, deliverable: false)
}

public struct CanvastRuntimeLanguageState: Codable, Equatable {
  public let defaultLocale: String
  public let activeLocale: String
  public let source: String
  public let updatedAt: String

  public init(defaultLocale: String, activeLocale: String, source: String, updatedAt: String) {
    self.defaultLocale = defaultLocale
    self.activeLocale = activeLocale
    self.source = source
    self.updatedAt = updatedAt
  }

  public static let empty = CanvastRuntimeLanguageState(
    defaultLocale: "en",
    activeLocale: "en",
    source: "default",
    updatedAt: ""
  )
}

public struct CanvastRuntimeStatusItem: Codable, Equatable, Identifiable {
  public let id: String
  public let title: String
  public let status: String
  public let required: Bool?
  public let rootRequestID: String?
  public let summary: String?
  public let updatedAt: String
  public let startedAt: String?
  public let completedAt: String?
  public let elapsedMs: Double?
  public let sidecarDispatch: CanvastSidecarDispatch?

  public init(
    id: String,
    title: String,
    status: String,
    required: Bool? = nil,
    rootRequestID: String? = nil,
    summary: String? = nil,
    updatedAt: String,
    startedAt: String? = nil,
    completedAt: String? = nil,
    elapsedMs: Double? = nil,
    sidecarDispatch: CanvastSidecarDispatch? = nil
  ) {
    self.id = id
    self.title = title
    self.status = status
    self.required = required
    self.rootRequestID = rootRequestID
    self.summary = summary
    self.updatedAt = updatedAt
    self.startedAt = startedAt
    self.completedAt = completedAt
    self.elapsedMs = elapsedMs
    self.sidecarDispatch = sidecarDispatch
  }
}

public struct CanvastApprovalReview: Codable, Equatable, Identifiable {
  public let id: String
  public let timestamp: String
  public let tool: String
  public let decision: String
  public let risk: String
  public let authorization: String
  public let rationale: String
  public let inputSummary: String?
  public let categories: [String]?
  public let source: String

  public init(
    id: String,
    timestamp: String,
    tool: String,
    decision: String,
    risk: String,
    authorization: String,
    rationale: String,
    inputSummary: String? = nil,
    categories: [String]? = nil,
    source: String
  ) {
    self.id = id
    self.timestamp = timestamp
    self.tool = tool
    self.decision = decision
    self.risk = risk
    self.authorization = authorization
    self.rationale = rationale
    self.inputSummary = inputSummary
    self.categories = categories
    self.source = source
  }
}

public struct CanvastRuntimeModelState: Codable, Equatable {
  public let provider: String
  public let model: String
  public let thinkingLevel: String
  public let availableThinkingLevels: [String]
  public let modalities: [String]
  public let imageInput: String
  public let updatedAt: String

  public init(
    provider: String = "",
    model: String = "",
    thinkingLevel: String = "",
    availableThinkingLevels: [String] = [],
    modalities: [String] = [],
    imageInput: String = "unknown",
    updatedAt: String = ""
  ) {
    self.provider = provider
    self.model = model
    self.thinkingLevel = thinkingLevel
    self.availableThinkingLevels = availableThinkingLevels
    self.modalities = modalities
    self.imageInput = imageInput
    self.updatedAt = updatedAt
  }

  public static let empty = CanvastRuntimeModelState()
}

public struct CanvastRuntimeTokenState: Codable, Equatable {
  public let inputTokens: Double
  public let outputTokens: Double
  public let cacheReadTokens: Double
  public let cacheWriteTokens: Double
  public let totalTokens: Double
  public let effectiveTokens: Double
  public let contextWindowTokens: Double
  public let contextUsedTokens: Double
  public let contextRemainingTokens: Double
  public let contextUsageRatio: Double
  public let turnCount: Double
  public let toolCalls: Double
  public let costUsd: Double
  public let updatedAt: String

  public init(
    inputTokens: Double = 0,
    outputTokens: Double = 0,
    cacheReadTokens: Double = 0,
    cacheWriteTokens: Double = 0,
    totalTokens: Double = 0,
    effectiveTokens: Double = 0,
    contextWindowTokens: Double = 0,
    contextUsedTokens: Double = 0,
    contextRemainingTokens: Double = 0,
    contextUsageRatio: Double = 0,
    turnCount: Double = 0,
    toolCalls: Double = 0,
    costUsd: Double = 0,
    updatedAt: String = ""
  ) {
    self.inputTokens = inputTokens
    self.outputTokens = outputTokens
    self.cacheReadTokens = cacheReadTokens
    self.cacheWriteTokens = cacheWriteTokens
    self.totalTokens = totalTokens
    self.effectiveTokens = effectiveTokens
    self.contextWindowTokens = contextWindowTokens
    self.contextUsedTokens = contextUsedTokens
    self.contextRemainingTokens = contextRemainingTokens
    self.contextUsageRatio = contextUsageRatio
    self.turnCount = turnCount
    self.toolCalls = toolCalls
    self.costUsd = costUsd
    self.updatedAt = updatedAt
  }

  public static let empty = CanvastRuntimeTokenState()
}

public struct CanvastRuntimeAttachment: Codable, Equatable, Identifiable {
  public let id: String
  public let timestamp: String
  public let kind: String
  public let disposition: String
  public let placeholder: String
  public let summary: String
  public let sizeBytes: Double?
  public let mimeType: String?
  public let source: String

  public init(
    id: String,
    timestamp: String,
    kind: String,
    disposition: String,
    placeholder: String,
    summary: String,
    sizeBytes: Double? = nil,
    mimeType: String? = nil,
    source: String
  ) {
    self.id = id
    self.timestamp = timestamp
    self.kind = kind
    self.disposition = disposition
    self.placeholder = placeholder
    self.summary = summary
    self.sizeBytes = sizeBytes
    self.mimeType = mimeType
    self.source = source
  }
}

public enum CanvastRootExecutionState: String, Codable, Equatable {
  case idle
  case working
  case waiting
  case blocked
  case done
}

public struct CanvastRootExecution: Codable, Equatable {
  public let version: Int
  public let state: CanvastRootExecutionState
  public let reason: String
  public let rootRequestID: String?
  public let settledRequestID: String?
  public let settlement: String
  public let workingCount: Int
  public let waitingCount: Int
  public let blockedCount: Int
  public let updatedAt: String

  public init(
    version: Int = 1,
    state: CanvastRootExecutionState = .idle,
    reason: String = "not_started",
    rootRequestID: String? = nil,
    settledRequestID: String? = nil,
    settlement: String = "pending",
    workingCount: Int = 0,
    waitingCount: Int = 0,
    blockedCount: Int = 0,
    updatedAt: String = ""
  ) {
    self.version = version
    self.state = state
    self.reason = reason
    self.rootRequestID = rootRequestID
    self.settledRequestID = settledRequestID
    self.settlement = settlement
    self.workingCount = workingCount
    self.waitingCount = waitingCount
    self.blockedCount = blockedCount
    self.updatedAt = updatedAt
  }

  public static let empty = CanvastRootExecution()
}

public struct CanvastRuntimeStatusSummary: Codable, Equatable {
  public let updatedAt: String
  public let language: CanvastRuntimeLanguageState
  public let tasks: [CanvastRuntimeStatusItem]
  public let plans: [CanvastRuntimeStatusItem]
  public let subAgents: [CanvastRuntimeStatusItem]
  public let workflows: [CanvastRuntimeStatusItem]
  public let toolRuns: [CanvastRuntimeStatusItem]
  public let model: CanvastRuntimeModelState
  public let tokens: CanvastRuntimeTokenState
  public let attachments: [CanvastRuntimeAttachment]
  public let permission: CanvastRuntimePermissionState
  public let inputQueue: [CanvastRuntimeInput]
  public let requests: [CanvastRuntimeRequest]
  public let continuity: CanvastRuntimeContinuity
  public let resume: CanvastRuntimeResumeSnapshot
  public let rootExecution: CanvastRootExecution
  public let approvalReviews: [CanvastApprovalReview]
  public let events: [CanvastRuntimeEvent]

  public init(
    updatedAt: String,
    language: CanvastRuntimeLanguageState = .empty,
    tasks: [CanvastRuntimeStatusItem] = [],
    plans: [CanvastRuntimeStatusItem] = [],
    subAgents: [CanvastRuntimeStatusItem] = [],
    workflows: [CanvastRuntimeStatusItem] = [],
    toolRuns: [CanvastRuntimeStatusItem] = [],
    model: CanvastRuntimeModelState = .empty,
    tokens: CanvastRuntimeTokenState = .empty,
    attachments: [CanvastRuntimeAttachment] = [],
    permission: CanvastRuntimePermissionState = .empty,
    inputQueue: [CanvastRuntimeInput] = [],
    requests: [CanvastRuntimeRequest] = [],
    continuity: CanvastRuntimeContinuity = .empty,
    resume: CanvastRuntimeResumeSnapshot = .empty,
    rootExecution: CanvastRootExecution = .empty,
    approvalReviews: [CanvastApprovalReview] = [],
    events: [CanvastRuntimeEvent] = []
  ) {
    self.updatedAt = updatedAt
    self.language = language
    self.tasks = tasks
    self.plans = plans
    self.subAgents = subAgents
    self.workflows = workflows
    self.toolRuns = toolRuns
    self.model = model
    self.tokens = tokens
    self.attachments = attachments
    self.permission = permission
    self.inputQueue = inputQueue
    self.requests = requests
    self.continuity = continuity
    self.resume = resume
    self.rootExecution = rootExecution
    self.approvalReviews = approvalReviews
    self.events = events
  }

  public static let empty = CanvastRuntimeStatusSummary(updatedAt: "", language: .empty)

  public var openTaskCount: Int {
    tasks.filter { ["pending", "in_progress", "running", "blocked", "unknown"].contains($0.status) }.count
  }

  public var activeAgentCount: Int {
    subAgents.filter { ["in_progress", "running"].contains($0.status) }.count
  }

  public var activeWorkflowCount: Int {
    workflows.filter { ["in_progress", "running"].contains($0.status) }.count
  }

  public var latestApprovalReview: CanvastApprovalReview? {
    approvalReviews.last
  }
}

public struct CanvastProjectState: Equatable {
  public let projectRoot: URL
  public let runtimeMode: CanvastRuntimeMode
  public let graph: CanvastGraphSummary
  public let closure: CanvastClosureSummary
  public let runtimeStatus: CanvastRuntimeStatusSummary
  public let context: CanvastContextState
  public let sessions: [CanvastSessionSummary]
  public let features: [CanvastFeature]

  public init(
    projectRoot: URL,
    runtimeMode: CanvastRuntimeMode,
    graph: CanvastGraphSummary,
    closure: CanvastClosureSummary,
    runtimeStatus: CanvastRuntimeStatusSummary = .empty,
    context: CanvastContextState = .empty,
    sessions: [CanvastSessionSummary] = [],
    features: [CanvastFeature] = CanvastFeatureRegistry.all
  ) {
    self.projectRoot = projectRoot
    self.runtimeMode = runtimeMode
    self.graph = graph
    self.closure = closure
    self.runtimeStatus = runtimeStatus
    self.context = context
    self.sessions = sessions
    self.features = features
  }
}

public final class CanvastStateStore {
  private let fileManager: FileManager

  public init(fileManager: FileManager = .default) {
    self.fileManager = fileManager
  }

  public func load(projectRoot: URL, stateDirectory: URL? = nil) -> CanvastProjectState {
    let stateDir = stateDirectory ?? defaultStateDirectory(projectRoot: projectRoot)
    return CanvastProjectState(
      projectRoot: projectRoot,
      runtimeMode: loadMode(stateDirectory: stateDir),
      graph: loadGraph(stateDirectory: stateDir),
      closure: loadClosure(projectRoot: projectRoot),
      runtimeStatus: loadRuntimeStatus(stateDirectory: stateDir),
      context: loadContext(stateDirectory: stateDir),
      sessions: loadSessions(stateDirectory: stateDir)
    )
  }

  public func defaultStateDirectory(projectRoot: URL) -> URL {
    let home = fileManager.homeDirectoryForCurrentUser
    let projectKey = Self.projectKey(for: projectRoot)
    return home.appendingPathComponent(".canvast/projects/\(projectKey)/state", isDirectory: true)
  }

  public static func projectKey(for projectRoot: URL) -> String {
    let canonicalURL = projectRoot.standardizedFileURL.resolvingSymlinksInPath()
    let canonical = canonicalURL.path
    let rawBase = canonicalURL.lastPathComponent.isEmpty ? "project" : canonicalURL.lastPathComponent
    let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "._-"))
    let sanitizedScalars = rawBase.unicodeScalars.map { scalar in
      allowed.contains(scalar) ? Character(scalar) : "_"
    }
    let base = String(sanitizedScalars).prefix(48)
    let usableBase = base.isEmpty ? "project" : String(base)
    let digest = SHA256.hash(data: Data(canonical.utf8))
      .map { String(format: "%02x", $0) }
      .joined()
      .prefix(12)
    return "\(usableBase)-\(digest)"
  }

  public func loadMode(stateDirectory: URL) -> CanvastRuntimeMode {
    let file = stateDirectory.appendingPathComponent("canvast-mode.json")
    guard let data = try? Data(contentsOf: file),
          let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let mode = raw["mode"] as? String,
          let parsed = CanvastRuntimeMode(rawValue: mode) else {
      return .enhanced
    }
    return parsed
  }

  public func saveMode(
    projectRoot: URL,
    mode: CanvastRuntimeMode,
    stateDirectory: URL? = nil,
    reason: String = "User switched runtime mode from the macOS app."
  ) throws {
    let stateDir = stateDirectory ?? defaultStateDirectory(projectRoot: projectRoot)
    try fileManager.createDirectory(at: stateDir, withIntermediateDirectories: true)
    let current = loadModeRevision(stateDirectory: stateDir)
    let payload: [String: Any] = [
      "mode": mode.rawValue,
      "source": "command",
      "updatedAt": ISO8601DateFormatter().string(from: Date()),
      "revision": current + 1,
      "reason": reason
    ]
    let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
    try data.write(to: stateDir.appendingPathComponent("canvast-mode.json"), options: .atomic)
  }

  private func loadModeRevision(stateDirectory: URL) -> Int {
    let file = stateDirectory.appendingPathComponent("canvast-mode.json")
    guard let data = try? Data(contentsOf: file),
          let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let revision = raw["revision"] as? NSNumber else {
      return 0
    }
    return revision.intValue
  }

  public func loadGraph(stateDirectory: URL) -> CanvastGraphSummary {
    let file = stateDirectory.appendingPathComponent("canvas-graph.json")
    guard let data = try? Data(contentsOf: file),
          let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      return .empty
    }
    let nodes = CanvastJSON.records(raw["nodes"])
    let edges = CanvastJSON.records(raw["edges"])
    var byType: [String: Int] = [:]
    for node in nodes {
      let type = node["type"] as? String ?? "unknown"
      byType[type, default: 0] += 1
    }
    let nodeItems = nodes.map { node in
      let properties = CanvastJSON.flattenedProperties(node["properties"])
      let label = ["goal", "path", "chosen", "task", "content", "problem", "summary"]
        .compactMap { properties[$0] }.first ?? CanvastJSON.string(node["id"], "unknown")
      return CanvastGraphNode(id: CanvastJSON.string(node["id"], UUID().uuidString), type: CanvastJSON.string(node["type"], "unknown"), label: label, properties: properties)
    }
    let edgeItems = edges.enumerated().map { index, edge in
      CanvastGraphEdge(
        id: CanvastJSON.string(edge["id"], "edge-\(index)"),
        type: CanvastJSON.string(edge["type"], "unknown"),
        fromNodeID: CanvastJSON.string(edge["fromNodeId"]),
        toNodeID: CanvastJSON.string(edge["toNodeId"])
      )
    }
    return CanvastGraphSummary(nodes: nodes.count, edges: edges.count, byType: byType, nodeItems: nodeItems, edgeItems: edgeItems)
  }

  public func loadClosure(projectRoot: URL) -> CanvastClosureSummary {
    let file = projectRoot.appendingPathComponent("PRODUCT_CLOSURE_RECORD.json")
    guard let data = try? Data(contentsOf: file),
          let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let items = raw["items"] as? [[String: Any]] else {
      return .empty
    }
    let required = items.filter { ($0["required"] as? Bool) == true }
    let closed = required.filter { ($0["state"] as? String) == "closed" }
    return CanvastClosureSummary(
      required: required.count,
      closed: closed.count,
      open: required.count - closed.count,
      deliverable: !required.isEmpty && required.count == closed.count
    )
  }

  public func loadRuntimeStatus(stateDirectory: URL) -> CanvastRuntimeStatusSummary {
    let file = stateDirectory.appendingPathComponent("runtime-status.json")
    guard let data = try? Data(contentsOf: file),
          let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      return .empty
    }
    let languageRaw = raw["language"] as? [String: Any] ?? [:]
    let language = CanvastRuntimeLanguageState(
      defaultLocale: languageRaw["defaultLocale"] as? String ?? "en",
      activeLocale: languageRaw["activeLocale"] as? String ?? "en",
      source: languageRaw["source"] as? String ?? "default",
      updatedAt: languageRaw["updatedAt"] as? String ?? ""
    )
    return CanvastRuntimeStatusSummary(
      updatedAt: raw["updatedAt"] as? String ?? "",
      language: language,
      tasks: loadRuntimeItems(raw["tasks"]),
      plans: loadRuntimeItems(raw["plans"]),
      subAgents: loadRuntimeItems(raw["subAgents"]),
      workflows: loadRuntimeItems(raw["workflows"]),
      toolRuns: loadRuntimeItems(raw["toolRuns"]),
      model: loadRuntimeModel(raw["model"]),
      tokens: loadRuntimeTokens(raw["tokens"]),
      attachments: loadRuntimeAttachments(raw["attachments"]),
      permission: loadRuntimePermission(raw["permission"]),
      inputQueue: loadRuntimeInputs(raw["inputQueue"]),
      requests: loadRuntimeRequests(raw["requests"]),
      continuity: loadRuntimeContinuity(raw["continuity"]),
      resume: loadRuntimeResume(raw["resume"]),
      rootExecution: loadRootExecution(raw["rootExecution"]),
      approvalReviews: loadApprovalReviews(raw["approvalReviews"]),
      events: loadRuntimeEvents(raw["events"])
    )
  }

  public func loadContext(stateDirectory: URL) -> CanvastContextState {
    let file = stateDirectory.appendingPathComponent("context-recall/index.json")
    guard let data = try? Data(contentsOf: file),
          let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return .empty }
    let storage = CanvastJSON.record(raw["storage"])
    let records = CanvastJSON.records(raw["records"]).enumerated().map { index, row in
      let pointer = CanvastJSON.record(row["pointer"])
      return CanvastContextRecallRecord(
        id: CanvastJSON.string(row["id"], "recall-\(index)"), kind: CanvastJSON.string(row["kind"], "runtime"),
        source: CanvastJSON.string(row["source"], "runtime"), title: CanvastJSON.string(row["title"], "Recall record"),
        summary: CanvastJSON.string(row["summary"]), timestamp: CanvastJSON.string(row["timestamp"]),
        sessionID: CanvastJSON.optionalString(pointer["sessionId"]), sessionFile: CanvastJSON.optionalString(pointer["sessionFile"])
      )
    }
    return CanvastContextState(updatedAt: CanvastJSON.string(raw["updatedAt"]), records: records, hotRecords: CanvastJSON.integer(storage["hotRecords"]), archiveRecords: CanvastJSON.integer(storage["archiveRecords"]), directoryBytes: CanvastJSON.integer(storage["directoryBytes"]), overBudget: CanvastJSON.bool(storage["overBudget"]))
  }

  public func loadSessions(stateDirectory: URL) -> [CanvastSessionSummary] {
    let runtime = loadRuntimeStatus(stateDirectory: stateDirectory)
    let context = loadContext(stateDirectory: stateDirectory)
    var grouped: [String: [CanvastContextRecallRecord]] = [:]
    for record in context.records {
      if let id = record.sessionID { grouped[id, default: []].append(record) }
    }
    if let active = runtime.continuity.sessionID, grouped[active] == nil { grouped[active] = [] }
    return grouped.map { id, records in
      CanvastSessionSummary(id: id, file: records.compactMap(\.sessionFile).last, latestActivityAt: records.map(\.timestamp).max() ?? runtime.continuity.updatedAt, recallRecordCount: records.count, isActive: id == runtime.continuity.sessionID)
    }.sorted { $0.latestActivityAt > $1.latestActivityAt }
  }

  private func loadRuntimeItems(_ value: Any?) -> [CanvastRuntimeStatusItem] {
    let rows = value as? [[String: Any]] ?? []
    return rows.map { row in
      CanvastRuntimeStatusItem(
        id: row["id"] as? String ?? UUID().uuidString,
        title: row["title"] as? String ?? "Untitled",
        status: row["status"] as? String ?? "unknown",
        required: row["required"] as? Bool,
        rootRequestID: row["rootRequestId"] as? String,
        summary: row["summary"] as? String,
        updatedAt: row["updatedAt"] as? String ?? "",
        startedAt: row["startedAt"] as? String,
        completedAt: row["completedAt"] as? String,
        elapsedMs: optionalDouble(row["elapsedMs"]),
        sidecarDispatch: loadSidecarDispatch(row["sidecarDispatch"])
      )
    }
  }

  private func loadRuntimeModel(_ value: Any?) -> CanvastRuntimeModelState {
    let row = value as? [String: Any] ?? [:]
    return CanvastRuntimeModelState(
      provider: row["provider"] as? String ?? "",
      model: row["model"] as? String ?? "",
      thinkingLevel: row["thinkingLevel"] as? String ?? "",
      availableThinkingLevels: row["availableThinkingLevels"] as? [String] ?? [],
      modalities: row["modalities"] as? [String] ?? [],
      imageInput: row["imageInput"] as? String ?? "unknown",
      updatedAt: row["updatedAt"] as? String ?? ""
    )
  }

  private func loadRuntimeTokens(_ value: Any?) -> CanvastRuntimeTokenState {
    let row = value as? [String: Any] ?? [:]
    return CanvastRuntimeTokenState(
      inputTokens: double(row["inputTokens"]),
      outputTokens: double(row["outputTokens"]),
      cacheReadTokens: double(row["cacheReadTokens"]),
      cacheWriteTokens: double(row["cacheWriteTokens"]),
      totalTokens: double(row["totalTokens"]),
      effectiveTokens: double(row["effectiveTokens"]),
      contextWindowTokens: double(row["contextWindowTokens"]),
      contextUsedTokens: double(row["contextUsedTokens"]),
      contextRemainingTokens: double(row["contextRemainingTokens"]),
      contextUsageRatio: double(row["contextUsageRatio"]),
      turnCount: double(row["turnCount"]),
      toolCalls: double(row["toolCalls"]),
      costUsd: double(row["costUsd"]),
      updatedAt: row["updatedAt"] as? String ?? ""
    )
  }

  private func loadRuntimeAttachments(_ value: Any?) -> [CanvastRuntimeAttachment] {
    let rows = value as? [[String: Any]] ?? []
    return rows.map { row in
      CanvastRuntimeAttachment(
        id: row["id"] as? String ?? UUID().uuidString,
        timestamp: row["timestamp"] as? String ?? "",
        kind: row["kind"] as? String ?? "text",
        disposition: row["disposition"] as? String ?? "placeholder",
        placeholder: row["placeholder"] as? String ?? "",
        summary: row["summary"] as? String ?? "",
        sizeBytes: optionalDouble(row["sizeBytes"]),
        mimeType: row["mimeType"] as? String,
        source: row["source"] as? String ?? "runtime-status"
      )
    }
  }

  private func loadRuntimePermission(_ value: Any?) -> CanvastRuntimePermissionState {
    let row = CanvastJSON.record(value)
    return CanvastRuntimePermissionState(
      mode: CanvastJSON.string(row["mode"], "ask"), source: CanvastJSON.string(row["source"], "default"),
      unattended: CanvastJSON.bool(row["unattended"]), updatedAt: CanvastJSON.string(row["updatedAt"])
    )
  }

  private func loadRuntimeInputs(_ value: Any?) -> [CanvastRuntimeInput] {
    CanvastJSON.records(value).enumerated().map { index, row in
      CanvastRuntimeInput(
        id: CanvastJSON.string(row["id"], "input-\(index)"),
        timestamp: CanvastJSON.optionalString(row["timestamp"]),
        policy: CanvastJSON.string(row["policy"], "none"),
        status: CanvastJSON.string(row["status"], "queued"),
        textSummary: CanvastJSON.string(row["textSummary"], "Input"),
        source: CanvastJSON.optionalString(row["source"]),
        affectsActiveWork: CanvastJSON.bool(row["affectsActiveWork"]),
        requestID: CanvastJSON.optionalString(row["requestId"]),
        deliveryMode: CanvastJSON.optionalString(row["deliveryMode"]),
        deliveredAt: CanvastJSON.optionalString(row["deliveredAt"]),
        answeredAt: CanvastJSON.optionalString(row["answeredAt"]),
        hasVisibleReply: row["hasVisibleReply"] as? Bool,
        failureReason: CanvastJSON.optionalString(row["failureReason"])
      )
    }
  }

  private func loadRuntimeRequests(_ value: Any?) -> [CanvastRuntimeRequest] {
    CanvastJSON.records(value).enumerated().map { index, row in
      CanvastRuntimeRequest(
        requestID: CanvastJSON.string(row["requestId"], "request-\(index)"),
        parentRequestID: CanvastJSON.optionalString(row["parentRequestId"]),
        kind: CanvastJSON.string(row["kind"], "primary"),
        status: CanvastJSON.string(row["status"], "queued"),
        textSummary: CanvastJSON.string(row["textSummary"], "Request"),
        hasVisibleReply: CanvastJSON.bool(row["hasVisibleReply"]),
        createdAt: CanvastJSON.optionalString(row["createdAt"]),
        deliveredAt: CanvastJSON.optionalString(row["deliveredAt"]),
        answeredAt: CanvastJSON.optionalString(row["answeredAt"]),
        updatedAt: CanvastJSON.optionalString(row["updatedAt"]),
        deliveryMode: CanvastJSON.optionalString(row["deliveryMode"]),
        failureReason: CanvastJSON.optionalString(row["failureReason"])
      )
    }
  }

  private func loadRuntimeContinuity(_ value: Any?) -> CanvastRuntimeContinuity {
    let row = CanvastJSON.record(value)
    return CanvastRuntimeContinuity(
      phase: CanvastJSON.string(row["phase"], "idle"), projectID: CanvastJSON.optionalString(row["projectId"]),
      sessionID: CanvastJSON.optionalString(row["sessionId"]), turnID: CanvastJSON.optionalString(row["turnId"]),
      requestID: CanvastJSON.optionalString(row["requestId"]), recoverable: CanvastJSON.bool(row["recoverable"]),
      recoveryMessage: CanvastJSON.optionalString(row["recoveryMessage"]), updatedAt: CanvastJSON.string(row["updatedAt"])
    )
  }

  private func loadRuntimeResume(_ value: Any?) -> CanvastRuntimeResumeSnapshot {
    let row = CanvastJSON.record(value)
    let candidates = CanvastJSON.records(row["candidates"]).map { candidate in
      let bindingRow = CanvastJSON.record(candidate["binding"])
      let claimRow = CanvastJSON.record(candidate["claim"])
      let validationRow = CanvastJSON.record(candidate["validation"])
      let binding = bindingRow.isEmpty ? nil : CanvastRuntimeResumeBinding(
        planNodeID: CanvastJSON.optionalString(bindingRow["planNodeId"]),
        taskNodeID: CanvastJSON.optionalString(bindingRow["taskNodeId"]),
        updatedAt: CanvastJSON.string(bindingRow["updatedAt"]),
        source: CanvastJSON.string(bindingRow["source"])
      )
      let claim = claimRow.isEmpty ? nil : CanvastRuntimeResumeClaim(
        claimToken: CanvastJSON.string(claimRow["claimToken"]),
        sessionID: CanvastJSON.string(claimRow["sessionId"]),
        state: CanvastJSON.string(claimRow["state"]),
        claimedAt: CanvastJSON.string(claimRow["claimedAt"]),
        updatedAt: CanvastJSON.string(claimRow["updatedAt"])
      )
      let validation = CanvastRuntimeResumeValidation(
        availability: CanvastJSON.string(validationRow["availability"]),
        freshness: CanvastJSON.string(validationRow["freshness"]),
        issues: CanvastJSON.strings(validationRow["issues"]),
        projectMatched: CanvastJSON.bool(validationRow["projectMatched"]),
        hasBlockingActiveRun: CanvastJSON.bool(validationRow["hasBlockingActiveRun"]),
        missingPlanNode: CanvastJSON.bool(validationRow["missingPlanNode"]),
        missingTaskNode: CanvastJSON.bool(validationRow["missingTaskNode"]),
        parentLinkValid: CanvastJSON.bool(validationRow["parentLinkValid"])
      )
      return CanvastRuntimeResumeCandidate(
        id: CanvastJSON.string(candidate["id"]),
        projectID: CanvastJSON.string(candidate["projectId"]),
        requestID: CanvastJSON.string(candidate["requestId"]),
        title: CanvastJSON.string(candidate["title"]),
        summary: CanvastJSON.string(candidate["summary"]),
        createdAt: CanvastJSON.string(candidate["createdAt"]),
        updatedAt: CanvastJSON.string(candidate["updatedAt"]),
        lastActiveAt: CanvastJSON.string(candidate["lastActiveAt"]),
        sessionID: CanvastJSON.optionalString(candidate["sessionId"]),
        turnID: CanvastJSON.optionalString(candidate["turnId"]),
        continuationOwner: CanvastJSON.optionalString(candidate["continuationOwner"]),
        continuityPhase: CanvastJSON.optionalString(candidate["continuityPhase"]),
        operationID: CanvastJSON.optionalString(candidate["operationId"]),
        disposition: CanvastJSON.string(candidate["disposition"]),
        binding: binding,
        claim: claim,
        validation: validation,
        availableActions: CanvastJSON.strings(candidate["availableActions"]),
        retiredReason: CanvastJSON.optionalString(candidate["retiredReason"]),
        completedAt: CanvastJSON.optionalString(candidate["completedAt"])
      )
    }
    return CanvastRuntimeResumeSnapshot(
      revision: CanvastJSON.integer(row["revision"]),
      state: CanvastJSON.string(row["state"], "idle"),
      updatedAt: CanvastJSON.string(row["updatedAt"]),
      projectID: CanvastJSON.optionalString(row["projectId"]),
      selectedCandidateID: CanvastJSON.optionalString(row["selectedCandidateId"]),
      claimedCandidateID: CanvastJSON.optionalString(row["claimedCandidateId"]),
      readyCandidateCount: CanvastJSON.integer(row["readyCandidateCount"]),
      candidates: candidates
    )
  }

  private func loadRootExecution(_ value: Any?) -> CanvastRootExecution {
    let row = CanvastJSON.record(value)
    return CanvastRootExecution(
      version: CanvastJSON.integer(row["version"]),
      state: CanvastRootExecutionState(rawValue: CanvastJSON.string(row["state"])) ?? .idle,
      reason: CanvastJSON.string(row["reason"], "not_started"),
      rootRequestID: CanvastJSON.optionalString(row["rootRequestId"]),
      settledRequestID: CanvastJSON.optionalString(row["settledRequestId"]),
      settlement: CanvastJSON.string(row["settlement"], "pending"),
      workingCount: CanvastJSON.integer(row["workingCount"]),
      waitingCount: CanvastJSON.integer(row["waitingCount"]),
      blockedCount: CanvastJSON.integer(row["blockedCount"]),
      updatedAt: CanvastJSON.string(row["updatedAt"])
    )
  }

  private func loadRuntimeEvents(_ value: Any?) -> [CanvastRuntimeEvent] {
    CanvastJSON.records(value).enumerated().map { index, row in
      CanvastRuntimeEvent(
        id: CanvastJSON.string(row["id"], "event-\(index)"), timestamp: CanvastJSON.string(row["timestamp"]),
        kind: CanvastJSON.string(row["kind"], "event"), title: CanvastJSON.string(row["title"], "Runtime event"),
        summary: CanvastJSON.optionalString(row["summary"]), source: CanvastJSON.string(row["source"], "runtime-status"),
        sidecarDispatch: loadSidecarDispatch(row["sidecarDispatch"])
      )
    }
  }

  private func loadSidecarDispatch(_ value: Any?) -> CanvastSidecarDispatch? {
    guard let row = value as? [String: Any], let revision = row["revision"] as? NSNumber else { return nil }
    return CanvastSidecarDispatch(
      strategy: CanvastJSON.string(row["strategy"]), tool: CanvastJSON.string(row["tool"]),
      reasonCodes: row["reasonCodes"] as? [String] ?? [], explanation: CanvastJSON.string(row["explanation"]),
      revision: revision.intValue, executionState: CanvastJSON.string(row["executionState"]),
      concurrencyScope: CanvastJSON.string(row["concurrencyScope"]), primaryOverlap: row["primaryOverlap"] as? Bool ?? false,
      childRunIds: row["childRunIds"] as? [String] ?? [], failureCode: CanvastJSON.optionalString(row["failureCode"]),
      branches: CanvastJSON.records(row["branches"]).map { branch in
        CanvastSidecarDispatchBranch(
          id: CanvastJSON.string(branch["id"]), selfContained: branch["selfContained"] as? Bool ?? false,
          primaryDependency: CanvastJSON.string(branch["primaryDependency"]),
          dependsOnBranchIds: branch["dependsOnBranchIds"] as? [String] ?? [],
          writeTargets: branch["writeTargets"] as? [String] ?? [],
          externalResourceKeys: branch["externalResourceKeys"] as? [String] ?? []
        )
      }
    )
  }

  private func loadApprovalReviews(_ value: Any?) -> [CanvastApprovalReview] {
    let rows = value as? [[String: Any]] ?? []
    return rows.map { row in
      CanvastApprovalReview(
        id: row["id"] as? String ?? UUID().uuidString,
        timestamp: row["timestamp"] as? String ?? "",
        tool: row["tool"] as? String ?? "unknown",
        decision: row["decision"] as? String ?? "needs_user",
        risk: row["risk"] as? String ?? "medium",
        authorization: row["authorization"] as? String ?? "none",
        rationale: row["rationale"] as? String ?? "No rationale recorded.",
        inputSummary: row["inputSummary"] as? String,
        categories: row["categories"] as? [String],
        source: row["source"] as? String ?? "runtime-status"
      )
    }
  }

  private func double(_ value: Any?) -> Double {
    if let number = value as? NSNumber {
      return number.doubleValue
    }
    if let string = value as? String, let parsed = Double(string) {
      return parsed
    }
    return 0
  }

  private func optionalDouble(_ value: Any?) -> Double? {
    if value == nil {
      return nil
    }
    return double(value)
  }
}
