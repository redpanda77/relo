@testable import ReloRuntime
import Foundation
import Testing
@testable import ReloCore

@Suite("Current work pagination")
@MainActor
struct CurrentPaginationTests {
    @Test func exactRevalidationDoesNotRequireWalkingEarlierCurrentPages() async throws {
        let source = CurrentPagingSource()
        let scope = SessionScope(storage: try StorageScope(serverOrigin: URL(string: "https://example.test")!, accountID: "a", deviceID: "d"), credentialVersion: 1)
        let owner = CurrentStateController(scope: scope, source: source, cache: InMemoryCurrentStateCache())
        owner.activate(); await owner.refresh()
        await owner.refresh(subjectIDs: [CurrentPagingSource.id(2)])
        #expect(owner.state.isSubjectVerified(CurrentPagingSource.id(2)))
        #expect(await source.pageCursors.isEmpty)
        #expect(await source.targeted == [[CurrentPagingSource.id(2)]])
        owner.deactivate()
    }

    @Test func laterPageAddsWorkAndRefreshRepairsPreviouslyLoadedIdentities() async throws {
        let source = CurrentPagingSource()
        let scope = SessionScope(storage: try StorageScope(serverOrigin: URL(string: "https://example.test")!, accountID: "a", deviceID: "d"), credentialVersion: 1)
        let owner = CurrentStateController(scope: scope, source: source, cache: InMemoryCurrentStateCache())
        owner.activate(); await owner.refresh()
        #expect(owner.state.snapshot.subjects.count == 1)
        await owner.loadMoreCurrent()
        #expect(owner.state.snapshot.subjects.count == 2)
        #expect(owner.state.snapshot.metadata?.hasMore == false)
        #expect(!owner.state.isLoadingCurrentPage)
        #expect(await source.pageCursors == ["second"])
        await owner.refresh()
        #expect(owner.state.snapshot.subjects.count == 2)
        #expect(await source.targeted == [[CurrentPagingSource.id(2)]])
        owner.deactivate()
    }
}

private actor CurrentPagingSource: CurrentStateSource {
    private(set) var pageCursors: [String?] = []
    private(set) var targeted: [[String]] = []
    nonisolated static func id(_ index: Int) -> String { "sub_11111111-1111-1111-1111-" + String(format: "%012d", index) }
    func fetchCurrent(ids: [String]?) -> CurrentInboxResponse {
        if let ids { targeted.append(ids) }
        return response(indices: ids == nil ? [1] : [2], more: ids == nil)
    }
    func fetchCurrentPage(after cursor: String?) -> CurrentInboxResponse {
        pageCursors.append(cursor); return response(indices: [2], more: false)
    }
    func fetchPending(after cursor: String?, limit: Int) throws -> PendingCurrentPage { throw InboxRemoteError.unavailable }
    nonisolated func changes() -> AsyncThrowingStream<CurrentChangeHint, Error> { AsyncThrowingStream { $0.finish() } }
    private func response(indices: [Int], more: Bool) -> CurrentInboxResponse {
        let now = Date()
        return .init(items: indices.map {
            .init(subjectId: Self.id($0), notificationId: nil, kind: .progress, version: .init(generation: 1, revision: 1),
                  title: "Running", summary: "Work", source: "Fixture", createdAt: now, updatedAt: now, occurredAt: now,
                  acceptedAt: now, readAt: nil, currentUntil: nil, freshUntil: now.addingTimeInterval(300),
                  deliverUntil: now.addingTimeInterval(60), freshness: .fresh, interaction: nil, activity: nil, resources: nil)
        }, retired: [], total: 2, cursor: more ? "second" : nil, hasMore: more,
        counts: .init(actionable: 0, currentUnread: 2), nextExpiryAt: nil, serverTime: now)
    }
}
