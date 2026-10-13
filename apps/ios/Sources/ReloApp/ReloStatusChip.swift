import SwiftUI

/// Palette shared by the all-clear surfaces (kept local so it does not depend on the HUD theme).
enum ReloClearPalette {
    static let mint = Color(red: 0x34 / 255, green: 0xD3 / 255, blue: 0x99 / 255)
    static let amber = Color(red: 0xFB / 255, green: 0xBF / 255, blue: 0x24 / 255)
    static let cyan = Color(red: 0x5C / 255, green: 0xE1 / 255, blue: 1)
    static let violet = Color(red: 0x8B / 255, green: 0x7C / 255, blue: 1)
    static let gray = Color(red: 0x8A / 255, green: 0x8F / 255, blue: 0xA3 / 255)
}

/// A compact live-status chip: a glowing dot, or a scanning sweep while it works.
struct ReloStatusChip: View {
    enum Mode: Equatable { case live, syncing, offline, pending }
    let mode: Mode
    let text: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulse = false

    private var tone: Color {
        switch mode {
        case .live: ReloClearPalette.mint
        case .syncing, .pending: ReloClearPalette.cyan
        case .offline: ReloClearPalette.amber
        }
    }

    var body: some View {
        HStack(spacing: 8) {
            indicator
            Text(text.uppercased())
                .font(.system(.caption2, design: .monospaced).weight(.medium)).tracking(1.1)
                .foregroundStyle(mode == .live ? Color.reloSecondaryText : tone)
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
