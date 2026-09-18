import SwiftUI
import AppKit
import CanvastAppCore

struct CanvastWorkbenchView: View {
  @EnvironmentObject private var model: CanvastDesktopModel
  @State private var showsCollapsedInspector = false
  @State private var splitVisibility: NavigationSplitViewVisibility = .all
  private let refreshTimer = Timer.publish(every: 2, on: .main, in: .common).autoconnect()
  private let compactWidth: CGFloat = 1_180
  private let fullWorkbenchWidth: CGFloat = 1_500

  var body: some View {
    ZStack(alignment: .topLeading) {
      GeometryReader { geometry in
        responsiveWorkbench(width: geometry.size.width)
      }
    }
    .background(Color(nsColor: .windowBackgroundColor))
    .toolbar { toolbar }
    .onReceive(refreshTimer) { _ in
      if model.runState.isActive { model.refreshRuntimeState() }
    }
  }

  @ViewBuilder
  private func responsiveWorkbench(width: CGFloat) -> some View {
    if !model.workspaceIsConfigured {
      WorkspaceOnboardingView()
    } else if width >= fullWorkbenchWidth {
      NavigationSplitView(columnVisibility: $splitVisibility) {
        WorkbenchSidebar()
          .navigationSplitViewColumnWidth(min: 205, ideal: 225, max: 250)
      } content: {
        workspaceContent
          .navigationTitle(model.selectedWorkspace.shortTitle)
      } detail: {
        WorkspaceInspector()
          .navigationSplitViewColumnWidth(min: 260, ideal: 290, max: 340)
      }
      .navigationSplitViewStyle(.balanced)
    } else if width >= compactWidth {
      HStack(spacing: 0) {
        WorkbenchSidebar()
          .frame(width: 225)
        Divider()
        VStack(spacing: 0) {
          CollapsedWorkbenchBar(
            showsWorkspacePicker: false,
            showsInspector: $showsCollapsedInspector
          )
          Divider()
          workspaceContent
        }
        .navigationTitle(model.selectedWorkspace.shortTitle)
      }
    } else {
      VStack(spacing: 0) {
        CollapsedWorkbenchBar(
          showsWorkspacePicker: true,
          showsInspector: $showsCollapsedInspector
        )
        Divider()
        workspaceContent
      }
    }
  }

  @ViewBuilder
  private var workspaceContent: some View {
    ZStack(alignment: .topLeading) {
      switch model.selectedWorkspace {
      case .runConsole: RunConsoleView()
      case .canvas: CanvasGraphView()
      case .taskPlan: TaskPlanView()
      case .agentsWorkflow: AgentsWorkflowView()
      case .safetyPermissions: SafetyPermissionsView()
      case .toolsContextSessions: ToolsContextSessionsView()
      }
    }
  }

  @ToolbarContentBuilder
  private var toolbar: some ToolbarContent {
    ToolbarItemGroup {
      Button { model.navigateBack() } label: {
        Image(systemName: "chevron.left")
      }
      .disabled(!model.canNavigateBack)
      .help(model.localizer.text(
        "Go back to the previous workspace or selection",
        "返回上一个工作区或选择"
      ))
      .accessibilityLabel(model.localizer.text("Go Back", "返回"))

      Button { model.navigateForward() } label: {
        Image(systemName: "chevron.right")
      }
      .disabled(!model.canNavigateForward)
      .help(model.localizer.text(
        "Go forward to the next workspace or selection",
        "前进到下一个工作区或选择"
      ))
      .accessibilityLabel(model.localizer.text("Go Forward", "前进"))

      Picker(model.localizer.text("Live mode", "实时模式"), selection: Binding(
        get: { model.displayedRuntimeMode },
        set: { model.setRuntimeMode($0) }
      )) {
        Text(model.localizer.text("Standard", "标准")).tag(CanvastRuntimeMode.parity)
        Text(model.localizer.text("Enhanced", "增强")).tag(CanvastRuntimeMode.enhanced)
      }
      .pickerStyle(.segmented)
      .frame(width: 180)
      .disabled(!model.workspaceIsConfigured || actionLocked(model, .setRuntimeMode))
      .help(model.localizer.text(
        "Apply the runtime mode through the live typed control",
        "通过实时类型化控制应用运行模式"
      ))

      Picker(model.localizer.dynamic("thinking"), selection: Binding(
        get: { model.thinkingLevel },
        set: { model.setThinkingLevel($0) }
      )) {
        ForEach(thinkingOptions, id: \.self) { Text(humanized($0, localizer: model.localizer)).tag($0) }
      }
      .frame(width: 125)
      .disabled(!model.workspaceIsConfigured || actionLocked(model, .setThinkingLevel))

      Button { model.refresh() } label: {
        Label(model.localizer.dynamic("refresh"), systemImage: "arrow.clockwise")
      }
        .disabled(!model.workspaceIsConfigured || actionLocked(model, .refreshWorkspace))
        .help(model.localizer.text(
          "Reload runtime and Canvas state",
          "重新加载运行时和画布状态"
        ))

      Button(action: model.openSettingsWindow) {
        Label(model.localizer.text("Settings", "设置"), systemImage: "gearshape")
      }
      .help(model.localizer.text(
        "Open Settings to change the provider, runtime paths, and app language",
        "打开设置以修改服务商、运行时路径和应用语言"
      ))
    }
  }

  private var thinkingOptions: [String] {
    let available = model.state.runtimeStatus.model.availableThinkingLevels
    let defaults = ["low", "medium", "high", "max"]
    let options = available.isEmpty ? defaults : available
    return options.contains(model.thinkingLevel) ? options : [model.thinkingLevel] + options
  }

}

struct WorkspaceOnboardingView: View {
  @EnvironmentObject private var model: CanvastDesktopModel

  var body: some View {
    VStack(spacing: 0) {
      Spacer(minLength: 40)
      VStack(alignment: .leading, spacing: 18) {
        HStack(alignment: .center, spacing: 14) {
          CanvastBrandLogo()
          VStack(alignment: .leading, spacing: 4) {
            Text(model.localizer.text("Set up Canvast", "设置 Canvast"))
              .font(.largeTitle.bold())
              .fixedSize(horizontal: false, vertical: true)
            Text(model.localizer.text(
              "Choose or create a workspace before entering Canvast. Add a provider API key in Settings before sending prompts or running model-backed actions.",
              "进入 Canvast 前请先选择或新建工作区。发送提示词或执行依赖模型的操作前，请在设置中添加服务商 API 密钥。"
            ))
              .font(.subheadline)
              .foregroundStyle(.secondary)
              .fixedSize(horizontal: false, vertical: true)
          }
        }

        HStack(spacing: 10) {
          Button { chooseWorkspace() } label: {
            Label(model.localizer.text("Choose Folder", "选择文件夹"), systemImage: "folder")
          }
          .buttonStyle(.borderedProminent)
          Button { createWorkspace() } label: {
            Label(model.localizer.text("Create Folder", "新建文件夹"), systemImage: "folder.badge.plus")
          }
          .buttonStyle(.bordered)
          Button { model.openSettingsWindow() } label: {
            Label(model.localizer.text("Add API Key", "添加 API 密钥"), systemImage: "key")
          }
          .buttonStyle(.bordered)
        }

        VStack(alignment: .leading, spacing: 8) {
          setupRow(
            title: model.localizer.text("Workspace", "工作区"),
            detail: model.workspaceIsConfigured
              ? model.projectDisplayPath
              : model.localizer.text("Choose or create a project folder.", "选择或新建项目文件夹。"),
            isReady: model.workspaceIsConfigured
          )
          setupRow(
            title: model.localizer.text("Provider API key", "服务商 API 密钥"),
            detail: model.providerCredentialIsConfigured
              ? model.localizer.text("Saved for the selected provider.", "已为当前服务商保存。")
              : model.localizer.text("Required for prompts, Canvas export, and model-backed runtime actions.", "发送提示词、导出画布和依赖模型的运行时操作需要该密钥。"),
            isReady: model.providerCredentialIsConfigured
          )
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(.separator.opacity(0.45)))

        VStack(alignment: .leading, spacing: 8) {
          Label(
            model.workspaceIsConfigured
              ? model.localizer.text("Setup complete", "设置完成")
              : model.localizer.text("Workspace required", "需要工作区"),
            systemImage: "exclamationmark.triangle"
          )
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(.orange)
          Text(model.localizer.text(
            "Workspace-dependent controls stay disabled until a valid directory is selected. Provider-backed actions remain gated until an API key is saved.",
            "选择有效目录前，依赖工作区的控件会保持禁用。依赖服务商的操作会继续锁定，直到保存 API 密钥。"
          ))
          .font(.caption)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
      }
      .padding(28)
      .frame(maxWidth: 720, alignment: .leading)
      .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
      .overlay(RoundedRectangle(cornerRadius: 10).stroke(.separator.opacity(0.55)))
      Spacer(minLength: 40)
    }
    .padding(24)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Color(nsColor: .windowBackgroundColor))
  }

  private func chooseWorkspace() {
    model.chooseAndOpenWorkspace()
  }

  private func createWorkspace() {
    model.createAndOpenWorkspace()
  }

  private func setupRow(title: String, detail: String, isReady: Bool) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Image(systemName: isReady ? "checkmark.circle.fill" : "circle")
        .foregroundStyle(isReady ? Color.green : Color.secondary)
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(.subheadline.weight(.semibold))
        Text(detail)
          .font(.caption)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }
}

struct WorkbenchSidebar: View {
  @EnvironmentObject private var model: CanvastDesktopModel

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
      BrandHeaderView()
          .padding(.horizontal, 10)

        VStack(alignment: .leading, spacing: 5) {
          sidebarSectionTitle(model.localizer.dynamic("workspace"))
          ForEach(DesktopWorkspace.allCases) { workspace in
            Button { model.navigate(to: workspace) } label: {
              HStack {
                Label(workspace.title, systemImage: workspace.symbol)
                Spacer()
                if let badge = badge(for: workspace) {
                  Text(badge)
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(.quaternary, in: Capsule())
                }
              }
              .contentShape(Rectangle())
            }
            .buttonStyle(SidebarSelectionButtonStyle(isSelected: model.selectedWorkspace == workspace))
          }
        }

        VStack(alignment: .leading, spacing: 5) {
          sidebarSectionTitle(model.localizer.text("Conversations", "会话"))
          Button { startNewChat() } label: {
            Label(model.localizer.text("New Chat", "新建对话"), systemImage: "square.and.pencil")
              .frame(maxWidth: .infinity, alignment: .leading)
              .contentShape(Rectangle())
          }
          .buttonStyle(SidebarSelectionButtonStyle(isSelected: false))
          .disabled(!model.canManageSessions || actionLocked(model, .startNewSession))

          Button { showRecentSessions() } label: {
            Label(model.localizer.text("Recent", "最近"), systemImage: "clock.arrow.circlepath")
              .frame(maxWidth: .infinity, alignment: .leading)
              .contentShape(Rectangle())
          }
          .buttonStyle(SidebarSelectionButtonStyle(
            isSelected: model.selectedWorkspace == .toolsContextSessions && model.toolsWorkspaceSection == .sessions
          ))

          Button { model.openSettingsWindow() } label: {
            Label(model.localizer.text("Settings", "设置"), systemImage: "gearshape")
              .frame(maxWidth: .infinity, alignment: .leading)
              .contentShape(Rectangle())
          }
          .buttonStyle(SidebarSelectionButtonStyle(isSelected: false))
        }

        VStack(alignment: .leading, spacing: 5) {
          sidebarSectionTitle(model.localizer.text("Current run", "当前运行"))
          Button { model.navigate(to: .runConsole) } label: {
            HStack(spacing: 8) {
              Image(systemName: model.runState.symbol).foregroundStyle(model.runState.color)
              VStack(alignment: .leading, spacing: 2) {
                Text(model.runState.label).font(.subheadline.weight(.medium))
                Text(
                  model.state.runtimeStatus.updatedAt.isEmpty
                    ? model.localizer.dynamic("state_not_recorded")
                    : model.state.runtimeStatus.updatedAt
                )
                  .font(.caption2)
                  .foregroundStyle(.secondary)
                  .fixedSize(horizontal: false, vertical: true)
              }
              Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
          }
          .buttonStyle(SidebarSelectionButtonStyle(isSelected: model.selectedWorkspace == .runConsole))
        }
      }
      .padding(.horizontal, 8)
      .padding(.vertical, 12)
    }
    .navigationTitle("Canvast")
    .frame(minWidth: 205, idealWidth: 225, maxWidth: 250)
    .background(Color(nsColor: .windowBackgroundColor))
  }

  private func sidebarSectionTitle(_ title: String) -> some View {
    Text(title.uppercased())
      .font(.caption2.weight(.semibold))
      .foregroundStyle(.secondary)
      .padding(.horizontal, 9)
      .padding(.bottom, 2)
  }

  private func startNewChat() {
    guard model.canManageSessions else {
      model.statusLine = model.workspaceRequiredMessage()
      return
    }
    model.navigate(to: .toolsContextSessions, toolsSection: .sessions)
    model.startNewSession()
  }

  private func showRecentSessions() {
    model.navigate(to: .toolsContextSessions, toolsSection: .sessions)
  }

  private func badge(for workspace: DesktopWorkspace) -> String? {
    switch workspace {
    case .runConsole: return model.runState.isActive ? model.localizer.text("Live", "运行中") : nil
    case .canvas: return model.canvasGraph.nodes.isEmpty ? nil : String(model.canvasGraph.nodes.count)
    case .taskPlan: return model.state.runtimeStatus.openTaskCount == 0 ? nil : String(model.state.runtimeStatus.openTaskCount)
    case .agentsWorkflow:
      let active = model.state.runtimeStatus.activeAgentCount + model.state.runtimeStatus.activeWorkflowCount
      return active == 0 ? nil : String(active)
    case .safetyPermissions:
      return model.state.runtimeStatus.approvalReviews.isEmpty ? nil : String(model.state.runtimeStatus.approvalReviews.count)
    case .toolsContextSessions: return nil
    }
  }
}

private struct CollapsedWorkbenchBar: View {
  @EnvironmentObject private var model: CanvastDesktopModel
  let showsWorkspacePicker: Bool
  @Binding var showsInspector: Bool

  var body: some View {
    ViewThatFits(in: .horizontal) {
      HStack(spacing: 12) {
        titleControl
        Spacer(minLength: 12)
        actionControls
      }
      VStack(alignment: .leading, spacing: 10) {
        titleControl
        actionControls
      }
    }
    .controlSize(.small)
    .padding(.horizontal, 14)
    .padding(.vertical, 8)
    .background(Color(nsColor: .controlBackgroundColor))
  }

  private func startNewChat() {
    guard model.canManageSessions else {
      model.statusLine = model.workspaceRequiredMessage()
      return
    }
    model.navigate(to: .toolsContextSessions, toolsSection: .sessions)
    model.startNewSession()
  }

  private func showRecentSessions() {
    model.navigate(to: .toolsContextSessions, toolsSection: .sessions)
  }

  @ViewBuilder
  private var titleControl: some View {
    if showsWorkspacePicker {
      Menu {
        ForEach(DesktopWorkspace.allCases) { workspace in
          Button { model.navigate(to: workspace) } label: {
            Label(workspace.title, systemImage: workspace.symbol)
          }
        }
      } label: {
        Label(model.selectedWorkspace.title, systemImage: model.selectedWorkspace.symbol)
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      .menuStyle(.borderlessButton)
    } else {
      Label(model.selectedWorkspace.title, systemImage: model.selectedWorkspace.symbol)
        .font(.headline)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private var actionControls: some View {
    ViewThatFits(in: .horizontal) {
      HStack(spacing: 8) { compactButtons }
      VStack(alignment: .leading, spacing: 8) { compactButtons }
    }
  }

  @ViewBuilder
  private var compactButtons: some View {
    if showsWorkspacePicker {
      Button { startNewChat() } label: {
        Label(model.localizer.text("New Chat", "新建对话"), systemImage: "square.and.pencil")
          .fixedSize(horizontal: false, vertical: true)
      }
      .buttonStyle(.borderedProminent)
      .disabled(!model.canManageSessions || actionLocked(model, .startNewSession))

      Button { showRecentSessions() } label: {
        Label(model.localizer.text("Recent", "最近"), systemImage: "clock.arrow.circlepath")
          .fixedSize(horizontal: false, vertical: true)
      }
      .buttonStyle(.bordered)
    }

    Button(action: model.openSettingsWindow) {
      Label(model.localizer.text("Settings", "设置"), systemImage: "gearshape")
        .fixedSize(horizontal: false, vertical: true)
    }
    .buttonStyle(.bordered)

    Button { showsInspector.toggle() } label: {
      Label(model.localizer.text("Inspector", "检查器"), systemImage: "sidebar.right")
        .fixedSize(horizontal: false, vertical: true)
    }
    .buttonStyle(.bordered)
    .popover(isPresented: $showsInspector, arrowEdge: .bottom) {
      WorkspaceInspector()
        .frame(width: 330, height: 560)
    }
  }

}

private struct SidebarSelectionButtonStyle: ButtonStyle {
  let isSelected: Bool

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.subheadline)
      .foregroundStyle(isSelected ? Color.accentColor : Color.primary)
      .padding(.horizontal, 9)
      .padding(.vertical, 7)
      .background(
        isSelected ? Color.accentColor.opacity(configuration.isPressed ? 0.20 : 0.12) : Color.clear,
        in: RoundedRectangle(cornerRadius: 7)
      )
      .opacity(configuration.isPressed ? 0.78 : 1)
  }
}

private struct BrandHeaderView: View {
  var body: some View {
    HStack(spacing: 11) {
      CanvastBrandLogo()
      VStack(alignment: .leading, spacing: 2) {
        Text("Canvast").font(.headline)
        Text(CanvastLocalizationRuntime.localizer.text("Project workbench", "项目工作台"))
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      Spacer()
    }
    .accessibilityElement(children: .combine)
  }
}

struct WorkspaceInspector: View {
  @EnvironmentObject private var model: CanvastDesktopModel

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        Label(model.localizer.text("Inspector", "检查器"), systemImage: "sidebar.right").font(.title3.bold())
        if model.selectedWorkspace == .canvas, let node = model.selectedCanvasNode {
          canvasNodeInspector(node)
        } else {
          workspaceInspector
        }
        runtimeInspector
        Spacer(minLength: 20)
      }
      .padding(16)
    }
    .frame(minWidth: 260, idealWidth: 290, maxWidth: 340, alignment: .topLeading)
    .background(Color(nsColor: .controlBackgroundColor))
  }

  private func canvasNodeInspector(_ node: CanvasGraphNode) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Image(systemName: node.type.symbol).foregroundStyle(node.type.color)
        Text(node.type.title).font(.caption).foregroundStyle(.secondary)
        Spacer()
        Button { model.navigate(to: .canvas, canvasNodeID: nil) } label: { Image(systemName: "xmark") }
          .buttonStyle(.plain)
          .help(model.localizer.text("Clear the Canvas selection", "清除画布选择"))
          .accessibilityLabel(model.localizer.text("Clear Canvas Selection", "清除画布选择"))
      }
      Text(node.title).font(.headline).textSelection(.enabled)
      Text(node.subtitle).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
      Text(node.id).font(.caption2.monospaced()).foregroundStyle(.tertiary).textSelection(.enabled)
      if node.type == .plan {
        Divider()
        Text(model.localizer.text("Runtime scope", "运行时范围"))
          .font(.caption2)
          .foregroundStyle(.secondary)
        Text(model.localizer.text(
          "Canvas selection is visual only. Use an explicit action to change runtime scope.",
          "画布选择仅用于视觉查看。请使用显式操作来改变运行时范围。"
        ))
          .font(.caption)
          .foregroundStyle(.secondary)
        if isTaskNode(node) {
          Button(model.localizer.text("Use as Active Task", "设为当前任务")) {
            model.selectCanvasTask(nodeID: node.id)
          }
            .disabled(actionLocked(model, .selectCanvasTask))
        } else {
          Button(model.localizer.text("Use as Active Plan", "设为当前计划")) {
            model.selectCanvasPlan(planID: node.id)
          }
            .disabled(actionLocked(model, .selectCanvasPlan))
        }
      }
      if !node.detailRows.isEmpty {
        Divider()
        ForEach(node.detailRows, id: \.self) { row in
          VStack(alignment: .leading, spacing: 2) {
            Text(row.label).font(.caption2).foregroundStyle(.secondary)
            Text(row.value).font(.caption).textSelection(.enabled)
          }
        }
      }
      Divider()
      let incoming = model.canvasGraph.edges.filter { $0.targetID == node.id }
      let outgoing = model.canvasGraph.edges.filter { $0.sourceID == node.id }
      edgeSection(model.localizer.text("Incoming", "入边"), edges: incoming, target: { $0.sourceID })
      edgeSection(model.localizer.text("Outgoing", "出边"), edges: outgoing, target: { $0.targetID })
    }
  }

  private var workspaceInspector: some View {
    VStack(alignment: .leading, spacing: 10) {
      Label(model.selectedWorkspace.title, systemImage: model.selectedWorkspace.symbol).font(.headline)
      Text(model.selectedWorkspace.subtitle).font(.caption).foregroundStyle(.secondary)
      Divider()
      if let feature = model.selectedFeatureValue {
        let capability = CanvastDesktopCapabilityMatrix.capability(for: feature.id)
        Text(model.localizer.text("Selected capability", "已选能力"))
          .font(.caption2)
          .foregroundStyle(.secondary)
        Label(feature.title, systemImage: feature.symbolName).font(.subheadline.weight(.medium))
        Text(feature.detail).font(.caption).foregroundStyle(.secondary)
        Text(capability.rationale).font(.caption2).foregroundStyle(.secondary)
        if let command = feature.command {
          VStack(alignment: .leading, spacing: 8) {
            Button {
              model.navigate(to: .runConsole, feature: feature.id)
              model.prepareFeature(feature)
              model.statusLine = model.localizer.text(
                "Prepared \(feature.title) in Run Console. Press Run to execute it.",
                "已在运行控制台中准备 \(feature.title)。点击运行以执行。"
              )
            } label: {
              Label(model.localizer.text("Prepare in Run Console", "在运行控制台中准备"), systemImage: "terminal")
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.borderedProminent)
            .frame(maxWidth: .infinity, alignment: .leading)
            Button(model.localizer.text("Copy command", "复制命令")) { model.copyFeatureCommand(feature) }
              .buttonStyle(.bordered)
              .help(model.localizer.text(
                "Copy \(command) for use in the terminal TUI.",
                "复制 \(command) 以便在终端 TUI 中使用。"
              ))
          }
          Text(model.localizer.text(
            "Prepare fills the prompt only. Press Run to execute it.",
            "准备只会填充提示词。点击运行以执行。"
          ))
            .font(.caption2)
            .foregroundStyle(.secondary)
        } else if capability.actions.isEmpty {
          Text(model.localizer.text("No App action", "无 App 操作"))
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)
        }
      }
      LifecycleInspectorCard(snapshot: model.primaryActionSnapshot)
    }
  }

  private var runtimeInspector: some View {
    VStack(alignment: .leading, spacing: 9) {
      Divider()
      Text(model.localizer.text("Runtime", "运行时")).font(.headline)
      inspectorRow(model.localizer.dynamic("mode"), humanized(model.displayedRuntimeMode.rawValue, localizer: model.localizer))
      inspectorRow(model.localizer.dynamic("thinking"), humanized(model.thinkingLevel, localizer: model.localizer))
      inspectorRow(
        model.localizer.dynamic("tasks"),
        model.localizer.counted(
          model.state.runtimeStatus.openTaskCount,
          singularEnglish: "open",
          pluralEnglish: "open",
          simplifiedChineseSuffix: " 个未完成"
        )
      )
      inspectorRow(
        model.localizer.dynamic("agents"),
        model.localizer.counted(
          model.state.runtimeStatus.activeAgentCount,
          singularEnglish: "active",
          pluralEnglish: "active",
          simplifiedChineseSuffix: " 个活跃"
        )
      )
      inspectorRow(model.localizer.dynamic("context"), "\(Int((model.state.runtimeStatus.tokens.contextUsageRatio * 100).rounded()))%")
      inspectorRow(model.localizer.dynamic("project"), model.projectRoot.lastPathComponent)
      Divider()
      Text(model.localizedStatusLine).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
    }
  }

  private func edgeSection(
    _ title: String,
    edges: [CanvasGraphEdge],
    target: @escaping (CanvasGraphEdge) -> String
  ) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("\(model.localizer.exact(title)) (\(edges.count))").font(.caption.weight(.semibold))
      if edges.isEmpty {
        Text(model.localizer.dynamic("none")).font(.caption2).foregroundStyle(.tertiary)
      } else {
        ForEach(edges.prefix(8)) { edge in
          Button { model.navigate(to: .canvas, canvasNodeID: target(edge)) } label: {
            HStack(spacing: 5) {
              Text(humanized(edge.type))
                .fixedSize(horizontal: false, vertical: true)
              Spacer()
              Image(systemName: "arrow.right")
            }
            .font(.caption2)
          }
          .buttonStyle(.plain)
        }
      }
    }
  }

  private func isTaskNode(_ node: CanvasGraphNode) -> Bool {
    model.canvasGraph.edges.contains { edge in
      edge.type == "DECOMPOSES_INTO" && edge.targetID == node.id
    }
  }

  private func inspectorRow(_ label: String, _ value: String) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(label).font(.caption).foregroundStyle(.secondary)
      ScrollableMonospacedText(value: value, font: .caption.weight(.medium), color: .primary)
    }
  }
}
