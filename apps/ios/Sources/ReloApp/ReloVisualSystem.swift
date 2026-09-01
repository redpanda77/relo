import SwiftUI

extension Color {
    static let reloCanvas = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.063, green: 0.051, blue: 0.071, alpha: 1)
            : UIColor(red: 0.972, green: 0.961, blue: 0.949, alpha: 1)
    })

    static let reloSurface = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.105, green: 0.086, blue: 0.113, alpha: 1)
            : UIColor(red: 1, green: 0.994, blue: 0.985, alpha: 1)
    })

    static let reloCoral = Color(red: 1, green: 0.42, blue: 0.34)
    static let reloIndigo = Color(red: 0.25, green: 0.45, blue: 1)
    static let reloInteractive = Color(red: 0.11, green: 0.56, blue: 0.45)
}
struct ReloSignalField: View {
    var intensity: Double = 1

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @State private var lowPowerModeEnabled = ProcessInfo.processInfo.isLowPowerModeEnabled

    var body: some View {
        Group {
            if reduceMotion || reduceTransparency || lowPowerModeEnabled {
                staticField
            } else {
                TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { timeline in
                    Rectangle()
                        .fill(Color(red: 0.063, green: 0.051, blue: 0.071))
                        .colorEffect(
                            ShaderLibrary.reloSignalField(
                                .float(timeline.date.timeIntervalSinceReferenceDate),
                                .color(.reloCoral),
                                .color(.reloIndigo),
                                .float(intensity)
                            )
                        )
                }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .NSProcessInfoPowerStateDidChange)) { _ in
            lowPowerModeEnabled = ProcessInfo.processInfo.isLowPowerModeEnabled
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private var staticField: some View {
        ZStack {
            Color(red: 0.063, green: 0.051, blue: 0.071)
            RadialGradient(
                colors: [Color.reloCoral.opacity(0.3 * intensity), .clear],
                center: .topTrailing,
                startRadius: 12,
                endRadius: 310
            )
            RadialGradient(
                colors: [Color.reloIndigo.opacity(0.22 * intensity), .clear],
                center: .bottomLeading,
                startRadius: 18,
                endRadius: 340
            )
        }
    }
}

struct ReloOverviewPanel: View {
    let readiness: String
    let readinessSymbol: String
    let activeCount: Int
    let pendingCount: Int
    let syncLabel: String

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Relo")
                        .font(.system(.caption, design: .rounded, weight: .bold))
                        .tracking(1.5)
                        .foregroundStyle(.white.opacity(0.68))
                    Text("Your private signal desk")
                        .font(.title2.weight(.bold))
                        .foregroundStyle(.white)
                }
                Spacer(minLength: 8)
                Label(readiness, systemImage: readinessSymbol)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(readiness == "Ready" ? Color.mint : Color.orange)
                    .lineLimit(1)
                    .minimumScaleFactor(0.78)
                    .padding(.horizontal, 10)
                    .frame(width: 124)
                    .frame(minHeight: 32)
                    .background(.white.opacity(0.09), in: Capsule())
            }

            ViewThatFits(in: .horizontal) {
                HStack(spacing: 22) { metrics }
                VStack(alignment: .leading, spacing: 12) { metrics }
            }
        }
        .padding(20)
        .background {
            ReloSignalField(intensity: 0.78)
        }
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(.white.opacity(0.09), lineWidth: 0.5)
        }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private var metrics: some View {
        metric(title: "Active", value: activeCount.formatted(), symbol: "waveform.path.ecg")
        metric(title: "Needs reply", value: pendingCount.formatted(), symbol: "text.bubble")
        metric(title: "Sync", value: syncLabel, symbol: "arrow.triangle.2.circlepath")
    }

    private func metric(title: String, value: String, symbol: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: symbol)
                .foregroundStyle(Color.reloCoral)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.58))
                Text(value)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
