import ReloCore
import SwiftUI

/// The Now deck's ambient field: faint dust across the whole width, drifting slowly upward in
/// two depths and tinted by today's meanings, so the header reads as one instrument rather
/// than a ball in the middle. Ripples from the orb travel through it.
struct ReloDeckField: View {
    let state: ReloSignalState
    let mix: NowMix
    let waves: [ReloOrbWave]
    /// Where this view's left edge sits in the deck, whose coordinates the ripples use.
    var deckOffsetX: CGFloat = 0

    private struct Mote { let x, y, speed, size, phase, slot: Double }

    private static let motes: [Mote] = {
        var seed: UInt64 = 0x44454B
        func next() -> Double {
            seed = seed &* 6364136223846793005 &+ 1442695040888963407
            return Double(seed >> 11) / Double(UInt64(1) << 53)
        }
        return (0..<100).map { _ in
            let far = next() < 0.6
            return Mote(x: next(), y: next(), speed: far ? 0.004 + next() * 0.004 : 0.010 + next() * 0.008,
                        size: far ? 0.5 + next() * 0.5 : 0.9 + next() * 0.9, phase: next() * .pi * 2, slot: next())
        }
    }()

    var body: some View {
        ReloMotionClock(framesPerSecond: 20, still: 5) { time in
            Canvas(opaque: false) { context, size in draw(&context, size: size, t: time) }
        }
        .allowsHitTesting(false).accessibilityHidden(true)
    }

    private func draw(_ context: inout GraphicsContext, size: CGSize, t: Double) {
        let now = Date.now
        let live = waves.filter { now.timeIntervalSince($0.at) < 2.6 }
        let fallback = ReloHoloTheme.accent(for: state)
        for mote in Self.motes {
            let y = (mote.y - t * mote.speed).truncatingRemainder(dividingBy: 1)
            let wrapped = y < 0 ? y + 1 : y
            var point = CGPoint(x: mote.x * size.width + sin(t * 0.3 + mote.phase) * 6, y: wrapped * size.height)
            var lift = 0.0
            for wave in live {
                let push = wave.push(CGPoint(x: point.x + deckOffsetX, y: point.y), now: now)
                point.x += push.dx * 0.8; point.y += push.dy * 0.8; lift += push.lift
            }
            // Fade near the deck's top and bottom so the field has no hard edge.
            let edge = min(wrapped / 0.18, (1 - wrapped) / 0.25, 1)
            let twinkle = 0.55 + 0.45 * sin(t * 1.3 + mote.phase * 5)
            let color = ReloHoloTheme.accentSignal(mix, slot: mote.slot).map(ReloHoloTheme.color) ?? fallback
            let alpha = max(0, edge) * twinkle * (mote.size > 1 ? 0.42 : 0.26) * (1 + 1.5 * min(lift, 1))
            let r = mote.size * (1 + 0.5 * min(lift, 1))
            context.fill(Path(ellipseIn: CGRect(x: point.x - r, y: point.y - r, width: r * 2, height: r * 2)),
                         with: .color(color.opacity(alpha)))
        }
    }
}

/// The deck's status line, at the trailing end of the title row: where the data stands ("● LIVE 6:37",
/// "OFFLINE · 6:37", "SYNCING") and, tapped, the way into connection details and recovery.
struct ReloDeckFooter: View {
    enum Sync: Equatable { case live(Date), syncing, offline(Date?) }
    let sync: Sync
    let pendingResponses: Int
    var trouble: String? = nil
    var showConnection: () -> Void = {}
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var breathing = false

    var body: some View {
        Button(action: showConnection) {
            // A hit area taller and wider than the 9 pt line itself.
            status
                .contentShape(Rectangle().inset(by: -10))
        }
        .buttonStyle(.plain)
        .accessibilityHint("Shows connection details and recovery options")
    }

    private var status: some View {
        let (color, text): (Color, String) = if let trouble { (ReloHoloTheme.color(.attention), trouble) } else { switch sync {
        case let .live(at): (Color(red: 0x34 / 255, green: 0xD3 / 255, blue: 0x99 / 255), "LIVE \(at.formatted(date: .omitted, time: .shortened))")
        case .syncing: (ReloHoloTheme.cyan, "SYNCING")
        case let .offline(at): (ReloHoloTheme.yellow, at.map { "OFFLINE · \($0.formatted(date: .omitted, time: .shortened))" } ?? "OFFLINE")
        } }
        let dotted: Bool = { if case .offline = sync { return false } else { return true } }()
        return HStack(spacing: 4) {
            if dotted {
                Circle().fill(color).frame(width: 5, height: 5)
                    .opacity(sync == .syncing && breathing ? 0.35 : 1)
            }
            Text(text).foregroundStyle(color).lineLimit(1)
            if pendingResponses > 0 {
                Text("· \(pendingResponses) SENDING").foregroundStyle(Color.reloSecondaryText)
            }
        }
        .font(.system(size: 9, weight: .medium, design: .monospaced)).tracking(1)
        .fixedSize()
        // The dot breathes only while syncing; otherwise nothing animates here.
        .reloLoop(.easeInOut(duration: 0.8).repeatForever(), flag: $breathing, enabled: sync == .syncing)
        .accessibilityElement(children: .combine)
    }
}
