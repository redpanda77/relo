import Intents
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
    private struct DownloadedMedia {
        let data: Data
        let response: URLResponse
    }

    private var orchestrator: ReloNotificationServiceOrchestrator<UNMutableNotificationContent>?
    private var enrichmentTask: Task<Void, Never>?

    private static let selfImposedTimeout: TimeInterval = 24

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        let content = (request.content.mutableCopy() as? UNMutableNotificationContent)
            ?? UNMutableNotificationContent()
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
        recordBestEffortReceipt(notificationID: envelope?.notificationID ?? request.identifier)

        DispatchQueue.global().asyncAfter(deadline: .now() + Self.selfImposedTimeout) {
            orchestrator.timeout()
        }

        enrichmentTask = Task { [weak self] in
            guard let self else { return }
            var imageMedia: DownloadedMedia?
            let context = ReloNotificationOrchestrationContext(
                hasEnvelope: envelope != nil,
                isPrivate: envelope?.privacy == .private,
                supportsCommunicationStyle: envelope.map(
                    ReloNotificationServicePolicy.shouldAttemptDonation
                ) ?? false,
                conversationIdentifier: envelope?.conversationIdentifier
            )
            await orchestrator.run(
                context: context,
                enrichMedia: { ownedContent in
                    guard let envelope else { return ownedContent }
                    imageMedia = await self.enrichMedia(content: ownedContent, envelope: envelope)
                    return ownedContent
                },
                donateAndUpdate: { enriched in
                    guard
                        let envelope,
                        let sourceName = envelope.sourceName,
                        let conversationIdentifier = envelope.conversationIdentifier
                    else { return .donationFailed }
                    return await self.donateAndUpdate(
                        content: enriched,
                        envelope: envelope,
                        sourceName: sourceName,
                        conversationIdentifier: conversationIdentifier,
                        imageMedia: imageMedia
                    )
                }
            )
        }
    }

    override func serviceExtensionTimeWillExpire() {
        enrichmentTask?.cancel()
        orchestrator?.timeout()
    }

    private func enrichMedia(
        content: UNMutableNotificationContent,
        envelope: ReloNotificationEnvelope
    ) async -> DownloadedMedia? {
        var imageMedia: DownloadedMedia?
        if let imageURL = envelope.imageURL {
            imageMedia = await download(imageURL, maximumBytes: ReloNotificationEnvelope.maximumAttachmentBytes)
            if let imageMedia {
                addAttachment(from: imageMedia, sourceURL: imageURL, to: content)
            }
        }
        return imageMedia
    }

    private func donateAndUpdate(
        content: UNMutableNotificationContent,
        envelope: ReloNotificationEnvelope,
        sourceName: String,
        conversationIdentifier: String,
        imageMedia: DownloadedMedia?
    ) async -> ReloNotificationDonationResult<UNMutableNotificationContent> {
        let avatar: INImage?
        if let avatarURL = envelope.avatarURL {
            if avatarURL == envelope.imageURL,
               let imageMedia,
               imageMedia.data.count <= ReloNotificationEnvelope.maximumAvatarBytes {
                avatar = INImage(imageData: imageMedia.data)
            } else if let avatarMedia = await download(
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
            sourceName: sourceName,
            conversationIdentifier: conversationIdentifier,
            avatar: avatar
        )
    }

    private func download(_ url: URL, maximumBytes: Int64) async -> DownloadedMedia? {
        var request = URLRequest(url: url)
        request.timeoutInterval = 8
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        let session = URLSession(
            configuration: configuration,
            delegate: ReloPublicImageRedirectDelegate(),
            delegateQueue: nil
        )
        defer { session.invalidateAndCancel() }
        do {
            let (temporaryURL, response) = try await session.download(for: request)
            guard !Task.isCancelled else { return nil }
            guard
                let finalURL = response.url,
                ReloPublicImageURLPolicy.validatedURL(finalURL.absoluteString) != nil
            else { return nil }
            let values = try temporaryURL.resourceValues(forKeys: [.fileSizeKey])
            let fileSize = Int64(values.fileSize ?? 0)
            guard ReloNotificationMediaPolicy.accepts(
                response: response,
                fileSize: fileSize,
                maximumBytes: maximumBytes
            ) else { return nil }
            return DownloadedMedia(data: try Data(contentsOf: temporaryURL), response: response)
        } catch {
            return nil
        }
    }

    private func addAttachment(
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

    private func donateCommunicationIntent(
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

    private func recordBestEffortReceipt(notificationID: String) {
        guard
            let appGroup = Bundle.main.object(forInfoDictionaryKey: "RELOAppGroup") as? String,
            !appGroup.isEmpty,
            let container = FileManager.default.containerURL(
                forSecurityApplicationGroupIdentifier: appGroup
            )
        else { return }
        ReloNotificationReceiptStore(baseDirectory: container).add(notificationID: notificationID)
    }
}
