import Foundation

/// How long a foreground phone waits before asking a server it cannot reach again.
/// One schedule for every retry loop: 2s, 5s, 10s, 30s, then 60s, each jittered.
public struct ReconnectBackoff: Sendable, Equatable {
    public static let standard = ReconnectBackoff()
    public let schedule: [Duration]
    public let jitter: Double

    public init(schedule: [Duration] = [.seconds(2), .seconds(5), .seconds(10), .seconds(30), .seconds(60)], jitter: Double = 0.2) {
        self.schedule = schedule.isEmpty ? [.seconds(60)] : schedule; self.jitter = max(0, min(jitter, 0.5))
    }

    /// `attempt` is zero-based and saturates on the last step; `randomUnit` is in 0...1 (0.5 is no jitter).
    public func delay(attempt: Int, randomUnit: Double = 0.5) -> Duration {
        let base = schedule[max(0, min(attempt, schedule.count - 1))]
        let unit = max(0, min(randomUnit, 1))
        let factor = 1 + jitter * (unit * 2 - 1)
        let cap = schedule[schedule.count - 1] * (1 + jitter)
        return min(base * factor, cap)
    }
}

/// A short outage is silent: the unreachable banner only appears once the server has been
/// unreachable for `grace`, and clears the moment a sync succeeds.
public struct OutageBannerPolicy: Sendable, Equatable {
    public static let standard = OutageBannerPolicy()
    public let grace: TimeInterval
    public init(grace: TimeInterval = 20) { self.grace = grace }

    /// Seconds until the banner should appear, or nil when there is no outage. Zero means show now.
    public func remaining(offlineSince: Date?, now: Date) -> TimeInterval? {
        guard let offlineSince else { return nil }
        return max(0, grace - now.timeIntervalSince(offlineSince))
    }
    public func isVisible(offlineSince: Date?, now: Date) -> Bool { remaining(offlineSince: offlineSince, now: now) == 0 }
}
