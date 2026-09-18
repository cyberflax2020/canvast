/**
 * =============================================================================
 * Canvast — Desktop Capability Matrix / 桌面能力矩阵
 * =============================================================================
 * @file        macos-app/Sources/CanvastAppCore/DesktopCapabilityMatrix.swift
 * @brief       Maps product features to typed native desktop capabilities.
 * @description Keeps capability declarations separate from wire validation so
 *              both production sources remain within the repository file cap.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import Foundation

public struct CanvastDesktopCapability: Identifiable, Codable, Equatable {
  public var id: CanvastFeatureID { featureID }
  public let featureID: CanvastFeatureID
  public let workspace: CanvastDesktopWorkspace
  public let level: CanvastDesktopCapabilityLevel
  public let actions: [CanvastDesktopActionKind]
  public let localActions: [CanvastDesktopActionKind]
  public let degradedActions: [CanvastDesktopActionKind]
  public let rationale: String

  public var isImplemented: Bool {
    level == .executable || level == .editable || level == .degraded || level == .readOnly
  }

  public var isOperable: Bool {
    !actions.isEmpty && level != .external && level != .unavailable
  }
}

public enum CanvastDesktopCapabilityMatrix {
  public static let all: [CanvastDesktopCapability] = CanvastFeatureRegistry.all.map(capability)

  public static func capability(for id: CanvastFeatureID) -> CanvastDesktopCapability {
    capability(CanvastFeatureRegistry.feature(id)!)
  }

  private static func capability(_ feature: CanvastFeature) -> CanvastDesktopCapability {
    let workspace = workspace(for: feature)
    switch feature.id {
    case .chat:
      return entry(
        feature, workspace, .executable,
        [.runPrompt, .requestControl, .inspectResume, .chooseResume, .claimResume, .rebindResume, .retireResume, .reconcileResume, .steerRun, .followUpRun, .stopRun]
      )
    case .planMode:
      return entry(feature, workspace, .editable, [.createPlan, .updatePlan, .approvePlan, .completePlan, .selectCanvasPlan])
    case .taskTree:
      return entry(feature, workspace, .editable, [.createTask, .updateTask])
    case .subAgents:
      return entry(
        feature, workspace, .degraded, [.spawnAgent],
        degraded: [.cancelAgent, .followUpAgent],
        "Launch is closed-loop; targeted cancel and follow-up return structured unsupported results until addressable handles exist."
      )
    case .workflow, .dynamicWorkflow:
      return entry(
        feature, workspace, .degraded, [.runWorkflow],
        degraded: [.cancelWorkflow, .followUpWorkflow],
        "Launch is closed-loop; targeted cancel and follow-up return structured unsupported results until addressable handles exist."
      )
    case .canvas:
      return entry(
        feature, workspace, .readOnly, [.selectCanvasTask, .exportCanvas, .cancelCanvasExport],
        local: [.filterCanvasSnapshot, .reloadPersistedSnapshot],
        "The graph remains a read-only projection; task selection and portable export use typed actions."
      )
    case .dynamicCanvas:
      return entry(
        feature, workspace, .readOnly, [], local: [.filterCanvasSnapshot, .reloadPersistedSnapshot],
        "Dynamic graph state is inspected locally; the App does not claim graph mutation."
      )
    case .permissions:
      return entry(feature, workspace, .editable, [.setPermissionMode])
    case .models:
      return entry(feature, workspace, .editable, [.setThinkingLevel])
    case .sessions:
      return entry(
        feature, workspace, .editable,
        [
          .newSession, .sessionCatalog, .sessionOpen, .sessionRename, .sessionDelete, .sessionTranscript,
          .projectPreflight, .projectCreate, .projectOpen, .projectReinitialize, .projectDelete,
          .projectRestart, .setRuntimeMode, .inspectProjectScope, .rebindProjectScope,
        ],
        local: [.reloadPersistedSnapshot]
      )
    case .sandbox:
      return entry(
        feature, workspace, .editable,
        [.inspectSandbox, .setSandboxProfile, .grantSandboxAccess, .revokeSandboxAccess]
      )
    case .reasoningTrace, .autoOrchestration, .context, .usage, .closure, .tools, .safety, .macApp:
      return entry(
        feature, workspace, .readOnly, [], local: [.reloadPersistedSnapshot],
        "Visible from a durable local projection; no runtime mutation is claimed."
      )
    case .webResearch, .askUser, .modelRegistry, .lsp, .notebooks, .artifacts, .cron, .monitor,
         .backgroundTasks, .worktrees, .git, .mcp, .codeReview, .evaluation:
      return entry(feature, workspace, .external, [], "No deterministic desktop action is wired for this capability.")
    case .packaging, .guiGuard, .offscreenSnapshot:
      return entry(feature, workspace, .external, [], "This is a delivery or automation boundary, not an in-App action.")
    }
  }

  private static func entry(
    _ feature: CanvastFeature,
    _ workspace: CanvastDesktopWorkspace,
    _ level: CanvastDesktopCapabilityLevel,
    _ actions: [CanvastDesktopActionKind],
    local: [CanvastDesktopActionKind] = [],
    degraded: [CanvastDesktopActionKind] = [],
    _ rationale: String = "Backed by a typed desktop action or native RPC command."
  ) -> CanvastDesktopCapability {
    CanvastDesktopCapability(
      featureID: feature.id, workspace: workspace, level: level,
      actions: actions, localActions: local, degradedActions: degraded, rationale: rationale
    )
  }

  private static func workspace(for feature: CanvastFeature) -> CanvastDesktopWorkspace {
    if feature.id == .subAgents { return .orchestration }
    if feature.id == .sessions { return .project }
    switch feature.controlPlane {
    case "agent": return .run
    case "planning": return .planning
    case "orchestration": return .orchestration
    case "canvas", "memory": return .canvas
    case "safety": return .safety
    default: return .project
    }
  }
}
