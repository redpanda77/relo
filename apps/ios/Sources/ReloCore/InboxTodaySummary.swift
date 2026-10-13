import Foundation

public struct InboxTodaySummary: Equatable, Sendable {
    public let notifications: Int
    public let liveActivities: Int
    public let active: Int
    /// Live Activity runs seen today that are no longer active.
    public let finished: Int
    /// Everything that happened today: notifications plus Live Activity runs (each counted once).
    /// The hero's headline number, so it never contradicts the "Live Activities today" line.
    public var total: Int { notifications + liveActivities }

    public init(notifications: Int, liveActivities: Int, active: Int, finished: Int) {
        self.notifications = notifications; self.liveActivities = liveActivities
        self.active = active; self.finished = finished
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
