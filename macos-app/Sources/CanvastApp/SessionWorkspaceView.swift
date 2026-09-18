import SwiftUI
import CanvastAppCore

struct SessionWorkspaceView: View {
  @EnvironmentObject private var model: CanvastDesktopModel

  let availableWidth: CGFloat
  @Binding var sessionSearch: String
  @Binding var selectedSessionPath: String
  @Binding var renameDraft: String
  @Binding var sessionInputDraft: String
  @Binding var confirmSessionDeletion: Bool

  @State private var requestPolicy: CanvastRuntimeRequestControlPolicy = .sidecar
  @State private var showsRunProcess = true

  private var desktopSessionPaneHeight: CGFloat { 650 }

  var body: some View {
    Group {
      if availableWidth >= 900 {
        HStack(alignment: .top, spacing: 14) {
          sessionSwitcher
            .frame(
              minWidth: 260, idealWidth: 300, maxWidth: 340,
              minHeight: desktopSessionPaneHeight, maxHeight: desktopSessionPaneHeight,
              alignment: .topLeading
            )
          conversationPane
            .frame(
              maxWidth: .infinity,
              minHeight: desktopSessionPaneHeight, maxHeight: desktopSessionPaneHeight,
              alignment: .bottomLeading
            )
        }
      } else {
        VStack(alignment: .leading, spacing: 14) {
          sessionSwitcher
          conversationPane
        }
      }
    }
  }

  private var sessionSwitcher: some View {
    Panel(
      model.localizer.text("Conversations", "会话"),
      systemImage: "bubble.left.and.bubble.right",
      fillsAvailableHeight: true
    ) {
      ViewThatFits(in: .horizontal) {
        HStack(spacing: 8) { switcherControls }
        VStack(alignment: .leading, spacing: 8) { switcherControls }
      }
      TextField(model.localizer.text("Search sessions", "搜索会话"), text: $sessionSearch)
        .textFieldStyle(.roundedBorder)
      Divider()
      if model.sessionCatalog == nil {
        EmptyState(
          title: sessionCatalogPlaceholderTitle,
          detail: sessionCatalogPlaceholderDetail,
          systemImage: sessionCatalogIsLoading ? "clock.arrow.circlepath" : "tray"
        )
        Button { model.loadSessionCatalog() } label: {
          Label(model.localizer.text("Refresh History", "刷新历史"), systemImage: "arrow.clockwise")
        }
        .disabled(!model.canManageSessions || actionLocked(model, .loadSessionCatalog))
      } else if filteredSessions.isEmpty {
        EmptyState(
          title: sessionSearch.isEmpty
            ? model.localizer.text("No saved conversations", "没有已保存会话")
            : model.localizer.text("No matching conversations", "没有匹配会话"),
          detail: sessionSearch.isEmpty
            ? model.localizer.text("Create a conversation to start a project session.", "新建会话以开始一个项目会话。")
            : model.localizer.text("Search by name, ID, path, or transcript preview.", "可按名称、ID、路径或转录预览搜索。"),
          systemImage: sessionSearch.isEmpty ? "square.and.pencil" : "magnifyingglass"
        )
      } else {
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 8) {
            ForEach(filteredSessions) { session in
              Button { selectConversation(session) } label: {
                sessionRow(session)
              }
              .buttonStyle(.plain)
            }
          }
        }
        .frame(maxHeight: 430)
      }
    }
  }

  @ViewBuilder
  private var switcherControls: some View {
    Button { startNewConversation() } label: {
      Label(model.localizer.text("New Chat", "新建对话"), systemImage: "square.and.pencil")
    }
    .buttonStyle(.borderedProminent)
    .disabled(!model.canManageSessions || actionLocked(model, .startNewSession))

    Button { model.loadSessionCatalog() } label: {
      Label(model.localizer.text("Refresh History", "刷新历史"), systemImage: "arrow.clockwise")
    }
    .disabled(!model.canManageSessions || actionLocked(model, .loadSessionCatalog))
  }

  private func sessionRow(_ session: DesktopSessionCatalogItem) -> some View {
    VStack(alignment: .leading, spacing: 7) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Image(systemName: session.isActive ? "record.circle.fill" : "text.bubble")
          .foregroundStyle(session.isActive ? Color.green : Color.secondary)
        Text(sessionName(session))
          .font(.subheadline.weight(.semibold))
          .fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 6)
        if session.isActive {
          StatusBadge(text: model.localizer.dynamic("current"), color: .green)
        }
      }
      if let firstMessage = nonempty(session.firstMessage) {
        Text(firstMessage)
          .font(.caption)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      ViewThatFits(in: .horizontal) {
        HStack(spacing: 10) { sessionMetadata(session) }
        VStack(alignment: .leading, spacing: 4) { sessionMetadata(session) }
      }
      .font(.caption2)
      .foregroundStyle(.tertiary)
    }
    .padding(10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      selectedSessionPath == session.path ? Color.accentColor.opacity(0.13) : Color.primary.opacity(0.035),
      in: RoundedRectangle(cornerRadius: 8)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 8)
        .stroke(selectedSessionPath == session.path ? Color.accentColor.opacity(0.65) : Color.clear)
    )
  }

  @ViewBuilder
  private func sessionMetadata(_ session: DesktopSessionCatalogItem) -> some View {
    Label(
      model.localizer.counted(
        session.messageCount,
        singularEnglish: "message",
        pluralEnglish: "messages",
        simplifiedChineseSuffix: " 条消息"
      ),
      systemImage: "text.bubble"
    )
    if !session.modifiedAt.isEmpty {
      Label(session.modifiedAt, systemImage: "clock")
    }
  }

  private var conversationPane: some View {
    Panel(
      model.localizer.text("Conversation", "对话"),
      systemImage: "message",
      fillsAvailableHeight: true
    ) {
      if let session = selectedSession {
        conversationContent(session)
      } else {
        VStack(alignment: .leading, spacing: 12) {
          EmptyState(
            title: model.localizer.text("Choose or create a conversation", "选择或新建会话"),
            detail: model.localizer.text("A conversation opens its project session, shows transcript history, and keeps the next input at the bottom.", "会话页会打开项目会话、展示历史记录，并把下一轮输入固定在底部。"),
            systemImage: "bubble.left.and.text.bubble.right"
          )
          Button { startNewConversation() } label: {
            Label(model.localizer.text("New Chat", "新建对话"), systemImage: "square.and.pencil")
          }
          .buttonStyle(.borderedProminent)
          .disabled(!model.canManageSessions || actionLocked(model, .startNewSession))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
      }
    }
  }

  private func conversationContent(_ session: DesktopSessionCatalogItem) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      conversationHeader(session)
      Divider()
      conversationActivitySection(session)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .layoutPriority(1)
      Divider()
      composer(session)
        .frame(maxWidth: .infinity, alignment: .bottomLeading)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }

  private func conversationHeader(_ session: DesktopSessionCatalogItem) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .top, spacing: 10) {
        VStack(alignment: .leading, spacing: 5) {
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(sessionName(session))
              .font(.headline)
              .fixedSize(horizontal: false, vertical: true)
            if session.isActive {
              StatusBadge(text: model.localizer.dynamic("current"), color: .green)
            }
          }
          ScrollableMonospacedText(
            value: session.id.isEmpty ? session.path : session.id,
            font: .caption2.monospaced(),
            color: .secondary
          )
        }
        Spacer(minLength: 8)
        SessionRunStatusPill(state: model.runState)
      }
      ViewThatFits(in: .horizontal) {
        HStack(spacing: 8) { conversationActions(session) }
        VStack(alignment: .leading, spacing: 8) { conversationActions(session) }
      }
      renameSection(session)
    }
  }

  @ViewBuilder
  private func conversationActions(_ session: DesktopSessionCatalogItem) -> some View {
    Button { loadConversationTranscript(session) } label: {
      Label(
        model.localizer.text("History", "历史"),
        systemImage: "text.book.closed"
      )
    }
    .disabled(!model.canManageSessions || actionLocked(model, .loadSessionTranscript))

    Button { openConversation(session) } label: {
      Label(
        session.isActive
          ? model.localizer.text("Current", "当前")
          : model.localizer.text("Open", "打开"),
        systemImage: session.isActive ? "record.circle.fill" : "arrow.right.square"
      )
    }
    .disabled(openConversationDisabled(session))

    Button(role: .destructive) { confirmSessionDeletion = true } label: {
      Label(model.localizer.text("Delete", "删除"), systemImage: "trash")
    }
    .disabled(!model.canManageSessions || session.isActive || actionLocked(model, .deleteSession))
    .help(deleteActionHelp(session))

    Toggle(isOn: $showsRunProcess) {
      Label(model.localizer.text("Process", "过程"), systemImage: "waveform.path.ecg")
    }
    .toggleStyle(.checkbox)
  }

  @ViewBuilder
  private func renameSection(_ session: DesktopSessionCatalogItem) -> some View {
    if session.isActive {
      ViewThatFits(in: .horizontal) {
        HStack(spacing: 8) { renameControls }
        VStack(alignment: .leading, spacing: 8) { renameControls }
      }
    } else {
      Text(model.localizer.text("Open this conversation before renaming or continuing it.", "先打开此会话，然后再重命名或继续。"))
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  @ViewBuilder
  private var renameControls: some View {
    TextField(model.localizer.text("Conversation name", "会话名称"), text: $renameDraft)
      .textFieldStyle(.roundedBorder)
      .frame(minWidth: 210)
      .onSubmit { renameCurrentSession() }
    Button { renameCurrentSession() } label: {
      Label(model.localizer.text("Rename", "重命名"), systemImage: "pencil")
    }
    .disabled(renameDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || actionLocked(model, .renameSession))
  }

  private func conversationActivitySection(_ session: DesktopSessionCatalogItem) -> some View {
    let messages = timelineMessages(for: session)
    return ScrollViewReader { proxy in
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          transcriptSection(messages)
          if showsRunProcess {
            Divider()
            runProcessSection
          }
          Color.clear.frame(height: 1).id("session-timeline-bottom")
        }
        .padding(.vertical, 2)
        .frame(maxWidth: .infinity, alignment: .topLeading)
      }
      .onChange(of: model.sessionTranscript) { _ in
        withAnimation(.easeOut(duration: 0.2)) {
          proxy.scrollTo("session-timeline-bottom", anchor: .bottom)
        }
      }
      .onChange(of: model.liveSessionMessages) { _ in
        withAnimation(.easeOut(duration: 0.2)) {
          proxy.scrollTo("session-timeline-bottom", anchor: .bottom)
        }
      }
    }
  }

  @ViewBuilder
  private func transcriptSection(_ messages: [SessionTimelineMessage]) -> some View {
    if messages.isEmpty {
      EmptyState(
        title: model.localizer.text("No transcript loaded", "尚未加载转录"),
        detail: model.localizer.text("Open or reload the conversation to show its recorded QA history.", "打开或重新加载会话以显示已记录的问答历史。"),
        systemImage: "text.book.closed"
      )
    } else {
      LazyVStack(alignment: .leading, spacing: 10) {
        ForEach(messages) { message in
          SessionMessageBubble(message: message)
        }
      }
    }
  }

  private var runProcessSection: some View {
    let projection = RuntimeRequestObservabilityProjection(
      status: model.state.runtimeStatus,
      receipt: model.requestControlResult,
      dispatchCorrelationID: model.actionSnapshot(.sendRequestControl)?.correlationID
    )
    return VStack(alignment: .leading, spacing: 8) {
      HStack {
        Label(model.localizer.text("Run process", "运行过程"), systemImage: "waveform.path.ecg")
          .font(.subheadline.weight(.semibold))
        Spacer()
        LifecycleStateBadge(snapshot: latestConversationAction)
      }
      LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 8)], alignment: .leading, spacing: 8) {
        runProcessMetric(model.localizer.text("Queued input", "排队输入"), "\(projection.inputs.count)")
        runProcessMetric(model.localizer.text("Requests", "请求"), "\(projection.requests.count)")
        runProcessMetric(
          model.localizer.text("Snapshot", "快照"),
          model.state.runtimeStatus.updatedAt.isEmpty ? model.localizer.dynamic("not_recorded") : model.state.runtimeStatus.updatedAt
        )
      }
      if let receipt = projection.receipt {
        runReceiptSummary(receipt)
      }
      if projection.receipt == nil && projection.inputs.isEmpty && projection.requests.isEmpty {
        Text(model.localizer.text(
          "No queued input or request lifecycle entries are recorded for the current runtime snapshot.",
          "当前运行时快照尚未记录排队输入或请求生命周期。"
        ))
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      } else {
        runQueueSummary(projection.inputs)
        runRequestSummary(projection.requests)
      }
      if model.isPollingRefreshInFlight {
        Label(model.localizer.text("Refreshing persisted runtime state", "正在刷新持久化运行时状态"), systemImage: "arrow.clockwise")
          .font(.caption2)
          .foregroundStyle(.tertiary)
      }
    }
  }

  private func runProcessMetric(_ label: String, _ value: String) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(label)
        .font(.caption2)
        .foregroundStyle(.tertiary)
      Text(value)
        .font(.caption.monospacedDigit())
        .foregroundStyle(.primary)
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 8))
  }

  private func runReceiptSummary(_ receipt: RuntimeRequestReceiptProjection) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Label(model.localizer.text("Latest receipt", "最新回执"), systemImage: "checkmark.seal")
          .font(.caption.weight(.semibold))
        Spacer(minLength: 8)
        StatusBadge(text: humanized(receipt.requestStatus ?? receipt.queueStatus, localizer: model.localizer), color: runtimePhaseColor(receipt.requestStatus ?? receipt.queueStatus))
      }
      Text(receipt.message)
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      ViewThatFits(in: .horizontal) {
        HStack(spacing: 8) { receiptFields(receipt) }
        VStack(alignment: .leading, spacing: 4) { receiptFields(receipt) }
      }
    }
    .padding(9)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color.green.opacity(0.07), in: RoundedRectangle(cornerRadius: 8))
  }

  @ViewBuilder
  private func receiptFields(_ receipt: RuntimeRequestReceiptProjection) -> some View {
    Label(humanized(receipt.policy, localizer: model.localizer), systemImage: "slider.horizontal.3")
    Label(receipt.runtimeRequestID, systemImage: "number")
    if let dispatchCorrelationID = receipt.dispatchCorrelationID, !dispatchCorrelationID.isEmpty {
      Label(dispatchCorrelationID, systemImage: "paperplane")
    }
  }

  private func runQueueSummary(_ inputs: [CanvastRuntimeInput]) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Label(model.localizer.text("Input queue", "输入队列"), systemImage: "tray")
        .font(.caption.weight(.semibold))
      if inputs.isEmpty {
        Text(model.localizer.text("No queued input.", "没有排队输入。"))
          .font(.caption)
          .foregroundStyle(.secondary)
      } else {
        ForEach(inputs.prefix(3)) { input in
          runtimeItemRow(
            title: input.textSummary,
            status: input.status,
            metadata: [input.policy, input.deliveryMode, input.requestID].compactMap { $0 }
          )
        }
      }
    }
  }

  private func runRequestSummary(_ requests: [CanvastRuntimeRequest]) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Label(model.localizer.text("Request lifecycle", "请求生命周期"), systemImage: "list.bullet.rectangle")
        .font(.caption.weight(.semibold))
      if requests.isEmpty {
        Text(model.localizer.text("No correlated requests.", "没有关联请求。"))
          .font(.caption)
          .foregroundStyle(.secondary)
      } else {
        ForEach(requests.prefix(3)) { request in
          runtimeItemRow(
            title: request.textSummary,
            status: request.status,
            metadata: [request.kind, request.deliveryMode, request.requestID].compactMap { $0 }
          )
        }
      }
    }
  }

  private func runtimeItemRow(title: String, status: String, metadata: [String]) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(title.isEmpty ? model.localizer.dynamic("unknown") : title)
          .font(.caption)
          .fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 8)
        StatusBadge(text: humanized(status, localizer: model.localizer), color: runtimePhaseColor(status))
      }
      if !metadata.isEmpty {
        Text(metadata.map { humanized($0, localizer: model.localizer) }.joined(separator: " / "))
          .font(.caption2)
          .foregroundStyle(.tertiary)
          .textSelection(.enabled)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 8))
  }

  private func runtimePhaseColor(_ status: String) -> Color {
    RuntimeObservationPhase(status: status).color
  }

  private func composer(_ session: DesktopSessionCatalogItem) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      if model.runState == .running {
        Picker(model.localizer.text("Request policy", "请求策略"), selection: $requestPolicy) {
          ForEach(CanvastRuntimeRequestControlPolicy.allCases, id: \.self) { policy in
            Text(policyTitle(policy)).tag(policy)
          }
        }
        .frame(minWidth: 190, idealWidth: 230, maxWidth: 280, alignment: .leading)
      }
      ZStack(alignment: .topLeading) {
        TextEditor(text: activeComposerTextBinding)
          .font(.body)
          .scrollContentBackground(.hidden)
          .padding(8)
          .frame(minHeight: 98, maxHeight: 156)
        if activeComposerText.isEmpty {
          Text(composerPlaceholder(session))
            .font(.body)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 13)
            .padding(.vertical, 16)
            .allowsHitTesting(false)
        }
      }
      .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
      .overlay(
        RoundedRectangle(cornerRadius: 8)
          .stroke(Color(nsColor: .separatorColor), lineWidth: 1)
      )

      ViewThatFits(in: .horizontal) {
        HStack(alignment: .center, spacing: 10) {
          Text(composerDetail(session))
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
          Spacer(minLength: 8)
          sendComposerButton(session)
        }
        VStack(alignment: .leading, spacing: 8) {
          Text(composerDetail(session))
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
          HStack {
            Spacer(minLength: 0)
            sendComposerButton(session)
          }
        }
      }
    }
  }

  private func sendComposerButton(_ session: DesktopSessionCatalogItem) -> some View {
    Button { submitSessionMessage(session) } label: {
      Label(submitTitle(session), systemImage: submitSymbol(session))
        .frame(minWidth: 88)
    }
    .buttonStyle(.borderedProminent)
    .disabled(!canSubmitSessionMessage(session))
  }

  private var filteredSessions: [DesktopSessionCatalogItem] {
    guard let sessions = model.sessionCatalog?.sessions else { return [] }
    let query = sessionSearch.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !query.isEmpty else { return sessions }
    return sessions.filter { session in
      [
        session.name, session.id, session.path, session.cwd,
        session.firstMessage ?? "", session.allMessagesText ?? "",
      ].joined(separator: " ").lowercased().contains(query)
    }
  }

  private var selectedSession: DesktopSessionCatalogItem? {
    model.sessionCatalog?.sessions.first { $0.path == selectedSessionPath }
  }

  private var latestConversationAction: DesktopActionSnapshot? {
    [
      model.actionSnapshot(.startNewSession),
      model.actionSnapshot(.openSession),
      model.actionSnapshot(.loadSessionTranscript),
      model.actionSnapshot(.startRun),
      model.actionSnapshot(.sendRequestControl),
    ].compactMap { $0 }.max { $0.updatedAt < $1.updatedAt }
  }

  private var sessionCatalogIsLoading: Bool {
    model.actionSnapshot(.loadSessionCatalog)?.status.isActive == true
  }

  private var sessionCatalogPlaceholderTitle: String {
    if !model.workspaceIsConfigured {
      return model.localizer.text("Choose a workspace", "请选择工作区")
    }
    if sessionCatalogIsLoading {
      return model.localizer.text("Loading conversations", "正在加载会话")
    }
    return model.localizer.text("Conversation history not loaded", "尚未加载会话历史")
  }

  private var sessionCatalogPlaceholderDetail: String {
    if !model.workspaceIsConfigured {
      return model.workspaceRequiredMessage()
    }
    if sessionCatalogIsLoading {
      return model.localizer.text(
        "The session catalog is loading from the selected workspace.",
        "会话目录正在从已选择的工作区加载。"
      )
    }
    return model.localizer.text(
      "Refresh history to load saved conversations, or start a new chat.",
      "刷新历史以加载已保存会话，或新建对话。"
    )
  }

  private func startNewConversation() {
    guard model.canManageSessions else {
      model.statusLine = model.workspaceRequiredMessage()
      return
    }
    selectedSessionPath = ""
    model.prompt = ""
    model.runningInputDraft = ""
    sessionInputDraft = ""
    model.startNewSession()
  }

  private func selectConversation(_ session: DesktopSessionCatalogItem) {
    selectedSessionPath = session.path
    renameDraft = session.name
    if session.isActive {
      loadConversationTranscript(session)
    }
  }

  private func openConversation(_ session: DesktopSessionCatalogItem) {
    guard model.canManageSessions else {
      model.statusLine = model.workspaceRequiredMessage()
      return
    }
    selectedSessionPath = session.path
    renameDraft = session.name
    if !session.isActive, !actionLocked(model, .openSession) {
      model.openSession(path: session.path)
    } else {
      loadConversationTranscript(session)
    }
  }

  private func openConversationDisabled(_ session: DesktopSessionCatalogItem) -> Bool {
    guard model.canManageSessions else { return true }
    if session.isActive {
      return true
    }
    return actionLocked(model, .openSession)
  }

  private func deleteActionHelp(_ session: DesktopSessionCatalogItem) -> String {
    if !model.canManageSessions { return model.workspaceRequiredMessage() }
    if session.isActive {
      return model.localizer.text(
        "Open another conversation before deleting this current one.",
        "请先打开另一个会话，再删除当前会话。"
      )
    }
    if actionLocked(model, .deleteSession) {
      return model.localizer.text(
        "Another session deletion is still finishing.",
        "另一个会话删除操作仍在完成。"
      )
    }
    return model.localizer.text(
      "Move this saved conversation to the project trash.",
      "将这个已保存会话移到项目回收目录。"
    )
  }

  private func loadConversationTranscript(_ session: DesktopSessionCatalogItem) {
    guard model.canManageSessions else {
      model.statusLine = model.workspaceRequiredMessage()
      return
    }
    selectedSessionPath = session.path
    renameDraft = session.name
    guard !actionLocked(model, .loadSessionTranscript) else { return }
    model.loadSessionTranscript(path: session.path)
  }

  private func renameCurrentSession() {
    guard selectedSession?.isActive == true else {
      model.statusLine = model.localizer.text(
        "Open this conversation before renaming it.",
        "请先打开此会话，然后再重命名。"
      )
      return
    }
    guard model.canManageSessions else {
      model.statusLine = model.workspaceRequiredMessage()
      return
    }
    model.renameActiveSession(name: renameDraft)
  }

  private func submitSessionMessage(_ session: DesktopSessionCatalogItem) {
    let trimmed = activeComposerText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    guard model.canManageSessions else {
      model.statusLine = model.workspaceRequiredMessage()
      return
    }
    guard session.isActive else {
      openConversation(session)
      model.statusLine = model.localizer.text(
        "Opened the selected conversation. Send again after it becomes current.",
        "已打开所选会话。它成为当前会话后再发送。"
      )
      return
    }
    guard model.workbenchIsConfigured else {
      model.statusLine = model.providerCredentialRequiredMessage()
      return
    }
    if model.runState == .running {
      model.sendRequestControl(trimmed, policy: requestPolicy)
      model.runningInputDraft = ""
      return
    }
    guard !model.runState.isActive else {
      model.statusLine = model.localizer.text(
        "Wait for the current run transition to finish before sending another message.",
        "请等待当前运行状态切换完成后再发送下一条消息。"
      )
      return
    }
    model.startRun()
    if model.runState.isActive || actionLocked(model, .startRun) {
      model.prompt = ""
    }
  }

  private func canSubmitSessionMessage(_ session: DesktopSessionCatalogItem) -> Bool {
    guard !activeComposerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          model.canManageSessions else { return false }
    if !session.isActive {
      return !openConversationDisabled(session)
    }
    guard model.providerCredentialIsConfigured else { return false }
    if model.runState == .running {
      return !actionLocked(model, .sendRequestControl)
    }
    if model.runState.isActive { return false }
    return model.canStartRun
  }

  private func timelineMessages(for session: DesktopSessionCatalogItem) -> [SessionTimelineMessage] {
    let messages = model.conversationTimelineMessages(for: session.path)
    if !messages.isEmpty { return messages }
    if let firstMessage = nonempty(session.firstMessage) {
      return [
        .init(
          id: "preview-\(session.path)",
          role: .user,
          eventType: model.localizer.text("Preview", "预览"),
          timestamp: session.modifiedAt,
          text: firstMessage
        ),
      ]
    }
    return []
  }

  private var activeComposerText: String {
    if model.runState == .running { return model.runningInputDraft }
    return model.prompt
  }

  private var activeComposerTextBinding: Binding<String> {
    Binding(
      get: { model.runState == .running ? model.runningInputDraft : model.prompt },
      set: { next in
        if model.runState == .running {
          model.runningInputDraft = next
        } else {
          model.prompt = next
        }
        sessionInputDraft = next
      }
    )
  }

  private func sessionName(_ session: DesktopSessionCatalogItem) -> String {
    session.name.isEmpty ? model.localizer.text("Untitled conversation", "未命名会话") : session.name
  }

  private func nonempty(_ value: String?) -> String? {
    guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
          !trimmed.isEmpty else { return nil }
    return trimmed
  }

  private func composerPlaceholder(_ session: DesktopSessionCatalogItem) -> String {
    if !session.isActive {
      return model.localizer.text("Open this conversation before continuing it.", "先打开此会话，然后继续输入。")
    }
    if !model.providerCredentialIsConfigured {
      return model.localizer.text(
        "Add a provider API key in Settings before sending.",
        "发送前请先在设置中添加服务商 API 密钥。"
      )
    }
    if model.runState == .running {
      return policyPlaceholder
    }
    return model.localizer.text("Message Canvast about this workspace.", "向 Canvast 发送关于此工作区的消息。")
  }

  private func composerDetail(_ session: DesktopSessionCatalogItem) -> String {
    if !session.isActive {
      return model.localizer.text("The first submit opens the conversation; the draft stays in place.", "首次提交会先打开会话，草稿会保留。")
    }
    if !model.providerCredentialIsConfigured {
      return model.providerCredentialRequiredMessage()
    }
    if model.runState == .running {
      return policyDetail
    }
    if model.runState.isActive {
      return model.localizer.text("A run is changing state. Sending is temporarily disabled.", "运行正在切换状态，暂时不能发送。")
    }
    return model.localizer.text("Submit starts the next run in the active conversation.", "提交会在当前会话中启动下一轮运行。")
  }

  private func submitTitle(_ session: DesktopSessionCatalogItem) -> String {
    if !session.isActive {
      return model.localizer.text("Open", "打开")
    }
    return model.localizer.text("Send", "发送")
  }

  private func submitSymbol(_ session: DesktopSessionCatalogItem) -> String {
    if !session.isActive { return "arrow.right.square" }
    return "paperplane.fill"
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
        "Explicitly affects primary work by pausing execution.",
        "会显式影响主工作，并暂停执行。"
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
}
