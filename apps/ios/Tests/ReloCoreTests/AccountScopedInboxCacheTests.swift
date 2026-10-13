@testable import ReloPersistence
import Foundation
import XCTest
@testable import ReloCore

final class AccountScopedInboxCacheTests: XCTestCase {
    func testCurrentCacheRetainsCanonicalActivityAndPresentationAcrossColdLaunch() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let fileURL = directory.appendingPathComponent("inbox.json")
        let cache = FileInboxCache(fileURL: fileURL)
        let context = InboxContext(
            providerName: "Codex",
            project: "Relo notifications",
            threadName: "Lifecycle audit",
            taskTitle: "Keep the cold-launch layout stable"
        )
        let summary = InboxActivitySummary(
            id: "act_cache123456",
            originThreadId: "org_cache123456",
            generation: 2,
            sequence: 6,
            state: "ended",
            title: "Codex · Relo notifications",
            status: "Complete",
            detail: "Cache retains canonical activity context",
            terminalReason: "ended_by_producer",
            context: context,
            updatedAt: Date(timeIntervalSince1970: 1_800_000_000),
            endedAt: Date(timeIntervalSince1970: 1_800_000_000)
        )
        let item = InboxItem(
            id: "ntf_cache123456",
            kind: .liveActivity,
            sourceName: "developer-mac-codex",
            title: "Earlier event",
            createdAt: Date(timeIntervalSince1970: 1_800_000_000),
            liveActivity: LiveActivityCommand(
                operation: .end,
                activityId: summary.id,
                generation: summary.generation,
                targetDeviceId: "dev_cache123456",
                style: "standard",
                sourceName: "developer-mac-codex",
                headline: "Earlier event",
                status: "Complete",
                sequence: summary.sequence
            ),
            activitySummary: summary,
            context: context
        )

        try await cache.save(InboxSnapshot(items: [item], cursor: "cursor"))
        let loaded = try await cache.load()

        XCTAssertEqual(loaded.items, [item.historySummary()])
        XCTAssertNil(loaded.items.first?.liveActivity)
        XCTAssertNil(loaded.items.first?.activitySummary)
        XCTAssertEqual(loaded.items.first?.context?.threadName, "Lifecycle audit")
        let stored = try JSONSerialization.jsonObject(with: Data(contentsOf: fileURL)) as? [String: Any]
        XCTAssertEqual(stored?["schemaVersion"] as? Int, LocalStoreSchema.inboxCache)
    }

    func testAccountsNeverOpenEachOthersSnapshots() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = AccountScopedInboxCache(
            baseDirectory: directory.appendingPathComponent("accounts")
        )
        let first = InboxSnapshot(items: [item(id: "evt_first1234567")], cursor: "first")

        try await cache.select(accountId: "acc_first123456")
        try await cache.save(first)
        try await cache.select(accountId: "acc_second12345")

        let second = try await cache.load()
        XCTAssertEqual(second, InboxSnapshot())

        try await cache.select(accountId: "acc_first123456")
        let reloadedFirst = try await cache.load()
        XCTAssertEqual(reloadedFirst, first)
    }

    func testIncompatibleLegacyCacheIsDiscardedWhenCacheOpens() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let accountID = "acc_legacyactivity1"
        let storedURL = directory
            .appendingPathComponent("accounts", isDirectory: true)
            .appendingPathComponent(accountID, isDirectory: true)
            .appendingPathComponent("inbox.json")
        try FileManager.default.createDirectory(
            at: storedURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let json = #"{"items":[{"id":"ntf_legacyactivity","kind":"live_activity","sourceName":"Relo","title":"Legacy activity","createdAt":"2027-01-15T11:59:00Z","liveActivity":{"operation":"start","activityId":"act_legacyactivity","targetDeviceId":"dev_legacyactivity","style":"standard","sourceName":"Relo","headline":"Legacy activity","status":"Running"}}],"cursor":null,"lastSuccessfulSyncAt":null}"#
        try Data(json.utf8).write(to: storedURL, options: .atomic)
        let cache = AccountScopedInboxCache(
            baseDirectory: directory.appendingPathComponent("accounts")
        )

        try await cache.select(accountId: accountID)
        let snapshot = try await cache.load()

        XCTAssertEqual(snapshot, InboxSnapshot())
        XCTAssertFalse(FileManager.default.fileExists(atPath: storedURL.path))
    }

    func testEachAccountPersistsOnlyItsNewestBoundedHistoryWithoutLosingCursor() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let accountsDirectory = directory.appendingPathComponent("accounts")
        let cache = AccountScopedInboxCache(
            baseDirectory: accountsDirectory
        )
        let itemCount = InboxHistoryRetention.maximumStoredItems + 25

        try await cache.select(accountId: "acc_first123456")
        try await cache.save(InboxSnapshot(
            items: history(prefix: "first", count: itemCount),
            cursor: "first-cursor"
        ))
        let first = try await cache.load()

        try await cache.select(accountId: "acc_second12345")
        try await cache.save(InboxSnapshot(
            items: history(prefix: "second", count: itemCount),
            cursor: "second-cursor"
        ))
        let second = try await cache.load()

        XCTAssertEqual(first.items.count, InboxHistoryRetention.maximumStoredItems)
        XCTAssertEqual(second.items.count, InboxHistoryRetention.maximumStoredItems)
        XCTAssertEqual(first.cursor, "first-cursor")
        XCTAssertEqual(second.cursor, "second-cursor")
        XCTAssertTrue(first.items.allSatisfy { $0.id.hasPrefix("first_") })
        XCTAssertTrue(second.items.allSatisfy { $0.id.hasPrefix("second_") })

        try await cache.select(accountId: "acc_first123456")
        let reloadedFirst = try await cache.load()
        XCTAssertEqual(reloadedFirst, first)

        let storedURL = accountsDirectory
            .appendingPathComponent("acc_first123456", isDirectory: true)
            .appendingPathComponent("inbox.json")
        let stored = try InboxCacheStorage.decode(Data(contentsOf: storedURL)).snapshot
        XCTAssertEqual(stored.items.count, InboxHistoryRetention.maximumStoredItems)
    }

    func testOpeningAnExistingOversizedAccountSnapshotCompactsItOnDisk() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let accountsDirectory = directory.appendingPathComponent("accounts")
        let accountID = "acc_existing12345"
        let storedURL = accountsDirectory
            .appendingPathComponent(accountID, isDirectory: true)
            .appendingPathComponent("inbox.json")
        try FileManager.default.createDirectory(
            at: storedURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let oversized = InboxSnapshot(
            items: history(
                prefix: "existing",
                count: InboxHistoryRetention.maximumStoredItems + 25
            ),
            cursor: "existing-cursor"
        )
        try InboxCacheStorage.encode(oversized).write(to: storedURL, options: .atomic)
        let cache = AccountScopedInboxCache(
            baseDirectory: accountsDirectory
        )

        try await cache.select(accountId: accountID)
        let loaded = try await cache.load()

        XCTAssertEqual(loaded.items.count, InboxHistoryRetention.maximumStoredItems)
        XCTAssertEqual(loaded.cursor, "existing-cursor")
        let compacted = try InboxCacheStorage.decode(Data(contentsOf: storedURL)).snapshot
        XCTAssertEqual(compacted, loaded)
    }

    private func temporaryDirectory() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    }

    private func item(id: String) -> InboxItem {
        InboxItem(
            id: id,
            kind: .notification,
            sourceName: "Test",
            title: "Event",
            createdAt: Date(timeIntervalSince1970: 1_800_000_000)
        )
    }

    private func history(prefix: String, count: Int) -> [InboxItem] {
        (0..<count).map { index in
            InboxItem(
                id: String(format: "%@_%012d", prefix, index),
                kind: .notification,
                sourceName: "Test",
                title: "Event \(index)",
                createdAt: Date(timeIntervalSince1970: TimeInterval(index))
            )
        }
    }

    private func write(_ snapshot: InboxSnapshot, to url: URL) throws {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        try encoder.encode(snapshot).write(to: url, options: .atomic)
    }

    private func read(from url: URL) throws -> InboxSnapshot {
        try InboxCacheStorage.decode(Data(contentsOf: url)).snapshot
    }
}
