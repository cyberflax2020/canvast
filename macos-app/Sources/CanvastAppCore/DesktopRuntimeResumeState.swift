import Foundation

public struct CanvastRuntimeResumeBinding: Codable, Equatable {
  public let planNodeID: String?
  public let taskNodeID: String?
  public let updatedAt: String
  public let source: String

  public init(planNodeID: String?, taskNodeID: String?, updatedAt: String, source: String) {
    self.planNodeID = planNodeID
    self.taskNodeID = taskNodeID
    self.updatedAt = updatedAt
    self.source = source
  }
}

public struct CanvastRuntimeResumeClaim: Codable, Equatable {
  public let claimToken: String
  public let sessionID: String
  public let state: String
  public let claimedAt: String
  public let updatedAt: String

  public init(claimToken: String, sessionID: String, state: String, claimedAt: String, updatedAt: String) {
    self.claimToken = claimToken
    self.sessionID = sessionID
    self.state = state
    self.claimedAt = claimedAt
    self.updatedAt = updatedAt
  }
}

public struct CanvastRuntimeResumeValidation: Codable, Equatable {
  public let availability: String
  public let freshness: String
  public let issues: [String]
  public let projectMatched: Bool
  public let hasBlockingActiveRun: Bool
  public let missingPlanNode: Bool
  public let missingTaskNode: Bool
  public let parentLinkValid: Bool

  public init(
    availability: String,
    freshness: String,
    issues: [String],
    projectMatched: Bool,
    hasBlockingActiveRun: Bool,
    missingPlanNode: Bool,
    missingTaskNode: Bool,
    parentLinkValid: Bool
  ) {
    self.availability = availability
    self.freshness = freshness
    self.issues = issues
    self.projectMatched = projectMatched
    self.hasBlockingActiveRun = hasBlockingActiveRun
    self.missingPlanNode = missingPlanNode
    self.missingTaskNode = missingTaskNode
    self.parentLinkValid = parentLinkValid
  }
}

public struct CanvastRuntimeResumeCandidate: Codable, Equatable, Identifiable {
  public let id: String
  public let projectID: String
  public let requestID: String
  public let title: String
  public let summary: String
  public let createdAt: String
  public let updatedAt: String
  public let lastActiveAt: String
  public let sessionID: String?
  public let turnID: String?
  public let continuationOwner: String?
  public let continuityPhase: String?
  public let operationID: String?
  public let disposition: String
  public let binding: CanvastRuntimeResumeBinding?
  public let claim: CanvastRuntimeResumeClaim?
  public let validation: CanvastRuntimeResumeValidation
  public let availableActions: [String]
  public let retiredReason: String?
  public let completedAt: String?

  public init(
    id: String,
    projectID: String,
    requestID: String,
    title: String,
    summary: String,
    createdAt: String,
    updatedAt: String,
    lastActiveAt: String,
    sessionID: String?,
    turnID: String?,
    continuationOwner: String?,
    continuityPhase: String?,
    operationID: String?,
    disposition: String,
    binding: CanvastRuntimeResumeBinding?,
    claim: CanvastRuntimeResumeClaim?,
    validation: CanvastRuntimeResumeValidation,
    availableActions: [String],
    retiredReason: String?,
    completedAt: String?
  ) {
    self.id = id
    self.projectID = projectID
    self.requestID = requestID
    self.title = title
    self.summary = summary
    self.createdAt = createdAt
    self.updatedAt = updatedAt
    self.lastActiveAt = lastActiveAt
    self.sessionID = sessionID
    self.turnID = turnID
    self.continuationOwner = continuationOwner
    self.continuityPhase = continuityPhase
    self.operationID = operationID
    self.disposition = disposition
    self.binding = binding
    self.claim = claim
    self.validation = validation
    self.availableActions = availableActions
    self.retiredReason = retiredReason
    self.completedAt = completedAt
  }
}

public struct CanvastRuntimeResumeSnapshot: Codable, Equatable {
  public let revision: Int
  public let state: String
  public let updatedAt: String
  public let projectID: String?
  public let selectedCandidateID: String?
  public let claimedCandidateID: String?
  public let readyCandidateCount: Int
  public let candidates: [CanvastRuntimeResumeCandidate]

  public init(
    revision: Int,
    state: String,
    updatedAt: String,
    projectID: String?,
    selectedCandidateID: String?,
    claimedCandidateID: String?,
    readyCandidateCount: Int,
    candidates: [CanvastRuntimeResumeCandidate]
  ) {
    self.revision = revision
    self.state = state
    self.updatedAt = updatedAt
    self.projectID = projectID
    self.selectedCandidateID = selectedCandidateID
    self.claimedCandidateID = claimedCandidateID
    self.readyCandidateCount = readyCandidateCount
    self.candidates = candidates
  }

  public static let empty = CanvastRuntimeResumeSnapshot(
    revision: 0,
    state: "idle",
    updatedAt: "",
    projectID: nil,
    selectedCandidateID: nil,
    claimedCandidateID: nil,
    readyCandidateCount: 0,
    candidates: []
  )
}
