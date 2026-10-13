import ReloCore
import Foundation

public actor FileCurrentStateCache: CurrentStateCaching {
    private struct Envelope: Codable { let schemaVersion: Int; let scope: StorageScope; let snapshot: CurrentCacheSnapshot }
    private struct Header: Decodable { let schemaVersion: Int }
    public static let maximumBytes = 16 * 1_024 * 1_024
    private let scope: StorageScope
    private let url: URL
    private let io: any InboxStorageIO
    private let wallTime: @Sendable () -> Date
    public private(set) var lastRecovery: InboxCacheRecovery?

    public init(baseDirectory: URL, scope: StorageScope, io: any InboxStorageIO = FileInboxStorageIO(), wallTime: @escaping @Sendable () -> Date = { Date() }) {
        self.scope = scope; self.io = io; self.wallTime = wallTime
        self.url = baseDirectory.appendingPathComponent(scope.fileKey, isDirectory: true).appendingPathComponent("current.json")
    }

    public func load() throws -> CurrentCacheSnapshot {
        let data: Data
        do { data = try io.read(url: url) }
        catch where InboxStorageFailure.isMissing(error) { return CurrentCacheSnapshot() }
        catch { throw InboxStorageError.unavailable }
        guard data.count <= Self.maximumBytes else { throw CurrentCacheCapacityError.limitReached }
        var snapshot: CurrentCacheSnapshot
        do {
            let version = try JSONDecoder().decode(Header.self, from: data).schemaVersion
            guard version == 1 else { throw InboxStorageError.unsupportedSchema(version) }
            let value = try JSONDecoder().decode(Envelope.self, from: data)
            guard value.scope == scope, value.snapshot.isValid else { throw InboxStorageError.corrupt }
            snapshot = value.snapshot
        } catch InboxStorageError.unsupportedSchema(let version) where version > 1 {
            throw InboxStorageError.unsupportedSchema(version)
        } catch {
            let reason: InboxCacheRecovery = (error as? InboxStorageError).map {
                if case .unsupportedSchema = $0 { return .retiredSchema }; return .corrupt
            } ?? .corrupt
            try InboxCacheStorage.remove(from: url, io: io)
            lastRecovery = reason
            return CurrentCacheSnapshot()
        }
        // Persist cold-launch expiry before returning it so a later clock rollback
        // cannot reopen the same version. Storage failure preserves the original bytes.
        let wall = wallTime()
        if let lowerBound = snapshot.conservativeTimeAfterRestart(wallTime: wall) {
            let original = snapshot
            snapshot.expire(at: lowerBound)
            if snapshot != original {
                snapshot.prepareForSave(wallTime: wall)
                try save(snapshot)
            }
        }
        return snapshot
    }

    public func save(_ snapshot: CurrentCacheSnapshot) throws {
        try Task.checkCancellation()
        guard snapshot.isValid else { throw InboxStorageError.corrupt }
        let data = try JSONEncoder().encode(Envelope(schemaVersion: 1, scope: scope, snapshot: snapshot))
        // Fail visibly without evicting a still-valid approval or its retirement fence.
        guard data.count <= Self.maximumBytes else { throw CurrentCacheCapacityError.limitReached }
        try Task.checkCancellation()
        do { try io.replace(data: data, at: url) }
        catch { throw InboxStorageError.unavailable }
    }
}
