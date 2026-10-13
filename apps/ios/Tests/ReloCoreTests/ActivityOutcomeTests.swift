import Foundation
@testable import ReloCore
import Testing

@Suite("Card outcome and final status")
struct ActivityOutcomeTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func summary(state: String, status: String, ended: Bool, terminalReason: String? = nil) throws -> InboxActivitySummary {
        var json: [String: Any] = ["id": "act_outcome123456", "generation": 1, "sequence": 5, "state": state,
                                   "title": "Release", "status": status]
        if ended { json["endedAt"] = "2026-10-06T17:07:07Z" }
        if let terminalReason { json["terminalReason"] = terminalReason }
        return try ReloWireJSON.decoder().decode(InboxActivitySummary.self, from: JSONSerialization.data(withJSONObject: json))
    }

    private func item(operation: LiveActivityCommand.Operation, kind: String, summary: InboxActivitySummary?) -> InboxItem {
        let presentation = LiveActivityPresentation(
            title: "Release", subtitle: nil, status: summary?.status ?? "Working", components: [],
            surfaces: .init(lockScreen: [], expandedBottom: [], compactTrailing: [], minimal: []),
            state: .init(kind: kind, tone: kind == "completed" ? "success" : "live", icon: .active), behavior: .progress)
        return InboxItem(
            id: "ntf_outcome123456", kind: .liveActivity, sourceName: "Claude Code", title: "Release", createdAt: now,
            liveActivity: LiveActivityCommand(
                operation: operation, activityId: "act_outcome123456", generation: 1, targetDeviceId: "dev_outcome123456",
                style: "steps", sourceName: "Claude Code", headline: "Release", status: summary?.status ?? "Working",
                sequence: 5, presentation: presentation),
            activitySummary: summary)
    }

    @Test func aRunningCardHasNoFinalStatus() throws {
        let running = item(operation: .update, kind: "active", summary: try summary(state: "active", status: "Testing", ended: false))
        #expect(InboxAttentionProjection.activityOutcome(running, now: now) == .running)
        #expect(InboxAttentionProjection.finalStatus(running, now: now) == nil)
    }

    @Test func theEndEventTellsSuccessFromAStop() throws {
        let done = item(operation: .end, kind: "completed", summary: try summary(state: "ended", status: "Shipped", ended: true))
        #expect(InboxAttentionProjection.activityOutcome(done, now: now) == .completed)
        #expect(InboxAttentionProjection.finalStatus(done, now: now) == "Shipped")
        let stopped = item(operation: .end, kind: "failed", summary: try summary(state: "ended", status: "Tests failed", ended: true))
        #expect(InboxAttentionProjection.activityOutcome(stopped, now: now) == .stopped)
        #expect(InboxAttentionProjection.finalStatus(stopped, now: now) == "Tests failed")
    }

    @Test func anOlderUpdateOfAnEndedCardOnlyKnowsItEnded() throws {
        let update = item(operation: .update, kind: "active", summary: try summary(state: "ended", status: "Shipped", ended: true))
        #expect(InboxAttentionProjection.activityOutcome(update, now: now) == .ended)
        #expect(InboxAttentionProjection.finalStatus(update, now: now) == "Shipped")
    }

    @Test func expiryWinsOverTheEndEventsTone() throws {
        let expired = item(operation: .end, kind: "failed",
                           summary: try summary(state: "expired", status: "Expired", ended: true, terminalReason: "expired"))
        #expect(InboxAttentionProjection.activityOutcome(expired, now: now) == .expired)
    }
}
