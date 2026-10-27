import Foundation
@testable import ReloCore
import Testing

@Suite("History rows say where, what, how it went and what it took")
struct HistoryRowProjectionTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func decode(_ rows: [[String: Any]]) throws -> [InboxItem] {
        let body: [String: Any] = ["items": rows, "total": rows.count, "serverTime": "2026-10-06T23:00:00Z",
                                   "unread": ["account": 0, "projects": [String: Int]()]]
        return try ReloWireJSON.decoder().decode(InboxRepairResponse.self, from: JSONSerialization.data(withJSONObject: body))
            .snapshot(syncedAt: now).items
    }

    private func cardEvent(_ id: String, card: String, sequence: Int, topic: String, activity: [String: Any],
                           interaction: [String: Any]? = nil) -> [String: Any] {
        var row: [String: Any] = [
            "id": id, "kind": "live_activity", "sourceName": "Claude Code", "title": "Release", "privacy": "standard",
            "createdAt": "2026-10-06T21:0\(sequence):00Z", "updatedAt": "2026-10-06T21:0\(sequence):00Z",
            "contentSummary": ["summary": "", "format": "text", "byteLength": 0],
            "context": ["providerName": "Claude Code", "project": "relo", "threadName": topic],
            "activityEvent": ["id": card, "operation": "update", "generation": 1, "sequence": sequence],
            "activity": activity]
        if let interaction { row["interaction"] = interaction }
        return row
    }

    @Test func aFinishedCardShowsItsResultStepsCountsAndDuration() throws {
        let activity: [String: Any] = ["state": "ended", "outcome": "completed", "status": "Shipped", "progress": 1,
            "steps": ["done": 3, "total": 3], "updates": 6,
            "startedAt": "2026-10-06T21:00:00Z", "endedAt": "2026-10-06T21:34:00Z"]
        let ask: [String: Any] = ["id": "int_ask", "kind": "approval", "prompt": "Ship now?", "state": "approved",
                                  "expiresAt": "2026-10-06T21:10:00Z", "respondedAt": "2026-10-06T21:03:00Z"]
        let items = try decode([
            cardEvent("ntf_end", card: "act_one", sequence: 5, topic: "Release", activity: activity),
            cardEvent("ntf_ask", card: "act_one", sequence: 3, topic: "Release", activity: activity, interaction: ask),
        ])
        let collapsed = InboxHistoryProjection.collapsedActivities(items)
        #expect(collapsed.map(\.id) == ["ntf_end"])
        let row = try #require(HistoryRowProjection.rows(collapsed, events: items, now: now).first)
        #expect(row.outcome == .done)
        #expect(row.summary == "Shipped")
        #expect(row.type == "Live Activity")
        #expect(row.source.name == "Claude Code")
        #expect(row.project?.name == "relo")
        #expect(row.topic == nil, "a topic that repeats the title is noise")
        #expect(row.steps == .init(done: 3, total: 3, current: nil))
        #expect(row.progress == nil, "steps already show the progress")
        #expect(row.updates == 6)
        #expect(row.duration == TimeInterval(34 * 60))
        #expect(row.decision?.prompt == "Ship now?")
        #expect(row.decision?.answer == "You approved")
    }

    @Test func aStoppedCardSaysWhereItStoppedAndARunningOneHasNoDuration() throws {
        let stopped = try decode([cardEvent("ntf_stop", card: "act_two", sequence: 2, topic: "Nightly build", activity: [
            "state": "ended", "outcome": "failed", "status": "Tests failed", "steps": ["done": 1, "total": 3, "current": "Test"],
            "updates": 3, "startedAt": "2026-10-06T21:00:00Z", "endedAt": "2026-10-06T21:05:00Z"])])
        let row = HistoryRowProjection.row(stopped[0], now: now)
        #expect(row.outcome == .stopped)
        #expect(row.topic == "Nightly build")
        #expect(row.steps?.current == "Test")

        let running = try decode([cardEvent("ntf_run", card: "act_three", sequence: 1, topic: "Deploy", activity: [
            "state": "active", "status": "Building", "progress": 0.4, "updates": 2, "startedAt": "2026-10-06T21:00:00Z"])])
        let live = HistoryRowProjection.row(running[0], now: now)
        #expect(live.outcome == .running)
        #expect(live.duration == nil)
        #expect(live.progress == 0.4)
    }

    @Test func messagesAndQuestionsSayWhatTheyAre() {
        let message = InboxItem(id: "ntf_msg", kind: .notification, sourceName: "Deploy bot", title: "Deployed",
                                detail: "0.9.9 is live", createdAt: now)
        let messageRow = HistoryRowProjection.row(message, now: now)
        #expect(messageRow.outcome == .message)
        #expect(messageRow.type == "Message")
        #expect(messageRow.summary == "0.9.9 is live")

        let question = InboxItem(id: "ntf_q", kind: .notification, sourceName: "Claude Code", title: "Migrate?",
            createdAt: now, interaction: InboxInteraction(id: "int_q", kind: .yesNo, prompt: "Run the migration?",
                                                          state: .pending, expiresAt: now.addingTimeInterval(60)))
        let questionRow = HistoryRowProjection.row(question, now: now)
        #expect(questionRow.outcome == .waitingForYou)
        #expect(questionRow.type == "Question")
        #expect(HistoryRowProjection.row(question, now: now.addingTimeInterval(120)).outcome == .unanswered)
        #expect(HistoryRowProjection.daySummary([questionRow, messageRow]) == "1 need you · 1 message")
    }

    @Test func aRoundShowsOnceAsItsCardNotAlsoAsItsOutcomeMessage() throws {
        let done: [String: Any] = ["state": "ended", "outcome": "completed", "status": "Released", "updates": 2,
                                   "startedAt": "2026-10-06T21:00:00Z", "endedAt": "2026-10-06T21:04:00Z"]
        let outcome: [String: Any] = ["id": "ntf_outcome", "kind": "notification", "sourceName": "Claude Code",
            "title": "Ship works", "privacy": "standard", "createdAt": "2026-10-06T21:05:00Z", "updatedAt": "2026-10-06T21:05:00Z",
            "contentSummary": ["summary": "", "format": "text", "byteLength": 0], "outcomeOf": "act_one"]
        var orphan = outcome
        orphan["id"] = "ntf_orphan"; orphan["outcomeOf"] = "act_gone"
        let items = try decode([cardEvent("ntf_end", card: "act_one", sequence: 4, topic: "Release", activity: done), outcome, orphan])
        #expect(items.first { $0.id == "ntf_outcome" }?.outcomeOf == "act_one")
        #expect(InboxHistoryProjection.readable(items).map(\.id).sorted() == ["ntf_end", "ntf_orphan"],
                "the message stays when its card is not loaded")
    }

    @Test func aLaterRoundIsTitledByItsRequestAndTheFirstByTheGoal() {
        var work = ReloWork(id: "wrk_1")
        work.phases = [.init(id: "r1", title: "Ship works", outcome: "Built", state: .done),
                       .init(id: "r2", title: "Push and release", outcome: "Released", state: .done),
                       .init(id: "r3", title: "Polish", state: .current)]
        #expect(HistoryRowProjection.round(of: work) == .init(n: 2, title: "Push and release"))
        work.phases = [.init(id: "r1", title: "Ship works", state: .current)]
        #expect(HistoryRowProjection.round(of: work) == .init(n: 1, title: "Ship works"))
        work.phases = [.init(id: "build", title: "Build", state: .done)]
        #expect(HistoryRowProjection.round(of: work) == nil, "only rounds (r<n>) count")
    }

    @Test func aQuietHourOrMoreIsMarkedOnTheRail() {
        let newer = now
        #expect(HistoryTimeline.quietGap(newer: newer, older: newer.addingTimeInterval(-59 * 60)) == nil)
        #expect(HistoryTimeline.quietGap(newer: newer, older: newer.addingTimeInterval(-(3 * 3600 + 45 * 60))) == "3h 45m quiet")
    }

    @Test func aDayCountsItsSettledRowsByMeaningInDisplayOrder() throws {
        let stopped: [String: Any] = ["state": "ended", "outcome": "failed", "status": "Tests failed", "updates": 1,
                                      "startedAt": "2026-10-06T21:00:00Z", "endedAt": "2026-10-06T21:02:00Z"]
        let done: [String: Any] = ["state": "ended", "outcome": "completed", "status": "Shipped", "updates": 1,
                                   "startedAt": "2026-10-06T21:00:00Z", "endedAt": "2026-10-06T21:03:00Z"]
        let items = try decode([cardEvent("ntf_a", card: "act_a", sequence: 1, topic: "A", activity: stopped),
                                cardEvent("ntf_b", card: "act_b", sequence: 2, topic: "B", activity: done),
                                cardEvent("ntf_c", card: "act_c", sequence: 3, topic: "C", activity: done)])
        let rows = HistoryRowProjection.rows(items, events: items, now: now)
        #expect(HistoryTimeline.counts(rows) == [.init(signal: .done, count: 2), .init(signal: .failed, count: 1)])
        #expect(HistoryTimeline.countLabel(.failed, count: 1) == "Stopped")
        let day = HistoryTimeline.activity(rows, on: rows[0].at, now: rows[0].at.addingTimeInterval(3 * 86_400))
        #expect(day.rows.count == 3, "an earlier day runs to its end")
    }
}
