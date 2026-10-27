import Foundation
import ReloCore

/// What changed between two Now summaries, the way the iPhone's Live Activities see an update: a work
/// started, needs the owner, became the owner's turn, finished or failed. The notch expands for these
/// (like the Dynamic Island) and may play a sound. Step progress and status text change the card in
/// place without an event. Everything compared here is the server's derivation.
public struct NotchEvent: Equatable, Sendable {
    public enum Kind: String, CaseIterable, Sendable {
        case question, failed, yourTurn, finished, started
        /// A finished plan step, said aloud at the Verbose spoken detail (ADR 0015 revision 1). Never produced by
        /// `between`: it does not expand the notch or play a sound; Relo for Mac's moments find it themselves.
        case progressed

        /// Which event leads when several arrive together.
        public var rank: Int {
            switch self {
            case .question: 0
            case .failed: 1
            case .yourTurn: 2
            case .finished: 3
            case .started: 4
            case .progressed: 5
            }
        }
    }

    /// What the server derived for the work behind an event: the only inputs the Mac uses to decide whether to expand,
    /// cue and say it. Nothing here is re-derived on the Mac (CLAUDE.md, Relo state model).
    public struct Facts: Equatable, Sendable {
        /// The server's interruption level (passive, active, time-sensitive); nil when the server stays silent.
        public var interruptionLevel: String?
        public var needsYou: NeedsYouReason?
        public var evidenceAt: Date
        /// The sealed round this work last closed, when it waits on the owner after a round.
        public var roundNumber: Int?
        /// A Quiet work's own words ("Session idle since 3:12 PM"), from the server's reason or absence.
        public var quietLine: String?
        /// How old the evidence was when the summary was made.
        public var age: TimeInterval

        public init(interruptionLevel: String? = nil, needsYou: NeedsYouReason? = nil, evidenceAt: Date, roundNumber: Int? = nil,
                    quietLine: String? = nil, age: TimeInterval = 0) {
            self.interruptionLevel = interruptionLevel
            self.needsYou = needsYou
            self.evidenceAt = evidenceAt
            self.roundNumber = roundNumber
            self.quietLine = quietLine
            self.age = age
        }

        public init(item: NowItem, serverTime: Date, locale: Locale = .current, timeZone: TimeZone = .current) {
            let owner = item.owner
            var line = item.quietLine(locale: locale, timeZone: timeZone)
            if line == nil, let absence = owner.absence { line = AbsenceWording.line(absence, locale: locale, timeZone: timeZone) }
            self.init(interruptionLevel: owner.interruptionLevel, needsYou: owner.needsYou, evidenceAt: owner.evidenceAt,
                      roundNumber: item.roundNumber, quietLine: line, age: max(0, serverTime.timeIntervalSince(owner.evidenceAt)))
        }
    }

    public var kind: Kind
    public var row: NotchPresentation.Row
    /// The server's derivation for the work; nil for an event the Mac stages itself (onboarding, previews).
    public var facts: Facts?

    public init(kind: Kind, row: NotchPresentation.Row, facts: Facts? = nil) {
        self.kind = kind
        self.row = row
        self.facts = facts
    }

    /// Once per moment: the work, the question, and the round (else the server's evidence time), so a later round of the
    /// same work announces again while a reconnect or a remount does not.
    public var momentKey: String {
        let round = facts.map { $0.roundNumber.map { "r\($0)" } ?? "e\(Int($0.evidenceAt.timeIntervalSince1970 * 1000))" } ?? ""
        return "\(kind.rawValue)|\(row.id)|\(row.questionID ?? "")|\(round)"
    }

    /// The events from `previous` to `next`, most important first. The first summary after launch
    /// (`previous` nil) only reports questions already waiting: that is why the owner looks now.
    /// `summary` is the server's Now summary behind `next`: its per-work derivation decides the rest. Without it, work
    /// that merely stopped (dropped, left unfinished) stays silent, since only the server says whether that is news.
    /// `previousServerTime` is the previous summary's time: a change whose evidence is older than it was already
    /// reported (or slept through) and is not announced again.
    public static func between(_ previous: NotchPresentation?, _ next: NotchPresentation, summary: NowSummary? = nil,
                               previousServerTime: Date? = nil) -> [NotchEvent] {
        let rows = next.sections.filter { !$0.isFolded }.flatMap(\.rows)
        let factsOf = { (id: String) -> Facts? in
            summary?.item(id: id).map { Facts(item: $0, serverTime: summary?.serverTime ?? Date()) }
        }
        guard let previous else {
            return rows.filter(\.questionPending).map { NotchEvent(kind: .question, row: $0, facts: factsOf($0.id)) }
        }
        let before = Dictionary(previous.sections.flatMap(\.rows).map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var events: [NotchEvent] = []
        for row in rows {
            let old = before[row.id]
            let facts = factsOf(row.id)
            // Older than the previous summary: not news.
            if let facts, let since = previousServerTime, facts.evidenceAt < since, !(row.questionPending && old?.questionID != row.questionID) { continue }
            if row.questionPending, old?.questionID != row.questionID || old?.questionPending != true {
                events.append(NotchEvent(kind: .question, row: row, facts: facts))
                continue
            }
            // Needs you without a question to answer (a permission prompt on a work whose hooks relay none): a moment like a
            // question. A missed question is not news.
            if row.tone == .needsYou, !row.questionPending, facts?.needsYou != .missedQuestion, old?.tone != .needsYou {
                events.append(NotchEvent(kind: .question, row: row, facts: facts))
                continue
            }
            guard old?.tone != row.tone else { continue }
            switch row.tone {
            case .failed: events.append(NotchEvent(kind: .failed, row: row, facts: facts))
            // Stopped by time alone (the server derived no interruption): neither expands nor speaks.
            case .dropped, .leftUnfinished:
                if facts?.interruptionLevel != nil { events.append(NotchEvent(kind: .failed, row: row, facts: facts)) }
            case .yourTurn: events.append(NotchEvent(kind: .yourTurn, row: row, facts: facts))
            case .done: events.append(NotchEvent(kind: .finished, row: row, facts: facts))
            // New work, or work that moves again after a pause or a quiet spell.
            case .working where old == nil || old?.tone == .paused || old?.tone == .quiet:
                events.append(NotchEvent(kind: .started, row: row, facts: facts))
            default: break
            }
        }
        return events.sorted { $0.kind.rank < $1.kind.rank }
    }
}
