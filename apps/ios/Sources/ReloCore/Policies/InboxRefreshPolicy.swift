import Foundation

public enum InboxRefreshPolicy {
    /// Pushes and scene activation are the primary triggers. While the app is active, this
    /// bounded cadence closes disabled/unavailable APNs gaps without one-second battery polling.
    public static let foregroundFallbackSeconds: Int64 = 15

    public static func foregroundDelaySeconds(
        afterAttempt attempt: Int,
        directPushAvailable: Bool? = nil
    ) -> Int64 {
        let delays: [Int64] = switch directPushAvailable {
        case false: [2, 3, 5, 8, 10]
        case true: [30, 60]
        case nil: [2, 3, 5, 8, 13, foregroundFallbackSeconds]
        }
        return delays[min(max(0, attempt), delays.count - 1)]
    }
}
