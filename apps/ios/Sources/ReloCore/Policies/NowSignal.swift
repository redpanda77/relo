import Foundation

/// What a thing on the Now screen means. Every color in the app maps to exactly one of these,
/// so the orb, the readouts, badges, activity bars and Live Activities all speak one language:
/// done is green, running is cyan, needs you is orange, attention is yellow, failed is red,
/// and messages are violet.
public enum NowSignal: Int, CaseIterable, Sendable {
    case done, running, needsYou, attention, failed, message

    public var label: String {
        switch self {
        case .done: "Done"
        case .running: "Running"
        case .needsYou: "Needs you"
        case .attention: "Attention"
        case .failed: "Failed"
        case .message: "Messages"
        }
    }

    /// The meaning of a History row's outcome.
    public static func of(_ outcome: HistoryRow.Outcome) -> NowSignal {
        switch outcome {
        case .done: .done
        case .running: .running
        case .waitingForYou: .needsYou
        case .stopped: .failed
        case .expired, .ended, .replaced, .unanswered: .attention
        case let .answered(answer): ["Declined", "No"].contains(answer) ? .attention : .done
        case .message: .message
        }
    }
}

/// Today's work by meaning: how much of it is each signal. The orb is colored in these
/// proportions, so the sphere itself shows how the day is going.
public struct NowMix: Equatable, Sendable {
    public let counts: [NowSignal: Int]

    public init(counts: [NowSignal: Int]) { self.counts = counts.filter { $0.value > 0 } }

    /// Today's rows plus what is live right now (requests waiting and running cards).
    public static func make(today rows: [HistoryRow], needsYou: Int, running: Int) -> NowMix {
        var counts: [NowSignal: Int] = [:]
        for row in rows where row.outcome != .running && row.outcome != .waitingForYou {
            counts[NowSignal.of(row.outcome), default: 0] += 1
        }
        counts[.needsYou, default: 0] += needsYou
        counts[.running, default: 0] += running
        return NowMix(counts: counts)
    }

    public var total: Int { counts.values.reduce(0, +) }
    public var isEmpty: Bool { total == 0 }

    /// Present signals in display order with their share of the whole.
    public var shares: [(signal: NowSignal, share: Double)] {
        let total = Double(max(self.total, 1))
        return NowSignal.allCases.compactMap { signal in
            counts[signal].map { (signal, Double($0) / total) }
        }
    }

    /// The signal at a position along the mix (0...1), for coloring a particle by its slot.
    public func signal(at position: Double) -> NowSignal? {
        var cumulative = 0.0
        for (signal, share) in shares {
            cumulative += share
            if position < cumulative { return signal }
        }
        return shares.last?.signal
    }
}

/// One hour of today's activity, split by meaning, for the activity strip.
public struct NowHourMix: Equatable, Sendable {
    public let hour: Int
    public let counts: [NowSignal: Int]
    public var total: Int { counts.values.reduce(0, +) }
}

public extension TodayActivity {
    /// Each hour's items split by meaning, in display order.
    var hourMixes: [NowHourMix] {
        let calendar = Calendar.current
        var hours = (0..<24).map { _ in [NowSignal: Int]() }
        for row in rows {
            let hour = min(23, max(0, calendar.component(.hour, from: row.at)))
            hours[hour][NowSignal.of(row.outcome), default: 0] += 1
        }
        return hours.enumerated().map { NowHourMix(hour: $0.offset, counts: $0.element) }
    }
}

/// Everything active right now, including cards that have gone quiet. The current-state feed
/// drops a card once it stops updating, so it is merged with History rows whose card is still
/// active; a card appears once, from History when available (it carries steps and progress).
public enum LiveNowProjection {
    public struct Card: Equatable, Identifiable, Sendable {
        public let id: String
        /// History row for the card when History has it; otherwise only the current-state subject.
        public let row: HistoryRow?
        public let subject: CurrentSubjectProjection?
        public let title: String
        public let status: String?
        public let progress: Double?
        public let updatedAt: Date
        public let notificationID: String?
        /// When the card started, for the live elapsed timer.
        public let startedAt: Date?
        /// "MacBook Pro · Work".
        public let origin: String?
        /// The agent session behind this card when it has gone quiet.
        public var quietSession: AgentSession? = nil
        /// When the session list was fetched; the card's silence grows from the server's figure at that time.
        public var quietSessionFetchedAt: Date? = nil

        /// "agent running, no update for 14 min" when the session behind the card is quiet.
        public func agentQuietPhrase(now: Date) -> String? {
            guard let quietSession, let fetched = quietSessionFetchedAt else { return nil }
            return "agent running, \(AgentSessionsProjection.quietPhrase(quietSession, fetchedAt: fetched, now: now))"
        }

        /// No update for this long reads as quiet (the card may have stalled).
        public func quietFor(now: Date) -> TimeInterval? {
            let silence = now.timeIntervalSince(updatedAt)
            return silence >= 20 * 60 ? silence : nil
        }
    }

    public static func make(history: [InboxItem], subjects: [CurrentSubjectProjection], sessions: [AgentSession] = [], sessionsFetchedAt: Date? = nil, now: Date) -> [Card] {
        let collapsed = InboxHistoryProjection.collapsedActivities(history)
        let rows = HistoryRowProjection.rows(collapsed, events: history, now: now).filter { $0.outcome == .running }
        var cards: [Card] = rows.map { row in
            Card(id: InboxHistoryProjection.cardID(row.item) ?? row.id, row: row, subject: nil, title: row.title,
                 status: row.summary, progress: row.progress, updatedAt: row.at, notificationID: row.id,
                 startedAt: row.startedAt, origin: row.origin)
        }
        let known = Set(cards.map(\.id))
        for subject in subjects where !known.contains(subject.activity?.id ?? subject.subjectId) {
            cards.append(Card(id: subject.activity?.id ?? subject.subjectId, row: nil, subject: subject,
                              title: subject.title, status: subject.summary.isEmpty ? subject.activity?.status : subject.summary,
                              progress: subject.activity?.progress, updatedAt: subject.updatedAt,
                              notificationID: subject.notificationId,
                              startedAt: subject.activity == nil ? nil : subject.createdAt, origin: nil))
        }
        let quiet = Dictionary(sessions.filter { $0.presence == .quiet }.compactMap { s in s.card.map { ($0.id, s) } },
                               uniquingKeysWith: { first, _ in first })
        for index in cards.indices { cards[index].quietSession = quiet[cards[index].id]
            cards[index].quietSessionFetchedAt = sessionsFetchedAt
        }
        return cards.sorted { $0.updatedAt == $1.updatedAt ? $0.id < $1.id : $0.updatedAt > $1.updatedAt }
    }
}

public extension LiveNowProjection.Card {
    /// "25M" or "2H 5M": how long a quiet card has been silent, for the QUIET badge.
    static func quietLabel(_ seconds: TimeInterval) -> String {
        let minutes = max(1, Int(seconds / 60))
        return minutes < 60 ? "\(minutes)M" : minutes % 60 == 0 ? "\(minutes / 60)H" : "\(minutes / 60)H \(minutes % 60)M"
    }
}
