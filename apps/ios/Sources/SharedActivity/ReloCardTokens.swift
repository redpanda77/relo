import SwiftUI

/// The card system's measures and type recipes, compiled into the app and the widget so a Lock Screen card
/// and a card in Relo are built from the same numbers. No card writes a spacing or font literal of its own.
enum ReloLayout {
    static let screenInset: CGFloat = 16
    static let cardInset: CGFloat = 16
    static let itemSpacing: CGFloat = 12
    static let sectionSpacing: CGFloat = 20
    static let cardRadius: CGFloat = 18
    static let buttonRadius: CGFloat = 14
    /// Tracking for caps labels (ReloMonoLabel); the HUD keeps its own.
    static let labelTracking: CGFloat = 1.4

    // MARK: Card rhythm

    /// Between the lines of one card (header, title, status, footer).
    static let cardGap: CGFloat = 6
    /// Between inline pieces on one line (a badge and a time, two buttons).
    static let inlineGap: CGFloat = 8
    /// Above the footer row (meta and actions).
    static let footerGap: CGFloat = 10
    /// A row inside a grouped card: its vertical padding, and the smallest tappable height.
    static let rowInset: CGFloat = 12
    static let rowMinHeight: CGFloat = 52
    /// A compact card action: tall enough to hit, short enough to share the footer row.
    static let actionHeight: CGFloat = 40
    static let actionRadius: CGFloat = 12
    /// The progress bar along a card's bottom edge, which costs no row.
    static let barHeight: CGFloat = 4
    static let barGap: CGFloat = 3

    /// The radius of a tile nested in a card: concentric with the card's corner, never the card's own radius.
    static func nestedRadius(inset: CGFloat = cardInset) -> CGFloat { max(cardRadius - inset, 8) }

    // MARK: Card type

    /// Small caps kicker: the one monospaced recipe (tracking is applied by `reloEyebrow()`).
    static let cardEyebrow: Font = .system(.caption2, design: .monospaced).weight(.semibold)
    /// A work or row title.
    static let cardTitle: Font = .subheadline.weight(.semibold)
    /// The question on a question card.
    static let cardHero: Font = .headline
    /// The status line under a title.
    static let cardStatus: Font = .footnote
    /// Header corner, footer meta, times.
    static let cardMeta: Font = .caption
}

extension View {
    /// The card eyebrow: monospaced caps with the shared tracking.
    func reloEyebrow() -> some View {
        font(ReloLayout.cardEyebrow).tracking(ReloLayout.labelTracking).textCase(.uppercase)
    }
}

/// How long something took, written one way everywhere: "under a minute", "14m", "1h 20m".
enum ReloDuration {
    static func format(_ seconds: TimeInterval) -> String {
        guard seconds >= 60 else { return "under a minute" }
        return Duration.seconds(seconds).formatted(.units(allowed: [.hours, .minutes], width: .abbreviated, maximumUnitCount: 2))
    }
}
