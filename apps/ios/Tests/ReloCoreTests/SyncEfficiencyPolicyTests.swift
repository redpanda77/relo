@testable import ReloTransport
import Foundation
import Testing
@testable import ReloCore

@Suite("Sync efficiency policies")
struct SyncEfficiencyPolicyTests {
    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    private func ask(_ gate: inout NativeReconciliationGate, scope: String, items: [InboxItem], now: Date, force: Bool = false) -> Bool {
        gate.shouldReconcile(scope: scope, items: items, now: now, force: force)
    }

    private func live(_ id: String, sequence: Int) -> InboxItem {
        let presentation = LiveActivityPresentation(
            title: "Release", subtitle: nil, status: "Working", components: [],
            surfaces: .init(lockScreen: [], expandedBottom: [], compactTrailing: [], minimal: []),
            state: .init(kind: "active", tone: "live", icon: .active), behavior: .progress)
        return InboxItem(id: id, kind: .liveActivity, sourceName: "Claude Code", title: "Release", createdAt: t0,
            liveActivity: LiveActivityCommand(operation: .update, activityId: "act_" + id, generation: 1,
                targetDeviceId: "dev_outcome123456", style: "steps", sourceName: "Claude Code", headline: "Release",
                status: "Working", sequence: sequence, presentation: presentation))
    }

    @Test func reconciliationRunsOnChangeOrAtTheFloorOnly() {
        var gate = NativeReconciliationGate()
        let items = [live("ntf_aaaaaaaaaaaa", sequence: 1)]
        #expect(ask(&gate, scope: "s", items: items, now: t0))
        #expect(!ask(&gate, scope: "s", items: items, now: t0.addingTimeInterval(10)))
        #expect(!ask(&gate, scope: "s", items: items, now: t0.addingTimeInterval(59)))
        // A new version of the same activity, then a new activity, each reconcile at once.
        let bumped = [live("ntf_aaaaaaaaaaaa", sequence: 2)]
        #expect(ask(&gate, scope: "s", items: bumped, now: t0.addingTimeInterval(20)))
        #expect(ask(&gate, scope: "s", items: bumped + [live("ntf_bbbbbbbbbbbb", sequence: 1)], now: t0.addingTimeInterval(21)))
        // Unchanged: waits for the floor measured from the last reconciliation.
        let same = bumped + [live("ntf_bbbbbbbbbbbb", sequence: 1)]
        #expect(!ask(&gate, scope: "s", items: same, now: t0.addingTimeInterval(80)))
        #expect(ask(&gate, scope: "s", items: same, now: t0.addingTimeInterval(81)))
    }

    @Test func explicitRefreshAndANewScopeAlwaysReconcile() {
        var gate = NativeReconciliationGate()
        #expect(ask(&gate, scope: "s", items: [], now: t0))
        #expect(!ask(&gate, scope: "s", items: [], now: t0.addingTimeInterval(1)))
        #expect(ask(&gate, scope: "s", items: [], now: t0.addingTimeInterval(2), force: true))
        #expect(ask(&gate, scope: "other", items: [], now: t0.addingTimeInterval(3)))
    }

    @Test func failuresBackOffFromTwoToSixtySecondsAndResetOnSuccess() {
        var gate = RefreshFailureGate()
        #expect(!gate.isBlocked(at: t0))
        var waits: [Double] = []
        for _ in 0..<8 {
            gate.recordFailure(at: t0, randomUnit: 0.5)
            waits.append(gate.blockedUntil!.timeIntervalSince(t0))
        }
        #expect(waits == [2, 4, 8, 16, 32, 60, 60, 60])
        #expect(gate.isBlocked(at: t0.addingTimeInterval(59)) && !gate.isBlocked(at: t0.addingTimeInterval(60)))
        gate.recordFailure(at: t0, randomUnit: 0); #expect(gate.blockedUntil!.timeIntervalSince(t0) >= 48)
        gate.recordFailure(at: t0, randomUnit: 1); #expect(gate.blockedUntil!.timeIntervalSince(t0) <= 72)
        gate.recordSuccess()
        #expect(!gate.isBlocked(at: t0) && gate.failures == 0)
        gate.recordFailure(at: t0, randomUnit: 0.5)
        #expect(gate.blockedUntil!.timeIntervalSince(t0) == 2)
    }

    @Test func currentStateBodyCapIsFourMiBByDeclaredOrActualSize() throws {
        try HTTPCurrentStateSource.checkSize(expected: -1, actual: 4_194_304)
        try HTTPCurrentStateSource.checkSize(expected: 4_194_304, actual: 10)
        #expect(throws: InboxRemoteError.incompatibleResponse) { try HTTPCurrentStateSource.checkSize(expected: 4_194_305, actual: 10) }
        #expect(throws: InboxRemoteError.incompatibleResponse) { try HTTPCurrentStateSource.checkSize(expected: -1, actual: 4_194_305) }
    }
}
