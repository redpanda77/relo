import ReloCore
import SwiftUI

/// What the Now header leads with: the system layer first (the counts can't be trusted), then the work layer,
/// most urgent first. It colours the wash, the centre's plate and glow; the orb keeps its own three states.
enum ReloHUDLead: Equatable {
    case connecting, checking, offline, needsYou, yourTurn, running, quiet, clear

    var accent: Color {
        switch self {
        case .needsYou: ReloHoloTheme.orange
        case .yourTurn: ReloHoloTheme.amber
        case .running: ReloHoloTheme.cyan
        case .quiet: ReloHoloTheme.sessions
        case .clear: Color(red: 0x7F / 255, green: 0xA9 / 255, blue: 1)
        case .connecting, .checking, .offline: ReloHoloTheme.slate
        }
    }

    /// The hue the wash paints with, which differs from the accent in the calm states (clear, quiet, connecting).
    var washColor: Color {
        switch self {
        case .needsYou: ReloHoloTheme.orange
        case .yourTurn: ReloHoloTheme.amber
        case .running: ReloHoloTheme.cyan
        case .quiet: ReloHoloTheme.violet
        case .clear, .connecting, .checking: ReloHoloTheme.blue
        case .offline: ReloHoloTheme.slate
        }
    }

    /// The bottom of the count's white-to-colour ramp.
    var ramp: Color {
        switch self {
        case .needsYou: ReloHoloTheme.coral
        case .yourTurn: Color(red: 0xF5 / 255, green: 0x9E / 255, blue: 0x0B / 255)
        case .running: ReloHoloTheme.blue
        case .quiet: ReloHoloTheme.violet
        default: accent
        }
    }

    /// How strongly the wash lights the top of the screen, and its breath (the notch's periods).
    var wash: (strength: Double, period: Double) {
        switch self {
        case .needsYou: (0.40, 1.8)
        case .yourTurn: (0.30, 2.1)
        case .running: (0.28, 1.75)
        case .quiet: (0.22, 3.5)
        case .clear: (0.14, 7)
        case .offline: (0.10, 7)
        case .connecting, .checking: (0.10, 1.2)
        }
    }

    /// The aurora's three hues, drifting far behind everything.
    var aurora: (colors: [Color], strength: Double) {
        switch self {
        case .needsYou: ([ReloHoloTheme.coral, ReloHoloTheme.orange, ReloHoloTheme.violet], 0.2)
        case .yourTurn: ([ReloHoloTheme.amber, ReloHoloTheme.coral, ReloHoloTheme.violet], 0.16)
        case .running: ([ReloHoloTheme.violet, ReloHoloTheme.azure, ReloHoloTheme.mint], 0.16)
        case .quiet: ([ReloHoloTheme.violet, ReloHoloTheme.blue, ReloHoloTheme.slate], 0.13)
        case .clear: ([ReloHoloTheme.blue, ReloHoloTheme.violet, ReloHoloTheme.azure], 0.08)
        case .offline: ([ReloHoloTheme.slate, ReloHoloTheme.slate, ReloHoloTheme.slate], 0.06)
        case .connecting, .checking: ([ReloHoloTheme.blue, ReloHoloTheme.violet, ReloHoloTheme.azure], 0.06)
        }
    }

    /// The count breathes behind its number only while something needs the owner or moves.
    var glowPeriod: Double? {
        switch self {
        case .needsYou: 1.8
        case .yourTurn: 2.1
        case .running, .quiet: 3.6
        default: nil
        }
    }
}

/// One session as the header draws it: a satellite on the outer orbit, counted under its machine and harness.
struct ReloHUDSession: Equatable, Identifiable {
    enum Phase: Int, Comparable {
        case needsYou, yourTurn, running, quiet
        static func < (lhs: Phase, rhs: Phase) -> Bool { lhs.rawValue < rhs.rawValue }

        var color: Color {
            switch self {
            case .needsYou: ReloHoloTheme.orange
            case .yourTurn: ReloHoloTheme.amber
            case .running: ReloHoloTheme.cyan
            case .quiet: ReloHoloTheme.slate
            }
        }
    }

    let id: String
    let phase: Phase
    var computer: String?
    var computerIcon: ComputerIcon?
    var source: String?

    /// A session as the header sees it: waiting on input needs the owner; waiting on a turn is the owner's turn;
    /// working on a moving card runs; working without one is quiet. Idle and ended sessions are not drawn.
    static func make(_ row: NowSessionInput, movingWork: Set<String>) -> ReloHUDSession? {
        let phase: Phase
        switch row.phase {
        case .waiting: phase = row.waitingFor == "input" ? .needsYou : .yourTurn
        case .working: phase = row.workID.map(movingWork.contains) == true ? .running : .quiet
        default: return nil
        }
        return ReloHUDSession(id: row.id, phase: phase, computer: row.computer, computerIcon: row.computerIcon, source: row.source)
    }
}

/// The sessions grouped by machine, in the order they first appear: each machine's most urgent phase and how
/// many sessions each harness runs there.
struct ReloFleetMachine: Equatable, Identifiable {
    struct Harness: Equatable { let source: String; let count: Int }
    let name: String
    let icon: ComputerIcon?
    let lead: ReloHUDSession.Phase
    let harnesses: [Harness]
    /// No session is at work here: drawn dim with the word "idle".
    var idle = false
    var id: String { name }

    /// The machines with sessions at work, then `idle` machines (no session of theirs is at work) after them.
    static func fleet(_ sessions: [ReloHUDSession], idle idleNames: [String] = []) -> [ReloFleetMachine] {
        var order: [String] = []
        var groups: [String: [ReloHUDSession]] = [:]
        for session in sessions {
            let name = session.computer ?? "This computer"
            if groups[name] == nil { order.append(name) }
            groups[name, default: []].append(session)
        }
        var machines: [ReloFleetMachine] = order.map { name in
            let mine = groups[name] ?? []
            var sources: [String] = []
            var counts: [String: Int] = [:]
            for session in mine {
                let source = session.source ?? "agent"
                if counts[source] == nil { sources.append(source) }
                counts[source, default: 0] += 1
            }
            return ReloFleetMachine(name: name, icon: mine.first?.computerIcon, lead: mine.map(\.phase).min() ?? .quiet,
                                    harnesses: sources.map { Harness(source: $0, count: counts[$0] ?? 0) })
        }
        for name in idleNames where !order.contains(name) && !machines.contains(where: { $0.name == name }) {
            machines.append(ReloFleetMachine(name: name, icon: nil, lead: .quiet, harnesses: [], idle: true))
        }
        return machines
    }
}

/// The four readouts' places on the gauge ring, in the owner's order: needs you top left, your turn top right,
/// running bottom right, sessions bottom left (clockwise). Angles are SwiftUI's, clockwise from east.
enum ReloHUDSlot: Int, CaseIterable {
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
        case .needsYou: ReloHoloTheme.orange
        case .yourTurn: ReloHoloTheme.amber
        case .running: ReloHoloTheme.cyan
        case .sessions: ReloHoloTheme.sessions
        }
    }

    /// The colour mixed 55% with white (the label's pale tint), blended by hand: iOS 17 has no `Color.mix`.
    var pale: Color {
        let rgb: (Double, Double, Double) = switch self {
        case .needsYou: (0xFF, 0x8A, 0x3D)
        case .yourTurn: (0xFB, 0xBF, 0x24)
        case .running: (0x5C, 0xE1, 0xFF)
        case .sessions: (0xA9, 0x9E, 0xFF)
        }
        func mix(_ channel: Double) -> Double { (channel * 0.55 + 255 * 0.45) / 255 }
        return Color(red: mix(rgb.0), green: mix(rgb.1), blue: mix(rgb.2))
    }
}

/// The gauge ring: four quadrant arcs, one per readout, each lit from its middle outward by how full it is.
struct ReloGaugeRing: View {
    struct Gauge: Equatable { var fill: Double; var lit: Bool; var dimmed = false }
    let gauges: [ReloHUDSlot: Gauge]
    let radius: CGFloat

    var body: some View {
        Canvas { context, size in
            let center = CGPoint(x: size.width / 2, y: size.height / 2)
            func arc(_ from: Double, _ to: Double) -> Path {
                Path { $0.addArc(center: center, radius: radius, startAngle: .degrees(from), endAngle: .degrees(to), clockwise: false) }
            }
            for slot in ReloHUDSlot.allCases {
                context.stroke(arc(slot.angle - 40, slot.angle + 40), with: .color(.white.opacity(0.1)), lineWidth: 3)
                guard let gauge = gauges[slot], gauge.lit, gauge.fill > 0 else { continue }
                let half = 38 * min(max(gauge.fill, 0.04), 1)
                let color = gauge.dimmed ? ReloHoloTheme.slate.opacity(0.6) : slot.color
                var glow = context
                glow.addFilter(.blur(radius: 4))
                glow.stroke(arc(slot.angle - half, slot.angle + half), with: .color(color.opacity(0.7)),
                            style: StrokeStyle(lineWidth: 4, lineCap: .round))
                context.stroke(arc(slot.angle - half, slot.angle + half), with: .color(color),
                               style: StrokeStyle(lineWidth: 3, lineCap: .round))
            }
        }
        .allowsHitTesting(false).accessibilityHidden(true)
    }
}

/// A readout docked on the gauge ring: its number nearest the ring, its label outward, tinted when lit,
/// a dashed outline when it is zero. A value that changes glows once.
struct ReloDockedTag: View {
    let slot: ReloHUDSlot
    let value: String
    let lit: Bool
    var dimmed = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.reloEffectsArmed) private var armed
    @State private var flare = 0.0

    var body: some View {
        let color = dimmed ? ReloHoloTheme.slate : slot.color
        HStack(spacing: 8) {
            if slot.leading { label(color); number(color) } else { number(color); label(color) }
        }
        .padding(.horizontal, 11)
        .frame(height: 26)
        .background {
            ZStack {
                Capsule().fill(ReloHoloTheme.ink.opacity(0.92))
                if lit { Capsule().fill(color.opacity(0.17)) }
            }
        }
        .overlay {
            Capsule().strokeBorder(lit ? color.opacity(0.45) : .white.opacity(0.2),
                                   style: StrokeStyle(lineWidth: 0.75, dash: lit ? [] : [3, 2]))
        }
        .shadow(color: lit ? color.opacity(0.22 + 0.5 * flare) : .clear, radius: 7 + 6 * flare)
        .fixedSize()
        .onChange(of: value) { _, _ in
            guard !reduceMotion, armed else { return }
            flare = 1
            withAnimation(.easeOut(duration: 1.3)) { flare = 0 }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(slot.label.capitalized)
        .accessibilityValue(value)
    }

    private func number(_ color: Color) -> some View {
        Text(value)
            .font(.system(size: 15, weight: .semibold, design: .rounded))
            .foregroundStyle(lit ? color : .white.opacity(dimmed ? 0.6 : 0.42))
            .contentTransition(.numericText())
            .animation(reduceMotion ? nil : .smooth(duration: 0.35), value: value)
    }

    private func label(_ color: Color) -> some View {
        Text(slot.label)
            .font(.system(size: 8.5, weight: .bold, design: .monospaced)).tracking(1.4)
            .foregroundStyle(lit ? slot.pale : Color(red: 0x6B / 255, green: 0x74 / 255, blue: 0x88 / 255))
            .lineLimit(1)
    }
}

/// The sessions as satellites on the outer orbit, each in its phase's colour with a fading tail (the notch's
/// satellites). Quiet ones drift slowly in grey; one waiting on the owner's turn parks at twelve o'clock and pulses.
struct ReloSatellites: View {
    let sessions: [ReloHUDSession]
    let radius: CGFloat
    var frozen = false

    var body: some View {
        ReloMotionClock(live: !frozen && !sessions.isEmpty, framesPerSecond: 30, still: 7) { time in
            Canvas { context, size in
                let center = CGPoint(x: size.width / 2, y: size.height / 2)
                let track = CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)
                context.stroke(Path(ellipseIn: track), with: .color(.white.opacity(0.09)), lineWidth: 1)
                func point(_ degrees: Double) -> CGPoint {
                    let a = degrees * .pi / 180
                    return CGPoint(x: center.x + cos(a) * radius, y: center.y + sin(a) * radius)
                }
                func dot(_ at: CGPoint, _ r: CGFloat, _ color: Color) {
                    context.fill(Path(ellipseIn: CGRect(x: at.x - r, y: at.y - r, width: r * 2, height: r * 2)), with: .color(color))
                }
                var parked = false
                for (index, session) in sessions.enumerated() {
                    let quiet = session.phase == .quiet
                    // Frozen (offline) greys the orbiting ones; the parked your-turn satellite stays amber.
                    let color = quiet || (frozen && session.phase != .yourTurn) ? ReloHoloTheme.slate.opacity(0.6) : session.phase.color
                    if session.phase == .yourTurn && !parked {
                        parked = true
                        let top = point(-90)
                        // A triangle wave: out and back over 2.4 s, so the ring never snaps.
                        let beat = 0.5 - 0.5 * cos(2 * .pi * time / 2.4)
                        let ring = 8 * (1 + 0.9 * beat)
                        context.stroke(Path(ellipseIn: CGRect(x: top.x - ring, y: top.y - ring, width: ring * 2, height: ring * 2)),
                                       with: .color(color.opacity(0.5 * (1 - beat))), lineWidth: 1.5)
                        dot(top, 7.5, color.opacity(0.3))
                        dot(top, 4.2, color)
                        continue
                    }
                    let period: Double = quiet ? 160 : [38, 46, 52, 60][index % 4]
                    let angle = Double(Self.seed(session.id) % 360) + time * 360 / period
                    let step = quiet ? 1.4 : 2.6
                    for k in 1...10 {
                        let fade = (1 - Double(k) / 11) * 0.55
                        dot(point(angle - Double(k) * step), CGFloat(3.2 - Double(k) * 0.24), color.opacity(fade))
                    }
                    let head = point(angle)
                    dot(head, 7.5, color.opacity(0.28))
                    dot(head, 3.8, color)
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

/// The centre readout, as on the dashboard: the count from white into the lead's colour over a painted glow
/// that breathes (no filter on the text), and its label in a small dark plate with hairlines either side.
struct ReloCentreReadout: View {
    let value: String?
    let label: String
    let lead: ReloHUDLead
    @ScaledMetric(relativeTo: .largeTitle) private var countSize: CGFloat = 46
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let accent = lead.accent
        VStack(spacing: 9) {
            ZStack {
                ReloMotionClock(live: lead.glowPeriod != nil, framesPerSecond: 30, still: 0) { time in
                    let beat = lead.glowPeriod.map { (sin(time * 2 * .pi / $0) + 1) / 2 } ?? 0.4
                    Ellipse()
                        .fill(RadialGradient(colors: [accent.opacity(0.55), .clear], center: .center, startRadius: 0, endRadius: 70))
                        .frame(width: 150, height: 110)
                        .opacity(0.35 + 0.4 * beat)
                        .scaleEffect(0.92 + 0.14 * beat)
                }
                if let value {
                    Text(value)
                        .font(.system(size: countSize, weight: .medium, design: .rounded)).tracking(-0.5)
                        .foregroundStyle(LinearGradient(colors: [.white, lead.ramp], startPoint: .top, endPoint: .bottom))
                        .lineLimit(1).minimumScaleFactor(0.5)
                        .contentTransition(.numericText())
                } else {
                    Text("relo")
                        .font(.system(size: 30, weight: .medium, design: .rounded)).tracking(-0.5)
                        .foregroundStyle(.white)
                        .shadow(color: accent.opacity(0.5), radius: 10)
                }
            }
            .frame(height: 52)
            .animation(reduceMotion ? nil : .smooth(duration: 0.45), value: value)
            Text(label)
                .font(.system(size: 9.5, weight: .bold, design: .monospaced)).tracking(2.4)
                .foregroundStyle(accent.opacity(0.65))
                .overlay { Text(label).font(.system(size: 9.5, weight: .bold, design: .monospaced)).tracking(2.4).foregroundStyle(.white.opacity(0.45)) }
                .lineLimit(1).minimumScaleFactor(0.7)
                .padding(EdgeInsets(top: 3, leading: 11, bottom: 3, trailing: 9))
                .background(RoundedRectangle(cornerRadius: 3).fill(Color(red: 6 / 255, green: 8 / 255, blue: 14 / 255).opacity(0.62)))
                .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(accent.opacity(0.45), lineWidth: 0.5))
                .shadow(color: accent.opacity(0.22), radius: 7)
                .overlay(alignment: .leading) { hairline(accent).offset(x: -18) }
                .overlay(alignment: .trailing) { hairline(accent).scaleEffect(x: -1).offset(x: 18) }
                .contentTransition(.opacity)
                .animation(reduceMotion ? nil : .smooth(duration: 0.3), value: label)
        }
        .accessibilityHidden(true)
    }

    private func hairline(_ accent: Color) -> some View {
        LinearGradient(colors: [.clear, accent.opacity(0.6)], startPoint: .leading, endPoint: .trailing)
            .frame(width: 14, height: 1)
    }
}

/// The light behind the header, as the notch spreads it: the lead's colour washing down from the top edge and
/// breathing on the notch's periods, and a faint aurora drifting far behind.
struct ReloStateWash: View {
    let lead: ReloHUDLead
    let center: CGPoint
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let wash = lead.wash, aurora = lead.aurora
        ZStack {
            ReloMotionClock(live: !reduceMotion, framesPerSecond: 15, still: 0) { time in
                let drift = (sin(time * 2 * .pi / 22) + 1) / 2
                ZStack {
                    Circle().fill(aurora.colors[0]).frame(width: 330, height: 330)
                        .offset(x: -150 + 26 * drift, y: -40 + 14 * drift)
                    Circle().fill(aurora.colors[1]).frame(width: 250, height: 250)
                        .offset(x: 130 - 20 * drift, y: -90 + 10 * drift)
                    Circle().fill(aurora.colors[2]).frame(width: 210, height: 210)
                        .offset(x: 20 + 16 * drift, y: 120 - 12 * drift).opacity(0.6)
                }
                .blur(radius: 64)
                .opacity(aurora.strength)
                .position(center)
            }
            // The wash is drawn once and only its opacity breathes. Inside the ticking, blurred layer
            // above it was re-rasterized on the CPU every tick (~25 ms on the main thread, 15 times a
            // second: a dropped frame each time). A rectangle's gradient stays on the GPU; the
            // ellipse is its mask.
            ReloMotionClock(live: !reduceMotion, framesPerSecond: 15, still: 0) { time in
                let breath = (sin(time * 2 * .pi / (wash.period * 2)) + 1) / 2
                Rectangle()
                    .fill(RadialGradient(stops: [.init(color: lead.washColor.opacity(wash.strength), location: 0),
                                                 .init(color: lead.washColor.opacity(wash.strength * 0.42), location: 0.35),
                                                 .init(color: lead.washColor.opacity(wash.strength * 0.09), location: 0.7),
                                                 .init(color: .clear, location: 1)],
                                         center: .center, startRadius: 0, endRadius: 300))
                    .mask(Ellipse())
                    .frame(width: 620, height: 470)
                    .opacity(0.7 + 0.3 * breath)
                    .position(x: center.x, y: center.y - 90)
            }
        }
        .animation(reduceMotion ? nil : .smooth(duration: 0.9), value: lead)
        .allowsHitTesting(false).accessibilityHidden(true)
    }
}

/// A ring that leaves the orb's edge every 1.8 s while something needs the owner (the notch's needs ring).
struct ReloNeedsPulse: View {
    let diameter: CGFloat
    let color: Color

    var body: some View {
        ReloMotionClock(framesPerSecond: 30, still: 0.4) { time in
            ZStack {
                ForEach(0..<2, id: \.self) { index in
                    let e = (time / 1.8 + Double(index) * 0.5).truncatingRemainder(dividingBy: 1)
                    Circle().strokeBorder(color, lineWidth: 1.5)
                        .frame(width: diameter, height: diameter)
                        .scaleEffect(1 + 0.85 * (1 - pow(1 - e, 2)))
                        .opacity(0.55 * pow(1 - e, 1.5))
                }
            }
        }
        .allowsHitTesting(false).accessibilityHidden(true)
    }
}

/// The machines under the header: each one's most urgent colour, its name and how many sessions each harness
/// runs there. Machines with nothing at work are listed too, dim, with the word "idle". With no machine known the
/// line stays empty (it keeps its height).
struct ReloFleetLegend: View {
    let fleet: [ReloFleetMachine]
    var frozen = false

    var body: some View {
        HStack(spacing: 14) {
            ForEach(fleet.prefix(3)) { machine in
                let dot = frozen ? Color(red: 0x6B / 255, green: 0x74 / 255, blue: 0x88 / 255)
                    : machine.idle ? Color.white.opacity(0.3) : machine.lead.color
                HStack(spacing: 6) {
                    Circle().fill(dot).frame(width: 5, height: 5)
                        .shadow(color: frozen || machine.idle ? .clear : dot, radius: 3)
                    Text(machine.name)
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(machine.idle || frozen ? Color(red: 0x98 / 255, green: 0xA2 / 255, blue: 0xB6 / 255)
                                         : Color(red: 0xEE / 255, green: 0xF1 / 255, blue: 0xF7 / 255))
                        .lineLimit(1)
                    ForEach(machine.harnesses, id: \.source) { harness in
                        HStack(spacing: 3) {
                            SourceMark(name: SessionSource.label(harness.source), fallbackSymbol: "terminal", size: 10)
                            Text("\(harness.count)").font(.system(size: 10, weight: .semibold, design: .monospaced))
                                .foregroundStyle(Color(red: 0xC9 / 255, green: 0xCF / 255, blue: 0xDB / 255))
                        }
                    }
                    if machine.idle {
                        Text("idle").font(.system(size: 10, weight: .semibold, design: .monospaced))
                            .foregroundStyle(Color(red: 0x7E / 255, green: 0x88 / 255, blue: 0x9C / 255))
                    }
                }
                .opacity(frozen ? 0.55 : 1)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 18)
        .accessibilityElement(children: .ignore)
        .accessibilityHidden(fleet.isEmpty)
        .accessibilityLabel(fleet.isEmpty ? "No machines" : fleet.map { machine in
            machine.idle ? "\(machine.name): idle"
                : "\(machine.name): " + machine.harnesses.map { "\($0.count) \(SessionSource.label($0.source))" }.joined(separator: ", ")
        }.joined(separator: ". "))
    }
}
