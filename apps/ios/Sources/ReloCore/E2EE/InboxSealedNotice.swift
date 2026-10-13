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
        if sealed.content.kind == "card" { return openingSealedCard(sealed, open: open) }
        let decoder = JSONDecoder()
        let notice = open(sealed.content, id).flatMap { try? decoder.decode(ReloSealedNoticeContent.self, from: $0) }
            ?? sealed.alert.flatMap { open($0, id) }.flatMap { try? decoder.decode(ReloSealedNoticeContent.self, from: $0) }
        // Not openable here: show placeholders, never text the server put next to the envelope.
        guard let notice else { return lockedPlaceholder() }
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

/// The readable text an opened envelope gives a Now row: a notice or question (title, summary, body)
/// or a card (title, status, detail). Only the server's placeholders are replaced.
struct ReloOpenedRowText {
    static let titlePlaceholders: Set<String> = ["Encrypted card", "Encrypted notification", "Encrypted question"]
    static let summaryPlaceholders: Set<String> = [
        "Private notification", "Updating…", "Open Relo on your iPhone to read this.",
        "Open Relo on your iPhone to read this question.",
    ]

    let title: String?
    let summary: String?
    let status: String?

    init?(_ sealed: InboxSealedNotice, itemID: String, open: ReloSealedOpener) {
        guard let data = open(sealed.content, itemID) ?? sealed.alert.flatMap({ open($0, itemID) }),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        title = object["title"] as? String
        status = object["status"] as? String
        summary = (object["summary"] as? String) ?? (object["status"] as? String) ?? (object["detail"] as? String)
            ?? (object["body"] as? String).map { String($0.prefix(240)) }
    }

    /// A sealed row shows only text from its envelope or a placeholder, never other server-written text.
    static func title(_ text: ReloOpenedRowText?, replacing current: String) -> String {
        if let title = text?.title, !titlePlaceholders.contains(title), !title.isEmpty { return String(title.prefix(200)) }
        return titlePlaceholders.contains(current) ? current : "Encrypted notification"
    }

    /// The server may only shape a card's summary around "Updating…" (step counts); the status comes from the envelope.
    static func summary(_ text: ReloOpenedRowText?, replacing current: String) -> String {
        if let status = text?.status, current.contains("Updating…") {
            return String(current.replacingOccurrences(of: "Updating…", with: status).prefix(240))
        }
        if let summary = text?.summary, !summary.isEmpty { return String(summary.prefix(240)) }
        return summaryPlaceholders.contains(current) || current.contains("Updating…") ? current : "Open Relo on your iPhone to read this."
    }

    func status(replacing current: String?) -> String? {
        guard let current, let status, current.contains("Updating…") else { return current }
        return String(current.replacingOccurrences(of: "Updating…", with: status).prefix(240))
    }
}

public extension CurrentSubjectProjection {
    /// Live now with the real text: opens this phone's envelope and replaces the placeholders.
    func openingSealed(_ open: ReloSealedOpener) -> CurrentSubjectProjection {
        guard let sealed else { return self }
        let text = ReloOpenedRowText(sealed, itemID: notificationId ?? subjectId, open: open)
        return CurrentSubjectProjection(
            subjectId: subjectId, notificationId: notificationId, kind: kind, version: version,
            title: ReloOpenedRowText.title(text, replacing: title), summary: ReloOpenedRowText.summary(text, replacing: summary),
            source: source,
            createdAt: createdAt, updatedAt: updatedAt, occurredAt: occurredAt, acceptedAt: acceptedAt, readAt: readAt,
            currentUntil: currentUntil, freshUntil: freshUntil, deliverUntil: deliverUntil, freshness: freshness,
            interaction: interaction,
            activity: activity.map { CurrentActivity(id: $0.id, generation: $0.generation, sequence: $0.sequence,
                                                      status: text?.status(replacing: $0.status) ?? $0.status,
                                                      progress: $0.progress) },
            resources: resources, sealed: sealed
        )
    }
}

public extension PendingCurrentDecision {
    func openingSealed(_ open: ReloSealedOpener) -> PendingCurrentDecision {
        guard let sealed else { return self }
        let text = ReloOpenedRowText(sealed, itemID: notificationId, open: open)
        let fallbackTitle = sealed.content.kind == "question" && !ReloOpenedRowText.titlePlaceholders.contains(title) ? "Encrypted question" : title
        return PendingCurrentDecision(
            subjectId: subjectId, notificationId: notificationId, version: version, kind: kind,
            title: ReloOpenedRowText.title(text, replacing: fallbackTitle),
            summary: ReloOpenedRowText.summary(text, replacing: summary), source: source,
            createdAt: createdAt, readAt: readAt, urgencyRank: urgencyRank, interaction: interaction, sealed: sealed
        )
    }
}

public extension CurrentInboxResponse {
    func openingSealed(_ open: ReloSealedOpener) -> CurrentInboxResponse {
        var opened = self
        opened.items = items.map { $0.openingSealed(open) }
        return opened
    }
}

public extension PendingCurrentPage {
    func openingSealed(_ open: ReloSealedOpener) -> PendingCurrentPage {
        var opened = self
        opened.items = items.map { $0.openingSealed(open) }
        return opened
    }
}

extension InboxItem {
    /// A card event in History or Now: real title, status and current step from the card's envelope.
    func openingSealedCard(_ sealed: InboxSealedNotice, open: ReloSealedOpener) -> InboxItem {
        guard let data = open(sealed.content, id) ?? sealed.alert.flatMap({ open($0, id) }),
              let text = try? JSONDecoder().decode(ReloSealedCardText.self, from: data) else { return self }
        let placeholders: Set<String> = ["Encrypted card", "Encrypted question"]
        let realTitle = text.title.flatMap { placeholders.contains($0) ? nil : $0 }
        let shownTitle = placeholders.contains(title) ? (realTitle ?? title) : title
        let opened = { (value: String?) -> String? in
            guard let value, let status = text.status else { return value }
            return value.replacingOccurrences(of: "Updating…", with: status)
        }
        let card = activity.map { digest -> InboxCardDigest in
            let steps = digest.steps.map { steps -> InboxCardDigest.Steps in
                guard let current = steps.current, let labels = text.steps, current.hasPrefix("Step "),
                      let number = Int(current.dropFirst(5)), labels.indices.contains(number - 1) else { return steps }
                return .init(done: steps.done, total: steps.total, current: labels[number - 1])
            }
            return InboxCardDigest(state: digest.state, outcome: digest.outcome, status: opened(digest.status),
                                   progress: digest.progress, steps: steps, updates: digest.updates,
                                   startedAt: digest.startedAt, endedAt: digest.endedAt)
        }
        return InboxItem(
            id: id, kind: kind, sourceName: sourceName, sourceImageUrl: sourceImageUrl, title: shownTitle,
            detail: opened(detail) ?? text.status, content: content, readAt: readAt, withdrawnAt: withdrawnAt, result: result,
            deliveryState: deliveryState, apnsAcceptedAt: apnsAcceptedAt, receivedAt: receivedAt, openedAt: openedAt,
            createdAt: createdAt, destinationUrl: destinationUrl, privacy: privacy, liveActivity: liveActivity,
            activitySummary: activitySummary, interaction: interaction, context: context, resources: resources,
            activityEvent: activityEvent, activity: card, sealed: sealed
        )
    }
}

public extension InboxRepairResponse {
    /// The snapshot with sealed rows opened on this phone.
    func openingSealed(_ open: ReloSealedOpener) -> InboxRepairResponse {
        var opened = self
        opened.items = items.map { summary in
            var summary = summary
            summary.item = summary.item.openingSealed(open)
            return summary
        }
        // Opening a session's names teaches the name book; rows show them when displayed.
        for session in sessions ?? [] {
            if let names = session.sealedNames, names.kind == "names" { _ = open(names, session.id) }
        }
        return opened
    }
}

extension InboxItem {
    func lockedPlaceholder() -> InboxItem {
        guard let sealed else { return self }
        let question = sealed.content.kind == "question"
        return InboxItem(
            id: id, kind: kind, sourceName: sourceName, sourceImageUrl: nil,
            title: question ? "Encrypted question" : "Encrypted notification",
            detail: question ? "Open Relo on your iPhone to read this question." : "Open Relo on your iPhone to read this.", content: nil,
            readAt: readAt, withdrawnAt: withdrawnAt, result: result, deliveryState: deliveryState,
            apnsAcceptedAt: apnsAcceptedAt, receivedAt: receivedAt, openedAt: openedAt, createdAt: createdAt,
            destinationUrl: nil, privacy: .private, liveActivity: liveActivity, activitySummary: activitySummary,
            interaction: interaction.map { $0.replacingPrompt(ReloSealedCards.promptPlaceholder) }, context: context,
            resources: resources, activityEvent: activityEvent, activity: activity, sealed: sealed
        )
    }
}
