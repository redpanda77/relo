import Foundation

/// The sealed parts of an inbox item as the server returns them to this phone: this phone's alert
/// envelope (title + summary) and the body envelope shared by every recipient phone.
public struct InboxSealedNotice: Codable, Equatable, Sendable {
    public let alert: ReloEnvelope?
    public let content: ReloEnvelope

    public init(alert: ReloEnvelope?, content: ReloEnvelope) {
        self.alert = alert
        self.content = content
    }
}

/// What `relo notify` seals: the body envelope carries all of it, the alert only title and summary.
public struct ReloSealedNoticeContent: Codable, Equatable, Sendable {
    public var title: String
    public var summary: String?
    public var body: String?
    public var bodyFormat: String?
    public var imageUrl: String?
    public var destinationUrl: String?
    public var sentAt: String?
}

/// Opens one envelope on this phone for the item carrying it (nil when it cannot: unverified sender,
/// rotated-away key, or a replay of another item's envelope).
public typealias ReloSealedOpener = @Sendable (ReloEnvelope, _ itemID: String) -> Data?

public extension InboxItem {
    /// The item with its sealed text opened on this phone, or unchanged when nothing opens.
    func openingSealed(_ open: ReloSealedOpener) -> InboxItem {
        guard let sealed else { return self }
        let decoder = JSONDecoder()
        let notice = open(sealed.content, id).flatMap { try? decoder.decode(ReloSealedNoticeContent.self, from: $0) }
            ?? sealed.alert.flatMap { open($0, id) }.flatMap { try? decoder.decode(ReloSealedNoticeContent.self, from: $0) }
        guard let notice else { return self }
        let body = notice.body
        let summary = notice.summary ?? body.map { String($0.prefix(240)) } ?? notice.title
        return InboxItem(
            id: id, kind: kind, sourceName: sourceName, sourceImageUrl: nil, title: notice.title,
            detail: body ?? notice.summary,
            content: body.map { Content(summary: summary, body: $0, format: notice.bodyFormat == "markdown" ? .markdown : .text,
                                        byteLength: $0.utf8.count) } ?? content,
            readAt: readAt, withdrawnAt: withdrawnAt, result: result, deliveryState: deliveryState,
            apnsAcceptedAt: apnsAcceptedAt, receivedAt: receivedAt, openedAt: openedAt, createdAt: createdAt,
            destinationUrl: notice.destinationUrl.flatMap(URL.init(string:)),
            // Opened on this phone, so it shows like any other item; `sealed` still marks it end-to-end.
            privacy: .standard,
            liveActivity: liveActivity, activitySummary: activitySummary,
            // A sealed question shows its real prompt once opened (E4.1).
            interaction: interaction.map { $0.replacingPrompt(notice.summary ?? notice.body ?? $0.prompt) }, context: context,
            resources: resources, activityEvent: activityEvent, activity: activity, sealed: sealed
        )
    }

    var isEndToEndEncrypted: Bool { sealed != nil }
}

public extension InboxHistoryPage {
    func openingSealed(_ open: ReloSealedOpener) -> InboxHistoryPage {
        InboxHistoryPage(items: items.map { $0.openingSealed(open) }, cursor: cursor, hasMore: hasMore, total: total,
                         serverTime: serverTime, readWatermark: readWatermark, unread: unread)
    }
}

public extension InboxNotificationDetail {
    func openingSealed(_ open: ReloSealedOpener) -> InboxNotificationDetail {
        InboxNotificationDetail(item: item.openingSealed(open), evidence: evidence)
    }
}

public extension InboxInteraction {
    func replacingPrompt(_ prompt: String) -> InboxInteraction {
        InboxInteraction(id: id, kind: kind, prompt: prompt, state: state, expiresAt: expiresAt, respondedAt: respondedAt)
    }
}
