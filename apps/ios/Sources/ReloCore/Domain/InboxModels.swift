import Foundation

public struct InboxContext: Codable, Equatable, Sendable {
    public let providerName: String?
    public let producerKind: String?
    /// Stored as received (opaque handles for encrypted work); read through the names below.
    private let storedComputer: String?
    private let storedProject: String?
    public let providerThreadId: String?
    public let providerWorkItemId: String?
    private let storedThreadName: String?
    private let storedTaskTitle: String?
    public let threadNameSource: String?
    public let taskTitleSource: String?
    private let storedAccount: String?

    public var computer: String? { ReloNames.display(storedComputer) }
    public var project: String? { ReloNames.display(storedProject) }
    public var threadName: String? { ReloNames.display(storedThreadName) }
    public var taskTitle: String? { ReloNames.display(storedTaskTitle) }
    public var account: String? { ReloNames.display(storedAccount) }

    private enum CodingKeys: String, CodingKey {
        case providerName, producerKind, providerThreadId, providerWorkItemId, threadNameSource, taskTitleSource
        case storedComputer = "computer", storedProject = "project", storedThreadName = "threadName"
        case storedTaskTitle = "taskTitle", storedAccount = "account"
    }

    public init(
        providerName: String? = nil,
        producerKind: String? = nil,
        computer: String? = nil,
        project: String? = nil,
        providerThreadId: String? = nil,
        providerWorkItemId: String? = nil,
        threadName: String? = nil,
        taskTitle: String? = nil,
        threadNameSource: String? = nil,
        taskTitleSource: String? = nil,
        account: String? = nil
    ) {
        self.storedAccount = account
        self.providerName = providerName
        self.producerKind = producerKind
        self.storedComputer = computer
        self.storedProject = project
        self.providerThreadId = providerThreadId
        self.providerWorkItemId = providerWorkItemId
        self.storedThreadName = threadName
        self.storedTaskTitle = taskTitle
        self.threadNameSource = threadNameSource
        self.taskTitleSource = taskTitleSource
    }

    /// "MacBook Pro · Work", "MacBook Pro", "Work", or nil when neither is known.
    public var originLabel: String? {
        let parts = [computer, account].compactMap { value -> String? in
            let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return trimmed.isEmpty ? nil : trimmed
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

public struct InboxActivitySummary: Codable, Equatable, Sendable {
    public let id: String
    public let originThreadId: String?
    public let conversationId: String?
    public let workItemId: String?
    public let generation: Int
    public let sequence: Int
    public let state: String
    public let title: String
    public let status: String
    public let detail: String?
    public let progress: Double?
    public let terminalReason: String?
    public let context: InboxContext?
    public let createdAt: Date?
    public let updatedAt: Date?
    public let staleAt: Date?
    public let expiresAt: Date?
    public let endedAt: Date?

    public init(
        id: String,
        originThreadId: String? = nil,
        conversationId: String? = nil,
        workItemId: String? = nil,
        generation: Int,
        sequence: Int,
        state: String,
        title: String,
        status: String,
        detail: String? = nil,
        progress: Double? = nil,
        terminalReason: String? = nil,
        context: InboxContext? = nil,
        createdAt: Date? = nil,
        updatedAt: Date? = nil,
        staleAt: Date? = nil,
        expiresAt: Date? = nil,
        endedAt: Date? = nil
    ) {
        self.id = id
        self.originThreadId = originThreadId
        self.conversationId = conversationId
        self.workItemId = workItemId
        self.generation = generation
        self.sequence = sequence
        self.state = state
        self.title = title
        self.status = status
        self.detail = detail
        self.progress = progress
        self.terminalReason = terminalReason
        self.context = context
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.staleAt = staleAt
        self.expiresAt = expiresAt
        self.endedAt = endedAt
    }
}

public struct InboxResourceSource: Codable, Equatable, Sendable {
    public let id: String
    public let kind: String
    public let name: String

    public init(id: String, kind: String, name: String) {
        self.id = id
        self.kind = kind
        self.name = name
    }
}

public struct InboxResourceProject: Codable, Equatable, Sendable {
    public struct Palette: Codable, Equatable, Sendable {
        public let slot: Int
        public let generation: Int

        public init(slot: Int, generation: Int) {
            self.slot = slot
            self.generation = generation
        }
    }

    public let id: String
    public let name: String
    public let isDirect: Bool
    public let palette: Palette
    public let icon: String
    public let revision: Int

    public init(id: String, name: String, isDirect: Bool, palette: Palette, icon: String, revision: Int) {
        self.id = id
        self.name = name
        self.isDirect = isDirect
        self.palette = palette
        self.icon = icon
        self.revision = revision
    }
}

public struct InboxResourceLinks: Codable, Equatable, Sendable {
    public let source: InboxResourceSource
    public let project: InboxResourceProject
    public let conversationId: String?
    public let workItemId: String?

    public init(
        source: InboxResourceSource,
        project: InboxResourceProject,
        conversationId: String? = nil,
        workItemId: String? = nil
    ) {
        self.source = source
        self.project = project
        self.conversationId = conversationId
        self.workItemId = workItemId
    }
}

public struct InboxItem: Codable, Equatable, Identifiable, Sendable {
    public struct Content: Codable, Equatable, Sendable {
        public enum Format: String, Codable, Sendable { case text, markdown }
        public let summary: String
        public let body: String
        public let format: Format
        public let byteLength: Int

        public init(summary: String, body: String, format: Format, byteLength: Int) {
            self.summary = summary
            self.body = body
            self.format = format
            self.byteLength = byteLength
        }
    }

    public enum Kind: String, Codable, CaseIterable, Sendable {
        case notification
        case liveActivity = "live_activity"
        case response
    }

    public enum DeliveryState: String, Codable, CaseIterable, Sendable {
        case queued
        case sending
        case acceptedByAPNs = "accepted_by_apns"
        case retryable
        case reconciliationRequired = "reconciliation_required"
        case rejected
        case tokenInvalid = "token_invalid"
    }

    public let id: String
    public let kind: Kind
    public let sourceName: String
    public let sourceImageUrl: URL?
    public let title: String
    public let detail: String?
    public let content: Content?
    public let readAt: Date?
    public let withdrawnAt: Date?
    public let result: String?
    public let deliveryState: DeliveryState?
    public let apnsAcceptedAt: Date?
    public let receivedAt: Date?
    public let openedAt: Date?
    public let createdAt: Date
    public let destinationUrl: URL?
    public let privacy: NotificationPrivacy
    public let liveActivity: LiveActivityCommand?
    public let activitySummary: InboxActivitySummary?
    /// A card event's identity, kept when history drops the full command, so its events stay one card.
    public let activityEvent: InboxHistoryMetadata.ActivityEvent?
    /// Where the card behind a history event stands now.
    public let activity: InboxCardDigest?
    public let interaction: InboxInteraction?
    public let context: InboxContext?
    public let resources: InboxResourceLinks?
    /// End-to-end sealed envelopes (docs/END-TO-END-ENCRYPTION.md); text above is a placeholder until opened.
    public let sealed: InboxSealedNotice?

    public init(
        id: String,
        kind: Kind,
        sourceName: String,
        sourceImageUrl: URL? = nil,
        title: String,
        detail: String? = nil,
        content: Content? = nil,
        readAt: Date? = nil,
        withdrawnAt: Date? = nil,
        result: String? = nil,
        deliveryState: DeliveryState? = nil,
        apnsAcceptedAt: Date? = nil,
        receivedAt: Date? = nil,
        openedAt: Date? = nil,
        createdAt: Date,
        destinationUrl: URL? = nil,
        privacy: NotificationPrivacy = .standard,
        liveActivity: LiveActivityCommand? = nil,
        activitySummary: InboxActivitySummary? = nil,
        interaction: InboxInteraction? = nil,
        context: InboxContext? = nil,
        resources: InboxResourceLinks? = nil,
        activityEvent: InboxHistoryMetadata.ActivityEvent? = nil,
        activity: InboxCardDigest? = nil,
        sealed: InboxSealedNotice? = nil
    ) {
        self.id = id
        self.kind = kind
        self.sourceName = sourceName
        self.sourceImageUrl = sourceImageUrl
        self.title = title
        self.detail = detail
        self.content = content
        self.readAt = readAt
        self.withdrawnAt = withdrawnAt
        self.result = result
        self.deliveryState = deliveryState
        self.apnsAcceptedAt = apnsAcceptedAt
        self.receivedAt = receivedAt
        self.openedAt = openedAt
        self.createdAt = createdAt
        self.destinationUrl = destinationUrl
        self.privacy = privacy
        self.liveActivity = liveActivity
        self.activitySummary = activitySummary
        self.activityEvent = activityEvent
        self.activity = activity
        self.interaction = interaction
        self.context = context
        self.resources = resources
        self.sealed = sealed
    }

    public var validatedDestinationURL: URL? {
        destinationUrl.flatMap(NotificationDestinationPolicy.validatedURL)
    }

    public var validatedSourceImageURL: URL? {
        guard privacy == .standard else { return nil }
        return sourceImageUrl.flatMap(NotificationImagePolicy.validatedURL)
    }

    private enum CodingKeys: String, CodingKey {
        case id, kind, sourceName, sourceImageUrl, title, detail, content, readAt, withdrawnAt
        case result, deliveryState
        case apnsAcceptedAt, receivedAt, openedAt, createdAt, destinationUrl, privacy
        case liveActivity, activitySummary, interaction, context, resources, activityEvent, activity, sealed
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        kind = try values.decode(Kind.self, forKey: .kind)
        sourceName = try values.decode(String.self, forKey: .sourceName)
        sourceImageUrl = try values.decodeIfPresent(URL.self, forKey: .sourceImageUrl)
        title = try values.decode(String.self, forKey: .title)
        detail = try values.decodeIfPresent(String.self, forKey: .detail)
        content = try values.decodeIfPresent(Content.self, forKey: .content)
        readAt = try values.decodeIfPresent(Date.self, forKey: .readAt)
        withdrawnAt = try values.decodeIfPresent(Date.self, forKey: .withdrawnAt)
        result = try values.decodeIfPresent(String.self, forKey: .result)
        deliveryState = try values.decodeIfPresent(DeliveryState.self, forKey: .deliveryState)
        apnsAcceptedAt = try values.decodeIfPresent(Date.self, forKey: .apnsAcceptedAt)
        receivedAt = try values.decodeIfPresent(Date.self, forKey: .receivedAt)
        openedAt = try values.decodeIfPresent(Date.self, forKey: .openedAt)
        createdAt = try values.decode(Date.self, forKey: .createdAt)
        destinationUrl = try values.decodeIfPresent(URL.self, forKey: .destinationUrl)
        privacy = try values.decodeIfPresent(NotificationPrivacy.self, forKey: .privacy) ?? .standard
        liveActivity = try values.decodeIfPresent(LiveActivityCommand.self, forKey: .liveActivity)
        activitySummary = try values.decodeIfPresent(InboxActivitySummary.self, forKey: .activitySummary)
        activityEvent = try values.decodeIfPresent(InboxHistoryMetadata.ActivityEvent.self, forKey: .activityEvent)
        activity = try values.decodeIfPresent(InboxCardDigest.self, forKey: .activity)
        // An interaction kind or state from a newer server leaves the item readable without it.
        interaction = try values.decodeSupportedInteraction(
            InboxInteraction.self, forKey: .interaction, isSupported: InboxInteraction.isSupported)
        context = try values.decodeIfPresent(InboxContext.self, forKey: .context)
        resources = try values.decodeIfPresent(InboxResourceLinks.self, forKey: .resources)
        sealed = try values.decodeIfPresent(InboxSealedNotice.self, forKey: .sealed)
    }
}

public struct DeliveryEvidenceSerialization: Decodable, Equatable, Sendable {
    public let canonicalIntent: String?
    public let deviceProjection: String?
    public let providerBytes: String?
}

public struct DeliveryEvidenceItem: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let notificationId: String
    public let deliveryId: String?
    public let attemptId: String?
    public let deviceId: String?
    public let activityId: String?
    public let stage: String
    public let stageOrder: Int
    public let state: String
    public let detailCode: String?
    public let serialization: DeliveryEvidenceSerialization?
    public let occurredAt: Date
}

public struct DeliveryEvidenceResponse: Decodable, Equatable, Sendable {
    public let version: Int
    public let order: String
    public let items: [DeliveryEvidenceItem]
    public let cursor: String?
    public let hasMore: Bool
}

public struct InboxNotificationDetail: Decodable, Equatable, Sendable {
    public struct Evidence: Decodable, Equatable, Sendable {
        public struct Delivery: Decodable, Equatable, Sendable {
            public let id: String
            public let deviceId: String?
            public let transport: String
            public let state: String
            public let attemptCount: Int
            public let providerOutcome: String?
            public let errorCode: String?
            public let acceptedAt: Date?
            public let createdAt: Date
            public let updatedAt: Date
        }

        public struct Interaction: Decodable, Equatable, Sendable {
            public let kind: String
            public let createdAt: Date
        }

        public struct Withdrawal: Decodable, Equatable, Sendable {
            public let deviceId: String?
            public let outcome: String
            public let detailCode: String?
            public let createdAt: Date
        }

        public let version: Int
        public let timeline: [DeliveryEvidenceItem]
        public let deliveries: [Delivery]
        public let interactions: [Interaction]
        public let withdrawals: [Withdrawal]

        private enum CodingKeys: String, CodingKey {
            case version, timeline, deliveries, interactions, withdrawals
        }

        public init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            version = try values.decodeIfPresent(Int.self, forKey: .version) ?? 1
            timeline = try values.decodeIfPresent([DeliveryEvidenceItem].self, forKey: .timeline) ?? []
            deliveries = try values.decode([Delivery].self, forKey: .deliveries)
            interactions = try values.decode([Interaction].self, forKey: .interactions)
            withdrawals = try values.decode([Withdrawal].self, forKey: .withdrawals)
        }
    }

    public let item: InboxItem
    public let evidence: Evidence
}

public struct InboxHistoryPresentationState: Equatable, Sendable {
    public var searchQuery: String
    public var filterIdentifier: String
    public private(set) var visibleLimit: Int
    public private(set) var scopeIdentity: String?
    private let defaultFilterIdentifier: String

    public init(defaultFilterIdentifier: String) {
        self.searchQuery = ""
        self.filterIdentifier = defaultFilterIdentifier
        self.visibleLimit = InboxHistoryProjection.pageSize
        self.scopeIdentity = nil
        self.defaultFilterIdentifier = defaultFilterIdentifier
    }

    public mutating func transition(to scopeIdentity: String) {
        guard self.scopeIdentity != scopeIdentity else { return }
        self.scopeIdentity = scopeIdentity
        searchQuery = ""
        filterIdentifier = defaultFilterIdentifier
        visibleLimit = InboxHistoryProjection.pageSize
    }

    public mutating func resetPagination() {
        visibleLimit = InboxHistoryProjection.pageSize
    }

    public mutating func showMore(available: Int) {
        visibleLimit = InboxHistoryProjection.nextVisibleLimit(
            current: visibleLimit,
            available: available
        )
    }
}

public struct InboxSnapshot: Codable, Equatable, Sendable {
    public var total: Int? = nil
    public var historyMetadata: [String: InboxHistoryMetadata]? = nil
    public var items: [InboxItem]
    public var cursor: String?
    public var lastSuccessfulSyncAt: Date?
    public var readWatermark: String?
    public var unread: InboxUnreadSummary?
    /// Agent sessions from the server; nil from older servers.
    public var sessions: [AgentSession]? = nil

    public init(
        items: [InboxItem] = [],
        cursor: String? = nil,
        lastSuccessfulSyncAt: Date? = nil,
        readWatermark: String? = nil,
        unread: InboxUnreadSummary? = nil
    ) {
        self.items = items
        self.cursor = cursor
        self.lastSuccessfulSyncAt = lastSuccessfulSyncAt
        self.readWatermark = readWatermark
        self.unread = unread
    }
}

public struct InboxPage: Codable, Equatable, Sendable {
    public let items: [InboxItem]
    public let cursor: String?
    public let hasMore: Bool
    public let serverTime: Date
    public let readWatermark: String?
    public let unread: InboxUnreadSummary?

    public init(
        items: [InboxItem],
        cursor: String?,
        hasMore: Bool,
        serverTime: Date,
        readWatermark: String? = nil,
        unread: InboxUnreadSummary? = nil
    ) {
        self.items = items
        self.cursor = cursor
        self.hasMore = hasMore
        self.serverTime = serverTime
        self.readWatermark = readWatermark
        self.unread = unread
    }
}

public struct InboxHistoryPage: Codable, Equatable, Sendable {
    public static let maximumItems = 100
    public let items: [InboxItem]
    public let cursor: String?
    public let hasMore: Bool
    public let total: Int
    public let serverTime: Date
    public let readWatermark: String?
    public let unread: InboxUnreadSummary?

    public init(
        items: [InboxItem],
        cursor: String?,
        hasMore: Bool,
        total: Int,
        serverTime: Date,
        readWatermark: String? = nil,
        unread: InboxUnreadSummary? = nil
    ) {
        self.items = items
        self.cursor = cursor
        self.hasMore = hasMore
        self.total = total
        self.serverTime = serverTime
        self.readWatermark = readWatermark
        self.unread = unread
    }
}

public struct InboxUnreadSummary: Codable, Equatable, Sendable {
    public let account: Int
    public let projects: [String: Int]

    public init(account: Int, projects: [String: Int]) {
        self.account = account
        self.projects = projects
    }
}

public struct InboxHistorySnapshot: Equatable, Sendable {
    public enum Source: Equatable, Sendable {
        case offlineCache
        case server
    }

    public let items: [InboxItem]
    public let cursor: String?
    public let hasMore: Bool
    public let total: Int?
    public let source: Source

    public init(
        items: [InboxItem],
        cursor: String?,
        hasMore: Bool,
        total: Int?,
        source: Source
    ) {
        self.items = items
        self.cursor = cursor
        self.hasMore = hasMore
        self.total = total
        self.source = source
    }

    public static func offlineCache(items: [InboxItem]) -> InboxHistorySnapshot {
        InboxHistorySnapshot(
            items: InboxHistoryRetention.retainingNewest(items),
            cursor: nil,
            hasMore: false,
            total: nil,
            source: .offlineCache
        )
    }
}

public struct InboxSelectedItemSnapshot: Equatable, Sendable {
    public private(set) var item: InboxItem?
    public private(set) var scopeIdentity: String?

    public init(item: InboxItem? = nil, scopeIdentity: String? = nil) {
        self.item = item
        self.scopeIdentity = scopeIdentity
    }

    public mutating func select(_ item: InboxItem, scopeIdentity: String) {
        self.item = item
        self.scopeIdentity = scopeIdentity
    }

    public mutating func reconcile(scopeIdentity: String, availableItems: [InboxItem]) {
        guard self.scopeIdentity == scopeIdentity else {
            dismiss()
            return
        }
        guard let selectedID = item?.id else { return }
        if let refreshed = availableItems.first(where: { $0.id == selectedID }) {
            item = refreshed
        }
        // A selected arbitrary-age item may not be present in page one or the
        // bounded offline projection. Retain it until explicit dismissal.
    }

    public mutating func dismiss() {
        item = nil
        scopeIdentity = nil
    }
}

public enum InboxRemoteError: Error, Equatable, Sendable {
    case cursorExpired
    case unauthorized
    case tailnetUnavailable
    case incompatibleResponse
    case unavailable
}

public struct InboxReadMutationResponse: Codable, Equatable, Sendable {
    public let changed: Int
    public let readAt: Date?
    public let readWatermark: String?
    public let unread: InboxUnreadSummary

    private enum CodingKeys: String, CodingKey { case changed, readAt, readWatermark, unread }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        if let count = try? values.decode(Int.self, forKey: .changed) {
            changed = count
        } else {
            changed = (try values.decode(Bool.self, forKey: .changed)) ? 1 : 0
        }
        readAt = try values.decodeIfPresent(Date.self, forKey: .readAt)
        readWatermark = try values.decodeIfPresent(String.self, forKey: .readWatermark)
        unread = try values.decode(InboxUnreadSummary.self, forKey: .unread)
    }
}
