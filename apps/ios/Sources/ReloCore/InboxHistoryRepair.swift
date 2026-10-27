import Foundation

/// Historical event identity and original deadlines; never permission to act.
public struct InboxHistoryMetadata: Codable, Equatable, Sendable {
    public struct ContentSummary: Codable, Equatable, Sendable {
        public let summary: String
        public let format: InboxItem.Content.Format
        public let byteLength: Int
    }
    public struct ActivityEvent: Codable, Equatable, Sendable {
        public let id: String
        public let operation: String
        public let generation: Int
        public let sequence: Int

        public init(id: String, operation: String, generation: Int, sequence: Int) {
            self.id = id
            self.operation = operation
            self.generation = generation
            self.sequence = sequence
        }
    }
    public struct Relevance: Codable, Equatable, Sendable {
        public let subjectId: String
        public let generation: Int
        public let revision: Int
        public let status: String
        public let supersededAt: Date?
        public let currentUntil: Date?
        public let actionExpiresAt: Date?
        public let freshUntil: Date?
        public let deliverUntil: Date
    }
    public let updatedAt: Date
    public let contentSummary: ContentSummary
    public let activityEvent: ActivityEvent?
    public let relevance: Relevance?
}

public struct InboxHistorySummary: Decodable, Equatable, Sendable {
    public var item: InboxItem
    public let metadata: InboxHistoryMetadata
    private enum CodingKeys: String, CodingKey { case detail, content, liveActivity, payload, body }

    public init(from decoder: Decoder) throws {
        let keys = try decoder.container(keyedBy: CodingKeys.self)
        guard ![CodingKeys.detail, .content, .liveActivity, .payload, .body].contains(where: keys.contains) else {
            throw InboxRemoteError.incompatibleResponse
        }
        metadata = try InboxHistoryMetadata(from: decoder)
        let raw = try InboxItem(from: decoder)
        guard raw.title.unicodeScalars.count <= 200, raw.sourceName.unicodeScalars.count <= 200,
              metadata.contentSummary.summary.unicodeScalars.count <= 240,
              (0...65_536).contains(metadata.contentSummary.byteLength),
              (raw.interaction?.prompt.unicodeScalars.count ?? 0) <= 240 else {
            throw InboxRemoteError.incompatibleResponse
        }
        item = raw.historySummary(text: metadata.contentSummary.summary, activityEvent: metadata.activityEvent)
    }
}

public struct InboxRepairResponse: Decodable, Equatable, Sendable {
    public var items: [InboxHistorySummary]
    public let total: Int
    public let serverTime: Date
    public let readWatermark: String?
    public let unread: InboxUnreadSummary
    /// Each work's plan, rounds and newest sealed card, sent once per work instead of on every card event.
    /// `withWorkPlans()` moves them onto the items, so nothing downstream (or stored) needs this again.
    public let works: [String: Work]

    public struct Work: Decodable, Equatable, Sendable {
        public let plan: [InboxCardDigest.PlanStep]?
        public let rounds: [InboxCardDigest.PlanRound]?
        public let sealed: ReloEnvelope?

        private enum CodingKeys: String, CodingKey { case plan, rounds, sealed }

        public init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            let steps: [InboxCardDigest.PlanStep] = values.contains(.plan) ? ReloWork.lenientArray(values, .plan) : []
            let closedRounds: [InboxCardDigest.PlanRound] = values.contains(.rounds) ? ReloWork.lenientArray(values, .rounds) : []
            plan = steps.isEmpty ? nil : steps
            rounds = closedRounds.isEmpty ? nil : closedRounds
            sealed = (try? values.decodeIfPresent(ReloEnvelope.self, forKey: .sealed)) ?? nil
        }
    }

    /// Card envelopes shared by several events, by md5; an item names one as `sealed.contentRef`.
    public let envelopes: [String: ReloEnvelope]

    private enum CodingKeys: String, CodingKey { case items, total, serverTime, readWatermark, unread, works, envelopes }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        items = try values.decode([InboxHistorySummary].self, forKey: .items)
        total = try values.decode(Int.self, forKey: .total)
        serverTime = try values.decode(Date.self, forKey: .serverTime)
        readWatermark = try values.decodeIfPresent(String.self, forKey: .readWatermark)
        unread = try values.decode(InboxUnreadSummary.self, forKey: .unread)
        // A bad entry is dropped, never the snapshot: its items then show what they carry themselves.
        struct Lossy: Decodable {
            let work: Work?
            init(from decoder: Decoder) throws { work = try? Work(from: decoder) }
        }
        struct LossyEnvelope: Decodable {
            let envelope: ReloEnvelope?
            init(from decoder: Decoder) throws { envelope = try? ReloEnvelope(from: decoder) }
        }
        let sharedRaw = (try? values.decodeIfPresent([String: LossyEnvelope].self, forKey: .envelopes)) ?? nil
        envelopes = (sharedRaw ?? [:]).compactMapValues(\.envelope).filter {
            $0.key.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil
        }
        let raw = (try? values.decodeIfPresent([String: Lossy].self, forKey: .works)) ?? nil
        works = (raw ?? [:]).compactMapValues(\.work).filter {
            $0.key.range(of: "^wrk_[0-9a-f-]{36}$", options: .regularExpression) != nil
        }
    }

    /// The items as before the server stopped repeating shared data: `sealed.content` from `envelopes` by its reference, and `plan` and `rounds` filled from the
    /// item's work when it has none, and the work's newest sealed card as `sealed.plan` when it differs from the
    /// item's own text (an earlier round's event names the later rounds from it). Run right after decoding and
    /// before opening, so History, detail and Now see ordinary items and a stored item never needs `works` again.
    public func resolvingShared() -> InboxRepairResponse {
        guard !works.isEmpty || !envelopes.isEmpty else { return self }
        var filled = self
        filled.items = items.map { summary in
            var summary = summary
            var item = summary.item
            // Shared card envelopes first: the work step compares against the item's own content. A missing
            // reference leaves the item sealed and unreadable, never failing the snapshot.
            if let notice = item.sealed, let ref = notice.contentRef, let shared = envelopes[ref] {
                item = item.replacing(activity: item.activity,
                                      sealed: InboxSealedNotice(alert: notice.alert, content: shared, plan: notice.plan))
                summary.item = item
            }
            guard let id = item.activity?.workId, let work = works[id] else { return summary }
            let activity = item.activity?.filling(plan: work.plan, rounds: work.rounds)
            var sealed = item.sealed
            if let notice = item.sealed, notice.contentRef == nil, notice.plan == nil, let newest = work.sealed, newest != notice.content {
                sealed = InboxSealedNotice(alert: notice.alert, content: notice.content, plan: newest)
            }
            summary.item = item.replacing(activity: activity, sealed: sealed)
            return summary
        }
        return filled
    }

    public var isValid: Bool {
        items.count <= 250 && total >= items.count && unread.account >= 0
            && unread.projects.values.allSatisfy { $0 >= 0 }
            && Set(items.map { $0.item.id }).count == items.count
    }

    public func snapshot(syncedAt: Date) throws -> InboxSnapshot {
        guard isValid else { throw InboxRemoteError.incompatibleResponse }
        var result = InboxSnapshot(items: items.map(\.item), lastSuccessfulSyncAt: syncedAt,
            readWatermark: readWatermark, unread: unread)
        result.total = total
        result.historyMetadata = Dictionary(uniqueKeysWithValues: items.map { ($0.item.id, $0.metadata) })
        return result
    }
}

public protocol InboxSnapshotRemoteDataSource: Sendable {
    func fetchSnapshot() async throws -> InboxRepairResponse
}

extension InboxItem {
    /// The same item, its card digest and sealed notice replaced.
    func replacing(activity: InboxCardDigest?, sealed: InboxSealedNotice?) -> InboxItem {
        InboxItem(
            id: id, kind: kind, sourceName: sourceName, sourceImageUrl: sourceImageUrl, title: title, detail: detail,
            content: content, readAt: readAt, withdrawnAt: withdrawnAt, result: result, deliveryState: deliveryState,
            apnsAcceptedAt: apnsAcceptedAt, receivedAt: receivedAt, openedAt: openedAt, createdAt: createdAt,
            destinationUrl: destinationUrl, privacy: privacy, liveActivity: liveActivity, activitySummary: activitySummary,
            interaction: interaction, context: context, resources: resources, activityEvent: activityEvent,
            activity: activity, sealed: sealed, work: work, outcomeOf: outcomeOf)
    }

    /// Also strips full content when compacting a cache written by the predecessor.
    public func historySummary(text: String? = nil, activityEvent: InboxHistoryMetadata.ActivityEvent? = nil) -> InboxItem {
        let summary = privacy == .private ? "Private notification" : (text ?? content?.summary ?? detail)
        let bounded = summary.map { String($0.unicodeScalars.prefix(240)) }
        let request = interaction.map {
            InboxInteraction(id: $0.id, kind: $0.kind,
                prompt: privacy == .private ? "Private notification" : String($0.prompt.unicodeScalars.prefix(240)),
                state: $0.state, expiresAt: $0.expiresAt, respondedAt: $0.respondedAt)
        }
        return InboxItem(id: id, kind: kind, sourceName: String(sourceName.unicodeScalars.prefix(200)),
            sourceImageUrl: sourceImageUrl, title: String(title.unicodeScalars.prefix(200)), detail: bounded,
            readAt: readAt, withdrawnAt: withdrawnAt, result: result, deliveryState: deliveryState,
            apnsAcceptedAt: apnsAcceptedAt, receivedAt: receivedAt, openedAt: openedAt, createdAt: createdAt,
            destinationUrl: destinationUrl, privacy: privacy, interaction: request, context: context, resources: resources,
            activityEvent: activityEvent ?? self.activityEvent, activity: activity, sealed: sealed, work: work, outcomeOf: outcomeOf)
    }
}
