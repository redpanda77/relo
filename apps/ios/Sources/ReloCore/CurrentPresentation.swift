import Foundation

/// A draft and its eventual submission stay attached to this exact request.
/// Native activity progress can advance without replacing its immutable decision ID.
public struct CurrentDecisionIdentity: Equatable, Hashable, Sendable, Identifiable {
    public let scope: StorageScope
    public let subjectID: String
    public let notificationID: String
    public let interactionID: String
    public let kind: CurrentDecision.Kind
    public let version: CurrentVersion?
    public let expiresAt: Date
    /// A choice question's answers; empty for every other kind.
    public let options: [InteractionOption]
    public var id: String { scope.fileKey + ":" + interactionID }

    public init?(subject: CurrentSubjectProjection, scope: StorageScope) {
        guard let notificationID = subject.notificationId, let decision = subject.interaction else { return nil }
        self.scope = scope; subjectID = subject.subjectId; self.notificationID = notificationID
        interactionID = decision.id; kind = decision.type
        version = subject.activity == nil ? subject.version : nil
        expiresAt = decision.expiresAt
        options = decision.options ?? []
    }

    public init(pending: PendingCurrentDecision, scope: StorageScope) {
        self.scope = scope; subjectID = pending.subjectId; notificationID = pending.notificationId
        interactionID = pending.interaction.id; kind = pending.interaction.type
        version = pending.version; expiresAt = pending.interaction.expiresAt
        options = pending.interaction.options ?? []
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(scope); hasher.combine(subjectID); hasher.combine(notificationID)
        hasher.combine(interactionID); hasher.combine(kind.rawValue)
        hasher.combine(version?.generation); hasher.combine(version?.revision); hasher.combine(expiresAt)
        hasher.combine(options)
    }
}

public enum CurrentActionAvailability: Equatable, Sendable {
    case available, unverified, expired, replaced, answered, unavailable, differentAccount

    public var permitsSubmission: Bool { self == .available }
    public var explanation: String? {
        switch self {
        case .available: nil
        case .unverified: "Checking whether this request is still current…"
        case .expired: "This request expired. New responses are disabled."
        case .replaced: "This request was replaced. Your draft belongs to the original request."
        case .answered: "This request has already been answered."
        case .unavailable: "This request is no longer available."
        case .differentAccount: "This draft belongs to a different account or device."
        }
    }
}

/// The editor owns this value; current-state updates change availability, not its destination.
public struct CurrentDecisionDraft: Equatable, Sendable, Identifiable {
    public let identity: CurrentDecisionIdentity
    public let title: String
    public let prompt: String
    public var text: String
    public var id: String { identity.id }

    public init(identity: CurrentDecisionIdentity, title: String, prompt: String, text: String = "") {
        self.identity = identity; self.title = title; self.prompt = prompt; self.text = text
    }

    public func availability(in state: CurrentRuntimeState?, now: Date) -> CurrentActionAvailability {
        CurrentInboxPresentation.availability(for: identity, state: state, now: now)
    }
}

/// UI partitions are projections of current state, never inferred from the newest history row.
public struct CurrentInboxPresentation: Equatable, Sendable {
    public let needsMe: [PendingCurrentDecision]
    public let running: [CurrentSubjectProjection]
    public let recentChanges: [CurrentSubjectProjection]
    public let actionableCount: Int?
    public let unreadCount: Int?
    public let checkedAt: Date?

    public init(state: CurrentRuntimeState?, now: Date) {
        guard let state else {
            needsMe = []; running = []; recentChanges = []
            actionableCount = nil; unreadCount = nil; checkedAt = nil
            return
        }
        var snapshot = state.snapshot
        snapshot.expire(at: now)
        let subjects = snapshot.subjects.values.map(\.projection)
        needsMe = (snapshot.pending?.entries.values.map(\.item) ?? []).sorted {
            if $0.urgencyRank != $1.urgencyRank { return $0.urgencyRank < $1.urgencyRank }
            if $0.interaction.expiresAt != $1.interaction.expiresAt { return $0.interaction.expiresAt < $1.interaction.expiresAt }
            return $0.id < $1.id
        }
        running = subjects.filter { $0.kind == .progress || $0.kind == .incident }.sorted {
            $0.updatedAt == $1.updatedAt ? $0.subjectId < $1.subjectId : $0.updatedAt > $1.updatedAt
        }
        recentChanges = subjects.filter { $0.kind == .notice }.sorted {
            $0.updatedAt == $1.updatedAt ? $0.subjectId < $1.subjectId : $0.updatedAt > $1.updatedAt
        }
        let metadata = snapshot.metadata
        let trusted = state.countsAreCurrent && state.timeVerified
            && (metadata?.nextExpiryAt.map { $0 > now } ?? true)
        let pending = snapshot.pending?.metadata
        let pendingTrusted = state.pendingCountsAreCurrent && state.timeVerified
            && (pending?.nextExpiryAt.map { $0 > now } ?? true)
        if pendingTrusted, let pending, !trusted || pending.serverTime >= (metadata?.serverTime ?? .distantPast) {
            actionableCount = pending.total
        } else { actionableCount = trusted ? metadata?.counts.actionable : nil }
        unreadCount = trusted ? metadata?.counts.currentUnread : nil
        checkedAt = metadata?.serverTime
    }

    public static func availability(for identity: CurrentDecisionIdentity, state: CurrentRuntimeState?, now: Date) -> CurrentActionAvailability {
        guard let state else { return .unverified }
        guard state.scope.storage == identity.scope else { return .differentAccount }
        if let retirement = state.snapshot.retired[identity.subjectID] {
            switch retirement.reason {
            case .settled: return .answered
            case .superseded: return .replaced
            case .expired: return .expired
            case .ended, .resolved, .withdrawn, .notFound: return .unavailable
            }
        }
        guard identity.expiresAt > now else { return .expired }
        let entry = state.snapshot.pending?.entries[identity.interactionID]
        if let newer = state.snapshot.pending?.entries.values.first(where: { $0.item.subjectId == identity.subjectID && $0.item.id != identity.interactionID }),
           newer.observedAt >= (entry?.observedAt ?? .distantPast) { return .replaced }
        if let removedAt = state.snapshot.pending?.removed[identity.interactionID],
           removedAt >= (entry?.observedAt ?? .distantPast) { return .unavailable }
        if let subject = state.snapshot.subjects[identity.subjectID],
           subject.observedAt >= (entry?.observedAt ?? .distantPast) {
            guard subject.projection.notificationId == identity.notificationID,
                  subject.projection.interaction?.id == identity.interactionID,
                  subject.projection.interaction?.type == identity.kind,
                  subject.projection.interaction?.expiresAt == identity.expiresAt,
                  identity.version == nil || subject.projection.version == identity.version else { return .replaced }
            if let until = subject.projection.currentUntil, until <= now { return .expired }
            if state.isSubjectVerified(identity.subjectID) { return .available }
        }
        guard let entry else { return .unverified }
        guard entry.validUntil > now else { return .expired }
        guard entry.item.notificationId == identity.notificationID, entry.item.subjectId == identity.subjectID,
              entry.item.interaction.type == identity.kind, entry.item.interaction.expiresAt == identity.expiresAt,
              identity.version == nil || entry.item.version == identity.version else { return .replaced }
        guard state.timeVerified, state.verifiedPending[identity.interactionID] == entry.observedAt,
              state.snapshot.pending?.metadata?.nextExpiryAt.map({ $0 > now }) ?? true else { return .unverified }
        return .available
    }

    public static func freshnessLabel(for subject: CurrentSubjectProjection, now: Date) -> String? {
        if subject.freshness == .stale || subject.freshUntil.map({ $0 <= now }) == true { return "Out of date" }
        return nil
    }
}
