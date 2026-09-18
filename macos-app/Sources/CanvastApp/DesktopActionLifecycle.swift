import Foundation
import CanvastAppCore

enum DesktopActionLifecycleStatus: String, CaseIterable, Codable {
  case idle
  case preparing
  case queued
  case running
  case waiting
  case reconciling
  case outcomeUnknown = "outcome_unknown"
  case succeeded
  case failed
  case cancelled
  case timedOut = "timed_out"
  case reconciled

  var isActive: Bool {
    switch self {
    case .idle, .outcomeUnknown, .succeeded, .failed, .cancelled, .timedOut, .reconciled: return false
    case .preparing, .queued, .running, .waiting, .reconciling: return true
    }
  }

  var holdsLock: Bool {
    isActive || self == .outcomeUnknown || self == .reconciled
  }

  var label: String {
    let localizer = CanvastLocalizationRuntime.localizer
    switch self {
    case .idle: return localizer.dynamic("idle")
    case .preparing: return localizer.dynamic("preparing")
    case .queued: return localizer.dynamic("queued")
    case .running: return localizer.dynamic("running")
    case .waiting: return localizer.dynamic("waiting")
    case .reconciling: return localizer.dynamic("reconciling")
    case .outcomeUnknown: return localizer.dynamic("outcome_unknown")
    case .succeeded: return localizer.dynamic("succeeded")
    case .failed: return localizer.dynamic("failed")
    case .cancelled: return localizer.dynamic("cancelled")
    case .timedOut: return localizer.dynamic("timed_out")
    case .reconciled: return localizer.dynamic("review_required")
    }
  }
}

enum DesktopActionStageToken: String, CaseIterable, Codable {
  case localState = "local_state"
  case snapshotRefresh = "snapshot_refresh"
  case hostPreparation = "host_preparation"
  case requestEncoding = "request_encoding"
  case requestDispatch = "request_dispatch"
  case resultAwait = "result_await"
  case streamActive = "stream_active"
  case streamHeartbeat = "stream_heartbeat"
  case cancellation = "cancellation"
  case timeout = "timeout"
  case outcomeUnknown = "outcome_unknown"
  case reconciliation = "reconciliation"
  case rollback = "rollback"
  case complete = "complete"
}

enum DesktopActionExecutionTransport: String, Codable {
  case localUI = "local_ui"
  case nativeRPC = "native_rpc"
  case desktopDispatcher = "desktop_dispatcher"
}

enum DesktopActionCancelCapability: String, Codable {
  case none
  case activeRunAbort = "active_run_abort"
  case localTask = "local_task"
}

enum DesktopActionRollbackCapability: String, Codable {
  case none
  case localState = "local_state"
}

enum DesktopActionRetryPolicy: String, Codable {
  case never
  case afterDefinitiveFailure = "after_definitive_failure"
  case idempotent

  func allows(_ status: DesktopActionLifecycleStatus) -> Bool {
    guard status == .failed || status == .timedOut else { return false }
    return self != .never
  }
}

enum DesktopActionDeliveryState: String, Codable {
  case notDispatched = "not_dispatched"
  case dispatched
  case acknowledged
}

enum DesktopActionReconciliationOutcome: Equatable {
  case confirmedSucceeded(String)
  case confirmedFailed(String)
  case stillUnknown(String)
}

enum DesktopUIControlKind: String, Codable, CaseIterable {
  case execution
  case edit
  case navigation
}

enum DesktopUIActionBinding: Equatable {
  case fixed(DesktopUIActionID)
  case currentLifecycleAction
}

struct DesktopActionStage: Equatable {
  let token: DesktopActionStageToken
  private let rawLabel: String
  private let localizedLabel: CanvastLocalizedString?
  private let rawDetail: String?
  private let localizedDetail: CanvastLocalizedString?

  var label: String {
    if let localizedLabel {
      return CanvastLocalizationRuntime.localizer.text(localizedLabel)
    }
    return CanvastLocalizationRuntime.localizer.exact(rawLabel)
  }

  var detail: String? {
    if let localizedDetail {
      return CanvastLocalizationRuntime.localizer.text(localizedDetail)
    }
    return rawDetail.map(CanvastLocalizationRuntime.localizer.exact)
  }

  init(_ token: DesktopActionStageToken, label: String, detail: String? = nil) {
    self.token = token
    rawLabel = label
    localizedLabel = nil
    rawDetail = detail
    localizedDetail = nil
  }

  init(
    _ token: DesktopActionStageToken,
    english: String,
    simplifiedChinese: String,
    detailEnglish: String? = nil,
    detailSimplifiedChinese: String? = nil
  ) {
    self.token = token
    rawLabel = english
    localizedLabel = .init(english, simplifiedChinese)
    if let detailEnglish, let detailSimplifiedChinese {
      rawDetail = detailEnglish
      localizedDetail = .init(detailEnglish, detailSimplifiedChinese)
    } else {
      rawDetail = detailEnglish
      localizedDetail = nil
    }
  }
}

struct DesktopActionSpec: Equatable {
  let id: DesktopUIActionID
  private let rawTitle: String
  private let localizedTitle: CanvastLocalizedString?
  let transport: DesktopActionExecutionTransport
  let lockScope: String?
  let defaultTimeoutSeconds: Int?
  let retryPolicy: DesktopActionRetryPolicy
  let cancelCapability: DesktopActionCancelCapability
  let rollbackCapability: DesktopActionRollbackCapability
  private let rawTimeoutMessage: String
  private let localizedTimeoutMessage: CanvastLocalizedString?
  private let rawDuplicateMessage: String
  private let localizedDuplicateMessage: CanvastLocalizedString?

  var title: String {
    if let localizedTitle {
      return CanvastLocalizationRuntime.localizer.text(localizedTitle)
    }
    return CanvastLocalizationRuntime.localizer.exact(rawTitle)
  }

  var timeoutMessage: String {
    if let localizedTimeoutMessage {
      return CanvastLocalizationRuntime.localizer.text(localizedTimeoutMessage)
    }
    return CanvastLocalizationRuntime.localizer.exact(rawTimeoutMessage)
  }

  var duplicateMessage: String {
    if let localizedDuplicateMessage {
      return CanvastLocalizationRuntime.localizer.text(localizedDuplicateMessage)
    }
    return CanvastLocalizationRuntime.localizer.exact(rawDuplicateMessage)
  }

  init(
    id: DesktopUIActionID,
    title: String,
    transport: DesktopActionExecutionTransport,
    lockScope: String?,
    defaultTimeoutSeconds: Int?,
    retryPolicy: DesktopActionRetryPolicy,
    cancelCapability: DesktopActionCancelCapability,
    rollbackCapability: DesktopActionRollbackCapability,
    timeoutMessage: String,
    duplicateMessage: String
  ) {
    self.id = id
    rawTitle = title
    localizedTitle = nil
    self.transport = transport
    self.lockScope = lockScope
    self.defaultTimeoutSeconds = defaultTimeoutSeconds
    self.retryPolicy = retryPolicy
    self.cancelCapability = cancelCapability
    self.rollbackCapability = rollbackCapability
    rawTimeoutMessage = timeoutMessage
    localizedTimeoutMessage = nil
    rawDuplicateMessage = duplicateMessage
    localizedDuplicateMessage = nil
  }

  init(
    id: DesktopUIActionID,
    titleEnglish: String,
    titleSimplifiedChinese: String,
    transport: DesktopActionExecutionTransport,
    lockScope: String?,
    defaultTimeoutSeconds: Int?,
    retryPolicy: DesktopActionRetryPolicy,
    cancelCapability: DesktopActionCancelCapability,
    rollbackCapability: DesktopActionRollbackCapability,
    timeoutEnglish: String,
    timeoutSimplifiedChinese: String,
    duplicateEnglish: String,
    duplicateSimplifiedChinese: String
  ) {
    self.id = id
    rawTitle = titleEnglish
    localizedTitle = .init(titleEnglish, titleSimplifiedChinese)
    self.transport = transport
    self.lockScope = lockScope
    self.defaultTimeoutSeconds = defaultTimeoutSeconds
    self.retryPolicy = retryPolicy
    self.cancelCapability = cancelCapability
    self.rollbackCapability = rollbackCapability
    rawTimeoutMessage = timeoutEnglish
    localizedTimeoutMessage = .init(timeoutEnglish, timeoutSimplifiedChinese)
    rawDuplicateMessage = duplicateEnglish
    localizedDuplicateMessage = .init(duplicateEnglish, duplicateSimplifiedChinese)
  }
}

struct DesktopUIControlRegistration: Identifiable, Equatable {
  let site: String
  let file: String
  let control: String
  private let rawLabel: String
  private let localizedLabel: CanvastLocalizedString?
  let controlKind: DesktopUIControlKind
  let actionBinding: DesktopUIActionBinding?

  var actionID: DesktopUIActionID? {
    guard case .fixed(let actionID) = actionBinding else { return nil }
    return actionID
  }

  var id: String { "\(file)#\(site)" }
  var label: String {
    if let localizedLabel {
      return CanvastLocalizationRuntime.localizer.text(localizedLabel)
    }
    return CanvastLocalizationRuntime.localizer.exact(rawLabel)
  }

  init(
    site: String, file: String, control: String, label: String,
    controlKind: DesktopUIControlKind, actionBinding: DesktopUIActionBinding? = nil
  ) {
    self.site = site
    self.file = file
    self.control = control
    rawLabel = label
    localizedLabel = nil
    self.controlKind = controlKind
    self.actionBinding = actionBinding
  }

  init(
    site: String,
    file: String,
    control: String,
    englishLabel: String,
    simplifiedChineseLabel: String,
    controlKind: DesktopUIControlKind,
    actionBinding: DesktopUIActionBinding? = nil
  ) {
    self.site = site
    self.file = file
    self.control = control
    rawLabel = englishLabel
    localizedLabel = .init(englishLabel, simplifiedChineseLabel)
    self.controlKind = controlKind
    self.actionBinding = actionBinding
  }
}

struct DesktopActionSnapshot: Identifiable, Equatable {
  let actionID: DesktopUIActionID
  let title: String
  let transport: DesktopActionExecutionTransport
  let correlationID: String
  let attempt: Int
  let lockScope: String?
  let status: DesktopActionLifecycleStatus
  let stage: DesktopActionStage
  let message: String
  let startedAt: Date
  let updatedAt: Date
  let heartbeatAt: Date?
  let timeoutAt: Date?
  let lastStableState: String?
  let retryPolicy: DesktopActionRetryPolicy
  let deliveryState: DesktopActionDeliveryState
  let reconciliationID: String?
  let hasRetryHandler: Bool
  let hasCancelHandler: Bool
  let hasRollbackHandler: Bool
  let hasReconcileHandler: Bool
  let cancelCapability: DesktopActionCancelCapability
  let rollbackCapability: DesktopActionRollbackCapability

  var id: String { actionID.rawValue }
  var isActive: Bool { status.isActive }
  var supportsCancel: Bool { status.isActive && cancelCapability != .none && hasCancelHandler }
  var supportsRollback: Bool {
    (status == .failed || status == .timedOut) && rollbackCapability != .none && hasRollbackHandler
  }
  var supportsRetryAction: Bool { retryPolicy.allows(status) && hasRetryHandler }
  var supportsReconcile: Bool {
    (status == .outcomeUnknown || status == .reconciled) && hasReconcileHandler
  }
  var supportsManualResolution: Bool { status == .reconciled }
}

enum DesktopActionStartDecision {
  case started(DesktopActionSnapshot)
  case locked(DesktopActionSnapshot, message: String)
}

@MainActor
final class DesktopActionCenter {
  struct Handlers {
    var retry: (() -> Void)?
    var cancel: (() -> Void)?
    var rollback: (() -> Void)?
    var reconcile: ((String) -> Void)?
    var onTimeout: (() -> Void)?
  }

  var onChange: (() -> Void)?

  private let clock: () -> Date
  private var snapshots: [DesktopUIActionID: DesktopActionSnapshot] = [:]
  private var handlers: [DesktopUIActionID: Handlers] = [:]
  private var activeScopes: [String: DesktopUIActionID] = [:]
  private var timer: Timer?

  init(clock: @escaping () -> Date = Date.init) {
    self.clock = clock
  }

  deinit { timer?.invalidate() }

  var primarySnapshot: DesktopActionSnapshot? {
    let active = snapshots.values.filter { $0.status.holdsLock }.sorted(by: snapshotOrder)
    if let active = active.first { return active }
    return snapshots.values.sorted(by: snapshotOrder).first
  }

  var recentSnapshots: [DesktopActionSnapshot] {
    snapshots.values.sorted(by: snapshotOrder)
  }

  func snapshot(for id: DesktopUIActionID) -> DesktopActionSnapshot? {
    snapshots[id]
  }

  func isCurrentExecution(_ id: DesktopUIActionID, correlationID: String) -> Bool {
    guard let snapshot = snapshots[id] else { return false }
    return snapshot.correlationID == correlationID &&
      [.preparing, .queued, .running, .waiting].contains(snapshot.status)
  }

  func canAcceptRemoteResult(_ id: DesktopUIActionID, correlationID: String) -> Bool {
    guard let snapshot = snapshots[id] else { return false }
    return snapshot.correlationID == correlationID && snapshot.status.holdsLock
  }

  func isCurrentReconciliation(
    _ id: DesktopUIActionID, correlationID: String, reconciliationID: String
  ) -> Bool {
    guard let snapshot = snapshots[id] else { return false }
    return snapshot.correlationID == correlationID &&
      snapshot.reconciliationID == reconciliationID &&
      (snapshot.status == .reconciling || snapshot.status == .outcomeUnknown)
  }

  func isLocked(_ id: DesktopUIActionID) -> Bool {
    let spec = DesktopActionRegistry.spec(for: id)
    guard let scope = spec.lockScope else { return snapshot(for: id)?.status.holdsLock == true }
    guard let holderID = activeScopes[scope], let holder = snapshots[holderID], holder.status.holdsLock else { return false }
    return holderID != id || holder.status.holdsLock
  }

  func lockHolder(for id: DesktopUIActionID) -> DesktopActionSnapshot? {
    let spec = DesktopActionRegistry.spec(for: id)
    guard let scope = spec.lockScope,
          let holderID = activeScopes[scope],
          let holder = snapshots[holderID],
          holder.status.holdsLock else { return nil }
    return holder
  }

  func startAutoTick() {
    guard timer == nil else { return }
    let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
      Task { @MainActor [weak self] in self?.tick() }
    }
    RunLoop.main.add(timer, forMode: .common)
    self.timer = timer
  }

  func begin(
    spec: DesktopActionSpec,
    correlationID: String,
    lastStableState: String? = nil,
    retry: (() -> Void)? = nil,
    cancel: (() -> Void)? = nil,
    rollback: (() -> Void)? = nil,
    reconcile: ((String) -> Void)? = nil,
    onTimeout: (() -> Void)? = nil,
    timeoutSeconds: Int? = nil,
    stage: DesktopActionStage = .init(
      .hostPreparation,
      english: "Preparing action",
      simplifiedChinese: "准备操作"
    )
  ) -> DesktopActionStartDecision {
    if let scope = spec.lockScope,
       let holderID = activeScopes[scope],
       let holder = snapshots[holderID],
       holder.status.holdsLock {
      return .locked(holder, message: spec.duplicateMessage)
    }
    let now = clock()
    let attempt = (snapshots[spec.id]?.attempt ?? 0) + 1
    let effectiveTimeoutSeconds = timeoutSeconds.map { $0 > 0 ? $0 : nil } ?? spec.defaultTimeoutSeconds
    let timeoutAt = effectiveTimeoutSeconds.map {
      now.addingTimeInterval(TimeInterval($0))
    }
    let initialMessage = CanvastLocalizationRuntime.localizer.exact(stage.label)
    let snapshot = DesktopActionSnapshot(
      actionID: spec.id,
      title: spec.title,
      transport: spec.transport,
      correlationID: correlationID,
      attempt: attempt,
      lockScope: spec.lockScope,
      status: .preparing,
      stage: stage,
      message: initialMessage,
      startedAt: now,
      updatedAt: now,
      heartbeatAt: now,
      timeoutAt: timeoutAt,
      lastStableState: lastStableState,
      retryPolicy: spec.retryPolicy,
      deliveryState: .notDispatched,
      reconciliationID: nil,
      hasRetryHandler: retry != nil,
      hasCancelHandler: cancel != nil,
      hasRollbackHandler: rollback != nil,
      hasReconcileHandler: reconcile != nil,
      cancelCapability: spec.cancelCapability,
      rollbackCapability: spec.rollbackCapability
    )
    snapshots[spec.id] = snapshot
    handlers[spec.id] = Handlers(
      retry: retry, cancel: cancel, rollback: rollback, reconcile: reconcile, onTimeout: onTimeout
    )
    if let scope = spec.lockScope { activeScopes[scope] = spec.id }
    publish()
    return .started(snapshot)
  }

  func instantSuccess(
    spec: DesktopActionSpec,
    correlationID: String = UUID().uuidString,
    message: String,
    lastStableState: String? = nil,
    retry: (() -> Void)? = nil,
    rollback: (() -> Void)? = nil,
    stage: DesktopActionStage = .init(
      .localState,
      english: "Applied local change",
      simplifiedChinese: "已应用本地更改"
    )
  ) {
    switch begin(
      spec: spec,
      correlationID: correlationID,
      lastStableState: lastStableState,
      retry: retry,
      rollback: rollback,
      stage: stage
    ) {
    case .locked: return
    case .started:
      succeed(spec.id, correlationID: correlationID, message: message, stage: .init(.complete, label: message))
    }
  }

  func markDispatched(_ id: DesktopUIActionID, correlationID: String, message: String) {
    update(
      id, correlationID: correlationID, status: nil,
      stage: .init(.requestDispatch, label: message), deliveryState: .dispatched
    )
  }

  func markQueued(_ id: DesktopUIActionID, correlationID: String, message: String, detail: String? = nil) {
    update(
      id, correlationID: correlationID, status: .queued,
      stage: .init(.requestDispatch, label: message, detail: detail), deliveryState: .dispatched
    )
  }

  func markRunning(
    _ id: DesktopUIActionID,
    correlationID: String,
    message: String,
    token: DesktopActionStageToken = .streamActive,
    detail: String? = nil
  ) {
    guard isCurrentExecution(id, correlationID: correlationID) else { return }
    update(
      id,
      correlationID: correlationID,
      status: .running,
      stage: .init(token, label: message, detail: detail),
      heartbeat: true
    )
  }

  func markWaiting(_ id: DesktopUIActionID, correlationID: String, message: String, detail: String? = nil) {
    update(
      id, correlationID: correlationID, status: .waiting,
      stage: .init(.resultAwait, label: message, detail: detail), heartbeat: true, deliveryState: .dispatched
    )
  }

  func heartbeat(
    _ id: DesktopUIActionID,
    correlationID: String,
    message: String,
    token: DesktopActionStageToken = .streamHeartbeat,
    detail: String? = nil
  ) {
    guard isCurrentExecution(id, correlationID: correlationID) else { return }
    update(id, correlationID: correlationID, status: nil, stage: .init(token, label: message, detail: detail), heartbeat: true)
  }

  func succeed(_ id: DesktopUIActionID, correlationID: String, message: String, stage: DesktopActionStage? = nil) {
    finalize(id, correlationID: correlationID, status: .succeeded, message: message, stage: stage ?? .init(.complete, label: message))
  }

  func fail(_ id: DesktopUIActionID, correlationID: String, message: String, stage: DesktopActionStage? = nil) {
    finalize(id, correlationID: correlationID, status: .failed, message: message, stage: stage ?? .init(.complete, label: message))
  }

  func markOutcomeUnknown(_ id: DesktopUIActionID, correlationID: String, message: String) {
    finalize(
      id, correlationID: correlationID, status: .outcomeUnknown, message: message,
      stage: .init(
        .outcomeUnknown,
        english: "Outcome unknown",
        simplifiedChinese: "结果未知",
        detailEnglish: message,
        detailSimplifiedChinese: message
      )
    )
  }

  func cancel(_ id: DesktopUIActionID, correlationID: String, message: String, stage: DesktopActionStage? = nil) {
    finalize(id, correlationID: correlationID, status: .cancelled, message: message, stage: stage ?? .init(.cancellation, label: message))
  }

  func tick(now overrideNow: Date? = nil) {
    let now = overrideNow ?? clock()
    var timeoutCallbacks: [() -> Void] = []
    for snapshot in snapshots.values where snapshot.isActive {
      guard let timeoutAt = snapshot.timeoutAt, now >= timeoutAt else { continue }
      if snapshot.status == .reconciling {
        if returnToOutcomeUnknown(
          snapshot.actionID, correlationID: snapshot.correlationID,
          reconciliationID: snapshot.reconciliationID ?? "",
          message: CanvastLocalizationRuntime.localizer.text(
            "State refresh timed out; the original action outcome remains unknown.",
            "状态刷新已超时；原始操作结果仍然未知。"
          )
        ), let callback = handlers[snapshot.actionID]?.onTimeout {
          timeoutCallbacks.append(callback)
        }
        continue
      }
      let callback = handlers[snapshot.actionID]?.onTimeout
      let spec = DesktopActionRegistry.spec(for: snapshot.actionID)
      let isUncertainRemote = spec.transport != .localUI && snapshot.deliveryState != .notDispatched
      finalize(
        snapshot.actionID, correlationID: snapshot.correlationID,
        status: isUncertainRemote ? .outcomeUnknown : .timedOut,
        message: isUncertainRemote
          ? "\(spec.timeoutMessage) The request may have completed; refresh to verify before trying again."
          : spec.timeoutMessage,
        stage: .init(
          isUncertainRemote ? .outcomeUnknown : .timeout,
          english: isUncertainRemote ? "Outcome unknown" : "Timed out",
          simplifiedChinese: isUncertainRemote ? "结果未知" : "已超时",
          detailEnglish: spec.timeoutMessage,
          detailSimplifiedChinese: spec.timeoutMessage
        ),
        updatedAt: now
      )
      if let callback { timeoutCallbacks.append(callback) }
    }
    timeoutCallbacks.forEach { $0() }
  }

  func retry(_ id: DesktopUIActionID) {
    guard let snapshot = snapshots[id], snapshot.supportsRetryAction, let retry = handlers[id]?.retry else { return }
    handlers[id]?.retry = nil
    synchronizeHandlerAvailability(id)
    retry()
  }

  func requestCancel(_ id: DesktopUIActionID) {
    guard let snapshot = snapshots[id], snapshot.supportsCancel, let cancel = handlers[id]?.cancel else { return }
    handlers[id]?.cancel = nil
    synchronizeHandlerAvailability(id)
    cancel()
  }

  func rollback(_ id: DesktopUIActionID) {
    guard let snapshot = snapshots[id], snapshot.supportsRollback, !snapshot.status.holdsLock,
          let rollback = handlers[id]?.rollback else { return }
    handlers[id]?.rollback = nil
    synchronizeHandlerAvailability(id)
    rollback()
  }

  func reconcile(_ id: DesktopUIActionID) {
    guard let snapshot = snapshots[id], snapshot.supportsReconcile, let reconcile = handlers[id]?.reconcile else { return }
    let reconciliationID = UUID().uuidString
    update(
      id, correlationID: snapshot.correlationID, status: .reconciling,
      stage: .init(
        .reconciliation,
        english: "Refreshing authoritative state",
        simplifiedChinese: "正在刷新权威状态"
      ),
      timeoutAt: clock().addingTimeInterval(10),
      reconciliationID: reconciliationID,
      replaceReconciliationID: true
    )
    reconcile(reconciliationID)
  }

  @discardableResult
  func resolveUnknown(
    _ id: DesktopUIActionID,
    correlationID: String,
    reconciliationID: String,
    outcome: DesktopActionReconciliationOutcome
  ) -> Bool {
    guard isCurrentReconciliation(
      id, correlationID: correlationID, reconciliationID: reconciliationID
    ) else { return false }
    switch outcome {
    case .confirmedSucceeded(let message):
      finalize(id, correlationID: correlationID, status: .succeeded, message: message,
               stage: .init(
                 .reconciliation,
                 english: "Outcome confirmed",
                 simplifiedChinese: "结果已确认",
                 detailEnglish: message,
                 detailSimplifiedChinese: message
               ))
    case .confirmedFailed(let message):
      finalize(id, correlationID: correlationID, status: .failed, message: message,
               stage: .init(
                 .reconciliation,
                 english: "Failure confirmed",
                 simplifiedChinese: "失败已确认",
                 detailEnglish: message,
                 detailSimplifiedChinese: message
               ))
    case .stillUnknown(let message):
      finalize(id, correlationID: correlationID, status: .reconciled, message: message,
               stage: .init(
                 .reconciliation,
                 english: "Review required",
                 simplifiedChinese: "需要复核",
                 detailEnglish: message,
                 detailSimplifiedChinese: message
               ))
    }
    return true
  }

  @discardableResult
  func resolveReviewedOutcome(
    _ id: DesktopUIActionID, correlationID: String, succeeded: Bool, message: String
  ) -> Bool {
    guard let snapshot = snapshots[id], snapshot.correlationID == correlationID,
          snapshot.supportsManualResolution else { return false }
    finalize(
      id, correlationID: correlationID, status: succeeded ? .succeeded : .failed, message: message,
      stage: .init(
        .reconciliation,
        english: succeeded ? "Outcome confirmed" : "Failure confirmed",
        simplifiedChinese: succeeded ? "结果已确认" : "失败已确认",
        detailEnglish: message,
        detailSimplifiedChinese: message
      )
    )
    return true
  }

  @discardableResult
  func returnToOutcomeUnknown(
    _ id: DesktopUIActionID, correlationID: String, reconciliationID: String, message: String
  ) -> Bool {
    guard isCurrentReconciliation(
      id, correlationID: correlationID, reconciliationID: reconciliationID
    ) else { return false }
    update(
      id, correlationID: correlationID, status: .outcomeUnknown,
      stage: .init(
        .outcomeUnknown,
        english: "Outcome unknown",
        simplifiedChinese: "结果未知",
        detailEnglish: message,
        detailSimplifiedChinese: message
      ),
      clearTimeout: true, reconciliationID: nil, replaceReconciliationID: true
    )
    return true
  }

  private func update(
    _ id: DesktopUIActionID,
    correlationID: String,
    status: DesktopActionLifecycleStatus?,
    stage: DesktopActionStage,
    heartbeat: Bool = false,
    timeoutAt: Date? = nil,
    deliveryState: DesktopActionDeliveryState? = nil,
    clearTimeout: Bool = false,
    reconciliationID: String? = nil,
    replaceReconciliationID: Bool = false
  ) {
    guard var snapshot = snapshots[id], snapshot.correlationID == correlationID else { return }
    let now = clock()
    let currentHandlers = handlers[id] ?? Handlers()
    let localizedMessage = CanvastLocalizationRuntime.localizer.exact(stage.label)
    snapshot = DesktopActionSnapshot(
      actionID: snapshot.actionID,
      title: snapshot.title,
      transport: snapshot.transport,
      correlationID: snapshot.correlationID,
      attempt: snapshot.attempt,
      lockScope: snapshot.lockScope,
      status: status ?? snapshot.status,
      stage: stage,
      message: localizedMessage,
      startedAt: snapshot.startedAt,
      updatedAt: now,
      heartbeatAt: heartbeat ? now : snapshot.heartbeatAt,
      timeoutAt: clearTimeout ? nil : (timeoutAt ?? snapshot.timeoutAt),
      lastStableState: snapshot.lastStableState,
      retryPolicy: snapshot.retryPolicy,
      deliveryState: deliveryState ?? snapshot.deliveryState,
      reconciliationID: replaceReconciliationID ? reconciliationID : snapshot.reconciliationID,
      hasRetryHandler: currentHandlers.retry != nil,
      hasCancelHandler: currentHandlers.cancel != nil,
      hasRollbackHandler: currentHandlers.rollback != nil,
      hasReconcileHandler: currentHandlers.reconcile != nil,
      cancelCapability: snapshot.cancelCapability,
      rollbackCapability: snapshot.rollbackCapability
    )
    snapshots[id] = snapshot
    publish()
  }

  private func finalize(
    _ id: DesktopUIActionID,
    correlationID: String,
    status: DesktopActionLifecycleStatus,
    message: String,
    stage: DesktopActionStage,
    updatedAt: Date? = nil
  ) {
    guard var snapshot = snapshots[id], snapshot.correlationID == correlationID else { return }
    let now = updatedAt ?? clock()
    let localizedMessage = CanvastLocalizationRuntime.localizer.exact(message)
    var nextHandlers = handlers[id] ?? Handlers()
    switch status {
    case .outcomeUnknown, .reconciling, .reconciled:
      nextHandlers.cancel = nil
      nextHandlers.onTimeout = nil
    case .failed, .timedOut:
      nextHandlers.cancel = nil
      nextHandlers.reconcile = nil
      nextHandlers.onTimeout = nil
    default:
      nextHandlers = Handlers()
    }
    handlers[id] = nextHandlers
    snapshot = DesktopActionSnapshot(
      actionID: snapshot.actionID,
      title: snapshot.title,
      transport: snapshot.transport,
      correlationID: snapshot.correlationID,
      attempt: snapshot.attempt,
      lockScope: snapshot.lockScope,
      status: status,
      stage: stage,
      message: localizedMessage,
      startedAt: snapshot.startedAt,
      updatedAt: now,
      heartbeatAt: now,
      timeoutAt: snapshot.timeoutAt,
      lastStableState: snapshot.lastStableState,
      retryPolicy: snapshot.retryPolicy,
      deliveryState: status == .succeeded ? .acknowledged : snapshot.deliveryState,
      reconciliationID: status == .reconciling || status == .outcomeUnknown ? snapshot.reconciliationID : nil,
      hasRetryHandler: nextHandlers.retry != nil,
      hasCancelHandler: nextHandlers.cancel != nil,
      hasRollbackHandler: nextHandlers.rollback != nil,
      hasReconcileHandler: nextHandlers.reconcile != nil,
      cancelCapability: snapshot.cancelCapability,
      rollbackCapability: snapshot.rollbackCapability
    )
    snapshots[id] = snapshot
    if !status.holdsLock, let scope = snapshot.lockScope, activeScopes[scope] == id { activeScopes.removeValue(forKey: scope) }
    publish()
  }

  private func synchronizeHandlerAvailability(_ id: DesktopUIActionID) {
    guard let snapshot = snapshots[id] else { return }
    let currentHandlers = handlers[id] ?? Handlers()
    snapshots[id] = DesktopActionSnapshot(
      actionID: snapshot.actionID, title: snapshot.title, transport: snapshot.transport,
      correlationID: snapshot.correlationID, attempt: snapshot.attempt, lockScope: snapshot.lockScope,
      status: snapshot.status, stage: snapshot.stage, message: snapshot.message,
      startedAt: snapshot.startedAt, updatedAt: clock(), heartbeatAt: snapshot.heartbeatAt,
      timeoutAt: snapshot.timeoutAt, lastStableState: snapshot.lastStableState,
      retryPolicy: snapshot.retryPolicy, deliveryState: snapshot.deliveryState,
      reconciliationID: snapshot.reconciliationID,
      hasRetryHandler: currentHandlers.retry != nil,
      hasCancelHandler: currentHandlers.cancel != nil,
      hasRollbackHandler: currentHandlers.rollback != nil,
      hasReconcileHandler: currentHandlers.reconcile != nil,
      cancelCapability: snapshot.cancelCapability, rollbackCapability: snapshot.rollbackCapability
    )
    publish()
  }

  private func snapshotOrder(_ lhs: DesktopActionSnapshot, _ rhs: DesktopActionSnapshot) -> Bool {
    if lhs.isActive != rhs.isActive { return lhs.isActive && !rhs.isActive }
    if lhs.updatedAt != rhs.updatedAt { return lhs.updatedAt > rhs.updatedAt }
    return lhs.title < rhs.title
  }

  private func publish() { onChange?() }
}
