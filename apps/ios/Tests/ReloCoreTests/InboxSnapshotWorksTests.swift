import Foundation
import Testing
@testable import ReloCore

/// The snapshot sends each work's plan once (`works`); `resolvingShared()` puts it back on the items.
@Suite("Snapshot works")
struct InboxSnapshotWorksTests {

    private func envelope(_ tag: String) -> [String: Any] {
        ["v": "1", "kind": "card", "context": "ctx:\(tag)", "sender": "key_1", "recipients": [],
         "nonce": tag, "ct": tag, "sig": tag]
    }

    private func row(_ id: String, workId: String?, sealed: Bool) -> [String: Any] {
        var activity: [String: Any] = ["state": "active", "updates": 1, "startedAt": "2026-09-30T20:00:00Z"]
        if let workId { activity["workId"] = workId }
        var row: [String: Any] = [
            "id": id, "kind": "live_activity", "sourceName": "Claude Code", "title": "Deploy", "createdAt": "2026-09-30T20:00:00Z",
            "updatedAt": "2026-09-30T20:00:00.123456Z", "activity": activity,
            "contentSummary": ["summary": "Deploy", "format": "text", "byteLength": 6],
        ]
        if sealed { row["sealed"] = ["content": envelope("own-\(id)")] }
        return row
    }

    private func decode(items: [[String: Any]], works: Any?, envelopes: Any? = nil) throws -> InboxRepairResponse {
        var body: [String: Any] = ["items": items, "total": items.count, "serverTime": "2026-09-30T20:00:00.123456Z",
                                   "readWatermark": "w", "unread": ["account": 0, "projects": [:]]]
        if let works { body["works"] = works }
        if let envelopes { body["envelopes"] = envelopes }
        return try ReloWireJSON.decoder().decode(InboxRepairResponse.self, from: JSONSerialization.data(withJSONObject: body))
    }

    private var goodWork: [String: Any] {
        ["plan": [["id": "s1", "state": "done"], ["id": "s2", "state": "current"]],
         "rounds": [["n": 1, "state": "closed"], ["n": 2, "state": "open"]], "sealed": envelope("newest")]
    }

    private let uuidKey = "wrk_00000000-0000-4000-8000-0000000000a1"

    @Test func itemsOfOneWorkGetThePlanRoundsAndSealedPlan() throws {
        let response = try decode(items: [row("ntf_1", workId: uuidKey, sealed: true), row("ntf_2", workId: uuidKey, sealed: true)],
                                  works: [uuidKey: goodWork]).resolvingShared()
        #expect(response.isValid)
        for summary in response.items {
            #expect(summary.item.activity?.plan?.map(\.id) == ["s1", "s2"])
            #expect(summary.item.activity?.rounds?.map(\.n) == [1, 2])
            #expect(summary.item.sealed?.plan?.ct == "newest")
            #expect(summary.item.sealed?.content.ct.hasPrefix("own-") == true)
        }
    }

    @Test func aBadWorksEntryIsDroppedAndNeverFailsTheSnapshot() throws {
        let response = try decode(items: [row("ntf_1", workId: uuidKey, sealed: false)],
                                  works: [uuidKey: "not an object", "bad-key": goodWork, "wrk_x": goodWork]).resolvingShared()
        #expect(response.works.isEmpty)
        #expect(response.items[0].item.activity?.plan == nil)
        let notObject = try decode(items: [row("ntf_1", workId: nil, sealed: false)], works: ["unexpected"])
        #expect(notObject.works.isEmpty)
    }

    @Test func anItemWithoutAWorkIsUnchanged() throws {
        let plain = try decode(items: [row("ntf_1", workId: nil, sealed: true)], works: nil)
        let filled = try decode(items: [row("ntf_1", workId: nil, sealed: true)], works: [uuidKey: goodWork]).resolvingShared()
        #expect(filled.items == plain.items)
        #expect(filled.items[0].item.activity?.plan == nil)
    }

    @Test func aSealedCardEqualToTheWorksNewestGetsNoSealedPlan() throws {
        var work = goodWork; work["sealed"] = envelope("own-ntf_1")
        let response = try decode(items: [row("ntf_1", workId: uuidKey, sealed: true)], works: [uuidKey: work]).resolvingShared()
        #expect(response.items[0].item.sealed?.plan == nil)
    }

    private func refRow(_ id: String, ref: String) -> [String: Any] {
        var row = self.row(id, workId: nil, sealed: false)
        row["sealed"] = ["contentRef": ref]
        return row
    }

    @Test func twoItemsSharingOneEnvelopeByRefBothResolve() throws {
        let ref = String(repeating: "a", count: 32)
        let response = try decode(items: [refRow("ntf_1", ref: ref), refRow("ntf_2", ref: ref)], works: nil,
                                  envelopes: [ref: envelope("shared"), "bad": envelope("x"), String(repeating: "b", count: 32): "junk"]).resolvingShared()
        #expect(response.envelopes.count == 1)
        for summary in response.items {
            #expect(summary.item.sealed?.content.ct == "shared")
            #expect(summary.item.sealed?.contentRef == nil)
        }
    }

    @Test func aMissingRefLeavesTheItemUnopenedAndTheDecodeSucceeds() throws {
        let response = try decode(items: [refRow("ntf_1", ref: String(repeating: "c", count: 32))], works: nil,
                                  envelopes: [:]).resolvingShared()
        #expect(response.isValid)
        let sealed = try #require(response.items[0].item.sealed)
        #expect(sealed.content == InboxSealedNotice.unresolvedContent)
        let opened = response.items[0].item.openingSealed { _, _ in nil }
        #expect(opened.sealed != nil)
    }
}
