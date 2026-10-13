import Foundation

public struct CurrentVersion: Codable, Equatable, Sendable {
    public let generation: Int
    public let revision: Int
    var isValid: Bool { generation > 0 && revision > 0 }
}

public struct CurrentDecision: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable { case approval, yesNo = "yes_no", text, choice }
    public enum State: String, Codable, Sendable { case pending }
    public let id: String
    public let type: Kind
    public let state: State
    public let expiresAt: Date
    /// A choice question's answers; nil for every other kind.
    public let options: [InteractionOption]?

    public init(id: String, type: Kind, state: State, expiresAt: Date, options: [InteractionOption]? = nil) {
        self.id = id; self.type = type; self.state = state; self.expiresAt = expiresAt
        self.options = type == .choice ? options : nil
    }

    private enum CodingKeys: String, CodingKey { case id, type, state, expiresAt, options }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        type = try values.decode(Kind.self, forKey: .type)
        state = try values.decode(State.self, forKey: .state)
        expiresAt = try values.decode(Date.self, forKey: .expiresAt)
        if type == .choice {
            let decoded = try values.decode([InteractionOption].self, forKey: .options)
            guard InteractionOption.isValidList(decoded) else {
                throw DecodingError.dataCorruptedError(
                    forKey: .options, in: values, debugDescription: "A choice needs 2–4 distinct options")
            }
            options = decoded
        } else {
            options = nil
        }
    }

    static func isSupported(_ probe: InteractionCompatibilityProbe) -> Bool {
        probe.type.flatMap(Kind.init(rawValue:)) != nil && probe.state.flatMap(State.init(rawValue:)) != nil
    }
}

/// One element of a current or pending list: the decoded item, or the subject a newer server
/// sent with an interaction this build cannot answer. Such an item is left out of the list.
private struct SupportedCurrentElement<Item: Decodable>: Decodable {
    private struct Probe: Decodable {
        let subjectId: String?
        let interaction: InteractionCompatibilityProbe?
    }
    let item: Item?
    let unsupportedSubjectID: String?

    init(from decoder: Decoder) throws {
        let probe = try Probe(from: decoder)
        if let interaction = probe.interaction, !CurrentDecision.isSupported(interaction) {
            item = nil; unsupportedSubjectID = probe.subjectId
        } else {
            item = try Item(from: decoder); unsupportedSubjectID = nil
        }
    }
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
    /// End-to-end sealed text for this phone; title, summary and status are placeholders until opened.
    public var sealed: InboxSealedNotice? = nil

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
    public var items: [CurrentSubjectProjection]
    public let retired: [RetiredCurrentSubject]
    public let total: Int
    public let cursor: String?
    public let hasMore: Bool
    public let counts: CurrentCounts
    public let nextExpiryAt: Date?
    public let serverTime: Date
    /// Subjects the server sent with an interaction this build cannot answer. They are left out
    /// of `items` but still count as answered when specific subjects were requested.
    public var unsupportedSubjectIDs: [String] = []

    private enum CodingKeys: String, CodingKey {
        case items, retired, total, cursor, hasMore, counts, nextExpiryAt, serverTime
    }

    public init(
        items: [CurrentSubjectProjection], retired: [RetiredCurrentSubject], total: Int, cursor: String?,
        hasMore: Bool, counts: CurrentCounts, nextExpiryAt: Date?, serverTime: Date
    ) {
        self.items = items; self.retired = retired; self.total = total; self.cursor = cursor
        self.hasMore = hasMore; self.counts = counts; self.nextExpiryAt = nextExpiryAt; self.serverTime = serverTime
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let elements = try values.decode([SupportedCurrentElement<CurrentSubjectProjection>].self, forKey: .items)
        items = elements.compactMap(\.item)
        unsupportedSubjectIDs = elements.compactMap(\.unsupportedSubjectID)
        retired = try values.decode([RetiredCurrentSubject].self, forKey: .retired)
        total = try values.decode(Int.self, forKey: .total)
        cursor = try values.decodeIfPresent(String.self, forKey: .cursor)
        hasMore = try values.decode(Bool.self, forKey: .hasMore)
        counts = try values.decode(CurrentCounts.self, forKey: .counts)
        nextExpiryAt = try values.decodeIfPresent(Date.self, forKey: .nextExpiryAt)
        serverTime = try values.decode(Date.self, forKey: .serverTime)
    }

    public func isValid(requestedIDs: [String]?) -> Bool {
        let identities = items.map(\.subjectId) + retired.map(\.subjectId)
        guard items.count <= 50, retired.count <= 50, total >= items.count,
              counts.actionable >= 0, counts.actionable <= total,
              counts.currentUnread >= 0, counts.currentUnread <= total,
              items.allSatisfy(\.isValid), Set(identities).count == identities.count,
              retired.allSatisfy({ CurrentWireIdentity.isSubject($0.subjectId) && ($0.version?.isValid ?? true)
                && ($0.reason != .notFound || $0.version == nil) }),
              hasMore == (cursor != nil), (cursor?.utf8.count ?? 0) <= 512 else { return false }
        if let requestedIDs {
            return !hasMore && Set(identities).union(unsupportedSubjectIDs) == Set(requestedIDs)
        }
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
    /// A sealed question's text for this phone; title and summary are placeholders until opened.
    public var sealed: InboxSealedNotice? = nil
}

public struct PendingCurrentPage: Codable, Equatable, Sendable {
    public var items: [PendingCurrentDecision]
    public let total: Int
    public let hasMore: Bool
    public let cursor: String?
    public let nextExpiryAt: Date?
    public let serverTime: Date

    private enum CodingKeys: String, CodingKey { case items, total, hasMore, cursor, nextExpiryAt, serverTime }

    public init(
        items: [PendingCurrentDecision], total: Int, hasMore: Bool, cursor: String?,
        nextExpiryAt: Date?, serverTime: Date
    ) {
        self.items = items; self.total = total; self.hasMore = hasMore; self.cursor = cursor
        self.nextExpiryAt = nextExpiryAt; self.serverTime = serverTime
    }

    /// A decision whose kind or state this build cannot answer is left out of the page.
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        items = try values.decode([SupportedCurrentElement<PendingCurrentDecision>].self, forKey: .items)
            .compactMap(\.item)
        total = try values.decode(Int.self, forKey: .total)
        hasMore = try values.decode(Bool.self, forKey: .hasMore)
        cursor = try values.decodeIfPresent(String.self, forKey: .cursor)
        nextExpiryAt = try values.decodeIfPresent(Date.self, forKey: .nextExpiryAt)
        serverTime = try values.decode(Date.self, forKey: .serverTime)
    }

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
