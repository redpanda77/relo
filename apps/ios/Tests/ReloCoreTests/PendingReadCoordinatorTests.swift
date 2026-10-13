@testable import ReloRuntime
@testable import ReloPersistence
import Foundation
import Testing
@testable import ReloCore

@Suite("Scoped durable exact read intent")
struct PendingReadCoordinatorTests {
    private func scope(_ account: String = "a", version: Int = 1) throws -> SessionScope {
        .init(storage: try .init(serverOrigin: URL(string: "https://relo.test")!, accountID: account, deviceID: "d"), credentialVersion: version)
    }

    @Test func restartAndQueueLimitPreserveEveryIDAndAcceptDuplicatesWhenFull() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let owner = try scope().storage, ids = (0..<1_000).map { "ntf_\($0)" }
        let store = FilePendingReadStore(baseDirectory: directory, scope: owner)
        try await store.enqueue(ids)
        try await store.enqueue([ids[0], ids[0]])
        await #expect(throws: PendingReadError.full) { try await store.enqueue(["one-too-many"]) }
        let reopened = FilePendingReadStore(baseDirectory: directory, scope: owner)
        #expect(try await reopened.pending(limit: 2_000) == ids)
        let other = FilePendingReadStore(baseDirectory: directory, scope: try scope("b").storage)
        #expect(try await other.pending(limit: 1_000).isEmpty)
    }

    @Test @MainActor func durableSavePrecedesFeedbackAndFailedSaveCannotPretendToQueue() async throws {
        let io = FaultingInboxIO(data: nil), session = try scope()
        let store = FilePendingReadStore(baseDirectory: URL(fileURLWithPath: "/unused"), scope: session.storage, io: io)
        let coordinator = PendingReadCoordinator()
        coordinator.activate(scope: session, store: store, remote: ReadFixtureRemote())
        io.setFault(.write)
        #expect(await coordinator.enqueue(["exact"]) == false)
        #expect(coordinator.state.pendingIDs.isEmpty)
        #expect(coordinator.state.issue == .storage)
        io.setFault(nil)
        #expect(await coordinator.enqueue(["exact"]))
        #expect(try await store.pending(limit: 1_000) == ["exact"])
        #expect(coordinator.state.pendingIDs == ["exact"])
    }

    @Test @MainActor func fullRecoveryIsBoundedToFourExact250IDRequests() async throws {
        let store = InMemoryPendingReadStore(), remote = ReadFixtureRemote(), coordinator = PendingReadCoordinator()
        coordinator.activate(scope: try scope(), store: store, remote: remote)
        let ids = (0..<1_000).map { "id-\($0)" }
        #expect(await coordinator.enqueue(ids))
        await coordinator.flush()
        #expect(await remote.batches.map(\.count) == [250, 250, 250, 250])
        #expect(await remote.batches.flatMap { $0 } == ids)
        #expect(await store.pending(limit: 1_000).isEmpty)
        #expect(coordinator.state.pendingIDs.isEmpty)
    }

    @Test @MainActor func partialAcknowledgmentClearsOnlyEchoedIDsAndTimeoutRetainsIntent() async throws {
        let store = InMemoryPendingReadStore(), coordinator = PendingReadCoordinator(), session = try scope()
        coordinator.activate(scope: session, store: store, remote: ReadFixtureRemote(partial: true))
        #expect(await coordinator.enqueue(["a", "b", "c"]))
        await coordinator.flush()
        #expect(await store.pending(limit: 1_000) == ["b", "c"])
        coordinator.activate(scope: try scope(version: 2), store: store, remote: ReadFixtureRemote(fail: true))
        await coordinator.flush()
        #expect(await store.pending(limit: 1_000) == ["b", "c"])
        #expect(coordinator.state.issue == .offline)
    }

    @Test @MainActor func lateOldScopeCompletionCannotRemoveNewScopeIntentOrPublishCounts() async throws {
        let old = InMemoryPendingReadStore(), replacement = InMemoryPendingReadStore(), held = HeldReadRemote()
        var counts: [Int] = []
        let coordinator = PendingReadCoordinator(confirmed: { counts.append($0.account) })
        coordinator.activate(scope: try scope(), store: old, remote: held)
        #expect(await coordinator.enqueue(["same-id"]))
        let oldFlush = Task { await coordinator.flush() }
        await held.started()
        coordinator.activate(scope: try scope("b"), store: replacement, remote: ReadFixtureRemote())
        #expect(await coordinator.enqueue(["same-id"]))
        await held.release(); await oldFlush.value
        #expect(counts.isEmpty)
        #expect(await old.pending(limit: 1_000) == ["same-id"])
        #expect(await replacement.pending(limit: 1_000) == ["same-id"])
        await coordinator.flush()
        #expect(counts == [0])
        #expect(await replacement.pending(limit: 1_000).isEmpty)
    }

    @Test @MainActor func removalFailureKeepsDurableIDsForIdempotentReplay() async throws {
        let io = FaultingInboxIO(data: nil), session = try scope()
        let store = FilePendingReadStore(baseDirectory: URL(fileURLWithPath: "/unused"), scope: session.storage, io: io)
        let remote = ReadFixtureRemote(beforeReply: { io.setFault(.write) })
        let coordinator = PendingReadCoordinator()
        coordinator.activate(scope: session, store: store, remote: remote)
        #expect(await coordinator.enqueue(["exact"]))
        let bytes = io.contents
        await coordinator.flush()
        #expect(io.contents == bytes)
        #expect(coordinator.state.issue == .storage)
        io.setFault(nil)
        #expect(try await store.pending(limit: 1_000) == ["exact"])
    }
}

private actor ReadFixtureRemote: ReadItemsRemoteSource {
    private(set) var batches: [[String]] = []
    let partial: Bool
    let fail: Bool
    let beforeReply: @Sendable () -> Void
    init(partial: Bool = false, fail: Bool = false, beforeReply: @escaping @Sendable () -> Void = {}) {
        self.partial = partial; self.fail = fail; self.beforeReply = beforeReply
    }
    func markReadItems(_ ids: [String]) throws -> ReadItemsResponse {
        batches.append(ids)
        if fail { throw InboxRemoteError.unavailable }
        beforeReply()
        return .init(results: (partial ? Array(ids.prefix(1)) : ids).map { .init(notificationId: $0, outcome: .read) },
            unread: .init(account: 0, projects: [:]))
    }
}

private actor HeldReadRemote: ReadItemsRemoteSource {
    private var continuation: CheckedContinuation<Void, Never>?
    private var waiter: CheckedContinuation<Void, Never>?
    func markReadItems(_ ids: [String]) async -> ReadItemsResponse {
        await withCheckedContinuation { continuation = $0; waiter?.resume(); waiter = nil }
        return .init(results: ids.map { .init(notificationId: $0, outcome: .read) }, unread: .init(account: 999, projects: [:]))
    }
    func started() async { if continuation == nil { await withCheckedContinuation { waiter = $0 } } }
    func release() { continuation?.resume(); continuation = nil }
}
