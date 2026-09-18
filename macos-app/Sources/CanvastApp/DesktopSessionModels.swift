import Foundation
import CanvastAppCore

struct DesktopSessionCatalogItem: Identifiable, Equatable {
  let id: String
  let path: String
  let cwd: String
  let name: String
  let createdAt: String
  let modifiedAt: String
  let messageCount: Int
  let firstMessage: String?
  let allMessagesText: String?
  let parentSessionPath: String
  let isActive: Bool
}

struct DesktopSessionCatalog: Equatable {
  let cwd: String
  let sessionDirectory: String
  let activeSessionPath: String
  let activeSessionID: String
  let activeSessionName: String
  let sessions: [DesktopSessionCatalogItem]
  let message: String

  var activeSession: DesktopSessionCatalogItem? {
    sessions.first { $0.path == activeSessionPath || $0.id == activeSessionID }
  }
}

struct DesktopSessionTranscriptEntry: Identifiable, Equatable {
  let id: String
  let type: String
  let role: String?
  let timestamp: String
  let parentID: String?
  let text: String
}

struct DesktopSessionTranscript: Equatable {
  let sessionPath: String
  let sessionID: String
  let sessionName: String
  let entryCount: Int
  let transcript: String
  let entries: [DesktopSessionTranscriptEntry]
  let message: String
}

struct DesktopLiveSessionMessage: Identifiable, Equatable {
  enum Role: String, Equatable {
    case user
    case assistant
    case process
  }

  let id: String
  let requestID: String
  let sessionPath: String?
  let role: Role
  let eventType: String
  var timestamp: String
  var text: String
  var isStreaming: Bool
}

struct DesktopSessionOpenResult: Equatable {
  let sessionPath: String
  let previousSessionPath: String
  let activeSessionPath: String
  let activeSessionID: String
  let activeSessionName: String
  let message: String
}

struct DesktopSessionRenameResult: Equatable {
  let sessionPath: String
  let sessionID: String
  let name: String
  let message: String
}

struct DesktopSessionDeleteReceipt: Equatable {
  let receiptType: String
  let sessionID: String
  let sessionName: String
  let sessionPath: String
  let trashedSessionPath: String
  let trashRoot: String
  let deletedAt: String
  let message: String
}

struct DesktopSessionCreationResult: Equatable {
  let sessionPath: String
  let sessionID: String
  let sessionName: String
  let message: String
}

struct DesktopGitPreflightCounts: Equatable {
  let tracked: Int
  let untracked: Int
  let conflicts: Int
}

struct DesktopGitPreflightPaths: Equatable {
  let tracked: [String]
  let untracked: [String]
  let conflicts: [String]
}

struct DesktopGitPreflightState: Equatable {
  let available: Bool
  let repositoryPresent: Bool
  let head: String
  let hasChanges: Bool
  let counts: DesktopGitPreflightCounts
  let paths: DesktopGitPreflightPaths
  let errorCode: String?
  let errorMessage: String?
}

struct DesktopProjectTargetInspection: Equatable {
  let inputPath: String
  let resolvedPath: String
  let canonicalPath: String
  let workspaceRoot: String
  let exists: Bool
  let isDirectory: Bool
  let entryCount: Int
  let withinWorkspace: Bool
  let containsSymlink: Bool
  let git: DesktopGitPreflightState
}

struct DesktopProjectPreflightIssue: Identifiable, Equatable {
  let code: String
  let scope: String
  let message: String

  var id: String { "\(scope):\(code):\(message)" }
}

struct DesktopProjectPreflightReceipt: Equatable {
  let receiptType: String
  let operation: String
  let currentProjectRoot: String
  let workspaceRoot: String
  let current: DesktopGitPreflightState
  let target: DesktopProjectTargetInspection
  let replacement: DesktopProjectTargetInspection?
  let revision: String
  let requiresApproval: Bool
  let canProceed: Bool
  let canProceedWithApproval: Bool
  let issues: [DesktopProjectPreflightIssue]
  let message: String
}

struct DesktopProjectLifecycleReceipt: Equatable {
  let receiptType: String
  let actionKind: String
  let operation: String
  let inputPath: String
  let currentProjectRoot: String
  let workspaceRoot: String
  let targetProjectRoot: String
  let preflightRevision: String
  let activeProjectRoot: String
  let created: Bool?
  let reinitialized: Bool?
  let retired: Bool?
  let preservedStatePath: String?
  let retiredStatePath: String?
  let sessionPath: String?
  let sessionID: String?
  let message: String
}

struct DesktopResumeActionResult: Equatable {
  let snapshot: CanvastRuntimeResumeSnapshot
  let candidate: CanvastRuntimeResumeCandidate?
  let candidateID: String?
  let requestID: String?
  let claimToken: String?
  let dispatchID: String?
  let accepted: Bool?
  let dispatched: Bool?
  let revision: Int
  let continuationReceiptState: String?
  let continuityPhase: String?
  let message: String
}

struct DesktopRootStatusSummary: Equatable {
  let state: CanvastRootExecutionState
  let reason: String
  let rootRequestID: String?
  let settledRequestID: String?
  let settlement: String
  let workingCount: Int
  let waitingCount: Int
  let blockedCount: Int
  let updatedAt: String

  init(_ root: CanvastRootExecution) {
    self.state = root.state
    self.reason = root.reason
    self.rootRequestID = root.rootRequestID
    self.settledRequestID = root.settledRequestID
    self.settlement = root.settlement
    self.workingCount = root.workingCount
    self.waitingCount = root.waitingCount
    self.blockedCount = root.blockedCount
    self.updatedAt = root.updatedAt
  }

  var isDone: Bool {
    state == .done
      && settlement == "succeeded"
      && rootRequestID != nil
      && settledRequestID == rootRequestID
      && workingCount == 0
      && waitingCount == 0
      && blockedCount == 0
  }
}
