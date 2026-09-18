import SwiftUI
import CanvastAppCore

struct SafetyPermissionsView: View {
  @EnvironmentObject private var model: CanvastDesktopModel
  @State private var riskFilter = "All"
  @State private var decisionFilter = "All"
  @State private var searchText = ""
  @State private var sandboxProfile = "workspace-write"
  @State private var grantKind = SandboxGrantInputKind.path
  @State private var grantValue = ""
  @State private var grantAccess = "read"
  @State private var grantScope = "session"
  @State private var grantReason = ""
  @State private var confirmFullAccess = false

  private let riskOptions = ["All", "Low", "Medium", "High", "Critical"]
  private let decisionOptions = ["All", "Allow", "Deny", "Ask"]

  private var reviews: [CanvastApprovalReview] {
    let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return model.state.runtimeStatus.approvalReviews.reversed().filter { review in
      if riskFilter != "All" && review.risk.caseInsensitiveCompare(riskFilter) != .orderedSame { return false }
      if decisionFilter != "All" && !review.decision.lowercased().contains(decisionFilter.lowercased()) { return false }
      if query.isEmpty { return true }
      return [review.tool, review.decision, review.risk, review.authorization, review.rationale, review.inputSummary ?? ""]
        .joined(separator: " " ).lowercased().contains(query)
    }
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        WorkspaceTitle(
          workspace: .safetyPermissions,
          trailing: AnyView(
            Button { model.refresh() } label: { Label(model.localizer.dynamic("refresh"), systemImage: "arrow.clockwise") }
              .disabled(actionLocked(model, .refreshWorkspace))
          )
        )
        executionBoundary
        sandboxControls
        SandboxGrantManagementView(
          grants: model.sandboxStatus?.grants ?? [],
          hasInspectedSandbox: model.sandboxStatus != nil,
          revision: model.sandboxStatus?.revision,
          revocationReceipt: model.sandboxRevocationReceipt,
          isRevoking: model.isActionLocked(.revokeSandboxAccess),
          revoke: model.revokeSandboxGrant
        )
        filterBar
        ViewThatFits(in: .horizontal) {
          HStack(alignment: .top, spacing: 14) {
            approvalHistory
              .frame(minWidth: 420)
            safetyControls
              .frame(width: 310)
          }
          VStack(alignment: .leading, spacing: 14) {
            approvalHistory
            safetyControls
          }
        }
      }
      .padding(18)
    }
    .background(Color(nsColor: .windowBackgroundColor))
    .onChange(of: model.sandboxStatus?.config.profile) { profile in
      if let profile, !profile.isEmpty { sandboxProfile = profile }
    }
  }

  private var executionBoundary: some View {
    AdaptiveMetricGrid {
      MetricCard(
        title: model.localizer.text("Runtime boundary", "运行边界"),
        value: model.localizer.text("Safe run", "安全运行"),
        detail: model.localizer.text("App runs use the project launcher through bounded safe-run.", "App 运行通过有界 safe-run 使用项目启动器。"), color: .green
      )
      MetricCard(
        title: model.localizer.text("Run timeout", "运行超时"), value: "\(model.timeoutSeconds)s",
        detail: model.localizer.text("configurable in Run Console", "可在运行控制台中配置"), color: .blue
      )
      MetricCard(
        title: model.localizer.text("Permission reviews", "权限审查"), value: "\(model.state.runtimeStatus.approvalReviews.count)",
        detail: model.localizer.text("persisted decisions in runtime status", "运行时状态中的持久化决策"), color: .purple
      )
      MetricCard(
        title: model.localizer.text("Current run", "当前运行"), value: model.runState.label,
        detail: model.runState.isActive
          ? model.localizer.text("execution is active", "执行进行中")
          : model.localizer.text("no active child process", "没有活动子进程"), color: model.runState.color
      )
    }
  }

  private var filterBar: some View {
    ViewThatFits(in: .horizontal) {
      HStack(spacing: 10) {
        approvalSearchField
          .frame(minWidth: 240, maxWidth: 360)
        riskPicker
          .frame(width: 150)
        decisionPicker
          .frame(width: 160)
        Spacer(minLength: 0)
      }
      VStack(alignment: .leading, spacing: 8) {
        approvalSearchField
        HStack(spacing: 10) {
          riskPicker
          decisionPicker
        }
      }
    }
  }

  private var approvalSearchField: some View {
    TextField(model.localizer.text("Search tool, rationale, or input", "搜索工具、理由或输入"), text: $searchText)
      .textFieldStyle(.roundedBorder)
  }

  private var riskPicker: some View {
    Picker(model.localizer.text("Risk", "风险"), selection: $riskFilter) {
      ForEach(riskOptions, id: \.self) { Text(humanized($0, localizer: model.localizer)).tag($0) }
    }
  }

  private var decisionPicker: some View {
    Picker(model.localizer.text("Decision", "决策"), selection: $decisionFilter) {
      ForEach(decisionOptions, id: \.self) { Text(humanized($0, localizer: model.localizer)).tag($0) }
    }
  }

  private var approvalHistory: some View {
    Panel(model.localizer.text("Permission decision history", "权限决策历史"), systemImage: "list.bullet.clipboard") {
      if reviews.isEmpty {
        EmptyState(
          title: model.localizer.text("No matching permission decisions", "没有匹配的权限决策"),
          detail: model.localizer.text("Tool permission reviews are shown here when runtime state records them.", "运行时状态记录工具权限审查后会显示在这里。"),
          systemImage: "checkmark.shield"
        )
      } else {
        LazyVStack(alignment: .leading, spacing: 10) {
          ForEach(reviews) { review in
            approvalRow(review)
            if review.id != reviews.last?.id { Divider() }
          }
        }
      }
    }
  }

  private var sandboxControls: some View {
    Panel(model.localizer.text("Sandbox controls", "沙箱控制"), systemImage: "lock.shield") {
      ViewThatFits(in: .horizontal) {
        HStack(alignment: .top, spacing: 18) {
          sandboxStatusColumn
            .frame(minWidth: 220, maxWidth: .infinity, alignment: .topLeading)
          Divider()
          sandboxProfileColumn
            .frame(minWidth: 230, maxWidth: .infinity, alignment: .topLeading)
          Divider()
          sandboxGrantColumn
            .frame(minWidth: 330, maxWidth: .infinity, alignment: .topLeading)
        }
        VStack(alignment: .leading, spacing: 14) {
          sandboxStatusColumn
          Divider()
          sandboxProfileColumn
          Divider()
          sandboxGrantColumn
        }
      }
    }
    .confirmationDialog(
      model.localizer.text("Request full-access sandbox?", "请求完全访问沙箱？"),
      isPresented: $confirmFullAccess,
      titleVisibility: .visible
    ) {
      Button(model.localizer.text("Request Full Access", "请求完全访问"), role: .destructive) { model.setSandboxProfile("full-access") }
        .disabled(actionLocked(model, .setSandboxProfile))
      Button(model.localizer.dynamic("cancel"), role: .cancel) {}
    } message: {
      Text(model.localizer.text("Full access disables shell sandboxing for the session and may be rejected by unattended policy.", "完全访问会禁用当前会话的 shell 沙箱，并且可能被无人值守策略拒绝。"))
    }
  }

  private var sandboxStatusColumn: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text(model.localizer.text("Current status", "当前状态")).font(.subheadline.weight(.semibold))
        Spacer()
        Button { model.inspectSandbox() } label: { Label(model.localizer.dynamic("inspect"), systemImage: "arrow.clockwise") }
          .disabled(actionLocked(model, .inspectSandbox))
      }
      if let status = model.sandboxStatus {
        policyRow(model.localizer.dynamic("profile"), humanized(status.config.profile, localizer: model.localizer))
        policyRow(model.localizer.text("Permission mode", "权限模式"), status.config.permissionMode.map { humanized($0, localizer: model.localizer) } ?? model.localizer.dynamic("not_recorded"))
        policyRow(model.localizer.text("Unattended", "无人值守"), display(status.config.unattended))
        policyRow(model.localizer.text("Network", "网络"), status.config.network.map { humanized($0, localizer: model.localizer) } ?? model.localizer.dynamic("not_recorded"))
        policyRow(model.localizer.text("Writable roots", "可写根路径"), "\(status.config.writableRoots.count)")
        policyRow(model.localizer.text("Grants", "授权"), "\(status.grants.count)")
      } else {
        Text(model.localizer.text("Select Inspect to load the live sandbox profile and grants.", "选择“检查”以加载实时沙箱配置和授权。"))
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
  }

  private var sandboxProfileColumn: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(model.localizer.text("Session profile", "会话配置"))
          .font(.subheadline.weight(.semibold))
        Spacer(minLength: 8)
        Picker(model.localizer.dynamic("profile"), selection: $sandboxProfile) {
          Text(model.localizer.dynamic("read_only")).tag("read-only")
          Text(model.localizer.dynamic("workspace_write")).tag("workspace-write")
          Text(model.localizer.dynamic("full_access")).tag("full-access")
        }
        .labelsHidden()
        .frame(width: 170)
      }
      Button(model.localizer.text("Apply Profile", "应用配置")) {
        if sandboxProfile == "full-access" { confirmFullAccess = true }
        else { model.setSandboxProfile(sandboxProfile) }
      }
      .buttonStyle(.borderedProminent)
      .disabled(actionLocked(model, .setSandboxProfile) || sandboxProfile == model.sandboxStatus?.config.profile)
      Text(model.localizer.text("Full Access requires explicit confirmation and may be unavailable for unattended App runs.", "完全访问需要显式确认，并且在无人值守 App 运行中可能不可用。"))
        .font(.caption2)
        .foregroundStyle(.secondary)
    }
  }

  private var sandboxGrantColumn: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(model.localizer.text("Explicit grant", "显式授权")).font(.subheadline.weight(.semibold))
      Picker(model.localizer.text("Target", "目标"), selection: $grantKind) {
        ForEach(SandboxGrantInputKind.allCases) { kind in Text(kind.title).tag(kind) }
      }
      .pickerStyle(.segmented)
      ViewThatFits(in: .horizontal) {
        HStack(spacing: 8) {
          grantValueField
            .frame(minWidth: 220)
          grantPickerRow
        }
        VStack(alignment: .leading, spacing: 8) {
          grantValueField
          grantPickerRow
        }
      }
      TextField(model.localizer.text("Reason (optional)", "原因（可选）"), text: $grantReason).textFieldStyle(.roundedBorder)
      HStack {
        Button(model.localizer.text("Grant Explicit Access", "授予显式访问")) { grantSandboxAccess() }
          .buttonStyle(.borderedProminent)
          .disabled(grantValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || actionLocked(model, .grantSandboxAccess))
        Text(model.localizer.text("Grants do not bypass hard-danger blocks.", "授权不会绕过硬性危险阻断。"))
          .font(.caption2)
          .foregroundStyle(.secondary)
      }
    }
  }

  private var grantValueField: some View {
    TextField(
      grantKind == .command
        ? model.localizer.text("Exact command", "精确命令")
        : model.localizer.text("Absolute or project-relative path", "绝对路径或项目相对路径"),
      text: $grantValue
    )
    .textFieldStyle(.roundedBorder)
  }

  private var grantPickerRow: some View {
    HStack(spacing: 8) {
      if grantKind == .path {
        Picker(model.localizer.text("Access", "访问"), selection: $grantAccess) {
          Text(model.localizer.dynamic("read")).tag("read")
          Text(model.localizer.dynamic("write")).tag("write")
        }
        .frame(width: 100)
      }
      Picker(model.localizer.text("Scope", "范围"), selection: $grantScope) {
        Text(model.localizer.dynamic("once")).tag("once")
        Text(model.localizer.dynamic("session")).tag("session")
        Text(model.localizer.dynamic("project")).tag("project")
      }
      .frame(width: 110)
      Spacer(minLength: 0)
    }
  }

  private func approvalRow(_ review: CanvastApprovalReview) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .firstTextBaseline) {
        Label(review.tool, systemImage: "wrench.and.screwdriver")
          .font(.headline)
          .fixedSize(horizontal: false, vertical: true)
        Spacer()
        StatusBadge(text: humanized(review.decision), color: decisionColor(review.decision))
        StatusBadge(text: humanized(review.risk), color: riskColor(review.risk))
      }
      Text(review.rationale).font(.subheadline).fixedSize(horizontal: false, vertical: true)
      if let inputSummary = review.inputSummary, !inputSummary.isEmpty {
        Text(inputSummary)
          .font(.caption.monospaced())
          .foregroundStyle(.secondary)
          .padding(8)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
      }
      HStack(spacing: 12) {
        Label(
          "\(model.localizer.text("Authorization", "授权边界")): \(humanized(review.authorization, localizer: model.localizer))",
          systemImage: "person.badge.key"
        )
        Label(review.source, systemImage: "tray.and.arrow.down")
        Spacer()
        Text(review.timestamp)
      }
      .font(.caption2)
      .foregroundStyle(.secondary)
      if let categories = review.categories, !categories.isEmpty {
        HStack { ForEach(categories, id: \.self) { StatusBadge(text: humanized($0, localizer: model.localizer), color: .secondary) } }
      }
    }
    .contextMenu {
      Button(model.localizer.text("Prepare an audit request", "准备审计请求")) { prepareAudit(review) }
      Button(model.localizer.text("Copy rationale", "复制理由")) { copy(review.rationale) }
    }
  }

  private var safetyControls: some View {
    VStack(spacing: 14) {
      Panel(model.localizer.text("Execution controls", "执行控制"), systemImage: "stop.circle") {
        VStack(alignment: .leading, spacing: 10) {
          Button { model.stopRun() } label: { Label(model.localizer.text("Stop Active Run", "停止当前运行"), systemImage: "stop.fill") }
            .buttonStyle(.borderedProminent)
            .tint(.red)
            .disabled(!model.runState.isActive || actionLocked(model, .stopRun))
          Button { preparePermissionAudit() } label: { Label(model.localizer.text("Prepare Permission Audit", "准备权限审计"), systemImage: "checkmark.shield") }
          HStack {
            Button(model.localizer.text("Set Ask Every Time", "设为每次询问")) { model.setPermissionMode("ask") }
              .disabled(actionLocked(model, .setPermissionMode))
            Button(model.localizer.text("Set Automatic", "设为自动")) { model.setPermissionMode("auto") }
              .disabled(actionLocked(model, .setPermissionMode))
          }
          ActionStateBadge(state: model.actionState)
          Divider()
          Label(model.localizer.text("Runs are launched without interactive GUI prompts.", "运行启动时不会出现交互式 GUI 提示。"), systemImage: "rectangle.slash")
          Label(model.localizer.text("Output and errors remain visible in Run Console.", "输出和错误会继续在运行控制台中可见。"), systemImage: "text.alignleft")
          Label(model.localizer.text("Stop aborts active work while the project RPC host remains available.", "停止会中止当前工作，同时项目 RPC 主机仍保持可用。"), systemImage: "scope")
        }
        .font(.caption)
      }
      Panel(model.localizer.text("Workspace policy", "工作区策略"), systemImage: "lock.shield") {
        VStack(alignment: .leading, spacing: 9) {
          policyRow(model.localizer.text("Project root", "项目根目录"), model.projectDisplayPath)
          policyRow(model.localizer.text("Runtime mode", "运行时模式"), humanized(model.displayedRuntimeMode.rawValue, localizer: model.localizer))
          policyRow(model.localizer.dynamic("thinking"), humanized(model.thinkingLevel, localizer: model.localizer))
          policyRow(model.localizer.text("Closure", "闭环"), model.state.closure.deliverable ? model.localizer.text("Deliverable", "可交付") : model.localizer.text("Open", "未闭合"))
        }
      }
    }
  }

  private func policyRow(_ label: String, _ value: String) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(label).font(.caption2).foregroundStyle(.secondary)
      ScrollableMonospacedText(value: value)
    }
  }

  private func riskColor(_ risk: String) -> Color {
    switch risk.lowercased() {
    case "critical", "high": return .red
    case "medium": return .orange
    case "low": return .green
    default: return .secondary
    }
  }

  private func decisionColor(_ decision: String) -> Color {
    let normalized = decision.lowercased()
    if normalized.contains("deny") || normalized.contains("block") { return .red }
    if normalized.contains("ask") || normalized.contains("review") { return .orange }
    if normalized.contains("allow") || normalized.contains("approve") { return .green }
    return .blue
  }

  private func preparePermissionAudit() {
    model.prepareRequest(
      "Audit the current project permission posture. Summarize recent decisions, high-risk actions, scope boundaries, and any action that still requires explicit authorization.",
      status: model.localizer.text("Prepared a permission audit request. Press Run to execute it.", "已准备权限审计请求。点击运行以执行。")
    )
  }

  private func prepareAudit(_ review: CanvastApprovalReview) {
    model.prepareRequest(
      "Review permission decision \(review.id) for tool \(review.tool). Verify its risk classification, authorization boundary, rationale, and whether it remains appropriate.",
      status: model.localizer.text("Prepared an audit for \(review.tool). Press Run to execute it.", "已为 \(review.tool) 准备审计。点击运行以执行。")
    )
  }

  private func copy(_ text: String) {
    model.copyText(text, status: model.localizer.text("Permission rationale copied", "权限理由已复制"))
  }

  private func grantSandboxAccess() {
    let value = grantValue.trimmingCharacters(in: .whitespacesAndNewlines)
    let reason = grantReason.trimmingCharacters(in: .whitespacesAndNewlines)
    if grantKind == .command {
      model.grantSandboxCommand(value, scope: grantScope, reason: reason.isEmpty ? nil : reason)
    } else {
      model.grantSandboxPath(value, access: grantAccess, scope: grantScope, reason: reason.isEmpty ? nil : reason)
    }
  }

  private func display(_ value: Bool?, enabled: String = "Yes", disabled: String = "No") -> String {
    guard let value else { return model.localizer.dynamic("not_recorded") }
    return value ? model.localizer.boolText(true) : model.localizer.boolText(false)
  }
}

private enum SandboxGrantInputKind: String, CaseIterable, Identifiable {
  case command
  case path

  var id: String { rawValue }
  var title: String {
    let localizer = CanvastLocalizationRuntime.localizer
    return self == .command ? localizer.dynamic("command") : localizer.dynamic("path")
  }
}
