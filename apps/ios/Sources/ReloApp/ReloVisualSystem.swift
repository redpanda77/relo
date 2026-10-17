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
    /// Dashboard `--muted-foreground` (7:1 on the canvas).
    static let reloSecondaryText = Color(hex: 0xA4A4B6)
    static let reloErrorText = Color(hex: 0xF87171)
    static let reloMediaPlaceholder = Color.white.opacity(0.06)
    /// Dashboard `--primary`: links, tint and the "act" color.
    static let reloInteractive = Color(hex: 0xFF6B57)
    /// Filled buttons: a deeper coral so white labels stay above 4.5:1.
    static let reloActionFill = Color(hex: 0xC8432F)
    static let reloOnAction = Color.white
    /// Semantic: something needs the owner (HUD needs-you orange). Use instead of `ReloHoloTheme.orange`.
    static let reloAttention = ReloHoloTheme.orange
    /// Semantic: a destructive or failed outcome, as text and quiet borders; never system red.
    static let reloDestructive = reloErrorText
    /// Brand gradient stops (`--brand-gradient`).
    static let reloCoral = Color(hex: 0xFF6B57)
    static let reloMagenta = Color(hex: 0xD65CF0)
    static let reloIndigo = Color(hex: 0x7C6BFF)
    /// State colors (`--status-*`): needs you, running, done.
    static let reloSignalCoral = Color(hex: 0xFF7A66)
    static let reloSignalIndigo = Color(hex: 0x8B7CFF)
    static let reloDone = Color(hex: 0x34D399)
    static let reloInfo = Color(hex: 0x94A3B8)
    static let reloWarning = Color(hex: 0xFBBF24)
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
