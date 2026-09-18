import Foundation
import CanvastAppCore

@MainActor
extension CanvastDesktopModel {
  var currentNavigationTarget: DesktopNavigationTarget {
    DesktopNavigationTarget(
      workspace: selectedWorkspace, feature: selectedFeature,
      toolsSection: toolsWorkspaceSection, canvasNodeID: selectedCanvasNodeID
    )
  }

  var canNavigateBack: Bool { navigationHistory.canGoBack }
  var canNavigateForward: Bool { navigationHistory.canGoForward }

  func navigate(
    to workspace: DesktopWorkspace,
    feature: CanvastFeatureID? = nil,
    toolsSection: ToolsWorkspaceSection? = nil,
    canvasNodeID: String? = nil
  ) {
    let target = DesktopNavigationTarget(
      workspace: workspace, feature: feature ?? selectedFeature,
      toolsSection: toolsSection ?? self.toolsWorkspaceSection, canvasNodeID: canvasNodeID
    )
    let current = currentNavigationTarget
    guard target != current else { return }
    navigationHistory.push(current)
    applyNavigationTarget(target)
  }

  func navigateBack() {
    let current = currentNavigationTarget
    guard let target = navigationHistory.goBack(from: current) else { return }
    applyNavigationTarget(target)
  }

  func navigateForward() {
    let current = currentNavigationTarget
    guard let target = navigationHistory.goForward(from: current) else { return }
    applyNavigationTarget(target)
  }

  private func applyNavigationTarget(_ target: DesktopNavigationTarget) {
    selectedWorkspace = target.workspace
    selectedFeature = target.feature
    toolsWorkspaceSection = target.toolsSection
    selectedCanvasNodeID = target.canvasNodeID
  }
}
