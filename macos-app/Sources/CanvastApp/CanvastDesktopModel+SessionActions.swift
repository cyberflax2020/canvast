import Foundation
import AppKit
import CanvastAppCore

@MainActor
extension CanvastDesktopModel {
  private var canPresentNativeDirectoryPanel: Bool {
    !CommandLine.arguments.contains("--self-test")
  }

  var visibleResumeSnapshot: CanvastRuntimeResumeSnapshot {
    resumeActionResult?.snapshot ?? state.runtimeStatus.resume
  }

  func loadSessionCatalog() {
    executeAction(.init(
      workspace: .project, kind: .sessionCatalog, featureID: .sessions
    ), label: "session history", uiActionID: .loadSessionCatalog)
  }

  func openSession(path: String) {
    let sessionPath = path.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !sessionPath.isEmpty else {
      reportSessionInputIssue("Choose a session before opening it.")
      return
    }
    executeAction(.init(
      workspace: .project, kind: .sessionOpen, featureID: .sessions,
      arguments: ["sessionPath": .string(sessionPath)]
    ), label: "session open", uiActionID: .openSession)
  }

  func renameActiveSession(name: String) {
    let nextName = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !nextName.isEmpty else {
      reportSessionInputIssue("Enter a session name before renaming it.")
      return
    }
    guard let catalog = sessionCatalog,
          !catalog.activeSessionPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      reportSessionInputIssue("Load the session catalog before renaming the active session.")
      return
    }
    executeAction(.init(
      workspace: .project, kind: .sessionRename, featureID: .sessions,
      arguments: ["name": .string(nextName)]
    ), label: "session rename", uiActionID: .renameSession)
  }

  func deleteSession(path: String) {
    let sessionPath = path.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !sessionPath.isEmpty else {
      reportSessionInputIssue("Choose a session before deleting it.")
      return
    }
    executeAction(.init(
      workspace: .project, kind: .sessionDelete, featureID: .sessions,
      arguments: ["sessionPath": .string(sessionPath)]
    ), label: "session delete", uiActionID: .deleteSession)
  }

  func loadSessionTranscript(path: String) {
    let sessionPath = path.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !sessionPath.isEmpty else {
      reportSessionInputIssue("Choose a session before loading its transcript.")
      return
    }
    executeAction(.init(
      workspace: .project, kind: .sessionTranscript, featureID: .sessions,
      arguments: ["sessionPath": .string(sessionPath)]
    ), label: "session transcript", uiActionID: .loadSessionTranscript)
  }

  func runProjectPreflight(path: String, replacementPath: String? = nil, operation: String) {
    let projectPath = path.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !projectPath.isEmpty else {
      reportSessionInputIssue("Choose a project path before running Project Safety Check.")
      return
    }
    guard ["create", "open", "reinitialize", "retire"].contains(operation) else {
      reportSessionInputIssue("Project Safety Check operation must be create, open, reinitialize, or retire.")
      return
    }
    var arguments: [String: CanvastDesktopValue] = [
      "projectPath": .string(projectPath),
      "operation": .string(operation),
    ]
    if let replacementPath = trimmedNonempty(replacementPath) {
      arguments["replacementPath"] = .string(replacementPath)
    }
    executeAction(.init(
      workspace: .project, kind: .projectPreflight, featureID: .sessions,
      arguments: arguments
    ), label: "project safety check", uiActionID: .runProjectPreflight)
  }

  func createProjectSession(path: String, expectedRevision: String?, approvedAcknowledgement: Bool) {
    dispatchProjectLifecycleAction(
      kind: .projectCreate,
      uiActionID: .createProjectSession,
      path: path,
      expectedRevision: expectedRevision,
      approvedAcknowledgement: approvedAcknowledgement,
      label: "project create"
    )
  }

  func openProjectSession(path: String, expectedRevision: String?, approvedAcknowledgement: Bool) {
    dispatchProjectLifecycleAction(
      kind: .projectOpen,
      uiActionID: .openProjectSession,
      path: path,
      expectedRevision: expectedRevision,
      approvedAcknowledgement: approvedAcknowledgement,
      label: "project open"
    )
  }

  func reinitializeProject(path: String, expectedRevision: String?, approvedAcknowledgement: Bool) {
    dispatchProjectLifecycleAction(
      kind: .projectReinitialize,
      uiActionID: .reinitializeProject,
      path: path,
      expectedRevision: expectedRevision,
      approvedAcknowledgement: approvedAcknowledgement,
      label: "project reinitialize"
    )
  }

  func retireProject(
    path: String, replacementPath: String?, expectedRevision: String?,
    approvedAcknowledgement: Bool
  ) {
    dispatchProjectLifecycleAction(
      kind: .projectDelete,
      uiActionID: .retireProject,
      path: path,
      replacementPath: replacementPath,
      expectedRevision: expectedRevision,
      approvedAcknowledgement: approvedAcknowledgement,
      label: "project retirement"
    )
  }

  func chooseProjectDirectoryForLifecycle(message: String) -> String? {
    guard canPresentNativeDirectoryPanel else {
      statusLine = localizer.text(
        "Native project selection is unavailable during unattended self-test runs.",
        "无人值守自测运行期间无法使用原生项目选择面板。"
      )
      return nil
    }
    let panel = NSOpenPanel()
    panel.message = message
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    return panel.runModal() == .OK ? panel.url?.path : nil
  }

  func inspectResumeCandidate(id: String) {
    dispatchResumeAction(
      .inspectResume, uiActionID: .inspectResume, label: "resume inspection",
      candidateID: id
    )
  }

  func chooseResumeCandidate(id: String) {
    dispatchResumeAction(
      .chooseResume, uiActionID: .chooseResume, label: "resume candidate selection",
      candidateID: id
    )
  }

  func claimResumeCandidate(id: String?) {
    let candidateID = trimmedNonempty(id)
    if candidateID == nil {
      let readyCandidates = visibleResumeSnapshot.candidates.filter { candidate in
        candidate.validation.availability == "ready"
          && ["available", "selected", "claimed"].contains(candidate.disposition)
      }
      guard visibleResumeSnapshot.readyCandidateCount == 1, readyCandidates.count == 1 else {
        reportSessionInputIssue(
          "Select a resume candidate. An omitted candidate ID is only valid when exactly one candidate is ready."
        )
        return
      }
    }
    let payload = CanvastResumeClaimPayload(
      candidateID: candidateID, expectedRevision: visibleResumeSnapshot.revision
    )
    executeAction(.init(
      workspace: .run, kind: .claimResume, featureID: .chat, arguments: payload.actionArguments
    ), label: "resume claim and dispatch", uiActionID: .claimResume)
  }

  func rebindResumeCandidate(
    id: String, planNodeID: String?, taskNodeID: String?
  ) {
    guard let candidateID = trimmedNonempty(id) else {
      reportSessionInputIssue("Choose a resume candidate before repairing its binding.")
      return
    }
    var arguments: [String: CanvastDesktopValue] = ["candidateId": .string(candidateID)]
    if let planNodeID = trimmedNonempty(planNodeID) {
      arguments["planNodeId"] = .string(planNodeID)
    }
    if let taskNodeID = trimmedNonempty(taskNodeID) {
      arguments["taskNodeId"] = .string(taskNodeID)
    }
    guard arguments["planNodeId"] != nil || arguments["taskNodeId"] != nil else {
      reportSessionInputIssue("Enter a plan node ID or task node ID before repairing the binding.")
      return
    }
    executeAction(.init(
      workspace: .run, kind: .rebindResume, featureID: .chat, arguments: arguments
    ), label: "resume binding repair", uiActionID: .rebindResume)
  }

  func retireResumeCandidate(id: String, reason: String? = nil) {
    guard let candidateID = trimmedNonempty(id) else {
      reportSessionInputIssue("Choose a resume candidate before retiring it.")
      return
    }
    var arguments: [String: CanvastDesktopValue] = ["candidateId": .string(candidateID)]
    if let reason = trimmedNonempty(reason) { arguments["reason"] = .string(reason) }
    executeAction(.init(
      workspace: .run, kind: .retireResume, featureID: .chat, arguments: arguments
    ), label: "resume candidate retirement", uiActionID: .retireResume)
  }

  func reconcileResumeCandidates() {
    executeAction(.init(
      workspace: .run, kind: .reconcileResume, featureID: .chat
    ), label: "resume reconciliation", uiActionID: .reconcileResume)
  }

  private func dispatchResumeAction(
    _ kind: CanvastDesktopActionKind,
    uiActionID: DesktopUIActionID,
    label: String,
    candidateID: String
  ) {
    guard let candidateID = trimmedNonempty(candidateID) else {
      reportSessionInputIssue("Choose a resume candidate before continuing.")
      return
    }
    executeAction(.init(
      workspace: .run, kind: kind, featureID: .chat,
      arguments: ["candidateId": .string(candidateID)]
    ), label: label, uiActionID: uiActionID)
  }

  private func dispatchProjectLifecycleAction(
    kind: CanvastDesktopActionKind,
    uiActionID: DesktopUIActionID,
    path: String,
    replacementPath: String? = nil,
    expectedRevision: String?,
    approvedAcknowledgement: Bool,
    label: String
  ) {
    let projectPath = path.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !projectPath.isEmpty else {
      reportSessionInputIssue("Choose a project path before continuing.")
      return
    }
    var arguments: [String: CanvastDesktopValue] = ["projectPath": .string(projectPath)]
    if let replacementPath = trimmedNonempty(replacementPath) {
      arguments["replacementPath"] = .string(replacementPath)
    }
    if let revision = trimmedNonempty(expectedRevision) {
      arguments["expectedRevision"] = .string(revision)
    }
    if approvedAcknowledgement {
      arguments["approvedAcknowledgement"] = .boolean(true)
    }
    executeAction(.init(
      workspace: .project, kind: kind, featureID: .sessions, arguments: arguments
    ), label: label, uiActionID: uiActionID)
  }

  private func trimmedNonempty(_ value: String?) -> String? {
    guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
          !trimmed.isEmpty else { return nil }
    return trimmed
  }

  private func reportSessionInputIssue(_ message: String) {
    statusLine = message
    appendConsole(.standardError, message)
  }
}
