import Foundation

public enum InboxHistoryRetention {
    /// Relo server remains authoritative. The iPhone keeps a bounded, protected
    /// offline projection so large accounts cannot grow local storage forever.
    public static let maximumStoredItems = 250

    public static func retainingNewest(_ items: [InboxItem]) -> [InboxItem] {
        var byID: [String: InboxItem] = [:]
        for item in items {
            byID[item.id] = item
        }
        return Array(byID.values.sorted {
            if $0.createdAt == $1.createdAt { return $0.id > $1.id }
            return $0.createdAt > $1.createdAt
        }.prefix(maximumStoredItems))
    }

    public static func retainingNewest(in snapshot: InboxSnapshot) -> InboxSnapshot {
        var retained = snapshot
        retained.items = retainingNewest(snapshot.items).map { $0.historySummary() }
        let retainedIDs = Set(retained.items.map(\.id))
        retained.historyMetadata = snapshot.historyMetadata?.filter { retainedIDs.contains($0.key) }
        return retained
    }
}
