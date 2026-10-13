import ReloCore
import SwiftUI

/// Which corner of the deck a module sits in; it decides the bracket, alignment and leader.
enum ReloHUDCorner {
    case topLeading, topTrailing, bottomLeading, bottomTrailing

    var leading: Bool { self == .topLeading || self == .bottomLeading }
    var top: Bool { self == .topLeading || self == .topTrailing }
    /// The ring angle (degrees, SwiftUI's clockwise-from-east) the module's leader points at.
    var ringAngle: Double {
        switch self {
        case .topLeading: 225
        case .topTrailing: 315
        case .bottomLeading: 135
        case .bottomTrailing: 45
        }
    }
}

/// A corner readout built as part of the instrument: an index, a caption, the number, and a
/// small gauge that says what the number is made of. A hairline bracket closes the deck's
/// corner. Live modules glow in their meaning's color. A value that changes while you watch is
/// acquired like a target: a scan line passes through the module, a reticle closes in on it and
/// the number glows once. A focused live module (requests waiting) keeps a slow bracket glow.
struct ReloHUDModule: View {
    enum Gauge {
        /// Today's mix, as one thin spectrum.
        case mix(NowMix)
        /// A share of the whole (e.g. done of today), as ten cells.
        case share(Double)
        /// One cell per item (running cards, waiting requests), up to ten.
        case items(Int)
    }

    let corner: ReloHUDCorner
    let index: String
    let label: String
    let value: String
    let color: Color
    let lit: Bool
    var focused = false
    let gauge: Gauge
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.reloEffectsArmed) private var armed
    /// The acquire effect: 1 just changed, 0 settled.
    @State private var acquire = 0.0
    /// The scan line's travel down the module, 0 to 1; 1 means no scan showing.
    @State private var scan: CGFloat = 1
    @State private var breathing = false

    private var alignment: HorizontalAlignment { corner.leading ? .leading : .trailing }

    /// When this module started powering on; it builds its parts in order over `buildDuration`.
    var buildStart: Date? = nil
    static let buildDuration: TimeInterval = 1.6
    @State private var building = false

    /// 0 when the build starts, 1 when the module is fully on.
    private func buildProgress(at now: Date) -> Double {
        guard let buildStart, !reduceMotion else { return 1 }
        return min(max(now.timeIntervalSince(buildStart) / Self.buildDuration, 0), 1)
    }

    var body: some View {
        Group {
            if building {
                TimelineView(.animation) { context in face(build: buildProgress(at: context.date)) }
            } else {
                face(build: buildProgress(at: .now))
            }
        }
        .overlay { acquisition.padding(-6) }
        .onChange(of: value) { _, _ in
            guard !reduceMotion, armed else { return }
            scan = 0; acquire = 1
            withAnimation(.easeInOut(duration: 0.8)) { scan = 1 }
            withAnimation(.easeOut(duration: 1.3).delay(0.15)) { acquire = 0 }
        }
        .task(id: focused && lit && armed && !reduceMotion) {
            guard focused && lit && armed && !reduceMotion else { breathing = false; return }
            withAnimation(.easeInOut(duration: 1.8).repeatForever()) { breathing = true }
        }
        // Run the frame clock only while this module is building.
        .task(id: buildStart) {
            let left = buildStart.map { Self.buildDuration - Date.now.timeIntervalSince($0) } ?? 0
            guard left > 0, !reduceMotion else { building = false; return }
            building = true
            try? await Task.sleep(for: .seconds(left + 0.05))
            building = false
        }
        .lineLimit(1).minimumScaleFactor(0.6)
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label.capitalized)
        .accessibilityValue(value)
    }

    /// The module at a point in its build, atom by atom: the bracket draws, the index tag's outline
    /// appears and its number flickers in, the label types out, a placeholder holds while the
    /// number cycles slowly and locks, the gauge's empty cells appear one by one and then light
    /// one by one, and only then does the whole module ease up to full strength.
    private func face(build p: Double) -> some View {
        let done = p >= 1
        let strength = 0.62 + 0.38 * Self.window(p, 0.9, 1)
        return VStack(alignment: alignment, spacing: 4) {
            HStack(spacing: 5) {
                if corner.leading { bootTag(p) }
                Text(Self.typed(label, Self.window(p, 0.2, 0.46)))
                    .font(.system(.caption2, design: .monospaced).weight(.semibold)).tracking(1.6)
                    .foregroundStyle(lit ? color : Color.reloSecondaryText)
                if !corner.leading { bootTag(p) }
            }
            ZStack(alignment: corner.leading ? .leading : .trailing) {
                // A dim placeholder holds the place before the number locks on.
                Text(String(repeating: "–", count: max(value.count, 1)))
                    .font(.system(.title, design: .rounded).weight(.light))
                    .foregroundStyle(Color.reloSecondaryText.opacity(0.5))
                    .opacity(p >= 0.46 && p < 0.56 ? 0.4 + 0.6 * Self.window(p, 0.46, 0.5) : 0)
                Text(Self.scrambled(value, p))
                    .font(.system(.title, design: .rounded).weight(.light))
                    .foregroundStyle(lit ? color : .white)
                    .shadow(color: focused && lit ? color.opacity(0.7) : .clear, radius: 10)
                    .shadow(color: color.opacity(0.9 * acquire), radius: 8)
                    .contentTransition(.numericText())
                    .animation(done ? .smooth(duration: 0.5) : nil, value: value)
                    .opacity(p < 0.56 ? 0 : 0.55 + 0.45 * Self.window(p, 0.56, 0.74))
            }
            gaugeView(fill: Self.window(p, 0.76, 0.92), outline: Self.window(p, 0.66, 0.76))
                .frame(width: 64, height: 4)
        }
        .padding(corner.leading ? .leading : .trailing, 10)
        .padding(corner.top ? .top : .bottom, 8)
        .overlay(alignment: corner.top ? (corner.leading ? .topLeading : .topTrailing)
                                       : (corner.leading ? .bottomLeading : .bottomTrailing)) {
            bracket(trace: Self.window(p, 0, 0.14))
        }
        // Building runs dim; finished, it eases up to full strength.
        .opacity(done ? 1 : strength)
    }

    /// The index tag during a build: its outline first, then its number flickering in softly.
    private func bootTag(_ p: Double) -> some View {
        Text(index)
            .font(.system(size: 8, weight: .medium, design: .monospaced))
            .foregroundStyle(Color.reloSecondaryText.opacity(0.7))
            .opacity(Self.flicker(p, from: 0.12, to: 0.24))
            .padding(.horizontal, 3).padding(.vertical, 1)
            .overlay {
                RoundedRectangle(cornerRadius: 2).trim(from: 0, to: Self.window(p, 0.08, 0.16))
                    .stroke(Color.reloSecondaryText.opacity(0.35), lineWidth: 0.5)
            }
    }

    private static func window(_ p: Double, _ from: Double, _ to: Double) -> Double {
        min(max((p - from) / (to - from), 0), 1)
    }

    /// Off, a few uneven blinks, then on: how a segment display warms up.
    private static func flicker(_ p: Double, from: Double, to: Double) -> Double {
        if p < from { return 0 }
        if p >= to { return 1 }
        let steps: [Double] = [0.5, 0.2, 0.7, 0.45, 1]
        return steps[min(Int(window(p, from, to) * Double(steps.count)), steps.count - 1)]
    }

    /// The label typed out behind a block cursor; padded so the module never changes width.
    private static func typed(_ text: String, _ r: Double) -> String {
        guard r < 1 else { return text }
        let count = Int((Double(text.count) * r).rounded(.down))
        guard r > 0 else { return String(repeating: " ", count: text.count) }
        return String(text.prefix(count)) + "▌" + String(repeating: " ", count: max(text.count - count - 1, 0))
    }

    /// Digits cycling while the readout locks on, then the real value.
    private static func scrambled(_ value: String, _ p: Double) -> String {
        guard p < 0.74 else { return value }
        // About eight changes a second over a 1.6 s build: readable, not frantic.
        let tick = Int(p * 13)
        return String(value.enumerated().map { index, character in
            character.isNumber ? Character(String((tick * 7 + index * 3) % 10)) : character
        })
    }
    private var indexTag: some View {
        Text(index)
            .font(.system(size: 8, weight: .medium, design: .monospaced))
            .foregroundStyle(Color.reloSecondaryText.opacity(0.7))
            .padding(.horizontal, 3).padding(.vertical, 1)
            .overlay { RoundedRectangle(cornerRadius: 2).strokeBorder(Color.reloSecondaryText.opacity(0.35), lineWidth: 0.5) }
    }

    /// An L-shaped hairline that closes the deck's outer corner; booting, it draws from its tip.
    private func bracket(trace: Double) -> some View {
        Path { path in
            let arm: CGFloat = 12
            path.move(to: CGPoint(x: 0, y: arm)); path.addLine(to: .zero); path.addLine(to: CGPoint(x: arm, y: 0))
        }
        .trim(from: 0, to: trace)
        .stroke(lit ? color.opacity(0.75) : Color.white.opacity(0.28), lineWidth: 1)
        .shadow(color: color.opacity(breathing ? 0.9 : 0), radius: 4)
        .shadow(color: color.opacity(0.8 * acquire), radius: 6)
        .frame(width: 12, height: 12)
        .scaleEffect(x: corner.leading ? 1 : -1, y: corner.top ? 1 : -1)
        .accessibilityHidden(true)
    }

    /// The scan line and the reticle that close in on a module whose value just changed.
    private var acquisition: some View {
        GeometryReader { proxy in
            let size = proxy.size
            ZStack(alignment: .top) {
                if scan < 1 {
                    LinearGradient(colors: [color.opacity(0), color.opacity(0.5), color.opacity(0)],
                                   startPoint: .top, endPoint: .bottom)
                        .frame(height: 10)
                        .overlay { Rectangle().fill(color.opacity(0.8)).frame(height: 0.75) }
                        .offset(y: -10 + scan * (size.height + 10))
                        .frame(width: size.width, height: size.height, alignment: .top)
                        .clipped()
                        .blendMode(.plusLighter)
                }
                // Four corner ticks, starting a little outside the module and closing in as they fade.
                Path { path in
                    let inset = -6 * acquire, arm: CGFloat = 6
                    let rect = CGRect(origin: .zero, size: size).insetBy(dx: inset, dy: inset)
                    for (corner, dx, dy) in [(CGPoint(x: rect.minX, y: rect.minY), arm, arm),
                                             (CGPoint(x: rect.maxX, y: rect.minY), -arm, arm),
                                             (CGPoint(x: rect.minX, y: rect.maxY), arm, -arm),
                                             (CGPoint(x: rect.maxX, y: rect.maxY), -arm, -arm)] {
                        path.move(to: CGPoint(x: corner.x, y: corner.y + dy))
                        path.addLine(to: corner)
                        path.addLine(to: CGPoint(x: corner.x + dx, y: corner.y))
                    }
                }
                .stroke(color.opacity(acquire), lineWidth: 1)
                .shadow(color: color.opacity(acquire), radius: 3)
            }
            .frame(width: size.width, height: size.height, alignment: .top)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    /// The gauge, `fill` of the way built (0 to 1): cells light one by one, the spectrum sweeps in.
    @ViewBuilder private func gaugeView(fill: Double, outline: Double = 1) -> some View {
        switch gauge {
        case let .mix(mix):
            GeometryReader { proxy in
                HStack(spacing: 1.5) {
                    if mix.isEmpty {
                        Capsule().fill(Color.white.opacity(0.12))
                    } else {
                        ForEach(mix.shares, id: \.signal) { entry in
                            Capsule().fill(ReloHoloTheme.color(entry.signal))
                                .frame(width: max(2, (proxy.size.width - 1.5 * CGFloat(mix.shares.count - 1)) * entry.share))
                        }
                    }
                }
                .scaleEffect(x: max(fill, 0.001), anchor: corner.leading ? .leading : .trailing)
                .background(alignment: corner.leading ? .leading : .trailing) {
                    Capsule().fill(Color.white.opacity(0.12)).scaleEffect(x: max(outline, 0.001), anchor: corner.leading ? .leading : .trailing)
                }
            }
        case let .share(fraction):
            cells(filled: Int((min(max(fraction, 0), 1) * 10).rounded()), fill: fill, outline: outline)
        case let .items(count):
            cells(filled: min(count, 10), fill: fill, outline: outline)
        }
    }

    private func cells(filled: Int, fill: Double = 1, outline: Double = 1) -> some View {
        // Booting, the empty cells appear one by one, then light one after another up to the value.
        let lit = Int((Double(filled) * fill).rounded(.down))
        let placed = Int((10 * outline).rounded(.up))
        return HStack(spacing: 2) {
            ForEach(0..<10, id: \.self) { index in
                Capsule().fill(index < lit ? color : Color.white.opacity(0.12))
                    .opacity(index < placed ? 1 : 0)
            }
        }
        .environment(\.layoutDirection, corner.leading ? .leftToRight : .rightToLeft)
    }
}

/// Hairline leaders from each corner module to a tick on the ring, so the readouts belong to
/// the instrument. A bright pulse runs along a leader when its module's value changes.
struct ReloHUDLeaders: View {
    let center: CGPoint
    let ringRadius: CGFloat
    let anchors: [(corner: ReloHUDCorner, point: CGPoint, color: Color, lit: Bool, pulse: Int)]

    var body: some View {
        ZStack {
            ForEach(Array(anchors.enumerated()), id: \.offset) { _, anchor in
                ReloHUDLeader(from: anchor.point, to: ringPoint(anchor.corner), color: anchor.color,
                              lit: anchor.lit, pulse: anchor.pulse)
            }
        }
        .allowsHitTesting(false).accessibilityHidden(true)
    }

    private func ringPoint(_ corner: ReloHUDCorner) -> CGPoint {
        let a = corner.ringAngle * .pi / 180
        return CGPoint(x: center.x + cos(a) * ringRadius, y: center.y + sin(a) * ringRadius)
    }
}

private struct ReloHUDLeader: View {
    let from: CGPoint
    let to: CGPoint
    let color: Color
    let lit: Bool
    let pulse: Int
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.reloEffectsArmed) private var armed
    @State private var travel = 1.0

    var body: some View {
        // An elbow: along the module's baseline first, then diagonally to the ring.
        let elbow = CGPoint(x: from.x + (to.x - from.x) * 0.45, y: from.y)
        ZStack {
            Path { path in path.move(to: from); path.addLine(to: elbow); path.addLine(to: to) }
                .stroke(lit ? color.opacity(0.45) : Color.white.opacity(0.14),
                        style: StrokeStyle(lineWidth: 0.6, dash: [2, 3]))
            Circle().fill(lit ? color : Color.white.opacity(0.4)).frame(width: 3, height: 3).position(to)
            Circle().fill(color).frame(width: 4, height: 4)
                .shadow(color: color, radius: 4)
                .modifier(ReloAlongElbow(travel: travel, from: from, elbow: elbow, to: to))
                .opacity(travel < 1 ? 1 : 0)
        }
        .onChange(of: pulse) { _, _ in
            guard !reduceMotion, armed else { return }
            travel = 0
            withAnimation(.easeInOut(duration: 0.8)) { travel = 1 }
        }
    }

}

/// Positions a view along the leader's elbow as `travel` animates from 0 to 1.
private struct ReloAlongElbow: ViewModifier, Animatable {
    var travel: Double
    let from: CGPoint, elbow: CGPoint, to: CGPoint
    nonisolated var animatableData: Double {
        get { travel }
        set { travel = newValue }
    }

    func body(content: Content) -> some View {
        content.position(point)
    }

    private var point: CGPoint {
        if travel < 0.45 {
            let k = travel / 0.45
            return CGPoint(x: from.x + (elbow.x - from.x) * k, y: from.y)
        }
        let k = min((travel - 0.45) / 0.55, 1)
        return CGPoint(x: elbow.x + (to.x - elbow.x) * k, y: elbow.y + (to.y - elbow.y) * k)
    }
}
