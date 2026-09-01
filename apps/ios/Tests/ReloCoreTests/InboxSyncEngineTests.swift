import XCTest
@testable import ReloCore

final class InboxSyncEngineTests: XCTestCase {
    func testRefreshPolicyKeepsServerHistoryVisibleWhileCacheRefreshCompletes() {
        let serverItem = item(id: "evt_serverhistory1", title: "Server history", minutesAgo: 1)
        let cacheItem = item(id: "evt_cachehistory12", title: "Cache history", minutesAgo: 2)
        let serverHistory = InboxHistorySnapshot(
            items: [serverItem],
            cursor: "older-history",
            hasMore: true,
            total: 12,
            source: .server
        )

        let visible = InboxHistoryRefreshPolicy.visibleSnapshot(
            current: serverHistory,
            refreshedCacheItems: [cacheItem]
        )

        XCTAssertEqual(visible, serverHistory)
    }

    func testRefreshPolicyUsesRefreshedCacheUntilServerHistoryHasLoaded() {
        let stale = item(id: "evt_stalecache123", title: "Stale", minutesAgo: 2)
        let refreshed = item(id: "evt_freshcache12", title: "Refreshed", minutesAgo: 1)

        let visible = InboxHistoryRefreshPolicy.visibleSnapshot(
            current: .offlineCache(items: [stale]),
            refreshedCacheItems: [refreshed]
        )

        XCTAssertEqual(visible, .offlineCache(items: [refreshed]))
    }

    func testReconnectFetchesEveryEventAfterDurableCursorExactlyOnce() async throws {
        let old = item(id: "evt_before123456", minutesAgo: 20)
        let missedOne = item(id: "evt_missed123456", minutesAgo: 10)
        let missedTwo = item(id: "evt_missed789012", minutesAgo: 5)
        let cache = InMemoryInboxCache(
            snapshot: InboxSnapshot(items: [old], cursor: "cursor-before", lastSuccessfulSyncAt: nil)
        )
        let remote = FakeRemote(steps: [
            .page(InboxPage(items: [missedOne], cursor: "cursor-middle", hasMore: true, serverTime: .now)),
            .page(InboxPage(items: [missedTwo], cursor: "cursor-after", hasMore: false, serverTime: .now))
        ])
        let syncedAt = Date(timeIntervalSince1970: 1_800_000_000)
        let engine = InboxSyncEngine(remote: remote, cache: cache, now: { syncedAt })

        let result = try await engine.synchronize()

        XCTAssertEqual(Set(result.items.map(\.id)), Set([old.id, missedOne.id, missedTwo.id]))
        XCTAssertEqual(result.items.count, 3)
        XCTAssertEqual(result.cursor, "cursor-after")
        XCTAssertEqual(result.lastSuccessfulSyncAt, syncedAt)
        let cursors = await remote.requestedCursors
        XCTAssertEqual(cursors, ["cursor-before", "cursor-middle"])
        let persisted = await cache.load()
        XCTAssertEqual(persisted, result)
    }

    func testPartialSyncCommitsEachPageAndResumesAfterConnectionFailure() async throws {
        let first = item(id: "evt_first1234567", minutesAgo: 2)
        let second = item(id: "evt_second123456", minutesAgo: 1)
        let cache = InMemoryInboxCache()
        let interruptedRemote = FakeRemote(steps: [
            .page(InboxPage(items: [first], cursor: "cursor-one", hasMore: true, serverTime: .now)),
            .failure(.unavailable)
        ])
        let interruptedEngine = InboxSyncEngine(remote: interruptedRemote, cache: cache)

        do {
            _ = try await interruptedEngine.synchronize()
            XCTFail("Expected the second page to fail")
        } catch InboxRemoteError.unavailable {
            // Expected.
        }

        let afterFailure = await cache.load()
        XCTAssertEqual(afterFailure.items, [first])
        XCTAssertEqual(afterFailure.cursor, "cursor-one")

        let resumedRemote = FakeRemote(steps: [
            .page(InboxPage(items: [second], cursor: "cursor-two", hasMore: false, serverTime: .now))
        ])
        let resumedEngine = InboxSyncEngine(remote: resumedRemote, cache: cache)
        let result = try await resumedEngine.synchronize()

        let requested = await resumedRemote.requestedCursors
        XCTAssertEqual(requested, ["cursor-one"])
        XCTAssertEqual(Set(result.items.map(\.id)), Set([first.id, second.id]))
        XCTAssertEqual(result.cursor, "cursor-two")
    }

    func testDuplicateEventIsReplacedByAuthoritativeServerValue() async throws {
        let original = item(id: "evt_duplicate1234", title: "Queued", minutesAgo: 4, state: .queued)
        let updated = item(id: original.id, title: "Accepted", minutesAgo: 4, state: .acceptedByAPNs)
        let cache = InMemoryInboxCache(snapshot: InboxSnapshot(items: [original], cursor: "old"))
        let remote = FakeRemote(steps: [
            .page(InboxPage(items: [updated], cursor: "new", hasMore: false, serverTime: .now))
        ])

        let result = try await InboxSyncEngine(remote: remote, cache: cache).synchronize()

        XCTAssertEqual(result.items, [updated])
    }

    func testExpiredCursorRebuildsProjectionFromServer() async throws {
        let stale = item(id: "evt_stale1234567", minutesAgo: 30)
        let canonical = item(id: "evt_canonical123", minutesAgo: 1)
        let cache = InMemoryInboxCache(snapshot: InboxSnapshot(items: [stale], cursor: "expired"))
        let remote = FakeRemote(steps: [
            .failure(.cursorExpired),
            .page(InboxPage(items: [canonical], cursor: "fresh", hasMore: false, serverTime: .now))
        ])

        let result = try await InboxSyncEngine(remote: remote, cache: cache).synchronize()

        XCTAssertEqual(result.items, [canonical])
        XCTAssertEqual(result.cursor, "fresh")
        let cursors = await remote.requestedCursors
        XCTAssertEqual(cursors, ["expired", nil])
    }

    func testLargeHistoryKeepsNewestBoundedWindowWhileAdvancingThroughEveryPage() async throws {
        let itemCount = InboxHistoryRetention.maximumStoredItems + 50
        let history = (0..<itemCount).map { index in
            item(
                id: String(format: "evt_%012d", index),
                minutesAgo: TimeInterval(itemCount - index)
            )
        }
        var steps: [FakeRemote.Step] = []
        for lowerBound in stride(from: 0, to: history.count, by: 50) {
            let upperBound = min(lowerBound + 50, history.count)
            steps.append(.page(InboxPage(
                items: Array(history[lowerBound..<upperBound]),
                cursor: "cursor-\(upperBound)",
                hasMore: true,
                serverTime: .now
            )))
        }
        let authoritativeNewest = item(
            id: history.last!.id,
            title: "Authoritative newest",
            minutesAgo: 1
        )
        steps.append(.page(InboxPage(
            items: [authoritativeNewest],
            cursor: "cursor-final",
            hasMore: false,
            serverTime: .now
        )))
        let cache = InMemoryInboxCache()
        let remote = FakeRemote(steps: steps)

        let result = try await InboxSyncEngine(remote: remote, cache: cache).synchronize()

        XCTAssertEqual(result.items.count, InboxHistoryRetention.maximumStoredItems)
        XCTAssertEqual(Set(result.items.map(\.id)).count, result.items.count)
        XCTAssertEqual(result.items.first, authoritativeNewest)
        XCTAssertFalse(result.items.contains { $0.id == history[49].id })
        XCTAssertTrue(result.items.contains { $0.id == history[50].id })
        XCTAssertEqual(result.cursor, "cursor-final")
        let persisted = await cache.load()
        XCTAssertEqual(persisted, result)
        let requestedCursors = await remote.requestedCursors
        XCTAssertEqual(requestedCursors.count, steps.count)
        XCTAssertNil(requestedCursors.first!)
        XCTAssertEqual(requestedCursors.last!, "cursor-\(itemCount)")
    }

    func testServerHistoryPagerTraversesMoreThanTwentyOneHundredItemsWithoutCacheTruncation() async throws {
        let itemCount = 2_101
        let history = (0..<itemCount).map { index in
            item(
                id: String(format: "evt_history%08d", index),
                minutesAgo: TimeInterval(index)
            )
        }
        var steps: [FakeHistoryRemote.Step] = []
        for lowerBound in stride(from: 0, to: history.count, by: 100) {
            let upperBound = min(lowerBound + 100, history.count)
            let hasMore = upperBound < history.count
            steps.append(.page(InboxHistoryPage(
                items: Array(history[lowerBound..<upperBound]),
                cursor: hasMore ? "history-cursor-\(upperBound)" : nil,
                hasMore: hasMore,
                total: itemCount,
                serverTime: .now
            )))
        }
        let remote = FakeHistoryRemote(steps: steps)
        let pager = InboxHistoryPager(remote: remote)

        var snapshot = try await pager.reload()
        while snapshot.hasMore {
            snapshot = try await pager.loadMore()
        }

        XCTAssertEqual(snapshot.source, .server)
        XCTAssertEqual(snapshot.total, itemCount)
        XCTAssertEqual(snapshot.items.count, itemCount)
        XCTAssertEqual(Set(snapshot.items.map(\.id)).count, itemCount)
        XCTAssertEqual(snapshot.items.first?.id, history.first?.id)
        XCTAssertEqual(snapshot.items.last?.id, history.last?.id)
        XCTAssertNil(snapshot.cursor)
        let requestedCursors = await remote.requestedCursors
        XCTAssertEqual(requestedCursors.count, 22)
        XCTAssertNil(requestedCursors.first!)
        XCTAssertEqual(requestedCursors.last!, "history-cursor-2100")
    }

    func testExpiredServerHistoryCursorRebuildsWithoutMixingOldWindow() async throws {
        let oldNewest = item(id: "evt_oldnewest1234", minutesAgo: 1)
        let oldSecond = item(id: "evt_oldsecond1234", minutesAgo: 2)
        let canonical = item(id: "evt_canonical5678", minutesAgo: 0)
        let oldPage = [oldNewest] + (1..<100).map { index in
            item(id: String(format: "evt_oldfill%08d", index), minutesAgo: TimeInterval(index + 2))
        }
        let remote = FakeHistoryRemote(steps: [
            .page(InboxHistoryPage(
                items: oldPage,
                cursor: "expired-history-cursor",
                hasMore: true,
                total: 101,
                serverTime: .now
            )),
            .failure(.cursorExpired),
            .page(InboxHistoryPage(
                items: [canonical, oldSecond],
                cursor: nil,
                hasMore: false,
                total: 2,
                serverTime: .now
            )),
        ])
        let pager = InboxHistoryPager(remote: remote)

        _ = try await pager.reload()
        let rebuilt = try await pager.loadMore()

        XCTAssertEqual(rebuilt.items, [canonical, oldSecond])
        XCTAssertFalse(rebuilt.items.contains(oldNewest))
        XCTAssertEqual(Set(rebuilt.items.map(\.id)).count, rebuilt.items.count)
        XCTAssertEqual(rebuilt.total, 2)
        XCTAssertFalse(rebuilt.hasMore)
        let requestedCursors = await remote.requestedCursors
        XCTAssertEqual(requestedCursors, [nil, "expired-history-cursor", nil])
    }

    func testHistoryPagePolicyRejectsOversizeDuplicatesOrderAndImpossibleTotals() {
        let ordered = (0..<100).map { index in
            item(id: String(format: "evt_policy%08d", 100 - index), minutesAgo: TimeInterval(index))
        }
        let valid = InboxHistoryPage(
            items: ordered,
            cursor: "next",
            hasMore: true,
            total: 101,
            serverTime: .now
        )
        XCTAssertTrue(InboxHistoryPagePolicy.isValid(valid, requestedCursor: nil))

        let cases = [
            InboxHistoryPage(
                items: ordered + [item(id: "evt_oversized1234", minutesAgo: 101)],
                cursor: "next", hasMore: true, total: 102, serverTime: .now
            ),
            InboxHistoryPage(
                items: Array(repeating: ordered[0], count: 100),
                cursor: "next", hasMore: true, total: 101, serverTime: .now
            ),
            InboxHistoryPage(
                items: [ordered[1], ordered[0]],
                cursor: nil, hasMore: false, total: 2, serverTime: .now
            ),
            InboxHistoryPage(
                items: [
                    item(id: "evt_tie000000001", minutesAgo: 1),
                    item(id: "evt_tie000000002", minutesAgo: 1),
                ],
                cursor: nil, hasMore: false, total: 2, serverTime: .now
            ),
            InboxHistoryPage(
                items: Array(ordered.prefix(99)),
                cursor: "next", hasMore: true, total: 101, serverTime: .now
            ),
            InboxHistoryPage(
                items: [ordered[0]],
                cursor: nil, hasMore: false, total: 2, serverTime: .now
            ),
        ]
        for page in cases {
            XCTAssertFalse(InboxHistoryPagePolicy.isValid(page, requestedCursor: nil))
        }
        XCTAssertFalse(InboxHistoryPagePolicy.isValid(
            InboxHistoryPage(items: [], cursor: nil, hasMore: false, total: 0, serverTime: .now),
            requestedCursor: "anchor"
        ))
    }

    func testHistoryPagerRejectsMalformedCrossPageBoundariesWithoutMutatingSnapshot() async throws {
        let firstPageItems = (0..<100).map { index in
            item(id: String(format: "evt_boundary%08d", 200 - index), minutesAgo: TimeInterval(index))
        }
        let malformedPages = [
            InboxHistoryPage(
                items: [firstPageItems.last!],
                cursor: nil,
                hasMore: false,
                total: 101,
                serverTime: .now
            ),
            InboxHistoryPage(
                items: [item(id: "evt_newerboundary", minutesAgo: 98)],
                cursor: nil,
                hasMore: false,
                total: 101,
                serverTime: .now
            ),
            InboxHistoryPage(
                items: [item(id: "evt_missingterminal", minutesAgo: 100)],
                cursor: nil,
                hasMore: false,
                total: 102,
                serverTime: .now
            ),
            InboxHistoryPage(
                items: [item(id: "evt_totalregressed", minutesAgo: 100)],
                cursor: nil,
                hasMore: false,
                total: 100,
                serverTime: .now
            ),
        ]

        for malformedPage in malformedPages {
            let firstPage = InboxHistoryPage(
                items: firstPageItems,
                cursor: "page-two",
                hasMore: true,
                total: malformedPage.items.first?.id == "evt_missingterminal" ? 102 : 101,
                serverTime: .now
            )
            let pager = InboxHistoryPager(remote: FakeHistoryRemote(steps: [
                .page(firstPage),
                .page(malformedPage),
            ]))
            let initial = try await pager.reload()

            do {
                _ = try await pager.loadMore()
                XCTFail("A malformed continuation must fail closed")
            } catch let error as InboxRemoteError {
                XCTAssertEqual(error, .unavailable)
            }
            let retained = await pager.currentSnapshot()
            XCTAssertEqual(retained, initial)
        }
    }

    func testHistoryPagerKeepsFirstPageTotalWhenNewerEventsArriveDuringBackwardWalk() async throws {
        let firstPageItems = (0..<100).map { index in
            item(id: String(format: "evt_stabletotal%08d", 200 - index), minutesAgo: TimeInterval(index))
        }
        let oldest = item(id: "evt_stableoldest", minutesAgo: 100)
        let pager = InboxHistoryPager(remote: FakeHistoryRemote(steps: [
            .page(InboxHistoryPage(
                items: firstPageItems,
                cursor: "page-two",
                hasMore: true,
                total: 101,
                serverTime: .now
            )),
            .page(InboxHistoryPage(
                items: [oldest],
                cursor: nil,
                hasMore: false,
                total: 102,
                serverTime: .now
            )),
        ]))

        _ = try await pager.reload()
        let completed = try await pager.loadMore()

        XCTAssertEqual(completed.items.count, 101)
        XCTAssertEqual(completed.items.last, oldest)
        XCTAssertEqual(completed.total, 101)
        XCTAssertFalse(completed.hasMore)
    }

    func testArbitraryOldSelectionSurvivesPageOneCacheAndReconnectRefreshUntilDismissal() {
        let selected = item(id: "evt_selectedold12", title: "Old selected detail", minutesAgo: 4_000)
        var selection = InboxSelectedItemSnapshot()
        selection.select(selected, scopeIdentity: "account|session|device|1")

        let pageOne = (0..<100).map { index in
            item(id: String(format: "evt_pageone%08d", index), minutesAgo: TimeInterval(index))
        }
        let offlineWindow = (0..<InboxHistoryRetention.maximumStoredItems).map { index in
            item(id: String(format: "evt_offline%08d", index), minutesAgo: TimeInterval(index))
        }
        selection.reconcile(
            scopeIdentity: "account|session|device|1",
            availableItems: pageOne
        )
        selection.reconcile(
            scopeIdentity: "account|session|device|1",
            availableItems: offlineWindow
        )

        XCTAssertEqual(selection.item, selected)
        let updated = item(id: selected.id, title: "Updated old detail", minutesAgo: 4_000)
        selection.reconcile(
            scopeIdentity: "account|session|device|1",
            availableItems: [updated]
        )
        XCTAssertEqual(selection.item, updated)
        let staleDuplicate = item(id: selected.id, title: "Stale history detail", minutesAgo: 4_000)
        selection.reconcile(
            scopeIdentity: "account|session|device|1",
            availableItems: [updated, staleDuplicate]
        )
        XCTAssertEqual(selection.item, updated)
        var changedScope = selection
        changedScope.reconcile(
            scopeIdentity: "other-account|session|device|1",
            availableItems: [updated]
        )
        XCTAssertNil(changedScope.item)
        selection.dismiss()
        XCTAssertNil(selection.item)
    }

    func testSuspendedOldAccountRefreshWritesOnlyItsImmutableBoundCache() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let scoped = AccountScopedInboxCache(
            baseDirectory: directory
        )
        try await scoped.select(accountId: "account-a")
        let accountACache = try await scoped.boundCache(for: "account-a")
        let suspended = SuspendedInboxRemote()
        let oldEngine = InboxSyncEngine(remote: suspended, cache: accountACache)
        let oldRefresh = Task { try await oldEngine.synchronize() }
        await suspended.waitUntilRequested()

        try await scoped.select(accountId: "account-b")
        let accountBItem = item(id: "evt_accountb1234", minutesAgo: 1)
        try await scoped.save(InboxSnapshot(items: [accountBItem], cursor: "b-cursor"))
        let accountAItem = item(id: "evt_accounta1234", minutesAgo: 1)
        await suspended.resume(with: InboxPage(
            items: [accountAItem], cursor: "a-cursor", hasMore: false, serverTime: .now
        ))
        _ = try await oldRefresh.value

        let accountB = try await scoped.load()
        XCTAssertEqual(accountB.items, [accountBItem])
        XCTAssertEqual(accountB.cursor, "b-cursor")
        try await scoped.select(accountId: "account-a")
        let accountA = try await scoped.load()
        XCTAssertEqual(accountA.items, [accountAItem])
        XCTAssertEqual(accountA.cursor, "a-cursor")
    }

    func testSeparateHistoryPagersDoNotShareDeviceOrSessionState() async throws {
        let firstDeviceItem = item(id: "evt_firstdevice12", minutesAgo: 1)
        let secondDeviceItem = item(id: "evt_seconddevice1", minutesAgo: 1)
        let firstPager = InboxHistoryPager(remote: FakeHistoryRemote(steps: [
            .page(InboxHistoryPage(
                items: [firstDeviceItem], cursor: nil, hasMore: false, total: 1, serverTime: .now
            )),
        ]))
        let secondPager = InboxHistoryPager(remote: FakeHistoryRemote(steps: [
            .page(InboxHistoryPage(
                items: [secondDeviceItem], cursor: nil, hasMore: false, total: 1, serverTime: .now
            )),
        ]))

        let first = try await firstPager.reload()
        let second = try await secondPager.reload()

        XCTAssertEqual(first.items, [firstDeviceItem])
        XCTAssertEqual(second.items, [secondDeviceItem])
        XCTAssertFalse(second.items.contains(firstDeviceItem))
    }

    private func item(
        id: String,
        title: String = "Event",
        minutesAgo: TimeInterval,
        state: InboxItem.DeliveryState = .acceptedByAPNs
    ) -> InboxItem {
        InboxItem(
            id: id,
            kind: .notification,
            sourceName: "Test",
            title: title,
            deliveryState: state,
            createdAt: Date(timeIntervalSince1970: 1_800_000_000 - minutesAgo * 60)
        )
    }
}

private actor FakeRemote: InboxRemoteDataSource {
    enum Step: Sendable {
        case page(InboxPage)
        case failure(InboxRemoteError)
    }

    private var steps: [Step]
    private(set) var requestedCursors: [String?] = []

    init(steps: [Step]) {
        self.steps = steps
    }

    func fetchPage(after cursor: String?) throws -> InboxPage {
        requestedCursors.append(cursor)
        guard !steps.isEmpty else { throw InboxRemoteError.unavailable }
        switch steps.removeFirst() {
        case let .page(page): return page
        case let .failure(error): throw error
        }
    }
}

private actor FakeHistoryRemote: InboxHistoryRemoteDataSource {
    enum Step: Sendable {
        case page(InboxHistoryPage)
        case failure(InboxRemoteError)
    }

    private var steps: [Step]
    private(set) var requestedCursors: [String?] = []

    init(steps: [Step]) {
        self.steps = steps
    }

    func fetchHistoryPage(before cursor: String?) throws -> InboxHistoryPage {
        requestedCursors.append(cursor)
        guard !steps.isEmpty else { throw InboxRemoteError.unavailable }
        switch steps.removeFirst() {
        case let .page(page): return page
        case let .failure(error): throw error
        }
    }
}

private actor SuspendedInboxRemote: InboxRemoteDataSource {
    private var continuation: CheckedContinuation<InboxPage, Error>?

    func fetchPage(after cursor: String?) async throws -> InboxPage {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
        }
    }

    func waitUntilRequested() async {
        while continuation == nil { await Task.yield() }
    }

    func resume(with page: InboxPage) {
        continuation?.resume(returning: page)
        continuation = nil
    }
}
