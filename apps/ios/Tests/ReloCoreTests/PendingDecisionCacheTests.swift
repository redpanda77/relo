import Foundation
import Testing
@testable import ReloCore

@Suite("Durable independent pending inventory")
struct PendingDecisionCacheTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    @Test(arguments: [false, true])
    func laterInventoryObservationCannotExtendKnownParentDeadline(inventoryArrivesFirst: Bool) throws {
        let decision = item(1)
        let deadline = now.addingTimeInterval(10)
        let current = CurrentSubjectProjection(subjectId: decision.subjectId, notificationId: decision.notificationId,
            kind: .decision, version: decision.version!, title: decision.title, summary: decision.summary, source: decision.source,
            createdAt: now, updatedAt: now, occurredAt: now, acceptedAt: now, readAt: nil, currentUntil: deadline,
            freshUntil: nil, deliverUntil: now.addingTimeInterval(60), freshness: .unknown, interaction: decision.interaction,
            activity: nil, resources: nil)
        var cache = CurrentCacheSnapshot()
        if inventoryArrivesFirst {
            try cache.applyPending(page([decision], total: 1, at: now.addingTimeInterval(1)), limit: 50)
        }
        try cache.apply(.init(items: [current], retired: [], total: 1, cursor: nil, hasMore: false,
            counts: .init(actionable: 1, currentUnread: 1), nextExpiryAt: deadline, serverTime: now))
        if !inventoryArrivesFirst {
            try cache.applyPending(page([decision], total: 1, at: now.addingTimeInterval(1)), limit: 50)
        }
        var state = try state(cache); state.timeVerified = true
        state.verifiedPending[decision.id] = now.addingTimeInterval(1)
        let identity = CurrentDecisionIdentity(pending: decision, scope: state.scope.storage)
        #expect(CurrentInboxPresentation.availability(for: identity, state: state, now: deadline) == .expired)
        #expect(cache.pending?.entries[decision.id]?.validUntil == deadline)
    }

    @Test func all101ApprovalsRemainReachableWithoutHistoryOrCurrentPageMembership() throws {
        var cache = CurrentCacheSnapshot()
        for start in stride(from: 0, to: 101, by: 50) {
            try cache.applyPending(page((start..<min(start + 50, 101)).map { item($0) }, total: 101, hasMore: start < 100), limit: 50)
        }
        let restored = try JSONDecoder().decode(CurrentCacheSnapshot.self, from: JSONEncoder().encode(cache))
        #expect(restored.pending?.entries.count == 101)
        #expect(restored.subjects.isEmpty)
        #expect(restored.pending?.metadata?.total == 101)
        #expect(restored.isValid)
    }

    @Test func partialPageDoesNotRetireOtherRequestsAndCompleteScanDoes() throws {
        var cache = CurrentCacheSnapshot()
        try cache.applyPending(page([item(1), item(2)], total: 2), limit: 50)
        let later = now.addingTimeInterval(1)
        try cache.applyPending(page([item(1)], total: 1, at: later), limit: 50)
        #expect(cache.pending?.entries.count == 2)
        cache.finishPendingScan(seen: [item(1).id], startedAt: later)
        #expect(cache.pending?.entries.count == 1)
        // A delayed cache read must not restore a request absent from the completed scan.
        var disk = CurrentCacheSnapshot(); try disk.applyPending(page([item(2)], total: 1), limit: 50)
        cache.mergeKnowledge(from: disk)
        #expect(cache.pending?.entries[item(2).id] == nil)
    }

    @Test func completedScanDoesNotDiscardNewerEvidenceArrivingBetweenPages() throws {
        var cache = CurrentCacheSnapshot()
        try cache.applyPending(page([item(2)], total: 1, at: now.addingTimeInterval(2)), limit: 50)
        cache.finishPendingScan(seen: [], startedAt: now)
        #expect(cache.pending?.entries[item(2).id] != nil)
    }

    @Test func replacementRejectsLateOriginalAndKeepsDraftIdentity() throws {
        var cache = CurrentCacheSnapshot()
        let original = item(1), replacement = item(2, subject: 1, revision: 2)
        try cache.applyPending(page([original], total: 1), limit: 50)
        try cache.applyPending(page([replacement], total: 1, at: now.addingTimeInterval(1)), limit: 50)
        try cache.applyPending(page([original], total: 1), limit: 50)
        #expect(cache.pending?.entries.keys.sorted() == [replacement.id])
        var state = try state(cache)
        state.verifiedPending[replacement.id] = now.addingTimeInterval(1)
        let draft = CurrentDecisionIdentity(pending: original, scope: state.scope.storage)
        #expect(CurrentInboxPresentation.availability(for: draft, state: state, now: now) == .replaced)
    }

    @Test func originalExpiryPersistsAcrossClockRollbackAndCachedActionsStayUnverified() throws {
        var cache = CurrentCacheSnapshot()
        try cache.applyPending(page([item(1)], total: 1), limit: 50)
        let cold = try state(cache)
        let identity = CurrentDecisionIdentity(pending: item(1), scope: cold.scope.storage)
        #expect(CurrentInboxPresentation.availability(for: identity, state: cold, now: now) == .unverified)
        cache.expire(at: now.addingTimeInterval(301))
        var restored = try JSONDecoder().decode(CurrentCacheSnapshot.self, from: JSONEncoder().encode(cache))
        try restored.applyPending(page([item(1)], total: 1), limit: 50)
        #expect(restored.pending?.entries.isEmpty == true)
    }

    @Test func predecessorCacheWithoutPendingFieldDecodesAndUsesCurrentDecision() throws {
        let encoded = try JSONEncoder().encode(CurrentCacheSnapshot())
        var object = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        object.removeValue(forKey: "pending")
        let restored = try JSONDecoder().decode(CurrentCacheSnapshot.self, from: JSONSerialization.data(withJSONObject: object))
        #expect(restored.pending == nil)
        #expect(restored.isValid)
    }

    @Test func canonicalCountAndParentDeadlineAreNotInferredFromLoadedRows() throws {
        var cache = CurrentCacheSnapshot()
        let parentExpiry = now.addingTimeInterval(10)
        try cache.applyPending(page([item(1)], total: 101, nextExpiry: parentExpiry), limit: 50)
        var state = try state(cache); state.timeVerified = true; state.pendingCountsAreCurrent = true
        state.verifiedPending[item(1).id] = now
        let identity = CurrentDecisionIdentity(pending: item(1), scope: state.scope.storage)
        #expect(CurrentInboxPresentation(state: state, now: now).actionableCount == 101)
        #expect(CurrentInboxPresentation.availability(for: identity, state: state, now: now) == .available)
        #expect(CurrentInboxPresentation(state: state, now: parentExpiry).actionableCount == nil)
        #expect(CurrentInboxPresentation.availability(for: identity, state: state, now: parentExpiry) == .unverified)
    }

    private func state(_ cache: CurrentCacheSnapshot) throws -> CurrentRuntimeState {
        var state = CurrentRuntimeState(scope: SessionScope(storage: try StorageScope(serverOrigin: URL(string: "https://example.test")!, accountID: "a", deviceID: "d"), credentialVersion: 1))
        state.snapshot = cache; return state
    }
    private func page(_ items: [PendingCurrentDecision], total: Int, hasMore: Bool = false, at: Date? = nil, nextExpiry: Date? = nil) -> PendingCurrentPage {
        .init(items: items, total: total, hasMore: hasMore, cursor: hasMore ? "next" : nil,
              nextExpiryAt: nextExpiry ?? now.addingTimeInterval(300), serverTime: at ?? now)
    }
    private func item(_ n: Int, subject: Int? = nil, revision: Int = 1) -> PendingCurrentDecision {
        func id(_ value: Int) -> String { "11111111-1111-1111-1111-" + String(format: "%012d", value) }
        return .init(subjectId: "sub_" + id(subject ?? n), notificationId: "ntf_" + id(n), version: .init(generation: 1, revision: revision),
            kind: .decision, title: "Approval", summary: "Original question", source: "Fixture", createdAt: now, readAt: nil, urgencyRank: 0,
            interaction: .init(id: "int_" + id(n), type: .approval, state: .pending, expiresAt: now.addingTimeInterval(300)))
    }
}
