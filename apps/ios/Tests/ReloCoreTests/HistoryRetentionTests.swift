import Foundation
import Testing
@testable import ReloCore

@Suite("History retention")
struct HistoryRetentionTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    func message(daysAgo: Double, interaction: InboxInteraction? = nil) -> InboxItem {
        InboxItem(id: "ntf_\(daysAgo)", kind: .notification, sourceName: "Codex", title: "Done",
                  createdAt: now.addingTimeInterval(-daysAgo * 86_400), interaction: interaction)
    }

    @Test("The window and a manual clear combine; the later one wins")
    func cutoff() {
        #expect(HistoryRetention.twoDays.visibleSince(clearedAt: nil, now: now) == now.addingTimeInterval(-2 * 86_400))
        let cleared = now.addingTimeInterval(-3600)
        #expect(HistoryRetention.twoDays.visibleSince(clearedAt: cleared, now: now) == cleared)
        #expect(HistoryRetention.everything.visibleSince(clearedAt: nil, now: now) == nil)
        #expect(HistoryRetention.standard == .twoDays)
    }

    @Test("Old messages hide; waiting requests never do")
    func visibility() {
        let since = HistoryRetention.twoDays.visibleSince(clearedAt: nil, now: now)
        #expect(HistoryRetention.isVisible(message(daysAgo: 1), since: since, now: now))
        #expect(!HistoryRetention.isVisible(message(daysAgo: 3), since: since, now: now))
        let waiting = InboxInteraction(id: "int_1", kind: .approval, prompt: "Ship?", state: .pending, expiresAt: now + 600)
        #expect(HistoryRetention.isVisible(message(daysAgo: 3, interaction: waiting), since: since, now: now))
    }

    @Test("A Live Activity with no end evidence is over after 12 hours, and clears with history")
    func staleActivities() {
        let old = InboxItem(id: "ntf_a", kind: .liveActivity, sourceName: "Relo", title: "Approval needed",
                            createdAt: now.addingTimeInterval(-20 * 3600))
        let fresh = InboxItem(id: "ntf_b", kind: .liveActivity, sourceName: "Relo", title: "Deploying",
                              createdAt: now.addingTimeInterval(-600))
        #expect(InboxAttentionProjection.activityEnding(old, now: now) == .ended)
        #expect(InboxAttentionProjection.activityEnding(fresh, now: now) == nil)
        let cleared = now.addingTimeInterval(-60)
        #expect(!HistoryRetention.isVisible(old, since: cleared, now: now))
        #expect(HistoryRetention.isVisible(fresh, since: cleared, now: now), "a possibly running activity stays")
    }
}
