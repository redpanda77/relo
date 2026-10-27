import ReloCore
import SwiftUI

// MARK: - Now screen model (1.14)
//
// Every string on Now comes from `NowScreenModel`. Its input mirrors the server's `NowSummary`
// (contract owner-state v1); until the ReloCore mirror and the `/api/now` client land, NowView
// fills it through `NowScreenInput.legacy`. Nothing here decides a state: rows sit in the list the
// input put them in, and labels only render times the input carries.

typealias NowOwnerState = OwnerState

enum NowNeedsReason: Equatable, Sendable { case question, missedQuestion, permission }

/// One work item from a Now list.
struct NowItemInput: Equatable, Identifiable, Sendable {
    var id: String
    var notificationID: String?
    var title: String
    var status: String?
    var source: String
    var project: String?
    /// The project's colour slot from the server (`ProjectPalette`).
    var projectSlot: Int? = nil
    var computer: String?
    var computerIcon: ComputerIcon? = nil
    /// The session's own name ("Release review"), from the Sessions list.
    var topic: String? = nil
    var state: NowOwnerState
    var reason: NowNeedsReason? = nil
    /// The server's evidence time (category A: rendered, never compared).
    var evidenceAt: Date
    var startedAt: Date? = nil
    var expiresAt: Date? = nil
    var steps: NowItem.Steps? = nil
    var progress: Double? = nil
    /// The question a Needs-you row asks (`int_…`), for Dismiss on a missed question.
    var questionID: String? = nil
    /// What the last closed round delivered, shown on a "Your turn" row in place of the card's status.
    var roundOutcome: String? = nil
    var roundNumber: Int? = nil
    /// Why a Quiet work is quiet and since when (the server's words become the status line).
    var quietReason: QuietReason? = nil
    var quietSince: Date? = nil
    var absence: Absence? = nil
}

struct NowSinceInput: Equatable, Sendable {
    var since: Date
    var finished = 0, failed = 0, waitingOnYou = 0, stoppedWithoutFinishing = 0
}

struct NowSessionInput: Equatable, Identifiable, Sendable {
    enum Phase: Equatable, Sendable { case working, waiting, idle, ended }
    var id: String
    var title: String
    var computer: String?
    var computerIcon: ComputerIcon? = nil
    /// nil: hooks off, only "last seen".
    var phase: Phase?
    var waitingFor: String?
    var lastSeenAt: Date
    var workID: String?
    var folded: Bool
    /// Tool and project ("Claude Code · relo") under the title when the session has a name of its own.
    var context: String? = nil
    var contextPct: Int? = nil
    var contextTokens: Int? = nil
    var costUsd: Double? = nil
    /// The harness running it (`claude-code`, `codex`), for the deck's machines line.
    var source: String? = nil
}

struct NowScreenInput: Equatable, Sendable {
    var serverTime: Date
    var sinceYouLooked: NowSinceInput?
    var recent: [NowItemInput] = []
    /// Missed questions and permission prompts; live questions render from the decision feed.
    var needsYou: [NowItemInput] = []
    var waitingOnYou: [NowItemInput] = []
    var running: [NowItemInput] = []
    var quiet: [NowItemInput] = []
    var paused: [NowItemInput] = []
    var sessions: [NowSessionInput] = []
}

enum NowTone: Equatable, Sendable { case needsYou, running, runningQuiet, attention, failed, done, sessions, secondary }

struct NowRowModel: Equatable, Identifiable, Sendable {
    var id: String
    var notificationID: String?
    var title: String
    var chip: String?
    var tone: NowTone
    var lines: [String] = []
    var footnote: String? = nil
    var meta: String? = nil
    var shimmer = false
    var startedAt: Date? = nil
    var steps: NowItem.Steps? = nil
    var progress: Double? = nil
    var reason: NowNeedsReason? = nil
    var questionID: String? = nil
    /// Work cards (Waiting on you, Running) read like the card in History: where it runs, what it is,
    /// how it stands, and its plan.
    var card: NowCardModel? = nil
    /// The owner may end this work from the row (swipe "End"): Quiet and Your turn.
    var endable = false
}

struct NowCardModel: Equatable, Sendable {
    var origin: [String]
    var at: Date
    var badge: String?
    var status: String?
    var note: String?
    var caption: String?
    var computer: String?
    var computerIcon: ComputerIcon? = nil
    /// The project the work belongs to (nil for a script with none).
    var project: String? = nil
    var projectSlot: Int? = nil
    /// Set on settled and parked work (Since you looked, Quiet, Paused): the badge then reads and colors
    /// as on History and the detail page (`ReloStateStyle`).
    var ownerState: NowOwnerState? = nil
    /// Since when a Quiet work is quiet (the badge's minutes).
    var quietSince: Date? = nil
}

struct NowSessionRowModel: Equatable, Identifiable, Sendable {
    var id: String
    var title: String
    var workTitle: String?
    var chip: String
    var tone: NowTone
    var notificationID: String?
    var context: String? = nil
    /// When the session was last seen; closes the state line ("Idle · 11:42 PM").
    var lastSeenAt: Date? = nil
    /// The harness running it (`claude-code`, `codex`): its mark leads the row.
    var source: String? = nil
    /// nil: hooks off, only "last seen".
    var phase: NowSessionInput.Phase? = nil
    /// Context used (0-100). Shown as a bar whenever the session reports it; 80 or more reads amber.
    var contextPct: Int? = nil
    var costUsd: Double? = nil

    /// Context at 80% or more reads in the attention tone.
    var heavyContext: Bool { SessionUsage.isHeavy(contextPct: contextPct) }
}

/// How many of a machine's sessions run one harness (the chips in its header).
struct NowHarnessCount: Equatable, Identifiable, Sendable {
    var source: String
    var count: Int
    var id: String { source }
}

struct NowSessionGroupModel: Equatable, Identifiable, Sendable {
    var id: String { title }
    var title: String
    /// The group's computer icon: the first of its sessions that names one.
    var icon: ComputerIcon? = nil
    var rows: [NowSessionRowModel]
    var idle: [NowSessionRowModel]
    /// "3 sessions · 2 need you", "1 session · running", "Idle since 4:10 PM".
    var summary: String = ""
    /// The machine's most urgent phase; nil for an idle machine (a dim dot, no glow).
    var dot: NowTone? = nil
    var harnesses: [NowHarnessCount] = []
}

struct NowSessionsBlock: Equatable, Sendable {
    var working: Int
    var groups: [NowSessionGroupModel]
    /// Every session that is not idle: the section's count.
    var active: Int { groups.reduce(0) { $0 + $1.rows.count } }
}

enum NowBlock: Equatable, Identifiable, Sendable {
    case sinceYouLooked(line: String?, accessibility: String?, recent: [NowRowModel], more: Int)
    case needsYou([NowRowModel])
    /// Quiet and Paused share one line: "Quiet 2 · Paused 1   Show ›".
    case parked(quiet: [NowRowModel], paused: [NowRowModel], open: Bool)
    case waitingOnYou([NowRowModel])
    case running(title: String, rows: [NowRowModel])
    case sessions(NowSessionsBlock)

    var id: String {
        switch self {
        case .sinceYouLooked: "since"
        case .needsYou: "needs"
        case .parked: "fold-parked"
        case .waitingOnYou: "waiting"
        case .running: "running"
        case .sessions: "sessions"
        }
    }
}

extension NowBlock {
    /// What the page animates on: the section, then each card in it, so a card that changes section moves.
    var motionKeys: [String] {
        let rows: [NowRowModel] = switch self {
        case let .sinceYouLooked(_, _, recent, _): recent
        case let .needsYou(rows), let .waitingOnYou(rows), let .running(_, rows): rows
        case let .parked(quiet, paused, _): quiet + paused
        case .sessions: []
        }
        return [id] + rows.map(\.id)
    }
}

/// A work card on its own surface keeps its identity across sections: leaving Waiting on you for Running it
/// glides to its new place instead of fading out in one and in in the other.
private struct CardTravel: ViewModifier {
    let id: String?
    let space: Namespace.ID

    func body(content: Content) -> some View {
        if let id { content.matchedGeometryEffect(id: id, in: space) } else { content }
    }
}

extension AnyTransition {
    /// A card arriving on Now settles down into place; leaving, it dissolves through a soft blur (`reloSoftSwap`).
    static var reloCardArrival: AnyTransition {
        .asymmetric(insertion: .opacity.combined(with: .scale(scale: 0.96, anchor: .top)), removal: .reloSoftSwap)
    }
}

enum NowScreenModel {
    static let defaultWindow: TimeInterval = 8 * 3_600

    /// What answering a missed question means. Said once, on the page where the late answer is given.
    static let lateAnswerNote = "Late answers reach the session marked late. An approval here is not permission: the session must ask again."

    static func make(_ input: NowScreenInput, isOffline: Bool, openFolds: Set<String>,
                     calendar: Calendar = .current, locale: Locale = .current) -> [NowBlock] {
        var blocks: [NowBlock] = []
        var seen = Set<String>()
        func unique(_ items: [NowItemInput]) -> [NowItemInput] {
            items.filter { seen.insert($0.id).inserted }
        }
        let now = input.serverTime
        let needs = unique(input.needsYou)
        if !needs.isEmpty { blocks.append(.needsYou(needs.map { needsRow($0, locale: locale) })) }
        let waiting = unique(input.waitingOnYou)
        // The owner's turn is shown, never folded: it is the second question after "does anything need me".
        if !waiting.isEmpty { blocks.append(.waitingOnYou(waiting.map { waitingRow($0, locale: locale) })) }
        let running = unique(input.running)
        if !running.isEmpty {
            blocks.append(.running(title: isOffline ? "Last known" : "Running",
                                   rows: running.map { runningRow($0, now: now, isOffline: isOffline) }))
        }
        if let since = input.sinceYouLooked {
            let line = sinceLine(since, serverTime: now, calendar: calendar, locale: locale)
            let recent = unique(input.recent)
            let open = openFolds.contains("recent")
            let shown = open ? recent : Array(recent.prefix(4))
            // A quiet stretch says nothing here: the deck's "Live · synced" already says the
            // screen is current, so "Nothing new since…" only repeated it.
            if line != nil || !shown.isEmpty {
                blocks.append(.sinceYouLooked(line: line?.text, accessibility: line?.spoken,
                                              recent: shown.map { recentRow($0, locale: locale) },
                                              more: recent.count - shown.count))
            }
        }
        let quiet = unique(input.quiet)
        let paused = unique(input.paused)
        if !quiet.isEmpty || !paused.isEmpty {
            blocks.append(.parked(quiet: quiet.map { quietRow($0, now: now, locale: locale) },
                                  paused: paused.map { pausedRow($0, locale: locale) },
                                  open: openFolds.contains("parked")))
        }
        if !input.sessions.isEmpty {
            let work = input.needsYou + input.waitingOnYou + input.running
            blocks.append(.sessions(sessionsBlock(input.sessions, work: work, now: now, locale: locale)))
        }
        return blocks
    }

    // MARK: Since you looked

    struct SinceLine: Equatable { var text: String; var spoken: String }

    static func sinceLine(_ since: NowSinceInput, serverTime: Date, calendar: Calendar = .current,
                          locale: Locale = .current) -> SinceLine? {
        let parts = [
            since.finished > 0 ? "\(since.finished) finished" : nil,
            since.failed > 0 ? "\(since.failed) failed" : nil,
            since.waitingOnYou > 0 ? "\(since.waitingOnYou) waiting on you" : nil,
            since.stoppedWithoutFinishing > 0 ? "\(since.stoppedWithoutFinishing) stopped without finishing" : nil,
        ].compactMap { $0 }
        let time = since.since.formatted(Date.FormatStyle(time: .shortened).locale(locale))
        let isDefault = abs(serverTime.addingTimeInterval(-defaultWindow).timeIntervalSince(since.since)) < 60
        let lead: String
        if isDefault {
            lead = "In the last 8 hours"
        } else if calendar.isDate(since.since, inSameDayAs: serverTime) {
            lead = "Since \(time)"
        } else if let yesterday = calendar.date(byAdding: .day, value: -1, to: serverTime),
                  calendar.isDate(since.since, inSameDayAs: yesterday) {
            lead = "Since yesterday \(time)"
        } else {
            lead = "Since \(since.since.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened).locale(locale)))"
        }
        guard !parts.isEmpty else { return nil }
        let list = parts.joined(separator: ", ")
        return SinceLine(text: "\(lead): \(list)", spoken: "\(lead), \(list)")
    }

    // MARK: Rows

    private static func origin(_ item: NowItemInput) -> String {
        [item.source, item.project].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private static func clock(_ date: Date, locale: Locale) -> String {
        date.formatted(Date.FormatStyle(time: .shortened).locale(locale))
    }

    static func relative(_ date: Date, now: Date) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: now)
    }

    static func recentRow(_ item: NowItemInput, locale: Locale = .current) -> NowRowModel {
        let (chip, tone): (String, NowTone) = switch item.state {
        case .failed: ("FAILED", .failed)
        case .done: ("DONE", .done)
        case .leftUnfinished: ("STOPPED WITHOUT FINISHING", .secondary)
        case .dropped: ("DROPPED", .attention)
        default: ("UPDATED", .secondary)
        }
        let line = item.state == .leftUnfinished
            ? "last update \(clock(item.evidenceAt, locale: locale))" : (item.status ?? "")
        return NowRowModel(id: item.id, notificationID: item.notificationID, title: item.title, chip: chip, tone: tone,
                           lines: [line, origin(item)].filter { !$0.isEmpty },
                           steps: item.steps, progress: item.progress, card: settledCard(item))
    }

    /// Settled and parked work on the shared card: how it stands (as History says it), when, and where its plan got to.
    private static func settledCard(_ item: NowItemInput) -> NowCardModel {
        var model = card(item, at: item.evidenceAt, badge: ReloStateStyle.make(state: item.state, standing: nil)?.label,
                         note: nil, caption: stepsCaption(item.steps, standing: standing(of: item.state)))
        model.ownerState = item.state
        return model
    }

    static func needsRow(_ item: NowItemInput, locale: Locale = .current) -> NowRowModel {
        switch item.reason ?? .question {
        case .missedQuestion:
            let chip = item.expiresAt.map { "MISSED \(clock($0, locale: locale))" } ?? "MISSED"
            return NowRowModel(id: item.id, notificationID: item.notificationID, title: item.title, chip: chip,
                               tone: .needsYou, lines: [item.status].compactMap { $0 }.filter { !$0.isEmpty },
                               reason: .missedQuestion, questionID: item.questionID,
                               // The header's corner reads "Missed 14:02": the time the answer was due.
                               card: card(item, at: item.expiresAt ?? item.evidenceAt, badge: "Missed", note: nil, caption: nil))
        case .permission:
            let computer = item.computer ?? "your computer"
            return NowRowModel(id: item.id, notificationID: item.notificationID, title: item.title, chip: "PERMISSION",
                               tone: .needsYou,
                               lines: ["\(item.source) is waiting for a permission prompt on \(computer)."],
                               footnote: "Answer it on your computer.", reason: .permission,
                               card: card(item, at: item.evidenceAt, badge: "Permission", note: nil, caption: nil))
        case .question:
            return NowRowModel(id: item.id, notificationID: item.notificationID, title: item.title, chip: nil,
                               tone: .needsYou, lines: [item.status].compactMap { $0 }.filter { !$0.isEmpty }, reason: .question,
                               card: card(item, at: item.evidenceAt, badge: "Needs you", note: nil, caption: nil))
        }
    }

    static func waitingRow(_ item: NowItemInput, locale: Locale = .current) -> NowRowModel {
        let since = "since \(clock(item.evidenceAt, locale: locale))"
        return NowRowModel(id: item.id, notificationID: item.notificationID, title: item.title, chip: nil, tone: .attention,
                           lines: ["Your turn · \(since)", origin(item)].filter { !$0.isEmpty },
                           steps: item.steps,
                           // The header carries the time it became the owner's turn; the caption never repeats it.
                           card: card(item.roundOutcome.map { delivered(item, outcome: $0) } ?? item, at: item.evidenceAt,
                                      badge: "Your turn", note: nil,
                                      // A delivered round shows its outcome instead of the plan line (4.3).
                                      caption: item.roundOutcome == nil ? stepsCaption(item.steps) : nil),
                           endable: WorkEnding.isOffered(for: item.state))
    }

    /// A row whose round was delivered says what the round delivered, not the card's last status.
    private static func delivered(_ item: NowItemInput, outcome: String) -> NowItemInput {
        var shown = item
        shown.status = "\(item.roundNumber.map { "Round \($0) delivered" } ?? "Round delivered"): \(outcome)"
        return shown
    }

    /// The one plan line (U2), as the Lock Screen and History read it: "2 of 10 · Run the migrations".
    static func stepsCaption(_ steps: NowItem.Steps?, standing: PlanProgress.Standing = .moving) -> String? {
        guard let steps, steps.total > 0 else { return nil }
        // The server's position of the current top-level step makes the active line "Step 2 of 5".
        let progress = PlanProgress(done: steps.done, total: steps.total, current: steps.currentIndex)
        let finished = standing == .moving && steps.done >= steps.total
        return progress.line(label: steps.current, standing: finished ? .done : standing)
    }

    /// How a settled work's plan reads: finished, stopped or paused.
    static func standing(of state: NowOwnerState) -> PlanProgress.Standing {
        switch state {
        case .done: .done
        case .failed, .dropped, .leftUnfinished: .stopped
        case .paused: .paused
        default: .moving
        }
    }

    private static func card(_ item: NowItemInput, at: Date, badge: String?, note: String?, caption: String?) -> NowCardModel {
        let topic = item.topic.flatMap { $0.isEmpty || $0 == item.title ? nil : $0 }
        return NowCardModel(origin: [item.source, item.project, topic].compactMap { $0 }.filter { !$0.isEmpty },
                            at: at, badge: badge, status: item.status.flatMap { $0.isEmpty ? nil : $0 }, note: note,
                            caption: caption?.isEmpty == false ? caption : nil, computer: item.computer,
                            computerIcon: item.computerIcon, project: item.project, projectSlot: item.projectSlot)
    }

    static func runningRow(_ item: NowItemInput, now: Date, isOffline: Bool) -> NowRowModel {
        let quietly = item.state == .workingQuietly
        var lines = [item.status ?? ""]
        if quietly { lines.append("Working quietly · updated \(relative(item.evidenceAt, now: now))") }
        lines.append(origin(item))
        return NowRowModel(id: item.id, notificationID: item.notificationID, title: item.title,
                           chip: isOffline ? "Unconfirmed" : nil, tone: quietly ? .runningQuiet : .running,
                           lines: lines.filter { !$0.isEmpty },
                           meta: "updated \(relative(item.evidenceAt, now: now))",
                           // Light runs through work that moves (waiting on its own job included: it reads Running).
                           shimmer: item.state == .moving && !isOffline, startedAt: item.startedAt,
                           steps: item.steps, progress: item.progress,
                           card: card(item, at: item.startedAt ?? item.evidenceAt, badge: isOffline ? "Unconfirmed" : nil,
                                      note: quietly ? "Working quietly · updated \(relative(item.evidenceAt, now: now))" : nil,
                                      caption: stepsCaption(item.steps)))
    }

    static func quietRow(_ item: NowItemInput, now: Date, locale: Locale = .current) -> NowRowModel {
        let line: String = switch item.state {
        case .stoppedResponding:
            "Stopped responding at \(item.steps?.current ?? item.status ?? "its last step"), last seen \(clock(item.evidenceAt, locale: locale))"
        case .noSignal: "No signal since \(clock(item.evidenceAt, locale: locale))"
        default: "Quiet · updated \(relative(item.evidenceAt, now: now))"
        }
        var card = settledCard(item)
        // The server said why it is quiet: that is the status line (U10), in place of the agent's last words.
        let why = item.absence.flatMap { AbsenceWording.line($0, computer: item.computer, locale: locale) }
            ?? QuietWording.line(reason: item.quietReason, since: item.quietSince ?? item.evidenceAt, locale: locale)
        if let why { card.status = why }
        card.quietSince = item.quietSince ?? item.evidenceAt
        return NowRowModel(id: item.id, notificationID: item.notificationID, title: item.title, chip: nil, tone: .secondary,
                           lines: [why ?? line, origin(item)].filter { !$0.isEmpty },
                           steps: item.steps, progress: item.progress, card: card,
                           endable: WorkEnding.isOffered(for: item.state))
    }

    static func pausedRow(_ item: NowItemInput, locale: Locale = .current) -> NowRowModel {
        NowRowModel(id: item.id, notificationID: item.notificationID, title: item.title, chip: nil, tone: .secondary,
                    lines: ["Paused · \(item.status ?? "")", "paused \(clock(item.evidenceAt, locale: locale))", origin(item)]
                        .filter { !$0.isEmpty && $0 != "Paused · " },
                    steps: item.steps, progress: item.progress, card: settledCard(item))
    }

    // MARK: Sessions

    static func sessionsBlock(_ sessions: [NowSessionInput], work: [NowItemInput], now: Date,
                              locale: Locale = .current) -> NowSessionsBlock {
        var order: [String] = []
        var byComputer: [String: [NowSessionInput]] = [:]
        for session in sessions {
            let key = session.computer ?? "Unknown computer"
            if byComputer[key] == nil { order.append(key) }
            byComputer[key, default: []].append(session)
        }
        let workByID = Dictionary(work.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        func row(_ session: NowSessionInput) -> NowSessionRowModel {
            let (chip, tone): (String, NowTone) = switch session.phase {
            case .working: ("Working", .running)
            case .waiting: session.waitingFor == "input" ? ("Needs you", .needsYou) : ("Your turn", .attention)
            case .idle: ("Idle", .secondary)
            case .ended: ("Ended", .secondary)
            case nil: ("Last seen \(relative(session.lastSeenAt, now: now))", .secondary)
            }
            let linked = session.workID.flatMap { workByID[$0] }
            return NowSessionRowModel(id: session.id, title: session.title, workTitle: linked?.title, chip: chip,
                                      tone: tone, notificationID: linked?.notificationID, context: session.context,
                                      lastSeenAt: session.phase == nil ? nil : session.lastSeenAt,
                                      source: session.source, phase: session.phase, contextPct: session.contextPct,
                                      costUsd: session.costUsd)
        }
        func plural(_ n: Int) -> String { "\(n) \(n == 1 ? "session" : "sessions")" }
        let groups = order.map { key -> NowSessionGroupModel in
            let members = byComputer[key] ?? []
            let rows = members.filter { !$0.folded }
            let idle = members.filter(\.folded)
            let needs = rows.filter { $0.phase == .waiting }.count
            let working = rows.filter { $0.phase == .working }.count
            let summary: String
            let dot: NowTone?
            if rows.isEmpty {
                let since = idle.map(\.lastSeenAt).max().map { clock($0, locale: locale) }
                summary = since.map { "Idle since \($0)" } ?? "Idle"
                dot = nil
            } else if needs > 0 {
                summary = "\(plural(rows.count)) · \(needs) \(needs == 1 ? "needs" : "need") you"
                dot = rows.contains { $0.phase == .waiting && $0.waitingFor == "input" } ? .needsYou : .attention
            } else if working > 0 {
                summary = "\(plural(rows.count)) · running"
                dot = .running
            } else {
                summary = "\(plural(rows.count)) · quiet"
                dot = .secondary
            }
            var counts: [String: Int] = [:]
            var seen: [String] = []
            for session in rows {
                guard let source = session.source else { continue }
                if counts[source] == nil { seen.append(source) }
                counts[source, default: 0] += 1
            }
            let harnesses = seen.map { NowHarnessCount(source: $0, count: counts[$0] ?? 0) }
                .sorted { $0.count > $1.count }
            return NowSessionGroupModel(title: key, icon: members.lazy.compactMap(\.computerIcon).first,
                                        rows: rows.map(row), idle: idle.map(row), summary: summary, dot: dot,
                                        harnesses: harnesses)
        }
        return NowSessionsBlock(working: sessions.filter { $0.phase == .working }.count, groups: groups)
    }
}

extension NowScreenInput {
    /// The server's Now summary (`GET /api/now`), read as is.
    init(summary: NowSummary) {
        // Each work's session names where it runs: the session's own name and its computer.
        let sessionsByWork = Dictionary(summary.sessions.sessions.compactMap { row in row.workId.map { ($0, row) } },
                                        uniquingKeysWith: { first, _ in first })
        let sessionsByID = Dictionary(summary.sessions.sessions.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        func item(_ item: NowItem) -> NowItemInput {
            let session = sessionsByWork[item.id] ?? item.sessionId.flatMap { sessionsByID[$0] }
            let reason: NowNeedsReason? = switch item.owner.needsYou {
            case .question?: .question
            case .missedQuestion?: .missedQuestion
            case .permission?: .permission
            default: nil
            }
            return NowItemInput(id: item.id, notificationID: item.notificationId, title: item.title, status: item.status,
                                source: item.sourceName ?? "", project: item.project, projectSlot: item.projectSlot, computer: session?.computer,
                                computerIcon: item.computerIcon ?? session?.computerIcon,
                                topic: session?.title ?? item.sessionTitle, state: item.owner.state, reason: reason, evidenceAt: item.owner.evidenceAt,
                                startedAt: item.startedAt, expiresAt: nil, steps: item.planSteps, progress: nil,
                                questionID: item.question?.id, roundOutcome: item.roundOutcome, roundNumber: item.roundNumber,
                                quietReason: item.quietWhy, quietSince: item.quietFrom, absence: item.owner.absence)
        }
        let since = summary.sinceYouLooked
        self.init(
            serverTime: summary.serverTime,
            sinceYouLooked: NowSinceInput(since: since.since, finished: since.finished, failed: since.failed,
                                          waitingOnYou: since.waitingOnYou,
                                          stoppedWithoutFinishing: since.stoppedWithoutFinishing),
            recent: summary.recent.map(item),
            // Live questions render from the decision feed, which carries the answer path.
            needsYou: summary.needsYou.filter { $0.owner.needsYou != .question }.map(item),
            waitingOnYou: summary.waitingOnYou.map(item),
            running: summary.running.map(item),
            quiet: summary.quiet.map(item),
            paused: summary.paused.map(item),
            sessions: summary.sessions.sessions.map { row in
                let phase: NowSessionInput.Phase? = switch row.phase {
                case .working?: .working
                case .waiting?: .waiting
                case .idle?: .idle
                case .ended?: .ended
                default: nil
                }
                // The session's own name leads when this phone could open it; tool and project go under it.
                let origin = [row.sourceLabel, row.project].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
                return NowSessionInput(
                    id: row.id,
                    title: row.title ?? origin,
                    computer: row.computer, computerIcon: row.computerIcon, phase: phase, waitingFor: row.waitingFor, lastSeenAt: row.lastSeenAt,
                    workID: row.workId, folded: row.isFoldedIdle, context: row.title == nil || origin.isEmpty ? nil : origin,
                    contextPct: row.contextPct, contextTokens: row.contextTokens, costUsd: row.costUsd, source: row.source)
            })
    }
}

extension NowTone {
    /// The tone's color, from the one state table (`ReloStateStyle`).
    var color: Color {
        switch self {
        case .needsYou: ReloStateStyle.needsYou.color
        case .running: ReloStateStyle.running.color
        case .sessions: ReloHoloTheme.sessionsViolet
        case .runningQuiet: ReloHoloTheme.slate
        case .attention: ReloStateStyle.yourTurn.color
        case .failed: ReloStateStyle.failed.color
        case .done: ReloStateStyle.done.color
        case .secondary: Color.reloSecondaryText
        }
    }
}

// MARK: - Now

/// Since you looked, Needs you, Waiting on you, Running, Quiet, Paused, Sessions, then Today.
/// One rhythm: a small monospaced caption in the section's meaning color, 28pt between sections.
/// Empty sections disappear.
struct CurrentAttentionView: View {
    @Bindable var model: AppModel
    /// The Now lists, as the server put them (see `NowScreenInput`).
    var input: NowScreenInput
    /// The last `/api/now` fetch failed: the cached summary shows as last known.
    var offline = false
    var viewHistory: () -> Void = {}
    @AppStorage(ReloHistoryPreferences.clearedAtKey) private var clearedAt: Double = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Open folds, in memory only: closed again on relaunch.
    @State private var openFolds: Set<String> = []
    /// Failed rows whose panel is open in place (Open, Close). Local only: there is no server dismiss.
    @State private var openPanels: Set<String> = []
    /// The work the owner swiped "End" on, awaiting the confirmation.
    @State private var endTarget: EndWorkTarget?
    /// Questions just answered from here: the card stays a beat on "Sent" after the feed retires it,
    /// then fades, so the answer is seen to land and the page never jumps under the thumb.
    @State private var settling: [PendingCurrentDecision] = []
    /// One space for the work cards, so a card that changes section (Waiting on you → Running) travels there.
    @Namespace private var cardSpace

    /// The live questions, then the ones settling, each once.
    private func requests(_ screen: CurrentInboxPresentation) -> [PendingCurrentDecision] {
        let live = Set(screen.needsMe.map(\.id))
        return screen.needsMe + settling.filter { !live.contains($0.id) }
    }

    private func settle(from old: [PendingCurrentDecision], to new: [PendingCurrentDecision]) {
        let remaining = Set(new.map(\.id))
        let answered = old.filter {
            !remaining.contains($0.id) && model.responseFeedback(for: $0.notificationId)?.phase == .accepted
                && !settling.contains($0)
        }
        guard !answered.isEmpty else { return }
        settling += answered
        let ids = Set(answered.map(\.id))
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.2))
            withAnimation(reduceMotion ? nil : .smooth(duration: 0.45)) { settling.removeAll { ids.contains($0.id) } }
        }
    }

    private func blocks(_ screen: CurrentInboxPresentation) -> [NowBlock] {
        var blocks = NowScreenModel.make(input, isOffline: isOffline, openFolds: openFolds)
        // Live questions come from the decision feed (they carry the answer path): Needs you
        // shows whenever there is one, right after the since line.
        if !requests(screen).isEmpty, !blocks.contains(where: { $0.id == "needs" }) {
            blocks.insert(.needsYou([]), at: blocks.first?.id == "since" ? 1 : 0)
        }
        return blocks
    }

    var body: some View {
        let screen = model.currentPresentation
        let blocks = blocks(screen)
        // Standing by only when nothing is live: no card and no session at work. Idle machines then show in it,
        // so an idle-only sessions section is not drawn twice.
        let allClear = requests(screen).isEmpty && !blocks.contains {
            switch $0 {
            case .needsYou, .waitingOnYou, .running, .parked: true
            case let .sessions(sessions): sessions.active > 0
            case .sinceYouLooked: false
            }
        }
        // A plain stack: a handful of sections of very different heights. Lazily laid out, the
        // sections below the fold were measured only on arrival and the page jumped as they did.
        VStack(alignment: .leading, spacing: 26) {
            ForEach(blocks) { block in
                switch block {
                case let .sinceYouLooked(line, spoken, recent, more):
                    sinceSection(line: line, spoken: spoken, recent: recent, more: more)
                case let .needsYou(rows):
                    needsSection(screen: screen, rows: rows)
                case let .parked(quiet, paused, open):
                    parkedSection(quiet: quiet, paused: paused, open: open)
                case let .waitingOnYou(rows):
                    section("Your turn", count: rows.count, color: ReloStateStyle.yourTurn.color) {
                        ForEach(rows) { row in workCard(row) }
                    }
                case let .running(title, rows):
                    section(title, count: rows.count, color: ReloStateStyle.running.color) {
                        ForEach(rows) { row in workCard(row) }
                    }
                case let .sessions(sessions):
                    if !allClear { sessionsSection(sessions) }
                }
            }
            NowAllClearView(allClear: allClear, machines: StandbyMachine.make(input.sessions, now: input.serverTime),
                            viewHistory: viewHistory)
                .transition(.opacity)
            if model.currentState?.snapshot.metadata?.hasMore == true {
                moreButton("Show more current work", busy: model.currentState?.isLoadingCurrentPage == true) {
                    Task { await model.loadMoreCurrent() }
                }
            }
        }
        // One motion for the page, a spring with no bounce: sections and cards settle in place as the lists
        // change, and a card that changes section travels to its new place. Keyed on the cards too, not only
        // the sections: a card moving between two sections that both stay used to cut.
        .animation(reduceMotion ? nil : .smooth(duration: 0.45), value: requests(screen).map(\.id))
        .animation(reduceMotion ? nil : .smooth(duration: 0.45), value: blocks.flatMap(\.motionKeys))
        .onChange(of: screen.needsMe) { old, new in settle(from: old, to: new) }
        .endWorkConfirmation($endTarget, model: model)
        .alert("Couldn't end the work", isPresented: Binding(
            get: { model.endWorkError != nil && model.selectedNotificationID == nil },
            set: { if !$0 { model.endWorkError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(model.endWorkError ?? "") }
    }

    private var isOffline: Bool { offline || model.currentState?.connection == .offline }

    // MARK: Sections

    private func section<Content: View>(_ title: String, count: Int?, color: Color,
                                        @ViewBuilder content: () -> Content) -> some View {
        // 10 pt from the caption to the first card and between cards (the design's `.sec` rhythm).
        VStack(alignment: .leading, spacing: 10) {
            NowSectionCaption(title: title, count: count, color: color)
            content()
        }
        .transition(.opacity)
    }

    private func toggle(_ key: String) {
        withAnimation(reduceMotion ? nil : .smooth(duration: 0.3)) {
            if openFolds.contains(key) { openFolds.remove(key) } else { openFolds.insert(key) }
        }
    }

    // MARK: Since you looked

    private func sinceSection(line: String?, spoken: String?, recent: [NowRowModel], more: Int) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            NowSectionCaption(title: "Since you looked", count: recent.count + more, color: Color.nowHex(0xEEF1F7))
            if !recent.isEmpty {
                CardGroup {
                    ForEach(Array(recent.enumerated()), id: \.element.id) { index, row in
                        // The open panel is a row's sibling: no hairline between it and the row below.
                        let above = index > 0 ? recent[index - 1] : nil
                        let afterPanel = above.map { $0.card?.ownerState == .failed && openPanels.contains($0.id) } ?? false
                        settledRow(row, icon: nil, divider: index > 0 && !afterPanel)
                    }
                    if more > 0 || openFolds.contains("recent") {
                        let open = openFolds.contains("recent")
                        Button { toggle("recent") } label: {
                            HStack {
                                Text(more > 0 ? "Show \(more) more" : "Show fewer")
                                Spacer(minLength: 0)
                                Text(open ? "Hide" : "Show ›").foregroundStyle(Color.white.opacity(0.42))
                            }
                            .font(.system(size: 12, weight: .semibold)).foregroundStyle(Color.white.opacity(0.6))
                            .padding(.horizontal, 16).frame(minHeight: 44).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityValue(open ? "expanded" : "collapsed")
                        .nowHairline(inset: 14, opacity: 0.08)
                    }
                }
                // Today's sentence ("Since 4:10 PM: 2 finished, 1 failed") is spoken, not shown.
                .accessibilityElement(children: .contain)
                .accessibilityLabel(spoken ?? line ?? "Since you looked")
            }
        }
        .transition(.opacity)
        #if RELO_FLOW_CAPTURE
        .onAppear {
            if ReloCaptureFlags.opensFailedPanels {
                openPanels = Set(recent.filter { $0.card?.ownerState == .failed }.map(\.id))
            }
        }
        #endif
    }

    // MARK: Needs you

    private func needsSection(screen: CurrentInboxPresentation, rows: [NowRowModel]) -> some View {
        let count = (screen.actionableCount ?? screen.needsMe.count) + rows.count
        return section("Needs you", count: count > 0 ? count : nil, color: ReloStateStyle.needsYou.color) {
            ForEach(requests(screen)) { item in requestCard(item).transition(.reloCardArrival) }
            ForEach(rows) { row in needsCard(row) }
            if let error = model.nowDismissError {
                Text(error).font(ReloLayout.cardStatus).foregroundStyle(Color.reloErrorText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if model.currentState?.snapshot.pending?.metadata?.hasMore == true {
                moreButton("Show more requests", busy: model.currentState?.pendingConnection == .connecting) {
                    Task { await model.loadMorePending() }
                }
            }
            if model.currentState?.pendingConnection == .offline {
                Text("Couldn't refresh requests. Saved requests stay visible and are checked again when you reconnect.")
                    .font(ReloLayout.cardStatus).foregroundStyle(Color.reloSecondaryText)
            }
        }
    }

    /// The origin line of a card built from a row model: `source · project › session`.
    private func origin(of card: NowCardModel?, notificationID: String? = nil) -> ReloCardOrigin? {
        card.map { ReloCardOrigin(source: $0.origin.first ?? "", project: $0.origin.dropFirst().first,
                                  projectColor: ReloProjectPalette.color(slot: $0.projectSlot, name: $0.project),
                                  topic: $0.origin.count > 2 ? $0.origin[2] : nil, hasLink: carriesLink(notificationID)) }
    }

    /// Whether the notification behind a card carries a link, from the item this phone holds.
    private func carriesLink(_ notificationID: String?) -> Bool {
        guard let id = notificationID else { return false }
        return (model.items.first { $0.id == id } ?? model.historyItems.first { $0.id == id })?.validatedDestinationURL != nil
    }

    /// A missed question (late answers allowed, never permission) or a permission prompt: header (where it
    /// ran · "Missed"), the question and what it said, footer ("Asked 14:02" · the actions).
    private func needsCard(_ row: NowRowModel) -> some View {
        let style: ReloStateStyle = switch row.reason {
        case .missedQuestion?: .missed
        case .permission?: .permission
        default: .needsYou
        }
        return ReloCard(tint: style.color, rhythm: true) {
            CardHeader(origin: origin(of: row.card, notificationID: row.notificationID), corner: .badge(style))
            CardTitle(row.title, style: .hero).cardGap(above: 9)
            ForEach(row.lines, id: \.self) { line in CardStatusLine(line, lines: 4).cardGap(above: 4) }
            if row.reason == .missedQuestion {
                CardFooter(meta: row.card.map { Text("Asked ") + Text($0.at, style: .time) }) {
                    if let questionID = row.questionID {
                        // Dismisses here; it never opens the notification.
                        CardAction("Dismiss", kind: .quiet) { Task { await model.dismissMissedQuestion(questionID: questionID) } }
                    }
                    if let id = row.notificationID {
                        CardAction("Answer late", kind: .primary) { Task { await model.openNotification(notificationID: id) } }
                    }
                }
                .cardGap(above: 10)
            } else if let footnote = row.footnote {
                CardFooter(meta: Text(footnote)).cardGap(above: 10)
            }
        }
    }

    /// What the decision feed leaves out of a live question: where it was asked. The Now summary lists the same
    /// question as an item (joined on the notification id) with its project, session and computer.
    private func questionContext(_ item: PendingCurrentDecision) -> (origin: ReloCardOrigin, computer: String?, icon: ComputerIcon?) {
        let work = model.nowSummary?.needsYou.first { $0.notificationId == item.notificationId }
        let session = work.flatMap { work in
            model.nowSummary?.sessions.sessions.first { $0.id == work.sessionId || $0.workId == work.id }
        }
        let source = work?.sourceName ?? item.source
        let topic = (session?.title ?? work?.sessionTitle).flatMap { $0.isEmpty || $0 == item.title ? nil : $0 }
        return (ReloCardOrigin(source: source, project: work?.project,
                               projectColor: ReloProjectPalette.color(slot: work?.projectSlot, name: work?.project),
                               topic: topic, hasLink: carriesLink(item.notificationId)),
                session?.computer, work?.computerIcon ?? session?.computerIcon)
    }

    /// A live question: header (where it was asked, "NEEDS YOU · 4:12"), the question, its summary, the answer
    /// buttons, then the footer (the computer, "ASKED 6:42 PM"). The text opens the full request.
    private func requestCard(_ item: PendingCurrentDecision) -> some View {
        let answer = CurrentDecisionPresenter(model: model, decision: item)
        let context = questionContext(item)
        let ink = Color.white.opacity(0.42)
        return ReloCard(tint: ReloStateStyle.needsYou.color, wash: true, rhythm: true) {
            Button {
                Task { await model.openNotification(notificationID: item.notificationId) }
            } label: {
                VStack(alignment: .leading, spacing: 0) {
                    CardHeader(origin: context.origin, corner: answer.phase.corner(deadline: item.interaction.expiresAt))
                    CardTitle(item.title, style: .hero).cardGap(above: 9)
                    if !item.summary.isEmpty, item.summary != item.title {
                        CardStatusLine(item.summary, lines: 4).cardGap(above: 4)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens the full request")
            // A question answered on its own page (free text) has no buttons: no band, the footer follows at 10.
            if !answer.choices.isEmpty || answer.phase.note != nil {
                CurrentDecisionButtons(model: model, decision: item).cardGap(above: 12)
            }
            HStack(alignment: .center, spacing: ReloLayout.inlineGap) {
                if let computer = context.computer {
                    (Text(Image(systemName: (context.icon ?? .laptop).systemImageName)).font(.system(size: 13, weight: .light))
                        + Text("  " + computer).font(.system(size: 11, weight: .medium)))
                        .foregroundColor(ink).lineLimit(1)
                }
                Spacer(minLength: 0)
                (Text("ASKED ") + Text(item.createdAt, style: .time))
                    .font(.system(size: 10.5, design: .monospaced)).tracking(0.3).foregroundColor(ink).lineLimit(1)
            }
            .frame(minHeight: 20)
            .cardGap(above: 10)
        }
    }

    // MARK: Folds

    /// Quiet and Paused share one group and one line: "Quiet 2 · Paused 1   Show ›". Opened, they list compact rows.
    private func parkedSection(quiet: [NowRowModel], paused: [NowRowModel], open: Bool) -> some View {
        let slate = ReloHoloTheme.slate
        var label = Text("")
        if !quiet.isEmpty {
            label = label + Text("Quiet ") + Text("\(quiet.count)").foregroundColor(slate)
        }
        if !quiet.isEmpty, !paused.isEmpty { label = label + Text(" · ") }
        if !paused.isEmpty {
            label = label + Text("Paused ") + Text("\(paused.count)").foregroundColor(slate)
        }
        let spoken = [quiet.isEmpty ? nil : "Quiet, \(quiet.count)", paused.isEmpty ? nil : "Paused, \(paused.count)"]
            .compactMap { $0 }.joined(separator: ", ")
        return CardGroup {
            Button { toggle("parked") } label: {
                HStack(spacing: 6) {
                    Image(systemName: quiet.isEmpty ? "pause.fill" : "moon.fill").font(.system(size: 11)).foregroundStyle(slate)
                        .accessibilityHidden(true)
                    label.font(.system(size: 12, weight: .semibold)).foregroundColor(Color.white.opacity(0.6))
                    Spacer(minLength: 8)
                    Text(open ? "Hide" : "Show ›").font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Color.white.opacity(0.42))
                }
                .padding(.horizontal, 16).frame(minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(spoken)
            .accessibilityValue(open ? "expanded" : "collapsed")
            .accessibilityHint("Shows the items")
            if open {
                ForEach(quiet) { row in settledRow(row, icon: .quiet, divider: true) }
                ForEach(paused) { row in settledRow(row, icon: .paused, divider: true) }
            }
        }
        .transition(.opacity)
    }

    // MARK: Rows

    /// A compact row of Since you looked and the folds: icon, title, "project · computer", the time. A failed row
    /// opens a panel in place (Open, Close); the rest open their details.
    @ViewBuilder
    private func settledRow(_ row: NowRowModel, icon: NowSettledIcon.Kind?, divider: Bool) -> some View {
        let card = row.card
        let state = card?.ownerState
        let outcome: NowSettledIcon.Kind = switch state {
        case .failed?: .failed
        case .done?: .done
        default: .dropped
        }
        let kind = icon ?? outcome
        let project = card.flatMap { $0.project ?? $0.origin.first }
        let note: String? = switch state {
        case .dropped?: "dropped"
        case .leftUnfinished?: "stopped"
        default: nil
        }
        let subline = [project, note, card?.computer].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        let failed = kind == .failed
        let panelOpen = failed && openPanels.contains(row.id)
        let content = HStack(spacing: 12) {
            NowSettledIcon(kind: kind)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title).font(.system(size: 13.5, weight: .medium)).foregroundStyle(Color.nowHex(0xE9ECF2)).lineLimit(1)
                if !subline.isEmpty {
                    Text(subline).font(.system(size: 11)).foregroundStyle(Color.white.opacity(0.42)).lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let at = card?.at {
                Text(at.formatted(Date.FormatStyle().hour(.defaultDigits(amPM: .omitted)).minute()))
                    .font(.system(size: 10.5, weight: .medium, design: .monospaced)).monospacedDigit()
                    .foregroundStyle(Color.white.opacity(0.42))
            }
        }
        .padding(.horizontal, 14).frame(minHeight: 50).contentShape(Rectangle())

        VStack(spacing: 0) {
            if failed {
                Button {
                    withAnimation(reduceMotion ? nil : .smooth(duration: 0.3)) {
                        if panelOpen { openPanels.remove(row.id) } else { openPanels.insert(row.id) }
                    }
                } label: { content }
                    .buttonStyle(.plain)
                    .accessibilityValue(panelOpen ? "expanded" : "collapsed")
            } else if let id = row.notificationID {
                Button { Task { await model.openNotification(notificationID: id) } } label: { content }
                    .buttonStyle(.plain).accessibilityHint("Opens details")
            } else {
                content.accessibilityElement(children: .combine)
            }
            if panelOpen {
                failedPanel(row)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .nowHairline(inset: 52, opacity: 0.08, shown: divider)
    }

    private func failedPanel(_ row: NowRowModel) -> some View {
        let red = ReloStateStyle.failed.color
        return VStack(alignment: .leading, spacing: 10) {
            Text(row.card?.status ?? row.lines.first ?? "It failed.")
                .font(.system(size: 12.5, weight: .medium)).lineSpacing(2).foregroundStyle(Color.white.opacity(0.75))
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                if let id = row.notificationID {
                    NowPanelChip(title: "Open", filled: true) { Task { await model.openNotification(notificationID: id) } }
                }
                NowPanelChip(title: "Close", filled: row.notificationID == nil) {
                    withAnimation(reduceMotion ? nil : .smooth(duration: 0.3)) { _ = openPanels.remove(row.id) }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 10).padding(.horizontal, 12)
        .background(red.opacity(0.09), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(red.opacity(0.32), lineWidth: 0.5))
        .padding(.top, 2).padding(.horizontal, 10).padding(.bottom, 10)
    }

    /// One work card: the shared card History uses too (`ReloWorkCard`).
    @ViewBuilder
    private func workCard(_ row: NowRowModel, surface: ReloCardPlacement = .card) -> some View {
        let card = row.card
        let outcome = card?.ownerState.flatMap { ReloStateStyle.make(state: $0, standing: nil) }
        let color = outcome?.color ?? row.tone.color
        // How it stands: a settled or parked work reads as History says it; the rest by the badge it carries;
        // work with none is simply running.
        let state: ReloStateStyle? = outcome ?? card?.badge.map { badge in
            switch badge {
            case "Your turn": ReloStateStyle.yourTurn
            case "Unconfirmed": ReloStateStyle.unconfirmed
            default: ReloStateStyle.running.labelled(badge)
            }
        } ?? (row.startedAt != nil ? ReloStateStyle.running : nil)
        // The session's name comes from the Sessions list; a session not listed there keeps the name its card carries.
        let topic = card.flatMap { $0.origin.count > 2 ? $0.origin[2] : nil } ?? row.notificationID.flatMap { id in
            (model.historyItems.first { $0.id == id } ?? model.items.first { $0.id == id })
                .flatMap { HistoryRowProjection.row($0, now: model.attentionDate).topic }
        }.flatMap { $0 == row.title ? nil : $0 }
        // A quiet work reads "QUIET 14 MIN": the minutes since it last said anything (4).
        let quiet = card?.ownerState == .stale
        let shownState: ReloStateStyle? = quiet
            ? ReloStateStyle.quiet.labelled("Quiet \(max(1, Int(model.attentionDate.timeIntervalSince(card?.quietSince ?? card?.at ?? model.attentionDate) / 60))) min")
            : state
        let inner = ReloWorkCard(
            origin: card.map { ReloCardOrigin(source: $0.origin.first ?? "", project: $0.origin.dropFirst().first,
                                              projectColor: ReloProjectPalette.color(slot: $0.projectSlot, name: $0.project),
                                              topic: topic, hasLink: carriesLink(row.notificationID)) },
            at: card?.at, title: row.title, summary: outcome != nil ? card?.status : card?.status ?? row.lines.first,
            tint: shownState == .yourTurn ? ReloStateStyle.yourTurn.color : nil, quiet: quiet,
            steps: row.steps, progress: row.progress, progressCaption: card?.caption, color: color, shimmer: row.shimmer,
            state: shownState, facts: [card?.note].compactMap { $0 },
            runningSince: card?.badge == nil && outcome == nil ? row.startedAt : nil, computer: card?.computer,
            computerIcon: card?.computerIcon, surface: surface)
            .modifier(CardTravel(id: surface == .card ? row.id : nil, space: cardSpace))

        if let notificationID = row.notificationID {
            Button { Task { await model.openNotification(notificationID: notificationID) } } label: { inner }
                .buttonStyle(ReloPressStyle())
                .accessibilityElement(children: .combine).accessibilityHint("Opens details")
                .swipeToEnd(enabled: row.endable) { endTarget = EndWorkTarget(id: row.id, title: row.title) }
        } else {
            inner.accessibilityElement(children: .combine)
                .swipeToEnd(enabled: row.endable) { endTarget = EndWorkTarget(id: row.id, title: row.title) }
        }
    }

    // MARK: Sessions

    /// Sessions by machine: one group card per machine (header, then its sessions), 14 pt apart.
    @ViewBuilder
    private func sessionsSection(_ block: NowSessionsBlock) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            NowSectionCaption(title: "Sessions", count: block.active, color: ReloHoloTheme.sessionsViolet)
            ForEach(block.groups) { group in machineCard(group) }
        }
        .transition(.opacity)
    }

    private func machineCard(_ group: NowSessionGroupModel) -> some View {
        let key = "idle:\(group.title)"
        let open = openFolds.contains(key)
        let idleOnly = group.rows.isEmpty
        let hasBody = !idleOnly || (open && !group.idle.isEmpty)
        let header = NowMachineHeader(group: group, bottomLine: hasBody,
                                      trailing: idleOnly && !group.idle.isEmpty ? "\(group.idle.count) idle" : nil, open: open)
        return CardGroup {
            if idleOnly, !group.idle.isEmpty {
                Button { toggle(key) } label: { header }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(group.title), \(group.summary), \(group.idle.count) idle")
                    .accessibilityValue(open ? "expanded" : "collapsed")
            } else {
                header.accessibilityElement(children: .combine)
            }
            ForEach(Array(group.rows.enumerated()), id: \.element.id) { index, row in
                sessionRow(row, divider: index > 0)
            }
            if !idleOnly, !group.idle.isEmpty {
                Button { toggle(key) } label: {
                    HStack {
                        Spacer(minLength: 0)
                        Text("\(group.idle.count) idle \(open ? "⌃" : "›")")
                            .font(.system(size: 11, weight: .semibold)).foregroundStyle(Color.white.opacity(0.42))
                    }
                    .padding(.horizontal, 14).frame(minHeight: 36).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Idle, \(group.idle.count) sessions").accessibilityValue(open ? "expanded" : "collapsed")
                .nowHairline(inset: 44, opacity: 0.07)
            }
            if open {
                ForEach(Array(group.idle.enumerated()), id: \.element.id) { index, row in
                    sessionRow(row, divider: index > 0 || !idleOnly)
                }
            }
        }
        .opacity(idleOnly ? 0.6 : 1)
    }

    /// A session: its harness, its name, a context bar with "62% · $1.84", and its phase as a chip.
    @ViewBuilder
    private func sessionRow(_ row: NowSessionRowModel, divider: Bool) -> some View {
        let working = row.phase == .working
        let content = HStack(spacing: 10) {
            NowHarnessGlyph(source: row.source, size: 11)
                .frame(width: 20, height: 20)
                .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            VStack(alignment: .leading, spacing: 0) {
                Text(row.title).font(.system(size: 13, weight: .medium)).foregroundStyle(Color.nowHex(0xE9ECF2)).lineLimit(1)
                NowContextLine(pct: row.contextPct, cost: row.costUsd, heavy: row.heavyContext, seen: row.lastSeenAt)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            NowPhaseChip(label: row.chip, tint: NowPhaseChip.tint(for: row), working: working, animated: !reduceMotion)
        }
        .padding(.horizontal, 14).frame(minHeight: 52)
        .background { if working { NowWorkSweep(animated: !reduceMotion) } }
        .clipped()
        .contentShape(Rectangle())
        .nowHairline(inset: 44, opacity: 0.07, shown: divider)

        if let notificationID = row.notificationID {
            Button { Task { await model.openNotification(notificationID: notificationID) } } label: { content }
                .buttonStyle(.plain)
                .accessibilityElement(children: .combine).accessibilityHint("Opens details")
        } else {
            content.accessibilityElement(children: .combine)
        }
    }

    private func moreButton(_ title: String, busy: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: ReloLayout.inlineGap) {
                if busy { ProgressView().controlSize(.small) }
                Text(title)
            }
        }
        .buttonStyle(.reloSecondary).disabled(busy)
    }
}

#if RELO_FLOW_CAPTURE
/// Capture only: the preview model has no session controller to verify a question, so it would read "Checking".
@MainActor enum ReloCaptureFlags {
    static var decisionsReady = false
    /// Since you looked with its failed rows' panels open (the C2 design).
    static var opensFailedPanels = false
    /// Every system card of Now's SYSTEM section (C4), with fixture state.
    static var systemCards = false
}
#endif

/// What a request in Needs you offers, from the model: the sender's choices and where the answer stands.
/// The card reads the phase for its header; the buttons read both.
@MainActor
struct CurrentDecisionPresenter {
    let model: AppModel
    let decision: PendingCurrentDecision

    var choices: [ReloDecisionActions.Choice] {
        if decision.interaction.type == .choice, let options = decision.interaction.options { return ReloDecisionActions.Choice.options(options) }
        if let item = model.items.first(where: { $0.id == decision.notificationId }),
           let labelled = BinaryNotificationActionPresentation(
            behavior: InboxPresentationProjection.presentation(for: item).behavior) {
            return ReloDecisionActions.Choice.binary(labelled)
        }
        let kind: InboxInteraction.Kind = switch decision.interaction.type {
        case .approval: .approval
        case .yesNo: .yesNo
        case .text: .text
        case .choice: .choice
        }
        return BinaryNotificationActionPresentation(kind: kind, style: "standard").map(ReloDecisionActions.Choice.binary) ?? []
    }

    var draft: CurrentDecisionDraft? { model.currentDecision(notificationID: decision.notificationId) }

    var phase: ReloDecisionActions.Phase {
        #if RELO_FLOW_CAPTURE
        if ReloCaptureFlags.decisionsReady { return .ready }
        #endif
        let feedback = model.responseFeedback(for: decision.notificationId)
        let availability = draft.map { model.decisionAvailability($0.identity) } ?? .unverified
        if let answer = ReloDecisionActions.Phase.answer(
            feedback, submitting: model.respondingNotificationID == decision.notificationId) {
            if case .failed = answer, !availability.permitsSubmission {} else { return answer }
        }
        return .unavailable(availability)
    }
}

/// Approve/Deny, Yes/No or a choice's options for a request in Needs you, with the sender's own labels:
/// the same answer area as the detail page, so a tap never reflows the card.
private struct CurrentDecisionButtons: View {
    @Bindable var model: AppModel
    let decision: PendingCurrentDecision

    private var presenter: CurrentDecisionPresenter { CurrentDecisionPresenter(model: model, decision: decision) }

    var body: some View {
        ReloDecisionActions(choices: presenter.choices, phase: presenter.phase, style: .card,
                            sent: model.responseFeedback(for: decision.notificationId)?.action,
                            deadline: decision.interaction.expiresAt, momentID: decision.notificationId) { send($0) }
    }

    private func send(_ choice: ReloDecisionActions.Choice) {
        guard let draft = presenter.draft, model.respondingNotificationID == nil else { return }
        Task { await model.respond(to: draft.identity, action: choice.action, optionID: choice.optionID) }
    }
}

// MARK: - Sessions and since-you-looked parts (C3, C2)

private extension Color {
    /// A design-study hex color (0xRRGGBB).
    static func nowHex(_ value: UInt32) -> Color {
        Color(red: Double((value >> 16) & 0xFF) / 255, green: Double((value >> 8) & 0xFF) / 255, blue: Double(value & 0xFF) / 255)
    }
}

private extension View {
    /// A 0.5 pt hairline across the top of a row, inset from the leading edge.
    func nowHairline(inset: CGFloat, opacity: Double, shown: Bool = true) -> some View {
        overlay(alignment: .top) {
            if shown { Rectangle().fill(Color.white.opacity(opacity)).frame(height: 0.5).padding(.leading, inset) }
        }
    }
}

/// The harness's mark in the design's tones (Claude Code warm, the rest cool grey).
private struct NowHarnessGlyph: View {
    let source: String?
    let size: CGFloat

    var body: some View {
        if let source, let logo = SourceLogo(sourceName: source) {
            Image(logo.assetName).renderingMode(.template).resizable().scaledToFit()
                .frame(width: size, height: size)
                .foregroundStyle(logo == .claudeCode ? Color.nowHex(0xE8A07A) : Color.nowHex(0xC9CFDB))
                .accessibilityLabel(logo.name)
        } else {
            Image(systemName: "terminal").font(.system(size: size * 0.9)).foregroundStyle(Color.nowHex(0xC9CFDB))
        }
    }
}

/// A machine: its tile with the status dot, its name and summary, and one chip per harness.
private struct NowMachineHeader: View {
    let group: NowSessionGroupModel
    let bottomLine: Bool
    let trailing: String?
    let open: Bool

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: (group.icon ?? .laptop).systemImageName)
                .font(.system(size: 16, weight: .light)).foregroundStyle(Color.nowHex(0xD3D8E2))
                .frame(width: 30, height: 30)
                .background(Color.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(Color.white.opacity(0.14), lineWidth: 0.5))
                .overlay(alignment: .topTrailing) {
                    Circle().fill(group.dot.map(\.color) ?? Color.white.opacity(0.3)).frame(width: 7, height: 7)
                        .shadow(color: group.dot.map(\.color) ?? .clear, radius: group.dot == nil ? 0 : 3)
                        .offset(x: 2, y: -2)
                }
            VStack(alignment: .leading, spacing: 1) {
                Text(group.title).font(.system(size: 14, weight: .semibold)).foregroundStyle(Color.nowHex(0xF2F4F8)).lineLimit(1)
                Text(group.summary).font(.system(size: 11)).foregroundStyle(Color.white.opacity(0.42)).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            ForEach(group.harnesses) { harness in
                HStack(spacing: 4) {
                    NowHarnessGlyph(source: harness.source, size: 10)
                    Text("\(harness.count)").font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                        .foregroundStyle(Color.nowHex(0xC9CFDB))
                }
                .padding(.horizontal, 7).frame(height: 22)
                .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            }
            if let trailing {
                HStack(spacing: 3) {
                    Text(trailing)
                    Text("›").rotationEffect(.degrees(open ? 90 : 0))
                }
                .font(.system(size: 11, weight: .semibold)).foregroundStyle(Color.white.opacity(0.42))
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .contentShape(Rectangle())
        .overlay(alignment: .bottom) {
            if bottomLine { Rectangle().fill(Color.white.opacity(0.08)).frame(height: 0.5) }
        }
    }
}

/// "62% · $1.84" under a session's name, with a 46 x 3 bar for the context. Amber from 80%.
private struct NowContextLine: View {
    let pct: Int?
    let cost: Double?
    let heavy: Bool
    let seen: Date?

    var body: some View {
        let amber = NowTone.attention.color
        let ink = Color.white.opacity(0.42)
        let cents = cost.flatMap { $0 >= 0 && $0.isFinite ? String(format: "$%.2f", $0) : nil }
        if pct != nil || cents != nil || seen != nil {
            HStack(spacing: 6) {
                if let pct {
                    let share = Double(min(max(pct, 0), 100)) / 100
                    RoundedRectangle(cornerRadius: 2).fill(Color.white.opacity(0.1)).frame(width: 46, height: 3)
                        .overlay(alignment: .leading) {
                            RoundedRectangle(cornerRadius: 2).fill(heavy ? amber : ReloHoloTheme.slate)
                                .frame(width: 46 * share, height: 3)
                        }
                        .accessibilityHidden(true)
                }
                text(amber: amber).font(.system(size: 10, weight: .medium, design: .monospaced)).foregroundColor(ink).lineLimit(1)
            }
            .padding(.top, 4)
        }
    }

    private func text(amber: Color) -> Text {
        let cents = cost.flatMap { $0 >= 0 && $0.isFinite ? String(format: "$%.2f", $0) : nil }
        var parts: [Text] = []
        if let pct { parts.append(Text("\(min(max(pct, 0), 100))%").foregroundColor(heavy ? amber : Color.white.opacity(0.42))) }
        if let cents { parts.append(Text(cents)) }
        if pct == nil, cents == nil, let seen { parts.append(Text(seen, style: .time)) }
        guard var result = parts.first else { return Text("") }
        for part in parts.dropFirst() { result = result + Text(" · ") + part }
        return result
    }
}

/// A session's phase: a tinted capsule, with a three-bar waveform while it works.
private struct NowPhaseChip: View {
    let label: String
    let tint: Color
    let working: Bool
    let animated: Bool

    static func tint(for row: NowSessionRowModel) -> Color {
        switch row.phase {
        case .working?: ReloHoloTheme.sessionsViolet
        case .waiting?: row.tone.color
        default: ReloHoloTheme.slate
        }
    }

    var body: some View {
        HStack(spacing: 5) {
            if working { NowWave(color: tint, animated: animated) }
            Text(label.uppercased()).font(.system(size: 10, weight: .semibold, design: .monospaced)).lineLimit(1)
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 8).frame(height: 20)
        .background(tint.opacity(0.15), in: Capsule())
        .overlay(Capsule().strokeBorder(tint.opacity(0.3), lineWidth: 0.75))
        .fixedSize()
    }
}

/// Three bars breathing between 3 and 9 pt (`wv`, 0.9 s, 0.15 s apart). Still, under Reduce Motion.
private struct NowWave: View {
    let color: Color
    let animated: Bool

    var body: some View {
        // The shared clock: capped, and paused off screen, in Low Power Mode and when the device is hot.
        ReloMotionClock(live: animated, framesPerSecond: 30, still: 0) { t in
            HStack(alignment: .bottom, spacing: 1.5) {
                ForEach(0..<3, id: \.self) { index in
                    let level = animated ? 0.5 - 0.5 * cos(2 * .pi * (t - Double(index) * 0.15) / 0.9)
                        : [0.3, 1, 0.6][index]
                    RoundedRectangle(cornerRadius: 1).fill(color).frame(width: 2, height: 3 + 6 * level)
                }
            }
            .frame(height: 9, alignment: .bottom)
        }
        .accessibilityHidden(true)
    }
}

/// A violet light that sweeps across a working row every 3.2 s (`sweep`), at rest from 70% of the cycle.
private struct NowWorkSweep: View {
    let animated: Bool

    var body: some View {
        if animated {
            ReloMotionClock(framesPerSecond: 30, still: 0) { time in
                GeometryReader { geo in
                    let cycle = time.truncatingRemainder(dividingBy: 3.2) / 3.2
                    let eased: Double = {
                        guard cycle < 0.7 else { return 1 }
                        let u = cycle / 0.7
                        return u < 0.5 ? 2 * u * u : 1 - pow(-2 * u + 2, 2) / 2
                    }()
                    LinearGradient(colors: [ReloHoloTheme.sessionsViolet.opacity(0), ReloHoloTheme.sessionsViolet.opacity(0.14),
                                            ReloHoloTheme.sessionsViolet.opacity(0)], startPoint: .leading, endPoint: .trailing)
                        .frame(width: geo.size.width * 0.3)
                        .offset(x: geo.size.width * (-0.3 + 1.5 * eased))
                }
            }
            .allowsHitTesting(false).accessibilityHidden(true)
        }
    }
}

/// A 26 pt circle with a 12 pt stroke glyph: how a settled or parked item ended.
private struct NowSettledIcon: View {
    enum Kind { case done, failed, dropped, quiet, paused }
    let kind: Kind
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shaken = false

    private var tint: Color {
        switch kind {
        case .done: ReloStateStyle.done.color
        case .failed: ReloStateStyle.failed.color
        case .dropped: NowTone.attention.color
        case .quiet, .paused: ReloHoloTheme.slate
        }
    }

    var body: some View {
        ZStack {
            Circle().fill(tint.opacity(0.15))
            switch kind {
            case .done: NowGlyph(shape: .check).stroke(tint, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round)).frame(width: 12, height: 12)
            case .failed: NowGlyph(shape: .cross).stroke(tint, style: StrokeStyle(lineWidth: 2, lineCap: .round)).frame(width: 12, height: 12)
            case .dropped: NowGlyph(shape: .dash).stroke(tint, style: StrokeStyle(lineWidth: 2, lineCap: .round)).frame(width: 12, height: 12)
            case .quiet: Image(systemName: "moon.fill").font(.system(size: 12)).foregroundStyle(tint)
            case .paused: Image(systemName: "pause.fill").font(.system(size: 11)).foregroundStyle(tint)
            }
        }
        .frame(width: 26, height: 26)
        .keyframeAnimator(initialValue: 0.0, trigger: shaken) { view, x in view.offset(x: x) } keyframes: { _ in
            KeyframeTrack {
                CubicKeyframe(-3, duration: 0.1)
                CubicKeyframe(3, duration: 0.1)
                CubicKeyframe(-1.5, duration: 0.1)
                CubicKeyframe(0, duration: 0.2)
            }
        }
        .task {
            // The failed icon shakes once, 0.6 s after it appears.
            guard kind == .failed, !reduceMotion else { return }
            try? await Task.sleep(for: .milliseconds(600))
            shaken = true
        }
        .accessibilityHidden(true)
    }
}

private struct NowGlyph: Shape {
    enum Kind { case check, cross, dash }
    let shape: Kind

    func path(in rect: CGRect) -> Path {
        let k = rect.width / 12
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + x * k, y: rect.minY + y * k) }
        var path = Path()
        switch shape {
        case .check:
            path.move(to: point(2.5, 6.2)); path.addLine(to: point(5, 8.6)); path.addLine(to: point(9.5, 3.6))
        case .cross:
            path.move(to: point(3, 3)); path.addLine(to: point(9, 9))
            path.move(to: point(9, 3)); path.addLine(to: point(3, 9))
        case .dash:
            path.move(to: point(3, 6)); path.addLine(to: point(9, 6))
        }
        return path
    }
}

/// Open and Close under a failed row: 34 pt capsules; Close is the transparent one.
private struct NowPanelChip: View {
    let title: String
    let filled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Color.nowHex(0xF2F4F8))
                .padding(.horizontal, 14).frame(height: 34)
                .background(Color.white.opacity(filled ? 0.1 : 0), in: Capsule())
                .overlay(Capsule().strokeBorder(Color.white.opacity(0.14), lineWidth: 0.5))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}
