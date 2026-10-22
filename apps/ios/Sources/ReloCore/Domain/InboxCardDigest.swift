import Foundation

/// A history event's card as it stands now: enough for a list to say how the work turned out.
public struct InboxCardDigest: Codable, Equatable, Sendable {
    public struct Steps: Codable, Equatable, Sendable {
        public let done: Int
        public let total: Int
        public let current: String?
        /// The current step's id, so a sealed label is found by id (ADR 0007); absent before works.
        public let currentId: String?
        /// The server's position of the current top-level step (from 1) and its fraction (0 to 1); absent on an older card.
        public let currentIndex: Int?
        public let fill: Double?

        public init(done: Int, total: Int, current: String?, currentId: String? = nil, currentIndex: Int? = nil, fill: Double? = nil) {
            self.currentIndex = currentIndex
            self.fill = fill
            self.done = done
            self.total = total
            self.current = current
            self.currentId = currentId
        }

        private enum CodingKeys: String, CodingKey { case done, total, current, currentId, currentIndex, fill }

        public init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            done = try values.decode(Int.self, forKey: .done)
            total = try values.decode(Int.self, forKey: .total)
            current = try values.decodeIfPresent(String.self, forKey: .current)
            currentId = (try? values.decodeIfPresent(String.self, forKey: .currentId)) ?? nil
            currentIndex = (try? values.decodeIfPresent(Int.self, forKey: .currentIndex)) ?? nil
            fill = (try? values.decodeIfPresent(Double.self, forKey: .fill)) ?? nil
        }
    }

    /// One step of the work's whole plan. The label is nil for sealed or private work (opened by id).
    /// `parent`, `round` and `detail` come with plan trees and rounds (ADR 0012); all are optional and
    /// a value of an unexpected type reads as absent, so an older or newer server never hides the plan.
    public struct PlanStep: Codable, Equatable, Hashable, Sendable {
        public let id: String
        public let state: String
        public let label: String?
        /// The parent step's id; steps stay in pre-order (a parent before its subtree).
        public let parent: String?
        /// The round the step belongs to; absent means round 1.
        public let round: Int?
        /// A readable work's longer note on the step.
        public let detail: String?
        /// When the step became current and when it was done (times are not content; plan 12b 4.5/4.6).
        public let startedAt: Date?
        public let doneAt: Date?
        /// The round whose unfinished step this one continues (set when a round opens without its own plan).
        public let carriedFrom: Int?
        /// The round's close skipped this open step (the agent did not choose to skip it): the next round carries it.
        public let dropped: Bool?

        public init(id: String, state: String, label: String?, parent: String? = nil, round: Int? = nil, detail: String? = nil,
                    startedAt: Date? = nil, doneAt: Date? = nil, carriedFrom: Int? = nil, dropped: Bool? = nil) {
            self.id = id; self.state = state; self.label = label
            self.parent = parent; self.round = round; self.detail = detail
            self.startedAt = startedAt; self.doneAt = doneAt
            self.carriedFrom = carriedFrom; self.dropped = dropped
        }

        private enum CodingKeys: String, CodingKey { case id, state, label, parent, round, detail, startedAt, doneAt, carriedFrom, dropped }

        public init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            id = try values.decode(String.self, forKey: .id)
            state = (try? values.decode(String.self, forKey: .state)) ?? "open"
            label = (try? values.decodeIfPresent(String.self, forKey: .label)) ?? nil
            parent = ((try? values.decodeIfPresent(String.self, forKey: .parent)) ?? nil).flatMap { $0.isEmpty ? nil : $0 }
            round = ((try? values.decodeIfPresent(Int.self, forKey: .round)) ?? nil).flatMap { $0 >= 1 ? $0 : nil }
            detail = ReloWork.text((try? values.decodeIfPresent(String.self, forKey: .detail)) ?? nil)
            startedAt = (try? values.decodeIfPresent(Date.self, forKey: .startedAt)) ?? nil
            doneAt = (try? values.decodeIfPresent(Date.self, forKey: .doneAt)) ?? nil
            carriedFrom = ((try? values.decodeIfPresent(Int.self, forKey: .carriedFrom)) ?? nil).flatMap { $0 >= 1 ? $0 : nil }
            dropped = (try? values.decodeIfPresent(Bool.self, forKey: .dropped)) ?? nil
        }
    }

    /// One round of the work's plan: a unit of delivery with its own steps and, once closed, an outcome.
    public struct PlanRound: Codable, Equatable, Hashable, Sendable {
        public let n: Int
        /// True when the round is closed (delivered); any other state reads as open.
        public let closed: Bool
        public let title: String?
        public let outcome: String?
        public let openedAt: Date?
        public let closedAt: Date?

        public init(n: Int, closed: Bool = false, title: String? = nil, outcome: String? = nil,
                    openedAt: Date? = nil, closedAt: Date? = nil) {
            self.n = n; self.closed = closed; self.title = title; self.outcome = outcome
            self.openedAt = openedAt; self.closedAt = closedAt
        }

        private enum CodingKeys: String, CodingKey { case n, state, title, outcome, openedAt, closedAt }

        public init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            n = try values.decode(Int.self, forKey: .n)
            closed = ((try? values.decodeIfPresent(String.self, forKey: .state)) ?? nil) == "closed"
            title = ReloWork.text((try? values.decodeIfPresent(String.self, forKey: .title)) ?? nil)
            outcome = ReloWork.text((try? values.decodeIfPresent(String.self, forKey: .outcome)) ?? nil)
            openedAt = (try? values.decodeIfPresent(Date.self, forKey: .openedAt)) ?? nil
            closedAt = (try? values.decodeIfPresent(Date.self, forKey: .closedAt)) ?? nil
        }

        public func encode(to encoder: Encoder) throws {
            var values = encoder.container(keyedBy: CodingKeys.self)
            try values.encode(n, forKey: .n)
            try values.encode(closed ? "closed" : "open", forKey: .state)
            try values.encodeIfPresent(title, forKey: .title)
            try values.encodeIfPresent(outcome, forKey: .outcome)
            try values.encodeIfPresent(openedAt, forKey: .openedAt)
            try values.encodeIfPresent(closedAt, forKey: .closedAt)
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
    /// The work's whole plan; the card itself carries only a window of a long one.
    public let plan: [PlanStep]?
    /// The plan's rounds; absent means one open round 1.
    public let rounds: [PlanRound]?

    public init(state: String, outcome: String? = nil, status: String? = nil, progress: Double? = nil,
                steps: Steps? = nil, updates: Int, startedAt: Date, endedAt: Date? = nil, work: ReloWork? = nil,
                plan: [PlanStep]? = nil, rounds: [PlanRound]? = nil) {
        self.plan = plan
        self.rounds = rounds
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

    private enum CodingKeys: String, CodingKey { case state, outcome, status, progress, steps, updates, startedAt, endedAt, work, plan, rounds }

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
        // `plan` is the steps; an object `{ steps, rounds }` (the work summary's shape) reads too.
        struct PlanObject: Decodable {
            let steps: [PlanStep]?
            let rounds: [PlanRound]?
            private enum CodingKeys: String, CodingKey { case steps, rounds }
            init(from decoder: Decoder) throws {
                let values = try decoder.container(keyedBy: CodingKeys.self)
                steps = ReloWork.lenientArray(values, .steps)
                rounds = ReloWork.lenientArray(values, .rounds)
            }
        }
        var decodedPlan = (try? values.decodeIfPresent([PlanStep].self, forKey: .plan)) ?? nil
        var decodedRounds: [PlanRound] = values.contains(.rounds) ? ReloWork.lenientArray(values, .rounds) : []
        if decodedPlan == nil, let object = (try? values.decodeIfPresent(PlanObject.self, forKey: .plan)) ?? nil {
            decodedPlan = object.steps
            if decodedRounds.isEmpty { decodedRounds = object.rounds ?? [] }
        }
        plan = decodedPlan.flatMap { $0.isEmpty ? nil : $0 }
        rounds = decodedRounds.isEmpty ? nil : decodedRounds
    }
}
