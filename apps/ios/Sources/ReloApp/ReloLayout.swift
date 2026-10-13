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

extension View {
    /// Pull-to-refresh that holds the spinner for a beat: a refresh that returns at once otherwise
    /// snaps the page back up mid-pull, which reads as a glitch.
    func reloRefreshable(_ action: @escaping @Sendable () async -> Void) -> some View {
        refreshable {
            async let minimum: Void = { try? await Task.sleep(for: .milliseconds(700)) }()
            await action()
            await minimum
        }
    }
}
