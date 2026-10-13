import ActivityKit
import ReloCore
import SwiftUI
import WidgetKit

/// Picks the layout for the family the system asks for. Without a `.small` view the watch
/// Smart Stack falls back to the island's compact pair: two glyphs on a black tile.
struct ReloActivityContentView: View {
    let context: ActivityViewContext<ReloActivityAttributes>

    var body: some View {
        if #available(iOS 18.0, *) {
            FamilyRoutedContent(context: context)
        } else {
            lockScreenCard
        }
    }

    fileprivate var lockScreenCard: some View {
        PresentationCardView(
            presentation: context.state.presentation, context: context, surface: .lockScreen
        )
        .activityBackgroundTint(PresentationBackdrop.base)
    }
}

@available(iOS 18.0, *)
private struct FamilyRoutedContent: View {
    let context: ActivityViewContext<ReloActivityAttributes>
    @Environment(\.activityFamily) private var family

    var body: some View {
        switch family {
        case .small:
            PresentationWatchCard(
                attributes: context.attributes, state: context.state, isStale: context.isStale
            )
            // A lifted tint so the tile reads as a card in the Smart Stack, not a hole in it.
            .activityBackgroundTint(PresentationWatchCard.tileBase)
        default:
            ReloActivityContentView(context: context).lockScreenCard
        }
    }
}

/// The Apple Watch Smart Stack tile (and its full-screen alert): source, title, one fact.
/// Questions keep their answer buttons; the intent runs on the paired iPhone.
struct PresentationWatchCard: View {
    static let tileBase = Color(red: 0.08, green: 0.09, blue: 0.15)

    let attributes: ReloActivityAttributes
    let state: ReloActivityAttributes.ContentState
    let isStale: Bool

    @Environment(\.isLuminanceReduced) private var isLuminanceReduced

    private var presentation: LiveActivityPresentation { state.presentation }
    private var palette: PresentationPalette { .init(presentation: presentation, surface: .lockScreen) }
    private var projection: LiveActivitySurfaceProjection {
        .make(
            presentation: presentation, surface: .lockScreen,
            interaction: state.displayInteraction, isStale: isStale, now: .now)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            header
            ViewThatFits(in: .vertical) {
                if presentation.privacy == .private {
                    Label("Private activity", systemImage: "lock.fill")
                        .font(.footnote.weight(.semibold)).foregroundStyle(palette.primaryText)
                } else if projection.isDecision {
                    questionBody(questionLines: 2)
                    questionBody(questionLines: 1)
                    questionBody(questionLines: 0)
                } else {
                    workBody(titleLines: 2)
                    workBody(titleLines: 1)
                    title(lines: 1)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(alignment: .bottomTrailing) {
            // The state colour glows up from one corner, as on the Lock Screen card.
            if !isLuminanceReduced {
                RadialGradient(
                    colors: [palette.rampEnd.opacity(0.30), .clear],
                    center: .bottomTrailing, startRadius: 0, endRadius: 110)
                .padding(-24)
            }
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            PresentationSourceMark(presentation: presentation, palette: palette)
            Spacer(minLength: 0)
            if presentation.privacy != .private {
                trailingFact
            }
        }
    }

    @ViewBuilder private var trailingFact: some View {
        if projection.permitsInlineResponse, let deadline = state.displayInteraction?.expiresAt {
            PresentationCountdown(deadline: deadline, palette: palette)
                .font(.caption2.weight(.semibold))
        } else if presentation.state.kind == "active", !isStale, let startedAt = state.startedAt {
            Text(timerInterval: startedAt...Date.distantFuture, countsDown: false)
                .font(.caption2.monospacedDigit()).foregroundStyle(palette.secondaryText)
                .multilineTextAlignment(.trailing)
                .frame(maxWidth: 56, alignment: .trailing)
                .accessibilityLabel("Running for")
        } else {
            Image(systemName: presentation.state.icon.systemImageName)
                .font(.caption2.weight(.semibold)).foregroundStyle(palette.state)
                .accessibilityLabel(presentation.status)
        }
    }

    private func title(lines: Int) -> some View {
        Text(presentation.title)
            .font(.headline)
            .foregroundStyle(palette.primaryText)
            .lineLimit(lines)
            .accessibilityAddTraits(.isHeader)
    }

    private func workBody(titleLines: Int) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            title(lines: titleLines)
            factRow
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder private var factRow: some View {
        switch projection.fact {
        case .percentage(let value, _):
            HStack(spacing: 6) {
                PresentationNeonBar(value: value, palette: palette)
                Text(value, format: .percent.precision(.fractionLength(0)))
                    .font(.caption2.weight(.semibold).monospacedDigit())
                    .foregroundStyle(palette.state)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(projection.status)
            .accessibilityValue("\(Int((value * 100).rounded())) percent")
        case .stages(let completed, let total):
            HStack(spacing: 6) {
                Text("\(completed)/\(total)")
                    .fontWeight(.semibold).monospacedDigit().foregroundStyle(palette.state)
                Text(projection.status).foregroundStyle(palette.secondaryText)
            }
            .font(.caption2).lineLimit(1)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(completed) of \(total) stages complete")
        case .symbol(let symbol, let label):
            Label(label, systemImage: symbol)
                .font(.caption2).foregroundStyle(palette.secondaryText).lineLimit(1)
        }
    }

    /// The buttons are never dropped; the question text shrinks around them.
    private func questionBody(questionLines: Int) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if questionLines > 0 {
                Text(presentation.subtitle ?? presentation.title)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(palette.primaryText)
                    .lineLimit(questionLines)
            }
            PresentationBehaviorModule(
                activityID: attributes.eventID,
                activityGeneration: attributes.generation,
                behavior: presentation.behavior,
                interaction: state.displayInteraction,
                fallbackStatus: projection.status, palette: palette,
                permitsSubmission: projection.permitsInlineResponse,
                controlHeight: 30
            )
        }
        .fixedSize(horizontal: false, vertical: true)
    }
}

#if DEBUG
    /// The `.small` family cannot be selected from a widget preview, so the tile is previewed
    /// directly at a 45 mm Smart Stack size.
    #Preview("Watch Smart Stack", traits: .sizeThatFitsLayout) {
        VStack(spacing: 8) {
            ForEach(
                ["max-text", "decision-with-progress", "question-long", "stale-progress", "all-complete"],
                id: \.self
            ) { name in
                PresentationWatchCard(
                    attributes: ReloLiveActivityReferenceFixtures.attributes,
                    state: ReloLiveActivityReferenceFixtures.state(named: name)!,
                    isStale: name == "stale-progress"
                )
                .padding(10)
                .frame(width: 184, height: 88)
                .background(PresentationWatchCard.tileBase, in: RoundedRectangle(cornerRadius: 22))
                .clipShape(RoundedRectangle(cornerRadius: 22))
            }
        }
        .padding()
        .background(.black)
    }
#endif
