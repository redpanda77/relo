//
//  ReloGlass.swift
//  Relo
//
//  The glass of Relo's own windows (the main window and Settings), from the approved study in
//  docs/internal/product/mac-glass-study: the desktop blurred through the window, panels of light glass on it, and the
//  notch's motion on the cards (the state's wash from the bottom edge, beams climbing both sides). Colours are
//  ReloNotchTheme's and motion ReloMotion's; with Reduce Motion the light stays still and the beams do not play.
//

import AppKit
import Observation
import SwiftUI

enum ReloGlass {
    static let radius: CGFloat = 20
    static let eyebrow = Font.system(size: 10.5, weight: .semibold, design: .monospaced)

    /// A Relo window that shows the desktop through it: clear and non-opaque, its title bar part of the content.
    static func prepare(_ window: NSWindow) {
        window.isOpaque = false
        window.backgroundColor = .clear
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.styleMask.insert(.fullSizeContentView)
    }
}

/// Eases for effects computed from time, matching SwiftUI's repeating animations.
enum ReloEase {
    /// `.easeInOut(duration: d).repeatForever(autoreverses: true)`: 0 to 1 and back, forever.
    static func reversing(_ t: TimeInterval, _ d: Double) -> Double {
        let phase = t.truncatingRemainder(dividingBy: 2 * d) / d
        let x = phase <= 1 ? phase : 2 - phase
        return 0.5 - 0.5 * cos(.pi * x)
    }

    /// `.easeOut(duration: d).repeatForever(autoreverses: false)`: 0 to 1, then again from 0.
    static func ripple(_ t: TimeInterval, _ d: Double) -> Double {
        let x = t.truncatingRemainder(dividingBy: d) / d
        return 1 - (1 - x) * (1 - x)
    }
}

/// Whether a window's animated surface can be seen. The window controller keeps it current (closed, minimized or
/// covered means paused); the window's root view hands it to its effects through `\.reloMotionPaused`.
@MainActor
@Observable
final class ReloWindowVisibility {
    private(set) var paused = true

    func refresh(_ window: NSWindow?) {
        guard let window else { paused = true; return }
        paused = window.isMiniaturized || !window.occlusionState.contains(.visible)
    }
}

/// A window's root: its content with the window's visibility as the motion pause.
struct ReloWindowRoot<Content: View>: View {
    let visibility: ReloWindowVisibility
    @ViewBuilder let content: Content

    var body: some View {
        content.environment(\.reloMotionPaused, visibility.paused)
    }
}

/// The desktop behind the window, blurred (the window's own glass).
struct ReloWindowBlur: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = .hudWindow
        view.blendingMode = .behindWindow
        view.state = .active
        return view
    }

    func updateNSView(_ view: NSVisualEffectView, context: Context) {}
}

/// Behind a Relo window's content: the blurred desktop, darkened so text reads, and slow light in the state's colours
/// (the ReloAurora's drift, one repeating Core Animation move).
struct ReloGlassBackdrop: View {
    var tint: Color = ReloNotchTheme.running
    var second: Color = ReloNotchTheme.azure

    var body: some View {
        ZStack {
            ReloWindowBlur()
            Color(red: 0.03, green: 0.035, blue: 0.07).opacity(0.6)
            // The two lights drift on Core Animation: nothing here is drawn per frame.
            ReloLoopView(key: "\(tint)|\(second)") { [tint, second] root, size in
                let w = size.width, h = size.height, c = CGPoint(x: w / 2, y: h / 2)
                root.masksToBounds = true
                let drift = { (t: Double) in ReloEase.reversing(t, 13) }
                let first = ReloLoop.blob(tint.opacity(0.32), size: w * 0.6, blur: w * 0.6 * 0.3, center: c, scale: root.contentsScale)
                ReloLoop.drift(first, from: CGPoint(x: c.x - w * 0.22, y: c.y - h * 0.26), to: CGPoint(x: c.x - w * 0.3, y: c.y - h * 0.34),
                               period: 26, drift)
                let next = ReloLoop.blob(second.opacity(0.32), size: w * 0.55, blur: w * 0.55 * 0.3, center: c, scale: root.contentsScale)
                ReloLoop.drift(next, from: CGPoint(x: c.x + w * 0.3, y: c.y + h * 0.38), to: CGPoint(x: c.x + w * 0.36, y: c.y + h * 0.3),
                               period: 26, drift)
                root.addSublayer(first)
                root.addSublayer(next)
            }
            LinearGradient(colors: [.white.opacity(0.06), .clear], startPoint: .topLeading, endPoint: .center)
        }
        .clipped()
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// A panel of glass: a light fill brighter at the top, a hairline edge and a brighter top highlight, a soft shadow.
/// `tint` colours the edge (a question's coral).
struct ReloGlassSurface: ViewModifier {
    var radius: CGFloat = ReloGlass.radius
    var tint: Color?

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        content
            .background {
                shape
                    .fill(LinearGradient(colors: [.white.opacity(0.085), .white.opacity(0.03)], startPoint: .top, endPoint: .bottom))
                    .shadow(color: .black.opacity(0.22), radius: 16, y: 8)
            }
            .overlay {
                ZStack {
                    shape.strokeBorder(tint?.opacity(0.4) ?? .white.opacity(0.13), lineWidth: 0.5)
                    shape.strokeBorder(LinearGradient(colors: [.white.opacity(0.2), .clear], startPoint: .top, endPoint: .init(x: 0.5, y: 0.25)),
                                       lineWidth: 1)
                }
                .allowsHitTesting(false)
            }
    }
}

extension View {
    func reloGlass(radius: CGFloat = ReloGlass.radius, tint: Color? = nil) -> some View {
        modifier(ReloGlassSurface(radius: radius, tint: tint))
    }
}

/// The state's light rising from a surface's bottom edge, breathing (the closed notch's wing glow).
struct ReloStateWash: View {
    let color: Color
    var strength: Double = 1
    /// A question breathes faster than running work.
    var urgent = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ReloLoopView(key: "\(color)|\(strength)|\(urgent)|\(reduceMotion)") { [color, strength, urgent, reduceMotion] root, size in
            let wash = ReloLoop.imageLayer(
                EllipticalGradient(colors: [color.opacity(0.36 * strength), color.opacity(0.12 * strength), .clear],
                                   center: .bottom, startRadiusFraction: 0, endRadiusFraction: 0.7),
                size: size, center: CGPoint(x: size.width / 2, y: size.height / 2), scale: root.contentsScale)
            if reduceMotion {
                wash.opacity = 1
            } else {
                let d = urgent ? 1.1 : 2.1
                wash.opacity = 0.65
                wash.add(ReloLoop.animation("opacity", period: 2 * d, fps: 30) { 0.65 + 0.35 * ReloEase.reversing($0, d) }, forKey: "opacity")
            }
            root.addSublayer(wash)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// A surface's edge from the bottom centre, round the left side, to the top centre; mirrored, the right side.
private struct ReloHalfEdge: Shape {
    var radius: CGFloat

    func path(in rect: CGRect) -> Path {
        let r = min(radius, rect.height / 2, rect.width / 2)
        var path = Path()
        path.move(to: CGPoint(x: rect.midX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX + r, y: rect.maxY))
        path.addArc(center: CGPoint(x: rect.minX + r, y: rect.maxY - r), radius: r, startAngle: .degrees(90), endAngle: .degrees(180), clockwise: false)
        path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + r))
        path.addArc(center: CGPoint(x: rect.minX + r, y: rect.minY + r), radius: r, startAngle: .degrees(180), endAngle: .degrees(270), clockwise: false)
        path.addLine(to: CGPoint(x: rect.midX, y: rect.minY))
        return path
    }
}

/// The notch's beams on a surface (ReloOrbitPainter.beams): two lights leave the bottom centre together and climb both
/// sides. They play once each time `trigger` changes (a step finished), or every 2.8 s while `repeating` (a question).
struct ReloEdgeBeams: View {
    let color: Color
    var radius: CGFloat = ReloGlass.radius
    var repeating = false
    var trigger = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.reloMotionPaused) private var paused
    @State private var start: Date?

    private static let run = 1.9
    private static let cycle = 2.8

    var body: some View {
        Group {
            if !reduceMotion && !paused && !ReloMotionSignal.shared.paused && (repeating || start != nil) {
                if ReloEffects.metal {
                    ReloEffectView(framesPerSecond: 60, outset: 8, additive: true) { [color, radius, start] canvas in
                        guard let p = Self.progress(canvas.now, start: start) else { return }
                        var sink = canvas.sink()
                        ReloEdgeBeamsPainter(color: color, radius: radius, size: canvas.size, p: p).paint(&sink)
                    }
                } else {
                    TimelineView(.animation(minimumInterval: 1.0 / 60)) { timeline in
                        if let p = Self.progress(timeline.date, start: start) {
                            ZStack {
                                beam(p)
                                beam(p).scaleEffect(x: -1, y: 1)
                                spark(p)
                            }
                            .blendMode(.plusLighter)
                        }
                    }
                }
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onChange(of: trigger) { _, _ in
            let now = Date()
            start = now
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(Self.run + 0.1))
                if start == now { start = nil }
            }
        }
    }

    static func progress(_ date: Date, start: Date?) -> Double? {
        if let start {
            let t = date.timeIntervalSince(start)
            return t < Self.run ? t / Self.run : nil
        }
        let t = date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: Self.cycle)
        return t < Self.run ? t / Self.run : nil
    }

    private func beam(_ p: Double) -> some View {
        let head = p < 0.5 ? 4 * p * p * p : 1 - pow(-2 * p + 2, 3) / 2
        let alpha = sin(p * .pi)
        let edge = ReloHalfEdge(radius: radius)
        return ZStack {
            edge.trim(from: max(0, head - 0.2), to: head)
                .stroke(color.opacity(0.5 * alpha), style: StrokeStyle(lineWidth: 6, lineCap: .round))
                .blur(radius: 4)
            edge.trim(from: max(0, head - 0.16), to: head)
                .stroke(color.opacity(0.9 * alpha), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
            edge.trim(from: max(0, head - 0.015), to: head)
                .stroke(Color.white.opacity(alpha), style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
        }
    }

    /// Where they leave: a flash at the bottom centre.
    private func spark(_ p: Double) -> some View {
        let f = max(0, 1 - p / 0.25)
        return GeometryReader { geo in
            RadialGradient(colors: [color.opacity(0.75 * f), color.opacity(0)], center: .center, startRadius: 0, endRadius: 18)
                .frame(width: 44, height: 28)
                .position(x: geo.size.width / 2, y: geo.size.height)
        }
    }
}

/// The edge beams at one instant: `p` (0…1) through their run.
struct ReloEdgeBeamsPainter {
    let color: Color
    let radius: CGFloat
    let size: CGSize
    let p: Double

    func paint<S: ReloPaintSink>(_ ctx: inout S) {
        let head = p < 0.5 ? 4 * p * p * p : 1 - pow(-2 * p + 2, 3) / 2
        let alpha = sin(p * .pi)
        let left = Self.halfEdge(size: size, radius: radius)
        let right = left.map { CGPoint(x: size.width - $0.x, y: $0.y) }
        for edge in [left, right] {
            ctx.blurredLines(Self.trim(edge, max(0, head - 0.2), head), .color(color.opacity(0.5 * alpha)), lineWidth: 6, blur: 4)
            ctx.strokeLines(Self.trim(edge, max(0, head - 0.16), head), .color(color.opacity(0.9 * alpha)), lineWidth: 1.5, round: true)
            ctx.strokeLines(Self.trim(edge, max(0, head - 0.015), head), .color(.white.opacity(alpha)), lineWidth: 2.5, round: true)
        }
        // Where they leave: a flash at the bottom centre.
        let f = max(0, 1 - p / 0.25)
        if f > 0 {
            let o = CGPoint(x: size.width / 2, y: size.height)
            var spark = ctx
            spark.clip(rect: CGRect(x: o.x - 22, y: o.y - 14, width: 44, height: 28))
            spark.fillRect(CGRect(x: o.x - 22, y: o.y - 14, width: 44, height: 28),
                           .radial(Gradient(colors: [color.opacity(0.75 * f), color.opacity(0)]), center: o, startRadius: 0, endRadius: 18))
        }
    }

    /// ReloHalfEdge's path as points: the bottom centre, round the left side, to the top centre.
    static func halfEdge(size: CGSize, radius: CGFloat) -> [CGPoint] {
        let r = min(radius, size.height / 2, size.width / 2)
        var points = [CGPoint(x: size.width / 2, y: size.height), CGPoint(x: r, y: size.height)]
        let arc = { (center: CGPoint, from: Double) in
            (1...12).map { i -> CGPoint in
                let a = (from + 90 * Double(i) / 12) * .pi / 180
                return CGPoint(x: center.x + r * cos(a), y: center.y + r * sin(a))
            }
        }
        points += arc(CGPoint(x: r, y: size.height - r), 90)
        points.append(CGPoint(x: 0, y: r))
        points += arc(CGPoint(x: r, y: r), 180)
        points.append(CGPoint(x: size.width / 2, y: 0))
        return points
    }

    /// The part of a line between two fractions of its length, as Shape.trim cuts it.
    static func trim(_ points: [CGPoint], _ from: Double, _ to: Double) -> [CGPoint] {
        var lengths = [0.0]
        for i in 1..<points.count { lengths.append(lengths[i - 1] + hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)) }
        let total = lengths.last ?? 0
        guard total > 0, to > from else { return [] }
        func at(_ d: Double) -> CGPoint {
            let i = max(1, lengths.firstIndex { $0 >= d } ?? points.count - 1)
            let span = lengths[i] - lengths[i - 1], f = span > 0 ? (d - lengths[i - 1]) / span : 0
            return CGPoint(x: points[i - 1].x + (points[i].x - points[i - 1].x) * f, y: points[i - 1].y + (points[i].y - points[i - 1].y) * f)
        }
        let a = from * total, b = to * total
        return [at(a)] + points.indices.filter { lengths[$0] > a && lengths[$0] < b }.map { points[$0] } + [at(b)]
    }
}

/// A Relo window's eyebrow: the title in the state's colour, its count, and a hairline fading out.
struct ReloGlassSectionHeader: View {
    let title: String
    var count: Int?
    var color: Color = ReloNotchTheme.secondaryText

    var body: some View {
        HStack(spacing: 8) {
            // Never wraps: the rule after it gives way instead.
            Text(title.uppercased()).foregroundStyle(color).tracking(1.6).lineLimit(1).fixedSize()
            if let count {
                Text("\(count)").foregroundStyle(color.opacity(0.7)).contentTransition(.numericText(value: Double(count)))
            }
            LinearGradient(colors: [color.opacity(0.4), .clear], startPoint: .leading, endPoint: .trailing).frame(height: 0.5)
        }
        .font(ReloGlass.eyebrow)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// Settings rows on one glass panel, with an eyebrow above and a footnote below. Put `ReloGlassDivider` between rows.
struct ReloGlassGroup<Content: View>: View {
    var title: String?
    var footer: String?
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let title {
                Text(title.uppercased())
                    .font(ReloGlass.eyebrow).tracking(1.6)
                    .foregroundStyle(.white.opacity(0.5))
                    .padding(.leading, 4)
                    .accessibilityAddTraits(.isHeader)
            }
            VStack(alignment: .leading, spacing: 0) { content }
                .reloGlass()
            if let footer {
                Text(footer)
                    .font(.system(size: 11.5))
                    .foregroundStyle(.white.opacity(0.48))
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 4)
            }
        }
    }
}

struct ReloGlassDivider: View {
    var body: some View {
        Rectangle().fill(Color.white.opacity(0.08)).frame(height: 0.5).padding(.horizontal, 18)
    }
}

/// One settings row's padding.
struct ReloGlassRow: ViewModifier {
    func body(content: Content) -> some View {
        content.padding(.horizontal, 18).padding(.vertical, 13).frame(maxWidth: .infinity, alignment: .leading)
    }
}

extension View {
    func reloGlassRow() -> some View { modifier(ReloGlassRow()) }
}

/// A row's title with an optional line under it.
struct ReloGlassLabel: View {
    let title: String
    var detail: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.system(size: 13.5)).foregroundStyle(.white)
            if let detail {
                Text(detail).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.5)).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// The glass switch: violet and lit when on, the knob springing across; it sounds as it turns (docs/SOUND.md).
struct ReloGlassToggleStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 14) {
            configuration.label.frame(maxWidth: .infinity, alignment: .leading)
            ReloGlassSwitch(isOn: configuration.$isOn)
        }
        .contentShape(Rectangle())
        .onTapGesture { configuration.isOn.toggle() }
        .onChange(of: configuration.isOn) { _, on in ReloCuePlayer.shared.play(on ? .on : .off) }
        .accessibilityRepresentation { Toggle(isOn: configuration.$isOn) { configuration.label } }
    }
}

private struct ReloGlassSwitch: View {
    @Binding var isOn: Bool
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack(alignment: isOn ? .trailing : .leading) {
            Capsule()
                .fill(isOn
                      ? AnyShapeStyle(LinearGradient(colors: [Color(red: 0xA1 / 255, green: 0x94 / 255, blue: 1), Color(red: 0x7A / 255, green: 0x68 / 255, blue: 1)],
                                                     startPoint: .top, endPoint: .bottom))
                      : AnyShapeStyle(Color.white.opacity(0.14)))
                .overlay(Capsule().strokeBorder(.white.opacity(isOn ? 0.3 : 0.16), lineWidth: 0.5))
                .shadow(color: ReloNotchTheme.running.opacity(isOn ? 0.45 : 0), radius: 8)
            Circle()
                .fill(LinearGradient(colors: [.white, Color(white: 0.9)], startPoint: .top, endPoint: .bottom))
                .shadow(color: .black.opacity(0.35), radius: 3, y: 2)
                .padding(2)
        }
        .frame(width: 40, height: 24)
        .opacity(isEnabled ? 1 : 0.4)
        .animation(ReloMotion.or(ReloMotion.bouncy, reduced: reduceMotion), value: isOn)
    }
}

/// A quiet glass capsule button (Check now, Sign out); `tint` colours its text.
struct ReloGlassButtonStyle: ButtonStyle {
    var tint: Color = .white

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12.5, weight: .semibold))
            .foregroundStyle(tint.opacity(0.92))
            .padding(.horizontal, 15)
            .padding(.vertical, 7)
            .background(Capsule().fill(.white.opacity(configuration.isPressed ? 0.16 : 0.08)))
            .overlay(Capsule().strokeBorder(.white.opacity(0.14), lineWidth: 0.5))
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(ReloMotion.press, value: configuration.isPressed)
            .contentShape(Capsule())
    }
}

extension Color {
    /// The colour moved toward white, so a state colour reads as text on glass.
    func reloLight(_ amount: Double) -> Color {
        let base = NSColor(self).usingColorSpace(.sRGB) ?? NSColor(self)
        return Color(nsColor: base.blended(withFraction: amount, of: .white) ?? base)
    }
}
