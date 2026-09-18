import SwiftUI
import CanvastAppCore

enum SessionTimelineRole: Equatable {
  case user
  case assistant
  case process

  init(entryRole: String?, entryType: String) {
    switch entryRole?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
    case "user":
      self = .user
    case "assistant":
      self = .assistant
    case "system", "tool", "custom":
      self = .process
    default:
      self = entryType == "message" ? .assistant : .process
    }
  }

  var symbol: String {
    switch self {
    case .user: return "person.crop.circle"
    case .assistant: return "sparkles"
    case .process: return "gearshape.2"
    }
  }

  var accent: Color {
    switch self {
    case .user: return .accentColor
    case .assistant: return .green
    case .process: return .secondary
    }
  }

  func title(localizer: CanvastLocalizer) -> String {
    switch self {
    case .user: return localizer.text("You", "你")
    case .assistant: return localizer.text("Canvast", "Canvast")
    case .process: return localizer.text("Process", "过程")
    }
  }
}

struct SessionTimelineMessage: Identifiable, Equatable {
  let id: String
  let role: SessionTimelineRole
  let eventType: String
  let timestamp: String
  let text: String
  let isStreaming: Bool

  init(
    id: String,
    role: SessionTimelineRole,
    eventType: String = "",
    timestamp: String,
    text: String,
    isStreaming: Bool = false
  ) {
    self.id = id
    self.role = role
    self.eventType = eventType
    self.timestamp = timestamp
    self.text = text
    self.isStreaming = isStreaming
  }

  init(entry: DesktopSessionTranscriptEntry, index: Int) {
    let stableID = entry.id.trimmingCharacters(in: .whitespacesAndNewlines)
    self.id = stableID.isEmpty ? "transcript-\(index)" : stableID
    self.role = SessionTimelineRole(entryRole: entry.role, entryType: entry.type)
    self.eventType = entry.type
    self.timestamp = entry.timestamp
    self.text = entry.text
    self.isStreaming = false
  }

  init(live: DesktopLiveSessionMessage) {
    self.id = live.id
    switch live.role {
    case .user: self.role = .user
    case .assistant: self.role = .assistant
    case .process: self.role = .process
    }
    self.eventType = live.eventType
    self.timestamp = live.timestamp
    self.text = live.text
    self.isStreaming = live.isStreaming
  }
}

struct SessionMessageBubble: View {
  @EnvironmentObject private var model: CanvastDesktopModel
  let message: SessionTimelineMessage

  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      if message.role == .user { Spacer(minLength: 40) }
      Image(systemName: message.role.symbol)
        .font(.caption.weight(.semibold))
        .foregroundStyle(message.role.accent)
        .frame(width: 24, height: 24)
        .background(message.role.accent.opacity(0.12), in: Circle())
      VStack(alignment: .leading, spacing: 5) {
        HStack(spacing: 8) {
          Text(message.role.title(localizer: model.localizer))
            .font(.caption.weight(.semibold))
            .foregroundStyle(message.role.accent)
          if !message.eventType.isEmpty {
            Text(humanized(message.eventType, localizer: model.localizer))
              .font(.caption2)
              .foregroundStyle(.secondary)
          }
          if message.isStreaming {
            Text(model.localizer.text("Live", "实时"))
              .font(.caption2.weight(.semibold))
              .foregroundStyle(.blue)
          }
          Spacer(minLength: 6)
          if !message.timestamp.isEmpty {
            Text(message.timestamp)
              .font(.caption2)
              .foregroundStyle(.tertiary)
          }
        }
        messageText
      }
      .padding(10)
      .frame(maxWidth: message.role == .user ? 560 : .infinity, alignment: .leading)
      .background(message.role.accent.opacity(message.role == .process ? 0.06 : 0.10), in: RoundedRectangle(cornerRadius: 8))
      .overlay(
        RoundedRectangle(cornerRadius: 8)
          .stroke(message.role.accent.opacity(message.role == .process ? 0.12 : 0.2))
      )
      if message.role != .user { Spacer(minLength: 30) }
    }
    .accessibilityElement(children: .combine)
  }

  @ViewBuilder
  private var messageText: some View {
    if message.role == .assistant, let attributed = try? AttributedString(markdown: message.text) {
      Text(attributed)
        .font(.body)
        .foregroundStyle(Color.primary)
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
    } else {
      Text(message.text)
        .font(message.role == .process ? .caption.monospaced() : .body)
        .foregroundStyle(message.role == .process ? Color.secondary : Color.primary)
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}

struct SessionRunStatusPill: View {
  let state: DesktopRunState
  @EnvironmentObject private var model: CanvastDesktopModel

  var body: some View {
    HStack(spacing: 6) {
      if state.isActive {
        ProgressView()
          .controlSize(.small)
      } else {
        Image(systemName: state.symbol)
      }
      Text(state.label)
    }
    .font(.caption.weight(.semibold))
    .foregroundStyle(state.color)
    .padding(.horizontal, 10)
    .padding(.vertical, 6)
    .background(state.color.opacity(0.12), in: Capsule())
    .accessibilityElement(children: .combine)
    .accessibilityLabel(model.localizer.text("Run status: \(state.label)", "运行状态：\(state.label)"))
  }
}
