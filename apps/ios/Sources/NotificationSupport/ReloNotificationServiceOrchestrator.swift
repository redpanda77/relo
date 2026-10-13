import Foundation
#if canImport(UserNotifications)
import UserNotifications
#endif

enum ReloNotificationPresentationBudget {
    static let processingSeconds: TimeInterval = 0.150
    static let receiptLockSeconds: TimeInterval = 0.020
    // The total budget includes completion work and timer scheduling. Giving optional
    // donation the full 150 ms made the measured content callback miss that budget.
    static let enrichmentSeconds: TimeInterval = 0.100
}

struct ReloNotificationOrchestrationContext: Equatable, Sendable {
    let hasEnvelope: Bool
    let isPrivate: Bool
    let supportsCommunicationStyle: Bool
    let conversationIdentifier: String?
}

enum ReloNotificationDonationResult<Content> {
    case donationFailed
    case updated(Content)
    case contentUpdateFailed
}

/// The lock owns bestAttempt, completion and the single-use content handler. Content
/// is copied on entry, publication and retrieval, so the worker and deadline never
/// mutate the same instance. start transfers its request-local callbacks to one task.
/// The SDK content handler is not Sendable-annotated: it is stored under the
/// lock and handed to exactly one winning completion, never called concurrently.
/// Metadata/copy callbacks are Sendable and cannot capture mutable outside state.
/// Keep this narrow bridge until UserNotifications exposes a Sendable content API;
/// timeout/enrichment races and copy isolation are covered by the orchestration tests.
final class ReloNotificationServiceOrchestrator<Content>: @unchecked Sendable {
    typealias ContentHandler = (Content) -> Void
    typealias MetadataApplier = @Sendable (Content, ReloNotificationPresentationMetadata) -> Content
    typealias ContentCopier = @Sendable (Content) -> Content

    private let lock = NSLock()
    private let originalMetadata: ReloNotificationPresentationMetadata
    private let applyMetadata: MetadataApplier
    private let copyContent: ContentCopier
    private var bestAttempt: Content
    private var contentHandler: ContentHandler?
    private var completed = false

    init(
        originalContent: Content,
        originalMetadata: ReloNotificationPresentationMetadata,
        contentHandler: @escaping ContentHandler,
        applyMetadata: @escaping MetadataApplier,
        copyContent: @escaping ContentCopier
    ) {
        bestAttempt = copyContent(originalContent)
        self.originalMetadata = originalMetadata
        self.contentHandler = contentHandler
        self.applyMetadata = applyMetadata
        self.copyContent = copyContent
    }

    /// An independent timer can release text even when enrichment ignores cancellation.
    /// The returned task remains owned by the extension and is cancelled at the deadline.
    func start(
        context: ReloNotificationOrchestrationContext,
        enrichMedia: sending @escaping (Content) async -> Content,
        donateAndUpdate: sending @escaping (Content) async -> ReloNotificationDonationResult<Content>,
        scheduleTimeout: (TimeInterval, @escaping @Sendable () -> Void) -> Void = { seconds, callback in
            DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + seconds, execute: callback)
        }
    ) -> Task<Void, Never> {
        let task = Task {
            await run(context: context, enrichMedia: enrichMedia, donateAndUpdate: donateAndUpdate)
        }
        scheduleTimeout(ReloNotificationPresentationBudget.enrichmentSeconds) { [weak self] in
            self?.timeout()
            task.cancel()
        }
        return task
    }

    func run(
        context: ReloNotificationOrchestrationContext,
        enrichMedia: (Content) async -> Content,
        donateAndUpdate: (Content) async -> ReloNotificationDonationResult<Content>
    ) async {
        guard !hasCompleted, !Task.isCancelled else { return }
        guard context.hasEnvelope else {
            finish(bestAttemptSnapshot(), outcome: .passthrough, conversationIdentifier: nil)
            return
        }
        guard !context.isPrivate else {
            finish(bestAttemptSnapshot(), outcome: .privateContent, conversationIdentifier: nil)
            return
        }

        let enriched = await enrichMedia(bestAttemptSnapshot())
        guard !hasCompleted, !Task.isCancelled else { return }
        updateBestAttempt(enriched)
        guard context.supportsCommunicationStyle else {
            finish(enriched, outcome: .passthrough, conversationIdentifier: nil)
            return
        }

        switch await donateAndUpdate(enriched) {
        case .donationFailed:
            finish(
                enriched,
                outcome: .donationFailed,
                conversationIdentifier: context.conversationIdentifier
            )
        case let .updated(updated):
            updateBestAttempt(updated)
            finish(
                updated,
                outcome: .donationSucceeded,
                conversationIdentifier: context.conversationIdentifier
            )
        case .contentUpdateFailed:
            finish(
                enriched,
                outcome: .contentUpdateFailed,
                conversationIdentifier: context.conversationIdentifier
            )
        }
    }

    func timeout() {
        finish(bestAttemptSnapshot(), outcome: .timeout, conversationIdentifier: nil)
    }

    private var hasCompleted: Bool {
        lock.lock()
        defer { lock.unlock() }
        return completed
    }

    private func updateBestAttempt(_ content: Content) {
        lock.lock()
        if !completed { bestAttempt = copyContent(content) }
        lock.unlock()
    }

    private func bestAttemptSnapshot() -> Content {
        lock.lock()
        defer { lock.unlock() }
        return copyContent(bestAttempt)
    }

    private func finish(
        _ content: Content,
        outcome: ReloNotificationServiceOutcome,
        conversationIdentifier: String?
    ) {
        lock.lock()
        guard !completed else {
            lock.unlock()
            return
        }
        completed = true
        let handler = contentHandler
        contentHandler = nil
        let delivered = copyContent(content)
        let metadata = originalMetadata.resolved(
            for: outcome,
            conversationIdentifier: conversationIdentifier
        )
        lock.unlock()

        handler?(applyMetadata(delivered, metadata))
    }
}

#if canImport(UserNotifications)
enum ReloNotificationContentAdapter {
    static func copying(
        _ content: UNMutableNotificationContent
    ) -> UNMutableNotificationContent {
        (content.mutableCopy() as? UNMutableNotificationContent)
            ?? UNMutableNotificationContent()
    }

    static func applyingMetadata(
        _ content: UNMutableNotificationContent,
        _ metadata: ReloNotificationPresentationMetadata
    ) -> UNMutableNotificationContent {
        let delivered = copying(content)
        delivered.categoryIdentifier = metadata.categoryIdentifier
        delivered.threadIdentifier = metadata.threadIdentifier
        delivered.badge = metadata.badgeNumber.map { NSNumber(value: $0) }
        return delivered
    }
}
#endif
