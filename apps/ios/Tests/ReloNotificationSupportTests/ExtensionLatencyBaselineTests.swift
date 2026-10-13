import XCTest
import UserNotifications
#if canImport(ReloNotificationSupport)
@testable import ReloNotificationSupport
#endif

final class ExtensionLatencyBaselineTests: XCTestCase {
    func testContentHandlerBaseline() async throws {
        let source = ProcessInfo.processInfo.environment["RELO_BENCHMARK_SOURCE_COMMIT"] ?? ""
        try XCTSkipIf(source.isEmpty, "Run scripts/benchmark-latency.sh for measured samples")
        XCTAssertNotNil(source.range(of: "^[a-f0-9]{40,64}$", options: .regularExpression))
        var spans: [[String: String]] = []
        for suspended in [false, true] {
            for _ in 0..<(suspended ? 20 : 100) {
                let completed = expectation(description: "Original text is released")
                let capture = ExtensionLatencyCapture()
                let donation = ExtensionLatencyDonation()
                let content = UNMutableNotificationContent()
                content.body = "Fixture"
                let orchestrator = ReloNotificationServiceOrchestrator(
                    originalContent: content,
                    originalMetadata: ReloNotificationPresentationMetadata(categoryIdentifier: "RELO_APPROVAL",
                        threadIdentifier: "fixture", badgeNumber: 1),
                    contentHandler: { _ in capture.append(DispatchTime.now().uptimeNanoseconds); completed.fulfill() },
                    applyMetadata: ReloNotificationContentAdapter.applyingMetadata,
                    copyContent: ReloNotificationContentAdapter.copying)
                let start = DispatchTime.now().uptimeNanoseconds
                let task = orchestrator.start(context: ReloNotificationOrchestrationContext(hasEnvelope: true,
                    isPrivate: false, supportsCommunicationStyle: suspended, conversationIdentifier: "fixture"),
                    enrichMedia: { $0 }, donateAndUpdate: { _ in
                        if suspended { await donation.wait() }
                        return .donationFailed
                    })
                await fulfillment(of: [completed], timeout: 2)
                await donation.release()
                await task.value
                orchestrator.timeout()
                let values = capture.values
                XCTAssertEqual(values.count, 1)
                let end = values.first ?? DispatchTime.now().uptimeNanoseconds
                spans.append(["stage": "nse_processing",
                    "scenario": suspended ? "extension_suspended_donation_real_timer" : "extension_text_no_remote_media",
                    "sourceCommit": source, "process": "ios-extension-benchmark", "clock": "monotonic",
                    "outcome": values.count == 1 ? "ok" : "failed", "startNs": String(start), "endNs": String(end)])
            }
        }
        let lines = try spans.map { String(decoding: try JSONSerialization.data(withJSONObject: $0, options: [.sortedKeys]), as: UTF8.self) }.joined(separator: "\n")
        let attachment = XCTAttachment(data: Data((lines + "\n").utf8), uniformTypeIdentifier: "public.json")
        attachment.name = "relo-latency-extension.ndjson"; attachment.lifetime = .keepAlways; add(attachment)
    }
}

// Synchronization is confined to this callback capture; tests never share an instance.
private final class ExtensionLatencyCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var timestamps: [UInt64] = []
    func append(_ value: UInt64) { lock.lock(); defer { lock.unlock() }; timestamps.append(value) }
    var values: [UInt64] { lock.lock(); defer { lock.unlock() }; return timestamps }
}
private actor ExtensionLatencyDonation {
    private var continuation: CheckedContinuation<Void, Never>?
    private var released = false
    func wait() async {
        if released { return }
        await withCheckedContinuation { continuation = $0 }
    }
    func release() { released = true; continuation?.resume(); continuation = nil }
}
