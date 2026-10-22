import Foundation

/// A work's plan as the detail screen reads it: rounds, each with its steps in pre-order and their depth
/// (ADR 0012, plan 12b). Pure display: it never decides what is current or delivered, it only arranges what
/// the server declared, folds what is long (4.7), hides what is skipped (U8) and opens only the current
/// step (U7). A flat single-round plan renders with no round header and no indentation.
public struct PlanOutline: Equatable, Sendable {
    public typealias State = LiveActivityDisplayPresentation.Step.State

    /// One plan step with its resolved text, as the detail view gathered it (labels opened by id).
    public struct Entry: Equatable, Sendable {
        public let id: String
        public let label: String
        /// False when this phone could not open the label: it reads "Not readable on this phone", never "Step n".
        public let readable: Bool
        public let state: State
        public let detail: String?
        public let parent: String?
        public let round: Int
        public let startedAt: Date?
        public let doneAt: Date?
        /// The round whose unfinished step this one continues; nil for a step the round planned itself.
        public let carriedFrom: Int?

        public init(id: String, label: String, state: State, detail: String? = nil, parent: String? = nil, round: Int = 1,
                    readable: Bool = true, startedAt: Date? = nil, doneAt: Date? = nil, carriedFrom: Int? = nil) {
            self.id = id; self.label = label; self.state = state
            self.detail = detail; self.parent = parent; self.round = max(1, round)
            self.readable = readable; self.startedAt = startedAt; self.doneAt = doneAt
            self.carriedFrom = carriedFrom
        }
    }

    public struct Node: Equatable, Identifiable, Sendable {
        public let id: String
        public let label: String
        public let readable: Bool
        /// A parent's state is derived: it reads as current when the current step is inside it.
        public let state: State
        public let detail: String?
        public let depth: Int
        public let round: Int
        public let parent: String?
        public let childIDs: [String]
        /// Steps anywhere below this one.
        public let descendantCount: Int
        /// Every descendant is done or skipped (and there is at least one).
        public let branchFinished: Bool
        public let startedAt: Date?
        public let doneAt: Date?
        public let carriedFrom: Int?

        public var hasChildren: Bool { !childIDs.isEmpty }
        public var isClosed: Bool { state == .complete || state == .skipped }
        /// What the row and the sheet say: the label, or the honest placeholder.
        public var shownLabel: String { readable ? label : PlanOutline.unreadableLabel }
    }

    public struct Round: Equatable, Identifiable, Sendable {
        public let n: Int
        public let title: String?
        public let outcome: String?
        public let closed: Bool
        public let openedAt: Date?
        public let closedAt: Date?
        public let nodes: [Node]
        public var id: Int { n }

        /// "Round 2 · Fix the login" or "Round 2".
        public var heading: String { title.map { "Round \(n) · \($0)" } ?? "Round \(n)" }
        public var duration: TimeInterval? {
            guard let openedAt, let closedAt, closedAt >= openedAt else { return nil }
            return closedAt.timeIntervalSince(openedAt)
        }
    }

    public static let unreadableLabel = "Not readable on this phone"

    public let rounds: [Round]

    /// Sections are shown from two rounds on.
    public var hasRoundSections: Bool { rounds.count >= 2 }
    public var nodes: [Node] { rounds.flatMap(\.nodes) }
    public var isTree: Bool { nodes.contains { $0.depth > 0 } }
    /// One round, no nesting: the plain list, no round header, no indentation.
    public var isFlat: Bool { !hasRoundSections && !isTree }
    /// The round shown open: the open one, else the last.
    public var currentRound: Round? { rounds.last(where: { !$0.closed }) ?? rounds.last }
    /// The last round is closed: the work waits for the owner (display only; the server decides attention).
    public var delivered: Bool { rounds.last?.closed == true }
    public var deliveredOutcome: String? { delivered ? rounds.last?.outcome : nil }

    /// Closed rounds fold to one row; the open (or last) round is expanded.
    public func startsFolded(_ round: Round) -> Bool { hasRoundSections && round.id != currentRound?.id }

    /// The step the work is on, anywhere in the plan.
    public var currentLeaf: Node? {
        guard let round = currentRound else { return nil }
        return round.nodes.last { $0.state == .current && !$0.hasChildren }
            ?? round.nodes.first { $0.state == .current }
    }

    /// The one count (U1) for this plan.
    public var progress: PlanProgress? { PlanProgress.make(outline: self) }

    /// The plan of a work that stopped: steps it never reached are not done and not skipped, so they read as open.
    public func unskipped() -> PlanOutline {
        PlanOutline(rounds: rounds.map { round in
            Round(n: round.n, title: round.title, outcome: round.outcome, closed: round.closed, openedAt: round.openedAt,
                  closedAt: round.closedAt, nodes: round.nodes.map { node in
                node.state == .skipped
                    ? Node(id: node.id, label: node.label, readable: node.readable, state: .pending, detail: node.detail,
                           depth: node.depth, round: node.round, parent: node.parent, childIDs: node.childIDs,
                           descendantCount: node.descendantCount, branchFinished: node.branchFinished,
                           startedAt: node.startedAt, doneAt: node.doneAt, carriedFrom: node.carriedFrom)
                    : node
            })
        })
    }

    public func node(_ id: String) -> Node? { nodes.first { $0.id == id } }

    /// Arranges `entries` (plan order, parents before children) into rounds. `rounds` is the plan's own
    /// list (absent: one open round 1); `titles` and `outcomes` fill round text that arrived sealed, by round number.
    public static func make(entries: [Entry], rounds declared: [InboxCardDigest.PlanRound]?,
                            titles: [Int: String] = [:], outcomes: [Int: String] = [:]) -> PlanOutline {
        var numbers = Set(declared?.map(\.n) ?? [1])
        numbers.formUnion(entries.map(\.round))
        let ordered = numbers.sorted()
        let byNumber = Dictionary((declared ?? []).map { ($0.n, $0) }, uniquingKeysWith: { first, _ in first })
        let rounds = ordered.map { n -> Round in
            let info = byNumber[n]
            let own = entries.filter { $0.round == n }
            return Round(n: n, title: info?.title ?? titles[n], outcome: info?.outcome ?? outcomes[n],
                         closed: info?.closed ?? false, openedAt: info?.openedAt, closedAt: info?.closedAt, nodes: nodes(own))
        }
        return PlanOutline(rounds: rounds)
    }

    private static func nodes(_ entries: [Entry]) -> [Node] {
        var depth: [String: Int] = [:]
        var children: [String: [String]] = [:]
        for entry in entries {
            // A parent counts only when it appeared earlier in this round (pre-order); else the step stands alone.
            if let parent = entry.parent, depth[parent] != nil {
                depth[entry.id] = depth[parent]! + 1
                children[parent, default: []].append(entry.id)
            } else {
                depth[entry.id] = 0
            }
        }
        let states = Dictionary(entries.map { ($0.id, $0.state) }, uniquingKeysWith: { first, _ in first })
        func descendants(_ id: String) -> [String] { (children[id] ?? []).flatMap { [$0] + descendants($0) } }
        return entries.map { entry in
            let below = descendants(entry.id)
            let belowStates = below.compactMap { states[$0] }
            let state: State = belowStates.contains(.current) ? .current : entry.state
            let finished = !below.isEmpty && belowStates.allSatisfy { $0 == .complete || $0 == .skipped }
            let hasParent = entry.parent.map { depth[$0] != nil } ?? false
            return Node(id: entry.id, label: entry.label, readable: entry.readable, state: state, detail: entry.detail,
                        depth: depth[entry.id] ?? 0, round: entry.round, parent: hasParent ? entry.parent : nil,
                        childIDs: children[entry.id] ?? [], descendantCount: below.count, branchFinished: finished,
                        startedAt: entry.startedAt, doneAt: entry.doneAt, carriedFrom: entry.carriedFrom)
        }
    }

    // MARK: Structure to draw (U6, U7, U8, 4.7)

    /// A step with the steps it opens onto. Drawn structurally: a branch draws its own rail segment through
    /// its opened children, so the line never breaks when a step opens or folds (U11).
    public struct Branch: Equatable, Identifiable, Sendable {
        public let node: Node
        /// Its children are listed (the current step, or opened by the owner).
        public let opened: Bool
        /// Done of total over its direct children, skipped left out; nil without children.
        public let count: PlanProgress.Sub?
        public let children: [Item]
        /// Its place among its siblings ("step 2 of 4"), skipped ones left out; nil for a skipped step.
        public let position: Int?
        public let siblings: Int
        public var id: String { node.id }
    }

    /// "5 done", "6 to go" or "2 skipped": one quiet row standing for steps not listed.
    public struct Fold: Equatable, Identifiable, Sendable {
        public enum Kind: String, Sendable { case done, toGo, skipped }
        public let id: String
        public let kind: Kind
        public let count: Int
        public var text: String { kind == .toGo ? "\(count) to go" : "\(count) \(kind == .done ? "done" : "skipped")" }
    }

    public enum Item: Equatable, Identifiable, Sendable {
        case branch(Branch)
        case fold(Fold)
        public var id: String {
            switch self {
            case let .branch(branch): branch.id
            case let .fold(fold): fold.id
            }
        }
    }

    /// A row to draw: an item, or a run of sibling steps whose names this phone cannot open (U8). Two or more in a
    /// row with the same state read as one quiet row ("2 done · names not readable on this phone"), never one
    /// placeholder per step.
    public enum Row: Equatable, Identifiable, Sendable {
        case item(Item)
        case unreadable(id: String, state: State, count: Int)
        public var id: String {
            switch self {
            case let .item(item): item.id
            case let .unreadable(id, _, _): "unreadable-\(id)"
            }
        }
        public static func text(state: State, count: Int) -> String {
            "\(count) \(state == .complete ? "done" : "to go") · names not readable on this phone"
        }
    }

    public static func rows(_ items: [Item]) -> [Row] {
        var rows: [Row] = []
        var run: [Branch] = []
        func flush() {
            if run.count >= 2, let first = run.first { rows.append(.unreadable(id: first.id, state: first.node.state, count: run.count)) }
            else { rows.append(contentsOf: run.map { .item(.branch($0)) }) }
            run = []
        }
        for item in items {
            if case let .branch(branch) = item, !branch.node.readable, !branch.node.hasChildren,
               branch.node.state == .complete || branch.node.state == .pending {
                if let last = run.last, last.node.state != branch.node.state { flush() }
                run.append(branch)
            } else {
                flush()
                rows.append(.item(item))
            }
        }
        flush()
        return rows
    }

    /// More than this many steps in one list are windowed.
    public static let windowLimit = 7
    /// How many finished steps stay listed before the current one, and how many upcoming ones after it.
    public static let windowBefore = 2, windowAfter = 3

    /// The items of `round` (its top-level steps), folded as 4.7 says. `expandedFolds` are the fold ids the
    /// owner opened, `openedSteps` the steps the owner opened on top of the current one.
    public func items(in round: Round, expandedFolds: Set<String> = [], openedSteps: Set<String> = []) -> [Item] {
        let byID = Dictionary(round.nodes.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return Self.items(of: round.nodes.filter { $0.depth == 0 }, key: "r\(round.n)", byID: byID,
                          expandedFolds: expandedFolds, openedSteps: openedSteps)
    }

    private static func items(of siblings: [Node], key: String, byID: [String: Node],
                              expandedFolds: Set<String>, openedSteps: Set<String>) -> [Item] {
        let liveSiblings = siblings.filter { $0.state != .skipped }
        func branch(_ node: Node) -> Item {
            let place = liveSiblings.firstIndex { $0.id == node.id }.map { $0 + 1 }
            let kids = node.childIDs.compactMap { byID[$0] }
            let live = kids.filter { $0.state != .skipped }
            let opened = node.state == .current || openedSteps.contains(node.id)
            let count = live.isEmpty ? nil : PlanProgress.Sub(done: live.filter { $0.state == .complete }.count, total: live.count)
            return .branch(Branch(node: node, opened: opened && !kids.isEmpty, count: count,
                                  children: opened ? items(of: kids, key: node.id, byID: byID,
                                                           expandedFolds: expandedFolds, openedSteps: openedSteps) : [],
                                  position: place, siblings: liveSiblings.count))
        }
        let live = liveSiblings
        let skipped = siblings.filter { $0.state == .skipped }
        var result: [Item] = []
        if live.count > windowLimit {
            let focus = live.firstIndex { $0.state == .current } ?? live.firstIndex { $0.state == .pending } ?? live.count - 1
            var start = max(0, focus - windowBefore)
            var end = min(live.count, focus + 1 + windowAfter)
            if start < 2 { start = 0 }                       // never fold a single step
            if live.count - end < 2 { end = live.count }
            if start > 0 {
                let fold = Fold(id: "\(key):done", kind: .done, count: start)
                if expandedFolds.contains(fold.id) { start = 0 } else { result.append(.fold(fold)) }
            }
            let tailFold = end < live.count ? Fold(id: "\(key):toGo", kind: .toGo, count: live.count - end) : nil
            if let tailFold, expandedFolds.contains(tailFold.id) { end = live.count }
            result += live[start..<end].map(branch)
            if let tailFold, end < live.count { result.append(.fold(tailFold)) }
        } else {
            result = live.map(branch)
        }
        if !skipped.isEmpty {
            let fold = Fold(id: "\(key):skipped", kind: .skipped, count: skipped.count)
            if expandedFolds.contains(fold.id) { result += skipped.map(branch) } else { result.append(.fold(fold)) }
        }
        return result
    }

    // MARK: Rounds to draw (4.7)

    public enum RoundSlot: Equatable, Identifiable, Sendable {
        case earlier(count: Int)
        case round(Round)
        public var id: String {
            switch self {
            case .earlier: "earlier"
            case let .round(round): "round-\(round.n)"
            }
        }
    }

    /// More than three rounds: the last two stay as rows, the earlier ones fold into "n earlier rounds".
    public func roundSlots(earlierExpanded: Bool) -> [RoundSlot] {
        guard rounds.count > 3, !earlierExpanded else { return rounds.map(RoundSlot.round) }
        return [.earlier(count: rounds.count - 2)] + rounds.suffix(2).map(RoundSlot.round)
    }
}

public extension PlanOutline {
    /// "4 min", "1 h 5 min", "2 h": a duration as a row's trailing meta. Nil under a minute.
    static func durationLabel(_ seconds: TimeInterval?) -> String? {
        guard let seconds, seconds >= 60 else { return nil }
        let minutes = Int((seconds / 60).rounded())
        if minutes < 60 { return "\(minutes) min" }
        let hours = minutes / 60, rest = minutes % 60
        if hours >= 24 { return "\(hours / 24) d" + (hours % 24 > 0 ? " \(hours % 24) h" : "") }
        return rest == 0 ? "\(hours) h" : "\(hours) h \(rest) min"
    }
}

public extension PlanOutline.Node {
    /// How long the step took, when both times are known.
    var duration: TimeInterval? {
        guard let startedAt, let doneAt, doneAt >= startedAt else { return nil }
        return doneAt.timeIntervalSince(startedAt)
    }
}

public extension PlanOutline {
    /// A Now item's plan as rounds and nested steps (Relo for Mac): states and structure from the server's `plan`
    /// and `rounds`; labels, details, round titles and outcomes from the server for a readable work, else from the
    /// card's sealed text opened on this device (by step id; a v1 text by the placeholder's number). Nil without steps.
    static func make(plan: [InboxCardDigest.PlanStep]?, rounds: [InboxCardDigest.PlanRound]?,
                     text: ReloSealedCardText?) -> PlanOutline? {
        guard let plan, !plan.isEmpty else { return nil }
        let labels = text?.labelsByStepID ?? [:]
        let details = text?.detailsByStepID ?? [:]
        let entries = plan.enumerated().map { index, step -> Entry in
            let opened = ReloWork.text(step.label).flatMap { ReloSealedCards.isPlaceholderStep($0) ? nil : $0 }
                ?? labels[step.id] ?? text?.legacyLabel(forPlaceholder: "Step \(index + 1)")
            let state: State = switch step.state {
            case "done", "complete": .complete
            case "current": .current
            case "skipped": .skipped
            default: .pending
            }
            return Entry(id: step.id, label: opened ?? "Step \(index + 1)", state: state, detail: step.detail ?? details[step.id],
                         parent: step.parent, round: step.round ?? 1, readable: opened != nil,
                         startedAt: step.startedAt, doneAt: step.doneAt, carriedFrom: step.carriedFrom)
        }
        var titles: [Int: String] = [:], outcomes: [Int: String] = [:]
        for phase in text?.phases ?? [] {
            guard phase.id.hasPrefix("r"), let n = Int(phase.id.dropFirst()) else { continue }
            if let title = ReloWork.text(phase.title) { titles[n] = title }
            if let outcome = ReloWork.text(phase.outcome) { outcomes[n] = outcome }
        }
        return make(entries: entries, rounds: rounds, titles: titles, outcomes: outcomes)
    }
}
