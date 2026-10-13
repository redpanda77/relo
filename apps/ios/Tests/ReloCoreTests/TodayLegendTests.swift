import Foundation
@testable import ReloCore
import Testing

@Suite("Today legend")
struct TodayLegendTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func row(_ id: String, kind: InboxItem.Kind, activity: InboxCardDigest? = nil) -> HistoryRow {
        HistoryRowProjection.row(InboxItem(id: id, kind: kind, sourceName: "A", title: id, createdAt: now,
                                           activity: activity), now: now)
    }

    @Test func countsOnlyMeaningsPresent() {
        let done = { (id: String) in
            row(id, kind: .liveActivity, activity: .init(state: "ended", outcome: "completed", updates: 1, startedAt: now))
        }
        let rows = [done("ntf_a"), done("ntf_b"), row("ntf_m", kind: .notification)]
        let legend = TodayActivity.make(rows: rows, now: now, calendar: .current).legend
        #expect(legend.map(\.signal) == [.done, .message])
        #expect(legend.map(\.count) == [2, 1])
        #expect(legend.map(\.text) == ["2 done", "1 message"])
    }

    @Test func emptyDayHasNoLegend() {
        #expect(TodayActivity.make(rows: [], now: now).legend.isEmpty)
        #expect(TodayActivity.make(rows: [], now: now).legendSpoken == "")
    }
}

@Suite("Quiet label")
struct QuietLabelTests {
    @Test func formatsMinutesAndHours() {
        #expect(LiveNowProjection.Card.quietLabel(25 * 60) == "25M")
        #expect(LiveNowProjection.Card.quietLabel(2 * 3600 + 5 * 60) == "2H 5M")
        #expect(LiveNowProjection.Card.quietLabel(3 * 3600) == "3H")
    }
}
