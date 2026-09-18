import Foundation
import CanvastAppCore

@MainActor
extension CanvastDesktopModel {
  func revokeSandboxGrant(_ grant: DesktopSandboxGrant) {
    guard let expectedRevision = sandboxStatus?.revision else {
      statusLine = localizer.text(
        "Inspect the live sandbox state before revoking a grant.",
        "撤销授权前，请先检查实时沙箱状态。"
      )
      return
    }
    sandboxRevocationReceipt = nil
    let action = CanvastDesktopAction(
      workspace: .safety, kind: .revokeSandboxAccess, featureID: .sandbox,
      arguments: [
        "grantId": .string(grant.id),
        "expectedRevision": .integer(expectedRevision),
      ]
    )
    executeAction(
      action,
      label: localizer.text("sandbox grant revocation", "沙箱授权撤销"),
      uiActionID: .revokeSandboxAccess,
      lastStableState: "\(grant.id)|\(expectedRevision)",
      reconcile: { [weak self] reconciliationID in
        self?.reconcileSandboxGrantRevocation(
          grantID: grant.id,
          expectedRevision: expectedRevision,
          originalRequestID: action.requestID,
          reconciliationID: reconciliationID
        )
      }
    )
  }

  func reconcileSandboxGrantRevocation(
    grantID: String,
    expectedRevision: Int,
    originalRequestID: String,
    reconciliationID: String
  ) {
    guard actionCenter.isCurrentReconciliation(
      .revokeSandboxAccess,
      correlationID: originalRequestID,
      reconciliationID: reconciliationID
    ) else { return }
    let inspection = CanvastDesktopAction(
      workspace: .safety, kind: .inspectSandbox, featureID: .sandbox
    )
    do {
      try inspection.validate()
      let providerConfiguration = try resolvedProviderConfiguration()
      try ensureRuntimeHost(providerConfiguration: providerConfiguration)
      pendingSandboxRevokeReconciliations[inspection.requestID] = .init(
        originalRequestID: originalRequestID,
        reconciliationID: reconciliationID,
        grantID: grantID,
        expectedRevision: expectedRevision
      )
      try runtimeBridge.execute(
        action: inspection,
        installRoot: try resolvedInstallRoot(),
        workspaceRoot: projectRoot,
        mode: displayedRuntimeMode,
        thinkingLevel: thinkingLevel,
        providerConfiguration: providerConfiguration
      )
      statusLine = localizer.text(
        "Inspecting the live grant state without resending revoke",
        "正在检查实时授权状态，不会重复发送撤销"
      )
    } catch {
      pendingSandboxRevokeReconciliations.removeValue(forKey: inspection.requestID)
      _ = actionCenter.returnToOutcomeUnknown(
        .revokeSandboxAccess,
        correlationID: originalRequestID,
        reconciliationID: reconciliationID,
        message: localizer.text(
          "Grant-state inspection failed; the revoke outcome remains unknown.",
          "授权状态检查失败；撤销结果仍未知。"
        )
      )
      statusLine = error.localizedDescription
      appendConsole(.standardError, statusLine)
    }
  }

  func handleSandboxRevokeReconciliationResult(
    _ response: CanvastDesktopActionResult
  ) -> Bool {
    guard let pending = pendingSandboxRevokeReconciliations.removeValue(
      forKey: response.requestID
    ) else { return false }
    guard actionCenter.isCurrentReconciliation(
      .revokeSandboxAccess,
      correlationID: pending.originalRequestID,
      reconciliationID: pending.reconciliationID
    ) else { return true }
    do {
      try response.validatePayload(for: .inspectSandbox)
    } catch {
      finishSandboxRevokeReconciliation(
        pending, outcome: .stillUnknown(localizer.text(
          "The sandbox inspection response was invalid; review is required.",
          "沙箱检查响应无效；需要人工复核。"
        ))
      )
      return true
    }
    guard response.status == .succeeded,
          let result = response.result,
          let status = decodeSandboxStatus(result),
          let revision = status.revision else {
      finishSandboxRevokeReconciliation(
        pending, outcome: .stillUnknown(localizer.text(
          "The live grant state could not be confirmed; review is required.",
          "无法确认实时授权状态；需要人工复核。"
        ))
      )
      return true
    }
    applyReconciledSandboxStatus(status)
    let stillPresent = status.grants.contains { $0.id == pending.grantID }
    if !stillPresent && revision > pending.expectedRevision {
      finishSandboxRevokeReconciliation(
        pending, outcome: .confirmedSucceeded(localizer.text(
          "Grant absence was confirmed in the newer live revision.",
          "已在更新的实时版本中确认该授权不存在。"
        ))
      )
    } else if stillPresent && revision >= pending.expectedRevision {
      finishSandboxRevokeReconciliation(
        pending, outcome: .confirmedFailed(localizer.text(
          "The grant is still active; the revoke did not take effect.",
          "该授权仍处于活动状态；撤销未生效。"
        ))
      )
    } else {
      finishSandboxRevokeReconciliation(
        pending, outcome: .stillUnknown(localizer.text(
          "The inspected revision cannot prove the revoke outcome; review is required.",
          "检查到的版本无法证明撤销结果；需要人工复核。"
        ))
      )
    }
    return true
  }

  func finishSandboxRevokeReconciliation(
    _ pending: DesktopSandboxRevokeReconciliation,
    outcome: DesktopActionReconciliationOutcome
  ) {
    guard actionCenter.resolveUnknown(
      .revokeSandboxAccess,
      correlationID: pending.originalRequestID,
      reconciliationID: pending.reconciliationID,
      outcome: outcome
    ) else { return }
    discardDispatcherRequest(pending.originalRequestID)
    switch outcome {
    case .confirmedSucceeded(let message), .confirmedFailed(let message),
         .stillUnknown(let message):
      statusLine = message
      appendConsole(.system, message)
    }
  }

  func discardSandboxRevokeReconciliations(originalRequestID: String) {
    pendingSandboxRevokeReconciliations = pendingSandboxRevokeReconciliations.filter {
      $0.value.originalRequestID != originalRequestID
    }
  }
}
