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

/// A request waiting for the owner, as a satellite on the orbital plane. It travels from the
/// far left of the orbit toward the front as its deadline nears, and burns brighter at the end.
struct ReloOrbitSatellite: Equatable, Identifiable {
    let id: String
    /// Share of its answer window still left, 1 when asked and 0 at the deadline.
    let remaining: Double
}

/// The orbital plane: a wide tilted ring of particle streams through the deck, running past
/// both screen edges, so the header reads left to right rather than as a ball in a box. Drawn
/// in two halves around the orb: the far half behind it, the near half in front. Its particles
/// carry today's mix; requests waiting for the owner ride it as orange satellites (running work
/// is the ring's arcs, so each element means one thing). Ripples shove its particles too.
struct ReloOrbitPlane: View {
    enum Half { case far, near }
    let half: Half
    let state: ReloSignalState
    let mix: NowMix
    let satellites: [ReloOrbitSatellite]
    var framesPerSecond: Double = 30
    let waves: [ReloOrbWave]
    /// The orb's center in this view's coordinates.
    let center: CGPoint
    /// Where this view sits in the deck, whose coordinates the ripples use.
    var deckOffset: CGPoint = .zero

    private struct Grain { let angle, lane, speed, size, phase, slot: Double }

    private static let grains: [Grain] = {
        var seed: UInt64 = 0x4F524254
        func next() -> Double {
            seed = seed &* 6364136223846793005 &+ 1442695040888963407
            return Double(seed >> 11) / Double(UInt64(1) << 53)
        }
        return (0..<300).map { _ in
            Grain(angle: next() * .pi * 2, lane: pow(next(), 1.6) * (next() < 0.5 ? -1 : 1),
                  speed: 0.05 + next() * 0.07, size: 0.5 + pow(next(), 3) * 1.6, phase: next() * .pi * 2, slot: next())
        }
    }()

    var body: some View {
        ReloMotionClock(framesPerSecond: framesPerSecond, still: 4) { time in
            Canvas(opaque: false, colorMode: .extendedLinear, rendersAsynchronously: true) { context, size in draw(&context, size: size, t: time) }
        }
        .allowsHitTesting(false).accessibilityHidden(true)
    }

    private func draw(_ context: inout GraphicsContext, size: CGSize, t: Double) {
        let now = Date.now
        let live = waves.filter { now.timeIntervalSince($0.at) < 2.6 }
        let rx = size.width * 0.78, ry = rx * 0.15
        let tilt = -0.11
        let cosT = cos(tilt), sinT = sin(tilt)
        let accent = ReloHoloTheme.accent(for: state)
        let energy = state.energy
        func place(_ angle: Double, _ lane: Double) -> (CGPoint, Double) {
            let x = cos(angle) * rx * (1 + lane * 0.05)
            let y = sin(angle) * ry * (1 + lane * 0.35)
            // sin(angle) > 0 is the near side of the plane.
            return (CGPoint(x: center.x + x * cosT - y * sinT, y: center.y + x * sinT + y * cosT), sin(angle))
        }
        context.blendMode = .plusLighter

        // The plane's faint body: two hairline ellipses that fade toward the edges.
        for lane in [-0.6, 0.6] {
            var path = Path()
            var first = true
            for step in 0...240 {
                let angle = Double(step) / 240 * .pi * 2
                let (point, depth) = place(angle, lane)
                guard (half == .near) == (depth > 0) else { first = true; continue }
                if first { path.move(to: point); first = false } else { path.addLine(to: point) }
            }
            // Solid hairline (gradient shading on a CPU canvas is costly); the deck's edge mask fades it.
            context.stroke(path, with: .color(accent.opacity(0.3)), lineWidth: 0.6)
        }

        // Particle streams flowing around the plane, left to right across the front.
        for grain in Self.grains {
            let angle = grain.angle + t * grain.speed * (0.6 + 0.6 * energy)
            var (point, depth) = place(angle, grain.lane)
            guard (half == .near) == (depth > 0) else { continue }
            var lift = 0.0
            for wave in live {
                let push = wave.push(CGPoint(x: point.x + deckOffset.x, y: point.y + deckOffset.y), now: now)
                point.x += push.dx; point.y += push.dy; lift += push.lift
            }
            let nearness = (depth + 1) / 2
            let edgeFade = min(1, max(0, min(point.x, size.width - point.x) / 70))
            let twinkle = 0.6 + 0.4 * sin(t * 2.1 + grain.phase)
            let alpha = (0.26 + 0.74 * nearness) * twinkle * edgeFade * (1 + 1.2 * min(lift, 1))
            let color = ReloHoloTheme.accentSignal(mix, slot: grain.slot).map(ReloHoloTheme.color) ?? accent
            let r = grain.size * (0.6 + 0.7 * nearness) * (1 + 0.5 * min(lift, 1))
            context.fill(Path(ellipseIn: CGRect(x: point.x - r, y: point.y - r, width: r * 2, height: r * 2)),
                         with: .color(color.opacity(min(alpha, 1))))
        }

        // Waiting requests ride the plane as satellites: from the far left of the orbit toward
        // the front as the deadline nears; the last fifth of the window burns brighter.
        let orange = ReloHoloTheme.color(.needsYou), coral = ReloHoloTheme.deep(.needsYou)
        for (index, satellite) in satellites.prefix(6).enumerated() {
            let remaining = min(max(satellite.remaining, 0), 1)
            let angle = .pi / 2 - remaining * 1.5 * .pi - Double(index) * 0.22
            let (head, depth) = place(angle, 0)
            guard (half == .near) == (depth > 0) else { continue }
            let urgent = remaining < 0.2
            let pulse = urgent ? 1 + 0.35 * sin(t * 6 + Double(index)) : 1
            for step in 0..<16 {
                let (point, _) = place(angle + Double(step) * 0.011, 0)
                let r = (2.4 - Double(step) * 0.12) * pulse
                context.fill(Path(ellipseIn: CGRect(x: point.x - r, y: point.y - r, width: r * 2, height: r * 2)),
                             with: .color((step < 5 ? orange : coral).opacity(0.85 - Double(step) * 0.05)))
            }
            for (r, opacity) in [(9.0 * pulse, urgent ? 0.22 : 0.12), (5.0 * pulse, urgent ? 0.4 : 0.26)] {
                context.fill(Path(ellipseIn: CGRect(x: head.x - r, y: head.y - r, width: r * 2, height: r * 2)),
                             with: .color(orange.opacity(opacity)))
            }
            context.fill(Path(ellipseIn: CGRect(x: head.x - 1.6, y: head.y - 1.6, width: 3.2, height: 3.2)), with: .color(.white))
        }
    }
}

/// Today's proportions by meaning, edge to edge: one thin segmented bar with the meaning names
/// under their segments. It says what the colors mean without repeating the corner counts.
struct ReloSpectrumBar: View {
    let mix: NowMix

    var body: some View {
        let shares = mix.shares
        GeometryReader { proxy in
            let gap: CGFloat = 3
            let usable = proxy.size.width - gap * CGFloat(max(shares.count - 1, 0))
            HStack(alignment: .top, spacing: gap) {
                ForEach(shares, id: \.signal) { entry in
                    let width = max(usable * entry.share, 4)
                    VStack(alignment: .leading, spacing: 6) {
                        Capsule().fill(LinearGradient(colors: [ReloHoloTheme.color(entry.signal), ReloHoloTheme.deep(entry.signal)],
                                                      startPoint: .leading, endPoint: .trailing))
                            .frame(width: width, height: 3)
                        // A name only where it fits its own segment, so labels never collide.
                        if width > CGFloat(entry.signal.label.count) * 7.5 + 6 {
                            Text(entry.signal.label.uppercased())
                                .font(.system(size: 9, weight: .medium, design: .monospaced)).tracking(1.2)
                                .foregroundStyle(ReloHoloTheme.color(entry.signal).opacity(0.85))
                                .lineLimit(1).fixedSize()
                        }
                    }
                    .frame(width: width, alignment: .leading)
                }
            }
        }
        .frame(height: 22)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Today by kind: " + shares.map {
            "\(Int(($0.share * 100).rounded())) percent \($0.signal.label.lowercased())"
        }.joined(separator: ", "))
    }
}
