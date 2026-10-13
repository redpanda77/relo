import ReloCore
import SwiftUI

/// A History row reads top to bottom as: where it came from, what it was, how it turned out, what it took.
struct HistoryRowView: View {
    let row: HistoryRow
    var showsSource = true
    var showsProject = true
    var responseStatus: String?
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        // No icon column: every line gets the full width. The outcome lives in the badge,
        // the steps bar is the card's spine, and one meta line carries the counts and the type.
        VStack(alignment: .leading, spacing: 6) {
            origin
            titleRow
            if let summary = row.summary {
                // With nothing to measure, the type rides on the summary instead of taking a line alone.
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(summary).font(.subheadline).foregroundStyle(Color.reloSecondaryText)
                        .lineLimit(typeSize.isAccessibilitySize ? nil : 2)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if typePlacement == .summary { typeLabel.font(.caption).foregroundStyle(Color.reloSecondaryText) }
                }
            }
            if let decision = row.decision { decisionStrip(decision) }
            if let steps = row.steps {
                HistoryStepsMeter(steps: steps, color: color, outcome: row.outcome).padding(.top, 2)
            } else if let progress = row.progress {
                HistoryProgressMeter(value: progress, color: color, showsValue: false).padding(.top, 2)
            }
            if typePlacement == .meta || row.origin != nil { meta }
        }
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens details")
    }

    /// Large text stacks the badge under the title so the title keeps the full width.
    private var titleRow: some View {
        let stacked = typeSize.isAccessibilitySize
        let layout = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 10))
        return layout {
            Text(row.title).font(.headline).foregroundStyle(.primary)
                .lineLimit(stacked ? nil : 2)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let label = responseStatus ?? row.outcome.label {
                badge(label)
            } else {
                typeLabel.font(.caption.weight(.medium)).foregroundStyle(Color.reloSecondaryText)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background { Capsule().fill(Color.primary.opacity(0.07)) }
                    .fixedSize()
            }
        }
    }

    private enum TypePlacement { case badge, summary, meta }
    /// A message has no outcome, so its type takes the badge; otherwise it joins the first line with room.
    private var typePlacement: TypePlacement {
        if responseStatus == nil && row.outcome.label == nil { return .badge }
        if metaFacts.isEmpty && row.summary != nil { return .summary }
        return .meta
    }

    private var typeLabel: some View {
        Label(row.type, systemImage: typeSymbol).labelStyle(HistoryInlineLabelStyle()).fixedSize()
    }

    /// What the work amounted to and where it ran on the left; what kind of item it is on the right.
    private var meta: some View {
        let measure = metaFacts.joined(separator: " · ")
        let showsType = typePlacement == .meta
        let type = Label(row.type, systemImage: typeSymbol).labelStyle(HistoryInlineLabelStyle())
        let origin = row.origin.map { Label($0, systemImage: "laptopcomputer").labelStyle(HistoryInlineLabelStyle()) }
        return ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                if !measure.isEmpty { Text(measure).fixedSize() }
                if let origin { origin.fixedSize() }
                Spacer(minLength: 8)
                if showsType { type.fixedSize() }
            }
            VStack(alignment: .leading, spacing: 2) {
                if !measure.isEmpty { Text(measure).fixedSize(horizontal: false, vertical: true) }
                if let origin { origin.fixedSize(horizontal: false, vertical: true) }
                if showsType { type }
            }
        }
        .font(.caption).foregroundStyle(Color.reloSecondaryText)
    }

    private var metaFacts: [String] {
        var parts: [String] = []
        if let steps = row.steps { parts.append(HistoryStepsMeter.caption(steps, outcome: row.outcome)) }
        else if let progress = row.progress { parts.append(progress.formatted(.percent.precision(.fractionLength(0)))) }
        if let updates = row.updates, updates > 1 { parts.append("\(updates) updates") }
        if let duration = row.duration {
            parts.append(Self.duration(duration))
        } else if row.outcome == .running, let started = row.startedAt {
            parts.append("since \(started.formatted(date: .omitted, time: .shortened))")
        }
        return parts
    }

    private var typeSymbol: String {
        switch row.type {
        case "Live Activity": "waveform"
        case "Approval": "checkmark.seal"
        case "Question": "questionmark.circle"
        case "Reply request": "text.bubble"
        case "Response": "arrowshape.turn.up.left"
        default: "bell"
        }
    }

    /// Source › project › topic, with the time on the right. Filters hide what they already pin.
    private var origin: some View {
        let stacked = typeSize.isAccessibilitySize
        let layout = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 6))
        return layout {
            if stacked {
                originParts(source: showsSource, topic: true).fixedSize(horizontal: false, vertical: true)
            } else {
                // The fullest line that fits; a part is dropped whole rather than cut to an ellipsis.
                ViewThatFits(in: .horizontal) {
                    originParts(source: showsSource, topic: true).fixedSize()
                    originParts(source: showsSource, topic: false).fixedSize()
                    originParts(source: false, topic: false).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            HStack(spacing: 5) {
                if row.unread {
                    Circle().fill(Color.reloInteractive).frame(width: 7, height: 7).accessibilityLabel("Unread")
                }
                Text(row.at, style: .time)
                    .font(.caption.monospacedDigit()).foregroundStyle(Color.reloSecondaryText)
            }
            .layoutPriority(1)
        }
        .font(.caption.weight(.medium))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([showsSource ? row.source.name : nil, showsProject ? row.project?.name : nil, row.topic]
            .compactMap { $0 }.joined(separator: ", "))
    }

    private func originParts(source: Bool, topic: Bool) -> some View {
        let project = showsProject ? row.project : nil
        let showsSourceName = source || project == nil
        let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 5))
        return layout {
            if showsSourceName {
                Label(row.source.name, systemImage: row.source.systemImageName)
                    .labelStyle(HistoryInlineLabelStyle())
                    .foregroundStyle(Color.reloSecondaryText)
            }
            if let project {
                if showsSourceName && !typeSize.isAccessibilitySize { separator("·") }
                Text(project.name).foregroundStyle(projectColor(project)).fontWeight(.semibold)
            }
            if topic, let name = row.topic {
                if !typeSize.isAccessibilitySize { separator("›") }
                Text(name).foregroundStyle(Color.reloSecondaryText)
            }
        }
    }

    private func separator(_ mark: String) -> some View {
        Text(mark).foregroundStyle(Color.reloSecondaryText.opacity(0.6)).accessibilityHidden(true)
    }

    private func badge(_ label: String) -> some View {
        Label(label, systemImage: symbol).labelStyle(HistoryInlineLabelStyle())
            .font(.caption.weight(.semibold)).foregroundStyle(color)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background { Capsule().fill(color.opacity(0.14)) }
            .overlay { Capsule().strokeBorder(color.opacity(0.25), lineWidth: 0.5) }
            .fixedSize()
    }

    /// The question asked on the card and its answer, on one line when it fits.
    private func decisionStrip(_ decision: HistoryRow.Decision) -> some View {
        let tint: Color = decision.pending ? .reloSignalCoral : decision.declined ? .reloWarning : .reloDone
        let answer = HStack(spacing: 4) {
            Text(decision.answer).foregroundStyle(tint).fontWeight(.semibold)
            if let at = decision.at {
                Text("· \(at.formatted(date: .omitted, time: .shortened))").foregroundStyle(Color.reloSecondaryText)
                    .monospacedDigit()
            }
        }
        let prompt = Label(decision.prompt, systemImage: "questionmark.bubble").labelStyle(HistoryInlineLabelStyle())
            .foregroundStyle(.primary)
        return ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { prompt.fixedSize(); Spacer(minLength: 8); answer.fixedSize() }
            VStack(alignment: .leading, spacing: 3) {
                prompt.fixedSize(horizontal: false, vertical: true)
                answer.fixedSize(horizontal: false, vertical: true)
            }
        }
        .font(.caption)
        .padding(.horizontal, 10).padding(.vertical, 7)
        .background { RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Color.primary.opacity(0.06)) }
    }

    static func duration(_ seconds: TimeInterval) -> String {
        guard seconds >= 60 else { return "under a minute" }
        return Duration.seconds(seconds).formatted(.units(allowed: [.hours, .minutes], width: .abbreviated, maximumUnitCount: 2))
    }

    private var symbol: String {
        switch row.outcome {
        case .running: "waveform"
        case .done: "checkmark"
        case .stopped: "exclamationmark.triangle.fill"
        case .expired: "clock.badge.xmark"
        case .ended: "stop.fill"
        case .replaced: "arrow.triangle.2.circlepath"
        case .waitingForYou: "hand.raised.fill"
        case .answered: "checkmark.bubble.fill"
        case .unanswered: "clock"
        case .message: "bell.fill"
        }
    }

    private var color: Color {
        switch row.outcome {
        case .running: .reloSignalIndigo
        case .done: .reloDone
        case .stopped: .reloWarning
        case .waitingForYou: .reloSignalCoral
        case let .answered(answer): ["Declined", "No"].contains(answer) ? .reloWarning : .reloDone
        case .expired, .ended, .replaced, .unanswered, .message: .reloInfo
        }
    }

    private func projectColor(_ project: InboxProjectIdentity) -> Color {
        guard let slot = project.paletteSlot else { return .primary }
        switch slot % 3 {
        case 0: return .reloInteractive
        case 1: return .reloSignalIndigo
        default: return .reloSignalCoral
        }
    }
}

private struct HistoryInlineLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 3) { configuration.icon.imageScale(.small); configuration.title }
    }
}

/// One segment per step across the full width, so "4 of 6" reads at a glance; long plans become a bar.
struct HistoryStepsMeter: View {
    let steps: HistoryRow.Steps
    let color: Color
    let outcome: HistoryRow.Outcome
    /// Finished work is finished: cards ended before steps were completed on success still read as done.
    private var done: Int { Self.done(steps, outcome: outcome) }

    var body: some View {
        Group {
            if steps.total <= 12 {
                HStack(spacing: 3) {
                    ForEach(0..<steps.total, id: \.self) { index in
                        Capsule().fill(index < done ? color : Color.primary.opacity(index == done ? 0.28 : 0.1))
                            .frame(height: 4).frame(maxWidth: .infinity)
                    }
                }
            } else {
                HistoryProgressMeter(value: Double(done) / Double(steps.total), color: color, showsValue: false)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Self.caption(steps, outcome: outcome))
    }

    static func done(_ steps: HistoryRow.Steps, outcome: HistoryRow.Outcome) -> Int {
        outcome == .done ? steps.total : steps.done
    }

    static func caption(_ steps: HistoryRow.Steps, outcome: HistoryRow.Outcome) -> String {
        let done = done(steps, outcome: outcome)
        if done >= steps.total { return "All \(steps.total) steps" }
        guard let current = steps.current else { return "\(done) of \(steps.total) steps" }
        switch outcome {
        case .stopped: return "Stopped at \(current)"
        case .expired: return "Expired at \(current)"
        case .ended, .replaced: return "Ended at \(current)"
        default: return "\(done) of \(steps.total) · \(current)"
        }
    }
}

struct HistoryProgressMeter: View {
    let value: Double
    let color: Color
    var showsValue = true
    private var fraction: Double { value.isFinite ? min(max(value, 0), 1) : 0 }

    var body: some View {
        HStack(spacing: 8) {
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.1))
                    Capsule().fill(color).frame(width: max(4, proxy.size.width * fraction))
                }
            }
            .frame(height: 4)
            if showsValue {
                Text(fraction, format: .percent.precision(.fractionLength(0)))
                    .font(.caption.weight(.medium).monospacedDigit()).foregroundStyle(Color.reloSecondaryText)
            }
        }
        .accessibilityElement(children: .ignore).accessibilityLabel("Progress")
        .accessibilityValue(fraction.formatted(.percent.precision(.fractionLength(0))))
    }
}
