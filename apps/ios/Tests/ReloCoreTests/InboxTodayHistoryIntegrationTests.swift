import Foundation
import Testing
@testable import ReloCore
import ReloRuntime

@Suite("Daily totals through server history")
struct InboxTodayHistoryIntegrationTests {
    @Test("Fetches beyond the retained cache and stops after covering today's events")
    func busyDay() async throws {
        let now = ISO8601DateFormatter().date(from: "2026-10-01T08:00:00Z")!
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Dubai")!
        let start = calendar.startOfDay(for: now)
        let today = (0..<350).map {
            InboxItem(id: "today-\($0)", kind: .notification, sourceName: "Fixture", title: "Today",
                      createdAt: now.addingTimeInterval(-Double($0)))
        }
        let yesterday = (0..<100).map {
            InboxItem(id: "yesterday-\($0)", kind: .notification, sourceName: "Fixture", title: "Yesterday",
                      createdAt: start.addingTimeInterval(-Double($0 + 1)))
        }
        let remote = DailyHistoryFixture(items: today + yesterday, now: now)
        let pager = InboxHistoryPager(remote: remote)
        var snapshot = try await pager.reload()
        while InboxTodaySummary.needsMoreHistory(snapshot: snapshot, cachedItems: Array(today.prefix(250)), now: now, calendar: calendar) {
            snapshot = try await pager.loadMore()
        }
        #expect(await remote.requestCount == 4)
        #expect(snapshot.hasMore) // Older days are left for deliberate History browsing.
        let attention = InboxAttentionProjection.make(items: snapshot.items, now: now, acceptedNotificationIDs: [], queuedNotificationIDs: [])
        #expect(InboxTodaySummary.make(items: snapshot.items, attention: attention, now: now, calendar: calendar).notifications == 350)
    }
}

private actor DailyHistoryFixture: InboxHistoryRemoteDataSource {
    let items: [InboxItem]
    let now: Date
    private(set) var requestCount = 0
    init(items: [InboxItem], now: Date) { self.items = items; self.now = now }
    func fetchHistoryPage(before cursor: String?) async throws -> InboxHistoryPage {
        requestCount += 1
        let offset = cursor.flatMap(Int.init) ?? 0
        let end = min(offset + 100, items.count)
        return InboxHistoryPage(items: Array(items[offset..<end]), cursor: end < items.count ? "\(end)" : nil,
                                hasMore: end < items.count, total: items.count, serverTime: now)
    }
}
