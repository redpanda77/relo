import SwiftUI

/// The one button of the app. Primary is the coral action; secondary is quiet glass; destructive is the
/// same quiet glass with the error color, never a system-red fill. Full width at one height.
struct ReloButtonStyle: ButtonStyle {
    enum Kind { case primary, secondary, destructive }

    var kind: Kind = .primary
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static let height: CGFloat = 50

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: ReloLayout.buttonRadius, style: .continuous)
        configuration.label
            .font(.headline)
            .foregroundStyle(foreground)
            .frame(maxWidth: .infinity, minHeight: Self.height)
            .background(shape.fill(fill))
            .overlay(shape.strokeBorder(stroke, lineWidth: 1))
            .contentShape(shape)
            .opacity(isEnabled ? (configuration.isPressed ? 0.85 : 1) : 0.45)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.975 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.75), value: configuration.isPressed)
    }

    private var foreground: Color {
        switch kind {
        case .primary: .reloOnAction
        case .secondary: .primary
        case .destructive: .reloDestructive
        }
    }

    private var fill: Color {
        switch kind {
        case .primary: .reloActionFill
        case .secondary, .destructive: Color.white.opacity(0.08)
        }
    }

    private var stroke: Color {
        switch kind {
        case .primary: .clear
        case .secondary: Color.white.opacity(0.12)
        case .destructive: Color.reloDestructive.opacity(0.35)
        }
    }
}

/// The inline capsule: Review, Retry, Turn on. Its hit area keeps 44 pt around a 36 pt capsule.
struct ReloCapsuleButtonStyle: ButtonStyle {
    var tint: Color = .reloActionFill
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .reloCapsule(tint: tint)
            .padding(.vertical, 4)
            .contentShape(Rectangle())
            .opacity(isEnabled ? (configuration.isPressed ? 0.85 : 1) : 0.45)
    }
}

extension View {
    /// The capsule's look, for a capsule drawn inside a larger tappable row (the row is the button).
    func reloCapsule(tint: Color = .reloActionFill) -> some View {
        font(.subheadline.weight(.semibold))
            .foregroundStyle(Color.reloOnAction)
            .padding(.horizontal, 14).frame(minHeight: 36)
            .background(tint, in: Capsule())
    }
}

extension ButtonStyle where Self == ReloButtonStyle {
    static var reloPrimary: ReloButtonStyle { ReloButtonStyle(kind: .primary) }
    static var reloSecondary: ReloButtonStyle { ReloButtonStyle(kind: .secondary) }
    static var reloDestructive: ReloButtonStyle { ReloButtonStyle(kind: .destructive) }
    static func relo(_ kind: ReloButtonStyle.Kind) -> ReloButtonStyle { ReloButtonStyle(kind: kind) }
}

extension ButtonStyle where Self == ReloCapsuleButtonStyle {
    static var reloCapsule: ReloCapsuleButtonStyle { ReloCapsuleButtonStyle() }
    static func reloCapsule(tint: Color) -> ReloCapsuleButtonStyle { ReloCapsuleButtonStyle(tint: tint) }
}
