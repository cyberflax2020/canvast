import Foundation

public struct CanvastAppSnapshot: Equatable {
  public let title: String
  public let sidebar: [String]
  public let statusCards: [String]
  public let primaryPanels: [String]
  public let featureCatalog: [String]
  public let featureCommands: [String]
  public let brandAssets: [String]

  public var text: String {
    let localizer = CanvastLocalizationRuntime.localizer
    return [
      "# \(title)",
      "## \(localizer.text("Sidebar", "侧边栏"))",
      sidebar.joined(separator: "\n"),
      "## \(localizer.text("Status", "状态"))",
      statusCards.joined(separator: "\n"),
      "## \(localizer.text("Panels", "面板"))",
      primaryPanels.joined(separator: "\n"),
      "## \(localizer.text("Brand", "品牌"))",
      brandAssets.joined(separator: "\n"),
      "## \(localizer.text("Features", "能力"))",
      featureCatalog.joined(separator: "\n"),
      "## \(localizer.text("Commands", "命令"))",
      featureCommands.joined(separator: "\n")
    ].joined(separator: "\n")
  }
}

public enum CanvastAppRenderer {
  public static func snapshot(for state: CanvastProjectState) -> CanvastAppSnapshot {
    let localizer = CanvastLocalizationRuntime.localizer
    let primary = state.features.filter(\.isPrimary)
    let enhanced = state.features.filter(\.isEnhanced).map(\.title).joined(separator: ", ")
    let commands = state.features.compactMap { feature in
      feature.command.map { "\(feature.title): \($0)" }
    }
    let basePanels = [
      localizer.text(
        "Chat and command runner use unattended safe-run boundaries.",
        "对话与命令运行器使用 unattended 安全运行边界。"
      ),
      localizer.text(
        "Canvas visualizes files, plans, decisions, and agent runs.",
        "画布展示文件、计划、决策与 Agent 运行。"
      ),
      localizer.text(
        "Persistent runtime status keeps task tree, plans, sub-agents, workflows, and approval reviews visible outside the transcript.",
        "持久化运行时状态让任务树、计划、子 Agent、工作流与审批复核在转录之外也保持可见。"
      ),
      localizer.text(
        "Task tree and sub-agent management are first-class navigation surfaces.",
        "任务树与子 Agent 管理是一级导航界面。"
      ),
      localizer.text(
        "Workflow, context recall, web policy, sandbox, permissions, monitoring, and closure all have visible controls.",
        "工作流、上下文召回、Web 策略、沙箱、权限、监控与闭环都提供可见控制。"
      ),
      localizer.text(
        "macOS app mirrors CLI/TUI capabilities without launching browsers or requesting system permissions by default.",
        "macOS App 默认镜像 CLI/TUI 能力，不会主动启动浏览器或请求系统权限。"
      ),
    ]
    let taskPanels = state.runtimeStatus.tasks.suffix(5).map { item in
      localizer.text("Task", "任务")
        + ": [\(humanized(item.status, localizer: localizer))] \(item.title)\(item.summary.map { " - \($0)" } ?? "")"
    }
    let workflowPanels = state.runtimeStatus.workflows.suffix(5).map { item in
      localizer.text("Workflow", "工作流")
        + ": [\(humanized(item.status, localizer: localizer))] \(item.title)\(item.summary.map { " - \($0)" } ?? "")"
    }
    let agentPanels = state.runtimeStatus.subAgents.suffix(5).map { item in
      localizer.text("Agent", "Agent")
        + ": [\(humanized(item.status, localizer: localizer))] \(item.title)\(item.summary.map { " - \($0)" } ?? "")"
    }
    let approvalPanels = state.runtimeStatus.approvalReviews.suffix(5).map { review in
      localizer.text("Approval", "审批")
        + ": \(humanized(review.decision, localizer: localizer)) "
        + "\(localizer.text("risk", "风险"))=\(humanized(review.risk, localizer: localizer)) "
        + "\(localizer.text("authorization", "授权"))=\(humanized(review.authorization, localizer: localizer)) "
        + "\(localizer.text("tool", "工具"))=\(review.tool) - \(review.rationale)"
    }
    let model = state.runtimeStatus.model
    let tokens = state.runtimeStatus.tokens
    let unknown = localizer.dynamic("unknown").lowercased()
    let modelPanels = [
      localizer.text("Model", "模型")
        + ": \(model.provider.isEmpty ? unknown : model.provider)/\(model.model.isEmpty ? unknown : model.model) "
        + "\(localizer.dynamic("thinking").lowercased())=\(model.thinkingLevel.isEmpty ? unknown : humanized(model.thinkingLevel, localizer: localizer)) "
        + "\(localizer.text("image_input", "图像输入"))=\(humanized(model.imageInput, localizer: localizer))",
      localizer.text("Modalities", "模态")
        + ": \(model.modalities.isEmpty ? localizer.dynamic("unknown") : model.modalities.joined(separator: ", "))",
      localizer.text("Tokens", "Token")
        + ": \(localizer.text("total", "总计"))=\(formatWhole(tokens.totalTokens)) "
        + "\(localizer.text("effective", "有效"))=\(formatWhole(tokens.effectiveTokens)) "
        + "\(localizer.text("input", "输入"))=\(formatWhole(tokens.inputTokens)) "
        + "\(localizer.text("output", "输出"))=\(formatWhole(tokens.outputTokens)) "
        + "\(localizer.text("turns", "轮次"))=\(formatWhole(tokens.turnCount)) "
        + "\(localizer.dynamic("tools").lowercased())=\(formatWhole(tokens.toolCalls)) "
        + "\(localizer.text("cost", "成本"))=$\(String(format: "%.4f", tokens.costUsd))",
      localizer.dynamic("context")
        + ": \(localizer.text("used", "已使用"))=\(formatWhole(tokens.contextUsedTokens)) "
        + "\(localizer.text("window", "窗口"))=\(formatWhole(tokens.contextWindowTokens)) "
        + "\(localizer.text("remaining", "剩余"))=\(formatWhole(tokens.contextRemainingTokens)) "
        + "\(localizer.text("ratio", "占比"))=\(formatPercent(tokens.contextUsageRatio))",
    ]
    let attachmentPanels = state.runtimeStatus.attachments.suffix(5).map { attachment in
      localizer.text("Attachment", "附件")
        + ": [\(humanized(attachment.kind, localizer: localizer))/\(humanized(attachment.disposition, localizer: localizer))] \(attachment.placeholder) - \(attachment.summary)"
    }
    let runtimePanels = basePanels + modelPanels + taskPanels + workflowPanels + agentPanels + attachmentPanels + approvalPanels

    return CanvastAppSnapshot(
      title: "Canvast",
      sidebar: primary.map { "\($0.title) [\(humanized($0.controlPlane, localizer: localizer))]" },
      statusCards: [
        localizer.dynamic("mode") + ": \(humanized(state.runtimeMode.rawValue, localizer: localizer))",
        localizer.dynamic("canvas") + ": \(state.graph.nodes) \(localizer.text("nodes", "个节点")) / \(state.graph.edges) \(localizer.text("edges", "条边"))",
        localizer.text("Closure", "闭环") + ": \(state.closure.closed)/\(state.closure.required) \(localizer.text("required", "必需"))",
        localizer.text("Runtime Language", "运行时语言") + ": \(state.runtimeStatus.language.activeLocale) \(localizer.text("source", "来源"))=\(humanized(state.runtimeStatus.language.source, localizer: localizer))",
        localizer.text("Runtime Tasks", "运行时任务") + ": \(state.runtimeStatus.openTaskCount)/\(state.runtimeStatus.tasks.count) \(localizer.text("open", "未完成"))",
        localizer.text("Runtime Agents", "运行时 Agent") + ": \(state.runtimeStatus.activeAgentCount) \(localizer.text("active", "活跃"))",
        localizer.text("Runtime Workflows", "运行时工作流") + ": \(state.runtimeStatus.activeWorkflowCount) \(localizer.text("active", "活跃"))",
        localizer.text("Runtime Model", "运行时模型") + ": \(model.model.isEmpty ? unknown : model.model) \(localizer.dynamic("thinking").lowercased())=\(model.thinkingLevel.isEmpty ? unknown : humanized(model.thinkingLevel, localizer: localizer))",
        localizer.text("Runtime Tokens", "运行时 Token") + ": \(formatWhole(tokens.totalTokens)) \(localizer.text("total", "总计"))",
        localizer.text("Runtime Context", "运行时上下文") + ": \(formatWhole(tokens.contextUsedTokens))/\(formatWhole(tokens.contextWindowTokens))",
        localizer.text("Runtime Attachments", "运行时附件") + ": \(state.runtimeStatus.attachments.count)",
        localizer.text("Approval Reviews", "审批复核") + ": \(state.runtimeStatus.approvalReviews.count)",
        localizer.text("Safety", "安全") + ": "
          + [localizer.text("sandbox", "沙箱"), localizer.text("permissions", "权限"), localizer.text("safe-run", "安全运行"), localizer.text("GUI guard", "GUI 防护")].joined(separator: ", "),
        localizer.text("Enhanced", "增强能力") + ": \(enhanced)",
      ],
      primaryPanels: runtimePanels,
      featureCatalog: state.features.map { feature in
        let command = feature.command.map { " \(localizer.dynamic("command").lowercased())=\($0)" }
          ?? " \(localizer.text("state-view", "状态视图"))"
        let tier = feature.isEnhanced
          ? localizer.text("enhanced", "增强")
          : localizer.text("baseline", "基础")
        return "\(feature.title) [\(humanized(feature.controlPlane, localizer: localizer)), \(tier)]\(command)"
      },
      featureCommands: commands,
      brandAssets: [
        localizer.text("Logo", "标志") + ": CanvastLogo",
        localizer.text("Terminal mark", "终端标识") + ": assets/brand/canvast-logo.tui.txt",
        localizer.text("Palette", "色板") + ": #070b13 #1fc4f4 #47d86b #ffbd36",
      ]
    )
  }

  private static func formatWhole(_ value: Double) -> String {
    let rounded = Int(value.rounded())
    return NumberFormatter.localizedString(from: NSNumber(value: rounded), number: .decimal)
  }

  private static func formatPercent(_ value: Double) -> String {
    "\(Int((value * 100).rounded()))%"
  }

  public static func writeSnapshot(_ snapshot: CanvastAppSnapshot, to url: URL) throws {
    try snapshot.text.write(to: url, atomically: true, encoding: .utf8)
  }
}
