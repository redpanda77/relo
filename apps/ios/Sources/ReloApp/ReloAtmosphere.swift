import SwiftUI

/// One clock for every authored effect. It ticks only while the view is on screen, the app is
/// active, and the person has not asked for less motion or power; otherwise it holds `still`,
/// which renders the same frame every time.
struct ReloMotionClock<Content: View>: View {
    var live = true
    var framesPerSecond: Double = 60
    var still: TimeInterval = 42
    @ViewBuilder let content: (TimeInterval) -> Content
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var visible = false
    @State private var lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled

    private var ticking: Bool {
        live && visible && scenePhase == .active && !reduceMotion && !lowPower
    }

    var body: some View {
        Group {
            if ticking {
                TimelineView(.animation(minimumInterval: 1 / framesPerSecond)) { timeline in
                    content(still + timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 3_600))
                }
            } else {
                content(still)
            }
        }
        .onAppear { visible = true }
        .onDisappear { visible = false }
        .onReceive(NotificationCenter.default.publisher(for: .NSProcessInfoPowerStateDidChange)) { _ in
            lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
        }
    }
}

/// How much the Now screen asks of the person, which sets the signal's palette and energy.
enum ReloSignalState: Equatable {
    case clear, running, needsYou

    /// The color named in text and badges for this state.
    var primary: Color {
        switch self {
        case .clear: .reloDone
        case .running: .reloSignalIndigo
        case .needsYou: .reloSignalCoral
        }
    }

    /// Three particle stops, sampled across the sphere. Needs-you carries the full brand gradient.
    fileprivate var palette: [ReloRGB] {
        switch self {
        case .clear: [.init(0x34D399), .init(0x5EEAD4), .init(0x8B7CFF)]
        case .running: [.init(0x7C6BFF), .init(0xA99CFF), .init(0xD65CF0)]
        case .needsYou: [.init(0xFF6B57), .init(0xD65CF0), .init(0x7C6BFF)]
        }
    }

    var energy: Double {
        switch self {
        case .clear: 0.35
        case .running: 0.7
        case .needsYou: 1
        }
    }
}

/// The dashboard's gradient field: violet top-left, magenta top-right, coral below, on ink.
/// Static by design; glass surfaces sit on top of it.
struct ReloAppBackdrop: View {
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        ZStack {
            Color.reloCanvas
            if contrast != .increased && !reduceTransparency {
                EllipticalGradient(colors: [.reloMagenta.opacity(0.34), .clear],
                                   center: UnitPoint(x: 0.92, y: -0.14), endRadiusFraction: 0.68)
                EllipticalGradient(colors: [.reloIndigo.opacity(0.30), .clear],
                                   center: UnitPoint(x: -0.10, y: 0.06), endRadiusFraction: 0.68)
                EllipticalGradient(colors: [.reloCoral.opacity(0.22), .clear],
                                   center: UnitPoint(x: 0.64, y: 1.2), endRadiusFraction: 0.68)
            }
        }
        .ignoresSafeArea().allowsHitTesting(false).accessibilityHidden(true)
    }
}

// MARK: - Particle orb

fileprivate struct ReloRGB: Equatable {
    let red, green, blue: Double
    init(_ hex: UInt32) {
        red = Double((hex >> 16) & 255) / 255
        green = Double((hex >> 8) & 255) / 255
        blue = Double(hex & 255) / 255
    }
    init(red: Double, green: Double, blue: Double) { self.red = red; self.green = green; self.blue = blue }
    func mixed(with other: ReloRGB, _ amount: Double) -> ReloRGB {
        .init(red: red + (other.red - red) * amount, green: green + (other.green - green) * amount,
              blue: blue + (other.blue - blue) * amount)
    }
    var color: Color { Color(red: red, green: green, blue: blue) }
}

fileprivate func sample(_ palette: [ReloRGB], _ position: Double) -> ReloRGB {
    let scaled = min(max(position, 0), 1) * Double(palette.count - 1)
    let index = min(Int(scaled), palette.count - 2)
    return palette[index].mixed(with: palette[index + 1], scaled - Double(index))
}

fileprivate func smoothstep(_ edge0: Double, _ edge1: Double, _ x: Double) -> Double {
    let t = min(max((x - edge0) / (edge1 - edge0), 0), 1)
    return t * t * (3 - 2 * t)
}

/// A fixed, deterministic particle field: a Fibonacci sphere plus a tilted orbital ring.
/// Positions are unit-space; the view only rotates, breathes and projects them.
fileprivate enum ReloParticleField {
    struct Particle: Sendable {
        let x, y, z: Double
        let size: Double
        let phase: Double
        let hue: Double
    }

    struct SeededGenerator {
        var state: UInt64
        mutating func next() -> Double {
            state = state &* 6364136223846793005 &+ 1442695040888963407
            return Double(state >> 11) / Double(UInt64(1) << 53)
        }
    }

    static let sphere: [Particle] = {
        let count = 620
        let golden = Double.pi * (3 - 5.squareRoot())
        var generator = SeededGenerator(state: 0x52454C4F)
        return (0..<count).map { index in
            let y = 1 - (Double(index) + 0.5) / Double(count) * 2
            let radius = (1 - y * y).squareRoot()
            let theta = golden * Double(index)
            let jitter = 1 + (generator.next() - 0.5) * 0.08
            let x = cos(theta) * radius * jitter, z = sin(theta) * radius * jitter
            // Hue runs diagonally across the sphere, so the gradient turns as it rotates.
            let hue = min(max((x * 0.6 - y * 0.8 + 1) / 2 + (generator.next() - 0.5) * 0.12, 0), 1)
            return Particle(x: x, y: y * jitter, z: z, size: 0.55 + pow(generator.next(), 3) * 1.4,
                            phase: generator.next() * .pi * 2, hue: hue)
        }
    }()

    static let ring: [Particle] = {
        var generator = SeededGenerator(state: 0x52494E47)
        return (0..<170).map { index in
            let angle = Double(index) / 170 * .pi * 2 + (generator.next() - 0.5) * 0.05
            let radius = 1.3 + (generator.next() - 0.5) * 0.14
            return Particle(x: cos(angle) * radius, y: (generator.next() - 0.5) * 0.05, z: sin(angle) * radius,
                            size: 0.4 + pow(generator.next(), 2) * 0.8, phase: generator.next() * .pi * 2,
                            hue: Double(index) / 170)
        }
    }()
}

/// The Now signal: hundreds of particles forming a slowly turning sphere with an orbital ring.
/// Depth sets size and brightness; the center thins out so the count stays legible. New
/// activity sends one ring of particles outward. Decorative: the text beside it carries meaning.
struct ReloSignalOrb: View {
    let state: ReloSignalState
    /// Changes when new activity arrives; each increase emits one particle ring.
    let emissionTrigger: Int
    var live = true
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var emittedAt: Date?
    @State private var previous: ReloSignalState?
    @State private var changedAt = Date.distantPast

    var body: some View {
        Group {
            if contrast == .increased || reduceTransparency {
                Circle().fill(Color.reloSurface)
                    .overlay { Circle().strokeBorder(state.primary, lineWidth: 2) }
                    .padding(48)
            } else {
                ReloMotionClock(live: live, framesPerSecond: 60, still: 11) { time in
                    Canvas(opaque: false, colorMode: .extendedLinear, rendersAsynchronously: live) { context, size in
                        draw(in: &context, size: size, time: time)
                    }
                }
            }
        }
        .onChange(of: emissionTrigger) { old, new in
            if new > old && !reduceMotion { emittedAt = .now }
        }
        .onChange(of: state) { old, _ in previous = old; changedAt = .now }
        // The one authored entrance: the signal announces itself once when it appears.
        .onAppear { if live && !reduceMotion { emittedAt = .now } }
        .allowsHitTesting(false).accessibilityHidden(true)
    }

    private var palette: [ReloRGB] {
        let progress = min(Date.now.timeIntervalSince(changedAt) / 0.9, 1)
        guard let previous, progress < 1 else { return state.palette }
        let eased = progress * progress * (3 - 2 * progress)
        return zip(previous.palette, state.palette).map { $0.mixed(with: $1, eased) }
    }

    private func dot(_ context: inout GraphicsContext, _ point: CGPoint, _ radius: Double, _ color: Color) {
        context.fill(Path(ellipseIn: CGRect(x: point.x - radius, y: point.y - radius,
                                            width: radius * 2, height: radius * 2)), with: .color(color))
    }

    private func draw(in context: inout GraphicsContext, size: CGSize, time: TimeInterval) {
        let extent = min(size.width, size.height) / 2
        guard extent > 0 else { return }
        let center = CGPoint(x: size.width / 2, y: size.height / 2)
        let radius = extent * 0.6
        let palette = self.palette
        let energy = state.energy
        let small = radius < 60
        let mid = sample(palette, 0.5)

        // Ambient body light, then a dark lens so the count reads over the front particles.
        context.fill(Path(ellipseIn: CGRect(x: center.x - radius * 1.5, y: center.y - radius * 1.5,
                                            width: radius * 3, height: radius * 3)),
                     with: .radialGradient(Gradient(colors: [mid.color.opacity(0.20 + 0.10 * energy), .clear]),
                                           center: center, startRadius: radius * 0.2, endRadius: radius * 1.5))
        context.fill(Path(ellipseIn: CGRect(x: center.x - radius, y: center.y - radius,
                                            width: radius * 2, height: radius * 2)),
                     with: .radialGradient(Gradient(colors: [Color.reloCanvas.opacity(0.85), Color.reloCanvas.opacity(0)]),
                                           center: center, startRadius: 0, endRadius: radius * 0.95))

        context.blendMode = .plusLighter
        let spin = time * (0.16 + 0.14 * energy)
        let tilt = 0.38 + sin(time * 0.11) * 0.06
        let sinSpin = sin(spin), cosSpin = cos(spin)
        let sinTilt = sin(tilt), cosTilt = cos(tilt)
        let scale = radius / 96
        let stride = small ? 3 : 1

        func project(_ x: Double, _ y: Double, _ z: Double) -> (CGPoint, Double) {
            let perspective = 3.4 / (3.4 - z)
            return (CGPoint(x: center.x + x * radius * perspective, y: center.y + y * radius * perspective),
                    (z + 1) / 2)
        }

        for (index, particle) in ReloParticleField.sphere.enumerated() where index % stride == 0 {
            let breathe = 1 + 0.035 * sin(time * (0.9 + energy) + particle.phase * 3)
            let px = particle.x * breathe, py = particle.y * breathe, pz = particle.z * breathe
            // Spin around Y, then tilt toward the viewer around X.
            let rx = px * cosSpin + pz * sinSpin
            let rz0 = -px * sinSpin + pz * cosSpin
            let ry = py * cosTilt - rz0 * sinTilt
            let rz = py * sinTilt + rz0 * cosTilt
            let (point, depth) = project(rx, ry, rz)
            let distance = hypot(point.x - center.x, point.y - center.y) / radius
            let lens = rz > 0 ? 0.22 + 0.78 * smoothstep(0.30, 0.82, distance) : 1
            let twinkle = 0.72 + 0.28 * sin(time * (1.6 + particle.phase) + particle.phase * 7)
            let alpha = (0.10 + 0.9 * pow(depth, 1.5)) * lens * twinkle
            let size = particle.size * (0.5 + 0.8 * depth) * scale * (small ? 1.6 : 1)
            let color = sample(palette, particle.hue).color
            if particle.size > 1.25 && depth > 0.55 && !small {
                let glow = size * 3.2
                context.fill(Path(ellipseIn: CGRect(x: point.x - glow, y: point.y - glow, width: glow * 2, height: glow * 2)),
                             with: .radialGradient(Gradient(colors: [color.opacity(alpha * 0.35), .clear]),
                                                   center: point, startRadius: 0, endRadius: glow))
            }
            dot(&context, point, size, color.opacity(alpha))
        }

        // Orbital ring: its own slower, opposite drift, tilted steeply across the sphere.
        if !small {
            let orbit = -time * (0.10 + 0.08 * energy)
            let sinOrbit = sin(orbit), cosOrbit = cos(orbit)
            let ringTilt = 1.18, roll = -0.32
            for particle in ReloParticleField.ring {
                let ox = particle.x * cosOrbit - particle.z * sinOrbit
                let oz = particle.x * sinOrbit + particle.z * cosOrbit
                let ty = particle.y * cos(ringTilt) - oz * sin(ringTilt)
                let tz = particle.y * sin(ringTilt) + oz * cos(ringTilt)
                let rx = ox * cos(roll) - ty * sin(roll)
                let ry = ox * sin(roll) + ty * cos(roll)
                let (point, depth) = project(rx, ry, tz)
                let alpha = (0.08 + 0.62 * depth) * (0.6 + 0.4 * sin(time * 2 + particle.phase))
                dot(&context, point, particle.size * (0.5 + 0.6 * depth) * scale,
                    sample(palette, particle.hue).color.opacity(alpha))
            }
        }

        // Relay rings: a faint ambient one every few seconds, a bright one on new activity.
        func relay(progress: Double, strength: Double) {
            guard progress > 0, progress < 1 else { return }
            let ringRadius = radius * (1.02 + progress * 0.58)
            let fade = pow(1 - progress, 1.6) * strength
            let count = small ? 36 : 96
            for index in 0..<count {
                let angle = Double(index) / Double(count) * .pi * 2 + progress * 0.6
                let wobble = 1 + 0.02 * sin(angle * 5 + time * 3)
                let point = CGPoint(x: center.x + cos(angle) * ringRadius * wobble,
                                    y: center.y + sin(angle) * ringRadius * wobble)
                dot(&context, point, (1.4 - progress * 0.6) * scale,
                    sample(palette, Double(index) / Double(count)).color.opacity(fade))
            }
        }
        if live { relay(progress: (time / 5.5).truncatingRemainder(dividingBy: 1), strength: 0.28 * energy) }
        if let emittedAt { relay(progress: Date.now.timeIntervalSince(emittedAt) / 1.9, strength: 0.95) }
    }
}
