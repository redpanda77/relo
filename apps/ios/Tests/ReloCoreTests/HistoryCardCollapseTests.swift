import Foundation
@testable import ReloCore
import Testing

@Suite("History shows one row per card")
struct HistoryCardCollapseTests {
    private func event(_ id: String, operation: String, sequence: Int, at time: String) -> [String: Any] {
        ["id": id, "kind": "live_activity", "sourceName": "Claude Code", "title": "Release", "privacy": "standard",
         "createdAt": time, "updatedAt": time,
         "contentSummary": ["summary": "Working", "format": "text", "byteLength": 7],
         "activityEvent": ["id": "act_history_card", "operation": operation, "generation": 1, "sequence": sequence]]
    }

    @Test func aCardsEventsCollapseIntoItsLatestEvent() throws {
        let note: [String: Any] = ["id": "ntf_note", "kind": "notification", "sourceName": "Claude Code", "title": "Deployed",
            "privacy": "standard", "createdAt": "2026-10-06T12:05:00Z", "updatedAt": "2026-10-06T12:05:00Z",
            "contentSummary": ["summary": "Live", "format": "text", "byteLength": 4]]
        let body: [String: Any] = [
            "items": [note, event("ntf_end", operation: "end", sequence: 3, at: "2026-10-06T12:04:00Z"),
                      event("ntf_update", operation: "update", sequence: 2, at: "2026-10-06T12:02:00Z"),
                      event("ntf_start", operation: "start", sequence: 1, at: "2026-10-06T12:00:00Z")],
            "total": 4, "serverTime": "2026-10-06T12:06:00Z", "unread": ["account": 0, "projects": [String: Int]()]]
        let response = try ReloWireJSON.decoder().decode(InboxRepairResponse.self,
                                                         from: JSONSerialization.data(withJSONObject: body))
        let snapshot = try response.snapshot(syncedAt: .now)
        #expect(snapshot.items.first { $0.id == "ntf_start" }?.activityEvent?.id == "act_history_card")
        let rows = ReloHistoryResults.make(items: snapshot.items, query: "", kind: .all, projectID: nil)
        #expect(rows.map(\.id) == ["ntf_note", "ntf_end"])
    }

    @Test func theCardIdentitySurvivesTheOfflineCache() throws {
        let item = InboxItem(id: "ntf_cached", kind: .liveActivity, sourceName: "Claude Code", title: "Release",
            createdAt: .now, activityEvent: .init(id: "act_cached", operation: "update", generation: 1, sequence: 4))
        let decoded = try JSONDecoder().decode(InboxItem.self, from: JSONEncoder().encode(item.historySummary()))
        #expect(decoded.activityEvent?.id == "act_cached")
    }
}
