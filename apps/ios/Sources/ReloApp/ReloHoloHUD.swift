import SwiftUI

/// One running task as the HUD draws it: a ring arc whose length is its real progress.
struct ReloHoloTask: Equatable, Identifiable {
    let id: String
    /// 0...1, or `nil` when the task does not report progress (drawn as a travelling arc).
    let progress: Double?
}

/// The reticle: tick ring, counter-rotating dashed ring, one progress arc per running task,
/// a radar sweep and a scan-line shimmer. Decorative; the readouts around it carry the meaning.
struct ReloHoloReticle: View {
    let state: ReloSignalState
    let tasks: [ReloHoloTask]
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        TimelineView(.animation(minimumInterval: nil, paused: reduceMotion)) { timeline in
            let t = reduceMotion ? 0 : timeline.date.timeIntervalSinceReferenceDate
            Canvas { context, size in
                draw(&context, size: size, t: t)
            }
        }
        .accessibilityHidden(true)
    }

    private func draw(_ context: inout GraphicsContext, size: CGSize, t: Double) {
        let center = CGPoint(x: size.width / 2, y: size.height / 2)
        let radius = min(size.width, size.height) / 2 - 1
        let colors = ReloHoloTheme.colors(for: state)
        let accent = ReloHoloTheme.accent(for: state)
        let busy = state != .clear
        let speed = state == .needsYou ? 1.6 : (busy ? 1.0 : 0.35)
        let gradient = Gradient(colors: colors)
        func shading(_ turn: Double) -> GraphicsContext.Shading {
            .conicGradient(gradient, center: center, angle: .degrees(turn * 360))
        }
        func circle(_ r: CGFloat) -> Path { Path(ellipseIn: CGRect(x: center.x - r, y: center.y - r, width: r * 2, height: r * 2)) }
        func arc(_ r: CGFloat, _ from: Double, _ to: Double) -> Path {
            var p = Path()
            p.addArc(center: center, radius: r, startAngle: .degrees(from), endAngle: .degrees(to), clockwise: false)
            return p
        }

        // Backdrop: faint disc, scan lines, a drifting shimmer band while busy.
        context.fill(circle(radius), with: .radialGradient(
            Gradient(colors: [accent.opacity(busy ? 0.16 : 0.08), .clear]), center: center, startRadius: 0, endRadius: radius))
        context.drawLayer { layer in
            layer.clip(to: circle(radius - 3))
            var y: CGFloat = center.y - radius
            while y < center.y + radius {
                layer.fill(Path(CGRect(x: 0, y: y, width: size.width, height: 0.5)), with: .color(.white.opacity(0.045)))
                y += 4
            }
            if busy {
                let phase = (t * 0.28 * speed).truncatingRemainder(dividingBy: 1)
                let by = center.y - radius + CGFloat(phase) * radius * 2
                layer.fill(Path(CGRect(x: 0, y: by - 14, width: size.width, height: 28)), with: .linearGradient(
                    Gradient(colors: [.clear, accent.opacity(0.22), .clear]),
                    startPoint: CGPoint(x: 0, y: by - 14), endPoint: CGPoint(x: 0, y: by + 14)))
            }
        }

        // Radar sweep.
        if busy {
            let a = t * 60 * speed
            var wedge = Path()
            wedge.move(to: center)
            wedge.addArc(center: center, radius: radius - 6, startAngle: .degrees(a - 80), endAngle: .degrees(a), clockwise: false)
            wedge.closeSubpath()
            context.fill(wedge, with: .conicGradient(
                Gradient(stops: [.init(color: .clear, location: 0), .init(color: accent.opacity(0.34), location: 80 / 360),
                                 .init(color: .clear, location: 80 / 360 + 0.0001), .init(color: .clear, location: 1)]),
                center: center, angle: .degrees(a - 80)))
        }

        // Outer tick ring, slowly turning.
        let tickTurn = t * 4 * speed
        context.drawLayer { layer in
            layer.translateBy(x: center.x, y: center.y)
            layer.rotate(by: .degrees(tickTurn))
            for i in 0..<72 {
                let major = i % 6 == 0
                let angle = Double(i) / 72 * 2 * .pi
                var p = Path()
                p.move(to: CGPoint(x: cos(angle) * (radius - (major ? 8 : 4)), y: sin(angle) * (radius - (major ? 8 : 4))))
                p.addLine(to: CGPoint(x: cos(angle) * radius, y: sin(angle) * radius))
                layer.stroke(p, with: .color(.white.opacity(major ? 0.5 : 0.22)), lineWidth: major ? 0.8 : 0.5)
            }
        }
        context.stroke(circle(radius - 10), with: shading(tickTurn / 360), lineWidth: 0.6)

        // Dashed ring turning the other way, with a brighter travelling segment when idle.
        let dashR = radius - 18
        context.drawLayer { layer in
            layer.translateBy(x: center.x, y: center.y)
            layer.rotate(by: .degrees(-t * 9 * speed))
            layer.translateBy(x: -center.x, y: -center.y)
            layer.stroke(circle(dashR), with: .color(.white.opacity(0.28)),
                         style: StrokeStyle(lineWidth: 0.7, dash: [1.5, 5]))
        }

        // One ring per running task; idle shows a single calm ring with a slow segment.
        let ringCount = max(1, min(tasks.count, 4))
        let first = radius - 27
        let gap = min(9, max(5, (first - 46) / CGFloat(max(ringCount - 1, 1))))
        for index in 0..<ringCount {
            let r = first - CGFloat(index) * gap
            context.stroke(circle(r), with: .color(.white.opacity(0.10)), lineWidth: 1.4)
            let progress: Double? = tasks.indices.contains(index) ? tasks[index].progress : 0
            var start = -90.0, end = -90.0
            if let progress {
                end = start + max(0, min(1, progress)) * 360
            } else {
                start = -90 + t * 140 * speed + Double(index) * 70
                end = start + 100
            }
            if !tasks.indices.contains(index) { // idle segment
                start = -90 + t * 22 * speed
                end = start + 70
            }
            guard end - start > 0.5 else { continue }
            let path = arc(r, start, end)
            if !reduceTransparency {
                context.drawLayer { layer in
                    layer.addFilter(.blur(radius: 4))
                    layer.stroke(path, with: shading(t * 0.05 * speed), style: StrokeStyle(lineWidth: 3.5, lineCap: .round))
                }
            }
            context.stroke(path, with: shading(t * 0.05 * speed), style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
            // Leading node.
            let head = end * .pi / 180
            let hp = CGPoint(x: center.x + cos(head) * r, y: center.y + sin(head) * r)
            context.fill(Path(ellipseIn: CGRect(x: hp.x - 2, y: hp.y - 2, width: 4, height: 4)), with: .color(.white))
        }

        // Pulse ring around the readout: gentle when running, stronger when something needs you.
        let pulseBase: CGFloat = 36
        if busy {
            let period = state == .needsYou ? 1.1 : 2.4
            let p = (t / period).truncatingRemainder(dividingBy: 1)
            let grow = CGFloat(p) * (state == .needsYou ? 14 : 8)
            context.stroke(circle(pulseBase + grow), with: .color(accent.opacity((1 - p) * (state == .needsYou ? 0.7 : 0.4))), lineWidth: 1)
        }
        context.stroke(circle(pulseBase), with: .color(accent.opacity(0.35)), lineWidth: 0.6)

        // Crosshair ticks at the cardinal points.
        for angle in stride(from: 0.0, to: 360.0, by: 90.0) {
            let a = angle * .pi / 180
            var p = Path()
            p.move(to: CGPoint(x: center.x + cos(a) * (pulseBase + 4), y: center.y + sin(a) * (pulseBase + 4)))
            p.addLine(to: CGPoint(x: center.x + cos(a) * (pulseBase + 10), y: center.y + sin(a) * (pulseBase + 10)))
            context.stroke(p, with: .color(accent.opacity(0.7)), lineWidth: 0.8)
        }
    }
}

/// The full HUD: reticle with a live readout in the middle, three telemetry cells under it.
struct ReloHoloHUD: View {
    let state: ReloSignalState
    let tasks: [ReloHoloTask]
    let readout: Int
    let readoutLabel: String
    let telemetry: [Telemetry]
    @ScaledMetric(relativeTo: .largeTitle) private var readoutSize: CGFloat = 40
    @ScaledMetric(relativeTo: .caption2) private var labelSize: CGFloat = 10

    struct Telemetry: Equatable, Identifiable {
        let label: String
        let value: String
        var highlighted = false
        var id: String { label }
    }

    var body: some View {
        VStack(spacing: 10) {
            ZStack {
                ReloHoloReticle(state: state, tasks: tasks)
                VStack(spacing: 1) {
                    Text(readout.formatted())
                        .font(.system(size: readoutSize, weight: .ultraLight, design: .monospaced))
                        .monospacedDigit()
                        .foregroundStyle(.white)
                        .shadow(color: ReloHoloTheme.accent(for: state).opacity(0.8), radius: 8)
                        .lineLimit(1).minimumScaleFactor(0.5)
                        .contentTransition(.numericText(value: Double(readout)))
                    Text(readoutLabel)
                        .font(.system(size: min(labelSize, 11), weight: .medium, design: .monospaced))
                        .tracking(1.2)
                        .foregroundStyle(ReloHoloTheme.accent(for: state))
                        .lineLimit(1).minimumScaleFactor(0.5)
                }
                .frame(width: 92)
            }
            .frame(width: 196, height: 196)
            HStack(spacing: 0) {
                ForEach(Array(telemetry.enumerated()), id: \.element.id) { index, cell in
                    if index > 0 {
                        Rectangle().fill(.white.opacity(0.14)).frame(width: 0.5, height: 30)
                    }
                    VStack(spacing: 2) {
                        Text(cell.value)
                            .font(.system(.title3, design: .monospaced).weight(.light)).monospacedDigit()
                            .foregroundStyle(cell.highlighted ? ReloHoloTheme.coral : .white)
                            .lineLimit(1).minimumScaleFactor(0.6)
                        Text(cell.label)
                            .font(.system(.caption2, design: .monospaced)).tracking(1.2)
                            .foregroundStyle(Color.reloSecondaryText)
                            .lineLimit(1).minimumScaleFactor(0.6)
                    }
                    .frame(maxWidth: .infinity)
                }
            }
            .padding(.vertical, 6)
            .background(alignment: .top) { Rectangle().fill(LinearGradient(colors: [.clear, ReloHoloTheme.cyan.opacity(0.5), .clear], startPoint: .leading, endPoint: .trailing)).frame(height: 0.5) }
            .background(alignment: .bottom) { Rectangle().fill(LinearGradient(colors: [.clear, ReloHoloTheme.magenta.opacity(0.5), .clear], startPoint: .leading, endPoint: .trailing)).frame(height: 0.5) }
        }
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
    }
}
