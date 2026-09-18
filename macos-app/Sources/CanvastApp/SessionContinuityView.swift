import SwiftUI
import CanvastAppCore

struct SessionContinuityView: View {
  @EnvironmentObject private var model: CanvastDesktopModel

  let availableWidth: CGFloat
  let automaticallyLoadRuntimeData: Bool

  init(availableWidth: CGFloat, automaticallyLoadRuntimeData: Bool = true) {
    self.availableWidth = availableWidth
    self.automaticallyLoadRuntimeData = automaticallyLoadRuntimeData
  }

  @State private var sessionSearch = ""
  @State private var selectedSessionPath = ""
  @State private var renameDraft = ""
  @State private var selectedResumeCandidateID = ""
  @State private var planNodeDraft = ""
  @State private var taskNodeDraft = ""
  @State private var retireReasonDraft = ""
  @State private var confirmRetirement = false
  @State private var confirmSessionDeletion = false
  @State private var didBootstrap = false
  @State private var lastDispatchResult: DesktopResumeActionResult?
  @State private var sessionInputDraft = ""

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      SessionWorkspaceView(
        availableWidth: availableWidth,
        sessionSearch: $sessionSearch,
        selectedSessionPath: $selectedSessionPath,
        renameDraft: $renameDraft,
        sessionInputDraft: $sessionInputDraft,
        confirmSessionDeletion: $confirmSessionDeletion
      )
      resumePanel
      rootExecutionPanel
      LifecycleInspectorCard(snapshot: latestContinuityAction)
    }
    .onAppear(perform: bootstrapIfNeeded)
    .onChange(of: model.sessionCatalog) { _ in synchronizeSessionSelection() }
    .onChange(of: model.sessionCreationResult) { result in
      if let result {
        selectedSessionPath = result.sessionPath
        renameDraft = result.sessionName
        refreshCatalogAfterMutation(true, transcriptPath: result.sessionPath)
      }
    }
    .onChange(of: model.sessionOpenResult) { result in
      if let result {
        selectedSessionPath = result.activeSessionPath
        renameDraft = result.activeSessionName
        refreshCatalogAfterMutation(true, transcriptPath: result.activeSessionPath)
      }
    }
    .onChange(of: model.sessionRenameResult) { result in
      refreshCatalogAfterMutation(result != nil)
    }
    .onChange(of: model.sessionDeleteReceipt) { receipt in
      refreshCatalogAfterMutation(receipt != nil)
    }
    .onChange(of: model.state.runtimeStatus.resume) { _ in synchronizeResumeSelection() }
    .onChange(of: model.resumeActionResult) { result in
      if let result, result.dispatchID != nil || result.claimToken != nil {
        lastDispatchResult = result
      }
      synchronizeResumeSelection()
    }
    .onChange(of: selectedResumeCandidateID) { _ in synchronizeBindingDrafts() }
    .confirmationDialog(
      model.localizer.text("Move this session to trash?", "要将此会话移到回收目录吗？"),
      isPresented: $confirmSessionDeletion,
      titleVisibility: .visible
    ) {
      Button(model.localizer.text("Move to Trash", "移到回收目录"), role: .destructive) {
        if let session = selectedSession { model.deleteSession(path: session.path) }
      }
      .disabled(selectedSession == nil || selectedSession?.isActive == true || actionLocked(model, .deleteSession))
      Button(model.localizer.dynamic("cancel"), role: .cancel) {}
    } message: {
      Text(model.localizer.text(
        "Deleting a session uses the shared move-to-trash flow. The active session cannot be deleted.",
        "删除会话会使用共享的移入回收目录流程。活动会话不能被删除。"
      ))
    }
  }

  private var resumePanel: some View {
    Panel(model.localizer.text("Resume interrupted work", "恢复中断工作"), systemImage: "arrow.clockwise.heart") {
      HStack(alignment: .center, spacing: 8) {
        StatusBadge(text: humanized(resumeSnapshot.state), color: resumeStateColor)
        StatusBadge(
          text: model.localizer.language == .english
            ? "\(resumeSnapshot.readyCandidateCount) \(model.localizer.dynamic("ready").lowercased())"
            : "\(resumeSnapshot.readyCandidateCount) 个就绪",
          color: resumeSnapshot.readyCandidateCount > 0 ? .green : .secondary
        )
        Spacer(minLength: 8)
        LifecycleStateBadge(snapshot: latestResumeAction)
      }
      Button { model.reconcileResumeCandidates() } label: {
        Label(model.localizer.text("Refresh Resume State", "刷新恢复状态"), systemImage: "arrow.triangle.2.circlepath")
      }
      .disabled(!model.workbenchIsConfigured || actionLocked(model, .reconcileResume))

      if resumeSnapshot.candidates.isEmpty {
        EmptyState(
          title: model.localizer.text("No interrupted work", "没有中断工作"),
          detail: model.localizer.text("No resumable runtime candidates are currently projected for this project.", "当前没有为此项目投影出可恢复的运行时候选项。"),
          systemImage: "checkmark.circle"
        )
      } else {
        candidateSelectionList

        if let candidate = selectedResumeCandidate {
          resumeCandidateDetails(candidate)
          Divider()
          resumeCandidateActions(candidate)
        } else {
          Text(model.localizer.text("Choose a candidate ID before inspecting, selecting, or claiming interrupted work.", "请先选择候选 ID，再检查、选择或认领中断工作。"))
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }

      if let result = lastDispatchResult {
        Divider()
        claimDispatchReceipt(result)
      }
    }
    .confirmationDialog(
      model.localizer.text("Retire this resume candidate?", "要退役这个恢复候选项吗？"),
      isPresented: $confirmRetirement,
      titleVisibility: .visible
    ) {
      Button(model.localizer.text("Retire Candidate", "退役候选项"), role: .destructive) {
        model.retireResumeCandidate(
          id: selectedResumeCandidateID, reason: retireReasonDraft
        )
      }
      .disabled(selectedResumeCandidate == nil || actionLocked(model, .retireResume))
      Button(model.localizer.dynamic("cancel"), role: .cancel) {}
    } message: {
      Text(model.localizer.text("Retirement removes this candidate from the resumable set.", "退役会将该候选项从可恢复集合中移除。"))
    }
  }

  private func resumeCandidateDetails(_ candidate: CanvastRuntimeResumeCandidate) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(candidate.title.isEmpty ? model.localizer.text("Untitled resume", "未命名恢复项") : candidate.title)
          .font(.headline)
          .fixedSize(horizontal: false, vertical: true)
        Spacer()
        StatusBadge(
          text: humanized(candidate.validation.availability),
          color: candidate.validation.availability == "ready" ? .green : .orange
        )
        StatusBadge(text: humanized(candidate.disposition), color: dispositionColor(candidate))
      }
      scrollableMonospacedText(
        candidate.id,
        font: .caption.monospaced(),
        foregroundStyle: .secondary
      )
      if !candidate.summary.isEmpty {
        Text(candidate.summary).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
      }
      detailRow(model.localizer.text("Request ID", "请求 ID"), candidate.requestID)
      if let sessionID = nonempty(candidate.sessionID) { detailRow(model.localizer.text("Session ID", "会话 ID"), sessionID) }
      if let owner = nonempty(candidate.continuationOwner) { detailRow(model.localizer.text("Continuation owner", "续接拥有者"), owner) }
      if let phase = nonempty(candidate.continuityPhase) { detailRow(model.localizer.text("Continuity phase", "续接阶段"), phase) }
      detailRow(model.localizer.text("Freshness", "新鲜度"), humanized(candidate.validation.freshness))
      validationGrid(candidate.validation)
      if !candidate.validation.issues.isEmpty {
        VStack(alignment: .leading, spacing: 4) {
          Text(model.localizer.text("Validation issues", "校验问题")).font(.caption.weight(.semibold)).foregroundStyle(.orange)
          ForEach(candidate.validation.issues, id: \.self) { issue in
            Label(issue, systemImage: "exclamationmark.triangle.fill")
              .font(.caption)
              .foregroundStyle(.orange)
          }
        }
      }
      VStack(alignment: .leading, spacing: 4) {
        Text(model.localizer.text("Available actions", "可用动作"))
          .font(.caption2)
          .foregroundStyle(.tertiary)
        scrollableMonospacedText(
          candidate.availableActions.joined(separator: ", "),
          font: .caption2.monospaced(),
          foregroundStyle: Color.secondary.opacity(0.72)
        )
      }
    }
  }

  private func validationGrid(_ validation: CanvastRuntimeResumeValidation) -> some View {
    LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 8)], spacing: 6) {
      validationItem(model.localizer.text("Project matches", "项目匹配"), validation.projectMatched)
      validationItem(model.localizer.text("No active-run block", "没有活动运行阻塞"), !validation.hasBlockingActiveRun)
      validationItem(model.localizer.text("Plan binding present", "已存在计划绑定"), !validation.missingPlanNode)
      validationItem(model.localizer.text("Task binding present", "已存在任务绑定"), !validation.missingTaskNode)
      validationItem(model.localizer.text("Parent link valid", "父链接有效"), validation.parentLinkValid)
    }
  }

  private func validationItem(_ title: String, _ valid: Bool) -> some View {
    Label(title, systemImage: valid ? "checkmark.circle.fill" : "xmark.circle.fill")
      .font(.caption)
      .foregroundStyle(valid ? Color.green : Color.orange)
      .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func resumeCandidateActions(_ candidate: CanvastRuntimeResumeCandidate) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      LazyVGrid(columns: [GridItem(.adaptive(minimum: 145), spacing: 8)], spacing: 8) {
        Button(model.localizer.text("Inspect Candidate", "检查候选项")) { model.inspectResumeCandidate(id: candidate.id) }
          .disabled(!allows(candidate, "inspect") || actionLocked(model, .inspectResume))
        Button(model.localizer.text("Select Candidate", "选择候选项")) { model.chooseResumeCandidate(id: candidate.id) }
          .disabled(!allows(candidate, "choose") || actionLocked(model, .chooseResume))
        Button(model.localizer.text("Resume and Dispatch", "恢复并派发")) {
          model.claimResumeCandidate(id: explicitClaimCandidateID)
        }
        .disabled(!canClaim(candidate))
      }
      if allows(candidate, "rebind") {
        Text(model.localizer.text("Repair Canvas binding", "修复画布绑定")).font(.caption.weight(.semibold))
        ViewThatFits(in: .horizontal) {
          HStack(spacing: 8) { bindingFields }
          VStack(alignment: .leading, spacing: 8) { bindingFields }
        }
        Button(model.localizer.text("Repair Binding", "修复绑定")) {
          model.rebindResumeCandidate(
            id: candidate.id, planNodeID: planNodeDraft, taskNodeID: taskNodeDraft
          )
        }
        .disabled(
          (planNodeDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && taskNodeDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            || actionLocked(model, .rebindResume)
        )
      }
      if allows(candidate, "retire") {
        TextField(model.localizer.text("Optional retirement reason", "可选退役原因"), text: $retireReasonDraft)
          .textFieldStyle(.roundedBorder)
        Button(model.localizer.text("Retire Candidate", "退役候选项"), role: .destructive) { confirmRetirement = true }
          .disabled(actionLocked(model, .retireResume))
      }
    }
    .buttonStyle(.bordered)
  }

  @ViewBuilder
  private var bindingFields: some View {
    TextField(model.localizer.text("Plan node ID", "计划节点 ID"), text: $planNodeDraft).textFieldStyle(.roundedBorder)
    TextField(model.localizer.text("Task node ID", "任务节点 ID"), text: $taskNodeDraft).textFieldStyle(.roundedBorder)
  }

  private func claimDispatchReceipt(_ result: DesktopResumeActionResult) -> some View {
    VStack(alignment: .leading, spacing: 7) {
      HStack {
        Label(model.localizer.text("Claim and dispatch receipt", "认领与派发回执"), systemImage: "paperplane.circle.fill")
          .font(.subheadline.weight(.semibold))
        Spacer()
        StatusBadge(
          text: humanized(result.continuationReceiptState ?? "accepted"),
          color: result.continuationReceiptState == "missing" ? .orange : .green
        )
      }
      if let candidateID = result.candidateID { detailRow(model.localizer.text("Candidate ID", "候选 ID"), candidateID) }
      if let requestID = result.requestID { detailRow(model.localizer.text("Request ID", "请求 ID"), requestID) }
      if let dispatchID = result.dispatchID { detailRow(model.localizer.text("Dispatch ID", "派发 ID"), dispatchID) }
      if let claimToken = result.claimToken { detailRow(model.localizer.text("Claim token", "认领令牌"), claimToken) }
      if let phase = result.continuityPhase { detailRow(model.localizer.text("Continuity phase", "续接阶段"), phase) }
      Text(result.message).font(.caption).foregroundStyle(.secondary)
    }
  }

  private var rootExecutionPanel: some View {
    Panel(model.localizer.text("Root execution summary", "根执行摘要"), systemImage: "point.topleft.down.curvedto.point.bottomright.up") {
      let root = model.rootStatusSummary
      HStack(spacing: 8) {
        StatusBadge(text: humanized(root.state.rawValue), color: rootStateColor(root.state))
        StatusBadge(text: humanized(root.settlement), color: root.isDone ? .green : .secondary)
        Spacer()
        if root.isDone {
          Label(model.localizer.text("Settled", "已结清"), systemImage: "checkmark.seal.fill")
            .font(.caption.weight(.semibold))
            .foregroundStyle(.green)
        }
      }
      Text(humanized(root.reason)).font(.caption).foregroundStyle(.secondary)
      LazyVGrid(columns: [GridItem(.adaptive(minimum: 130), spacing: 8)], spacing: 8) {
        rootCount(model.localizer.text("Working", "工作中"), root.workingCount, .blue)
        rootCount(model.localizer.text("Waiting", "等待中"), root.waitingCount, .orange)
        rootCount(model.localizer.text("Blocked", "阻塞"), root.blockedCount, .red)
      }
      if let requestID = root.rootRequestID { detailRow(model.localizer.text("Root request", "根请求"), requestID) }
      if let settledID = root.settledRequestID { detailRow(model.localizer.text("Settled request", "结清请求"), settledID) }
      if !root.updatedAt.isEmpty { detailRow(model.localizer.dynamic("updated"), root.updatedAt) }
    }
  }

  private func rootCount(_ title: String, _ count: Int, _ color: Color) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(title).font(.caption).foregroundStyle(.secondary)
      Text("\(count)").font(.title3.weight(.semibold)).foregroundStyle(count > 0 ? color : .primary)
    }
    .padding(8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(.quaternary.opacity(0.55), in: RoundedRectangle(cornerRadius: 7))
  }

  private func detailRow(_ label: String, _ value: String) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(label).font(.caption2).foregroundStyle(.secondary)
      scrollableMonospacedText(value)
    }
  }

  private var candidateSelectionList: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(model.localizer.text("Resume candidates", "恢复候选项"))
        .font(.caption.weight(.semibold))
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 8) {
          ForEach(resumeSnapshot.candidates) { candidate in
            Button { selectedResumeCandidateID = candidate.id } label: {
              resumeCandidateRow(candidate)
            }
            .buttonStyle(.plain)
          }
        }
      }
      .frame(maxHeight: 220)
    }
  }

  private func resumeCandidateRow(_ candidate: CanvastRuntimeResumeCandidate) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(candidate.title.isEmpty ? model.localizer.text("Untitled resume", "未命名恢复项") : candidate.title)
        .font(.subheadline.weight(.semibold))
        .fixedSize(horizontal: false, vertical: true)
      scrollableMonospacedText(candidate.id, font: .caption2.monospaced(), foregroundStyle: .secondary)
      if !candidate.summary.isEmpty {
        Text(candidate.summary)
          .font(.caption)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      ViewThatFits(in: .horizontal) {
        HStack(spacing: 8) {
          StatusBadge(
            text: humanized(candidate.validation.availability),
            color: candidate.validation.availability == "ready" ? .green : .orange
          )
          StatusBadge(text: humanized(candidate.disposition), color: dispositionColor(candidate))
        }
        VStack(alignment: .leading, spacing: 6) {
          StatusBadge(
            text: humanized(candidate.validation.availability),
            color: candidate.validation.availability == "ready" ? .green : .orange
          )
          StatusBadge(text: humanized(candidate.disposition), color: dispositionColor(candidate))
        }
      }
    }
    .padding(10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      selectedResumeCandidateID == candidate.id ? Color.accentColor.opacity(0.13) : Color.primary.opacity(0.035),
      in: RoundedRectangle(cornerRadius: 8)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 8)
        .stroke(selectedResumeCandidateID == candidate.id ? Color.accentColor.opacity(0.65) : Color.clear)
    )
  }

  private func scrollableMonospacedText(
    _ value: String,
    font: Font = .caption.monospaced(),
    foregroundStyle: Color = .primary
  ) -> some View {
    ScrollableMonospacedText(value: value, font: font, color: foregroundStyle)
  }

  private var selectedSession: DesktopSessionCatalogItem? {
    model.sessionCatalog?.sessions.first { $0.path == selectedSessionPath }
  }

  private var resumeSnapshot: CanvastRuntimeResumeSnapshot {
    model.visibleResumeSnapshot
  }

  private var selectedResumeCandidate: CanvastRuntimeResumeCandidate? {
    resumeSnapshot.candidates.first { $0.id == selectedResumeCandidateID }
  }

  private var explicitClaimCandidateID: String? {
    let id = selectedResumeCandidateID.trimmingCharacters(in: .whitespacesAndNewlines)
    return id.isEmpty ? nil : id
  }

  private var latestSessionAction: DesktopActionSnapshot? {
    latestAction([.startNewSession, .loadSessionCatalog, .openSession, .renameSession, .deleteSession, .loadSessionTranscript])
  }

  private var latestResumeAction: DesktopActionSnapshot? {
    latestAction([.inspectResume, .chooseResume, .claimResume, .rebindResume, .retireResume, .reconcileResume])
  }

  private var latestContinuityAction: DesktopActionSnapshot? {
    [latestSessionAction, latestResumeAction].compactMap { $0 }.max { $0.updatedAt < $1.updatedAt }
  }

  private func latestAction(_ ids: [DesktopUIActionID]) -> DesktopActionSnapshot? {
    ids.compactMap { model.actionSnapshot($0) }.max { $0.updatedAt < $1.updatedAt }
  }

  private func bootstrapIfNeeded() {
    guard !didBootstrap else { return }
    didBootstrap = true
    synchronizeSessionSelection()
    synchronizeResumeSelection()
    guard automaticallyLoadRuntimeData else { return }
    if model.sessionCatalog == nil, !sessionControlIsLocked {
      model.loadSessionCatalog()
    }
    if model.workbenchIsConfigured, !hasResumeProjection, !actionLocked(model, .reconcileResume) {
      model.reconcileResumeCandidates()
    }
    if let result = model.resumeActionResult, result.dispatchID != nil || result.claimToken != nil {
      lastDispatchResult = result
    }
  }

  private func refreshCatalogAfterMutation(_ succeeded: Bool, transcriptPath: String? = nil) {
    guard succeeded else { return }
    Task { @MainActor in
      guard await waitForSessionControlUnlock() else { return }
      if !sessionControlIsLocked {
        model.loadSessionCatalog()
      }
      guard let transcriptPath = transcriptPath?.trimmingCharacters(in: .whitespacesAndNewlines),
            !transcriptPath.isEmpty else { return }
      guard await waitForSessionControlUnlock(),
            !model.isActionLocked(.loadSessionTranscript) else { return }
      model.loadSessionTranscript(path: transcriptPath)
    }
  }

  @MainActor
  private func waitForSessionControlUnlock() async -> Bool {
    for _ in 0..<8 {
      await Task.yield()
      if !sessionControlIsLocked { return true }
      try? await Task.sleep(nanoseconds: 120_000_000)
    }
    return false
  }

  @MainActor
  private var sessionControlIsLocked: Bool {
    [
      DesktopUIActionID.startNewSession,
      .loadSessionCatalog,
      .openSession,
      .renameSession,
      .deleteSession,
      .loadSessionTranscript,
    ].contains { model.isActionLocked($0) }
  }

  private func synchronizeSessionSelection() {
    guard let catalog = model.sessionCatalog else { return }
    let selectionStillExists = catalog.sessions.contains { $0.path == selectedSessionPath }
    if !selectionStillExists {
      selectedSessionPath = catalog.activeSessionPath.isEmpty
        ? (catalog.sessions.first?.path ?? "")
        : catalog.activeSessionPath
    }
    if let selectedSession,
       selectedSessionPath == selectedSession.path {
      renameDraft = selectedSession.name
    } else if let active = catalog.activeSession {
      renameDraft = active.name
    }
  }

  private func synchronizeResumeSelection() {
    let candidates = resumeSnapshot.candidates
    let priorSelection = selectedResumeCandidateID
    if candidates.contains(where: { $0.id == selectedResumeCandidateID }) {
      return
    }
    if let selectedID = resumeSnapshot.selectedCandidateID,
       candidates.contains(where: { $0.id == selectedID }) {
      selectedResumeCandidateID = selectedID
    } else if candidates.count == 1 {
      selectedResumeCandidateID = candidates[0].id
    } else {
      selectedResumeCandidateID = ""
    }
    if priorSelection != selectedResumeCandidateID { synchronizeBindingDrafts() }
  }

  private func synchronizeBindingDrafts() {
    planNodeDraft = selectedResumeCandidate?.binding?.planNodeID ?? ""
    taskNodeDraft = selectedResumeCandidate?.binding?.taskNodeID ?? ""
    retireReasonDraft = ""
  }

  private var hasResumeProjection: Bool {
    let projection = model.visibleResumeSnapshot
    return model.resumeActionResult != nil
      || projection.state != "idle"
      || !projection.updatedAt.isEmpty
      || projection.projectID != nil
      || !projection.candidates.isEmpty
  }

  private func allows(_ candidate: CanvastRuntimeResumeCandidate, _ action: String) -> Bool {
    candidate.availableActions.contains(action)
  }

  private func canClaim(_ candidate: CanvastRuntimeResumeCandidate) -> Bool {
    guard allows(candidate, "claim"), !actionLocked(model, .claimResume) else { return false }
    if resumeSnapshot.candidates.count > 1 {
      return !selectedResumeCandidateID.isEmpty && selectedResumeCandidateID == candidate.id
    }
    return resumeSnapshot.readyCandidateCount == 1
  }

  private func nonempty(_ value: String?) -> String? {
    guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
          !trimmed.isEmpty else { return nil }
    return trimmed
  }

  private var resumeStateColor: Color {
    switch resumeSnapshot.state {
    case "ready": return .green
    case "claimed", "running": return .blue
    case "attention_required": return .orange
    default: return .secondary
    }
  }

  private func dispositionColor(_ candidate: CanvastRuntimeResumeCandidate) -> Color {
    switch candidate.disposition {
    case "running", "claimed", "selected": return .blue
    case "completed": return .green
    case "retired": return .secondary
    default: return .orange
    }
  }

  private func rootStateColor(_ state: CanvastRootExecutionState) -> Color {
    switch state {
    case .idle: return .secondary
    case .working: return .blue
    case .waiting: return .orange
    case .blocked: return .red
    case .done: return .green
    }
  }
}
