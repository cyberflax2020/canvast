import Foundation
import CanvastAppCore

struct DesktopCanvasExportFile: Identifiable, Equatable {
  let format: String
  let name: String
  let bytes: Int
  let sha256: String

  var id: String { name }
}

struct DesktopCanvasExportReceipt: Equatable {
  let outputDirectory: String
  let files: [DesktopCanvasExportFile]
  let nodeCount: Int
  let edgeCount: Int
  let message: String
}

@MainActor
extension CanvastDesktopModel {
  var canvasExportReceipt: DesktopCanvasExportReceipt? {
    guard lastActionResult?.status == .succeeded,
          let result = lastActionResult?.result,
          stringValue(result["receiptType"]) == "canvas-export",
          let outputDirectory = stringValue(result["outputDirectory"]),
          let nodeCount = integerValue(result["nodeCount"]),
          let edgeCount = integerValue(result["edgeCount"]),
          let values = arrayValue(result["files"]) else { return nil }
    let files = values.compactMap { value -> DesktopCanvasExportFile? in
      guard let file = objectValue(value), let format = stringValue(file["format"]),
            let name = stringValue(file["name"]), let bytes = integerValue(file["bytes"]),
            let sha256 = stringValue(file["sha256"]) else { return nil }
      return DesktopCanvasExportFile(format: format, name: name, bytes: bytes, sha256: sha256)
    }
    guard files.count == 5 else { return nil }
    return DesktopCanvasExportReceipt(
      outputDirectory: outputDirectory, files: files, nodeCount: nodeCount, edgeCount: edgeCount,
      message: localizer.text("Canvas export completed.", "画布导出已完成。")
    )
  }

  func exportCanvas(outputName: String, requestID: String = UUID().uuidString) {
    guard requireConfiguredWorkspace(actionID: .exportCanvas) else { return }
    let action = CanvastDesktopAction(
      requestID: requestID, workspace: .canvas, kind: .exportCanvas, featureID: .canvas,
      arguments: ["outputName": .string(outputName)]
    )
    dispatchCanvasExport(action, outputName: outputName)
  }

  private func dispatchCanvasExport(_ action: CanvastDesktopAction, outputName: String) {
    do { try action.validate() } catch {
      failCanvasExportValidation(action: action, error: error)
      return
    }
    let spec = DesktopActionRegistry.spec(for: .exportCanvas)
    switch actionCenter.begin(
      spec: spec, correlationID: action.requestID,
      retry: { [weak self] in self?.exportCanvas(outputName: outputName) },
      cancel: { [weak self] in self?.cancelCanvasExport(targetRequestID: action.requestID) },
      reconcile: { [weak self] reconciliationID in
        self?.reconcileCanvasExport(
          requestID: action.requestID, reconciliationID: reconciliationID, outputName: outputName
        )
      },
      onTimeout: { [weak self] in
        self?.handleCanvasExportTimeout(targetRequestID: action.requestID)
      },
      stage: .init(
        .requestEncoding,
        english: "Preparing Canvas export",
        simplifiedChinese: "正在准备画布导出"
      )
    ) {
    case .locked(_, let message):
      statusLine = message
      return
    case .started:
      break
    }
    lastActionResult = nil
    do {
      let providerConfiguration = try resolvedProviderConfiguration()
      try ensureRuntimeHost(providerConfiguration: providerConfiguration)
      pendingActionIDs.insert(action.requestID)
      pendingActionKinds[action.requestID] = action.kind
      pendingUIActionIDs[action.requestID] = .exportCanvas
      try runtimeBridge.execute(
        action: action, installRoot: try resolvedInstallRoot(), workspaceRoot: projectRoot,
        mode: displayedRuntimeMode, thinkingLevel: thinkingLevel,
        providerConfiguration: providerConfiguration
      )
      actionCenter.markQueued(
        .exportCanvas, correlationID: action.requestID,
        message: localizer.text("Canvas export dispatched", "画布导出已发送")
      )
      actionCenter.markWaiting(
        .exportCanvas, correlationID: action.requestID,
        message: localizer.text(
          "Generating JSON, Markdown, Mermaid, SVG, and HTML",
          "正在生成 JSON、Markdown、Mermaid、SVG 和 HTML"
        )
      )
      statusLine = localizer.text("Canvas export started", "画布导出已开始")
    } catch {
      discardDispatcherRequest(action.requestID)
      let message = localizer.text(
        "Canvas export could not be dispatched: \(error.localizedDescription)",
        "无法发送画布导出：\(error.localizedDescription)"
      )
      actionCenter.fail(.exportCanvas, correlationID: action.requestID, message: message)
      statusLine = message
      appendConsole(.standardError, message)
    }
  }

  private func failCanvasExportValidation(action: CanvastDesktopAction, error: Error) {
    let spec = DesktopActionRegistry.spec(for: .exportCanvas)
    if case .started = actionCenter.begin(
      spec: spec, correlationID: action.requestID,
      stage: .init(
        .requestEncoding,
        english: "Validating Canvas export",
        simplifiedChinese: "正在验证画布导出"
      )
    ) {
      actionCenter.fail(
        .exportCanvas, correlationID: action.requestID,
        message: localizer.text(
          "Canvas export request is invalid: \(error.localizedDescription)",
          "画布导出请求无效：\(error.localizedDescription)"
        )
      )
    }
    statusLine = localizer.text(
      "Canvas export request is invalid: \(error.localizedDescription)",
      "画布导出请求无效：\(error.localizedDescription)"
    )
    appendConsole(.standardError, statusLine)
  }

  private func cancelCanvasExport(targetRequestID: String) {
    let cancellation = CanvastDesktopAction(
      workspace: .canvas, kind: .cancelCanvasExport, featureID: .canvas,
      arguments: ["targetRequestId": .string(targetRequestID)]
    )
    do {
      try cancellation.validate()
      let providerConfiguration = try resolvedProviderConfiguration()
      pendingActionIDs.insert(cancellation.requestID)
      pendingActionKinds[cancellation.requestID] = cancellation.kind
      pendingCanvasExportCancellationTargets[cancellation.requestID] = targetRequestID
      try runtimeBridge.execute(
        action: cancellation, installRoot: try resolvedInstallRoot(), workspaceRoot: projectRoot,
        mode: displayedRuntimeMode, thinkingLevel: thinkingLevel,
        providerConfiguration: providerConfiguration
      )
      guard pendingCanvasExportCancellationTargets[cancellation.requestID] == targetRequestID else {
        return
      }
      let message = localizer.text(
        "Waiting for Canvas export cancellation confirmation",
        "正在等待画布导出取消确认"
      )
      actionCenter.markWaiting(.exportCanvas, correlationID: targetRequestID, message: message)
      statusLine = message
    } catch {
      pendingCanvasExportCancellationTargets.removeValue(forKey: cancellation.requestID)
      discardDispatcherRequest(cancellation.requestID)
      markCanvasExportCancellationUnknown(
        targetRequestID: targetRequestID,
        detail: error.localizedDescription,
        english: "Canvas export cancellation could not be dispatched",
        simplifiedChinese: "无法发送画布导出取消请求"
      )
    }
  }

  func hasPendingCanvasExportCancellation(targetRequestID: String) -> Bool {
    pendingCanvasExportCancellationTargets.values.contains(targetRequestID)
  }

  func handleCanvasExportCancellationResult(_ result: CanvastDesktopActionResult) {
    guard let targetRequestID = pendingCanvasExportCancellationTargets.removeValue(
      forKey: result.requestID
    ) else {
      discardDispatcherRequest(result.requestID)
      appendConsole(
        .standardError,
        localizer.text(
          "Ignored an uncorrelated Canvas export cancellation receipt.",
          "已忽略未关联的画布导出取消回执。"
        )
      )
      return
    }
    discardDispatcherRequest(result.requestID)
    guard actionCenter.snapshot(for: .exportCanvas)?.correlationID == targetRequestID else {
      discardDispatcherRequest(targetRequestID)
      appendConsole(
        .standardError,
        localizer.text(
          "Ignored a stale Canvas export cancellation receipt.",
          "已忽略过期的画布导出取消回执。"
        )
      )
      return
    }

    let validationError: Error?
    do {
      try result.validatePayload(for: .cancelCanvasExport)
      validationError = nil
    } catch {
      validationError = error
    }
    let receiptTarget = stringValue(result.result?["targetRequestId"])
    guard result.status == .succeeded, validationError == nil, receiptTarget == targetRequestID else {
      let detail = validationError?.localizedDescription ?? result.error?.message ?? localizer.text(
        "The cancellation receipt did not match the active export.",
        "取消回执与当前导出不匹配。"
      )
      markCanvasExportCancellationUnknown(
        targetRequestID: targetRequestID, detail: detail,
        english: "Canvas export cancellation was not confirmed",
        simplifiedChinese: "画布导出取消未获确认"
      )
      return
    }

    discardDispatcherRequest(targetRequestID)
    let message = localizer.text("Canvas export cancellation confirmed", "画布导出取消已确认")
    actionCenter.cancel(.exportCanvas, correlationID: targetRequestID, message: message)
    statusLine = message
    appendConsole(.system, message)
  }

  func handleCanvasExportTimeout(targetRequestID: String) {
    let cancellationRequestIDs = pendingCanvasExportCancellationTargets.compactMap { entry in
      entry.value == targetRequestID ? entry.key : nil
    }
    guard !cancellationRequestIDs.isEmpty else {
      handleActionTimeout(.exportCanvas, correlationID: targetRequestID)
      return
    }
    for requestID in cancellationRequestIDs {
      pendingCanvasExportCancellationTargets.removeValue(forKey: requestID)
      discardDispatcherRequest(requestID)
    }
    markCanvasExportCancellationUnknown(
      targetRequestID: targetRequestID, detail: nil,
      english: "Canvas export cancellation confirmation timed out",
      simplifiedChinese: "画布导出取消确认已超时"
    )
  }

  func canvasExportResultMessage(
    _ result: CanvastDesktopActionResult, kind: CanvastDesktopActionKind?
  ) -> String? {
    guard kind == .exportCanvas else { return nil }
    if result.status == .succeeded {
      return localizer.text("Canvas export completed", "画布导出已完成")
    }
    let detail = result.error?.message ?? localizer.text("Unknown export error", "未知导出错误")
    return localizer.text(
      "Canvas export failed: \(detail)",
      "画布导出失败：\(detail)"
    )
  }

  private func markCanvasExportCancellationUnknown(
    targetRequestID: String, detail: String?, english: String, simplifiedChinese: String
  ) {
    discardDispatcherRequest(targetRequestID)
    let summary = localizer.text(english, simplifiedChinese)
    let message = detail.map { "\(summary): \($0)" } ?? summary
    actionCenter.markOutcomeUnknown(.exportCanvas, correlationID: targetRequestID, message: message)
    statusLine = message
    appendConsole(.standardError, message)
  }

  private func reconcileCanvasExport(
    requestID: String, reconciliationID: String, outputName: String
  ) {
    let message = localizer.text(
      "Review canvas-exports/\(outputName) before confirming the export outcome.",
      "确认导出结果前，请检查 canvas-exports/\(outputName)。"
    )
    _ = actionCenter.resolveUnknown(
      .exportCanvas, correlationID: requestID, reconciliationID: reconciliationID,
      outcome: .stillUnknown(message)
    )
    statusLine = message
  }
}
