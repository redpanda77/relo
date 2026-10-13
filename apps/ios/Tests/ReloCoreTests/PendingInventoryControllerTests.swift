@testable import ReloRuntime
import Foundation
import Testing
@testable import ReloCore

@Suite("Pending inventory runtime", .timeLimit(.minutes(1)))
@MainActor
struct PendingInventoryControllerTests {
    @Test func pendingPaintAndSubmissionAuthorityDoNotWaitForCurrentOrHistory() async throws {
        let fixture = try Fixture()
        fixture.owner.activate()
        await fixture.source.waitForPending(1)
        await fixture.source.complete(0, items: [1], hasMore: true)
        let state = await fixture.next { $0.pendingConnection == .current }
        let item = try #require(state.snapshot.pending?.entries.values.first?.item)
        let identity = CurrentDecisionIdentity(pending: item, scope: state.scope.storage)
        #expect(state.connection == .connecting)
        #expect(CurrentInboxPresentation.availability(for: identity, state: state, now: state.snapshot.evaluatedAt!) == .available)
        let more = Task { await fixture.owner.loadMorePending() }
        await fixture.source.waitForPending(2)
        #expect(await fixture.source.cursor(1) == "second")
        await fixture.source.complete(1, items: [2], hasMore: false)
        await more.value
        #expect(fixture.owner.state.snapshot.pending?.entries.count == 2)
        await fixture.owner.waitForPersistence()
        fixture.owner.deactivate(); await fixture.source.finish()
        #expect(try await fixture.cache.load().pending?.entries.count == 2)
    }

    @Test func hintRevokesAuthorityImmediatelyAndOldInflightPageCannotRestoreIt() async throws {
        let fixture = try Fixture()
        fixture.owner.activate(); await fixture.source.waitForPending(1)
        await fixture.source.complete(0, items: [1], hasMore: false)
        let ready = await fixture.next { $0.pendingConnection == .current }
        let item = try #require(ready.snapshot.pending?.entries.values.first?.item)
        let identity = CurrentDecisionIdentity(pending: item, scope: ready.scope.storage)
        fixture.owner.receive(.init(subjectIds: [item.subjectId], invalidateCounts: true))
        #expect(fixture.owner.state.verifiedPending.isEmpty)
        await fixture.source.waitForPending(2)
        fixture.owner.receive(.init(subjectIds: [item.subjectId], invalidateCounts: true))
        await fixture.source.complete(1, items: [1], hasMore: false)
        await fixture.source.waitForPending(3)
        #expect(CurrentInboxPresentation.availability(for: identity, state: fixture.owner.state, now: ready.snapshot.evaluatedAt!) == .unverified)
        await fixture.source.complete(2, items: [], hasMore: false)
        _ = await fixture.next { $0.pendingConnection == .current && $0.snapshot.pending?.entries.isEmpty == true }
        #expect(fixture.owner.state.verifiedPending.isEmpty)
        fixture.owner.deactivate(); await fixture.source.finish()
    }

    @Test func cancelledInventoryCannotPublishIntoAnInactiveSession() async throws {
        let fixture = try Fixture()
        fixture.owner.activate(); await fixture.source.waitForPending(1)
        fixture.owner.deactivate()
        await fixture.source.complete(0, items: [1], hasMore: false)
        await fixture.source.finish()
        #expect(fixture.owner.state.snapshot.pending?.entries.isEmpty ?? true)
        #expect(fixture.owner.state.pendingConnection == .inactive)
    }

    @Test func backgroundOneShotDoesNotOpenPendingInventory() async throws {
        let fixture = try Fixture()
        fixture.owner.activate(observeChanges: false)
        await fixture.source.waitForCurrent()
        #expect(await fixture.source.pendingCount == 0)
        fixture.owner.deactivate(); await fixture.source.finish()
    }
}

@MainActor
private final class Fixture {
    let source = InventorySource()
    let cache = InMemoryCurrentStateCache()
    let owner: CurrentStateController
    let states: AsyncStream<CurrentRuntimeState>
    init() throws {
        let (states, sink) = AsyncStream<CurrentRuntimeState>.makeStream()
        self.states = states
        let scope = SessionScope(storage: try StorageScope(serverOrigin: URL(string: "https://example.test")!, accountID: "a", deviceID: "d"), credentialVersion: 1)
        owner = CurrentStateController(scope: scope, source: source, cache: cache, changed: { sink.yield($0) })
    }
    func next(_ predicate: (CurrentRuntimeState) -> Bool) async -> CurrentRuntimeState {
        for await state in states where predicate(state) { return state }
        preconditionFailure("State stream ended")
    }
}

private actor InventorySource: CurrentStateSource {
    private var cursors: [String?] = []
    private var pending: [Int: CheckedContinuation<PendingCurrentPage, Error>] = [:]
    private var waiting: [(Int, CheckedContinuation<Void, Never>)] = []
    private var current: CheckedContinuation<CurrentInboxResponse, Error>?
    private var currentWaiters: [CheckedContinuation<Void, Never>] = []
    private var currentStarted = false
    nonisolated let stream: AsyncThrowingStream<CurrentChangeHint, Error>
    nonisolated let hints: AsyncThrowingStream<CurrentChangeHint, Error>.Continuation
    init() { (stream, hints) = AsyncThrowingStream.makeStream() }
    var pendingCount: Int { cursors.count }
    func cursor(_ index: Int) -> String? { cursors[index] }
    func waitForPending(_ count: Int) async {
        if cursors.count >= count { return }
        await withCheckedContinuation { waiting.append((count, $0)) }
    }
    func waitForCurrent() async {
        if currentStarted { return }
        await withCheckedContinuation { currentWaiters.append($0) }
    }
    func fetchCurrent(ids: [String]?) async throws -> CurrentInboxResponse {
        currentStarted = true
        return try await withCheckedThrowingContinuation {
            current = $0; currentWaiters.forEach { $0.resume() }; currentWaiters = []
        }
    }
    func fetchCurrentPage(after cursor: String?) async throws -> CurrentInboxResponse { try await fetchCurrent(ids: nil) }
    func fetchPending(after cursor: String?, limit: Int) async throws -> PendingCurrentPage {
        let index = cursors.count; cursors.append(cursor)
        return try await withCheckedThrowingContinuation {
            pending[index] = $0
            let ready = waiting.filter { $0.0 <= cursors.count }; waiting.removeAll { $0.0 <= cursors.count }
            ready.forEach { $0.1.resume() }
        }
    }
    nonisolated func changes() -> AsyncThrowingStream<CurrentChangeHint, Error> { stream }
    func complete(_ index: Int, items: [Int], hasMore: Bool) {
        let now = Date(timeIntervalSince1970: 1_800_000_000 + Double(index))
        let entries = items.map { n -> PendingCurrentDecision in
            let suffix = "11111111-1111-1111-1111-" + String(format: "%012d", n)
            return .init(subjectId: "ntf_" + suffix, notificationId: "ntf_" + suffix, version: nil, kind: .decision,
                title: "Question", summary: "Choose", source: "Test", createdAt: now, readAt: nil, urgencyRank: 0,
                interaction: .init(id: "int_" + suffix, type: .approval, state: .pending, expiresAt: Date(timeIntervalSince1970: 1_800_000_300)))
        }
        pending.removeValue(forKey: index)?.resume(returning: .init(items: entries, total: hasMore ? 2 : entries.count,
            hasMore: hasMore, cursor: hasMore ? "second" : nil, nextExpiryAt: Date(timeIntervalSince1970: 1_800_000_300), serverTime: now))
    }
    func finish() {
        hints.finish(); current?.resume(throwing: CancellationError()); current = nil
        pending.values.forEach { $0.resume(throwing: CancellationError()) }; pending = [:]
    }
}
