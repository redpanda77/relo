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

    @Test func aCompleteCurrentFeedDecidesWhatIsLive() {
        let kept = liveItem("act_kept", startedAgo: 3_000, updatedAgo: 600)
        let endedOnServer = liveItem("act_gone", startedAgo: 3_000, updatedAgo: 900)
        let racing = liveItem("act_new", startedAgo: 5, updatedAgo: 5)
        let asOf = now.addingTimeInterval(-60)
        let cards = LiveNowProjection.make(history: [kept, endedOnServer, racing], subjects: [runningSubject("act_kept")],
                                           runningAsOf: asOf, now: now)
        #expect(Set(cards.map(\.id)) == ["act_kept", "act_new"], "History newer than the feed is kept; older and unlisted is not")
        let offline = LiveNowProjection.make(history: [kept, endedOnServer], subjects: [], now: now)
        #expect(offline.count == 2, "without a complete feed History still shows its active cards")
    }

    @Test func liveCardsKeepTheOrderTheyStartedIn() {
        let first = liveItem("act_first", startedAgo: 3_000, updatedAgo: 1)
        let second = liveItem("act_second", startedAgo: 600, updatedAgo: 400)
        let cards = LiveNowProjection.make(history: [first, second], subjects: [], now: now)
        #expect(cards.map(\.id) == ["act_second", "act_first"], "a fresh update does not move a card to the top")
    }
}
