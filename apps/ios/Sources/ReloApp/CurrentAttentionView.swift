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
    /// nil: hooks off, only "last seen".
    var phase: Phase?
    var waitingFor: String?
    var lastSeenAt: Date
    var workID: String?
    var folded: Bool
    /// Tool and project ("Claude Code · relo") under the title when the session has a name of its own.
    var context: String? = nil
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
}

enum NowFold: String, Sendable { case waitingOnYou, quiet, paused, idle }

struct NowSessionRowModel: Equatable, Identifiable, Sendable {
    var id: String
    var title: String
    var workTitle: String?
    var chip: String
    var tone: NowTone
    var notificationID: String?
    var context: String? = nil
}

struct NowSessionGroupModel: Equatable, Identifiable, Sendable {
    var id: String { title }
    var title: String
    var rows: [NowSessionRowModel]
    var idle: [NowSessionRowModel]
}

struct NowSessionsBlock: Equatable, Sendable {
    var working: Int
    var groups: [NowSessionGroupModel]
}

enum NowBlock: Equatable, Identifiable, Sendable {
    case sinceYouLooked(line: String, accessibility: String, muted: Bool, recent: [NowRowModel], more: Int)
    case needsYou([NowRowModel])
    case fold(NowFold, count: Int, rows: [NowRowModel], open: Bool)
    case running(title: String, rows: [NowRowModel])
    case sessions(NowSessionsBlock)

    var id: String {
        switch self {
        case .sinceYouLooked: "since"
        case .needsYou: "needs"
        case let .fold(fold, _, _, _): "fold-\(fold.rawValue)"
        case .running: "running"
        case .sessions: "sessions"
        }
    }
}

enum NowScreenModel {
    static let defaultWindow: TimeInterval = 8 * 3_600

    static func make(_ input: NowScreenInput, isOffline: Bool, openFolds: Set<String>,
                     calendar: Calendar = .current, locale: Locale = .current) -> [NowBlock] {
        var blocks: [NowBlock] = []
        var seen = Set<String>()
        func unique(_ items: [NowItemInput]) -> [NowItemInput] {
            items.filter { seen.insert($0.id).inserted }
        }
        let now = input.serverTime
        if let since = input.sinceYouLooked {
            let line = sinceLine(since, serverTime: now, calendar: calendar, locale: locale)
            let recent = unique(input.recent)
            let open = openFolds.contains("recent")
            let shown = open ? recent : Array(recent.prefix(3))
            blocks.append(.sinceYouLooked(line: line.text, accessibility: line.spoken, muted: line.muted,
                                          recent: shown.map { recentRow($0, locale: locale) },
                                          more: recent.count - shown.count))
        }
        let needs = unique(input.needsYou)
        if !needs.isEmpty { blocks.append(.needsYou(needs.map { needsRow($0, locale: locale) })) }
        let waiting = unique(input.waitingOnYou)
        if !waiting.isEmpty {
            blocks.append(.fold(.waitingOnYou, count: waiting.count,
                                rows: waiting.map { waitingRow($0, locale: locale) },
                                open: openFolds.contains(NowFold.waitingOnYou.rawValue)))
        }
        let running = unique(input.running)
        if !running.isEmpty {
            blocks.append(.running(title: isOffline ? "Last known" : "Running",
                                   rows: running.map { runningRow($0, now: now, isOffline: isOffline) }))
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

    struct SinceLine: Equatable { var text: String; var spoken: String; var muted: Bool }

    static func sinceLine(_ since: NowSinceInput, serverTime: Date, calendar: Calendar = .current,
                          locale: Locale = .current) -> SinceLine {
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
        if parts.isEmpty {
            let text = isDefault ? "Nothing new in the last 8 hours." : "Nothing new \(lead.prefix(1).lowercased())\(lead.dropFirst())."
            return SinceLine(text: text, spoken: text, muted: true)
        }
        let list = parts.joined(separator: ", ")
        return SinceLine(text: "\(lead): \(list)", spoken: "\(lead), \(list)", muted: false)
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
                           lines: [line, origin(item)].filter { !$0.isEmpty })
    }

    static func needsRow(_ item: NowItemInput, locale: Locale = .current) -> NowRowModel {
        switch item.reason ?? .question {
        case .missedQuestion:
            let chip = item.expiresAt.map { "MISSED \(clock($0, locale: locale))" } ?? "MISSED"
            return NowRowModel(id: item.id, notificationID: item.notificationID, title: item.title, chip: chip,
                               tone: .needsYou, lines: [item.status, origin(item)].compactMap { $0 }.filter { !$0.isEmpty },
                               footnote: "Late answers reach the session marked late. An approval here is not permission: the session must ask again.",
                               reason: .missedQuestion, questionID: item.questionID)
        case .permission:
            let computer = item.computer ?? "your computer"
            return NowRowModel(id: item.id, notificationID: item.notificationID, title: item.title, chip: "PERMISSION",
                               tone: .needsYou,
                               lines: ["\(item.source) is waiting for a permission prompt on \(computer)."],
                               footnote: "Answer it on your computer.", reason: .permission)
        case .question:
            return NowRowModel(id: item.id, notificationID: item.notificationID, title: item.title, chip: nil,
                               tone: .needsYou, lines: [item.status, origin(item)].compactMap { $0 }, reason: .question)
        }
    }

    static func waitingRow(_ item: NowItemInput, locale: Locale = .current) -> NowRowModel {
        NowRowModel(id: item.id, notificationID: item.notificationID, title: item.title, chip: nil, tone: .attention,
                    lines: ["Your turn · since \(clock(item.evidenceAt, locale: locale))", origin(item)].filter { !$0.isEmpty })
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
                           shimmer: item.state == .moving && !isOffline, startedAt: item.startedAt,
                           steps: item.steps, progress: item.progress)
    }

    static func quietRow(_ item: NowItemInput, now: Date, locale: Locale = .current) -> NowRowModel {
        let line: String = switch item.state {
        case .stoppedResponding:
            "Stopped responding at \(item.steps?.current ?? item.status ?? "its last step"), last seen \(clock(item.evidenceAt, locale: locale))"
        case .noSignal: "No signal since \(clock(item.evidenceAt, locale: locale))"
        default: "Quiet · updated \(relative(item.evidenceAt, now: now))"
        }
        return NowRowModel(id: item.id, notificationID: item.notificationID, title: item.title, chip: nil, tone: .secondary,
                           lines: [line, origin(item)].filter { !$0.isEmpty })
    }

    static func pausedRow(_ item: NowItemInput, locale: Locale = .current) -> NowRowModel {
        NowRowModel(id: item.id, notificationID: item.notificationID, title: item.title, chip: nil, tone: .secondary,
                    lines: ["Paused · \(item.status ?? "")", "paused \(clock(item.evidenceAt, locale: locale))", origin(item)]
                        .filter { !$0.isEmpty && $0 != "Paused · " })
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
            case .working: ("working", .running)
            case .waiting: (session.waitingFor == "input" ? "needs your input" : "your turn", .attention)
            case .idle: ("idle", .secondary)
            case .ended: ("ended", .secondary)
            case nil: ("last seen \(relative(session.lastSeenAt, now: now))", .secondary)
            }
            let linked = session.workID.flatMap { workByID[$0] }
            return NowSessionRowModel(id: session.id, title: session.title, workTitle: linked?.title, chip: chip,
                                      tone: tone, notificationID: linked?.notificationID, context: session.context)
        }
        let groups = order.map { key in
            let members = byComputer[key] ?? []
            return NowSessionGroupModel(title: key, rows: members.filter { !$0.folded }.map(row),
                                        idle: members.filter(\.folded).map(row))
        }
        return NowSessionsBlock(working: sessions.filter { $0.phase == .working }.count, groups: groups)
    }
}

extension NowScreenInput {
    /// The server's Now summary (`GET /api/now`), read as is.
    init(summary: NowSummary) {
        func item(_ item: NowItem) -> NowItemInput {
            let reason: NowNeedsReason? = switch item.owner.needsYou {
            case .question?: .question
            case .missedQuestion?: .missedQuestion
            case .permission?: .permission
            default: nil
            }
            return NowItemInput(id: item.id, notificationID: item.notificationId, title: item.title, status: item.status,
                                source: item.sourceName ?? "", project: item.project, computer: nil,
                                state: item.owner.state, reason: reason, evidenceAt: item.owner.evidenceAt,
                                startedAt: item.startedAt, expiresAt: nil, steps: item.steps, progress: nil,
                                questionID: item.question?.id)
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
                    computer: row.computer, phase: phase, waitingFor: row.waitingFor, lastSeenAt: row.lastSeenAt,
                    workID: row.workId, folded: row.isFoldedIdle, context: row.title == nil || origin.isEmpty ? nil : origin)
            })
    }
}

extension NowTone {
    var color: Color {
        switch self {
        case .needsYou: ReloHoloTheme.color(.needsYou)
        case .running: ReloHoloTheme.color(.running)
        case .runningQuiet: ReloHoloTheme.color(.running).opacity(0.7)
        case .attention: ReloHoloTheme.color(.attention)
        case .failed: ReloHoloTheme.color(.failed)
        case .done: ReloHoloTheme.color(.done)
        case .sessions: ReloHoloTheme.sessions
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

    private func blocks(_ screen: CurrentInboxPresentation) -> [NowBlock] {
        var blocks = NowScreenModel.make(input, isOffline: isOffline, openFolds: openFolds)
        // Live questions come from the decision feed (they carry the answer path): Needs you
        // shows whenever there is one, right after the since line.
        if !screen.needsMe.isEmpty, !blocks.contains(where: { $0.id == "needs" }) {
            blocks.insert(.needsYou([]), at: blocks.first?.id == "since" ? 1 : 0)
        }
        return blocks
    }

    var body: some View {
        let screen = model.currentPresentation
        let blocks = blocks(screen)
        let allClear = screen.needsMe.isEmpty && !blocks.contains {
            switch $0 {
            case .needsYou, .running, .fold: true
            case .sinceYouLooked, .sessions: false
            }
        }
        let activity = todayActivity
        // A plain stack: a handful of sections of very different heights. Lazily laid out, the
        // sections below the fold were measured only on arrival and the page jumped as they did.
        VStack(alignment: .leading, spacing: 28) {
            persistenceWarning
            if isOffline {
                Label("Offline · showing Now as of \(input.serverTime.formatted(Date.FormatStyle(time: .shortened)))",
                      systemImage: "wifi.slash")
                    .font(.footnote.weight(.medium)).foregroundStyle(Color.reloSecondaryText)
            }
            ForEach(blocks) { block in
                switch block {
                case let .sinceYouLooked(line, spoken, muted, recent, more):
                    sinceSection(line: line, spoken: spoken, muted: muted, recent: recent, more: more)
                case let .needsYou(rows):
                    needsSection(screen: screen, rows: rows)
                case let .fold(fold, count, rows, open):
                    foldSection(fold, count: count, rows: rows, open: open)
                case let .running(title, rows):
                    section(title, count: rows.count, color: ReloHoloTheme.color(.running)) {
                        ForEach(rows) { row in runningCard(row) }
                    }
                case let .sessions(sessions):
                    sessionsSection(sessions)
                }
            }
            NowAllClearView(activity: activity, allClear: allClear,
                            openItem: { id in Task { await model.openNotification(notificationID: id) } },
                            viewHistory: viewHistory)
                .transition(.opacity)
            if model.currentState?.snapshot.metadata?.hasMore == true {
                moreButton("Show more current work", busy: model.currentState?.isLoadingCurrentPage == true) {
                    Task { await model.loadMoreCurrent() }
                }
            }
        }
        .animation(reduceMotion ? nil : .smooth(duration: 0.35), value: screen.needsMe.map(\.id))
        .animation(reduceMotion ? nil : .smooth(duration: 0.35), value: blocks.map(\.id))
    }

    // MARK: Persistence

    @ViewBuilder
    private var persistenceWarning: some View {
        if model.currentState?.persistence == .unavailable {
            VStack(spacing: 10) {
                Label("This iPhone couldn't save current work. Unlock it and retry; fetched requests can still be reviewed.",
                      systemImage: "externaldrive.badge.exclamationmark")
                    .font(.footnote).foregroundStyle(Color.reloErrorText)
                Button("Retry saving") { model.retryCurrentStorage() }
                    .buttonStyle(.bordered).tint(.reloInteractive).frame(minHeight: 44)
            }
            .frame(maxWidth: .infinity)
        }
    }

    private var todayActivity: TodayActivity {
        let items = InboxHistoryProjection.collapsedActivities(
            model.historyItems.filter { clearedAt <= 0 || $0.createdAt.timeIntervalSince1970 >= clearedAt })
        let rows = HistoryRowProjection.rows(items, events: model.historyItems, now: model.attentionDate)
            .filter { $0.outcome != .running && $0.outcome != .waitingForYou }
        return .make(rows: rows, now: model.attentionDate)
    }

    private var isOffline: Bool { offline || model.currentState?.connection == .offline }

    // MARK: Sections

    private func section<Content: View>(_ title: String, count: Int?, color: Color,
                                        @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            NowSectionCaption(title: title, count: count, color: color)
            content()
        }
        .transition(.opacity.combined(with: .move(edge: .bottom)))
    }

    private func toggle(_ key: String) {
        withAnimation(reduceMotion ? nil : .smooth(duration: 0.3)) {
            if openFolds.contains(key) { openFolds.remove(key) } else { openFolds.insert(key) }
        }
    }

    // MARK: Since you looked

    private func sinceSection(line: String, spoken: String, muted: Bool, recent: [NowRowModel], more: Int) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(line)
                .font(.subheadline.weight(muted ? .regular : .medium))
                .foregroundStyle(muted ? Color.reloSecondaryText : Color.primary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel(spoken)
            if !recent.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(recent.enumerated()), id: \.element.id) { index, row in
                        if index > 0 { Divider().padding(.leading, 16) }
                        listRow(row)
                    }
                    if more > 0 || openFolds.contains("recent") {
                        Divider().padding(.leading, 16)
                        foldLine(label: more > 0 ? "Show \(more) more" : "Show fewer", color: .reloInteractive,
                                 open: openFolds.contains("recent"), accessibility: nil) { toggle("recent") }
                    }
                }
                .reloCard()
            }
        }
    }

    // MARK: Needs you

    private func needsSection(screen: CurrentInboxPresentation, rows: [NowRowModel]) -> some View {
        section("Needs you", count: (screen.actionableCount ?? screen.needsMe.count) + rows.count,
                color: ReloHoloTheme.color(.needsYou)) {
            ForEach(screen.needsMe) { item in requestCard(item) }
            ForEach(rows) { row in needsCard(row) }
            if let error = model.nowDismissError {
                Text(error).font(.footnote).foregroundStyle(Color.reloErrorText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if model.currentState?.snapshot.pending?.metadata?.hasMore == true {
                moreButton("Show more requests", busy: model.currentState?.pendingConnection == .connecting) {
                    Task { await model.loadMorePending() }
                }
            }
            if model.currentState?.pendingConnection == .offline {
                Text("Couldn't refresh requests. Saved requests stay visible and are checked again when you reconnect.")
                    .font(.footnote).foregroundStyle(Color.reloSecondaryText)
            }
        }
    }

    /// A missed question (late answers allowed, never permission) or a permission prompt.
    private func needsCard(_ row: NowRowModel) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let chip = row.chip { chipText(chip, tone: row.tone) }
            Text(row.title).font(.headline).foregroundStyle(.primary).fixedSize(horizontal: false, vertical: true)
            ForEach(row.lines, id: \.self) { line in
                Text(line).font(.subheadline).foregroundStyle(Color.reloSecondaryText).lineLimit(4)
            }
            if row.reason == .missedQuestion, let id = row.notificationID {
                if let feedback = model.responseFeedback(for: id) {
                    Text(feedback.status).font(.footnote.weight(.medium)).foregroundStyle(Color.reloSecondaryText)
                } else if let decision = model.currentPresentation.needsMe.first(where: { $0.notificationId == id }) {
                    CurrentDecisionButtons(model: model, decision: decision)
                } else {
                    Button("Answer late") { Task { await model.openNotification(notificationID: id) } }
                        .buttonStyle(.bordered).tint(.reloInteractive).frame(minHeight: 44)
                }
            }
            if let footnote = row.footnote {
                Text(footnote).font(.footnote).foregroundStyle(Color.reloSecondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if row.reason == .missedQuestion, let questionID = row.questionID {
                // Dismisses here; it never opens the notification.
                Button("Dismiss") { Task { await model.dismissMissedQuestion(questionID: questionID) } }
                    .buttonStyle(.borderless)
                    .font(.footnote.weight(.semibold)).tint(.reloInteractive).frame(minHeight: 44)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .reloCard(tint: ReloHoloTheme.color(.needsYou))
    }

    private func requestCard(_ item: PendingCurrentDecision) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            // The text opens the full request; the answer buttons are right here.
            Button {
                Task { await model.openNotification(notificationID: item.notificationId) }
            } label: {
                HStack(alignment: .top, spacing: 14) {
                    ReloSignalGlyph(symbol: symbol(for: item.interaction.type), color: ReloHoloTheme.color(.needsYou), size: 40)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(item.source).font(.caption.weight(.semibold)).foregroundStyle(Color.reloSecondaryText)
                        Text(item.title).font(.headline).foregroundStyle(.primary)
                            .fixedSize(horizontal: false, vertical: true)
                        if !item.summary.isEmpty, item.summary != item.title {
                            Text(item.summary).font(.subheadline).foregroundStyle(.primary).lineLimit(4)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens the full request")
            if let feedback = model.responseFeedback(for: item.notificationId) {
                Text(feedback.status).font(.footnote.weight(.medium)).foregroundStyle(Color.reloSecondaryText)
            } else {
                ReloAnswerCountdown(deadline: item.interaction.expiresAt)
                CurrentDecisionButtons(model: model, decision: item)
            }
        }
        .padding(16)
        .reloCard(tint: ReloHoloTheme.color(.needsYou))
    }

    // MARK: Folds

    private func foldTitle(_ fold: NowFold) -> String {
        switch fold {
        case .waitingOnYou: "Waiting on you"
        case .quiet: "Quiet"
        case .paused: "Paused"
        case .idle: "Idle"
        }
    }

    private func foldSection(_ fold: NowFold, count: Int, rows: [NowRowModel], open: Bool) -> some View {
        let title = foldTitle(fold)
        let color = fold == .waitingOnYou ? ReloHoloTheme.color(.attention) : Color.reloSecondaryText
        return VStack(spacing: 0) {
            foldLine(label: "\(title) (\(count))", color: color, open: open,
                     accessibility: "\(title), \(count) \(count == 1 ? "item" : "items")") { toggle(fold.rawValue) }
            if open {
                ForEach(rows) { row in
                    Divider().padding(.leading, 16)
                    listRow(row)
                }
            }
        }
        .reloCard()
        .transition(.opacity)
    }

    /// One fold line; a button with its count and state for VoiceOver.
    private func foldLine(label: String, color: Color, open: Bool, accessibility: String?,
                          action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text(label).font(.footnote.weight(.medium)).foregroundStyle(color)
                Spacer(minLength: 8)
                Image(systemName: open ? "chevron.up" : "chevron.down")
                    .font(.caption.weight(.semibold)).foregroundStyle(color)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 16).padding(.vertical, 12).frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibility ?? label)
        .accessibilityValue(open ? "expanded" : "collapsed")
        .accessibilityHint("Shows the items")
    }

    // MARK: Rows

    private func chipText(_ text: String, tone: NowTone) -> some View {
        Text(text)
            .font(.system(.caption2, design: .monospaced).weight(.semibold)).tracking(1.0)
            .foregroundStyle(tone.color)
    }

    @ViewBuilder
    private func listRow(_ row: NowRowModel) -> some View {
        let content = HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                if let chip = row.chip { chipText(chip, tone: row.tone) }
                Text(row.title).font(.subheadline.weight(.medium)).foregroundStyle(.primary).lineLimit(2)
                ForEach(row.lines, id: \.self) { line in
                    Text(line).font(.caption).foregroundStyle(Color.reloSecondaryText).lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if row.notificationID != nil { ReloChevron() }
        }
        .padding(.horizontal, 16).padding(.vertical, 12).frame(minHeight: 52)
        .contentShape(Rectangle())

        if let notificationID = row.notificationID {
            Button { Task { await model.openNotification(notificationID: notificationID) } } label: { content }
                .buttonStyle(.plain)
                .accessibilityElement(children: .combine).accessibilityHint("Opens details")
        } else {
            content.accessibilityElement(children: .combine)
        }
    }

    @ViewBuilder
    private func runningCard(_ row: NowRowModel) -> some View {
        let tone = row.tone.color
        let body = VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(row.title).font(.headline).foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                if isOffline {
                    Label("Unconfirmed", systemImage: "wifi.slash")
                        .font(.caption.weight(.semibold)).foregroundStyle(Color.reloSecondaryText)
                } else if row.notificationID != nil {
                    ReloChevron()
                }
            }
            ForEach(Array(row.lines.enumerated()), id: \.offset) { index, line in
                Text(line).font(index == row.lines.count - 1 ? .footnote : .subheadline)
                    .foregroundStyle(line.hasPrefix("Working quietly") ? tone : Color.reloSecondaryText).lineLimit(2)
            }
            if let steps = row.steps, steps.total > 0 {
                LiveStepsBar(steps: steps, color: tone, shimmer: row.shimmer)
            } else if let progress = row.progress, progress.isFinite {
                LiveProgressBar(value: progress, color: tone, shimmer: row.shimmer)
            }
            HStack(spacing: 6) {
                if let startedAt = row.startedAt {
                    // The system ticks this timer; the card does not redraw once a second.
                    HStack(spacing: 4) {
                        Text("running")
                        Text(timerInterval: startedAt...Date.distantFuture, countsDown: false)
                            .monospacedDigit().multilineTextAlignment(.leading)
                            .frame(maxWidth: 64, alignment: .leading)
                    }
                    .fixedSize()
                    Text("·").accessibilityHidden(true)
                }
                if let meta = row.meta { Text(meta) }
            }
            .font(.system(.caption2, design: .monospaced)).foregroundStyle(Color.reloSecondaryText.opacity(0.85))
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .reloCard()

        if let notificationID = row.notificationID {
            Button { Task { await model.openNotification(notificationID: notificationID) } } label: { body }
                .buttonStyle(ReloPressStyle())
                .accessibilityElement(children: .combine).accessibilityHint("Opens details")
        } else {
            body.accessibilityElement(children: .combine)
        }
    }

    // MARK: Sessions

    @ViewBuilder
    private func sessionsSection(_ block: NowSessionsBlock) -> some View {
        section("Sessions", count: block.working, color: ReloHoloTheme.sessions) {
            ForEach(block.groups) { group in
                VStack(alignment: .leading, spacing: 8) {
                    Text(group.title).font(.system(.caption2, design: .monospaced).weight(.medium)).tracking(1.0)
                        .foregroundStyle(Color.reloSecondaryText).textCase(.uppercase)
                    VStack(spacing: 0) {
                        ForEach(Array(group.rows.enumerated()), id: \.element.id) { index, row in
                            if index > 0 { Divider().padding(.leading, 16) }
                            sessionRow(row)
                        }
                        if !group.idle.isEmpty {
                            let key = "idle:\(group.title)"
                            let open = openFolds.contains(key)
                            if !group.rows.isEmpty { Divider().padding(.leading, 16) }
                            foldLine(label: open ? "Hide idle" : "Idle (\(group.idle.count))", color: Color.reloSecondaryText,
                                     open: open, accessibility: "Idle, \(group.idle.count) sessions") { toggle(key) }
                            if open {
                                ForEach(group.idle) { row in
                                    Divider().padding(.leading, 16)
                                    sessionRow(row)
                                }
                            }
                        }
                    }
                    .reloCard()
                }
            }
        }
    }

    @ViewBuilder
    private func sessionRow(_ row: NowSessionRowModel) -> some View {
        let content = HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(row.title).font(.subheadline.weight(.medium)).foregroundStyle(.primary).lineLimit(1)
                if let context = row.context {
                    Text(context).font(.caption).foregroundStyle(Color.reloSecondaryText).lineLimit(1)
                }
                if let work = row.workTitle {
                    Text(work).font(.footnote).foregroundStyle(Color.reloSecondaryText).lineLimit(1)
                }
                HStack(spacing: 6) {
                    Circle().fill(row.tone.color).frame(width: 6, height: 6).accessibilityHidden(true)
                    Text(row.chip).font(.caption.weight(.medium)).foregroundStyle(row.tone.color).lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if row.notificationID != nil { ReloChevron() }
        }
        .padding(.horizontal, 16).padding(.vertical, 12).frame(minHeight: 52)
        .contentShape(Rectangle())

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
            HStack(spacing: 8) {
                if busy { ProgressView().controlSize(.small) }
                Text(title)
            }
            .font(.subheadline.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.bordered).tint(.reloInteractive).disabled(busy)
    }

    private func symbol(for kind: CurrentDecision.Kind) -> String {
        switch kind {
        case .approval: "checkmark.seal.fill"
        case .yesNo: "arrow.triangle.branch"
        case .text: "text.bubble.fill"
        case .choice: "list.bullet.circle.fill"
        }
    }
}

/// Approve/Deny, Yes/No or a choice's options for a request in Needs you, with the sender's own labels.
private struct CurrentDecisionButtons: View {
    @Bindable var model: AppModel
    let decision: PendingCurrentDecision

    private var actions: BinaryNotificationActionPresentation? {
        if let item = model.items.first(where: { $0.id == decision.notificationId }),
           let labelled = BinaryNotificationActionPresentation(
            behavior: InboxPresentationProjection.presentation(for: item).behavior) {
            return labelled
        }
        let kind: InboxInteraction.Kind = switch decision.interaction.type {
        case .approval: .approval
        case .yesNo: .yesNo
        case .text: .text
        case .choice: .choice
        }
        return BinaryNotificationActionPresentation(kind: kind, style: "standard")
    }

    var body: some View {
        if decision.interaction.type == .choice, let options = decision.interaction.options,
           let draft = model.currentDecision(notificationID: decision.notificationId),
           model.decisionAvailability(draft.identity).permitsSubmission {
            ChoiceOptionButtons(options: options) { send(.choose, draft.identity, optionID: $0.id) }
                .disabled(model.respondingNotificationID != nil)
        } else if let actions, let draft = model.currentDecision(notificationID: decision.notificationId),
           model.decisionAvailability(draft.identity).permitsSubmission {
            HStack(spacing: 12) {
                Button { send(actions.secondaryAction, draft.identity) } label: {
                    Text(actions.secondaryLabel).frame(maxWidth: .infinity, minHeight: 32)
                }
                .buttonStyle(.bordered).tint(.reloInteractive)
                Button { send(actions.primaryAction, draft.identity) } label: {
                    Text(actions.primaryLabel).frame(maxWidth: .infinity, minHeight: 32)
                }
                .buttonStyle(.borderedProminent).tint(.reloActionFill)
            }
            .disabled(model.respondingNotificationID != nil)
        }
    }

    private func send(_ action: NotificationInteractionAction, _ identity: CurrentDecisionIdentity, optionID: String? = nil) {
        Task {
            NotificationResponseHaptics.decisionStarted()
            await model.respond(to: identity, action: action, optionID: optionID)
            if let feedback = model.responseFeedback(for: decision.notificationId) {
                NotificationResponseHaptics.responseFinished(feedback.phase)
            }
        }
    }
}

/// The sweep of light used on live meters. It is a mask, not an overlay: it is drawn only
/// inside the shape it decorates (the filled part of a bar), so it never shows as a band over
/// the track or the label. It moves by sliding the gradient's start and end points.
private struct LiveSweep: View {
    let active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if active && !reduceMotion {
            // The shared clock: paused off screen, in Low Power Mode and when the device is hot.
            ReloMotionClock(framesPerSecond: 24, still: 0) { time in
                let cycle = 2.8
                // Travels from just before the left edge to just past the right, then rests.
                let phase = min(time.truncatingRemainder(dividingBy: cycle) / (cycle * 0.7), 1) * 1.6 - 0.3
                LinearGradient(stops: [.init(color: .clear, location: 0),
                                       .init(color: .white.opacity(0.55), location: 0.5),
                                       .init(color: .clear, location: 1)],
                               startPoint: UnitPoint(x: phase - 0.18, y: 0.5),
                               endPoint: UnitPoint(x: phase + 0.18, y: 0.5))
                    .blendMode(.plusLighter)
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }
}

/// A flat bar for work that reports a fraction instead of steps; the sweep lives in the fill.
private struct LiveProgressBar: View {
    let value: Double
    let color: Color
    let shimmer: Bool

    private var fraction: Double { value.isFinite ? min(max(value, 0), 1) : 0 }

    var body: some View {
        HStack(spacing: 10) {
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.white.opacity(0.1))
                    Capsule().fill(color)
                        .overlay { LiveSweep(active: shimmer) }
                        .clipShape(Capsule())
                        .frame(width: max(4, proxy.size.width * fraction))
                        .animation(.smooth(duration: 0.6), value: fraction)
                }
            }
            .frame(height: 4)
            Text(fraction, format: .percent.precision(.fractionLength(0)))
                .font(.caption.weight(.medium).monospacedDigit()).foregroundStyle(Color.reloSecondaryText)
        }
        .accessibilityElement(children: .ignore).accessibilityLabel("Progress")
        .accessibilityValue(fraction.formatted(.percent.precision(.fractionLength(0))))
    }
}

/// Steps as segments: finished ones in the meaning color with the sweep running through them
/// only (masked by their shapes), the current one a touch dimmer, pending ones faint track.
private struct LiveStepsBar: View {
    let steps: NowItem.Steps
    let color: Color
    let shimmer: Bool

    private var done: Int { min(max(steps.done, 0), steps.total) }

    private func segments(_ fill: @escaping (Int) -> Color) -> some View {
        HStack(spacing: 3) {
            ForEach(0..<max(steps.total, 1), id: \.self) { index in
                Capsule().fill(fill(index)).frame(height: 4).frame(maxWidth: .infinity)
            }
        }
    }

    var body: some View {
        segments { index in index < done ? color : Color.white.opacity(index == done ? 0.28 : 0.1) }
            .overlay {
                LiveSweep(active: shimmer)
                    .mask(segments { index in index < done ? .black : .clear })
            }
            .frame(height: 4)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Step \(min(done + 1, steps.total)) of \(steps.total)\(steps.current.map { ": \($0)" } ?? "")")
    }
}
