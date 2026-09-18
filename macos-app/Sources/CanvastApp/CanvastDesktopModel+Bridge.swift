import Foundation
import CanvastAppCore

@MainActor
extension CanvastDesktopModel {
  @discardableResult
  func executeAction(
    _ action: CanvastDesktopAction,
    label: String,
    uiActionID: DesktopUIActionID? = nil,
    lastStableState: String? = nil,
    reconcile: ((String) -> Void)? = nil
  ) -> Bool {
    guard requireConfiguredWorkspace(actionID: uiActionID, actionLabel: label) else { return false }
    do {
      try action.validate()
    } catch {
      let message = error.localizedDescription
      if let uiActionID {
        let spec = DesktopActionRegistry.spec(for: uiActionID)
        if case .started = actionCenter.begin(
          spec: spec, correlationID: action.requestID,
          stage: .init(.hostPreparation, label: "Validating typed action")
        ) {
          actionCenter.fail(uiActionID, correlationID: action.requestID, message: message)
        }
      }
      statusLine = message
      appendConsole(.standardError, message)
      return false
    }
    if let uiActionID {
      let spec = DesktopActionRegistry.spec(for: uiActionID)
      return beginDesktopDispatcherAction(
        uiActionID,
        action: action,
        retry: spec.retryPolicy == .never ? nil : { [weak self] in
          self?.retryDispatcherAction(action, label: label, uiActionID: uiActionID)
        },
        lastStableState: lastStableState,
        reconcile: reconcile ?? { [weak self] reconciliationID in
          self?.reconcilePersistedState(
            for: uiActionID, correlationID: action.requestID, reconciliationID: reconciliationID
          )
        }
      )
    }
    do {
      let providerConfiguration = try resolvedProviderConfiguration()
      try ensureRuntimeHost(providerConfiguration: providerConfiguration)
      pendingActionIDs.insert(action.requestID)
      pendingActionKinds[action.requestID] = action.kind
      actionState = .sending(label)
      lastActionResult = nil
      try runtimeBridge.execute(
        action: action, installRoot: try resolvedInstallRoot(), workspaceRoot: projectRoot,
        mode: displayedRuntimeMode, thinkingLevel: thinkingLevel,
        providerConfiguration: providerConfiguration
      )
      statusLine = "Sent \(label)"
      return true
    } catch {
      pendingActionIDs.remove(action.requestID)
      pendingActionKinds.removeValue(forKey: action.requestID)
      failAction(label.capitalized, error)
      return false
    }
  }

  func failAction(_ label: String, _ error: Error) {
    actionState = .failed("\(label) failed")
    statusLine = "\(label) failed: \(error.localizedDescription)"
    appendConsole(.standardError, statusLine)
  }

  func handleBridgeEvent(_ event: CanvastBridgeEvent) {
    switch event {
    case .process(let snapshot): handleProcessSnapshot(snapshot)
    case .rpc(let event): handleRPCEvent(event)
    }
  }

  func handleProcessSnapshot(_ snapshot: CanvastProcessSnapshot) {
    if observedProcessID != snapshot.runID {
      observedProcessID = snapshot.runID
      observedStderrCount = 0
    }
    if let requestID = activeRunRequestID, snapshot.phase == .running,
       actionCenter.isCurrentExecution(.startRun, correlationID: requestID) {
      actionCenter.markRunning(
        .startRun,
        correlationID: requestID,
        message: "Run in progress",
        token: .streamActive,
        detail: "The runtime host accepted the prompt and is still active."
      )
    }
    if snapshot.errorOutput.count > observedStderrCount {
      let delta = String(snapshot.errorOutput.dropFirst(observedStderrCount))
      observedStderrCount = snapshot.errorOutput.count
      consume(delta, channel: .standardError)
      if let requestID = activeRunRequestID {
        actionCenter.heartbeat(.startRun, correlationID: requestID, message: "Receiving runtime diagnostics")
      }
    }
    guard [.succeeded, .failed, .terminated].contains(snapshot.phase),
          let requestID = activeRunRequestID else { return }
    guard !runtimeBridge.isRunning else {
      let message = "Runtime host is still live; retaining the active run while shutdown is reconciled"
      actionCenter.heartbeat(
        .startRun, correlationID: requestID, message: message,
        token: runState == .stopping ? .cancellation : .streamHeartbeat,
        detail: snapshot.errorOutput.isEmpty ? nil : snapshot.errorOutput
      )
      statusLine = message
      return
    }
    runtimeBridge.discardPromptRequest(requestID)
    completeRun(exitCode: snapshot.exitCode ?? (snapshot.phase == .succeeded ? 0 : 1))
  }

  func handleRPCEvent(_ event: CanvastRPCEvent) {
    switch event.kind {
    case .agentStarted:
      guard let requestID = activeRunRequestID, event.requestID == nil || event.requestID == requestID else { return }
      guard actionCenter.isCurrentExecution(.startRun, correlationID: requestID) else { return }
      runState = .running
      actionCenter.markRunning(
        .startRun,
        correlationID: requestID,
        message: "Run in progress",
        token: .streamActive,
        detail: "The agent started executing the submitted prompt."
      )
      statusLine = "Canvast is working"
    case .agentSettled:
      guard let requestID = activeRunRequestID,
            event.requestID == nil || event.requestID == requestID else { return }
      if event.success == true {
        completeRun(exitCode: 0)
      } else {
        if let text = event.text, !text.isEmpty { appendConsole(.standardError, text) }
        completeRun(exitCode: event.text?.lowercased().contains("cancel") == true ? 130 : 1)
      }
    case .textDelta:
      if let text = event.text {
        appendLiveAssistantDelta(text, requestID: event.requestID)
        if let requestID = activeRunRequestID {
          actionCenter.heartbeat(.startRun, correlationID: requestID, message: "Receiving run output")
        }
      }
    case .processUpdate:
      if let text = event.text {
        appendLiveProcessMessage(text, eventType: event.command ?? "process", requestID: event.requestID)
        appendConsole(.system, text)
      }
    case .messageCompleted:
      finishLiveAssistantMessage(event.text, requestID: event.requestID)
    case .response:
      handleRPCResponse(event)
    case .actionResult:
      if let result = event.actionResult { handleActionResult(result) }
    case .notification:
      if let text = event.text {
        appendConsole(.system, text)
        if let requestID = activeRunRequestID {
          actionCenter.heartbeat(.startRun, correlationID: requestID, message: "Runtime notification", detail: text)
        }
      }
    case .protocolError:
      let message = event.text ?? "The runtime returned an invalid protocol response."
      if let requestID = event.requestID,
         let pending = pendingSandboxRevokeReconciliations.removeValue(forKey: requestID) {
        finishSandboxRevokeReconciliation(
          pending,
          outcome: .stillUnknown(localizer.text(
            "The sandbox inspection response was invalid; the revoke outcome remains unknown.",
            "沙箱检查响应无效；撤销结果仍未知。"
          ))
        )
        appendConsole(.standardError, message)
        return
      }
      if let requestID = event.requestID, event.command == "canvast-action",
         pendingActionKinds[requestID] == .cancelCanvasExport {
        handleCanvasExportCancellationResult(.init(
          requestID: requestID, status: .failed,
          error: .init(code: "protocol_error", message: message),
          capabilityLevel: .full
        ))
        return
      }
      if let requestID = event.requestID, event.command == "canvast-action",
         pendingActionIDs.contains(requestID), let actionID = pendingUIActionIDs[requestID],
         actionCenter.isCurrentExecution(actionID, correlationID: requestID) {
        if actionID == .setRuntimeMode {
          pendingRuntimeModeSelection = nil
        }
        actionCenter.markDispatched(
          actionID, correlationID: requestID, message: "Desktop action result was received but could not be decoded"
        )
        actionCenter.markOutcomeUnknown(actionID, correlationID: requestID, message: message)
        statusLine = message
      }
      appendConsole(.standardError, message)
    }
  }

  func handleRPCResponse(_ event: CanvastRPCEvent) {
    if let confirmationID = event.requestID,
       let originalRequestID = pendingThinkingConfirmations.removeValue(forKey: confirmationID) {
      handleThinkingLevelConfirmation(event, originalRequestID: originalRequestID)
      return
    }
    guard let requestID = event.requestID, let command = pendingNativeCommands[requestID] else { return }
    if let actionID = pendingNativeActionIDs[requestID],
       !actionCenter.canAcceptRemoteResult(actionID, correlationID: requestID) {
      if let requestID = event.requestID { discardNativeRequest(requestID) }
      return
    }
    if command == "prompt",
       !actionCenter.isCurrentExecution(.startRun, correlationID: requestID) {
      return
    }
    pendingNativeCommands.removeValue(forKey: requestID)
    guard event.success == true else {
      if command == "prompt" { runtimeBridge.discardPromptRequest(requestID) }
      let abortTarget = pendingAbortTargets.removeValue(forKey: requestID)
      pendingThinkingLevels.removeValue(forKey: requestID)
      if requestID == activeRunRequestID {
        activeRunRequestID = nil
        runState = .failed(event.text ?? "RPC command was rejected")
      } else if command == "abort", abortTarget == activeRunRequestID {
        forcedStopMessagesByTargetRequestID.removeValue(forKey: abortTarget ?? "")
        runState = runStateAfterRejectedStop(targetRunRequestID: abortTarget)
      }
      completeNativeRPCAction(requestID, message: event.text ?? "RPC command was rejected", failed: true)
      if command == "thinking level", let stable = actionCenter.snapshot(for: .setThinkingLevel)?.lastStableState {
        thinkingLevel = stable
      }
      failAction(command.capitalized, AppSelfContainedError(event.text ?? "RPC command was rejected"))
      return
    }
    switch command {
    case "prompt":
      runState = .running
      statusLine = "Canvast run accepted"
      actionCenter.markRunning(
        .startRun,
        correlationID: requestID,
        message: "Run accepted",
        token: .streamActive,
        detail: "The runtime acknowledged the prompt and kept the run alive."
      )
    case "abort":
      let targetRunRequestID = pendingAbortTargets.removeValue(forKey: requestID)
      if let targetRunRequestID, activeRunRequestID == targetRunRequestID {
        forcedStopMessagesByTargetRequestID.removeValue(forKey: targetRunRequestID)
        activeRunRequestID = nil
        runState = .finished(130)
        statusLine = "Canvast run stopped"
        completeNativeRPCAction(targetRunRequestID, message: "Canvast run stopped", cancelled: true)
      }
      completeNativeRPCAction(requestID, message: "Canvast run stopped")
      appendConsole(.system, statusLine)
    case "new session":
      completeNativeRPCAction(requestID, message: "New session started")
      statusLine = "New session started"
      refreshRuntimeState()
    case "thinking level":
      let confirmationID = UUID().uuidString
      pendingThinkingConfirmations[confirmationID] = requestID
      do {
        try runtimeBridge.getState(requestID: confirmationID)
        let message = thinkingEffectiveValueConfirmationPendingMessage()
        actionCenter.markWaiting(
          .setThinkingLevel, correlationID: requestID,
          message: message
        )
        statusLine = message
      } catch {
        pendingThinkingConfirmations.removeValue(forKey: confirmationID)
        pendingThinkingLevels.removeValue(forKey: requestID)
        let message = thinkingEffectiveValueUnavailableMessage()
        actionCenter.markOutcomeUnknown(.setThinkingLevel, correlationID: requestID, message: message)
        statusLine = message
        appendConsole(.standardError, error.localizedDescription)
      }
    case "follow-up", "steer":
      statusLine = "\(command.capitalized) accepted"
      refreshActiveSessionTranscriptIfVisible()
    default:
      break
    }
  }

  private func handleThinkingLevelConfirmation(
    _ event: CanvastRPCEvent, originalRequestID: String
  ) {
    guard pendingNativeActionIDs[originalRequestID] == .setThinkingLevel,
          actionCenter.canAcceptRemoteResult(.setThinkingLevel, correlationID: originalRequestID) else {
      pendingThinkingLevels.removeValue(forKey: originalRequestID)
      return
    }
    guard event.success == true,
          let effective = event.effectiveThinkingLevel?.trimmingCharacters(in: .whitespacesAndNewlines),
          !effective.isEmpty else {
      pendingThinkingLevels.removeValue(forKey: originalRequestID)
      let message = event.text ?? thinkingMissingEffectiveValueMessage()
      actionCenter.markOutcomeUnknown(.setThinkingLevel, correlationID: originalRequestID, message: message)
      statusLine = message
      return
    }
    let requested = pendingThinkingLevels.removeValue(forKey: originalRequestID)
    thinkingLevel = effective
    let message = thinkingLevelConfirmationMessage(requested: requested, effective: effective)
    completeNativeRPCAction(originalRequestID, message: message)
    statusLine = message
  }

  private func thinkingEffectiveValueConfirmationPendingMessage() -> String {
    localizer.text(
      "Confirming the effective thinking level",
      "正在确认实际生效的思考等级"
    )
  }

  private func thinkingEffectiveValueUnavailableMessage() -> String {
    localizer.text(
      "The runtime accepted the setting, but its effective value could not be confirmed.",
      "运行时已接受该设置，但无法确认其实际生效值。"
    )
  }

  private func thinkingMissingEffectiveValueMessage() -> String {
    localizer.text(
      "The runtime accepted the setting, but returned no effective thinking level.",
      "运行时已接受该设置，但未返回实际生效的思考等级。"
    )
  }

  private func thinkingLevelConfirmationMessage(requested: String?, effective: String) -> String {
    if requested == effective {
      return localizer.text(
        "Thinking level set to \(effective)",
        "思考等级已设为 \(effective)"
      )
    }
    let requestedValue = requested ?? localizer.text("the requested value", "请求值")
    return localizer.text(
      "Runtime applied thinking level \(effective) instead of \(requestedValue)",
      "运行时实际应用的思考等级是 \(effective)，而不是 \(requestedValue)"
    )
  }

  func handleActionResult(_ result: CanvastDesktopActionResult) {
    if handleSandboxRevokeReconciliationResult(result) { return }
    if pendingActionKinds[result.requestID] == .cancelCanvasExport {
      handleCanvasExportCancellationResult(result)
      return
    }
    if pendingActionKinds[result.requestID] == .exportCanvas,
       hasPendingCanvasExportCancellation(targetRequestID: result.requestID) {
      discardDispatcherRequest(result.requestID)
      appendConsole(
        .system,
        localizer.text(
          "Ignored a Canvas export result while cancellation confirmation is pending.",
          "等待取消确认期间，已忽略画布导出结果。"
        )
      )
      return
    }
    guard pendingActionIDs.contains(result.requestID) else {
      discardDispatcherRequest(result.requestID)
      appendConsole(.standardError, "Ignored an uncorrelated desktop action result.")
      return
    }
    let uiActionID = pendingUIActionIDs[result.requestID]
    if let uiActionID, !actionCenter.canAcceptRemoteResult(uiActionID, correlationID: result.requestID) {
      discardDispatcherRequest(result.requestID)
      appendConsole(.standardError, "Ignored a stale desktop action result.")
      return
    }
    pendingActionIDs.remove(result.requestID)
    let kind = pendingActionKinds.removeValue(forKey: result.requestID)
    pendingUIActionIDs.removeValue(forKey: result.requestID)
    if kind == .revokeSandboxAccess {
      discardSandboxRevokeReconciliations(originalRequestID: result.requestID)
    }
    let validationError: Error?
    do {
      try result.validatePayload(for: kind)
      validationError = nil
    } catch {
      validationError = error
    }
    let protocolMismatch = result.protocolVersion != CanvastDesktopAction.currentProtocolVersion
    let restartWasNotReloaded = kind == .projectRestart && result.status == .succeeded &&
      booleanValue(result.result?["reloaded"]) != true
    let effectiveResult = validationError != nil ? CanvastDesktopActionResult(
      requestID: result.requestID, status: .failed, result: result.result,
      error: CanvastDesktopActionError(
        code: protocolMismatch ? "unsupported_protocol" : "invalid_result",
        message: validationError?.localizedDescription ?? "Desktop action result validation failed."
      ), capabilityLevel: result.capabilityLevel
    ) : restartWasNotReloaded ? CanvastDesktopActionResult(
      protocolVersion: result.protocolVersion, requestID: result.requestID, status: .failed,
      result: result.result,
      error: CanvastDesktopActionError(
        code: "restart_not_reloaded",
        message: "Project runtime restart failed: the host reported reloaded=false"
      ),
      capabilityLevel: result.capabilityLevel
    ) : result
    lastActionResult = effectiveResult
    if effectiveResult.status == .succeeded { applyTypedResult(effectiveResult, kind: kind) }
    if kind == .setRuntimeMode && effectiveResult.status != .succeeded {
      pendingRuntimeModeSelection = nil
    }
    let message = canvasExportResultMessage(effectiveResult, kind: kind) ??
      effectiveResult.error?.message ?? stringValue(effectiveResult.result?["message"]) ??
      actionResultSummary(effectiveResult)
    if let uiActionID {
      switch effectiveResult.status {
      case .succeeded:
        actionCenter.succeed(uiActionID, correlationID: effectiveResult.requestID, message: message)
      case .unsupported:
        actionCenter.fail(
          uiActionID,
          correlationID: effectiveResult.requestID,
          message: message,
          stage: .init(.complete, label: "Unsupported", detail: message)
        )
      case .failed:
        actionCenter.fail(uiActionID, correlationID: effectiveResult.requestID, message: message)
      }
    } else {
      switch effectiveResult.status {
      case .succeeded:
        actionState = result.capabilityLevel == .degraded ? .degraded(message) : .succeeded(message)
      case .unsupported:
        actionState = .degraded(message)
      case .failed:
        actionState = .failed(message)
      }
    }
    statusLine = message
    appendConsole(effectiveResult.status == .failed ? .standardError : .system, message)
    refreshRuntimeState()
  }

  func reconcilePersistedState(
    for id: DesktopUIActionID, correlationID: String, reconciliationID: String
  ) {
    refreshRuntimeState(
      actionID: id, correlationID: correlationID, reconciliationID: reconciliationID
    ) { [weak self] in
      guard let self else { return }
      guard self.actionCenter.resolveUnknown(
        id, correlationID: correlationID, reconciliationID: reconciliationID,
        outcome: .stillUnknown(
          "Authoritative state was refreshed, but this request has no operation receipt. Confirm its outcome before another mutation."
        )
      ) else { return }
      self.statusLine = "State refreshed; confirm the outcome before retrying"
    }
  }

  func confirmReviewedAction(_ id: DesktopUIActionID, succeeded: Bool) {
    guard let snapshot = actionCenter.snapshot(for: id), snapshot.supportsManualResolution else { return }
    let message = succeeded ? "User confirmed the action succeeded after state review." :
      "User confirmed the action failed after state review."
    guard actionCenter.resolveReviewedOutcome(
      id, correlationID: snapshot.correlationID, succeeded: succeeded, message: message
    ) else { return }
    switch id {
    case .startRun:
      discardNativeRequest(snapshot.correlationID, discardPromptCorrelation: !succeeded)
      if succeeded {
        forcedStopMessagesByTargetRequestID.removeValue(forKey: snapshot.correlationID)
        activeRunRequestID = snapshot.correlationID
        runState = .running
      } else {
        forcedStopMessagesByTargetRequestID.removeValue(forKey: snapshot.correlationID)
        if activeRunRequestID == snapshot.correlationID { activeRunRequestID = nil }
        runState = .failed("Run start was confirmed failed")
      }
    case .stopRun:
      discardNativeRequest(snapshot.correlationID)
      if succeeded {
        if let target = snapshot.lastStableState {
          forcedStopMessagesByTargetRequestID.removeValue(forKey: target)
          completeNativeRPCAction(target, message: "Canvast run stop was confirmed", cancelled: true)
        }
        activeRunRequestID = nil
        runState = .finished(130)
      } else {
        if let target = snapshot.lastStableState {
          forcedStopMessagesByTargetRequestID.removeValue(forKey: target)
        }
        runState = activeRunRequestID == nil ? .failed("Run stop was confirmed failed") : .running
      }
    default:
      discardPendingRequest(for: id, correlationID: snapshot.correlationID)
    }
    statusLine = message
  }

  func discardPendingRequest(for id: DesktopUIActionID, correlationID: String) {
    if pendingNativeActionIDs[correlationID] == id { discardNativeRequest(correlationID) }
    if pendingUIActionIDs[correlationID] == id { discardDispatcherRequest(correlationID) }
  }

  func discardNativeRequest(_ requestID: String, discardPromptCorrelation: Bool = true) {
    if discardPromptCorrelation, pendingNativeCommands[requestID] == "prompt" {
      runtimeBridge.discardPromptRequest(requestID)
    }
    pendingNativeCommands.removeValue(forKey: requestID)
    pendingNativeActionIDs.removeValue(forKey: requestID)
    pendingThinkingLevels.removeValue(forKey: requestID)
    pendingThinkingConfirmations = pendingThinkingConfirmations.filter { entry in
      entry.key != requestID && entry.value != requestID
    }
    pendingAbortTargets.removeValue(forKey: requestID)
  }

  func discardDispatcherRequest(_ requestID: String) {
    pendingActionIDs.remove(requestID)
    pendingActionKinds.removeValue(forKey: requestID)
    pendingUIActionIDs.removeValue(forKey: requestID)
  }

  func retryDispatcherAction(_ action: CanvastDesktopAction, label: String, uiActionID: DesktopUIActionID) {
    executeAction(
      .init(
        requestID: UUID().uuidString,
        workspace: action.workspace,
        kind: action.kind,
        featureID: action.featureID,
        arguments: action.arguments
      ),
      label: label,
      uiActionID: uiActionID
    )
  }
}
