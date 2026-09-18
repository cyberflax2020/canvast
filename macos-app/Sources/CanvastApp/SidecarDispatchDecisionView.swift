import SwiftUI
import CanvastAppCore

struct SidecarDispatchDecisionView: View {
  let dispatch: CanvastSidecarDispatch
  @Environment(\.canvastLocalizer) private var localizer

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      LazyVGrid(columns: [GridItem(.adaptive(minimum: 210), alignment: .topLeading)], alignment: .leading, spacing: 8) {
        field(localizer.text("Strategy", "执行策略"), value(dispatch.strategy))
        field(localizer.text("Tool", "执行工具"), value(dispatch.tool))
        field(localizer.text("Revision", "决策版本"), String(dispatch.revision))
        field(localizer.text("Execution state", "执行状态"), value(dispatch.executionState))
        field(localizer.text("Concurrency scope", "并发范围"), scope(dispatch.concurrencyScope))
        field(localizer.text("Primary overlap", "与主任务重叠"), dispatch.primaryOverlap ? localizer.text("Yes", "是") : localizer.text("No", "否"))
      }
      field(localizer.text("Decision reasons", "决策原因"), dispatch.reasonCodes.isEmpty ? localizer.text("No reason code recorded", "未记录原因代码") : dispatch.reasonCodes.map(reason).joined(separator: "\n"))
      if !dispatch.explanation.isEmpty { field(localizer.text("Recorded explanation", "记录的解释"), dispatch.explanation) }
      field(localizer.text("Child run IDs", "子任务运行 ID"), dispatch.childRunIds.isEmpty ? localizer.text("None", "无") : dispatch.childRunIds.joined(separator: "\n"))
      if !dispatch.branches.isEmpty {
        VStack(alignment: .leading, spacing: 6) {
          Text(localizer.text("Branch evidence", "分支证据")).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
          ForEach(dispatch.branches) { branch in branchEvidence(branch) }
        }
      }
      if let failure = dispatch.failureCode, !failure.isEmpty { field(localizer.text("Failure", "失败原因"), value(failure)) }
    }
    .padding(10)
    .background(Color.accentColor.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
  }

  private func field(_ label: String, _ content: String) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(label).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
      Text(content).font(.caption).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
    }.frame(maxWidth: .infinity, alignment: .leading)
  }

  private func value(_ raw: String) -> String {
    let labels: [String: (String, String)] = [
      "serial": ("Serial", "串行"), "spawn_agent": ("Single child agent", "单个子 Agent"),
      "parallel_agents": ("Parallel child agents", "并行子 Agent"), "defer": ("Deferred", "延后"),
      "none": ("No agent tool", "不使用 Agent 工具"), "recorded": ("Recorded", "已记录"),
      "admitted": ("Admitted", "已准入"), "completed": ("Completed", "已完成"), "failed": ("Failed", "失败")
    ]
    guard let label = labels[raw] else { return humanized(raw, localizer: localizer) }
    return localizer.text(label.0, label.1)
  }

  private func scope(_ raw: String) -> String {
    switch raw {
    case "serial": return localizer.text("Serial sidecar execution", "Sidecar 串行执行")
    case "sidecar_children": return localizer.text("Sidecar children only", "仅 Sidecar 子任务并发")
    case "primary_and_sidecar": return localizer.text("Primary and sidecar", "主任务与 Sidecar 并发")
    default: return value(raw)
    }
  }

  private func reason(_ code: String) -> String {
    let meanings: [String: (String, String)] = [
      "non_sidecar_control": ("Changes primary work and stays serial", "会改变主任务，保持串行"),
      "status_control": ("Reads authoritative state without delegation", "读取权威状态，不进行委派"),
      "explicit_serial": ("Serial execution was requested", "明确要求串行执行"),
      "explicit_defer": ("Deferred execution was requested", "明确要求延后执行"),
      "invalid_branch_count": ("No valid positive branch count", "没有有效的正分支数"),
      "missing_branch_evidence": ("Per-branch evidence is missing", "缺少逐分支证据"),
      "branch_identity_unproven": ("Branch identity is missing or duplicated", "分支标识缺失或重复"),
      "input_not_self_contained": ("Input is not self-contained", "输入不能独立完成任务"),
      "live_primary_dependency": ("Depends on mutable primary state", "依赖仍在变化的主任务状态"),
      "inter_branch_dependency_present": ("Branches depend on each other", "分支之间存在依赖"),
      "write_isolation_unproven": ("Write isolation is unproven", "尚未证明写入相互隔离"),
      "external_resource_isolation_unproven": ("External-resource isolation is unproven", "尚未证明外部资源相互隔离"),
      "branch_write_overlap": ("Branch write targets overlap", "分支写入目标存在重叠"),
      "parallel_write_execution_unavailable": ("Parallel writes require isolated worktrees and a merge owner", "并行写入需要独立 worktree 和合并 owner"),
      "branch_external_resource_overlap": ("Branch external resources overlap", "分支外部资源存在重叠"),
      "budget_unavailable": ("Execution budget is unavailable", "执行预算不足"),
      "insufficient_child_slots": ("Child-agent capacity is unavailable", "子 Agent 容量不足"),
      "async_dispatch_unavailable": ("Non-blocking dispatch guarantees are unavailable", "缺少非阻塞调度保障"),
      "single_independent_branch": ("One independent branch uses a child agent", "一个独立分支使用单个子 Agent"),
      "multiple_independent_branches": ("Multiple independent branches use parallel child agents", "多个独立分支使用并行子 Agent"),
      "parallel_request_downgraded_to_spawn": ("One branch was reduced to a single child agent", "单分支已降为单个子 Agent"),
      "spawn_request_upgraded_to_parallel": ("Multiple branches were promoted to parallel child agents", "多分支已升级为并行子 Agent")
    ]
    guard let meaning = meanings[code] else { return humanized(code, localizer: localizer) }
    return "\(value(code)): \(localizer.text(meaning.0, meaning.1))"
  }

  private func branchEvidence(_ branch: CanvastSidecarDispatchBranch) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(branch.id).font(.caption.weight(.medium)).textSelection(.enabled)
      field(localizer.text("Self-contained", "输入自足"), branch.selfContained ? localizer.text("Yes", "是") : localizer.text("No", "否"))
      field(localizer.text("Primary dependency", "主任务依赖"), value(branch.primaryDependency))
      field(localizer.text("Branch dependencies", "分支依赖"), list(branch.dependsOnBranchIds))
      field(localizer.text("Write targets", "写入目标"), list(branch.writeTargets))
      field(localizer.text("External resources", "外部资源"), list(branch.externalResourceKeys))
    }.padding(8).background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
  }

  private func list(_ values: [String]) -> String {
    values.isEmpty ? localizer.text("None", "无") : values.joined(separator: "\n")
  }
}

struct SidecarDispatchPolicyGuideView: View {
  @Environment(\.canvastLocalizer) private var localizer
  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      Text(localizer.text("Sidecar dispatch rules", "Sidecar 调度规则")).font(.subheadline.weight(.semibold))
      rule("arrow.right", localizer.text("Control requests, dependent work, shared writes, shared external resources, or unproven isolation run serially.", "控制请求、依赖主任务的工作、共享写入、共享外部资源或隔离性未经证明的工作均串行执行。"))
      rule("person", localizer.text("One proven independent branch uses one child agent.", "一个已证明独立的分支使用单个子 Agent。"))
      rule("person.2", localizer.text("Two or more proven independent read-only branches use parallel child agents when budget and capacity are available. Parallel writes remain serial.", "两个及以上已证明独立且只读的分支在预算和容量允许时使用并行子 Agent；并行写入保持串行。"))
      rule("pause", localizer.text("An explicit delegated request is deferred when safe capacity is unavailable.", "明确要求委派但安全容量不足时延后执行。"))
      Text(localizer.text("Only sidecar children overlap. Primary work remains suspended until the sidecar settles. Decisions use typed evidence and reserve child capacity before launch.", "只有 Sidecar 子任务之间可以重叠执行。Sidecar 结束前主任务保持暂停。决策仅使用结构化证据，并在启动前预留子 Agent 容量。"))
        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }
  }
  private func rule(_ icon: String, _ text: String) -> some View {
    Label { Text(text).fixedSize(horizontal: false, vertical: true) } icon: { Image(systemName: icon) }.font(.caption)
  }
}
