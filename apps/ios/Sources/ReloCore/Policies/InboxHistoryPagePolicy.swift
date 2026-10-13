import Foundation

public enum InboxHistoryPagePolicy {
    public static func isValid(
        _ page: InboxHistoryPage,
        requestedCursor: String?
    ) -> Bool {
        guard
            page.items.count <= InboxHistoryPage.maximumItems,
            Set(page.items.map(\.id)).count == page.items.count,
            page.total >= page.items.count,
            page.hasMore == (page.cursor != nil),
            isNewestFirst(page.items)
        else { return false }

        if page.hasMore {
            guard
                page.items.count == InboxHistoryPage.maximumItems,
                page.total > page.items.count,
                page.cursor?.isEmpty == false,
                page.cursor != requestedCursor
            else { return false }
        }

        if requestedCursor == nil {
            return page.hasMore || page.total == page.items.count
        }
        return page.total > 0
    }

    public static func isValidContinuation(
        _ page: InboxHistoryPage,
        after snapshot: InboxHistorySnapshot,
        requestedCursor: String
    ) -> Bool {
        guard
            isValid(page, requestedCursor: requestedCursor),
            snapshot.source == .server,
            snapshot.cursor == requestedCursor,
            let expectedTotal = snapshot.total,
            expectedTotal >= snapshot.items.count,
            page.total >= expectedTotal
        else { return false }

        let existingIDs = Set(snapshot.items.map(\.id))
        guard page.items.allSatisfy({ !existingIDs.contains($0.id) }) else { return false }

        if let oldestLoaded = snapshot.items.last, let nextItem = page.items.first {
            guard sortsBefore(oldestLoaded, nextItem) else { return false }
        }

        let accumulatedCount = snapshot.items.count + page.items.count
        return page.hasMore
            ? accumulatedCount < expectedTotal
            : accumulatedCount == expectedTotal
    }

    private static func isNewestFirst(_ items: [InboxItem]) -> Bool {
        zip(items, items.dropFirst()).allSatisfy(sortsBefore)
    }

    private static func sortsBefore(_ newer: InboxItem, _ older: InboxItem) -> Bool {
        if newer.createdAt == older.createdAt { return newer.id > older.id }
        return newer.createdAt > older.createdAt
    }
}
