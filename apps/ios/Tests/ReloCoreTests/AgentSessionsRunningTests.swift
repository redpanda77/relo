import Foundation
import XCTest
@testable import ReloCore

/// The counting rules behind the Now HUD's AGENTS and RUNNING readouts and the Agents section.
final class AgentSessionsRunningTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func session(_ id: String, _ presence: AgentSession.Presence, state: String = "active",
                         card: String? = nil, eventAgo: TimeInterval = 60) -> AgentSession {
        AgentSession(id: id, harness: "claude-code", computer: "Studio Mac", account: "Work", project: "relo",
                     state: state, startedAt: now.addingTimeInterval(-3_600),
                     lastEventAt: now.addingTimeInterval(-eventAgo),
                     card: card.map { .init(id: $0, state: "active", quietForSeconds: 0) }, presence: presence)
    }

    func testOnlyActiveLiveSessionsAreRunning() {
        XCTAssertTrue(AgentSessionsProjection.isRunning(session("w", .working)))
        XCTAssertTrue(AgentSessionsProjection.isRunning(session("q", .quiet)))
        XCTAssertTrue(AgentSessionsProjection.isRunning(session("n", .noCard)))
        XCTAssertFalse(AgentSessionsProjection.isRunning(session("i", .noCard, state: "idle")))
        XCTAssertFalse(AgentSessionsProjection.isRunning(session("iw", .working, state: "idle")))
        XCTAssertFalse(AgentSessionsProjection.isRunning(session("e", .ended, state: "ended")))
        XCTAssertFalse(AgentSessionsProjection.isRunning(session("l", .lost)))
        XCTAssertFalse(AgentSessionsProjection.isRunning(session("u", .noCard, state: "something-new")))
    }

    func testRunningCountIgnoresIdleEndedAndLostAndCountsAgentsWithCards() {
        let sessions = [
            session("a", .working, card: "act_1"), session("b", .quiet, card: "act_2"),
            session("c", .noCard), session("d", .noCard), session("e", .noCard, state: "idle"),
            session("f", .working, state: "idle", card: "act_3"), session("g", .ended, state: "ended"),
            session("h", .lost),
        ]
        XCTAssertEqual(AgentSessionsProjection.runningCount(sessions), 4)
        XCTAssertEqual(AgentSessionsProjection.runningCount([]), 0)
    }

    func testIdleSessionsSortAfterRunningOnesAndBeforeEnded() {
        let sessions = [
            session("ended", .ended, state: "ended", eventAgo: 30), session("idle", .noCard, state: "idle", eventAgo: 5),
            session("nocard", .noCard, eventAgo: 600), session("working", .working, eventAgo: 900),
            session("lost", .lost, eventAgo: 20),
        ]
        XCTAssertEqual(AgentSessionsProjection.visible(sessions, now: now).map(\.id),
                       ["working", "nocard", "idle", "ended", "lost"])
    }

    func testStatusPhrases() {
        let phrase = { AgentSessionsProjection.statusPhrase($0, fetchedAt: self.now, now: self.now) }
        XCTAssertEqual(phrase(session("i", .noCard, state: "idle")), "idle, waiting for you")
        XCTAssertEqual(phrase(session("iw", .working, state: "idle", card: "act_1")), "idle, waiting for you")
        XCTAssertEqual(phrase(session("n", .noCard)), "running, no card")
        XCTAssertEqual(phrase(session("w", .working, card: "act_1")), "working")
        XCTAssertEqual(phrase(session("e", .ended, state: "ended")), "ended")
        XCTAssertEqual(phrase(session("l", .lost)), "lost contact")
    }

    func testASilentLiveSessionSettlesToLostByItsStatesThreshold() {
        let working = session("w", .working, card: "act_1", eventAgo: AgentSessionsProjection.activeLostAfter + 60)
        let idle = session("i", .noCard, state: "idle", eventAgo: AgentSessionsProjection.activeLostAfter + 60)
        let longIdle = session("z", .noCard, state: "idle", eventAgo: AgentSessionsProjection.idleLostAfter + 60)
        let fresh = session("f", .working, eventAgo: 30)
        let settled = AgentSessionsProjection.settled([working, idle, longIdle, fresh], now: now)
        XCTAssertEqual(settled.map(\.presence), [.lost, .noCard, .lost, .working])
        XCTAssertEqual(settled[0].state, "lost")
        XCTAssertEqual(settled[0].card?.id, "act_1", "the card link survives")
        XCTAssertEqual(settled[0].project, "relo", "the names survive")
        XCTAssertEqual(AgentSessionsProjection.runningCount(settled), 1)
        XCTAssertEqual(AgentSessionsProjection.idleCount(settled), 1)
    }

    func testAToolEventNeverMovesARow() {
        let older = AgentSession(id: "a", harness: "claude-code", project: "relo", startedAt: now.addingTimeInterval(-7_200),
                                 lastEventAt: now, presence: .working)
        let newer = AgentSession(id: "b", harness: "claude-code", project: "relo", startedAt: now.addingTimeInterval(-600),
                                 lastEventAt: now.addingTimeInterval(-300), presence: .working)
        XCTAssertEqual(AgentSessionsProjection.visible([older, newer], now: now).map(\.id), ["b", "a"])
    }
}
