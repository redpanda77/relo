@testable import ReloRuntime
@testable import ReloPersistence
import Foundation
import Testing
@testable import ReloCore
import ReloNotificationSupport

@Suite @MainActor struct ReceiptCoordinatorTests {
    private func session(origin: String = "https://relo.example", device: String = "dev_11111111") throws -> SessionScope {
        .init(storage: try StorageScope(serverOrigin: #require(URL(string: origin)), accountID: "acc_11111111", deviceID: device), credentialVersion: 1)
    }
    private func record(_ index: Int, in session: SessionScope) throws -> NotificationReceiptRecord {
        try .init(scope: ReceiptScope(serverOrigin: session.storage.serverOrigin, accountId: session.storage.accountID,
                                     deviceId: session.storage.deviceID), notificationID: String(format: "ntf_%012d", index),
                  capturedAt: Date(timeIntervalSince1970: 1_700_000_000 + Double(index)))
    }

    @Test func sharedServerOriginHashFixturesMatch() throws {
        struct Fixture: Decodable { let origin: URL; let sha256: String }
        let path = try #require(Bundle.module.url(forResource: "receipt-scope-v1", withExtension: "json"))
        let fixtures = try JSONDecoder().decode([Fixture].self, from: Data(contentsOf: path))
        for fixture in fixtures { #expect(try ReceiptScope.originHash(fixture.origin) == fixture.sha256) }
    }

    @Test func fileCutoverRetiresUnscopedEvidenceWithoutReassigningIt() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = NotificationReceiptFile(baseDirectory: directory)
        try file.append(id: "ntf_predecessor")
        let a = try session(), b = try session(origin: "https://another.example")
        let first = try record(1, in: a), other = try record(2, in: b)
        try file.append(record: first); try file.append(record: other)
        #expect(try file.append(record: record(1, in: a)) == .duplicate)
        let store = FileScopedNotificationReceiptStore(baseDirectory: directory)
        let aBatch = try await store.pending(scope: first.scope, limit: 200)
        #expect(aBatch.records == [first]); #expect(aBatch.retiredUnscopedCount == 1)
        try await store.retire(scope: first.scope)
        let restarted = FileScopedNotificationReceiptStore(baseDirectory: directory)
        #expect(try await restarted.pending(scope: other.scope, limit: 200).records == [other])
        #expect(try await restarted.pending(scope: first.scope, limit: 200).records.isEmpty)
    }

    @Test func oldReceiptsUploadInBatchesOf25WithoutAnyHistoryInput() async throws {
        let a = try session(), otherOrigin = try session(origin: "https://elsewhere.example"), otherDevice = try session(device: "dev_22222222")
        let records = try (0..<30).map { try record($0, in: a) }
        let foreign = [try record(99, in: otherOrigin), try record(99, in: otherDevice)]
        let store = ReceiptMemoryStore(records + foreign), remote = ReceiptRemote()
        let owner = ReceiptCoordinator()
        try owner.activate(scope: a, store: store, remote: remote)
        await owner.flush()
        #expect(await remote.calls.count == 25)
        #expect(owner.state.acknowledged == 25)
        #expect(await store.all.count == 7)
        await owner.flush()
        #expect(await remote.calls == records)
        #expect(await store.all == foreign)
    }

    @Test(arguments: [NotificationReceiptRemoteError.offline, .unauthorized, .conflict])
    func failureRetainsReceiptsForExactRetry(error: NotificationReceiptRemoteError) async throws {
        let a = try session(), receipt = try record(1, in: a)
        let store = ReceiptMemoryStore([receipt]), remote = ReceiptRemote(error: error), owner = ReceiptCoordinator()
        try owner.activate(scope: a, store: store, remote: remote)
        await owner.flush()
        #expect(await store.all == [receipt]); #expect(owner.state.issue != nil)
        await remote.setError(nil)
        await owner.flush()
        #expect(await store.all.isEmpty)
        #expect(await remote.calls == [receipt, receipt])
    }

    @Test func lateOldScopeAcknowledgementCannotRemoveOrPublishIntoReplacement() async throws {
        let a = try session(), b = try session(device: "dev_22222222")
        let first = try record(1, in: a), second = try record(2, in: b)
        let store = ReceiptMemoryStore([first, second]), oldRemote = ReceiptRemote(held: true)
        let currentRemote = ReceiptRemote(), owner = ReceiptCoordinator()
        try owner.activate(scope: a, store: store, remote: oldRemote)
        let old = Task { await owner.flush() }
        await oldRemote.waitForCall()
        try owner.activate(scope: b, store: store, remote: currentRemote)
        await owner.flush()
        await oldRemote.release()
        await old.value
        #expect(await store.all == [first])
        #expect(owner.state.scope == b && owner.state.acknowledged == 1)
    }

    @Test func removalFailureRetainsAcknowledgedRecordAndNotFoundRetiresOnlyExactScope() async throws {
        let a = try session(), b = try session(device: "dev_22222222")
        let first = try record(1, in: a), foreign = try record(1, in: b)
        let store = ReceiptMemoryStore([first, foreign]), remote = ReceiptRemote(), owner = ReceiptCoordinator()
        await store.failRemoval(true)
        try owner.activate(scope: a, store: store, remote: remote)
        await owner.flush()
        #expect(owner.state.issue == .storage && owner.state.acknowledged == 0)
        #expect(await store.all == [first, foreign])
        await store.failRemoval(false); await remote.setNotFound()
        await owner.flush()
        #expect(owner.state.retiredNotFound == 1)
        #expect(await store.all == [foreign])
    }
}

private actor ReceiptMemoryStore: ScopedNotificationReceiptStoring {
    private(set) var all: [NotificationReceiptRecord]
    private var removalFails = false
    init(_ records: [NotificationReceiptRecord]) { all = records }
    func failRemoval(_ value: Bool) { removalFails = value }
    func pending(scope: ReceiptScope, limit: Int) -> NotificationReceiptBatch { .init(records: Array(all.filter { $0.scope == scope }.prefix(limit))) }
    func remove(records: Set<NotificationReceiptRecord>) throws {
        if removalFails { throw CocoaError(.fileWriteNoPermission) }
        all.removeAll { records.contains($0) }
    }
    func retire(scope: ReceiptScope) { all.removeAll { $0.scope == scope } }
}

private actor ReceiptRemote: NotificationReceiptRemoteSource {
    private(set) var calls: [NotificationReceiptRecord] = []
    private var error: NotificationReceiptRemoteError?
    private var outcome: NotificationReceiptOutcome = .acknowledged
    private let held: Bool
    private var gate: CheckedContinuation<Void, Never>?
    private var started: [CheckedContinuation<Void, Never>] = []
    init(error: NotificationReceiptRemoteError? = nil, held: Bool = false) { self.error = error; self.held = held }
    func setError(_ error: NotificationReceiptRemoteError?) { self.error = error }
    func setNotFound() { outcome = .notFound }
    func waitForCall() async { if !calls.isEmpty { return }; await withCheckedContinuation { started.append($0) } }
    func release() { gate?.resume(); gate = nil }
    func submit(_ record: NotificationReceiptRecord) async throws -> NotificationReceiptOutcome {
        calls.append(record)
        if held {
            await withCheckedContinuation { continuation in
                gate = continuation; let waiters = started; started = []; waiters.forEach { $0.resume() }
            }
        }
        if let error { throw error }
        return outcome
    }
}
