import Foundation

public struct CachedCurrentSubject: Codable, Equatable, Sendable {
    public let projection: CurrentSubjectProjection
    public let observedAt: Date
}

public struct CurrentRetirement: Codable, Equatable, Sendable {
    public let subjectID: String
    public let version: CurrentVersion?
    public let reason: RetiredCurrentSubject.Reason
    public let observedAt: Date
}

public struct CurrentCacheMetadata: Codable, Equatable, Sendable {
    public let total: Int
    public let counts: CurrentCounts
    public let nextExpiryAt: Date?
    public let serverTime: Date
    public let cursor: String?
    public let hasMore: Bool
}

/// Separate from the bounded history cache. Retired versions are never reconstructed from history.
public struct CurrentCacheSnapshot: Codable, Equatable, Sendable {
    public private(set) var subjects: [String: CachedCurrentSubject] = [:]
    public private(set) var retired: [String: CurrentRetirement] = [:]
    public private(set) var metadata: CurrentCacheMetadata?
    public private(set) var evaluatedAt: Date?
    public private(set) var savedAtWall: Date?
    // Optional for backward-compatible decoding of the original protected cache.
    public private(set) var pending: PendingDecisionCache?
    public init() {}

    /// A page is additive. Its omissions never prove that an independent decision has ended.
    /// Controllers reconcile previously loaded IDs with targeted reads when restarting pagination.
    public mutating func apply(_ response: CurrentInboxResponse, requestedIDs: [String]? = nil) throws {
        guard response.isValid(requestedIDs: requestedIDs) else { throw CurrentStateQueryError.invalidQuery }
        for item in response.items { accept(item, at: response.serverTime) }
        for item in response.retired {
            retire(id: item.subjectId, version: item.version, reason: item.reason, at: response.serverTime)
        }
        if metadata == nil || response.serverTime >= metadata!.serverTime {
            // Targeted responses carry whole-scope counts, but no pagination cursor.
            metadata = CurrentCacheMetadata(total: response.total, counts: response.counts,
                nextExpiryAt: response.nextExpiryAt, serverTime: response.serverTime,
                cursor: requestedIDs == nil ? response.cursor : metadata?.cursor,
                hasMore: requestedIDs == nil ? response.hasMore : (metadata?.hasMore ?? false))
        }
        expire(at: max(evaluatedAt ?? response.serverTime, response.serverTime))
    }

    /// Merge a delayed disk read without replacing newer network state or losing retirement fences.
    public mutating func mergeKnowledge(from cached: CurrentCacheSnapshot) {
        for entry in cached.subjects.values { accept(entry.projection, at: entry.observedAt) }
        for entry in cached.retired.values {
            retire(id: entry.subjectID, version: entry.version, reason: entry.reason, at: entry.observedAt)
        }
        if let value = cached.metadata, metadata == nil || value.serverTime > metadata!.serverTime { metadata = value }
        if let value = cached.pending {
            if pending == nil { pending = PendingDecisionCache() }
            pending?.merge(value)
        }
        pending?.reconcile(subjects: subjects, retired: retired)
        if let value = cached.evaluatedAt { expire(at: value) }
    }

    public mutating func applyPending(_ page: PendingCurrentPage, limit: Int) throws {
        guard page.isValid(limit: limit) else { throw CurrentStateQueryError.invalidQuery }
        if pending == nil { pending = PendingDecisionCache() }
        pending?.apply(page)
        expire(at: page.serverTime)
    }

    public mutating func finishPendingScan(seen: Set<String>, startedAt: Date) {
        pending?.finishScan(seen: seen, startedAt: startedAt)
    }

    private mutating func accept(_ item: CurrentSubjectProjection, at observedAt: Date) {
        if let fence = retired[item.subjectId] {
            guard observedAt > fence.observedAt else { return }
            if let version = fence.version, !Self.newer(item.version, than: version),
               !(fence.reason == .notFound && item.version == version) { return }
        }
        if let old = subjects[item.subjectId] {
            guard Self.newer(item.version, than: old.projection.version)
                || (item.version == old.projection.version && observedAt >= old.observedAt) else { return }
        }
        subjects[item.subjectId] = CachedCurrentSubject(projection: item, observedAt: observedAt)
        retired.removeValue(forKey: item.subjectId)
    }

    /// Only exact known subjects retire locally; aggregate counts remain an explicitly dated sample.
    public mutating func expire(at serverTime: Date) {
        let now = max(evaluatedAt ?? serverTime, serverTime)
        evaluatedAt = now
        for (id, entry) in subjects {
            let deadline = [entry.projection.currentUntil, entry.projection.interaction?.expiresAt].compactMap { $0 }.min()
            if let deadline, deadline <= now {
                retire(id: id, version: entry.projection.version, reason: .expired, at: now)
            }
        }
        if pending == nil { pending = PendingDecisionCache() }
        pending?.reconcile(subjects: subjects, retired: retired)
        pending?.expire(at: now)
    }

    public mutating func prepareForSave(wallTime: Date) { savedAtWall = wallTime }

    /// A cold launch has no trustworthy monotonic anchor. This is a lower bound only:
    /// callers may show cached content but must label actions unverified until synchronization.
    public func conservativeTimeAfterRestart(wallTime: Date) -> Date? {
        guard let floor = evaluatedAt ?? metadata?.serverTime else { return nil }
        guard let savedAtWall else { return floor }
        return floor.addingTimeInterval(max(0, wallTime.timeIntervalSince(savedAtWall)))
    }

    public func freshness(of item: CurrentSubjectProjection, at serverTime: Date) -> CurrentSubjectProjection.Freshness {
        guard let deadline = item.freshUntil else { return item.freshness }
        return deadline <= serverTime ? .stale : item.freshness
    }

    private mutating func retire(id: String, version: CurrentVersion?, reason: RetiredCurrentSubject.Reason, at time: Date) {
        if let current = subjects[id] {
            if let version {
                if Self.newer(current.projection.version, than: version) { return }
                if version == current.projection.version && time < current.observedAt { return }
            } else if time < current.observedAt { return }
        }
        if let old = retired[id] {
            if let previous = old.version, let version {
                if Self.newer(previous, than: version) { return }
                if previous == version && time < old.observedAt { return }
            } else if time < old.observedAt { return }
        }
        let fenceVersion = version ?? subjects[id]?.projection.version ?? retired[id]?.version
        // Losing visibility supplies no evidence that a known terminal outcome changed.
        let retainedReason = reason == .notFound ? (retired[id]?.reason ?? reason) : reason
        subjects.removeValue(forKey: id)
        retired[id] = CurrentRetirement(subjectID: id, version: fenceVersion, reason: retainedReason, observedAt: time)
    }

    private static func newer(_ lhs: CurrentVersion, than rhs: CurrentVersion) -> Bool {
        lhs.generation == rhs.generation ? lhs.revision > rhs.revision : lhs.generation > rhs.generation
    }

    public var isValid: Bool {
        (pending?.isValid ?? true) && Set(subjects.keys).isDisjoint(with: retired.keys)
        && subjects.allSatisfy { $0.key == $0.value.projection.subjectId && $0.value.projection.isValid }
        && retired.allSatisfy { $0.key == $0.value.subjectID && CurrentWireIdentity.isSubject($0.key)
            && ($0.value.version?.isValid ?? true) }
        && (metadata.map { $0.total >= 0 && $0.counts.actionable >= 0 && $0.counts.actionable <= $0.total
            && $0.counts.currentUnread >= 0 && $0.counts.currentUnread <= $0.total
            && $0.hasMore == ($0.cursor != nil) && ($0.cursor?.utf8.count ?? 0) <= 512 } ?? true)
    }
}

/// An in-process monotonic clock includes suspension. Never persist its trust across launch.
public struct CurrentDeadlineClock: Sendable {
    private var anchor: (server: Date, instant: ContinuousClock.Instant)?
    private var floor: Date?
    public init(lastEvaluatedAt: Date? = nil) { floor = lastEvaluatedAt }
    public var isVerified: Bool { anchor != nil }

    public mutating func synchronize(serverTime: Date, requestStarted: ContinuousClock.Instant, receivedAt: ContinuousClock.Instant) {
        let elapsed = Self.seconds(requestStarted.duration(to: receivedAt))
        // Upper-bound request transit conservatively; a slow response cannot add action lifetime.
        let corrected = serverTime.addingTimeInterval(max(0, elapsed))
        let current = now(at: receivedAt)
        let value = max(current ?? corrected, corrected)
        floor = value; anchor = (value, receivedAt)
    }

    public mutating func now(at instant: ContinuousClock.Instant) -> Date? {
        guard let anchor else { return floor }
        let value = max(floor ?? anchor.server, anchor.server.addingTimeInterval(max(0, Self.seconds(anchor.instant.duration(to: instant)))))
        floor = value; return value
    }

    private static func seconds(_ duration: Duration) -> Double {
        Double(duration.components.seconds) + Double(duration.components.attoseconds) / 1e18
    }
}
