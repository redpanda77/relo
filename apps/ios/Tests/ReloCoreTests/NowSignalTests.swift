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

    @Test func liveNowKeepsQuietCardsAndShowsEachCardOnce() {
        let quiet = InboxItem(id: "ntf_quiet", kind: .liveActivity, sourceName: "Claude Code", title: "Release",
            createdAt: now.addingTimeInterval(-3_600),
            activityEvent: .init(id: "act_one", operation: "update", generation: 1, sequence: 2),
            activity: .init(state: "active", status: "Building", steps: .init(done: 1, total: 3, current: "Test"),
                            updates: 3, startedAt: now.addingTimeInterval(-4_000)))
        let ended = InboxItem(id: "ntf_ended", kind: .liveActivity, sourceName: "Claude Code", title: "Old",
            createdAt: now.addingTimeInterval(-7_200),
            activityEvent: .init(id: "act_two", operation: "end", generation: 1, sequence: 4),
            activity: .init(state: "ended", outcome: "completed", updates: 4, startedAt: now.addingTimeInterval(-8_000)))
        let cards = LiveNowProjection.make(history: [quiet, ended], subjects: [], now: now)
        #expect(cards.map(\.id) == ["act_one"])
        #expect(cards[0].status == "Building")
        #expect(cards[0].quietFor(now: now) != nil)
    }
}
