import SwiftUI
import CanvastAppCore

struct AgentsWorkflowView: View {
  @EnvironmentObject private var model: CanvastDesktopModel
  @State private var selectedAgentID: String?
  @State private var selectedWorkflowID: String?
  @State private var searchText = ""
  @State private var actionInput = ""

  private var agents: [CanvastRuntimeStatusItem] { filter(model.state.runtimeStatus.subAgents) }
  private var workflows: [CanvastRuntimeStatusItem] { filter(model.state.runtimeStatus.workflows) }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        WorkspaceTitle(
          workspace: .agentsWorkflow,
          trailing: AnyView(
            Button { model.refresh() } label: { Label(model.localizer.dynamic("refresh"), systemImage: "arrow.clockwise") }
              .disabled(actionLocked(model, .refreshWorkspace))
          )
        )
        AdaptiveMetricGrid(minimumColumnWidth: 190) {
          MetricCard(
            title: model.localizer.text("Active agents", "活跃 Agent"), value: "\(model.state.runtimeStatus.activeAgentCount)",
            detail: model.localizer.language == .english
              ? "\(model.state.runtimeStatus.subAgents.count) total recorded"
              : "共记录 \(model.state.runtimeStatus.subAgents.count) 个",
            color: model.state.runtimeStatus.activeAgentCount > 0 ? .blue : .secondary
          )
          MetricCard(
            title: model.localizer.text("Active workflows", "活跃工作流"), value: "\(model.state.runtimeStatus.activeWorkflowCount)",
            detail: model.localizer.language == .english
              ? "\(model.state.runtimeStatus.workflows.count) total recorded"
              : "共记录 \(model.state.runtimeStatus.workflows.count) 个",
            color: model.state.runtimeStatus.activeWorkflowCount > 0 ? .purple : .secondary
          )
          MetricCard(
            title: model.localizer.text("Agent graph", "Agent 图谱"),
            value: "\(model.canvasGraph.nodes.filter { $0.type == .agentRun }.count)",
            detail: model.localizer.text("persisted AgentRun nodes", "持久化 AgentRun 节点"), color: .orange
          )
          MetricCard(
            title: model.localizer.text("Execution links", "执行链接"),
            value: "\(model.canvasGraph.edges.filter { $0.type == "EXECUTED_BY" }.count)",
            detail: model.localizer.text("task-to-agent traceability links", "任务到 Agent 的追溯链接"), color: .teal
          )
        }
        ViewThatFits(in: .horizontal) {
          HStack {
            TextField(model.localizer.text("Search agents and workflows", "搜索 Agent 和工作流"), text: $searchText)
              .textFieldStyle(.roundedBorder)
              .frame(maxWidth: 380)
            Spacer()
            ActionStateBadge(state: model.actionState)
          }
          VStack(alignment: .leading, spacing: 8) {
            TextField(model.localizer.text("Search agents and workflows", "搜索 Agent 和工作流"), text: $searchText)
              .textFieldStyle(.roundedBorder)
            ActionStateBadge(state: model.actionState)
          }
        }
        Panel(model.localizer.text("Structured orchestration actions", "结构化编排操作"), systemImage: "paperplane") {
          ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { orchestrationControls }
            VStack(alignment: .leading, spacing: 8) { orchestrationControls }
          }
        }
        Panel(model.localizer.text("Sidecar dispatch policy", "Sidecar 调度策略"), systemImage: "arrow.triangle.branch") {
          SidecarDispatchPolicyGuideView()
        }
        orchestrationActivityPanel
        selectedItemActions
        persistedAgentGraph
      }
      .padding(18)
    }
    .background(Color(nsColor: .windowBackgroundColor))
  }

  @ViewBuilder
  private var selectedItemActions: some View {
    if let selection = selectedOrchestrationItem {
      Panel(model.localizer.text("Selected record", "已选记录"), systemImage: selection.icon) {
        ViewThatFits(in: .horizontal) {
          HStack(spacing: 8) {
            selectedRecordSummary(selection.item)
            Spacer()
            selectedRecordActions(selection.item)
          }
          VStack(alignment: .leading, spacing: 10) {
            selectedRecordSummary(selection.item)
            selectedRecordActions(selection.item)
          }
        }
      }
    }
  }

  private var selectedOrchestrationItem: (item: CanvastRuntimeStatusItem, icon: String)? {
    if let selectedAgentID, let item = model.state.runtimeStatus.subAgents.first(where: { $0.id == selectedAgentID }) {
      return (item, "person.2")
    }
    if let selectedWorkflowID, let item = model.state.runtimeStatus.workflows.first(where: { $0.id == selectedWorkflowID }) {
      return (item, "arrow.triangle.branch")
    }
    return nil
  }

  private func timelinePanel(
    title: String,
    icon: String,
    items: [CanvastRuntimeStatusItem],
    selection: Binding<String?>,
    empty: String
  ) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Label(title, systemImage: icon)
        .font(.subheadline.weight(.semibold))
      if items.isEmpty {
        EmptyState(title: title + " unavailable", detail: empty, systemImage: icon)
      } else {
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 8) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
              Button {
                selection.wrappedValue = item.id
                if title == "Agent runs" { selectedWorkflowID = nil } else { selectedAgentID = nil }
              } label: {
                RuntimeItemRow(item: item, showConnector: index < items.count - 1)
                  .padding(9)
                  .background(selection.wrappedValue == item.id ? Color.accentColor.opacity(0.1) : Color.clear, in: RoundedRectangle(cornerRadius: 8))
              }
              .buttonStyle(.plain)
              .contextMenu {
                Button(model.localizer.text("Show on Canvas", "在画布中显示")) { showOnCanvas(item) }
                if title == model.localizer.text("Agent runs", "Agent 运行") {
                  Button(model.localizer.text("Follow-up unavailable", "跟进不可用")) {}
                    .disabled(true)
                    .help(model.localizer.text("Targeted agent follow-up requires an addressable runtime handle.", "定向 Agent 跟进需要可寻址的运行时句柄。"))
                  Button(model.localizer.text("Cancel unavailable", "取消不可用")) {}
                    .disabled(true)
                    .help(model.localizer.text("Targeted agent cancellation requires an addressable runtime handle.", "定向 Agent 取消需要可寻址的运行时句柄。"))
                } else {
                  Button(model.localizer.text("Follow-up unavailable", "跟进不可用")) {}
                    .disabled(true)
                    .help(model.localizer.text("Targeted workflow follow-up requires an addressable runtime handle.", "定向工作流跟进需要可寻址的运行时句柄。"))
                  Button(model.localizer.text("Cancel unavailable", "取消不可用")) {}
                    .disabled(true)
                    .help(model.localizer.text("Targeted workflow cancellation requires an addressable runtime handle.", "定向工作流取消需要可寻址的运行时句柄。"))
                }
              }
            }
          }
        }
      }
    }
    .frame(minWidth: 280, maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }

  private var orchestrationActivityPanel: some View {
    Panel(model.localizer.text("Agent and workflow activity", "Agent 与工作流活动"), systemImage: "arrow.triangle.branch") {
      ViewThatFits(in: .horizontal) {
        HStack(alignment: .top, spacing: 14) {
          timelinePanel(
            title: model.localizer.text("Agent runs", "Agent 运行"), icon: "person.2", items: agents,
            selection: $selectedAgentID, empty: model.localizer.text("No delegated agent runs have been recorded.", "尚未记录委派的 Agent 运行。")
          )
          Divider()
          timelinePanel(
            title: model.localizer.dynamic("workflows"), icon: "arrow.triangle.branch", items: workflows,
            selection: $selectedWorkflowID, empty: model.localizer.text("No workflow runs have been recorded.", "尚未记录工作流运行。")
          )
        }
        .frame(minHeight: 300)
        VStack(alignment: .leading, spacing: 14) {
          timelinePanel(
            title: model.localizer.text("Agent runs", "Agent 运行"), icon: "person.2", items: agents,
            selection: $selectedAgentID, empty: model.localizer.text("No delegated agent runs have been recorded.", "尚未记录委派的 Agent 运行。")
          )
          Divider()
          timelinePanel(
            title: model.localizer.dynamic("workflows"), icon: "arrow.triangle.branch", items: workflows,
            selection: $selectedWorkflowID, empty: model.localizer.text("No workflow runs have been recorded.", "尚未记录工作流运行。")
          )
        }
      }
    }
  }

  private var persistedAgentGraph: some View {
    Panel(model.localizer.text("Persisted agent history", "持久化 Agent 历史"), systemImage: "clock.arrow.circlepath") {
      let nodes = model.canvasGraph.nodes.filter { $0.type == .agentRun && matchesGraphSearch($0) }
      if nodes.isEmpty {
        EmptyState(
          title: model.localizer.text("No matching AgentRun nodes", "没有匹配的 AgentRun 节点"),
          detail: model.localizer.text("Completed delegated work is retained on Canvas for project traceability.", "已完成的委派工作会保留在画布上，用于项目追溯。"),
          systemImage: "person.crop.circle.badge.clock"
        )
      } else {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 250), spacing: 10)], spacing: 10) {
          ForEach(nodes) { node in
            Button { model.focusCanvasNode(node.id) } label: {
              VStack(alignment: .leading, spacing: 7) {
                HStack {
                  Image(systemName: node.type.symbol).foregroundStyle(node.type.color)
                  Text(node.title)
                    .font(.headline)
                    .fixedSize(horizontal: false, vertical: true)
                  Spacer()
                  Image(systemName: "scope").foregroundStyle(.tertiary)
                }
                Text(node.subtitle)
                  .font(.caption)
                  .foregroundStyle(.secondary)
                  .fixedSize(horizontal: false, vertical: true)
                let linkCount = model.canvasGraph.edges.filter { $0.sourceID == node.id || $0.targetID == node.id }.count
                Text(model.localizer.language == .english ? "\(linkCount) connected records" : "\(linkCount) 条关联记录").font(.caption2).foregroundStyle(.tertiary)
              }
              .padding(12)
              .frame(maxWidth: .infinity, minHeight: 94, alignment: .topLeading)
              .background(node.type.color.opacity(0.07), in: RoundedRectangle(cornerRadius: 9))
            }
            .buttonStyle(.plain)
          }
        }
      }
    }
  }

  private func filter(_ items: [CanvastRuntimeStatusItem]) -> [CanvastRuntimeStatusItem] {
    let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !query.isEmpty else { return items }
    return items.filter { [ $0.id, $0.title, $0.status, $0.summary ?? "" ].joined(separator: " " ).lowercased().contains(query) }
  }

  private func matchesGraphSearch(_ node: CanvasGraphNode) -> Bool {
    let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return query.isEmpty || node.searchText.contains(query)
  }

  private func showOnCanvas(_ item: CanvastRuntimeStatusItem) {
    if model.canvasGraph.nodes.contains(where: { $0.id == item.id }) {
      model.focusCanvasNode(item.id)
    } else {
      model.searchCanvas(for: item.title, type: .agentRun)
    }
  }

  @ViewBuilder
  private var orchestrationControls: some View {
    TextField(model.localizer.text("Agent task or workflow goal", "Agent 任务或工作流目标"), text: $actionInput)
      .textFieldStyle(.roundedBorder)
    Button(model.localizer.text("Launch Agent", "启动 Agent")) {
      model.launchAgent(task: actionInput)
    }
    .disabled(actionInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || actionLocked(model, .launchAgent))
    Button(model.localizer.text("Launch Workflow", "启动工作流")) {
      model.launchWorkflow(goal: actionInput)
    }
    .buttonStyle(.borderedProminent)
    .disabled(actionInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || actionLocked(model, .launchWorkflow))
  }

  private func selectedRecordSummary(_ item: CanvastRuntimeStatusItem) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(item.title)
        .font(.subheadline.weight(.medium))
        .fixedSize(horizontal: false, vertical: true)
      Text(model.localizer.text("Selection is visual only; this recorded item has no addressable runtime handle.", "该选择仅用于视觉展示；此记录项没有可寻址的运行时句柄。"))
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      if let dispatch = item.sidecarDispatch { SidecarDispatchDecisionView(dispatch: dispatch) }
    }
  }

  private var unavailableActionHelp: String {
    model.localizer.text("Targeted follow-up requires an addressable runtime handle.", "定向跟进需要可寻址的运行时句柄。")
  }

  private var unavailableCancelHelp: String {
    model.localizer.text("Targeted cancellation requires an addressable runtime handle.", "定向取消需要可寻址的运行时句柄。")
  }

  @ViewBuilder
  private func selectedRecordActions(_ item: CanvastRuntimeStatusItem) -> some View {
    ViewThatFits(in: .horizontal) {
      HStack(spacing: 8) {
        Button { showOnCanvas(item) } label: { Label(model.localizer.text("Show on Canvas", "在画布中显示"), systemImage: "scope") }
        Button(model.localizer.text("Follow Up - Unavailable", "继续跟进 - 不可用")) {}
          .disabled(true)
          .help(unavailableActionHelp)
        Button(model.localizer.text("Cancel - Unavailable", "取消 - 不可用")) {}
          .disabled(true)
          .help(unavailableCancelHelp)
      }
      VStack(alignment: .leading, spacing: 8) {
        Button { showOnCanvas(item) } label: { Label(model.localizer.text("Show on Canvas", "在画布中显示"), systemImage: "scope") }
        Button(model.localizer.text("Follow Up - Unavailable", "继续跟进 - 不可用")) {}
          .disabled(true)
          .help(unavailableActionHelp)
        Button(model.localizer.text("Cancel - Unavailable", "取消 - 不可用")) {}
          .disabled(true)
          .help(unavailableCancelHelp)
      }
    }
  }

}
