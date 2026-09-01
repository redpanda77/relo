import Foundation

enum ReloProtectedFileWritingOptions {
    static var complete: Data.WritingOptions {
        #if os(iOS)
        [.atomic, .completeFileProtection]
        #else
        .atomic
        #endif
    }

    static var afterFirstUnlock: Data.WritingOptions {
        #if os(iOS)
        [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        #else
        .atomic
        #endif
    }
}

public enum DevelopmentResetSchema {
    public static let currentVersion = 2
}

public enum LocalStoreSchema {
    public static let accountSession = 1
    public static let deviceCredential = 1
    public static let installationID = 1
    public static let stableDeviceID = 1
    public static let pushToken = 1
    public static let registrationAttempt = 1
    public static let signOutProgress = 1
    public static let inboxCache = 1
    public static let liveActivityLedger = 1
    public static let pendingResponses = 1
    public static let responseConfirmations = 1
    public static let crossProcessResponses = 1
    public static let pendingNotificationReceipts = 1
}

public struct VersionedStorageEnvelope<Payload: Codable>: Codable {
    public let schemaVersion: Int
    public let payload: Payload

    public init(schemaVersion: Int, payload: Payload) {
        self.schemaVersion = schemaVersion
        self.payload = payload
    }
}

public enum VersionedStorageError: Error, Equatable {
    case unsupportedSchemaVersion(Int)
    case malformedEnvelope
}

public struct VersionedStorageDecodeResult<Payload> {
    public let payload: Payload
}

public enum VersionedStorageCodec {
    public static func encode<Payload: Codable>(
        _ payload: Payload,
        schemaVersion: Int
    ) throws -> Data {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return try encoder.encode(VersionedStorageEnvelope(
            schemaVersion: schemaVersion,
            payload: payload
        ))
    }

    public static func decode<Payload: Codable>(
        _ type: Payload.Type,
        from data: Data,
        schemaVersion: Int
    ) throws -> VersionedStorageDecodeResult<Payload> {
        guard
            let object = try JSONSerialization.jsonObject(
                with: data,
                options: [.fragmentsAllowed]
            ) as? [String: Any],
            let sourceVersion = object["schemaVersion"] as? Int,
            let rawPayload = object["payload"]
        else { throw VersionedStorageError.malformedEnvelope }
        guard sourceVersion == schemaVersion else {
            throw VersionedStorageError.unsupportedSchemaVersion(sourceVersion)
        }
        let payloadData = try JSONSerialization.data(
            withJSONObject: rawPayload,
            options: [.fragmentsAllowed, .sortedKeys]
        )

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return VersionedStorageDecodeResult(
            payload: try decoder.decode(Payload.self, from: payloadData)
        )
    }

    public static func isVersioned(_ data: Data) -> Bool {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return false
        }
        return object["schemaVersion"] != nil
    }
}

struct CachedInboxSnapshot: Codable {
    var items: [CachedInboxItem]
    var cursor: String?
    var lastSuccessfulSyncAt: Date?

    init(_ snapshot: InboxSnapshot) {
        items = snapshot.items.map(CachedInboxItem.init)
        cursor = snapshot.cursor
        lastSuccessfulSyncAt = snapshot.lastSuccessfulSyncAt
    }

    var snapshot: InboxSnapshot {
        InboxSnapshot(
            items: items.map(\.item),
            cursor: cursor,
            lastSuccessfulSyncAt: lastSuccessfulSyncAt
        )
    }
}

struct CachedInboxItem: Codable {
    let id: String
    let kind: InboxItem.Kind
    let sourceName: String
    let sourceImageUrl: URL?
    let title: String
    let detail: String?
    let content: InboxItem.Content?
    let readAt: Date?
    let withdrawnAt: Date?
    let result: String?
    let deliveryState: InboxItem.DeliveryState?
    let apnsAcceptedAt: Date?
    let receivedAt: Date?
    let openedAt: Date?
    let createdAt: Date
    let destinationUrl: URL?
    let privacy: NotificationPrivacy
    let liveActivity: LiveActivityCommand?
    let activitySummary: InboxActivitySummary?
    let interaction: InboxInteraction?
    let context: InboxContext?

    init(_ item: InboxItem) {
        id = item.id
        kind = item.kind
        sourceName = item.sourceName
        sourceImageUrl = item.sourceImageUrl
        title = item.title
        detail = item.detail
        content = item.content
        readAt = item.readAt
        withdrawnAt = item.withdrawnAt
        result = item.result
        deliveryState = item.deliveryState
        apnsAcceptedAt = item.apnsAcceptedAt
        receivedAt = item.receivedAt
        openedAt = item.openedAt
        createdAt = item.createdAt
        destinationUrl = item.destinationUrl
        privacy = item.privacy
        liveActivity = item.liveActivity
        activitySummary = item.activitySummary
        interaction = item.interaction
        context = item.context
    }

    var item: InboxItem {
        InboxItem(
            id: id,
            kind: kind,
            sourceName: sourceName,
            sourceImageUrl: sourceImageUrl,
            title: title,
            detail: detail,
            content: content,
            readAt: readAt,
            withdrawnAt: withdrawnAt,
            result: result,
            deliveryState: deliveryState,
            apnsAcceptedAt: apnsAcceptedAt,
            receivedAt: receivedAt,
            openedAt: openedAt,
            createdAt: createdAt,
            destinationUrl: destinationUrl,
            privacy: privacy,
            liveActivity: liveActivity,
            activitySummary: activitySummary,
            interaction: interaction,
            context: context
        )
    }
}

enum InboxCacheStorage {
    static func decode(_ data: Data) throws -> (snapshot: InboxSnapshot, migrated: Bool) {
        let decoded = try VersionedStorageCodec.decode(
            CachedInboxSnapshot.self,
            from: data,
            schemaVersion: LocalStoreSchema.inboxCache
        )
        return (decoded.payload.snapshot, false)
    }

    static func encode(_ snapshot: InboxSnapshot) throws -> Data {
        try VersionedStorageCodec.encode(
            CachedInboxSnapshot(snapshot),
            schemaVersion: LocalStoreSchema.inboxCache
        )
    }
}

public actor FileInboxCache: InboxCache {
    private let fileURL: URL
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    public init(fileURL: URL) {
        self.fileURL = fileURL
        self.encoder = JSONEncoder()
        self.decoder = JSONDecoder()
        self.encoder.dateEncodingStrategy = .iso8601
        self.decoder.dateDecodingStrategy = .iso8601
    }

    public func load() throws -> InboxSnapshot {
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            return InboxSnapshot()
        }
        let stored: InboxSnapshot
        do {
            let decoded = try InboxCacheStorage.decode(Data(contentsOf: fileURL))
            stored = decoded.snapshot
            if decoded.migrated { try save(stored) }
        } catch {
            try? FileManager.default.removeItem(at: fileURL)
            return InboxSnapshot()
        }
        let retained = InboxHistoryRetention.retainingNewest(in: stored)
        if retained != stored {
            try save(retained)
        }
        return retained
    }

    public func save(_ snapshot: InboxSnapshot) throws {
        let directory = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try InboxCacheStorage.encode(InboxHistoryRetention.retainingNewest(in: snapshot))
            .write(to: fileURL, options: ReloProtectedFileWritingOptions.complete)
    }
}

public actor InMemoryInboxCache: InboxCache {
    private var snapshot: InboxSnapshot

    public init(snapshot: InboxSnapshot = InboxSnapshot()) {
        self.snapshot = InboxHistoryRetention.retainingNewest(in: snapshot)
    }

    public func load() -> InboxSnapshot { snapshot }

    public func save(_ snapshot: InboxSnapshot) {
        self.snapshot = InboxHistoryRetention.retainingNewest(in: snapshot)
    }
}

public enum AccountScopedInboxCacheError: Error, Equatable {
    case invalidAccountId
    case accountNotSelected
}

public protocol AccountScopedInboxCaching: InboxCache {
    func select(accountId: String) async throws
    func boundCache(for accountId: String) async throws -> any InboxCache
    func clearSelectedAccount() async throws
}

public actor AccountScopedInboxCache: AccountScopedInboxCaching {
    private let baseDirectory: URL
    private var selectedFileURL: URL?

    public init(baseDirectory: URL) {
        self.baseDirectory = baseDirectory
    }

    public func select(accountId: String) throws {
        guard Self.isSafeAccountId(accountId) else {
            throw AccountScopedInboxCacheError.invalidAccountId
        }
        selectedFileURL = accountFileURL(accountId: accountId)
    }

    public func boundCache(for accountId: String) throws -> any InboxCache {
        guard Self.isSafeAccountId(accountId) else {
            throw AccountScopedInboxCacheError.invalidAccountId
        }
        return FileInboxCache(fileURL: accountFileURL(accountId: accountId))
    }

    public func load() throws -> InboxSnapshot {
        guard let selectedFileURL else { throw AccountScopedInboxCacheError.accountNotSelected }
        guard let stored = try Self.load(from: selectedFileURL) else { return InboxSnapshot() }
        let retained = InboxHistoryRetention.retainingNewest(in: stored)
        if retained != stored {
            try Self.save(retained, to: selectedFileURL)
        }
        return retained
    }

    public func save(_ snapshot: InboxSnapshot) throws {
        guard let selectedFileURL else { throw AccountScopedInboxCacheError.accountNotSelected }
        try Self.save(InboxHistoryRetention.retainingNewest(in: snapshot), to: selectedFileURL)
    }

    public func clearSelectedAccount() throws {
        guard let selectedFileURL else { throw AccountScopedInboxCacheError.accountNotSelected }
        if FileManager.default.fileExists(atPath: selectedFileURL.path) {
            try FileManager.default.removeItem(at: selectedFileURL)
        }
    }

    private static func load(from url: URL) throws -> InboxSnapshot? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        do {
            let decoded = try InboxCacheStorage.decode(Data(contentsOf: url))
            if decoded.migrated { try save(decoded.snapshot, to: url) }
            return decoded.snapshot
        } catch {
            try? FileManager.default.removeItem(at: url)
            return nil
        }
    }

    private static func save(_ snapshot: InboxSnapshot, to url: URL) throws {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try InboxCacheStorage.encode(snapshot)
            .write(to: url, options: ReloProtectedFileWritingOptions.complete)
    }

    private func accountFileURL(accountId: String) -> URL {
        baseDirectory
            .appendingPathComponent(accountId, isDirectory: true)
            .appendingPathComponent("inbox.json")
    }

    private static func isSafeAccountId(_ value: String) -> Bool {
        let punctuation = CharacterSet(charactersIn: "_-")
        return !value.isEmpty && value.unicodeScalars.allSatisfy {
            CharacterSet.alphanumerics.contains($0) || punctuation.contains($0)
        }
    }
}
