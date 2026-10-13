import Foundation

public enum InboxHistoryRefreshPolicy {
    public static func visibleSnapshot(
        current: InboxHistorySnapshot,
        refreshedCacheItems: [InboxItem]
    ) -> InboxHistorySnapshot {
        current.source == .server
            ? current
            : .offlineCache(items: refreshedCacheItems)
    }
}
