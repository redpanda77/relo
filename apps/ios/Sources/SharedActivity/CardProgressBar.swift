import ReloCore
import SwiftUI

enum CardProgressShape: Equatable {
    case segments([PlanBar.Segment])
    case fraction(Double)
}

/// The one drawing of a card's progress, in the app and on the Lock Screen: a segment per top-level step
/// (finished ones whole, the current one filled to the server's fraction) or a single bar for a fraction or
/// a long plan. `sweep` is drawn through the filled parts only (the app's shimmer; the widget passes none).
struct CardProgressBar<Sweep: View>: View {
    var shape: CardProgressShape
    var color: Color
    var track: Color = .white.opacity(0.1)
    var currentTrack: Color = .white.opacity(0.18)
    var height: CGFloat = ReloLayout.barHeight
    @ViewBuilder var sweep: Sweep

    /// Steps always read as divided segments (a round holds at most 30); only a plan past this is one bar.
    static var segmentLimit: Int { 40 }

    var body: some View {
        switch shape {
        case let .segments(segments) where segments.count <= Self.segmentLimit:
            segmentRow(segments)
                .frame(height: height)
        case let .segments(segments):
            let whole = segments.reduce(0.0) { $0 + $1.fill }
            fractionBar(whole / Double(max(segments.count, 1)))
        case let .fraction(value):
            fractionBar(value)
        }
    }

    private func segmentRow(_ segments: [PlanBar.Segment]) -> some View {
        // Many steps keep their divisions with a thinner gap.
        HStack(spacing: segments.count > 16 ? ReloLayout.barGap / 2 : ReloLayout.barGap) {
            ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                // The sweep runs inside the current segment only (the widget passes none).
                Capsule().fill(segment.state == .current ? currentTrack : track)
                    .overlay(alignment: .leading) {
                        GeometryReader { proxy in
                            Capsule().fill(color).frame(width: proxy.size.width * min(max(segment.fill, 0), 1))
                        }
                    }
                    .overlay { if segment.state == .current { sweep } }
                    .clipShape(Capsule())
                .frame(height: height).frame(maxWidth: .infinity)
            }
        }
    }

    private func fractionBar(_ value: Double) -> some View {
        let fraction = value.isFinite ? min(max(value, 0), 1) : 0
        return GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(track)
                Capsule().fill(color)
                    .overlay { sweep }
                    .clipShape(Capsule())
                    .frame(width: max(height, proxy.size.width * fraction))
            }
        }
        .frame(height: height)
    }
}

extension CardProgressBar where Sweep == EmptyView {
    init(shape: CardProgressShape, color: Color, track: Color = .white.opacity(0.1),
         currentTrack: Color = .white.opacity(0.18), height: CGFloat = ReloLayout.barHeight) {
        self.init(shape: shape, color: color, track: track, currentTrack: currentTrack, height: height, sweep: { EmptyView() })
    }
}
