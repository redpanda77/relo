import Foundation

public enum InboxHistoryProjection {
    public static let pageSize = 50

    public static func collapsedActivities(_ items: [InboxItem]) -> [InboxItem] {
        var ordinary: [InboxItem] = []
        var activities: [String: InboxItem] = [:]
        for item in items {
            guard item.kind == .liveActivity else {
                ordinary.append(item)
                continue
            }
            guard let activityID = cardID(item) else {
                ordinary.append(item)
                continue
            }
            guard let current = activities[activityID] else {
                activities[activityID] = item
                continue
            }
            let currentSequence = current.activitySummary?.sequence ?? current.liveActivity?.sequence ?? current.activityEvent?.sequence ?? -1
            let candidateSequence = item.activitySummary?.sequence ?? item.liveActivity?.sequence ?? item.activityEvent?.sequence ?? -1
            if candidateSequence > currentSequence
                || (candidateSequence == currentSequence && item.createdAt > current.createdAt) {
                activities[activityID] = item
            }
        }
        return (ordinary + activities.values).sorted { left, right in
            let leftDate = left.activitySummary?.updatedAt ?? left.createdAt
            let rightDate = right.activitySummary?.updatedAt ?? right.createdAt
            if leftDate != rightDate { return leftDate > rightDate }
            return left.id > right.id
        }
    }

    /// History as the owner reads it: one row per card, without a work's outcome notification while the card
    /// of the round it reports is there (the server names that card in `outcomeOf`), so a round shows once.
    public static func readable(_ items: [InboxItem]) -> [InboxItem] {
        let collapsed = collapsedActivities(items)
        let cards = Set(collapsed.compactMap(cardID))
        return collapsed.filter { item in item.outcomeOf.map { !cards.contains($0) } ?? true }
    }

    /// The card an event belongs to, from whichever identity the event still carries.
    public static func cardID(_ item: InboxItem) -> String? {
        guard item.kind == .liveActivity else { return nil }
        return item.activitySummary?.id ?? item.liveActivity?.activityId ?? item.activityEvent?.id
    }

    public static func activeActivities(
        _ items: [InboxItem],
        now: Date = .now
    ) -> [InboxItem] {
        collapsedActivities(items).filter { item in
            if let summary = item.activitySummary {
                guard summary.state == "active" else { return false }
                if let staleAt = summary.staleAt, staleAt <= now { return false }
                if let expiresAt = summary.expiresAt, expiresAt <= now { return false }
                return true
            }
            guard let command = item.liveActivity, command.operation != .end else { return false }
            if let staleAt = command.staleAt, staleAt <= now { return false }
            if let expiresAt = command.expiresAt, expiresAt <= now { return false }
            return true
        }
    }

    public static func nextVisibleLimit(current: Int, available: Int) -> Int {
        min(available, max(pageSize, current + pageSize))
    }

    public static func matchesSearch(_ item: InboxItem, query: String) -> Bool {
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return true }
        return [
            item.sourceName,
            item.title,
            item.detail,
            item.result,
            item.context?.providerName,
            item.context?.computer,
            item.context?.project,
            item.context?.threadName,
            item.context?.taskTitle,
            item.activitySummary?.title,
            item.activitySummary?.status,
            item.activitySummary?.detail,
            item.activitySummary?.context?.project,
            item.activitySummary?.context?.threadName,
            item.activitySummary?.context?.taskTitle,
        ]
        .compactMap { $0 }
        .contains { $0.localizedCaseInsensitiveContains(normalized) }
    }
}
