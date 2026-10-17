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
            activityEvent: activityEvent ?? self.activityEvent, activity: activity, sealed: sealed, work: work)
    }
}
