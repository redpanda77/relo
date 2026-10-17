import ReloCore
import SwiftUI

/// A step opened (plan 12b 4.6): its label and state, where it sits, how long it took, its detail, its
/// substeps with times, and the updates the agent sent while it was the current step.
struct PlanStepSheet: View {
    let node: PlanOutline.Node
    let outline: PlanOutline
    let mark: PlanMark
    let finishedWork: Bool
    let updates: [PlanStepUpdate]
    let now: Date

    @Environment(\.dismiss) private var dismiss

    private var round: PlanOutline.Round? { outline.rounds.first { $0.n == node.round } }
    private var children: [PlanOutline.Node] {
        guard let round else { return [] }
        return node.childIDs.compactMap { id in round.nodes.first { $0.id == id } }.filter { $0.state != .skipped }
    }

    private var stateWord: (text: String, color: Color) {
        switch node.state {
        case .complete: ("Done", .reloDone)
        case .skipped: ("Skipped", .reloSecondaryText)
        case .pending: ("Not started", .reloSecondaryText)
        case .current:
            switch mark {
            case .waiting: ("Waiting", .reloWarning)
            case .paused: ("Paused", .reloInfo)
            case .stopped: ("Stopped", .reloErrorText)
            case .open: ("Not finished", .reloSecondaryText)
            default: ("In progress", ReloHoloTheme.violet)
            }
        }
    }

    /// "Round 3 · 2 of 3 · 18 min (2:41 PM to 2:59 PM)" or "2 of 3 · Started 6 min ago".
    private var whereLine: String {
        var parts: [String] = []
        if outline.hasRoundSections { parts.append("Round \(node.round)") }
        if let round {
            let siblings = round.nodes.filter { $0.parent == node.parent && $0.state != .skipped }
            if let index = siblings.firstIndex(where: { $0.id == node.id }) { parts.append("\(index + 1) of \(siblings.count)") }
        }
        if node.state == .complete, let duration = PlanOutline.durationLabel(node.duration) {
            var time = duration
            if let start = node.startedAt, let end = node.doneAt {
                time += " (\(start.formatted(date: .omitted, time: .shortened)) to \(end.formatted(date: .omitted, time: .shortened)))"
            }
            parts.append(time)
        } else if node.state == .current, let start = node.startedAt, start <= now {
            parts.append("Started \(start.formatted(.relative(presentation: .named, unitsStyle: .abbreviated)))")
        }
        return parts.joined(separator: " · ")
    }

    private var showsTrimNote: Bool {
        PlanStepUpdates.mayBeTrimmed(stepStartedAt: node.startedAt, now: now)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Text(node.shownLabel)
                            .font(.title3.weight(.bold)).italic(!node.readable)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityAddTraits(.isHeader)
                        Spacer(minLength: 8)
                        HStack(spacing: 5) {
                            PlanMarkView(mark: mark, finished: finishedWork).scaleEffect(0.75).frame(width: 16, height: 16)
                            Text(stateWord.text).font(.subheadline.weight(.semibold))
                        }
                        .foregroundStyle(stateWord.color).fixedSize()
                    }
                    if !whereLine.isEmpty {
                        Text(whereLine).font(.subheadline).foregroundStyle(Color.reloSecondaryText)
                    }
                }
                if let detail = node.detail {
                    section("Detail") { Text(detail).font(.body).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
                }
                if !children.isEmpty {
                    let done = children.filter { $0.state == .complete }.count
                    section("Substeps", trailing: "\(done)/\(children.count)") {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(children) { child in
                                let childMark = Self.mark(child, parent: mark)
                                PlanRow(mark: childMark, finished: finishedWork, label: child.shownLabel,
                                        emphasis: child.state == .current ? .current : (child.state == .pending ? .quiet : .normal),
                                        unreadable: !child.readable,
                                        meta: [PlanOutline.durationLabel(child.duration)].compactMap { $0 },
                                        spoken: "\(child.shownLabel), \(childMark.spoken)")
                            }
                        }
                    }
                }
                if !updates.isEmpty || showsTrimNote {
                    section("Updates") {
                        VStack(alignment: .leading, spacing: 10) {
                            ForEach(updates) { update in
                                HStack(alignment: .firstTextBaseline, spacing: 12) {
                                    Text(update.at.formatted(date: .omitted, time: .shortened))
                                        .font(.footnote.monospacedDigit()).foregroundStyle(Color.reloSecondaryText)
                                        .frame(minWidth: 62, alignment: .leading)
                                    Text(update.text).font(.subheadline).fixedSize(horizontal: false, vertical: true)
                                }
                                .accessibilityElement(children: .combine)
                            }
                            if showsTrimNote {
                                Text("Updates older than 10 hours are deleted on this server.")
                                    .font(.footnote).foregroundStyle(Color.reloSecondaryText)
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, ReloLayout.screenInset)
            .padding(.top, 24).padding(.bottom, 32)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationBackground(Color.reloSurface)
    }

    /// A substep's mark: a current substep follows how the parent step stands.
    static func mark(_ node: PlanOutline.Node, parent: PlanMark) -> PlanMark {
        switch node.state {
        case .complete: .done
        case .skipped: .skipped
        case .pending: .open
        case .current: [.waiting, .paused, .stopped].contains(parent) ? parent : (parent == .open ? .open : .current)
        }
    }

    private func section<Content: View>(_ title: String, trailing: String? = nil,
                                        @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(Color.reloSecondaryText)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 8)
                if let trailing {
                    Text(trailing).font(.caption.monospacedDigit()).foregroundStyle(Color.reloSecondaryText)
                }
            }
            content()
        }
    }
}
