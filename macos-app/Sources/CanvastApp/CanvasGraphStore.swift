import Foundation
import CanvastAppCore

struct CanvasGraphStore {
  private let decoder = JSONDecoder()

  func load(from stateDirectory: URL) -> CanvasGraphSnapshot {
    let file = stateDirectory.appendingPathComponent("canvas-graph.json")
    guard FileManager.default.fileExists(atPath: file.path) else {
      return CanvasGraphSnapshot(
        nodes: [],
        edges: [],
        loadedAt: nil,
        source: .noPersistedGraph
      )
    }

    do {
      let data = try Data(contentsOf: file)
      let document = try decoder.decode(PersistedCanvasGraph.self, from: data)
      let nodes = document.nodes.compactMap(makeNode)
      let knownIDs = Set(nodes.map(\.id))
      let edges = document.edges.compactMap { edge -> CanvasGraphEdge? in
        guard knownIDs.contains(edge.fromNodeId), knownIDs.contains(edge.toNodeId) else { return nil }
        return CanvasGraphEdge(
          id: edge.id ?? "\(edge.type):\(edge.fromNodeId):\(edge.toNodeId)",
          type: edge.type,
          sourceID: edge.fromNodeId,
          targetID: edge.toNodeId
        )
      }
      return CanvasGraphSnapshot(
        nodes: nodes,
        edges: edges,
        loadedAt: Date(),
        source: .loaded(nodeCount: nodes.count, edgeCount: edges.count)
      )
    } catch {
      return CanvasGraphSnapshot(
        nodes: [],
        edges: [],
        loadedAt: Date(),
        source: .decodeFailure(error.localizedDescription)
      )
    }
  }

  private func makeNode(_ source: PersistedCanvasNode) -> CanvasGraphNode? {
    guard let kind = CanvasNodeKind(rawValue: source.type) else { return nil }
    let properties = source.properties ?? [:]
    let title = firstText(
      in: properties,
      keys: ["goal", "path", "chosen", "task", "content", "problem", "summary"]
    ) ?? source.id

    return CanvasGraphNode(
      id: source.id,
      type: kind,
      title: title,
      subtitleText: subtitle(kind: kind, properties: properties),
      detailRows: detailRows(kind: kind, properties: properties)
    )
  }

  private func detailRows(kind: CanvasNodeKind, properties: [String: JSONValue]) -> [CanvasDetailRow] {
    let keys: [(String, CanvasLocalizedText)]
    switch kind {
    case .plan:
      keys = [
        ("status", CanvasLocalizedText("Status", "状态")),
        ("constraints", CanvasLocalizedText("Constraints", "约束")),
        ("approvedBy", CanvasLocalizedText("Approved by", "批准人")),
        ("approvedAt", CanvasLocalizedText("Approved at", "批准时间"))
      ]
    case .decision:
      keys = [
        ("problem", CanvasLocalizedText("Problem", "问题")),
        ("rationale", CanvasLocalizedText("Rationale", "依据")),
        ("alternatives", CanvasLocalizedText("Alternatives", "备选方案")),
        ("madeBy", CanvasLocalizedText("Made by", "决策人")),
        ("stillValid", CanvasLocalizedText("Still valid", "仍然有效"))
      ]
    case .file:
      keys = [
        ("path", CanvasLocalizedText("Path", "路径")),
        ("language", CanvasLocalizedText("Language", "语言")),
        ("version", CanvasLocalizedText("Version", "版本")),
        ("stale", CanvasLocalizedText("Stale", "已过时")),
        ("lastModified", CanvasLocalizedText("Modified", "修改时间"))
      ]
    case .agentRun:
      keys = [
        ("status", CanvasLocalizedText("Status", "状态")),
        ("agentType", CanvasLocalizedText("Agent type", "Agent 类型")),
        ("model", CanvasLocalizedText("Model", "模型")),
        ("depth", CanvasLocalizedText("Depth", "深度")),
        ("summary", CanvasLocalizedText("Summary", "摘要")),
        ("errorMessage", CanvasLocalizedText("Error", "错误"))
      ]
    }
    return keys.compactMap { key, labelText in
      guard let value = properties[key]?.canvasGraphValue,
            !value.displayText(localizer: CanvastLocalizationRuntime.localizer).isEmpty else { return nil }
      return CanvasDetailRow(labelText: labelText, valueSource: value)
    }
  }

  private func subtitle(kind: CanvasNodeKind, properties: [String: JSONValue]) -> CanvasTextLine {
    switch kind {
    case .plan:
      return CanvasTextLine(
        components: subtitleComponents(properties, keys: ["status", "approvedBy"]),
        fallback: CanvasLocalizedText("Plan state", "计划状态")
      )
    case .decision:
      return CanvasTextLine(
        components: firstScalarValue(in: properties, keys: ["rationale", "decisionType"]).map { [$0] } ?? [],
        fallback: CanvasLocalizedText("Project decision", "项目决策")
      )
    case .file:
      return CanvasTextLine(
        components: subtitleComponents(properties, keys: ["language", "version"]),
        fallback: CanvasLocalizedText("Project file", "项目文件")
      )
    case .agentRun:
      return CanvasTextLine(
        components: subtitleComponents(properties, keys: ["status", "agentType", "model"]),
        fallback: CanvasLocalizedText("Agent execution", "Agent 执行")
      )
    }
  }

  private func firstText(in properties: [String: JSONValue], keys: [String]) -> String? {
    for key in keys {
      guard let value = properties[key]?.scalarText?.trimmingCharacters(in: .whitespacesAndNewlines),
            !value.isEmpty else { continue }
      return value
    }
    return nil
  }

  private func firstScalarValue(in properties: [String: JSONValue], keys: [String]) -> CanvasGraphValue? {
    for key in keys {
      guard let value = properties[key]?.scalarGraphValue,
            !value.displayText(localizer: CanvastLocalizationRuntime.localizer).isEmpty else { continue }
      return value
    }
    return nil
  }

  private func subtitleComponents(_ properties: [String: JSONValue], keys: [String]) -> [CanvasGraphValue] {
    keys.compactMap { key in
      guard let value = properties[key]?.scalarGraphValue,
            !value.displayText(localizer: CanvastLocalizationRuntime.localizer).isEmpty else { return nil }
      return value
    }
  }
}

private struct PersistedCanvasGraph: Decodable {
  let nodes: [PersistedCanvasNode]
  let edges: [PersistedCanvasEdge]
}

private struct PersistedCanvasNode: Decodable {
  let id: String
  let type: String
  let properties: [String: JSONValue]?
}

private struct PersistedCanvasEdge: Decodable {
  let id: String?
  let type: String
  let fromNodeId: String
  let toNodeId: String
}

private enum JSONValue: Decodable {
  case string(String)
  case number(Double)
  case bool(Bool)
  case array([JSONValue])
  case object([String: JSONValue])
  case null

  init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() { self = .null; return }
    if let value = try? container.decode(Bool.self) { self = .bool(value); return }
    if let value = try? container.decode(Double.self) { self = .number(value); return }
    if let value = try? container.decode(String.self) { self = .string(value); return }
    if let value = try? container.decode([JSONValue].self) { self = .array(value); return }
    if let value = try? container.decode([String: JSONValue].self) { self = .object(value); return }
    throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported Canvas property value")
  }

  var scalarText: String? {
    switch self {
    case .string(let value): return value
    case .number(let value):
      return value.rounded() == value ? String(Int(value)) : String(value)
    case .bool(let value): return value ? "true" : "false"
    case .array, .object, .null: return nil
    }
  }

  var scalarGraphValue: CanvasGraphValue? {
    switch self {
    case .string(let value):
      let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
      return trimmed.isEmpty ? nil : .text(trimmed)
    case .number(let value):
      return .text(value.rounded() == value ? String(Int(value)) : String(value))
    case .bool(let value):
      return .bool(value)
    case .array, .object, .null:
      return nil
    }
  }

  var canvasGraphValue: CanvasGraphValue {
    switch self {
    case .string(let value):
      return .text(value)
    case .number(let value):
      return .text(value.rounded() == value ? String(Int(value)) : String(value))
    case .bool(let value):
      return .bool(value)
    case .array(let values):
      return .list(values.map(\.canvasGraphValue))
    case .object(let values):
      return .object(values.keys.sorted().map { key in
        CanvasGraphNamedValue(key: key, value: values[key]?.canvasGraphValue ?? .text(""))
      })
    case .null:
      return .text("")
    }
  }

  var displayText: String {
    canvasGraphValue.displayText(localizer: CanvastLocalizationRuntime.localizer)
  }
}
