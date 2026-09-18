import SwiftUI
import CanvastAppCore

enum RuntimeObservationPlane: String, CaseIterable, Hashable {
  case requestReceipt
  case inputQueue
  case requests
  case toolRuns
  case events
}

enum RuntimeObservationSource: String, Equatable {
  case typedRequestControlResult
  case runtimeStatus
}

struct RuntimeObservationRegistration: Identifiable, Equatable {
  let plane: RuntimeObservationPlane
  let workspace: DesktopWorkspace
  let surface: String
  let sources: [RuntimeObservationSource]
  let isReadOnly: Bool

  var id: String { plane.rawValue }
}

enum RuntimeObservabilityRegistry {
  static let registrations: [RuntimeObservationRegistration] = [
    .init(
      plane: .requestReceipt, workspace: .runConsole, surface: "Run request receipt",
      sources: [.typedRequestControlResult, .runtimeStatus], isReadOnly: true
    ),
    .init(
      plane: .inputQueue, workspace: .runConsole, surface: "Input queue",
      sources: [.runtimeStatus], isReadOnly: true
    ),
    .init(
      plane: .requests, workspace: .runConsole, surface: "Request lifecycle",
      sources: [.runtimeStatus], isReadOnly: true
    ),
    .init(
      plane: .toolRuns, workspace: .toolsContextSessions, surface: "Tool runs",
      sources: [.runtimeStatus], isReadOnly: true
    ),
    .init(
      plane: .events, workspace: .toolsContextSessions, surface: "Runtime events",
      sources: [.runtimeStatus], isReadOnly: true
    ),
  ]
}

enum RuntimeObservabilityPresentation: Equatable {
  case sideBySide
  case compact
}

enum RuntimeObservabilityLayout {
  static let minimumReadableColumnWidth: CGFloat = 340
  static let interColumnSpacing: CGFloat = 12
  static let sideBySideMinimumWidth = minimumReadableColumnWidth * 2 + interColumnSpacing

  static func presentation(availableWidth: CGFloat) -> RuntimeObservabilityPresentation {
    availableWidth >= sideBySideMinimumWidth ? .sideBySide : .compact
  }
}

enum RuntimeObservationPhase: Equatable {
  case queued
  case running
  case waiting
  case blocked
  case succeeded
  case failed
  case cancelled
  case unknown

  init(status: String) {
    switch status.lowercased() {
    case "pending", "queued": self = .queued
    case "in_progress", "running", "answering": self = .running
    case "delivered", "acknowledged", "waiting", "interrupt": self = .waiting
    case "blocked", "stale": self = .blocked
    case "completed", "succeeded", "done", "answered": self = .succeeded
    case "failed", "error", "expired": self = .failed
    case "cancelled", "aborted", "interrupted": self = .cancelled
    default: self = .unknown
    }
  }

  var isInProgress: Bool {
    switch self {
    case .queued, .running, .waiting: return true
    case .blocked, .succeeded, .failed, .cancelled, .unknown: return false
    }
  }

  var color: Color {
    switch self {
    case .queued, .running: return .blue
    case .waiting: return .orange
    case .blocked, .failed: return .red
    case .succeeded: return .green
    case .cancelled, .unknown: return .secondary
    }
  }
}

struct RuntimeRequestReceiptProjection: Equatable {
  let runtimeRequestID: String
  let dispatchCorrelationID: String?
  let policy: String
  let queueStatus: String
  let requestStatus: String?
  let deliveryMode: String
  let requestKind: String
  let affectsActiveWork: Bool
  let hasVisibleReply: Bool
  let message: String
}

struct RuntimeRequestObservabilityProjection {
  let inputs: [CanvastRuntimeInput]
  let requests: [CanvastRuntimeRequest]
  let receipt: RuntimeRequestReceiptProjection?

  init(
    status: CanvastRuntimeStatusSummary,
    receipt acceptedReceipt: DesktopRequestControlResult?,
    dispatchCorrelationID: String?
  ) {
    inputs = status.inputQueue.sorted { observationRank($0.status) > observationRank($1.status) }
    requests = status.requests.sorted { observationRank($0.status) > observationRank($1.status) }
    guard let acceptedReceipt else {
      receipt = nil
      return
    }
    let input = status.inputQueue.last { $0.requestID == acceptedReceipt.runtimeRequestID }
    let request = status.requests.last { $0.requestID == acceptedReceipt.runtimeRequestID }
    receipt = RuntimeRequestReceiptProjection(
      runtimeRequestID: acceptedReceipt.runtimeRequestID,
      dispatchCorrelationID: dispatchCorrelationID,
      policy: acceptedReceipt.policy.rawValue,
      queueStatus: input?.status ?? acceptedReceipt.queueStatus,
      requestStatus: request?.status,
      deliveryMode: input?.deliveryMode ?? request?.deliveryMode ?? acceptedReceipt.deliveryMode,
      requestKind: request?.kind ?? acceptedReceipt.requestKind,
      affectsActiveWork: input?.affectsActiveWork ?? acceptedReceipt.affectsActiveWork,
      hasVisibleReply: request?.hasVisibleReply ?? input?.hasVisibleReply ?? false,
      message: acceptedReceipt.message
    )
  }
}

struct RuntimeToolsEventsProjection {
  let toolRuns: [CanvastRuntimeStatusItem]
  let events: [CanvastRuntimeEvent]

  init(status: CanvastRuntimeStatusSummary) {
    toolRuns = status.toolRuns.sorted { observationRank($0.status) > observationRank($1.status) }
    events = Array(status.events.reversed())
  }
}

private func observationRank(_ status: String) -> Int {
  switch RuntimeObservationPhase(status: status) {
  case .running: return 7
  case .waiting: return 6
  case .queued: return 5
  case .blocked: return 4
  case .failed: return 3
  case .unknown: return 2
  case .cancelled: return 1
  case .succeeded: return 0
  }
}

struct RunRequestObservabilityView: View {
  let status: CanvastRuntimeStatusSummary
  let receipt: DesktopRequestControlResult?
  let dispatchCorrelationID: String?
  let isRefreshing: Bool
  @Environment(\.canvastLocalizer) private var localizer

  private var projection: RuntimeRequestObservabilityProjection {
    RuntimeRequestObservabilityProjection(
      status: status, receipt: receipt, dispatchCorrelationID: dispatchCorrelationID
    )
  }

  var body: some View {
    Panel(localizer.text("Requests", "请求"), systemImage: "tray.full") {
      if let receipt = projection.receipt {
        receiptView(receipt)
        Divider()
      }
      observationHeader(localizer.text("Input queue", "输入队列"), count: projection.inputs.count)
      if projection.inputs.isEmpty {
        observationEmpty(localizer.text("No queued input in the current runtime snapshot.", "当前运行时快照中没有排队输入。"))
      } else {
        ForEach(projection.inputs.prefix(6)) { input in
          runtimeInputRow(input)
        }
      }
      Divider()
      observationHeader(localizer.text("Request lifecycle", "请求生命周期"), count: projection.requests.count)
      if projection.requests.isEmpty {
        observationEmpty(localizer.text("No correlated requests have been recorded.", "尚未记录相关请求。"))
      } else {
        ForEach(projection.requests.prefix(8)) { request in
          runtimeRequestRow(request)
        }
      }
      freshnessFooter(updatedAt: status.updatedAt, isRefreshing: isRefreshing, localizer: localizer)
    }
  }

  private func receiptView(_ receipt: RuntimeRequestReceiptProjection) -> some View {
    VStack(alignment: .leading, spacing: 7) {
      observationHeader(localizer.text("Latest structured receipt", "最新结构化回执"), count: nil)
      HStack(alignment: .firstTextBaseline) {
        Text(receipt.runtimeRequestID).font(.caption.monospaced()).textSelection(.enabled)
        Spacer()
        observationBadge(receipt.requestStatus ?? receipt.queueStatus, localizer: localizer)
      }
      Text(receipt.message).font(.caption).foregroundStyle(.secondary)
      LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 8)], alignment: .leading) {
        observationValue(localizer.text("Policy", "策略"), humanized(receipt.policy, localizer: localizer))
        observationValue(localizer.text("Queue", "队列"), humanized(receipt.queueStatus, localizer: localizer))
        observationValue(localizer.text("Delivery", "投递"), receipt.deliveryMode.isEmpty ? localizer.dynamic("unknown") : humanized(receipt.deliveryMode, localizer: localizer))
        observationValue(localizer.text("Reply", "回复"), receipt.hasVisibleReply ? localizer.dynamic("visible") : localizer.dynamic("pending"))
        if let dispatchCorrelationID, !dispatchCorrelationID.isEmpty {
          observationValue(localizer.text("Dispatch", "派发"), dispatchCorrelationID)
        }
      }
      if receipt.affectsActiveWork {
        Label(localizer.text("This request is allowed to affect the active work.", "该请求允许影响当前活动工作。"), systemImage: "exclamationmark.triangle")
          .font(.caption)
          .foregroundStyle(.orange)
      }
    }
  }

  private func runtimeInputRow(_ input: CanvastRuntimeInput) -> some View {
    VStack(alignment: .leading, spacing: 5) {
      HStack(alignment: .firstTextBaseline) {
        Text(input.textSummary)
          .font(.subheadline.weight(.medium))
          .fixedSize(horizontal: false, vertical: true)
        Spacer()
        observationBadge(input.status, localizer: localizer)
      }
      HStack(spacing: 8) {
        Text(humanized(input.policy, localizer: localizer))
        if let deliveryMode = input.deliveryMode { Text(humanized(deliveryMode, localizer: localizer)) }
        if input.affectsActiveWork { Text(localizer.text("affects active work", "会影响当前工作")).foregroundStyle(.orange) }
      }
      .font(.caption2)
      .foregroundStyle(.secondary)
      if let requestID = input.requestID {
        Text(requestID).font(.caption2.monospaced()).foregroundStyle(.tertiary).textSelection(.enabled)
      }
      if let failureReason = input.failureReason {
        Text(failureReason).font(.caption).foregroundStyle(.red).textSelection(.enabled)
      }
    }
  }

  private func runtimeRequestRow(_ request: CanvastRuntimeRequest) -> some View {
    VStack(alignment: .leading, spacing: 5) {
      HStack(alignment: .firstTextBaseline) {
        Text(request.textSummary)
          .font(.subheadline.weight(.medium))
          .fixedSize(horizontal: false, vertical: true)
        Spacer()
        observationBadge(request.status, localizer: localizer)
      }
      HStack(spacing: 8) {
        Text(humanized(request.kind, localizer: localizer))
        Text(request.hasVisibleReply ? localizer.dynamic("visible_reply") : localizer.dynamic("reply_pending"))
      }
      .font(.caption2)
      .foregroundStyle(request.hasVisibleReply ? Color.green : Color.secondary)
      Text(request.requestID).font(.caption2.monospaced()).foregroundStyle(.tertiary).textSelection(.enabled)
      if let failureReason = request.failureReason {
        Text(failureReason).font(.caption).foregroundStyle(.red).textSelection(.enabled)
      }
    }
  }
}

struct RuntimeToolsEventsView: View {
  let status: CanvastRuntimeStatusSummary
  let isRefreshing: Bool
  let availableWidth: CGFloat
  @Environment(\.canvastLocalizer) private var localizer

  private var projection: RuntimeToolsEventsProjection { RuntimeToolsEventsProjection(status: status) }

  @ViewBuilder
  var body: some View {
    if RuntimeObservabilityLayout.presentation(availableWidth: availableWidth) == .sideBySide {
      HStack(alignment: .top, spacing: RuntimeObservabilityLayout.interColumnSpacing) {
        toolRunsPanel
          .frame(minWidth: RuntimeObservabilityLayout.minimumReadableColumnWidth)
        runtimeEventsPanel
          .frame(minWidth: RuntimeObservabilityLayout.minimumReadableColumnWidth)
      }
    } else {
      VStack(alignment: .leading, spacing: 16) {
        toolRunsPanel
        runtimeEventsPanel
      }
    }
  }

  private var toolRunsPanel: some View {
    Panel(localizer.text("Tool runs", "工具运行"), systemImage: "hammer") {
      if projection.toolRuns.isEmpty {
        observationEmpty(localizer.text(
          "No tool run has been recorded in the current runtime snapshot.",
          "当前运行时快照中尚未记录工具运行。"
        ))
      } else {
        ForEach(Array(projection.toolRuns.prefix(12).enumerated()), id: \.element.id) { index, item in
          RuntimeItemRow(item: item, showConnector: index < min(projection.toolRuns.count, 12) - 1)
        }
      }
      freshnessFooter(updatedAt: status.updatedAt, isRefreshing: isRefreshing, localizer: localizer)
    }
  }

  private var runtimeEventsPanel: some View {
    Panel(localizer.text("Runtime events", "运行时事件"), systemImage: "waveform.path.ecg") {
      if projection.events.isEmpty {
        observationEmpty(localizer.text(
          "No bounded runtime event has been recorded yet.",
          "尚未记录有界运行时事件。"
        ))
      } else {
        ForEach(projection.events.prefix(16)) { event in
          runtimeEventRow(event)
        }
      }
      freshnessFooter(updatedAt: status.updatedAt, isRefreshing: isRefreshing, localizer: localizer)
    }
  }

  private func runtimeEventRow(_ event: CanvastRuntimeEvent) -> some View {
    VStack(alignment: .leading, spacing: 5) {
      HStack(alignment: .firstTextBaseline) {
        Text(event.title)
          .font(.subheadline.weight(.medium))
          .fixedSize(horizontal: false, vertical: true)
        Spacer()
        StatusBadge(text: humanized(event.kind, localizer: localizer), color: .blue)
      }
      if let summary = event.summary, !summary.isEmpty {
        if event.sidecarDispatch == nil {
          Text(summary)
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      if let dispatch = event.sidecarDispatch { SidecarDispatchDecisionView(dispatch: dispatch) }
      HStack(spacing: 8) {
        Text(event.source)
        if !event.timestamp.isEmpty { Text(event.timestamp) }
      }
      .font(.caption2)
      .foregroundStyle(.tertiary)
    }
  }
}

private func observationHeader(_ title: String, count: Int?) -> some View {
  HStack {
    Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
    Spacer()
    if let count { Text("\(count)").font(.caption2.monospacedDigit()).foregroundStyle(.tertiary) }
  }
}

private func observationBadge(_ status: String, localizer: CanvastLocalizer) -> some View {
  let phase = RuntimeObservationPhase(status: status)
  return HStack(spacing: 5) {
    if phase.isInProgress { ProgressView().controlSize(.small) }
    Text(humanized(status.isEmpty ? "unknown" : status, localizer: localizer))
  }
  .font(.caption.weight(.medium))
  .foregroundStyle(phase.color)
  .padding(.horizontal, 8)
  .padding(.vertical, 4)
  .background(phase.color.opacity(0.12), in: Capsule())
}

private func observationValue(_ label: String, _ value: String) -> some View {
  VStack(alignment: .leading, spacing: 2) {
    Text(label).font(.caption2).foregroundStyle(.tertiary)
    ScrollableMonospacedText(value: value)
  }
}

private func observationEmpty(_ detail: String) -> some View {
  Text(detail).font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, minHeight: 34, alignment: .leading)
}

private func freshnessFooter(
  updatedAt: String,
  isRefreshing: Bool,
  localizer: CanvastLocalizer
) -> some View {
  let message = if isRefreshing {
    localizer.text("Refreshing persisted runtime state.", "正在刷新持久化运行时状态。")
  } else if updatedAt.isEmpty {
    localizer.text("No runtime snapshot has been recorded.", "尚未记录运行时快照。")
  } else {
    localizer.text("Snapshot updated \(updatedAt)", "快照更新于 \(updatedAt)")
  }
  return HStack(spacing: 6) {
    if isRefreshing { ProgressView().controlSize(.small) }
    Text(message)
      .font(.caption2)
      .foregroundStyle(.tertiary)
      .textSelection(.enabled)
  }
}
