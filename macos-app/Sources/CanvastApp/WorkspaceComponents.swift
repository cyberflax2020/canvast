import SwiftUI
import CanvastAppCore

@MainActor
func actionLocked(_ model: CanvastDesktopModel, _ id: DesktopUIActionID) -> Bool {
  model.isActionLocked(id)
}

@MainActor
func actionSnapshot(_ model: CanvastDesktopModel, _ id: DesktopUIActionID) -> DesktopActionSnapshot? {
  model.actionSnapshot(id)
}

struct WorkspaceTitle: View {
  let workspace: DesktopWorkspace
  var trailing: AnyView? = nil

  var body: some View {
    ViewThatFits(in: .horizontal) {
      HStack(alignment: .center, spacing: 12) {
        titleBlock
        Spacer(minLength: 8)
        trailing?.fixedSize(horizontal: true, vertical: false)
      }
      VStack(alignment: .leading, spacing: 10) {
        titleBlock
        if let trailing {
          trailing
            .frame(maxWidth: .infinity, alignment: .leading)
        }
      }
    }
  }

  private var titleBlock: some View {
    HStack(alignment: .center, spacing: 12) {
      Image(systemName: workspace.symbol)
        .font(.title2)
        .foregroundStyle(.tint)
        .frame(width: 34, height: 34)
        .background(.tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 9))
      VStack(alignment: .leading, spacing: 2) {
        Text(workspace.title)
          .font(.title2.bold())
          .fixedSize(horizontal: false, vertical: true)
        Text(workspace.subtitle)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      .layoutPriority(1)
    }
  }
}

struct Panel<Content: View>: View {
  let title: String
  let systemImage: String
  let fillsAvailableHeight: Bool
  let content: Content

  init(
    _ title: String,
    systemImage: String,
    fillsAvailableHeight: Bool = false,
    @ViewBuilder content: () -> Content
  ) {
    self.title = title
    self.systemImage = systemImage
    self.fillsAvailableHeight = fillsAvailableHeight
    self.content = content()
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Label(title, systemImage: systemImage).font(.headline)
      content
    }
    .padding(14)
    .frame(
      maxWidth: .infinity,
      maxHeight: fillsAvailableHeight ? CGFloat.infinity : nil,
      alignment: .topLeading
    )
    .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).stroke(.separator.opacity(0.55)))
  }
}

struct MetricCard: View {
  let title: String
  let value: String
  let detail: String
  var color: Color = .accentColor
  var progress: Double? = nil

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      Text(title).font(.caption).foregroundStyle(.secondary)
      Text(value)
        .font(.title3.weight(.semibold))
        .fixedSize(horizontal: false, vertical: true)
      if let progress {
        ProgressView(value: min(max(progress, 0), 1)).tint(color)
      }
      Text(detail)
        .font(.caption2)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(12)
    .frame(maxWidth: .infinity, minHeight: 104, maxHeight: .infinity, alignment: .topLeading)
    .background(color.opacity(0.07), in: RoundedRectangle(cornerRadius: 9))
  }
}

struct AdaptiveMetricGrid<Content: View>: View {
  let minimumColumnWidth: CGFloat
  let spacing: CGFloat
  let content: Content

  init(
    minimumColumnWidth: CGFloat = 180,
    spacing: CGFloat = 12,
    @ViewBuilder content: () -> Content
  ) {
    self.minimumColumnWidth = minimumColumnWidth
    self.spacing = spacing
    self.content = content()
  }

  var body: some View {
    LazyVGrid(
      columns: [GridItem(.adaptive(minimum: minimumColumnWidth), spacing: spacing)],
      alignment: .leading,
      spacing: spacing
    ) {
      content
        .frame(maxWidth: .infinity, minHeight: 104, alignment: .topLeading)
    }
  }
}

struct StatusBadge: View {
  let text: String
  let color: Color
  var systemImage: String? = nil

  var body: some View {
    HStack(spacing: 5) {
      if let systemImage { Image(systemName: systemImage) }
      Text(text)
        .fixedSize(horizontal: false, vertical: true)
    }
    .font(.caption.weight(.medium))
    .foregroundStyle(color)
    .padding(.horizontal, 8)
    .padding(.vertical, 4)
    .background(color.opacity(0.12), in: Capsule())
    .fixedSize(horizontal: true, vertical: false)
  }
}

struct RuntimeItemRow: View {
  let item: CanvastRuntimeStatusItem
  var showConnector: Bool = false

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      VStack(spacing: 0) {
        Circle()
          .fill(statusColor)
          .frame(width: 9, height: 9)
          .padding(.top, 5)
        if showConnector { Rectangle().fill(.separator).frame(width: 1, height: 34) }
      }
      VStack(alignment: .leading, spacing: 3) {
        HStack(alignment: .firstTextBaseline) {
          Text(item.title)
            .font(.subheadline.weight(.medium))
            .fixedSize(horizontal: false, vertical: true)
          Spacer()
          StatusBadge(text: humanized(item.status), color: statusColor)
        }
        if let summary = item.summary, !summary.isEmpty {
          if item.sidecarDispatch == nil {
            Text(summary)
              .font(.caption)
              .foregroundStyle(.secondary)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        if let dispatch = item.sidecarDispatch { SidecarDispatchDecisionView(dispatch: dispatch) }
        HStack(spacing: 8) {
          if !item.updatedAt.isEmpty { Text(item.updatedAt) }
          if let elapsedMs = item.elapsedMs { Text(duration(elapsedMs)) }
        }
        .font(.caption2)
        .foregroundStyle(.tertiary)
      }
    }
  }

  private var statusColor: Color {
    switch item.status.lowercased() {
    case "completed", "succeeded", "done": return .green
    case "in_progress", "running", "active": return .blue
    case "failed", "error", "blocked": return .red
    case "cancelled", "deleted": return .secondary
    default: return .orange
    }
  }
}

struct EmptyState: View {
  let title: String
  let detail: String
  let systemImage: String

  var body: some View {
    VStack(spacing: 8) {
      Image(systemName: systemImage).font(.title2).foregroundStyle(.tertiary)
      Text(title).font(.headline)
      Text(detail).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
    }
    .frame(maxWidth: .infinity, minHeight: 110)
    .padding()
  }
}

struct ActionStateBadge: View {
  @Environment(\.canvastLocalizer) private var localizer
  let state: DesktopActionState

  var body: some View {
    HStack(spacing: 5) {
      if state.isActive { ProgressView().controlSize(.small) }
      Circle().fill(state.color).frame(width: 7, height: 7)
      Text(state.label)
        .fixedSize(horizontal: false, vertical: true)
    }
    .font(.caption)
    .foregroundStyle(.secondary)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(localizer.text("Action status: \(state.label)", "操作状态：\(state.label)"))
  }
}

struct LifecycleStateBadge: View {
  @Environment(\.canvastLocalizer) private var localizer
  let snapshot: DesktopActionSnapshot?

  var body: some View {
    if let snapshot {
      HStack(spacing: 6) {
        if snapshot.isActive {
          ProgressView().controlSize(.small)
        } else {
          Image(systemName: icon)
        }
        Text(snapshot.stage.label)
          .fixedSize(horizontal: false, vertical: true)
      }
      .font(.caption.weight(.semibold))
      .foregroundStyle(color)
      .padding(.horizontal, 10)
      .padding(.vertical, 6)
      .background(color.opacity(0.12), in: Capsule())
      .accessibilityElement(children: .combine)
      .accessibilityLabel(
        localizer.text(
          "Action lifecycle: \(snapshot.status.label), \(snapshot.stage.label)",
          "操作生命周期：\(snapshot.status.label)，\(snapshot.stage.label)"
        )
      )
    } else {
      ActionStateBadge(state: .idle)
    }
  }

  private var color: Color {
    guard let snapshot else { return .secondary }
    switch snapshot.status {
    case .idle: return .secondary
    case .preparing, .queued, .running, .waiting: return .blue
    case .reconciling, .outcomeUnknown: return .orange
    case .succeeded: return .green
    case .reconciled: return .orange
    case .failed, .timedOut: return .red
    case .cancelled: return .orange
    }
  }

  private var icon: String {
    guard let snapshot else { return "circle" }
    switch snapshot.status {
    case .idle: return "circle"
    case .preparing, .queued, .running, .waiting: return "hourglass"
    case .reconciling: return "arrow.clockwise.circle.fill"
    case .outcomeUnknown: return "exclamationmark.triangle.fill"
    case .succeeded, .reconciled: return "checkmark.circle.fill"
    case .failed, .timedOut: return "xmark.octagon.fill"
    case .cancelled: return "arrow.uturn.backward.circle"
    }
  }
}

struct LifecycleInspectorCard: View {
  @EnvironmentObject private var model: CanvastDesktopModel
  @Environment(\.canvastLocalizer) private var localizer
  let snapshot: DesktopActionSnapshot?

  var body: some View {
    Panel(localizer.text("Action lifecycle", "操作生命周期"), systemImage: "point.3.connected.trianglepath.dotted") {
      if let snapshot {
        VStack(alignment: .leading, spacing: 8) {
          HStack(alignment: .firstTextBaseline) {
            Text(snapshot.title)
              .font(.subheadline.weight(.semibold))
              .fixedSize(horizontal: false, vertical: true)
            Spacer()
            StatusBadge(text: snapshot.status.label, color: statusColor(snapshot.status))
          }
          Text(snapshot.stage.label).font(.caption).foregroundStyle(.secondary)
          if let detail = snapshot.stage.detail, !detail.isEmpty {
            Text(detail).font(.caption2).foregroundStyle(.secondary)
          }
          lifecycleRow(localizer.text("Correlation", "关联 ID"), snapshot.correlationID)
          lifecycleRow(localizer.text("Attempt", "尝试次数"), "\(snapshot.attempt)")
          lifecycleRow(localizer.text("Started", "开始时间"), snapshot.startedAt.formatted(date: .omitted, time: .standard))
          lifecycleRow(localizer.text("Updated", "更新时间"), snapshot.updatedAt.formatted(date: .omitted, time: .standard))
          if let heartbeatAt = snapshot.heartbeatAt {
            lifecycleRow(localizer.text("Heartbeat", "心跳"), heartbeatAt.formatted(date: .omitted, time: .standard))
          }
          if let timeoutAt = snapshot.timeoutAt {
            lifecycleRow(localizer.text("Timeout", "超时"), timeoutAt.formatted(date: .omitted, time: .standard))
          }
          if let lastStableState = snapshot.lastStableState, !lastStableState.isEmpty {
            lifecycleRow(localizer.text("Stable", "稳定状态"), lastStableState)
          }
          LazyVGrid(
            columns: [GridItem(.adaptive(minimum: 86), spacing: 8)],
            alignment: .leading,
            spacing: 8
          ) {
            Button(localizer.text("Retry", "重试")) { model.retryAction(snapshot.actionID) }
              .disabled(!snapshot.supportsRetryAction || snapshot.isActive)
            Button(localizer.text("Cancel", "取消")) { model.cancelAction(snapshot.actionID) }
              .disabled(!snapshot.supportsCancel)
            Button(localizer.text("Rollback", "回滚")) { model.rollbackAction(snapshot.actionID) }
              .disabled(!snapshot.supportsRollback || snapshot.isActive)
            if snapshot.supportsReconcile {
              Button(localizer.text("Refresh State", "刷新状态")) { model.reconcileAction(snapshot.actionID) }
            }
            if snapshot.supportsManualResolution {
              Button(localizer.text("Confirm Succeeded", "确认成功")) {
                model.confirmReviewedAction(snapshot.actionID, succeeded: true)
              }
              Button(localizer.text("Confirm Failed", "确认失败")) {
                model.confirmReviewedAction(snapshot.actionID, succeeded: false)
              }
            }
          }
          .buttonStyle(.bordered)
        }
      } else {
        Text(localizer.text("No action has been recorded in this App session.", "当前 App 会话还没有记录任何操作。"))
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
  }

  private func lifecycleRow(_ label: String, _ value: String) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(label).font(.caption2).foregroundStyle(.secondary)
      ScrollableMonospacedText(value: value)
    }
  }

  private func statusColor(_ status: DesktopActionLifecycleStatus) -> Color {
    switch status {
    case .idle: return .secondary
    case .preparing, .queued, .running, .waiting: return .blue
    case .reconciling, .outcomeUnknown: return .orange
    case .succeeded: return .green
    case .reconciled: return .orange
    case .failed, .timedOut: return .red
    case .cancelled: return .orange
    }
  }
}

struct FeatureCard: View {
  @Environment(\.canvastLocalizer) private var localizer
  let feature: CanvastFeature
  let isSelected: Bool
  let action: () -> Void

  var body: some View {
    let capability = CanvastDesktopCapabilityMatrix.capability(for: feature.id)
    Button(action: action) {
      VStack(alignment: .leading, spacing: 8) {
        HStack {
          Image(systemName: feature.symbolName).foregroundStyle(.tint)
          Text(feature.title)
            .font(.headline)
            .foregroundStyle(.primary)
            .fixedSize(horizontal: false, vertical: true)
          Spacer()
          if feature.isEnhanced { Image(systemName: "sparkles").font(.caption).foregroundStyle(.purple) }
        }
        Text(feature.detail)
          .font(.caption)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
        HStack {
          Text(capabilityLabel(capability.level))
            .font(.caption2.weight(.semibold))
            .foregroundStyle(capability.isOperable ? .green : .secondary)
          Spacer()
          Text(actionHint)
            .font(.caption2.monospaced())
            .foregroundStyle(.tertiary)
        }
      }
      .padding(12)
      .frame(maxWidth: .infinity, minHeight: 105, alignment: .topLeading)
      .background(isSelected ? Color.accentColor.opacity(0.12) : Color(nsColor: .controlBackgroundColor))
      .clipShape(RoundedRectangle(cornerRadius: 9))
      .overlay(RoundedRectangle(cornerRadius: 9).stroke(isSelected ? Color.accentColor.opacity(0.65) : Color.secondary.opacity(0.18)))
    }
    .buttonStyle(.plain)
    .accessibilityHint(
      localizer.text(
        "Selects this capability and opens its workspace. It does not execute an action.",
        "选择该能力并打开对应工作区，不会直接执行动作。"
      )
    )
  }

  private func capabilityLabel(_ level: CanvastDesktopCapabilityLevel) -> String {
    switch level {
    case .executable, .editable: return localizer.text("Direct control", "直接控制")
    case .degraded: return localizer.text("Degraded", "降级")
    case .readOnly: return localizer.text("State view", "状态视图")
    case .external: return localizer.text("External", "外部")
    case .unavailable: return localizer.text("Unavailable", "不可用")
    }
  }

  private var actionHint: String {
    switch feature.id {
    case .chat:
      return localizer.text("Open Run", "打开运行")
    case .canvas, .dynamicCanvas:
      return localizer.text("Open Canvas", "打开画布")
    case .planMode, .taskTree, .closure:
      return localizer.text("Open Plan", "打开计划")
    case .subAgents, .workflow, .dynamicWorkflow:
      return localizer.text("Open Agents", "打开 Agent")
    case .sandbox, .permissions, .safety:
      return localizer.text("Open Safety", "打开安全")
    case .context:
      return localizer.text("Open Context", "打开上下文")
    case .sessions:
      return localizer.text("Open Sessions", "打开会话")
    default:
      return localizer.text("Inspect", "查看")
    }
  }
}

func formattedWhole(_ value: Double) -> String {
  NumberFormatter.localizedString(from: NSNumber(value: Int(value.rounded())), number: .decimal)
}

func duration(_ milliseconds: Double) -> String {
  let seconds = max(0, Int(milliseconds / 1_000))
  if seconds < 60 { return "\(seconds)s" }
  let minutes = seconds / 60
  return minutes < 60 ? "\(minutes)m \(seconds % 60)s" : "\(minutes / 60)h \(minutes % 60)m"
}

struct ScrollableMonospacedText: View {
  let value: String
  var font: Font = .caption.monospaced()
  var color: Color = .primary

  var body: some View {
    ViewThatFits(in: .horizontal) {
      Text(value)
        .font(font)
        .foregroundStyle(color)
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
      ScrollView(.horizontal, showsIndicators: true) {
        Text(value)
          .font(font)
          .foregroundStyle(color)
          .textSelection(.enabled)
          .fixedSize(horizontal: true, vertical: true)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
  }
}
