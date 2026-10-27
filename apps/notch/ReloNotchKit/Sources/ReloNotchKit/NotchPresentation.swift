import Foundation
import ReloCore

/// What the notch shows, read straight from the server's Now summary. It decides nothing: which work
/// leads, what needs the owner and what is visible all come from the server's derivation
/// (`owner`, `lockScreen`, the Now sections). It only shapes rows for a small surface.
public struct NotchPresentation: Equatable, Sendable {
    public enum Tone: String, Equatable, Sendable {
        case needsYou, yourTurn, working, quiet, done, failed, paused
        case dropped, leftUnfinished

        /// Work in motion: it shows its plan and a timer.
        public var isMoving: Bool { self == .working }
        /// Over without success: it counts as a failure for events and the closing sign.
        public var isStopped: Bool { self == .failed || self == .dropped || self == .leftUnfinished }
    }

    public struct Row: Identifiable, Equatable, Sendable {
        public var id: String
        public var title: String
        public var status: String?
        public var project: String?
        /// The project's colour slot (`ProjectPalette`), as on the iPhone and the Dashboard.
        public var projectSlot: Int? = nil
        public var source: String?
        public var tone: Tone
        public var chip: OwnerChip?
        public var stepsDone: Int?
        public var stepsTotal: Int?
        public var currentStep: String?
        public var startedAt: Date
        /// The pending question this card asks; nil once it is answered or missed (a missed question asks nothing:
        /// the server's derivation returns the card to its work's own state).
        public var questionID: String?
        public var notificationID: String?
        /// The question is still open for an answer (not missed or answered).
        public var questionPending: Bool
        /// The card's text is sealed and this Mac could not open it (not yet approved on the iPhone).
        public var unreadable: Bool
        /// SF Symbol of the computer the work runs on (ADR 0011); nil when the server names none.
        public var computerSymbol: String?
        public var declaredAt: Date
        /// What the last round delivered, when the work waits on the owner after a round (ADR 0012).
        public var roundOutcome: String?
        /// The session's name (its conversation title), from the server's Sessions view.
        public var topic: String? = nil
        /// The plan as rounds and nested steps, as the iPhone's detail draws it: states from the server, labels from the
        /// card's own text opened on this Mac. Nil without a plan.
        public var outline: PlanOutline? = nil
        /// The gist said after "<Kind>: <name>." (ADR 0015): the outcome as the CLI shortened it, or the agent's `--say`,
        /// from the card's own text opened on this Mac.
        public var spoken: String? = nil
        /// How the work is called aloud (`--spoken-name`), from the card's own text opened on this Mac.
        public var spokenName: String? = nil
        /// How much may be said of this card, from the producer's `relo voice` (ADR 0015 revision 1).
        public var spokenVoice: SpokenLine.Detail? = nil
        /// Which top-level step is current (from 1) and how far its own steps are (0 to 1), from the server's plan.
        public var currentIndex: Int? = nil
        public var currentFill: Double? = nil
        /// The server's own alert level for this work ("passive", "active", "timeSensitive"...): what decides how loud it is.
        public var interruptionLevel: String? = nil
        /// The round the work is in or just delivered (from the server), for "Round 2 delivered".
        public var roundNumber: Int? = nil
        /// When the server last had evidence the work moved (`owner.evidenceAt`): what "last moved" says.
        public var evidenceAt: Date? = nil
        /// Why a Quiet work is quiet, in the iPhone's words ("Session idle since 3:12 PM"): the server's `absence`, else its
        /// `quietReason`. Nil unless the row is Quiet and the server said why.
        public var quietLine: String? = nil
        /// The server's own plan count, kept whole so the line can say rounds as the iPhone does.
        public var planProgress: PlanProgress? = nil

        /// When the work last moved: the server's evidence time, else when it was last declared.
        public var movedAt: Date { evidenceAt ?? declaredAt }

        /// The status line as the iPhone words it: why a Quiet work is quiet, what a delivered round delivered
        /// ("Round 2 delivered: ..."), else what the card says.
        public var statusLine: String? {
            if tone == .quiet, let quietLine { return quietLine }
            if let outcome = roundOutcome, !outcome.isEmpty, tone == .yourTurn {
                return "\(roundNumber.map { "Round \($0) delivered" } ?? "Round delivered"): \(outcome)"
            }
            return status
        }

        /// The plan bar, one segment per top-level step, as the iPhone draws it (`NowItem.Steps.bar`); nil without steps.
        public var bar: PlanBar? {
            guard let total = stepsTotal, total > 0 else { return nil }
            return PlanBar.make(done: stepsDone ?? 0, total: total, current: currentIndex, fill: currentFill)
        }

        /// 0...1 when the plan has steps; nil otherwise.
        public var progress: Double? {
            guard let done = stepsDone, let total = stepsTotal, total > 0 else { return nil }
            return min(1, max(0, Double(done) / Double(total)))
        }

        /// The one plan line (rule U2), worded by the iPhone's `PlanProgress`: "2 of 5 · <step>",
        /// "Paused at 2 of 5", "5 of 5 done", "Stopped at 3 of 5". Nil when the plan has no steps.
        public var planLine: String? {
            guard let done = stepsDone, let total = stepsTotal, total > 0 else { return nil }
            // A delivered round says what it delivered instead of the plan line (the iPhone's rule 4.3).
            if tone == .yourTurn, let outcome = roundOutcome, !outcome.isEmpty { return nil }
            let standing: PlanProgress.Standing = switch tone {
            case .done: .done
            case .failed, .dropped, .leftUnfinished: .stopped
            case .paused: .paused
            default: done >= total ? .done : .moving
            }
            // The server's position of the current step makes the active line "Step 2 of 5", as on the iPhone.
            return PlanProgress(done: done, total: total, current: currentIndex).line(label: currentStep, standing: standing)
        }
    }

    public struct Section: Identifiable, Equatable, Sendable {
        public enum Kind: String, Sendable { case needsYou, waitingOnYou, running, recent, quiet, paused }
        public var kind: Kind
        public var rows: [Row]
        public var id: String { kind.rawValue }

        public var title: String {
            switch kind {
            case .needsYou: "Needs you"
            case .waitingOnYou: "Your turn"
            case .running: "Running"
            case .recent: "Just finished"
            case .quiet: "Quiet"
            case .paused: "Paused"
            }
        }

        /// Quiet and paused work is folded: shown dimmed, after everything that moves.
        public var isFolded: Bool { kind == .quiet || kind == .paused }
    }

    /// The one card the closed notch carries: the server's Lock Screen focus, else its first Lock
    /// Screen card. Nil when the server shows nothing there, and then the notch stays plain.
    public var focus: Row?
    public var needsYouCount: Int
    /// Live work the notch can count beside the focus (needs you, your turn, running).
    public var activeCount: Int
    public var sections: [Section]
    /// Some sealed text could not be opened: this Mac waits for approval on the iPhone.
    public var hasUnreadable: Bool
    /// "2 finished · 1 failed" since the owner last looked on this Mac; nil when nothing happened.
    public var sinceYouLooked: String?
    /// Finished or quiet cards sealed before this Mac could read them (they never update again): one
    /// line, not a list of "Private work" cards.
    public var privateEarlier: Int = 0
    /// The server's Sessions view without folded idle rows: agent conversations working or waiting.
    public var sessions: [Session] = []
    /// When the server said this summary stops being true by time alone (`refreshAt`), and when it was served.
    public var refreshAt: Date? = nil
    public var servedAt: Date? = nil

    public struct Session: Identifiable, Equatable, Sendable {
        public var id: String
        public var title: String
        public var source: String?
        public var project: String?
        public var phase: SessionPhase?
        public var waitingFor: String?
        public var computer: String?
        public var computerSymbol: String?
        public var lastSeenAt: Date
        /// A session already shown by a card (its work) is not listed again.
        public var hasCard: Bool
    }

    /// The agents at work, by computer then by harness, as the iPhone's Sessions view groups them.
    public struct Machine: Identifiable, Equatable, Sendable {
        public struct Harness: Identifiable, Equatable, Sendable {
            public var source: String
            public var working: Int
            public var waiting: Int
            /// Tracked sessions that are idle (a phase the server observed); never an untracked one.
            public var idle: Int
            /// Sessions with no observed state (hooks off): unknown is not idle.
            public var untracked: Int = 0
            /// One phase per session, working first, for a dot each.
            public var phases: [SessionPhase?] = []
            public var id: String { source }
            public var total: Int { working + waiting + idle + untracked }
        }
        public var name: String
        public var symbol: String?
        public var harnesses: [Harness]
        /// Its sessions, working first then waiting: their names say what the machine is doing.
        public var sessions: [Session] = []
        public var id: String { name }
        public var working: Int { harnesses.reduce(0) { $0 + $1.working } }
        public var waiting: Int { harnesses.reduce(0) { $0 + $1.waiting } }
        public var idle: Int { harnesses.reduce(0) { $0 + $1.idle } }
        public var untracked: Int { harnesses.reduce(0) { $0 + $1.untracked } }
        /// Dimmed and labelled Idle only when its sessions are tracked and none works or waits; untracked ones say nothing.
        public var isIdle: Bool { working == 0 && waiting == 0 && untracked == 0 }
    }

    /// Computers with live sessions in the server's order (the order its Sessions view lists them; never re-sorted here, so
    /// the iPhone and the Mac read the same list); harnesses within by how many sessions they run. A computer with no
    /// readable name is left out, or called `unnamedAs` when the caller knows they are all one (this Mac).
    public func machines(unnamedAs: String? = nil) -> [Machine] {
        let live = sessions.filter { $0.phase != .ended }
        var order: [String] = []
        var groups: [String: [Session]] = [:]
        for session in live {
            guard let name = Self.readableName(session.computer) ?? unnamedAs else { continue }
            if groups[name] == nil { order.append(name) }
            groups[name, default: []].append(session)
        }
        return order.map { name in
            let rows = groups[name] ?? []
            return Machine(name: name, symbol: rows.compactMap(\.computerSymbol).first, harnesses: Self.harnesses(in: rows),
                           sessions: rows.sorted { Self.phaseRank($0.phase) < Self.phaseRank($1.phase) })
        }
    }

    public var machines: [Machine] { machines() }

    /// A name the owner can read: server-sealed names this Mac cannot read yet arrive as ids (c-..., p-...).
    public static func readableName(_ name: String?) -> String? {
        guard let name = name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else { return nil }
        if name == "Unknown computer" { return nil }
        if name.range(of: #"^[a-z]-[a-z0-9]{10,}$"#, options: .regularExpression) != nil { return nil }
        return name
    }

    static func harnesses(in rows: [Session]) -> [Machine.Harness] {
        let grouped = Dictionary(grouping: rows, by: { $0.source ?? "Agent" })
        let built: [Machine.Harness] = grouped.map { source, group in
            let working = group.filter { $0.phase == .working }.count
            let waiting = group.filter { $0.phase == .waiting }.count
            let untracked = group.filter { $0.phase == nil }.count
            // Unknown is not idle: only a phase the server observed counts as idle.
            let idle = group.count - working - waiting - untracked
            let phases = group.map(\.phase).sorted { phaseRank($0) < phaseRank($1) }
            return Machine.Harness(source: source, working: working, waiting: waiting, idle: idle, untracked: untracked, phases: phases)
        }
        return built.sorted { ($0.working + $0.waiting, $0.total, $1.source) > ($1.working + $1.waiting, $1.total, $0.source) }
    }

    static func phaseRank(_ phase: SessionPhase?) -> Int {
        switch phase {
        case .working: 0
        case .waiting: 1
        default: 2
        }
    }

    /// One count in the open notch's summary line. `tone` gives its colour and symbol.
    public struct TallyEntry: Identifiable, Equatable, Sendable {
        public enum Kind: String, Sendable { case needsYou, yourTurn, running, finished, failed, stopped, quiet, paused }
        public var kind: Kind
        public var count: Int
        public var id: String { kind.rawValue }

        public var tone: Tone {
            switch kind {
            case .needsYou: .needsYou
            case .yourTurn: .yourTurn
            case .running: .working
            case .finished: .done
            case .failed: .failed
            case .stopped: .leftUnfinished
            case .quiet: .quiet
            case .paused: .paused
            }
        }

        /// The word after the count: "2 needs you", "1 failed", "3 running".
        public var label: String {
            switch kind {
            case .needsYou: "needs you"
            case .yourTurn: "your turn"
            case .running: "running"
            case .finished: "finished"
            case .failed: "failed"
            case .stopped: "stopped"
            case .quiet: "quiet"
            case .paused: "paused"
            }
        }
    }

    /// The one counting model: every surface (the open notch's summary line, the menu bar, Home's headline and chips, the
    /// sessions header) reads these numbers, so a thing is counted once and the same way everywhere. Read off the visible
    /// rows and sessions as they are: nothing is decided here, and a locked row hidden from the list is never counted.
    public struct Counts: Equatable, Sendable {
        /// Needs-you rows.
        public var needsYou = 0
        /// Rows waiting on the owner after a round.
        public var yourTurn = 0
        /// Running cards plus working sessions no card shows: the one "running".
        public var running = 0
        /// Finished well, failed, and ended without finishing (dropped or left unfinished), among the recent rows.
        public var finished = 0
        public var failed = 0
        public var stopped = 0
        public var quiet = 0
        public var paused = 0
        /// Working sessions that no card shows. Not part of `running`: "running" is the live cards the owner sees; a
        /// session the hooks report working without a card (an agent that declared nothing, or a subagent that did not
        /// roll up) shows on its computer's row, never as an extra running card.
        public var sessionsWithoutCards = 0

        /// Something moves or waits on the owner.
        public var isActive: Bool { needsYou + yourTurn + running > 0 }
        /// "2 need you", "1 needs you"; nil at zero.
        public var needsYouText: String? { needsYou == 0 ? nil : (needsYou == 1 ? "1 needs you" : "\(needsYou) need you") }
        /// "3 running"; nil at zero.
        public var runningText: String? { running == 0 ? nil : "\(running) running" }
    }

    public var counts: Counts {
        let rows = { (kind: Section.Kind) in sections.first { $0.kind == kind }?.rows ?? [] }
        let recent = rows(.recent)
        let withoutCards = workingSessionsWithoutCards
        return Counts(needsYou: rows(.needsYou).count, yourTurn: rows(.waitingOnYou).count,
                      running: rows(.running).count,
                      finished: recent.filter { !$0.tone.isStopped }.count, failed: recent.filter { $0.tone == .failed }.count,
                      stopped: recent.filter { $0.tone == .dropped || $0.tone == .leftUnfinished }.count,
                      quiet: rows(.quiet).count, paused: rows(.paused).count, sessionsWithoutCards: withoutCards)
    }

    /// Everything the open notch lists below it, counted in the order that matters (needs you first), zero counts left
    /// out. Built from `counts`.
    public var tally: [TallyEntry] {
        let counts = counts
        return [
            TallyEntry(kind: .needsYou, count: counts.needsYou), TallyEntry(kind: .yourTurn, count: counts.yourTurn),
            TallyEntry(kind: .running, count: counts.running), TallyEntry(kind: .failed, count: counts.failed),
            TallyEntry(kind: .stopped, count: counts.stopped), TallyEntry(kind: .finished, count: counts.finished),
            TallyEntry(kind: .quiet, count: counts.quiet), TallyEntry(kind: .paused, count: counts.paused)
        ].filter { $0.count > 0 }
    }

    /// Sessions working right now that no card shows: what the closed notch counts like music playing.
    public var workingSessionsWithoutCards: Int {
        sessions.filter { $0.phase == .working && !$0.hasCard }.count
    }

    /// The last summary no longer holds: the connection is down and the server's own `refreshAt` has passed with nothing
    /// newer read (without a `refreshAt`, nothing newer for two minutes). A frozen surface stops timers and orbits and says
    /// "as of HH:MM" instead of looking live.
    public func isFrozen(offline: Bool, lastUpdated: Date?, now: Date = Date()) -> Bool {
        guard offline else { return false }
        if let refreshAt { return now >= refreshAt }
        guard let seen = lastUpdated ?? servedAt else { return true }
        return now.timeIntervalSince(seen) > 120
    }

    /// "as of 10:42", for a line that is no longer live.
    public static func asOf(_ date: Date?, locale: Locale = .current, timeZone: TimeZone = .current) -> String {
        guard let date else { return "as of the last update" }
        var style = Date.FormatStyle(time: .shortened).locale(locale)
        style.timeZone = timeZone
        return "as of \(date.formatted(style))"
    }

    public static let empty = NotchPresentation(focus: nil, needsYouCount: 0, activeCount: 0, sections: [], hasUnreadable: false)

    /// Nothing moves or waits: only quiet or paused work, or none.
    public var isQuiet: Bool { sections.allSatisfy(\.isFolded) }

    public var isEmpty: Bool { sections.isEmpty }

    public init(focus: Row?, needsYouCount: Int, activeCount: Int, sections: [Section], hasUnreadable: Bool,
                sinceYouLooked: String? = nil) {
        self.focus = focus
        self.needsYouCount = needsYouCount
        self.activeCount = activeCount
        self.sections = sections
        self.hasUnreadable = hasUnreadable
        self.sinceYouLooked = sinceYouLooked
    }

    public init(summary: NowSummary?, plans: [String: PlanOutline] = [:], spoken: [String: SpokenText] = [:]) {
        guard let summary else { self = .empty; return }
        // A card's session name comes from the Sessions view (opened on this Mac like the iPhone): the session holding
        // the work first, else the card's own session id, as the iPhone's Now does.
        let titled = summary.sessions.sessions.compactMap { session -> (session: SessionRow, title: String)? in
            guard let title = session.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty else { return nil }
            return (session, title)
        }
        let byWork = Dictionary(titled.compactMap { entry in entry.session.workId.map { ($0, entry.title) } }, uniquingKeysWith: { first, _ in first })
        let byID = Dictionary(titled.map { ($0.session.id, $0.title) }, uniquingKeysWith: { first, _ in first })
        let byWorkSession = Dictionary(summary.sessions.sessions.compactMap { row in row.workId.map { ($0, row) } }, uniquingKeysWith: { first, _ in first })
        let byIDSession = Dictionary(summary.sessions.sessions.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let named = { (row: Row, item: NowItem) -> Row in
            var row = row
            row.topic = byWork[item.id] ?? item.sessionId.flatMap { byID[$0] } ?? item.sessionTitle
            // Never the title twice (a session named after its work).
            if let topic = row.topic, topic.caseInsensitiveCompare(row.title) == .orderedSame { row.topic = nil }
            let session = byWorkSession[item.id] ?? item.sessionId.flatMap { byIDSession[$0] }
            row.quietLine = Self.quietLine(item, computer: Self.readableName(session?.computer), tone: row.tone)
            row.outline = plans[item.id]
            row.spoken = spoken[item.id]?.gist
            row.spokenName = spoken[item.id]?.name
            row.spokenVoice = spoken[item.id]?.voice
            return row
        }
        let rowOf = { (item: NowItem) in named(Self.row(item), item) }
        // Work that is over and unreadable here stays out of the list; live work always shows.
        let past = { (items: [NowItem]) in items.map(rowOf).filter { !$0.unreadable } }
        let hidden = (summary.recent + summary.quiet + summary.paused).map(Self.row).filter(\.unreadable).count
        let sections: [Section] = [
            Section(kind: .needsYou, rows: summary.needsYou.map(rowOf)),
            Section(kind: .waitingOnYou, rows: summary.waitingOnYou.map(rowOf)),
            Section(kind: .running, rows: summary.running.map(rowOf)),
            Section(kind: .recent, rows: past(summary.recent)),
            Section(kind: .quiet, rows: past(summary.quiet)),
            Section(kind: .paused, rows: past(summary.paused))
        ].filter { !$0.rows.isEmpty }
        let focusID = summary.lockScreen.focus ?? summary.lockScreen.cards.first
        let focus = focusID.flatMap(summary.item(id:)).map(rowOf)
        let all = sections.flatMap(\.rows)
        self.init(
            focus: focus,
            needsYouCount: summary.needsYou.count,
            activeCount: summary.needsYou.count + summary.waitingOnYou.count + summary.running.count,
            sections: sections,
            hasUnreadable: all.contains(where: \.unreadable),
            sinceYouLooked: Self.recap(summary.sinceYouLooked)
        )
        privateEarlier = hidden
        refreshAt = summary.refreshAt
        servedAt = summary.serverTime
        let cardSessions = Set(summary.allItems.compactMap(\.sessionId))
        sessions = summary.sessions.sessions
            .filter { !$0.isFoldedIdle && $0.phase != .ended }
            .map { row in
                Session(
                    id: row.id,
                    title: row.title.flatMap { $0.isEmpty ? nil : $0 } ?? row.project ?? row.sourceLabel ?? "Session",
                    source: row.sourceLabel,
                    project: row.project,
                    phase: row.phase,
                    waitingFor: row.waitingFor,
                    computer: row.computer.flatMap { $0.isEmpty ? nil : $0 },
                    computerSymbol: row.computerIcon?.systemImageName,
                    lastSeenAt: row.lastSeenAt,
                    hasCard: cardSessions.contains(row.id) || row.workId != nil
                )
            }
    }

    /// The server's counts since the last look, in the iPhone's order of what matters.
    static func recap(_ since: SinceYouLooked) -> String? {
        let parts: [String] = [
            since.needsYou > 0 ? "\(since.needsYou) needs you" : nil,
            since.failed > 0 ? "\(since.failed) failed" : nil,
            since.stoppedWithoutFinishing > 0 ? "\(since.stoppedWithoutFinishing) stopped" : nil,
            since.finished > 0 ? "\(since.finished) finished" : nil,
            since.waitingOnYou > 0 ? "\(since.waitingOnYou) your turn" : nil
        ].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    static func row(_ item: NowItem) -> Row {
        // A sealed card this Mac could not open: the server's placeholder, or the opener's own
        // "Can't be read on this iPhone" with its reason (written for the iPhone, said here for the Mac).
        let openFailed = item.title == ReloSealedCards.unreadableTitle
        let unreadable = openFailed || ReloSealedCards.isPlaceholderTitle(item.title)
        let status = item.status
            .flatMap { $0.isEmpty || $0 == ReloSealedCards.statusPlaceholder ? nil : $0 }
            .map { openFailed ? $0.replacingOccurrences(of: "iPhone", with: "Mac") : $0 }
        var row = Row(
            id: item.id,
            title: unreadable ? "Private work" : item.title,
            status: status,
            project: item.project,
            projectSlot: item.projectSlot,
            source: item.sourceName,
            tone: tone(item.owner),
            chip: item.chip,
            // The plan as the server counts it (`progress`), else the older `steps`: what the iPhone draws.
            stepsDone: item.planSteps?.done,
            stepsTotal: item.planSteps?.total,
            currentStep: item.planSteps?.current,
            startedAt: item.startedAt,
            questionID: item.question?.standing == .pending ? item.question?.id : nil,
            notificationID: item.notificationId,
            questionPending: item.question?.standing == .pending,
            unreadable: unreadable,
            computerSymbol: item.computerIcon?.systemImageName,
            declaredAt: item.declaredAt,
            roundOutcome: item.roundOutcome
        )
        row.currentIndex = item.planSteps?.currentIndex
        row.currentFill = item.planSteps?.fill
        row.interruptionLevel = item.owner.interruptionLevel
        row.roundNumber = item.roundNumber
        row.evidenceAt = item.owner.evidenceAt
        row.planProgress = item.progress
        row.quietLine = quietLine(item, tone: row.tone)
        return row
    }

    /// Why a Quiet work is quiet, as the iPhone says it: the server's `absence`, else its `quietReason`, else what the state
    /// itself says. Nil for work that is not Quiet.
    static func quietLine(_ item: NowItem, computer: String? = nil, tone: Tone) -> String? {
        guard tone == .quiet else { return nil }
        let clock = { (date: Date) in date.formatted(date: .omitted, time: .shortened) }
        if let line = item.owner.absence.flatMap({ AbsenceWording.line($0, computer: computer) }) { return line }
        if let line = QuietWording.line(reason: item.quietWhy, since: item.quietFrom ?? item.owner.evidenceAt) { return line }
        switch item.owner.state {
        case .stoppedResponding:
            return "Stopped responding at \(item.planSteps?.current ?? item.status ?? "its last step"), last seen \(clock(item.owner.evidenceAt))"
        case .noSignal: return "No signal since \(clock(item.owner.evidenceAt))"
        default: return nil
        }
    }

    static func tone(_ owner: OwnerStateResult) -> Tone {
        switch owner.state {
        case .needsYou: .needsYou
        case .waitingOnYou: .yourTurn
        // Waiting on its own job (CI, a build, a benchmark) is moving: Running, with "Waiting on X" as its status.
        case .moving, .workingQuietly: .working
        case .stale, .stoppedResponding, .noSignal, .unknown: .quiet
        case .done: .done
        case .failed: .failed
        case .dropped: .dropped
        case .leftUnfinished: .leftUnfinished
        case .paused: .paused
        }
    }
}
