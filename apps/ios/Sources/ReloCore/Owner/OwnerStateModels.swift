import Foundation

// Swift mirror of packages/contracts/src/owner-state.ts (derived owner state, spec v2 slice 1).
// Display only: the server derives every state, section, placement and refetch instant.
// Decoding is tolerant: an unknown enum value never fails the summary.

public enum OwnerState: Equatable, Hashable, Sendable, Codable {
    case needsYou, failed, done, dropped, leftUnfinished, paused, waitingOnYou,
         moving, workingQuietly, stoppedResponding, noSignal, stale
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "needs_you": self = .needsYou
        case "failed": self = .failed
        case "done": self = .done
        case "dropped": self = .dropped
        case "left_unfinished": self = .leftUnfinished
        case "paused": self = .paused
        case "waiting_on_you": self = .waitingOnYou
        case "moving": self = .moving
        case "working_quietly": self = .workingQuietly
        case "stopped_responding": self = .stoppedResponding
        case "no_signal": self = .noSignal
        case "stale": self = .stale
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .needsYou: "needs_you"
        case .failed: "failed"
        case .done: "done"
        case .dropped: "dropped"
        case .leftUnfinished: "left_unfinished"
        case .paused: "paused"
        case .waitingOnYou: "waiting_on_you"
        case .moving: "moving"
        case .workingQuietly: "working_quietly"
        case .stoppedResponding: "stopped_responding"
        case .noSignal: "no_signal"
        case .stale: "stale"
        case .unknown(let raw): raw
        }
    }

    public init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    /// The header chip the owner sees for this state (text, never color alone). Nil: no chip.
    public var chip: OwnerChip? {
        switch self {
        case .needsYou: .needsYou
        case .waitingOnYou: .yourTurn
        case .stale, .stoppedResponding, .noSignal: .quiet
        case .workingQuietly: .working
        case .done: .done
        case .failed: .failed
        case .moving, .dropped, .leftUnfinished, .paused, .unknown: nil
        }
    }
}

/// Owner-facing chips shared by Now, Lock Screen, Dynamic Island and Watch.
public enum OwnerChip: String, Codable, Hashable, Sendable, CaseIterable {
    case needsYou, missed, yourTurn, working, quiet, done, failed

    public var label: String {
        switch self {
        case .needsYou: "NEEDS YOU"
        case .missed: "MISSED"
        case .yourTurn: "YOUR TURN"
        case .working: "WORKING"
        case .quiet: "QUIET"
        case .done: "DONE"
        case .failed: "FAILED"
        }
    }

    public var accessibilityLabel: String {
        switch self {
        case .needsYou: "Needs you"
        case .missed: "Missed question"
        case .yourTurn: "Your turn"
        case .working: "Working quietly"
        case .quiet: "Quiet"
        case .done: "Done"
        case .failed: "Failed"
        }
    }

    /// The chip for a state plus the needs-you reason (a missed question reads MISSED).
    public static func of(state: OwnerState, needsYou: NeedsYouReason?) -> OwnerChip? {
        if state == .needsYou, needsYou == .missedQuestion { return .missed }
        return state.chip
    }
}

/// Decodes a String-backed enum, mapping unknown values to a fallback instead of failing.
public protocol TolerantStringEnum: RawRepresentable, Codable, Sendable where RawValue == String {
    static var unknownFallback: Self { get }
}

public extension TolerantStringEnum {
    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? Self.unknownFallback
    }
}

public enum NowSection: String, TolerantStringEnum, Hashable {
    case needsYou = "needs_you", sinceYouLooked = "since_you_looked", waitingOnYou = "waiting_on_you",
         running, quiet, paused
    public static var unknownFallback: NowSection { .running }
}

public enum LockScreenPlacement: String, TolerantStringEnum, Hashable {
    case top, shown, yourTurn = "your_turn", dimmed, final, none
    public static var unknownFallback: LockScreenPlacement { .shown }
}

public enum NeedsYouReason: String, TolerantStringEnum, Hashable {
    case question, missedQuestion = "missed_question", permission
    public static var unknownFallback: NeedsYouReason { .question }
}

public enum QuestionStanding: String, TolerantStringEnum, Hashable {
    case pending, missed, answered, answeredLate = "answered_late"
    public static var unknownFallback: QuestionStanding { .pending }
}

public enum SessionPhase: String, TolerantStringEnum, Hashable, Comparable {
    case working, waiting, idle, ended
    public static var unknownFallback: SessionPhase { .idle }

    private var order: Int { [.working, .waiting, .idle, .ended].firstIndex(of: self) ?? 0 }
    public static func < (lhs: SessionPhase, rhs: SessionPhase) -> Bool { lhs.order < rhs.order }
}

public enum ProducerType: String, TolerantStringEnum, Hashable {
    case agentSession = "agent_session", script, service
    public static var unknownFallback: ProducerType { .script }
}

public struct OwnerStateResult: Codable, Equatable, Hashable, Sendable {
    public var state: OwnerState
    public var needsYou: NeedsYouReason?
    public var evidenceAt: Date
    public var evidenceSource: String
    public var staleDate: Date
    public var lockScreen: LockScreenPlacement
    public var lockScreenUntil: Date?
    public var now: NowSection?
    public var interruptionLevel: String?
    public var relevance: Double
    public var apnsPriority: Int
    public var nextChangeAt: Date?
    /// Why a quiet work is quiet and since when: the server puts both on `owner` (absent from older servers).
    public var quietReason: QuietReason? = nil
    public var quietSince: Date? = nil
    /// Why this item left the screen or dimmed (the server's derivation); absent from older servers.
    public var absence: Absence? = nil

    public init(state: OwnerState, needsYou: NeedsYouReason? = nil, evidenceAt: Date, evidenceSource: String = "declared",
                staleDate: Date, lockScreen: LockScreenPlacement, lockScreenUntil: Date? = nil, now: NowSection? = nil,
                interruptionLevel: String? = nil, relevance: Double = 0, apnsPriority: Int = 5, nextChangeAt: Date? = nil) {
        self.state = state; self.needsYou = needsYou; self.evidenceAt = evidenceAt; self.evidenceSource = evidenceSource
        self.staleDate = staleDate; self.lockScreen = lockScreen; self.lockScreenUntil = lockScreenUntil; self.now = now
        self.interruptionLevel = interruptionLevel; self.relevance = relevance; self.apnsPriority = apnsPriority
        self.nextChangeAt = nextChangeAt
    }

    public var chip: OwnerChip? { OwnerChip.of(state: state, needsYou: needsYou) }
}

public struct NowItem: Codable, Equatable, Hashable, Identifiable, Sendable {
    public struct Steps: Codable, Equatable, Hashable, Sendable {
        public var done: Int
        public var total: Int
        public var current: String?
        /// Which top-level step is current (from 1) and how far it is (0 to 1), from the server's plan wire.
        public var currentIndex: Int?
        public var fill: Double?

        public init(done: Int, total: Int, current: String? = nil, currentIndex: Int? = nil, fill: Double? = nil) {
            self.done = done; self.total = total; self.current = current; self.currentIndex = currentIndex; self.fill = fill
        }

        /// The bar for these counts: one segment per top-level step.
        public var bar: PlanBar { PlanBar.make(done: done, total: total, current: position, fill: fill) }

        /// The current step's place, the one number the bar lights and the caption writes ("Step N of M"): the server's
        /// `currentIndex`, else the step after the done ones when a current step's label is known (the caption's rule).
        public var position: Int? {
            if let currentIndex, currentIndex >= 1 { return currentIndex }
            guard done < total, let label = current?.trimmingCharacters(in: .whitespacesAndNewlines), !label.isEmpty else { return nil }
            return min(done + 1, total)
        }
    }

    public struct Question: Codable, Equatable, Hashable, Sendable {
        public var id: String
        public var standing: QuestionStanding
        public var askedAt: Date
        public var openedAt: Date?
    }

    /// This phone's sealed text for the row (phones only): the card (title, status, steps) and the
    /// question it asks. The row's own title and status are placeholders while these are sealed.
    public struct Sealed: Codable, Equatable, Hashable, Sendable {
        public var card: ReloEnvelope?
        public var question: ReloEnvelope?

        public init(card: ReloEnvelope? = nil, question: ReloEnvelope? = nil) {
            self.card = card
            self.question = question
        }
    }

    public var id: String
    public var title: String
    public var status: String?
    public var sourceName: String?
    /// The icon of the computer this work runs on; nil when the server names none.
    public var computerIcon: ComputerIcon?
    public var project: String?
    /// The project's colour slot (`ProjectPalette`); nil when the server names no project resource.
    public var projectSlot: Int?
    public var steps: Steps?
    /// The plan's count as the server computes it (top-level steps, the current one and its fraction); preferred over `steps`.
    public var progress: PlanProgress?
    /// The work's whole plan (each step's state, parent and round; labels nil for sealed work, opened by step id)
    /// and its rounds, so a device draws rounds and nested steps (`PlanOutline.make(plan:rounds:text:)`).
    public var plan: [InboxCardDigest.PlanStep]?
    public var rounds: [InboxCardDigest.PlanRound]?
    public var producer: ProducerType
    public var sessionId: String?
    /// The session's sealed names, carried on the card so it keeps its session's name after the session ends.
    public var sessionNames: ReloEnvelope?
    /// The session's name, opened on this device from `sessionNames`; never sent in the clear.
    public var sessionTitle: String?
    public var notificationId: String?
    public var startedAt: Date
    public var declaredAt: Date
    public var question: Question?
    public var owner: OwnerStateResult
    /// Why a Quiet work is quiet and since when (the server derives both; absent from older servers).
    public var quietReason: QuietReason?
    public var quietSince: Date?
    public var sealed: Sealed?
    /// What the last closed round delivered, when the work waits on the owner after a round (ADR 0012):
    /// sent in the clear by the server for a readable work, else opened from the sealed card (the phase
    /// `r<n>` outcome). Display only; the server derives that it is the owner's turn.
    public var roundOutcome: String?
    /// The number of that round (the sealed phase `r<n>`), so the row can say "Round 2 delivered".
    public var roundNumber: Int?

    public var chip: OwnerChip? { owner.chip }
    /// The plan the row shows: the server's `progress` when it sent one (top-level steps only), else the older `steps`.
    /// The label stays the opened one (`steps.current`) when this phone has it.
    public var planSteps: Steps? {
        guard let progress, progress.total > 0 else { return steps }
        return Steps(done: progress.done, total: progress.total, current: steps?.current ?? progress.stepLabel,
                     currentIndex: progress.current, fill: progress.fill)
    }
    /// The quiet reason and time wherever the server put them (on `owner` today).
    public var quietWhy: QuietReason? { owner.quietReason ?? quietReason }
    public var quietFrom: Date? { owner.quietSince ?? quietSince }

    /// The Quiet status line (`Session idle since 3:12 PM`); nil unless the work is Quiet and the server said why.
    public func quietLine(locale: Locale = .current, timeZone: TimeZone = .current) -> String? {
        guard owner.chip == .quiet else { return nil }
        return QuietWording.line(reason: quietWhy, since: quietFrom ?? owner.evidenceAt, locale: locale, timeZone: timeZone)
    }
}

public struct SessionRow: Codable, Equatable, Hashable, Identifiable, Sendable {
    public var id: String
    public var source: String?
    public var project: String?
    public var computer: String?
    /// The computer's icon; nil when the session has no work on a computer.
    public var computerIcon: ComputerIcon?
    /// Observed phase with hooks; nil without hooks (show "last seen").
    public var phase: SessionPhase?
    public var observed: Bool
    /// Why a waiting session waits: "input" (a permission or input prompt) or "turn"; nil unless waiting.
    public var waitingFor: String?
    public var lastSeenAt: Date
    /// "idle": folded into "Idle (n)".
    public var fold: String?
    public var workId: String?
    public var sealedNames: ReloEnvelope?
    public var nextChangeAt: Date?
    /// The session's name (the title the owner or Claude gave it), opened on this phone from
    /// `sealedNames`; never sent by the server in the clear.
    public var title: String?
    /// How full the session's context window is (0-100); nil when the computer does not report it.
    public var contextPct: Int?
    /// Tokens in the session's context window, read by a hook where no status line runs; nil when not reported.
    public var contextTokens: Int?
    /// What the session has cost so far, in US dollars; nil when not reported.
    public var costUsd: Double?

    public var isFoldedIdle: Bool { fold == "idle" }
    public var sourceLabel: String? { source.map(SessionSource.label) }
}

public struct SessionsView: Codable, Equatable, Hashable, Sendable {
    public struct Folds: Codable, Equatable, Hashable, Sendable { public var idle: Int }
    public var sessions: [SessionRow]
    public var folds: Folds
}

public extension NowSummary {
    /// The summary with each session's sealed names opened on this phone: the names teach the name book
    /// (inside `open`) and the session's title lands on its row.
    func openingSessionNames(_ open: ReloSealedOpener) -> NowSummary {
        var opened = self
        opened.sessions.sessions = sessions.sessions.map { row in
            var row = row
            if let names = row.sealedNames, names.kind == "names", let plaintext = open(names, row.id),
               let title = ReloNames.carriedTitle(in: plaintext) {
                row.title = title
            }
            return row
        }
        // Each card's own copy of its session's names: the name survives the session leaving the Sessions view.
        func titled(_ items: [NowItem]) -> [NowItem] {
            items.map { item in
                var item = item
                if let names = item.sessionNames, names.kind == "names", let sessionID = item.sessionId,
                   let plaintext = open(names, sessionID),
                   let title = ReloNames.carriedTitle(in: plaintext) {
                    item.sessionTitle = title
                }
                return item
            }
        }
        opened.needsYou = titled(needsYou)
        opened.recent = titled(recent)
        opened.waitingOnYou = titled(waitingOnYou)
        opened.running = titled(running)
        opened.quiet = titled(quiet)
        opened.paused = titled(paused)
        return opened
    }

    /// The summary with each row's sealed card and question opened on this phone. Only the server's
    /// placeholders are replaced, never words it wrote itself; a row this phone cannot open says so
    /// ("Can't be read on this iPhone" and why) instead of showing a placeholder.
    func openingSealed(_ open: ReloSealedOpener, diagnose: ReloSealedDiagnoser? = nil) -> NowSummary {
        var opened = self
        func each(_ items: [NowItem]) -> [NowItem] { items.map { $0.openingSealed(open, diagnose: diagnose) } }
        opened.needsYou = each(needsYou)
        opened.recent = each(recent)
        opened.waitingOnYou = each(waitingOnYou)
        opened.running = each(running)
        opened.quiet = each(quiet)
        opened.paused = each(paused)
        return opened
    }
}

public extension NowItem {
    /// This row with its sealed text opened (see `NowSummary.openingSealed`).
    func openingSealed(_ open: ReloSealedOpener, diagnose: ReloSealedDiagnoser? = nil) -> NowItem {
        let placeholder = ReloSealedCards.statusPlaceholder
        let titleIsPlaceholder = ReloSealedCards.isPlaceholderTitle(title)
        let statusIsPlaceholder = status.map { $0.contains(placeholder) || $0 == ReloSealedCards.promptPlaceholder } ?? false
        let stepIsPlaceholder = steps?.current.map(ReloSealedCards.isPlaceholderStep) ?? false
        guard sealed != nil || titleIsPlaceholder else { return self }
        var failure: String?
        func opened(_ envelope: ReloEnvelope?, _ itemID: String) -> ReloSealedCardText? {
            guard let envelope else { return nil }
            if let data = open(envelope, itemID), let text = try? JSONDecoder().decode(ReloSealedCardText.self, from: data) {
                return text
            }
            if failure == nil { failure = diagnose?(envelope) ?? "failed" }
            return nil
        }
        let card = opened(sealed?.card, id)
        let asked = opened(sealed?.question, notificationId ?? question?.id ?? id)
        let real = { (value: String?) -> String? in
            guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty,
                  !ReloSealedCards.isPlaceholderTitle(value), value != placeholder,
                  value != ReloSealedCards.promptPlaceholder else { return nil }
            return value
        }
        var item = self
        let openedTitle = real(card?.title) ?? real(asked?.title)
        let unreadable = titleIsPlaceholder && openedTitle == nil
        if titleIsPlaceholder { item.title = String((openedTitle ?? ReloSealedCards.unreadableTitle).prefix(200)) }

        if unreadable {
            let reason = ReloSealedCards.unreadableReason(outcome: failure ?? (sealed == nil ? "not_sealed" : nil))
            if let status, status.contains(placeholder) {
                item.status = status.replacingOccurrences(of: placeholder, with: reason)
            } else if status == nil || status == ReloSealedCards.promptPlaceholder {
                item.status = reason
            }
        } else if statusIsPlaceholder, let status {
            let prompt = real(asked?.summary)
            if status == ReloSealedCards.promptPlaceholder {
                item.status = prompt
            } else if let openedStatus = real(card?.status) ?? prompt {
                item.status = status.replacingOccurrences(of: placeholder, with: openedStatus)
            } else {
                // Opened but without a status: drop the placeholder, keep the server's own words around it.
                let rest = status.replacingOccurrences(of: placeholder, with: "")
                    .trimmingCharacters(in: CharacterSet(charactersIn: " ·–-").union(.whitespaces))
                item.status = rest.isEmpty ? nil : rest
            }
        }
        if stepIsPlaceholder, var steps, let current = steps.current {
            // By the placeholder's number: v1 labels in plan order, else the v2 steps in plan order.
            let ordered = (card?.phases ?? []).flatMap { $0.steps ?? [] }.map { ReloWork.text($0.label) }
            let number = ReloSealedCards.placeholderStepNumber(current) ?? 0
            let byOrder = ordered.indices.contains(number - 1) ? ordered[number - 1] : nil
            let label = card?.legacyLabel(forPlaceholder: current)
                ?? byOrder.flatMap { ReloSealedCards.isPlaceholderStep($0) ? nil : $0 }
            // "Step 2" tells the owner nothing: without the real label the row shows no step name.
            steps.current = label.map { String($0.prefix(80)) }
            item.steps = steps
        }
        if item.roundOutcome == nil, let last = card?.phases?.last, let outcome = last.outcome {
            item.roundOutcome = ReloWork.text(outcome).map { String($0.prefix(200)) }
            if last.id.hasPrefix("r") { item.roundNumber = Int(last.id.dropFirst()) }
        }
        return item
    }
}

public struct SinceYouLooked: Codable, Equatable, Hashable, Sendable {
    public var since: Date
    public var finished: Int
    public var failed: Int
    public var waitingOnYou: Int
    public var stoppedWithoutFinishing: Int
    public var needsYou: Int
}

public struct NowSummary: Codable, Equatable, Hashable, Sendable {
    public struct Folds: Codable, Equatable, Hashable, Sendable {
        public var waitingOnYou: Int
        public var quiet: Int
        public var paused: Int
    }

    public struct LockScreen: Codable, Equatable, Hashable, Sendable {
        public var cards: [String]
        public var needsYouCount: Int
        public var focus: String?
    }

    public var serverTime: Date
    public var sinceYouLooked: SinceYouLooked
    public var needsYou: [NowItem]
    public var recent: [NowItem]
    public var waitingOnYou: [NowItem]
    public var running: [NowItem]
    public var quiet: [NowItem]
    public var paused: [NowItem]
    public var folds: Folds
    public var lockScreen: LockScreen
    public var sessions: SessionsView
    /// The earliest instant anything changes by time alone: refetch then (no client timers).
    public var refreshAt: Date?

    public var allItems: [NowItem] { needsYou + recent + waitingOnYou + running + quiet + paused }

    /// The summary without the Needs-you rows asking these questions (a dismissal in flight).
    public func removingQuestions(_ questionIDs: Set<String>) -> NowSummary {
        var summary = self
        summary.needsYou = needsYou.filter { item in item.question.map { !questionIDs.contains($0.id) } ?? true }
        return summary
    }
    public func item(id: String) -> NowItem? { allItems.first { $0.id == id } }

    /// The summary without one work (it was just ended on this phone).
    public func removingWork(_ workID: String) -> NowSummary {
        var summary = self
        summary.needsYou.removeAll { $0.id == workID }
        summary.recent.removeAll { $0.id == workID }
        summary.waitingOnYou.removeAll { $0.id == workID }
        summary.running.removeAll { $0.id == workID }
        summary.quiet.removeAll { $0.id == workID }
        summary.paused.removeAll { $0.id == workID }
        return summary
    }
}

/// `GET /api/now?since=<ISO>`: the server's Now summary for this device's account.
/// `since` is the owner's last look on this device (a device fact, category E).
public protocol NowSource: Sendable {
    func fetchNow(since: Date?) async throws -> NowSummary
}
/// The optional context and cost facts of a session, as one display line ("62% context · $4.10", or "282k context"
/// when only the token count is known).
public enum SessionUsage {
    /// Context at or above this share reads in the attention tone.
    public static let heavyContextPct = 80

    public static func line(contextPct: Int?, contextTokens: Int? = nil, costUsd: Double?, locale: Locale = .current) -> String? {
        var parts: [String] = []
        if let contextPct {
            parts.append("\(min(max(contextPct, 0), 100))% context")
        } else if let contextTokens, contextTokens >= 0 {
            parts.append("\(tokenCount(contextTokens)) context")
        }
        if let costUsd, costUsd >= 0, costUsd.isFinite {
            parts.append(costUsd.formatted(.currency(code: "USD").locale(locale)))
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// Under 1,000 exact ("850"), under a million in thousands ("282k"), else in millions ("1.2M").
    static func tokenCount(_ tokens: Int) -> String {
        if tokens < 1_000 { return "\(tokens)" }
        if tokens < 1_000_000 { return "\(tokens / 1_000)k" }
        let tenths = tokens / 100_000
        return tenths % 10 == 0 ? "\(tenths / 10)M" : "\(tenths / 10).\(tenths % 10)M"
    }

    public static func isHeavy(contextPct: Int?) -> Bool { (contextPct ?? 0) >= heavyContextPct }
}
