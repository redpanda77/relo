import Foundation

public struct InboxTodaySummary: Equatable, Sendable {
    public let notifications: Int
    public let liveActivities: Int
    public let active: Int
    /// Live Activity runs seen today that are no longer active.
    public let finished: Int
    /// The hero's headline number: notifications plus Live Activity runs, or, once `counting(_:)` sets it, today's
    /// settled work as the strip below counts it (each card update is its own notification: on 19 Oct the raw count
    /// read 236 over a strip of 31).
    public let total: Int

    public init(notifications: Int, liveActivities: Int, active: Int, finished: Int, total: Int? = nil) {
        self.notifications = notifications; self.liveActivities = liveActivities
        self.active = active; self.finished = finished
        self.total = total ?? notifications + liveActivities
    }

    /// The same summary headed by `total` (TodayActivity.settled's row count).
    public func counting(_ total: Int) -> Self {
        Self(notifications: notifications, liveActivities: liveActivities, active: active, finished: finished, total: total)
    }

    public static func make(items: [InboxItem], attention: InboxAttentionProjection.Snapshot,
                            now: Date, calendar: Calendar = .current) -> Self {
        let start = calendar.startOfDay(for: now)
        // History comes first; current cache copies carry the freshest withdrawal evidence.
        var events: [String: InboxItem] = [:]
        for item in items { events[item.id] = item }
        let today = events.values.filter { $0.withdrawnAt == nil && $0.createdAt >= start && $0.createdAt <= now }
        let liveIDs = Set(today.compactMap(activityIdentity))
        let activeIDs = Set((attention.activities + attention.requests + attention.queuedRequests).compactMap(activityIdentity))
        return Self(notifications: today.filter { $0.kind == .notification }.count,
                    liveActivities: liveIDs.count, active: activeIDs.count,
                    finished: liveIDs.subtracting(activeIDs).count)
    }

    public static func needsMoreHistory(snapshot: InboxHistorySnapshot, cachedItems: [InboxItem],
                                        now: Date, calendar: Calendar = .current) -> Bool {
        guard snapshot.hasMore else { return false }
        let start = calendar.startOfDay(for: now)
        // Both sources are newest-first ranges. If either reaches before today,
        // their union already contains today's complete range.
        return !(snapshot.items + cachedItems).contains { $0.createdAt < start }
    }

    private static func activityIdentity(_ item: InboxItem) -> String? {
        guard let id = item.activitySummary?.id ?? item.liveActivity?.activityId else {
            return item.kind == .liveActivity ? item.id : nil
        }
        let generation = item.activitySummary?.generation ?? item.liveActivity?.generation ?? 0
        return "\(id)|\(generation)"
    }
}
