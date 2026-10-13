@testable import ReloPersistence
import Foundation
import Testing
@testable import ReloCore

@Suite("Complete inbox cache contract")
struct InboxCacheContractTests {
    @Test(arguments: ["memory", "file", "account"])
    func roundTripEveryFieldAndFractionalDeadline(kind: String) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache: any InboxCache
        switch kind {
        case "memory": cache = InMemoryInboxCache()
        case "file": cache = FileInboxCache(fileURL: directory.appendingPathComponent("inbox.json"))
        default:
            let scoped = AccountScopedInboxCache(baseDirectory: directory)
            try await scoped.select(accountId: "account"); cache = scoped
        }
        let snapshot = fullSnapshot()
        try await cache.save(snapshot)
        let loaded = try await cache.load()
        #expect(loaded == InboxHistoryRetention.retainingNewest(in: snapshot))
        #expect(loaded.items.first?.content == nil)
        #expect(loaded.items.first?.detail == "Private notification")
    }

    @Test(arguments: ["file", "account", "bound"])
    func accessAndWriteFailuresPreserveBytes(kind: String) async throws {
        let io = FaultingInboxIO(data: try InboxCacheStorage.encode(fullSnapshot()))
        let scoped = AccountScopedInboxCache(baseDirectory: URL(fileURLWithPath: "/unused"), io: io)
        try await scoped.select(accountId: "account")
        let cache: any InboxCache = kind == "file" ? FileInboxCache(fileURL: URL(fileURLWithPath: "/unused/inbox"), io: io)
            : kind == "bound" ? try await scoped.boundCache(for: "account") : scoped
        let original = io.contents
        io.setFault(.read)
        await #expect(throws: InboxStorageError.unavailable) { try await cache.load() }
        #expect(io.contents == original)
        #expect(io.removes == 0)
        io.setFault(.write)
        await #expect(throws: InboxStorageError.unavailable) { try await cache.save(InboxSnapshot()) }
        #expect(io.contents == original)
        io.setFault(nil)
        #expect(try await cache.load() == InboxHistoryRetention.retainingNewest(in: fullSnapshot()))
    }

    @Test(arguments: ["{", "{}", "{\"schemaVersion\":0,\"payload\":{}}"])
    func onlyCorruptOrRetiredDisposableDataResets(value: String) async throws {
        let io = FaultingInboxIO(data: Data(value.utf8))
        let cache = FileInboxCache(fileURL: URL(fileURLWithPath: "/unused/inbox"), io: io)
        #expect(try await cache.load() == InboxSnapshot())
        #expect(io.removes == 1)
        #expect(await cache.lastRecovery != nil)
        #expect(try await cache.load() == InboxSnapshot())
        #expect(io.removes == 1)
    }

    @Test func futureSchemaIsPreservedForACompatibleApp() async throws {
        let original = Data("{\"schemaVersion\":99,\"payload\":{}}".utf8)
        let io = FaultingInboxIO(data: original)
        let cache = FileInboxCache(fileURL: URL(fileURLWithPath: "/unused/inbox"), io: io)
        await #expect(throws: InboxStorageError.unsupportedSchema(99)) { try await cache.load() }
        #expect(io.contents == original)
        #expect(io.removes == 0)
    }

    @Test func migrationFailurePreservesOldBytesAndThenRecovers() async throws {
        let original = try VersionedStorageCodec.encode(fullSnapshot(), schemaVersion: 1)
        let io = FaultingInboxIO(data: original)
        let cache = FileInboxCache(fileURL: URL(fileURLWithPath: "/unused/inbox"), io: io)
        io.setFault(.write)
        await #expect(throws: InboxStorageError.unavailable) { try await cache.load() }
        #expect(io.contents == original)
        #expect(io.removes == 0)
        io.setFault(nil)
        let migrated = try await cache.load()
        #expect(migrated.readWatermark == fullSnapshot().readWatermark)
        #expect(migrated.items.first?.resources == fullSnapshot().items.first?.resources)
        #expect(io.contents != original)
        #expect(try await cache.load() == migrated)
    }

    @Test func actualReadDenialPreservesTheExistingFile() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let file = directory.appendingPathComponent("inbox.json")
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
            try? FileManager.default.removeItem(at: directory)
        }
        let cache = FileInboxCache(fileURL: file)
        try await cache.save(fullSnapshot())
        let original = try Data(contentsOf: file)
        try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: file.path)
        try #require(!FileManager.default.isReadableFile(atPath: file.path))
        await #expect(throws: (any Error).self) { try await cache.load() }
        #expect(FileManager.default.fileExists(atPath: file.path))
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        #expect(try Data(contentsOf: file) == original)
    }
}

private func fullSnapshot() -> InboxSnapshot {
    let time = Date(timeIntervalSince1970: 1_800_000_000.123456)
    let resources = InboxResourceLinks(source: .init(id: "src_exact", kind: "cli", name: "Source"),
        project: .init(id: "prj_exact", name: "Project", isDirect: false, palette: .init(slot: 7, generation: 3), icon: "build", revision: 4),
        conversationId: "cnv_exact", workItemId: "wrk_exact")
    let item = InboxItem(id: "ntf_exact", kind: .notification, sourceName: "Source",
        sourceImageUrl: URL(string: "https://example.test/icon.png"), title: "Exact title", detail: "Full detail",
        content: .init(summary: "Preview", body: "Body", format: .markdown, byteLength: 4),
        readAt: time, withdrawnAt: time, result: "Result", deliveryState: .acceptedByAPNs,
        apnsAcceptedAt: time, receivedAt: time, openedAt: time, createdAt: time,
        destinationUrl: URL(string: "https://example.test/detail"), privacy: .private,
        interaction: .init(id: "int_exact", kind: .yesNo, prompt: "Continue?", state: .pending, expiresAt: time.addingTimeInterval(900)),
        context: .init(providerName: "Agent", project: "Project", threadName: "Thread", taskTitle: "Task"), resources: resources)
    return .init(items: [item], cursor: "opaque", lastSuccessfulSyncAt: time, readWatermark: "read-watermark",
                 unread: .init(account: 99, projects: ["prj_exact": 7]))
}

// Lock-protected fault injection models atomic replacement without touching shared files.
final class FaultingInboxIO: InboxStorageIO, @unchecked Sendable {
    enum Fault { case read, write }
    private let lock = NSLock()
    private var data: Data?
    private var fault: Fault?
    private var removeCount = 0
    init(data: Data?) { self.data = data }
    var contents: Data? { lock.withLock { data } }
    var removes: Int { lock.withLock { removeCount } }
    func setFault(_ value: Fault?) { lock.withLock { fault = value } }
    func read(url: URL) throws -> Data {
        try lock.withLock {
            if fault == .read { throw CocoaError(.fileReadNoPermission) }
            guard let data else { throw CocoaError(.fileReadNoSuchFile) }
            return data
        }
    }
    func replace(data: Data, at url: URL) throws {
        try lock.withLock {
            if fault == .write { throw CocoaError(.fileWriteOutOfSpace) }
            self.data = data
        }
    }
    func remove(url: URL) throws { lock.withLock { data = nil; removeCount += 1 } }
}
