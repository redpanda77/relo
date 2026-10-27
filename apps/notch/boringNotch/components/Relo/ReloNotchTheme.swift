//
//  ReloNotchTheme.swift
//  Relo Notch
//
//  The iPhone app's state palette and badges (apps/ios ReloVisualSystem.swift and HistoryServerOutcome in
//  HistoryRowView.swift; plan 12b rule U4), so a state reads the same in the notch: same symbol, colour, label.
//

import ReloCore
import ReloNotchKit
import SwiftUI

enum ReloNotchTheme {
    static let mint = Color(red: 0x34 / 255, green: 0xD3 / 255, blue: 0x99 / 255)
    static let orange = Color(red: 1, green: 0x8A / 255, blue: 0x3D / 255)
    static let yellow = Color(red: 0xFA / 255, green: 0xCC / 255, blue: 0x15 / 255)
    static let red = Color(red: 0xF4 / 255, green: 0x3F / 255, blue: 0x5E / 255)
    static let violet = Color(red: 0x8B / 255, green: 0x7C / 255, blue: 1)
    static let sky = Color(red: 0x7D / 255, green: 0xD3 / 255, blue: 0xFC / 255)
    static let azure = Color(red: 0x38 / 255, green: 0xBD / 255, blue: 0xF8 / 255)
    static let blue = Color(red: 0x4D / 255, green: 0x8D / 255, blue: 1)
    static let coral = Color(red: 1, green: 0x6B / 255, blue: 0x57 / 255)
    /// A usage window that is full (out).
    static let usageOut = Color(red: 0xE1 / 255, green: 0x1D / 255, blue: 0x48 / 255)
    static let amber = Color(red: 0xFB / 255, green: 0xBF / 255, blue: 0x24 / 255)
    static let emerald = Color(red: 0x10 / 255, green: 0xB9 / 255, blue: 0x81 / 255)
    /// The iPhone's state colours (ReloVisualSystem): running indigo, needs you / your turn coral,
    /// done green, dropped / left unfinished amber, quiet / paused slate, failed red.
    static let running = Color(red: 0x8B / 255, green: 0x7C / 255, blue: 1)
    /// The running colour's light tint (counts and timers on the current step).
    static let runningSoft = Color(red: 0xC4 / 255, green: 0xBB / 255, blue: 1)
    /// The iPhone's holo pair (ReloHoloTheme): finished steps fill cyan to violet.
    static let cyan = Color(red: 0x5C / 255, green: 0xE1 / 255, blue: 1)
    static let ice = Color(red: 0xE4 / 255, green: 0xF9 / 255, blue: 1)
    static let holo = LinearGradient(colors: [cyan, running], startPoint: .topLeading, endPoint: .bottomTrailing)
    static let holoDown = LinearGradient(colors: [cyan, running], startPoint: .top, endPoint: .bottom)
    static let signalCoral = Color(red: 1, green: 0x7A / 255, blue: 0x66 / 255)
    static let done = Color(red: 0x34 / 255, green: 0xD3 / 255, blue: 0x99 / 255)
    static let info = Color(red: 0x94 / 255, green: 0xA3 / 255, blue: 0xB8 / 255)
    static let warning = Color(red: 0xFB / 255, green: 0xBF / 255, blue: 0x24 / 255)
    static let problem = Color(red: 0xF8 / 255, green: 0x71 / 255, blue: 0x71 / 255)
    static let secondaryText = Color.white.opacity(0.6)
    static let tertiaryText = Color.white.opacity(0.4)

    /// Colour, symbol and label per state: the iPhone's `HistoryServerOutcome.make`, one for one.
    static func color(_ tone: NotchPresentation.Tone) -> Color {
        switch tone {
        case .needsYou, .yourTurn: signalCoral
        case .working: running
        case .dropped, .leftUnfinished: warning
        case .quiet, .paused: info
        case .done: done
        case .failed: problem
        }
    }

    static func symbol(_ tone: NotchPresentation.Tone) -> String {
        switch tone {
        case .needsYou: "exclamationmark.bubble.fill"
        case .yourTurn: "hand.raised.fill"
        case .working: "waveform"
        case .quiet: "moon.zzz"
        case .paused: "pause.fill"
        case .done: "checkmark"
        case .failed: "xmark.octagon.fill"
        case .dropped: "stop.fill"
        case .leftUnfinished: "exclamationmark.triangle.fill"
        }
    }

    static func label(_ tone: NotchPresentation.Tone) -> String {
        switch tone {
        case .needsYou: "Needs you"
        case .yourTurn: "Your turn"
        case .working: "Running"
        case .quiet: "Quiet"
        case .paused: "Paused"
        case .done: "Done"
        case .failed: "Failed"
        case .dropped: "Dropped"
        case .leftUnfinished: "Left unfinished"
        }
    }
}

/// The plan as segments, one per top-level step (the iPhone's `PlanBar`): done steps filled, the current one filled as far
/// as its own steps go (or hinted), the rest dim. Past `maxSegments` the plan is one continuous bar.
struct ReloStepsBar: View {
    let bar: PlanBar
    let color: Color
    /// Work that is moving shows light travelling through what is done (the iPhone's LiveSweep).
    var shimmer = false
    var maxSegments = 12

    init(bar: PlanBar, color: Color, shimmer: Bool = false, maxSegments: Int = 12) {
        self.bar = bar; self.color = color; self.shimmer = shimmer; self.maxSegments = maxSegments
    }

    /// From counts alone: the step after the done ones is the current one.
    init(done: Int, total: Int, color: Color, shimmer: Bool = false) {
        self.init(bar: PlanBar.make(done: done, total: total, current: done < total ? done + 1 : nil, fill: nil), color: color, shimmer: shimmer)
    }

    var body: some View {
        let segments = bar.segments
        if segments.count > maxSegments {
            GeometryReader { geo in
                let filled = segments.reduce(0) { $0 + ($1.state == .done ? 1 : $1.state == .current ? $1.fill : 0) }
                let fill = geo.size.width * CGFloat(filled) / CGFloat(max(segments.count, 1))
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.white.opacity(0.1))
                    Capsule().fill(color)
                        .overlay { ReloLiveSweep(active: shimmer, mask: AnyView(Capsule()), maskKey: "capsule") }
                        .clipShape(Capsule()).frame(width: fill)
                }
            }
            .frame(height: 4)
        } else {
            row(mask: false)
                .overlay { ReloLiveSweep(active: shimmer, mask: AnyView(row(mask: true)), maskKey: "\(segments)") }
                .frame(height: 4)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(segments.filter { $0.state == .done }.count) of \(segments.count)")
        }
    }

    private func row(mask: Bool) -> some View {
        HStack(spacing: 3) {
            ForEach(Array(bar.segments.enumerated()), id: \.offset) { _, segment in
                Capsule()
                    .fill(mask ? (segment.state == .done ? Color.black : .clear)
                               // The step under way carries the card's colour, so a plan that has just started is not all grey.
                               : segment.state == .done ? color : segment.state == .current ? color.opacity(0.32) : Color.white.opacity(0.1))
                    .overlay(alignment: .leading) {
                        if !mask, segment.state == .current, segment.fill > 0 {
                            GeometryReader { geo in Capsule().fill(color).frame(width: geo.size.width * min(1, segment.fill)) }
                        }
                    }
                    .frame(height: 4)
                    .frame(maxWidth: .infinity)
            }
        }
    }
}

/// The iPhone's LiveSweep, the one shimmer on every surface (ADR 0013): a band of light that travels left to right,
/// eased in and out over 2.8 s, then rests; drawn only through what it overlays' mask allows. Still with Reduce Motion.
struct ReloLiveSweep: View {
    let active: Bool
    /// The light's colour (white, or a tint for a coloured pass).
    var tint: Color = .white
    /// What it shows through, and a key naming it (a new key redraws the mask).
    var mask: AnyView?
    var maskKey = ""
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if active && !reduceMotion {
            ReloLoopView(key: "\(maskKey)|\(tint)", mask: mask, additive: true) { [tint] root, size in
                let band = CAGradientLayer()
                band.frame = CGRect(origin: .zero, size: size)
                band.colors = [ReloLoop.cgColor(tint.opacity(0)), ReloLoop.cgColor(tint.opacity(0.55)), ReloLoop.cgColor(tint.opacity(0))]
                band.locations = [0, 0.5, 1]
                let cycle = 2.8
                let phase = { (time: Double) -> Double in
                    let t = min(time / (cycle * 0.7), 1)
                    return t * t * (3 - 2 * t) * 1.6 - 0.3
                }
                band.add(ReloLoop.animation("startPoint", period: cycle) { NSValue(point: NSPoint(x: phase($0) - 0.18, y: 0.5)) }, forKey: "start")
                band.add(ReloLoop.animation("endPoint", period: cycle) { NSValue(point: NSPoint(x: phase($0) + 0.18, y: 0.5)) }, forKey: "end")
                root.addSublayer(band)
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
            .transition(.opacity.animation(ReloMotion.base))
        }
    }
}

/// A card's origin line, as on the iPhone and the Dashboard: the agent's mark (not its name), the
/// project, then the session's name.
struct ReloCardOrigin: View {
    let row: NotchPresentation.Row

    /// The project in its colour, the one every app draws it in (`ProjectPalette`).
    private var projectColor: Color? {
        ProjectPalette.slot(row.projectSlot, name: row.project).map { slot in
            let rgb = ProjectPalette.rgb(slot)
            return Color(red: rgb.red, green: rgb.green, blue: rgb.blue)
        }
    }

    var body: some View {
        HStack(spacing: 4) {
            if let source = row.source {
                ReloSourceMark(name: source, size: 11)
            }
            // A handle no envelope has named yet is noise, never a project's name: the mark alone says whose it is.
            if let project = row.project.flatMap(ReloDisplayName.readable) {
                Text(project).fontWeight(.semibold).foregroundStyle(projectColor ?? ReloNotchTheme.secondaryText)
            }
            if let topic = row.topic.flatMap(ReloDisplayName.readable) {
                Text("›").foregroundStyle(ReloNotchTheme.tertiaryText.opacity(0.7))
                Text(topic).foregroundStyle(ReloNotchTheme.tertiaryText).layoutPriority(-1)
            }
        }
        .font(.system(size: 10))
        .lineLimit(1)
        .truncationMode(.tail)
    }
}
