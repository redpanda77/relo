@testable import ReloTransport
import Foundation
import Testing
@testable import ReloCore

private let currentID = "ntf_10000000-0000-4000-8000-000000000001"
private let requestID = "int_20000000-0000-4000-8000-000000000002"
private let stamp = "2026-09-30T12:00:00.123456Z"
private let currentItem = #"{"subjectId":"ntf_10000000-0000-4000-8000-000000000001","notificationId":"ntf_10000000-0000-4000-8000-000000000001","kind":"notice","version":{"generation":1,"revision":3},"title":"Current","summary":"Summary","source":"Fixture","createdAt":"2026-09-30T12:00:00.123456Z","updatedAt":"2026-09-30T12:00:00.123456Z","occurredAt":null,"acceptedAt":"2026-09-30T12:00:00.123456Z","readAt":null,"currentUntil":"2026-09-30T12:15:00.123456Z","freshUntil":null,"deliverUntil":"2026-09-30T12:01:00.123456Z","freshness":"unknown","interaction":null,"activity":null,"resources":null}"#
private func currentPage(items: String = currentItem, retired: String = "[]", total: Int = 100, cursor: String = "null", more: Bool = false) -> String {
    #"{"items":[\#(items)],"retired":\#(retired),"total":\#(total),"cursor":\#(cursor),"hasMore":\#(more),"counts":{"actionable":0,"currentUnread":\#(total)},"nextExpiryAt":"2026-09-30T12:15:00.123456Z","serverTime":"\#(stamp)"}"#
}

@Suite("Current state transport")
struct CurrentStateTransportTests {
    @Test func currentReadPreservesWholeScopeAndFractionalTime() async throws {
        let fixture = CurrentHTTPFixture([.json(currentPage())]); defer { fixture.close() }
        let page = try await fixture.source.fetchCurrent(ids: nil)
        #expect(page.total == 100); #expect(page.items.count == 1); #expect(page.items[0].occurredAt == nil)
        #expect(page.items[0].version.revision == 3); #expect(page.items[0].freshness == .unknown)
        let seconds = try Date.ISO8601FormatStyle().parse("2026-09-30T12:00:00Z")
        #expect(abs(page.serverTime.timeIntervalSince(seconds) - 0.123456) < 0.000001)
        let request = try #require(fixture.requests.first)
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer private-test-token")
        #expect(request.url?.query == "limit=50"); #expect(request.timeoutInterval == 10)
        #expect(!request.url!.absoluteString.contains("private-test-token"))
    }
    @Test func targetedReadHasNoPaginationAndRequiresEveryRequestedIdentity() async throws {
        let retired = #"[{"subjectId":"\#(currentID)","reason":"not_found"}]"#
        let fixture = CurrentHTTPFixture([.json(currentPage(items: "", retired: retired))]); defer { fixture.close() }
        let page = try await fixture.source.fetchCurrent(ids: [currentID, currentID])
        #expect(page.total == 100); #expect(page.retired[0].version == nil)
        let query = URLComponents(url: try #require(fixture.requests.first?.url), resolvingAgainstBaseURL: false)?.queryItems
        #expect(query == [URLQueryItem(name: "id", value: currentID)])
        let missing = CurrentHTTPFixture([.json(currentPage(items: ""))]); defer { missing.close() }
        await #expect(throws: InboxRemoteError.incompatibleResponse) { try await missing.source.fetchCurrent(ids: [currentID]) }
    }
    @Test func pendingInventoryHasIndependentCursorCountAndOriginalDeadline() async throws {
        let body = #"{"items":[{"subjectId":"\#(currentID)","notificationId":"\#(currentID)","version":null,"kind":"decision","title":"Question","summary":"Continue?","source":"Fixture","createdAt":"\#(stamp)","readAt":null,"urgencyRank":0,"interaction":{"id":"\#(requestID)","type":"yes_no","state":"pending","expiresAt":"2026-09-30T12:15:00.123456Z"}}],"total":300,"hasMore":true,"cursor":"next","nextExpiryAt":"2026-09-30T12:15:00.123456Z","serverTime":"\#(stamp)"}"#
        let fixture = CurrentHTTPFixture([.json(body)]); defer { fixture.close() }
        let result = try await fixture.source.fetchPending(after: "original_cursor", limit: 100)
        #expect(result.total == 300); #expect(result.items[0].interaction.id == requestID)
        #expect(result.items[0].interaction.expiresAt.timeIntervalSince(result.serverTime) == 900)
        #expect(fixture.requests[0].url?.path.hasSuffix("api/inbox/pending") == true)
        #expect(fixture.requests[0].url?.query == "limit=100&after=original_cursor")
    }
    @Test func choiceDecisionsCarryOptionsAndUnknownKindsAreLeftOutNotFatal() async throws {
        func pending(_ id: String, _ interaction: String) -> String {
            #"{"subjectId":"\#(id)","notificationId":"\#(id)","version":null,"kind":"decision","title":"Question","summary":"Which?","source":"Fixture","createdAt":"\#(stamp)","readAt":null,"urgencyRank":0,"interaction":\#(interaction)}"#
        }
        let choiceID = "ntf_30000000-0000-4000-8000-000000000003"
        let futureID = "ntf_40000000-0000-4000-8000-000000000004"
        let choice = #"{"id":"\#(requestID)","type":"choice","state":"pending","expiresAt":"2026-09-30T12:15:00.123456Z","options":[{"id":"ship","label":"Ship"},{"id":"wait","label":"Wait"},{"id":"rollback","label":"Roll back"}]}"#
        let future = #"{"id":"int_50000000-0000-4000-8000-000000000005","type":"ranking","state":"pending","expiresAt":"2026-09-30T12:15:00.123456Z"}"#
        let body = #"{"items":[\#(pending(choiceID, choice)),\#(pending(futureID, future))],"total":2,"hasMore":false,"cursor":null,"nextExpiryAt":"2026-09-30T12:15:00.123456Z","serverTime":"\#(stamp)"}"#
        let fixture = CurrentHTTPFixture([.json(body)]); defer { fixture.close() }
        let result = try await fixture.source.fetchPending(after: nil, limit: 100)
        #expect(result.items.map(\.subjectId) == [choiceID])
        #expect(result.items[0].interaction.type == .choice)
        #expect(result.items[0].interaction.options?.map(\.id) == ["ship", "wait", "rollback"])

        let current = #"{"subjectId":"\#(futureID)","notificationId":"\#(futureID)","kind":"decision","version":{"generation":1,"revision":1},"title":"Future","summary":"","source":"Fixture","createdAt":"\#(stamp)","updatedAt":"\#(stamp)","occurredAt":null,"acceptedAt":"\#(stamp)","readAt":null,"currentUntil":"2026-09-30T12:15:00.123456Z","freshUntil":null,"deliverUntil":"2026-09-30T12:01:00.123456Z","freshness":"unknown","interaction":\#(future),"activity":null,"resources":null}"#
        let page = CurrentHTTPFixture([.json(currentPage(items: currentItem + "," + current, total: 2))])
        defer { page.close() }
        let all = try await page.source.fetchCurrent(ids: nil)
        #expect(all.items.map(\.subjectId) == [currentID])
        #expect(all.unsupportedSubjectIDs == [futureID])
        // A requested subject this build cannot answer still counts as answered by the server.
        let targeted = CurrentHTTPFixture([.json(currentPage(items: currentItem + "," + current, total: 2))])
        defer { targeted.close() }
        let both = try await targeted.source.fetchCurrent(ids: [currentID, futureID])
        #expect(both.items.count == 1)
    }

    @Test func malformedChoiceOptionsStayAContractViolation() throws {
        let decoder = ReloWireJSON.decoder()
        for options in [#"[{"id":"ship","label":"Ship"}]"#, #"[{"id":"ship","label":"Ship"},{"id":"wait","label":"SHIP"}]"#, "null"] {
            let json = #"{"id":"\#(requestID)","type":"choice","state":"pending","expiresAt":"2026-09-30T12:15:00.123456Z","options":\#(options)}"#
            #expect(throws: DecodingError.self) { try decoder.decode(CurrentDecision.self, from: Data(json.utf8)) }
        }
    }
    @Test(arguments: [401, 403, 410, 503]) func statusErrorsAreTyped(status: Int) async throws {
        let fixture = CurrentHTTPFixture([.init(status: status, body: "{}")]); defer { fixture.close() }
        let expected: InboxRemoteError = status == 410 ? .cursorExpired : status == 503 ? .unavailable : .unauthorized
        await #expect(throws: expected) { try await fixture.source.fetchCurrent(ids: nil) }
    }
    @Test func invalidQueriesNeverStartNetworkWork() async throws {
        let fixture = CurrentHTTPFixture([]); defer { fixture.close() }
        await #expect(throws: CurrentStateQueryError.invalidQuery) { try await fixture.source.fetchCurrent(ids: []) }
        await #expect(throws: CurrentStateQueryError.invalidQuery) { try await fixture.source.fetchCurrent(ids: ["display name"]) }
        await #expect(throws: CurrentStateQueryError.invalidQuery) { try await fixture.source.fetchPending(after: nil, limit: 101) }
        await #expect(throws: CurrentStateQueryError.invalidQuery) { try await fixture.source.fetchCurrentPage(after: "") }
        #expect(fixture.requests.isEmpty)
    }
    @Test(arguments: ["duplicate", "oversized", "cursor", "missingDeadline", "bodyLimit"])
    func rejectsUnsafeResponses(scenario: String) async throws {
        let body: String
        switch scenario {
        case "duplicate": body = currentPage(items: currentItem + "," + currentItem)
        case "oversized": body = currentPage(items: Array(repeating: currentItem, count: 51).joined(separator: ","))
        case "cursor": body = currentPage(cursor: #""original""#, more: true)
        case "missingDeadline": body = currentPage(items: currentItem.replacingOccurrences(of: #""kind":"notice""#, with: #""kind":"decision""#))
        default: body = String(repeating: "x", count: 4_194_305)
        }
        let fixture = CurrentHTTPFixture([.json(body)]); defer { fixture.close() }
        await #expect(throws: InboxRemoteError.incompatibleResponse) { try await fixture.source.fetchCurrentPage(after: "original") }
    }
    @Test func frameDecoderHandlesKeepaliveCRLFAndRejectsOversizedOrMalformedHints() throws {
        var parser = CurrentEventDecoder(), hints: [CurrentChangeHint] = []
        let frame = ": keepalive\r\n\r\nevent: current\r\ndata: {\"subjectIds\":\r\ndata: [\"\(currentID)\"],\"invalidateCounts\":true}\r\n\r\n"
        for byte in frame.utf8 { if let hint = try parser.consume(byte) { hints.append(hint) } }
        #expect(hints == [.init(subjectIds: [currentID], invalidateCounts: true)])
        #expect(throws: InboxRemoteError.incompatibleResponse) {
            var invalid = CurrentEventDecoder(); for byte in "event: current\ndata: {bad}\n\n".utf8 { _ = try invalid.consume(byte) }
        }
        #expect(throws: InboxRemoteError.incompatibleResponse) {
            var huge = CurrentEventDecoder(); for _ in 0..<8_193 { _ = try huge.consume(120) }
        }
    }
    @Test func streamStartsWithReconciliationAndCancellationStopsTheUnderlyingRequest() async throws {
        let fixture = CurrentHTTPFixture([.stream("", hold: true)]); defer { fixture.close() }
        let consumer = Task { for try await _ in fixture.source.changes() {} }
        try await eventually { fixture.requests.count == 1 }
        let request = fixture.requests[0]
        #expect(request.url?.query == nil); #expect(request.timeoutInterval == 35)
        #expect(request.value(forHTTPHeaderField: "Accept") == "text/event-stream")
        consumer.cancel(); _ = try await consumer.value
        try await eventually { fixture.stopped > 0 }
        #expect(fixture.requests.count == 1)
    }
    @Test func unauthorizedStreamDoesNotRetry() async throws {
        let fixture = CurrentHTTPFixture([.init(status: 401, body: "{}")]); defer { fixture.close() }
        var iterator = fixture.source.changes().makeAsyncIterator()
        #expect(try await iterator.next() == .reconcile)
        await #expect(throws: InboxRemoteError.unauthorized) { while try await iterator.next() != nil {} }
        #expect(fixture.requests.count == 1)
    }
    @Test func EOFAndDroppedHintsBecomeReconciliationBeforeRetry() async throws {
        let frames = (0..<80).map { _ in "event: current\ndata: {\"subjectIds\":[\"\(currentID)\"],\"invalidateCounts\":true}\n\n" }.joined()
        let fixture = CurrentHTTPFixture([.stream(frames, hold: false)]); defer { fixture.close() }
        let gate = CurrentRetryGate()
        let source = HTTPCurrentStateSource(baseURL: fixture.url, token: "private-test-token", session: fixture.session) { _ in
            await gate.mark(); throw CancellationError()
        }
        let stream = source.changes()
        try await eventually { await gate.called }
        var iterator = stream.makeAsyncIterator()
        #expect(try await iterator.next() == .reconcile)
        #expect(fixture.requests.count == 1)
    }
    @Test func reconnectOpensFreshAuthenticatedStreamAndCancelsCleanly() async throws {
        let fixture = CurrentHTTPFixture([.stream("", hold: false), .stream("", hold: true)]); defer { fixture.close() }
        let gate = CurrentRetryGate()
        let source = HTTPCurrentStateSource(baseURL: fixture.url, token: "immutable-scope", session: fixture.session) { _ in await gate.mark() }
        let consumer = Task { for try await _ in source.changes() {} }
        try await eventually { fixture.requests.count == 2 }
        #expect(await gate.called); #expect(fixture.requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer immutable-scope" && $0.url?.query == nil })
        consumer.cancel(); _ = try await consumer.value
        try await eventually { fixture.stopped > 0 }; #expect(fixture.requests.count == 2)
    }
}

private actor CurrentRetryGate {
    private(set) var called = false
    func mark() { called = true }
}
private enum CurrentTestError: Error { case timeout }
private func eventually(_ condition: () async -> Bool) async throws {
    let deadline = ContinuousClock.now.advanced(by: .seconds(3))
    while !(await condition()) {
        guard ContinuousClock.now < deadline else { throw CurrentTestError.timeout }
        try await Task.sleep(for: .milliseconds(5))
    }
}

/// Test-only synchronization: every mutable fixture/registry field is protected by its NSLock.
private final class CurrentHTTPFixture: @unchecked Sendable {
    struct Step: Sendable {
        var status = 200
        var body: String
        var mime = "application/json"
        var hold = false
        static func json(_ body: String) -> Self { .init(body: body) }
        static func stream(_ body: String, hold: Bool) -> Self { .init(body: body, mime: "text/event-stream", hold: hold) }
    }
    let url = URL(string: "https://\(UUID().uuidString.lowercased()).current.test")!
    let session: URLSession
    private let lock = NSLock()
    private var steps: [Step]
    private var recorded: [URLRequest] = []
    private var stopCount = 0
    var requests: [URLRequest] { lock.withLock { recorded } }
    var stopped: Int { lock.withLock { stopCount } }
    var source: HTTPCurrentStateSource { .init(baseURL: url, token: "private-test-token", session: session) }
    init(_ steps: [Step]) {
        self.steps = steps
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CurrentTestURLProtocol.self]
        session = URLSession(configuration: configuration)
        CurrentFixtureRegistry.shared.set(self, host: url.host!)
    }
    func respond(_ transport: CurrentTestURLProtocol) {
        let step = lock.withLock { () -> Step in
            recorded.append(transport.request)
            return steps.isEmpty ? .init(status: 503, body: "{}") : steps.removeFirst()
        }
        let response = HTTPURLResponse(url: transport.request.url!, statusCode: step.status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": step.mime])!
        transport.client?.urlProtocol(transport, didReceive: response, cacheStoragePolicy: .notAllowed)
        if !step.body.isEmpty { transport.client?.urlProtocol(transport, didLoad: Data(step.body.utf8)) }
        if !step.hold { transport.client?.urlProtocolDidFinishLoading(transport) }
    }
    func didStop() { lock.withLock { stopCount += 1 } }
    func close() { session.invalidateAndCancel(); CurrentFixtureRegistry.shared.set(nil, host: url.host!) }
}
private final class CurrentFixtureRegistry: @unchecked Sendable {
    static let shared = CurrentFixtureRegistry()
    private let lock = NSLock()
    private var fixtures: [String: CurrentHTTPFixture] = [:]
    func set(_ fixture: CurrentHTTPFixture?, host: String) { lock.withLock { fixtures[host] = fixture } }
    func get(_ host: String) -> CurrentHTTPFixture? { lock.withLock { fixtures[host] } }
}
private final class CurrentTestURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host?.hasSuffix(".current.test") == true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { CurrentFixtureRegistry.shared.get(request.url!.host!)?.respond(self) }
    override func stopLoading() { CurrentFixtureRegistry.shared.get(request.url!.host!)?.didStop() }
}
