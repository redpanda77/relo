import SwiftUI

/// A card of rows: one surface, a hairline between rows. Rows are `CardRow`s; the first passes `divider: false`.
struct CardGroup<Content: View>: View {
    var tint: Color? = nil
    @ViewBuilder var content: Content

    var body: some View {
        VStack(spacing: 0) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .reloCard(tint: tint)
    }
}

/// One row of a `CardGroup`: the standard inset, a hairline above it, and the full row as the hit area.
struct CardRow<Content: View>: View {
    var divider = true
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(.horizontal, ReloLayout.cardInset).padding(.vertical, ReloLayout.rowInset)
            .frame(maxWidth: .infinity, minHeight: ReloLayout.rowMinHeight, alignment: .leading)
            .contentShape(Rectangle())
            .cardDivider(divider)
    }
}

extension View {
    /// The hairline between two rows of a `CardGroup`, inset like the row's text.
    func cardDivider(_ shown: Bool = true) -> some View {
        overlay(alignment: .top) {
            if shown {
                Rectangle().fill(Color.primary.opacity(0.1)).frame(height: 0.5).padding(.leading, ReloLayout.cardInset)
            }
        }
    }
}
