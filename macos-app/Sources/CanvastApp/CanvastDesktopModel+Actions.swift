import Foundation
import CanvastAppCore

@MainActor
extension CanvastDesktopModel {
  func setRuntimeMode(_ next: CanvastRuntimeMode) {
    guard next != displayedRuntimeMode else { return }
    guard requireConfiguredWorkspace(actionID: .setRuntimeMode) else { return }
    let priorMode = state.runtimeMode
    guard persistRuntimeModeSelection(next, priorMode: priorMode) else { return }
    guard runtimeBridge.isRunning else {
      recordRuntimeModeChange(next, priorMode: priorMode)
      return
    }
    let requestID = UUID().uuidString
    pendingRuntimeModeSelection = next
    let dispatched = executeAction(.init(
      requestID: requestID,
      workspace: .project, kind: .setRuntimeMode, featureID: .sessions,
      arguments: [
        "mode": .string(next.rawValue),
        "scope": .string("session"),
        "reason": .string("User switched runtime mode from the macOS app."),
      ]
    ), label: "runtime mode", uiActionID: .setRuntimeMode, lastStableState: priorMode.rawValue)
    let currentSnapshot = actionSnapshot(.setRuntimeMode)
    if !dispatched || (currentSnapshot?.correlationID == requestID && currentSnapshot?.status == .failed) {
      pendingRuntimeModeSelection = nil
    }
  }

  private func persistRuntimeModeSelection(_ next: CanvastRuntimeMode, priorMode: CanvastRuntimeMode) -> Bool {
    guard !isActionLocked(.setRuntimeMode) else {
      let message = actionLockMessage(.setRuntimeMode) ?? "A runtime mode change is already in progress."
      statusLine = message
      appendConsole(.system, message)
      return false
    }
    do {
      try store.saveMode(projectRoot: projectRoot, mode: next, stateDirectory: stateDirectory)
      _ = nextPersistedRefreshGeneration()
      let reason = "User switched runtime mode from the macOS app."
      let localizedMode = humanized(next.rawValue, localizer: localizer)
      let message = localizer.text("Mode set to \(localizedMode)", "模式已设为 \(localizedMode)")
      commitLocalRuntimeMode(next, source: "local_settings", reason: reason, message: message)
      return true
    } catch {
      failLocalGate(
        actionID: .setRuntimeMode,
        message: error.localizedDescription,
        label: "Runtime mode"
      )
      return false
    }
  }

  private func recordRuntimeModeChange(_ next: CanvastRuntimeMode, priorMode: CanvastRuntimeMode) {
    let localizedMode = humanized(next.rawValue, localizer: localizer)
    let message = localizer.text("Mode set to \(localizedMode)", "模式已设为 \(localizedMode)")
    recordLocalFilterAction(.setRuntimeMode, message: message, lastStableState: priorMode.rawValue)
  }

  func setThinkingLevel(_ next: String) {
    let normalized = next.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard ["minimal", "low", "medium", "high", "xhigh", "max"].contains(normalized) else {
      statusLine = "Unsupported thinking level: \(next)"
      return
    }
    let priorLevel = thinkingLevel
    if runtimeBridge.isRunning {
      let requestID = UUID().uuidString
      if beginNativeRPCAction(
        .setThinkingLevel,
        correlationID: requestID,
        lastStableState: priorLevel,
        retry: { [weak self] in self?.setThinkingLevel(normalized) },
        reconcile: { [weak self] reconciliationID in
          self?.reconcilePersistedState(
            for: .setThinkingLevel, correlationID: requestID, reconciliationID: reconciliationID
          )
        },
        operation: {
          pendingThinkingLevels[requestID] = normalized
          pendingNativeCommands[requestID] = "thinking level"
          try runtimeBridge.setThinkingLevel(normalized, requestID: requestID)
          statusLine = "Applying thinking level \(normalized)"
        }
      ) == false {
        if actionSnapshot(.setThinkingLevel)?.status != .outcomeUnknown { thinkingLevel = priorLevel }
      }
    } else {
      thinkingLevel = normalized
      recordLocalFilterAction(
        .setThinkingLevel,
        message: "Thinking level set to \(normalized)",
        lastStableState: priorLevel
      )
    }
  }

  func toggleMode() {
    setRuntimeMode(displayedRuntimeMode == .enhanced ? .parity : .enhanced)
  }

  func previewRun() {
    let id = DesktopUIActionID.previewRun
    guard requireConfiguredWorkspace(actionID: id) else { return }
    let correlationID = UUID().uuidString
    let installRoot: URL
    do {
      installRoot = try resolvedInstallRoot()
    } catch {
      return
    }
    let workspaceRoot = projectRoot
    let mode = displayedRuntimeMode
    let thinkingLevel = thinkingLevel
    let timeoutSeconds = timeoutSeconds
    let runtimeBridge = runtimeBridge
    let providerConfiguration: CanvastProviderRuntimeConfiguration
    do {
      providerConfiguration = try resolvedProviderConfiguration()
    } catch {
      return
    }
    guard beginAsyncLocalAction(id, correlationID: correlationID, retry: { [weak self] in self?.previewRun() }) else { return }
    reserveLocalActionTask(id, correlationID: correlationID)
    let previewTask = Task.detached(priority: .userInitiated) {
      do {
        let plan = try runtimeBridge.makePlan(
          installRoot: installRoot, workspaceRoot: workspaceRoot, mode: mode,
          thinkingLevel: thinkingLevel, timeoutSeconds: timeoutSeconds,
          providerConfiguration: providerConfiguration
        )
        let arguments = [plan.executable.path] + plan.arguments
        guard !Task.isCancelled else { return }
        await self.commitLaunchPreview(arguments, id: id, correlationID: correlationID)
      } catch {
        await self.failLaunchPreview(error, id: id, correlationID: correlationID)
      }
    }
    installLocalActionTask(previewTask, for: id, correlationID: correlationID)
  }

  private func commitLaunchPreview(
    _ arguments: [String], id: DesktopUIActionID, correlationID: String
  ) {
    guard actionCenter.isCurrentExecution(id, correlationID: correlationID) else { return }
    launchPreview = arguments.map(shellDisplay).joined(separator: " ")
    appendConsole(.system, "Prepared a sealed-runtime launch preview.")
    actionCenter.succeed(id, correlationID: correlationID, message: "Launch preview ready")
    statusLine = "Launch preview ready"
    finishLocalActionTask(id, correlationID: correlationID)
  }

  private func failLaunchPreview(
    _ error: Error, id: DesktopUIActionID, correlationID: String
  ) {
    guard actionCenter.isCurrentExecution(id, correlationID: correlationID) else { return }
    let message = error.localizedDescription
    actionCenter.fail(id, correlationID: correlationID, message: message)
    statusLine = message
    appendConsole(.standardError, message)
    finishLocalActionTask(id, correlationID: correlationID)
  }

  var canStartRun: Bool {
    workbenchIsConfigured && !runState.isActive && !isActionLocked(.startRun)
  }

  func startRun() {
    let id = DesktopUIActionID.startRun
    guard requireConfiguredWorkspace(actionID: id) else { return }
    guard !runState.isActive, !isActionLocked(id) else { return }
    let requestID = UUID().uuidString
    let installRoot: URL
    do {
      installRoot = try resolvedInstallRoot()
    } catch {
      return
    }
    let workspaceRoot = projectRoot
    let mode = displayedRuntimeMode
    let thinkingLevel = thinkingLevel
    let timeoutSeconds = timeoutSeconds
    let runtimeBridge = runtimeBridge
    let providerConfiguration: CanvastProviderRuntimeConfiguration
    do {
      providerConfiguration = try resolvedProviderConfiguration()
    } catch {
      return
    }
    let prompt = runPrompt
    guard beginAsyncLocalAction(
      id, correlationID: requestID,
      cancel: { [weak self] in self?.cancelPreparingOrActiveRun(requestID) },
      reconcile: { [weak self] reconciliationID in
        self?.reconcilePersistedState(
          for: .startRun, correlationID: requestID, reconciliationID: reconciliationID
        )
      },
      timeoutSeconds: timeoutSeconds,
      stage: .init(.hostPreparation, label: "Validating sealed runtime")
    ) else { return }
    runState = .preparing
    reserveLocalActionTask(id, correlationID: requestID)
    let preparationTask = Task.detached(priority: .userInitiated) { [weak self] in
      do {
        let plan = try runtimeBridge.makePlan(
          installRoot: installRoot, workspaceRoot: workspaceRoot, mode: mode,
          thinkingLevel: thinkingLevel, timeoutSeconds: timeoutSeconds,
          providerConfiguration: providerConfiguration
        )
        try Task.checkCancellation()
        await self?.commitPreparedRun(
          plan, providerConfiguration: providerConfiguration, prompt: prompt,
          id: id, correlationID: requestID
        )
      } catch is CancellationError {
        return
      } catch {
        await self?.failPreparedRun(error, id: id, correlationID: requestID)
      }
    }
    installLocalActionTask(preparationTask, for: id, correlationID: requestID)
  }

  private func commitPreparedRun(
    _ plan: CanvastLaunchPlan,
    providerConfiguration: CanvastProviderRuntimeConfiguration,
    prompt: String,
    id: DesktopUIActionID,
    correlationID: String
  ) {
    guard actionCenter.isCurrentExecution(id, correlationID: correlationID) else {
      finishLocalActionTask(id, correlationID: correlationID)
      return
    }
    launchPreview = ([plan.executable.path] + plan.arguments).map(shellDisplay).joined(separator: " ")
    actionCenter.heartbeat(
      id, correlationID: correlationID, message: "Starting sealed runtime host",
      token: .hostPreparation
    )
    pendingNativeActionIDs[correlationID] = id
    do {
      try ensureRuntimeHost(providerConfiguration: providerConfiguration, plan: plan)
      guard actionCenter.isCurrentExecution(id, correlationID: correlationID) else {
        discardNativeRequest(correlationID)
        finishLocalActionTask(id, correlationID: correlationID)
        return
      }
      activeRunRequestID = correlationID
      pendingNativeCommands[correlationID] = "prompt"
      try runtimeBridge.sendPrompt(prompt, requestID: correlationID)
      beginLiveSessionTurn(requestID: correlationID, prompt: prompt)
      actionCenter.markDispatched(id, correlationID: correlationID, message: "Prompt sent to runtime")
      if pendingNativeActionIDs[correlationID] == id {
        actionCenter.markWaiting(id, correlationID: correlationID, message: "Waiting for runtime reply")
      }
      statusLine = "Prompt submitted to the Canvast RPC session"
      appendConsole(.system, "Prompt submitted in \(projectRoot.lastPathComponent).")
    } catch let dispatchError as DesktopActionDispatchError {
      settlePreparedRunDispatchFailure(dispatchError, id: id, correlationID: correlationID)
    } catch {
      discardNativeRequest(correlationID)
      activeRunRequestID = nil
      runState = .failed("Run failed to start")
      let message = error.localizedDescription
      actionCenter.fail(id, correlationID: correlationID, message: message)
      statusLine = message
      appendConsole(.standardError, message)
    }
    finishLocalActionTask(id, correlationID: correlationID)
  }

  private func settlePreparedRunDispatchFailure(
    _ error: DesktopActionDispatchError, id: DesktopUIActionID, correlationID: String
  ) {
    let message = error.localizedDescription
    switch error {
    case .notDispatched:
      discardNativeRequest(correlationID)
      activeRunRequestID = nil
      runState = .failed("Run failed to start")
      actionCenter.fail(id, correlationID: correlationID, message: message)
    case .outcomeUnknown:
      actionCenter.markDispatched(id, correlationID: correlationID, message: "Prompt write outcome is unknown")
      actionCenter.markOutcomeUnknown(id, correlationID: correlationID, message: message)
    }
    statusLine = message
    appendConsole(.standardError, message)
  }

  private func failPreparedRun(
    _ error: Error, id: DesktopUIActionID, correlationID: String
  ) {
    guard actionCenter.isCurrentExecution(id, correlationID: correlationID) else { return }
    let message = error.localizedDescription
    actionCenter.fail(id, correlationID: correlationID, message: message)
    runState = .failed("Run failed to start")
    statusLine = message
    appendConsole(.standardError, message)
    finishLocalActionTask(id, correlationID: correlationID)
  }

  private func cancelPreparingOrActiveRun(_ correlationID: String) {
    if activeRunRequestID == correlationID || pendingNativeActionIDs[correlationID] == .startRun {
      stopRun()
      return
    }
    cancelLocalActionTask(.startRun, correlationID: correlationID)
    guard actionCenter.isCurrentExecution(.startRun, correlationID: correlationID) else { return }
    actionCenter.cancel(.startRun, correlationID: correlationID, message: "Run preparation cancelled")
    runState = .idle
    statusLine = "Run preparation cancelled"
  }

  var canStopRun: Bool {
    runState.isActive && !isActionLocked(.stopRun)
  }

  func stopRun() {
    guard canStopRun else { return }
    let requestID = UUID().uuidString
    let targetRunRequestID = activeRunRequestID
    if beginNativeRPCAction(
      .stopRun,
      correlationID: requestID,
      lastStableState: targetRunRequestID,
      reconcile: { [weak self] reconciliationID in
        self?.reconcilePersistedState(for: .stopRun, correlationID: requestID, reconciliationID: reconciliationID)
      },
      operation: {
        runState = .stopping
        statusLine = "Stopping Canvast run"
        appendConsole(.system, "Stop requested.")
        if let targetRunRequestID { pendingAbortTargets[requestID] = targetRunRequestID }
        pendingNativeCommands[requestID] = "abort"
        try runtimeBridge.abort(requestID: requestID)
      }
    ) == false {
      if let snapshot = actionSnapshot(.stopRun),
         snapshot.correlationID == requestID, snapshot.status != .outcomeUnknown {
        pendingNativeCommands.removeValue(forKey: requestID)
        pendingAbortTargets.removeValue(forKey: requestID)
        runState = targetRunRequestID != nil && activeRunRequestID == targetRunRequestID
          ? .running
          : .failed("Stop failed")
      }
    }
  }

  func shutdownRuntimeHost() {
    activeRunRequestID = nil
    activeRuntimeConfigurationSignature = nil
    runtimeBridge.stopHost()
  }

  func sendRunningInput(_ message: String, mode: RunningInputMode) {
    let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    let policy: CanvastRuntimeRequestControlPolicy = switch mode {
    case .followUp: .sidecar
    case .steer: .redirect
    }
    sendRequestControl(trimmed, policy: policy)
  }

  func sendRequestControl(_ text: String, policy: CanvastRuntimeRequestControlPolicy) {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      statusLine = "Request control text is required"
      return
    }
    let requestID = UUID().uuidString
    let action = CanvastDesktopAction(
      requestID: requestID,
      workspace: .run, kind: .requestControl, featureID: .chat,
      arguments: ["policy": .string(policy.rawValue), "text": .string(trimmed)]
    )
    let dispatched = executeAction(.init(
      requestID: action.requestID,
      workspace: action.workspace, kind: action.kind, featureID: action.featureID,
      arguments: action.arguments
    ), label: "\(policy.rawValue) request control", uiActionID: .sendRequestControl)
    if dispatched {
      beginLiveSessionTurn(requestID: requestID, prompt: trimmed, expectsAssistant: false)
    }
  }

  func createPlan(title: String) {
    executeAction(.init(
      workspace: .planning, kind: .createPlan, featureID: .planMode,
      arguments: ["title": .string(title), "goal": .string(title)]
    ), label: "plan creation", uiActionID: .createPlan)
  }

  func updatePlan(id: String, status: String) {
    executeAction(.init(
      workspace: .planning, kind: .updatePlan, featureID: .planMode,
      arguments: ["id": .string(id), "planId": .string(id), "status": .string(status)]
    ), label: "plan update", uiActionID: .updatePlan)
  }

  func approvePlan(notes: String? = nil) {
    guard guardCurrentPlanLifecycle(.approvePlan, operation: "approve") else { return }
    executeAction(.init(
      workspace: .planning, kind: .approvePlan, featureID: .planMode,
      arguments: optionalStringArguments("notes", notes)
    ), label: "plan approval", uiActionID: .approvePlan)
  }

  func completePlan(summary: String? = nil) {
    guard guardCurrentPlanLifecycle(.completePlan, operation: "complete") else { return }
    executeAction(.init(
      workspace: .planning, kind: .completePlan, featureID: .planMode,
      arguments: optionalStringArguments("summary", summary)
    ), label: "plan completion", uiActionID: .completePlan)
  }

  @discardableResult
  private func guardCurrentPlanLifecycle(_ id: DesktopUIActionID, operation: String) -> Bool {
    guard !hasCurrentPlanLifecycle else { return true }
    let message = "Cannot \(operation) a plan because there is no current plan. Create a plan first."
    let correlationID = UUID().uuidString
    switch actionCenter.begin(
      spec: DesktopActionRegistry.spec(for: id), correlationID: correlationID,
      stage: .init(.localState, label: "Validating current plan")
    ) {
    case .locked(_, let lockMessage):
      statusLine = lockMessage
      appendConsole(.system, lockMessage)
    case .started:
      actionCenter.fail(
        id, correlationID: correlationID, message: message,
        stage: .init(.complete, label: "Current plan required", detail: message)
      )
      statusLine = message
      appendConsole(.standardError, message)
    }
    return false
  }

  func createTask(subject: String) {
    executeAction(.init(
      workspace: .planning, kind: .createTask, featureID: .taskTree,
      arguments: ["subject": .string(subject), "title": .string(subject), "status": .string("pending")]
    ), label: "task creation", uiActionID: .createTask)
  }

  func updateTask(id: String, status: String) {
    executeAction(.init(
      workspace: .planning, kind: .updateTask, featureID: .taskTree,
      arguments: ["id": .string(id), "taskId": .string(id), "status": .string(status)]
    ), label: "task update", uiActionID: .updateTask)
  }

  func launchAgent(task: String) {
    executeAction(.init(
      workspace: .orchestration, kind: .spawnAgent, featureID: .subAgents,
      arguments: ["task": .string(task), "agentType": .string("general-purpose")]
    ), label: "agent launch", uiActionID: .launchAgent)
  }

  func cancelAgent(id: String) {
    executeAction(.init(
      workspace: .orchestration, kind: .cancelAgent, featureID: .subAgents,
      arguments: ["id": .string(id), "agentId": .string(id)]
    ), label: "agent cancellation")
  }

  func followUpAgent(id: String, message: String) {
    executeAction(.init(
      workspace: .orchestration, kind: .followUpAgent, featureID: .subAgents,
      arguments: ["id": .string(id), "agentId": .string(id), "message": .string(message)]
    ), label: "agent follow-up")
  }

  func launchWorkflow(goal: String) {
    executeAction(.init(
      workspace: .orchestration, kind: .runWorkflow, featureID: .workflow,
      arguments: ["goal": .string(goal), "name": .string(goal)]
    ), label: "workflow launch", uiActionID: .launchWorkflow)
  }

  func cancelWorkflow(id: String) {
    executeAction(.init(
      workspace: .orchestration, kind: .cancelWorkflow, featureID: .workflow,
      arguments: ["id": .string(id), "workflowId": .string(id)]
    ), label: "workflow cancellation")
  }

  func followUpWorkflow(id: String, message: String) {
    executeAction(.init(
      workspace: .orchestration, kind: .followUpWorkflow, featureID: .workflow,
      arguments: ["id": .string(id), "workflowId": .string(id), "message": .string(message)]
    ), label: "workflow follow-up")
  }

  func selectCanvasTask(nodeID: String) {
    executeAction(.init(
      workspace: .canvas, kind: .selectCanvasTask, featureID: .canvas,
      arguments: ["nodeId": .string(nodeID)]
    ), label: "Canvas task selection", uiActionID: .selectCanvasTask)
  }

  func selectCanvasPlan(planID: String) {
    executeAction(.init(
      workspace: .planning, kind: .selectCanvasPlan, featureID: .planMode,
      arguments: ["planId": .string(planID)]
    ), label: "Canvas plan selection", uiActionID: .selectCanvasPlan)
  }

  func inspectProjectScope() {
    executeAction(.init(
      workspace: .project, kind: .inspectProjectScope, featureID: .sessions
    ), label: "project scope inspection", uiActionID: .inspectProjectScope)
  }

  func rebindProjectScope() {
    executeAction(.init(
      workspace: .project, kind: .rebindProjectScope, featureID: .sessions
    ), label: "project scope rebind", uiActionID: .rebindProjectScope)
  }

  func inspectSandbox() {
    executeAction(.init(
      workspace: .safety, kind: .inspectSandbox, featureID: .sandbox
    ), label: "sandbox inspection", uiActionID: .inspectSandbox)
  }

  func setSandboxProfile(_ profile: String) {
    executeAction(.init(
      workspace: .safety, kind: .setSandboxProfile, featureID: .sandbox,
      arguments: ["profile": .string(profile)]
    ), label: "sandbox profile", uiActionID: .setSandboxProfile)
  }

  func grantSandboxCommand(_ command: String, scope: String, reason: String? = nil) {
    var arguments = optionalStringArguments("reason", reason)
    arguments["command"] = .string(command)
    arguments["scope"] = .string(scope)
    executeAction(.init(
      workspace: .safety, kind: .grantSandboxAccess, featureID: .sandbox, arguments: arguments
    ), label: "sandbox command grant", uiActionID: .grantSandboxAccess)
  }

  func grantSandboxPath(_ path: String, access: String, scope: String, reason: String? = nil) {
    var arguments = optionalStringArguments("reason", reason)
    arguments["path"] = .string(path)
    arguments["access"] = .string(access)
    arguments["scope"] = .string(scope)
    executeAction(.init(
      workspace: .safety, kind: .grantSandboxAccess, featureID: .sandbox, arguments: arguments
    ), label: "sandbox path grant", uiActionID: .grantSandboxAccess)
  }

  func setPermissionMode(_ mode: String) {
    executeAction(.init(
      workspace: .safety, kind: .setPermissionMode, featureID: .permissions,
      arguments: ["mode": .string(mode)]
    ), label: "permission mode", uiActionID: .setPermissionMode)
  }

  func startNewSession() {
    executeAction(.init(
      workspace: .project, kind: .newSession, featureID: .sessions
    ), label: "new session", uiActionID: .startNewSession)
  }

  func restartProjectRuntime() {
    executeAction(.init(
      workspace: .project, kind: .projectRestart, featureID: .sessions,
      arguments: ["reload": .boolean(true)]
    ), label: "project runtime restart", uiActionID: .restartProjectRuntime)
  }

  func clearConsole() {
    guard !runState.isActive else {
      statusLine = "Stop the active run before clearing its console."
      return
    }
    performLocalAction(.clearConsole, retry: { [weak self] in self?.clearConsole() }) {
      consoleEntries.removeAll()
      outputBuffers.removeAll()
      liveSessionMessages.removeAll()
      liveSessionBaselineEntryCounts.removeAll()
      liveSessionRequestAliases.removeAll()
      launchPreview = nil
      return "Console cleared"
    }
  }
}
