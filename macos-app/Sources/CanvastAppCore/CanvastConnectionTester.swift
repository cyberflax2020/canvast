import Foundation

public protocol CanvastConnectionTransport: Sendable {
  func send(_ request: URLRequest) async throws -> (Data, URLResponse)
}

/// URLSession transport whose task is cancelled when its calling Swift task is cancelled.
public final class CanvastURLSessionConnectionTransport:
  CanvastConnectionTransport, @unchecked Sendable
{
  private let session: URLSession

  public init(session: URLSession = .shared) {
    self.session = session
  }

  public func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
    let state = CanvastURLSessionTaskState()
    return try await withTaskCancellationHandler(operation: {
      try Task.checkCancellation()
      return try await withCheckedThrowingContinuation { continuation in
        let task = session.dataTask(with: request) { data, response, error in
          if let error {
            continuation.resume(throwing: error)
          } else if let data, let response {
            continuation.resume(returning: (data, response))
          } else {
            continuation.resume(throwing: CanvastConnectionTestError.invalidResponse)
          }
        }
        state.install(task)
      }
    }, onCancel: {
      state.cancel()
    })
  }
}

public protocol CanvastConnectionTesting: Sendable {
  func testConnection(
    configuration: CanvastProviderRuntimeConfiguration,
    timeout: Duration
  ) async throws -> CanvastConnectionTestResult
}

public struct CanvastConnectionTestResult: Equatable, Sendable {
  public let statusCode: Int
  public let latency: Duration

  public init(statusCode: Int, latency: Duration) {
    self.statusCode = statusCode
    self.latency = latency
  }
}

public enum CanvastConnectionTestError: Error, Equatable, Sendable {
  case unsupportedProvider(String)
  case invalidBaseURL
  case insecureBaseURL
  case invalidTimeout
  case invalidResponse
  case unsuccessfulStatus(Int)
  case timedOut
}

extension CanvastConnectionTestError: LocalizedError {
  public var errorDescription: String? {
    switch self {
    case .unsupportedProvider(let provider):
      return CanvastAppCoreLocalizer.text(
        "Connection testing is not configured for provider '\(provider)'.",
        "连接测试未为服务商 '\(provider)' 配置。"
      )
    case .invalidBaseURL:
      return CanvastAppCoreLocalizer.text(
        "The provider base URL is invalid.",
        "服务商 Base URL 无效。"
      )
    case .insecureBaseURL:
      return CanvastAppCoreLocalizer.text(
        "The provider base URL must use HTTPS.",
        "服务商 Base URL 必须使用 HTTPS。"
      )
    case .invalidTimeout:
      return CanvastAppCoreLocalizer.text(
        "The connection-test timeout must be greater than zero.",
        "连接测试超时时间必须大于 0。"
      )
    case .invalidResponse:
      return CanvastAppCoreLocalizer.text(
        "The provider returned an invalid HTTP response.",
        "服务商返回了无效的 HTTP 响应。"
      )
    case .unsuccessfulStatus(let status):
      return CanvastAppCoreLocalizer.text(
        "The provider returned HTTP status \(status).",
        "服务商返回 HTTP 状态码 \(status)。"
      )
    case .timedOut:
      return CanvastAppCoreLocalizer.text(
        "The provider connection test timed out.",
        "服务商连接测试已超时。"
      )
    }
  }
}

public final class CanvastConnectionTester: CanvastConnectionTesting, @unchecked Sendable {
  private enum RaceOutcome {
    case response(URLResponse)
    case deadline
  }

  private let transport: any CanvastConnectionTransport
  private let clock: ContinuousClock

  public init(session: URLSession = .shared, clock: ContinuousClock = .init()) {
    self.transport = CanvastURLSessionConnectionTransport(session: session)
    self.clock = clock
  }

  public init(
    transport: any CanvastConnectionTransport,
    clock: ContinuousClock = .init()
  ) {
    self.transport = transport
    self.clock = clock
  }

  public func testConnection(
    configuration: CanvastProviderRuntimeConfiguration,
    timeout: Duration = .seconds(15)
  ) async throws -> CanvastConnectionTestResult {
    guard timeout > .zero else { throw CanvastConnectionTestError.invalidTimeout }
    try Task.checkCancellation()
    let request = try makeRequest(configuration: configuration, timeout: timeout)
    let startedAt = clock.now

    let response = try await withThrowingTaskGroup(of: RaceOutcome.self) { group in
      group.addTask { [transport] in
        let (_, response) = try await transport.send(request)
        return .response(response)
      }
      group.addTask { [clock] in
        try await clock.sleep(for: timeout)
        return .deadline
      }
      defer { group.cancelAll() }
      guard let first = try await group.next() else {
        throw CanvastConnectionTestError.invalidResponse
      }
      switch first {
      case .response(let response): return response
      case .deadline: throw CanvastConnectionTestError.timedOut
      }
    }

    try Task.checkCancellation()
    guard let httpResponse = response as? HTTPURLResponse else {
      throw CanvastConnectionTestError.invalidResponse
    }
    guard (200..<300).contains(httpResponse.statusCode) else {
      throw CanvastConnectionTestError.unsuccessfulStatus(httpResponse.statusCode)
    }
    return CanvastConnectionTestResult(
      statusCode: httpResponse.statusCode, latency: startedAt.duration(to: clock.now)
    )
  }

  public func makeRequest(
    configuration: CanvastProviderRuntimeConfiguration,
    timeout: Duration = .seconds(15)
  ) throws -> URLRequest {
    guard timeout > .zero else { throw CanvastConnectionTestError.invalidTimeout }
    let baseURL = try resolvedBaseURL(for: configuration)
    guard baseURL.scheme?.lowercased() == "https" else {
      throw CanvastConnectionTestError.insecureBaseURL
    }
    guard baseURL.host != nil, baseURL.user == nil, baseURL.password == nil,
          baseURL.query == nil, baseURL.fragment == nil else {
      throw CanvastConnectionTestError.invalidBaseURL
    }
    let endpoint = baseURL.lastPathComponent == "models"
      ? baseURL
      : baseURL.appendingPathComponent("models", isDirectory: false)
    guard !configuration.apiKey.isEmpty else {
      throw CanvastConnectionTestError.invalidResponse
    }

    var request = URLRequest(
      url: endpoint,
      cachePolicy: .reloadIgnoringLocalAndRemoteCacheData,
      timeoutInterval: Self.timeInterval(for: timeout)
    )
    request.httpMethod = "GET"
    request.httpShouldHandleCookies = false
    request.setValue("Bearer \(configuration.apiKey)", forHTTPHeaderField: "Authorization")
    return request
  }

  public static func defaultBaseURL(for provider: String) -> URL? {
    switch provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
    case "deepseek": return URL(string: "https://api.deepseek.com")
    case "openai": return URL(string: "https://api.openai.com/v1")
    case "anthropic": return URL(string: "https://api.anthropic.com/v1")
    default: return nil
    }
  }

  private func resolvedBaseURL(for configuration: CanvastProviderRuntimeConfiguration) throws -> URL {
    if let baseURL = configuration.baseURL { return baseURL }
    guard let baseURL = Self.defaultBaseURL(for: configuration.provider) else {
      throw CanvastConnectionTestError.unsupportedProvider(configuration.provider)
    }
    return baseURL
  }

  private static func timeInterval(for duration: Duration) -> TimeInterval {
    let components = duration.components
    let seconds = Double(components.seconds)
    let fractionalSeconds = Double(components.attoseconds) / 1_000_000_000_000_000_000
    return max(seconds + fractionalSeconds, 0.001)
  }
}

private final class CanvastURLSessionTaskState: @unchecked Sendable {
  private let lock = NSLock()
  private var task: URLSessionTask?
  private var isCancelled = false

  func install(_ task: URLSessionTask) {
    let shouldCancel = lock.withLock { () -> Bool in
      self.task = task
      return isCancelled
    }
    if shouldCancel { task.cancel() } else { task.resume() }
  }

  func cancel() {
    let task = lock.withLock { () -> URLSessionTask? in
      isCancelled = true
      return self.task
    }
    task?.cancel()
  }
}
