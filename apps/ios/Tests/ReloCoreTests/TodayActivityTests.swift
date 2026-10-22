import Foundation
import Testing
@testable import ReloCore

@Suite("Today's activity by hour")
struct TodayActivityTests {
    private let now = ISO8601DateFormatter().date(from: "2026-10-01T08:00:00Z")!  // 12:00 in Dubai
    private var calendar: Calendar {
        var value = Calendar(identifier: .gregorian)
        value.timeZone = TimeZone(identifier: "Asia/Dubai")!
        return value
    }
    private func row(_ id: String, at date: Date, done: Bool = false) -> HistoryRow {
        let item = InboxItem(id: id, kind: done ? .liveActivity : .notification, sourceName: "Fixture", title: id,
            createdAt: date,
            activity: done ? .init(state: "ended", outcome: "completed", status: "ok", progress: 1,
                                   steps: nil, updates: 2, startedAt: date.addingTimeInterval(-60), endedAt: date) : nil)
        return HistoryRowProjection.row(item, now: now)
    }

    @Test("Buckets today's rows by hour, newest first, ignoring other days")
    func buckets() {
        let start = calendar.startOfDay(for: now)
        let rows = [row("early", at: start.addingTimeInterval(3600 * 9 + 60)),
                    row("a", at: now.addingTimeInterval(-600), done: true),
                    row("b", at: now.addingTimeInterval(-300)),
                    row("yesterday", at: start.addingTimeInterval(-10))]
        let result = TodayActivity.make(rows: rows, now: now, calendar: calendar)
        #expect(result.rows.map(\.id) == ["b", "a", "early"])
        #expect(result.currentHour == 12)
        #expect(result.totals[11] == 2 && result.totals[12] == 0 && result.totals[9] == 1)
        #expect(result.done[11] == 1 && result.done.reduce(0, +) == 1)
        #expect(result.maxTotal == 2)
        #expect(!result.isEmpty)
    }

    @Test("The hero's TODAY number is the strip's settled rows, never one per card update")
    func heroCountsSettledRows() {
        let running = HistoryRowProjection.row(InboxItem(id: "live", kind: .liveActivity, sourceName: "Fixture", title: "live",
            createdAt: now.addingTimeInterval(-120),
            activity: .init(state: "active", outcome: nil, status: "Working", progress: nil, steps: nil, updates: 40,
                            startedAt: now.addingTimeInterval(-3600), endedAt: nil)), now: now)
        #expect(running.outcome == .running)
        let settled = TodayActivity.settled(rows: [running, row("a", at: now.addingTimeInterval(-600), done: true),
                                                   row("b", at: now.addingTimeInterval(-300))], now: now, calendar: calendar)
        #expect(settled.rows.map(\.id) == ["b", "a"])
        let raw = InboxTodaySummary(notifications: 236, liveActivities: 3, active: 1, finished: 2)
        #expect(raw.total == 239)
        let shown = raw.counting(settled.rows.count)
        #expect(shown.total == 2 && shown.finished == 2 && shown.notifications == 236)
    }

    @Test("A day with nothing is empty")
    func empty() {
        let result = TodayActivity.make(rows: [], now: now, calendar: calendar)
        #expect(result.isEmpty && result.maxTotal == 0 && result.totals.count == 24)
    }
}
