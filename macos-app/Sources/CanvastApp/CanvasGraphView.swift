import AppKit
import SwiftUI
import CanvastAppCore

struct CanvasGraphView: View {
  @EnvironmentObject private var model: CanvastDesktopModel
  @Environment(\.canvastLocalizer) private var localizer
  @State private var zoom: CGFloat = 0
  @State private var pan: CGSize = .zero
  @State private var panStart: CGSize?
  @State private var magnificationStart: CGFloat?
  @State private var focusSelection = false

  private let nodeWidth: CGFloat = 238

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      WorkspaceTitle(
        workspace: .canvas,
        trailing: AnyView(StatusBadge(
          text: localizer.language == .english
            ? "\(model.canvasGraph.nodes.count) nodes · \(model.canvasGraph.edges.count) links"
            : "\(model.canvasGraph.nodes.count) 个节点 · \(model.canvasGraph.edges.count) 条连线",
          color: .blue,
          systemImage: "point.3.connected.trianglepath.dotted"
        ))
      )
      toolbar
      CanvasSelectionReceiptStrip(
        taskSelection: model.canvasTaskSelection,
        planSelection: model.canvasPlanSelection
      )
      CanvasExportStatusView()
      graphSurface
      footer
    }
    .padding(18)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .background(Color(nsColor: .windowBackgroundColor))
    .onChange(of: model.canvasSearch) { _ in focusSelection = false; resetViewport() }
    .onChange(of: model.canvasTypeFilter) { _ in focusSelection = false; resetViewport() }
    .onChange(of: model.selectedCanvasNodeID) { selected in
      if selected == nil { focusSelection = false }
    }
  }

  private var toolbar: some View {
    VStack(alignment: .leading, spacing: 10) {
      ViewThatFits(in: .horizontal) {
        HStack(alignment: .center, spacing: 8) {
          searchControls
          Spacer(minLength: 8)
          primaryCanvasActions
        }
        VStack(alignment: .leading, spacing: 8) {
          searchControls
          primaryCanvasActions
            .frame(maxWidth: .infinity, alignment: .trailing)
        }
      }
      if let node = model.selectedCanvasNode, node.type == .plan {
        selectedPlanAction(node)
      }
      Text(localizer.text(
        "Drag to pan. Use trackpad pinch or the zoom controls to change scale. Select a node to focus related work.",
        "拖动画布可平移。使用触控板捏合或缩放控件调整比例。选择节点后可聚焦相关工作。"
      ))
      .font(.caption)
      .foregroundStyle(.secondary)
      .fixedSize(horizontal: false, vertical: true)
    }
  }

  private var searchControls: some View {
    ViewThatFits(in: .horizontal) {
      HStack(spacing: 8) {
        TextField(localizer.text("Search node id, title, or details", "搜索节点 ID、标题或详情"), text: $model.canvasSearch)
          .textFieldStyle(.roundedBorder)
          .frame(minWidth: 230, idealWidth: 330, maxWidth: 420)

        Picker(localizer.text("Type", "类型"), selection: $model.canvasTypeFilter) {
          Text(localizer.text("All types", "全部类型")).tag(Optional<CanvasNodeKind>.none)
          ForEach(CanvasNodeKind.allCases) { kind in
            Label(kind.title, systemImage: kind.symbol).tag(Optional(kind))
          }
        }
        .frame(minWidth: 170)
      }
      VStack(alignment: .leading, spacing: 8) {
        TextField(localizer.text("Search node id, title, or details", "搜索节点 ID、标题或详情"), text: $model.canvasSearch)
          .textFieldStyle(.roundedBorder)
        Picker(localizer.text("Type", "类型"), selection: $model.canvasTypeFilter) {
          Text(localizer.text("All types", "全部类型")).tag(Optional<CanvasNodeKind>.none)
          ForEach(CanvasNodeKind.allCases) { kind in
            Label(kind.title, systemImage: kind.symbol).tag(Optional(kind))
          }
        }
      }
    }
  }

  private var primaryCanvasActions: some View {
    ViewThatFits(in: .horizontal) {
      HStack(spacing: 8) { actionButtons }
      VStack(alignment: .trailing, spacing: 8) { actionButtons }
    }
    .frame(maxWidth: .infinity, alignment: .trailing)
  }

  @ViewBuilder
  private var actionButtons: some View {
    Button { scale(by: 1.2) } label: { Label(localizer.text("Zoom In", "放大"), systemImage: "plus.magnifyingglass") }
      .help(localizer.text("Zoom in", "放大"))
    Button { scale(by: 1 / 1.2) } label: { Label(localizer.text("Zoom Out", "缩小"), systemImage: "minus.magnifyingglass") }
      .help(localizer.text("Zoom out", "缩小"))
    Button { resetViewport() } label: {
      Label(localizer.text("Fit", "适配"), systemImage: "arrow.up.left.and.arrow.down.right")
    }
    .help(localizer.text("Fit the visible graph", "适配可见图谱"))

    Button {
      focusSelection.toggle()
      resetViewport()
    } label: {
      Label(
        focusSelection
          ? localizer.text("Show All", "显示全部")
          : localizer.text("Focus", "聚焦"),
        systemImage: focusSelection ? "rectangle.expand.vertical" : "scope"
      )
    }
    .disabled(model.selectedCanvasNodeID == nil)
    .help(localizer.text("Show the selected node and its direct neighbors", "显示所选节点及其直接邻居"))

    CanvasExportToolbarControl()

    Button {
      model.refreshCanvas()
      resetViewport()
    } label: {
      Label(localizer.dynamic("refresh"), systemImage: "arrow.clockwise")
    }
    .disabled(actionLocked(model, .refreshCanvas))
  }

  @ViewBuilder
  private func selectedPlanAction(_ node: CanvasGraphNode) -> some View {
    if isTaskNode(node) {
      Button { model.selectCanvasTask(nodeID: node.id) } label: {
        Label(localizer.text("Use as Active Task", "设为当前任务"), systemImage: "scope")
      }
      .help(localizer.text("Explicitly use this Canvas task as the active task scope", "显式将此画布任务设为当前任务范围"))
      .disabled(actionLocked(model, .selectCanvasTask))
    } else {
      Button { model.selectCanvasPlan(planID: node.id) } label: {
        Label(localizer.text("Use as Active Plan", "设为当前计划"), systemImage: "checklist.checked")
      }
      .help(localizer.text("Explicitly use this Canvas plan for scope enforcement", "显式将此画布计划用于范围约束"))
      .disabled(actionLocked(model, .selectCanvasPlan))
    }
  }

  @ViewBuilder
  private var graphSurface: some View {
    if model.canvasGraph.nodes.isEmpty {
      EmptyState(
        title: localizer.text("Canvas is empty", "画布为空"),
        detail: model.canvasGraph.sourceDescription,
        systemImage: "point.3.connected.trianglepath.dotted"
      )
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
      .overlay(RoundedRectangle(cornerRadius: 10).stroke(.separator.opacity(0.55)))
    } else if renderedNodes.isEmpty {
      EmptyState(
        title: localizer.text("No nodes match", "没有匹配节点"),
        detail: localizer.text(
          "Clear search and type filters, or leave focus mode to restore the graph.",
          "清除搜索和类型筛选，或退出聚焦模式以恢复图谱。"
        ),
        systemImage: "magnifyingglass"
      )
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
      .overlay(RoundedRectangle(cornerRadius: 10).stroke(.separator.opacity(0.55)))
    } else {
      GeometryReader { geometry in
        let layout = GraphLayout(nodes: renderedNodes, nodeWidth: nodeWidth)
        let effectiveScale = currentScale(viewport: geometry.size, content: layout.contentSize)
        let origin = graphOrigin(viewport: geometry.size, content: layout.contentSize, scale: effectiveScale)
        let graphViewport = CanvasGraphPresentation.graphViewport(
          viewportSize: geometry.size,
          origin: origin,
          scale: effectiveScale
        )

        Canvas { context, size in
          drawGrid(context: &context, size: size, origin: origin, scale: effectiveScale)
          context.translateBy(x: origin.x, y: origin.y)
          context.scaleBy(x: effectiveScale, y: effectiveScale)
          drawEdges(context: &context, layout: layout, visibleRect: graphViewport)
          drawNodes(context: &context, layout: layout, visibleRect: graphViewport)
        }
        .contentShape(Rectangle())
        .gesture(panGesture)
        .simultaneousGesture(magnificationGesture(viewport: geometry.size, content: layout.contentSize))
        .simultaneousGesture(SpatialTapGesture().onEnded { event in
          selectNode(at: event.location, layout: layout, origin: origin, scale: effectiveScale)
        })
        .overlay(alignment: .topLeading) { layerLabels(layout: layout, origin: origin, scale: effectiveScale) }
        .overlay(alignment: .bottomTrailing) { viewportBadge(scale: effectiveScale) }
        .accessibilityLabel(localizer.text("Canvast project graph", "Canvast 项目图谱"))
        .accessibilityValue(localizer.language == .english
          ? "\(renderedNodes.count) visible nodes and \(renderedEdges.count) visible links"
          : "\(renderedNodes.count) 个可见节点，\(renderedEdges.count) 条可见连线")
      }
      .frame(minHeight: 420)
      .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
      .overlay(RoundedRectangle(cornerRadius: 10).stroke(.separator.opacity(0.65)))
      .clipped()
    }
  }

  private var footer: some View {
    HStack(spacing: 12) {
      ForEach(CanvasNodeKind.allCases) { kind in
        HStack(spacing: 5) {
          Circle().fill(kind.color).frame(width: 8, height: 8)
          Text("\(kind.title) \(visibleCount(kind))")
        }
      }
      .font(.caption)
      .foregroundStyle(.secondary)

      Spacer()

      Text(model.canvasGraph.sourceDescription)
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private var filteredNodes: [CanvasGraphNode] {
    CanvasGraphPresentation.filteredNodes(
      nodes: model.canvasGraph.nodes,
      query: model.canvasSearch,
      typeFilter: model.canvasTypeFilter
    )
  }

  private var renderedNodes: [CanvasGraphNode] {
    CanvasGraphPresentation.renderedNodes(
      allNodes: model.canvasGraph.nodes,
      filteredNodes: filteredNodes,
      edges: model.canvasGraph.edges,
      focusSelection: focusSelection,
      selectedNodeID: model.selectedCanvasNodeID
    )
  }

  private var renderedEdges: [CanvasGraphEdge] {
    let ids = Set(renderedNodes.map(\.id))
    return model.canvasGraph.edges.filter { ids.contains($0.sourceID) && ids.contains($0.targetID) }
  }

  private var panGesture: some Gesture {
    DragGesture(minimumDistance: 3)
      .onChanged { value in
        if panStart == nil { panStart = pan }
        guard let panStart else { return }
        pan = CGSize(width: panStart.width + value.translation.width, height: panStart.height + value.translation.height)
      }
      .onEnded { _ in panStart = nil }
  }

  private func magnificationGesture(viewport: CGSize, content: CGSize) -> some Gesture {
    MagnificationGesture()
      .onChanged { value in
        if magnificationStart == nil { magnificationStart = currentScale(viewport: viewport, content: content) }
        guard let magnificationStart else { return }
        zoom = clampedScale(magnificationStart * value)
      }
      .onEnded { _ in magnificationStart = nil }
  }

  private func drawGrid(context: inout GraphicsContext, size: CGSize, origin: CGPoint, scale: CGFloat) {
    let spacing = max(18, 34 * scale)
    let offsetX = origin.x.truncatingRemainder(dividingBy: spacing)
    let offsetY = origin.y.truncatingRemainder(dividingBy: spacing)
    var path = Path()
    var x = offsetX
    while x < size.width { path.move(to: CGPoint(x: x, y: 0)); path.addLine(to: CGPoint(x: x, y: size.height)); x += spacing }
    var y = offsetY
    while y < size.height { path.move(to: CGPoint(x: 0, y: y)); path.addLine(to: CGPoint(x: size.width, y: y)); y += spacing }
    context.stroke(path, with: .color(Color.secondary.opacity(0.07)), lineWidth: 0.7)
  }

  private func drawEdges(context: inout GraphicsContext, layout: GraphLayout, visibleRect: CGRect) {
    let visibleEdges = CanvasGraphPresentation.visibleEdges(
      renderedEdges: renderedEdges,
      layout: layout,
      visibleRect: visibleRect
    )

    for edge in visibleEdges {
      guard let source = layout.rects[edge.sourceID], let target = layout.rects[edge.targetID] else { continue }
      let start = CGPoint(x: source.maxX, y: source.midY)
      let end = CGPoint(x: target.minX, y: target.midY)
      let controlOffset = max(38, abs(end.x - start.x) * 0.42)
      var path = Path()
      path.move(to: start)
      path.addCurve(
        to: end,
        control1: CGPoint(x: start.x + controlOffset, y: start.y),
        control2: CGPoint(x: end.x - controlOffset, y: end.y)
      )
      let highlighted = edge.sourceID == model.selectedCanvasNodeID || edge.targetID == model.selectedCanvasNodeID
      let color = edgeColor(edge.type)
      context.stroke(path, with: .color(color.opacity(highlighted ? 0.95 : 0.4)), lineWidth: highlighted ? 2.3 : 1.15)
      drawArrow(context: &context, at: end, color: color, highlighted: highlighted)

      if highlighted {
        let midpoint = CGPoint(x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 - 7)
        let label = context.resolve(
          Text(humanized(edge.type)).font(.system(size: 9, weight: .medium)).foregroundColor(color)
        )
        context.draw(label, at: midpoint, anchor: .center)
      }
    }
  }

  private func drawArrow(context: inout GraphicsContext, at point: CGPoint, color: Color, highlighted: Bool) {
    var arrow = Path()
    arrow.move(to: CGPoint(x: point.x - 9, y: point.y - 5))
    arrow.addLine(to: point)
    arrow.addLine(to: CGPoint(x: point.x - 9, y: point.y + 5))
    context.stroke(arrow, with: .color(color.opacity(highlighted ? 1 : 0.55)), lineWidth: highlighted ? 2.3 : 1.2)
  }

  private func drawNodes(context: inout GraphicsContext, layout: GraphLayout, visibleRect: CGRect) {
    let visibleNodes = CanvasGraphPresentation.visibleNodes(
      renderedNodes: renderedNodes,
      layout: layout,
      visibleRect: visibleRect
    )

    for node in visibleNodes {
      guard let rect = layout.rects[node.id] else { continue }
      let selected = node.id == model.selectedCanvasNodeID
      let fill = selected ? node.type.color.opacity(0.22) : Color(nsColor: .windowBackgroundColor).opacity(0.96)
      let outline = selected ? node.type.color : node.type.color.opacity(0.55)
      context.fill(Path(roundedRect: rect, cornerRadius: 11), with: .color(fill))
      context.stroke(Path(roundedRect: rect, cornerRadius: 11), with: .color(outline), lineWidth: selected ? 3 : 1.3)

      let marker = CGRect(x: rect.minX, y: rect.minY, width: 7, height: rect.height)
      context.fill(Path(roundedRect: marker, cornerRadius: 3), with: .color(node.type.color))

      let textLayout = CanvasGraphPresentation.nodeTextLayout(node)
      var title = context.resolve(Text(textLayout.title.renderedText)
      .font(.system(size: 12, weight: .semibold))
      .foregroundColor(.primary))
      title.shading = .color(.primary)
      let titleHeight = CGFloat(textLayout.title.lines.count) * 15
      context.draw(title, in: CGRect(
        x: rect.minX + 18, y: rect.minY + 12,
        width: rect.width - 36, height: titleHeight
      ))

      var subtitle = context.resolve(Text(textLayout.subtitle.renderedText)
      .font(.system(size: 9.5))
      .foregroundColor(.secondary))
      subtitle.shading = .color(.secondary)
      let subtitleHeight = CGFloat(textLayout.subtitle.lines.count) * 12
      context.draw(subtitle, in: CGRect(
        x: rect.minX + 18, y: rect.minY + 18 + titleHeight,
        width: rect.width - 36, height: subtitleHeight
      ))

      var id = context.resolve(
        Text(textLayout.id.renderedText)
          .font(.system(size: 8.5, design: .monospaced))
          .foregroundColor(.secondary.opacity(0.75))
      )
      id.shading = .color(.secondary.opacity(0.75))
      context.draw(id, in: CGRect(
        x: rect.minX + 18, y: rect.minY + 24 + titleHeight + subtitleHeight,
        width: rect.width - 36, height: CGFloat(textLayout.id.lines.count) * 10
      ))
    }
  }

  private func layerLabels(layout: GraphLayout, origin: CGPoint, scale: CGFloat) -> some View {
    ZStack(alignment: .topLeading) {
      ForEach(layout.nonemptyKinds) { kind in
        if let x = layout.layerX[kind] {
          Label(kind.title, systemImage: kind.symbol)
            .font(.caption.weight(.semibold))
            .foregroundStyle(kind.color)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(.regularMaterial, in: Capsule())
            .offset(x: origin.x + (x - nodeWidth / 2) * scale, y: max(8, origin.y + 8 * scale))
        }
      }
    }
    .allowsHitTesting(false)
  }

  private func viewportBadge(scale: CGFloat) -> some View {
    Text("\(Int((scale * 100).rounded()))%")
      .font(.caption2.monospacedDigit())
      .foregroundStyle(.secondary)
      .padding(.horizontal, 7)
      .padding(.vertical, 4)
      .background(.regularMaterial, in: Capsule())
      .padding(10)
  }

  private func selectNode(at location: CGPoint, layout: GraphLayout, origin: CGPoint, scale: CGFloat) {
    let point = CGPoint(x: (location.x - origin.x) / scale, y: (location.y - origin.y) / scale)
    let hit = renderedNodes.last { node in
      layout.rects[node.id]?.insetBy(dx: -4, dy: -4).contains(point) == true
    }
    model.focusCanvasNode(hit?.id)
    model.statusLine = hit.map {
      localizer.text(
        "Selected Canvas node \($0.id) for visual inspection",
        "已选择画布节点 \($0.id) 供视觉检查"
      )
    } ?? localizer.text("Canvas visual selection cleared", "已清除画布视觉选择")
  }

  private func isTaskNode(_ node: CanvasGraphNode) -> Bool {
    model.canvasGraph.edges.contains { edge in
      edge.type == "DECOMPOSES_INTO" && edge.targetID == node.id
    }
  }

  private func graphOrigin(viewport: CGSize, content: CGSize, scale: CGFloat) -> CGPoint {
    CGPoint(
      x: (viewport.width - content.width * scale) / 2 + pan.width,
      y: (viewport.height - content.height * scale) / 2 + pan.height
    )
  }

  private func currentScale(viewport: CGSize, content: CGSize) -> CGFloat {
    if zoom > 0 { return zoom }
    let widthScale = max(0.1, (viewport.width - 40) / max(content.width, 1))
    let heightScale = max(0.1, (viewport.height - 40) / max(content.height, 1))
    return clampedScale(min(widthScale, heightScale, 1.15))
  }

  private func scale(by factor: CGFloat) {
    zoom = clampedScale((zoom > 0 ? zoom : 1) * factor)
  }

  private func clampedScale(_ proposed: CGFloat) -> CGFloat { min(max(proposed, 0.22), 2.5) }

  private func resetViewport() { zoom = 0; pan = .zero }

  private func visibleCount(_ kind: CanvasNodeKind) -> Int { renderedNodes.filter { $0.type == kind }.count }

  private func edgeColor(_ type: String) -> Color {
    switch type {
    case "MOTIVATED_BY": return .purple
    case "PRODUCED_BY": return .teal
    case "DECOMPOSES_INTO": return .blue
    case "EXECUTED_BY": return .orange
    default: return .secondary
    }
  }

}

enum CanvasGraphPresentation {
  static func filteredNodes(
    nodes: [CanvasGraphNode],
    query: String,
    typeFilter: CanvasNodeKind?
  ) -> [CanvasGraphNode] {
    let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return nodes.filter { node in
      if let typeFilter, node.type != typeFilter { return false }
      return normalized.isEmpty || node.searchText.contains(normalized)
    }
  }

  static func renderedNodes(
    allNodes: [CanvasGraphNode],
    filteredNodes: [CanvasGraphNode],
    edges: [CanvasGraphEdge],
    focusSelection: Bool,
    selectedNodeID: String?
  ) -> [CanvasGraphNode] {
    guard focusSelection, let selectedNodeID else { return filteredNodes }
    let neighbors = Set(edges.compactMap { edge -> String? in
      if edge.sourceID == selectedNodeID { return edge.targetID }
      if edge.targetID == selectedNodeID { return edge.sourceID }
      return nil
    } + [selectedNodeID])
    return allNodes.filter { neighbors.contains($0.id) }
  }

  fileprivate static func visibleNodes(
    renderedNodes: [CanvasGraphNode],
    layout: GraphLayout,
    visibleRect: CGRect
  ) -> [CanvasGraphNode] {
    let drawingViewport = visibleRect.insetBy(dx: -layout.maximumNodeWidth, dy: -layout.maximumNodeHeight)
    return renderedNodes.filter { node in
      layout.rects[node.id]?.intersects(drawingViewport) == true
    }
  }

  fileprivate static func visibleEdges(
    renderedEdges: [CanvasGraphEdge],
    layout: GraphLayout,
    visibleRect: CGRect
  ) -> [CanvasGraphEdge] {
    let expanded = visibleRect.insetBy(dx: -layout.maximumNodeWidth, dy: -layout.maximumNodeHeight)
    return renderedEdges.filter { edge in
      guard let sourceRect = layout.rects[edge.sourceID],
            let targetRect = layout.rects[edge.targetID] else { return false }
      let corridor = sourceRect.union(targetRect).insetBy(dx: -36, dy: -24)
      return sourceRect.intersects(expanded) || targetRect.intersects(expanded) || corridor.intersects(expanded)
    }
  }

  static func graphViewport(viewportSize: CGSize, origin: CGPoint, scale: CGFloat) -> CGRect {
    let effectiveScale = max(scale, 0.001)
    return CGRect(
      x: -origin.x / effectiveScale,
      y: -origin.y / effectiveScale,
      width: viewportSize.width / effectiveScale,
      height: viewportSize.height / effectiveScale
    )
  }

  static func normalizedCanvasText(_ text: String) -> String {
    text
      .replacingOccurrences(of: "\r\n", with: "\n")
      .replacingOccurrences(of: "\r", with: "\n")
  }

  static func measuredWidth(of text: String, font: NSFont) -> CGFloat {
    ceil((text as NSString).size(withAttributes: [.font: font]).width)
  }

  static func wrappedText(_ text: String, maximumWidth: CGFloat, font: NSFont) -> CanvasWrappedText {
    let normalized = normalizedCanvasText(text)
    guard maximumWidth > 0 else {
      return CanvasWrappedText(segments: [CanvasWrappedSegment(text: normalized, sourceLineBreakAfter: false)])
    }

    var segments: [CanvasWrappedSegment] = []
    var current = ""
    for character in normalized {
      if character == "\n" {
        segments.append(CanvasWrappedSegment(text: current, sourceLineBreakAfter: true))
        current = ""
        continue
      }

      let candidate = current + String(character)
      if !current.isEmpty && measuredWidth(of: candidate, font: font) > maximumWidth {
        segments.append(CanvasWrappedSegment(text: current, sourceLineBreakAfter: false))
        current = String(character)
      } else {
        current = candidate
      }
    }
    segments.append(CanvasWrappedSegment(text: current, sourceLineBreakAfter: false))
    return CanvasWrappedText(segments: segments)
  }

  static func nodeTextLayout(_ node: CanvasGraphNode) -> CanvasNodeTextLayout {
    let availableWidth: CGFloat = 194
    return CanvasNodeTextLayout(
      title: wrappedText(
        node.title,
        maximumWidth: availableWidth,
        font: .systemFont(ofSize: 12, weight: .semibold)
      ),
      subtitle: wrappedText(
        node.subtitle,
        maximumWidth: availableWidth,
        font: .systemFont(ofSize: 9.5)
      ),
      id: wrappedText(
        node.id,
        maximumWidth: availableWidth,
        font: .monospacedSystemFont(ofSize: 8.5, weight: .regular)
      )
    )
  }
}

struct CanvasWrappedSegment: Equatable {
  let text: String
  let sourceLineBreakAfter: Bool
}

struct CanvasWrappedText: Equatable {
  let segments: [CanvasWrappedSegment]

  var lines: [String] { segments.map(\.text) }
  var renderedText: String { lines.joined(separator: "\n") }
  var sourceText: String {
    segments.map { segment in
      segment.text + (segment.sourceLineBreakAfter ? "\n" : "")
    }.joined()
  }
}

struct CanvasNodeTextLayout {
  let title: CanvasWrappedText
  let subtitle: CanvasWrappedText
  let id: CanvasWrappedText

  var height: CGFloat {
    let titleHeight = CGFloat(title.lines.count) * 15
    let subtitleHeight = CGFloat(subtitle.lines.count) * 12
    let idHeight = CGFloat(id.lines.count) * 10
    return max(84, 34 + titleHeight + subtitleHeight + idHeight)
  }
}

fileprivate struct GraphLayout {
  let rects: [String: CGRect]
  let layerX: [CanvasNodeKind: CGFloat]
  let nonemptyKinds: [CanvasNodeKind]
  let contentSize: CGSize
  let maximumNodeWidth: CGFloat
  let maximumNodeHeight: CGFloat

  init(nodes: [CanvasGraphNode], nodeWidth: CGFloat) {
    let horizontalGap: CGFloat = 92
    let verticalGap: CGFloat = 42
    let inset: CGFloat = 42
    let kinds = CanvasNodeKind.allCases.filter { kind in nodes.contains { $0.type == kind } }
    var nextRects: [String: CGRect] = [:]
    var nextLayerX: [CanvasNodeKind: CGFloat] = [:]
    var maximumColumnHeight: CGFloat = 0
    var maximumHeight: CGFloat = 0

    for (column, kind) in kinds.enumerated() {
      let grouped = nodes.filter { $0.type == kind }.sorted { lhs, rhs in
        lhs.title.localizedStandardCompare(rhs.title) == .orderedAscending
      }
      let x = inset + nodeWidth / 2 + CGFloat(column) * (nodeWidth + horizontalGap)
      nextLayerX[kind] = x
      var y = inset + 38
      for node in grouped {
        let height = CanvasGraphPresentation.nodeTextLayout(node).height
        nextRects[node.id] = CGRect(x: x - nodeWidth / 2, y: y, width: nodeWidth, height: height)
        y += height + verticalGap
        maximumHeight = max(maximumHeight, height)
      }
      maximumColumnHeight = max(maximumColumnHeight, y - verticalGap)
    }

    let columnCount = max(1, kinds.count)
    self.rects = nextRects
    self.layerX = nextLayerX
    self.nonemptyKinds = kinds
    self.maximumNodeWidth = nodeWidth
    self.maximumNodeHeight = maximumHeight
    self.contentSize = CGSize(
      width: inset * 2 + CGFloat(columnCount) * nodeWidth + CGFloat(max(0, columnCount - 1)) * horizontalGap,
      height: max(inset * 2 + 38, maximumColumnHeight + inset)
    )
  }
}
