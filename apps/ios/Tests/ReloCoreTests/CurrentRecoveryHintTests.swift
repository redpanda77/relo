import Foundation
import Testing
@testable import ReloCore
@testable import ReloRuntime

@Suite("Hints queued during transport failure", .timeLimit(.minutes(1)))
@MainActor
struct CurrentRecoveryHintTests {
    @Test(arguments: [false, true])
    func currentRetriesOnlyTheNewHint(_ retryAlsoFails: Bool) async throws {
        let source = RecoveryHintSource(mode: .current, retryAlsoFails: retryAlsoFails)
        let owner = try controller(source)
        owner.activate(observeChanges: false)
        await source.waitUntilSuspended()
        let (started, signal) = AsyncStream<Void>.makeStream()
        let refresh = Task { signal.yield(()); await owner.refresh() }
        for await _ in started { break }
        for _ in 0..<30 { owner.receive(.reconcile) }
        await source.failSuspendedRead()
        await refresh.value
        #expect(await source.currentReads == 2)
        #expect(owner.state.connection == (retryAlsoFails ? .offline : .current))
        owner.deactivate()
    }

    @Test(arguments: [false, true])
    func pendingRetriesOnlyTheNewHint(_ retryAlsoFails: Bool) async throws {
        let source = RecoveryHintSource(mode: .pending, retryAlsoFails: retryAlsoFails)
        let (states, sink) = AsyncStream<CurrentRuntimeState>.makeStream()
        let owner = try controller(source, changed: { sink.yield($0) })
        owner.activate()
        for await state in states where state.pendingConnection == .current { break }
        let loading = Task { await owner.loadMorePending() }
        await source.waitUntilSuspended()
        for _ in 0..<30 { owner.receive(.reconcile) }
        await source.failSuspendedRead()
        await loading.value
        #expect(await source.pendingReads == 3) // Initial page, failing next page, one coalesced reset.
        #expect(owner.state.pendingConnection == (retryAlsoFails ? .offline : .current))
        owner.deactivate()
    }

    private func controller(_ source: RecoveryHintSource, changed: @escaping @MainActor (CurrentRuntimeState) -> Void = { _ in }) throws -> CurrentStateController {
        let storage = try StorageScope(serverOrigin: URL(string: "https://example.test")!, accountID: "account", deviceID: "device")
        return CurrentStateController(scope: SessionScope(storage: storage, credentialVersion: 1), source: source,
            cache: InMemoryCurrentStateCache(), changed: changed)
    }
}

private actor RecoveryHintSource: CurrentStateSource {
    enum Mode: Sendable { case current, pending }
    let mode: Mode
    let retryAlsoFails: Bool
    private(set) var currentReads = 0
    private(set) var pendingReads = 0
    private var suspended: CheckedContinuation<Void, Error>?
    private var waiters: [CheckedContinuation<Void, Never>] = []
    init(mode: Mode, retryAlsoFails: Bool) { self.mode = mode; self.retryAlsoFails = retryAlsoFails }
    func waitUntilSuspended() async {
        if suspended != nil { return }
        await withCheckedContinuation { waiters.append($0) }
    }
    private func suspend() async throws {
        try await withCheckedThrowingContinuation {
            suspended = $0; waiters.forEach { $0.resume() }; waiters = []
        }
    }
    func failSuspendedRead() { suspended?.resume(throwing: InboxRemoteError.unavailable); suspended = nil }
    func fetchCurrent(ids: [String]?) async throws -> CurrentInboxResponse {
        currentReads += 1
        if mode == .current {
            if currentReads == 1 { try await suspend() }
            else if retryAlsoFails { throw InboxRemoteError.unavailable }
        }
        return .init(items: [], retired: [], total: 0, cursor: nil, hasMore: false,
            counts: .init(actionable: 0, currentUnread: 0), nextExpiryAt: nil, serverTime: Date())
    }
    func fetchCurrentPage(after cursor: String?) async throws -> CurrentInboxResponse { try await fetchCurrent(ids: nil) }
    func fetchPending(after cursor: String?, limit: Int) async throws -> PendingCurrentPage {
        pendingReads += 1
        if mode == .pending {
            if pendingReads == 2 { try await suspend() }
            else if pendingReads > 2 && retryAlsoFails { throw InboxRemoteError.unavailable }
        }
        return .init(items: [], total: pendingReads == 1 ? 1 : 0, hasMore: pendingReads == 1,
            cursor: pendingReads == 1 ? "next" : nil, nextExpiryAt: nil, serverTime: Date())
    }
    nonisolated func changes() -> AsyncThrowingStream<CurrentChangeHint, Error> { AsyncThrowingStream { $0.finish() } }
}
