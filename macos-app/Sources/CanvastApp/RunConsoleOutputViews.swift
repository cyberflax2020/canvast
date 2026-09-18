import SwiftUI
import CanvastAppCore

enum ConsoleDisplayKind: Equatable {
  case system
  case output
  case error
  case input
  case process

  func title(localizer: CanvastLocalizer) -> String {
    switch self {
    case .system: return localizer.text("Canvast", "Canvast")
    case .output: return localizer.text("Output", "输出")
    case .error: return localizer.text("Error", "错误")
    case .input: return localizer.text("Input", "输入")
    case .process: return localizer.text("Process", "过程")
    }
  }

  var symbol: String {
    switch self {
    case .system: return "sparkles"
    case .output: return "text.alignleft"
    case .error: return "exclamationmark.triangle"
    case .input: return "person.crop.circle"
    case .process: return "gearshape.2"
    }
  }

  var color: Color {
    switch self {
    case .system: return .blue
    case .output: return .primary
    case .error: return .red
    case .input: return .accentColor
    case .process: return .secondary
    }
  }
}

enum ConsoleDisplaySource: Equatable {
  case raw
  case conversation
}

struct ConsoleDisplayEntry: Identifiable, Equatable {
  let id: String
  let timestamp: Date?
  let timestampFallback: String
  let kind: ConsoleDisplayKind
  var text: String
  let source: ConsoleDisplaySource

  init(raw entry: ConsoleEntry) {
    self.id = "raw-\(entry.id.uuidString)"
    self.timestamp = entry.timestamp
    self.timestampFallback = ""
    switch entry.channel {
    case .system:
      self.kind = .system
    case .standardOutput:
      self.kind = .output
    case .standardError:
      self.kind = .error
    }
    self.text = entry.text
    self.source = .raw
  }

  init(message: SessionTimelineMessage, index: Int) {
    self.id = "conversation-\(index)-\(message.id)"
    self.timestamp = RunConsoleDisplayProjection.parseTimestamp(message.timestamp)
    self.timestampFallback = message.timestamp
    switch message.role {
    case .user:
      self.kind = .input
    case .assistant:
      self.kind = .output
    case .process:
      self.kind = .process
    }
    self.text = message.text
    self.source = .conversation
  }
}

struct RunConsoleDisplayProjection {
  static func entries(
    rawConsoleEntries: [ConsoleEntry],
    conversationMessages: [SessionTimelineMessage]
  ) -> [ConsoleDisplayEntry] {
    let conversationEntries = conversationMessages.enumerated().compactMap { index, message -> ConsoleDisplayEntry? in
      guard !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
      return ConsoleDisplayEntry(message: message, index: index)
    }
    guard !conversationEntries.isEmpty else {
      return groupAdjacentRawOutput(rawConsoleEntries.map(ConsoleDisplayEntry.init(raw:)))
    }

    var seenConversationText = Set(conversationEntries.map { normalizedText($0.text) })
    var entries = conversationEntries
    for rawEntry in rawConsoleEntries.map(ConsoleDisplayEntry.init(raw:)) {
      let normalized = normalizedText(rawEntry.text)
      if !normalized.isEmpty, seenConversationText.contains(normalized) { continue }
      entries.append(rawEntry)
      if !normalized.isEmpty { seenConversationText.insert(normalized) }
    }
    return groupAdjacentRawOutput(entries.sorted(by: precedes))
  }

  static func parseTimestamp(_ value: String) -> Date? {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    return ISO8601DateFormatter().date(from: trimmed)
  }

  private static func groupAdjacentRawOutput(_ entries: [ConsoleDisplayEntry]) -> [ConsoleDisplayEntry] {
    var grouped: [ConsoleDisplayEntry] = []
    for entry in entries {
      guard let last = grouped.last,
            last.source == .raw,
            entry.source == .raw,
            last.kind == entry.kind,
            shouldGroupRawOutput(last, entry) else {
        grouped.append(entry)
        continue
      }
      var merged = last
      merged.text += "\n\(entry.text)"
      grouped[grouped.count - 1] = merged
    }
    return grouped
  }

  private static func shouldGroupRawOutput(_ previous: ConsoleDisplayEntry, _ next: ConsoleDisplayEntry) -> Bool {
    guard previous.kind == .output || previous.kind == .error else { return false }
    guard let previousTimestamp = previous.timestamp,
          let nextTimestamp = next.timestamp else { return false }
    return nextTimestamp.timeIntervalSince(previousTimestamp) <= 1.2
  }

  private static func precedes(_ lhs: ConsoleDisplayEntry, _ rhs: ConsoleDisplayEntry) -> Bool {
    switch (lhs.timestamp, rhs.timestamp) {
    case let (left?, right?):
      if left == right { return lhs.id < rhs.id }
      return left < right
    case (_?, nil):
      return true
    case (nil, _?):
      return false
    case (nil, nil):
      return lhs.id < rhs.id
    }
  }

  private static func normalizedText(_ value: String) -> String {
    value
      .replacingOccurrences(of: "User input:", with: "")
      .replacingOccurrences(of: "用户输入：", with: "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }
}

struct ConsoleOutputView: View {
  let entries: [ConsoleDisplayEntry]
  let followsOutput: Bool
  @EnvironmentObject private var model: CanvastDesktopModel

  private let bottomID = "canvast-console-bottom"

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        if entries.isEmpty {
          VStack(spacing: 8) {
            Image(systemName: "terminal")
              .font(.title2)
              .foregroundStyle(.tertiary)
            Text(model.localizer.text("Console is ready", "控制台已就绪"))
              .font(.headline)
            Text(model.localizer.text(
              "Preview or run to see user input, visible process events, tool results, final answers, and system messages here.",
              "预览或运行后，用户输入、可见过程、工具结果、最终回复和系统消息会显示在这里。"
            ))
              .font(.caption)
              .foregroundStyle(.secondary)
              .multilineTextAlignment(.center)
          }
          .frame(maxWidth: .infinity, minHeight: 150)
          .padding()
        } else {
          LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(entries) { entry in
              ConsoleEntryRow(entry: entry)
              Divider().padding(.leading, 14)
            }
            Color.clear.frame(height: 1).id(bottomID)
          }
        }
      }
      .background(Color(nsColor: .textBackgroundColor).opacity(0.72))
      .onAppear { scrollToBottom(using: proxy, animated: false) }
      .onChange(of: entries) { _ in
        scrollToBottom(using: proxy, animated: true)
      }
      .onChange(of: followsOutput) { enabled in
        if enabled { scrollToBottom(using: proxy, animated: true) }
      }
    }
  }

  private func scrollToBottom(using proxy: ScrollViewProxy, animated: Bool) {
    guard followsOutput, !entries.isEmpty else { return }
    if animated {
      withAnimation(.easeOut(duration: 0.18)) {
        proxy.scrollTo(bottomID, anchor: .bottom)
      }
    } else {
      proxy.scrollTo(bottomID, anchor: .bottom)
    }
  }
}

private struct ConsoleEntryRow: View {
  let entry: ConsoleDisplayEntry
  @EnvironmentObject private var model: CanvastDesktopModel

  var body: some View {
    HStack(alignment: .top, spacing: 9) {
      RoundedRectangle(cornerRadius: 1)
        .fill(entry.kind.color)
        .frame(width: 3)

      timestampText
        .frame(width: 72, alignment: .leading)

      HStack(spacing: 4) {
        Image(systemName: entry.kind.symbol)
        Text(entry.kind.title(localizer: model.localizer))
      }
      .font(.system(size: 11, weight: .semibold))
      .foregroundStyle(entry.kind.color)
      .frame(width: 76, alignment: .leading)

      Text(verbatim: entry.text)
        .font(.system(size: 12, design: .monospaced))
        .foregroundStyle(entry.kind.color)
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
    .background(rowBackground)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(
      "\(CanvastLocalizationRuntime.localizer.text("Channel", "通道"))：\(entry.kind.title(localizer: model.localizer))，\(entry.text)"
    )
  }

  @ViewBuilder
  private var timestampText: some View {
    if let timestamp = entry.timestamp {
      Text(timestamp, format: .dateTime.hour().minute().second())
        .font(.system(size: 11, design: .monospaced))
        .foregroundStyle(.tertiary)
    } else if !entry.timestampFallback.isEmpty {
      Text(entry.timestampFallback)
        .font(.system(size: 10, design: .monospaced))
        .foregroundStyle(.tertiary)
    } else {
      Text("-")
        .font(.system(size: 11, design: .monospaced))
        .foregroundStyle(.tertiary)
    }
  }

  private var rowBackground: Color {
    switch entry.kind {
    case .system, .input, .process:
      return entry.kind.color.opacity(0.045)
    case .output:
      return .clear
    case .error:
      return entry.kind.color.opacity(0.065)
    }
  }
}
