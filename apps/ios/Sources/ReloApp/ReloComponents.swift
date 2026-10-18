import ReloCore
import SwiftUI

struct ReloChevron: View {
    var body: some View {
        Image(systemName: "chevron.right").font(.caption.weight(.semibold))
            .foregroundStyle(.tertiary).accessibilityHidden(true)
    }
}

/// Cards press in slightly, like a physical surface; Reduce Motion keeps only the dimming.
struct ReloPressStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.975 : 1)
            .opacity(configuration.isPressed ? 0.88 : 1)
            .animation(.spring(response: 0.28, dampingFraction: 0.72), value: configuration.isPressed)
    }
}

/// The one caps label: monospaced, one weight, one tracking. Section kickers, codes and small status words.
struct ReloMonoLabel: View {
    let text: String
    var color: Color = .reloSecondaryText
    init(_ text: String, color: Color = .reloSecondaryText) { self.text = text; self.color = color }
    var body: some View {
        Text(text).reloEyebrow().foregroundStyle(color)
    }
}

struct ReloEmptyState: View {
    let title: String
    let detail: String
    var symbol = "tray"
    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: symbol)
        } description: { Text(detail) }
        .padding(.vertical, 20)
    }
}

/// The Settings idiom: a filled, gradient tile with a white symbol, then the title.
struct ReloSettingLabel: View {
    let title: String
    let symbol: String
    var color: Color = .reloActionFill
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some View {
        // The fixed-size tile can't grow with the text; at accessibility sizes the words need its width.
        if typeSize.isAccessibilitySize {
            Text(title).fixedSize(horizontal: false, vertical: true).frame(minHeight: 32)
        } else {
            tiled
        }
    }
    private var tiled: some View {
        Label {
            Text(title).fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: symbol)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 29, height: 29)
                .background(color.gradient, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                .accessibilityHidden(true)
        }
        .frame(minHeight: 32)
    }
}

/// A filter chip. Selected chips fill with the action color; menu chips carry a chevron.
struct ReloFilterPill: View {
    let title: String
    var symbol: String?
    let selected: Bool
    var menu = false
    let action: () -> Void

    var body: some View {
        if menu { label } else { Button(action: action) { label }.buttonStyle(.plain) }
    }

    private var label: some View {
        HStack(spacing: 6) {
            if let symbol { Image(systemName: symbol).font(.caption.weight(.semibold)) }
            Text(title).font(.subheadline.weight(.semibold)).lineLimit(1)
            if menu { Image(systemName: "chevron.down").font(.caption2.weight(.bold)).opacity(0.7) }
        }
        .foregroundStyle(selected ? Color.reloCanvas : Color.primary)
        .padding(.horizontal, 14).frame(minHeight: 34)
        .background {
            Capsule().fill(selected ? AnyShapeStyle(Color.reloInteractive) : AnyShapeStyle(Color.white.opacity(0.07)))
        }
        .overlay { Capsule().strokeBorder(Color.white.opacity(selected ? 0 : 0.12), lineWidth: 0.75) }
        .contentShape(Capsule())
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}
