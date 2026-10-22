import Foundation
@testable import ReloCore
import Testing

@Suite("Now colors mean something")
struct NowSignalTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func outcomesMapToOneMeaningEach() {
        #expect(NowSignal.of(.done) == .done)
        #expect(NowSignal.of(.running) == .running)
        #expect(NowSignal.of(.waitingForYou) == .needsYou)
        #expect(NowSignal.of(.stopped) == .failed)
        #expect(NowSignal.of(.expired) == .attention)
        #expect(NowSignal.of(.answered("Approved")) == .done)
        #expect(NowSignal.of(.answered("Declined")) == .attention)
        #expect(NowSignal.of(.message) == .message)
    }

    @Test func theMixCountsTodayAndWhatIsLiveOnce() {
        let done = HistoryRowProjection.row(InboxItem(id: "ntf_done", kind: .liveActivity, sourceName: "A", title: "T",
            createdAt: now, activity: .init(state: "ended", outcome: "completed", updates: 3, startedAt: now)), now: now)
        let message = HistoryRowProjection.row(InboxItem(id: "ntf_msg", kind: .notification, sourceName: "A",
            title: "Hi", createdAt: now), now: now)
        let live = HistoryRowProjection.row(InboxItem(id: "ntf_live", kind: .liveActivity, sourceName: "A", title: "L",
            createdAt: now, activity: .init(state: "active", updates: 1, startedAt: now)), now: now)
        let mix = NowMix.make(today: [done, message, live], needsYou: 2, running: 1)
        #expect(mix.counts == [.done: 1, .message: 1, .needsYou: 2, .running: 1])
        #expect(mix.total == 5)
        #expect(mix.signal(at: 0.1) == .done)
        #expect(mix.signal(at: 0.99) == .message)
    }


    private func liveItem(_ card: String, startedAgo: TimeInterval, updatedAgo: TimeInterval) -> InboxItem {
        InboxItem(id: "ntf_\(card)", kind: .liveActivity, sourceName: "Claude Code", title: card,
                  createdAt: now.addingTimeInterval(-updatedAgo),
                  activityEvent: .init(id: card, operation: "update", generation: 1, sequence: 2),
                  activity: .init(state: "active", updates: 2, startedAt: now.addingTimeInterval(-startedAgo)))
    }

    private func runningSubject(_ card: String) -> CurrentSubjectProjection {
        CurrentSubjectProjection(subjectId: card, notificationId: nil, kind: .progress,
            version: CurrentVersion(generation: 1, revision: 1), title: card, summary: "", source: "Claude Code",
            createdAt: now, updatedAt: now, occurredAt: nil, acceptedAt: now, readAt: nil, currentUntil: nil,
            freshUntil: nil, deliverUntil: now, freshness: .fresh, interaction: nil,
            activity: CurrentActivity(id: card, generation: 1, sequence: 1, status: nil, progress: nil), resources: nil)
    }


}

@Suite("Relo's cues are earned once (ADR 0013)")
struct ReloCueGateTests {
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func theFirstObservationIsTheBaselineAndMakesNoSound() {
        var gate = ReloCueGate()
        #expect(gate.observe([.needsYou: ["q1"]], at: t0) == nil)
        #expect(gate.observe([.needsYou: ["q1"]], at: t0 + 10) == nil)
    }

    @Test func aNewMomentCuesOnceAndNeverAgain() {
        var gate = ReloCueGate()
        _ = gate.observe([:], at: t0)
        let r1 = gate.observe([.needsYou: ["q1"]], at: t0 + 5)
        #expect(r1 == .needsYou)
        // Still open on the next observations, a remount or a reconnect: no second cue.
        let r2 = gate.observe([.needsYou: ["q1"]], at: t0 + 30)
        #expect(r2 == nil)
        let r3 = gate.observe([.needsYou: ["q1", "q2"]], at: t0 + 40)
        #expect(r3 == .needsYou)
    }

    @Test func theHighestMomentOfABatchWinsAndOnlyOneCuePlays() {
        var gate = ReloCueGate()
        _ = gate.observe([:], at: t0)
        let cue = gate.observe([.done: ["w1"], .failed: ["w2"], .yourTurn: ["s1"]], at: t0 + 5)
        #expect(cue == .failed)
        // The others were consumed with the batch: they do not cue later.
        let r4 = gate.observe([.done: ["w1"], .failed: ["w2"], .yourTurn: ["s1"]], at: t0 + 60)
        #expect(r4 == nil)
    }

    @Test func atMostOneCueEveryTwoSeconds() {
        var gate = ReloCueGate()
        _ = gate.observe([:], at: t0)
        let r5 = gate.observe([.done: ["a"]], at: t0 + 5)
        #expect(r5 == .done)
        let r6 = gate.observe([.done: ["a", "b"]], at: t0 + 6)
        #expect(r6 == nil)
        let r7 = gate.observe([.done: ["a", "b", "c"]], at: t0 + 7.5)
        #expect(r7 == .done)
    }

    @Test func quietAndLookedAtMomentsAreConsumedWithoutACue() {
        var gate = ReloCueGate()
        _ = gate.observe([:], at: t0)
        let r8 = gate.observe([.needsYou: ["q1"]], at: t0 + 5, quiet: true)
        #expect(r8 == nil)
        let r9 = gate.observe([.needsYou: ["q1"]], at: t0 + 30)
        #expect(r9 == nil)
        let r10 = gate.observe([.done: ["w1"]], at: t0 + 40, looking: ["w1"])
        #expect(r10 == nil)
        let r11 = gate.observe([.done: ["w1"]], at: t0 + 60)
        #expect(r11 == nil)
    }

    @Test func aReturnFromTheBackgroundIsABaselineAgain() {
        var gate = ReloCueGate()
        _ = gate.observe([:], at: t0)
        gate.rebaseline()
        let r12 = gate.observe([.needsYou: ["q9"]], at: t0 + 100)
        #expect(r12 == nil)
    }

    @Test func theOwnersOwnMomentsCueOncePerId() {
        var gate = ReloCueGate()
        let r13 = gate.admit(.sent, id: "ntf_1", at: t0)
        #expect(r13)
        let r14 = gate.admit(.sent, id: "ntf_1", at: t0 + 10)
        #expect(!r14)
        // Spaced: a second moment inside two seconds is silent.
        let r15 = gate.admit(.linked, id: "link", at: t0 + 1)
        #expect(!r15)
        let r16 = gate.admit(.linked, id: "link2", at: t0 + 3)
        #expect(r16)
    }

    @Test func everyCueHasItsNamedFile() {
        #expect(ReloCue.allCases.map(\.fileName).sorted() == ["done.caf", "failed.caf", "linked.caf", "needs-you.caf", "sent.caf", "your-turn.caf"])
    }
}
