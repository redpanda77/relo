import Foundation
import Testing
@testable import ReloCore

@Suite("Agent sessions")
struct AgentSessionsTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func session(_ id: String, _ presence: AgentSession.Presence, harness: String = "codex",
                         computer: String? = "MacBook Pro", account: String? = "Work",
                         eventAgo: TimeInterval = 60) -> AgentSession {
        AgentSession(id: id, harness: harness, computer: computer, account: account, project: "relo",
                     startedAt: now.addingTimeInterval(-3_600), lastEventAt: now.addingTimeInterval(-eventAgo),
                     presence: presence)
    }

    @Test func harnessNames() {
        #expect(AgentSessionsProjection.harnessName("claude-code") == "Claude Code")
        #expect(AgentSessionsProjection.harnessName("codex") == "Codex")
        #expect(AgentSessionsProjection.harnessName("opencode") == "OpenCode")
        #expect(AgentSessionsProjection.harnessName("gemini") == "Gemini CLI")
        #expect(AgentSessionsProjection.harnessName("cursor") == "Cursor")
        #expect(AgentSessionsProjection.harnessName("aider") == "aider")
    }

    @Test func ordersWorkingQuietNoCardThenRecentEndedAndDropsOld() {
        let sessions = [
            session("ended-old", .ended, eventAgo: 7_200), session("lost", .lost, eventAgo: 600),
            session("nocard", .noCard), session("quiet", .quiet, eventAgo: 900),
            session("working", .working), session("ended", .ended, eventAgo: 1_800),
        ]
        #expect(AgentSessionsProjection.visible(sessions, now: now).map(\.id)
                == ["working", "quiet", "nocard", "ended", "lost"])
    }

    @Test func groupsByComputerAndAccount() {
        let sessions = [
            session("a", .noCard, computer: "Mac mini", account: nil), session("b", .working),
            session("c", .quiet, eventAgo: 900), session("d", .working, computer: nil, account: nil),
        ]
        let groups = AgentSessionsProjection.groups(sessions, now: now)
        #expect(groups.map(\.title) == ["MacBook Pro · Work", "Unknown computer", "Mac mini"])
        #expect(groups[0].sessions.map(\.id) == ["b", "c"])
    }

    @Test func quietPhrase() {
        // lastEventAt is fresh (the agent keeps working); the card has been silent 10 min at fetch, fetched 4 min ago.
        let quiet = AgentSession(id: "q", harness: "codex", startedAt: now.addingTimeInterval(-3_600),
            lastEventAt: now.addingTimeInterval(-5), card: .init(id: "act_1", state: "active", quietForSeconds: 600),
            presence: .quiet)
        let fetched = now.addingTimeInterval(-240)
        #expect(AgentSessionsProjection.quietPhrase(quiet, fetchedAt: fetched, now: now) == "no update for 14 min")
        #expect(AgentSessionsProjection.durationPhrase(125 * 60) == "2 h 5 min")
    }

    private let sessionJSON = """
    {"id":"ags_11111111-2222-4333-8444-555555555555","harness":"codex","computer":"MacBook Pro","account":null,
     "project":"relo","state":"active","startedAt":"2026-10-13T10:00:00.123Z","lastEventAt":"2026-10-13T10:05:00Z",
     "card":{"id":"act_11111111-2222-4333-8444-555555555555","state":"active","quietForSeconds":300},"presence":"quiet"}
    """

    @Test func decodesSessionsOnTheSnapshotAndToleratesTheirAbsence() throws {
        func response(_ extra: String) throws -> InboxRepairResponse {
            let json = """
            {"items":[],"total":0,"serverTime":"2026-10-13T10:06:00Z","readWatermark":null,
             "unread":{"account":0,"projects":{}}\(extra)}
            """
            return try ReloWireJSON.decoder().decode(InboxRepairResponse.self, from: Data(json.utf8))
        }
        let with = try response(",\"sessions\":[\(sessionJSON)]")
        let decoded = try #require(with.sessions?.first)
        #expect(decoded.presence == .quiet && decoded.card?.quietForSeconds == 300 && decoded.account == nil)
        #expect(try with.snapshot(syncedAt: now).sessions == with.sessions)
        #expect(try response("").sessions == nil)
        #expect(try response("").snapshot(syncedAt: now).sessions == nil)
    }

    @Test func unknownPresenceReadsAsNoCardAndCacheRoundTrips() throws {
        let odd = sessionJSON.replacingOccurrences(of: "\"quiet\"}", with: "\"hovering\"}")
        let decoded = try ReloWireJSON.decoder().decode(AgentSession.self, from: Data(odd.utf8))
        #expect(decoded.presence == .noCard)
        var snapshot = InboxSnapshot(); snapshot.sessions = [decoded]
        let data = try JSONEncoder().encode(snapshot)
        #expect(try JSONDecoder().decode(InboxSnapshot.self, from: data).sessions == [decoded])
        let old = try JSONEncoder().encode(InboxSnapshot())
        #expect(try JSONDecoder().decode(InboxSnapshot.self, from: old).sessions == nil)
    }

    @Test func liveNowCardGoesAgentQuietOnlyWhenItsSessionIsQuiet() {
        let quiet = AgentSession(id: "q", harness: "codex", startedAt: now.addingTimeInterval(-3_600),
                                 lastEventAt: now,
                                 card: .init(id: "act_1", state: "active", quietForSeconds: 840), presence: .quiet)
        let card = LiveNowProjection.Card(id: "act_1", row: nil, subject: nil, title: "t", status: nil, progress: nil,
            updatedAt: now, notificationID: nil, startedAt: nil, origin: nil, quietSession: quiet,
            quietSessionFetchedAt: now)
        #expect(card.agentQuietPhrase(now: now) == "agent running, no update for 14 min")
        let other = LiveNowProjection.Card(id: "act_2", row: nil, subject: nil, title: "t", status: nil, progress: nil,
            updatedAt: now, notificationID: nil, startedAt: nil, origin: nil, quietSession: nil)
        #expect(other.agentQuietPhrase(now: now) == nil)
    }
}
