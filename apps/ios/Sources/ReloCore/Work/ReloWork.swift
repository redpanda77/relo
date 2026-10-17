import Foundation

/// A work (ADR 0007): one goal with phases and steps, shown by one or more cards over its life.
///
/// The server sends what it knows in the clear (ids, states, positions, times); titles and labels of
/// an end-to-end encrypted work arrive only in the card's sealed text and are merged in on this phone
/// (`opening(_:)`). Every part is optional and decoding never fails on a part it does not understand,
/// so an item from a server that does not send works yet reads exactly as before.
public struct ReloWork: Codable, Equatable, Hashable, Sendable {
    public enum State: String, Codable, Hashable, Sendable {
        case active, waiting, stale, succeeded, failed, cancelled, abandoned, unknown

        public init(wire: String?) {
            switch wire?.lowercased() {
            case "active", "running": self = .active
            case "waiting": self = .waiting
            case "stale": self = .stale
            case "succeeded", "completed", "done": self = .succeeded
            case "failed": self = .failed
            case "cancelled", "canceled": self = .cancelled
            case "abandoned": self = .abandoned
            default: self = .unknown
            }
        }

        public var isFinished: Bool { [.succeeded, .failed, .cancelled, .abandoned].contains(self) }
    }

    public enum ProgressState: String, Codable, Hashable, Sendable {
        case pending, current, done, skipped

        public init?(wire: String?) {
            switch wire?.lowercased() {
            case "pending", "todo", "queued": self = .pending
            case "current", "active", "running", "in_progress": self = .current
            case "done", "complete", "completed", "succeeded": self = .done
            case "skipped", "removed": self = .skipped
            default: return nil
            }
        }
    }

    public struct Step: Codable, Equatable, Hashable, Sendable, Identifiable {
        public let id: String
        public var state: ProgressState?
        /// Plain text from the server, or the label opened from the sealed text.
        public var label: String?
        /// A longer note on the step, from the server (readable works) or the sealed text.
        public var detail: String?

        public init(id: String, state: ProgressState? = nil, label: String? = nil, detail: String? = nil) {
            self.id = id
            self.state = state
            self.label = label
            self.detail = detail
        }

        private enum CodingKeys: String, CodingKey { case id, state, label, detail }

        public init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            id = try values.decode(String.self, forKey: .id)
            state = ProgressState(wire: try? values.decodeIfPresent(String.self, forKey: .state))
            // "Step n" is the server's stand-in for a sealed label, not a label.
            label = ReloWork.text(try? values.decodeIfPresent(String.self, forKey: .label))
                .flatMap { ReloSealedCards.isPlaceholderStep($0) ? nil : $0 }
            detail = ReloWork.text((try? values.decodeIfPresent(String.self, forKey: .detail)) ?? nil)
        }
    }

    public struct Phase: Codable, Equatable, Hashable, Sendable, Identifiable {
        public let id: String
        public var title: String?
        /// What a closed round delivered (a round is the phase `r<n>`).
        public var outcome: String?
        public var state: ProgressState?
        public var startedAt: Date?
        public var endedAt: Date?
        public var steps: [Step]

        public init(id: String, title: String? = nil, outcome: String? = nil, state: ProgressState? = nil,
                    startedAt: Date? = nil, endedAt: Date? = nil, steps: [Step] = []) {
            self.id = id
            self.title = title
            self.outcome = outcome
            self.state = state
            self.startedAt = startedAt
            self.endedAt = endedAt
            self.steps = steps
        }

        private enum CodingKeys: String, CodingKey { case id, title, outcome, state, startedAt, endedAt, finishedAt, completedAt, steps }

        public init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            id = try values.decode(String.self, forKey: .id)
            title = ReloWork.text(try? values.decodeIfPresent(String.self, forKey: .title))
                .flatMap { ReloSealedCards.isPlaceholderPhase($0) ? nil : $0 }
            outcome = ReloWork.text((try? values.decodeIfPresent(String.self, forKey: .outcome)) ?? nil)
            state = ProgressState(wire: try? values.decodeIfPresent(String.self, forKey: .state))
            startedAt = (try? values.decodeIfPresent(Date.self, forKey: .startedAt)) ?? nil
            endedAt = ((try? values.decodeIfPresent(Date.self, forKey: .endedAt)) ?? nil)
                ?? ((try? values.decodeIfPresent(Date.self, forKey: .finishedAt)) ?? nil)
                ?? ((try? values.decodeIfPresent(Date.self, forKey: .completedAt)) ?? nil)
            steps = ReloWork.lenientArray(values, .steps)
        }

        public func encode(to encoder: Encoder) throws {
            var values = encoder.container(keyedBy: CodingKeys.self)
            try values.encode(id, forKey: .id)
            try values.encodeIfPresent(title, forKey: .title)
            try values.encodeIfPresent(outcome, forKey: .outcome)
            try values.encodeIfPresent(state?.rawValue, forKey: .state)
            try values.encodeIfPresent(startedAt, forKey: .startedAt)
            try values.encodeIfPresent(endedAt, forKey: .endedAt)
            try values.encode(steps, forKey: .steps)
        }
    }

    /// Where the work stands now: the current phase by id and position, and how many phases there are.
    /// The Lock Screen uses it when the sealed text carries only the current phase.
    ///
    /// On the wire (packages/contracts/src/works.ts) `index` is one-based: `{ id, index, count, title? }`.
    public struct PhasePosition: Codable, Equatable, Hashable, Sendable {
        public var id: String?
        /// Zero-based position of the current phase (the wire's `index` minus one).
        public var index: Int?
        public var count: Int?
        /// The phase's name when the server may show it (never for sealed text: "Phase n" is dropped).
        public var title: String?
        /// The current step, from the work's `step`.
        public var stepId: String?

        public init(id: String? = nil, index: Int? = nil, count: Int? = nil, title: String? = nil, stepId: String? = nil) {
            self.id = id
            self.index = index
            self.count = count
            self.title = title
            self.stepId = stepId
        }

        private enum CodingKeys: String, CodingKey { case id, index, count, title, stepId }

        public init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            id = (try? values.decodeIfPresent(String.self, forKey: .id)) ?? nil
            index = ((try? values.decodeIfPresent(Int.self, forKey: .index)) ?? nil).flatMap { $0 >= 1 ? $0 - 1 : nil }
            count = ((try? values.decodeIfPresent(Int.self, forKey: .count)) ?? nil).flatMap { $0 >= 1 ? $0 : nil }
            title = ReloWork.text((try? values.decodeIfPresent(String.self, forKey: .title)) ?? nil)
                .flatMap { ReloSealedCards.isPlaceholderPhase($0) ? nil : $0 }
            stepId = (try? values.decodeIfPresent(String.self, forKey: .stepId)) ?? nil
        }

        public func encode(to encoder: Encoder) throws {
            var values = encoder.container(keyedBy: CodingKeys.self)
            try values.encodeIfPresent(id, forKey: .id)
            try values.encodeIfPresent(index.map { $0 + 1 }, forKey: .index)
            try values.encodeIfPresent(count, forKey: .count)
            try values.encodeIfPresent(title, forKey: .title)
            try values.encodeIfPresent(stepId, forKey: .stepId)
        }
    }

    /// One entry of the append-only plan revision log.
    public struct Revision: Codable, Equatable, Hashable, Sendable, Identifiable {
        public let revision: Int
        public var reason: String?
        public var at: Date?
        public var id: Int { revision }

        public init(revision: Int, reason: String? = nil, at: Date? = nil) {
            self.revision = revision
            self.reason = reason
            self.at = at
        }

        private enum CodingKeys: String, CodingKey { case revision, reason, at, createdAt }

        public init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            revision = try values.decode(Int.self, forKey: .revision)
            reason = ReloWork.text(try? values.decodeIfPresent(String.self, forKey: .reason))
            at = ((try? values.decodeIfPresent(Date.self, forKey: .at)) ?? nil)
                ?? ((try? values.decodeIfPresent(Date.self, forKey: .createdAt)) ?? nil)
        }

        public func encode(to encoder: Encoder) throws {
            var values = encoder.container(keyedBy: CodingKeys.self)
            try values.encode(revision, forKey: .revision)
            try values.encodeIfPresent(reason, forKey: .reason)
            try values.encodeIfPresent(at, forKey: .at)
        }
    }

    public var id: String?
    public var state: State?
    public var title: String?
    public var phase: PhasePosition?
    public var phases: [Phase]
    public var revisions: [Revision]
    /// The plan's revision number (`plan.revision`).
    public var planRevision: Int?
    /// The current phase's step ids, as a card's work frame lists them.
    public var currentStepIDs: [String]

    public init(id: String?, state: State? = nil, title: String? = nil, phase: PhasePosition? = nil,
                phases: [Phase] = [], revisions: [Revision] = [], planRevision: Int? = nil, currentStepIDs: [String] = []) {
        self.id = id
        self.state = state
        self.title = title
        self.phase = phase
        self.phases = phases
        self.revisions = revisions
        self.planRevision = planRevision
        self.currentStepIDs = currentStepIDs
    }

    private enum CodingKeys: String, CodingKey { case id, workId, state, title, phase, phases, revisions, plan, steps, step, planRevision }
    private enum PlanKeys: String, CodingKey { case revision, phases }
    private enum StepKeys: String, CodingKey { case id }

    /// Reads the work resource (`plan: { revision, phases }`, `phase`, `step: { id }`), the card frame
    /// (`phase`, `steps: [id]`, `step: id`) and this app's own cache form alike.
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = ReloWork.text(((try? values.decodeIfPresent(String.self, forKey: .id)) ?? nil)
            ?? ((try? values.decodeIfPresent(String.self, forKey: .workId)) ?? nil))
        state = ((try? values.decodeIfPresent(String.self, forKey: .state)) ?? nil).map { State(wire: $0) }
        title = ReloWork.text(try? values.decodeIfPresent(String.self, forKey: .title))
            .flatMap { ReloSealedCards.isPlaceholderTitle($0) ? nil : $0 }
        phase = (try? values.decodeIfPresent(PhasePosition.self, forKey: .phase)) ?? nil
        var phases: [Phase] = ReloWork.lenientArray(values, .phases)
        planRevision = (try? values.decodeIfPresent(Int.self, forKey: .planRevision)) ?? nil
        if let plan = try? values.nestedContainer(keyedBy: PlanKeys.self, forKey: .plan) {
            if phases.isEmpty { phases = ReloWork.lenientArray(plan, .phases) }
            planRevision = (try? plan.decodeIfPresent(Int.self, forKey: .revision)) ?? planRevision
        }
        self.phases = phases
        revisions = ReloWork.lenientArray(values, .revisions)
        currentStepIDs = ((try? values.decodeIfPresent([String].self, forKey: .steps)) ?? nil) ?? []
        let step = ((try? values.decodeIfPresent(String.self, forKey: .step)) ?? nil)
            ?? ((try? values.nestedContainer(keyedBy: StepKeys.self, forKey: .step))
                .flatMap { try? $0.decodeIfPresent(String.self, forKey: .id) } ?? nil)
        if let step {
            var position = phase ?? PhasePosition()
            position.stepId = position.stepId ?? step
            phase = position
        }
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encodeIfPresent(id, forKey: .id)
        try values.encodeIfPresent(state?.rawValue, forKey: .state)
        try values.encodeIfPresent(title, forKey: .title)
        try values.encodeIfPresent(phase, forKey: .phase)
        if !phases.isEmpty { try values.encode(phases, forKey: .phases) }
        if !revisions.isEmpty { try values.encode(revisions, forKey: .revisions) }
        try values.encodeIfPresent(planRevision, forKey: .planRevision)
        if !currentStepIDs.isEmpty { try values.encode(currentStepIDs, forKey: .steps) }
    }

    func with(id: String) -> ReloWork {
        var copy = self
        copy.id = id
        return copy
    }

    /// Nothing worth keeping: no id to group by and no plan to show.
    public var isEmpty: Bool { id == nil && phases.isEmpty && phase == nil && revisions.isEmpty && currentStepIDs.isEmpty }

    /// Every step in plan order.
    public var steps: [Step] { phases.flatMap(\.steps) }

    /// Zero-based position of the current phase: the server's position, else the phase holding the
    /// current step, else the first phase not done.
    public var currentPhaseIndex: Int? {
        guard !phases.isEmpty else { return nil }
        if let id = phase?.id, let index = phases.firstIndex(where: { $0.id == id }) { return index }
        if let index = phases.firstIndex(where: { $0.state == .current }) { return index }
        if let index = phases.firstIndex(where: { $0.steps.contains { $0.state == .current } }) { return index }
        if phases.count == phase?.count, let index = phase?.index, phases.indices.contains(index) { return index }
        if let index = phases.firstIndex(where: { ![.done, .skipped].contains($0.state ?? .pending) }) { return index }
        return phases.count - 1
    }

    // MARK: Sealed text

    /// The work with titles and labels from this phone's opened text, matched by id. Phases the
    /// server did not list (an older server) come from the text in its order.
    public func opening(_ text: ReloSealedCardText) -> ReloWork {
        var opened = self
        opened.title = text.title.flatMap { ReloSealedCards.isPlaceholderTitle($0) ? nil : ReloWork.text($0) } ?? title
        // The update's own step (sealed text), for grouping updates by step; the server's frame wins when it sent one.
        if let stepId = text.stepId, opened.phase?.stepId == nil {
            var position = opened.phase ?? PhasePosition()
            position.stepId = stepId
            opened.phase = position
        }
        let sealedPhases = text.phases ?? []
        if opened.phases.isEmpty {
            opened.phases = sealedPhases.map { phase in
                Phase(id: phase.id, title: ReloWork.text(phase.title), outcome: ReloWork.text(phase.outcome),
                      steps: (phase.steps ?? []).map {
                          Step(id: $0.id, label: ReloWork.text($0.label), detail: ReloWork.text($0.detail))
                      })
            }
            return opened
        }
        let titles = Dictionary(sealedPhases.map { ($0.id, $0.title) }, uniquingKeysWith: { first, _ in first })
        let outcomes = Dictionary(sealedPhases.map { ($0.id, $0.outcome) }, uniquingKeysWith: { first, _ in first })
        let labels = text.labelsByStepID
        let details = text.detailsByStepID
        opened.phases = phases.map { phase in
            var phase = phase
            if let title = titles[phase.id].flatMap(ReloWork.text) { phase.title = title }
            if let outcome = outcomes[phase.id].flatMap(ReloWork.text) { phase.outcome = outcome }
            phase.steps = phase.steps.map { step in
                var step = step
                if let label = labels[step.id] { step.label = label }
                if let detail = details[step.id] { step.detail = detail }
                return step
            }
            return phase
        }
        return opened
    }

    /// A card's work as this phone reads it: the server's ids and states with titles and labels only
    /// from the opened text (v2 by id; v1 under the positional ids `step_n`).
    public static func opened(_ work: ReloWork?, text: ReloSealedCardText) -> ReloWork? {
        guard var opened = (work ?? (text.phases == nil ? nil : ReloWork(id: nil)))?.withoutText.opening(text) else {
            return legacy(text)
        }
        if opened.phases.isEmpty, let legacy = legacy(text) { opened.phases = legacy.phases }
        return opened
    }

    /// The stand-in phase holding a v1 card's labels; never shown as a phase.
    public static let legacyPhaseID = "_v1_steps"

    /// A v1 card's labels (no work, no phases) under the server's positional ids `step_1…`, so
    /// screens that show the card's steps find them by id. Carries no work id: it never groups.
    public static func legacy(_ text: ReloSealedCardText) -> ReloWork? {
        guard let labels = text.steps, !labels.isEmpty else { return nil }
        let steps = labels.enumerated().compactMap { index, label -> Step? in
            guard let label = ReloWork.text(label), !ReloSealedCards.isPlaceholderStep(label) else { return nil }
            return Step(id: "step_\(index + 1)", label: label)
        }
        return steps.isEmpty ? nil : ReloWork(id: nil, phases: [Phase(id: legacyPhaseID, steps: steps)])
    }

    /// The opened label for a card step: by id, else by the number its "Step n" placeholder carries.
    public func label(forStepID id: String, placeholder: String) -> String? {
        let all = steps
        if let label = all.first(where: { $0.id == id })?.label { return label }
        guard let number = ReloSealedCards.placeholderStepNumber(placeholder) else { return nil }
        return all.first { $0.id == "step_\(number)" }?.label
    }

    /// For a sealed item that this phone could not open: only what the server may know in the clear.
    public var withoutText: ReloWork {
        var stripped = self
        stripped.title = nil
        stripped.phases = phases.map { phase in
            var phase = phase
            phase.title = nil
            phase.outcome = nil
            phase.steps = phase.steps.map { Step(id: $0.id, state: $0.state) }
            return phase
        }
        stripped.revisions = revisions.map { Revision(revision: $0.revision, at: $0.at) }
        stripped.phase?.title = nil
        return stripped
    }

    /// Titles and labels from `older` for the ids this copy has none for: the last known text stays.
    public func keepingText(from older: ReloWork?) -> ReloWork {
        guard let older else { return self }
        let titles = Dictionary(older.phases.compactMap { phase in phase.title.map { (phase.id, $0) } },
                                uniquingKeysWith: { first, _ in first })
        let outcomes = Dictionary(older.phases.compactMap { phase in phase.outcome.map { (phase.id, $0) } },
                                  uniquingKeysWith: { first, _ in first })
        let labels = Dictionary(older.steps.compactMap { step in step.label.map { (step.id, $0) } },
                                uniquingKeysWith: { first, _ in first })
        let details = Dictionary(older.steps.compactMap { step in step.detail.map { (step.id, $0) } },
                                 uniquingKeysWith: { first, _ in first })
        var merged = self
        merged.title = title ?? older.title
        merged.phases = phases.map { phase in
            var phase = phase
            phase.title = phase.title ?? titles[phase.id]
            phase.outcome = phase.outcome ?? outcomes[phase.id]
            phase.steps = phase.steps.map { step in
                var step = step
                step.label = step.label ?? labels[step.id]
                step.detail = step.detail ?? details[step.id]
                return step
            }
            return phase
        }
        if merged.revisions.isEmpty { merged.revisions = older.revisions }
        return merged
    }

    // MARK: Decoding helpers

    static func text(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    /// Decodes the elements it understands and skips the rest, so one odd element never hides the plan.
    static func lenientArray<Element: Decodable, Key: CodingKey>(_ values: KeyedDecodingContainer<Key>, _ key: Key) -> [Element] {
        guard values.contains(key), var items = try? values.nestedUnkeyedContainer(forKey: key) else { return [] }
        var decoded: [Element] = []
        while !items.isAtEnd {
            if let element = try? items.decode(Element.self) {
                decoded.append(element)
            } else if (try? items.decode(ReloSkippedElement.self)) == nil {
                break
            }
        }
        return decoded
    }
}

private struct ReloSkippedElement: Decodable {
    init(from decoder: Decoder) throws {}
}
