import ReloCore
import Foundation

public actor FilePendingReadStore: PendingReadStoring {
    public static let maximumEntries = 1_000
    private struct Record: Codable { let id: String; let capturedAt: Date }
    private struct Envelope: Codable { let version: Int; let scope: StorageScope; var records: [Record] }
    private let scope: StorageScope
    private let url: URL
    private let io: any InboxStorageIO
    private let now: @Sendable () -> Date

    public init(baseDirectory: URL, scope: StorageScope, io: any InboxStorageIO = FileInboxStorageIO(),
                now: @escaping @Sendable () -> Date = { Date() }) {
        self.scope = scope; self.io = io; self.now = now
        url = baseDirectory.appendingPathComponent(scope.fileKey).appendingPathComponent("pending-reads.json")
    }

    public func enqueue(_ notificationIDs: [String]) throws {
        guard notificationIDs.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 256 }) else { throw PendingReadError.invalidID }
        var envelope = try read()
        var known = Set(envelopeIDs(envelope))
        var additions: [Record] = []
        let capturedAt = now()
        for id in notificationIDs where known.insert(id).inserted { additions.append(.init(id: id, capturedAt: capturedAt)) }
        guard envelope.records.count + additions.count <= Self.maximumEntries else { throw PendingReadError.full }
        guard !additions.isEmpty else { return }
        envelope.records += additions
        try write(envelope)
    }

    public func pending(limit: Int) throws -> [String] {
        guard limit > 0 else { return [] }
        return Array(try read().records.prefix(min(limit, Self.maximumEntries)).map(\.id))
    }

    public func remove(_ notificationIDs: Set<String>) throws {
        guard !notificationIDs.isEmpty else { return }
        var envelope = try read()
        envelope.records.removeAll { notificationIDs.contains($0.id) }
        try write(envelope)
    }

    private func envelopeIDs(_ envelope: Envelope) -> [String] { envelope.records.map(\.id) }
    private func read() throws -> Envelope {
        let data: Data
        do { data = try io.read(url: url) }
        catch where InboxStorageFailure.isMissing(error) { return .init(version: 1, scope: scope, records: []) }
        catch { throw PendingReadError.unavailable }
        guard data.count <= 1_048_576,
              let envelope = try? JSONDecoder().decode(Envelope.self, from: data) else { throw PendingReadError.corrupt }
        guard envelope.version == 1 else { throw PendingReadError.unsupportedVersion }
        guard envelope.scope == scope, envelope.records.count <= Self.maximumEntries,
              Set(envelopeIDs(envelope)).count == envelope.records.count,
              envelope.records.allSatisfy({ !$0.id.isEmpty && $0.id.utf8.count <= 256 }) else { throw PendingReadError.corrupt }
        return envelope
    }
    private func write(_ envelope: Envelope) throws {
        let data = try JSONEncoder().encode(envelope)
        do { try io.replace(data: data, at: url) }
        catch { throw PendingReadError.unavailable }
    }
}

public actor InMemoryPendingReadStore: PendingReadStoring {
    private var ids: [String] = []
    public init() {}
    public func enqueue(_ notificationIDs: [String]) throws {
        var known = Set(ids)
        let additions = notificationIDs.filter { known.insert($0).inserted }
        guard ids.count + additions.count <= FilePendingReadStore.maximumEntries else { throw PendingReadError.full }
        ids += additions
    }
    public func pending(limit: Int) -> [String] { Array(ids.prefix(max(0, limit))) }
    public func remove(_ notificationIDs: Set<String>) { ids.removeAll { notificationIDs.contains($0) } }
}
