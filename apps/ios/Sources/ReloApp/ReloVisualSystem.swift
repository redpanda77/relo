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

/// The notch's glass: a white fill falling from 8.5% at the top to 3% at the bottom over a light blur, a 0.5 pt
/// hairline, a lit top edge and a soft drop shadow. A state tint washes it top to bottom and colours the hairline;
/// an urgent card also carries a glowing edge on its leading side (system cards that need the owner).
private struct ReloCardSurface: ViewModifier {
    var tint: Color?
    var edge = false
    /// A breathing radial glow of the tint near the top (a question card).
    var wash = false
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
                    shape.fill(.ultraThinMaterial).opacity(0.35)
                    shape.fill(LinearGradient(colors: [.white.opacity(0.085), .white.opacity(0.03)], startPoint: .top, endPoint: .bottom))
                    if let tint {
                        shape.fill(LinearGradient(colors: [tint.opacity(0.13), tint.opacity(0.03)], startPoint: .top, endPoint: .bottom))
                    }
                }
                shape.strokeBorder(solid ? Color.white.opacity(0.24) : (tint?.opacity(0.4) ?? Color.white.opacity(0.13)),
                                   lineWidth: solid ? 1 : 0.5)
                if !solid, wash, let tint { CardWash(tint: tint) }
                if !solid {
                    // The glass highlight: light catching the top edge only.
                    shape.strokeBorder(LinearGradient(colors: [.white.opacity(0.2), .clear],
                                                      startPoint: .top, endPoint: .init(x: 0.5, y: 0.25)), lineWidth: 1)
                }
            }
        }
        .overlay(alignment: .leading) {
            if edge, let tint { BreathingEdge(tint: tint) }
        }
        .shadow(color: .black.opacity(0.22), radius: 8, x: 0, y: 8)
    }
}

/// The glowing leading edge of a card that needs the owner: breathes .5 to 1 over 2.1 s with a 10 pt glow.
/// It breathes under Reduce Motion too (a slow fade, no travel).
private struct BreathingEdge: View {
    let tint: Color
    @State private var bright = false

    var body: some View {
        Capsule().fill(tint).frame(width: 2).padding(.vertical, 14)
            .shadow(color: tint, radius: 10)
            .opacity(bright ? 1 : 0.5)
            .accessibilityHidden(true)
            .reloLoop(.easeInOut(duration: 2.1).repeatForever(autoreverses: true), flag: $bright)
    }
}

/// The question card's wash: a radial ellipse of the tint at 22% centred above the card's top edge, its lower
/// part glowing into the card, breathing between .65 and 1 over 1.8 s (the design's `.wash::before`).
private struct CardWash: View {
    let tint: Color
    @State private var bright = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        GeometryReader { proxy in
            let w = proxy.size.width, h = proxy.size.height
            // The design's box is 140% x 120% of the card, starting at -20% / -60%; its gradient is centred at
            // 50% / 30% of that box and fades to nothing at 70% of the half-size.
            RadialGradient(colors: [tint.opacity(0.22), tint.opacity(0.22 * 0.3), .clear],
                           center: .center, startRadius: 0, endRadius: 100)
                .frame(width: 200, height: 200)
                .scaleEffect(x: 0.49 * w / 100, y: 0.42 * h / 100)
                .position(x: w / 2, y: -0.24 * h)
        }
        .opacity(reduceMotion ? 1 : (bright ? 1 : 0.65))
        .clipShape(RoundedRectangle(cornerRadius: ReloLayout.cardRadius, style: .continuous))
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .reloLoop(.easeInOut(duration: 1.8).repeatForever(autoreverses: true), flag: $bright)
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
    func reloCard(tint: Color? = nil, edge: Bool = false, wash: Bool = false) -> some View {
        modifier(ReloCardSurface(tint: tint, edge: edge, wash: wash))
    }
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
