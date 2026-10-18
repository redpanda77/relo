import SwiftUI

/// A compact card action: content-sized so it shares the footer row with the metadata, or `fill` for an
/// equal split of the row (answer buttons). ReloButtonStyle stays for sheets and forms.
struct CardActionStyle: ButtonStyle {
    enum Kind { case primary, secondary, quiet, destructive }

    var kind: Kind = .secondary
    var fill = false
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: ReloLayout.actionRadius, style: .continuous)
        configuration.label
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(foreground)
            .lineLimit(2).multilineTextAlignment(.center)
            .padding(.horizontal, kind == .quiet ? 8 : 14)
            .frame(maxWidth: fill ? .infinity : nil, minHeight: ReloLayout.actionHeight)
            .background(shape.fill(background))
            .overlay(shape.strokeBorder(stroke, lineWidth: 1))
            .contentShape(shape)
            .opacity(isEnabled ? (configuration.isPressed ? 0.85 : 1) : 0.45)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.985 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.75), value: configuration.isPressed)
    }

    private var foreground: Color {
        switch kind {
        case .primary: .reloOnAction
        case .secondary: .primary
        case .quiet: .reloInteractive
        case .destructive: .reloDestructive
        }
    }

    private var background: Color {
        switch kind {
        case .primary: .reloActionFill
        case .secondary, .destructive: Color.white.opacity(0.08)
        case .quiet: .clear
        }
    }

    private var stroke: Color {
        switch kind {
        case .primary, .quiet: .clear
        case .secondary: Color.white.opacity(0.12)
        case .destructive: Color.reloDestructive.opacity(0.35)
        }
    }
}

extension ButtonStyle where Self == CardActionStyle {
    static func cardAction(_ kind: CardActionStyle.Kind, fill: Bool = false) -> CardActionStyle {
        CardActionStyle(kind: kind, fill: fill)
    }
}

struct CardAction: View {
    let title: String
    var kind: CardActionStyle.Kind = .secondary
    var fill = false
    let action: () -> Void

    init(_ title: String, kind: CardActionStyle.Kind = .secondary, fill: Bool = false, action: @escaping () -> Void) {
        self.title = title; self.kind = kind; self.fill = fill; self.action = action
    }

    var body: some View {
        Button(title, action: action).buttonStyle(.cardAction(kind, fill: fill))
    }
}
