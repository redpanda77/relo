import Foundation

/// A local view of authoritative events. Deadlines change attention, never server outcomes.
public enum InboxAttentionProjection {
    public struct Snapshot: Equatable, Sendable {
        public let requests: [InboxItem]
        public let activities: [InboxItem]
        public let queuedRequests: [InboxItem]
        public let recentNotifications: [InboxItem]
        public let nextTransitionAt: Date?
    }

    public static func make(items: [InboxItem], now: Date,
                            acceptedNotificationIDs: Set<String>,
                            queuedNotificationIDs: Set<String>) -> Snapshot {
        // Detail and Inbox can both contain the same event. Prefer terminal evidence and
        // the newest canonical version before rendering stable, unique row identities.
        var byID: [String: InboxItem] = [:]
        for item in items {
            if let old = byID[item.id] {
                let oldVersion = old.activitySummary?.sequence ?? old.liveActivity?.sequence ?? -1
                let version = item.activitySummary?.sequence ?? item.liveActivity?.sequence ?? -1
                if version < oldVersion { continue }
                if version == oldVersion {
                    if old.withdrawnAt != nil && item.withdrawnAt == nil { continue }
                    if let state = old.activitySummary?.state, state != "active", item.activitySummary?.state == "active" { continue }
                    if old.interaction?.state != .pending && old.interaction != nil && item.interaction?.state == .pending { continue }
                }
            }
            byID[item.id] = item
        }
        let candidates = Array(byID.values)
        var latest: [String: InboxItem] = [:]
        for item in candidates {
            guard let id = item.activitySummary?.id ?? item.liveActivity?.activityId else { continue }
            if let old = latest[id] {
                let oldGeneration = old.activitySummary?.generation ?? old.liveActivity?.generation ?? 0
                let generation = item.activitySummary?.generation ?? item.liveActivity?.generation ?? 0
                let oldVersion = old.activitySummary?.sequence ?? old.liveActivity?.sequence ?? -1
                let version = item.activitySummary?.sequence ?? item.liveActivity?.sequence ?? -1
                if generation < oldGeneration { continue }
                if generation == oldGeneration && (version < oldVersion || (version == oldVersion && item.createdAt < old.createdAt)) { continue }
            }
            latest[id] = item
        }
        let canonical = InboxHistoryProjection.collapsedActivities(candidates.filter { item in
            guard let id = item.activitySummary?.id ?? item.liveActivity?.activityId else { return true }
            return latest[id]?.id == item.id
        })
        let current = canonical.filter { item in
            guard item.withdrawnAt == nil else { return false }
            if let id = item.activitySummary?.id ?? item.liveActivity?.activityId,
               let latestItem = latest[id], latestItem.id != item.id { return false }
            if let summary = item.activitySummary {
                guard summary.state == "active", summary.endedAt == nil else { return false }
            } else if let command = item.liveActivity {
                guard command.operation != .end else { return false }
            }
            return true
        }
        let pending = current.filter {
            $0.interaction?.state == .pending && !acceptedNotificationIDs.contains($0.id)
        }
        let requests = pending.filter { !queuedNotificationIDs.contains($0.id) }
        let queued = pending.filter { queuedNotificationIDs.contains($0.id) }
        let requestIDs = Set(pending.map(\.id))
        let activities = current.filter {
            ($0.activitySummary != nil || $0.liveActivity != nil) && !requestIDs.contains($0.id)
        }
        // "Since you looked" comes from the server's NowSummary; the phone keeps no recent window.
        let recentNotifications: [InboxItem] = []
        let deadlines = current.flatMap { item -> [Date] in
            [item.interaction?.expiresAt,
             item.activitySummary?.expiresAt ?? item.liveActivity?.expiresAt,
             item.activitySummary?.staleAt ?? item.liveActivity?.staleAt]
                .compactMap { $0 }.filter { $0 > now }
        }
        return Snapshot(requests: requests, activities: activities, queuedRequests: queued,
                        recentNotifications: recentNotifications,
                        nextTransitionAt: deadlines.min())
    }

    /// Overdue means a running activity missed its update. A finished or expired activity is
    /// never overdue; it is simply over.
    public static func isStale(_ item: InboxItem, now: Date) -> Bool {
        guard !activityIsFinished(item, now: now) else { return false }
        return (item.activitySummary?.staleAt ?? item.liveActivity?.staleAt).map { $0 <= now } ?? false
    }

    public enum ActivityEnding: Equatable, Sendable { case ended, expired }

    /// How a Live Activity finished, or `nil` while it may still be running (server evidence only).
    public static func activityEnding(_ item: InboxItem, now: Date) -> ActivityEnding? {
        guard item.kind == .liveActivity else { return nil }
        if let summary = item.activitySummary {
            if summary.terminalReason == "expired" { return .expired }
            if summary.endedAt != nil || summary.state != "active" { return .ended }
            if let expires = summary.expiresAt, expires <= now { return .expired }
        } else if let expires = item.liveActivity?.expiresAt, expires <= now {
            return .expired
        }
        return nil
    }

    /// How a card's work turned out. Only the end event carries the final outcome; an older update
    /// of an ended card can say only that the card ended.
    public enum ActivityOutcome: Equatable, Sendable { case running, completed, stopped, expired, ended }

    public static func activityOutcome(_ item: InboxItem, now: Date) -> ActivityOutcome {
        guard let ending = activityEnding(item, now: now) else { return .running }
        if ending == .expired || item.activitySummary?.state == "expired" { return .expired }
        if item.liveActivity?.operation == .end, let kind = item.liveActivity?.presentation.state.kind {
            if kind == "completed" { return .completed }
            if kind == "failed" { return .stopped }
        }
        return .ended
    }

    /// The status the card ended with ("Shipped", "Tests failed"), once the card has ended.
    public static func finalStatus(_ item: InboxItem, now: Date) -> String? {
        guard activityEnding(item, now: now) != nil, let summary = item.activitySummary,
              summary.endedAt != nil || summary.state != "active" else { return nil }
        return summary.status
    }

    public static func activityIsFinished(_ item: InboxItem, now: Date) -> Bool {
        activityEnding(item, now: now) != nil
    }
}

public enum ReloTab: String, CaseIterable, Sendable { case now, history, settings }

public struct ReloNavigationState: Equatable, Sendable {
    public var tab: ReloTab = .now
    public private(set) var detailTab: ReloTab?
    public private(set) var notificationID: String?
    public private(set) var scope: String?
    public init() {}
    public mutating func transition(to scope: String) {
        guard self.scope != scope else { return }
        self = Self(); self.scope = scope
    }
    public mutating func open(_ id: String) {
        guard notificationID != id else { return }
        if tab == .settings { tab = .now }
        notificationID = id; detailTab = tab
    }
    public mutating func dismiss() { notificationID = nil; detailTab = nil }
}

public struct ReplyDraftState: Equatable, Sendable {
    private var scope: String?
    private var drafts: [String: String] = [:]
    public init() {}
    public mutating func transition(to scope: String) {
        guard self.scope != scope else { return }
        self.scope = scope; drafts = [:]
    }
    public func text(requestID: String) -> String { drafts[requestID] ?? "" }
    public mutating func set(_ text: String, requestID: String) { drafts[requestID] = text }
}

public enum ResponsePresentationState: Equatable, Sendable {
    case idle, sending, queued, accepted, rejected, expired, resolved
    public static func make(item: InboxItem, now: Date, feedback: NotificationResponseFeedback?,
                            queued: Bool, submitting: Bool, eligible: Bool) -> Self {
        if feedback?.phase == .accepted { return .accepted }
        if submitting || feedback?.phase == .sending { return .sending }
        guard item.interaction?.state == .pending else { return .resolved }
        guard (item.interaction?.expiresAt ?? .distantPast) > now, eligible else { return .expired }
        if queued || feedback?.phase == .queued { return .queued }
        if feedback?.phase == .rejected { return .rejected }
        return .idle
    }
    public var allowsSubmission: Bool { self == .idle || self == .rejected }
}

public enum ReloHistoryFilter: String, CaseIterable, Identifiable, Sendable {
    case all = "All", notifications = "Messages", decisions = "Decisions", activities = "Live Activities",
         responses = "Responses"
    public var id: Self { self }
    public var symbol: String {
        switch self {
        case .all: "tray.full"
        case .notifications: "bell"
        case .decisions: "checkmark.seal"
        case .activities: "waveform.path"
        case .responses: "arrowshape.turn.up.left"
        }
    }
    /// Messages are plain notifications; anything that asked the person something is a decision.
    public func matches(_ item: InboxItem) -> Bool {
        switch self {
        case .all: true
        case .notifications: item.kind == .notification && item.interaction == nil
        case .decisions: item.interaction != nil
        case .activities: item.kind == .liveActivity
        case .responses: item.kind == .response
        }
    }
}
public enum ReloHistoryResults {
    public static func make(items: [InboxItem], query: String, kind: ReloHistoryFilter,
                            projectID: String?) -> [InboxItem] {
        InboxHistoryProjection.collapsedActivities(items).filter {
            kind.matches($0) && InboxHierarchyProjection.matchesProject($0, selectedProjectID: projectID)
                && InboxHistoryProjection.matchesSearch($0, query: query)
        }
    }
}
