import Foundation
@testable import ReloCore
import Testing

@Suite("Live Activity abandonment")
struct LiveActivityAbandonmentPolicyTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func aCurrentCardIsKept() {
        #expect(LiveActivityAbandonmentPolicy.reason(expiresAt: now.addingTimeInterval(3_600),
            staleAt: now.addingTimeInterval(600), now: now) == nil)
        #expect(LiveActivityAbandonmentPolicy.reason(expiresAt: nil, staleAt: nil, now: now) == nil)
    }

    @Test func aStaleCardGetsTheServerIdleWindowPlusMargin() {
        let justStale = now.addingTimeInterval(-60)
        #expect(LiveActivityAbandonmentPolicy.reason(expiresAt: nil, staleAt: justStale, now: now) == nil)
        let pastServerIdleEnd = now.addingTimeInterval(-11 * 60)
        #expect(LiveActivityAbandonmentPolicy.reason(expiresAt: nil, staleAt: pastServerIdleEnd, now: now) == nil)
        let longAbandoned = now.addingTimeInterval(-31 * 60)
        #expect(LiveActivityAbandonmentPolicy.reason(expiresAt: nil, staleAt: longAbandoned, now: now) == .abandoned)
    }

    @Test func anExpiredCardEndsWhateverItsFreshness() {
        #expect(LiveActivityAbandonmentPolicy.reason(expiresAt: now, staleAt: now.addingTimeInterval(600), now: now) == .expired)
    }

    @Test func aRunningAgentsCardIsKeptPastStaleButNotPastExpiry() {
        let longStale = now.addingTimeInterval(-90 * 60)
        #expect(LiveActivityAbandonmentPolicy.reason(expiresAt: nil, staleAt: longStale, sessionRunning: true, now: now) == nil)
        #expect(LiveActivityAbandonmentPolicy.reason(expiresAt: now, staleAt: longStale, sessionRunning: true, now: now) == .expired)
    }
}
