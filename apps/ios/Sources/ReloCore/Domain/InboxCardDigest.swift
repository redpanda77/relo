import Foundation

/// A history event's card as it stands now: enough for a list to say how the work turned out.
public struct InboxCardDigest: Codable, Equatable, Sendable {
    public struct Steps: Codable, Equatable, Sendable {
        public let done: Int
        public let total: Int
        public let current: String?
        /// The current step's id, so a sealed label is found by id (ADR 0007); absent before works.
        public let currentId: String?

        public init(done: Int, total: Int, current: String?, currentId: String? = nil) {
            self.done = done
            self.total = total
            self.current = current
            self.currentId = currentId
        }

        private enum CodingKeys: String, CodingKey { case done, total, current, currentId }

        public init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            done = try values.decode(Int.self, forKey: .done)
            total = try values.decode(Int.self, forKey: .total)
            current = try values.decodeIfPresent(String.self, forKey: .current)
            currentId = (try? values.decodeIfPresent(String.self, forKey: .currentId)) ?? nil
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
    /// The work this card belongs to and where it stands (ADR 0007); absent before works.
    public let work: ReloWork?

    public init(state: String, outcome: String? = nil, status: String? = nil, progress: Double? = nil,
                steps: Steps? = nil, updates: Int, startedAt: Date, endedAt: Date? = nil, work: ReloWork? = nil) {
        self.state = state
        self.outcome = outcome
        self.status = status
        self.progress = progress
        self.steps = steps
        self.updates = updates
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.work = work
    }

    private enum CodingKeys: String, CodingKey { case state, outcome, status, progress, steps, updates, startedAt, endedAt, work }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        state = try values.decode(String.self, forKey: .state)
        outcome = try values.decodeIfPresent(String.self, forKey: .outcome)
        status = try values.decodeIfPresent(String.self, forKey: .status)
        progress = try values.decodeIfPresent(Double.self, forKey: .progress)
        steps = try values.decodeIfPresent(Steps.self, forKey: .steps)
        updates = try values.decode(Int.self, forKey: .updates)
        startedAt = try values.decode(Date.self, forKey: .startedAt)
        endedAt = try values.decodeIfPresent(Date.self, forKey: .endedAt)
        work = ((try? values.decodeIfPresent(ReloWork.self, forKey: .work)) ?? nil).flatMap { $0.isEmpty ? nil : $0 }
    }
}
