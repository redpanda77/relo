@testable import ReloRuntime
import Foundation
import Testing
@testable import ReloCore

@Suite("Independent current-state owner", .timeLimit(.minutes(1)))
@MainActor
struct CurrentStateControllerTests {
    @Test func serverPaintDoesNotWaitForDiskAndActivationHasOneOwner() async throws {
        let source = ControlledCurrentSource(), cache = SuspendedCurrentCache(), recorder = CurrentStateRecorder()
        let controller = try owner(source: source, cache: cache, recorder: recorder)
        controller.activate(); controller.activate()
        await source.waitForRequests(1)
        await source.complete(0, with: .success(page(revision: 3)))
        let current = await recorder.next { $0.connection == .current }
        #expect(current.snapshot.subjects.values.first?.projection.version.revision == 3)
        #expect(current.snapshot.metadata?.counts.actionable == 500)
        #expect(current.persistence == .loading)
        #expect(await source.requestCount == 1)
        var old = CurrentCacheSnapshot(); try old.apply(page(revision: 1, at: time.addingTimeInterval(-1)))
        await cache.finishLoad(old)
        let loaded = await recorder.next { $0.persistence == .available }
        #expect(loaded.snapshot.subjects.values.first?.projection.version.revision == 3)
        controller.deactivate(); await source.finish()
    }

    @Test func aBurstJoinsOneBoundedNextRead() async throws {
        let source = ControlledCurrentSource(), cache = SuspendedCurrentCache(), recorder = CurrentStateRecorder()
        let controller = try owner(source: source, cache: cache, recorder: recorder)
        controller.activate()
        await source.waitForRequests(1)
        let id = subjectID
        for _ in 0..<100 { controller.receive(.init(subjectIds: [id], invalidateCounts: true)) }
        #expect(await source.requestCount == 1)
        await source.complete(0, with: .success(page(revision: 1)))
        await source.waitForRequests(2)
        #expect(await source.request(at: 1) == [id])
        await source.complete(1, with: .success(page(revision: 2, at: time.addingTimeInterval(1), targeted: true)))
        _ = await recorder.next { $0.snapshot.subjects[id]?.projection.version.revision == 2 }
        #expect(await source.requestCount == 2)
        controller.deactivate(); await cache.finishLoad(CurrentCacheSnapshot()); await source.finish()
    }

    @Test func overflowRequestsFullReconciliationInsteadOfAnUnboundedIDQueue() async throws {
        let source = ControlledCurrentSource(), cache = SuspendedCurrentCache(), recorder = CurrentStateRecorder()
        let controller = try owner(source: source, cache: cache, recorder: recorder)
        controller.activate(); await source.waitForRequests(1)
        for _ in 0..<51 { controller.receive(.init(subjectIds: ["sub_" + UUID().uuidString.lowercased()], invalidateCounts: true)) }
        await source.complete(0, with: .success(page(revision: 1)))
        await source.waitForRequests(2)
        #expect(await source.request(at: 1) == nil)
        await source.complete(1, with: .success(page(revision: 2, at: time.addingTimeInterval(1))))
        _ = await recorder.next { $0.snapshot.subjects[subjectID]?.projection.version.revision == 2 }
        controller.deactivate(); await cache.finishLoad(CurrentCacheSnapshot()); await source.finish()
    }

    @Test func cancelledScopeCannotPublishEvenWhenTransportIgnoresCancellation() async throws {
        let source = ControlledCurrentSource(), cache = SuspendedCurrentCache(), recorder = CurrentStateRecorder()
        let controller = try owner(source: source, cache: cache, recorder: recorder)
        controller.activate(); await source.waitForRequests(1)
        let (joined, signal) = AsyncStream<Void>.makeStream()
        let waiter = Task { signal.yield(()); await controller.refresh() }
        for await _ in joined { break }
        controller.deactivate()
        await source.complete(0, with: .success(page(revision: 9)))
        await waiter.value
        await cache.finishLoad(CurrentCacheSnapshot()); await source.finish()
        #expect(controller.state.connection == .inactive)
        #expect(controller.state.snapshot.subjects.isEmpty)
        #expect(!controller.state.timeVerified)
    }

    @Test func lateDiskEntriesRequireAnExactFreshReadBeforeBecomingVerified() async throws {
        let source = ControlledCurrentSource(), cache = SuspendedCurrentCache(), recorder = CurrentStateRecorder()
        let controller = try owner(source: source, cache: cache, recorder: recorder)
        controller.activate(); await source.waitForRequests(1)
        await source.complete(0, with: .success(page(revision: 1)))
        _ = await recorder.next { $0.connection == .current }
        #expect(controller.state.isSubjectVerified(subjectID))
        let oldID = "sub_22222222-2222-2222-2222-222222222222"
        var cached = CurrentCacheSnapshot()
        try cached.apply(page(revision: 3, at: time.addingTimeInterval(-1), id: oldID))
        await cache.finishLoad(cached)
        await source.waitForRequests(2)
        #expect(await source.request(at: 1) == [oldID])
        #expect(!controller.state.isSubjectVerified(oldID))
        let retired = CurrentInboxResponse(items: [], retired: [.init(subjectId: oldID, reason: .notFound, version: nil)],
            total: 1, cursor: nil, hasMore: false, counts: .init(actionable: 0, currentUnread: 1), nextExpiryAt: nil,
            serverTime: time.addingTimeInterval(1))
        await source.complete(1, with: .success(retired))
        _ = await recorder.next { $0.snapshot.retired[oldID] != nil }
        #expect(controller.state.snapshot.subjects[oldID] == nil)
        controller.deactivate(); await source.finish()
    }

    @Test func streamRevocationCancelsInFlightReadAndRejectsLateHints() async throws {
        let source = ControlledCurrentSource(), cache = SuspendedCurrentCache(), recorder = CurrentStateRecorder()
        let controller = try owner(source: source, cache: cache, recorder: recorder)
        controller.activate(); await source.waitForRequests(1)
        let (joined, signal) = AsyncStream<Void>.makeStream()
        let waiter = Task { signal.yield(()); await controller.refresh() }
        for await _ in joined { break }
        source.hints.finish(throwing: InboxRemoteError.unauthorized)
        _ = await recorder.next { $0.connection == .unauthorized }
        controller.receive(.reconcile)
        await source.complete(0, with: .success(page(revision: 4)))
        await waiter.value
        #expect(controller.state.connection == .unauthorized)
        #expect(controller.state.snapshot.subjects.isEmpty)
        #expect(await source.requestCount == 1)
        await cache.finishLoad(CurrentCacheSnapshot()); await source.finish()
    }

    @Test func failedProtectedReadDoesNotPreventCurrentFetchOrOverwriteUnknownFences() async throws {
        let source = ControlledCurrentSource(), cache = SuspendedCurrentCache(), recorder = CurrentStateRecorder()
        let controller = try owner(source: source, cache: cache, recorder: recorder)
        controller.activate(); await source.waitForRequests(1)
        await cache.failLoad()
        _ = await recorder.next { $0.persistence == .unavailable }
        await source.complete(0, with: .success(page(revision: 1)))
        let current = await recorder.next { $0.connection == .current }
        #expect(current.snapshot.subjects.count == 1)
        #expect(current.persistence == .unavailable)
        #expect(await cache.saves == 0)
        controller.deactivate(); await source.finish()
    }

    private var subjectID: String { "sub_11111111-1111-1111-1111-111111111111" }
    private var time: Date { Date(timeIntervalSince1970: 1_800_000_000) }
    private func owner(source: ControlledCurrentSource, cache: SuspendedCurrentCache, recorder: CurrentStateRecorder) throws -> CurrentStateController {
        let scope = SessionScope(storage: try StorageScope(serverOrigin: URL(string: "https://example.test")!, accountID: "account", deviceID: "device"), credentialVersion: 1)
        return CurrentStateController(scope: scope, source: source, cache: cache, changed: recorder.record)
    }
    private func page(revision: Int, at: Date? = nil, targeted: Bool = false, id: String? = nil) -> CurrentInboxResponse {
        let item = CurrentSubjectProjection(subjectId: id ?? subjectID, notificationId: "ntf_11111111-1111-1111-1111-111111111111", kind: .notice,
            version: .init(generation: 1, revision: revision), title: "Current", summary: "Summary", source: "Source",
            createdAt: time, updatedAt: at ?? time, occurredAt: time, acceptedAt: time, readAt: nil,
            currentUntil: time.addingTimeInterval(900), freshUntil: nil, deliverUntil: time.addingTimeInterval(60), freshness: .unknown,
            interaction: nil, activity: nil, resources: nil)
        return .init(items: [item], retired: [], total: 500, cursor: targeted ? nil : "page-two", hasMore: !targeted,
                     counts: .init(actionable: 500, currentUnread: 500), nextExpiryAt: time.addingTimeInterval(900), serverTime: at ?? time)
    }
}

@MainActor
private final class CurrentStateRecorder {
    private let stream: AsyncStream<CurrentRuntimeState>
    private let continuation: AsyncStream<CurrentRuntimeState>.Continuation
    init() { (stream, continuation) = AsyncStream.makeStream() }
    func record(_ state: CurrentRuntimeState) { continuation.yield(state) }
    func next(where predicate: (CurrentRuntimeState) -> Bool) async -> CurrentRuntimeState {
        for await value in stream where predicate(value) { return value }
        preconditionFailure("Recorder ended unexpectedly")
    }
}

private actor ControlledCurrentSource: CurrentStateSource {
    nonisolated let stream: AsyncThrowingStream<CurrentChangeHint, Error>
    nonisolated let hints: AsyncThrowingStream<CurrentChangeHint, Error>.Continuation
    private var requests: [[String]?] = []
    private var continuations: [Int: CheckedContinuation<CurrentInboxResponse, Error>] = [:]
    private var waiters: [(Int, CheckedContinuation<Void, Never>)] = []
    init() { (stream, hints) = AsyncThrowingStream.makeStream() }
    var requestCount: Int { requests.count }
    func request(at index: Int) -> [String]? { requests[index] }
    func waitForRequests(_ count: Int) async {
        if requests.count >= count { return }
        await withCheckedContinuation { waiters.append((count, $0)) }
    }
    func fetchCurrent(ids: [String]?) async throws -> CurrentInboxResponse {
        let index = requests.count; requests.append(ids)
        return try await withCheckedThrowingContinuation { continuation in
            continuations[index] = continuation
            let ready = waiters.filter { $0.0 <= requests.count }; waiters.removeAll { $0.0 <= requests.count }
            for waiter in ready { waiter.1.resume() }
        }
    }
    func fetchCurrentPage(after cursor: String?) async throws -> CurrentInboxResponse { try await fetchCurrent(ids: nil) }
    func fetchPending(after cursor: String?, limit: Int) async throws -> PendingCurrentPage { throw InboxRemoteError.unavailable }
    nonisolated func changes() -> AsyncThrowingStream<CurrentChangeHint, Error> { stream }
    func complete(_ index: Int, with result: Result<CurrentInboxResponse, Error>) { continuations.removeValue(forKey: index)?.resume(with: result) }
    func finish() {
        hints.finish()
        for continuation in continuations.values { continuation.resume(throwing: CancellationError()) }
        continuations = [:]
    }
}

private actor SuspendedCurrentCache: CurrentStateCaching {
    private var continuation: CheckedContinuation<CurrentCacheSnapshot, Error>?
    private var result: Result<CurrentCacheSnapshot, Error>?
    private(set) var saves = 0
    func load() async throws -> CurrentCacheSnapshot {
        if let result { return try result.get() }
        return try await withCheckedThrowingContinuation { continuation = $0 }
    }
    func save(_ snapshot: CurrentCacheSnapshot) { saves += 1 }
    func finishLoad(_ value: CurrentCacheSnapshot) { result = .success(value); continuation?.resume(returning: value); continuation = nil }
    func failLoad() { result = .failure(InboxStorageError.unavailable); continuation?.resume(throwing: InboxStorageError.unavailable); continuation = nil }
}
