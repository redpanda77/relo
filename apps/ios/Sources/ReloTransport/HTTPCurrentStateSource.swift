import ReloCore
import Foundation

/// Immutable account/device transport. Its owner cancels `changes()` on background or scope replacement.
public struct HTTPCurrentStateSource: CurrentStateSource {
    private let baseURL: URL
    private let token: String
    private let session: URLSession
    private let retry: @Sendable (Int) async throws -> Void

    /// Puts real names back for opaque project and topic handles (E2.5) before decoding.
    private var nameResolver: (@Sendable (Data) -> Data)?
    /// Opens end-to-end sealed rows so Now shows real titles and statuses (E3–E5).
    private var sealedOpener: ReloSealedOpener?

    public init(baseURL: URL, token: String, session: URLSession = ReloAPISession.shared,
                nameResolver: (@Sendable (Data) -> Data)? = nil, sealedOpener: ReloSealedOpener? = nil) {
        self.init(baseURL: baseURL, token: token, session: session) { failure in
            let ceiling = min(5_000, 250 * (1 << min(failure, 5)))
            try await Task.sleep(for: .milliseconds(Int.random(in: max(1, ceiling / 2)...ceiling)))
        }
        self.nameResolver = nameResolver
        self.sealedOpener = sealedOpener
    }

    init(baseURL: URL, token: String, session: URLSession, retry: @escaping @Sendable (Int) async throws -> Void) {
        self.baseURL = baseURL; self.token = token; self.session = session; self.retry = retry
    }

    public func fetchCurrent(ids: [String]?) async throws -> CurrentInboxResponse {
        guard let ids else { return try await fetchCurrentPage(after: nil) }
        guard !ids.isEmpty, ids.count <= 50, ids.allSatisfy(CurrentWireIdentity.isSubject) else { throw CurrentStateQueryError.invalidQuery }
        let unique = Array(Set(ids)).sorted()
        let response: CurrentInboxResponse = try await fetch(path: "api/inbox/current", query: unique.map { .init(name: "id", value: $0) })
        guard response.isValid(requestedIDs: unique) else { throw InboxRemoteError.incompatibleResponse }
        return sealedOpener.map { response.openingSealed($0) } ?? response
    }

    public func fetchCurrentPage(after cursor: String?) async throws -> CurrentInboxResponse {
        let query = try pageQuery(cursor: cursor, limit: 50)
        let response: CurrentInboxResponse = try await fetch(path: "api/inbox/current", query: query)
        guard response.isValid(requestedIDs: nil), response.cursor != cursor || !response.hasMore else { throw InboxRemoteError.incompatibleResponse }
        return sealedOpener.map { response.openingSealed($0) } ?? response
    }

    public func fetchPending(after cursor: String?, limit: Int = 50) async throws -> PendingCurrentPage {
        guard (1...100).contains(limit) else { throw CurrentStateQueryError.invalidQuery }
        let response: PendingCurrentPage = try await fetch(path: "api/inbox/pending", query: pageQuery(cursor: cursor, limit: limit))
        guard response.isValid(limit: limit), response.cursor != cursor || !response.hasMore else { throw InboxRemoteError.incompatibleResponse }
        return sealedOpener.map { response.openingSealed($0) } ?? response
    }

    private func pageQuery(cursor: String?, limit: Int) throws -> [URLQueryItem] {
        guard cursor.map({ !$0.isEmpty && $0.utf8.count <= 512 }) ?? true else { throw CurrentStateQueryError.invalidQuery }
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let cursor { query.append(.init(name: "after", value: cursor)) }
        return query
    }

    private func request(path: String, query: [URLQueryItem] = [], stream: Bool = false) throws -> URLRequest {
        guard var url = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false),
              ["https", "http"].contains(url.scheme?.lowercased() ?? ""), url.host != nil,
              url.user == nil, url.password == nil else { throw CurrentStateQueryError.invalidQuery }
        url.queryItems = query.isEmpty ? nil : query; url.fragment = nil
        guard let address = url.url else { throw CurrentStateQueryError.invalidQuery }
        var request = URLRequest(url: address, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: stream ? 35 : 10)
        request.authorize(bearer: token)
        request.setValue(stream ? "text/event-stream" : "application/json", forHTTPHeaderField: "Accept")
        return request
    }

    /// Memory guard only: a declared or actual body over the cap is not a current-state reply.
    static let maxBodyBytes = 4_194_304

    static func checkSize(expected: Int64, actual: Int) throws {
        guard expected <= Int64(maxBodyBytes), actual <= maxBodyBytes else { throw InboxRemoteError.incompatibleResponse }
    }

    private func fetch<Value: Decodable>(path: String, query: [URLQueryItem]) async throws -> Value {
        try Task.checkCancellation()
        let request = try request(path: path, query: query)
        do {
            // One buffered read: iterating a JSON body byte by byte costs an async hop per byte.
            let (data, response) = try await session.data(for: request, delegate: CurrentRequestDelegate())
            try validate(response, stream: false)
            try Self.checkSize(expected: response.expectedContentLength, actual: data.count)
            try Task.checkCancellation()
            let resolved = nameResolver?(data) ?? data
            do { return try ReloWireJSON.decoder().decode(Value.self, from: resolved) }
            catch { throw InboxRemoteError.incompatibleResponse }
        } catch { throw mapped(error) }
    }

    public func changes() -> AsyncThrowingStream<CurrentChangeHint, Error> {
        AsyncThrowingStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            let owner = Task {
                var failures = 0, resync = false
                emit(.reconcile, to: continuation)
                while !Task.isCancelled {
                    do {
                        let request = try request(path: "api/inbox/events", stream: true)
                        let (bytes, response) = try await session.bytes(for: request, delegate: CurrentRequestDelegate())
                        let task = bytes.task
                        defer { task.cancel() }
                        try validate(response, stream: true)
                        let connectedAt = ContinuousClock.now
                        // A reconnect after an outage must re-read: the failure-time reconcile ran while the server was down.
                        if resync { resync = false; emit(.reconcile, to: continuation) }
                        try await withTaskCancellationHandler {
                            var parser = CurrentEventDecoder()
                            for try await byte in bytes {
                                try Task.checkCancellation()
                                if let hint = try parser.consume(byte) { emit(hint, to: continuation) }
                            }
                        } onCancel: { task.cancel() }
                        if connectedAt.duration(to: .now) >= .seconds(15) { failures = 0 }
                        throw InboxRemoteError.unavailable // EOF requires a new authoritative bootstrap.
                    } catch {
                        if Task.isCancelled || error is CancellationError { continuation.finish(); return }
                        let failure = mapped(error)
                        if failure as? InboxRemoteError == .unauthorized || failure as? InboxRemoteError == .incompatibleResponse
                            || failure is CurrentStateQueryError {
                            continuation.finish(throwing: failure); return
                        }
                        // Reconcile immediately; only reopening the connection waits for jitter.
                        emit(.reconcile, to: continuation); resync = true
                        do { try await retry(failures) }
                        catch { continuation.finish(throwing: error); return }
                        failures = min(failures + 1, 5)
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { @Sendable _ in owner.cancel() }
        }
    }

    private func emit(_ hint: CurrentChangeHint, to continuation: AsyncThrowingStream<CurrentChangeHint, Error>.Continuation) {
        // A dropped targeted hint must become a full read, never silent lost state.
        if case .dropped = continuation.yield(hint) { continuation.yield(.reconcile) }
    }

    private func validate(_ response: URLResponse, stream: Bool) throws {
        guard let http = response as? HTTPURLResponse else { throw InboxRemoteError.incompatibleResponse }
        switch http.statusCode {
        case 200: break
        case 401, 403: throw InboxRemoteError.unauthorized
        case 409, 410: throw InboxRemoteError.cursorExpired
        default: throw InboxRemoteError.unavailable
        }
        let expected = stream ? "text/event-stream" : "application/json"
        guard http.mimeType?.lowercased() == expected else { throw InboxRemoteError.incompatibleResponse }
    }

    private func mapped(_ error: Error) -> Error {
        if Task.isCancelled || (error as? URLError)?.code == .cancelled { return CancellationError() }
        if let network = error as? URLError,
           [.cannotFindHost, .dnsLookupFailed, .notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost].contains(network.code) {
            return InboxRemoteError.serverUnreachable
        }
        if error is URLError { return InboxRemoteError.unavailable }
        return error
    }
}

/// No redirects: an authenticated read/stream must stay on its configured endpoint.
/// Stateless delegate; there is no mutable cross-task state.
private final class CurrentRequestDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// A partial or hostile frame cannot grow memory without bound. CRLF and split UTF-8 are accepted.
struct CurrentEventDecoder {
    private var line: [UInt8] = []
    private var frameBytes = 0
    private var event = ""
    private var data: [String] = []

    mutating func consume(_ byte: UInt8) throws -> CurrentChangeHint? {
        frameBytes += 1
        guard frameBytes <= 8_192 else { throw InboxRemoteError.incompatibleResponse }
        guard byte == 10 else { line.append(byte); return nil }
        if line.last == 13 { line.removeLast() }
        guard let value = String(bytes: line, encoding: .utf8) else { throw InboxRemoteError.incompatibleResponse }
        line.removeAll(keepingCapacity: true)
        if value.isEmpty {
            defer { frameBytes = 0; event = ""; data.removeAll(keepingCapacity: true) }
            guard event == "current" else { return nil }
            guard let hint = try? JSONDecoder().decode(CurrentChangeHint.self, from: Data(data.joined(separator: "\n").utf8)), hint.isValid else {
                throw InboxRemoteError.incompatibleResponse
            }
            return hint
        }
        if value.hasPrefix(":") { return nil }
        let fields = value.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        var content = fields.count == 2 ? String(fields[1]) : ""
        if content.first == " " { content.removeFirst() }
        if fields[0] == "event" { event = content }
        if fields[0] == "data" { data.append(content) }
        return nil
    }
}
