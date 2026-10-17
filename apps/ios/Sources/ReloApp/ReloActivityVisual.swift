import ReloCore
import SwiftUI

/// Summary rows show one useful indicator; detail preserves every rich component.
struct ReloActivityVisual: View {
    let item: InboxItem
    let accountID: String?
    var row = false
    /// Detail only: the screen draws progress itself, so show just media components.
    var mediaOnly = false
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var components: [LiveActivityPresentation.Component] {
        guard let presentation = item.liveActivity?.presentation else { return [] }
        if mediaOnly && !row { return presentation.components.filter(\.isNonProgress) }
        // One progress, never two: named steps say what is happening, so they win over a bar.
        if let steps = presentation.components.first(where: {
            if case .steps = $0 { return true }; return false
        }) { return [steps] + (row ? [] : presentation.components.filter(\.isNonProgress)) }
        if row {
            return presentation.components.first(where: {
                if case .progressBar = $0 { return true }; return false
            }).map { [$0] } ?? []
        }
        return presentation.components
    }
    var body: some View {
        if let presentation = item.liveActivity?.presentation {
            VStack(alignment: .leading, spacing: 16) {
                ForEach(components) { component in
                    componentView(component, presentation: presentation)
                }
            }
        } else if mediaOnly ? hasLegacyImage : (!row || !hasLegacyImage) {
            ActivityPresentationVisual(presentation: InboxPresentationProjection.presentation(for: item),
                palette: ActivityPresentationPalette(item: item), accountID: accountID, surface: row ? .row : .detail)
        }
    }
    /// Steps read by outcome: finished work is all done, stopped work marks where it stopped,
    /// and only a running card shows a step as in progress.
    private func stepFill(_ state: LiveActivityDisplayPresentation.Step.State, outcome: InboxAttentionProjection.ActivityOutcome,
                          color: Color) -> Color {
        if outcome == .completed { return color }
        switch state {
        case .complete: return color
        case .pending, .skipped: return .reloMediaPlaceholder
        case .current:
            switch outcome {
            case .running: return color.opacity(0.42)
            case .stopped: return .reloWarning
            default: return .reloMediaPlaceholder
            }
        }
    }

    private func stepCaption(current: String?, outcome: InboxAttentionProjection.ActivityOutcome) -> String? {
        switch outcome {
        case .running: return current
        case .completed: return "All steps done"
        case .stopped: return current.map { "Stopped at \($0)" }
        case .expired: return current.map { "Expired at \($0)" }
        case .ended: return current.map { "Ended at \($0)" }
        }
    }

    private var hasLegacyImage: Bool {
        if case .image = InboxPresentationProjection.presentation(for: item).visual { return true }
        return false
    }
    @ViewBuilder private func componentView(_ component: LiveActivityPresentation.Component,
                                            presentation: LiveActivityPresentation) -> some View {
        let c = (ReloReadableColor(hex: presentation.color(for: component.colorRole)) ?? .init(red: 0.04, green: 0.43, blue: 0.34))
            .readable(onLight: colorScheme == .light)
        let color = Color(red: c.red, green: c.green, blue: c.blue)
        switch component {
        case let .progressBar(_, _, suppliedValue, label):
            let value = item.activitySummary?.progress ?? suppliedValue
            Group {
                if row {
                    HStack(spacing: 12) {
                        ProgressView(value: value).tint(color)
                        Text(value, format: .percent.precision(.fractionLength(0)))
                            .font(.caption.monospacedDigit()).foregroundStyle(Color.reloSecondaryText)
                    }
                } else {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(label ?? "Progress").font(.subheadline).foregroundStyle(Color.reloSecondaryText)
                            Spacer()
                            Text(value, format: .percent.precision(.fractionLength(0))).font(.subheadline.monospacedDigit())
                        }
                        ProgressView(value: value).tint(color)
                    }
                }
            }
                .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: value)
                .accessibilityElement(children: .ignore).accessibilityLabel(label ?? "Progress")
                .accessibilityValue("\(Int((value * 100).rounded())) percent")
        case let .steps(_, _, items, window):
            let outcome = InboxAttentionProjection.activityOutcome(item, now: .now)
            let current = items.first(where: { $0.state == .current })
            // A long plan's hidden steps still get their segment: done before the window, not started after.
            let states = Array(repeating: LiveActivityDisplayPresentation.Step.State.complete, count: window.before)
                + items.map(\.state) + Array(repeating: .pending, count: window.after)
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: states.count > 12 ? 3 : 6) {
                    ForEach(Array(states.enumerated()), id: \.offset) { _, state in
                        Capsule().fill(stepFill(state, outcome: outcome, color: color)).frame(height: 6)
                    }
                }
                if let caption = stepCaption(current: current?.label, outcome: outcome) {
                    Text(caption).font(.subheadline)
                        .foregroundStyle(outcome == .stopped ? Color.reloWarning : Color.reloSecondaryText)
                }
            }.accessibilityElement(children: .ignore).accessibilityLabel("Steps")
                .accessibilityValue(stepCaption(current: current?.label, outcome: outcome)
                    ?? items.map { "\($0.label), \($0.state.rawValue)" }.joined(separator: "; "))
        case let .image(_, _, asset):
            if !row { ReloImmutableImage(reference: asset, accountID: accountID, row: false) }
        }
    }
}

private extension LiveActivityPresentation.Component {
    /// Media and other components shown alongside a card's single progress representation.
    var isNonProgress: Bool {
        switch self {
        case .steps, .progressBar: false
        default: true
        }
    }
}
