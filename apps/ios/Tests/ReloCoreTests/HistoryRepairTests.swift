@testable import ReloTransport
@testable import ReloPersistence
import Foundation
import Testing
@testable import ReloCore

func historyRepairFixture(_ items: [InboxItem], total: Int? = nil) throws -> InboxRepairResponse {
    let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601
    let rows = try items.map { item -> [String: Any] in
        var row = try JSONSerialization.jsonObject(with: encoder.encode(item)) as! [String: Any]
        for key in ["detail", "content", "liveActivity", "activitySummary"] { row.removeValue(forKey: key) }
        row["updatedAt"] = "2026-09-30T20:00:00.123456Z"
        row["contentSummary"] = ["summary": String((item.content?.summary ?? item.detail ?? "").unicodeScalars.prefix(240)),
            "format": "text", "byteLength": item.content?.byteLength ?? (item.detail?.utf8.count ?? 0)]
        return row
    }
    let data = try JSONSerialization.data(withJSONObject: ["items": rows, "total": total ?? items.count,
        "serverTime": "2026-09-30T20:00:00.123456Z", "readWatermark": "exact-watermark",
        "unread": ["account": total ?? items.count, "projects": [:]]])
    return try ReloWireJSON.decoder().decode(InboxRepairResponse.self, from: data)
}

@Suite("Bounded history and exact detail content")
struct HistoryRepairTests {
    private func item(_ id: String, size: Int = 65_536) -> InboxItem {
        .init(id: id, kind: .notification, sourceName: "Source", title: "Title",
            detail: String(repeating: "x", count: size),
            content: .init(summary: "Preview", body: String(repeating: "b", count: size), format: .markdown, byteLength: size),
            createdAt: Date(timeIntervalSince1970: 1_800_000_000.123456))
    }
    private func scope(_ account: String = "a", device: String = "d", origin: String = "https://relo.test") throws -> StorageScope {
        try .init(serverOrigin: URL(string: origin)!, accountID: account, deviceID: device)
    }

    @Test func predecessorHistoryCompactsFullBodiesWithoutLosingReadStateOrDates() async throws {
        let original = InboxSnapshot(items: [item("exact")], readWatermark: "watermark", unread: .init(account: 99, projects: [:]))
        let io = FaultingInboxIO(data: try InboxCacheStorage.encode(original))
        let cache = FileInboxCache(fileURL: URL(fileURLWithPath: "/history"), io: io)
        let snapshot = try await cache.load()
        #expect(snapshot.items[0].content == nil)
        #expect(snapshot.items[0].detail == "Preview")
        #expect(snapshot.items[0].createdAt == original.items[0].createdAt)
        #expect(snapshot.readWatermark == "watermark")
        #expect(snapshot.unread?.account == 99)
        #expect(try #require(io.contents).count < 2_048)
        #expect(try await cache.load() == snapshot)
    }

    @Test func summaryWirePreservesOriginalIdentityDeadlinesAndFractionalClock() throws {
        let response = try historyRepairFixture([item("exact")], total: 12_000)
        let snapshot = try response.snapshot(syncedAt: .now)
        #expect(snapshot.items[0].content == nil)
        #expect(snapshot.items[0].detail == "Preview")
        #expect(snapshot.total == 12_000)
        #expect(snapshot.unread?.account == 12_000)
        #expect(snapshot.historyMetadata?["exact"]?.contentSummary.byteLength == 65_536)
        #expect(snapshot.historyMetadata?["exact"]?.updatedAt == response.serverTime)
    }

    @Test func detailCacheIsExactAndSurvivesRestartWithFractionalDates() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let owner = try scope(), original = item("exact")
        try await FileNotificationDetailCache(baseDirectory: directory, scope: owner).save(original)
        let reopened = FileNotificationDetailCache(baseDirectory: directory, scope: owner)
        #expect(try await reopened.load(notificationID: "exact") == original)
        #expect(try await reopened.load(notificationID: "other") == nil)
        for other in [try scope("b"), try scope(device: "other"), try scope(origin: "https://another.test")] {
            #expect(try await FileNotificationDetailCache(baseDirectory: directory, scope: other).load(notificationID: "exact") == nil)
        }
    }

    @Test func detailCacheEvictsLeastRecentlyOpenedAtFiftyEntries() async throws {
        let io = FaultingInboxIO(data: nil)
        let cache = FileNotificationDetailCache(baseDirectory: URL(fileURLWithPath: "/unused"), scope: try scope(), io: io)
        for index in 0..<50 { try await cache.save(item("\(index)", size: 20)) }
        #expect(try await cache.load(notificationID: "0") != nil)
        try await cache.save(item("new", size: 20))
        #expect(try await cache.load(notificationID: "1") == nil)
        #expect(try await cache.load(notificationID: "0") != nil)
        #expect(try await cache.load(notificationID: "new") != nil)
    }

    @Test func detailCacheEnforcesEncodedByteLimitIncludingEscapingAndMetadata() async throws {
        let io = FaultingInboxIO(data: nil)
        let cache = FileNotificationDetailCache(baseDirectory: URL(fileURLWithPath: "/unused"), scope: try scope(), io: io)
        for index in 0..<50 { try await cache.save(item("\(index)")) }
        #expect(try #require(io.contents).count <= FileNotificationDetailCache.maximumBytes)
        #expect(try await cache.load(notificationID: "0") == nil)
        #expect(try await cache.load(notificationID: "49") != nil)
    }

    @Test func detailCacheReadAndWriteDenialPreserveExistingBytes() async throws {
        let io = FaultingInboxIO(data: nil)
        let cache = FileNotificationDetailCache(baseDirectory: URL(fileURLWithPath: "/unused"), scope: try scope(), io: io)
        try await cache.save(item("exact", size: 10))
        let original = io.contents
        io.setFault(.read)
        await #expect(throws: InboxStorageError.unavailable) { try await cache.save(item("other", size: 10)) }
        #expect(io.contents == original)
        io.setFault(.write)
        await #expect(throws: InboxStorageError.unavailable) { try await cache.save(item("other", size: 10)) }
        #expect(io.contents == original)
        io.setFault(nil)
        #expect(try await cache.load(notificationID: "exact") != nil)
    }
}
