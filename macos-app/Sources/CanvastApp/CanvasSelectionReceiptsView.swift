import SwiftUI
import CanvastAppCore

struct CanvasSelectionReceiptsView: View {
  let taskSelection: DesktopCanvasTaskSelection?
  let planSelection: DesktopCanvasPlanSelection?
  @Environment(\.canvastLocalizer) private var localizer

  private var receipts: [CanvasSelectionReceipt] {
    CanvasSelectionReceiptProjection.receipts(
      taskSelection: taskSelection,
      planSelection: planSelection
    )
  }

  var body: some View {
    Panel(localizer.text("Runtime selection receipts", "运行时选择回执"), systemImage: "checkmark.seal") {
      VStack(alignment: .leading, spacing: 10) {
        Text(localizer.text("Only confirmed typed runtime replies appear here. Visual row or graph selection does not change runtime scope.", "这里只显示已确认的类型化运行时回复。视觉上的行或图选择不会改变运行时范围。"))
          .font(.caption)
          .foregroundStyle(.secondary)

        if receipts.isEmpty {
          EmptyState(
            title: localizer.text("No runtime selection receipt", "没有运行时选择回执"),
            detail: localizer.text("Use a plan or task as active scope to record the requested and effective identifiers.", "将计划或任务用作活动范围，以记录请求值和生效值。"),
            systemImage: "scope"
          )
        } else {
          LazyVGrid(
            columns: [GridItem(.adaptive(minimum: 300), spacing: 10)],
            alignment: .leading, spacing: 10
          ) {
            ForEach(receipts) { receipt in
              receiptCard(receipt)
            }
          }
        }
      }
    }
  }

  private func receiptCard(_ receipt: CanvasSelectionReceipt) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Label(receipt.title, systemImage: receipt.systemImage)
          .font(.subheadline.weight(.semibold))
        Spacer()
        StatusBadge(text: humanized(receipt.nodeType, localizer: localizer), color: .green)
      }
      receiptRow(localizer.dynamic("requested"), receipt.requestedID)
      receiptRow(localizer.dynamic("effective"), receipt.effectiveID)
      Text(receipt.message)
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .topLeading)
    .background(Color.green.opacity(0.07), in: RoundedRectangle(cornerRadius: 9))
    .overlay(RoundedRectangle(cornerRadius: 9).stroke(Color.green.opacity(0.25)))
  }

  private func receiptRow(_ label: String, _ value: String) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(label).font(.caption2).foregroundStyle(.secondary)
      ScrollableMonospacedText(value: value)
    }
  }
}

struct CanvasSelectionReceipt: Identifiable, Equatable {
  let id: String
  let title: String
  let systemImage: String
  let requestedID: String
  let effectiveID: String
  let nodeType: String
  let message: String
}

enum CanvasSelectionReceiptProjection {
  static func receipts(
    taskSelection: DesktopCanvasTaskSelection?,
    planSelection: DesktopCanvasPlanSelection?
  ) -> [CanvasSelectionReceipt] {
    let localizer = CanvastLocalizationRuntime.localizer
    var result: [CanvasSelectionReceipt] = []
    if let taskSelection {
      result.append(CanvasSelectionReceipt(
        id: "task:\(taskSelection.currentTaskID)", title: localizer.text("Active task", "当前任务"),
        systemImage: "checklist", requestedID: taskSelection.nodeID,
        effectiveID: taskSelection.currentTaskID, nodeType: taskSelection.nodeType,
        message: taskSelection.message
      ))
    }
    if let planSelection {
      result.append(CanvasSelectionReceipt(
        id: "plan:\(planSelection.activePlanID)", title: localizer.text("Active plan", "当前计划"),
        systemImage: "map", requestedID: planSelection.planID,
        effectiveID: planSelection.activePlanID, nodeType: planSelection.nodeType,
        message: planSelection.message
      ))
    }
    return result
  }
}

struct CanvasSelectionReceiptStrip: View {
  let taskSelection: DesktopCanvasTaskSelection?
  let planSelection: DesktopCanvasPlanSelection?
  @Environment(\.canvastLocalizer) private var localizer

  private var receipts: [CanvasSelectionReceipt] {
    CanvasSelectionReceiptProjection.receipts(
      taskSelection: taskSelection,
      planSelection: planSelection
    )
  }

  var body: some View {
    if !receipts.isEmpty {
      ViewThatFits(in: .horizontal) {
        HStack(spacing: 10) { receiptBadges }
        VStack(alignment: .leading, spacing: 6) { receiptBadges }
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 8)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Color.green.opacity(0.07), in: RoundedRectangle(cornerRadius: 8))
      .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.green.opacity(0.22)))
    }
  }

  @ViewBuilder
  private var receiptBadges: some View {
    ForEach(receipts) { receipt in
      Label(
        "\(receipt.title): \(receipt.effectiveID)",
        systemImage: receipt.systemImage
      )
      .font(.caption.monospaced())
      .fixedSize(horizontal: false, vertical: true)
      .help(localizer.text("Requested", "请求值") + " \(receipt.requestedID). \(receipt.message)")
      .textSelection(.enabled)
    }
  }
}
