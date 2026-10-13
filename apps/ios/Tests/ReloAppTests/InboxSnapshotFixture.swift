import Foundation
import ReloCore

/// Test fakes describe their inbox as one page plus single-item reads; the fixture derives the
/// snapshot and read-items responses production uses from those primitives.
protocol InboxFixtureSource: InboxDataSource {
    func fetchPage(after cursor: String?) async throws -> InboxPage
    func markRead(notificationID: String) async throws -> InboxReadMutationResponse
}

// App fakes model one authoritative response. Production has no delta fallback.
extension InboxFixtureSource {
    func markReadItems(_ notificationIDs: [String]) async throws -> ReadItemsResponse {
        var unread = InboxUnreadSummary(account: 0, projects: [:])
        for id in notificationIDs { unread = try await markRead(notificationID: id).unread }
        return .init(results: notificationIDs.map { .init(notificationId: $0, outcome: .read) }, unread: unread)
    }

    func fetchSnapshot() async throws -> InboxRepairResponse {
        let page = try await fetchPage(after: nil)
        let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601
        let items = try page.items.map { item -> [String: Any] in
            var value = try JSONSerialization.jsonObject(with: encoder.encode(item)) as! [String: Any]
            for key in ["detail", "content", "liveActivity", "activitySummary"] { value.removeValue(forKey: key) }
            value["contentSummary"] = ["summary": String((item.detail ?? "").unicodeScalars.prefix(240)), "format": "text", "byteLength": 0]
            value["updatedAt"] = "2026-09-30T00:00:00Z"
            return value
        }
        let data = try JSONSerialization.data(withJSONObject: ["items": items, "total": items.count,
            "serverTime": "2026-09-30T00:00:00Z", "unread": ["account": page.unread?.account ?? 0, "projects": page.unread?.projects ?? [:]]])
        let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(InboxRepairResponse.self, from: data)
    }
}

// Empty receipt fixtures keep unrelated hosted tests free of networking.
extension ScopedNotificationReceiptStoring {
    func pending(scope: ReceiptScope, limit: Int) async throws -> NotificationReceiptBatch { .init(records: []) }
    func remove(records: Set<NotificationReceiptRecord>) async throws {}
    func retire(scope: ReceiptScope) async throws {}
}
