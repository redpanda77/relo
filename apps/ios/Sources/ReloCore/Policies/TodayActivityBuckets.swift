import Foundation

/// Today's work by hour, for the Now tab's activity strip and log.
public struct TodayActivity: Equatable, Sendable {
    /// Items per hour of the day (24 entries, index = hour).
    public let totals: [Int]
    /// Of those, how many finished successfully.
    public let done: [Int]
    /// Hour of `now`, the strip's marker.
    public let currentHour: Int
    /// Today's rows, newest first.
    public let rows: [HistoryRow]

    public var isEmpty: Bool { rows.isEmpty }
    public var maxTotal: Int { totals.max() ?? 0 }

    public static func make(rows: [HistoryRow], now: Date, calendar: Calendar = .current) -> TodayActivity {
        let start = calendar.startOfDay(for: now)
        let today = rows.filter { $0.at >= start && $0.at <= now.addingTimeInterval(60) }
            .sorted { $0.at > $1.at }
        var totals = Array(repeating: 0, count: 24)
        var done = Array(repeating: 0, count: 24)
        for row in today {
            let hour = min(23, max(0, calendar.component(.hour, from: row.at)))
            totals[hour] += 1
            if row.outcome == .done { done[hour] += 1 }
        }
        return TodayActivity(totals: totals, done: done,
                             currentHour: calendar.component(.hour, from: now), rows: today)
    }
}
