//
//  ReloNotchView.swift
//  Relo Notch
//
//  The open notch's Relo tab: what needs the owner (answerable right here), what runs and what just
//  finished, in the iPhone's card language and in the order the server derives.
//

import AppKit
import ReloCore
import ReloNotchKit
import SwiftUI

struct ReloNotchView: View {
    @EnvironmentObject var vm: BoringViewModel
    private let store = ReloNotch.store

    @ObservedObject private var updater = ReloUpdater.shared

    var body: some View {
        // One container whatever the content: swapping containers when the list appeared or emptied recreated it,
        // losing its scroll position and the opened card. Short content gets the banner under it, never over its buttons.
        content
            .safeAreaInset(edge: .bottom, spacing: 0) { if !showsList { banner } }
            .overlay(alignment: .bottom) { if showsList { banner } }
            .onAppear {
                store.relotabAppeared(); ReloMoments.shared.markSeen(); ReloUpdater.shared.surfaceNotice()
                if [.live, .offline, .connecting].contains(store.connection) { ReloAgents.shared.lookIfDue() }
            }
            .onDisappear { store.relotabDisappeared() }
            .onChange(of: compactHeight, initial: true) { _, height in
                // Sign-in, all clear and connecting need little room; the list measures itself.
                guard let height, reloOpenHeight != height else { return }
                reloOpenHeight = height
                guard vm.notchState == .open, BoringViewCoordinator.shared.currentView == .relo else { return }
                withAnimation(ReloMotion.snappy) { vm.notchSize = openNotchSize(for: .relo) }
            }
    }

    /// The line at the foot: a waiting update first, else an agent found since Relo last looked (only while signed in).
    @ViewBuilder private var banner: some View {
        if updater.visibleUpdate != nil || updater.notice != nil { ReloUpdateBanner() }
        else if ReloPendingApproval.shared.line != nil { ReloPendingApprovalBanner() }
        else if signedIn { ReloAgentFoundBanner() }
    }

    private var signedIn: Bool { [.live, .offline, .connecting].contains(store.connection) }

    /// The open notch's height without the list: the sign-in choices need a little more, a banner its line.
    private var compactHeight: CGFloat? {
        guard !showsList else { return nil }
        let signIn = [.signedOut, .signingIn, .needsSignIn].contains(store.connection) && !store.isLocal
        let waiting = ReloPendingApproval.shared.line != nil
        let banner = updater.visibleUpdate != nil || updater.notice != nil || waiting || (signedIn && ReloAgents.shared.newlyFound != nil)
        return (signIn ? 230 : 200) + (banner ? (waiting ? 64 : 44) : 0)
    }

    private var showsList: Bool {
        [.connecting, .live, .offline].contains(store.connection) && !store.presentation.isEmpty
    }

    @ViewBuilder
    private var content: some View {
        if store.isLocal && (store.localStartFailed || store.localStarting) {
            ReloLocalProblemView(compact: true)
        } else {
            // The last Now, until the server answers: a touch quieter, then full strength as it swaps to live.
            connectionContent
                .opacity(store.showingCached ? 0.72 : 1)
                .animation(.easeOut(duration: 0.35), value: store.showingCached)
        }
    }

    @ViewBuilder
    private var connectionContent: some View {
        switch store.connection {
        case .starting:
            ProgressView().controlSize(.small).frame(maxWidth: .infinity, maxHeight: .infinity)
        case .signedOut, .signingIn, .needsSignIn:
            ReloSignInPanel()
        case .connecting, .live, .offline:
            if store.presentation.isEmpty {
                ReloAllClear(offline: store.connection == .offline, connecting: store.summary == nil)
            } else {
                ReloWorkList()
            }
        }
    }
}

// MARK: - Work

/// The Relo tab's content height, measured so the open notch fits what it shows.
struct ReloContentHeight: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

extension View {
    func measuresReloHeight() -> some View {
        background(GeometryReader { Color.clear.preference(key: ReloContentHeight.self, value: $0.size.height) })
    }
}

/// The open notch's list: the one-line summary on top, then every card full width in the server's order. Live cards
/// (needs you, your turn, running) are one keyed run, so a card that changes state slides to its new place; finished,
/// quiet and paused work are compact rows; the computers at work close the list. A click opens a card in place.
struct ReloWorkList: View {
    @EnvironmentObject var vm: BoringViewModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let store = ReloNotch.store
    @State private var expandedID: String? = ReloWorkList.snapshotOpened
    @State private var showsFolded = ReloWorkList.snapshotOpened != nil
    @State private var appeared = false

    /// The snapshot tool's opened card (debug builds set it to render the list with a card opened in place).
    static var snapshotOpened: String?

    /// How many cards each section shows before "+n more" (needs you always shows every card).
    static func cap(_ kind: NotchPresentation.Section.Kind) -> Int {
        switch kind {
        case .needsYou: .max
        case .waitingOnYou, .recent: 3
        case .running: 4
        case .quiet, .paused: 3
        }
    }

    /// The summary line's height and the gap under it: the list measures itself, the line is added.
    private static let summaryHeight: CGFloat = 18 + 10

    /// A live card in the list; `hero` is a question's size.
    struct LiveCard: Identifiable {
        let row: NotchPresentation.Row
        let hero: Bool
        var id: String { row.id }
    }

    /// Needs you, your turn and running, each up to its cap, in order; and how many were left out.
    static func live(_ presentation: NotchPresentation) -> (cards: [LiveCard], more: Int) {
        let sections = presentation.sections.filter { [.needsYou, .waitingOnYou, .running].contains($0.kind) }
        let cards = sections.flatMap { section in section.rows.prefix(cap(section.kind)).map { LiveCard(row: $0, hero: section.kind == .needsYou) } }
        return (cards, sections.reduce(0) { $0 + max(0, $1.rows.count - cap($1.kind)) })
    }

    var body: some View {
        let presentation = store.presentation
        let offline = store.connection == .offline
        let live = Self.live(presentation)
        let recent = presentation.sections.first { $0.kind == .recent }
        let folded = presentation.sections.filter(\.isFolded)
        VStack(alignment: .leading, spacing: 10) {
            ReloSummaryBar(tally: presentation.tally, recap: presentation.sinceYouLooked, offline: offline,
                           lock: presentation.hasUnreadable && store.waitingComputers.isEmpty)
            ScrollView(.vertical, showsIndicators: false) {
                VStack(alignment: .leading, spacing: ReloCardMetrics.sectionSpacing) {
                    if !store.waitingComputers.isEmpty {
                        ReloWaitingComputers(computers: store.waitingComputers,
                                             approve: { id in Task { await store.approveComputer(id: id) } },
                                             decline: { id in store.declineComputer(id: id) })
                    }
                    if !live.cards.isEmpty {
                        VStack(spacing: ReloCardMetrics.itemSpacing) {
                            ForEach(Array(live.cards.enumerated()), id: \.element.id) { index, item in
                                card(item.row, hero: item.hero, offline: offline)
                                    .reloListEntrance(index, appeared)
                                    .transition(cardTransition)
                            }
                            if live.more > 0 { ReloMoreLine(count: live.more) }
                        }
                    }
                    if let recent {
                        rowGroup(Array(recent.rows.prefix(Self.cap(.recent))), offline: offline)
                            .reloListEntrance(live.cards.count, appeared)
                            .transition(cardTransition)
                    }
                    if !folded.isEmpty { foldedView(folded, offline: offline) }
                    if !presentation.shownMachines.isEmpty {
                        ReloCardGroup(items: Array(presentation.shownMachines.prefix(4))) { ReloMachineRow(machine: $0) }
                            .transition(.opacity)
                    }
                }
                .padding(.bottom, 8)
                .measuresReloHeight()
                .animation(motion, value: presentation)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .onPreferenceChange(ReloContentHeight.self) { height in fit(height + Self.summaryHeight) }
        .onAppear { appeared = true }
        .padding(.top, 2)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    /// Cards rise in and fade on `snappy`; leaving runs faster (about 0.7 of the entrance) and shrinks a touch.
    /// Reduce Motion keeps the fades.
    private var cardTransition: AnyTransition {
        reduceMotion ? .opacity : .asymmetric(
            insertion: .opacity.combined(with: .offset(y: 8)),
            removal: .opacity.combined(with: .scale(scale: 0.97, anchor: .top)).animation(ReloMotion.fast))
    }

    private var motion: Animation { ReloMotion.or(ReloMotion.snappy, reduced: reduceMotion) }

    /// The notch grows to fit the list, from a compact height up to the tallest it opens; past that, the list scrolls.
    /// The header, paddings and the notch's own top add 58 pt.
    private func fit(_ content: CGFloat) {
        let height = min(reloOpenNotchSize.height, max(170, (content + 58).rounded()))
        guard abs(height - reloOpenHeight) > 1 else { return }
        reloOpenHeight = height
        guard vm.notchState == .open, BoringViewCoordinator.shared.currentView == .relo else { return }
        withAnimation(motion) { vm.notchSize = openNotchSize(for: .relo) }
    }

    private func card(_ row: NotchPresentation.Row, hero: Bool = false, offline: Bool, dimmed: Bool = false) -> some View {
        ReloWorkCard(row: row, hero: hero, expanded: expandedID == row.id, offline: offline, dimmed: dimmed) { toggle(row.id) }
    }

    /// A row of a group opened into its card: the group already draws the surface, so the card draws none of its own.
    private func groupedCard(_ row: NotchPresentation.Row, offline: Bool, dimmed: Bool) -> some View {
        ReloWorkCard(row: row, expanded: expandedID == row.id, offline: offline, dimmed: dimmed, grouped: true) { toggle(row.id) }
    }

    /// Finished, quiet or paused work: one-line rows on one surface; a clicked row opens into its card in place.
    private func rowGroup(_ rows: [NotchPresentation.Row], offline: Bool, dimmed: Bool = false) -> some View {
        ReloCardGroup(items: rows) { row in
            if expandedID == row.id {
                groupedCard(row, offline: offline, dimmed: dimmed).transition(.opacity)
            } else {
                ReloCompactRow(row: row) { toggle(row.id) }.opacity(dimmed ? 0.7 : 1).transition(.opacity)
            }
        }
    }

    private func toggle(_ id: String) {
        ReloCuePlayer.shared.play(expandedID == id ? .collapse : .expand)
        withAnimation(motion) { expandedID = expandedID == id ? nil : id }
    }

    /// Quiet and paused work stays folded under one line, the moon line: Quiet's moon breathing slowly, the counts, when
    /// the freshest of them last moved, and Show or Hide; opened, their rows.
    @ViewBuilder
    private func foldedView(_ sections: [NotchPresentation.Section], offline: Bool) -> some View {
        VStack(alignment: .leading, spacing: ReloCardMetrics.itemSpacing) {
            Button {
                withAnimation(motion) { showsFolded.toggle() }
            } label: {
                ReloQuietLine(sections: sections, open: showsFolded)
            }
            .buttonStyle(ReloLinkButtonStyle())
            .accessibilityLabel("\(sections.reduce(0) { $0 + $1.rows.count }) quiet or paused, \(showsFolded ? "hide" : "show")")
            if showsFolded {
                rowGroup(sections.flatMap { Array($0.rows.prefix(Self.cap($0.kind))) }, offline: offline, dimmed: true)
                    .transition(reduceMotion ? .opacity : .opacity.combined(with: .offset(y: -6)))
            }
        }
    }
}

/// The folded line under the live work: the moon (paused only: the pause sign) breathing in slate, "3 quiet · 1 paused",
/// when the freshest of them last moved, then Show or Hide and the chevron. Reduce Motion keeps the moon still.
struct ReloQuietLine: View {
    let sections: [NotchPresentation.Section]
    let open: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let rows = sections.flatMap(\.rows)
        let onlyPaused = sections.allSatisfy { $0.kind == .paused }
        HStack(spacing: 7) {
            Image(systemName: onlyPaused ? "pause.fill" : "moon.fill")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(ReloNotchTheme.info)
                .phaseAnimator(reduceMotion ? [1.0] : [0.45, 0.9]) { view, value in view.opacity(value) } animation: { _ in
                    .easeInOut(duration: 2.25)
                }
                .frame(width: 13)
            Text(counts).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(.white.opacity(0.75))
            if let last = rows.map(\.movedAt).max() {
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    Text("· last moved \(Self.ago(last, now: context.date))")
                        .font(.system(size: 11))
                        .foregroundStyle(ReloNotchTheme.tertiaryText)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 6)
            Text(open ? "Hide" : "Show").font(ReloCardMetrics.meta).foregroundStyle(ReloNotchTheme.tertiaryText)
                .contentTransition(.opacity)
            Image(systemName: "chevron.right")
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(ReloNotchTheme.tertiaryText)
                .rotationEffect(.degrees(open ? 90 : 0))
        }
        .frame(height: 22)
        .padding(.horizontal, 2)
        .contentShape(Rectangle())
    }

    private var counts: String {
        sections.map { "\($0.rows.count) \($0.kind == .paused ? "paused" : "quiet")" }.joined(separator: " · ")
    }

    /// "just now", "18 min ago", "2 h ago", "3 d ago": the age the eye needs, not a timer.
    static func ago(_ date: Date, now: Date) -> String {
        let minutes = Int(now.timeIntervalSince(date) / 60)
        if minutes < 1 { return "just now" }
        if minutes < 60 { return "\(minutes) min ago" }
        if minutes < 48 * 60 { return "\(minutes / 60) h ago" }
        return "\(minutes / 1440) d ago"
    }
}

/// The list's summary in one line: each state's count in its colour and symbol, in the order that matters. When the
/// line runs out of room it drops the words, then the least urgent counts (folded into "+n"), and never wraps.
/// Offline, or private work waiting for this Mac's approval, sits on the right as one capsule.
private struct ReloSummaryBar: View {
    let tally: [NotchPresentation.TallyEntry]
    let recap: String?
    let offline: Bool
    let lock: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 8) {
            ViewThatFits(in: .horizontal) {
                counts(words: .all)
                counts(words: .urgent)
                counts(words: .none)
                counts(words: .none, limit: 4)
                counts(words: .none, limit: 2)
            }
            .layoutPriority(1)
            Spacer(minLength: 0)
            if offline {
                // Offline the list is the last thing heard, and says when.
                capsule(LocalMode.offlineSymbol(local: ReloNotch.store.isLocal),
                        "\(LocalMode.offlineLabel(local: ReloNotch.store.isLocal)) · \(NotchPresentation.asOf(ReloNotch.store.lastUpdated))",
                        ReloNotchTheme.warning)
            } else if lock && !ReloNotch.store.isLocal {
                capsule("lock.fill", "Approve this Mac on your iPhone", ReloNotchTheme.warning)
            }
        }
        .frame(height: 18)
        .animation(ReloMotion.or(ReloMotion.snappy, reduced: reduceMotion), value: tally)
        .help(recap.map { "Since you looked: \($0)" } ?? "")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(tally.map { "\($0.count) \($0.label)" }.joined(separator: ", "))
    }

    private enum Words { case all, urgent, none }

    private func counts(words: Words, limit: Int = .max) -> some View {
        let shown = Array(tally.prefix(limit))
        let rest = tally.dropFirst(limit).reduce(0) { $0 + $1.count }
        return HStack(spacing: 12) {
            ForEach(shown) { entry in
                ReloSummaryCount(entry: entry, worded: words == .all || (words == .urgent && entry.kind == .needsYou))
                    .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.8)))
            }
            if rest > 0 {
                Text("+\(rest)")
                    .font(.system(size: 11, weight: .semibold).monospacedDigit())
                    .foregroundStyle(ReloNotchTheme.tertiaryText)
            }
        }
        .lineLimit(1)
        .fixedSize()
    }

    private func capsule(_ symbol: String, _ text: String, _ color: Color) -> some View {
        Label(text, systemImage: symbol)
            .font(.system(size: 10.5, weight: .medium))
            .foregroundStyle(color)
            .lineLimit(1)
            .padding(.horizontal, 8).padding(.vertical, 2)
            .background(Capsule().fill(color.opacity(0.12)))
            .fixedSize()
    }
}

/// One count of the summary: the state's symbol and number in its colour, its word after it when there is room.
private struct ReloSummaryCount: View {
    let entry: NotchPresentation.TallyEntry
    let worded: Bool

    var body: some View {
        let color = ReloNotchTheme.color(entry.tone)
        HStack(spacing: 4) {
            Image(systemName: ReloNotchTheme.symbol(entry.tone))
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(color)
            Text("\(entry.count)")
                .font(.system(size: 11, weight: .semibold).monospacedDigit())
                .foregroundStyle(color)
                .contentTransition(.numericText(value: Double(entry.count)))
            if worded {
                Text(entry.label)
                    .font(.system(size: 11))
                    .foregroundStyle(ReloNotchTheme.secondaryText)
            }
        }
    }
}

private struct ReloMoreLine: View {
    let count: Int
    private let store = ReloNotch.store

    var body: some View {
        Button {
            if store.isLocal { ReloHomeWindowController.shared.show() }
            else if let url = store.dashboardURL { NSWorkspace.shared.open(url) }
        } label: {
            Text(store.isLocal ? "+\(count) more" : "+\(count) more · Dashboard")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(ReloNotchTheme.tertiaryText)
        }
        .buttonStyle(ReloLinkButtonStyle())
    }
}

/// Answers the owner can give from the notch: approve or deny, yes or no, or one of a choice's options.
/// Free-text replies go to the iPhone or the Dashboard. Offline, nothing is sent (never queued).
struct ReloAnswerBar: View {
    let notificationID: String
    let question: ReloNotchStore.Question?
    let offline: Bool
    private let store = ReloNotch.store

    var body: some View {
        let phase = store.answers[notificationID]
        HStack(spacing: 6) {
            if offline {
                Label(LocalMode.offlineAnswer(local: store.isLocal), systemImage: LocalMode.offlineSymbol(local: store.isLocal))
                    .font(.system(size: 11))
                    .foregroundStyle(ReloNotchTheme.yellow)
            } else {
                switch phase {
                case .sending:
                    ProgressView().controlSize(.mini)
                    Text("Sending…").font(.system(size: 11)).foregroundStyle(ReloNotchTheme.secondaryText)
                case .accepted:
                    Label("Sent", systemImage: "checkmark.circle.fill")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(ReloNotchTheme.mint)
                case .failed(let message):
                    Label(message, systemImage: "exclamationmark.triangle.fill")
                        .font(.system(size: 11))
                        .foregroundStyle(ReloNotchTheme.yellow)
                        .lineLimit(1)
                    buttons
                case nil:
                    buttons
                }
            }
        }
        .animation(.smooth, value: phase)
    }

    @ViewBuilder
    private var buttons: some View {
        switch question?.kind {
        case .approval:
            // Relo on this Mac has nothing to approve: the same two answers read Yes and No.
            answer(store.isLocal ? "Yes" : "Approve", .approve, prominent: true)
            answer(store.isLocal ? "No" : "Deny", .deny)
        case .yesNo:
            answer("Yes", .yes, prominent: true)
            answer("No", .no)
        case .choice:
            ForEach(question?.options ?? []) { option in
                Button(option.label) { Task { await store.answer(notificationID: notificationID, action: .choose, optionID: option.id) } }
                    .buttonStyle(ReloPillButtonStyle(prominent: false))
            }
        case .text:
            Text(LocalMode.textReply(local: store.isLocal)).font(.system(size: 11)).foregroundStyle(ReloNotchTheme.secondaryText)
            ReloDashboardLink(compact: true)
        case nil:
            ProgressView().controlSize(.mini)
        }
    }

    private func answer(_ title: String, _ action: NotificationInteractionAction, prominent: Bool = false) -> some View {
        Button(title) { Task { await store.answer(notificationID: notificationID, action: action) } }
            .buttonStyle(ReloPillButtonStyle(prominent: prominent))
    }
}

struct ReloPillButtonStyle: ButtonStyle {
    var prominent: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 11, weight: .semibold))
            .lineLimit(1)
            .padding(.horizontal, 10)
            .padding(.vertical, 3)
            .foregroundStyle(prominent ? Color.black : Color.white)
            .background(
                Capsule().fill(prominent ? ReloNotchTheme.signalCoral : Color.white.opacity(0.14))
            )
            .opacity(configuration.isPressed ? 0.7 : 1)
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .animation(ReloMotion.press, value: configuration.isPressed)
            .contentShape(Capsule())
    }
}

/// What the owner opened or folded in a card's plan. It lives on the card, so the visible card and the hidden copy that
/// measures its open height draw the same plan.
struct ReloPlanState: Equatable {
    var openedRounds: Set<Int> = []
    var openedSteps: Set<String> = []
    var expandedFolds: Set<String> = []
    var earlierExpanded = false
}

/// The plan's grid (the Round Deck study, at the card's density): every step, delivered round and round heading shares
/// four columns (mark, text, time, chevron), so marks, names, times and chevrons line up down the whole plan.
enum ReloPlanMetrics {
    static let mark: CGFloat = 12
    static let gap: CGFloat = 8
    static let meta: CGFloat = 46
    static let chevron: CGFloat = 10
    /// An 11.5 pt line as SwiftUI sets it; marks, times and chevrons centre on it.
    static let line: CGFloat = 14
    static let rowPad: CGFloat = 5
    /// Padding inside a delivered round and the round in progress, measured to the text.
    static let pane: CGFloat = 10
    static let deckSpacing: CGFloat = 10
    static var markTop: CGFloat { (line - mark) / 2 }
    static var indent: CGFloat { mark + gap }
    /// The rail runs from a mark's edge to the next mark's edge: it joins the dots.
    static let label = Font.system(size: 11.5)
    static let detail = Font.system(size: 10.5)
    static let meta10 = Font.system(size: 10).monospacedDigit()
}

/// The plan, opened, as a deck (the Round Deck study, approved 22 Oct): delivered rounds stack as slabs with their
/// outcome; the round in progress is one panel whose heading shares the marks' edge; one rail joins each step's mark to
/// the next; only the step being worked moves (a ripple on its mark, light through its name). Built on `PlanOutline`,
/// so folding, windowing ("5 done", "6 to go") and skipped steps read as on the iPhone. States come from the server.
struct ReloPlanSteps: View {
    let row: NotchPresentation.Row
    let color: Color
    @Binding var state: ReloPlanState
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if let outline = row.outline.map({ row.tone.isStopped ? $0.unskipped() : $0 }) {
            let ctx = ReloPlanContext(outline: outline, state: $state, finished: row.tone == .done,
                                      working: row.tone == .working, reduceMotion: reduceMotion)
            if outline.hasRoundSections {
                VStack(alignment: .leading, spacing: ReloPlanMetrics.deckSpacing) {
                    ForEach(outline.roundSlots(earlierExpanded: state.earlierExpanded)) { slot in
                        switch slot {
                        case let .earlier(count):
                            ReloEarlierRounds(count: count) { ctx.change { $0.earlierExpanded = true } }
                        case let .round(round):
                            if round.closed {
                                ReloRoundSlab(round: round, ctx: ctx)
                            } else {
                                ReloRoundPanel(round: round, ctx: ctx)
                            }
                        }
                    }
                }
            } else if let round = outline.rounds.first {
                ReloPlanItems(items: ctx.items(round), ctx: ctx)
            }
        } else if let status = row.status {
            Text(status).font(.system(size: 11)).foregroundStyle(ReloNotchTheme.secondaryText)
        }
    }
}

/// What the plan's parts need from the card: the outline, what the owner opened, and how the work stands.
struct ReloPlanContext {
    let outline: PlanOutline
    let state: Binding<ReloPlanState>
    /// The work is done: finished marks and rails turn green instead of the running gradient.
    let finished: Bool
    /// The work is moving: only then does the current step pulse and shimmer.
    let working: Bool
    let reduceMotion: Bool

    func items(_ round: PlanOutline.Round) -> [PlanOutline.Item] {
        outline.items(in: round, expandedFolds: state.wrappedValue.expandedFolds, openedSteps: state.wrappedValue.openedSteps)
    }

    func change(_ edit: (inout ReloPlanState) -> Void) {
        withAnimation(ReloMotion.or(ReloMotion.smooth, reduced: reduceMotion)) { edit(&state.wrappedValue) }
    }
}

/// One level of steps: each draws its rail to the next; a fold row stands for steps not listed.
struct ReloPlanItems: View {
    let items: [PlanOutline.Item]
    let ctx: ReloPlanContext

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                let last = index == items.count - 1
                switch item {
                case let .branch(branch):
                    ReloPlanBranch(branch: branch, ctx: ctx)
                        .reloPlanRail(!last, tinted: branch.node.state == .complete, finished: ctx.finished, reduceMotion: ctx.reduceMotion)
                case let .fold(fold):
                    Button { ctx.change { $0.expandedFolds.insert(fold.id) } } label: {
                        ReloPlanRow(mark: { ReloPlanMark(kind: .fold) }) {
                            Text(fold.text).font(ReloPlanMetrics.detail).foregroundStyle(ReloNotchTheme.tertiaryText)
                        }
                    }
                    .buttonStyle(ReloPlanRowButtonStyle())
                    .accessibilityLabel("\(fold.text), hidden")
                    .accessibilityHint("Shows them")
                    .reloPlanRail(!last, tinted: fold.kind == .done, finished: ctx.finished, reduceMotion: ctx.reduceMotion)
                }
            }
        }
    }
}

/// A step and, opened, the steps under it (indented to its name). The current phase opens itself; others open on a click.
struct ReloPlanBranch: View {
    let branch: PlanOutline.Branch
    let ctx: ReloPlanContext

    private var node: PlanOutline.Node { branch.node }
    private var leafNow: Bool { node.state == .current && !node.hasChildren }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if node.hasChildren && node.state != .current {
                Button { ctx.change { $0.openedSteps.formSymmetricDifference([node.id]) } } label: { row }
                    .buttonStyle(ReloPlanRowButtonStyle())
                    .accessibilityHint(branch.opened ? "Hides its steps" : "Shows its steps")
            } else {
                row
            }
            if branch.opened, !branch.children.isEmpty {
                ReloPlanItems(items: branch.children, ctx: ctx)
                    .padding(.leading, ReloPlanMetrics.indent)
                    .transition(.opacity)
            }
        }
    }

    private var row: some View {
        ReloPlanRow(
            mark: {
                ReloPlanMark(kind: ReloPlanMark.Kind(node.state), finished: ctx.finished, parent: node.hasChildren,
                             pulse: leafNow && ctx.working)
            },
            text: {
                VStack(alignment: .leading, spacing: 1) {
                    ReloPlanLabel(text: node.readable ? node.label : "Not readable on this Mac", node: node,
                                  shine: leafNow && ctx.working)
                    if leafNow, let detail = node.detail {
                        Text(detail)
                            .font(ReloPlanMetrics.detail)
                            .foregroundStyle(ReloNotchTheme.tertiaryText)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                            .transition(.opacity)
                    }
                }
            },
            meta: { meta },
            chevron: node.hasChildren && node.state != .current ? (branch.opened ? .open : .closed) : nil)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var meta: some View {
        if let count = branch.count {
            Text("\(count.done)/\(count.total)")
                .font(.system(size: 9.5).monospacedDigit())
                .foregroundStyle(node.state == .current ? ReloNotchTheme.runningSoft : ReloNotchTheme.tertiaryText)
                .padding(.horizontal, 5)
                .frame(height: 14)
                .background(Capsule().fill(node.state == .current ? ReloNotchTheme.running.opacity(0.16) : Color.white.opacity(0.06)))
        } else if leafNow, let started = node.startedAt, Date().timeIntervalSince(started) < 3600 {
            Text(started, style: .timer).font(ReloPlanMetrics.meta10).foregroundStyle(ReloNotchTheme.runningSoft)
        } else if node.state == .complete, let duration = PlanOutline.durationLabel(node.duration) {
            Text(duration).font(ReloPlanMetrics.meta10).foregroundStyle(ReloNotchTheme.tertiaryText)
        }
    }
}

/// A step's name: the current one bold with light passing through it, done ones quiet, a phase a little heavier.
struct ReloPlanLabel: View {
    let text: String
    let node: PlanOutline.Node
    var shine = false

    var body: some View {
        let label = Text(text)
            .font(ReloPlanMetrics.label.weight(node.state == .current ? .semibold : (node.hasChildren ? .medium : .regular)))
            .italic(!node.readable)
            .lineLimit(2)
            .fixedSize(horizontal: false, vertical: true)
        label
            .foregroundStyle(color)
            .overlay { ReloTextShine(active: shine, mask: AnyView(label), maskKey: text) }
    }

    private var color: Color {
        switch node.state {
        case .current: .white
        case .complete, .skipped: ReloNotchTheme.tertiaryText
        case .pending: node.hasChildren ? .white.opacity(0.78) : ReloNotchTheme.secondaryText
        }
    }
}

/// Light passing through the name of the step being worked (text only): a violet-to-ice band moving left to right,
/// as reading goes, every 3.2 s.
struct ReloTextShine: View {
    let active: Bool
    /// The text it passes through, and what that text says (a new text redraws the mask).
    var mask: AnyView?
    var maskKey = ""
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if active && !reduceMotion {
            ReloLoopView(key: maskKey, mask: mask) { root, size in
                let band = CAGradientLayer()
                band.frame = CGRect(origin: .zero, size: size)
                band.colors = [ReloLoop.cgColor(.clear), ReloLoop.cgColor(ReloNotchTheme.runningSoft), ReloLoop.cgColor(ReloNotchTheme.ice),
                               ReloLoop.cgColor(.clear)]
                band.locations = [0, 0.42, 0.58, 1]
                let cycle = 3.2
                let phase = { (time: Double) in -0.3 + time / cycle * 1.6 }
                band.add(ReloLoop.animation("startPoint", period: cycle) { NSValue(point: NSPoint(x: phase($0) - 0.22, y: 0.5)) }, forKey: "start")
                band.add(ReloLoop.animation("endPoint", period: cycle) { NSValue(point: NSPoint(x: phase($0) + 0.22, y: 0.5)) }, forKey: "end")
                root.addSublayer(band)
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }
}

/// The four columns: mark, text, time, chevron.
struct ReloPlanRow<Mark: View, Content: View, Meta: View>: View {
    enum Chevron { case open, closed }

    @ViewBuilder let mark: () -> Mark
    @ViewBuilder let text: () -> Content
    @ViewBuilder var meta: () -> Meta
    var chevron: Chevron?

    init(@ViewBuilder mark: @escaping () -> Mark, @ViewBuilder text: @escaping () -> Content,
         @ViewBuilder meta: @escaping () -> Meta, chevron: Chevron? = nil) {
        self.mark = mark; self.text = text; self.meta = meta; self.chevron = chevron
    }

    var body: some View {
        HStack(alignment: .top, spacing: ReloPlanMetrics.gap) {
            mark()
                .frame(width: ReloPlanMetrics.mark, height: ReloPlanMetrics.mark)
                .padding(.top, ReloPlanMetrics.markTop)
            text().frame(maxWidth: .infinity, alignment: .leading)
            meta().frame(width: ReloPlanMetrics.meta, height: ReloPlanMetrics.line, alignment: .trailing)
            Image(systemName: "chevron.right")
                .font(.system(size: 7.5, weight: .bold))
                .foregroundStyle(ReloNotchTheme.tertiaryText)
                .rotationEffect(.degrees(chevron == .open ? 90 : 0))
                .opacity(chevron == nil ? 0 : 1)
                .frame(width: ReloPlanMetrics.chevron, height: ReloPlanMetrics.line)
        }
        .padding(.vertical, ReloPlanMetrics.rowPad)
        .contentShape(Rectangle())
    }
}

extension ReloPlanRow where Meta == EmptyView {
    init(@ViewBuilder mark: @escaping () -> Mark, @ViewBuilder text: @escaping () -> Content) {
        self.init(mark: mark, text: text, meta: { EmptyView() })
    }
}

/// Rows that open something dim a little while pressed and brighten their chevron on hover.
struct ReloPlanRowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.6 : 1)
            .animation(ReloMotion.press, value: configuration.isPressed)
    }
}

/// A step's mark. Shape carries the state: a filled check, a ring with a dot (and a ripple while worked), an empty ring,
/// a dashed ring, a green check for a delivered round, dots for steps not listed.
struct ReloPlanMark: View {
    enum Kind: Equatable {
        case done, current, open, skipped, roundDone, fold

        init(_ state: PlanOutline.State) {
            switch state {
            case .complete: self = .done
            case .current: self = .current
            case .skipped: self = .skipped
            case .pending: self = .open
            }
        }
    }

    let kind: Kind
    var finished = false
    var parent = false
    var pulse = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            if pulse { ReloPlanRipple() }
            switch kind {
            case .done:
                Circle().fill(finished ? AnyShapeStyle(ReloNotchTheme.done) : AnyShapeStyle(ReloNotchTheme.holo))
                    .overlay(ReloPlanTick().stroke(Color.black.opacity(0.82), style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round)))
                    .transition(.scale(scale: 0.6).combined(with: .opacity))
            case .current:
                Circle().strokeBorder(ReloNotchTheme.running, lineWidth: 1.5)
                    .overlay(Circle().fill(ReloNotchTheme.running).frame(width: parent ? 3 : 5, height: parent ? 3 : 5))
                    .transition(.opacity)
            case .open:
                Circle().strokeBorder(Color.white.opacity(0.28), lineWidth: 1.25)
            case .skipped:
                Circle().strokeBorder(Color.white.opacity(0.28), style: StrokeStyle(lineWidth: 1.25, dash: [2, 2]))
            case .roundDone:
                Circle().fill(ReloNotchTheme.done.opacity(0.16))
                    .overlay(ReloPlanTick().stroke(ReloNotchTheme.done, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round)))
            case .fold:
                Circle().strokeBorder(Color.white.opacity(0.22), style: StrokeStyle(lineWidth: 1, dash: [1.5, 2]))
                    .overlay(Image(systemName: "ellipsis").font(.system(size: 5.5, weight: .bold)).foregroundStyle(ReloNotchTheme.tertiaryText))
            }
        }
        .animation(ReloMotion.or(ReloMotion.bouncy, reduced: reduceMotion), value: kind)
        .accessibilityHidden(true)
    }
}

/// The check inside a done mark: a thin drawn tick, as the iPhone and the study draw it (not a heavy symbol).
struct ReloPlanTick: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX + rect.width * 0.29, y: rect.minY + rect.height * 0.53))
        path.addLine(to: CGPoint(x: rect.minX + rect.width * 0.44, y: rect.minY + rect.height * 0.68))
        path.addLine(to: CGPoint(x: rect.minX + rect.width * 0.73, y: rect.minY + rect.height * 0.36))
        return path
    }
}

/// The ripple on the current step's mark: a ring that grows to 2.4× and fades every 1.8 s, after a short beat so it
/// starts once the mark has settled. With Reduce Motion it is a still halo.
struct ReloPlanRipple: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        // After a short beat, so it starts once the mark has settled; time carries on from where a pause held it.
        Group {
            if reduceMotion {
                Circle().stroke(ReloNotchTheme.running.opacity(0.4), lineWidth: 1.25).scaleEffect(1.45)
            } else {
                ReloLoopView(key: 0) { root, size in
                    let ring = ReloLoop.ring(CGRect(origin: .zero, size: size), color: ReloNotchTheme.running, lineWidth: 1.25, inset: false)
                    ring.add(ReloLoop.animation("transform.scale", period: 1.8, delay: 0.25) { 1 + 1.4 * ReloEase.ripple($0, 1.8) },
                             forKey: "scale")
                    ring.add(ReloLoop.animation("opacity", period: 1.8, delay: 0.25) { 0.7 * (1 - ReloEase.ripple($0, 1.8)) },
                             forKey: "opacity")
                    root.addSublayer(ring)
                }
            }
        }
        .allowsHitTesting(false)
    }
}

/// The line from a step's mark to the next one's, a little apart from both marks; it fills top-down with the running
/// gradient (green for finished work) once the step is done.
struct ReloPlanRail: View {
    let tinted: Bool
    let finished: Bool
    let reduceMotion: Bool

    var body: some View {
        Capsule().fill(Color.white.opacity(0.13))
            .overlay(alignment: .top) {
                Capsule().fill(finished ? AnyShapeStyle(ReloNotchTheme.done.opacity(0.7)) : AnyShapeStyle(ReloNotchTheme.holoDown))
                    .scaleEffect(x: 1, y: tinted ? 1 : 0.0001, anchor: .top)
                    .animation(reduceMotion ? nil : .easeInOut(duration: 0.55), value: tinted)
            }
            .frame(width: 1.5)
    }
}

extension View {
    /// Draws the rail from this item's mark to the next sibling's, running past its opened steps.
    func reloPlanRail(_ show: Bool, tinted: Bool, finished: Bool, reduceMotion: Bool) -> some View {
        let m = ReloPlanMetrics.self
        return background(alignment: .topLeading) {
            if show {
                ReloPlanRail(tinted: tinted, finished: finished, reduceMotion: reduceMotion)
                    .padding(.top, m.rowPad + m.markTop + m.mark)
                    .padding(.bottom, -(m.rowPad + m.markTop))
                    .padding(.leading, m.mark / 2 - 0.75)
            }
        }
    }
}

/// A delivered round: one card with its outcome; a click opens its steps inside it.
struct ReloRoundSlab: View {
    let round: PlanOutline.Round
    let ctx: ReloPlanContext

    private var open: Bool { ctx.state.wrappedValue.openedRounds.contains(round.n) }

    var body: some View {
        let m = ReloPlanMetrics.self
        VStack(alignment: .leading, spacing: 0) {
            Button { ctx.change { $0.openedRounds.formSymmetricDifference([round.n]) } } label: {
                ReloPlanRow(
                    mark: { ReloPlanMark(kind: .roundDone) },
                    text: {
                        VStack(alignment: .leading, spacing: 0) {
                            (Text("Round \(round.n)").fontWeight(.semibold).foregroundColor(.white.opacity(0.82))
                             + Text(round.title.map { " · \($0)" } ?? "").fontWeight(.medium).foregroundColor(ReloNotchTheme.secondaryText))
                                .font(ReloPlanMetrics.label)
                                .lineLimit(open ? 2 : 1)
                            if let outcome = round.outcome {
                                Text(outcome)
                                    .font(ReloPlanMetrics.detail)
                                    .foregroundStyle(ReloNotchTheme.tertiaryText)
                                    .lineLimit(open ? 4 : 1)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    },
                    meta: {
                        if let duration = PlanOutline.durationLabel(round.duration) {
                            Text(duration).font(m.meta10).foregroundStyle(ReloNotchTheme.tertiaryText)
                        }
                    },
                    chevron: open ? .open : .closed)
                .padding(.horizontal, m.pane)
                .padding(.vertical, m.pane - m.rowPad)
            }
            .buttonStyle(ReloPlanRowButtonStyle())
            .accessibilityLabel("Round \(round.n), delivered\(round.outcome.map { ", \($0)" } ?? "")")
            .accessibilityHint(open ? "Hides its steps" : "Shows its steps")
            if open {
                ReloPlanItems(items: ctx.items(round), ctx: ctx)
                    .padding(.horizontal, m.pane)
                    .padding(.bottom, m.pane - m.rowPad)
                    .transition(.opacity)
            }
        }
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.white.opacity(0.05)))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Color.white.opacity(0.08)))
    }
}

/// "3 earlier rounds": rounds before the last two, folded into one quiet slab.
struct ReloEarlierRounds: View {
    let count: Int
    let expand: () -> Void

    var body: some View {
        Button(action: expand) {
            ReloPlanRow(mark: { ReloPlanMark(kind: .fold) }) {
                Text("\(count) earlier rounds").font(ReloPlanMetrics.detail).foregroundStyle(ReloNotchTheme.tertiaryText)
            }
            .padding(.horizontal, ReloPlanMetrics.pane)
            .padding(.vertical, ReloPlanMetrics.pane - ReloPlanMetrics.rowPad)
        }
        .buttonStyle(ReloPlanRowButtonStyle())
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Color.white.opacity(0.08), style: StrokeStyle(lineWidth: 1, dash: [3, 3])))
        .accessibilityHint("Shows them")
    }
}

/// The round in progress: one panel; its heading starts at the marks' edge, its steps below.
struct ReloRoundPanel: View {
    let round: PlanOutline.Round
    let ctx: ReloPlanContext

    var body: some View {
        let m = ReloPlanMetrics.self
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 1) {
                Text("Round \(round.n) · \(ctx.working ? "in progress" : "open")".uppercased())
                    .font(.system(size: 9, weight: .semibold))
                    .tracking(0.7)
                    .foregroundStyle(ReloNotchTheme.runningSoft)
                if let title = round.title {
                    Text(title)
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundStyle(.white)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.trailing, m.meta + m.chevron + m.gap * 2)
            .padding(.bottom, m.pane - m.rowPad * 2)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            ReloPlanItems(items: ctx.items(round), ctx: ctx)
        }
        .padding(.horizontal, m.pane)
        .padding(.top, m.pane)
        .padding(.bottom, m.pane - m.rowPad)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(ReloNotchTheme.running.opacity(0.07)))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(ReloNotchTheme.running.opacity(0.18)))
    }
}

/// Opens the Dashboard on the owner's server: history, text replies, everything the notch leaves out.
struct ReloDashboardLink: View {
    var compact = false
    private let store = ReloNotch.store

    var body: some View {
        if !store.isLocal, let url = store.dashboardURL {
            Button {
                NSWorkspace.shared.open(url)
            } label: {
                Label(compact ? "Dashboard" : "Open Dashboard", systemImage: "arrow.up.right.square")
                    .font(.system(size: compact ? 11 : 10, weight: .medium))
            }
            .buttonStyle(compact ? AnyButtonStyle(ReloPillButtonStyle(prominent: false)) : AnyButtonStyle(ReloLinkButtonStyle()))
            .foregroundStyle(ReloNotchTheme.secondaryText)
        }
    }
}

/// A bare text link that dims while pressed.
struct ReloLinkButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.6 : 1).contentShape(Rectangle())
    }
}

/// Type-erases the two button looks the link uses.
struct AnyButtonStyle: ButtonStyle {
    private let make: (Configuration) -> AnyView
    init<S: ButtonStyle>(_ style: S) { make = { AnyView(style.makeBody(configuration: $0)) } }
    func makeBody(configuration: Configuration) -> some View { make(configuration) }
}

/// Computers of the account this Mac does not trust yet. Approving one here opens its cards on this Mac, and on every
/// other trusted device too (docs/ENCRYPTION-PROTOCOL.md, "Computers are approved once").
struct ReloWaitingComputers: View {
    let computers: [ReloNotchStore.WaitingComputer]
    let approve: (String) -> Void
    let decline: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(computers) { computer in
                HStack(spacing: 8) {
                    Image(systemName: "lock.desktopcomputer")
                        .foregroundStyle(ReloNotchTheme.yellow)
                    Text("\(computer.name) wants to show its cards here")
                        .font(.system(size: 11))
                        .foregroundStyle(ReloNotchTheme.yellow)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Button("Decline") { decline(computer.id) }
                        .buttonStyle(ReloLinkButtonStyle())
                        .font(.system(size: 11))
                        .foregroundStyle(ReloNotchTheme.secondaryText)
                    Button("Approve") { approve(computer.id) }
                        .buttonStyle(ReloLinkButtonStyle())
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(ReloNotchTheme.yellow)
                }
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(ReloNotchTheme.yellow.opacity(0.1)))
    }
}

private struct ReloAllClear: View {
    let offline: Bool
    let connecting: Bool
    private var local: Bool { ReloNotch.store.isLocal }

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: offline ? LocalMode.offlineSymbol(local: local) : "checkmark.circle")
                .font(.system(size: 22, weight: .medium))
                .foregroundStyle(offline ? ReloNotchTheme.yellow : ReloNotchTheme.mint)
            Text(offline ? (local ? LocalMode.notAnswering : "Relo is offline")
                 : connecting ? (local ? LocalMode.starting : "Connecting to Relo…") : "Nothing needs you")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.white)
            Text(offline ? "The last state stays here until \(local ? "Relo answers" : "the server answers")." : "Running work shows up here as it starts.")
                .font(.system(size: 11))
                .foregroundStyle(ReloNotchTheme.secondaryText)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Sign-in

struct ReloSignInPanel: View {
    private let store = ReloNotch.store

    /// Signed out of a server: two plain choices, trying Relo on this Mac (no account) or signing in, and help for an
    /// owner who cannot sign in. Never a dead end: whoever cannot sign in can always just try it here.
    var body: some View {
        if store.isLocal { ReloLocalProblemView(compact: true) }
        else if ReloPendingApproval.shared.pending != nil { ReloPendingApprovalPanel(compact: true) }
        else { remote }
    }

    private var signingIn: Bool { store.connection == .signingIn }
    private var again: Bool { store.connection == .needsSignIn }
    /// Signed in before: signing in again comes first. Never signed in: trying it on this Mac does.
    private var localFirst: Bool { ReloLocalMode.canRunHere && !again }

    private var line: String {
        if signingIn { return "Finish signing in in your browser, or try Relo on this Mac meanwhile." }
        if let problem = store.problem { return problem }
        // A server was chosen but no sign-in finished: Relo on this Mac is not blocked behind it.
        if ReloLocalMode.canRunHere, store.originChosen, !again { return PendingApproval.signInLater }
        return ReloLocalMode.canRunHere ? "Try Relo on this Mac now, or sign in to see your agents on your iPhone too."
            : "Sign in to see your agents here and on your iPhone."
    }

    private var remote: some View {
        VStack(spacing: 10) {
            VStack(spacing: 3) {
                Text(again ? "Sign in to Relo again" : "Choose how to start")
                    .font(.system(size: 14, weight: .semibold)).foregroundStyle(.white)
                Text(line)
                    .font(ReloCardMetrics.status)
                    .foregroundStyle(store.problem != nil && !signingIn ? ReloNotchTheme.warning : ReloNotchTheme.secondaryText)
                    .lineLimit(2).multilineTextAlignment(.center)
            }
            HStack(spacing: 10) {
                if localFirst { tryHere }
                ReloNotchChoice(icon: "person.crop.circle", title: signingIn ? "Signing in…" : "Sign in",
                                detail: signingIn ? "Waiting for your browser" : "With your Relo account",
                                prominent: !localFirst, busy: signingIn) { ReloLocalMode.signInOrSetUp() }
                if ReloLocalMode.canRunHere && !localFirst { tryHere }
            }
            if !signingIn {
                Button("Can't sign in?") { ReloLocalMode.cantSignIn() }
                    .buttonStyle(.plain).font(.system(size: 11, weight: .medium))
                    .foregroundStyle(ReloNotchTheme.secondaryText).underline()
                    .onHover { $0 ? NSCursor.pointingHand.push() : NSCursor.pop() }
            }
        }
        .padding(.horizontal, 16)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var tryHere: some View {
        ReloNotchChoice(icon: "laptopcomputer", title: "Try it on this Mac", detail: "No account needed",
                        prominent: localFirst) { ReloLocalMode.runHere() }
    }
}

/// One of the notch's big choices: an icon, what it does and a line under it, the whole card clickable, lit on hover.
struct ReloNotchChoice: View {
    let icon: String
    let title: String
    let detail: String
    var prominent = false
    var busy = false
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Group {
                    if busy { ProgressView().controlSize(.small).tint(.white) }
                    else { Image(systemName: icon).font(.system(size: 18, weight: .medium)) }
                }
                .frame(width: 24)
                .foregroundStyle(prominent ? ReloNotchTheme.signalCoral : .white.opacity(0.85))
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(.white)
                    Text(detail).font(.system(size: 11)).foregroundStyle(ReloNotchTheme.secondaryText)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.white.opacity(hovering ? 0.7 : 0.35))
            }
            .padding(.horizontal, 12).padding(.vertical, 9)
            .frame(maxWidth: .infinity)
            .background {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(prominent ? ReloNotchTheme.signalCoral.opacity(hovering ? 0.26 : 0.18) : .white.opacity(hovering ? 0.12 : 0.07))
            }
            .overlay {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(prominent ? ReloNotchTheme.signalCoral.opacity(0.55) : .white.opacity(0.14), lineWidth: 0.5)
            }
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(ReloPressStyle())
        .disabled(busy)
        .onHover { hovering = $0 }
        .animation(ReloMotion.fast, value: hovering)
    }
}

/// Pressed: a touch smaller and dimmer.
struct ReloPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.8 : 1)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(ReloMotion.press, value: configuration.isPressed)
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
