import ReloCore
import SwiftUI

/// The plasma core (a Metal shader, see ReloPlasmaOrb.metal) in today's meaning colors.
struct ReloPlasmaOrb: View {
    let state: ReloSignalState
    let mix: NowMix
    /// The latest ripple, in this view's own coordinates.
    var wave: ReloOrbWave?
    var waveOffset: CGPoint = .zero
    var framesPerSecond: Double = 30

    var body: some View {
        let stops = colorStops
        ReloMotionClock(framesPerSecond: framesPerSecond, still: 9) { time in
            GeometryReader { proxy in
                let age = wave.map { Date.now.timeIntervalSince($0.at) } ?? -1
                let touch = wave.map { CGPoint(x: $0.origin.x - waveOffset.x, y: $0.origin.y - waveOffset.y) } ?? .zero
                Rectangle().fill(.black)
                    .colorEffect(ShaderLibrary.reloPlasmaOrb(
                        .float2(proxy.size), .float(Float(time)), .float(Float(state.energy)),
                        .color(stops.colors[0]), .color(stops.colors[1]), .color(stops.colors[2]), .color(stops.colors[3]),
                        .float4(stops.weights.0, stops.weights.1, stops.weights.2, stops.weights.3),
                        .float2(touch), .float(Float(age))))
            }
        }
        .allowsHitTesting(false).accessibilityHidden(true)
    }

    /// Up to four meanings by share, cumulative stops; the state palette when today is empty.
    private var colorStops: (colors: [Color], weights: (Float, Float, Float, Float)) {
        let shares = mix.shares.sorted { $0.share > $1.share }.prefix(4)
        guard !shares.isEmpty else {
            let palette = ReloHoloTheme.colors(for: state)
            return ([palette[0], palette[1], palette[2], palette[1]], (0.34, 0.67, 0.9, 1))
        }
        // Relo blue is the body; today's two leading meanings run through it as accents.
        let palette = ReloHoloTheme.colors(for: state)
        let lead = ReloHoloTheme.color(shares[0].signal)
        let second = shares.count > 1 ? ReloHoloTheme.color(shares[1].signal) : palette[2]
        return ([palette[0], lead, palette[1], second], (0.42, 0.6, 0.88, 1))
    }
}
