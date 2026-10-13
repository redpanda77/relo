@testable import ReloTransport
import Foundation
import Testing
@testable import ReloCore

@Suite(.serialized) struct HTTPNotificationReceiptSourceTests {
    @Test func exactReplayUsesStableScopedKeyAndOnly200AcknowledgesDuplicates() async throws {
        let (source, record, session) = try fixture()
        defer { session.invalidateAndCancel() }
        ReceiptURLProtocol.capture.configure(status: 200, body: #"{"interactionId":"int_acknowledged","replayed":true}"#)
        _ = try await source.submit(record)
        _ = try await source.submit(NotificationReceiptRecord(scope: record.scope, notificationID: record.notificationID,
                                                               capturedAt: record.capturedAt.addingTimeInterval(1)))
        let requests = ReceiptURLProtocol.capture.requests
        #expect(requests.count == 2)
        let bodies = try requests.map { request in
            let data = try #require(request.httpBody)
            let object = try JSONSerialization.jsonObject(with: data)
            return try #require(object as? [String: Any])
        }
        #expect(bodies[0]["kind"] as? String == "received")
        #expect(bodies[0]["idempotencyKey"] as? String == bodies[1]["idempotencyKey"] as? String)
        #expect((bodies[0]["idempotencyKey"] as? String)?.count == 77)
        #expect(requests[0].url?.path == "/api/notifications/\(record.notificationID)/interactions")
        #expect(requests[0].timeoutInterval == 8)
        let foreign = try ReceiptScope(serverOrigin: #require(URL(string: "https://another.example")),
                                      accountId: record.scope.accountId, deviceId: record.scope.deviceId)
        await #expect(throws: NotificationReceiptRemoteError.scopeMismatch) {
            try await source.submit(NotificationReceiptRecord(scope: foreign, notificationID: record.notificationID))
        }
        #expect(ReceiptURLProtocol.capture.requests.count == 2)
    }

    @Test func onlyAuthorizedStructuredNotFoundIsTerminal() async throws {
        let (source, record, session) = try fixture()
        defer { session.invalidateAndCancel() }
        ReceiptURLProtocol.capture.configure(status: 404, body: #"{"error":"not_found"}"#)
        guard case .notFound = try await source.submit(record) else { Issue.record("Expected terminal not-found"); return }
        ReceiptURLProtocol.capture.configure(status: 404, body: "proxy route not found")
        await #expect(throws: NotificationReceiptRemoteError.incompatible) { try await source.submit(record) }
        ReceiptURLProtocol.capture.configure(status: 409, body: #"{"error":"idempotency_conflict"}"#)
        await #expect(throws: NotificationReceiptRemoteError.conflict) { try await source.submit(record) }
        ReceiptURLProtocol.capture.configure(status: 401, body: #"{"error":"unauthorized"}"#)
        await #expect(throws: NotificationReceiptRemoteError.unauthorized) { try await source.submit(record) }
        ReceiptURLProtocol.capture.configure(status: 200, body: #"{"ok":true}"#)
        await #expect(throws: NotificationReceiptRemoteError.incompatible) { try await source.submit(record) }
    }

    private func fixture() throws -> (HTTPNotificationReceiptSource, NotificationReceiptRecord, URLSession) {
        let scope = try StorageScope(serverOrigin: #require(URL(string: "https://receipt.example")),
                                     accountID: "acc_11111111", deviceID: "dev_11111111")
        let credential = DeviceCredential(deviceId: scope.deviceID, installationId: UUID(), accessToken: "test-only",
                                          issuedAt: .distantPast, accountId: scope.accountID, credentialVersion: 1)
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [ReceiptURLProtocol.self]
        let session = URLSession(configuration: config)
        let record = try NotificationReceiptRecord(scope: ReceiptScope(serverOrigin: scope.serverOrigin,
            accountId: scope.accountID, deviceId: scope.deviceID), notificationID: "ntf_11111111")
        return (try HTTPNotificationReceiptSource(scope: scope, credential: credential, session: session), record, session)
    }
}

private final class ReceiptHTTPExchange: @unchecked Sendable {
    private let lock = NSLock()
    private var status = 200
    private var body = Data()
    private var captured: [URLRequest] = []
    var requests: [URLRequest] { lock.withLock { captured } }
    func configure(status: Int, body: String) { lock.withLock { self.status = status; self.body = Data(body.utf8); captured = [] } }
    func respond(to request: URLRequest) -> (Int, Data) {
        var recorded = request
        if recorded.httpBody == nil, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var data = Data(), buffer = [UInt8](repeating: 0, count: 4096)
            while true {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(contentsOf: buffer.prefix(count))
            }
            recorded.httpBody = data
        }
        return lock.withLock { captured.append(recorded); return (status, body) }
    }
}
private final class ReceiptURLProtocol: URLProtocol {
    static let capture = ReceiptHTTPExchange()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let (status, bytes) = Self.capture.respond(to: request)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: bytes); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
