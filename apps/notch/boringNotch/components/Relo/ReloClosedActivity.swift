//
//  ReloClosedActivity.swift
//  Relo Notch
//
//  The closed notch's Relo card, the Mac's Dynamic Island. Compact: a ring left of the notch and a count
//  right of it, while work runs (like music playing). Expanded: when work starts, needs the owner,
//  becomes their turn, finishes or fails, the notch grows into the card for a few seconds, with that
//  update's sound. What leads is the server's Lock Screen focus; nothing here decides state.
//

import AppKit
import Defaults
import OSLog
import ReloCore
import ReloNotchKit
import ReloVoice
import SwiftUI

@MainActor
enum ReloNotch {
    static let store = ReloNotchStore()
    /// Plan usage read from the agents signed in on this Mac (`relo usage --json`); refreshes faster while sessions work.
    static let usage = UsageStore(
        read: {
            let server = await MainActor.run { ReloServerService.shared.server }
            guard let result = try? await server.relo(["usage", "--json"]), result.status == 0 else { return nil }
            return Data(result.stdout.utf8)
        },
        isBusy: { store.presentation.machines.contains { $0.working > 0 } })
    /// Says a card's line on this Mac; the model loads when a line needs it and unloads when idle.
    static let voice: ReloVoice = {
        let voice = ReloVoice()
        voice.engine = ReloVoice.Engine(rawValue: Defaults[.reloVoiceEngine]) ?? .relo
        voice.speaker = Defaults[.reloVoiceSpeaker]
        return voice
    }()

    /// Whether the closed notch carries Relo now: the server shows a focus, sessions are working, or
    /// this Mac is not signed in yet (then it says how to start).
    static var showsClosedActivity: Bool {
        Defaults[.reloClosedActivity]
            && (store.presentation.focus != nil || store.presentation.workingSessionsWithoutCards > 0 || needsSignIn)
    }

    /// Why the closed notch shows Relo or not, and on which screen: the notch going plain is otherwise invisible.
    static let wingsLog = Logger(subsystem: "relo.notch", category: "wings")

    /// Nothing live and signed in: the closed notch carries Relo's pilot light (unless music holds the notch), so it
    /// says Relo is here instead of going plain.
    static var showsPilotLight: Bool {
        Defaults[.reloClosedActivity] && !showsClosedActivity
    }

    static var needsSignIn: Bool {
        // The onboarding's own staged work owns the notch: no sign-in hint under it.
        !store.isStagingOnboarding && ([.signedOut, .needsSignIn].contains(store.connection) || (store.isLocal && store.localStartFailed))
    }

    /// Expanding and sounds are paused from the menu ("Pause alerts for 1 hour").
    static var alertsPaused: Bool {
        (Defaults[.reloPeeksPausedUntil] ?? .distantPast) > Date()
    }
}

/// Relo's update sounds, one per kind of update, each switchable in Settings.
@MainActor
enum ReloSounds {
    static func enabled(_ kind: NotchEvent.Kind) -> Bool {
        guard Defaults[.reloSounds] else { return false }
        switch kind {
        case .question: return Defaults[.reloSoundQuestion]
        case .failed: return Defaults[.reloSoundFailed]
        case .yourTurn: return Defaults[.reloSoundYourTurn]
        case .finished: return Defaults[.reloSoundFinished]
        case .started: return Defaults[.reloSoundStarted]
        case .progressed: return Defaults[.reloSoundStep]
        }
    }

    /// Settings' preview of a kind's cue (ADR 0013).
    static func preview(_ kind: NotchEvent.Kind) {
        let cue: ReloCue? = switch kind {
        case .question: .needsYou
        case .failed: .failed
        case .yourTurn: .yourTurn
        case .finished: .done
        case .started: .start
        case .progressed: .update
        }
        if let cue { ReloCuePlayer.shared.play(cue, force: true) }
    }
}

/// The closed notch's wings: content on each side of the camera housing, read as one unit (the Dynamic Island's compact
/// leading and trailing views). The housing is the real notch (`getClosedNotchSize`: the screen's auxiliary top areas and
/// safe-area height). Both wings take the width of the wider content, so the black stays centred on the camera, and the
/// notch's hover area (ContentView's chin) is computed from the same numbers.
@MainActor
enum ReloWing {
    /// Outer margin (clear of the notch's rounded corner) and the gap to the housing.
    static let outer: CGFloat = 6
    static let gap: CGFloat = 8
    /// Up to this many steps draw as segments; more read as one continuous bar.
    static let maxSegments = 8
    /// Each wing while anything is live: the orbit on the left; the plan and +N, or a chip, on the right.
    static let orbit: CGFloat = 58

    /// Each wing's content: Orbit's width while anything is live, else just the mark.
    static func contentWidth(_ presentation: NotchPresentation, side: CGFloat, offline: Bool) -> CGFloat {
        presentation.focus != nil || presentation.workingSessionsWithoutCards > 0 ? max(side, orbit) : side
    }

    /// The whole closed width beyond the housing, both wings with their margins.
    static func extraWidth(side: CGFloat) -> CGFloat {
        let store = ReloNotch.store
        return 2 * (contentWidth(store.presentation, side: side, offline: store.connection == .offline) + outer + gap)
    }
}

struct ReloClosedActivity: View {
    @EnvironmentObject var vm: BoringViewModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let store = ReloNotch.store

    /// The update the notch is expanded for, if any (its card follows the live summary by id).
    @State private var expanded: NotchEvent?
    /// When the current expansion opened: the clock its light and entrance run on.
    @State private var openedAt = Date()
    /// The moment the wings are playing (a step, a question, your turn, a finish, a failure).
    @State private var moment: ReloOrbitMoment?
    @State private var queue: [NotchEvent] = []
    /// A notice (`relo notify`) the notch shows for a moment when no iPhone gets it, and the ones waiting behind it.
    @State private var notice: MacNotice?
    @State private var noticeQueue: [MacNotice] = []
    @State private var noticeTask: Task<Void, Never>?
    /// A plan-usage moment (80%, out, reset): shown like a notice, behind every update and notice, never over them.
    @State private var usageMoment: UsageMoment?
    @State private var usageQueue: [UsageMoment] = []
    @State private var usageTask: Task<Void, Never>?
    @State private var expandTask: Task<Void, Never>?
    @State private var attention = 0
    @State private var showSignInHint = false
    @State private var hintShown = false

    private var side: CGFloat { max(0, vm.effectiveClosedNotchHeight - 12) }

    var body: some View {
        let presentation = store.presentation
        let offline = store.connection == .offline
        let wing = ReloWing.contentWidth(presentation, side: side, offline: offline)
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                Color.clear
                    .frame(width: wing, height: side)
                    .padding(.leading, ReloWing.outer)
                    .padding(.trailing, ReloWing.gap)
                Rectangle()
                    .fill(.black)
                    .frame(width: vm.closedNotchSize.width - cornerRadiusInsets.closed.top)
                Color.clear
                    .frame(width: wing, height: side)
                    .padding(.leading, ReloWing.gap)
                    .padding(.trailing, ReloWing.outer)
            }
            .overlay {
                // One canvas over the whole closed notch (its rounded corners too), so the glow and the beams follow
                // the black's own edge. The expansion carries the light down: the wings fade once its shape starts to move.
                ReloOrbitWings(scene: ReloOrbitScene(presentation, unseen: ReloMoments.shared.unseen), moment: moment,
                               wing: wing, side: side, offline: offline)
                    .padding(.horizontal, -cornerRadiusInsets.closed.bottom)
                    .opacity(expanded == nil && notice == nil && usageMoment == nil ? 1 : 0)
            }
            .opacity(offline ? 0.5 : 1)
            .animation(expanded == nil && notice == nil && usageMoment == nil ? .easeOut(duration: 0.3).delay(0.18) : .easeOut(duration: 0.22).delay(0.06),
                       value: expanded == nil && notice == nil && usageMoment == nil)
            .frame(height: vm.effectiveClosedNotchHeight, alignment: .center)

            if let expanded {
                // Questions and failures open the card; a start or a finish is one small line.
                // The shape grows on its spring and the content arrives on its own clock; leaving, it all fades at once.
                Group {
                    if expanded.kind == .finished || expanded.kind == .started {
                        ReloPeekPill(event: expanded, row: live(expanded.row, in: presentation), openedAt: openedAt)
                    } else {
                        ReloExpandedCard(event: expanded, row: live(expanded.row, in: presentation), openedAt: openedAt)
                    }
                }
                .transition(.asymmetric(insertion: .identity,
                                        removal: .opacity.combined(with: .offset(y: -4)).animation(.easeOut(duration: 0.14))))
            } else if let notice {
                ReloNoticePill(notice: notice, openedAt: openedAt)
                    .transition(.asymmetric(insertion: .identity,
                                            removal: .opacity.combined(with: .offset(y: -4)).animation(.easeOut(duration: 0.14))))
            } else if let usageMoment {
                ReloUsagePill(moment: usageMoment, openedAt: openedAt)
                    .transition(.asymmetric(insertion: .identity,
                                            removal: .opacity.combined(with: .offset(y: -4)).animation(.easeOut(duration: 0.14))))
            } else if showSignInHint {
                Text(ReloNotch.store.isLocal ? (ReloNotch.store.localStartFailed ? LocalMode.hoverStartFailed : LocalMode.hoverToRepair) : "Relo · hover here to sign in")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(ReloNotchTheme.secondaryText)
                    .padding(.horizontal, 10).padding(.bottom, 8).padding(.top, 2)
                    .transition(.opacity.combined(with: .offset(y: -6)))
            }
        }
        .onAppear {
            if ReloNotch.needsSignIn && !hintShown { flashSignInHint() }
        }
        // The moments come from the store (ReloMoments), once each: this view only shows them, so a remount never
        // re-announces a question that is still open.
        .onChange(of: ReloMoments.shared.batch) { _, batch in receive(batch.events) }
        .onChange(of: ReloMoments.shared.notices) { _, arrivals in receiveNotices(arrivals.notices) }
        .onChange(of: ReloUsageMoments.shared.arrivals) { _, arrivals in receiveUsage(arrivals.moments) }
        .onChange(of: ReloMoments.shared.stepped) { _, stepped in
            guard !quiet, let id = stepped.rowID, moment.map({ Date().timeIntervalSince($0.at) >= $0.duration }) ?? true,
                  let row = presentation.sections.lazy.flatMap(\.rows).first(where: { $0.id == id }) else { return }
            moment = ReloOrbitMoment(step: row)
        }
        .onChange(of: presentation) { _, now in closeIfGone(now) }
        .onDisappear {
            expandTask?.cancel(); expandTask = nil
            noticeTask?.cancel(); noticeTask = nil
            usageTask?.cancel(); usageTask = nil; usageMoment = nil; usageQueue = []
            expanded = nil; queue = []; notice = nil; noticeQueue = []
        }
    }

    /// The expanded card shows the work as it is now, not as it was when the update arrived.
    private func live(_ row: NotchPresentation.Row, in presentation: NotchPresentation) -> NotchPresentation.Row {
        presentation.sections.lazy.flatMap(\.rows).first { $0.id == row.id } ?? row
    }

    // MARK: Expanding for updates

    /// A card that left Now (answered, dismissed) closes its expansion.
    private func closeIfGone(_ presentation: NotchPresentation) {
        if let shown = expanded, presentation.sections.flatMap(\.rows).first(where: { $0.id == shown.row.id }) == nil {
            collapse()
        }
    }

    /// New moments (sound and haptic are ReloMoments'): the mark beats and the notch expands for the lead one.
    private func receive(_ events: [NotchEvent]) {
        guard !events.isEmpty else { return }
        if events.contains(where: { [.question, .failed, .yourTurn].contains($0.kind) }) { attention += 1 }
        guard !quiet else { return }
        // The wings play the lead update's moment; the card (when peeks are on) opens once it has been seen.
        if let lead = events.first, let next = ReloOrbitMoment(lead) { moment = next }
        guard Defaults[.reloPeek] else { return }
        // A more important update replaces what is shown; the rest wait their turn.
        let pending = (queue + events).sorted { Self.rank($0.kind) < Self.rank($1.kind) }
        if let current = expanded, let next = pending.first, Self.rank(next.kind) < Self.rank(current.kind) {
            queue = Array(pending.dropFirst()).filter { $0.row.id != next.row.id }
            show(next)
        } else if expanded == nil, let next = pending.first {
            queue = Array(pending.dropFirst())
            show(next)
        } else {
            queue = pending.filter { $0.row.id != expanded?.row.id }
        }
        queue = Array(queue.prefix(4))
    }

    // MARK: Notices

    /// New notices (this Mac shows them because no iPhone gets the push): a short line under the notch, one at a time,
    /// never over a question or an update, and not while alerts are paused or a full-screen app is in front.
    private func receiveNotices(_ arrivals: [MacNotice]) {
        guard !arrivals.isEmpty, !quiet, Defaults[.reloPeek] else { return }
        noticeQueue = Array((noticeQueue + arrivals).suffix(3))
        showNextNotice()
    }

    private func showNextNotice() {
        guard notice == nil, expanded == nil, queue.isEmpty, !noticeQueue.isEmpty else { showNextUsage(); return }
        let next = noticeQueue.removeFirst()
        noticeTask?.cancel()
        noticeTask = Task { @MainActor in
            openedAt = Date()
            withAnimation(reduceMotion ? .easeInOut(duration: 0.2) : ReloMotion.snappy) { notice = next }
            try? await Task.sleep(for: .seconds(4.5))
            // Hovering the line keeps it (the notch opens from there).
            while !Task.isCancelled && vm.cursorIsOverNotch() { try? await Task.sleep(for: .milliseconds(300)) }
            guard !Task.isCancelled else { return }
            withAnimation(ReloMotion.smooth) { notice = nil }
            try? await Task.sleep(for: .milliseconds(450))
            guard !Task.isCancelled else { return }
            showNextNotice()
        }
    }

    // MARK: Usage moments

    /// Plan-usage moments (no sound, see ReloUsageMoments): they respect every pause rule, wait behind updates and
    /// notices, and are dropped, not kept, when an update arrives (the Usage tab has the numbers).
    private func receiveUsage(_ arrivals: [UsageMoment]) {
        guard !arrivals.isEmpty, !quiet, Defaults[.reloPeek] else { return }
        usageQueue = Array((usageQueue + arrivals).suffix(3))
        showNextUsage()
    }

    private func showNextUsage() {
        guard usageMoment == nil, notice == nil, expanded == nil, queue.isEmpty, noticeQueue.isEmpty,
              !usageQueue.isEmpty, !quiet, Defaults[.reloPeek] else { return }
        let next = usageQueue.removeFirst()
        usageTask?.cancel()
        usageTask = Task { @MainActor in
            openedAt = Date()
            withAnimation(reduceMotion ? .easeInOut(duration: 0.2) : ReloMotion.snappy) { usageMoment = next }
            try? await Task.sleep(for: .seconds(4.5))
            while !Task.isCancelled && vm.cursorIsOverNotch() { try? await Task.sleep(for: .milliseconds(300)) }
            guard !Task.isCancelled else { return }
            withAnimation(ReloMotion.smooth) { usageMoment = nil }
            try? await Task.sleep(for: .milliseconds(450))
            guard !Task.isCancelled else { return }
            showNextUsage()
        }
    }

    private static func rank(_ kind: NotchEvent.Kind) -> Int {
        NotchEvent.Kind.allCases.firstIndex(of: kind) ?? 9
    }

    private func show(_ event: NotchEvent) {
        expandTask?.cancel()
        // A question or an update outranks a notice: it waits in the Recent list.
        noticeTask?.cancel(); notice = nil; noticeQueue = []
        usageTask?.cancel(); usageMoment = nil
        let lead = reduceMotion || moment?.rowID != event.row.id ? 0 : Self.momentLead(event.kind)
        let seconds = Self.duration(event.kind)
        expandTask = Task { @MainActor in
            if lead > 0 {
                try? await Task.sleep(for: .seconds(lead))
                guard !Task.isCancelled else { return }
            }
            openedAt = Date()
            withAnimation(reduceMotion ? .easeInOut(duration: 0.2) : ReloMotion.snappy) {
                expanded = event
            }
            try? await Task.sleep(for: .seconds(seconds))
            // Hovering the card keeps it (the notch opens from there).
            while !Task.isCancelled && vm.cursorIsOverNotch() { try? await Task.sleep(for: .milliseconds(300)) }
            guard !Task.isCancelled else { return }
            collapse()
        }
    }

    private func collapse() {
        expandTask?.cancel()
        withAnimation(ReloMotion.smooth) { expanded = nil }
        guard !queue.isEmpty else {
            Task { @MainActor in try? await Task.sleep(for: .milliseconds(450)); showNextNotice() }
            return
        }
        let next = queue.removeFirst()
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(450))
            if expanded == nil && !quiet { show(next) }
        }
    }

    /// How long the wings play an update's moment before its card opens: until the beams reach the top corners, so the
    /// expansion takes the light down from there in one gesture.
    static func momentLead(_ kind: NotchEvent.Kind) -> Double {
        switch kind {
        case .question: 1.75
        case .yourTurn: 2.25
        case .failed: 2.05
        case .finished: 2.35
        case .progressed: 1.35
        case .started: 1.75
        }
    }

    static func duration(_ kind: NotchEvent.Kind) -> Double {
        switch kind {
        case .question: 8
        case .failed: 6
        case .yourTurn: 5
        case .finished: 3.5
        case .started, .progressed: 3
        }
    }

    /// No expanding or sound while alerts are paused or a full-screen app is in front.
    private var quiet: Bool {
        if ReloNotch.alertsPaused { return true }
        if Defaults[.reloQuietInFullScreen], let uuid = vm.screenUUID,
           FullscreenMediaDetector.shared.fullscreenStatus[uuid] == true { return true }
        return false
    }

    /// Signed out: say once per launch, for a few seconds, how to start.
    private func flashSignInHint() {
        hintShown = true
        withAnimation(ReloMotion.snappy) { showSignInHint = true }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(8))
            withAnimation(ReloMotion.smooth) { showSignInHint = false }
        }
    }
}

/// The closed notch's left wing says which state leads, with the same symbol its card's badge uses (a hand for your
/// turn, a bubble for a question, a check, a cross), in its color. Running work and rest
/// are Relo's flat dot (the right wing's moving waveform already says "running"; at rest it is quiet grey). It stays
/// put; while a moment the owner has not seen waits (a new question, a card that changed state), it breathes, slowly
/// and calmly, until Relo's tab is opened.
struct ReloBrandMark: View {
    let tone: NotchPresentation.Tone?
    let side: CGFloat
    var unseen = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var breathe = false

    /// The state's own symbol; nil keeps the dot (running, or nothing at all).
    static func symbol(_ tone: NotchPresentation.Tone?) -> String? {
        guard let tone, tone != .working else { return nil }
        return ReloNotchTheme.symbol(tone)
    }

    var body: some View {
        let color = tone.map(ReloNotchTheme.color) ?? Color.white.opacity(0.35)
        Group {
            if let symbol = Self.symbol(tone) {
                Image(systemName: symbol)
                    .font(.system(size: side * 0.62, weight: .bold))
                    .foregroundStyle(color)
                    .contentTransition(.symbolEffect(.replace))
            } else {
                Circle()
                    .fill(color)
                    .frame(width: side * 0.5, height: side * 0.5)
            }
        }
        .scaleEffect(breathe ? 1.14 : 1)
        .opacity(breathe ? 0.7 : 1)
        .frame(width: side, height: side)
        .animation(ReloMotion.base, value: tone)
        .onChange(of: unseen, initial: true) { _, now in
            guard !reduceMotion else { breathe = false; return }
            if now {
                withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true)) { breathe = true }
            } else {
                withAnimation(ReloMotion.base) { breathe = false }
            }
        }
        .accessibilityLabel(tone.map { "Relo · \(ReloNotchTheme.label($0))" + (unseen ? ", new" : "") } ?? "Relo")
    }
}

/// What an update expands as: its light, its entrance and its idle life.
extension ReloOpenKind {
    init(_ event: NotchEvent, row: NotchPresentation.Row) {
        switch event.kind {
        case .question: self = .needs
        case .yourTurn: self = .turn
        case .failed: self = .failed
        case .started: self = .started
        case .finished: self = .done
        case .progressed: self = row.questionPending ? .needs : .running
        }
    }
}

/// A start or a finish under the notch, a short card: the state's badge and the title, then the first step (a start)
/// or what it delivered (a finish), then the plan bar. A start draws the plan in from the left behind a bright head;
/// a finish sweeps it full in mint, over the light rising from the bottom edge.
struct ReloPeekPill: View {
    let event: NotchEvent
    let row: NotchPresentation.Row
    let openedAt: Date

    var body: some View {
        let kind = ReloOpenKind(event, row: row)
        ReloOpenClock(openedAt: openedAt) { e in
            VStack(alignment: .leading, spacing: 4) {
                // The expanded card's anatomy, shorter: origin and badge, the title in up to two lines, one line, the bar.
                HStack(spacing: 6) {
                    ReloCardOrigin(row: row).reloArrival(e, 0.16)
                    Spacer(minLength: 6)
                    // A finish is said once: the word in mint and the bar sweeping full; no check on top of them.
                    Text(kind == .started ? "Started" : ReloNotchTheme.label(row.tone))
                        .font(ReloCardMetrics.badge)
                        .foregroundStyle(kind.color)
                        .fixedSize()
                        .reloBadgeArrival(kind, e)
                }
                Text(ReloDisplayName.readable(row.title) ?? LocalMode.untitled(local: ReloNotch.store.isLocal))
                    .font(ReloCardMetrics.hero)
                    .foregroundStyle(.white)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .reloArrival(e, 0.22)
                if let line {
                    Text(line)
                        .font(ReloCardMetrics.status)
                        .foregroundStyle(ReloNotchTheme.secondaryText)
                        .lineLimit(1)
                        .reloArrival(e, 0.28)
                }
                if kind == .done || row.bar != nil {
                    ReloLightBar(segments: row.bar?.segments ?? [], kind: kind, openedAt: openedAt,
                                 color: kind == .done ? ReloNotchTheme.running : kind.color)
                        .padding(.top, 4)
                        .reloArrival(e, 0.32)
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 6)
            .padding(.bottom, 12)
            .frame(width: 440, alignment: .leading)
        }
        .background {
            // Out to the notch's own edge: the notch pads its content by its bottom corner radius on each side.
            ReloOpenLight(kind: kind, openedAt: openedAt, bottomRadius: cornerRadiusInsets.closed.bottom)
                .padding(.horizontal, -cornerRadiusInsets.closed.bottom)
        }
    }

    /// A start says where it begins; a finish says what it delivered.
    private var line: String? {
        if event.kind == .started { return row.planLine ?? row.statusLine }
        return row.roundOutcome ?? row.statusLine
    }
}

/// A plain notice under the notch (`relo notify`), when this Mac is where notices show: where it came from, its title
/// and its first line. Short, quiet, and gone in a few seconds; it stays in the Recent list of Relo's window.
struct ReloNoticePill: View {
    let notice: MacNotice
    let openedAt: Date

    var body: some View {
        ReloOpenClock(openedAt: openedAt) { e in
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(ReloDisplayName.readable(notice.source) ?? "Relo")
                        .font(ReloCardMetrics.origin)
                        .foregroundStyle(ReloNotchTheme.secondaryText)
                        .lineLimit(1)
                        .reloArrival(e, 0.16)
                    Spacer(minLength: 6)
                    Text("Notice")
                        .font(ReloCardMetrics.badge)
                        .foregroundStyle(ReloOpenKind.started.color)
                        .fixedSize()
                        .reloBadgeArrival(.started, e)
                }
                Text(ReloDisplayName.readable(notice.title) ?? notice.title)
                    .font(ReloCardMetrics.hero)
                    .foregroundStyle(.white)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .reloArrival(e, 0.22)
                if let summary = notice.summary {
                    Text(summary)
                        .font(ReloCardMetrics.status)
                        .foregroundStyle(ReloNotchTheme.secondaryText)
                        .lineLimit(1)
                        .reloArrival(e, 0.28)
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 6)
            .padding(.bottom, 12)
            .frame(width: 440, alignment: .leading)
        }
        .background {
            ReloOpenLight(kind: .started, openedAt: openedAt, bottomRadius: cornerRadiusInsets.closed.bottom)
                .padding(.horizontal, -cornerRadiusInsets.closed.bottom)
        }
    }
}

/// The expanded notch for one update: the closed notch grown taller. No mark on the left: the origin with the time and
/// the state's badge on top, the title in up to two lines, what it asks or does, then the answer or the plan bar, over
/// the state's light rising from the bottom edge. Each piece arrives in turn as the notch opens.
struct ReloExpandedCard: View {
    let event: NotchEvent
    let row: NotchPresentation.Row
    let openedAt: Date
    private let store = ReloNotch.store
    /// Three lines do not hold the question: the notch offers no answer next to half of it.
    @State private var questionCut = false

    private var showsQuestion: Bool {
        guard !row.unreadable, row.questionPending, let question else { return false }
        return question.isReadable
    }

    var body: some View {
        let kind = ReloOpenKind(event, row: row)
        let color = ReloNotchTheme.color(row.tone)
        ReloOpenClock(openedAt: openedAt) { e in
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    ReloCardOrigin(row: row).reloArrival(e, 0.16)
                    Spacer(minLength: 6)
                    if row.tone.isMoving, !row.questionPending {
                        Group {
                            if store.presentation.isFrozen(offline: store.connection == .offline, lastUpdated: store.lastUpdated) {
                                Text(NotchPresentation.asOf(store.lastUpdated ?? store.presentation.servedAt))
                            } else if Date().timeIntervalSince(row.startedAt) < 3600 {
                                Text(row.startedAt, style: .timer).monospacedDigit()
                            } else {
                                Text("since \(row.startedAt.formatted(date: .omitted, time: .shortened))")
                            }
                        }
                        .font(ReloCardMetrics.meta).foregroundStyle(ReloNotchTheme.tertiaryText)
                        .reloArrival(e, 0.16)
                    }
                    // One shimmer per card: the bar's when it has one, else the running badge's.
                    ReloStateBadge(symbol: ReloNotchTheme.symbol(row.tone), label: ReloNotchTheme.label(row.tone), color: color,
                                   live: kind == .running && !showsBar(kind))
                        .reloBadgeArrival(kind, e)
                }
                Text(ReloDisplayName.readable(row.title) ?? LocalMode.untitled(local: ReloNotch.store.isLocal))
                    .font(ReloCardMetrics.hero)
                    .foregroundStyle(row.unreadable ? ReloNotchTheme.secondaryText : .white)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .reloArrival(e, 0.22)
                if showsQuestion, let question {
                    // Up to three lines of the question; the answer waits until all of it shows.
                    ReloQuestionText(text: question.prompt, open: false, cut: $questionCut).reloArrival(e, 0.28)
                } else {
                    Text(detail)
                        .font(ReloCardMetrics.status)
                        .foregroundStyle(ReloNotchTheme.secondaryText)
                        .lineLimit(kind == .failed || kind == .turn ? 2 : 1)
                        .fixedSize(horizontal: false, vertical: true)
                        .reloArrival(e, 0.28)
                }
                floor(kind, e)
                    .padding(.top, 6)
            }
            .padding(.horizontal, 18)
            .padding(.top, 6)
            .padding(.bottom, 14)
            .frame(width: 440, alignment: .leading)
        }
        .background {
            // Out to the notch's own edge: the notch pads its content by its bottom corner radius on each side.
            ReloOpenLight(kind: kind, openedAt: openedAt, bottomRadius: cornerRadiusInsets.closed.bottom)
                .padding(.horizontal, -cornerRadiusInsets.closed.bottom)
        }
        .animation(ReloMotion.base, value: row)
    }

    /// The answer for a question; otherwise the plan bar (dimmed while it waits on the owner), or nothing.
    @ViewBuilder
    private func floor(_ kind: ReloOpenKind, _ e: Double) -> some View {
        if row.questionPending, !QuestionReadability.canAnswerHere(rowUnreadable: row.unreadable, question: question) {
            HStack {
                Spacer(minLength: 0)
                ReloReadOnPhoneLine()
            }
            .opacity(Ease.out(Ease.seg(e, 0.36, 0.6)))
        } else if row.questionPending, questionCut {
            HStack {
                Spacer(minLength: 0)
                Button { ReloHomeWindowController.shared.show() } label: {
                    Label("Open Relo to read it all", systemImage: "arrow.up.forward.app")
                        .font(.system(size: 11)).foregroundStyle(ReloNotchTheme.secondaryText)
                }
                .buttonStyle(ReloLinkButtonStyle())
            }
            .opacity(Ease.out(Ease.seg(e, 0.36, 0.6)))
        } else if let notificationID = row.notificationID, row.questionPending {
            HStack {
                Spacer(minLength: 0)
                ReloAnswerBar(notificationID: notificationID, question: question, offline: store.connection == .offline)
            }
            .opacity(Ease.out(Ease.seg(e, 0.36, 0.6)))
            .scaleEffect(0.96 + 0.04 * Ease.out(Ease.seg(e, 0.36, 0.6)), anchor: .trailing)
        } else if let bar = row.bar, showsBar(kind) {
            ReloLightBar(segments: bar.segments, kind: kind, openedAt: openedAt, live: kind == .running)
                .opacity(kind == .turn ? 0.6 : 1)
                .reloArrival(e, 0.36)
        }
    }

    private func showsBar(_ kind: ReloOpenKind) -> Bool {
        !row.questionPending && row.bar != nil && (kind == .running || kind == .turn) && (row.stepsDone ?? 0) < (row.stepsTotal ?? 0)
    }

    private var question: ReloNotchStore.Question? {
        row.notificationID.flatMap { store.questions[$0] }
    }

    private var detail: String {
        if row.unreadable { return ReloLocked.line(row) }
        if let question, question.isReadable { return question.prompt }
        if row.questionPending { return row.status ?? "A question is waiting" }
        if row.tone.isMoving, let line = row.planLine { return line }
        return row.statusLine ?? row.roundOutcome ?? ReloNotchTheme.label(row.tone)
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
