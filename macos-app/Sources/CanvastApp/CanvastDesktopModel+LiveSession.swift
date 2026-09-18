import Foundation

@MainActor
extension CanvastDesktopModel {
  func beginLiveSessionTurn(requestID: String, prompt: String, expectsAssistant: Bool = true) {
    let sessionPath = currentActiveSessionPath()
    let now = isoTimestamp()
    liveSessionRequestAliases[requestID] = requestID
    liveSessionBaselineEntryCounts[requestID] = sessionPath != nil && sessionTranscript?.sessionPath == sessionPath
      ? (sessionTranscript?.entries.count ?? 0)
      : 0
    liveSessionMessages.removeAll { $0.requestID == requestID }
    liveSessionMessages.append(.init(
      id: "live-\(requestID)-user", requestID: requestID, sessionPath: sessionPath,
      role: .user, eventType: "message", timestamp: now, text: prompt, isStreaming: false
    ))
    appendConsole(.system, localizer.text("User input: \(prompt)", "用户输入：\(prompt)"))
    if expectsAssistant {
      liveSessionMessages.append(.init(
        id: "live-\(requestID)-assistant", requestID: requestID, sessionPath: sessionPath,
        role: .assistant, eventType: "message", timestamp: now, text: "", isStreaming: true
      ))
    }
    trimLiveSessionMessages()
  }

  func appendLiveAssistantDelta(_ text: String) {
    guard let requestID = activeRunRequestID,
          !text.isEmpty else { return }
    if let index = liveSessionMessages.firstIndex(where: {
      $0.requestID == requestID && $0.role == .assistant
    }) {
      liveSessionMessages[index].text += text
      liveSessionMessages[index].timestamp = isoTimestamp()
      liveSessionMessages[index].isStreaming = true
    } else {
      liveSessionMessages.append(.init(
        id: "live-\(requestID)-assistant", requestID: requestID, sessionPath: currentActiveSessionPath(),
        role: .assistant, eventType: "message", timestamp: isoTimestamp(), text: text, isStreaming: true
      ))
    }
    trimLiveSessionMessages()
  }

  func appendLiveAssistantDelta(_ text: String, requestID: String?) {
    let effectiveRequestID = resolveLiveSessionRequestID(requestID)
    guard let effectiveRequestID,
          !text.isEmpty else { return }
    if let index = liveSessionMessages.firstIndex(where: {
      $0.requestID == effectiveRequestID && $0.role == .assistant
    }) {
      liveSessionMessages[index].text += text
      liveSessionMessages[index].timestamp = isoTimestamp()
      liveSessionMessages[index].isStreaming = true
    } else {
      liveSessionMessages.append(.init(
        id: "live-\(effectiveRequestID)-assistant", requestID: effectiveRequestID, sessionPath: currentActiveSessionPath(),
        role: .assistant, eventType: "message", timestamp: isoTimestamp(), text: text, isStreaming: true
      ))
    }
    trimLiveSessionMessages()
  }

  func appendLiveProcessMessage(_ text: String, eventType: String) {
    guard let requestID = activeRunRequestID,
          !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
    let message = DesktopLiveSessionMessage(
      id: "live-\(requestID)-process-\(liveSessionMessages.count)",
      requestID: requestID, sessionPath: currentActiveSessionPath(), role: .process,
      eventType: eventType, timestamp: isoTimestamp(), text: text, isStreaming: true
    )
    if let assistantIndex = liveSessionMessages.firstIndex(where: {
      $0.requestID == requestID && $0.role == .assistant
    }) {
      liveSessionMessages.insert(message, at: assistantIndex)
    } else {
      liveSessionMessages.append(message)
    }
    trimLiveSessionMessages()
  }

  func appendLiveProcessMessage(_ text: String, eventType: String, requestID: String?) {
    let effectiveRequestID = resolveLiveSessionRequestID(requestID)
    guard let effectiveRequestID,
          !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
    let message = DesktopLiveSessionMessage(
      id: "live-\(effectiveRequestID)-process-\(liveSessionMessages.count)",
      requestID: effectiveRequestID, sessionPath: currentActiveSessionPath(), role: .process,
      eventType: eventType, timestamp: isoTimestamp(), text: text, isStreaming: true
    )
    if let assistantIndex = liveSessionMessages.firstIndex(where: {
      $0.requestID == effectiveRequestID && $0.role == .assistant
    }) {
      liveSessionMessages.insert(message, at: assistantIndex)
    } else {
      liveSessionMessages.append(message)
    }
    trimLiveSessionMessages()
  }

  func finishLiveAssistantMessage(_ text: String?) {
    guard let requestID = activeRunRequestID else { return }
    let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if let index = liveSessionMessages.firstIndex(where: {
      $0.requestID == requestID && $0.role == .assistant
    }) {
      if !trimmed.isEmpty { liveSessionMessages[index].text = trimmed }
      liveSessionMessages[index].timestamp = isoTimestamp()
      liveSessionMessages[index].isStreaming = false
    } else if let sessionPath = currentActiveSessionPath(), !trimmed.isEmpty {
      liveSessionMessages.append(.init(
        id: "live-\(requestID)-assistant", requestID: requestID, sessionPath: sessionPath,
        role: .assistant, eventType: "message", timestamp: isoTimestamp(), text: trimmed, isStreaming: false
      ))
    }
  }

  func finishLiveAssistantMessage(_ text: String?, requestID: String?) {
    let effectiveRequestID = resolveLiveSessionRequestID(requestID)
    guard let effectiveRequestID else { return }
    let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if let index = liveSessionMessages.firstIndex(where: {
      $0.requestID == effectiveRequestID && $0.role == .assistant
    }) {
      if !trimmed.isEmpty { liveSessionMessages[index].text = trimmed }
      liveSessionMessages[index].timestamp = isoTimestamp()
      liveSessionMessages[index].isStreaming = false
    } else if let sessionPath = currentActiveSessionPath(), !trimmed.isEmpty {
      liveSessionMessages.append(.init(
        id: "live-\(effectiveRequestID)-assistant", requestID: effectiveRequestID, sessionPath: sessionPath,
        role: .assistant, eventType: "message", timestamp: isoTimestamp(), text: trimmed, isStreaming: false
      ))
    }
    if !trimmed.isEmpty {
      appendConsole(.standardOutput, trimmed)
    }
  }

  func finalizeLiveSessionTurn(requestID: String?, succeeded: Bool) {
    guard let requestID else { return }
    let effectiveRequestID = resolveLiveSessionRequestID(requestID) ?? requestID
    mirrorFinalLiveAssistantMessageToConsole(requestID: effectiveRequestID)
    for index in liveSessionMessages.indices where liveSessionMessages[index].requestID == effectiveRequestID {
      liveSessionMessages[index].isStreaming = false
    }
    if !succeeded, let index = liveSessionMessages.firstIndex(where: {
      $0.requestID == effectiveRequestID && $0.role == .assistant &&
        $0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }) {
      liveSessionMessages.remove(at: index)
    }
  }

  func linkLiveSessionRequestAlias(_ requestID: String, to canonicalRequestID: String) {
    let trimmedRequestID = requestID.trimmingCharacters(in: .whitespacesAndNewlines)
    let trimmedCanonicalID = canonicalRequestID.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedRequestID.isEmpty, !trimmedCanonicalID.isEmpty else { return }
    liveSessionRequestAliases[trimmedRequestID] = trimmedCanonicalID
    if liveSessionBaselineEntryCounts[trimmedCanonicalID] == nil,
       let aliasBaseline = liveSessionBaselineEntryCounts[trimmedRequestID] {
      liveSessionBaselineEntryCounts[trimmedCanonicalID] = aliasBaseline
    }
    for index in liveSessionMessages.indices where liveSessionMessages[index].requestID == trimmedRequestID {
      let existingID = liveSessionMessages[index].id
      let suffix = existingID.hasPrefix("live-\(trimmedRequestID)-")
        ? String(existingID.dropFirst("live-\(trimmedRequestID)-".count))
        : existingID
      liveSessionMessages[index] = DesktopLiveSessionMessage(
        id: "live-\(trimmedCanonicalID)-\(suffix)",
        requestID: trimmedCanonicalID,
        sessionPath: liveSessionMessages[index].sessionPath,
        role: liveSessionMessages[index].role,
        eventType: liveSessionMessages[index].eventType,
        timestamp: liveSessionMessages[index].timestamp,
        text: liveSessionMessages[index].text,
        isStreaming: liveSessionMessages[index].isStreaming
      )
    }
  }

  func liveSessionTimelineMessages(for sessionPath: String) -> [SessionTimelineMessage] {
    let persistedCount = sessionTranscript?.sessionPath == sessionPath ? (sessionTranscript?.entries.count ?? 0) : 0
    return liveSessionMessages.filter { message in
      guard message.sessionPath == nil || message.sessionPath == sessionPath else { return false }
      let baseline = liveSessionBaselineEntryCounts[message.requestID] ?? Int.max
      return persistedCount <= baseline
    }.map(SessionTimelineMessage.init(live:))
  }

  func conversationTimelineMessages(for sessionPath: String) -> [SessionTimelineMessage] {
    let liveMessages = liveSessionTimelineMessages(for: sessionPath)
    if let transcript = sessionTranscript, transcript.sessionPath == sessionPath {
      if !transcript.entries.isEmpty {
        return transcript.entries.enumerated().map { index, entry in
          SessionTimelineMessage(entry: entry, index: index)
        } + liveMessages
      }
      let rawTranscript = transcript.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
      if !rawTranscript.isEmpty {
        return [
          .init(
            id: "raw-transcript-\(sessionPath)",
            role: .process,
            eventType: localizer.text("Transcript", "转录"),
            timestamp: "",
            text: rawTranscript
          ),
        ] + liveMessages
      }
    }
    if !liveMessages.isEmpty { return liveMessages }
    return sessionCatalog?.sessions.first { $0.path == sessionPath }.flatMap { session in
      guard let firstMessage = nonemptySessionText(session.firstMessage) else { return nil }
      return [
        .init(
          id: "preview-\(session.path)",
          role: .user,
          eventType: localizer.text("Preview", "预览"),
          timestamp: session.modifiedAt,
          text: firstMessage
        ),
      ]
    } ?? []
  }

  func currentConversationTimelineMessages() -> [SessionTimelineMessage] {
    guard let sessionPath = currentActiveSessionPath() else { return [] }
    return conversationTimelineMessages(for: sessionPath)
  }

  func currentConversationSessionPath() -> String? {
    currentActiveSessionPath()
  }

  func synchronizeCurrentConversationStateIfPossible() {
    guard canManageSessions else { return }
    if sessionCatalog == nil, !isActionLocked(.loadSessionCatalog) {
      loadSessionCatalog()
      return
    }
    guard let sessionPath = currentActiveSessionPath(),
          !isActionLocked(.loadSessionTranscript) else { return }
    if sessionTranscript?.sessionPath != sessionPath {
      loadSessionTranscript(path: sessionPath)
    }
  }

  func refreshActiveSessionTranscriptIfVisible() {
    guard !isActionLocked(.loadSessionTranscript),
          let sessionPath = currentActiveSessionPath() else { return }
    loadSessionTranscript(path: sessionPath)
  }

  func currentActiveSessionPath() -> String? {
    let catalogPath = sessionCatalog?.activeSessionPath.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !catalogPath.isEmpty { return catalogPath }
    let transcriptPath = sessionTranscript?.sessionPath.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !transcriptPath.isEmpty { return transcriptPath }
    let runtimeSessionPath = state.sessions.first { $0.isActive }?.file?
      .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return runtimeSessionPath.isEmpty ? nil : runtimeSessionPath
  }

  private func nonemptySessionText(_ value: String?) -> String? {
    guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
          !trimmed.isEmpty else { return nil }
    return trimmed
  }

  private func trimLiveSessionMessages() {
    if liveSessionMessages.count > 80 {
      liveSessionMessages.removeFirst(liveSessionMessages.count - 80)
    }
    let retainedRequestIDs = Set(liveSessionMessages.map(\.requestID))
    liveSessionBaselineEntryCounts = liveSessionBaselineEntryCounts.filter { retainedRequestIDs.contains($0.key) }
    liveSessionRequestAliases = liveSessionRequestAliases.filter {
      retainedRequestIDs.contains($0.key) || retainedRequestIDs.contains($0.value)
    }
  }

  private func isoTimestamp() -> String {
    ISO8601DateFormatter().string(from: liveSessionTimestampOverride ?? Date())
  }

  private func resolveLiveSessionRequestID(_ requestID: String?) -> String? {
    if let requestID = requestID?.trimmingCharacters(in: .whitespacesAndNewlines), !requestID.isEmpty {
      if let canonical = liveSessionRequestAliases[requestID] { return canonical }
      if liveSessionMessages.contains(where: { $0.requestID == requestID }) { return requestID }
      return requestID
    }
    if let activeRunRequestID { return liveSessionRequestAliases[activeRunRequestID] ?? activeRunRequestID }
    return liveSessionMessages.last?.requestID
  }

  private func mirrorFinalLiveAssistantMessageToConsole(requestID: String) {
    guard let message = liveSessionMessages.last(where: {
      $0.requestID == requestID && $0.role == .assistant
    }) else { return }
    let text = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    if consoleEntries.contains(where: {
      $0.channel == .standardOutput &&
        $0.text.trimmingCharacters(in: .whitespacesAndNewlines) == text
    }) {
      return
    }
    appendConsole(.standardOutput, text)
  }
}
