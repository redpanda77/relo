import SwiftUI

/// A compact live-status chip: a glowing dot, or a scanning sweep while it works.
struct ReloStatusChip: View {
    enum Mode: Equatable { case live, syncing, offline, pending }
    let mode: Mode
    let text: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulse = false

    private var tone: Color {
        switch mode {
        case .live: ReloHoloTheme.mint
        case .syncing, .pending: ReloHoloTheme.cyan
        case .offline: ReloHoloTheme.amber
        }
    }

    var body: some View {
        HStack(spacing: 8) {
            indicator
            ReloMonoLabel(text, color: mode == .live ? Color.reloSecondaryText : tone)
                .lineLimit(1).minimumScaleFactor(0.8)
        }
        .padding(.horizontal, 12).padding(.vertical, 7)
        .background {
            ZStack {
                Capsule().fill(tone.opacity(0.07))
                if mode == .syncing { sweep }
            }
            .clipShape(Capsule())
            .overlay { Capsule().strokeBorder(tone.opacity(0.22), lineWidth: 0.5) }
        }
        .frame(minHeight: 28)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(text)
        .onAppear {
            guard !reduceMotion, mode == .live || mode == .syncing else { return }
            withAnimation(.easeInOut(duration: 1.4).repeatForever(autoreverses: true)) { pulse = true }
        }
    }

    @ViewBuilder private var indicator: some View {
        switch mode {
        case .pending:
            Image(systemName: "paperplane.fill").font(.system(size: 9, weight: .semibold)).foregroundStyle(tone)
        case .offline:
            Image(systemName: "wifi.slash").font(.system(size: 9, weight: .semibold)).foregroundStyle(tone)
        case .live, .syncing:
            Circle().fill(tone).frame(width: 6, height: 6)
                .shadow(color: tone.opacity(0.9), radius: pulse ? 5 : 2)
                .opacity(pulse ? 1 : 0.65)
        }
    }

    private var sweep: some View {
        ReloMotionClock(still: 0.4) { time in
            GeometryReader { proxy in
                let width = proxy.size.width
                let x = CGFloat((time / 1.5).truncatingRemainder(dividingBy: 1)) * (width + 60) - 60
                LinearGradient(colors: [.clear, tone.opacity(0.35), .clear], startPoint: .leading, endPoint: .trailing)
                    .frame(width: 60).offset(x: x)
            }
        }
        .accessibilityHidden(true)
    }
}
