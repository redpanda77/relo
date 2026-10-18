import SwiftUI

/// A card's title. `.row` is a work or a list row; `.hero` is the question on a question card.
struct CardTitle: View {
    enum Style { case row, hero }
    let text: String
    var style: Style = .row
    @Environment(\.dynamicTypeSize) private var typeSize

    init(_ text: String, style: Style = .row) { self.text = text; self.style = style }

    var body: some View {
        Text(text)
            .font(style == .hero ? ReloLayout.cardHero : ReloLayout.cardTitle)
            .foregroundStyle(.primary)
            .lineLimit(typeSize.isAccessibilitySize ? nil : (style == .hero ? 4 : 3))
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityAddTraits(style == .hero ? .isHeader : [])
    }
}

/// What the work says about itself, in its own words: one or two lines under the title.
struct CardStatusLine: View {
    let text: String
    var color: Color = .reloSecondaryText
    var symbol: String? = nil
    var lines = 2
    @Environment(\.dynamicTypeSize) private var typeSize

    init(_ text: String, color: Color = .reloSecondaryText, symbol: String? = nil, lines: Int = 2) {
        self.text = text; self.color = color; self.symbol = symbol; self.lines = lines
    }

    var body: some View {
        Group {
            if let symbol { Label(text, systemImage: symbol) } else { Text(text) }
        }
        .font(ReloLayout.cardStatus).foregroundStyle(color)
        .lineLimit(typeSize.isAccessibilitySize ? nil : lines)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A rare explanatory line a card owes the owner once: it sits at the foot of the card in the meta type.
struct CardNote: View {
    let text: String
    var symbol: String? = nil
    init(_ text: String, symbol: String? = nil) { self.text = text; self.symbol = symbol }

    var body: some View {
        Group {
            if let symbol { Label(text, systemImage: symbol) } else { Text(text) }
        }
        .font(ReloLayout.cardMeta).foregroundStyle(Color.reloSecondaryText)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

extension Text {
    /// Meta pieces joined with " · " in the secondary color: "Step 3 of 10 · Reproduce the issue · MacBook Pro".
    static func cardMeta(_ parts: [Text]) -> Text? {
        guard var joined = parts.first else { return nil }
        for part in parts.dropFirst() { joined = joined + Text(" · ").foregroundColor(Color.reloSecondaryText.opacity(0.7)) + part }
        return joined.foregroundColor(Color.reloSecondaryText)
    }

    static func cardMeta(_ parts: [String]) -> Text? {
        cardMeta(parts.filter { !$0.isEmpty }.map { Text($0) })
    }
}
