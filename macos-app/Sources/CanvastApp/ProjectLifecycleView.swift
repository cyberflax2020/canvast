import SwiftUI
import CanvastAppCore

struct ProjectLifecycleView: View {
  @EnvironmentObject private var model: CanvastDesktopModel

  let availableWidth: CGFloat

  @State private var targetPathDraft = ""
  @State private var replacementPathDraft = ""
  @State private var selectedOperation = ProjectLifecycleOperation.open
  @State private var approvalAcknowledged = false
  @State private var confirmProjectRetirement = false

  var body: some View {
    Panel(model.localizer.text("Project lifecycle", "项目生命周期"), systemImage: "arrow.triangle.branch") {
      VStack(alignment: .leading, spacing: 12) {
        pathInputSection
        operationPicker
        lifecycleControls
        if let snapshot = latestLifecycleAction {
          LifecycleStateBadge(snapshot: snapshot)
        } else {
          ActionStateBadge(state: model.actionState)
        }
        if let receipt = model.projectPreflightReceipt {
          Divider()
          preflightSection(receipt)
        }
        if let receipt = model.projectLifecycleReceipt {
          Divider()
          lifecycleReceiptSection(receipt)
        }
        Divider()
        Text(model.localizer.text(
          "Project Safety Check presents dirty, untracked, and conflict changes before shared project create, project open, and project reinitialize actions can proceed. When approval is required, you must acknowledge the reviewed revision explicitly before Canvast sends the mutation.",
          "Project Safety Check 会先展示脏改动、未跟踪文件和冲突文件，然后共享的项目创建、项目打开与项目重初始化动作才能继续。当需要批准时，你必须在 Canvast 发送变更前显式确认已审阅该修订版本。"
        ))
          .font(.caption)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .onAppear(perform: bootstrapDrafts)
    .onChange(of: selectedOperation) { _ in
      approvalAcknowledged = false
    }
    .onChange(of: model.projectPreflightReceipt?.revision) { _ in
      approvalAcknowledged = false
    }
    .onChange(of: model.projectLifecycleReceipt?.activeProjectRoot) { activeProjectRoot in
      guard let activeProjectRoot,
            !activeProjectRoot.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
      targetPathDraft = activeProjectRoot
      if selectedOperation == .retire {
        replacementPathDraft = ""
      }
      approvalAcknowledged = false
    }
    .confirmationDialog(
      model.localizer.text("Retire this project from Canvast?", "要从 Canvast 中退休此项目吗？"),
      isPresented: $confirmProjectRetirement,
      titleVisibility: .visible
    ) {
      Button(model.localizer.text("Retire Project", "退休项目"), role: .destructive) {
        runConfirmedRetirement()
      }
    } message: {
      Text(model.localizer.text(
        "Canvast will retire only its managed project state and sessions. The project workspace and source files will not be deleted.",
        "Canvast 只会退休其管理的项目状态和会话，不会删除项目工作区或源文件。"
      ))
    }
  }

  private var pathInputSection: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(model.localizer.text("Target project path", "目标项目路径"))
        .font(.caption.weight(.semibold))
      TextField(model.localizer.text("Project path", "项目路径"), text: $targetPathDraft)
        .textFieldStyle(.roundedBorder)
      if selectedOperation == .retire && isRetiringActiveProject {
        Text(model.localizer.text("Replacement project path", "替代项目路径"))
          .font(.caption.weight(.semibold))
        TextField(
          model.localizer.text("Existing project to activate first", "先激活的现有项目"),
          text: $replacementPathDraft
        )
        .textFieldStyle(.roundedBorder)
      }
      ViewThatFits(in: .horizontal) {
        HStack(spacing: 8) { pathButtons }
        VStack(alignment: .leading, spacing: 8) { pathButtons }
      }
    }
  }

  @ViewBuilder
  private var pathButtons: some View {
    Button {
      if let path = model.chooseProjectDirectoryForLifecycle(
        message: model.localizer.text("Choose a project directory for shared lifecycle actions", "选择用于共享生命周期动作的项目目录")
      ) {
        targetPathDraft = path
      }
    } label: {
      Label(model.localizer.text("Choose Directory", "选择目录"), systemImage: "folder.badge.plus")
    }
    Button { model.refresh() } label: {
      Label(model.localizer.text("Reload Persisted State", "重新加载持久化状态"), systemImage: "tray.and.arrow.down")
    }
    .disabled(actionLocked(model, .refreshWorkspace))
  }

  private var operationPicker: some View {
    Picker(model.localizer.text("Operation", "操作"), selection: $selectedOperation) {
      ForEach(ProjectLifecycleOperation.allCases) { operation in
        Text(operation.title(model.localizer)).tag(operation)
      }
    }
    .pickerStyle(.segmented)
  }

  private var lifecycleControls: some View {
    VStack(alignment: .leading, spacing: 8) {
      ViewThatFits(in: .horizontal) {
        HStack(spacing: 8) { primaryButtons }
        VStack(alignment: .leading, spacing: 8) { primaryButtons }
      }
      if requiresAcknowledgement {
        Toggle(
          model.localizer.text(
            "I reviewed the Project Safety Check details and approve this exact revision before continuing.",
            "我已审阅 Project Safety Check 详情，并批准在继续前使用这个精确修订版本。"
          ),
          isOn: $approvalAcknowledged
        )
        .toggleStyle(.checkbox)
      }
      Button(action: requestSelectedMutation) {
        Label(selectedOperation.commitTitle(model.localizer), systemImage: selectedOperation.commitSymbol)
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      .disabled(!canRunSelectedMutation)
    }
    .buttonStyle(.bordered)
  }

  @ViewBuilder
  private var primaryButtons: some View {
    Button(action: runPreflight) {
      Label(model.localizer.text("Run Project Safety Check", "运行 Project Safety Check"), systemImage: "checklist.unchecked")
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .disabled(trimmedTargetPath.isEmpty || actionLocked(model, .runProjectPreflight))
    Button {
      targetPathDraft = model.projectRoot.path
      selectedOperation = .reinitialize
    } label: {
      Label(model.localizer.text("Use Active Project", "使用当前项目"), systemImage: "scope")
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private func preflightSection(_ receipt: DesktopProjectPreflightReceipt) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text(model.localizer.text("Project Safety Check", "Project Safety Check"))
          .font(.subheadline.weight(.semibold))
        Spacer()
        StatusBadge(
          text: preflightStatusText(receipt),
          color: receipt.canProceed ? .green : (receipt.canProceedWithApproval ? .orange : .red)
        )
      }
      detailRow(model.localizer.text("Operation", "操作"), humanized(receipt.operation, localizer: model.localizer))
      detailRow(model.localizer.text("Revision", "修订版本"), receipt.revision)
      detailRow(model.localizer.text("Current project root", "当前项目根目录"), receipt.currentProjectRoot)
      detailRow(model.localizer.text("Target project root", "目标项目根目录"), receipt.target.canonicalPath)
      if let replacement = receipt.replacement {
        detailRow(model.localizer.text("Replacement project root", "替代项目根目录"), replacement.canonicalPath)
      }
      detailRow(model.localizer.text("Workspace root", "工作区根目录"), receipt.workspaceRoot)
      gitStateSection(title: model.localizer.text("Current project git state", "当前项目 Git 状态"), state: receipt.current)
      gitStateSection(title: model.localizer.text("Target project git state", "目标项目 Git 状态"), state: receipt.target.git)
      if !receipt.issues.isEmpty {
        VStack(alignment: .leading, spacing: 6) {
          Text(model.localizer.text("Issues that require review", "需要审阅的问题"))
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
          ForEach(receipt.issues) { issue in
            VStack(alignment: .leading, spacing: 2) {
              Text("[\(issue.scope)] \(issue.code)")
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
              Text(issue.message)
                .font(.caption)
                .fixedSize(horizontal: false, vertical: true)
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.55), in: RoundedRectangle(cornerRadius: 7))
          }
        }
      }
      Text(receipt.message)
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private func gitStateSection(title: String, state: DesktopGitPreflightState) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title)
        .font(.caption.weight(.semibold))
      HStack(spacing: 8) {
        StatusBadge(text: state.available ? model.localizer.text("Git available", "Git 可用") : model.localizer.text("Git unavailable", "Git 不可用"), color: state.available ? .green : .orange)
        StatusBadge(text: state.repositoryPresent ? model.localizer.text("Repository detected", "已检测仓库") : model.localizer.text("No repository", "没有仓库"), color: state.repositoryPresent ? .blue : .secondary)
        StatusBadge(text: state.hasChanges ? model.localizer.text("Changes detected", "检测到变更") : model.localizer.text("Clean", "干净"), color: state.hasChanges ? .orange : .green)
      }
      detailRow(model.localizer.text("HEAD", "HEAD"), state.head)
      detailRow(
        model.localizer.text("Counts", "计数"),
        model.localizer.text(
          "tracked \(state.counts.tracked), untracked \(state.counts.untracked), conflicts \(state.counts.conflicts)",
          "已跟踪 \(state.counts.tracked)，未跟踪 \(state.counts.untracked)，冲突 \(state.counts.conflicts)"
        )
      )
      if !state.paths.tracked.isEmpty {
        detailRow(model.localizer.text("Tracked paths", "已跟踪路径"), state.paths.tracked.joined(separator: "\n"))
      }
      if !state.paths.untracked.isEmpty {
        detailRow(model.localizer.text("Untracked paths", "未跟踪路径"), state.paths.untracked.joined(separator: "\n"))
      }
      if !state.paths.conflicts.isEmpty {
        detailRow(model.localizer.text("Conflict paths", "冲突路径"), state.paths.conflicts.joined(separator: "\n"))
      }
      if let errorMessage = state.errorMessage, !errorMessage.isEmpty {
        detailRow(model.localizer.text("Git error", "Git 错误"), errorMessage)
      }
    }
  }

  private func lifecycleReceiptSection(_ receipt: DesktopProjectLifecycleReceipt) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text(model.localizer.text("Project lifecycle receipt", "项目生命周期回执"))
          .font(.subheadline.weight(.semibold))
        Spacer()
        StatusBadge(text: humanized(receipt.operation, localizer: model.localizer), color: .green)
      }
      detailRow(model.localizer.text("Action kind", "动作类型"), receipt.actionKind)
      detailRow(model.localizer.text("Input path", "输入路径"), receipt.inputPath)
      detailRow(model.localizer.text("Target project root", "目标项目根目录"), receipt.targetProjectRoot)
      detailRow(model.localizer.text("Active project root", "活动项目根目录"), receipt.activeProjectRoot)
      detailRow(model.localizer.text("Preflight revision", "预检修订版本"), receipt.preflightRevision)
      if let sessionPath = receipt.sessionPath {
        detailRow(model.localizer.text("Session path", "会话路径"), sessionPath)
      }
      if let sessionID = receipt.sessionID {
        detailRow(model.localizer.text("Session ID", "会话 ID"), sessionID)
      }
      if let preservedStatePath = receipt.preservedStatePath {
        detailRow(model.localizer.text("Preserved state path", "保留状态路径"), preservedStatePath)
      }
      if let retiredStatePath = receipt.retiredStatePath {
        detailRow(model.localizer.text("Retired Canvast state", "已退休的 Canvast 状态"), retiredStatePath)
      }
      Text(receipt.message)
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private func detailRow(_ label: String, _ value: String) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(label).font(.caption2).foregroundStyle(.secondary)
      ScrollableMonospacedText(value: value)
    }
  }

  private func bootstrapDrafts() {
    if targetPathDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      targetPathDraft = model.projectRoot.path
    }
  }

  private func runPreflight() {
    guard !trimmedTargetPath.isEmpty else { return }
    model.runProjectPreflight(
      path: trimmedTargetPath,
      replacementPath: selectedOperation == .retire ? trimmedReplacementPath : nil,
      operation: selectedOperation.rawValue
    )
  }

  private func requestSelectedMutation() {
    guard !trimmedTargetPath.isEmpty else { return }
    if selectedOperation == .retire {
      confirmProjectRetirement = true
      return
    }
    let revision = matchingPreflight?.revision
    switch selectedOperation {
    case .create:
      model.createProjectSession(
        path: trimmedTargetPath,
        expectedRevision: revision,
        approvedAcknowledgement: approvalAcknowledged
      )
    case .open:
      model.openProjectSession(
        path: trimmedTargetPath,
        expectedRevision: revision,
        approvedAcknowledgement: approvalAcknowledged
      )
    case .reinitialize:
      model.reinitializeProject(
        path: trimmedTargetPath,
        expectedRevision: revision,
        approvedAcknowledgement: approvalAcknowledged
      )
    case .retire:
      break
    }
  }

  private func runConfirmedRetirement() {
    model.retireProject(
      path: trimmedTargetPath,
      replacementPath: trimmedReplacementPath,
      expectedRevision: matchingPreflight?.revision,
      approvedAcknowledgement: approvalAcknowledged
    )
  }

  private var trimmedTargetPath: String {
    targetPathDraft.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private var trimmedReplacementPath: String? {
    let value = replacementPathDraft.trimmingCharacters(in: .whitespacesAndNewlines)
    return value.isEmpty ? nil : value
  }

  private var isRetiringActiveProject: Bool {
    URL(fileURLWithPath: trimmedTargetPath).standardizedFileURL
      == model.projectRoot.standardizedFileURL
  }

  private var matchingPreflight: DesktopProjectPreflightReceipt? {
    guard let receipt = model.projectPreflightReceipt else { return nil }
    guard receipt.operation == selectedOperation.rawValue else { return nil }
    if selectedOperation == .retire {
      let receiptReplacement = receipt.replacement?.canonicalPath
        ?? receipt.replacement?.resolvedPath
        ?? receipt.replacement?.inputPath
      guard receiptReplacement == trimmedReplacementPath else { return nil }
    }
    return receipt
  }

  private var requiresAcknowledgement: Bool {
    matchingPreflight?.requiresApproval == true
  }

  private var canRunSelectedMutation: Bool {
    guard let receipt = matchingPreflight else { return false }
    guard !trimmedTargetPath.isEmpty else { return false }
    guard receipt.target.canonicalPath == trimmedTargetPath || receipt.target.resolvedPath == trimmedTargetPath || receipt.target.inputPath == trimmedTargetPath else {
      return false
    }
    guard receipt.canProceedWithApproval else { return false }
    if receipt.requiresApproval && !approvalAcknowledged { return false }
    switch selectedOperation {
    case .create:
      return !actionLocked(model, .createProjectSession)
    case .open:
      return !actionLocked(model, .openProjectSession)
    case .reinitialize:
      return !actionLocked(model, .reinitializeProject)
    case .retire:
      if isRetiringActiveProject && trimmedReplacementPath == nil { return false }
      return approvalAcknowledged && !actionLocked(model, .retireProject)
    }
  }

  private var latestLifecycleAction: DesktopActionSnapshot? {
    [
      model.actionSnapshot(.runProjectPreflight),
      model.actionSnapshot(.createProjectSession),
      model.actionSnapshot(.openProjectSession),
      model.actionSnapshot(.reinitializeProject),
      model.actionSnapshot(.retireProject),
    ].compactMap { $0 }.max { $0.updatedAt < $1.updatedAt }
  }

  private func preflightStatusText(_ receipt: DesktopProjectPreflightReceipt) -> String {
    if receipt.canProceed {
      return model.localizer.text("Ready", "可继续")
    }
    if receipt.canProceedWithApproval {
      return model.localizer.text("Approval required", "需要确认")
    }
    return model.localizer.text("Blocked", "已阻止")
  }
}

private enum ProjectLifecycleOperation: String, CaseIterable, Identifiable {
  case create
  case open
  case reinitialize
  case retire

  var id: String { rawValue }

  func title(_ localizer: CanvastLocalizer) -> String {
    switch self {
    case .create:
      return localizer.text("Create", "创建")
    case .open:
      return localizer.text("Open", "打开")
    case .reinitialize:
      return localizer.text("Reinitialize", "重初始化")
    case .retire:
      return localizer.text("Retire", "退休")
    }
  }

  func commitTitle(_ localizer: CanvastLocalizer) -> String {
    switch self {
    case .create:
      return localizer.text("Create Project Session", "创建项目会话")
    case .open:
      return localizer.text("Open Project Session", "打开项目会话")
    case .reinitialize:
      return localizer.text("Reinitialize Project", "重初始化项目")
    case .retire:
      return localizer.text("Retire Project", "退休项目")
    }
  }

  var commitSymbol: String {
    switch self {
    case .create:
      return "plus.rectangle.on.rectangle"
    case .open:
      return "arrow.right.square"
    case .reinitialize:
      return "arrow.clockwise.circle"
    case .retire:
      return "archivebox"
    }
  }
}

struct ProjectSessionSummaryCard: View {
  @EnvironmentObject private var model: CanvastDesktopModel

  var body: some View {
    Panel(model.localizer.text("Project summary", "项目摘要"), systemImage: "folder") {
      VStack(alignment: .leading, spacing: 7) {
        Text(model.localizer.dynamic("project"))
          .font(.caption)
          .foregroundStyle(.secondary)
        Text(model.projectRoot.lastPathComponent)
          .font(.title3.weight(.semibold))
          .fixedSize(horizontal: false, vertical: true)
        ScrollView(.horizontal) {
          Text(model.projectDisplayPath)
            .font(.caption.monospaced())
            .foregroundStyle(.secondary)
            .textSelection(.enabled)
            .fixedSize(horizontal: true, vertical: false)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}
