import Foundation
import Dispatch
import CanvastAppCore

@MainActor
extension CanvastDesktopModel {
  func beginAsyncLocalAction(
    _ id: DesktopUIActionID, correlationID: String, retry: (() -> Void)? = nil,
    cancel: (() -> Void)? = nil,
    reconcile: ((String) -> Void)? = nil,
    timeoutSeconds: Int? = nil,
    stage: DesktopActionStage = .init(.snapshotRefresh, label: "Loading local state")
  ) -> Bool {
    if requiresConfiguredWorkspace(id) {
      guard requireConfiguredWorkspace(actionID: id) else { return false }
    }
    let spec = DesktopActionRegistry.spec(for: id)
    switch actionCenter.begin(
      spec: spec, correlationID: correlationID, retry: retry, cancel: cancel, reconcile: reconcile,
      onTimeout: { [weak self] in
        self?.cancelLocalActionTask(id, correlationID: correlationID)
        self?.handleActionTimeout(id, correlationID: correlationID)
      },
      timeoutSeconds: timeoutSeconds,
      stage: stage
    ) {
    case .locked(_, let message):
      statusLine = message
      return false
    case .started:
      actionCenter.markRunning(
        id, correlationID: correlationID, message: stage.label, token: stage.token,
        detail: stage.detail
      )
      return true
    }
  }

  func reserveLocalActionTask(_ id: DesktopUIActionID, correlationID: String) {
    if localActionTaskCorrelationIDs[id] != correlationID {
      localActionTasks.removeValue(forKey: id)?.cancel()
    }
    localActionTaskCorrelationIDs[id] = correlationID
  }

  func installLocalActionTask(
    _ task: Task<Void, Never>, for id: DesktopUIActionID, correlationID: String
  ) {
    guard localActionTaskCorrelationIDs[id] == correlationID else {
      task.cancel()
      return
    }
    localActionTasks[id] = task
  }

  func finishLocalActionTask(_ id: DesktopUIActionID, correlationID: String) {
    if let trackedCorrelationID = localActionTaskCorrelationIDs[id],
       trackedCorrelationID != correlationID {
      return
    }
    localActionTaskCorrelationIDs.removeValue(forKey: id)
    localActionTasks.removeValue(forKey: id)
  }

  func cancelLocalActionTask(_ id: DesktopUIActionID, correlationID: String) {
    if let trackedCorrelationID = localActionTaskCorrelationIDs[id],
       trackedCorrelationID != correlationID {
      return
    }
    localActionTaskCorrelationIDs.removeValue(forKey: id)
    localActionTasks.removeValue(forKey: id)?.cancel()
  }

  func performLocalAction(
    _ id: DesktopUIActionID,
    lastStableState: String? = nil,
    retry: (() -> Void)? = nil,
    rollback: (() -> Void)? = nil,
    stage: DesktopActionStage = .init(.localState, label: "Applying local change"),
    operation: () throws -> String
  ) {
    let spec = DesktopActionRegistry.spec(for: id)
    let correlationID = UUID().uuidString
    switch actionCenter.begin(
      spec: spec,
      correlationID: correlationID,
      lastStableState: lastStableState,
      retry: retry,
      rollback: rollback,
      stage: stage
    ) {
    case .locked(_, let message):
      statusLine = message
      appendConsole(.system, message)
      return
    case .started:
      actionCenter.markRunning(id, correlationID: correlationID, message: stage.label, token: stage.token, detail: stage.detail)
      do {
        let message = try operation()
        actionCenter.succeed(id, correlationID: correlationID, message: message)
        statusLine = message
      } catch {
        let message = error.localizedDescription
        actionCenter.fail(id, correlationID: correlationID, message: message)
        statusLine = message
        appendConsole(.standardError, message)
      }
    }
  }

  func beginNativeRPCAction(
    _ id: DesktopUIActionID,
    correlationID: String,
    lastStableState: String? = nil,
    retry: (() -> Void)? = nil,
    cancel: (() -> Void)? = nil,
    rollback: (() -> Void)? = nil,
    reconcile: ((String) -> Void)? = nil,
    timeoutSeconds: Int? = nil,
    operation: () throws -> Void
  ) -> Bool {
    if requiresConfiguredWorkspace(id) {
      guard requireConfiguredWorkspace(actionID: id) else { return false }
    }
    let spec = DesktopActionRegistry.spec(for: id)
    switch actionCenter.begin(
      spec: spec,
      correlationID: correlationID,
      lastStableState: lastStableState,
      retry: retry,
      cancel: cancel,
      rollback: rollback,
      reconcile: reconcile,
      onTimeout: { [weak self] in self?.handleActionTimeout(id, correlationID: correlationID) },
      timeoutSeconds: timeoutSeconds,
      stage: .init(.hostPreparation, label: "Preparing runtime host")
    ) {
    case .locked(_, let message):
      statusLine = message
      appendConsole(.system, message)
      return false
    case .started:
      break
    }
    pendingNativeActionIDs[correlationID] = id
    do {
      try operation()
      actionCenter.markDispatched(id, correlationID: correlationID, message: "Request sent to runtime")
      if pendingNativeActionIDs[correlationID] == id {
        actionCenter.markWaiting(id, correlationID: correlationID, message: "Waiting for runtime reply")
      }
      return true
    } catch let dispatchError as DesktopActionDispatchError {
      let message = dispatchError.localizedDescription
      switch dispatchError {
      case .notDispatched:
        discardNativeRequest(correlationID)
        actionCenter.fail(id, correlationID: correlationID, message: message)
      case .outcomeUnknown:
        actionCenter.markDispatched(id, correlationID: correlationID, message: "Request write outcome is unknown")
        actionCenter.markOutcomeUnknown(id, correlationID: correlationID, message: message)
      }
      statusLine = message
      appendConsole(.standardError, message)
      return false
    } catch {
      discardNativeRequest(correlationID)
      let message = error.localizedDescription
      actionCenter.fail(id, correlationID: correlationID, message: message)
      statusLine = message
      appendConsole(.standardError, message)
      return false
    }
  }

  func beginDesktopDispatcherAction(
    _ id: DesktopUIActionID,
    action: CanvastDesktopAction,
    retry: (() -> Void)? = nil,
    lastStableState: String? = nil,
    rollback: (() -> Void)? = nil,
    reconcile: ((String) -> Void)? = nil
  ) -> Bool {
    guard requireConfiguredWorkspace(actionID: id) else { return false }
    let spec = DesktopActionRegistry.spec(for: id)
    switch actionCenter.begin(
      spec: spec,
      correlationID: action.requestID,
      lastStableState: lastStableState,
      retry: retry,
      rollback: rollback,
      reconcile: reconcile,
      onTimeout: { [weak self] in self?.handleActionTimeout(id, correlationID: action.requestID) },
      stage: .init(.hostPreparation, label: "Preparing runtime host")
    ) {
    case .locked(_, let message):
      statusLine = message
      appendConsole(.system, message)
      return false
    case .started:
      break
    }
    do {
      let providerConfiguration = try dispatcherProviderConfiguration(for: id)
      try ensureRuntimeHost(providerConfiguration: providerConfiguration)
      pendingActionIDs.insert(action.requestID)
      pendingActionKinds[action.requestID] = action.kind
      pendingUIActionIDs[action.requestID] = id
      try runtimeBridge.execute(
        action: action,
        installRoot: try resolvedInstallRoot(),
        workspaceRoot: projectRoot,
        mode: displayedRuntimeMode,
        thinkingLevel: thinkingLevel,
        providerConfiguration: providerConfiguration
      )
      if pendingActionIDs.contains(action.requestID) {
        actionCenter.markQueued(id, correlationID: action.requestID, message: "Typed action dispatched")
        actionCenter.markWaiting(id, correlationID: action.requestID, message: "Waiting for desktop action result")
      }
      statusLine = "Sent \(spec.title.lowercased())"
      return true
    } catch let dispatchError as DesktopActionDispatchError {
      let message = dispatchError.localizedDescription
      switch dispatchError {
      case .notDispatched:
        pendingActionIDs.remove(action.requestID)
        pendingActionKinds.removeValue(forKey: action.requestID)
        pendingUIActionIDs.removeValue(forKey: action.requestID)
        actionCenter.fail(id, correlationID: action.requestID, message: message)
      case .outcomeUnknown:
        actionCenter.markDispatched(id, correlationID: action.requestID, message: "Typed action write outcome is unknown")
        actionCenter.markOutcomeUnknown(id, correlationID: action.requestID, message: message)
      }
      statusLine = message
      appendConsole(.standardError, message)
      return false
    } catch {
      pendingActionIDs.remove(action.requestID)
      pendingActionKinds.removeValue(forKey: action.requestID)
      pendingUIActionIDs.removeValue(forKey: action.requestID)
      let message = error.localizedDescription
      actionCenter.fail(id, correlationID: action.requestID, message: message)
      statusLine = message
      appendConsole(.standardError, message)
      return false
    }
  }

  private func dispatcherProviderConfiguration(
    for id: DesktopUIActionID
  ) throws -> CanvastProviderRuntimeConfiguration? {
    guard dispatchRequiresProviderConfiguration(id) else { return nil }
    return try resolvedProviderConfiguration()
  }

  func recordLocalFilterAction(_ id: DesktopUIActionID, message: String, lastStableState: String? = nil) {
    guard !requiresConfiguredWorkspace(id) || requireConfiguredWorkspace(actionID: id) else { return }
    actionCenter.instantSuccess(
      spec: DesktopActionRegistry.spec(for: id),
      message: message,
      lastStableState: lastStableState,
      stage: .init(.localState, label: message)
    )
    statusLine = message
  }

  private func requiresConfiguredWorkspace(_ id: DesktopUIActionID) -> Bool {
    switch id {
    case .saveSettings, .testProviderConnection, .applyProviderSettings,
         .revokeProviderCredential, .clearConsole, .setThinkingLevel:
      return false
    default:
      return true
    }
  }

  func completeNativeRPCAction(_ requestID: String, message: String, failed: Bool = false, cancelled: Bool = false) {
    guard let actionID = pendingNativeActionIDs.removeValue(forKey: requestID) else { return }
    if cancelled {
      actionCenter.cancel(actionID, correlationID: requestID, message: message)
    } else if failed {
      actionCenter.fail(actionID, correlationID: requestID, message: message)
    } else {
      actionCenter.succeed(actionID, correlationID: requestID, message: message)
    }
  }

  func runStateAfterRejectedStop(targetRunRequestID: String?) -> DesktopRunState {
    guard let targetRunRequestID, activeRunRequestID == targetRunRequestID else {
      return .failed("Run stop was not confirmed")
    }
    guard let snapshot = actionCenter.snapshot(for: .startRun),
          snapshot.correlationID == targetRunRequestID else {
      return .running
    }
    switch snapshot.status {
    case .running:
      return .running
    case .preparing, .queued, .waiting, .outcomeUnknown, .reconciling, .reconciled:
      return .preparing
    case .idle, .succeeded, .failed, .cancelled, .timedOut:
      return .running
    }
  }

  func settlePendingAbortRequest(for targetRunRequestID: String, message: String) {
    guard let abortRequestID = pendingAbortTargets.first(where: { $0.value == targetRunRequestID })?.key else {
      return
    }
    pendingNativeCommands.removeValue(forKey: abortRequestID)
    pendingAbortTargets.removeValue(forKey: abortRequestID)
    completeNativeRPCAction(abortRequestID, message: message)
  }

  func sealTimedOutPromptRequest(_ requestID: String) {
    runtimeBridge.discardPromptRequest(requestID)
    if pendingNativeCommands[requestID] == "prompt" {
      pendingNativeCommands.removeValue(forKey: requestID)
    }
  }

  func noteForcedStopSettlement(for runRequestID: String, message: String) {
    forcedStopMessagesByTargetRequestID[runRequestID] = message
    statusLine = message
    appendConsole(.standardError, message)
  }

  func forceStopTimedOutRun(_ runRequestID: String, reason: String) {
    guard activeRunRequestID == runRequestID else { return }
    noteForcedStopSettlement(for: runRequestID, message: reason)
    runtimeBridge.stopHost()
    if runtimeBridge.isRunning {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
        guard let self, self.activeRunRequestID == runRequestID, self.runtimeBridge.isRunning else { return }
        self.statusLine = "Run timeout escalation is still settling; refresh state if the host remains live."
        self.appendConsole(.standardError, self.statusLine)
      }
    }
  }

  func requestTimeoutAbortSettlement(for runRequestID: String) {
    sealTimedOutPromptRequest(runRequestID)
    guard activeRunRequestID == runRequestID || pendingNativeActionIDs[runRequestID] == .startRun else {
      return
    }
    if let stopSnapshot = actionCenter.snapshot(for: .stopRun),
       stopSnapshot.status.holdsLock,
       stopSnapshot.lastStableState == runRequestID {
      runState = runStateAfterRejectedStop(targetRunRequestID: runRequestID)
      let waitingMessage = "Run deadline exceeded; waiting for the outstanding abort settlement."
      statusLine = waitingMessage
      appendConsole(.standardError, waitingMessage)
      forceStopTimedOutRun(
        runRequestID,
        reason: "Run deadline exceeded; the runtime host is being terminated while settlement is verified."
      )
      return
    }
    let abortRequestID = UUID().uuidString
    let timeoutStatus = "Run deadline exceeded; abort requested while settlement is verified."
    if beginNativeRPCAction(
      .stopRun,
      correlationID: abortRequestID,
      lastStableState: runRequestID,
      reconcile: { [weak self] reconciliationID in
        self?.reconcilePersistedState(
          for: .stopRun, correlationID: abortRequestID, reconciliationID: reconciliationID
        )
      },
      operation: {
        pendingAbortTargets[abortRequestID] = runRequestID
        pendingNativeCommands[abortRequestID] = "abort"
        try runtimeBridge.abort(requestID: abortRequestID)
      }
    ) {
      runState = runStateAfterRejectedStop(targetRunRequestID: runRequestID)
      statusLine = timeoutStatus
      appendConsole(.standardError, timeoutStatus)
      forceStopTimedOutRun(
        runRequestID,
        reason: "Run deadline exceeded; the runtime host is being terminated while abort settlement is verified."
      )
      return
    }
    forceStopTimedOutRun(
      runRequestID,
      reason: "Run deadline exceeded; abort delivery was uncertain, so the runtime host is being terminated while settlement is verified."
    )
  }

  func handleActionTimeout(_ id: DesktopUIActionID, correlationID: String) {
    let snapshot = actionCenter.snapshot(for: id)
    guard let snapshot else {
      statusLine = DesktopActionRegistry.spec(for: id).timeoutMessage
      appendConsole(.standardError, statusLine)
      return
    }
    guard snapshot.correlationID == correlationID else { return }
    if id == .startRun, snapshot.status == .outcomeUnknown {
      requestTimeoutAbortSettlement(for: correlationID)
      return
    }
    if snapshot.status == .timedOut {
      if pendingNativeActionIDs[correlationID] == id {
        discardNativeRequest(correlationID)
      }
      if pendingUIActionIDs[correlationID] == id {
        pendingUIActionIDs.removeValue(forKey: correlationID)
        pendingActionIDs.remove(correlationID)
        pendingActionKinds.removeValue(forKey: correlationID)
      }
    }
    if id == .startRun,
       [.timedOut, .outcomeUnknown].contains(snapshot.status) {
      runtimeBridge.discardPromptRequest(correlationID)
    }
    if id == .setThinkingLevel {
      if snapshot.status == .timedOut { pendingThinkingLevels.removeValue(forKey: correlationID) }
      if let stable = snapshot.lastStableState { thinkingLevel = stable }
    }
    if id == .setRuntimeMode {
      pendingRuntimeModeSelection = nil
    }
    if snapshot.status == .timedOut, id == .startRun {
      if activeRunRequestID == correlationID { activeRunRequestID = nil }
      runState = .failed("Run start timed out")
    }
    if snapshot.status == .timedOut, id == .stopRun {
      runState = runStateAfterRejectedStop(targetRunRequestID: snapshot.lastStableState)
    }
    statusLine = snapshot.message
    appendConsole(.standardError, statusLine)
  }
}
