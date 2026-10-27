//
//  ReloHomeDeck.swift
//  Relo
//
//  The main window's Now deck, as the iPhone draws it (ReloNowHero, ReloHoloHUD, ReloHUDModule; mirrored, sized for the
//  window's aside): the plasma orb, an instrument ring with one arc per running card, a gauge ring with the four readouts
//  docked on it (needs you, your turn, running, sessions), the working sessions as satellites on an outer orbit, and the
//  lead's count at the centre. Colours are the iPhone's, so a meaning reads the same on every device.
//

import ReloNotchKit
import SwiftUI

/// The iPhone's deck colours (ReloHoloTheme).
enum ReloDeckTheme {
    static let ink = Color(red: 0x05 / 255, green: 0x06 / 255, blue: 0x0B / 255)
    static let cyan = Color(red: 0x5C / 255, green: 0xE1 / 255, blue: 1)
    static let blue = Color(red: 0x4D / 255, green: 0x8D / 255, blue: 1)
    static let sky = Color(red: 0x7D / 255, green: 0xD3 / 255, blue: 0xFC / 255)
    static let azure = Color(red: 0x38 / 255, green: 0xBD / 255, blue: 0xF8 / 255)
    static let violet = Color(red: 0x8B / 255, green: 0x7C / 255, blue: 1)
    static let coral = Color(red: 1, green: 0x6B / 255, blue: 0x57 / 255)
    static let amber = Color(red: 0xFB / 255, green: 0xBF / 255, blue: 0x24 / 255)
    static let orange = Color(red: 1, green: 0x8A / 255, blue: 0x3D / 255)
    static let slate = Color(red: 0x94 / 255, green: 0xA3 / 255, blue: 0xB8 / 255)
    /// Sessions working now: their own hue, apart from the cards' cyan.
    static let sessions = Color(red: 0xA9 / 255, green: 0x9E / 255, blue: 1)

    /// Each running card's arc: all in the running family, each a different shade.
    static func taskRamp(_ index: Int) -> [Color] {
        let ramps: [[Color]] = [[cyan, blue, cyan], [sky, azure, blue], [blue, cyan, sky], [azure, sky, cyan]]
        return ramps[index % ramps.count]
    }
}

/// What the deck leads with, most urgent first (the iPhone's ReloHUDLead, work layer).
enum ReloDeckLead: Equatable {
    case needsYou, yourTurn, running, quiet, clear

    var accent: Color {
        switch self {
        case .needsYou: ReloDeckTheme.orange
        case .yourTurn: ReloDeckTheme.amber
        case .running: ReloDeckTheme.cyan
        case .quiet: ReloDeckTheme.sessions
        case .clear: Color(red: 0x7F / 255, green: 0xA9 / 255, blue: 1)
        }
    }

    /// The bottom of the count's white-to-colour ramp.
    var ramp: Color {
        switch self {
        case .needsYou: ReloDeckTheme.coral
        case .yourTurn: Color(red: 0xF5 / 255, green: 0x9E / 255, blue: 0x0B / 255)
        case .running: ReloDeckTheme.blue
        case .quiet: ReloDeckTheme.violet
        case .clear: accent
        }
    }

    /// The count breathes behind its number only while something needs the owner or moves.
    var glowPeriod: Double? {
        switch self {
        case .needsYou: 1.8
        case .yourTurn: 2.1
        case .running, .quiet: 3.6
        case .clear: nil
        }
    }
}

/// The four readouts' places on the gauge ring: needs you top left, your turn top right, running bottom right, sessions
/// bottom left. Angles are SwiftUI's, clockwise from east.
enum ReloDeckSlot: Int, CaseIterable {
    case needsYou, yourTurn, running, sessions

    var angle: Double {
        switch self {
        case .needsYou: 225
        case .yourTurn: 315
        case .running: 45
        case .sessions: 135
        }
    }

    var leading: Bool { self == .needsYou || self == .sessions }

    var label: String {
        switch self {
        case .needsYou: "NEEDS YOU"
        case .yourTurn: "YOUR TURN"
        case .running: "RUNNING"
        case .sessions: "SESSIONS"
        }
    }

    var color: Color {
        switch self {
        case .needsYou: ReloDeckTheme.orange
        case .yourTurn: ReloDeckTheme.amber
        case .running: ReloDeckTheme.cyan
        case .sessions: ReloDeckTheme.sessions
        }
    }

    /// The colour mixed 55% with white (the label's pale tint).
    var pale: Color { color.reloLight(0.45) }
}

/// One satellite: a working or waiting session, in its phase's colour.
struct ReloDeckSatellite: Equatable, Identifiable {
    enum Phase { case needsYou, yourTurn, running, quiet }
    let id: String
    let phase: Phase

    var color: Color {
        switch phase {
        case .needsYou: ReloDeckTheme.orange
        case .yourTurn: ReloDeckTheme.amber
        case .running: ReloDeckTheme.cyan
        case .quiet: ReloDeckTheme.slate
        }
    }
}

struct ReloHomeDeck: View {
    let presentation: NotchPresentation
    var offline = false

    /// The gauge ring the readouts dock on, and the orbit the satellites ride (the iPhone's 128 and 164, scaled to the aside).
    private let gaugeRadius: CGFloat = 104
    private let orbitRadius: CGFloat = 132
    private var side: CGFloat { orbitRadius * 2 + 32 }

    private var counts: NotchPresentation.Counts { presentation.counts }
    /// Sessions at work: waiting on the owner, or working (on a card: running; without one: quiet).
    private var satellites: [ReloDeckSatellite] {
        presentation.sessions.compactMap { session -> ReloDeckSatellite? in
            switch session.phase {
            case .waiting?: ReloDeckSatellite(id: session.id, phase: session.waitingFor == "input" ? .needsYou : .yourTurn)
            case .working?: ReloDeckSatellite(id: session.id, phase: session.hasCard ? .running : .quiet)
            default: nil
            }
        }
    }

    private var sessionCount: Int { satellites.count }

    /// The running cards' arcs: their plan's progress, or a travelling arc when they report none.
    private var tasks: [ReloDeckTask] {
        presentation.sections.filter { $0.kind == .running }.flatMap(\.rows).map { row in
            let progress: Double? = if let done = row.stepsDone, let total = row.stepsTotal, total > 0 {
                (Double(done) + (row.currentFill ?? 0)) / Double(total)
            } else { nil }
            return ReloDeckTask(id: row.id, progress: progress)
        }
    }

    private var lead: ReloDeckLead {
        if counts.needsYou > 0 { return .needsYou }
        if counts.yourTurn > 0 { return .yourTurn }
        if counts.running > 0 { return .running }
        return sessionCount > 0 ? .quiet : .clear
    }

    private var readout: (value: String?, label: String) {
        switch lead {
        case .needsYou: (counts.needsYou.formatted(), "NEEDS YOU")
        case .yourTurn: (counts.yourTurn.formatted(), "YOUR TURN")
        case .running: (counts.running.formatted(), "RUNNING")
        case .quiet: (sessionCount.formatted(), "SESSIONS")
        case .clear: (nil, "ALL CLEAR")
        }
    }

    private var mood: ReloOrb.Mood {
        switch lead {
        case .needsYou, .yourTurn: .needsYou
        case .running, .quiet: .running
        case .clear: .clear
        }
    }

    var body: some View {
        ZStack {
            if lead == .needsYou { ReloDeckNeedsPulse(diameter: 172, color: lead.accent) }
            ReloOrb(mood: mood)
                .frame(width: 172, height: 172)
                .saturation(offline ? 0.12 : 1)
                .brightness(offline ? -0.4 : 0)
            ReloDeckRing(accent: lead.accent, tasks: tasks, frozen: offline)
                .frame(width: 204, height: 204)
            ReloDeckGauges(gauges: gauges, radius: gaugeRadius)
                .frame(width: gaugeRadius * 2 + 12, height: gaugeRadius * 2 + 12)
            ReloDeckSatellites(satellites: satellites, radius: orbitRadius, frozen: offline)
                .frame(width: side, height: side)
            ReloDeckCentre(value: readout.value, label: readout.label, lead: lead)
                .frame(width: 140)
            tags
        }
        .frame(width: side, height: side)
        .animation(ReloMotion.base, value: lead)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Now")
        .accessibilityValue("\(counts.needsYou) need you, \(counts.yourTurn) your turn, \(counts.running) running, \(sessionCount) sessions")
    }

    private var gauges: [ReloDeckSlot: ReloDeckGauges.Gauge] {
        let progress = tasks.compactMap(\.progress)
        let runFill = progress.isEmpty ? 0.5 : progress.reduce(0, +) / Double(progress.count)
        return [
            .needsYou: .init(fill: Double(counts.needsYou) / 5, lit: counts.needsYou > 0, dimmed: offline),
            .yourTurn: .init(fill: Double(counts.yourTurn) / 5, lit: counts.yourTurn > 0, dimmed: offline),
            .running: .init(fill: runFill, lit: counts.running > 0, dimmed: offline),
            .sessions: .init(fill: Double(sessionCount) / 6, lit: sessionCount > 0, dimmed: offline),
        ]
    }

    /// Each readout docked where its gauge meets the ring: the number nearest the instrument.
    private var tags: some View {
        let values: [ReloDeckSlot: Int] = [.needsYou: counts.needsYou, .yourTurn: counts.yourTurn,
                                           .running: counts.running, .sessions: sessionCount]
        return ZStack {
            ForEach(ReloDeckSlot.allCases, id: \.self) { slot in
                let angle = slot.angle * .pi / 180
                let dock = CGPoint(x: side / 2 + cos(angle) * (gaugeRadius + 6), y: side / 2 + sin(angle) * (gaugeRadius + 6))
                let value = values[slot] ?? 0
                ReloDeckTag(slot: slot, value: value.formatted(), lit: value > 0 && !offline, dimmed: offline && value > 0)
                    .frame(width: 140, alignment: slot.leading ? .trailing : .leading)
                    .position(x: slot.leading ? dock.x + 14 - 70 : dock.x - 14 + 70, y: dock.y)
            }
        }
        .frame(width: side, height: side)
    }
}

struct ReloDeckTask: Equatable, Identifiable {
    let id: String
    /// 0...1, or nil when the card reports no progress (drawn as a travelling arc).
    let progress: Double?
}

/// The instrument ring: 120 fine ticks turning slowly with a light sweeping past, one hairline, and one arc per running
/// card with a glowing head; idle, a single comet glides along the hairline.
struct ReloDeckRing: View {
    let accent: Color
    let tasks: [ReloDeckTask]
    var frozen = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if ReloEffects.metal {
                ReloEffectView(motion: ReloEffectMotion(live: !frozen, still: 7)) { [accent, tasks] canvas in
                    var sink = canvas.sink()
                    ReloDeckRingPainter(accent: accent, tasks: tasks, size: canvas.size, t: canvas.time).paint(&sink)
                }
            } else {
                ReloMotionClock(live: !frozen, framesPerSecond: 30, still: 7) { t in
                    Canvas { context, size in
                        var sink = GraphicsContextSink(ctx: context)
                        ReloDeckRingPainter(accent: accent, tasks: tasks, size: size, t: t).paint(&sink)
                    }
                }
            }
        }
        .allowsHitTesting(false).accessibilityHidden(true)
    }
}

/// The instrument ring at one instant.
struct ReloDeckRingPainter {
    let accent: Color
    let tasks: [ReloDeckTask]
    let size: CGSize
    let t: Double

    func paint<S: ReloPaintSink>(_ context: inout S) {
        let center = CGPoint(x: size.width / 2, y: size.height / 2)
        let outer = min(size.width, size.height) / 2 - 2
        let speed = tasks.isEmpty ? 0.4 : 1.0
        func point(_ radius: CGFloat, _ degrees: Double) -> CGPoint {
            let a = degrees * .pi / 180
            return CGPoint(x: center.x + cos(a) * radius, y: center.y + sin(a) * radius)
        }
        let turn = t * 3 * speed
        let sweep = (t * 40 * speed).truncatingRemainder(dividingBy: 360)
        for index in 0..<120 {
            let angle = Double(index) * 3 + turn
            let major = index % 10 == 0
            let distance = abs(((angle - sweep).truncatingRemainder(dividingBy: 360) + 540).truncatingRemainder(dividingBy: 360) - 180)
            let lit = max(0, 1 - distance / 50)
            let color = lit > 0 ? accent.opacity(0.25 + 0.65 * lit) : Color.white.opacity(major ? 0.34 : 0.13)
            context.strokeLines([point(outer - (major ? 6 : 3), angle), point(outer, angle)], .color(color),
                                lineWidth: major ? 0.9 : 0.5, round: false)
        }
        let hairline = outer - 10
        context.strokeArc(center: center, radius: hairline, from: 0, to: 360, accent.opacity(0.55), lineWidth: 0.6, round: false)
        for (index, task) in tasks.prefix(3).enumerated() {
            let radius = hairline - 6 - CGFloat(index) * 5
            context.strokeArc(center: center, radius: radius, from: 0, to: 360, .white.opacity(0.07), lineWidth: 1.2, round: false)
            let start: Double, end: Double
            if let progress = task.progress {
                start = -90; end = -90 + max(0.015, min(1, progress)) * 360
            } else {
                start = -90 + t * 70 + Double(index) * 120; end = start + 64
            }
            let ramp = ReloDeckTheme.taskRamp(index)
            context.strokeArc(center: center, radius: radius, from: start, to: end, ramp[1].opacity(0.16), lineWidth: 6, round: true)
            context.strokeArc(center: center, radius: radius, from: start, to: end, ramp[0].opacity(0.28), lineWidth: 3.2, round: true)
            context.strokeArc(center: center, radius: radius, from: start, to: end, ramp[0], lineWidth: 1.5, round: true)
            let head = point(radius, end)
            let breathe = 1 + 0.25 * sin(t * 3 + Double(index))
            for (r0, opacity) in [(5.0, 0.18), (3.2, 0.35)] {
                context.disc(head, r0 * breathe, ramp[2].opacity(opacity))
            }
            context.disc(head, 1.6, .white)
        }
        if tasks.isEmpty {
            let head = -90 + t * 18
            for step in 0..<14 {
                context.disc(point(hairline, head - Double(step) * 1.6), 1.8 - Double(step) * 0.11, accent.opacity(0.9 - Double(step) * 0.06))
            }
        }
    }
}

/// The gauge ring: four quadrant arcs, one per readout, each lit from its middle outward by how full it is.
struct ReloDeckGauges: View {
    struct Gauge: Equatable { var fill: Double; var lit: Bool; var dimmed = false }
    let gauges: [ReloDeckSlot: Gauge]
    let radius: CGFloat

    var body: some View {
        Canvas { context, size in
            let center = CGPoint(x: size.width / 2, y: size.height / 2)
            func arc(_ from: Double, _ to: Double) -> Path {
                Path { $0.addArc(center: center, radius: radius, startAngle: .degrees(from), endAngle: .degrees(to), clockwise: false) }
            }
            for slot in ReloDeckSlot.allCases {
                context.stroke(arc(slot.angle - 40, slot.angle + 40), with: .color(.white.opacity(0.1)), lineWidth: 3)
                guard let gauge = gauges[slot], gauge.lit, gauge.fill > 0 else { continue }
                let half = 38 * min(max(gauge.fill, 0.04), 1)
                let color = gauge.dimmed ? ReloDeckTheme.slate.opacity(0.6) : slot.color
                var glow = context
                glow.addFilter(.blur(radius: 4))
                glow.stroke(arc(slot.angle - half, slot.angle + half), with: .color(color.opacity(0.7)), style: StrokeStyle(lineWidth: 4, lineCap: .round))
                context.stroke(arc(slot.angle - half, slot.angle + half), with: .color(color), style: StrokeStyle(lineWidth: 3, lineCap: .round))
            }
        }
        .allowsHitTesting(false).accessibilityHidden(true)
    }
}

/// A readout docked on the gauge ring: its number nearest the ring, its label outward, tinted when lit, a dashed outline
/// at zero. A value that changes glows once.
struct ReloDeckTag: View {
    let slot: ReloDeckSlot
    let value: String
    let lit: Bool
    var dimmed = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var flare = 0.0

    var body: some View {
        let color = dimmed ? ReloDeckTheme.slate : slot.color
        HStack(spacing: 7) {
            if slot.leading { label; number(color) } else { number(color); label }
        }
        .padding(.horizontal, 10)
        .frame(height: 24)
        .background {
            ZStack {
                Capsule().fill(ReloDeckTheme.ink.opacity(0.92))
                if lit { Capsule().fill(color.opacity(0.17)) }
            }
        }
        .overlay {
            Capsule().strokeBorder(lit ? color.opacity(0.45) : .white.opacity(0.2), style: StrokeStyle(lineWidth: 0.75, dash: lit ? [] : [3, 2]))
        }
        .shadow(color: lit ? color.opacity(0.22 + 0.5 * flare) : .clear, radius: 7 + 6 * flare)
        .fixedSize()
        .onChange(of: value) { _, _ in
            guard !reduceMotion else { return }
            flare = 1
            withAnimation(.easeOut(duration: 1.3)) { flare = 0 }
        }
    }

    private func number(_ color: Color) -> some View {
        Text(value)
            .font(.system(size: 14, weight: .semibold, design: .rounded))
            .foregroundStyle(lit ? color : .white.opacity(dimmed ? 0.6 : 0.42))
            .contentTransition(.numericText())
            .animation(reduceMotion ? nil : .smooth(duration: 0.35), value: value)
    }

    private var label: some View {
        Text(slot.label)
            .font(.system(size: 8, weight: .bold, design: .monospaced)).tracking(1.3)
            .foregroundStyle(lit ? slot.pale : Color(red: 0x6B / 255, green: 0x74 / 255, blue: 0x88 / 255))
            .lineLimit(1)
    }
}

/// The sessions at work as satellites on the outer orbit, each with a fading tail. Quiet ones drift slowly in grey; one
/// waiting on the owner's turn parks at twelve o'clock and pulses.
struct ReloDeckSatellites: View {
    let satellites: [ReloDeckSatellite]
    let radius: CGFloat
    var frozen = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if ReloEffects.metal {
                ReloEffectView(motion: ReloEffectMotion(live: !frozen && !satellites.isEmpty, still: 7)) { [satellites, radius, frozen] canvas in
                    var sink = canvas.sink()
                    ReloDeckSatellitesPainter(satellites: satellites, radius: radius, frozen: frozen, size: canvas.size, time: canvas.time)
                        .paint(&sink)
                }
            } else {
                ReloMotionClock(live: !frozen && !satellites.isEmpty, framesPerSecond: 30, still: 7) { time in
                    Canvas { context, size in
                        var sink = GraphicsContextSink(ctx: context)
                        ReloDeckSatellitesPainter(satellites: satellites, radius: radius, frozen: frozen, size: size, time: time).paint(&sink)
                    }
                }
            }
        }
        .allowsHitTesting(false).accessibilityHidden(true)
    }

    /// A stable start angle per session, so satellites never jump when the list changes.
    static func seed(_ id: String) -> Int {
        id.unicodeScalars.reduce(5381) { (($0 << 5) &+ $0) &+ Int($1.value) } & 0x7fff_ffff
    }
}

/// The satellites at one instant.
struct ReloDeckSatellitesPainter {
    let satellites: [ReloDeckSatellite]
    let radius: CGFloat
    let frozen: Bool
    let size: CGSize
    let time: Double

    func paint<S: ReloPaintSink>(_ context: inout S) {
        let center = CGPoint(x: size.width / 2, y: size.height / 2)
        let track = CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)
        context.strokeEllipse(track, .white.opacity(0.09), lineWidth: 1)
        func point(_ degrees: Double) -> CGPoint {
            let a = degrees * .pi / 180
            return CGPoint(x: center.x + cos(a) * radius, y: center.y + sin(a) * radius)
        }
        var parked = false
        for (index, satellite) in satellites.enumerated() {
            let quiet = satellite.phase == .quiet
            let color = quiet || (frozen && satellite.phase != .yourTurn) ? ReloDeckTheme.slate.opacity(0.6) : satellite.color
            if satellite.phase == .yourTurn && !parked {
                parked = true
                let top = point(-90)
                let beat = 0.5 - 0.5 * cos(2 * .pi * time / 2.4)
                let ring = 8 * (1 + 0.9 * beat)
                context.strokeEllipse(CGRect(x: top.x - ring, y: top.y - ring, width: ring * 2, height: ring * 2),
                                      color.opacity(0.5 * (1 - beat)), lineWidth: 1.5)
                context.disc(top, 7.5, color.opacity(0.3))
                context.disc(top, 4.2, color)
                continue
            }
            let period: Double = quiet ? 160 : [38, 46, 52, 60][index % 4]
            let angle = Double(ReloDeckSatellites.seed(satellite.id) % 360) + time * 360 / period
            let step = quiet ? 1.4 : 2.6
            for k in 1...10 {
                let fade = (1 - Double(k) / 11) * 0.55
                context.disc(point(angle - Double(k) * step), CGFloat(3.2 - Double(k) * 0.24), color.opacity(fade))
            }
            let head = point(angle)
            context.disc(head, 7.5, color.opacity(0.28))
            context.disc(head, 3.8, color)
        }
    }
}

/// The centre readout: the count from white into the lead's colour over a glow that breathes, and its label in a small
/// dark plate with hairlines either side.
struct ReloDeckCentre: View {
    let value: String?
    let label: String
    let lead: ReloDeckLead
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let accent = lead.accent
        VStack(spacing: 8) {
            ZStack {
                ReloLoopView(key: lead, live: lead.glowPeriod != nil) { [lead] root, size in
                    let glow = ReloLoop.imageLayer(
                        Ellipse().fill(RadialGradient(colors: [accent.opacity(0.55), .clear], center: .center, startRadius: 0, endRadius: 56)),
                        size: CGSize(width: 120, height: 88), center: CGPoint(x: size.width / 2, y: size.height / 2), scale: root.contentsScale)
                    let period = lead.glowPeriod ?? 1
                    let beat = { (time: Double) in lead.glowPeriod == nil ? 0.4 : (sin(time * 2 * .pi / period) + 1) / 2 }
                    glow.opacity = Float(0.35 + 0.4 * beat(0))
                    glow.transform = CATransform3DMakeScale(0.92 + 0.14 * beat(0), 0.92 + 0.14 * beat(0), 1)
                    glow.add(ReloLoop.animation("opacity", period: period) { 0.35 + 0.4 * beat($0) }, forKey: "opacity")
                    glow.add(ReloLoop.animation("transform.scale", period: period) { 0.92 + 0.14 * beat($0) }, forKey: "scale")
                    root.addSublayer(glow)
                }
                .frame(width: 120, height: 88)
                if let value {
                    Text(value)
                        .font(.system(size: 38, weight: .medium, design: .rounded)).tracking(-0.5)
                        .foregroundStyle(LinearGradient(colors: [.white, lead.ramp], startPoint: .top, endPoint: .bottom))
                        .lineLimit(1).minimumScaleFactor(0.5)
                        .contentTransition(.numericText())
                } else {
                    Text("relo")
                        .font(.system(size: 26, weight: .medium, design: .rounded)).tracking(-0.5)
                        .foregroundStyle(.white)
                        .shadow(color: accent.opacity(0.5), radius: 10)
                }
            }
            .frame(height: 44)
            .animation(reduceMotion ? nil : .smooth(duration: 0.45), value: value)
            Text(label)
                .font(.system(size: 9, weight: .bold, design: .monospaced)).tracking(2.2)
                .foregroundStyle(accent.opacity(0.65))
                .overlay { Text(label).font(.system(size: 9, weight: .bold, design: .monospaced)).tracking(2.2).foregroundStyle(.white.opacity(0.45)) }
                .lineLimit(1).minimumScaleFactor(0.7)
                .padding(EdgeInsets(top: 3, leading: 10, bottom: 3, trailing: 8))
                .background(RoundedRectangle(cornerRadius: 3).fill(Color(red: 6 / 255, green: 8 / 255, blue: 14 / 255).opacity(0.62)))
                .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(accent.opacity(0.45), lineWidth: 0.5))
                .shadow(color: accent.opacity(0.22), radius: 7)
                .overlay(alignment: .leading) { hairline(accent).offset(x: -16) }
                .overlay(alignment: .trailing) { hairline(accent).scaleEffect(x: -1).offset(x: 16) }
                .contentTransition(.opacity)
                .animation(reduceMotion ? nil : .smooth(duration: 0.3), value: label)
        }
        .accessibilityHidden(true)
    }

    private func hairline(_ accent: Color) -> some View {
        LinearGradient(colors: [.clear, accent.opacity(0.6)], startPoint: .leading, endPoint: .trailing)
            .frame(width: 12, height: 1)
    }
}

/// A ring that leaves the orb's edge every 1.8 s while something needs the owner.
struct ReloDeckNeedsPulse: View {
    let diameter: CGFloat
    let color: Color
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ReloLoopView(key: "\(color)|\(diameter)", still: 0.4) { [color, diameter] root, size in
            for index in 0..<2 {
                let ring = ReloLoop.ring(CGRect(x: (size.width - diameter) / 2, y: (size.height - diameter) / 2, width: diameter, height: diameter),
                                         color: color, lineWidth: 1.5, inset: true)
                let e = { (time: Double) in (time / 1.8 + Double(index) * 0.5).truncatingRemainder(dividingBy: 1) }
                ring.add(ReloLoop.animation("transform.scale", period: 1.8) { 1 + 0.85 * (1 - pow(1 - e($0), 2)) }, forKey: "scale")
                ring.add(ReloLoop.animation("opacity", period: 1.8) { 0.55 * pow(1 - e($0), 1.5) }, forKey: "opacity")
                root.addSublayer(ring)
            }
        }
        .frame(width: diameter, height: diameter)
        .allowsHitTesting(false).accessibilityHidden(true)
    }
}
