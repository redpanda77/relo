import ReloCore
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
    public static let computerInvite = 1
    public static let inboxCache = 2
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

enum InboxCacheStorage {
    private struct Header: Decodable { let schemaVersion: Int }

    static func decode(_ data: Data) throws -> (snapshot: InboxSnapshot, migrated: Bool) {
        do {
            let version = try JSONDecoder().decode(Header.self, from: data).schemaVersion
            switch version {
            case 1:
                // The one supported predecessor used ISO dates and omitted optional metadata.
                let old = try VersionedStorageCodec.decode(InboxSnapshot.self, from: data, schemaVersion: 1)
                return (old.payload, true)
            case LocalStoreSchema.inboxCache:
                return (try JSONDecoder().decode(VersionedStorageEnvelope<InboxSnapshot>.self, from: data).payload, false)
            default:
                throw InboxStorageError.unsupportedSchema(version)
            }
        } catch let error as InboxStorageError {
            throw error
        } catch {
            throw InboxStorageError.corrupt
        }
    }

    static func encode(_ snapshot: InboxSnapshot) throws -> Data {
        // Foundation's native Date representation preserves fractional deadlines exactly.
        try JSONEncoder().encode(VersionedStorageEnvelope(schemaVersion: LocalStoreSchema.inboxCache, payload: snapshot))
    }

    static func load(from url: URL, io: any InboxStorageIO) throws -> (InboxSnapshot, InboxCacheRecovery?) {
        let data: Data
        do { data = try io.read(url: url) }
        catch where InboxStorageFailure.isMissing(error) { return (InboxSnapshot(), nil) }
        catch { throw InboxStorageError.unavailable }
        let decoded: (snapshot: InboxSnapshot, migrated: Bool)
        do { decoded = try decode(data) }
        catch InboxStorageError.corrupt {
            try remove(from: url, io: io)
            return (InboxSnapshot(), .corrupt)
        } catch InboxStorageError.unsupportedSchema(let version) where version < LocalStoreSchema.inboxCache {
            try remove(from: url, io: io)
            return (InboxSnapshot(), .retiredSchema)
        }
        // I/O errors during migration/compaction must never enter a corruption catch.
        let retained = InboxHistoryRetention.retainingNewest(in: decoded.snapshot)
        if decoded.migrated || retained != decoded.snapshot { try save(retained, to: url, io: io) }
        return (retained, nil)
    }

    static func save(_ snapshot: InboxSnapshot, to url: URL, io: any InboxStorageIO) throws {
        let data = try encode(InboxHistoryRetention.retainingNewest(in: snapshot))
        do { try io.replace(data: data, at: url) }
        catch { throw InboxStorageError.unavailable }
    }

    static func remove(from url: URL, io: any InboxStorageIO) throws {
        do { try io.remove(url: url) }
        catch where InboxStorageFailure.isMissing(error) { return }
        catch { throw InboxStorageError.unavailable }
    }
}

/// One redacted recovery reason per cache; never captures content, paths, or credentials.
public actor FileInboxCache: InboxCache {
    private let fileURL: URL
    private let io: any InboxStorageIO
    public private(set) var lastRecovery: InboxCacheRecovery?

    public init(fileURL: URL, io: any InboxStorageIO = FileInboxStorageIO()) {
        self.fileURL = fileURL
        self.io = io
    }

    public func load() throws -> InboxSnapshot {
        let (snapshot, recovery) = try InboxCacheStorage.load(from: fileURL, io: io)
        if let recovery { lastRecovery = recovery }
        return snapshot
    }

    public func save(_ snapshot: InboxSnapshot) throws {
        try InboxCacheStorage.save(snapshot, to: fileURL, io: io)
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

public actor AccountScopedInboxCache: AccountScopedInboxCaching {
    private let baseDirectory: URL
    private var selectedFileURL: URL?
    private let io: any InboxStorageIO
    public private(set) var lastRecovery: InboxCacheRecovery?

    public init(baseDirectory: URL, io: any InboxStorageIO = FileInboxStorageIO()) {
        self.baseDirectory = baseDirectory
        self.io = io
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
        return FileInboxCache(fileURL: accountFileURL(accountId: accountId), io: io)
    }

    public func load() throws -> InboxSnapshot {
        guard let selectedFileURL else { throw AccountScopedInboxCacheError.accountNotSelected }
        let (snapshot, recovery) = try InboxCacheStorage.load(from: selectedFileURL, io: io)
        if let recovery { lastRecovery = recovery }
        return snapshot
    }

    public func save(_ snapshot: InboxSnapshot) throws {
        guard let selectedFileURL else { throw AccountScopedInboxCacheError.accountNotSelected }
        try InboxCacheStorage.save(snapshot, to: selectedFileURL, io: io)
    }

    public func clearSelectedAccount() throws {
        guard let selectedFileURL else { throw AccountScopedInboxCacheError.accountNotSelected }
        try InboxCacheStorage.remove(from: selectedFileURL, io: io)
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
