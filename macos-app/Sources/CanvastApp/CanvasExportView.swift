import Foundation
import SwiftUI

struct CanvasExportToolbarControl: View {
  @EnvironmentObject private var model: CanvastDesktopModel
  @State private var outputName = "canvas-export"

  var body: some View {
    HStack(spacing: 6) {
      TextField(model.localizer.text("Export folder", "导出目录"), text: $outputName)
        .textFieldStyle(.roundedBorder)
        .frame(width: 150)
      Button { model.exportCanvas(outputName: outputName) } label: {
        Label(model.localizer.text("Export", "导出"), systemImage: "square.and.arrow.up")
      }
      .disabled(outputName.isEmpty || actionLocked(model, .exportCanvas))
      .help(model.localizer.text(
        "Export JSON, Markdown, Mermaid, SVG, and HTML",
        "导出 JSON、Markdown、Mermaid、SVG 和 HTML"
      ))
      if let snapshot = actionSnapshot(model, .exportCanvas), snapshot.supportsCancel {
        Button(model.localizer.text("Cancel", "取消")) { model.cancelAction(.exportCanvas) }
          .buttonStyle(.borderless)
      }
    }
  }
}

struct CanvasExportStatusView: View {
  @EnvironmentObject private var model: CanvastDesktopModel

  var body: some View {
    if let receipt = model.canvasExportReceipt {
      VStack(alignment: .leading, spacing: 6) {
        HStack {
          Label(model.localizer.text("Canvas export ready", "Canvas 导出已完成"), systemImage: "checkmark.circle.fill")
            .foregroundStyle(.green)
          Spacer()
          Text(exportCounts(receipt))
            .font(.caption).foregroundStyle(.secondary)
        }
        Text(receipt.outputDirectory).font(.caption.monospaced()).textSelection(.enabled)
        HStack(spacing: 8) {
          ForEach(receipt.files) { file in
            Text("\(file.format.uppercased()) · \(ByteCountFormatter.string(fromByteCount: Int64(file.bytes), countStyle: .file))")
              .font(.caption2).foregroundStyle(.secondary)
              .help(model.localizer.text(
                "\(file.name)\nSHA-256 checksum: \(file.sha256)",
                "\(file.name)\nSHA-256 校验值：\(file.sha256)"
              ))
          }
        }
      }
      .padding(10)
      .background(.green.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
    } else if let snapshot = actionSnapshot(model, .exportCanvas) {
      HStack(spacing: 8) {
        StatusBadge(
          text: snapshot.status.label,
          color: snapshot.status == .failed || snapshot.status == .timedOut ? .red : .blue
        )
        Text(snapshot.message).font(.caption).foregroundStyle(.secondary)
        Spacer()
        Text(snapshot.correlationID).font(.caption2.monospaced()).foregroundStyle(.tertiary)
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 7)
      .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
    }
  }

  private func exportCounts(_ receipt: DesktopCanvasExportReceipt) -> String {
    let nodes = model.localizer.counted(
      receipt.nodeCount, singularEnglish: "node", pluralEnglish: "nodes",
      simplifiedChineseSuffix: " 个节点"
    )
    let links = model.localizer.counted(
      receipt.edgeCount, singularEnglish: "link", pluralEnglish: "links",
      simplifiedChineseSuffix: " 条连接"
    )
    return "\(nodes) · \(links)"
  }
}
