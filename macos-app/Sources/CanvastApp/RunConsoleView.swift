import SwiftUI
import CanvastAppCore

struct RunConsoleView: View {
  @EnvironmentObject private var model: CanvastDesktopModel
  @State private var followsOutput = true
  @State private var requestPolicy: CanvastRuntimeRequestControlPolicy = .sidecar
  @State private var compactOutput: RunConsoleOutputSection = .turns
  @FocusState private var promptIsFocused: Bool

  var body: some View {
    GeometryReader { geometry in
      content(
        availableWidth: max(0, geometry.size.width - 36),
        availableHeight: max(0, geometry.size.height - 36)
      )
    }
    .background(Color(nsColor: .windowBackgroundColor))
    .task {
      model.synchronizeCurrentConversationStateIfPossible()
    }
  }

  private func content(availableWidth: CGFloat, availableHeight: CGFloat) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      WorkspaceTitle(
        workspace: .runConsole,
        trailing: AnyView(RunConsoleStateBadge(state: model.runState))
      )

      settingsStrip(availableWidth: availableWidth, compactHeight: availableHeight < 740)
      controls(availableWidth: availableWidth)
      if model.runState.isActive { runningInputBar(availableWidth: availableWidth) }

      VSplitView {
        editorAndPreview(availableWidth: availableWidth)
          .frame(
            minHeight: availableHeight < 740 ? 90 : 130,
            idealHeight: availableHeight < 740 ? 150 : 200
          )

        runOutput(availableWidth: availableWidth)
          .frame(
            minHeight: availableHeight < 740 ? 120 : 170,
            idealHeight: availableHeight < 740 ? 220 : 320
          )
      }
    }
    .padding(18)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }

  @ViewBuilder
  private func runOutput(availableWidth: CGFloat) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Picker(model.localizer.text("Run output", "运行输出"), selection: $compactOutput) {
        ForEach(RunConsoleOutputSection.allCases) { section in
          Text(section.title(localizer: model.localizer)).tag(section)
        }
      }
      .pickerStyle(.segmented)
      .labelsHidden()

      switch compactOutput {
      case .turns:
        turnOutput
      case .console:
        console
      case .requests:
        requestObservability
      }
    }
  }

  private var requestObservability: some View {
    ScrollView {
      RunRequestObservabilityView(
        status: model.state.runtimeStatus,
        receipt: model.requestControlResult,
        dispatchCorrelationID: model.actionSnapshot(.sendRequestControl)?.correlationID,
        isRefreshing: model.isPollingRefreshInFlight
      )
      .padding(.top, 6)
    }
  }

  private func runningInputBar(availableWidth: CGFloat) -> some View {
    RunConsoleSurface {
      VStack(alignment: .leading, spacing: 8) {
        if availableWidth >= 620 {
          HStack(spacing: 10) {
            requestPolicyPicker
            runningInputField
            sendControlButton
          }
        } else {
          VStack(alignment: .leading, spacing: 8) {
            requestPolicyPicker.frame(maxWidth: .infinity)
            HStack(spacing: 10) {
              runningInputField
              sendControlButton
            }
          }
        }
        Text(policyDetail)
          .font(.caption)
          .foregroundStyle(requestPolicyAffectsPrimary ? Color.orange : Color.secondary)
      }
    }
    .fixedSize(horizontal: false, vertical: true)
  }

  private var requestPolicyPicker: some View {
    Picker(model.localizer.text("Request policy", "请求策略"), selection: $requestPolicy) {
      ForEach(CanvastRuntimeRequestControlPolicy.allCases, id: \.self) { policy in
        Text(policyTitle(policy)).tag(policy)
      }
    }
    .frame(minWidth: 190, idealWidth: 210)
  }

  private var runningInputField: some View {
    TextField(policyPlaceholder, text: $model.runningInputDraft)
      .textFieldStyle(.roundedBorder)
      .frame(minWidth: 240)
      .onSubmit { submitRunningInput() }
  }

  private var sendControlButton: some View {
    Button(model.localizer.text("Send Control", "发送控制")) { submitRunningInput() }
      .buttonStyle(.borderedProminent)
      .fixedSize(horizontal: false, vertical: true)
      .disabled(!canSendRunningInput)
  }

  private func submitRunningInput() {
    guard canSendRunningInput else { return }
    model.sendRequestControl(model.runningInputDraft, policy: requestPolicy)
    model.runningInputDraft = ""
  }

  private var canSendRunningInput: Bool {
    model.runState == .running && !actionLocked(model, .sendRequestControl) &&
      !model.runningInputDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  private var requestPolicyAffectsPrimary: Bool {
    switch requestPolicy {
    case .sidecar, .status: return false
    case .pause, .redirect, .taskAdjustment: return true
    }
  }

  private var policyPlaceholder: String {
    switch requestPolicy {
    case .sidecar:
      return model.localizer.text("Queue an independent follow-up request.", "排入一个独立的后续请求。")
    case .status:
      return model.localizer.text("Ask for current progress or blockers.", "询问当前进度或阻塞点。")
    case .pause:
      return model.localizer.text("Explain why the active work should pause.", "说明为什么当前工作需要暂停。")
    case .redirect:
      return model.localizer.text("Provide the replacement direction or objective.", "提供替代方向或目标。")
    case .taskAdjustment:
      return model.localizer.text("Describe the plan or task adjustment.", "描述计划或任务调整。")
    }
  }

  private var policyDetail: String {
    guard model.runState == .running else {
      return model.localizer.text(
        "Request controls become available after the run reaches Running.",
        "请求控制会在运行进入“运行中”后可用。"
      )
    }
    switch requestPolicy {
    case .sidecar:
      return model.localizer.text(
        "Preserves primary work and queues an independent follow-up.",
        "保留主工作，并排入一个独立的后续请求。"
      )
    case .status:
      return model.localizer.text(
        "Preserves primary work and requests a status response.",
        "保留主工作，并请求一条状态回复。"
      )
    case .pause:
      return model.localizer.text(
        "Explicitly affects primary work by pausing it.",
        "会显式影响主工作，并将其暂停。"
      )
    case .redirect:
      return model.localizer.text(
        "Explicitly affects primary work by replacing its direction.",
        "会显式影响主工作，并替换其方向。"
      )
    case .taskAdjustment:
      return model.localizer.text(
        "Explicitly affects primary work by amending the active plan or task.",
        "会显式影响主工作，并修改当前计划或任务。"
      )
    }
  }

  private func policyTitle(_ policy: CanvastRuntimeRequestControlPolicy) -> String {
    switch policy {
    case .sidecar: return model.localizer.text("Sidecar", "侧挂")
    case .status: return model.localizer.text("Status", "状态")
    case .pause: return model.localizer.text("Pause", "暂停")
    case .redirect: return model.localizer.text("Redirect", "重定向")
    case .taskAdjustment: return model.localizer.text("Task Adjustment", "任务调整")
    }
  }

  private func settingsStrip(availableWidth: CGFloat, compactHeight: Bool) -> some View {
    RunConsoleSurface {
      if availableWidth >= 980 {
        HStack(spacing: 12) {
          settingsHeading
            .frame(minWidth: 112, alignment: .leading)
          Divider().frame(height: 56)
          settingsItems
        }
      } else if compactHeight && availableWidth >= 800 {
        VStack(alignment: .leading, spacing: 8) {
          settingsHeading
          Divider()
          LazyVGrid(
            columns: Array(repeating: GridItem(.flexible(minimum: 150), spacing: 8), count: 4),
            alignment: .leading,
            spacing: 8
          ) {
            settingsItems
          }
        }
      } else {
        VStack(alignment: .leading, spacing: 12) {
          settingsHeading
          Divider()
          LazyVGrid(
            columns: settingsColumns(availableWidth: availableWidth),
            alignment: .leading,
            spacing: 10
          ) {
            settingsItems
          }
        }
      }
    }
  }

  private func settingsColumns(availableWidth: CGFloat) -> [GridItem] {
    let count = availableWidth >= 760 ? 2 : 1
    return Array(repeating: GridItem(.flexible(minimum: 210), spacing: 10), count: count)
  }

  private var settingsHeading: some View {
    Label(model.localizer.text("Run settings", "运行设置"), systemImage: "slider.horizontal.3")
      .font(.headline)
      .fixedSize(horizontal: false, vertical: true)
  }

  @ViewBuilder
  private var settingsItems: some View {
    RunConsoleSetting(
      title: model.localizer.dynamic("mode"),
      value: model.displayedRuntimeMode == .enhanced
        ? model.localizer.text("Enhanced", "增强")
        : model.localizer.text("Standard", "标准"),
      detail: model.localizer.text("Runtime profile", "运行时配置"),
      systemImage: "switch.2"
    )
    RunConsoleSetting(
      title: model.localizer.dynamic("thinking"),
      value: humanized(model.thinkingLevel, localizer: model.localizer),
      detail: model.localizer.text("Reasoning level", "推理等级"),
      systemImage: "brain.head.profile"
    )
    RunConsoleTimeoutSetting(
      timeoutSeconds: $model.timeoutSeconds,
      value: timeoutLabel,
      disabled: model.runState.isActive || actionLocked(model, .startRun)
    )
    RunConsoleSetting(
      title: model.localizer.dynamic("project"),
      value: model.projectRoot.lastPathComponent,
      detail: model.localizer.text("Working directory", "工作目录"),
      systemImage: "folder"
    )
  }

  private func controls(availableWidth: CGFloat) -> some View {
    RunConsoleSurface {
      Group {
        if availableWidth >= 800 {
          HStack(spacing: 10) {
            controlButtons(compact: false)
            Divider().frame(height: 22)
            runStatusSummary
              .frame(minWidth: 180, maxWidth: .infinity, alignment: .leading)
          }
        } else {
          VStack(alignment: .leading, spacing: 10) {
            controlButtons(compact: availableWidth < 760)
            Divider()
            runStatusSummary
              .frame(maxWidth: .infinity, alignment: .leading)
          }
        }
      }
      .controlSize(.regular)
    }
  }

  @ViewBuilder
  private func controlButtons(compact: Bool) -> some View {
    if compact {
      LazyVGrid(
        columns: [GridItem(.adaptive(minimum: 132), spacing: 8)],
        spacing: 8
      ) {
        controlButtonItems
      }
    } else {
      HStack(spacing: 8) { controlButtonItems }
    }
  }

  @ViewBuilder
  private var controlButtonItems: some View {
      Button { model.previewRun() } label: {
        RunControlLabel(title: model.localizer.dynamic("preview"), systemImage: "eye")
      }
      .frame(maxWidth: .infinity)
      .disabled(model.runState.isActive || actionLocked(model, .previewRun))
      .help(model.localizer.text("Prepare the launch without starting a run", "在不启动运行的情况下准备启动"))

      Button { model.startRun() } label: {
        RunControlLabel(title: model.localizer.dynamic("run"), systemImage: "play.fill")
      }
      .buttonStyle(.borderedProminent)
      .frame(maxWidth: .infinity)
      .disabled(!model.canStartRun)
      .help(model.localizer.text("Start the Canvast run", "启动 Canvast 运行"))

      Button { model.stopRun() } label: {
        RunControlLabel(title: model.localizer.dynamic("stop"), systemImage: "stop.fill")
      }
      .tint(.red)
      .frame(maxWidth: .infinity)
      .disabled(!model.runState.isActive || actionLocked(model, .stopRun))
      .help(model.localizer.text("Stop the active Canvast run", "停止当前 Canvast 运行"))

      Button { model.clearConsole() } label: {
        RunControlLabel(title: model.localizer.dynamic("clear"), systemImage: "trash")
      }
      .frame(maxWidth: .infinity)
      .disabled(
        model.runState.isActive ||
        actionLocked(model, .clearConsole) ||
        (model.consoleEntries.isEmpty && model.launchPreview == nil)
      )
      .help(model.localizer.text("Clear output and the launch preview", "清空输出和启动预览"))
  }

  private var runStatusSummary: some View {
    HStack(spacing: 8) {
      if model.runState.isActive {
        ProgressView()
          .progressViewStyle(.linear)
          .frame(width: 72)
          .accessibilityLabel(model.runState.label)
      }
      Image(systemName: model.runState.symbol)
        .foregroundStyle(model.runState.color)
      Text(model.localizedStatusLine)
        .font(.callout)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  @ViewBuilder
  private func editorAndPreview(availableWidth: CGFloat) -> some View {
    if availableWidth >= 820 {
      HStack(alignment: .top, spacing: 12) {
        promptEditor.frame(minWidth: 390)
        launchPreview.frame(minWidth: 390)
      }
      .padding(.vertical, 6)
    } else {
      VStack(alignment: .leading, spacing: 12) {
        promptEditor.frame(minHeight: 170)
        launchPreview.frame(minHeight: 150)
      }
      .padding(.vertical, 6)
    }
  }

  private var promptEditor: some View {
    RunConsoleSurface(expandsVertically: true) {
      VStack(alignment: .leading, spacing: 10) {
        HStack {
          Label(model.localizer.text("Prompt", "提示词"), systemImage: "text.bubble")
            .labelStyle(.titleAndIcon)
            .font(.headline)
          Spacer()
          if model.runState.isActive {
            Label(
              model.localizer.text("Use Sidecar or Redirect above", "请使用上方的侧挂或重定向"),
              systemImage: "arrow.turn.down.right"
            )
              .font(.caption)
              .foregroundStyle(.secondary)
          } else {
            Text(
              model.localizer.counted(
                model.prompt.count,
                singularEnglish: "character",
                pluralEnglish: "characters",
                simplifiedChineseSuffix: " 个字符"
              )
            )
              .font(.caption)
              .foregroundStyle(.tertiary)
          }
        }

        TextEditor(text: $model.prompt)
          .font(.system(.body, design: .monospaced))
          .scrollContentBackground(.hidden)
          .padding(7)
          .focused($promptIsFocused)
          .disabled(model.runState.isActive)
          .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
          .overlay {
            RoundedRectangle(cornerRadius: 8)
              .stroke(promptIsFocused ? Color.accentColor : Color(nsColor: .separatorColor), lineWidth: promptIsFocused ? 1.5 : 1)
          }
          .overlay(alignment: .topLeading) {
            if model.prompt.isEmpty {
              Text(model.localizer.text(
                "Describe what Canvast should do in this project.",
                "描述 Canvast 应在这个项目中做什么。"
              ))
                .font(.system(.body, design: .monospaced))
                .foregroundStyle(.tertiary)
                .padding(.horizontal, 13)
                .padding(.vertical, 15)
                .allowsHitTesting(false)
            }
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .accessibilityLabel(model.localizer.text("Run prompt", "运行提示词"))

        Text(model.localizer.text(
          "Preview inspects the launch only. Press Run to execute the prompt.",
          "预览只检查启动内容。点击运行以执行提示词。"
        ))
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var launchPreview: some View {
    RunConsoleSurface(expandsVertically: true) {
      VStack(alignment: .leading, spacing: 10) {
        HStack {
          Label(model.localizer.text("Launch preview", "启动预览"), systemImage: "terminal")
            .font(.headline)
          Spacer()
          if model.launchPreview != nil {
            StatusBadge(
              text: model.localizer.dynamic("ready"),
              color: .green,
              systemImage: "checkmark.circle.fill"
            )
          }
        }

        if let preview = model.launchPreview {
          ScrollView([.horizontal, .vertical]) {
            Text(verbatim: preview)
              .font(.system(.caption, design: .monospaced))
              .foregroundStyle(.primary)
              .textSelection(.enabled)
              .fixedSize(horizontal: true, vertical: true)
              .frame(maxWidth: .infinity, alignment: .topLeading)
              .padding(10)
          }
          .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
          .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(nsColor: .separatorColor)))
          .accessibilityLabel(model.localizer.text("Canvast launch preview", "Canvast 启动预览"))
        } else {
          VStack(spacing: 8) {
            Image(systemName: "eye")
              .font(.title2)
              .foregroundStyle(.tertiary)
            Text(model.localizer.text("No preview prepared", "尚未准备预览"))
              .font(.subheadline.weight(.medium))
            Text(model.localizer.text(
              "Select Preview to inspect the launch, then press Run to execute.",
              "选择预览以检查启动内容，然后点击运行来执行。"
            ))
              .font(.caption)
              .foregroundStyle(.secondary)
              .multilineTextAlignment(.center)
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var console: some View {
    RunConsoleSurface(contentPadding: 0, expandsVertically: true) {
      VStack(alignment: .leading, spacing: 0) {
        HStack(spacing: 10) {
          Label(model.localizer.text("Console", "控制台"), systemImage: "rectangle.and.text.magnifyingglass")
            .font(.headline)

          Text(entryCountLabel)
            .font(.caption)
            .foregroundStyle(.secondary)

          Spacer()

          if model.runState.isActive {
            ProgressView()
              .controlSize(.small)
              .accessibilityLabel(model.localizer.text("Canvast run in progress", "Canvast 运行中"))
          }

          Toggle(model.localizer.text("Follow output", "跟随输出"), isOn: $followsOutput)
            .toggleStyle(.switch)
            .controlSize(.small)
            .font(.caption)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)

        Divider()

        ConsoleOutputView(
          entries: consoleDisplayEntries,
          followsOutput: followsOutput
        )
      }
    }
    .padding(.top, 6)
  }

  private var turnOutput: some View {
    RunConsoleSurface(contentPadding: 0, expandsVertically: true) {
      VStack(alignment: .leading, spacing: 0) {
        HStack(spacing: 10) {
          Label(model.localizer.text("Turn", "轮次"), systemImage: "bubble.left.and.bubble.right")
            .font(.headline)

          Text(turnCountLabel)
            .font(.caption)
            .foregroundStyle(.secondary)

          Spacer()

          if model.runState.isActive {
            ProgressView()
              .controlSize(.small)
              .accessibilityLabel(model.localizer.text("Canvast run in progress", "Canvast 运行中"))
          }

          Toggle(model.localizer.text("Follow output", "跟随输出"), isOn: $followsOutput)
            .toggleStyle(.switch)
            .controlSize(.small)
            .font(.caption)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)

        Divider()

        RunTurnOutputView(
          messages: model.currentConversationTimelineMessages(),
          followsOutput: followsOutput
        )
      }
    }
    .padding(.top, 6)
  }

  private var timeoutLabel: String {
    guard model.timeoutSeconds > 0 else { return model.localizer.text("No limit", "无限制") }
    if model.timeoutSeconds.isMultiple(of: 60) {
      return model.localizer.language == .english
        ? "\(model.timeoutSeconds / 60) min"
        : "\(model.timeoutSeconds / 60) 分钟"
    }
    return model.localizer.language == .english
      ? "\(model.timeoutSeconds) sec"
      : "\(model.timeoutSeconds) 秒"
  }

  private var entryCountLabel: String {
    let count = consoleDisplayEntries.count
    return model.localizer.counted(
      count,
      singularEnglish: "entry",
      pluralEnglish: "entries",
      simplifiedChineseSuffix: " 条记录"
    )
  }

  private var turnCountLabel: String {
    let count = model.currentConversationTimelineMessages().filter { $0.role == .user }.count
    return model.localizer.counted(
      count,
      singularEnglish: "turn",
      pluralEnglish: "turns",
      simplifiedChineseSuffix: " 个轮次"
    )
  }

  private var consoleDisplayEntries: [ConsoleDisplayEntry] {
    RunConsoleDisplayProjection.entries(
      rawConsoleEntries: model.consoleEntries,
      conversationMessages: model.currentConversationTimelineMessages()
    )
  }
}

private enum RunConsoleOutputSection: String, CaseIterable, Identifiable {
  case turns
  case console
  case requests

  var id: String { rawValue }

  func title(localizer: CanvastLocalizer) -> String {
    switch self {
    case .turns: return localizer.text("Turn", "轮次")
    case .console: return localizer.text("Console", "控制台")
    case .requests: return localizer.text("Requests", "请求")
    }
  }
}

private struct RunConsoleTurn: Identifiable, Equatable {
  let id: String
  var messages: [SessionTimelineMessage]

  var firstTimestamp: String {
    messages.first?.timestamp ?? ""
  }

  var isStreaming: Bool {
    messages.contains { $0.isStreaming }
  }
}

private struct RunTurnOutputView: View {
  let messages: [SessionTimelineMessage]
  let followsOutput: Bool
  @EnvironmentObject private var model: CanvastDesktopModel

  private let bottomID = "canvast-turn-output-bottom"

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        if turns.isEmpty {
          VStack(spacing: 8) {
            Image(systemName: "bubble.left.and.bubble.right")
              .font(.title2)
              .foregroundStyle(.tertiary)
            Text(model.localizer.text("No active turn output", "暂无当前轮次输出"))
              .font(.headline)
            Text(model.localizer.text(
              "Start a run to see the prompt, visible process updates, tool results, and final answer grouped together.",
              "启动运行后，提示词、可见过程、工具结果和最终回复会按轮次显示。"
            ))
              .font(.caption)
              .foregroundStyle(.secondary)
              .multilineTextAlignment(.center)
          }
          .frame(maxWidth: .infinity, minHeight: 150)
          .padding()
        } else {
          LazyVStack(alignment: .leading, spacing: 12) {
            ForEach(turns) { turn in
              RunTurnCard(turn: turn)
            }
            Color.clear.frame(height: 1).id(bottomID)
          }
          .padding(12)
        }
      }
      .background(Color(nsColor: .textBackgroundColor).opacity(0.72))
      .onAppear { scrollToBottom(using: proxy, animated: false) }
      .onChange(of: messages) { _ in
        scrollToBottom(using: proxy, animated: true)
      }
      .onChange(of: followsOutput) { enabled in
        if enabled { scrollToBottom(using: proxy, animated: true) }
      }
    }
  }

  private var turns: [RunConsoleTurn] {
    guard !messages.isEmpty else { return [] }
    var orderedIDs: [String] = []
    var grouped: [String: [SessionTimelineMessage]] = [:]
    var currentID: String?
    var currentIndex = 0
    for message in messages {
      if message.role == .user || currentID == nil {
        currentIndex += 1
        currentID = "turn-\(currentIndex)-\(message.id)"
        orderedIDs.append(currentID!)
        grouped[currentID!] = []
      }
      grouped[currentID!]?.append(message)
    }
    return orderedIDs.compactMap { requestID in
      guard let messages = grouped[requestID], !messages.isEmpty else { return nil }
      return RunConsoleTurn(id: requestID, messages: messages)
    }
  }

  private func scrollToBottom(using proxy: ScrollViewProxy, animated: Bool) {
    guard followsOutput, !turns.isEmpty else { return }
    if animated {
      withAnimation(.easeOut(duration: 0.18)) {
        proxy.scrollTo(bottomID, anchor: .bottom)
      }
    } else {
      proxy.scrollTo(bottomID, anchor: .bottom)
    }
  }
}

private struct RunTurnCard: View {
  let turn: RunConsoleTurn
  @EnvironmentObject private var model: CanvastDesktopModel

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Label(model.localizer.text("Turn", "轮次"), systemImage: "arrow.triangle.2.circlepath")
          .font(.subheadline.weight(.semibold))
        if turn.isStreaming {
          StatusBadge(text: model.localizer.text("Live", "实时"), color: .blue)
        }
        Spacer(minLength: 8)
        if !turn.firstTimestamp.isEmpty {
          Text(turn.firstTimestamp)
            .font(.caption2)
            .foregroundStyle(.tertiary)
        }
      }
      LazyVStack(alignment: .leading, spacing: 10) {
        ForEach(turn.messages) { message in
          SessionMessageBubble(message: message)
        }
      }
    }
    .padding(10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 8))
    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(nsColor: .separatorColor).opacity(0.6)))
  }
}

private struct RunConsoleSurface<Content: View>: View {
  let contentPadding: CGFloat
  let expandsVertically: Bool
  let content: Content

  init(
    contentPadding: CGFloat = 14,
    expandsVertically: Bool = false,
    @ViewBuilder content: () -> Content
  ) {
    self.contentPadding = contentPadding
    self.expandsVertically = expandsVertically
    self.content = content()
  }

  var body: some View {
    content
      .padding(contentPadding)
      .frame(
        maxWidth: .infinity,
        maxHeight: expandsVertically ? .infinity : nil,
        alignment: .topLeading
      )
      .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
      .overlay {
        RoundedRectangle(cornerRadius: 10)
          .stroke(Color(nsColor: .separatorColor).opacity(0.7))
      }
  }
}

private struct RunConsoleSetting: View {
  let title: String
  let value: String
  let detail: String
  let systemImage: String

  var body: some View {
    HStack(spacing: 9) {
      Image(systemName: systemImage)
        .foregroundStyle(.tint)
        .frame(width: 24, height: 24)
        .background(.tint.opacity(0.1), in: RoundedRectangle(cornerRadius: 6))

      VStack(alignment: .leading, spacing: 1) {
        Text(title)
          .font(.caption2)
          .foregroundStyle(.secondary)
        Text(value)
          .font(.subheadline.weight(.semibold))
          .fixedSize(horizontal: false, vertical: true)
        Text(detail)
          .font(.caption2)
          .foregroundStyle(.tertiary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(.horizontal, 8)
    .frame(minWidth: 150, maxWidth: .infinity, minHeight: 50, alignment: .leading)
  }
}

private struct RunConsoleTimeoutSetting: View {
  @Binding var timeoutSeconds: Int
  let value: String
  let disabled: Bool
  @EnvironmentObject private var model: CanvastDesktopModel

  var body: some View {
    HStack(spacing: 7) {
      Image(systemName: "timer")
        .foregroundStyle(.tint)
        .frame(width: 24, height: 24)
        .background(.tint.opacity(0.1), in: RoundedRectangle(cornerRadius: 6))
      VStack(alignment: .leading, spacing: 1) {
        Text(model.localizer.dynamic("timeout")).font(.caption2).foregroundStyle(.secondary)
        Text(value)
          .font(.subheadline.weight(.semibold))
          .fixedSize(horizontal: false, vertical: true)
        Text(model.localizer.text(
          "\(timeoutSeconds) seconds maximum",
          "最多 \(timeoutSeconds) 秒"
        ))
        .font(.caption2)
        .foregroundStyle(.tertiary)
        .fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 2)
      Stepper("", value: $timeoutSeconds, in: 60...7_200, step: 60)
        .labelsHidden()
        .controlSize(.small)
        .disabled(disabled)
        .help(model.localizer.text("Change the run timeout in one-minute steps", "按 1 分钟步长调整运行超时"))
    }
    .padding(.horizontal, 8)
    .frame(minWidth: 170, maxWidth: .infinity, minHeight: 50, alignment: .leading)
  }
}

private struct RunControlLabel: View {
  let title: String
  let systemImage: String

  var body: some View {
    Label(title, systemImage: systemImage)
      .fixedSize(horizontal: false, vertical: true)
      .frame(minWidth: 72, minHeight: 18, alignment: .center)
  }
}

private struct RunConsoleStateBadge: View {
  let state: DesktopRunState
  @EnvironmentObject private var model: CanvastDesktopModel

  var body: some View {
    HStack(spacing: 6) {
      if state.isActive {
        ProgressView()
          .controlSize(.small)
      } else {
        Image(systemName: state.symbol)
      }
      Text(state.label)
    }
    .font(.caption.weight(.semibold))
    .foregroundStyle(state.color)
    .padding(.horizontal, 10)
    .padding(.vertical, 6)
    .background(state.color.opacity(0.12), in: Capsule())
    .accessibilityElement(children: .combine)
    .accessibilityLabel(model.localizer.text("Run status: \(state.label)", "运行状态：\(state.label)"))
  }
}
