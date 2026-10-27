import Foundation
import ReloCore
import Testing
@testable import ReloNotchKit

/// The notch expands for the same changes a Live Activity update shows: these pin which ones.
struct NotchEventsTests {
    private func summary() throws -> NowSummary {
        struct Fixture: Decodable { let nowSummary: NowSummary }
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../ios/Tests/ReloCoreTests/Fixtures/owner-state-v1.json").standardizedFileURL
        return try ReloWireJSON.decoder().decode(Fixture.self, from: Data(contentsOf: url)).nowSummary
    }

    private func pendingQuestion(_ id: String) throws -> NowItem.Question {
        try ReloWireJSON.decoder().decode(NowItem.Question.self, from: Data(
            #"{"id":"\#(id)","standing":"pending","askedAt":"2026-10-14T09:58:00.000Z"}"#.utf8))
    }

    @Test func theFirstSummaryOnlyAnnouncesQuestionsAlreadyWaiting() throws {
        var now = try summary()
        #expect(NotchEvent.between(nil, NotchPresentation(summary: now)).isEmpty)
        now.needsYou[0].question = try pendingQuestion("int_1")
        #expect(NotchEvent.between(nil, NotchPresentation(summary: now)).map(\.kind) == [.question])
    }

    @Test func anUnchangedSummaryAnnouncesNothing() throws {
        let now = NotchPresentation(summary: try summary())
        #expect(NotchEvent.between(now, now).isEmpty)
    }

    @Test func newWorkStartsAndFinishedOrFailedWorkIsAnnounced() throws {
        let before = try summary()
        var after = before
        var started = before.running[0]
        started.id = "act_new"
        after.running.append(started)
        var finished = before.running[0]
        finished.owner.state = .done
        after.running.removeFirst()
        after.recent.insert(finished, at: 0)
        let events = NotchEvent.between(NotchPresentation(summary: before), NotchPresentation(summary: after))
        #expect(events.map(\.kind) == [.finished, .started])
        #expect(events.first?.row.id == before.running[0].id)
    }

    @Test func aNewQuestionLeadsEvenOnAWorkAlreadyShown() throws {
        var before = try summary()
        before.needsYou[0].question = try pendingQuestion("int_1")
        var after = before
        after.needsYou[0].question = try pendingQuestion("int_2")
        after.recent[0].owner.state = .failed
        let events = NotchEvent.between(NotchPresentation(summary: before), NotchPresentation(summary: after))
        #expect(events.map(\.kind) == [.question])
    }

    @Test func progressAndStatusChangesUpdateInPlace() throws {
        let before = try summary()
        var after = before
        after.running[0].status = "Halfway"
        after.running[0].steps?.done = 2
        #expect(NotchEvent.between(NotchPresentation(summary: before), NotchPresentation(summary: after)).isEmpty)
    }

    @Test func workThatMovesAgainAfterAPauseStarts() throws {
        var before = try summary()
        var paused = before.running.removeFirst()
        paused.owner.state = .paused
        before.paused = [paused]
        let after = try summary()
        #expect(NotchEvent.between(NotchPresentation(summary: before), NotchPresentation(summary: after)).map(\.kind) == [.started])
    }

    private func present(_ summary: NowSummary) -> NotchPresentation { NotchPresentation(summary: summary) }

    /// A running work that became left unfinished, in Recent.
    private func stopped(level: String?) throws -> (before: NowSummary, after: NowSummary) {
        let before = try summary()
        var after = before
        var item = after.running.removeFirst()
        item.owner.state = .leftUnfinished
        item.owner.interruptionLevel = level
        after.recent.insert(item, at: 0)
        return (before, after)
    }

    @Test func workLeftUnfinishedByTimeAloneIsSilent() throws {
        let (before, after) = try stopped(level: nil)
        #expect(NotchEvent.between(present(before), present(after), summary: after).isEmpty)
        // Without the server's summary the Mac cannot tell, so it stays silent too.
        #expect(NotchEvent.between(present(before), present(after)).isEmpty)
    }

    @Test func workStoppedWithAnInterruptionLevelIsAnnounced() throws {
        let (before, after) = try stopped(level: "active")
        let events = NotchEvent.between(present(before), present(after), summary: after)
        #expect(events.map(\.kind) == [.failed])
        #expect(events.first?.facts?.interruptionLevel == "active")
    }

    @Test func aPermissionPromptWithoutAQuestionIsAMomentLikeAQuestion() throws {
        let before = try summary()
        var after = before
        var item = after.running.removeFirst()
        item.owner.state = .needsYou
        item.owner.needsYou = .permission
        item.owner.interruptionLevel = "time-sensitive"
        item.question = nil
        after.needsYou.append(item)
        let events = NotchEvent.between(present(before), present(after), summary: after)
        #expect(events.map(\.kind) == [.question])
        #expect(events.first?.row.questionPending == false)
        // Already needing the owner: no second moment.
        #expect(NotchEvent.between(present(after), present(after), summary: after).isEmpty)
    }

    @Test func aMissedQuestionIsNotAMoment() throws {
        let before = try summary()
        var after = before
        var item = after.running.removeFirst()
        item.owner.state = .needsYou
        item.owner.needsYou = .missedQuestion
        item.question = try ReloWireJSON.decoder().decode(NowItem.Question.self, from: Data(
            #"{"id":"int_9","standing":"missed","askedAt":"2026-10-14T09:58:00.000Z"}"#.utf8))
        after.needsYou.append(item)
        #expect(NotchEvent.between(present(before), present(after), summary: after).isEmpty)
    }

    @Test func aLaterRoundHasItsOwnMomentKey() throws {
        var first = try summary()
        first.waitingOnYou[0].roundNumber = 1
        var second = first
        second.waitingOnYou[0].roundNumber = 2
        var working = try summary()
        working.waitingOnYou = []
        let a = NotchEvent.between(present(working), present(first), summary: first)
        let b = NotchEvent.between(present(working), present(second), summary: second)
        let turnA = try #require(a.first { $0.kind == .yourTurn })
        let turnB = try #require(b.first { $0.kind == .yourTurn })
        #expect(turnA.momentKey != turnB.momentKey)
        #expect(turnA.momentKey == a.first { $0.kind == .yourTurn }?.momentKey)
    }

    @Test func withoutARoundTheEvidenceTimeSeparatesMoments() throws {
        var first = try summary()
        first.waitingOnYou[0].roundNumber = nil
        var second = first
        second.waitingOnYou[0].owner.evidenceAt = first.waitingOnYou[0].owner.evidenceAt.addingTimeInterval(600)
        var working = try summary()
        working.waitingOnYou = []
        let a = try #require(NotchEvent.between(present(working), present(first), summary: first).first { $0.kind == .yourTurn })
        let b = try #require(NotchEvent.between(present(working), present(second), summary: second).first { $0.kind == .yourTurn })
        #expect(a.momentKey != b.momentKey)
    }

    @Test func eventsOlderThanThePreviousSummaryAreNotAnnounced() throws {
        let before = try summary()
        var after = before
        var finished = before.running[0]
        finished.owner.state = .done
        finished.owner.evidenceAt = before.serverTime.addingTimeInterval(-3600)
        after.running.removeFirst()
        after.recent.insert(finished, at: 0)
        #expect(NotchEvent.between(present(before), present(after), summary: after, previousServerTime: before.serverTime).isEmpty)
        // Fresh evidence still announces, and carries its age for the voice queue.
        after.recent[0].owner.evidenceAt = before.serverTime.addingTimeInterval(5)
        after.serverTime = before.serverTime.addingTimeInterval(12)
        let events = NotchEvent.between(present(before), present(after), summary: after, previousServerTime: before.serverTime)
        #expect(events.map(\.kind) == [.finished])
        #expect(events.first?.facts?.age == 7)
    }

    @Test func aQuietWorkCarriesTheServersOwnWords() throws {
        let before = try summary()
        var after = before
        var item = after.running.removeFirst()
        item.owner.state = .stale
        item.owner.quietReason = .sessionIdle
        item.owner.quietSince = Date(timeIntervalSince1970: 1_792_000_000)
        after.quiet.append(item)
        let facts = NotchEvent.Facts(item: try #require(after.item(id: item.id)), serverTime: after.serverTime,
                                     locale: Locale(identifier: "en_US"), timeZone: TimeZone(identifier: "UTC")!)
        #expect(facts.quietLine?.hasPrefix("Session idle since") == true)
    }
}
