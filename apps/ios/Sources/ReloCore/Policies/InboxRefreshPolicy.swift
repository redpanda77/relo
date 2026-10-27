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

/// Decides whether the native live-activity reconciliation (`GET api/inbox/live-activities/active`) is worth a
/// request. The call used to run on nearly every maintenance tick; it only matters when the set of live-activity
/// commands in the latest snapshot changed, so otherwise it waits for a floor interval (a safety net for drift
/// the snapshot cannot show, such as an activity the system ended). An explicit refresh always reconciles.
public struct NativeReconciliationGate: Sendable, Equatable {
    public static let floorSeconds: TimeInterval = 60

    private var scope: String?
    private var signature: Set<String> = []
    private var lastAt: Date?

    public init() {}

    /// Identity and version of every live-activity command in the snapshot.
    public static func signature(of items: [InboxItem]) -> Set<String> {
        Set(items.compactMap { item in
            item.liveActivity.map { "\(item.id)|\($0.identity.storageKey)|\($0.sequence ?? 0)|\($0.operation.rawValue)" }
        })
    }

    /// True when a reconciliation should run now; records it as started.
    public mutating func shouldReconcile(scope: String, items: [InboxItem], now: Date, force: Bool = false) -> Bool {
        let current = Self.signature(of: items)
        let due = force || self.scope != scope || current != signature
            || lastAt.map { now.timeIntervalSince($0) >= Self.floorSeconds } ?? true
        guard due else { return false }
        self.scope = scope; signature = current; lastAt = now
        return true
    }
}

/// Backs off snapshot refreshes that follow a failure so a down server is not asked again on every tick.
/// Explicit refreshes (pull to refresh, foreground) ignore the gate but still feed it.
public struct RefreshFailureGate: Sendable, Equatable {
    public static let backoff = ReconnectBackoff(
        schedule: [.seconds(2), .seconds(4), .seconds(8), .seconds(16), .seconds(32), .seconds(60)], jitter: 0.2)

    public private(set) var failures = 0
    public private(set) var blockedUntil: Date?

    public init() {}

    public func isBlocked(at now: Date) -> Bool { blockedUntil.map { now < $0 } ?? false }

    public mutating func recordFailure(at now: Date, randomUnit: Double = .random(in: 0...1)) {
        let delay = Self.backoff.delay(attempt: failures, randomUnit: randomUnit)
        let seconds = Double(delay.components.seconds) + Double(delay.components.attoseconds) / 1e18
        blockedUntil = now.addingTimeInterval(seconds)
        failures += 1
    }

    public mutating func recordSuccess() { failures = 0; blockedUntil = nil }
}
