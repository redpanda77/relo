@testable import ReloPersistence
import Foundation
import Testing
@testable import ReloCore

@Suite("Persistent current relevance")
struct CurrentStateCacheTests {
    @Test func completeSnapshotRoundTripPreservesRetirementAndMetadata() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = FileCurrentStateCache(baseDirectory: directory, scope: try scope())
        var snapshot = CurrentCacheSnapshot()
        let current = subject()
        try snapshot.apply(response([current], total: 401, hasMore: true))
        let retiredID = "sub_22222222-2222-2222-2222-222222222222"
        try snapshot.apply(response([], retired: [.init(subjectId: retiredID, reason: .superseded, version: .init(generation: 2, revision: 9))], total: 401), requestedIDs: [retiredID])
        snapshot.prepareForSave(wallTime: time)
        try await cache.save(snapshot)
        let relaunched = FileCurrentStateCache(baseDirectory: directory, scope: try scope())
        #expect(try await relaunched.load() == snapshot)
        #expect(snapshot.subjects[current.id]?.projection.resources == current.resources)
        #expect(snapshot.metadata?.counts.actionable == 401)
        #expect(snapshot.metadata?.cursor == "next-page")
    }

    @Test func cacheOpenPersistsExpiryAcrossClockRollbackAndWriteFailure() async throws {
        let io = FaultingInboxIO(data: nil)
        let originalTime = time
        let cache = FileCurrentStateCache(baseDirectory: URL(fileURLWithPath: "/unused"), scope: try scope(), io: io, wallTime: { originalTime })
        var snapshot = CurrentCacheSnapshot(); try snapshot.apply(response([subject()]))
        snapshot.prepareForSave(wallTime: originalTime)
        try await cache.save(snapshot)
        let original = io.contents
        let later = FileCurrentStateCache(baseDirectory: URL(fileURLWithPath: "/unused"), scope: try scope(), io: io, wallTime: { originalTime.addingTimeInterval(61) })
        io.setFault(.write)
        await #expect(throws: InboxStorageError.unavailable) { try await later.load() }
        #expect(io.contents == original)
        #expect(io.removes == 0)
        io.setFault(nil)
        let expired = try await later.load()
        #expect(expired.subjects.isEmpty)
        #expect(expired.retired.values.first?.reason == .expired)
        // Relaunch with the original (earlier) wall time must retain the tombstone.
        #expect(try await cache.load() == expired)
    }

    @Test func delayedDiskKnowledgeRetainsHigherRetiredVersionDespiteNewerClockSample() throws {
        var disk = CurrentCacheSnapshot(), network = CurrentCacheSnapshot()
        let terminal = subject(revision: 3)
        try disk.apply(response([], retired: [.init(subjectId: terminal.id, reason: .settled, version: terminal.version)]), requestedIDs: [terminal.id])
        try network.apply(response([subject(revision: 1)], at: time.addingTimeInterval(10)))
        network.mergeKnowledge(from: disk)
        #expect(network.subjects.isEmpty)
        #expect(network.retired[terminal.id]?.version == terminal.version)
        #expect(network.metadata?.serverTime == time.addingTimeInterval(10))
    }

    @Test func cancelledWriterCannotReplacePersistedCurrentKnowledge() async throws {
        let io = FaultingInboxIO(data: nil)
        let cache = FileCurrentStateCache(baseDirectory: URL(fileURLWithPath: "/unused"), scope: try scope(), io: io)
        var snapshot = CurrentCacheSnapshot(); try snapshot.apply(response([subject(revision: 3)]))
        try await cache.save(snapshot)
        let original = io.contents
        let cancelled = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            try await cache.save(CurrentCacheSnapshot())
        }
        await #expect(throws: CancellationError.self) { try await cancelled.value }
        #expect(io.contents == original)
    }

    @Test func reorderedVersionsCannotReplaceNewerState() throws {
        var snapshot = CurrentCacheSnapshot()
        try snapshot.apply(response([subject(revision: 1)]))
        try snapshot.apply(response([subject(revision: 3)], at: time.addingTimeInterval(3)))
        try snapshot.apply(response([subject(revision: 2)], at: time.addingTimeInterval(4)))
        #expect(snapshot.subjects.values.first?.projection.version.revision == 3)
        try snapshot.apply(response([subject(generation: 2, revision: 1)], at: time.addingTimeInterval(5)))
        try snapshot.apply(response([subject(generation: 1, revision: 999)], at: time.addingTimeInterval(6)))
        #expect(snapshot.subjects.values.first?.projection.version.generation == 2)
    }

    @Test func offlineExpiryAndRestartCannotResurrectAnAction() async throws {
        let io = FaultingInboxIO(data: nil)
        let cache = FileCurrentStateCache(baseDirectory: URL(fileURLWithPath: "/unused"), scope: try scope(), io: io)
        let item = subject()
        var snapshot = CurrentCacheSnapshot()
        try snapshot.apply(response([item]))
        snapshot.expire(at: time.addingTimeInterval(60))
        snapshot.prepareForSave(wallTime: time.addingTimeInterval(60))
        try await cache.save(snapshot)
        var reloaded = try await cache.load()
        #expect(reloaded.subjects.isEmpty)
        #expect(reloaded.retired[item.id]?.reason == .expired)
        // A delayed response, then a fresh response replaying the same obsolete version.
        try reloaded.apply(response([item], at: time.addingTimeInterval(1)))
        try reloaded.apply(response([item], at: time.addingTimeInterval(90)))
        #expect(reloaded.subjects.isEmpty)
        #expect(reloaded.conservativeTimeAfterRestart(wallTime: time) == time.addingTimeInterval(90))
        let clock = CurrentDeadlineClock(lastEvaluatedAt: reloaded.evaluatedAt)
        #expect(!clock.isVerified)
    }

    @Test func targetedRetirementFencesLateCompletionButAllowsExplicitNewGeneration() throws {
        var snapshot = CurrentCacheSnapshot()
        let item = subject(revision: 3)
        try snapshot.apply(response([item]))
        try snapshot.apply(response([], retired: [.init(subjectId: item.id, reason: .settled, version: item.version)], at: time.addingTimeInterval(2)), requestedIDs: [item.id])
        try snapshot.apply(response([subject(revision: 2)], at: time.addingTimeInterval(3)))
        #expect(snapshot.subjects.isEmpty)
        try snapshot.apply(response([], retired: [.init(subjectId: item.id, reason: .notFound, version: nil)], at: time.addingTimeInterval(4)), requestedIDs: [item.id])
        try snapshot.apply(response([item], at: time.addingTimeInterval(5)))
        #expect(snapshot.subjects.isEmpty)
        #expect(snapshot.retired[item.id]?.reason == .settled)
        try snapshot.apply(response([subject(generation: 2)], at: time.addingTimeInterval(6)))
        #expect(snapshot.subjects[item.id]?.projection.version.generation == 2)
        #expect(snapshot.retired.isEmpty)
    }

    @Test func truncatedPagesNeverRetireAnUnlistedIndependentApproval() throws {
        var snapshot = CurrentCacheSnapshot()
        let oldApproval = subject(id: "sub_22222222-2222-2222-2222-222222222222")
        try snapshot.apply(response([oldApproval]))
        try snapshot.apply(response([subject()], total: 600, hasMore: true, at: time.addingTimeInterval(1)))
        #expect(snapshot.subjects.count == 2)
        #expect(snapshot.subjects[oldApproval.id] != nil)
        #expect(snapshot.metadata?.counts.actionable == 600)
        #expect(snapshot.metadata?.hasMore == true)
    }

    @Test func missingVisibilityDoesNotLeakOrAcceptAnOldResponse() throws {
        var snapshot = CurrentCacheSnapshot()
        let item = subject()
        try snapshot.apply(response([item]))
        try snapshot.apply(response([], retired: [.init(subjectId: item.id, reason: .notFound, version: nil)], at: time.addingTimeInterval(3)), requestedIDs: [item.id])
        try snapshot.apply(response([item], at: time.addingTimeInterval(2)))
        #expect(snapshot.subjects.isEmpty)
        // A later authoritative read can restore visibility of the same still-valid version.
        try snapshot.apply(response([item], at: time.addingTimeInterval(4)))
        #expect(snapshot.subjects[item.id]?.projection == item)
    }

    @Test func clockDoesNotGainTimeOnRollbackAndAccountsForResponseTransit() throws {
        let instant = ContinuousClock.now
        var clock = CurrentDeadlineClock()
        clock.synchronize(serverTime: time, requestStarted: instant, receivedAt: instant.advanced(by: .seconds(2)))
        #expect(clock.isVerified)
        #expect(clock.now(at: instant.advanced(by: .seconds(12))) == time.addingTimeInterval(12))
        clock.synchronize(serverTime: time.addingTimeInterval(-1_000), requestStarted: instant.advanced(by: .seconds(13)), receivedAt: instant.advanced(by: .seconds(14)))
        #expect(clock.now(at: instant.advanced(by: .seconds(15))) == time.addingTimeInterval(15))
        var snapshot = CurrentCacheSnapshot()
        try snapshot.apply(response([subject()]))
        snapshot.expire(at: time.addingTimeInterval(20)); snapshot.prepareForSave(wallTime: time)
        #expect(snapshot.conservativeTimeAfterRestart(wallTime: time.addingTimeInterval(-3_600)) == time.addingTimeInterval(20))
        #expect(snapshot.conservativeTimeAfterRestart(wallTime: time.addingTimeInterval(100)) == time.addingTimeInterval(120))
    }

    @Test func staleProgressStaysVisibleAndDeliveryTTLDoesNotExpireAction() throws {
        var snapshot = CurrentCacheSnapshot()
        let item = subject()
        try snapshot.apply(response([item]))
        snapshot.expire(at: time.addingTimeInterval(2)) // deliverUntil was +1, action expiry remains +60.
        #expect(snapshot.subjects[item.id] != nil)
    }

    @Test func originAccountAndDeviceAreIndependentAndCanonical() async throws {
        let a = try scope()
        let canonical = try StorageScope(serverOrigin: URL(string: "https://EXAMPLE.test:443/")!, accountID: "account", deviceID: "device")
        #expect(a == canonical)
        #expect(a.fileKey == canonical.fileKey)
        let other = try StorageScope(serverOrigin: URL(string: "https://other.test")!, accountID: "account", deviceID: "device")
        let otherDevice = try StorageScope(serverOrigin: a.serverOrigin, accountID: "account", deviceID: "other")
        let otherAccount = try StorageScope(serverOrigin: a.serverOrigin, accountID: "other", deviceID: "device")
        #expect(Set([a.fileKey, other.fileKey, otherDevice.fileKey, otherAccount.fileKey]).count == 4)
        #expect(a.fileKey.count == 64)
        #expect(throws: StorageScopeError.self) { try StorageScope(serverOrigin: URL(string: "https://example.test/?token=secret")!, accountID: "account", deviceID: "device") }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var snapshot = CurrentCacheSnapshot(); try snapshot.apply(response([subject()]))
        try await FileCurrentStateCache(baseDirectory: directory, scope: a).save(snapshot)
        for different in [other, otherDevice, otherAccount] {
            #expect(try await FileCurrentStateCache(baseDirectory: directory, scope: different).load() == CurrentCacheSnapshot())
        }
    }

    @Test func currentCacheFaultsPreserveRetirementBytes() async throws {
        let io = FaultingInboxIO(data: nil)
        let cache = FileCurrentStateCache(baseDirectory: URL(fileURLWithPath: "/unused"), scope: try scope(), io: io)
        var snapshot = CurrentCacheSnapshot(); try snapshot.apply(response([subject()]))
        snapshot.expire(at: time.addingTimeInterval(60))
        try await cache.save(snapshot)
        let original = io.contents
        io.setFault(.read)
        await #expect(throws: InboxStorageError.unavailable) { try await cache.load() }
        #expect(io.contents == original)
        io.setFault(.write)
        await #expect(throws: InboxStorageError.unavailable) { try await cache.save(CurrentCacheSnapshot()) }
        #expect(io.contents == original)
        io.setFault(nil)
        #expect(try await cache.load() == snapshot)
        #expect(io.removes == 0)
    }

    private var time: Date { Date(timeIntervalSince1970: 1_800_000_000.123456) }
    private func scope() throws -> StorageScope {
        try StorageScope(serverOrigin: URL(string: "https://example.test")!, accountID: "account", deviceID: "device")
    }
    private func subject(id: String = "sub_11111111-1111-1111-1111-111111111111", generation: Int = 1, revision: Int = 1) -> CurrentSubjectProjection {
        .init(subjectId: id, notificationId: "ntf_11111111-1111-1111-1111-111111111111", kind: .decision,
              version: .init(generation: generation, revision: revision), title: "Proceed?", summary: "Original request", source: "Source",
              createdAt: time, updatedAt: time, occurredAt: time, acceptedAt: time, readAt: time,
              currentUntil: time.addingTimeInterval(60), freshUntil: time.addingTimeInterval(30), deliverUntil: time.addingTimeInterval(1), freshness: .fresh,
              interaction: .init(id: "int_11111111-1111-1111-1111-111111111111", type: .approval, state: .pending, expiresAt: time.addingTimeInterval(60)), activity: nil,
              resources: .init(source: .init(id: "src_11111111-1111-1111-1111-111111111111", kind: "cli", name: "Source"), project: .init(id: "prj_11111111-1111-1111-1111-111111111111", name: "Project", isDirect: false, palette: .init(slot: 2, generation: 4), icon: "build", revision: 9), conversationId: "cnv_11111111-1111-1111-1111-111111111111", workItemId: nil))
    }
    private func response(_ items: [CurrentSubjectProjection], retired: [RetiredCurrentSubject] = [], total: Int? = nil, hasMore: Bool = false, at: Date? = nil) -> CurrentInboxResponse {
        .init(items: items, retired: retired, total: total ?? items.count, cursor: hasMore ? "next-page" : nil, hasMore: hasMore,
              counts: .init(actionable: total ?? items.count, currentUnread: 0), nextExpiryAt: time.addingTimeInterval(60), serverTime: at ?? time)
    }
}
