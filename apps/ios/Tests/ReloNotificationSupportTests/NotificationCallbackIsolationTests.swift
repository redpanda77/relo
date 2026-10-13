import Foundation
import Testing
@testable import ReloNotificationSupport

@Suite("Notification callback isolation")
struct NotificationCallbackIsolationTests {
    @Test(arguments: 0..<20)
    func racingDeadlineAndLateDonationCompleteExactlyOnce(_ iteration: Int) async {
        let delivery = CallbackDelivery()
        let gate = DonationGate()
        let original = "original-\(iteration)"
        let updated = "updated-\(iteration)"
        let orchestrator = ReloNotificationServiceOrchestrator(
            originalContent: original,
            originalMetadata: ReloNotificationPresentationMetadata(
                categoryIdentifier: "RELO_APPROVAL", threadIdentifier: "thread", badgeNumber: 1),
            contentHandler: { delivery.append($0) },
            applyMetadata: { content, _ in content },
            copyContent: { $0 }
        )
        let task = orchestrator.start(
            context: .init(hasEnvelope: true, isPrivate: false,
                           supportsCommunicationStyle: true, conversationIdentifier: "thread"),
            enrichMedia: { $0 },
            donateAndUpdate: { _ in .updated(await gate.wait()) },
            scheduleTimeout: { _, _ in }
        )
        await gate.waitUntilStarted()
        await withTaskGroup(of: Void.self) { group in
            for _ in 0..<16 { group.addTask { orchestrator.timeout() } }
            group.addTask { await gate.release(updated) }
        }
        await task.value
        orchestrator.timeout()
        let values = delivery.values
        #expect(values.count == 1)
        #expect(values.first == original || values.first == updated)
    }
}

/// The native content handler is synchronous. Only immutable String snapshots
/// leave this lock; append/read are the sole access paths to mutable storage.
private final class CallbackDelivery: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String] = []
    func append(_ value: String) { lock.withLock { storage.append(value) } }
    var values: [String] { lock.withLock { storage } }
}

private actor DonationGate {
    private var continuation: CheckedContinuation<String, Never>?
    private var started: CheckedContinuation<Void, Never>?
    func wait() async -> String {
        await withCheckedContinuation {
            continuation = $0
            started?.resume()
            started = nil
        }
    }
    func waitUntilStarted() async {
        guard continuation == nil else { return }
        await withCheckedContinuation { started = $0 }
    }
    func release(_ value: String) {
        continuation?.resume(returning: value)
        continuation = nil
    }
}
