import ReloCore
import Foundation

public actor InboxSyncEngine {
    private let remote: any InboxSnapshotRemoteDataSource
    private let cache: any InboxCache
    private let now: @Sendable () -> Date
    private var revision = 0

    public init(remote: any InboxSnapshotRemoteDataSource, cache: any InboxCache,
                now: @escaping @Sendable () -> Date = { Date() }) {
        self.remote = remote; self.cache = cache; self.now = now
    }

    public func cachedSnapshot() async throws -> InboxSnapshot { try await cache.load() }

    /// One authoritative repair replaces the window, including removals and late commits.
    /// Neither a cursor nor a failed predecessor-cache read can gate network recovery.
    public func synchronize() async throws -> InboxSnapshot {
        revision += 1
        let expected = revision
        try Task.checkCancellation()
        let response = try await remote.fetchSnapshot()
        try Task.checkCancellation()
        guard revision == expected else { throw CancellationError() }
        let snapshot = try response.snapshot(syncedAt: now())
        try await cache.save(snapshot)
        try Task.checkCancellation()
        guard revision == expected else { throw CancellationError() }
        return snapshot
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
