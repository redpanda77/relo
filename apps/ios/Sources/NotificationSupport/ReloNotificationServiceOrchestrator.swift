import Foundation
#if canImport(UserNotifications)
import UserNotifications
#endif

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

final class ReloNotificationServiceOrchestrator<Content>: @unchecked Sendable {
    typealias ContentHandler = (Content) -> Void
    typealias MetadataApplier = (Content, ReloNotificationPresentationMetadata) -> Content
    typealias ContentCopier = (Content) -> Content

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

    func run(
        context: ReloNotificationOrchestrationContext,
        enrichMedia: (Content) async -> Content,
        donateAndUpdate: (Content) async -> ReloNotificationDonationResult<Content>
    ) async {
        guard context.hasEnvelope else {
            finish(bestAttemptSnapshot(), outcome: .passthrough, conversationIdentifier: nil)
            return
        }
        guard !context.isPrivate else {
            finish(bestAttemptSnapshot(), outcome: .privateContent, conversationIdentifier: nil)
            return
        }

        let enriched = await enrichMedia(bestAttemptSnapshot())
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
