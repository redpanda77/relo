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

/// A card's progress bar, merged: segments for a plan, one bar for a fraction or a long plan, the sweep of
/// light running through what is filled.
struct CardProgress: View {
    var spec: CardProgressSpec
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        CardProgressBar<LiveSweep>(shape: spec.shape, color: spec.color, height: ReloLayout.barHeight,
                                   sweep: { LiveSweep(active: spec.shimmer) })
        // A step finishing fills its segment and the next one lights, on a spring with no bounce.
        .animation(reduceMotion ? nil : .smooth(duration: 0.6), value: spec.shape)
        .animation(reduceMotion ? nil : .smooth(duration: 0.4), value: spec.color)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spec.spoken)
        .accessibilityValue(spec.steps == nil
                            ? (spec.fraction ?? 0).formatted(.percent.precision(.fractionLength(0))) : "")
    }
}

/// Where a card sits: on its own surface, as a row of a `CardGroup`, or bare in a List cell that already
/// carries the row background and its own horizontal inset.
enum ReloCardPlacement { case card, row, listCell }

/// The one progress layout, the Lock Screen's: the bar across the card and the step line under it
/// ("Step 3 of 5 · Run the tests", one line). Progress is content: it sits under the status it measures,
/// never on the card's edge or in the footer.
struct CardProgressRow: View {
    var caption: String?
    var spec: CardProgressSpec

    var body: some View {
        VStack(alignment: .leading, spacing: ReloLayout.cardGap) {
            CardProgress(spec: spec).padding(.top, 2)
            if let caption {
                Text(caption).font(ReloLayout.cardMeta).foregroundStyle(Color.reloSecondaryText).lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

/// The one card container: the glass surface, the standard inset and the line gap. Every card in the app is
/// this around header, title, status, progress and footer, all in plain layout flow.
struct ReloCard<Content: View>: View {
    var tint: Color? = nil
    var surface: ReloCardPlacement = .card
    @ViewBuilder var content: Content

    var body: some View {
        let sideInset: CGFloat = surface == .listCell ? 0 : ReloLayout.cardInset
        let vertical: CGFloat = surface == .card ? ReloLayout.cardInset : ReloLayout.rowInset
        let inner = VStack(alignment: .leading, spacing: ReloLayout.cardGap) { content }
            .padding(.horizontal, sideInset).padding(.vertical, vertical)
            .frame(maxWidth: .infinity, alignment: .leading)
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
            ReloMotionClock(framesPerSecond: 30, still: 0) { time in
                let cycle = 2.8
                // Travels from just before the left edge to just past the right, then rests. Eased in and
                // out (smoothstep), so the light gathers and settles instead of sliding at one speed.
                let t = min(time.truncatingRemainder(dividingBy: cycle) / (cycle * 0.7), 1)
                let phase = t * t * (3 - 2 * t) * 1.6 - 0.3
                LinearGradient(stops: [.init(color: .clear, location: 0),
                                       .init(color: .white.opacity(0.55), location: 0.5),
                                       .init(color: .clear, location: 1)],
                               startPoint: UnitPoint(x: phase - 0.18, y: 0.5),
                               endPoint: UnitPoint(x: phase + 0.18, y: 0.5))
                    .blendMode(.plusLighter)
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
            // Work that starts or stops moving fades its light in or out, never mid-sweep.
            .transition(.opacity.animation(.easeInOut(duration: 0.5)))
        }
    }
}
