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
    /// Set on settled and parked work (Since you looked, Quiet, Paused): the badge then reads and colors
    /// as on History and the detail page (`ReloStateStyle`).
    var ownerState: NowOwnerState? = nil
}

enum NowFold: String, Sendable { case quiet, paused, idle }

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
    /// "62% context · $4.10"; shown only when the owner opted in.
    var usage: String? = nil
    /// Context at 80% or more reads in the attention tone.
    var heavyContext = false
}

struct NowSessionGroupModel: Equatable, Identifiable, Sendable {
    var id: String { title }
    var title: String
    /// The group's computer icon: the first of its sessions that names one.
    var icon: ComputerIcon? = nil
    var rows: [NowSessionRowModel]
    var idle: [NowSessionRowModel]
}

struct NowSessionsBlock: Equatable, Sendable {
    var working: Int
    var groups: [NowSessionGroupModel]
}

enum NowBlock: Equatable, Identifiable, Sendable {
    case sinceYouLooked(line: String?, accessibility: String?, recent: [NowRowModel], more: Int)
    case needsYou([NowRowModel])
    case fold(NowFold, count: Int, rows: [NowRowModel], open: Bool)
    case waitingOnYou([NowRowModel])
    case running(title: String, rows: [NowRowModel])
    case sessions(NowSessionsBlock)

    var id: String {
        switch self {
        case .sinceYouLooked: "since"
        case .needsYou: "needs"
        case let .fold(fold, _, _, _): "fold-\(fold.rawValue)"
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
        case let .needsYou(rows), let .waitingOnYou(rows), let .running(_, rows), let .fold(_, _, rows, _): rows
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
            let shown = open ? recent : Array(recent.prefix(3))
            // A quiet stretch says nothing here: the deck's "Live · synced" already says the
            // screen is current, so "Nothing new since…" only repeated it.
            if line != nil || !shown.isEmpty {
                blocks.append(.sinceYouLooked(line: line?.text, accessibility: line?.spoken,
                                              recent: shown.map { recentRow($0, locale: locale) },
                                              more: recent.count - shown.count))
            }
        }
        let quiet = unique(input.quiet)
        if !quiet.isEmpty {
            blocks.append(.fold(.quiet, count: quiet.count, rows: quiet.map { quietRow($0, now: now, locale: locale) },
                                open: openFolds.contains(NowFold.quiet.rawValue)))
        }
        let paused = unique(input.paused)
        if !paused.isEmpty {
            blocks.append(.fold(.paused, count: paused.count, rows: paused.map { pausedRow($0, locale: locale) },
                                open: openFolds.contains(NowFold.paused.rawValue)))
        }
        if !input.sessions.isEmpty {
            let work = input.needsYou + input.waitingOnYou + input.running
            blocks.append(.sessions(sessionsBlock(input.sessions, work: work, now: now)))
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
                            computerIcon: item.computerIcon)
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

    static func sessionsBlock(_ sessions: [NowSessionInput], work: [NowItemInput], now: Date) -> NowSessionsBlock {
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
            case .waiting: (session.waitingFor == "input" ? "Needs your input" : "Your turn", .attention)
            case .idle: ("Idle", .secondary)
            case .ended: ("Ended", .secondary)
            case nil: ("Last seen \(relative(session.lastSeenAt, now: now))", .secondary)
            }
            let linked = session.workID.flatMap { workByID[$0] }
            return NowSessionRowModel(id: session.id, title: session.title, workTitle: linked?.title, chip: chip,
                                      tone: tone, notificationID: linked?.notificationID, context: session.context,
                                      lastSeenAt: session.phase == nil ? nil : session.lastSeenAt,
                                      usage: SessionUsage.line(contextPct: session.contextPct, contextTokens: session.contextTokens, costUsd: session.costUsd),
                                      heavyContext: SessionUsage.isHeavy(contextPct: session.contextPct))
        }
        let groups = order.map { key in
            let members = byComputer[key] ?? []
            return NowSessionGroupModel(title: key, icon: members.lazy.compactMap(\.computerIcon).first, rows: members.filter { !$0.folded }.map(row),
                                        idle: members.filter(\.folded).map(row))
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
                                source: item.sourceName ?? "", project: item.project, computer: session?.computer,
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
                    contextPct: row.contextPct, contextTokens: row.contextTokens, costUsd: row.costUsd)
            })
    }
}

extension NowTone {
    /// The tone's color, from the one state table (`ReloStateStyle`).
    var color: Color {
        switch self {
        case .needsYou: ReloStateStyle.needsYou.color
        case .running, .sessions: ReloStateStyle.running.color
        case .runningQuiet: ReloStateStyle.running.color.opacity(0.7)
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
    @AppStorage(ReloSessionUsagePreferences.showKey) private var showsUsage = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Open folds, in memory only: closed again on relaunch.
    @State private var openFolds: Set<String> = []
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
        let allClear = requests(screen).isEmpty && !blocks.contains {
            switch $0 {
            case .needsYou, .waitingOnYou, .running, .fold: true
            case .sinceYouLooked, .sessions: false
            }
        }
        // A plain stack: a handful of sections of very different heights. Lazily laid out, the
        // sections below the fold were measured only on arrival and the page jumped as they did.
        VStack(alignment: .leading, spacing: 28) {
            // Offline is told once, by the deck's sync line ("OFFLINE · AS OF …"), not here too.
            persistenceWarning
            ForEach(blocks) { block in
                switch block {
                case let .sinceYouLooked(line, spoken, recent, more):
                    sinceSection(line: line, spoken: spoken, recent: recent, more: more)
                case let .needsYou(rows):
                    needsSection(screen: screen, rows: rows)
                case let .fold(fold, count, rows, open):
                    foldSection(fold, count: count, rows: rows, open: open)
                case let .waitingOnYou(rows):
                    section("Waiting on you", count: rows.count, color: ReloStateStyle.yourTurn.color) {
                        ForEach(rows) { row in workCard(row) }
                    }
                case let .running(title, rows):
                    section(title, count: rows.count, color: ReloStateStyle.running.color) {
                        ForEach(rows) { row in workCard(row) }
                    }
                case let .sessions(sessions):
                    sessionsSection(sessions)
                }
            }
            NowAllClearView(allClear: allClear, viewHistory: viewHistory)
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

    // MARK: Persistence

    @ViewBuilder
    private var persistenceWarning: some View {
        if model.currentState?.persistence == .unavailable {
            ReloCard(tint: .reloWarning) {
                CardFooter(meta: Text("This iPhone couldn't save current work. Unlock it and retry; fetched requests can still be reviewed.")
                    .foregroundColor(.reloErrorText)) {
                    CardAction("Retry saving", kind: .primary) { model.retryCurrentStorage() }
                }
            }
        }
    }

    private var isOffline: Bool { offline || model.currentState?.connection == .offline }

    // MARK: Sections

    private func section<Content: View>(_ title: String, count: Int?, color: Color,
                                        @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: ReloLayout.itemSpacing) {
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
        VStack(alignment: .leading, spacing: ReloLayout.itemSpacing) {
            if let line {
                Text(line)
                    .font(.subheadline.weight(.medium))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel(spoken ?? line)
            }
            if !recent.isEmpty {
                CardGroup {
                    ForEach(Array(recent.enumerated()), id: \.element.id) { index, row in
                        foldedRow(row, divider: index > 0)
                    }
                    if more > 0 || openFolds.contains("recent") {
                        foldLine(label: more > 0 ? "Show \(more) more" : "Show fewer", color: .reloInteractive,
                                 open: openFolds.contains("recent"), accessibility: nil) { toggle("recent") }
                            .cardDivider()
                    }
                }
            }
        }
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
    private func origin(of card: NowCardModel?) -> ReloCardOrigin? {
        card.map { ReloCardOrigin(source: $0.origin.first ?? "", project: $0.origin.dropFirst().first,
                                  topic: $0.origin.count > 2 ? $0.origin[2] : nil) }
    }

    /// A missed question (late answers allowed, never permission) or a permission prompt: header (where it
    /// ran · "Missed"), the question and what it said, footer ("Asked 14:02" · the actions).
    private func needsCard(_ row: NowRowModel) -> some View {
        let style: ReloStateStyle = switch row.reason {
        case .missedQuestion?: .missed
        case .permission?: .permission
        default: .needsYou
        }
        return ReloCard(tint: style.color) {
            CardHeader(origin: origin(of: row.card), corner: .badge(style))
            CardTitle(row.title, style: .hero)
            ForEach(row.lines, id: \.self) { line in CardStatusLine(line, lines: 4) }
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
            } else if let footnote = row.footnote {
                CardFooter(meta: Text(footnote))
            }
        }
    }

    /// A live question: header (source, the countdown or the send phase), the question, its summary, then the
    /// answer buttons as the footer. The text opens the full request.
    private func requestCard(_ item: PendingCurrentDecision) -> some View {
        let answer = CurrentDecisionPresenter(model: model, decision: item)
        return ReloCard(tint: ReloStateStyle.needsYou.color) {
            Button {
                Task { await model.openNotification(notificationID: item.notificationId) }
            } label: {
                VStack(alignment: .leading, spacing: ReloLayout.cardGap) {
                    CardHeader(origin: ReloCardOrigin(source: item.source),
                               corner: answer.phase.corner(deadline: item.interaction.expiresAt))
                    CardTitle(item.title, style: .hero)
                    if !item.summary.isEmpty, item.summary != item.title { CardStatusLine(item.summary, color: .primary, lines: 4) }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens the full request")
            CurrentDecisionButtons(model: model, decision: item)
        }
    }

    // MARK: Folds

    private func foldTitle(_ fold: NowFold) -> String {
        switch fold {
        case .quiet: "Quiet"
        case .paused: "Paused"
        case .idle: "Idle"
        }
    }

    private func foldSection(_ fold: NowFold, count: Int, rows: [NowRowModel], open: Bool) -> some View {
        let title = foldTitle(fold)
        let color = Color.reloSecondaryText
        return CardGroup {
            foldLine(label: "\(title) (\(count))", color: color, open: open,
                     accessibility: "\(title), \(count) \(count == 1 ? "item" : "items")") { toggle(fold.rawValue) }
            if open {
                ForEach(rows) { row in foldedRow(row, divider: true) }
            }
        }
        .transition(.opacity)
    }

    /// One fold line; a button with its count and state for VoiceOver.
    private func foldLine(label: String, color: Color, open: Bool, accessibility: String?,
                          action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: ReloLayout.inlineGap) {
                Text(label).font(ReloLayout.cardStatus.weight(.medium)).foregroundStyle(color)
                Spacer(minLength: ReloLayout.inlineGap)
                Image(systemName: open ? "chevron.up" : "chevron.down")
                    .font(ReloLayout.cardMeta.weight(.semibold)).foregroundStyle(color)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, ReloLayout.cardInset).padding(.vertical, ReloLayout.rowInset).frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibility ?? label)
        .accessibilityValue(open ? "expanded" : "collapsed")
        .accessibilityHint("Shows the items")
    }

    // MARK: Rows

    /// A row inside a grouped card (Since you looked, folds): the shared work card, unframed.
    @ViewBuilder
    private func foldedRow(_ row: NowRowModel, divider: Bool) -> some View {
        workCard(row, surface: .row).cardDivider(divider)
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
        let inner = ReloWorkCard(
            origin: card.map { ReloCardOrigin(source: $0.origin.first ?? "", project: $0.origin.dropFirst().first,
                                              projectColor: ReloStateStyle.running.color, topic: topic) },
            at: card?.at, title: row.title, summary: outcome != nil ? card?.status : card?.status ?? row.lines.first,
            steps: row.steps, progress: row.progress, progressCaption: card?.caption, color: color, shimmer: row.shimmer,
            state: state, facts: [card?.note].compactMap { $0 },
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

    @ViewBuilder
    private func sessionsSection(_ block: NowSessionsBlock) -> some View {
        section("Sessions", count: block.working, color: ReloStateStyle.running.color) {
            ForEach(block.groups) { group in
                VStack(alignment: .leading, spacing: ReloLayout.inlineGap) {
                    HStack(spacing: 5) {
                        ComputerMark(icon: group.icon, tint: Color.reloSecondaryText).imageScale(.small)
                        Text(group.title)
                    }
                    .reloEyebrow()
                    .foregroundStyle(Color.reloSecondaryText)
                    CardGroup {
                        ForEach(Array(group.rows.enumerated()), id: \.element.id) { index, row in
                            sessionRow(row, divider: index > 0)
                        }
                        if !group.idle.isEmpty {
                            let key = "idle:\(group.title)"
                            let open = openFolds.contains(key)
                            foldLine(label: open ? "Hide idle" : "Idle (\(group.idle.count))", color: Color.reloSecondaryText,
                                     open: open, accessibility: "Idle, \(group.idle.count) sessions") { toggle(key) }
                                .cardDivider(!group.rows.isEmpty)
                            if open {
                                ForEach(group.idle) { row in sessionRow(row, divider: true) }
                            }
                        }
                    }
                }
            }
        }
    }

    /// A session in two rows: header (tool as its logo, project, its name · "● Working"), then a footer line
    /// (the work it holds and, if the owner opted in, its usage · when it was last seen). The computer is the
    /// group's heading.
    @ViewBuilder
    private func sessionRow(_ row: NowSessionRowModel, divider: Bool) -> some View {
        let standing = ReloStateStyle(label: row.chip, color: row.tone.color, symbol: "circle.fill")
        let corner: CardCorner = .badge(standing)
        let usage = showsUsage ? row.usage : nil
        let content = HStack(alignment: .center, spacing: ReloLayout.itemSpacing) {
            VStack(alignment: .leading, spacing: ReloLayout.cardGap) {
                if let context = row.context {
                    CardHeader(origin: sessionOrigin(context, name: row.title), corner: corner, live: row.tone == .running)
                    if row.workTitle != nil || usage != nil || row.lastSeenAt != nil {
                        sessionLine(title: row.workTitle, usage: usage, heavy: row.heavyContext, seen: row.lastSeenAt)
                    }
                } else {
                    HStack(alignment: .firstTextBaseline, spacing: ReloLayout.inlineGap) {
                        Text(row.title).font(ReloLayout.cardTitle).foregroundStyle(.primary).lineLimit(2)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        CardHeader(origin: nil, corner: corner, live: row.tone == .running)
                            .fixedSize()
                    }
                    if row.workTitle.map({ $0 != row.title }) == true || usage != nil || row.lastSeenAt != nil {
                        sessionLine(title: row.workTitle.flatMap { $0 == row.title ? nil : $0 }, usage: usage,
                                    heavy: row.heavyContext, seen: row.lastSeenAt)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if row.notificationID != nil { ReloChevron() }
        }
        .padding(.horizontal, ReloLayout.cardInset).padding(.vertical, ReloLayout.rowInset)
        .frame(minHeight: ReloLayout.rowMinHeight)
        .contentShape(Rectangle())
        .cardDivider(divider)

        if let notificationID = row.notificationID {
            Button { Task { await model.openNotification(notificationID: notificationID) } } label: { content }
                .buttonStyle(.plain)
                .accessibilityElement(children: .combine).accessibilityHint("Opens details")
        } else {
            content.accessibilityElement(children: .combine)
        }
    }

    /// The work a session holds, its usage trailing on the same line.
    private func sessionLine(title: String?, usage: String?, heavy: Bool, seen: Date?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: ReloLayout.inlineGap) {
            if let title { Text(title).font(ReloLayout.cardTitle).foregroundStyle(.primary).lineLimit(2) }
            Spacer(minLength: 0)
            if let usage {
                Text(usage).font(ReloLayout.cardMeta).monospacedDigit()
                    .foregroundStyle(heavy ? NowTone.attention.color : Color.reloSecondaryText).lineLimit(1).fixedSize()
            }
            if let seen {
                Text(seen, style: .time).font(ReloLayout.cardMeta).monospacedDigit()
                    .foregroundStyle(Color.reloSecondaryText).lineLimit(1).fixedSize()
            }
        }
    }

    /// "Claude Code · relo" as the tool's logo, the project and the session's own name.
    private func sessionOrigin(_ context: String, name: String) -> ReloCardOrigin {
        let parts = context.components(separatedBy: " · ")
        return ReloCardOrigin(source: parts.first ?? context, project: parts.count > 1 ? parts.dropFirst().joined(separator: " · ") : nil,
                              projectColor: .reloSecondaryText, topic: name)
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
