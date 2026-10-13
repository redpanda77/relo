import ReloCore
import Foundation

public actor FileNotificationDetailCache: NotificationDetailCaching {
    public static let maximumEntries = 50
    public static let maximumBytes = 4 * 1_024 * 1_024
    private struct Envelope: Codable {
        let version: Int
        let scope: StorageScope
        var items: [InboxItem]
    }
    private let scope: StorageScope
    private let url: URL
    private let io: any InboxStorageIO

    public init(baseDirectory: URL, scope: StorageScope, io: any InboxStorageIO = FileInboxStorageIO()) {
        self.scope = scope
        self.url = baseDirectory.appendingPathComponent(scope.fileKey).appendingPathComponent("details.json")
        self.io = io
    }

    public func load(notificationID: String) throws -> InboxItem? {
        var envelope = try read()
        guard let index = envelope.items.firstIndex(where: { $0.id == notificationID }) else { return nil }
        let item = envelope.items.remove(at: index)
        envelope.items.insert(item, at: 0)
        try write(envelope)
        return item
    }

    public func save(_ item: InboxItem) throws {
        try Task.checkCancellation()
        var envelope = try read()
        envelope.items.removeAll { $0.id == item.id }
        envelope.items.insert(item, at: 0)
        envelope.items = Array(envelope.items.prefix(Self.maximumEntries))
        while try JSONEncoder().encode(envelope).count > Self.maximumBytes {
            envelope.items.removeLast()
        }
        try Task.checkCancellation()
        try write(envelope)
    }

    public func clear() throws {
        do { try io.remove(url: url) }
        catch where InboxStorageFailure.isMissing(error) { return }
        catch { throw InboxStorageError.unavailable }
    }

    private func read() throws -> Envelope {
        let data: Data
        do { data = try io.read(url: url) }
        catch where InboxStorageFailure.isMissing(error) { return Envelope(version: 1, scope: scope, items: []) }
        catch { throw InboxStorageError.unavailable }
        guard data.count <= Self.maximumBytes else { throw InboxStorageError.corrupt }
        guard let envelope = try? JSONDecoder().decode(Envelope.self, from: data),
              envelope.version == 1, envelope.scope == scope, envelope.items.count <= Self.maximumEntries,
              Set(envelope.items.map(\.id)).count == envelope.items.count else { throw InboxStorageError.corrupt }
        return envelope
    }

    private func write(_ envelope: Envelope) throws {
        let data = try JSONEncoder().encode(envelope)
        do { try io.replace(data: data, at: url) }
        catch { throw InboxStorageError.unavailable }
    }
}

public actor InMemoryNotificationDetailCache: NotificationDetailCaching {
    private var items: [InboxItem] = []
    public init() {}
    public func load(notificationID: String) -> InboxItem? { items.first { $0.id == notificationID } }
    public func save(_ item: InboxItem) {
        items.removeAll { $0.id == item.id }; items.insert(item, at: 0)
        items = Array(items.prefix(FileNotificationDetailCache.maximumEntries))
    }
    public func clear() { items = [] }
}
