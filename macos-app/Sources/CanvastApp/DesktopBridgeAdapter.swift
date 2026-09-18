import Foundation
import CanvastAppCore

protocol DesktopRuntimeBridging: AnyObject {
  var isRunning: Bool { get }
  var processSnapshot: CanvastProcessSnapshot { get }

  @discardableResult func observe(_ observer: @escaping (CanvastBridgeEvent) -> Void) -> UUID
  func removeObserver(_ token: UUID)
  func makePlan(
    installRoot: URL,
    workspaceRoot: URL,
    mode: CanvastRuntimeMode,
    thinkingLevel: String,
    timeoutSeconds: Int,
    providerConfiguration: CanvastProviderRuntimeConfiguration?
  ) throws -> CanvastLaunchPlan
  func start(plan: CanvastLaunchPlan) throws
  func sendPrompt(_ message: String, requestID: String) throws
  func sendSteer(_ message: String, requestID: String) throws
  func sendFollowUp(_ message: String, requestID: String) throws
  func abort(requestID: String) throws
  func newSession(requestID: String) throws
  func setThinkingLevel(_ level: String, requestID: String) throws
  func getState(requestID: String) throws
  func discardPromptRequest(_ requestID: String)
  func execute(
    action: CanvastDesktopAction, installRoot: URL, workspaceRoot: URL,
    mode: CanvastRuntimeMode, thinkingLevel: String?,
    providerConfiguration: CanvastProviderRuntimeConfiguration?
  ) throws
  func stopHost()
}

enum DesktopActionDispatchError: LocalizedError {
  case notDispatched(Error)
  case outcomeUnknown(Error)

  var errorDescription: String? {
    switch self {
    case .notDispatched(let error), .outcomeUnknown(let error): return error.localizedDescription
    }
  }
}

final class DesktopRuntimeBridgeAdapter: DesktopRuntimeBridging {
  private let bridge: CanvastBridge

  init(bridge: CanvastBridge = CanvastBridge()) {
    self.bridge = bridge
  }

  var isRunning: Bool { bridge.isRunning }
  var processSnapshot: CanvastProcessSnapshot { bridge.processSnapshot }

  @discardableResult
  func observe(_ observer: @escaping (CanvastBridgeEvent) -> Void) -> UUID {
    bridge.observe(observer)
  }

  func removeObserver(_ token: UUID) { bridge.removeObserver(token) }

  func makePlan(
    installRoot: URL,
    workspaceRoot: URL,
    mode: CanvastRuntimeMode,
    thinkingLevel: String,
    timeoutSeconds: Int,
    providerConfiguration: CanvastProviderRuntimeConfiguration?
  ) throws -> CanvastLaunchPlan {
    do {
      return try bridge.buildLaunchPlan(
        installRoot: installRoot, workspaceRoot: workspaceRoot, mode: mode,
        thinkingLevel: thinkingLevel, timeoutSeconds: timeoutSeconds,
        providerConfiguration: providerConfiguration
      )
    } catch let error as CanvastBridgeError {
      throw DesktopRuntimeBridgeError(error)
    }
  }

  func start(plan: CanvastLaunchPlan) throws {
    do { try bridge.start(plan: plan) } catch let error as CanvastBridgeError { throw DesktopRuntimeBridgeError(error) }
  }

  func sendPrompt(_ message: String, requestID: String) throws {
    try deliver { try bridge.sendPrompt(message, requestID: requestID) }
  }

  func sendSteer(_ message: String, requestID: String) throws {
    try deliver { try bridge.sendSteer(message, requestID: requestID) }
  }

  func sendFollowUp(_ message: String, requestID: String) throws {
    try deliver { try bridge.sendFollowUp(message, requestID: requestID) }
  }

  func abort(requestID: String) throws {
    try deliver { try bridge.abort(requestID: requestID) }
  }

  func newSession(requestID: String) throws {
    try deliver { try bridge.newSession(requestID: requestID) }
  }

  func setThinkingLevel(_ level: String, requestID: String) throws {
    try deliver { try bridge.setThinkingLevel(level, requestID: requestID) }
  }

  func getState(requestID: String) throws {
    try deliver { try bridge.getState(requestID: requestID) }
  }

  func discardPromptRequest(_ requestID: String) {
    bridge.discardPromptRequest(requestID)
  }

  func execute(
    action: CanvastDesktopAction, installRoot: URL, workspaceRoot: URL,
    mode: CanvastRuntimeMode, thinkingLevel: String?,
    providerConfiguration: CanvastProviderRuntimeConfiguration?
  ) throws {
    do {
      try bridge.execute(
        action: action, installRoot: installRoot, workspaceRoot: workspaceRoot,
        mode: mode, thinkingLevel: thinkingLevel, providerConfiguration: providerConfiguration
      )
    } catch {
      throw dispatchError(error)
    }
  }

  func stopHost() { bridge.stop() }

  private func deliver(_ operation: () throws -> Void) throws {
    do { try operation() } catch { throw dispatchError(error) }
  }

  private func dispatchError(_ error: Error) -> DesktopActionDispatchError {
    if let sendError = error as? CanvastBridgeSendError {
      let underlying = (sendError.underlying as? CanvastBridgeError).map(DesktopRuntimeBridgeError.init) ?? sendError.underlying
      switch sendError.deliveryState {
      case .notDispatched: return .notDispatched(underlying)
      case .unknownAfterWrite: return .outcomeUnknown(underlying)
      }
    }
    let underlying = (error as? CanvastBridgeError).map(DesktopRuntimeBridgeError.init) ?? error
    return .notDispatched(underlying)
  }
}

private enum DesktopRuntimeBridgeError: LocalizedError {
  case missingLauncher(URL)
  case invalidWorkspace(URL)
  case processAlreadyRunning
  case noRunningProcess
  case invalidRPCPayload
  case unavailable(String)

  init(_ error: CanvastBridgeError) {
    switch error {
    case .missingLauncher(let url): self = .missingLauncher(url)
    case .invalidWorkspace(let url): self = .invalidWorkspace(url)
    case .processAlreadyRunning: self = .processAlreadyRunning
    case .noRunningProcess: self = .noRunningProcess
    case .invalidRPCPayload: self = .invalidRPCPayload
    }
  }

  var errorDescription: String? {
    switch self {
    case .missingLauncher(let url): return "Canvast launcher is not executable at \(url.path)."
    case .invalidWorkspace(let url): return "The selected workspace is not a directory: \(url.path)."
    case .processAlreadyRunning: return "A Canvast RPC host is already active."
    case .noRunningProcess: return "The Canvast RPC host is not running."
    case .invalidRPCPayload: return "The structured Canvast request could not be encoded."
    case .unavailable(let detail): return "The Canvast runtime action is unavailable: \(detail)."
    }
  }
}
