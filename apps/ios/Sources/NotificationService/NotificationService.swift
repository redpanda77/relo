import ReloCore
import Intents
import OSLog
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
    private struct DownloadedMedia: Sendable {
        let data: Data
        let response: URLResponse
    }

    /// Shared only by this request's sequential enrichment and donation callbacks.
    private actor RequestMedia {
        private var image: DownloadedMedia?
        func store(_ image: DownloadedMedia?) { self.image = image }
        func load() -> DownloadedMedia? { image }
    }

    /// Immutable donation inputs captured before enrichment starts.
    private struct DonationInput: Sendable {
        let sourceName: String
        let conversationIdentifier: String
        let avatarURL: URL?
        let imageURL: URL?

        init?(_ envelope: ReloNotificationEnvelope) {
            guard let sourceName = envelope.sourceName,
                  let conversationIdentifier = envelope.conversationIdentifier
            else { return nil }
            self.sourceName = sourceName
            self.conversationIdentifier = conversationIdentifier
            avatarURL = envelope.avatarURL
            imageURL = envelope.imageURL
        }
    }

    private var orchestrator: ReloNotificationServiceOrchestrator<UNMutableNotificationContent>?
    private var enrichmentTask: Task<Void, Never>?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        let content = (request.content.mutableCopy() as? UNMutableNotificationContent)
            ?? UNMutableNotificationContent()
        // End-to-end sealed alert: open it on this phone before anything else, inside the budget.
        if let opened = ReloSealedContent.live().openAlert(userInfo: request.content.userInfo) {
            content.title = opened.title
            content.body = opened.body
        }
        let metadata = ReloNotificationPresentationMetadata(
            categoryIdentifier: content.categoryIdentifier,
            threadIdentifier: content.threadIdentifier,
            badgeNumber: content.badge?.intValue
        )
        let orchestrator = ReloNotificationServiceOrchestrator(
            originalContent: content,
            originalMetadata: metadata,
            contentHandler: contentHandler,
            applyMetadata: ReloNotificationContentAdapter.applyingMetadata,
            copyContent: ReloNotificationContentAdapter.copying
        )
        self.orchestrator = orchestrator

        let envelope = ReloNotificationEnvelope(
            userInfo: request.content.userInfo,
            requestIdentifier: request.identifier
        )
        let context = ReloNotificationOrchestrationContext(
            hasEnvelope: envelope != nil,
            isPrivate: envelope?.privacy == .private,
            supportsCommunicationStyle: envelope.map(ReloNotificationServicePolicy.shouldAttemptDonation) ?? false,
            conversationIdentifier: envelope?.conversationIdentifier
        )
        // Closures capture only immutable Sendable values so every supported compiler can
        // check the sending regions.
        let hasEnvelope = envelope != nil
        let imageURL = envelope?.imageURL
        let donation = envelope.flatMap(DonationInput.init)
        let imageMedia = RequestMedia()
        enrichmentTask = orchestrator.start(
            context: context,
            enrichMedia: { ownedContent in
                await Self.enrich(
                    content: ownedContent, hasEnvelope: hasEnvelope, imageURL: imageURL, imageMedia: imageMedia
                )
            },
            donateAndUpdate: { enriched in
                await Self.donate(content: enriched, donation: donation, imageMedia: imageMedia)
            }
        )
        // File access is best effort and must never hold the presentation deadline.
        let notificationID = envelope?.notificationID ?? request.identifier
        DispatchQueue.global(qos: .utility).async {
            Self.recordBestEffortReceipt(notificationID: notificationID, scope: envelope?.receiptScope)
        }
    }

    override func serviceExtensionTimeWillExpire() {
        enrichmentTask?.cancel()
        orchestrator?.timeout()
    }

    private static func enrich(
        content: UNMutableNotificationContent,
        hasEnvelope: Bool,
        imageURL: URL?,
        imageMedia: RequestMedia
    ) async -> UNMutableNotificationContent {
        guard hasEnvelope else { return content }
        var media: DownloadedMedia?
        if let imageURL {
            media = cachedMedia(imageURL, maximumBytes: ReloNotificationEnvelope.maximumAttachmentBytes)
            if let media {
                addAttachment(from: media, sourceURL: imageURL, to: content)
            }
        }
        await imageMedia.store(media)
        return content
    }

    private static func donate(
        content: UNMutableNotificationContent,
        donation: DonationInput?,
        imageMedia: RequestMedia
    ) async -> ReloNotificationDonationResult<UNMutableNotificationContent> {
        guard let donation else { return .donationFailed }
        let storedImage = await imageMedia.load()
        return await donateAndUpdate(content: content, donation: donation, imageMedia: storedImage)
    }

    private static func donateAndUpdate(
        content: UNMutableNotificationContent,
        donation: DonationInput,
        imageMedia: DownloadedMedia?
    ) async -> ReloNotificationDonationResult<UNMutableNotificationContent> {
        let avatar: INImage?
        if let avatarURL = donation.avatarURL {
            if avatarURL == donation.imageURL,
               let imageMedia,
               imageMedia.data.count <= ReloNotificationEnvelope.maximumAvatarBytes {
                avatar = INImage(imageData: imageMedia.data)
            } else if let avatarMedia = cachedMedia(
                avatarURL,
                maximumBytes: ReloNotificationEnvelope.maximumAvatarBytes
            ) {
                avatar = INImage(imageData: avatarMedia.data)
            } else {
                avatar = nil
            }
        } else {
            avatar = nil
        }

        return await donateCommunicationIntent(
            content: content,
            sourceName: donation.sourceName,
            conversationIdentifier: donation.conversationIdentifier,
            avatar: avatar
        )
    }

    /// This lookup never starts a URLSession request. A cache miss leaves text intact.
    private static func cachedMedia(_ url: URL, maximumBytes: Int64) -> DownloadedMedia? {
        guard !Task.isCancelled,
              let cached = URLCache.shared.cachedResponse(for: URLRequest(url: url)),
              let finalURL = cached.response.url,
              ReloPublicImageURLPolicy.validatedURL(finalURL.absoluteString) != nil,
              ReloNotificationMediaPolicy.accepts(
                response: cached.response, fileSize: Int64(cached.data.count), maximumBytes: maximumBytes
              )
        else { return nil }
        return DownloadedMedia(data: cached.data, response: cached.response)
    }

    private static func addAttachment(
        from media: DownloadedMedia,
        sourceURL: URL,
        to content: UNMutableNotificationContent
    ) {
        guard let fileExtension = ReloNotificationMediaPolicy.fileExtension(
            response: media.response,
            sourceURL: sourceURL
        ) else { return }
        let destination = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension(fileExtension)
        do {
            try media.data.write(to: destination, options: .atomic)
            let attachment = try UNNotificationAttachment(identifier: "relo-image", url: destination)
            content.attachments = [attachment]
        } catch {
            // The notification remains actionable without its optional media.
        }
    }

    private static func donateCommunicationIntent(
        content: UNMutableNotificationContent,
        sourceName: String,
        conversationIdentifier: String,
        avatar: INImage?
    ) async -> ReloNotificationDonationResult<UNMutableNotificationContent> {
        let identifier = "relo:\(conversationIdentifier)"
        let sender = INPerson(
            personHandle: INPersonHandle(value: identifier, type: .unknown),
            nameComponents: nil,
            displayName: sourceName,
            image: avatar,
            contactIdentifier: nil,
            customIdentifier: identifier
        )
        let intent = INSendMessageIntent(
            recipients: nil,
            outgoingMessageType: .outgoingMessageText,
            content: content.body,
            speakableGroupName: nil,
            conversationIdentifier: conversationIdentifier,
            serviceName: "Relo",
            sender: sender,
            attachments: nil
        )
        let interaction = INInteraction(intent: intent, response: nil)
        interaction.direction = .incoming
        let donated: Bool = await withCheckedContinuation { continuation in
            interaction.donate { error in
                continuation.resume(returning: error == nil)
            }
        }
        guard donated else { return .donationFailed }
        do {
            let updated = try content.updating(from: intent)
            let actionable = (updated.mutableCopy() as? UNMutableNotificationContent) ?? content
            return .updated(actionable)
        } catch {
            return .contentUpdateFailed
        }
    }

    private static func recordBestEffortReceipt(notificationID: String, scope: ReceiptScope?) {
        guard
            let appGroup = Bundle.main.object(forInfoDictionaryKey: "RELOAppGroup") as? String,
            !appGroup.isEmpty,
            let container = FileManager.default.containerURL(
                forSecurityApplicationGroupIdentifier: appGroup
            )
        else { return }
        let logger = Logger(subsystem: "relo.notification-service", category: "receipts")
        guard let scope else {
            logger.notice("Notification has no valid receipt scope; evidence cannot be reassigned")
            return
        }
        do {
            let result = try ReloNotificationReceiptStore(baseDirectory: container).add(
                record: NotificationReceiptRecord(scope: scope, notificationID: notificationID),
                lockWait: ReloNotificationPresentationBudget.receiptLockSeconds
            )
            switch result {
            case .inserted, .duplicate: break
            case .insertedWithEviction(let count): logger.notice("Receipt capacity retired \(count) oldest records")
            case .notRecordedWithinBudget: logger.notice("Receipt lock budget elapsed; presentation continues")
            }
        } catch {
            logger.error("Receipt persistence failed; presentation continues")
        }
    }
}
