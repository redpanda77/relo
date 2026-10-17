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

/// Why this phone cannot open an envelope: a `ReloSealedOpenRecord.Outcome` raw value ("not_for_this_phone",
/// "computer_unknown", …), or nil when unknown. Key ids and outcomes only, never text.
public typealias ReloSealedDiagnoser = @Sendable (ReloEnvelope) -> String?

public extension InboxItem {
    /// The item with its sealed text opened on this phone, or unchanged when nothing opens.
    /// `diagnose` explains an envelope that does not open, so the item says why instead of a placeholder.
    func openingSealed(_ open: ReloSealedOpener, diagnose: ReloSealedDiagnoser? = nil) -> InboxItem {
        guard let sealed else { return self }
        if sealed.content.kind == "card" { return openingSealedCard(sealed, open: open) }
        let decoder = JSONDecoder()
        let notice = open(sealed.content, id).flatMap { try? decoder.decode(ReloSealedNoticeContent.self, from: $0) }
            ?? sealed.alert.flatMap { open($0, id) }.flatMap { try? decoder.decode(ReloSealedNoticeContent.self, from: $0) }
        // Not openable here: show placeholders, never text the server put next to the envelope.
        guard let notice else { return lockedPlaceholder(outcome: diagnose?(sealed.content)) }
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
            liveActivity: liveActivity,
            activitySummary: activitySummary?.opening(title: notice.title, status: nil, detail: nil),
            // A sealed question shows its real prompt once opened (E4.1).
            interaction: interaction.map { $0.replacingPrompt(notice.summary ?? notice.body ?? $0.prompt) }, context: context,
            resources: resources, activityEvent: activityEvent, activity: activity, sealed: sealed, work: work?.withoutText
        )
    }

    var isEndToEndEncrypted: Bool { sealed != nil }

    /// Why this phone can't read a sealed item it could not open (its locked body), else nil.
    var unreadableLine: String? { sealed != nil && privacy == .private ? detail : nil }
}

public extension InboxHistoryPage {
    func openingSealed(_ open: ReloSealedOpener, diagnose: ReloSealedDiagnoser? = nil) -> InboxHistoryPage {
        InboxHistoryPage(items: items.map { $0.openingSealed(open, diagnose: diagnose) }, cursor: cursor, hasMore: hasMore,
                         total: total, serverTime: serverTime, readWatermark: readWatermark, unread: unread)
    }
}

public extension InboxNotificationDetail {
    func openingSealed(_ open: ReloSealedOpener, diagnose: ReloSealedDiagnoser? = nil) -> InboxNotificationDetail {
        InboxNotificationDetail(item: item.openingSealed(open, diagnose: diagnose), evidence: evidence)
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
    /// The whole plan with its sealed labels opened. The work's sealed text lists every visible step's
    /// label in plan order, as the server's plan does, so they pair by position when the counts agree.
    static func openingPlan(_ plan: [InboxCardDigest.PlanStep], text: ReloSealedCardText) -> [InboxCardDigest.PlanStep] {
        // v2 text names labels and details by step id; v1 lists labels in plan order.
        let byID = text.labelsByStepID, details = text.detailsByStepID
        let ordered = text.steps.flatMap { $0.count == plan.count ? $0 : nil }
        return plan.enumerated().map { index, step in
            let positional = ordered.map { ReloSealedCards.isPlaceholderStep($0[index]) ? nil : $0[index] } ?? nil
            return .init(id: step.id, state: step.state, label: step.label ?? byID[step.id] ?? positional, parent: step.parent,
                         round: step.round, detail: step.detail ?? details[step.id],
                         startedAt: step.startedAt, doneAt: step.doneAt)
        }
    }

    /// A card event in History or Now: real title, status and current step from the card's envelope.
    func openingSealedCard(_ sealed: InboxSealedNotice, open: ReloSealedOpener) -> InboxItem {
        guard let data = open(sealed.content, id) ?? sealed.alert.flatMap({ open($0, id) }),
              let text = try? JSONDecoder().decode(ReloSealedCardText.self, from: data) else {
            // Unopened: the plan keeps only what the server may know in the clear.
            return replacingWork(work?.withoutText)
        }
        let placeholders: Set<String> = ["Encrypted card", "Encrypted question"]
        let realTitle = text.title.flatMap { placeholders.contains($0) ? nil : $0 }
        let shownTitle = placeholders.contains(title) ? (realTitle ?? title) : title
        let opened = { (value: String?) -> String? in
            guard let value, let status = text.status else { return value }
            return value.replacingOccurrences(of: "Updating…", with: status)
        }
        let card = activity.map { digest -> InboxCardDigest in
            let steps = digest.steps.map { steps -> InboxCardDigest.Steps in
                // By the current step's id (v2), else by the placeholder's number (v1).
                guard let current = steps.current, ReloSealedCards.isPlaceholderStep(current),
                      let label = steps.currentId.flatMap({ text.labelsByStepID[$0] }) ?? text.legacyLabel(forPlaceholder: current)
                else { return steps }
                return .init(done: steps.done, total: steps.total, current: label, currentId: steps.currentId)
            }
            return InboxCardDigest(state: digest.state, outcome: digest.outcome, status: opened(digest.status),
                                   progress: digest.progress, steps: steps, updates: digest.updates,
                                   startedAt: digest.startedAt, endedAt: digest.endedAt,
                                   work: digest.work.map { $0.withoutText.opening(text) },
                                   plan: digest.plan.map { Self.openingPlan($0, text: text) }, rounds: digest.rounds)
        }
        return InboxItem(
            id: id, kind: kind, sourceName: sourceName, sourceImageUrl: sourceImageUrl, title: shownTitle,
            detail: opened(detail) ?? text.status, content: content, readAt: readAt, withdrawnAt: withdrawnAt, result: result,
            deliveryState: deliveryState, apnsAcceptedAt: apnsAcceptedAt, receivedAt: receivedAt, openedAt: openedAt,
            createdAt: createdAt, destinationUrl: destinationUrl, privacy: privacy, liveActivity: liveActivity,
            activitySummary: activitySummary?.opening(title: realTitle, status: text.status, detail: text.detail),
            interaction: interaction, context: context, resources: resources,
            activityEvent: activityEvent, activity: card, sealed: sealed,
            // The plan's titles and labels come only from this phone's envelope, matched by id.
            work: ReloWork.opened(work, text: text)
        )
    }
}

extension InboxActivitySummary {
    /// The card summary the detail screen shows, with the server's placeholders replaced by the
    /// opened text. Words the server wrote itself ("Approved", "Expired") stay.
    func opening(title openedTitle: String?, status openedStatus: String?, detail openedDetail: String?) -> InboxActivitySummary {
        let placeholders: Set<String> = ["Encrypted card", "Encrypted question"]
        return InboxActivitySummary(
            id: id, originThreadId: originThreadId, conversationId: conversationId, workItemId: workItemId,
            generation: generation, sequence: sequence, state: state,
            title: placeholders.contains(title) ? (openedTitle ?? title) : title,
            status: openedStatus.map { status.replacingOccurrences(of: "Updating…", with: $0) } ?? status,
            detail: detail ?? openedDetail, progress: progress, terminalReason: terminalReason, context: context,
            createdAt: createdAt, updatedAt: updatedAt, staleAt: staleAt, expiresAt: expiresAt, endedAt: endedAt
        )
    }
}

public extension InboxRepairResponse {
    /// The snapshot with sealed rows opened on this phone.
    func openingSealed(_ open: ReloSealedOpener, diagnose: ReloSealedDiagnoser? = nil) -> InboxRepairResponse {
        var opened = self
        opened.items = items.map { summary in
            var summary = summary
            summary.item = summary.item.openingSealed(open, diagnose: diagnose)
            return summary
        }
        return opened
    }
}

extension InboxItem {
    /// What a sealed item this phone cannot open shows: the placeholder title and, as its body, why this
    /// iPhone can't read it (never "Open Relo on your iPhone": this is the iPhone).
    func lockedPlaceholder(outcome: String? = nil) -> InboxItem {
        guard let sealed else { return self }
        let question = sealed.content.kind == "question"
        return InboxItem(
            id: id, kind: kind, sourceName: sourceName, sourceImageUrl: nil,
            title: question ? "Encrypted question" : "Encrypted notification",
            detail: ReloSealedCards.unreadableSentence(outcome: outcome), content: nil,
            readAt: readAt, withdrawnAt: withdrawnAt, result: result, deliveryState: deliveryState,
            apnsAcceptedAt: apnsAcceptedAt, receivedAt: receivedAt, openedAt: openedAt, createdAt: createdAt,
            destinationUrl: nil, privacy: .private, liveActivity: liveActivity, activitySummary: activitySummary,
            interaction: interaction.map { $0.replacingPrompt(ReloSealedCards.promptPlaceholder) }, context: context,
            resources: resources, activityEvent: activityEvent, activity: activity, sealed: sealed, work: work?.withoutText
        )
    }
}

public extension InboxItem {
    /// The card's steps for the detail timeline with the labels this phone opened: by step id, or by the
    /// number a "Step n" placeholder carries. `presented` are the card's own steps when it has them;
    /// otherwise they are rebuilt from the digest's counts. "Step n" stays only for a step whose text
    /// never reached this phone.
    func timelineSteps(presented: [LiveActivityDisplayPresentation.Step]) -> [LiveActivityDisplayPresentation.Step] {
        typealias Step = LiveActivityDisplayPresentation.Step
        if !presented.isEmpty {
            return presented.map { step in
                guard ReloSealedCards.isPlaceholderStep(step.label),
                      let label = work?.label(forStepID: step.id, placeholder: step.label) else { return step }
                return Step(id: step.id, label: label, state: step.state)
            }
        }
        guard let steps = activity?.steps, steps.total > 0 else { return [] }
        // Ids for the rebuilt steps: the card frame's when it lists them all, else the server's positional ones.
        let frame = work?.currentStepIDs ?? []
        let known = work?.steps ?? []
        let ids: [String] = frame.count == steps.total ? frame
            : known.count == steps.total ? known.map(\.id)
            : (0..<steps.total).map { "step_\($0 + 1)" }
        return ids.enumerated().map { index, id in
            let state: Step.State = index < steps.done ? .complete : index == steps.done ? .current : .pending
            let placeholder = "Step \(index + 1)"
            let label = work?.label(forStepID: id, placeholder: placeholder)
                ?? (state == .current ? steps.current.flatMap { ReloSealedCards.isPlaceholderStep($0) ? nil : $0 } : nil)
                ?? placeholder
            return Step(id: id, label: label, state: state)
        }
    }
}
