import SwiftUI

/// One running task as the HUD draws it: an arc whose length is its real progress.
struct ReloHoloTask: Equatable, Identifiable {
    let id: String
    /// 0...1, or `nil` when the task does not report progress (drawn as a travelling arc).
    let progress: Double?
}

/// The instrument ring around the particle sphere: fine ticks turning slowly, one hairline,
/// and one luminous arc per running task with a glowing head. Nothing is drawn inside the
/// sphere, so the count stays the only thing at the centre. Decorative; the readouts carry meaning.
struct ReloHoloRing: View {
    let state: ReloSignalState
    let tasks: [ReloHoloTask]
    /// Rises when something new arrives; each rise flashes the instrument once.
    var pulse = 0
    /// Rises when a card finishes; each rise flashes the instrument mint.
    var finished = 0
    var framesPerSecond: Double = 30
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Each task's arc glides from the value it showed to the new one, and flares when it moves.
    @State private var glides: [String: Glide] = [:]
    @State private var flashAt: Date?
    @Environment(\.reloEffectsArmed) private var armed
    @State private var flashColor = ReloHoloTheme.cyan

    private struct Glide { var from: Double; var to: Double; var at: Date }

    var body: some View {
        ReloMotionClock(framesPerSecond: framesPerSecond, still: 7) { time in
            Canvas(opaque: false, colorMode: .extendedLinear) { context, size in
                draw(&context, size: size, t: time)
            }
        }
        // Arcs already running when the ring appears are shown where they are, not replayed from 0.
        .onAppear { for task in tasks { if let p = task.progress { glides[task.id] = Glide(from: p, to: p, at: .distantPast) } } }
        .onChange(of: tasks) { _, new in
            let now = Date.now
            for task in new {
                guard let target = task.progress else { continue }
                let current = shown(task.id, now: now) ?? target
                if glides[task.id]?.to != target {
                    let still = reduceMotion || !armed
                    glides[task.id] = Glide(from: still ? target : current, to: target, at: still ? .distantPast : now)
                }
            }
        }
        .onChange(of: pulse) { old, new in
            if new > old && !reduceMotion && armed { flashColor = ReloHoloTheme.accent(for: state); flashAt = .now }
        }
        .onChange(of: finished) { old, new in
            if new > old && !reduceMotion && armed { flashColor = ReloHoloTheme.mint; flashAt = .now }
        }
        .allowsHitTesting(false).accessibilityHidden(true)
    }

    /// The arc value on screen now: an eased glide over 0.9 s.
    private func shown(_ id: String, now: Date) -> Double? {
        guard let glide = glides[id] else { return nil }
        let p = min(max(now.timeIntervalSince(glide.at) / 0.9, 0), 1)
        let eased = 1 - pow(1 - p, 3)
        return glide.from + (glide.to - glide.from) * eased
    }

    private func draw(_ context: inout GraphicsContext, size: CGSize, t: Double) {
        let center = CGPoint(x: size.width / 2, y: size.height / 2)
        let outer = min(size.width, size.height) / 2 - 2
        let accent = ReloHoloTheme.accent(for: state)
        let speed = state == .needsYou ? 1.5 : (state == .running ? 1 : 0.4)
        let gradient = Gradient(colors: ReloHoloTheme.colors(for: state))
        func point(_ radius: CGFloat, _ degrees: Double) -> CGPoint {
            let a = degrees * .pi / 180
            return CGPoint(x: center.x + cos(a) * radius, y: center.y + sin(a) * radius)
        }
        func arc(_ radius: CGFloat, _ from: Double, _ to: Double) -> Path {
            var path = Path()
            path.addArc(center: center, radius: radius, startAngle: .degrees(from), endAngle: .degrees(to), clockwise: false)
            return path
        }

        // Tick ring: 120 hairlines, a longer one every 30°, brightest where the light sweeps past.
        let turn = t * 3 * speed
        let sweep = (t * 40 * speed).truncatingRemainder(dividingBy: 360)
        for index in 0..<120 {
            let angle = Double(index) * 3 + turn
            let major = index % 10 == 0
            let distance = abs(((angle - sweep).truncatingRemainder(dividingBy: 360) + 540).truncatingRemainder(dividingBy: 360) - 180)
            let lit = max(0, 1 - distance / 50)
            var tick = Path()
            tick.move(to: point(outer - (major ? 7 : 3.5), angle))
            tick.addLine(to: point(outer, angle))
            let color = lit > 0 ? accent.opacity(0.25 + 0.65 * lit) : Color.white.opacity(major ? 0.34 : 0.13)
            context.stroke(tick, with: .color(color), lineWidth: major ? 0.9 : 0.5)
        }

        // Something new arrived: the whole instrument lights once and a ring leaves it.
        if let flashAt {
            let p = Date.now.timeIntervalSince(flashAt) / 1.4
            if p >= 0 && p < 1 {
                let fade = pow(1 - p, 2)
                for index in 0..<120 {
                    let angle = Double(index) * 3 + turn
                    var tick = Path()
                    tick.move(to: point(outer - 5, angle))
                    tick.addLine(to: point(outer, angle))
                    context.stroke(tick, with: .color(flashColor.opacity(0.8 * fade)), lineWidth: 0.8)
                }
                context.stroke(arc(outer + CGFloat(p) * 22, 0, 360), with: .color(flashColor.opacity(0.6 * fade)), lineWidth: 1)
            }
        }

        // One hairline just inside the ticks, its gradient slowly turning.
        let hairline = outer - 11
        // Solid, not a conic gradient: canvases rasterize on the CPU, and gradient shading
        // around a full circle every frame was the deck's main cost.
        context.stroke(arc(hairline, 0, 360), with: .color(accent.opacity(0.55)), style: StrokeStyle(lineWidth: 0.6))
        _ = gradient

        // Task arcs: a faint track, the measured arc with a soft bloom, and a glowing head.
        let tracks = tasks.prefix(3)
        for (index, task) in tracks.enumerated() {
            let radius = hairline - 7 - CGFloat(index) * 6
            context.stroke(arc(radius, 0, 360), with: .color(.white.opacity(0.07)), lineWidth: 1.2)
            let start: Double, end: Double
            let now = Date.now
            // A flare at the head for a moment after the task reports new progress.
            let flare = glides[task.id].map { max(0, 1 - now.timeIntervalSince($0.at) / 1.4) } ?? 0
            if let progress = shown(task.id, now: now) ?? task.progress {
                start = -90; end = -90 + max(0.015, min(1, progress)) * 360
            } else {
                start = -90 + t * 70 * speed + Double(index) * 120; end = start + 64
            }
            let path = arc(radius, start, end)
            let ramp = ReloHoloTheme.taskRamp(index)
            // Bloom as wider faint strokes (no blur filter), then the arc itself: all solid fills.
            if !reduceTransparency {
                context.stroke(path, with: .color(ramp[1].opacity(0.16)), style: StrokeStyle(lineWidth: 6, lineCap: .round))
                context.stroke(path, with: .color(ramp[0].opacity(0.28)), style: StrokeStyle(lineWidth: 3.2, lineCap: .round))
            }
            context.stroke(path, with: .color(ramp[0]), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
            let head = point(radius, end)
            let breathe = 1 + 0.25 * sin(t * 3 + Double(index)) + 1.6 * flare
            for (radius, opacity) in [(5.0, 0.18), (3.2, 0.35)] {
                let r = radius * breathe
                context.fill(Path(ellipseIn: CGRect(x: head.x - r, y: head.y - r, width: r * 2, height: r * 2)),
                             with: .color(ramp[2].opacity(opacity)))
            }
            context.fill(Path(ellipseIn: CGRect(x: head.x - 1.6, y: head.y - 1.6, width: 3.2, height: 3.2)), with: .color(.white))
        }

        // Idle: a single comet glides along the hairline so the instrument never looks frozen.
        if tracks.isEmpty {
            let head = -90 + t * 18
            for step in 0..<14 {
                let p = point(hairline, head - Double(step) * 1.6)
                let r = 1.8 - Double(step) * 0.11
                context.fill(Path(ellipseIn: CGRect(x: p.x - r, y: p.y - r, width: r * 2, height: r * 2)),
                             with: .color(accent.opacity(0.9 - Double(step) * 0.06)))
            }
        }
    }
}

/// A corner readout: a spaced caption over a light numeral, no frame or rule. When it is the
/// number that matters now, a small light sits by its caption and the numeral takes its color.
struct ReloHoloReadout: View {
    let label: String
    let value: String
    let alignment: HorizontalAlignment
    let lit: Bool
    /// The readout the centre is showing right now gets a soft halo behind its numeral.
    var focused = false
    let color: Color

    var body: some View {
        VStack(alignment: alignment, spacing: 2) {
            HStack(spacing: 5) {
                if lit && alignment == .leading { light }
                Text(label)
                    .font(.system(.caption2, design: .monospaced).weight(.medium)).tracking(1.6)
                    .foregroundStyle(lit ? color : Color.reloSecondaryText)
                if lit && alignment == .trailing { light }
            }
            Text(value)
                .font(.system(.title, design: .rounded).weight(.light))
                .foregroundStyle(lit ? color : .white)
                .shadow(color: focused && lit ? color.opacity(0.8) : .clear, radius: 10)
                .contentTransition(.numericText())
                .animation(.smooth(duration: 0.5), value: value)
        }
        .animation(.smooth(duration: 0.6), value: focused)
        .lineLimit(1).minimumScaleFactor(0.6)
        .fixedSize()
        .accessibilityElement(children: .combine)
    }

    private var light: some View {
        Circle().fill(color).frame(width: 5, height: 5).shadow(color: color, radius: 3)
    }
}

/// A status line in the instrument's voice: monospaced, with a scanning bar while it works.
struct ReloScanStatus: View {
    let text: String
    let symbol: String
    let tone: Color
    let working: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 10) {
            ReloMotionClock(live: working, still: 0) { time in
                Image(systemName: symbol)
                    .font(.footnote.weight(.semibold)).foregroundStyle(tone)
                    .rotationEffect(.degrees(working ? time * 240 : 0))
            }
            VStack(alignment: .leading, spacing: 5) {
                Text(text.uppercased())
                    .font(.system(.caption, design: .monospaced).weight(.medium)).tracking(1.2)
                    .foregroundStyle(working ? tone : Color.reloSecondaryText)
                    .fixedSize(horizontal: false, vertical: true)
                if working {
                    ReloMotionClock(still: 0.3) { time in
                        GeometryReader { proxy in
                            let width = proxy.size.width
                            let x = CGFloat((time / 1.6).truncatingRemainder(dividingBy: 1)) * (width + 80) - 80
                            ZStack(alignment: .leading) {
                                Capsule().fill(Color.white.opacity(0.08))
                                Capsule().fill(LinearGradient(colors: [.clear, tone, .clear], startPoint: .leading, endPoint: .trailing))
                                    .frame(width: 80).offset(x: x)
                            }
                            .clipShape(Capsule())
                        }
                    }
                    .frame(height: 2)
                    .accessibilityHidden(true)
                }
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 11)
        .background {
            RoundedRectangle(cornerRadius: 14, style: .continuous).fill(tone.opacity(0.07))
                .overlay { RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(tone.opacity(0.22), lineWidth: 0.5) }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(text)
    }
}
