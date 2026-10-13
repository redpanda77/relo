import Foundation

/// A history event's card as it stands now: enough for a list to say how the work turned out.
public struct InboxCardDigest: Codable, Equatable, Sendable {
    public struct Steps: Codable, Equatable, Sendable {
        public let done: Int
        public let total: Int
        public let current: String?

        public init(done: Int, total: Int, current: String?) {
            self.done = done
            self.total = total
            self.current = current
        }
    }

    public let state: String
    public let outcome: String?
    public let status: String?
    public let progress: Double?
    public let steps: Steps?
    public let updates: Int
    public let startedAt: Date
    public let endedAt: Date?

    public init(state: String, outcome: String? = nil, status: String? = nil, progress: Double? = nil,
                steps: Steps? = nil, updates: Int, startedAt: Date, endedAt: Date? = nil) {
        self.state = state
        self.outcome = outcome
        self.status = status
        self.progress = progress
        self.steps = steps
        self.updates = updates
        self.startedAt = startedAt
        self.endedAt = endedAt
    }
}
