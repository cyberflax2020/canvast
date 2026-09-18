import SwiftUI
import CanvastAppCore

struct PlanUpdateControlsView: View {
  let selectedPlan: CanvastRuntimeStatusItem?
  @Binding var targetStatus: String
  let actionSnapshot: DesktopActionSnapshot?
  let isLocked: Bool
  let submit: (CanvastRuntimeStatusItem, String) -> Void
  @Environment(\.canvastLocalizer) private var localizer

  var body: some View {
    Panel(localizer.text("Plan status update", "计划状态更新"), systemImage: "arrow.triangle.2.circlepath") {
      VStack(alignment: .leading, spacing: 10) {
        if let selectedPlan {
          HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 3) {
              Text(selectedPlan.title)
                .font(.subheadline.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
              Text(selectedPlan.id)
                .font(.caption2.monospaced())
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
            }
            Spacer()
            StatusBadge(text: humanized(selectedPlan.status, localizer: localizer), color: .blue)
          }
        } else {
          Text(localizer.text("Select a plan row to prepare a typed plan.update request.", "选择一个计划行以准备类型化 plan.update 请求。"))
            .font(.caption)
            .foregroundStyle(.secondary)
        }

        ViewThatFits(in: .horizontal) {
          HStack(spacing: 10) { updateControls }
          VStack(alignment: .leading, spacing: 8) { updateControls }
        }

        HStack(alignment: .top, spacing: 7) {
          Image(systemName: "info.circle").foregroundStyle(.orange)
          Text(PlanUpdateRuntimeCapability.current.message)
            .font(.caption2)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
  }

  @ViewBuilder
  private var updateControls: some View {
    Picker(localizer.text("Target status", "目标状态"), selection: $targetStatus) {
      ForEach(PlanUpdateStatus.allCases) { status in
        Text(status.title(localizer: localizer)).tag(status.rawValue)
      }
    }
    .frame(minWidth: 190)
    Button(localizer.text("Request Plan Update", "请求计划更新")) {
      guard let selectedPlan else { return }
      submit(selectedPlan, targetStatus)
    }
    .buttonStyle(.borderedProminent)
    .disabled(!canSubmit)
    LifecycleStateBadge(snapshot: actionSnapshot)
  }

  private var canSubmit: Bool {
    guard let selectedPlan else { return false }
    return !isLocked && selectedPlan.status.caseInsensitiveCompare(targetStatus) != .orderedSame
  }
}

enum PlanUpdateStatus: String, CaseIterable, Identifiable {
  case inProgress = "in_progress"
  case completed

  var id: String { rawValue }
  func title(localizer: CanvastLocalizer = CanvastLocalizationRuntime.localizer) -> String {
    humanized(rawValue, localizer: localizer)
  }
}

struct PlanUpdateRuntimeCapability: Equatable {
  let actionKind: String
  let canMutateCanonicalPlan: Bool
  let message: String

  static var current: PlanUpdateRuntimeCapability {
    .init(
      actionKind: "plan.update",
      canMutateCanonicalPlan: true,
      message: CanvastLocalizationRuntime.localizer.text(
        "This control updates the runtime-owned active plan through its canonical lifecycle. Only in-progress and completed transitions are supported; historical plans remain read-only.",
        "此控件通过规范生命周期更新运行时持有的当前计划。仅支持进行中和已完成转换；历史计划保持只读。"
      )
    )
  }
}
