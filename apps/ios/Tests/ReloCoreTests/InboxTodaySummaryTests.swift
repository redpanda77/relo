import Foundation
import Testing
@testable import ReloCore

@Suite("Today's activity summary")
struct InboxTodaySummaryTests {
    private let now = ISO8601DateFormatter().date(from: "2026-10-01T08:00:00Z")!
    private var calendar: Calendar {
        var value = Calendar(identifier: .gregorian)
        value.timeZone = TimeZone(identifier: "Asia/Dubai")!
        return value
    }
    private func item(_ id: String, date: Date? = nil, withdrawn: Bool = false,
                      activity: String? = nil, generation: Int = 1, sequence: Int = 1,
                      state: String = "active", request: Bool = false) -> InboxItem {
        InboxItem(id: id, kind: activity == nil ? .notification : .liveActivity, sourceName: "Fixture", title: id,
            withdrawnAt: withdrawn ? now : nil, createdAt: date ?? now.addingTimeInterval(-60),
            activitySummary: activity.map { .init(id: $0, generation: generation, sequence: sequence,
                state: state, title: id, status: "Working") },
            interaction: request ? .init(id: "request-\(id)", kind: .approval, prompt: "Approve?",
                state: .pending, expiresAt: now.addingTimeInterval(3600)) : nil)
    }
    private func summary(_ items: [InboxItem], at date: Date? = nil) -> InboxTodaySummary {
        let attention = InboxAttentionProjection.make(items: items, now: date ?? now,
            acceptedNotificationIDs: [], queuedNotificationIDs: [])
        return .make(items: items, attention: attention, now: date ?? now, calendar: calendar)
    }

    @Test("Calendar boundaries, duplicates and withdrawals do not inflate notification totals")
    func counts() {
        let start = calendar.startOfDay(for: now)
        let current = item("current")
        let result = summary([current, current, item("midnight", date: start),
            item("yesterday", date: start.addingTimeInterval(-1)), item("future", date: now.addingTimeInterval(1)),
            item("removed", withdrawn: true)])
        #expect(result.notifications == 2)
        #expect(result.liveActivities == 0)
        #expect(result.active == 0)
        #expect(summary([current], at: calendar.dateInterval(of: .day, for: now)!.end).notifications == 0)
    }

    @Test("Activity updates count once per run; active includes work started yesterday and requests")
    func activities() {
        let start = calendar.startOfDay(for: now)
        let result = summary([
            item("update-one", activity: "build", sequence: 1),
            item("update-two", activity: "build", sequence: 2),
            item("restart", activity: "build", generation: 2),
            item("old-active", date: start.addingTimeInterval(-3600), activity: "old"),
            item("pending", activity: "review", request: true),
            item("finished", activity: "done", state: "ended")
        ])
        #expect(result.notifications == 0)
        #expect(result.liveActivities == 4)
        #expect(result.active == 3)
    }

    @Test("A running Live Activity counts toward today's total, never leaving a lone zero")
    func totalIncludesActivities() {
        let running = summary([item("run", activity: "build")])
        #expect(running.notifications == 0)
        #expect(running.liveActivities == 1)
        #expect(running.total == 1)
        #expect(running.finished == 0)
        let mixed = summary([item("n1"), item("n2"), item("a1", activity: "a"), item("a2", activity: "a", sequence: 2),
                             item("done", activity: "b", state: "ended"), item("live", activity: "c")])
        #expect(mixed.total == 5)
        #expect(mixed.liveActivities == 3)
        #expect(mixed.active == 2)
        #expect(mixed.finished == 1)
    }

    @Test("A busy day pages past the 250-event cache until today's range is covered")
    func coverage() {
        let todays = (0..<350).map { item("event-\($0)", date: now.addingTimeInterval(-Double($0))) }
        let firstPage = InboxHistorySnapshot(items: Array(todays.prefix(100)), cursor: "more", hasMore: true, total: 400, source: .server)
        #expect(InboxTodaySummary.needsMoreHistory(snapshot: firstPage,
            cachedItems: Array(todays.prefix(250)), now: now, calendar: calendar))
        let covered = InboxHistorySnapshot(items: todays + [item("yesterday", date: calendar.startOfDay(for: now).addingTimeInterval(-1))],
            cursor: "older", hasMore: true, total: 400, source: .server)
        #expect(!InboxTodaySummary.needsMoreHistory(snapshot: covered, cachedItems: [], now: now, calendar: calendar))
        #expect(summary(covered.items).notifications == 350)
        #expect(!InboxTodaySummary.needsMoreHistory(snapshot: firstPage,
            cachedItems: covered.items, now: now, calendar: calendar))
        let complete = InboxHistorySnapshot(items: todays, cursor: nil, hasMore: false, total: 350, source: .server)
        #expect(!InboxTodaySummary.needsMoreHistory(snapshot: complete, cachedItems: [], now: now, calendar: calendar))
    }

    @Test("Today follows a 23-hour daylight-saving calendar day")
    func daylightSaving() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York")!
        let now = ISO8601DateFormatter().date(from: "2026-03-08T20:00:00Z")!
        let day = calendar.dateInterval(of: .day, for: now)!
        #expect(day.duration == 23 * 3600)
        let items = [item("start", date: day.start), item("previous", date: day.start.addingTimeInterval(-1))]
        let attention = InboxAttentionProjection.make(items: items, now: now, acceptedNotificationIDs: [], queuedNotificationIDs: [])
        #expect(InboxTodaySummary.make(items: items, attention: attention, now: now, calendar: calendar).notifications == 1)
    }
}
