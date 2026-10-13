import Foundation
import Testing
@testable import ReloCore
import ReloPersistence

@Suite("Bounded private diagnostics")
struct DiagnosticStoreTests {
    @Test func hardLimitEvictsOldestAndSurvivesRelaunch() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("diagnostics.json")
        let store = BoundedDiagnosticStore(fileURL: file, capacity: 9_999)
        let events = (0..<2_001).map { event(attempt: $0) }
        for event in events { await store.record(event) }
        await store.flush()
        let snapshot = await store.snapshot()
        #expect(snapshot.capacity == 2_000)
        #expect(snapshot.events == Array(events.dropFirst()))
        #expect(!snapshot.persistenceUnavailable)
        let restored = await BoundedDiagnosticStore(fileURL: file).snapshot()
        #expect(restored.capacity == 500)
        #expect(restored.events == Array(events.suffix(500)))
    }

    @Test func suspendedStorageCannotHoldRecordingAndPendingMemoryStaysBounded() async {
        let archive = ControlledDiagnosticArchive(blockWrites: true)
        let store = BoundedDiagnosticStore(archive: archive, capacity: 3)
        await store.record(event(attempt: 0))
        await archive.waitForWrite()
        for value in 1...20 { await store.record(event(attempt: value)) }
        let snapshot = await store.snapshot()
        #expect(snapshot.events.map(\.attempt) == [18, 19, 20])
        await archive.release()
        await store.flush()
        #expect(await archive.saved.map(\.attempt) == [18, 19, 20])
        #expect(await archive.writes == 2)
    }

    @Test func storageFailureDoesNotRecurseAndUnreadableArchiveIsNeverOverwritten() async {
        let archive = ControlledDiagnosticArchive(failLoad: true)
        let store = BoundedDiagnosticStore(archive: archive)
        await store.record(event())
        await store.flush()
        let snapshot = await store.snapshot()
        #expect(snapshot.events.count == 1)
        #expect(snapshot.persistenceUnavailable)
        #expect(await archive.writes == 0)
        let writeFailure = ControlledDiagnosticArchive(failSave: true)
        let other = BoundedDiagnosticStore(archive: writeFailure)
        await other.record(event())
        await other.flush()
        #expect(await other.snapshot().persistenceUnavailable)
        #expect(await writeFailure.writes == 1)
    }

    @Test func unknownErrorsAndExtraArchiveFieldsCannotLeakSentinelContent() async throws {
        let sentinels = ["Bearer secret-token", "https://private.example/secret", "private notification body",
                         "private reply text", "Private User"]
        let error = NSError(domain: sentinels[1], code: 1, userInfo: [NSLocalizedDescriptionKey: sentinels.joined(separator: " ")])
        let event = OperationDiagnostic(operation: .responseSubmission, phase: .completed,
            outcome: OperationDiagnostic.outcome(for: error), priority: .immediate)
        var object = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(event)) as? [String: Any])
        object["errorText"] = sentinels.joined(separator: " ")
        let restored = try JSONDecoder().decode(OperationDiagnostic.self, from: JSONSerialization.data(withJSONObject: object))
        let archive = ControlledDiagnosticArchive()
        let store = BoundedDiagnosticStore(archive: archive)
        await store.record(restored)
        await store.flush()
        let exported = String(decoding: try JSONEncoder().encode(await store.snapshot()), as: UTF8.self)
        for sentinel in sentinels {
            #expect(!exported.contains(sentinel))
            #expect(!restored.redactedDescription.contains(sentinel))
            #expect(!String(decoding: try JSONEncoder().encode(await archive.saved), as: UTF8.self).contains(sentinel))
        }
        #expect(restored.outcome == .failed)
    }

    @Test(arguments: [
        (OperationDiagnostic.Outcome.pending, RecoveryStatus.pending),
        (.offline, .retrying), (.unauthorized, .pausedForAuth), (.storageUnavailable, .pausedForStorage),
        (.expired, .notSentExpired), (.superseded, .notSentReplaced), (.confirmed, .confirmed)
    ])
    func recoveryDescribesTheActualBoundary(_ example: (OperationDiagnostic.Outcome, RecoveryStatus)) {
        #expect(RecoveryStatus(outcome: example.0) == example.1)
    }

    @Test func failuresNameTheirBoundaryWithoutDiscardingLastConfirmedState() throws {
        let scope = try StorageScope(serverOrigin: #require(URL(string: "https://fixture.example")),
                                     accountID: "account", deviceID: "device")
        var state = CurrentRuntimeState(scope: SessionScope(storage: scope, credentialVersion: 1))
        let confirmed = Date(timeIntervalSince1970: 1_800_000_000)
        try state.snapshot.apply(.init(items: [], retired: [], total: 0, cursor: nil, hasMore: false,
            counts: .init(actionable: 0, currentUnread: 0), nextExpiryAt: nil, serverTime: confirmed))
        state.persistence = .available
        state.connection = .unauthorized
        #expect(RecoveryStatus(outcome: RecoveryStatusPolicy.current(state)) == .pausedForAuth)
        state.connection = .offline
        #expect(RecoveryStatus(outcome: RecoveryStatusPolicy.current(state)) == .retrying)
        state.persistence = .unavailable
        #expect(RecoveryStatus(outcome: RecoveryStatusPolicy.current(state)) == .pausedForStorage)
        #expect(state.snapshot.metadata?.serverTime == confirmed)
        var reads = PendingReadState()
        #expect(RecoveryStatusPolicy.reads(reads) == .pending)
        reads.pendingIDs = ["saved-read"]; reads.issue = .storage
        #expect(RecoveryStatusPolicy.reads(reads) == .storageUnavailable)
        #expect(reads.pendingIDs == ["saved-read"])
        #expect(RecoveryStatusPolicy.receipts(ReceiptRecoveryState()) == .pending)
    }

    private func event(attempt: Int = 1) -> OperationDiagnostic {
        .init(operation: .readReplay, phase: .completed, attempt: attempt, outcome: .confirmed, priority: .maintenance)
    }
}

private actor ControlledDiagnosticArchive: DiagnosticArchiveIO {
    let failLoad: Bool
    let failSave: Bool
    var blockWrites: Bool
    var saved: [OperationDiagnostic] = []
    var writes = 0
    private var releaseWrite: CheckedContinuation<Void, Never>?
    private var writeStarted: CheckedContinuation<Void, Never>?
    init(blockWrites: Bool = false, failLoad: Bool = false, failSave: Bool = false) {
        self.blockWrites = blockWrites; self.failLoad = failLoad; self.failSave = failSave
    }
    func load() throws -> [OperationDiagnostic] {
        if failLoad { throw CocoaError(.fileReadNoPermission) }
        return saved
    }
    func save(_ events: [OperationDiagnostic]) async throws {
        writes += 1
        if blockWrites {
            await withCheckedContinuation {
                releaseWrite = $0
                writeStarted?.resume(); writeStarted = nil
            }
        }
        if failSave { throw CocoaError(.fileWriteNoPermission) }
        saved = events
    }
    func waitForWrite() async {
        if releaseWrite != nil { return }
        await withCheckedContinuation { writeStarted = $0 }
    }
    func release() {
        blockWrites = false
        releaseWrite?.resume(); releaseWrite = nil
    }
}
