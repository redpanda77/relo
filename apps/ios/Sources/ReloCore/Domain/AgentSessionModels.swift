import Foundation

/// A running coding-agent session the server knows about (hooks report facts; no card content).
/// Older servers omit sessions entirely, so every consumer treats the list as optional.
public struct AgentSession: Codable, Equatable, Identifiable, Sendable {
    public enum Presence: String, Codable, Sendable {
        case working, quiet, noCard = "no_card", ended, lost

        /// A presence this build does not know reads as "running, no card" rather than failing the snapshot.
        public init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Presence(rawValue: raw) ?? .noCard
        }
    }

    public struct Card: Codable, Equatable, Sendable {
        public let id: String
        public let state: String
        public let quietForSeconds: Int

        public init(id: String, state: String, quietForSeconds: Int) {
            self.id = id; self.state = state; self.quietForSeconds = quietForSeconds
        }
    }

    public let id: String
    public let harness: String
    /// Stored as received (opaque handles for encrypted work); read through the names below.
    private let storedComputer: String?
    private let storedAccount: String?
    private let storedProject: String?
    public var computer: String? { ReloNames.display(storedComputer) }
    public var account: String? { ReloNames.display(storedAccount) }
    public var project: String? { ReloNames.display(storedProject) }
    public let state: String
    public let startedAt: Date
    public let lastEventAt: Date
    public let card: Card?
    public let presence: Presence
    /// The names behind this session's handles, sealed for this phone (kind "names").
    public var sealedNames: ReloEnvelope? = nil

    private enum CodingKeys: String, CodingKey {
        case id, harness, state, startedAt, lastEventAt, card, presence, sealedNames
        case storedComputer = "computer", storedAccount = "account", storedProject = "project"
    }

    public init(id: String, harness: String, computer: String? = nil, account: String? = nil, project: String? = nil,
                state: String = "active", startedAt: Date, lastEventAt: Date, card: Card? = nil, presence: Presence) {
        self.id = id; self.harness = harness; self.storedComputer = computer; self.storedAccount = account
        self.storedProject = project; self.state = state; self.startedAt = startedAt; self.lastEventAt = lastEventAt
        self.card = card; self.presence = presence
    }
}

/// Pure view model for the AGENTS section: which sessions show, in what order, grouped how.
public enum AgentSessionsProjection {
    /// Ended and lost sessions stay visible this long after their last event.
    public static let recentWindow: TimeInterval = 3_600

    public struct Group: Equatable, Identifiable, Sendable {
        /// "MacBook Pro · Work".
        public let title: String
        public let sessions: [AgentSession]
        public var id: String { title }
    }

    public static func harnessName(_ harness: String) -> String {
        switch harness {
        case "claude-code": "Claude Code"
        case "codex": "Codex"
        case "opencode": "OpenCode"
        case "gemini": "Gemini CLI"
        case "cursor": "Cursor"
        default: harness
        }
    }

    public static func rank(_ presence: AgentSession.Presence) -> Int {
        switch presence {
        case .working: 0
        case .quiet: 1
        case .noCard: 2
        case .ended: 3
        case .lost: 4
        }
    }

    /// The session's process is alive (working, quiet or without a card); it may be idle.
    public static func isLive(_ session: AgentSession) -> Bool {
        switch session.presence {
        case .working, .quiet, .noCard: true
        case .ended, .lost: false
        }
    }

    /// Live and in the middle of a turn. After the agent's turn ends (Stop) the server sets the
    /// state to "idle": the agent is waiting for the owner, so it is not running.
    public static func isRunning(_ session: AgentSession) -> Bool {
        isLive(session) && session.state == "active"
    }

    /// Live but between turns, waiting for the owner.
    public static func isIdle(_ session: AgentSession) -> Bool {
        isLive(session) && session.state == "idle"
    }

    /// How many agents are running now (the HUD's AGENTS and the Agents section's count).
    public static func runningCount(_ sessions: [AgentSession]) -> Int {
        sessions.filter(isRunning).count
    }

    /// Running first (working, quiet, no card), then idle, then ended, then lost.
    static func order(_ session: AgentSession) -> Int {
        if isLive(session) && !isRunning(session) { return 3 }
        let base = rank(session.presence)
        return base >= 3 ? base + 1 : base
    }

    /// Live sessions first (running, then idle), then ended or lost within the last hour.
    public static func visible(_ sessions: [AgentSession], now: Date) -> [AgentSession] {
        sessions.filter { session in
            isLive(session) || now.timeIntervalSince(session.lastEventAt) <= recentWindow
        }
        .sorted {
            let (a, b) = (order($0), order($1))
            if a != b { return a < b }
            if $0.lastEventAt != $1.lastEventAt { return $0.lastEventAt > $1.lastEventAt }
            return $0.id < $1.id
        }
    }

    public static func groupTitle(_ session: AgentSession) -> String {
        let parts = [session.computer, session.account].compactMap { value -> String? in
            let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return trimmed.isEmpty ? nil : trimmed
        }
        return parts.isEmpty ? "Unknown computer" : parts.joined(separator: " · ")
    }

    /// Groups by computer · account; a group sits where its best session sits.
    public static func groups(_ sessions: [AgentSession], now: Date) -> [Group] {
        var order: [String] = []
        var buckets: [String: [AgentSession]] = [:]
        for session in visible(sessions, now: now) {
            let title = groupTitle(session)
            if buckets[title] == nil { order.append(title) }
            buckets[title, default: []].append(session)
        }
        return order.map { Group(title: $0, sessions: buckets[$0] ?? []) }
    }

    /// How long the session's CARD has been silent: the server's figure at fetch time plus the time
    /// since the fetch. (lastEventAt moves on every tool call, so it says nothing about the card.)
    public static func quietFor(_ session: AgentSession, fetchedAt: Date, now: Date) -> TimeInterval {
        let base = TimeInterval(session.card?.quietForSeconds ?? 0)
        return base + max(now.timeIntervalSince(fetchedAt), 0)
    }

    /// "14 min", "2 h", "2 h 5 min".
    public static func durationPhrase(_ seconds: TimeInterval) -> String {
        let minutes = max(1, Int(seconds / 60))
        if minutes < 60 { return "\(minutes) min" }
        return minutes % 60 == 0 ? "\(minutes / 60) h" : "\(minutes / 60) h \(minutes % 60) min"
    }

    /// "no update for 14 min".
    public static func quietPhrase(_ session: AgentSession, fetchedAt: Date, now: Date) -> String {
        "no update for \(durationPhrase(quietFor(session, fetchedAt: fetchedAt, now: now)))"
    }

    /// The row's status line: "working", "no update for 14 min", "running, no card",
    /// "idle, waiting for you", "ended", "lost contact".
    public static func statusPhrase(_ session: AgentSession, fetchedAt: Date, now: Date) -> String {
        if isIdle(session) { return "idle, waiting for you" }
        switch session.presence {
        case .working: return "working"
        case .quiet: return quietPhrase(session, fetchedAt: fetchedAt, now: now)
        case .noCard: return "running, no card"
        case .ended: return "ended"
        case .lost: return "lost contact"
        }
    }
}
