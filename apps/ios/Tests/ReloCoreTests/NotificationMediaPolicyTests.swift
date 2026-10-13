@testable import ReloTransport
import CryptoKit
import Foundation
import Testing
@testable import ReloCore

@Suite("Bounded account-scoped media")
struct NotificationMediaPolicyTests {
    @Test func scopeKeys() {
        let a = NotificationMediaPolicy.Key(accountID: "acc_media123456", locator: "https://example.com/a.png", maximumPixels: 1200)
        let b = NotificationMediaPolicy.Key(accountID: "acc_other123456", locator: "https://example.com/a.png", maximumPixels: 1200)
        #expect(a != b)
        #expect(a != nil)
        #expect(NotificationMediaPolicy.Key(accountID: nil, locator: "asset", maximumPixels: 1200) == nil)
        #expect(NotificationMediaPolicy.Key(accountID: "../account", locator: "asset", maximumPixels: 1200) == nil)
    }
    @Test(arguments: ["http://example.com/a", "https://127.0.0.1/a", "https://user:pass@example.com/a", "file:///tmp/a", "https://host.local/a"])
    func invalidRequestAndRedirect(url: String) {
        #expect(NotificationImagePolicy.validatedURL(url) == nil)
    }
    @Test func limitsAndDigest() {
        #expect(!NotificationMediaPolicy.accepts(byteCount: 0, maximumBytes: 10))
        #expect(!NotificationMediaPolicy.accepts(byteCount: 11, maximumBytes: 10))
        #expect(!NotificationMediaPolicy.accepts(byteCount: 5, maximumBytes: 10, expectedLength: 11))
        let data = Data("image".utf8)
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        #expect(NotificationMediaPolicy.matches(data, byteSize: 5, sha256: digest))
        #expect(!NotificationMediaPolicy.matches(data, byteSize: 5, sha256: String(repeating: "0", count: 64)))
        #expect(!NotificationMediaPolicy.matches(data, byteSize: 4, sha256: digest))
    }
    @Test func missingFile() async {
        await #expect(throws: (any Error).self) {
            _ = try await NotificationMediaData.read(file: URL(fileURLWithPath: "/tmp/\(UUID().uuidString)-absent"), maximumBytes: 10)
        }
    }
    @Test func cancellation() async {
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await NotificationMediaData.download(url: URL(string: "https://example.com/a.png")!, maximumBytes: 100)
        }
        await #expect(throws: CancellationError.self) { _ = try await task.value }
    }
    @Test func boundedRead() async throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: file) }
        try Data(repeating: 1, count: 11).write(to: file)
        await #expect(throws: (any Error).self) { _ = try await NotificationMediaData.read(file: file, maximumBytes: 10) }
    }
    @Test("The actual redirect delegate rejects unsafe destinations") func redirect() async throws {
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let source = URL(string: "https://example.com/image")!
        let task = session.dataTask(with: source)
        let response = try #require(HTTPURLResponse(url: source, statusCode: 302, httpVersion: nil, headerFields: nil))
        let delegate = BoundedMediaDownloadDelegate(maximumBytes: 100)
        let unsafe = await delegate.urlSession(session, task: task, willPerformHTTPRedirection: response,
            newRequest: URLRequest(url: URL(string: "https://127.0.0.1/private")!))
        let safe = await delegate.urlSession(session, task: task, willPerformHTTPRedirection: response,
            newRequest: URLRequest(url: URL(string: "https://cdn.example.com/image")!))
        #expect(unsafe == nil)
        #expect(safe?.url?.host == "cdn.example.com")
    }

    @Test("Immutable paths reject malformed digests before disk access") func immutableReference() {
        func asset(_ digest: String, size: Int = 10) -> LiveActivityDisplayPresentation.AssetReference {
            .init(assetId: "ast_media123456", revision: 1, sha256: digest, mediaType: "image/png",
                  byteSize: size, pixelWidth: 100, pixelHeight: 100, altText: "Preview", contentMode: .fit)
        }
        #expect(NotificationMediaPolicy.accepts(asset(String(repeating: "a", count: 64))))
        #expect(!NotificationMediaPolicy.accepts(asset("../../private")))
        #expect(!NotificationMediaPolicy.accepts(asset(String(repeating: "a", count: 64), size: 10_000_001)))
    }

}
