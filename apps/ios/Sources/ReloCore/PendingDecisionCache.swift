import Foundation

public struct CachedPendingDecision: Codable, Equatable, Sendable {
    public let item: PendingCurrentDecision
    public let observedAt: Date
    public let validUntil: Date
}

/// Independent decision inventory. Page omissions are not terminal outcomes.
/// Only a completed scan or exact subject evidence can remove a loaded request.
public struct PendingDecisionCache: Codable, Equatable, Sendable {
    public private(set) var entries: [String: CachedPendingDecision] = [:]
    public private(set) var removed: [String: Date] = [:]
    public private(set) var metadata: PendingCurrentPage?

    mutating func apply(_ page: PendingCurrentPage) {
        for item in page.items { accept(item, at: page.serverTime, until: item.interaction.expiresAt) }
        if metadata == nil || page.serverTime >= metadata!.serverTime {
            metadata = PendingCurrentPage(items: [], total: page.total, hasMore: page.hasMore,
                cursor: page.cursor, nextExpiryAt: page.nextExpiryAt, serverTime: page.serverTime)
        }
    }

    mutating func accept(_ item: PendingCurrentDecision, at time: Date, until: Date) {
        if let fence = removed[item.id], fence >= time { return }
        if let old = entries[item.id], old.observedAt > time { return }
        for (id, other) in entries where other.item.subjectId == item.subjectId && id != item.id {
            if other.observedAt > time { return }
            if let old = other.item.version, let candidate = item.version,
               old.generation > candidate.generation || (old.generation == candidate.generation && old.revision > candidate.revision) { return }
            remove(id, at: time)
        }
        entries[item.id] = CachedPendingDecision(item: item, observedAt: time,
            validUntil: min(until, entries[item.id]?.validUntil ?? until))
        removed.removeValue(forKey: item.id)
    }

    mutating func remove(_ id: String, at time: Date) {
        if let entry = entries[id], entry.observedAt > time { return }
        entries.removeValue(forKey: id)
        removed[id] = max(removed[id] ?? time, time)
    }

    mutating func finishScan(seen: Set<String>, startedAt time: Date) {
        for (id, entry) in entries where !seen.contains(id) && entry.observedAt <= time { remove(id, at: time) }
    }

    mutating func reconcile(subjects: [String: CachedCurrentSubject], retired: [String: CurrentRetirement]) {
        for (id, entry) in entries {
            if let fence = retired[entry.item.subjectId] {
                let newerVersion: Bool = {
                    guard let candidate = entry.item.version, let old = fence.version else { return false }
                    return candidate.generation > old.generation || (candidate.generation == old.generation && candidate.revision > old.revision)
                }()
                if entry.observedAt <= fence.observedAt || (!newerVersion && fence.reason != .notFound) {
                    remove(id, at: max(entry.observedAt, fence.observedAt))
                }
            }
            if let current = subjects[entry.item.subjectId], current.observedAt >= entry.observedAt,
               current.projection.interaction?.id != id { remove(id, at: current.observedAt) }
        }
        for entry in subjects.values {
            let subject = entry.projection
            guard let decision = subject.interaction, let notification = subject.notificationId else { continue }
            let item = PendingCurrentDecision(subjectId: subject.subjectId, notificationId: notification,
                version: subject.activity == nil ? subject.version : nil, kind: .decision, title: subject.title,
                summary: subject.summary, source: subject.source, createdAt: subject.createdAt, readAt: subject.readAt,
                urgencyRank: 0, interaction: decision)
            let deadline = min(subject.currentUntil ?? decision.expiresAt, decision.expiresAt)
            if let known = entries[decision.id], known.validUntil > deadline {
                // A later inventory sample cannot erase a known shorter parent deadline.
                entries[decision.id] = CachedPendingDecision(item: known.item, observedAt: known.observedAt, validUntil: deadline)
            }
            accept(item, at: entry.observedAt, until: deadline)
        }
    }

    mutating func expire(at now: Date) {
        for (id, entry) in entries where entry.validUntil <= now { remove(id, at: now) }
    }

    mutating func merge(_ cached: PendingDecisionCache) {
        for (id, time) in cached.removed { remove(id, at: time) }
        for entry in cached.entries.values { accept(entry.item, at: entry.observedAt, until: entry.validUntil) }
        if let value = cached.metadata, metadata == nil || value.serverTime > metadata!.serverTime { metadata = value }
    }

    var isValid: Bool {
        Set(entries.keys).isDisjoint(with: removed.keys)
        && entries.allSatisfy { id, entry in
            id == entry.item.id && entry.validUntil <= entry.item.interaction.expiresAt
            && PendingCurrentPage(items: [entry.item], total: 1, hasMore: false, cursor: nil,
                nextExpiryAt: nil, serverTime: entry.observedAt).isValid(limit: 1)
        }
        && removed.keys.allSatisfy { CurrentWireIdentity.matches($0, prefix: "int_") }
        && (metadata?.isValid(limit: 0) ?? true)
    }
}
