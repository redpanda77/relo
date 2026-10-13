import Foundation

public enum RelevanceKind: String, Codable, Sendable {
    case notice, decision, progress, incident
}

public struct SubjectActor: Codable, Equatable, Sendable {
    public let accountId: String
    public let sourceId: String
}

/// Scope comes from authenticated server identity, never display copy or a project timestamp.
public struct SubjectVersion: Codable, Equatable, Sendable {
    public let accountId: String
    public let sourceId: String
    public let subjectKey: String
    public let generation: Int
    public let revision: Int

    public enum Operation: String, Codable, Sendable { case update, replace }
    public enum MutationResult: String, Sendable {
        case advance, duplicate, stale, unauthorized
        case wrongSubject = "wrong_subject"
        case requiresReplace = "requires_replace"
        case invalidGeneration = "invalid_generation"
    }

    public func sameSubject(as other: Self) -> Bool {
        accountId == other.accountId && sourceId == other.sourceId && subjectKey == other.subjectKey
    }

    private func isNewer(than other: Self) -> Bool {
        generation == other.generation ? revision > other.revision : generation > other.generation
    }

    /// Pure ordering guard. The server must authenticate the actor and lock the current pointer.
    public static func classify(actor: SubjectActor, candidate: Self, current: Self?, operation: Operation) -> MutationResult {
        guard actor.accountId == candidate.accountId, actor.sourceId == candidate.sourceId else { return .unauthorized }
        guard let current else {
            return operation == .replace && candidate.generation == 1 && candidate.revision == 1 ? .advance : .requiresReplace
        }
        guard candidate.sameSubject(as: current) else { return .wrongSubject }
        if current.isNewer(than: candidate) { return .stale }
        if candidate == current { return .duplicate } // Admission separately checks immutable payload equality.
        if candidate.generation == current.generation { return operation == .update ? .advance : .invalidGeneration }
        guard operation == .replace else { return .requiresReplace }
        return candidate.generation - 1 == current.generation && candidate.revision == 1 ? .advance : .invalidGeneration
    }

    fileprivate func supersedes(_ other: Self) -> Bool { sameSubject(as: other) && isNewer(than: other) }
}

public struct RelevanceDeadlines: Codable, Equatable, Sendable {
    public let kind: RelevanceKind
    public let occurredAt: Date
    public let acceptedAt: Date
    public let freshUntil: Date?
    public let relevantUntil: Date?
    public let actionExpiresAt: Date?
    public let deliverUntil: Date
}

/// Only admission normalizes these values. Retrying must use the original occurrence/deadlines.
public struct RelevancePolicy: Codable, Equatable, Sendable {
    public static let noticeSeconds = 900
    public static let noticeDeliverySeconds = 60
    public static let decisionSeconds = 900
    public static let progressDeliverySeconds = 15
    public static let terminalCleanupSeconds = 3_600
    public static let producerClockToleranceSeconds = 1.0

    public struct Heartbeat: Codable, Equatable, Sendable {
        public let intervalSeconds: Int
        public let lastHeartbeatAt: Date
    }
    public enum IncidentMode: String, Codable, Sendable { case untilResolved = "until_resolved", lease }
    public enum ValidationError: Error { case invalidPolicy, futureTime, unsupportedDate }

    public let kind: RelevanceKind
    public let relevanceSeconds: Int?
    public let deliverySeconds: Int?
    public let actionSeconds: Int?
    public let heartbeat: Heartbeat?
    public let mode: IncidentMode?
    public let leaseUntil: Date?

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case kind, relevanceSeconds, deliverySeconds, actionSeconds, heartbeat, mode, leaseUntil
    }
    private struct AnyKey: CodingKey {
        let stringValue: String
        var intValue: Int? { nil }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        kind = try values.decode(RelevanceKind.self, forKey: .kind)
        relevanceSeconds = try values.decodeIfPresent(Int.self, forKey: .relevanceSeconds)
        deliverySeconds = try values.decodeIfPresent(Int.self, forKey: .deliverySeconds)
        actionSeconds = try values.decodeIfPresent(Int.self, forKey: .actionSeconds)
        heartbeat = try values.decodeIfPresent(Heartbeat.self, forKey: .heartbeat)
        mode = try values.decodeIfPresent(IncidentMode.self, forKey: .mode)
        leaseUntil = try values.decodeIfPresent(Date.self, forKey: .leaseUntil)
        let keys = Set(try decoder.container(keyedBy: AnyKey.self).allKeys.map(\.stringValue))
        let allowed: Set<String>
        switch kind {
        case .notice: allowed = ["kind", "relevanceSeconds", "deliverySeconds"]
        case .decision: allowed = ["kind", "actionSeconds", "deliverySeconds"]
        case .progress: allowed = ["kind", "heartbeat", "deliverySeconds"]
        case .incident: allowed = ["kind", "mode", "leaseUntil", "deliverySeconds"]
        }
        guard keys.isSubset(of: allowed) else { throw ValidationError.invalidPolicy }
        for key in values.allKeys where key != .kind {
            guard try !values.decodeNil(forKey: key) else { throw ValidationError.invalidPolicy }
        }
        for seconds in [relevanceSeconds, deliverySeconds, actionSeconds, heartbeat?.intervalSeconds].compactMap({ $0 }) {
            guard seconds > 0, seconds <= 9_007_199_254_740_991 else { throw ValidationError.invalidPolicy }
        }
        switch kind {
        case .notice:
            let lifetime = relevanceSeconds ?? Self.noticeSeconds
            guard (deliverySeconds ?? min(lifetime, Self.noticeDeliverySeconds)) <= lifetime else { throw ValidationError.invalidPolicy }
        case .decision:
            let lifetime = actionSeconds ?? Self.decisionSeconds
            guard (deliverySeconds ?? lifetime) <= lifetime else { throw ValidationError.invalidPolicy }
        case .incident:
            guard let mode, (mode == .lease) == (leaseUntil != nil) else { throw ValidationError.invalidPolicy }
        case .progress: break
        }
    }

    public func deadlines(occurredAt: Date, acceptedAt: Date) throws -> RelevanceDeadlines {
        guard occurredAt <= acceptedAt.addingTimeInterval(Self.producerClockToleranceSeconds) else { throw ValidationError.futureTime }
        // Preserve original occurrence evidence without extending validity for a fast producer clock.
        let deadlineOrigin = min(occurredAt, acceptedAt)
        func plus(_ date: Date, _ seconds: Double) throws -> Date {
            let result = date.addingTimeInterval(seconds)
            guard result.timeIntervalSince1970.isFinite, result.timeIntervalSince1970 < 253_402_300_800 else { throw ValidationError.unsupportedDate }
            return result
        }
        var fresh: Date?
        var relevant: Date?
        var action: Date?
        var delivery: Date
        switch kind {
        case .notice:
            let lifetime = relevanceSeconds ?? Self.noticeSeconds
            relevant = try plus(deadlineOrigin, Double(lifetime))
            delivery = try plus(deadlineOrigin, Double(deliverySeconds ?? min(lifetime, Self.noticeDeliverySeconds)))
        case .decision:
            let lifetime = actionSeconds ?? Self.decisionSeconds
            action = try plus(deadlineOrigin, Double(lifetime))
            delivery = try plus(deadlineOrigin, Double(deliverySeconds ?? lifetime))
        case .progress:
            delivery = try plus(deadlineOrigin, Double(deliverySeconds ?? Self.progressDeliverySeconds))
            if let heartbeat {
                guard heartbeat.lastHeartbeatAt <= acceptedAt.addingTimeInterval(Self.producerClockToleranceSeconds) else { throw ValidationError.futureTime }
                fresh = try plus(min(heartbeat.lastHeartbeatAt, acceptedAt), 3 * Double(heartbeat.intervalSeconds))
            }
        case .incident:
            relevant = leaseUntil
            delivery = try plus(deadlineOrigin, Double(deliverySeconds ?? Self.noticeDeliverySeconds))
            if let relevant { delivery = min(delivery, relevant) }
        }
        return RelevanceDeadlines(kind: kind, occurredAt: occurredAt, acceptedAt: acceptedAt, freshUntil: fresh, relevantUntil: relevant, actionExpiresAt: action, deliverUntil: delivery)
    }

    /// Internal cleanup targets the old native activity; this never grants action or alert authority.
    public static func terminalCleanupDeadline(terminalAt: Date) -> Date {
        terminalAt.addingTimeInterval(Double(terminalCleanupSeconds))
    }
}

public struct RelevanceEvaluation: Codable, Equatable, Sendable {
    public enum Placement: String, Codable, Sendable { case current, history }
    public enum Freshness: String, Codable, Sendable { case fresh, stale, unknown }
    public enum Action: String, Codable, Sendable { case available, unverified, expired, superseded, settled, none }
    public enum AlertReason: String, Codable, Sendable {
        case eligible, superseded, settled, resolved, expired, stale, unverified
        case deliveryExpired = "delivery_expired"
        case silentProgress = "silent_progress"
    }
    public let placement: Placement
    public let freshness: Freshness
    public let action: Action
    public let deliveryEligible: Bool
    public let alertEligible: Bool
    public let alertReason: AlertReason
}

public struct RelevanceItem: Codable, Equatable, Sendable {
    public enum Status: String, Codable, Sendable { case active, settled, resolved }
    public let identity: SubjectVersion
    public let deadlines: RelevanceDeadlines
    public let status: Status
    public let supersededAt: Date?
    public let supersededBy: SubjectVersion?

    /// `current` belongs to this exact subject. When clockTrusted is false, now is a persisted
    /// lower bound on server time: it may prove expiry, but cannot prove continued action validity.
    public func evaluate(now: Date, clockTrusted: Bool, current: SubjectVersion?) -> RelevanceEvaluation {
        func expired(_ deadline: Date?) -> Bool { deadline.map { now >= $0 } ?? false }
        let replaced = supersededBy != nil || (current?.supersedes(identity) ?? false)
        let verified = current == identity
        let ended = expired(deadlines.actionExpiresAt ?? deadlines.relevantUntil)
        let freshness: RelevanceEvaluation.Freshness = deadlines.freshUntil == nil ? .unknown : expired(deadlines.freshUntil) ? .stale : clockTrusted ? .fresh : .unknown
        let action: RelevanceEvaluation.Action
        if deadlines.kind != .decision { action = .none }
        else if status == .settled { action = .settled }
        else if replaced { action = .superseded }
        else if ended { action = .expired }
        else if !verified || !clockTrusted { action = .unverified }
        else { action = .available }
        let placement: RelevanceEvaluation.Placement = replaced || !verified || ended || status != .active ? .history : .current
        let reason: RelevanceEvaluation.AlertReason
        if replaced { reason = .superseded }
        else if status == .settled { reason = .settled }
        else if status == .resolved { reason = .resolved }
        else if ended { reason = .expired }
        else if !verified || !clockTrusted { reason = .unverified }
        else if expired(deadlines.deliverUntil) { reason = .deliveryExpired }
        else if freshness == .stale { reason = .stale }
        else { reason = .eligible }
        let deliveryEligible = reason == .eligible
        let silentProgress = deliveryEligible && deadlines.kind == .progress
        return RelevanceEvaluation(placement: placement, freshness: freshness, action: action, deliveryEligible: deliveryEligible, alertEligible: deliveryEligible && !silentProgress, alertReason: silentProgress ? .silentProgress : reason)
    }
}

// Decode persisted/server values defensively: a missing deadline or corrupt version cannot
// turn a decision into a permanently actionable one. Keep these checks aligned with Zod.
private struct RelevanceCodingKey: CodingKey {
    let stringValue: String
    var intValue: Int? { nil }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

private func requireRelevanceKeys(_ decoder: Decoder, allowed: Set<String>) throws {
    let keys = Set(try decoder.container(keyedBy: RelevanceCodingKey.self).allKeys.map(\.stringValue))
    guard keys.isSubset(of: allowed) else { throw RelevancePolicy.ValidationError.invalidPolicy }
}

private func requireSubjectScope(_ parts: [String]) throws {
    guard parts.allSatisfy({ !$0.isEmpty && $0.utf16.count <= 200 }) else { throw RelevancePolicy.ValidationError.invalidPolicy }
}

extension SubjectActor {
    private enum CodingKeys: String, CodingKey { case accountId, sourceId }
    public init(from decoder: Decoder) throws {
        try requireRelevanceKeys(decoder, allowed: ["accountId", "sourceId"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        accountId = try values.decode(String.self, forKey: .accountId)
        sourceId = try values.decode(String.self, forKey: .sourceId)
        try requireSubjectScope([accountId, sourceId])
    }
}

extension SubjectVersion {
    private enum CodingKeys: String, CodingKey { case accountId, sourceId, subjectKey, generation, revision }
    public init(from decoder: Decoder) throws {
        try requireRelevanceKeys(decoder, allowed: ["accountId", "sourceId", "subjectKey", "generation", "revision"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        accountId = try values.decode(String.self, forKey: .accountId)
        sourceId = try values.decode(String.self, forKey: .sourceId)
        subjectKey = try values.decode(String.self, forKey: .subjectKey)
        generation = try values.decode(Int.self, forKey: .generation)
        revision = try values.decode(Int.self, forKey: .revision)
        try requireSubjectScope([accountId, sourceId, subjectKey])
        guard (1...9_007_199_254_740_991).contains(generation), (1...9_007_199_254_740_991).contains(revision) else { throw RelevancePolicy.ValidationError.invalidPolicy }
    }
}

extension RelevancePolicy.Heartbeat {
    private enum CodingKeys: String, CodingKey { case intervalSeconds, lastHeartbeatAt }
    public init(from decoder: Decoder) throws {
        try requireRelevanceKeys(decoder, allowed: ["intervalSeconds", "lastHeartbeatAt"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        intervalSeconds = try values.decode(Int.self, forKey: .intervalSeconds)
        lastHeartbeatAt = try values.decode(Date.self, forKey: .lastHeartbeatAt)
        guard (1...9_007_199_254_740_991).contains(intervalSeconds) else { throw RelevancePolicy.ValidationError.invalidPolicy }
    }
}

extension RelevanceDeadlines {
    private enum CodingKeys: String, CodingKey { case kind, occurredAt, acceptedAt, freshUntil, relevantUntil, actionExpiresAt, deliverUntil }
    public init(from decoder: Decoder) throws {
        try requireRelevanceKeys(decoder, allowed: ["kind", "occurredAt", "acceptedAt", "freshUntil", "relevantUntil", "actionExpiresAt", "deliverUntil"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        kind = try values.decode(RelevanceKind.self, forKey: .kind)
        occurredAt = try values.decode(Date.self, forKey: .occurredAt)
        acceptedAt = try values.decode(Date.self, forKey: .acceptedAt)
        freshUntil = try values.decode(Date?.self, forKey: .freshUntil)
        relevantUntil = try values.decode(Date?.self, forKey: .relevantUntil)
        actionExpiresAt = try values.decode(Date?.self, forKey: .actionExpiresAt)
        deliverUntil = try values.decode(Date.self, forKey: .deliverUntil)
        guard occurredAt <= acceptedAt.addingTimeInterval(RelevancePolicy.producerClockToleranceSeconds),
              (kind == .decision) == (actionExpiresAt != nil),
              kind != .notice || relevantUntil != nil,
              kind == .progress || freshUntil == nil,
              !(kind == .progress || kind == .decision) || relevantUntil == nil
        else { throw RelevancePolicy.ValidationError.invalidPolicy }
        if let end = actionExpiresAt ?? relevantUntil, deliverUntil > end { throw RelevancePolicy.ValidationError.invalidPolicy }
    }
}

extension RelevanceItem {
    private enum CodingKeys: String, CodingKey { case identity, deadlines, status, supersededAt, supersededBy }
    public init(from decoder: Decoder) throws {
        try requireRelevanceKeys(decoder, allowed: ["identity", "deadlines", "status", "supersededAt", "supersededBy"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        identity = try values.decode(SubjectVersion.self, forKey: .identity)
        deadlines = try values.decode(RelevanceDeadlines.self, forKey: .deadlines)
        status = try values.decode(Status.self, forKey: .status)
        supersededAt = try values.decode(Date?.self, forKey: .supersededAt)
        supersededBy = try values.decode(SubjectVersion?.self, forKey: .supersededBy)
        guard (supersededAt == nil) == (supersededBy == nil),
              status != .settled || deadlines.kind == .decision,
              status != .resolved || deadlines.kind == .incident
        else { throw RelevancePolicy.ValidationError.invalidPolicy }
        if let supersededBy, !supersededBy.supersedes(identity) { throw RelevancePolicy.ValidationError.invalidPolicy }
    }
}
