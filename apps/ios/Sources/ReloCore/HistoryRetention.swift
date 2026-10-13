import Foundation

/// How long this iPhone keeps showing past notifications. Hiding is local: the server and the
/// dashboard keep everything. Work that still needs the person is never hidden.
public enum HistoryRetention: String, CaseIterable, Identifiable, Sendable {
    case oneDay = "1d", twoDays = "2d", oneWeek = "7d", oneMonth = "30d", everything = "all"

    public static let standard: Self = .twoDays
    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .oneDay: "1 day"
        case .twoDays: "2 days"
        case .oneWeek: "1 week"
        case .oneMonth: "1 month"
        case .everything: "Everything"
        }
    }

    var interval: TimeInterval? {
        switch self {
        case .oneDay: 86_400
        case .twoDays: 2 * 86_400
        case .oneWeek: 7 * 86_400
        case .oneMonth: 30 * 86_400
        case .everything: nil
        }
    }

    /// The earliest moment still shown: the retention window or the last clear, whichever is later.
    public func visibleSince(clearedAt: Date?, now: Date) -> Date? {
        let window = interval.map { now.addingTimeInterval(-$0) }
        switch (window, clearedAt) {
        case let (window?, cleared?): return max(window, cleared)
        case let (window?, nil): return window
        case let (nil, cleared?): return cleared
        case (nil, nil): return nil
        }
    }

    public static func isVisible(_ item: InboxItem, since: Date?, now: Date) -> Bool {
        guard let since else { return true }
        if let interaction = item.interaction, interaction.state == .pending, interaction.expiresAt > now { return true }
        if item.kind == .liveActivity, !InboxAttentionProjection.activityIsFinished(item, now: now) { return true }
        return (item.activitySummary?.updatedAt ?? item.createdAt) >= since
    }
}
