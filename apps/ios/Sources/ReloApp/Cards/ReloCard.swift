import ReloCore
import SwiftUI

/// What a card measures: the plan's steps, or a fraction. Drawn once, by `CardProgress`.
struct CardProgressSpec: Equatable {
    var steps: NowItem.Steps?
    var fraction: Double?
    var color: Color
    var shimmer = false

    init?(steps: NowItem.Steps?, fraction: Double?, color: Color, shimmer: Bool = false) {
        if let steps, steps.total > 0 {
            self.steps = steps
        } else if let fraction, fraction.isFinite {
            self.fraction = fraction
        } else {
            return nil
        }
        self.color = color
        self.shimmer = shimmer
    }

    var shape: CardProgressShape {
        if let steps { return .segments(steps.bar.segments) }
        return .fraction(fraction ?? 0)
    }

    var spoken: String {
        if let steps {
            let current = min(steps.currentIndex ?? steps.done + 1, max(steps.total, 1))
            return "Step \(current) of \(steps.total)\(steps.current.map { ": \($0)" } ?? "")"
        }
        return "Progress"
    }
}

/// A card's progress, merged: segments for a plan, one bar for a fraction or a long plan, the sweep of light
/// running through what is filled. `.edge` lays it along the card's bottom edge, which costs no row.
struct CardProgress: View {
    enum Placement { case inline, edge }

    var spec: CardProgressSpec
    var placement: Placement = .inline

    var body: some View {
        CardProgressBar<LiveSweep>(shape: spec.shape, color: spec.color,
                                   height: placement == .edge ? ReloLayout.edgeProgressHeight : ReloLayout.barHeight,
                                   sweep: { LiveSweep(active: spec.shimmer) })
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spec.spoken)
        .accessibilityValue(spec.steps == nil
                            ? (spec.fraction ?? 0).formatted(.percent.precision(.fractionLength(0))) : "")
    }
}

/// Where a card sits: on its own surface, as a row of a `CardGroup`, or bare in a List cell that already
/// carries the row background and its own horizontal inset.
enum ReloCardPlacement { case card, row, listCell }

/// The one card container: the glass surface, the standard inset and line gap, and an optional progress
/// bar along its bottom edge. Every card in the app is this around header, title, status and footer.
struct ReloCard<Content: View>: View {
    var tint: Color? = nil
    var progress: CardProgressSpec? = nil
    var surface: ReloCardPlacement = .card
    @ViewBuilder var content: Content

    var body: some View {
        let sideInset: CGFloat = surface == .listCell ? 0 : ReloLayout.cardInset
        let vertical: CGFloat = surface == .card ? ReloLayout.cardInset : ReloLayout.rowInset
        let inner = VStack(alignment: .leading, spacing: ReloLayout.cardGap) { content }
            .padding(.horizontal, sideInset).padding(.vertical, vertical)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .bottom) {
                if let progress {
                    CardProgress(spec: progress, placement: .edge).padding(.horizontal, sideInset)
                }
            }
        if surface == .card { inner.reloCard(tint: tint) } else { inner }
    }
}

/// The sweep of light used on live meters. It is a mask, not an overlay: it is drawn only
/// inside the shape it decorates (the filled part of a bar), so it never shows as a band over
/// the track or the label. It moves by sliding the gradient's start and end points.
struct LiveSweep: View {
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
