import ReloCore
import SwiftUI

// The plan card's parts (plan 12b). One row component serves rounds, steps and substeps (U5, U6); the rail
// is drawn structurally, one segment per node that runs through that node's opened children (U11); a label
// gets the row's full width minus its trailing meta and wraps before it truncates (U12).

/// What a mark shows. Shape carries the state, never color alone (§7): filled check, ring with dot,
/// pause bars, cross, empty ring, dashed ring.
enum PlanMark: Equatable {
    case done, current, waiting, paused, stopped, open, skipped

    var spoken: String {
        switch self {
        case .done: "done"
        case .current: "current"
        case .waiting: "waiting"
        case .paused: "paused"
        case .stopped: "stopped"
        case .open: "not started"
        case .skipped: "skipped"
        }
    }
}

struct PlanMarkView: View {
    let mark: PlanMark
    /// The work is finished: finished marks turn green instead of the running gradient.
    var finished = false
    var round = false
    @ScaledMetric(relativeTo: .subheadline) private var size: CGFloat = 20
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            switch mark {
            case .done:
                if round {
                    Circle().fill(Color.reloDone.opacity(0.18))
                    Image(systemName: "checkmark").font(.system(size: size * 0.5, weight: .heavy)).foregroundStyle(Color.reloDone)
                } else {
                    Circle().fill(finished ? AnyShapeStyle(Color.reloDone)
                                  : AnyShapeStyle(LinearGradient(colors: [ReloHoloTheme.cyan, ReloHoloTheme.violet], startPoint: .topLeading, endPoint: .bottomTrailing)))
                    Image(systemName: "checkmark").font(.system(size: size * 0.45, weight: .heavy)).foregroundStyle(Color.reloCanvas)
                }
            case .current:
                PlanPulse(size: size)
                Circle().strokeBorder(ReloHoloTheme.violet, lineWidth: 2)
                Circle().fill(ReloHoloTheme.violet).frame(width: size * 0.4, height: size * 0.4)
            case .waiting:
                Circle().strokeBorder(Color.reloWarning, lineWidth: 2)
                Image(systemName: "pause.fill").font(.system(size: size * 0.38, weight: .black)).foregroundStyle(Color.reloWarning)
            case .paused:
                Circle().strokeBorder(Color.reloInfo, lineWidth: 2)
                Image(systemName: "pause.fill").font(.system(size: size * 0.38, weight: .black)).foregroundStyle(Color.reloInfo)
            case .stopped:
                Circle().strokeBorder(Color.reloErrorText, lineWidth: 1.5)
                Image(systemName: "xmark").font(.system(size: size * 0.42, weight: .heavy)).foregroundStyle(Color.reloErrorText)
            case .open:
                Circle().strokeBorder(Color.white.opacity(0.42), lineWidth: 1.5)
            case .skipped:
                Circle().strokeBorder(Color.white.opacity(0.42), style: StrokeStyle(lineWidth: 1.5, dash: [2.5, 2.5]))
            }
        }
        .frame(width: size, height: size)
        .animation(reduceMotion ? nil : .snappy(duration: 0.35), value: mark)
        .accessibilityHidden(true)
    }
}

/// A slow ring around the current step; static with Reduce Motion.
private struct PlanPulse: View {
    let size: CGFloat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var expanded = false
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.reloMotionPaused) private var paused
    /// The ring loops only while it can be seen: the app is active and its surface is not paused.
    private var running: Bool { !reduceMotion && scenePhase == .active && !paused }
    var body: some View {
        Circle().stroke(ReloHoloTheme.violet.opacity(reduceMotion ? 0.28 : (expanded ? 0 : 0.5)), lineWidth: 1)
            .frame(width: size, height: size)
            .scaleEffect(reduceMotion ? 1.35 : (expanded ? 1.9 : 1))
            // Scoped to the ring: a repeating `withAnimation` also caught the row's own moves and made the
            // mark drift whenever the plan above it changed height.
            .animation(running ? .easeOut(duration: 1.8).repeatForever(autoreverses: false) : nil, value: expanded)
            .onChange(of: running, initial: true) { _, on in expanded = on }
    }
}

// MARK: - The rail

/// The line joining a node's mark to the next sibling's mark. It belongs to the node, so it runs past the
/// node's opened children without a gap; the last node of a list has no tail. A finished stretch is tinted.
private struct PlanRail: ViewModifier {
    let show: Bool
    let tinted: Bool
    let finishedWork: Bool
    var top: CGFloat? = nil
    @ScaledMetric(relativeTo: .subheadline) private var size: CGFloat = 20

    func body(content: Content) -> some View {
        content.background(alignment: .topLeading) {
            if show {
                Capsule()
                    .fill(tinted ? (finishedWork ? AnyShapeStyle(Color.reloDone.opacity(0.6))
                                    : AnyShapeStyle(LinearGradient(colors: [ReloHoloTheme.cyan.opacity(0.75), ReloHoloTheme.violet.opacity(0.75)],
                                                                   startPoint: .top, endPoint: .bottom)))
                                 : AnyShapeStyle(Color.white.opacity(0.14)))
                    .frame(width: 2)
                    .padding(.leading, size / 2 - 1)
                    .padding(.top, top ?? (size + 10))
                    .padding(.bottom, -9)
            }
        }
    }
}

private extension View {
    func planRail(show: Bool, tinted: Bool, finishedWork: Bool, top: CGFloat? = nil) -> some View {
        modifier(PlanRail(show: show, tinted: tinted, finishedWork: finishedWork, top: top))
    }
}

// MARK: - The one row

struct PlanRow: View {
    enum Emphasis { case current, normal, quiet }
    enum Chevron { case closed, opened }

    let mark: PlanMark
    var round = false
    var finished = false
    let label: String
    var emphasis: Emphasis = .normal
    var unreadable = false
    var sub: String? = nil
    var meta: [String] = []
    var chevron: Chevron? = nil
    let spoken: String
    var select: (() -> Void)? = nil
    var toggle: (() -> Void)? = nil
    var toggleName: String = "Toggle substeps"

    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .subheadline) private var markColumn: CGFloat = 20

    private var wide: Bool { typeSize.isAccessibilitySize }

    private var labelText: some View {
        Text(label)
            .font(.subheadline.weight(emphasis == .current ? .semibold : (round ? .medium : .regular)))
            .italic(unreadable)
            .foregroundStyle(unreadable || emphasis == .quiet ? Color.reloSecondaryText : Color.primary)
            .lineLimit(wide ? nil : 2)
            .fixedSize(horizontal: false, vertical: true)
            .multilineTextAlignment(.leading)
    }

    private var metaView: some View {
        HStack(spacing: 6) {
            ForEach(meta, id: \.self) { text in
                Text(text).font(.caption).monospacedDigit().foregroundStyle(Color.reloSecondaryText)
            }
            if let chevron {
                Image(systemName: chevron == .closed ? "chevron.right" : "chevron.down")
                    .font(.caption2.weight(.bold)).foregroundStyle(Color.reloSecondaryText)
            }
        }
        .fixedSize()
        .padding(.top, 2)
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            if let select {
                Button(action: select) { content }.buttonStyle(PlanRowPressStyle())
            } else {
                content
            }
            if let toggle, chevron != nil {
                Button(action: toggle) { Color.clear.frame(width: 56, height: 40).contentShape(Rectangle()) }
                    .buttonStyle(.plain)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spoken)
        .accessibilityAddTraits(select == nil ? [] : .isButton)
        .accessibilityAction { select?() }
        .accessibilityActions {
            if toggle != nil, chevron != nil { Button(toggleName) { toggle?() } }
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 2) {
            if wide {
                HStack(alignment: .top, spacing: 10) {
                    PlanMarkView(mark: mark, finished: finished, round: round).padding(.top, 1)
                    VStack(alignment: .leading, spacing: 4) {
                        labelText
                        if !meta.isEmpty || chevron != nil { metaView }
                    }
                    Spacer(minLength: 0)
                }
            } else {
                HStack(alignment: .top, spacing: 10) {
                    PlanMarkView(mark: mark, finished: finished, round: round).padding(.top, 1)
                    labelText.frame(maxWidth: .infinity, alignment: .leading)
                    if !meta.isEmpty || chevron != nil { metaView }
                }
            }
            if let sub {
                Text(sub)
                    .font(.footnote).foregroundStyle(Color.reloSecondaryText)
                    .lineLimit(wide ? nil : 3).fixedSize(horizontal: false, vertical: true)
                    .multilineTextAlignment(.leading)
                    .padding(.leading, markColumn + 10)
            }
        }
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}

private struct PlanRowPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.6 : 1)
    }
}

/// "5 done", "6 to go", "2 skipped", "4 earlier rounds": one quiet row standing for what is not listed.
/// It has a mark of its own (a small dashed ring with three dots) so the rail runs into and out of it
/// like any other node.
struct PlanFoldRow: View {
    let text: String
    let spoken: String
    let action: () -> Void
    @ScaledMetric(relativeTo: .subheadline) private var size: CGFloat = 20

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 10) {
                ZStack {
                    Circle().strokeBorder(Color.white.opacity(0.3), style: StrokeStyle(lineWidth: 1, dash: [2, 2.5]))
                    Image(systemName: "ellipsis").font(.system(size: size * 0.42, weight: .bold))
                        .foregroundStyle(Color.reloSecondaryText)
                }
                .frame(width: size, height: size).padding(.top, 1)
                .accessibilityHidden(true)
                HStack(spacing: 4) {
                    Text(text)
                    ReloChevron()
                }
                .font(.footnote).foregroundStyle(Color.reloSecondaryText)
                .frame(minHeight: size, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity, minHeight: 34, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(PlanRowPressStyle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spoken)
        .accessibilityHint("Shows them")
        .accessibilityAddTraits(.isButton)
    }
}

// MARK: - Structure: a node draws its own rail through its opened children

/// What the structure needs from the card: how a node reads, and what a tap does.
struct PlanCardContext {
    var outline: PlanOutline
    var finishedWork: Bool
    var indent: CGFloat
    var markFor: (PlanOutline.Node) -> PlanMark
    var timeLabel: (PlanOutline.Node) -> String?
    var select: (PlanOutline.Node) -> Void
    var toggleStep: (String) -> Void
    var openedByOwner: Set<String>
    var expandFold: (String) -> Void
    var items: (PlanOutline.Round) -> [PlanOutline.Item]
    var toggleRound: (Int) -> Void
    var roundFolded: (PlanOutline.Round) -> Bool
    var expandEarlier: () -> Void
}

struct PlanItemsView: View {
    let items: [PlanOutline.Item]
    let ctx: PlanCardContext

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            let rows = PlanOutline.rows(items)
            ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                let last = index == rows.count - 1
                switch row {
                case let .unreadable(_, state, count):
                    PlanRow(mark: state == .complete ? .done : .open, finished: ctx.finishedWork,
                            label: PlanOutline.Row.text(state: state, count: count), emphasis: .quiet, unreadable: true,
                            spoken: PlanOutline.Row.text(state: state, count: count))
                        .planRail(show: !last, tinted: state == .complete, finishedWork: ctx.finishedWork)
                case let .item(.branch(branch)): PlanBranchView(branch: branch, last: last, ctx: ctx)
                case let .item(.fold(fold)):
                    PlanFoldRow(text: fold.text, spoken: "\(fold.count) \(fold.kind == .toGo ? "steps to go" : fold.kind == .done ? "steps done" : "steps skipped"), hidden") {
                        ctx.expandFold(fold.id)
                    }
                    .planRail(show: !last, tinted: false, finishedWork: ctx.finishedWork)
                }
            }
        }
    }
}

struct PlanBranchView: View {
    let branch: PlanOutline.Branch
    let last: Bool
    let ctx: PlanCardContext

    private var node: PlanOutline.Node { branch.node }

    private var spoken: String {
        var parts: [String] = []
        if let position = branch.position { parts.append("Step \(position) of \(branch.siblings)") }
        parts.append(node.shownLabel)
        let mark = ctx.markFor(node)
        parts.append(node.state == .current && mark == .open ? "not started" : mark.spoken)
        if let count = branch.count { parts.append("\(count.done) of \(count.total) substeps done") }
        if node.depth > 0 { parts.append("level \(node.depth + 1)") }
        return parts.joined(separator: ", ")
    }

    var body: some View {
        let mark = ctx.markFor(node)
        let autoOpen = node.state == .current
        let owned = ctx.openedByOwner.contains(node.id)
        VStack(alignment: .leading, spacing: 0) {
            PlanRow(
                mark: mark, finished: ctx.finishedWork, label: node.shownLabel,
                emphasis: node.state == .current ? .current : (node.state == .pending ? .quiet : .normal),
                unreadable: !node.readable,
                meta: [branch.count.map { "\($0.done)/\($0.total)" }, ctx.timeLabel(node)].compactMap { $0 },
                chevron: node.hasChildren && !autoOpen ? (owned ? .opened : .closed) : nil,
                spoken: spoken, select: { ctx.select(node) }, toggle: { ctx.toggleStep(node.id) },
                toggleName: owned ? "Hide substeps" : "Show substeps")
            if branch.opened, !branch.children.isEmpty {
                PlanItemsView(items: branch.children, ctx: ctx)
                    .padding(.leading, ctx.indent)
                    .transition(.opacity)
            }
        }
        .planRail(show: !last, tinted: node.state == .complete, finishedWork: ctx.finishedWork)
    }
}

// MARK: - Rounds

struct PlanRoundsView: View {
    let slots: [PlanOutline.RoundSlot]
    let ctx: PlanCardContext

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(slots.enumerated()), id: \.element.id) { index, slot in
                let last = index == slots.count - 1
                switch slot {
                case let .earlier(count):
                    PlanFoldRow(text: "\(count) earlier rounds", spoken: "\(count) earlier rounds, collapsed") { ctx.expandEarlier() }
                        .planRail(show: !last, tinted: true, finishedWork: ctx.finishedWork)
                case let .round(round):
                    PlanRoundView(round: round, last: last, ctx: ctx)
                }
            }
        }
    }
}

struct PlanRoundView: View {
    let round: PlanOutline.Round
    let last: Bool
    let ctx: PlanCardContext

    var body: some View {
        let inPlay = round.id == ctx.outline.currentRound?.id && !round.closed
        let folded = ctx.roundFolded(round)
        let total = ctx.outline.rounds.count
        let spoken = ["Round \(round.n) of \(total)", round.title, round.closed ? "delivered" : "in progress", round.outcome]
            .compactMap { $0 }.joined(separator: ", ")
        VStack(alignment: .leading, spacing: 0) {
            PlanRow(
                mark: round.closed ? .done : .current, round: true, finished: ctx.finishedWork,
                label: round.heading, emphasis: inPlay ? .current : .normal,
                sub: round.closed ? round.outcome : nil,
                meta: [PlanOutline.durationLabel(round.duration)].compactMap { $0 },
                chevron: inPlay ? nil : (folded ? .closed : .opened),
                spoken: spoken + (inPlay ? "" : folded ? ", collapsed" : ", expanded"),
                select: inPlay ? nil : { ctx.toggleRound(round.n) }, toggle: nil)
            if !folded {
                PlanItemsView(items: ctx.items(round), ctx: ctx)
                    .padding(.leading, ctx.indent)
                    .transition(.opacity)
            }
        }
        .planRail(show: !last, tinted: round.closed, finishedWork: ctx.finishedWork)
    }
}
