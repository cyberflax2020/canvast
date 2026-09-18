import SwiftUI
import CanvastAppCore

struct TaskPlanView: View {
  @EnvironmentObject private var model: CanvastDesktopModel
  @State private var searchText = ""
  @State private var selectedID: String?
  @State private var selectedKind: PlanningItemKind?
  @State private var showCompleted = false
  @State private var newItemTitle = ""
  @State private var lifecycleNote = ""
  @State private var planUpdateStatus = PlanUpdateStatus.inProgress.rawValue

  private var currentPlans: [CanvastRuntimeStatusItem] {
    matching(TaskPlanProjection.current(model.state.runtimeStatus.plans, root: model.state.runtimeStatus.rootExecution))
  }
  private var currentTasks: [CanvastRuntimeStatusItem] {
    matching(TaskPlanProjection.current(model.state.runtimeStatus.tasks, root: model.state.runtimeStatus.rootExecution))
  }
  private var historyPlans: [CanvastRuntimeStatusItem] {
    showCompleted
      ? matching(TaskPlanProjection.history(model.state.runtimeStatus.plans, root: model.state.runtimeStatus.rootExecution))
      : []
  }
  private var historyTasks: [CanvastRuntimeStatusItem] {
    showCompleted
      ? matching(TaskPlanProjection.history(model.state.runtimeStatus.tasks, root: model.state.runtimeStatus.rootExecution))
      : []
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        WorkspaceTitle(workspace: .taskPlan, trailing: AnyView(refreshButton))
        summaryStrip
        actionBar
        PlanUpdateControlsView(
          selectedPlan: selectedPlan,
          targetStatus: $planUpdateStatus,
          actionSnapshot: actionSnapshot(model, .updatePlan),
          isLocked: actionLocked(model, .updatePlan),
          submit: { plan, status in update(plan, kind: .plan, status: status) }
        )
        filterBar
        HStack(alignment: .top, spacing: 14) {
          Panel(model.localizer.dynamic("plans"), systemImage: "map") {
            planningSections(
              current: currentPlans,
              history: historyPlans,
              kind: .plan,
              emptyCurrentTitle: model.localizer.text("No current plans", "没有当前计划"),
              emptyCurrentDetail: model.localizer.text("Current contains only plans owned by the active run.", "当前区域仅显示由活动运行持有的计划。"),
              emptyHistoryTitle: model.localizer.text("No plan history", "没有计划历史")
            )
          }
          Panel(model.localizer.dynamic("tasks"), systemImage: "checklist") {
            planningSections(
              current: currentTasks,
              history: historyTasks,
              kind: .task,
              emptyCurrentTitle: model.localizer.text("No current tasks", "没有当前任务"),
              emptyCurrentDetail: model.localizer.text("A new session with no tasks remains empty even when older task history exists.", "即使存在旧任务历史，没有任务的新会话仍保持为空。"),
              emptyHistoryTitle: model.localizer.text("No task history", "没有任务历史")
            )
          }
        }
        CanvasSelectionReceiptsView(
          taskSelection: model.canvasTaskSelection,
          planSelection: model.canvasPlanSelection
        )
        planGraphSection
      }
      .padding(18)
    }
    .background(Color(nsColor: .windowBackgroundColor))
  }

  private var refreshButton: some View {
    Button { model.refresh() } label: { Label(model.localizer.dynamic("refresh"), systemImage: "arrow.clockwise") }
      .disabled(actionLocked(model, .refreshWorkspace))
  }

  private var actionBar: some View {
    Panel(model.localizer.text("Structured planning actions", "结构化规划操作"), systemImage: "plus.square.on.square") {
      VStack(alignment: .leading, spacing: 10) {
        HStack(spacing: 8) {
          TextField(model.localizer.text("Plan goal or task title", "计划目标或任务标题"), text: $newItemTitle).textFieldStyle(.roundedBorder)
          Button(model.localizer.text("Create Plan", "创建计划")) { model.createPlan(title: newItemTitle) }
            .disabled(newItemTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || actionLocked(model, .createPlan))
          Button(model.localizer.text("Create Task", "创建任务")) { model.createTask(subject: newItemTitle) }
            .buttonStyle(.borderedProminent)
            .disabled(newItemTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || actionLocked(model, .createTask))
          ActionStateBadge(state: model.actionState)
        }
        Divider()
        HStack(spacing: 8) {
          TextField(model.localizer.text("Optional approval notes or completion summary", "可选审批备注或完成摘要"), text: $lifecycleNote)
            .textFieldStyle(.roundedBorder)
          Button(model.localizer.text("Approve Current Plan", "批准当前计划")) { model.approvePlan(notes: optionalLifecycleNote) }
            .disabled(!model.hasCurrentPlanLifecycle || actionLocked(model, .approvePlan))
          Button(model.localizer.text("Complete Current Plan", "完成当前计划")) { model.completePlan(summary: optionalLifecycleNote) }
            .disabled(!model.hasCurrentPlanLifecycle || actionLocked(model, .completePlan))
        }
        Text(model.localizer.text("Lifecycle actions target the runtime-owned current plan, not the visually selected historical row.", "生命周期操作针对运行时持有的当前计划，而不是视觉上选中的历史行。"))
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
  }

  private var optionalLifecycleNote: String? {
    let trimmed = lifecycleNote.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  private var selectedPlan: CanvastRuntimeStatusItem? {
    guard selectedKind == .plan, let selectedID else { return nil }
    return model.state.runtimeStatus.plans.first { $0.id == selectedID }
  }

  private var summaryStrip: some View {
    AdaptiveMetricGrid(minimumColumnWidth: 190) {
      MetricCard(
        title: model.localizer.text("Plan progress", "计划进度"),
        value: "\(completed(model.state.runtimeStatus.plans))/\(model.state.runtimeStatus.plans.count)",
        detail: model.localizer.text("completed plans", "已完成计划"),
        color: .blue,
        progress: ratio(model.state.runtimeStatus.plans)
      )
      MetricCard(
        title: model.localizer.text("Task progress", "任务进度"),
        value: "\(completed(model.state.runtimeStatus.tasks))/\(model.state.runtimeStatus.tasks.count)",
        detail: model.localizer.text("completed tasks", "已完成任务"),
        color: .green,
        progress: ratio(model.state.runtimeStatus.tasks)
      )
      MetricCard(
        title: model.localizer.text("Open work", "未结工作"),
        value: "\(model.state.runtimeStatus.openTaskCount)",
        detail: model.localizer.text("pending, active, or blocked", "待处理、进行中或阻塞"),
        color: model.state.runtimeStatus.openTaskCount == 0 ? .green : .orange
      )
      MetricCard(
        title: model.localizer.text("Closure", "闭环"),
        value: "\(model.state.closure.closed)/\(model.state.closure.required)",
        detail: model.state.closure.deliverable
          ? model.localizer.text("delivery gates closed", "交付门已关闭")
          : model.localizer.language == .english
            ? "\(model.state.closure.open) gates remain"
            : "还剩 \(model.state.closure.open) 个门",
        color: model.state.closure.deliverable ? .green : .orange,
        progress: model.state.closure.required == 0 ? 0 : Double(model.state.closure.closed) / Double(model.state.closure.required)
      )
    }
  }

  private var filterBar: some View {
    HStack {
      TextField(model.localizer.text("Search plans and tasks", "搜索计划和任务"), text: $searchText)
        .textFieldStyle(.roundedBorder)
        .frame(maxWidth: 360)
      Toggle(
        model.localizer.text("Show completed and archived History", "显示已完成及归档历史"),
        isOn: $showCompleted
      )
      .toggleStyle(.switch)
      Spacer()
      if let selectedID {
        Button { focusOnCanvas(selectedID) } label: { Label(model.localizer.text("Show on Canvas", "在画布中显示"), systemImage: "scope") }
        if hasCanvasNode(selectedID), selectedKind == .plan {
          Button(model.localizer.text("Use as Active Plan", "设为当前计划")) { model.selectCanvasPlan(planID: selectedID) }
            .disabled(actionLocked(model, .selectCanvasPlan))
        } else if hasCanvasNode(selectedID), selectedKind == .task {
          Button(model.localizer.text("Use as Active Task", "设为当前任务")) { model.selectCanvasTask(nodeID: selectedID) }
            .disabled(actionLocked(model, .selectCanvasTask))
        }
      }
    }
  }

  @ViewBuilder
  private func planningSections(
    current: [CanvastRuntimeStatusItem],
    history: [CanvastRuntimeStatusItem],
    kind: PlanningItemKind,
    emptyCurrentTitle: String,
    emptyCurrentDetail: String,
    emptyHistoryTitle: String
  ) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Label(model.localizer.text("Current", "当前"), systemImage: "bolt.fill")
        .font(.subheadline.weight(.semibold))
      Text(model.localizer.text(
        "Open or pending means not started or waiting on dependencies. In progress means current execution.",
        "open 或 pending 表示尚未开始或等待依赖；in progress 表示当前执行。"
      ))
      .font(.caption)
      .foregroundStyle(.secondary)
      itemList(
        current,
        kind: kind,
        emptyTitle: emptyCurrentTitle,
        emptyDetail: emptyCurrentDetail
      )

      if showCompleted {
        Divider()
        Label(model.localizer.text("History", "历史"), systemImage: "clock.arrow.circlepath")
          .font(.subheadline.weight(.semibold))
        Text(model.localizer.text(
          "Done, completed, terminal, and archived items remain in History and never mix into Current.",
          "done、completed、终态及归档项保留在历史中，不会混入当前区域。"
        ))
        .font(.caption)
        .foregroundStyle(.secondary)
        itemList(
          history,
          kind: kind,
          emptyTitle: emptyHistoryTitle,
          emptyDetail: model.localizer.text("No completed or archived items match this search.", "没有符合当前搜索的已完成或归档项。")
        )
      }
    }
  }

  @ViewBuilder
  private func itemList(_ items: [CanvastRuntimeStatusItem], kind: PlanningItemKind, emptyTitle: String, emptyDetail: String) -> some View {
    if items.isEmpty {
      EmptyState(title: emptyTitle, detail: emptyDetail, systemImage: "checklist")
    } else {
      LazyVStack(alignment: .leading, spacing: 10) {
        ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
          Button { select(item, kind: kind) } label: {
            RuntimeItemRow(item: item, showConnector: index < items.count - 1)
              .padding(8)
              .background(selectedID == item.id ? Color.accentColor.opacity(0.1) : Color.clear, in: RoundedRectangle(cornerRadius: 8))
          }
          .buttonStyle(.plain)
          .contextMenu {
            Button(model.localizer.text("Show on Canvas", "在画布中显示")) { focusOnCanvas(item.id) }
            if hasCanvasNode(item.id) {
              switch kind {
              case .plan:
                Button(model.localizer.text("Use as Active Plan", "设为当前计划")) { model.selectCanvasPlan(planID: item.id) }
                  .disabled(actionLocked(model, .selectCanvasPlan))
              case .task:
                Button(model.localizer.text("Use as Active Task", "设为当前任务")) { model.selectCanvasTask(nodeID: item.id) }
                  .disabled(actionLocked(model, .selectCanvasTask))
              }
            }
            Button(model.localizer.text("Prepare status request", "准备状态请求")) { prepareStatusRequest(item) }
            if kind == .task {
              Divider()
              Button(model.localizer.text("Mark In Progress", "标记为进行中")) { update(item, kind: kind, status: "in_progress") }
                .disabled(actionLocked(model, .updateTask))
              Button(model.localizer.text("Mark Completed", "标记为已完成")) { update(item, kind: kind, status: "completed") }
                .disabled(actionLocked(model, .updateTask))
            }
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .topLeading)
    }
  }

  private var planGraphSection: some View {
    Panel(model.localizer.text("Plan traceability", "计划可追溯性"), systemImage: "point.3.connected.trianglepath.dotted") {
      let planNodes = model.canvasGraph.nodes.filter { $0.type == .plan }
      if planNodes.isEmpty {
        EmptyState(
          title: model.localizer.text("No persisted Plan nodes", "没有持久化计划节点"),
          detail: model.localizer.text("Refresh after a plan is recorded to inspect its task, decision, and execution links.", "在记录计划后刷新，以检查其任务、决策和执行链接。"),
          systemImage: "map"
        )
      } else {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 230), spacing: 10)], spacing: 10) {
          ForEach(planNodes) { node in
            Button { model.focusCanvasNode(node.id) } label: {
              VStack(alignment: .leading, spacing: 7) {
                HStack {
                  Image(systemName: node.type.symbol).foregroundStyle(node.type.color)
                  Text(node.title)
                    .font(.headline)
                    .fixedSize(horizontal: false, vertical: true)
                  Spacer()
                  Image(systemName: "arrow.up.right.square").foregroundStyle(.tertiary)
                }
                Text(node.subtitle)
                  .font(.caption)
                  .foregroundStyle(.secondary)
                  .fixedSize(horizontal: false, vertical: true)
                Text(model.localizer.language == .english ? "\(linkedCount(node.id)) linked records" : "\(linkedCount(node.id)) 条关联记录")
                  .font(.caption2)
                  .foregroundStyle(.tertiary)
              }
              .padding(12)
              .frame(maxWidth: .infinity, minHeight: 90, alignment: .topLeading)
              .background(node.type.color.opacity(0.07), in: RoundedRectangle(cornerRadius: 9))
            }
            .buttonStyle(.plain)
          }
        }
      }
    }
  }

  private func matching(_ items: [CanvastRuntimeStatusItem]) -> [CanvastRuntimeStatusItem] {
    let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return items.filter { item in
      if query.isEmpty { return true }
      return [item.id, item.title, item.status, item.summary ?? ""].joined(separator: " " ).lowercased().contains(query)
    }
  }

  private func completed(_ items: [CanvastRuntimeStatusItem]) -> Int {
    items.filter { ["completed", "succeeded", "done"].contains($0.status.lowercased()) }.count
  }

  private func ratio(_ items: [CanvastRuntimeStatusItem]) -> Double {
    items.isEmpty ? 0 : Double(completed(items)) / Double(items.count)
  }

  private func linkedCount(_ id: String) -> Int {
    model.canvasGraph.edges.filter { $0.sourceID == id || $0.targetID == id }.count
  }

  private func hasCanvasNode(_ id: String) -> Bool {
    model.canvasGraph.nodes.contains { $0.id == id }
  }

  private func focusOnCanvas(_ id: String) {
    if model.canvasGraph.nodes.contains(where: { $0.id == id }) {
      model.focusCanvasNode(id)
    } else {
      model.searchCanvas(for: id)
    }
  }

  private func select(_ item: CanvastRuntimeStatusItem, kind: PlanningItemKind) {
    selectedID = item.id
    selectedKind = kind
    if kind == .plan, let status = PlanUpdateStatus(rawValue: item.status.lowercased()) {
      planUpdateStatus = status.rawValue
    }
  }

  private func prepareStatusRequest(_ item: CanvastRuntimeStatusItem) {
    model.prepareRequest(
      model.localizer.text(
        "Summarize the current status, blockers, and next action for \(item.title) (\(item.id)).",
        "总结 \(item.title)（\(item.id)）的当前状态、阻塞项和下一步动作。"
      ),
      status: model.localizer.text(
        "Prepared a status request for \(item.title). Press Run to execute it.",
        "已为 \(item.title) 准备状态请求。点击运行以执行。"
      )
    )
  }

  private func update(_ item: CanvastRuntimeStatusItem, kind: PlanningItemKind, status: String) {
    switch kind {
    case .plan: model.updatePlan(id: item.id, status: status)
    case .task: model.updateTask(id: item.id, status: status)
    }
  }
}

private enum PlanningItemKind: Equatable { case plan, task }

struct TaskPlanProjection {
  private static let terminalStatuses: Set<String> = [
    "completed", "done", "succeeded", "failed", "aborted", "expired",
    "cancelled", "canceled", "deleted", "stale",
  ]

  static func current(
    _ items: [CanvastRuntimeStatusItem],
    root: CanvastRootExecution
  ) -> [CanvastRuntimeStatusItem] {
    guard root.state != .idle, root.state != .done, let rootRequestID = root.rootRequestID else { return [] }
    return items.filter { item in
      item.id != "session-runtime" &&
        !terminalStatuses.contains(item.status.lowercased()) &&
        item.rootRequestID == rootRequestID
    }
  }

  static func history(
    _ items: [CanvastRuntimeStatusItem],
    root: CanvastRootExecution
  ) -> [CanvastRuntimeStatusItem] {
    let currentIDs = Set(current(items, root: root).map(\.id))
    return items.filter { $0.id != "session-runtime" && !currentIDs.contains($0.id) }
  }
}
