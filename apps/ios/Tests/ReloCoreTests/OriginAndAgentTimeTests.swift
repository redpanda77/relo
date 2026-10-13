import Foundation
@testable import ReloCore
import Testing

@Suite("Cards say which computer and account they came from, and how long agents ran")
struct OriginAndAgentTimeTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func originLabelJoinsComputerAndAccountAndIgnoresBlanks() {
        #expect(InboxContext(computer: "MacBook Pro", account: "Work").originLabel == "MacBook Pro · Work")
        #expect(InboxContext(computer: " MacBook Pro ").originLabel == "MacBook Pro")
        #expect(InboxContext(computer: "  ", account: "Work").originLabel == "Work")
        #expect(InboxContext(computer: "", account: "\n").originLabel == nil)
        #expect(InboxContext().originLabel == nil)
    }

    @Test func contextDecodesAccountWhenPresentAndToleratesItsAbsence() throws {
        let decoder = JSONDecoder()
        let with = try decoder.decode(InboxContext.self, from: Data(#"{"computer":"Mac mini","account":"Personal"}"#.utf8))
        #expect(with.account == "Personal")
        #expect(with.originLabel == "Mac mini · Personal")
        let without = try decoder.decode(InboxContext.self, from: Data(#"{"computer":"Mac mini"}"#.utf8))
        #expect(without.account == nil)
        #expect(without.originLabel == "Mac mini")
    }

    private func card(_ id: String, context: InboxContext?, state: String = "ended", started: TimeInterval,
                      ended: TimeInterval?, at: Date? = nil) -> HistoryRow {
        let digest = InboxCardDigest(state: state, outcome: state == "ended" ? "completed" : nil, updates: 2,
                                     startedAt: now.addingTimeInterval(started),
                                     endedAt: ended.map { now.addingTimeInterval($0) })
        let item = InboxItem(id: id, kind: .liveActivity, sourceName: "Claude Code", title: id,
                             createdAt: at ?? now, context: context, activity: digest)
        return HistoryRowProjection.row(item, now: now)
    }

    @Test func rowsCarryTheirOriginAndFilterByIt() {
        let work = card("a", context: InboxContext(computer: "MacBook Pro", account: "Work"), started: -600, ended: -300)
        let work2 = card("b", context: InboxContext(computer: "MacBook Pro", account: "Work"), started: -600, ended: -300)
        let box = card("c", context: InboxContext(computer: "Mac mini"), started: -600, ended: -300)
        let none = card("d", context: nil, started: -600, ended: -300)
        let rows = [work, box, work2, none]
        #expect(work.origin == "MacBook Pro · Work")
        #expect(none.origin == nil)
        #expect(HistoryRowProjection.origins(rows) == ["MacBook Pro · Work", "Mac mini"])
        #expect(HistoryRowProjection.filter(rows, origin: "Mac mini").map(\.id) == ["c"])
        #expect(HistoryRowProjection.filter(rows, origin: nil).count == 4)
        #expect(HistoryRowProjection.origins([none]).isEmpty)
    }

    @Test func agentTimeSumsEndedCardsAndRunningOnesUntilNow() {
        let ended = card("a", context: nil, started: -3600, ended: -1800) // 30m
        let running = card("b", context: nil, state: "active", started: -900, ended: nil) // 15m
        let expired = card("c", context: nil, state: "expired", started: -900, ended: nil) // no end: nothing
        let message = HistoryRowProjection.row(InboxItem(id: "m", kind: .notification, sourceName: "x", title: "m", createdAt: now), now: now)
        let total = HistoryRowProjection.agentTime([ended, running, expired, message], now: now)
        #expect(total == 45 * 60)
        #expect(HistoryRowProjection.agentTimeLabel(total) == "45m")
        #expect(HistoryRowProjection.agentTimeLabel(4 * 3600 + 12 * 60 + 5) == "4h 12m")
        #expect(HistoryRowProjection.agentTimeLabel(2 * 3600) == "2h")
        #expect(HistoryRowProjection.agentTimeLabel(40) == nil)
    }

    @Test func daySummaryAppendsAgentTimeOnlyWhenAsked() {
        let ended = card("a", context: nil, started: -7200, ended: -3600)
        #expect(HistoryRowProjection.daySummary([ended]) == "1 done")
        #expect(HistoryRowProjection.daySummary([ended], now: now) == "1 done · 1h agent time")
    }

    @Test func todaysAgentTimeIgnoresOtherDays() {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let today = card("a", context: nil, started: -1800, ended: -600, at: now)
        let old = card("b", context: nil, started: -1800, ended: -600, at: now.addingTimeInterval(-3 * 86_400))
        #expect(HistoryRowProjection.agentTimeToday([today, old], now: now, calendar: calendar) == 20 * 60)
    }
}
