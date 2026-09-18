import SwiftUI
import AppKit
import CanvastAppCore

struct ToolsContextSessionsView: View {
  @EnvironmentObject private var model: CanvastDesktopModel
  let automaticallyLoadRuntimeData: Bool
  @State private var searchText = ""
  @State private var confirmProjectRebind = false

  init(automaticallyLoadRuntimeData: Bool = true) {
    self.automaticallyLoadRuntimeData = automaticallyLoadRuntimeData
  }

  var body: some View {
    GeometryReader { geometry in
      content(availableWidth: max(0, geometry.size.width - 36))
    }
    .background(Color(nsColor: .windowBackgroundColor))
  }

  private func content(availableWidth: CGFloat) -> some View {
    VStack(spacing: 0) {
      VStack(alignment: .leading, spacing: 14) {
        WorkspaceTitle(
          workspace: .toolsContextSessions,
          trailing: AnyView(
            Button { model.refresh() } label: { Label(model.localizer.dynamic("refresh"), systemImage: "arrow.clockwise") }
              .disabled(actionLocked(model, .refreshWorkspace))
          )
        )
        if availableWidth >= 760 {
          HStack {
            workspaceSectionPicker
            Spacer()
            if model.toolsWorkspaceSection == .tools { capabilitySearchField }
          }
        } else {
          VStack(alignment: .leading, spacing: 10) {
            workspaceSectionPicker
            if model.toolsWorkspaceSection == .tools { capabilitySearchField }
          }
        }
      }
      .padding(18)
      Divider()
      ScrollView {
        Group {
          switch model.toolsWorkspaceSection {
          case .tools: toolsSection(availableWidth: availableWidth)
          case .context: contextSection(availableWidth: availableWidth)
          case .sessions: sessionsSection(availableWidth: availableWidth)
          }
        }
        .padding(18)
      }
    }
  }

  private var workspaceSectionPicker: some View {
          Picker(model.localizer.text("Workspace section", "工作区分区"), selection: $model.toolsWorkspaceSection) {
            ForEach(ToolsWorkspaceSection.allCases) { Text($0.title).tag($0) }
          }
          .pickerStyle(.segmented)
          .frame(maxWidth: 430)
  }

  private var capabilitySearchField: some View {
    TextField(model.localizer.text("Search capabilities", "搜索能力"), text: $searchText)
      .textFieldStyle(.roundedBorder)
      .frame(minWidth: 220, idealWidth: 280, maxWidth: 320)
  }

  private func toolsSection(availableWidth: CGFloat) -> some View {
    let productFeatures = CanvastProductCapabilityCatalog.features(from: model.state.features)
    return VStack(alignment: .leading, spacing: 16) {
      AdaptiveMetricGrid(minimumColumnWidth: 190) {
        MetricCard(title: model.localizer.text("Capabilities", "能力"), value: "\(productFeatures.count)", detail: model.localizer.text("product capability entries", "产品能力入口"), color: .blue)
        MetricCard(title: model.localizer.text("Command actions", "命令动作"), value: "\(productFeatures.compactMap(\.command).count)", detail: model.localizer.text("visible commands and tools", "可见命令和工具"), color: .teal)
        MetricCard(title: model.localizer.text("Tool calls", "工具调用"), value: formattedWhole(model.state.runtimeStatus.tokens.toolCalls), detail: model.localizer.text("current runtime session", "当前运行时会话"), color: .purple)
        MetricCard(title: model.localizer.text("Enhanced", "增强"), value: "\(productFeatures.filter(\.isEnhanced).count)", detail: model.localizer.text("enhanced product capabilities", "增强产品能力"), color: .orange)
      }
      RuntimeToolsEventsView(
        status: model.state.runtimeStatus,
        isRefreshing: model.isPollingRefreshInFlight,
        availableWidth: availableWidth
      )
      Panel(model.localizer.text("Capability catalog", "能力目录"), systemImage: "wrench.and.screwdriver") {
        let features = filteredFeatures
        if features.isEmpty {
          EmptyState(title: model.localizer.text("No matching capabilities", "没有匹配的能力"), detail: model.localizer.text("Clear the search or use a broader term.", "清空搜索或使用更宽泛的关键词。"), systemImage: "magnifyingglass")
        } else {
          LazyVGrid(columns: [GridItem(.adaptive(minimum: 220), spacing: 10)], spacing: 10) {
            ForEach(features) { feature in
              FeatureCard(feature: feature, isSelected: model.selectedFeature == feature.id) { model.selectFeature(feature) }
                .contextMenu {
                  Button(model.localizer.text("Inspect capability", "检查能力")) { model.selectFeature(feature) }
                  if feature.command != nil {
                    Button(model.localizer.text("Prepare in Run Console", "在运行控制台中准备")) { prepareFeature(feature) }
                    Button(model.localizer.text("Copy TUI command", "复制 TUI 命令")) { model.copyFeatureCommand(feature) }
                  }
                }
            }
          }
        }
      }
    }
  }

  private func contextSection(availableWidth: CGFloat) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      let tokens = model.state.runtimeStatus.tokens
      AdaptiveMetricGrid(minimumColumnWidth: 190) {
        MetricCard(
          title: model.localizer.dynamic("context"),
          value: "\(formattedWhole(tokens.contextUsedTokens))/\(formattedWhole(tokens.contextWindowTokens))",
          detail: model.localizer.language == .english ? "\(Int((tokens.contextUsageRatio * 100).rounded()))% used" : "已使用 \(Int((tokens.contextUsageRatio * 100).rounded()))%",
          color: contextColor(tokens.contextUsageRatio),
          progress: tokens.contextUsageRatio
        )
        MetricCard(title: model.localizer.text("Input", "输入"), value: formattedWhole(tokens.inputTokens), detail: model.localizer.text("input tokens", "输入 tokens"), color: .blue)
        MetricCard(title: model.localizer.text("Output", "输出"), value: formattedWhole(tokens.outputTokens), detail: model.localizer.text("output tokens", "输出 tokens"), color: .green)
        MetricCard(title: model.localizer.text("Cache read", "缓存读取"), value: formattedWhole(tokens.cacheReadTokens), detail: model.localizer.text("reused context tokens", "复用的上下文 tokens"), color: .purple)
      }
      if availableWidth >= 860 {
        HStack(alignment: .top, spacing: 14) {
          contextCompositionPanel
          attachmentsPanel
        }
      } else {
        VStack(alignment: .leading, spacing: 14) {
          contextCompositionPanel
          attachmentsPanel
        }
      }
    }
  }

  private var contextCompositionPanel: some View {
        Panel(model.localizer.text("Context composition", "上下文构成"), systemImage: "square.stack.3d.up") {
          contextLayer(model.localizer.text("System guidance", "系统指引"), model.localizer.text("Stable product rules and execution boundaries", "稳定的产品规则和执行边界"), "1")
          contextLayer(model.localizer.text("Canvas scope", "画布范围"), model.localizer.text("Plans, decisions, files, and related AgentRun records", "计划、决策、文件和相关 AgentRun 记录"), "2")
          contextLayer(model.localizer.text("Recent conversation", "最近对话"), model.localizer.text("Current journey and active instructions", "当前历程和活动指令"), "3")
          contextLayer(model.localizer.text("Task files", "任务文件"), model.localizer.text("Relevant project content loaded for the current task", "为当前任务加载的相关项目内容"), "4")
          Divider()
          Button { prepareContextReview() } label: { Label(model.localizer.text("Prepare Context Review", "准备上下文审查"), systemImage: "text.magnifyingglass") }
        }
  }

  private var attachmentsPanel: some View {
        Panel(model.localizer.dynamic("attachments"), systemImage: "paperclip") {
          if model.state.runtimeStatus.attachments.isEmpty {
            EmptyState(title: model.localizer.text("No attachments", "没有附件"), detail: model.localizer.text("Images and other runtime inputs will appear here.", "图像和其他运行时输入会显示在这里。"), systemImage: "paperclip")
          } else {
            ForEach(model.state.runtimeStatus.attachments) { attachment in
              attachmentRow(attachment)
              if attachment.id != model.state.runtimeStatus.attachments.last?.id { Divider() }
            }
          }
        }
  }

  private func sessionsSection(availableWidth: CGFloat) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      SessionContinuityView(
        availableWidth: availableWidth,
        automaticallyLoadRuntimeData: automaticallyLoadRuntimeData
      )
      ProjectSessionSummaryCard()
      AdaptiveMetricGrid(minimumColumnWidth: 190) {
        MetricCard(title: model.localizer.text("Locale", "语言区域"), value: model.state.runtimeStatus.language.activeLocale, detail: model.state.runtimeStatus.language.source, color: .teal)
        MetricCard(title: model.localizer.text("Turns", "轮次"), value: formattedWhole(model.state.runtimeStatus.tokens.turnCount), detail: model.localizer.text("current recorded session", "当前记录会话"), color: .purple)
        MetricCard(
          title: model.localizer.dynamic("updated"),
          value: model.state.runtimeStatus.updatedAt.isEmpty ? model.localizer.dynamic("not_recorded") : model.state.runtimeStatus.updatedAt,
          detail: model.localizer.text("runtime status snapshot", "运行时状态快照"),
          color: .orange
        )
      }
      if availableWidth >= 860 {
        HStack(alignment: .top, spacing: 14) {
          projectSessionPanel
          ProjectLifecycleView(availableWidth: availableWidth)
            .environmentObject(model)
            .frame(minWidth: 280, idealWidth: 320, maxWidth: 340)
        }
      } else {
        VStack(alignment: .leading, spacing: 14) {
          projectSessionPanel
          ProjectLifecycleView(availableWidth: availableWidth)
            .environmentObject(model)
        }
      }
      projectScopePanel(availableWidth: availableWidth)
      persistedStatePanel
    }
  }

  private var projectSessionPanel: some View {
    Panel(model.localizer.text("Project session", "项目会话"), systemImage: "rectangle.stack") {
      sessionRow(model.localizer.text("Project root", "项目根目录"), model.projectDisplayPath, icon: "folder")
      sessionRow(model.localizer.text("State directory", "状态目录"), model.stateDirectoryDisplayPath, icon: "externaldrive")
      sessionRow(model.localizer.text("Runtime mode", "运行时模式"), humanized(model.displayedRuntimeMode.rawValue, localizer: model.localizer), icon: "switch.2")
      sessionRow(model.localizer.text("Model", "模型"), modelName, icon: "cpu")
      Divider()
      ViewThatFits(in: .horizontal) {
        HStack { sessionCopyButtons }
        VStack(alignment: .leading, spacing: 8) { sessionCopyButtons }
      }
    }
  }

  @ViewBuilder
  private var sessionCopyButtons: some View {
    Button { copy(model.projectDisplayPath, message: model.localizer.text("Project path copied", "项目路径已复制")) } label: {
      Label(model.localizer.text("Copy Project Path", "复制项目路径"), systemImage: "doc.on.doc")
        .fixedSize(horizontal: false, vertical: true)
    }
    Button { copy(model.stateDirectoryDisplayPath, message: model.localizer.text("State path copied", "状态路径已复制")) } label: {
      Label(model.localizer.text("Copy State Path", "复制状态路径"), systemImage: "doc.on.doc")
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private func projectScopePanel(availableWidth: CGFloat) -> some View {
    Panel(model.localizer.text("Project scope", "项目范围"), systemImage: "scope") {
      if availableWidth >= 720 {
        HStack(alignment: .top, spacing: 16) {
          projectScopeDetails
            .layoutPriority(1)
          Spacer(minLength: 12)
          projectScopeActions
            .frame(minWidth: 190, alignment: .trailing)
        }
      } else {
        VStack(alignment: .leading, spacing: 12) {
          projectScopeDetails
          projectScopeActions
        }
      }
    }
    .confirmationDialog(
      model.localizer.text("Rebind persisted Canvas scope?", "重新绑定持久化画布范围？"),
      isPresented: $confirmProjectRebind,
      titleVisibility: .visible
    ) {
      Button(model.localizer.text(
        "Rebind to \(model.projectRoot.lastPathComponent)",
        "重新绑定到 \(model.projectRoot.lastPathComponent)"
      ), role: .destructive) { model.rebindProjectScope() }
        .disabled(actionLocked(model, .rebindProjectScope))
      Button(model.localizer.dynamic("cancel"), role: .cancel) {}
    } message: {
      Text(model.localizer.text(
        "This explicitly binds persisted Canvas state to the current project root.",
        "这会将持久化画布状态显式绑定到当前项目根目录。"
      ))
    }
  }

  private var projectScopeDetails: some View {
        VStack(alignment: .leading, spacing: 8) {
          if let scope = model.projectScope {
            HStack {
              StatusBadge(
                text: humanized(scope.relation, localizer: model.localizer),
                color: scope.canLoadCanvas == false ? .orange : .green,
                systemImage: scope.canLoadCanvas == false ? "exclamationmark.triangle" : "checkmark.circle"
              )
              if let revision = scope.revision {
                Text(model.localizer.text("Revision \(revision)", "修订版本 \(revision)"))
                  .font(.caption)
                  .foregroundStyle(.secondary)
              }
            }
            sessionRow(model.localizer.text("Persisted project root", "持久化项目根目录"), scope.persistedProjectRoot, icon: "folder.badge.gearshape")
            if let source = scope.source {
              sessionRow(model.localizer.text("Binding source", "绑定来源"), humanized(source, localizer: model.localizer), icon: "link")
            }
            if let updatedAt = scope.updatedAt { sessionRow(model.localizer.dynamic("updated"), updatedAt, icon: "clock") }
            Text(scope.advisory)
              .font(.caption)
              .foregroundStyle(scope.canInjectScopedView == false ? Color.orange : Color.secondary)
              .fixedSize(horizontal: false, vertical: true)
          } else {
            Text(model.localizer.text(
              "Project scope has not been inspected in this App session.",
              "本次 App 会话尚未检查项目范围。"
            ))
              .font(.caption)
              .foregroundStyle(.secondary)
          }
        }
  }

  private var projectScopeActions: some View {
        VStack(alignment: .trailing, spacing: 8) {
          Button { model.inspectProjectScope() } label: {
            Label(model.localizer.text("Inspect Scope", "检查范围"), systemImage: "magnifyingglass")
              .fixedSize(horizontal: false, vertical: true)
          }
            .disabled(actionLocked(model, .inspectProjectScope))
          Button(role: .destructive) { confirmProjectRebind = true } label: {
            Label(model.localizer.text("Rebind to Current Project", "重新绑定到当前项目"), systemImage: "link.badge.plus")
              .fixedSize(horizontal: false, vertical: true)
          }
          .disabled(actionLocked(model, .rebindProjectScope))
        }
  }

  private var persistedStatePanel: some View {
    Panel(model.localizer.text("Persisted project state", "持久化项目状态"), systemImage: "externaldrive.badge.checkmark") {
      let records = model.persistedStateRecords
      if records.isEmpty {
        EmptyState(
          title: model.localizer.text("No state records found", "未找到状态记录"),
          detail: model.localizer.text(
            "State is created as Canvast records project activity.",
            "Canvast 记录项目活动时会创建状态。"
          ),
          systemImage: "externaldrive"
        )
      } else {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 220), spacing: 10)], spacing: 10) {
          ForEach(records) { record in
            VStack(alignment: .leading, spacing: 6) {
              Label(record.name, systemImage: record.isDirectory ? "folder" : "doc")
                .font(.subheadline.weight(.medium))
                .fixedSize(horizontal: false, vertical: true)
              Text(persistedRecordDetail(record))
                .font(.caption2)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
              scrollableMonospacedValue(record.url.path)
            }
            .padding(10)
            .frame(maxWidth: .infinity, minHeight: 96, alignment: .topLeading)
            .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
            .contextMenu {
              Button(model.localizer.text("Copy path", "复制路径")) {
                copy(record.url.path, message: model.localizer.text("State record path copied", "状态记录路径已复制"))
              }
            }
          }
        }
      }
    }
  }

  private var filteredFeatures: [CanvastFeature] {
    let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let productFeatures = CanvastProductCapabilityCatalog.features(from: model.state.features)
    guard !query.isEmpty else { return productFeatures }
    return productFeatures.filter {
      [$0.title, $0.detail, $0.controlPlane, $0.command ?? ""].joined(separator: " " ).lowercased().contains(query)
    }
  }

  private var modelName: String {
    let runtime = model.state.runtimeStatus.model
    let parts = [runtime.provider, runtime.model].filter { !$0.isEmpty }
    return parts.isEmpty ? model.localizer.dynamic("not_recorded") : parts.joined(separator: " / ")
  }

  private func contextLayer(_ title: String, _ detail: String, _ number: String) -> some View {
    HStack(alignment: .top, spacing: 10) {
      Text(number).font(.caption.bold()).foregroundStyle(.white).frame(width: 22, height: 22).background(.blue, in: Circle())
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.subheadline.weight(.medium)).fixedSize(horizontal: false, vertical: true)
        Text(detail).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      }
      Spacer()
    }
  }

  private func attachmentRow(_ attachment: CanvastRuntimeAttachment) -> some View {
    VStack(alignment: .leading, spacing: 5) {
      HStack {
        Label(humanized(attachment.kind, localizer: model.localizer), systemImage: "paperclip").font(.subheadline.weight(.medium))
        Spacer()
        StatusBadge(text: humanized(attachment.disposition, localizer: model.localizer), color: .blue)
      }
      Text(attachment.summary)
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      scrollableMonospacedValue(attachment.placeholder, foregroundStyle: Color.secondary.opacity(0.72))
    }
    .contextMenu {
      Button(model.localizer.text("Copy placeholder", "复制占位符")) {
        copy(attachment.placeholder, message: model.localizer.text("Attachment placeholder copied", "附件占位符已复制"))
      }
    }
  }

  private func persistedRecordDetail(_ record: PersistedStateRecord) -> String {
    var parts: [String] = []
    if record.isDirectory {
      parts.append(model.localizer.text("Directory", "目录"))
    } else if let sizeBytes = record.sizeBytes {
      parts.append(ByteCountFormatter.string(fromByteCount: Int64(sizeBytes), countStyle: .file))
    }
    if let modifiedAt = record.modifiedAt {
      parts.append(modifiedAt.formatted(date: .abbreviated, time: .shortened))
    }
    return parts.isEmpty ? model.localizer.text("State record", "状态记录") : parts.joined(separator: " · ")
  }

  private func sessionRow(_ title: String, _ value: String, icon: String) -> some View {
    HStack(alignment: .top, spacing: 9) {
      Image(systemName: icon).foregroundStyle(.secondary).frame(width: 18)
      VStack(alignment: .leading, spacing: 4) {
        Text(title).font(.caption2).foregroundStyle(.secondary)
        scrollableMonospacedValue(value)
      }
      Spacer()
    }
  }

  private func scrollableMonospacedValue(
    _ value: String,
    foregroundStyle: Color = .primary
  ) -> some View {
    ScrollView(.horizontal) {
      Text(value)
        .font(.caption.monospaced())
        .foregroundStyle(foregroundStyle)
        .textSelection(.enabled)
        .fixedSize(horizontal: true, vertical: false)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private func contextColor(_ ratio: Double) -> Color { ratio >= 0.9 ? .red : ratio >= 0.7 ? .orange : .blue }

  private func prepareContextReview() {
    model.prepareRequest(
      model.localizer.text(
        "Review the current context budget and Canvas scope. Identify stale or irrelevant context, missing project records, and the smallest safe context needed for the active task.",
        "审查当前上下文预算和画布范围，识别陈旧或无关的上下文、缺失的项目记录，以及当前任务所需的最小安全上下文。"
      ),
      status: model.localizer.text(
        "Prepared a context review request. Press Run to execute it.",
        "已准备上下文审查请求。点击运行以执行。"
      )
    )
  }

  private func prepareFeature(_ feature: CanvastFeature) {
    model.prepareFeature(feature)
    model.statusLine = model.localizer.text(
      "Prepared \(feature.title) in Run Console. Press Run to execute it.",
      "已在运行控制台中准备 \(feature.title)。点击运行以执行。"
    )
  }

  private func copy(_ value: String, message: String) {
    model.copyText(value, status: message)
  }
}
