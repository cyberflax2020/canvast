import Foundation
import CanvastAppCore

@MainActor
extension CanvastDesktopModel {
  func decodeSessionCreationResult(
    _ result: [String: CanvastJSONValue], fallback: String
  ) -> DesktopSessionCreationResult? {
    guard let sessionPath = stringValue(result["sessionPath"]),
          let sessionID = stringValue(result["sessionId"]) else { return nil }
    return DesktopSessionCreationResult(
      sessionPath: sessionPath, sessionID: sessionID,
      sessionName: stringValue(result["sessionName"]) ?? "",
      message: stringValue(result["message"]) ?? fallback
    )
  }

  func decodeSessionCatalog(
    _ result: [String: CanvastJSONValue], fallback: String
  ) -> DesktopSessionCatalog? {
    guard let cwd = stringValue(result["cwd"]),
          let sessionDirectory = stringValue(result["sessionDir"]) else { return nil }
    let items: [DesktopSessionCatalogItem] = arrayValue(result["sessions"])?.compactMap(objectValue).compactMap { item in
      guard let path = stringValue(item["path"]), !path.isEmpty else { return nil }
      let sessionID = stringValue(item["id"])?.trimmingCharacters(in: .whitespacesAndNewlines)
      let stableID = sessionID.flatMap { $0.isEmpty ? nil : $0 } ?? path
      return DesktopSessionCatalogItem(
        id: stableID, path: path,
        cwd: stringValue(item["cwd"]) ?? "", name: stringValue(item["name"]) ?? "",
        createdAt: stringValue(item["createdAt"]) ?? "",
        modifiedAt: stringValue(item["modifiedAt"]) ?? "",
        messageCount: integerValue(item["messageCount"]) ?? 0,
        firstMessage: stringValue(item["firstMessage"]),
        allMessagesText: stringValue(item["allMessagesText"]),
        parentSessionPath: stringValue(item["parentSessionPath"]) ?? "",
        isActive: booleanValue(item["isActive"]) ?? false
      )
    } ?? []
    return DesktopSessionCatalog(
      cwd: cwd, sessionDirectory: sessionDirectory,
      activeSessionPath: stringValue(result["activeSessionPath"]) ?? "",
      activeSessionID: stringValue(result["activeSessionId"]) ?? "",
      activeSessionName: stringValue(result["activeSessionName"]) ?? "",
      sessions: items, message: stringValue(result["message"]) ?? fallback
    )
  }

  func decodeSessionOpenResult(
    _ result: [String: CanvastJSONValue], fallback: String
  ) -> DesktopSessionOpenResult? {
    guard let sessionPath = stringValue(result["sessionPath"]),
          let activeSessionPath = stringValue(result["activeSessionPath"]) else { return nil }
    return DesktopSessionOpenResult(
      sessionPath: sessionPath, previousSessionPath: stringValue(result["previousSessionPath"]) ?? "",
      activeSessionPath: activeSessionPath,
      activeSessionID: stringValue(result["activeSessionId"]) ?? "",
      activeSessionName: stringValue(result["activeSessionName"]) ?? "",
      message: stringValue(result["message"]) ?? fallback
    )
  }

  func decodeSessionRenameResult(
    _ result: [String: CanvastJSONValue], fallback: String
  ) -> DesktopSessionRenameResult? {
    guard let sessionPath = stringValue(result["sessionPath"]),
          let sessionID = stringValue(result["sessionId"]),
          let name = stringValue(result["name"]) else { return nil }
    return DesktopSessionRenameResult(
      sessionPath: sessionPath, sessionID: sessionID, name: name,
      message: stringValue(result["message"]) ?? fallback
    )
  }

  func decodeSessionDeleteReceipt(
    _ result: [String: CanvastJSONValue], fallback: String
  ) -> DesktopSessionDeleteReceipt? {
    guard let receiptType = stringValue(result["receiptType"]),
          let sessionPath = stringValue(result["sessionPath"]),
          let sessionID = stringValue(result["sessionId"]),
          let trashedSessionPath = stringValue(result["trashedSessionPath"]),
          let trashRoot = stringValue(result["trashRoot"]),
          let deletedAt = stringValue(result["deletedAt"]) else { return nil }
    return DesktopSessionDeleteReceipt(
      receiptType: receiptType,
      sessionID: sessionID,
      sessionName: stringValue(result["sessionName"]) ?? "",
      sessionPath: sessionPath,
      trashedSessionPath: trashedSessionPath,
      trashRoot: trashRoot,
      deletedAt: deletedAt,
      message: stringValue(result["message"]) ?? fallback
    )
  }

  func decodeSessionTranscript(
    _ result: [String: CanvastJSONValue], fallback: String
  ) -> DesktopSessionTranscript? {
    guard let sessionPath = stringValue(result["sessionPath"]),
          let sessionID = stringValue(result["sessionId"]) else { return nil }
    let entries = arrayValue(result["entries"])?.compactMap(objectValue).map { entry in
      DesktopSessionTranscriptEntry(
        id: stringValue(entry["id"]) ?? "", type: stringValue(entry["type"]) ?? "",
        role: stringValue(entry["role"]), timestamp: stringValue(entry["timestamp"]) ?? "",
        parentID: stringValue(entry["parentId"]), text: stringValue(entry["text"]) ?? ""
      )
    } ?? []
    return DesktopSessionTranscript(
      sessionPath: sessionPath, sessionID: sessionID,
      sessionName: stringValue(result["sessionName"]) ?? "",
      entryCount: integerValue(result["entryCount"]) ?? entries.count,
      transcript: stringValue(result["transcript"]) ?? "", entries: entries,
      message: stringValue(result["message"]) ?? fallback
    )
  }

  func decodeProjectPreflightReceipt(
    _ result: [String: CanvastJSONValue], fallback: String
  ) -> DesktopProjectPreflightReceipt? {
    guard let receiptType = stringValue(result["receiptType"]),
          let operation = stringValue(result["operation"]),
          let currentProjectRoot = stringValue(result["currentProjectRoot"]),
          let workspaceRoot = stringValue(result["workspaceRoot"]),
          let currentValue = objectValue(result["current"]),
          let current = decodeGitPreflightState(currentValue),
          let targetValue = objectValue(result["target"]),
          let target = decodeProjectTargetInspection(targetValue),
          let revision = stringValue(result["revision"]),
          let requiresApproval = booleanValue(result["requiresApproval"]),
          let canProceed = booleanValue(result["canProceed"]),
          let canProceedWithApproval = booleanValue(result["canProceedWithApproval"]) else { return nil }
    let issues: [DesktopProjectPreflightIssue] = arrayValue(result["issues"])?.compactMap(objectValue).compactMap { item -> DesktopProjectPreflightIssue? in
      guard let code = stringValue(item["code"]),
            let scope = stringValue(item["scope"]),
            let message = stringValue(item["message"]) else { return nil }
      return DesktopProjectPreflightIssue(code: code, scope: scope, message: message)
    } ?? []
    return DesktopProjectPreflightReceipt(
      receiptType: receiptType,
      operation: operation,
      currentProjectRoot: currentProjectRoot,
      workspaceRoot: workspaceRoot,
      current: current,
      target: target,
      replacement: objectValue(result["replacement"]).flatMap(decodeProjectTargetInspection),
      revision: revision,
      requiresApproval: requiresApproval,
      canProceed: canProceed,
      canProceedWithApproval: canProceedWithApproval,
      issues: issues,
      message: stringValue(result["message"]) ?? fallback
    )
  }

  func decodeProjectLifecycleReceipt(
    _ result: [String: CanvastJSONValue], fallback: String
  ) -> DesktopProjectLifecycleReceipt? {
    guard let receiptType = stringValue(result["receiptType"]),
          let actionKind = stringValue(result["actionKind"]),
          let operation = stringValue(result["operation"]),
          let inputPath = stringValue(result["inputPath"]),
          let currentProjectRoot = stringValue(result["currentProjectRoot"]),
          let workspaceRoot = stringValue(result["workspaceRoot"]),
          let targetProjectRoot = stringValue(result["targetProjectRoot"]),
          let preflightRevision = stringValue(result["preflightRevision"]),
          let activeProjectRoot = stringValue(result["activeProjectRoot"]) else { return nil }
    return DesktopProjectLifecycleReceipt(
      receiptType: receiptType,
      actionKind: actionKind,
      operation: operation,
      inputPath: inputPath,
      currentProjectRoot: currentProjectRoot,
      workspaceRoot: workspaceRoot,
      targetProjectRoot: targetProjectRoot,
      preflightRevision: preflightRevision,
      activeProjectRoot: activeProjectRoot,
      created: booleanValue(result["created"]),
      reinitialized: booleanValue(result["reinitialized"]),
      retired: booleanValue(result["retired"]),
      preservedStatePath: stringValue(result["preservedStatePath"]),
      retiredStatePath: stringValue(result["retiredStatePath"]),
      sessionPath: stringValue(result["sessionPath"]),
      sessionID: stringValue(result["sessionId"]),
      message: stringValue(result["message"]) ?? fallback
    )
  }

  func decodeGitPreflightState(_ value: [String: CanvastJSONValue]) -> DesktopGitPreflightState? {
    guard let available = booleanValue(value["available"]),
          let repositoryPresent = booleanValue(value["repositoryPresent"]),
          let head = stringValue(value["head"]),
          let hasChanges = booleanValue(value["hasChanges"]),
          let countsValue = objectValue(value["counts"]),
          let tracked = integerValue(countsValue["tracked"]),
          let untracked = integerValue(countsValue["untracked"]),
          let conflicts = integerValue(countsValue["conflicts"]),
          let pathsValue = objectValue(value["paths"]) else { return nil }
    return DesktopGitPreflightState(
      available: available,
      repositoryPresent: repositoryPresent,
      head: head,
      hasChanges: hasChanges,
      counts: DesktopGitPreflightCounts(
        tracked: tracked,
        untracked: untracked,
        conflicts: conflicts
      ),
      paths: DesktopGitPreflightPaths(
        tracked: stringsValue(pathsValue["tracked"]),
        untracked: stringsValue(pathsValue["untracked"]),
        conflicts: stringsValue(pathsValue["conflicts"])
      ),
      errorCode: stringValue(value["errorCode"]),
      errorMessage: stringValue(value["errorMessage"])
    )
  }

  func decodeProjectTargetInspection(
    _ value: [String: CanvastJSONValue]
  ) -> DesktopProjectTargetInspection? {
    guard let inputPath = stringValue(value["inputPath"]),
          let resolvedPath = stringValue(value["resolvedPath"]),
          let canonicalPath = stringValue(value["canonicalPath"]),
          let workspaceRoot = stringValue(value["workspaceRoot"]),
          let exists = booleanValue(value["exists"]),
          let isDirectory = booleanValue(value["isDirectory"]),
          let entryCount = integerValue(value["entryCount"]),
          let withinWorkspace = booleanValue(value["withinWorkspace"]),
          let containsSymlink = booleanValue(value["containsSymlink"]),
          let gitValue = objectValue(value["git"]),
          let git = decodeGitPreflightState(gitValue) else { return nil }
    return DesktopProjectTargetInspection(
      inputPath: inputPath,
      resolvedPath: resolvedPath,
      canonicalPath: canonicalPath,
      workspaceRoot: workspaceRoot,
      exists: exists,
      isDirectory: isDirectory,
      entryCount: entryCount,
      withinWorkspace: withinWorkspace,
      containsSymlink: containsSymlink,
      git: git
    )
  }

  func decodeResumeActionResult(
    _ result: [String: CanvastJSONValue], fallback: String
  ) -> DesktopResumeActionResult? {
    guard let snapshotObject = objectValue(result["snapshot"]),
          let snapshot = decodeResumeSnapshot(snapshotObject) else { return nil }
    let resultRevision = integerValue(result["revision"]) ?? snapshot.revision
    guard resultRevision == snapshot.revision else { return nil }
    return DesktopResumeActionResult(
      snapshot: snapshot, candidate: objectValue(result["candidate"]).flatMap(decodeResumeCandidate),
      candidateID: stringValue(result["candidateId"]), requestID: stringValue(result["requestId"]),
      claimToken: stringValue(result["claimToken"]), dispatchID: stringValue(result["dispatchId"]),
      accepted: booleanValue(result["accepted"]), dispatched: booleanValue(result["dispatched"]),
      revision: resultRevision,
      continuationReceiptState: stringValue(result["continuationReceiptState"]),
      continuityPhase: stringValue(result["continuityPhase"]),
      message: stringValue(result["message"]) ?? fallback
    )
  }

  func decodeResumeSnapshot(_ value: [String: CanvastJSONValue]) -> CanvastRuntimeResumeSnapshot? {
    guard let revision = integerValue(value["revision"]), revision >= 0 else { return nil }
    let candidates = arrayValue(value["candidates"])?.compactMap(objectValue).compactMap(decodeResumeCandidate) ?? []
    return CanvastRuntimeResumeSnapshot(
      revision: revision,
      state: stringValue(value["state"]) ?? "idle", updatedAt: stringValue(value["updatedAt"]) ?? "",
      projectID: stringValue(value["projectId"]), selectedCandidateID: stringValue(value["selectedCandidateId"]),
      claimedCandidateID: stringValue(value["claimedCandidateId"]),
      readyCandidateCount: integerValue(value["readyCandidateCount"]) ?? 0, candidates: candidates
    )
  }

  func decodeResumeCandidate(_ value: [String: CanvastJSONValue]) -> CanvastRuntimeResumeCandidate? {
    guard let id = stringValue(value["id"]), let projectID = stringValue(value["projectId"]),
          let requestID = stringValue(value["requestId"]) else { return nil }
    let binding = objectValue(value["binding"]).map {
      CanvastRuntimeResumeBinding(
        planNodeID: stringValue($0["planNodeId"]), taskNodeID: stringValue($0["taskNodeId"]),
        updatedAt: stringValue($0["updatedAt"]) ?? "", source: stringValue($0["source"]) ?? ""
      )
    }
    let claim = objectValue(value["claim"]).map {
      CanvastRuntimeResumeClaim(
        claimToken: stringValue($0["claimToken"]) ?? "", sessionID: stringValue($0["sessionId"]) ?? "",
        state: stringValue($0["state"]) ?? "", claimedAt: stringValue($0["claimedAt"]) ?? "",
        updatedAt: stringValue($0["updatedAt"]) ?? ""
      )
    }
    let validationValue = objectValue(value["validation"]) ?? [:]
    return CanvastRuntimeResumeCandidate(
      id: id, projectID: projectID, requestID: requestID, title: stringValue(value["title"]) ?? "",
      summary: stringValue(value["summary"]) ?? "", createdAt: stringValue(value["createdAt"]) ?? "",
      updatedAt: stringValue(value["updatedAt"]) ?? "", lastActiveAt: stringValue(value["lastActiveAt"]) ?? "",
      sessionID: stringValue(value["sessionId"]), turnID: stringValue(value["turnId"]),
      continuationOwner: stringValue(value["continuationOwner"]),
      continuityPhase: stringValue(value["continuityPhase"]), operationID: stringValue(value["operationId"]),
      disposition: stringValue(value["disposition"]) ?? "", binding: binding, claim: claim,
      validation: CanvastRuntimeResumeValidation(
        availability: stringValue(validationValue["availability"]) ?? "",
        freshness: stringValue(validationValue["freshness"]) ?? "",
        issues: stringsValue(validationValue["issues"]),
        projectMatched: booleanValue(validationValue["projectMatched"]) ?? false,
        hasBlockingActiveRun: booleanValue(validationValue["hasBlockingActiveRun"]) ?? false,
        missingPlanNode: booleanValue(validationValue["missingPlanNode"]) ?? false,
        missingTaskNode: booleanValue(validationValue["missingTaskNode"]) ?? false,
        parentLinkValid: booleanValue(validationValue["parentLinkValid"]) ?? false
      ),
      availableActions: stringsValue(value["availableActions"]),
      retiredReason: stringValue(value["retiredReason"]), completedAt: stringValue(value["completedAt"])
    )
  }
}
