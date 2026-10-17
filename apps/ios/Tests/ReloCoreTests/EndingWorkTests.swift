import Foundation
import Testing
@testable import ReloCore

struct EndingWorkTests {
    private let locale = Locale(identifier: "en_US")
    private let utc = TimeZone(identifier: "UTC")!
    /// 3:12 PM UTC.
    private let since = ISO8601DateFormatter().date(from: "2026-10-16T15:12:00Z")!

    @Test func absenceDecodesAndIsWorded() throws {
        let value = try item("")
        #expect(value.owner.absence == nil)
        let json = """
        {"state":"stale","evidenceAt":"2026-10-16T14:30:00.000Z","evidenceSource":"declared","staleDate":"2026-10-16T14:50:00.000Z",
         "lockScreen":"dimmed","relevance":0,"apnsPriority":5,
         "absence":{"reason":"computer_offline","since":"2026-10-16T15:12:00.000Z"}}
        """
        let owner = try ReloWireJSON.decoder().decode(OwnerStateResult.self, from: Data(json.utf8))
        let absence = try #require(owner.absence)
        let offline = AbsenceWording.line(absence, computer: "Mac", locale: locale, timeZone: utc)
        #expect(offline?.hasPrefix("Mac offline since 3:12") == true && offline?.hasSuffix("PM") == true)
        let noUpdate = AbsenceWording.line(Absence(reason: .noUpdate, since: since), locale: locale, timeZone: utc)
        #expect(noUpdate?.hasPrefix("No update since 3:12") == true)
        #expect(AbsenceWording.line(Absence(reason: .sessionEnded, since: since)) == "Session ended")
        #expect(AbsenceWording.line(Absence(reason: .unknown("x"), since: since)) == nil)
    }

    private func item(_ extra: String, state: String = "stale") throws -> NowItem {
        let json = """
        {"id":"act_1","title":"Fix the login crash","producer":"agent_session",
         "startedAt":"2026-10-16T14:00:00.000Z","declaredAt":"2026-10-16T14:30:00.000Z",
         "owner":{"state":"\(state)","evidenceAt":"2026-10-16T14:30:00.000Z","evidenceSource":"declared",
                  "staleDate":"2026-10-16T14:50:00.000Z","lockScreen":"dimmed","relevance":0,"apnsPriority":5}\(extra)}
        """
        return try ReloWireJSON.decoder().decode(NowItem.self, from: Data(json.utf8))
    }

    @Test func quietReasonAndSinceDecode() throws {
        let value = try item(#","quietReason":"session_idle","quietSince":"2026-10-16T15:12:00.000Z""#)
        #expect(value.quietReason == .sessionIdle)
        #expect(value.quietSince == ISO8601DateFormatter().date(from: "2026-10-16T15:12:00Z"))
        #expect(try item(#","quietReason":"session_ended""#).quietReason == .sessionEnded)
        #expect(try item(#","quietReason":"no_update""#).quietReason == .noUpdate)
    }

    @Test func quietFieldsOnTheOwnerObjectAreRead() throws {
        // The server puts quietReason and quietSince on `owner` (owner-state derivation).
        let json = """
        {"id":"act_1","title":"Fix the login crash","producer":"agent_session",
         "startedAt":"2026-10-16T14:00:00.000Z","declaredAt":"2026-10-16T14:30:00.000Z",
         "owner":{"state":"stale","evidenceAt":"2026-10-16T14:30:00.000Z","evidenceSource":"declared",
                  "staleDate":"2026-10-16T14:50:00.000Z","lockScreen":"dimmed","relevance":0,"apnsPriority":5,
                  "quietReason":"session_ended","quietSince":"2026-10-16T15:12:00.000Z"}}
        """
        let value = try ReloWireJSON.decoder().decode(NowItem.self, from: Data(json.utf8))
        #expect(value.quietWhy == .sessionEnded)
        #expect(value.quietFrom != nil)
    }

    @Test func missingOrUnknownQuietFieldsAreTolerated() throws {
        let older = try item("")
        #expect(older.quietReason == nil && older.quietSince == nil)
        let future = try item(#","quietReason":"battery_low""#)
        #expect(future.quietReason == .unknown("battery_low"))
        // Unknown reason: the caller keeps its own words.
        #expect(future.quietLine(locale: locale, timeZone: utc) == nil)
    }

    @Test func wordingPerReason() {
        #expect(QuietWording.line(reason: .sessionIdle, since: since, locale: locale, timeZone: utc)?.hasPrefix("Session idle since 3:12") == true)
        #expect(QuietWording.line(reason: .sessionEnded, since: since, locale: locale, timeZone: utc)?.hasPrefix("Session ended at 3:12") == true)
        #expect(QuietWording.line(reason: .noUpdate, since: since, locale: locale, timeZone: utc)?.hasPrefix("No update since 3:12") == true)
        #expect(QuietWording.line(reason: .sessionIdle, since: since, locale: locale, timeZone: utc)?.hasSuffix("PM") == true)
        #expect(QuietWording.line(reason: nil, since: since, locale: locale, timeZone: utc) == nil)
        // The user's locale short time style.
        let german = QuietWording.line(reason: .sessionIdle, since: since, locale: Locale(identifier: "de_DE"), timeZone: utc)
        #expect(german == "Session idle since 15:12")
    }

    @Test func quietLineOnlyForQuietWorkFallsBackToEvidenceTime() throws {
        let quiet = try item(#","quietReason":"no_update""#)
        #expect(quiet.quietLine(locale: locale, timeZone: utc)?.hasPrefix("No update since 2:30") == true)
        // A moving work never reads as quiet, whatever the server sent.
        let moving = try item(#","quietReason":"no_update""#, state: "moving")
        #expect(moving.quietLine(locale: locale, timeZone: utc) == nil)
    }

    @Test func endIsOfferedOnlyForQuietPausedAndYourTurn() {
        let offered: [OwnerState] = [.stale, .stoppedResponding, .noSignal, .paused, .waitingOnYou]
        let withheld: [OwnerState] = [.moving, .workingQuietly, .needsYou, .done, .failed, .dropped, .leftUnfinished, .unknown("x")]
        for state in offered { #expect(WorkEnding.isOffered(for: state), "\(state)") }
        for state in withheld { #expect(!WorkEnding.isOffered(for: state), "\(state)") }
    }

    @Test func confirmationWords() {
        #expect(WorkEnding.confirmationTitle(goal: "Fix the login crash") == "End \"Fix the login crash\"?")
        #expect(WorkEnding.confirmationMessage == "It moves to History as ended by you. The agent's session keeps running.")
    }

    @Test func removingAWorkDropsItFromEveryList() throws {
        let data = try Data(contentsOf: #require(Bundle.module.url(forResource: "owner-state-v1", withExtension: "json")))
        struct Fixture: Decodable { let nowSummary: NowSummary }
        let summary = try ReloWireJSON.decoder().decode(Fixture.self, from: data).nowSummary
        let id = try #require(summary.allItems.first?.id)
        #expect(summary.removingWork(id).item(id: id) == nil)
        #expect(summary.removingWork(id).allItems.count < summary.allItems.count)
    }
}
