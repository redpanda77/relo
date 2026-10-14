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

/// The deck's footer: where the data stands, then today's proportions edge to edge. It names
/// what the colors mean without repeating the corner counts.
struct ReloDeckFooter: View {
    enum Sync: Equatable { case live(Date), syncing, offline }
    let sync: Sync
    let pendingResponses: Int
    let mix: NowMix
    var agentTime: String? = nil
    var trouble: String? = nil
    var showConnection: () -> Void = {}
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var breathing = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Where the data stands, and the way into connection details and recovery.
            Button(action: showConnection) {
                HStack(spacing: 6) {
                    status
                    Image(systemName: "chevron.right").font(.system(size: 8, weight: .bold))
                        .foregroundStyle(Color.reloSecondaryText)
                    Spacer(minLength: 8)
                    if let agentTime {
                        Text("\(agentTime) session time")
                            .font(.system(.caption2, design: .monospaced)).foregroundStyle(Color.reloSecondaryText)
                            .lineLimit(1).minimumScaleFactor(0.8)
                    }
                }
                .frame(minHeight: 32).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Shows connection details and recovery options")
            if !mix.isEmpty { ReloSpectrumBar(mix: mix) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var status: some View {
        let (color, text): (Color, String) = if let trouble { (ReloHoloTheme.color(.attention), trouble) } else { switch sync {
        case let .live(at): (ReloHoloTheme.color(.done), "LIVE · SYNCED \(at.formatted(date: .omitted, time: .shortened))")
        case .syncing: (ReloHoloTheme.color(.running), "SYNCING")
        case .offline: (ReloHoloTheme.color(.attention), "OFFLINE · SAVED WORK")
        } }
        return HStack(spacing: 6) {
            Circle().fill(color).frame(width: 6, height: 6)
                .opacity(sync == .syncing && breathing ? 0.35 : 1)
            Text(text).foregroundStyle(color)
            if pendingResponses > 0 {
                Text("· \(pendingResponses) SENDING").foregroundStyle(Color.reloSecondaryText)
            }
        }
        .font(.system(.caption2, design: .monospaced).weight(.medium)).tracking(1)
        .fixedSize()
        // The dot breathes only while syncing; otherwise nothing animates here.
        .onChange(of: sync == .syncing, initial: true) { _, syncing in
            guard !reduceMotion else { return }
            if syncing { withAnimation(.easeInOut(duration: 0.8).repeatForever()) { breathing = true } }
            else { withAnimation(nil) { breathing = false } }
        }
        .accessibilityElement(children: .combine)
    }
}
