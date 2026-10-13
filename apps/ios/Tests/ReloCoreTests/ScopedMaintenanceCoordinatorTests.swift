@testable import ReloRuntime
import Foundation
import Testing
@testable import ReloCore

@Suite("Independent scoped maintenance", .timeLimit(.minutes(1)))
@MainActor
struct ScopedMaintenanceCoordinatorTests {
    @Test func completedHistoryRepairReleasesItsSlotBeforeAnotherRequest() async {
        let owner = HistoryRepairCoordinator()
        var calls = 0
        for _ in 0..<100 {
            let result = await owner.repair(scope: "same") { calls += 1; return true }
            #expect(result)
        }
        #expect(calls == 100)
        owner.stop()
    }

    @Test func cancelledHistoryRepairReturnsNoSuccessAndReplacementStartsImmediately() async {
        let owner = HistoryRepairCoordinator(), old = MaintenanceGate(), new = MaintenanceGate()
        let previous = Task { await owner.repair(scope: "old") { await old.wait(); return true } }
        await old.entered()
        owner.stop()
        let replacement = Task { await owner.repair(scope: "new") { await new.wait(); return true } }
        await new.entered()
        old.release()
        #expect(await previous.value == false)
        new.release()
        #expect(await replacement.value)
        owner.stop()
    }

    @Test func suspendedHistoryDoesNotHoldOtherLanes() async {
        let owner = ScopedMaintenanceCoordinator(), history = MaintenanceGate()
        owner.bind(scope: "one")
        owner.request(.history) { await history.wait() }
        await history.entered()
        var completed = Set<ScopedMaintenanceCoordinator.Lane>()
        for lane in [ScopedMaintenanceCoordinator.Lane.commands, .receipts, .health, .nativeActivities] {
            owner.request(lane) { completed.insert(lane) }
        }
        for lane in [ScopedMaintenanceCoordinator.Lane.commands, .receipts, .health, .nativeActivities] { await owner.wait(for: lane) }
        #expect(completed.count == 4)
        history.release(); await owner.wait(for: .history); owner.stop()
    }

    @Test func aBurstRetainsOnlyOneFollowupPerLane() async {
        let owner = ScopedMaintenanceCoordinator(), gate = MaintenanceGate()
        owner.bind(scope: "one")
        var calls = [0]
        owner.request(.commands) { await gate.wait() }
        await gate.entered()
        for index in 1...100 { owner.request(.commands) { calls.append(index) } }
        gate.release(); await owner.wait(for: .commands)
        #expect(calls == [0, 100]); owner.stop()
    }

    @Test func replacementCancelsOldFollowupAndLateCleanupCannotEraseNewWork() async {
        let owner = ScopedMaintenanceCoordinator(), old = MaintenanceGate(), new = MaintenanceGate()
        owner.bind(scope: "old")
        owner.request(.receipts) { await old.wait() }
        await old.entered()
        var calls: [String] = []
        owner.request(.receipts) { calls.append("obsolete") }
        owner.bind(scope: "new")
        owner.request(.receipts) { await new.wait() }
        await new.entered()
        old.release()
        owner.request(.receipts) { calls.append("new") }
        new.release(); await owner.wait(for: .receipts)
        #expect(calls == ["new"]); owner.stop()
    }

    @Test func duplicateForegroundEntryOwnsOnePollAndStopPreventsItsTick() async {
        let entered = MaintenanceGate()
        let owner = ScopedMaintenanceCoordinator(sleep: { _ in
            await entered.signal(); try await Task.sleep(for: .seconds(3_600))
        })
        owner.bind(scope: "one")
        var ticks = 0
        owner.startPolling(delay: { _ in .seconds(1) }, tick: { ticks += 1 })
        owner.startPolling(delay: { _ in .seconds(1) }, tick: { ticks += 1 })
        await entered.entered()
        owner.stop()
        #expect(entered.signals == 1)
        #expect(ticks == 0)
    }
}

@MainActor
private final class MaintenanceGate {
    private let events: AsyncStream<Void>
    private let continuation: AsyncStream<Void>.Continuation
    private var held: CheckedContinuation<Void, Never>?
    private(set) var signals = 0
    init() { (events, continuation) = AsyncStream.makeStream() }
    func signal() { signals += 1; continuation.yield(()) }
    func wait() async { await withCheckedContinuation { held = $0; signal() } }
    func entered() async { for await _ in events { return } }
    func release() { held?.resume(); held = nil }
}
