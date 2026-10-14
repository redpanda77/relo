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
