import Foundation
import Darwin

public enum CanvastBridgeError: Error, Equatable {
  case missingLauncher(URL)
  case invalidWorkspace(URL)
  case processAlreadyRunning
  case noRunningProcess
  case invalidRPCPayload
}

public enum CanvastBridgeDeliveryState: String, Equatable {
  case notDispatched = "not_dispatched"
  case unknownAfterWrite = "unknown_after_write"
}

public struct CanvastBridgeSendError: Error {
  public let underlying: Error
  public let deliveryState: CanvastBridgeDeliveryState

  public init(underlying: Error, deliveryState: CanvastBridgeDeliveryState) {
    self.underlying = underlying
    self.deliveryState = deliveryState
  }
}

extension CanvastBridgeSendError: LocalizedError {
  public var errorDescription: String? { underlying.localizedDescription }
}

public struct CanvastLaunchPlan: Equatable, CustomStringConvertible, CustomDebugStringConvertible {
  public let executable: URL
  public let arguments: [String]
  public let environment: [String: String]
  public let workingDirectory: URL

  public init(executable: URL, arguments: [String], environment: [String: String], workingDirectory: URL) {
    self.executable = executable
    self.arguments = arguments
    self.environment = environment
    self.workingDirectory = workingDirectory
  }

  public var description: String {
    "CanvastLaunchPlan(executable: \(executable.path), arguments: \(arguments), " +
      "environmentKeys: \(environment.keys.sorted()), workingDirectory: \(workingDirectory.path))"
  }

  public var debugDescription: String { description }
}

public enum CanvastProcessPhase: String, Codable, Equatable {
  case idle
  case starting
  case running
  case stopping
  case succeeded
  case failed
  case terminated
}

public struct CanvastProcessSnapshot: Equatable {
  public let runID: UUID?
  public let phase: CanvastProcessPhase
  public let output: String
  public let errorOutput: String
  public let exitCode: Int32?
  public let startedAt: Date?
  public let completedAt: Date?

  public init(
    runID: UUID?, phase: CanvastProcessPhase, output: String, errorOutput: String,
    exitCode: Int32?, startedAt: Date?, completedAt: Date?
  ) {
    self.runID = runID
    self.phase = phase
    self.output = output
    self.errorOutput = errorOutput
    self.exitCode = exitCode
    self.startedAt = startedAt
    self.completedAt = completedAt
  }

  public static let idle = CanvastProcessSnapshot(
    runID: nil, phase: .idle, output: "", errorOutput: "",
    exitCode: nil, startedAt: nil, completedAt: nil
  )
}

public enum CanvastRPCEventKind: String, Equatable {
  case response
  case agentStarted
  case agentSettled
  case textDelta
  case processUpdate
  case messageCompleted
  case actionResult
  case notification
  case protocolError
}

public struct CanvastRPCEvent: Equatable {
  public let kind: CanvastRPCEventKind
  public let requestID: String?
  public let command: String?
  public let success: Bool?
  public let text: String?
  public let effectiveThinkingLevel: String?
  public let actionResult: CanvastDesktopActionResult?
  public let rawLine: String

  public init(
    kind: CanvastRPCEventKind, requestID: String? = nil, command: String? = nil,
    success: Bool? = nil, text: String? = nil, effectiveThinkingLevel: String? = nil,
    actionResult: CanvastDesktopActionResult? = nil, rawLine: String = ""
  ) {
    self.kind = kind
    self.requestID = requestID
    self.command = command
    self.success = success
    self.text = text
    self.effectiveThinkingLevel = effectiveThinkingLevel
    self.actionResult = actionResult
    self.rawLine = rawLine
  }
}

public enum CanvastBridgeEvent: Equatable {
  case process(CanvastProcessSnapshot)
  case rpc(CanvastRPCEvent)
}

public protocol CanvastDesktopActionExecuting: AnyObject {
  var processSnapshot: CanvastProcessSnapshot { get }
  @discardableResult func observe(_ observer: @escaping (CanvastBridgeEvent) -> Void) -> UUID
  func removeObserver(_ token: UUID)
  func start(plan: CanvastLaunchPlan) throws
  func execute(
    action: CanvastDesktopAction, installRoot: URL, workspaceRoot: URL,
    mode: CanvastRuntimeMode, thinkingLevel: String?,
    providerConfiguration: CanvastProviderRuntimeConfiguration?
  ) throws
  func sendPrompt(_ message: String, requestID: String) throws
  func sendSteer(_ message: String, requestID: String) throws
  func sendFollowUp(_ message: String, requestID: String) throws
  func abort(requestID: String) throws
  func newSession(requestID: String) throws
  func setThinkingLevel(_ level: String, requestID: String) throws
  func discardPromptRequest(_ requestID: String)
  func stop()
}

public final class CanvastBridge: CanvastDesktopActionExecuting {
  private struct PromptCorrelation: Equatable {
    let requestID: String
    let runID: UUID
  }

  private let fileManager: FileManager
  private let lock = NSLock()
  private var process: Process?
  private var standardInputPipe: Pipe?
  private var standardOutputPipe: Pipe?
  private var standardErrorPipe: Pipe?
  private var stdoutBuffer = Data()
  private var currentSnapshot: CanvastProcessSnapshot = .idle
  private var observers: [UUID: (CanvastBridgeEvent) -> Void] = [:]
  private var pendingPromptRequests: [PromptCorrelation] = []
  private var activePromptRequest: PromptCorrelation?
  private var settledAgentResult: (correlation: PromptCorrelation?, success: Bool, message: String?)?
  private let terminationGracePeriod: TimeInterval
  private let interruptionGracePeriod: TimeInterval
  private let killVerificationDelay: TimeInterval

  public init(
    fileManager: FileManager = .default,
    terminationGracePeriod: TimeInterval = 2,
    interruptionGracePeriod: TimeInterval = 2,
    killVerificationDelay: TimeInterval = 1
  ) {
    self.fileManager = fileManager
    self.terminationGracePeriod = terminationGracePeriod
    self.interruptionGracePeriod = interruptionGracePeriod
    self.killVerificationDelay = killVerificationDelay
  }

  deinit { stop() }

  public var processSnapshot: CanvastProcessSnapshot { lock.withLock { currentSnapshot } }
  public var isRunning: Bool {
    lock.withLock { process?.isRunning == true }
  }

  @discardableResult
  public func observe(_ observer: @escaping (CanvastBridgeEvent) -> Void) -> UUID {
    let token = UUID()
    let snapshot = lock.withLock { () -> CanvastProcessSnapshot in
      observers[token] = observer
      return currentSnapshot
    }
    observer(.process(snapshot))
    return token
  }

  public func removeObserver(_ token: UUID) {
    _ = lock.withLock { observers.removeValue(forKey: token) }
  }

  public func buildLaunchPlan(
    installRoot: URL, workspaceRoot: URL, prompt _: String = "", mode: CanvastRuntimeMode,
    thinkingLevel: String? = nil, timeoutSeconds _: Int = 900,
    providerConfiguration: CanvastProviderRuntimeConfiguration? = nil
  ) throws -> CanvastLaunchPlan {
    let location = try CanvastRuntimeLocator(
      bundleResourceURL: nil, developmentInstallRoot: installRoot, fileManager: fileManager
    ).locate()
    let workspace = workspaceRoot.standardizedFileURL.resolvingSymlinksInPath()
    var isDirectory: ObjCBool = false
    guard fileManager.fileExists(atPath: workspace.path, isDirectory: &isDirectory), isDirectory.boolValue else {
      throw CanvastBridgeError.invalidWorkspace(workspace)
    }
    let product = location.installRoot.appendingPathComponent("package", isDirectory: true)
    let componentPath = product.appendingPathComponent("components/bin", isDirectory: true).path
    let runtimeBinPath = location.installRoot.appendingPathComponent("bin", isDirectory: true).path
    var env = try CanvastSealedEnvironment.applying(
      to: ProcessInfo.processInfo.environment, runtimeRoot: location.installRoot,
      fileManager: fileManager
    )
    env["CANVAST_UNATTENDED"] = "1"
    env["CANVAST_UNATTENDED_GUI_TEST"] = "1"
    env["CANVAST_MODE"] = mode.rawValue
    env["CANVAST_INSTALL_DIR"] = product.path
    env["CANVAST_WORKING_DIR"] = workspace.path
    env["CANVAST_PROJECT_ROOT"] = workspace.path
    env["CANVAST_COMPONENTS_DIR"] = product.appendingPathComponent("components", isDirectory: true).path
    env["CANVAST_COMPONENT_BIN_DIR"] = componentPath
    env["PI_OFFLINE"] = "1"
    env.removeValue(forKey: "CANVAST_ALLOW_COMPONENT_AUTO_DOWNLOAD")
    if let providerConfiguration {
      env = providerConfiguration.applying(to: env)
    }
    let currentPath = env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
    let existingPath = currentPath.split(separator: ":").map(String.init)
    env["PATH"] = ([runtimeBinPath, componentPath] + existingPath.filter {
      $0 != runtimeBinPath && $0 != componentPath
    }).joined(separator: ":")
    var args = [location.coreEntrypoint.path]
    for extensionURL in location.extensionURLs {
      args.append(contentsOf: ["--extension", extensionURL.path])
    }
    if let thinkingLevel, !thinkingLevel.isEmpty { args.append(contentsOf: ["--thinking", thinkingLevel]) }
    args.append(contentsOf: ["--offline", "--mode", "rpc"])
    return CanvastLaunchPlan(
      executable: location.node, arguments: args, environment: env, workingDirectory: workspace
    )
  }

  public func buildLaunchPlan(
    installRoot: URL, workspaceRoot: URL, action _: CanvastDesktopAction, mode: CanvastRuntimeMode,
    thinkingLevel: String? = nil, timeoutSeconds: Int = 900,
    providerConfiguration: CanvastProviderRuntimeConfiguration? = nil
  ) throws -> CanvastLaunchPlan {
    try buildLaunchPlan(
      installRoot: installRoot, workspaceRoot: workspaceRoot, mode: mode, thinkingLevel: thinkingLevel,
      timeoutSeconds: timeoutSeconds, providerConfiguration: providerConfiguration
    )
  }

  public func execute(
    action: CanvastDesktopAction, installRoot: URL, workspaceRoot: URL,
    mode: CanvastRuntimeMode, thinkingLevel: String?,
    providerConfiguration: CanvastProviderRuntimeConfiguration? = nil
  ) throws {
    if !isRunning {
      try start(plan: buildLaunchPlan(
        installRoot: installRoot, workspaceRoot: workspaceRoot, mode: mode,
        thinkingLevel: thinkingLevel, providerConfiguration: providerConfiguration
      ))
    }
    try send(action: action)
  }

  public func start(plan: CanvastLaunchPlan) throws {
    guard !isRunning else { throw CanvastBridgeError.processAlreadyRunning }
    let runID = UUID()
    let inputPipe = Pipe()
    let outputPipe = Pipe()
    let errorPipe = Pipe()
    let next = Process()
    next.executableURL = plan.executable
    next.arguments = plan.arguments
    next.environment = plan.environment
    next.currentDirectoryURL = plan.workingDirectory
    next.standardInput = inputPipe
    next.standardOutput = outputPipe
    next.standardError = errorPipe
    outputPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
      self?.consumeStdout(handle.availableData, runID: runID)
    }
    errorPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
      self?.appendStderr(handle.availableData, runID: runID)
    }
    next.terminationHandler = { [weak self] finished in self?.finish(process: finished, runID: runID) }
    let startedAt = Date()
    lock.withLock {
      process = next
      standardInputPipe = inputPipe
      standardOutputPipe = outputPipe
      standardErrorPipe = errorPipe
      stdoutBuffer.removeAll(keepingCapacity: true)
      clearPromptCorrelationsLocked()
    }
    publish(CanvastProcessSnapshot(
      runID: runID, phase: .starting, output: "", errorOutput: "",
      exitCode: nil, startedAt: startedAt, completedAt: nil
    ))
    do {
      try next.run()
      if lock.withLock({ process === next }) { updatePhase(.running) }
    } catch {
      outputPipe.fileHandleForReading.readabilityHandler = nil
      errorPipe.fileHandleForReading.readabilityHandler = nil
      lock.withLock {
        if process === next { process = nil }
        standardInputPipe = nil
        standardOutputPipe = nil
        standardErrorPipe = nil
        clearPromptCorrelationsLocked(runID: runID)
      }
      publish(CanvastProcessSnapshot(
        runID: runID, phase: .failed, output: "", errorOutput: String(describing: error),
        exitCode: nil, startedAt: startedAt, completedAt: Date()
      ))
      throw error
    }
  }

  public func sendPrompt(_ message: String, requestID: String = UUID().uuidString) throws {
    let registered = lock.withLock { () -> Bool in
      guard process?.isRunning == true, let runID = currentSnapshot.runID else { return false }
      pendingPromptRequests.append(PromptCorrelation(requestID: requestID, runID: runID))
      return true
    }
    guard registered else {
      throw CanvastBridgeSendError(
        underlying: CanvastBridgeError.noRunningProcess,
        deliveryState: .notDispatched
      )
    }
    do {
      try sendJSONObject(["id": requestID, "type": "prompt", "message": message])
    } catch {
      if (error as? CanvastBridgeSendError)?.deliveryState == .notDispatched {
        discardPromptRequest(requestID)
      }
      throw error
    }
  }

  public func sendSteer(_ message: String, requestID: String = UUID().uuidString) throws {
    try sendJSONObject(["id": requestID, "type": "steer", "message": message])
  }

  public func sendFollowUp(_ message: String, requestID: String = UUID().uuidString) throws {
    try sendJSONObject(["id": requestID, "type": "follow_up", "message": message])
  }

  public func abort(requestID: String = UUID().uuidString) throws {
    try sendJSONObject(["id": requestID, "type": "abort"])
  }

  public func newSession(requestID: String = UUID().uuidString) throws {
    try sendJSONObject(["id": requestID, "type": "new_session"])
  }

  public func setThinkingLevel(_ level: String, requestID: String = UUID().uuidString) throws {
    try sendJSONObject(["id": requestID, "type": "set_thinking_level", "level": level])
  }

  public func getState(requestID: String = UUID().uuidString) throws {
    try sendJSONObject(["id": requestID, "type": "get_state"])
  }

  public func discardPromptRequest(_ requestID: String) {
    lock.withLock { discardPromptRequestLocked(requestID) }
  }

  public func send(action: CanvastDesktopAction) throws {
    guard action.kind.usesDesktopDispatcher else { throw CanvastBridgeError.invalidRPCPayload }
    let encoded = try JSONEncoder().encode(action)
    guard let payload = String(data: encoded, encoding: .utf8) else { throw CanvastBridgeError.invalidRPCPayload }
    try sendJSONObject([
      "id": action.requestID,
      "type": "prompt",
      "message": "/canvast-action \(payload)",
    ])
  }

  public func stop() {
    let target = lock.withLock { (process, standardInputPipe?.fileHandleForWriting) }
    guard let running = target.0 else { return }
    updatePhase(.stopping)
    target.1?.closeFile()
    let pid = running.processIdentifier
    if running.isRunning {
      if pid > 0 {
        _ = Darwin.kill(-pid, SIGTERM)
      }
      running.terminate()
    }
    DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + terminationGracePeriod) { [weak self, weak running] in
      guard let self, let running, running.isRunning, self.lock.withLock({ self.process === running }) else { return }
      let pid = running.processIdentifier
      if pid > 0 {
        _ = Darwin.kill(-pid, SIGINT)
      }
      running.interrupt()
      DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + self.interruptionGracePeriod) { [weak self, weak running] in
        guard let self, let running, running.isRunning, self.lock.withLock({ self.process === running }) else { return }
        let pid = running.processIdentifier
        guard pid > 0 else {
          self.reportStopFailure(for: running, detail: "Runtime host process id was unavailable during forced stop.")
          return
        }
        guard Darwin.kill(-pid, SIGKILL) == 0 || Darwin.kill(pid, SIGKILL) == 0 else {
          self.reportStopFailure(for: running, detail: "Failed to deliver SIGKILL to runtime host/process group (errno \(errno)).")
          return
        }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + self.killVerificationDelay) { [weak self, weak running] in
          guard let self, let running, running.isRunning, self.lock.withLock({ self.process === running }) else { return }
          self.reportStopFailure(for: running, detail: "Runtime host remained alive after TERM, INT, and KILL escalation.")
        }
      }
    }
  }

  public func resetCompletedRun() {
    guard !isRunning else { return }
    publish(.idle)
  }

  private func sendJSONObject(_ object: [String: Any]) throws {
    guard JSONSerialization.isValidJSONObject(object) else {
      throw CanvastBridgeSendError(underlying: CanvastBridgeError.invalidRPCPayload, deliveryState: .notDispatched)
    }
    let dataValue: Data
    do {
      dataValue = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    } catch {
      throw CanvastBridgeSendError(underlying: error, deliveryState: .notDispatched)
    }
    var data = dataValue
    data.append(0x0A)
    guard let handle = lock.withLock({ standardInputPipe?.fileHandleForWriting }), isRunning else {
      throw CanvastBridgeSendError(underlying: CanvastBridgeError.noRunningProcess, deliveryState: .notDispatched)
    }
    do {
      try handle.write(contentsOf: data)
    } catch {
      throw CanvastBridgeSendError(underlying: error, deliveryState: .unknownAfterWrite)
    }
  }

  private func consumeStdout(_ data: Data, runID: UUID) {
    guard !data.isEmpty else { return }
    let lines: [Data] = lock.withLock {
      guard currentSnapshot.runID == runID else { return [] }
      stdoutBuffer.append(data)
      var complete: [Data] = []
      while let newline = stdoutBuffer.firstIndex(of: 0x0A) {
        complete.append(stdoutBuffer.prefix(upTo: newline))
        stdoutBuffer.removeSubrange(...newline)
      }
      return complete
    }
    for lineData in lines { consumeRPCLine(lineData, runID: runID) }
  }

  private func consumeRPCLine(_ rawData: Data, runID: UUID) {
    var data = rawData
    if data.last == 0x0D { data.removeLast() }
    guard !data.isEmpty, let line = String(data: data, encoding: .utf8) else { return }
    guard appendOutput(line + "\n", runID: runID) else { return }
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let type = object["type"] as? String else {
      publish(.rpc(CanvastRPCEvent(
        kind: .protocolError, requestID: nil, command: nil, success: false,
        text: "Non-JSON output from RPC host: \(line)", actionResult: nil, rawLine: line
      )))
      return
    }
    if type == "extension_ui_request" {
      handleExtensionUIRequest(object, rawLine: line)
      return
    }
    if let result = decodeActionResult(from: object) {
      guard result.protocolVersion == CanvastDesktopAction.currentProtocolVersion else {
        publish(.rpc(CanvastRPCEvent(
          kind: .protocolError, requestID: result.requestID, command: "canvast-action", success: false,
          text: "Unsupported desktop action protocol version \(result.protocolVersion).",
          actionResult: nil, rawLine: line
        )))
        return
      }
      publish(.rpc(CanvastRPCEvent(
        kind: .actionResult, requestID: result.requestID, command: "canvast-action",
        success: result.status == .succeeded, text: result.error?.message, actionResult: result, rawLine: line
      )))
      return
    }
    if desktopActionResultMessage(from: object) != nil {
      publish(.rpc(CanvastRPCEvent(
        kind: .protocolError, requestID: desktopActionResultRequestID(from: object),
        command: "canvast-action", success: false,
        text: "The runtime returned an invalid desktop action result.",
        actionResult: nil, rawLine: line
      )))
      return
    }
    let event: CanvastRPCEvent
    let eventRequestID = eventRequestID(from: object)
    switch type {
    case "response":
      let responseData = object["data"] as? [String: Any]
      let wasCancelled = responseData?["cancelled"] as? Bool == true
      let requestID = object["id"] as? String
      let success = (object["success"] as? Bool) == true && !wasCancelled
      if !success, let requestID { discardPromptRequest(requestID) }
      event = CanvastRPCEvent(
        kind: .response, requestID: requestID, command: object["command"] as? String,
        success: success,
        text: wasCancelled ? "The runtime cancelled this session change." : object["error"] as? String,
        effectiveThinkingLevel: responseData?["thinkingLevel"] as? String,
        actionResult: nil, rawLine: line
      )
    case "agent_start":
      let requestID = lock.withLock { () -> String? in
        let index = pendingPromptRequests.firstIndex { $0.runID == runID }
        let correlation = index.map { pendingPromptRequests.remove(at: $0) }
        activePromptRequest = correlation
        settledAgentResult = nil
        return correlation?.requestID
      }
      event = CanvastRPCEvent(kind: .agentStarted, requestID: requestID, command: nil, success: nil, text: nil, actionResult: nil, rawLine: line)
    case "agent_end":
      let terminal = agentTerminalResult(object)
      lock.withLock {
        settledAgentResult = (activePromptRequest, terminal.success, terminal.message)
      }
      return
    case "agent_settled":
      let terminal = lock.withLock { () -> (String?, Bool, String?) in
        let value = settledAgentResult ??
          (correlation: activePromptRequest, success: true, message: nil)
        activePromptRequest = nil
        settledAgentResult = nil
        return (value.correlation?.requestID, value.success, value.message)
      }
      event = CanvastRPCEvent(
        kind: .agentSettled, requestID: terminal.0, command: nil,
        success: terminal.1, text: terminal.2, actionResult: nil, rawLine: line
      )
    case "message_update":
      let delta = object["assistantMessageEvent"] as? [String: Any]
      let updateType = delta?["type"] as? String ?? "message_update"
      if updateType.hasPrefix("thinking") || updateType == "toolcall_delta" { return }
      if updateType == "text_delta" {
        event = CanvastRPCEvent(
          kind: .textDelta, requestID: eventRequestID, command: nil, success: nil,
          text: delta?["delta"] as? String, actionResult: nil, rawLine: line
        )
      } else {
        guard let summary = visibleProcessSummary(from: object, fallbackType: updateType) else { return }
        event = CanvastRPCEvent(
          kind: .processUpdate, requestID: eventRequestID, command: updateType, success: nil,
          text: summary, actionResult: nil, rawLine: line
        )
      }
    case "message_end":
      guard let message = object["message"] as? [String: Any] else { return }
      let role = message["role"] as? String ?? ""
      if role == "assistant", let text = visibleMessageText(message), !text.isEmpty {
        event = CanvastRPCEvent(
          kind: .messageCompleted, requestID: eventRequestID, command: "message_end", success: true,
          text: text, actionResult: nil, rawLine: line
        )
      } else {
        guard let summary = visibleProcessSummary(from: object, fallbackType: "message_end") else { return }
        event = CanvastRPCEvent(
          kind: .processUpdate, requestID: eventRequestID, command: "message_end", success: nil,
          text: summary, actionResult: nil, rawLine: line
        )
      }
    case "tool_execution_start", "tool_execution_update", "tool_execution_end":
      guard let summary = visibleProcessSummary(from: object, fallbackType: type) else { return }
      event = CanvastRPCEvent(
        kind: .processUpdate, requestID: eventRequestID, command: type, success: nil,
        text: summary, actionResult: nil, rawLine: line
      )
    case "extension_error":
      event = CanvastRPCEvent(
        kind: .protocolError, requestID: nil, command: nil, success: false,
        text: object["error"] as? String ?? "An extension failed.", actionResult: nil, rawLine: line
      )
    default:
      return
    }
    publish(.rpc(event))
  }

  private func eventRequestID(from object: [String: Any]) -> String? {
    firstNonemptyString(
      object["requestId"], object["requestID"], object["request_id"],
      object["rootRequestId"], object["rootRequestID"], object["root_request_id"],
      (object["assistantMessageEvent"] as? [String: Any])?["requestId"],
      (object["assistantMessageEvent"] as? [String: Any])?["requestID"],
      (object["assistantMessageEvent"] as? [String: Any])?["request_id"],
      (object["message"] as? [String: Any])?["requestId"],
      (object["message"] as? [String: Any])?["requestID"],
      (object["message"] as? [String: Any])?["request_id"]
    )
  }

  private func visibleProcessSummary(from object: [String: Any], fallbackType: String) -> String? {
    var lines: [String] = []
    let eventType = fallbackType.replacingOccurrences(of: "_", with: " ")
    let toolName = firstNonemptyString(
      object["toolName"], object["tool"], object["name"],
      (object["assistantMessageEvent"] as? [String: Any])?["name"]
    )
    let status = firstNonemptyString(object["status"], object["state"], object["phase"])
    let title = [toolName, status].compactMap { $0 }.joined(separator: " - ")
    lines.append(title.isEmpty ? eventType : "\(eventType): \(title)")
    if let command = firstNonemptyString(object["command"], object["cmd"]) {
      lines.append("command: \(compactVisibleText(command, limit: 240))")
    }
    if let args = object["args"], let text = compactJSONSummary(args, limit: 360) {
      lines.append("args: \(text)")
    }
    if let partial = object["partialResult"], let text = visibleText(from: partial), !text.isEmpty {
      lines.append(compactVisibleText(text, limit: 600))
    } else if let result = object["result"], let text = visibleText(from: result), !text.isEmpty {
      lines.append(compactVisibleText(text, limit: 600))
    } else if let message = object["message"], let text = visibleText(from: message), !text.isEmpty {
      lines.append(compactVisibleText(text, limit: 600))
    } else if let text = firstNonemptyString(object["summary"], object["text"], object["delta"]) {
      lines.append(compactVisibleText(text, limit: 600))
    }
    let summary = lines
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
      .joined(separator: "\n")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return summary.isEmpty ? nil : summary
  }

  private func visibleMessageText(_ message: [String: Any]) -> String? {
    visibleText(from: message["content"])?.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private func visibleText(from value: Any?) -> String? {
    if let text = value as? String { return text }
    if let values = value as? [Any] {
      let joined = values.compactMap { item -> String? in
        if let text = item as? String { return text }
        guard let object = item as? [String: Any] else { return nil }
        if object["type"] as? String == "thinking" { return nil }
        if let text = object["text"] as? String { return text }
        if let content = visibleText(from: object["content"]) { return content }
        if let name = firstNonemptyString(object["name"], object["toolName"]) {
          return "tool: \(name)"
        }
        return nil
      }.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
      return joined.isEmpty ? nil : joined.joined(separator: "\n")
    }
    if let object = value as? [String: Any] {
      if object["type"] as? String == "thinking" { return nil }
      if let text = object["text"] as? String { return text }
      if let content = visibleText(from: object["content"]) { return content }
      if let output = visibleText(from: object["output"]) { return output }
      if let error = visibleText(from: object["error"]) { return error }
      if let message = visibleText(from: object["message"]) { return message }
      return compactJSONSummary(object, limit: 600)
    }
    return nil
  }

  private func compactJSONSummary(_ value: Any, limit: Int) -> String? {
    guard JSONSerialization.isValidJSONObject(value),
          let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
          let text = String(data: data, encoding: .utf8) else { return nil }
    return compactVisibleText(text, limit: limit)
  }

  private func firstNonemptyString(_ values: Any?...) -> String? {
    for value in values {
      if let text = value as? String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { return trimmed }
      }
    }
    return nil
  }

  private func compactVisibleText(_ value: String, limit: Int) -> String {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.count > limit else { return trimmed }
    let end = trimmed.index(trimmed.startIndex, offsetBy: limit)
    return String(trimmed[..<end]) + "\n[truncated]"
  }

  private func decodeActionResult(from object: [String: Any]) -> CanvastDesktopActionResult? {
    guard let message = desktopActionResultMessage(from: object) else { return nil }
    if let content = message["content"] as? String, let data = content.data(using: .utf8) {
      if let result = try? JSONDecoder().decode(CanvastDesktopActionResult.self, from: data) {
        return result
      }
    }
    if let details = message["details"], JSONSerialization.isValidJSONObject(details),
       let data = try? JSONSerialization.data(withJSONObject: details) {
      return try? JSONDecoder().decode(CanvastDesktopActionResult.self, from: data)
    }
    return nil
  }

  private func desktopActionResultMessage(from object: [String: Any]) -> [String: Any]? {
    guard object["type"] as? String == "message_end",
          let message = object["message"] as? [String: Any],
          message["customType"] as? String == "canvast-desktop-action-result" else { return nil }
    return message
  }

  private func desktopActionResultRequestID(from object: [String: Any]) -> String? {
    guard let message = desktopActionResultMessage(from: object) else { return nil }
    if let content = message["content"] as? String,
       let data = content.data(using: .utf8),
       let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       let requestID = payload["requestId"] as? String {
      return requestID
    }
    return (message["details"] as? [String: Any])?["requestId"] as? String
  }

  private func agentTerminalResult(_ object: [String: Any]) -> (success: Bool, message: String?) {
    guard let messages = object["messages"] as? [[String: Any]],
          let message = messages.reversed().first(where: { $0["role"] as? String == "assistant" }) else {
      return (false, "The runtime ended without a terminal agent message.")
    }
    let stopReason = (message["stopReason"] as? String) ?? (message["stop_reason"] as? String)
    let error = (message["errorMessage"] as? String) ?? (message["error_message"] as? String)
    if stopReason == "aborted" || stopReason == "cancelled" {
      return (false, error ?? "The run was cancelled.")
    }
    if stopReason == "error" || error != nil {
      return (false, error ?? "The runtime reported an agent error.")
    }
    return (true, nil)
  }

  private func handleExtensionUIRequest(_ object: [String: Any], rawLine: String) {
    let method = object["method"] as? String ?? "unknown"
    let text = object["message"] as? String ?? object["title"] as? String
    publish(.rpc(CanvastRPCEvent(
      kind: .notification, requestID: object["id"] as? String, command: method,
      success: nil, text: text, actionResult: nil, rawLine: rawLine
    )))
    guard ["select", "confirm", "input", "editor"].contains(method),
          let id = object["id"] as? String else { return }
    try? sendJSONObject(["type": "extension_ui_response", "id": id, "cancelled": true])
  }

  @discardableResult
  private func appendOutput(_ text: String, runID: UUID) -> Bool {
    mutateLiveSnapshot(runID: runID) { prior in
      CanvastProcessSnapshot(
        runID: runID, phase: prior.phase, output: prior.output + text, errorOutput: prior.errorOutput,
        exitCode: prior.exitCode, startedAt: prior.startedAt, completedAt: prior.completedAt
      )
    }
  }

  private func appendStderr(_ data: Data, runID: UUID) {
    guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
    _ = mutateLiveSnapshot(runID: runID) { prior in
      CanvastProcessSnapshot(
        runID: runID, phase: prior.phase, output: prior.output, errorOutput: prior.errorOutput + text,
        exitCode: prior.exitCode, startedAt: prior.startedAt, completedAt: prior.completedAt
      )
    }
  }

  private func finish(process finished: Process, runID: UUID) {
    let pipes = lock.withLock { () -> (Pipe?, Pipe?)? in
      guard process === finished, currentSnapshot.runID == runID else { return nil }
      standardOutputPipe?.fileHandleForReading.readabilityHandler = nil
      standardErrorPipe?.fileHandleForReading.readabilityHandler = nil
      return (standardOutputPipe, standardErrorPipe)
    }
    guard let pipes else { return }
    consumeStdout(pipes.0?.fileHandleForReading.readDataToEndOfFile() ?? Data(), runID: runID)
    let trailing = lock.withLock { () -> Data in
      let value = stdoutBuffer
      stdoutBuffer.removeAll(keepingCapacity: true)
      return value
    }
    if !trailing.isEmpty { consumeRPCLine(trailing, runID: runID) }
    appendStderr(pipes.1?.fileHandleForReading.readDataToEndOfFile() ?? Data(), runID: runID)
    let publication = lock.withLock { () -> (CanvastProcessSnapshot, [(CanvastBridgeEvent) -> Void])? in
      guard process === finished, currentSnapshot.runID == runID else { return nil }
      let prior = currentSnapshot
      let phase: CanvastProcessPhase = prior.phase == .stopping ? .terminated : (finished.terminationStatus == 0 ? .succeeded : .failed)
      process = nil
      standardInputPipe = nil
      standardOutputPipe = nil
      standardErrorPipe = nil
      clearPromptCorrelationsLocked(runID: runID)
      let snapshot = CanvastProcessSnapshot(
        runID: runID, phase: phase, output: prior.output, errorOutput: prior.errorOutput,
        exitCode: finished.terminationStatus, startedAt: prior.startedAt, completedAt: Date()
      )
      currentSnapshot = snapshot
      return (snapshot, Array(observers.values))
    }
    guard let publication else { return }
    for callback in publication.1 { callback(.process(publication.0)) }
  }

  private func updatePhase(_ phase: CanvastProcessPhase) {
    let publication = lock.withLock { () -> (CanvastProcessSnapshot, [(CanvastBridgeEvent) -> Void])? in
      guard let runID = currentSnapshot.runID,
            [.starting, .running, .stopping].contains(currentSnapshot.phase) else { return nil }
      let prior = currentSnapshot
      let next = CanvastProcessSnapshot(
        runID: runID, phase: phase, output: prior.output, errorOutput: prior.errorOutput,
        exitCode: prior.exitCode, startedAt: prior.startedAt, completedAt: prior.completedAt
      )
      currentSnapshot = next
      return (next, Array(observers.values))
    }
    guard let publication else { return }
    for callback in publication.1 { callback(.process(publication.0)) }
  }

  private func publish(_ snapshot: CanvastProcessSnapshot) {
    let callbacks = lock.withLock { () -> [(CanvastBridgeEvent) -> Void] in
      currentSnapshot = snapshot
      return Array(observers.values)
    }
    for callback in callbacks { callback(.process(snapshot)) }
  }

  private func publish(_ event: CanvastBridgeEvent) {
    let callbacks = lock.withLock { Array(observers.values) }
    for callback in callbacks { callback(event) }
  }

  @discardableResult
  private func mutateLiveSnapshot(
    runID: UUID, transform: (CanvastProcessSnapshot) -> CanvastProcessSnapshot
  ) -> Bool {
    let publication = lock.withLock { () -> (CanvastProcessSnapshot, [(CanvastBridgeEvent) -> Void])? in
      guard currentSnapshot.runID == runID,
            [.starting, .running, .stopping].contains(currentSnapshot.phase) else { return nil }
      let next = transform(currentSnapshot)
      currentSnapshot = next
      return (next, Array(observers.values))
    }
    guard let publication else { return false }
    for callback in publication.1 { callback(.process(publication.0)) }
    return true
  }

  private func reportStopFailure(for running: Process, detail: String) {
    let runID = lock.withLock { process === running ? currentSnapshot.runID : nil }
    guard let runID else { return }
    _ = mutateLiveSnapshot(runID: runID) { prior in
      CanvastProcessSnapshot(
        runID: runID, phase: .failed, output: prior.output,
        errorOutput: prior.errorOutput + (prior.errorOutput.isEmpty ? "" : "\n") + detail,
        exitCode: prior.exitCode, startedAt: prior.startedAt, completedAt: Date()
      )
    }
  }

  private func discardPromptRequestLocked(_ requestID: String) {
    pendingPromptRequests.removeAll { $0.requestID == requestID }
    if activePromptRequest?.requestID == requestID { activePromptRequest = nil }
    if settledAgentResult?.correlation?.requestID == requestID { settledAgentResult = nil }
  }

  private func clearPromptCorrelationsLocked(runID: UUID? = nil) {
    guard let runID else {
      pendingPromptRequests.removeAll(keepingCapacity: true)
      activePromptRequest = nil
      settledAgentResult = nil
      return
    }
    pendingPromptRequests.removeAll { $0.runID == runID }
    if activePromptRequest?.runID == runID { activePromptRequest = nil }
    if settledAgentResult?.correlation?.runID == runID { settledAgentResult = nil }
  }
}

private extension NSLock {
  func withLock<T>(_ body: () -> T) -> T { lock(); defer { unlock() }; return body() }
}
