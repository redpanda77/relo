import Foundation

/// The one plan count and the one plan line (plan 12b, U1 and U2). Mirrors `planProgress` in
/// packages/contracts and shares its fixture (`plan-progress.json`), so the Lock Screen, the Island, Now,
/// History and the app header all say the same thing.
///
/// - `done` of `total` count the TOP-LEVEL steps of the round in play (the open round, else the last).
///   Skipped steps are not counted and substeps never are. A round that carries unfinished steps
///   (`carriedFrom`) also counts the earlier rounds' finished top-level steps of the same goal.
/// - `currentId` is the top-level step that holds the current step (the current step itself, or its ancestor).
/// - `sub` is that step's own direct children: done of total.
public struct PlanProgress: Codable, Equatable, Hashable, Sendable {
    public struct Sub: Codable, Equatable, Hashable, Sendable {
        public let done: Int
        public let total: Int
        public init(done: Int, total: Int) { self.done = done; self.total = total }
    }

    /// How the work stands, as far as the line is concerned. A delivered round only reads as such while moving.
    public enum Standing: String, Codable, Sendable { case moving, paused, done, stopped }

    public let done: Int
    public let total: Int
    public let currentId: String?
    public let sub: Sub?
    public let round: Int
    public let rounds: Int
    public let delivered: Bool
    /// Which top-level step is current, counting from 1 (the segment the bar fills); the server's, never counted here.
    public let current: Int?
    /// How far the current top-level step is, 0 to 1 (its substeps, else its own progress); the server's.
    public let fill: Double?
    /// The current top-level step's label on a readable work; nil when sealed or private.
    public let stepLabel: String?

    public init(done: Int, total: Int, currentId: String? = nil, sub: Sub? = nil,
                round: Int = 1, rounds: Int = 1, delivered: Bool = false, current: Int? = nil, fill: Double? = nil,
                stepLabel: String? = nil) {
        self.stepLabel = stepLabel
        self.current = current.flatMap { $0 >= 1 ? $0 : nil }
        self.fill = fill.map { min(1, max(0, $0)) }
        self.done = max(0, done); self.total = max(0, total); self.currentId = currentId
        self.sub = sub.flatMap { $0.total > 0 ? $0 : nil }
        self.round = max(1, round); self.rounds = max(1, rounds); self.delivered = delivered
    }

    private enum CodingKeys: String, CodingKey { case done, total, currentId, sub, round, rounds, delivered, current, fill, stepLabel }

    /// Tolerant: a field of an unexpected type reads as absent; `done` and `total` are required.
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        self.init(done: try values.decode(Int.self, forKey: .done), total: try values.decode(Int.self, forKey: .total),
                  currentId: (try? values.decodeIfPresent(String.self, forKey: .currentId)) ?? nil,
                  sub: (try? values.decodeIfPresent(Sub.self, forKey: .sub)) ?? nil,
                  round: (try? values.decodeIfPresent(Int.self, forKey: .round)) ?? 1,
                  rounds: (try? values.decodeIfPresent(Int.self, forKey: .rounds)) ?? 1,
                  delivered: (try? values.decodeIfPresent(Bool.self, forKey: .delivered)) ?? false,
                  current: (try? values.decodeIfPresent(Int.self, forKey: .current)) ?? nil,
                  fill: (try? values.decodeIfPresent(Double.self, forKey: .fill)) ?? nil,
                  stepLabel: (try? values.decodeIfPresent(String.self, forKey: .stepLabel)) ?? nil)
    }

    // MARK: Counting

    /// From the arranged plan. Nil when the round in play has no countable steps and nothing was delivered.
    /// `stopped`: the work failed or was dropped, so the steps it never reached still count (they are not
    /// skipped, they are not done: "Stopped at 2 of 5").
    public static func make(outline: PlanOutline, stopped: Bool = false) -> PlanProgress? {
        guard let round = outline.currentRound else { return nil }
        let top = round.nodes.filter { $0.depth == 0 && (stopped || $0.state != .skipped) }
        guard !top.isEmpty || outline.delivered else { return nil }
        // A round that carries unfinished steps goes on with the goal: the top-level steps finished in the rounds
        // it continues count too ("Step 2 of 4", not "Step 1 of 3"). A round with its own plan counts alone.
        var before = 0
        var n = round.n
        while n > 1, outline.nodes.contains(where: { $0.round == n && $0.carriedFrom != nil }) {
            before += outline.rounds.first { $0.n == n - 1 }?.nodes.filter { $0.depth == 0 && $0.state == .complete }.count ?? 0
            n -= 1
        }
        let current = top.first { $0.state == .current }
        let position = current.flatMap { node in top.firstIndex { $0.id == node.id } }.map { $0 + 1 + before }
        let sub = current.flatMap { node -> Sub? in
            let kids = round.nodes.filter { node.childIDs.contains($0.id) && $0.state != .skipped }
            return kids.isEmpty ? nil : Sub(done: kids.filter { $0.state == .complete }.count, total: kids.count)
        }
        return PlanProgress(done: before + top.filter { $0.state == .complete }.count, total: before + top.count, currentId: current?.id,
                            sub: sub, round: round.n, rounds: outline.rounds.count, delivered: outline.delivered, current: position)
    }

    /// From a flat window of steps (a card event without the whole plan). `before` and `after` are the steps
    /// of a longer plan the card does not carry (done before the window, not started after it).
    public static func make(steps: [LiveActivityPlanDisplay.Step], before: Int = 0, after: Int = 0) -> PlanProgress? {
        let live = steps.filter { $0.state != .skipped }
        guard !live.isEmpty || before + after > 0 else { return nil }
        let current = live.first { $0.state == .current }
        let sub = current?.count.flatMap { $0.total > 0 ? Sub(done: $0.done, total: $0.total) : nil }
        let position = live.firstIndex { $0.state == .current }.map { before + $0 + 1 }
        return PlanProgress(done: before + live.filter { $0.state == .done }.count, total: before + live.count + after,
                            currentId: nil, sub: sub, current: position)
    }

    // MARK: Words

    public static let unreadable = "Not readable"

    /// "2/5" for the compact Island and other tight places.
    public var compact: String { "\(done)/\(total)" }

    /// "2 of 5", with "Round 3 · " in front once the work has two or more rounds (the app's plan header).
    public var count: String {
        let text = "\(done) of \(total)"
        return rounds >= 2 ? "Round \(round) · \(text)" : text
    }

    /// "Step 2 of 5" while a step is current (its position among the top-level steps), else the plain count; with the round in front from the second round.
    public var stepCount: String {
        guard let current else { return count }
        let text = "Step \(current) of \(total)"
        return rounds >= 2 ? "Round \(round) · \(text)" : text
    }

    /// The plan card header (U3): only the count while moving; the state's own words otherwise.
    public func header(_ standing: Standing = .moving) -> String {
        switch standing {
        case .moving: delivered ? "Round \(round) delivered" : stepCount
        case .paused: "Paused at \(done) of \(total)"
        case .done: "\(done) of \(total) done"
        case .stopped: "Stopped at \(done) of \(total)"
        }
    }

    /// The plan line (U2) in the pieces a narrow surface needs: the count and the trailing sub-count never
    /// truncate, the label does. `lead` is "2 of 5" (or the whole line for a state that has no label).
    public struct LineParts: Equatable, Sendable {
        public let lead: String
        public let label: String?
        public let trail: String?
        public var text: String { [lead, label, trail].compactMap { $0 }.joined(separator: " · ") }
    }

    public func lineParts(label: String?, standing: Standing = .moving) -> LineParts? {
        switch standing {
        case .moving:
            if delivered { return LineParts(lead: "Round \(round) delivered", label: nil, trail: nil) }
            guard total > 0 else { return nil }
            if done >= total, currentId == nil { return LineParts(lead: "\(done) of \(total) done", label: nil, trail: nil) }
            return LineParts(lead: current.map { "Step \($0) of \(total)" } ?? "\(done) of \(total)", label: PlanProgress.clean(label),
                             trail: sub.map { "\($0.done)/\($0.total)" })
        case .paused: return total > 0 ? LineParts(lead: "Paused at \(done) of \(total)", label: nil, trail: nil) : nil
        case .done: return total > 0 ? LineParts(lead: "\(done) of \(total) done", label: nil, trail: nil) : nil
        case .stopped: return total > 0 ? LineParts(lead: "Stopped at \(done) of \(total)", label: nil, trail: nil) : nil
        }
    }

    /// The plan line (U2), the same text on every surface. `label` is the current step's text (nil: omitted;
    /// `PlanProgress.unreadable` when the phone could not open it). Nil when there is nothing to count.
    public func line(label: String?, standing: Standing = .moving) -> String? {
        lineParts(label: label, standing: standing)?.text
    }

    static func clean(_ label: String?) -> String? {
        guard let label = label?.trimmingCharacters(in: .whitespacesAndNewlines), !label.isEmpty else { return nil }
        return label
    }
}

/// The plan's bar, the same on every surface (plan 14, workstream 7): one segment per TOP-LEVEL step, the
/// current segment filled by the server's fraction of that step (its substeps, or its own progress).
/// Substeps never add segments. Nothing here counts the plan: it lays out the counts the server sent.
public struct PlanBar: Equatable, Sendable {
    public struct Segment: Equatable, Sendable {
        public let state: LiveActivityPlanDisplay.StepState
        /// 1 for a finished step, 0 for one not started, the step's fraction for the current one (0 when unknown).
        public let fill: Double
    }

    public let segments: [Segment]

    /// From the card's shown steps and the steps hidden around them; `fill` is the server's for the current step.
    public static func make(steps: [LiveActivityPlanDisplay.Step], before: Int = 0, after: Int = 0, fill: Double?) -> PlanBar {
        let shown = steps.filter { $0.state != .skipped }.map { step -> Segment in
            switch step.state {
            case .done: Segment(state: .done, fill: 1)
            case .current: Segment(state: .current, fill: fill ?? 0)
            default: Segment(state: .open, fill: 0)
            }
        }
        return PlanBar(segments: Array(repeating: Segment(state: .done, fill: 1), count: before) + shown
            + Array(repeating: Segment(state: .open, fill: 0), count: after))
    }

    /// From the server's counts alone (a Now row): `done` finished, then the current segment, then the rest.
    public static func make(done: Int, total: Int, current: Int?, fill: Double?) -> PlanBar {
        let total = max(0, total)
        // No position from the server, no current segment: nothing is invented.
        let currentIndex = (current ?? 0) - 1
        return PlanBar(segments: (0..<total).map { index in
            if done >= total { Segment(state: .done, fill: 1) }
            else if index == currentIndex { Segment(state: .current, fill: fill ?? 0) }
            else if index < done { Segment(state: .done, fill: 1) }
            else { Segment(state: .open, fill: 0) }
        })
    }
}
