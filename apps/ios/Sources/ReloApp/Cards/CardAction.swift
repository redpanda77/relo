import SwiftUI

/// A compact card action: content-sized so it shares the footer row with the metadata, or `fill` for an
/// equal split of the row (answer buttons). ReloButtonStyle stays for sheets and forms.
struct CardActionStyle: ButtonStyle {
    enum Kind: Equatable {
        case primary, secondary, quiet, destructive
        /// A question card's answers (C1): 42 tall capsules, 13.5 semibold. The first is orange with a glow.
        case answerPrimary, answerSecondary
        /// A system card's buttons (C4): 36 tall capsules, 12.5 semibold. The primary is filled with the card's tint.
        case systemPrimary(Color), systemSecondary
    }

    var kind: Kind = .secondary
    var fill = false
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        let answer = kind == .answerPrimary || kind == .answerSecondary
        let system = systemTint != nil || kind == .systemSecondary
        let shape = RoundedRectangle(cornerRadius: answer ? 21 : system ? 18 : ReloLayout.actionRadius, style: .continuous)
        configuration.label
            .font(answer ? .system(size: 13.5, weight: .semibold) : system ? .system(size: 12.5, weight: .semibold) : .subheadline.weight(.semibold))
            .foregroundStyle(foreground)
            .lineLimit(2).multilineTextAlignment(.center)
            .padding(.horizontal, kind == .quiet ? 8 : system ? 15 : 14)
            .frame(maxWidth: fill ? .infinity : nil, minHeight: answer ? 42 : system ? 36 : ReloLayout.actionHeight)
            .background(shape.fill(background))
            .overlay(shape.strokeBorder(stroke, lineWidth: answer ? 0.5 : 1))
            .shadow(color: kind == .answerPrimary ? Color.reloStateOrange.opacity(0.35) : (systemTint?.opacity(0.4) ?? .clear),
                    radius: systemTint == nil ? 9 : 8)
            .contentShape(shape)
            .opacity(isEnabled ? (configuration.isPressed ? 0.85 : 1) : 0.45)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.96 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.75), value: configuration.isPressed)
    }

    private var systemTint: Color? { if case .systemPrimary(let tint) = kind { tint } else { nil } }

    private var foreground: Color {
        switch kind {
        case .systemPrimary: Color(red: 0x12 / 255, green: 0x0A / 255, blue: 0x02 / 255)
        case .systemSecondary: Color(red: 0xF2 / 255, green: 0xF4 / 255, blue: 0xF8 / 255)
        case .primary: .reloOnAction
        case .answerPrimary: Color(red: 0x1B / 255, green: 0x0A / 255, blue: 0x03 / 255)
        case .secondary, .answerSecondary: .primary
        case .quiet: .reloInteractive
        case .destructive: .reloDestructive
        }
    }

    private var background: Color {
        switch kind {
        case .systemPrimary(let tint): tint
        case .systemSecondary: Color.white.opacity(0.1)
        case .primary: .reloActionFill
        case .answerPrimary: .reloStateOrange
        case .answerSecondary: Color.white.opacity(0.12)
        case .secondary, .destructive: Color.white.opacity(0.08)
        case .quiet: .clear
        }
    }

    private var stroke: Color {
        switch kind {
        case .primary, .quiet, .answerPrimary, .systemPrimary: .clear
        case .systemSecondary: Color.white.opacity(0.14)
        case .answerSecondary: Color.white.opacity(0.14)
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
