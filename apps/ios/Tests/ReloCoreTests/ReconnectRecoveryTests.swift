@testable import ReloRuntime
import Foundation
import Testing
@testable import ReloCore

@Suite("Reconnect after an outage", .timeLimit(.minutes(1)))
@MainActor
struct ReconnectRecoveryTests {
    @Test func backoffScheduleIsBoundedAndJittered() {
        let policy = ReconnectBackoff.standard
        #expect((0..<7).map { policy.delay(attempt: $0) } == [.seconds(2), .seconds(5), .seconds(10), .seconds(30), .seconds(60), .seconds(60), .seconds(60)])
        for unit in stride(from: 0.0, through: 1.0, by: 0.25) {
            for attempt in [0, 3, 4, 500, Int.max] {
                let delay = policy.delay(attempt: attempt, randomUnit: unit)
                let base = policy.delay(attempt: attempt)
                #expect(delay >= base * 0.8 && delay <= base * 1.2)
                #expect(delay <= .seconds(72))
            }
        }
        #expect(policy.delay(attempt: -3) == .seconds(2))
    }

    @Test func bannerWaitsOutABriefOutage() {
        let policy = OutageBannerPolicy.standard, start = Date(timeIntervalSince1970: 1_800_000_000)
        #expect(policy.remaining(offlineSince: nil, now: start) == nil)
        #expect(!policy.isVisible(offlineSince: start, now: start.addingTimeInterval(19)))
        #expect(policy.remaining(offlineSince: start, now: start.addingTimeInterval(5)) == 15)
        #expect(policy.isVisible(offlineSince: start, now: start.addingTimeInterval(20)))
        #expect(!policy.isVisible(offlineSince: nil, now: start))
    }

    @Test func serverDownForSeveralAttemptsRecoversWithoutUserAction() async throws {
        let h = Harness(failures: 4)
        h.controller.activate()
        _ = await h.recorder.next { $0.connection == .current }
        #expect(h.sleeper.recovery == [.seconds(2), .seconds(5), .seconds(10), .seconds(30)])
        #expect(await h.source.fetches == 5)
        h.controller.deactivate(); await h.source.finish()
    }

    @Test func streamDropWhileServerRestartsReopensStreamAndRecovers() async throws {
        let h = Harness(failures: 0)
        h.controller.activate()
        _ = await h.recorder.next { $0.connection == .current }
        await h.source.setFailures(3)
        await h.source.dropStream()
        _ = await h.recorder.next { $0.connection == .offline }
        _ = await h.recorder.next { $0.connection == .current }
        // Concurrent reads share the failure budget, so only the schedule shape is fixed.
        let waits = h.sleeper.recovery
        #expect(waits.count >= 2 && waits == Array([Duration.seconds(2), .seconds(5), .seconds(10), .seconds(30), .seconds(60)].prefix(waits.count)))
        #expect(await h.source.streamOpens == 2)
        h.controller.deactivate(); await h.source.finish()
    }

    @Test func incompatibleReplyRetriesOnTheBackoffInsteadOfStayingDead() async throws {
        let h = Harness(failures: 0)
        await h.source.setFailure(InboxRemoteError.incompatibleResponse)
        await h.source.setFailures(2)
        h.controller.activate()
        _ = await h.recorder.next { $0.connection == .incompatible }
        _ = await h.recorder.next { $0.connection == .current }
        #expect(h.sleeper.recovery.first == .seconds(2))
        h.controller.deactivate(); await h.source.finish()
    }

    @Test func networkPathChangeRetriesImmediatelyInsteadOfWaitingOutTheBackoff() async throws {
        let h = Harness(failures: 1)
        h.sleeper.hold = true
        h.controller.activate()
        _ = await h.recorder.next { $0.connection == .offline }
        await h.source.setFailures(0)
        h.controller.retryNow()
        _ = await h.recorder.next { $0.connection == .current }
        #expect(h.sleeper.recovery.isEmpty)
        h.controller.deactivate(); await h.source.finish()
    }

    @Test func backgroundWakeupDoesNotRunARetryLoop() async throws {
        let h = Harness(failures: 100)
        h.controller.activate(observeChanges: false)
        _ = await h.recorder.next { $0.connection == .offline }
        for _ in 0..<50 { await Task.yield() }
        #expect(h.sleeper.recovery.isEmpty)
        #expect(await h.source.fetches == 1)
        h.controller.deactivate()
        #expect(h.controller.state.connection == .inactive)
        await h.source.finish()
    }

    @Test func deactivatingStopsTheRetryLoop() async throws {
        let h = Harness(failures: 100)
        h.sleeper.hold = true
        h.controller.activate()
        _ = await h.recorder.next { $0.connection == .offline }
        h.controller.deactivate()
        for _ in 0..<50 { await Task.yield() }
        #expect(await h.source.fetches == 1)
        await h.source.finish()
    }
}

@MainActor
private struct Harness {
    let source: ScriptedSource, sleeper = Sleeper(), recorder = Recorder(), controller: CurrentStateController
    init(failures: Int) {
        source = ScriptedSource(failures: failures)
        let scope = SessionScope(storage: try! StorageScope(serverOrigin: URL(string: "https://example.test")!, accountID: "account", deviceID: "device"), credentialVersion: 1)
        let sleeper = self.sleeper, recorder = self.recorder
        controller = CurrentStateController(scope: scope, source: source, cache: MemoryCache(), instant: { .now }, wallTime: { Date() },
                                            sleep: { try await sleeper.sleep($0) }, changed: recorder.record)
        controller.randomUnit = { 0.5 }
    }
}

/// Recovery waits (under 70 s) are recorded and elapse at once; longer waits (expiry timers) never fire.
private final class Sleeper: @unchecked Sendable {
    private let lock = NSLock()
    private var durations: [Duration] = []
    private var held = false
    var recovery: [Duration] { lock.withLock { durations } }
    var hold: Bool { get { lock.withLock { held } } set { lock.withLock { held = newValue } } }
    func sleep(_ duration: Duration) async throws {
        if duration > .seconds(70) || hold { try await Task.sleep(for: .seconds(3600)); return }
        lock.withLock { durations.append(duration) }
        await Task.yield()
    }
}

@MainActor
private final class Recorder {
    private let stream: AsyncStream<CurrentRuntimeState>
    private let continuation: AsyncStream<CurrentRuntimeState>.Continuation
    init() { (stream, continuation) = AsyncStream.makeStream() }
    func record(_ state: CurrentRuntimeState) { continuation.yield(state) }
    func next(where predicate: (CurrentRuntimeState) -> Bool) async -> CurrentRuntimeState {
        for await value in stream where predicate(value) { return value }
        preconditionFailure("Recorder ended unexpectedly")
    }
}

private actor MemoryCache: CurrentStateCaching {
    func load() async throws -> CurrentCacheSnapshot { CurrentCacheSnapshot() }
    func save(_ snapshot: CurrentCacheSnapshot) {}
}

private actor ScriptedSource: CurrentStateSource {
    private var remainingFailures: Int
    private(set) var fetches = 0, streamOpens = 0
    private var hints: AsyncThrowingStream<CurrentChangeHint, Error>.Continuation?
    init(failures: Int) { remainingFailures = failures }
    private var failure: any Error = InboxRemoteError.unavailable
    func setFailures(_ count: Int) { remainingFailures = count }
    func setFailure(_ error: any Error) { failure = error }
    func dropStream() { hints?.finish(throwing: InboxRemoteError.unavailable) }
    func finish() { hints?.finish() }
    func fetchCurrent(ids: [String]?) async throws -> CurrentInboxResponse {
        fetches += 1
        if remainingFailures > 0 { remainingFailures -= 1; throw failure }
        let time = Date(timeIntervalSince1970: 1_800_000_000)
        let item = CurrentSubjectProjection(subjectId: "sub_11111111-1111-1111-1111-111111111111", notificationId: "ntf_11111111-1111-1111-1111-111111111111", kind: .notice,
            version: .init(generation: 1, revision: 1), title: "Current", summary: "Summary", source: "Source",
            createdAt: time, updatedAt: time, occurredAt: time, acceptedAt: time, readAt: nil,
            currentUntil: time.addingTimeInterval(900), freshUntil: nil, deliverUntil: time.addingTimeInterval(60), freshness: .unknown,
            interaction: nil, activity: nil, resources: nil)
        return .init(items: [item], retired: [], total: 1, cursor: nil, hasMore: false,
                     counts: .init(actionable: 1, currentUnread: 1), nextExpiryAt: time.addingTimeInterval(900), serverTime: time)
    }
    func fetchCurrentPage(after cursor: String?) async throws -> CurrentInboxResponse { try await fetchCurrent(ids: nil) }
    func fetchPending(after cursor: String?, limit: Int) async throws -> PendingCurrentPage { throw InboxRemoteError.unavailable }
    nonisolated func changes() -> AsyncThrowingStream<CurrentChangeHint, Error> {
        let (stream, continuation) = AsyncThrowingStream<CurrentChangeHint, Error>.makeStream()
        Task { await self.opened(continuation) }
        return stream
    }
    private func opened(_ continuation: AsyncThrowingStream<CurrentChangeHint, Error>.Continuation) { streamOpens += 1; hints = continuation }
}
