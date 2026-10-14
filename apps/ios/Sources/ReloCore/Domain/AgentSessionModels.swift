import Foundation

/// A coding-agent session as the server reports it (hooks report facts; no card content). Wire type only:
/// the server decides phase, order and visibility; the phone keeps no thresholds.
/// Older servers omit sessions entirely, so every consumer treats the list as optional.
public struct AgentSession: Codable, Equatable, Identifiable, Sendable {
    public enum Presence: String, Codable, Sendable {
        case working, quiet, noCard = "no_card", ended

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
    /// Why a waiting session waits: "input" (a permission or input prompt) or "turn" (the owner's turn).
    public var waitingFor: String? = nil
    public let startedAt: Date
    /// The session's last observed activity (a phase change or a heartbeat).
    public let lastSeenAt: Date
    public let card: Card?
    public let presence: Presence
    /// The server's phase (contracts `sessionPhase`); nil from a server that does not send it.
    public var phase: SessionPhase? = nil
    /// The names behind this session's handles, sealed for this phone (kind "names").
    public var sealedNames: ReloEnvelope? = nil

    private enum CodingKeys: String, CodingKey {
        case id, harness, waitingFor, startedAt, lastSeenAt, card, presence, phase, sealedNames
        case storedComputer = "computer", storedAccount = "account", storedProject = "project"
    }

    public init(id: String, harness: String, computer: String? = nil, account: String? = nil, project: String? = nil,
                waitingFor: String? = nil, startedAt: Date, lastSeenAt: Date, card: Card? = nil,
                presence: Presence, phase: SessionPhase? = nil) {
        self.id = id; self.harness = harness; self.storedComputer = computer; self.storedAccount = account
        self.storedProject = project; self.waitingFor = waitingFor; self.startedAt = startedAt
        self.lastSeenAt = lastSeenAt; self.card = card; self.presence = presence
        self.phase = phase
    }
}

/// Source (harness) display names: a label table, not a view of its own.
public enum SessionSource {
    public static func label(_ source: String) -> String {
        switch source {
        case "claude-code": "Claude Code"
        case "codex": "Codex"
        case "opencode": "OpenCode"
        case "gemini": "Gemini CLI"
        case "cursor": "Cursor"
        default: source
        }
    }

    /// "MacBook Pro · Work".
    public static func groupTitle(computer: String?, account: String?) -> String {
        let parts = [computer, account].compactMap { value -> String? in
            let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return trimmed.isEmpty ? nil : trimmed
        }
        return parts.isEmpty ? "Unknown computer" : parts.joined(separator: " · ")
    }
}
