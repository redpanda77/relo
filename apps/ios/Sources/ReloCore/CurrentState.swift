import Foundation

public struct CurrentVersion: Codable, Equatable, Sendable {
    public let generation: Int
    public let revision: Int
    var isValid: Bool { generation > 0 && revision > 0 }
}

public struct CurrentDecision: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable { case approval, yesNo = "yes_no", text }
    public enum State: String, Codable, Sendable { case pending }
    public let id: String
    public let type: Kind
    public let state: State
    public let expiresAt: Date
}

public struct CurrentActivity: Codable, Equatable, Sendable {
    public let id: String
    public let generation: Int
    public let sequence: Int
    public let status: String?
    public let progress: Double?
}

/// Current identity and validity are independent of retained history or delivery TTL.
public struct CurrentSubjectProjection: Codable, Equatable, Identifiable, Sendable {
    public enum Freshness: String, Codable, Sendable { case fresh, stale, unknown }
    public var id: String { subjectId }
    public let subjectId: String
    public let notificationId: String?
    public let kind: RelevanceKind
    public let version: CurrentVersion
    public let title: String
    public let summary: String
    public let source: String
    public let createdAt: Date
    public let updatedAt: Date
    public let occurredAt: Date?
    public let acceptedAt: Date
    public let readAt: Date?
    public let currentUntil: Date?
    public let freshUntil: Date?
    public let deliverUntil: Date
    public let freshness: Freshness
    public let interaction: CurrentDecision?
    public let activity: CurrentActivity?
    public let resources: InboxResourceLinks?

    var isValid: Bool {
        guard CurrentWireIdentity.isSubject(subjectId), version.isValid,
              title.unicodeScalars.count <= 200, summary.unicodeScalars.count <= 240,
              source.unicodeScalars.count <= 200,
              notificationId.map({ CurrentWireIdentity.matches($0, prefix: "ntf_") }) ?? true,
              (kind == .decision) == (interaction != nil) else { return false }
        if let interaction {
            guard CurrentWireIdentity.matches(interaction.id, prefix: "int_"),
                  let currentUntil, currentUntil <= interaction.expiresAt else { return false }
        }
        if let activity {
            guard CurrentWireIdentity.matches(activity.id, prefix: "act_"), activity.generation > 0,
                  activity.sequence >= 0, (activity.status?.unicodeScalars.count ?? 0) <= 240,
                  activity.progress.map({ $0.isFinite && (0...1).contains($0) }) ?? true else { return false }
        }
        if let resources {
            guard CurrentWireIdentity.matches(resources.source.id, prefix: "src_"),
                  CurrentWireIdentity.matches(resources.project.id, prefix: "prj_"),
                  resources.source.name.unicodeScalars.count <= 200, resources.project.name.unicodeScalars.count <= 200,
                  (0..<12).contains(resources.project.palette.slot), resources.project.palette.generation >= 0,
                  resources.project.revision > 0 else { return false }
        }
        return true
    }
}

public struct RetiredCurrentSubject: Codable, Equatable, Sendable {
    public enum Reason: String, Codable, Sendable {
        case expired, settled, resolved, withdrawn, superseded, ended, notFound = "not_found"
    }
    public let subjectId: String
    public let reason: Reason
    public let version: CurrentVersion?
}

public struct CurrentCounts: Codable, Equatable, Sendable {
    public let actionable: Int
    public let currentUnread: Int
}

public struct CurrentInboxResponse: Codable, Equatable, Sendable {
    public let items: [CurrentSubjectProjection]
    public let retired: [RetiredCurrentSubject]
    public let total: Int
    public let cursor: String?
    public let hasMore: Bool
    public let counts: CurrentCounts
    public let nextExpiryAt: Date?
    public let serverTime: Date

    public func isValid(requestedIDs: [String]?) -> Bool {
        let identities = items.map(\.subjectId) + retired.map(\.subjectId)
        guard items.count <= 50, retired.count <= 50, total >= items.count,
              counts.actionable >= 0, counts.actionable <= total,
              counts.currentUnread >= 0, counts.currentUnread <= total,
              items.allSatisfy(\.isValid), Set(identities).count == identities.count,
              retired.allSatisfy({ CurrentWireIdentity.isSubject($0.subjectId) && ($0.version?.isValid ?? true)
                && ($0.reason != .notFound || $0.version == nil) }),
              hasMore == (cursor != nil), (cursor?.utf8.count ?? 0) <= 512 else { return false }
        if let requestedIDs { return !hasMore && Set(identities) == Set(requestedIDs) }
        return retired.isEmpty
    }
}

public struct PendingCurrentDecision: Codable, Equatable, Identifiable, Sendable {
    public var id: String { interaction.id }
    public let subjectId: String
    public let notificationId: String
    public let version: CurrentVersion?
    public let kind: RelevanceKind
    public let title: String
    public let summary: String
    public let source: String
    public let createdAt: Date
    public let readAt: Date?
    public let urgencyRank: Int
    public let interaction: CurrentDecision
}

public struct PendingCurrentPage: Codable, Equatable, Sendable {
    public let items: [PendingCurrentDecision]
    public let total: Int
    public let hasMore: Bool
    public let cursor: String?
    public let nextExpiryAt: Date?
    public let serverTime: Date

    public func isValid(limit: Int) -> Bool {
        items.count <= limit && total >= items.count && hasMore == (cursor != nil)
        && (cursor?.utf8.count ?? 0) <= 512 && Set(items.map(\.id)).count == items.count
        && items.allSatisfy {
            CurrentWireIdentity.isSubject($0.subjectId) && CurrentWireIdentity.matches($0.notificationId, prefix: "ntf_")
            && CurrentWireIdentity.matches($0.interaction.id, prefix: "int_") && ($0.version?.isValid ?? true)
            && $0.kind == .decision && $0.urgencyRank >= 0 && $0.title.unicodeScalars.count <= 200
            && $0.summary.unicodeScalars.count <= 240 && $0.source.unicodeScalars.count <= 200
        }
    }
}

public struct CurrentChangeHint: Codable, Equatable, Sendable {
    public let subjectIds: [String]
    public let invalidateCounts: Bool
    public static let reconcile = Self(subjectIds: [], invalidateCounts: true)
    public init(subjectIds: [String], invalidateCounts: Bool) {
        self.subjectIds = subjectIds; self.invalidateCounts = invalidateCounts
    }
    public var isValid: Bool { subjectIds.count <= 50 && subjectIds.allSatisfy(CurrentWireIdentity.isSubject) }
}

public protocol CurrentStateSource: Sendable {
    func fetchCurrent(ids: [String]?) async throws -> CurrentInboxResponse
    func fetchCurrentPage(after cursor: String?) async throws -> CurrentInboxResponse
    func fetchPending(after cursor: String?, limit: Int) async throws -> PendingCurrentPage
    func changes() -> AsyncThrowingStream<CurrentChangeHint, Error>
}

public enum CurrentStateQueryError: Error, Equatable { case invalidQuery }

public enum CurrentWireIdentity {
    public static func isSubject(_ value: String) -> Bool {
        ["sub_", "act_", "ntf_"].contains { matches(value, prefix: $0) }
    }
    static func matches(_ value: String, prefix: String) -> Bool {
        guard value.hasPrefix(prefix), value.utf8.count == prefix.utf8.count + 36 else { return false }
        let raw = String(value.dropFirst(prefix.count))
        return UUID(uuidString: raw)?.uuidString.lowercased() == raw
    }
}
