import Foundation

public enum InboxBadgeProjection {
    /// The icon badge represents unanswered, unexpired requests rather than total history.
    public static func pendingInteractionCount(
        in items: [InboxItem],
        now: Date = .now
    ) -> Int {
        items.reduce(into: 0) { count, item in
            guard
                let interaction = item.interaction,
                interaction.state == .pending,
                interaction.expiresAt > now
            else { return }
            count += 1
        }
    }
}
