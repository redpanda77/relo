import Foundation

/// One History row: where it came from, what it is, how it turned out, and how long and how much it took.
public struct HistoryRow: Equatable, Identifiable, Sendable {
    public enum Outcome: Equatable, Sendable {
        case running, done, stopped, expired, ended, replaced
        case waitingForYou, answered(String), unanswered
        case message

        public var label: String? {
            switch self {
            case .running: "Running"
            case .done: "Done"
            case .stopped: "Stopped"
            case .expired: "Expired"
            case .ended: "Ended"
            case .replaced: "Replaced"
            case .waitingForYou: "Needs you"
            case let .answered(answer): answer
            case .unanswered: "No answer"
            case .message: nil
            }
        }
    }

    public struct Steps: Equatable, Sendable {
        public let done: Int
        public let total: Int
        public let current: String?
    }

    /// A question asked on the card, and what became of it.
    public struct Decision: Equatable, Sendable {
        public let prompt: String
        public let answer: String
        public let pending: Bool
        public let declined: Bool
        public let at: Date?
    }

    public let id: String
    public let item: InboxItem
    public let source: InboxSourceIdentity
    public let project: InboxProjectIdentity?
    public let topic: String?
    public let type: String
    public let title: String
    public let summary: String?
    public let outcome: Outcome
    public let at: Date
    public let startedAt: Date?
    public let duration: TimeInterval?
    public let updates: Int?
    public let steps: Steps?
    public let progress: Double?
    public let decision: Decision?
    public let unread: Bool
    /// Which computer and agent account the card came from: "MacBook Pro · Work".
    public let origin: String?
}

public enum HistoryRowProjection {
    /// `rows` are the collapsed rows to show; `events` is everything loaded, so a card can find its questions.
    public static func rows(_ rows: [InboxItem], events: [InboxItem], now: Date) -> [HistoryRow] {
        var questions: [String: InboxItem] = [:]
        for event in events where event.interaction != nil {
            guard let card = InboxHistoryProjection.cardID(event) else { continue }
            if let known = questions[card], known.createdAt >= event.createdAt { continue }
            questions[card] = event
        }
        return rows.map { row($0, question: InboxHistoryProjection.cardID($0).flatMap { questions[$0] }, now: now) }
    }

    public static func row(_ item: InboxItem, question: InboxItem? = nil, now: Date) -> HistoryRow {
        let project = InboxHierarchyProjection.project(for: item)
        let topic = InboxSourceProjection.topic(for: item)?.name
        let title = ReloSealedCards.readableTitle(item.activitySummary?.title ?? item.title, prompt: item.interaction?.prompt)
        let card = item.kind == .liveActivity ? item.activity : nil
        let outcome = outcome(item, now: now)
        let startedAt = card?.startedAt ?? item.activitySummary?.createdAt
        let endedAt = card?.endedAt ?? item.activitySummary?.endedAt
        let duration = startedAt.flatMap { start in endedAt.map { $0.timeIntervalSince(start) } }.flatMap { $0 >= 0 ? $0 : nil }
        let steps = card?.steps.map { HistoryRow.Steps(done: $0.done, total: $0.total, current: $0.current) }
        let asked = (item.interaction != nil ? nil : question)?.interaction ?? nil
        return HistoryRow(
            id: item.id, item: item,
            source: InboxSourceProjection.source(for: item),
            project: project.isDirect ? nil : project,
            topic: topic.flatMap { $0.caseInsensitiveCompare(title) == .orderedSame ? nil : $0 },
            type: typeLabel(item), title: title,
            summary: summary(item, card: card, now: now).flatMap { $0.caseInsensitiveCompare(title) == .orderedSame ? nil : $0 },
            outcome: outcome,
            at: item.activitySummary?.updatedAt ?? item.createdAt,
            startedAt: startedAt, duration: duration,
            updates: card?.updates,
            steps: steps.flatMap { $0.total > 0 ? $0 : nil },
            progress: steps == nil ? card?.progress : nil,
            decision: asked.map { decision($0) },
            unread: item.readAt == nil,
            origin: origin(of: item))
    }

    /// "3 done · 1 stopped · 2 need you": how the day went, in the order that matters.
    public static func daySummary(_ rows: [HistoryRow], now: Date? = nil) -> String {
        var counts: [(String, Int)] = []
        func add(_ label: String, _ count: Int) { if count > 0 { counts.append((label, count)) } }
        add("need you", rows.filter { $0.outcome == .waitingForYou || $0.decision?.pending == true }.count)
        add("running", rows.filter { $0.outcome == .running }.count)
        add("done", rows.filter { $0.outcome == .done }.count)
        add("stopped", rows.filter { $0.outcome == .stopped }.count)
        add("ended", rows.filter { [.ended, .expired, .replaced].contains($0.outcome) }.count)
        add("answered", rows.filter { if case .answered = $0.outcome { true } else { $0.decision.map { !$0.pending } ?? false } }.count)
        add(rows.filter { $0.outcome == .message }.count == 1 ? "message" : "messages", rows.filter { $0.outcome == .message }.count)
        var parts = counts.map { "\($0.1) \($0.0)" }
        if let now, let time = agentTimeLabel(agentTime(rows, now: now)) { parts.append("\(time) session time") }
        return parts.joined(separator: " · ")
    }

    /// Total time agents spent on these cards: (ended or, while running, now) minus start.
    /// Messages and questions are not agent work; cards with no known end that are not running add nothing.
    public static func agentTime(_ rows: [HistoryRow], now: Date) -> TimeInterval {
        rows.reduce(0) { total, row in
            guard row.item.kind == .liveActivity, let start = row.startedAt else { return total }
            let span: TimeInterval
            if let duration = row.duration { span = duration }
            else if row.outcome == .running { span = now.timeIntervalSince(start) }
            else { return total }
            return total + max(0, span)
        }
    }

    /// Agent time on the calendar day of `now`.
    public static func agentTimeToday(_ rows: [HistoryRow], now: Date, calendar: Calendar = .current) -> TimeInterval {
        agentTime(rows.filter { calendar.isDate($0.at, inSameDayAs: now) }, now: now)
    }

    /// "4h 12m", "12m", "3h"; nil under a minute.
    public static func agentTimeLabel(_ seconds: TimeInterval) -> String? {
        let minutes = Int(seconds / 60)
        guard minutes >= 1 else { return nil }
        let hours = minutes / 60, rest = minutes % 60
        if hours == 0 { return "\(rest)m" }
        return rest == 0 ? "\(hours)h" : "\(hours)h \(rest)m"
    }

    /// The distinct origins in these rows, most common first (ties alphabetical).
    public static func origins(_ rows: [HistoryRow]) -> [String] {
        var counts: [String: Int] = [:]
        for origin in rows.compactMap(\.origin) { counts[origin, default: 0] += 1 }
        return counts.sorted { $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value }.map(\.key)
    }

    /// The computer and account an item came from.
    public static func origin(of item: InboxItem) -> String? {
        (item.context ?? item.activitySummary?.context)?.originLabel
    }

    /// Items from one origin; `nil` means all of them.
    public static func filter(_ items: [InboxItem], origin: String?) -> [InboxItem] {
        guard let origin else { return items }
        return items.filter { Self.origin(of: $0) == origin }
    }

    /// Rows from one origin; `nil` means all of them.
    public static func filter(_ rows: [HistoryRow], origin: String?) -> [HistoryRow] {
        guard let origin else { return rows }
        return rows.filter { $0.origin == origin }
    }

    public static func typeLabel(_ item: InboxItem) -> String {
        if let interaction = item.interaction {
            switch interaction.kind {
            case .approval: return "Approval"
            case .yesNo: return "Question"
            case .text: return "Reply request"
            case .choice: return "Choice"
            }
        }
        switch item.kind {
        case .liveActivity: return "Live Activity"
        case .response: return "Response"
        case .notification: return "Message"
        }
    }

    static func outcome(_ item: InboxItem, now: Date) -> HistoryRow.Outcome {
        if let interaction = item.interaction { return answer(interaction, now: now) }
        guard item.kind == .liveActivity else { return .message }
        if let card = item.activity {
            switch card.state {
            case "active": return .running
            case "expired": return .expired
            case "replaced": return .replaced
            default: return card.outcome == "completed" ? .done : card.outcome == "failed" ? .stopped : .ended
            }
        }
        switch InboxAttentionProjection.activityOutcome(item, now: now) {
        case .running: return .running
        case .completed: return .done
        case .stopped: return .stopped
        case .expired: return .expired
        case .ended: return .ended
        }
    }

    private static func answer(_ interaction: InboxInteraction, now: Date) -> HistoryRow.Outcome {
        switch interaction.state {
        case .pending: interaction.expiresAt > now ? .waitingForYou : .unanswered
        case .approved: .answered("Approved")
        case .denied: .answered("Declined")
        case .yes: .answered("Yes")
        case .no: .answered("No")
        case .replied: .answered(interaction.chosenLabel ?? "Replied")
        case .expired: .unanswered
        case .canceled: .answered("Withdrawn")
        }
    }

    private static func decision(_ interaction: InboxInteraction) -> HistoryRow.Decision {
        let answer: String = switch interaction.state {
        case .pending: "Waiting for you"
        case .approved: "You approved"
        case .denied: "You declined"
        case .yes: "You said yes"
        case .no: "You said no"
        case .replied: interaction.chosenLabel.map { "You chose \($0)" } ?? "You replied"
        case .expired: "No answer in time"
        case .canceled: "Withdrawn"
        }
        return .init(prompt: interaction.prompt, answer: answer, pending: interaction.state == .pending,
                     declined: [.denied, .no, .expired].contains(interaction.state), at: interaction.respondedAt)
    }

    /// The card's latest status says how the work went; a message or question says what it was about.
    private static func summary(_ item: InboxItem, card: InboxCardDigest?, now: Date) -> String? {
        if let status = card?.status ?? InboxAttentionProjection.finalStatus(item, now: now) ?? item.activitySummary?.status {
            return status
        }
        if let prompt = item.interaction?.prompt { return prompt }
        let detail = item.detail?.trimmingCharacters(in: .whitespacesAndNewlines)
        return detail?.isEmpty == false && detail != item.title ? detail : nil
    }
}
