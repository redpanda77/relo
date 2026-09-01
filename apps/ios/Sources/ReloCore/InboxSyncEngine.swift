import Foundation

public actor InboxSyncEngine {
    private let remote: any InboxRemoteDataSource
    private let cache: any InboxCache
    private let now: @Sendable () -> Date

    public init(
        remote: any InboxRemoteDataSource,
        cache: any InboxCache,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.remote = remote
        self.cache = cache
        self.now = now
    }

    public func cachedSnapshot() async throws -> InboxSnapshot {
        try await cache.load()
    }

    /// Push notifications are hints only. Every refresh resumes from the last
    /// committed server cursor, so a phone that was offline catches up later.
    public func synchronize() async throws -> InboxSnapshot {
        var snapshot = try await cache.load()

        do {
            return try await applyPages(to: snapshot, startingAfter: snapshot.cursor, replaceExisting: false)
        } catch InboxRemoteError.cursorExpired {
            snapshot = InboxSnapshot()
            return try await applyPages(to: snapshot, startingAfter: nil, replaceExisting: true)
        }
    }

    private func applyPages(
        to initial: InboxSnapshot,
        startingAfter initialCursor: String?,
        replaceExisting: Bool
    ) async throws -> InboxSnapshot {
        var snapshot = initial
        var cursor = initialCursor
        var firstPage = true

        repeat {
            let page = try await remote.fetchPage(after: cursor)
            if replaceExisting && firstPage {
                snapshot.items = []
            }

            snapshot.items = Self.merging(
                existing: snapshot.items,
                incoming: page.items
            )
            snapshot.cursor = page.cursor ?? cursor
            snapshot.lastSuccessfulSyncAt = now()
            snapshot.readWatermark = page.readWatermark ?? snapshot.readWatermark
            snapshot.unread = page.unread ?? snapshot.unread

            // Save after every page. If connectivity drops mid-sync, the next run
            // resumes after the last durable page instead of restarting or losing it.
            try await cache.save(snapshot)

            cursor = page.cursor
            firstPage = false
            if !page.hasMore { break }
        } while cursor != nil

        return snapshot
    }

    static func merging(
        existing: [InboxItem],
        incoming: [InboxItem]
    ) -> [InboxItem] {
        InboxHistoryRetention.retainingNewest(existing + incoming)
    }
}

public actor InboxHistoryPager {
    private let remote: any InboxHistoryRemoteDataSource
    private var snapshot = InboxHistorySnapshot.offlineCache(items: [])
    private var requestRevision = 0

    public init(remote: any InboxHistoryRemoteDataSource) {
        self.remote = remote
    }

    public func currentSnapshot() -> InboxHistorySnapshot {
        snapshot
    }

    public func reload() async throws -> InboxHistorySnapshot {
        requestRevision += 1
        let expectedRevision = requestRevision
        let page = try await remote.fetchHistoryPage(before: nil)
        guard InboxHistoryPagePolicy.isValid(page, requestedCursor: nil) else {
            throw InboxRemoteError.unavailable
        }
        guard expectedRevision == requestRevision else { return snapshot }
        snapshot = Self.snapshot(from: page)
        return snapshot
    }

    public func loadMore() async throws -> InboxHistorySnapshot {
        guard snapshot.source == .server, snapshot.hasMore, let cursor = snapshot.cursor else {
            return snapshot
        }
        let initialSnapshot = snapshot
        requestRevision += 1
        let expectedRevision = requestRevision

        do {
            let page = try await remote.fetchHistoryPage(before: cursor)
            guard InboxHistoryPagePolicy.isValidContinuation(
                page,
                after: initialSnapshot,
                requestedCursor: cursor
            ) else {
                throw InboxRemoteError.unavailable
            }
            guard expectedRevision == requestRevision else { return snapshot }
            snapshot = InboxHistorySnapshot(
                items: Self.merging(existing: initialSnapshot.items, incoming: page.items),
                cursor: page.cursor,
                hasMore: page.hasMore,
                total: initialSnapshot.total,
                source: .server
            )
            return snapshot
        } catch InboxRemoteError.cursorExpired {
            guard expectedRevision == requestRevision else { return snapshot }
            // A history cursor can expire after retention or scope changes. Never
            // mix the old window with a replacement scope; rebuild from page one.
            return try await reload()
        }
    }

    private static func snapshot(from page: InboxHistoryPage) -> InboxHistorySnapshot {
        InboxHistorySnapshot(
            items: merging(existing: [], incoming: page.items),
            cursor: page.cursor,
            hasMore: page.hasMore,
            total: page.total,
            source: .server
        )
    }

    private static func merging(
        existing: [InboxItem],
        incoming: [InboxItem]
    ) -> [InboxItem] {
        var byID: [String: InboxItem] = [:]
        for item in existing { byID[item.id] = item }
        for item in incoming { byID[item.id] = item }
        return byID.values.sorted {
            if $0.createdAt == $1.createdAt { return $0.id > $1.id }
            return $0.createdAt > $1.createdAt
        }
    }

}
