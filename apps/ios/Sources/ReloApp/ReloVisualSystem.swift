import SwiftUI

// RELO is dark only and shares the dashboard's tokens: an ink canvas under a fixed gradient
// field, translucent glass above it, coral for action, and one color per state.
// Spacing: 4 / 8 / 12 / 16 / 20 / 24 / 32. Never add row padding twice.
extension Color {
    fileprivate init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255,
                  blue: Double(hex & 255) / 255)
    }

    /// Dashboard `--background`.
    static let reloCanvas = Color(hex: 0x08080D)
    /// Dashboard `.glass-strong` base: the solid fallback for every glass surface.
    static let reloSurface = Color(hex: 0x111119)
    static let reloMediaPlaceholder = Color.white.opacity(0.06)
    /// Filled buttons: a deeper coral so white labels stay above 4.5:1.
    static let reloActionFill = Color(hex: 0xC8432F)
    static let reloOnAction = Color.white
    /// Semantic: something needs the owner (HUD needs-you orange). Use instead of `ReloHoloTheme.orange`.
    static let reloAttention = ReloHoloTheme.orange
    // The state colors (coral, indigo, done, info, warning, error), `reloInteractive` and `reloSecondaryText`
    // live in SharedActivity/ReloStateStyle.swift: the widget draws the same palette.
    /// Semantic: a destructive or failed outcome, as text and quiet borders; never system red.
    static let reloDestructive = reloErrorText
    /// Brand gradient stops (`--brand-gradient`).
    static let reloCoral = Color(hex: 0xFF6B57)
    static let reloMagenta = Color(hex: 0xD65CF0)
    static let reloIndigo = Color(hex: 0x7C6BFF)
    /// The dark lens behind the orb count.
    static let reloOrbCore = reloCanvas
}

/// Dashboard `.glass`: white 4% over the gradient field, a hairline border, a lit top edge and
/// a soft drop shadow. A state tint washes the corner and colors the border, like status cards.
private struct ReloCardSurface: ViewModifier {
    var tint: Color?
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: ReloLayout.cardRadius, style: .continuous)
        let solid = contrast == .increased || reduceTransparency
        content.background {
            ZStack {
                if solid {
                    shape.fill(Color.reloSurface)
                } else {
                    shape.fill(.ultraThinMaterial).opacity(0.45)
                    shape.fill(Color.white.opacity(0.04))
                    if let tint {
                        shape.fill(LinearGradient(colors: [tint.opacity(0.10), .clear, tint.opacity(0.03)],
                                                  startPoint: .topLeading, endPoint: .bottomTrailing))
                    }
                }
                shape.strokeBorder(solid ? Color.white.opacity(0.24) : (tint?.opacity(0.32) ?? Color.white.opacity(0.08)),
                                   lineWidth: 1)
                if !solid {
                    // The glass highlight: light catching the top edge only.
                    shape.strokeBorder(LinearGradient(colors: [.white.opacity(0.14), .clear],
                                                      startPoint: .top, endPoint: .center), lineWidth: 1)
                }
            }
        }
        .shadow(color: .black.opacity(0.45), radius: 24, x: 0, y: 12)
    }
}

/// Grouped-list rows on the atmosphere: the same frosted surface as cards, edge to edge.
struct ReloListRowBackground: View {
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    var body: some View {
        if contrast == .increased || reduceTransparency {
            Color.reloSurface
        } else {
            ZStack {
                Rectangle().fill(.ultraThinMaterial).opacity(0.45)
                Color.white.opacity(0.045)
            }
        }
    }
}

extension View {
    func reloScreenBackground() -> some View {
        // Fill the screen first: a ScrollView hugs narrow content, and the backdrop would hug it too.
        scrollContentBackground(.hidden).frame(maxWidth: .infinity, maxHeight: .infinity)
            .background { ReloAppBackdrop() }
    }

    /// The one custom surface: frosted glass with a lit edge, optionally washed with a state color.
    func reloCard(tint: Color? = nil) -> some View { modifier(ReloCardSurface(tint: tint)) }
}

/// Relo's one motion vocabulary (ADR 0013, section 5): the same values as the Dashboard's tokens and Relo for Mac's.
/// No literal spring or duration outside it, so the same gesture moves the same way everywhere. Reduce Motion
/// swaps every spring for a short fade at the call site (`reduceMotion ? nil : ReloMotion.snappy`).
enum ReloMotion {
    /// Durations, in seconds.
    static let micro = 0.12, fast = 0.18, base = 0.26, slow = 0.42

    /// Touch release (scale 0.97).
    static let press = Animation.spring(response: 0.18, dampingFraction: 1.0)
    /// Things that move: cards, indicators, sheets.
    static let snappy = Animation.spring(response: 0.28, dampingFraction: 0.86)
    /// Larger travel and settling away.
    static let smooth = Animation.spring(response: 0.35, dampingFraction: 1.0)
    /// Success only (a check, linked), never lists.
    static let bouncy = Animation.spring(response: 0.42, dampingFraction: 0.72)
}
