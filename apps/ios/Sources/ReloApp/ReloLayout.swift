import SwiftUI

enum ReloLayout {
    static let screenInset: CGFloat = 16
    static let cardInset: CGFloat = 16
    static let itemSpacing: CGFloat = 12
    static let sectionSpacing: CGFloat = 20
    static let cardRadius: CGFloat = 20
}

extension View {
    /// Match native grouped surfaces to the same outer edges as custom scroll content.
    func reloGroupedScreen() -> some View {
        contentMargins(.horizontal, ReloLayout.screenInset, for: .scrollContent)
            .reloScreenBackground()
    }
}
