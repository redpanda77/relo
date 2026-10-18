import ReloCore
import SwiftUI
import UIKit

// MARK: - Header

/// What it is and how it stands in three rows: where it runs with the state trailing (and its timer while it
/// runs), the title, then the latest status in its own words. Where, when and which computer live in Details
/// at the bottom. Hold the header to copy the item's ID.
struct ReloIdentityHeader: View {
    let item: InboxItem
    let title: String
    let kind: ReloMessageKind
    let status: String?
    /// The server's state for this work (Now summary); it wins over the card's own declared state.
    var serverOutcome: ReloStateStyle? = nil
    let now: Date

    private var row: HistoryRow { HistoryRowProjection.row(item, now: now) }
    /// The badge tells the truth (U4): a work that declared it waits is Waiting, never Running.
    private var waiting: Bool {
        item.isDeclaredWaiting && (serverOutcome.map { $0.label == "Running" || $0.label == "Waiting" } ?? (row.outcome == .running))
    }
    private var badge: ReloStateStyle {
        if waiting { return .waiting }
        if let serverOutcome { return serverOutcome }
        return ReloStateStyle(label: item.kind == .liveActivity ? (row.outcome.label ?? kind.label) : kind.label,
                              color: kind.color, symbol: kind.symbol)
    }
    /// Running work shows its live timer next to the badge; the system ticks it. Waiting work does not run.
    private var runningSince: Date? {
        guard !waiting, row.outcome == .running, serverOutcome == nil || serverOutcome?.label == "Running",
              let started = row.startedAt, started <= now else { return nil }
        return started
    }

    private var corner: CardCorner {
        // A badge that only repeats the type ("Message") says nothing; the timer may still stand alone.
        let showsBadge = badge.label.caseInsensitiveCompare(row.type) != .orderedSame
        switch (showsBadge, runningSince) {
        case let (true, since?): return .badgeTimer(badge, since: since)
        case (true, nil): return .badge(badge)
        case let (false, since?): return .timer(since: since)
        case (false, nil): return .none
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: ReloLayout.itemSpacing) {
            CardHeader(origin: ReloCardOrigin(source: row.source.name, sourceSymbol: row.source.systemImageName,
                                              project: row.project?.name,
                                              projectColor: ReloProjectPalette.color(for: row.project, fallback: .reloSecondaryText),
                                              topic: row.topic),
                       corner: corner)
            Text(title)
                .font(.title2.weight(.bold))
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            if let status, !status.isEmpty {
                Text(status).font(.body).foregroundStyle(Color.primary.opacity(0.86))
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .contextMenu {
            Button { UIPasteboard.general.string = item.id } label: { Label("Copy ID", systemImage: "doc.on.doc") }
        }
    }
}

// MARK: - Plan card

/// The work's plan (plan 12b): one row for rounds, steps and substeps; the header counts, the list points;
/// only the current step opens; folds keep a long plan under a screen; tapping a step opens its sheet.
/// Without a plan it falls back to one progress readout.
struct ReloMissionTimeline: View {
    let item: InboxItem
    let steps: [LiveActivityDisplayPresentation.Step]
    var window: LiveActivityDisplayPresentation.StepWindow = .whole
    /// The plan arranged in rounds and nested steps; built from `steps` when the whole plan did not arrive.
    var outline: PlanOutline? = nil
    let progress: Double?
    let status: String
    let now: Date
    /// How the work stands, from the server (the same as the badge): a paused work's plan stops at its step.
    var serverOutcome: ReloStateStyle? = nil
    /// The work declared it waits on something: its current step shows a pause (U4).
    var waiting = false
    /// The work's card updates sent while a step was current (4.6), newest first.
    var updates: (String) -> [PlanStepUpdate] = { _ in [] }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var toggledRounds: Set<Int> = []
    @State private var earlierExpanded = false
    @State private var expandedFolds: Set<String> = []
    @State private var openedSteps: Set<String> = []
    @State private var sheetStep: SheetStep?

    private struct SheetStep: Identifiable { let id: String }

    private var row: HistoryRow { HistoryRowProjection.row(item, now: now) }
    private var outcome: HistoryRow.Outcome { row.outcome }
    private var paused: Bool { serverOutcome?.label == "Paused" }
    private var quiet: Bool { serverOutcome?.label == "Quiet" }
    private var finishedWork: Bool { outcome == .done }

    private var standing: PlanProgress.Standing {
        if paused { return .paused }
        switch outcome {
        case .done: return .done
        case .stopped, .expired, .ended, .replaced: return .stopped
        default: return .moving
        }
    }

    /// The outline to draw: the whole plan, else the steps the card carries.
    private var shown: PlanOutline? {
        if let outline { return standing == .stopped ? outline.unskipped() : outline }
        guard !steps.isEmpty else { return nil }
        return PlanOutline.make(entries: steps.map {
            PlanOutline.Entry(id: $0.id, label: $0.label, state: $0.state, readable: !ReloSealedCards.isPlaceholderStep($0.label))
        }, rounds: nil)
    }

    private var header: String? {
        // The server's count whenever the card carries one; counted from the outline only without it.
        if shown != nil, let server = window.progress { return server.header(standing) }
        if let shown, let counted = outline == nil ? LiveActivityPlanDisplay.progress(LiveActivityPlanDisplay.steps(steps), window: window)
            : PlanProgress.make(outline: shown, stopped: standing == .stopped) { return counted.header(standing) }
        return nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeader
            if let shown { plan(shown) } else { progressReadout }
        }
        .padding(ReloLayout.cardInset)
        .frame(maxWidth: .infinity, alignment: .leading)
        .reloCard()
        .sheet(item: $sheetStep) { target in
            if let shown, let node = shown.node(target.id) {
                PlanStepSheet(node: node, outline: shown, mark: mark(for: node), finishedWork: finishedWork,
                              updates: updates(node.id), now: now)
            }
        }
    }

    private var sectionHeader: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(shown == nil ? "Progress" : "Plan")
                .font(.subheadline.weight(.semibold)).foregroundStyle(Color.reloSecondaryText)
            Spacer(minLength: 12)
            // The header counts, the list points (U3): never truncated.
            if let header {
                Text(header).font(.caption.weight(.semibold).monospacedDigit())
                    .foregroundStyle(Color.reloSecondaryText)
                    .multilineTextAlignment(.trailing).fixedSize(horizontal: false, vertical: true)
            }
        }
        .opacity(quiet ? 0.6 : 1)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    // MARK: Marks and context

    private func mark(for node: PlanOutline.Node) -> PlanMark {
        switch node.state {
        case .complete: return .done
        case .skipped: return .skipped
        case .pending: return .open
        case .current:
            switch outcome {
            case .running, .waitingForYou: return waiting && !paused ? .waiting : (paused ? .paused : .current)
            case .stopped: return .stopped
            default: return paused ? .paused : .open
            }
        }
    }

    private func context(_ outline: PlanOutline) -> PlanCardContext {
        PlanCardContext(
            outline: outline, finishedWork: finishedWork, indent: typeSize.isAccessibilitySize ? 12 : 30,
            markFor: { mark(for: $0) },
            timeLabel: { $0.state == .complete ? PlanOutline.durationLabel($0.duration) : nil },
            select: { sheetStep = SheetStep(id: $0.id) },
            toggleStep: { id in animated { if openedSteps.contains(id) { openedSteps.remove(id) } else { openedSteps.insert(id) } } },
            openedByOwner: openedSteps,
            expandFold: { id in animated { _ = expandedFolds.insert(id) } },
            items: { outline.items(in: $0, expandedFolds: expandedFolds, openedSteps: openedSteps) },
            toggleRound: { n in animated { if toggledRounds.contains(n) { toggledRounds.remove(n) } else { toggledRounds.insert(n) } } },
            roundFolded: { outline.startsFolded($0) != toggledRounds.contains($0.n) },
            expandEarlier: { animated { earlierExpanded = true } })
    }

    private func animated(_ change: () -> Void) {
        if reduceMotion { change() } else { withAnimation(.easeInOut(duration: 0.3), change) }
    }

    // MARK: The plan

    @ViewBuilder private func plan(_ outline: PlanOutline) -> some View {
        let ctx = context(outline)
        VStack(alignment: .leading, spacing: 0) {
            if self.outline == nil, window.before > 0 {
                hiddenRow(window.before == 1 ? "1 earlier step done" : "\(window.before) earlier steps done")
            }
            if outline.hasRoundSections {
                PlanRoundsView(slots: outline.roundSlots(earlierExpanded: earlierExpanded), ctx: ctx)
            } else if let round = outline.currentRound {
                PlanItemsView(items: ctx.items(round), ctx: ctx)
            }
            if self.outline == nil, window.after > 0 {
                hiddenRow(window.after == 1 ? "1 more step" : "\(window.after) more steps")
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.3), value: outline)
    }

    /// Steps of a longer plan that the card did not carry: counted, not listed.
    private func hiddenRow(_ text: String) -> some View {
        Text(text).font(.footnote).foregroundStyle(Color.reloSecondaryText)
            .padding(.leading, 30).padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private var progressReadout: some View {
        if let progress {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline) {
                    Text(progress, format: .percent.precision(.fractionLength(0)))
                        .font(.system(.largeTitle, design: .monospaced).weight(.semibold)).monospacedDigit()
                        .contentTransition(.numericText(value: progress))
                    Spacer(minLength: 8)
                }
                GeometryReader { proxy in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color.white.opacity(0.07))
                        Capsule().fill(LinearGradient(colors: [ReloHoloTheme.cyan, ReloHoloTheme.violet], startPoint: .leading, endPoint: .trailing))
                            .frame(width: max(4, proxy.size.width * min(max(progress, 0), 1)))
                    }
                }
                .frame(height: 5)
            }
            .animation(reduceMotion ? nil : .easeOut(duration: 0.25), value: progress)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Progress")
            .accessibilityValue("\(Int((progress * 100).rounded())) percent")
        } else {
            Text(status).font(.subheadline.monospaced()).foregroundStyle(Color.reloSecondaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

extension LiveActivityDisplayPresentation {
    /// The card's steps with the labels this phone opened (ReloCore `InboxItem.timelineSteps`).
    func timelineSteps(for item: InboxItem) -> [Step] {
        if case let .steps(items, _) = visual { return item.timelineSteps(presented: items) }
        return item.timelineSteps(presented: [])
    }

    /// Steps of a longer plan that the card does not carry.
    var stepWindow: StepWindow {
        if case let .steps(_, window) = visual { return window }
        return .whole
    }
}
