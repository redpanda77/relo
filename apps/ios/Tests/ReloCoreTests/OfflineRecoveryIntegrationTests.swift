import Foundation
import Testing
@testable import ReloCore
@testable import ReloPersistence

@Suite("Ten-minute protected current recovery")
struct OfflineRecoveryIntegrationTests {
    @Test func expiryAndReplacementSurviveRestartLateCacheAndClockRollback() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let time = Date(timeIntervalSince1970: 1_800_000_000), reconnected = time.addingTimeInterval(600)
        let scope = try StorageScope(serverOrigin: URL(string: "https://example.test")!, accountID: "account", deviceID: "device")
        let expired = subject(1, time: time, deadline: time.addingTimeInterval(300))
        let independent = subject(2, time: time, deadline: time.addingTimeInterval(1800))
        let progress = subject(3, time: time, revision: 1)
        let expiredIdentity = try #require(CurrentDecisionIdentity(subject: expired, scope: scope))
        let validIdentity = try #require(CurrentDecisionIdentity(subject: independent, scope: scope))
        var initial = CurrentCacheSnapshot()
        try initial.apply(page([expired, independent, progress], at: time, actionable: 2))
        initial.prepareForSave(wallTime: time)
        let original = FileCurrentStateCache(baseDirectory: directory, scope: scope, wallTime: { time })
        try await original.save(initial)
        let relaunched = FileCurrentStateCache(baseDirectory: directory, scope: scope, wallTime: { reconnected })
        var recovered = try await relaunched.load()
        var state = CurrentRuntimeState(scope: SessionScope(storage: scope, credentialVersion: 1))
        state.snapshot = recovered; state.connection = .offline
        let offline = CurrentInboxPresentation(state: state, now: reconnected)
        #expect(offline.needsMe.map(\.interaction.id) == [validIdentity.interactionID])
        #expect(offline.actionableCount == nil)
        #expect(CurrentInboxPresentation.availability(for: expiredIdentity, state: state, now: reconnected) == .expired)
        #expect(CurrentInboxPresentation.availability(for: validIdentity, state: state, now: reconnected) == .unverified)
        #expect(CurrentInboxPresentation.freshnessLabel(for: progress, now: reconnected) == "Out of date")

        let latest = subject(3, time: reconnected, revision: 31)
        try recovered.apply(page([independent, latest], at: reconnected, actionable: 1))
        recovered.mergeKnowledge(from: initial) // Delayed disk/history result from before disconnection.
        recovered.prepareForSave(wallTime: reconnected)
        try await relaunched.save(recovered)
        let rollback = FileCurrentStateCache(baseDirectory: directory, scope: scope, wallTime: { time })
        state.snapshot = try await rollback.load()
        state.connection = .current; state.timeVerified = true; state.countsAreCurrent = true
        state.verifiedVersions = [independent.id: independent.version, latest.id: latest.version]
        let current = CurrentInboxPresentation(state: state, now: reconnected)
        #expect(current.needsMe.map(\.interaction.id) == [validIdentity.interactionID])
        #expect(current.running.map(\.version.revision) == [31])
        #expect(current.actionableCount == 1)
        #expect(CurrentInboxPresentation.availability(for: expiredIdentity, state: state, now: time) == .expired)
        #expect(CurrentInboxPresentation.availability(for: validIdentity, state: state, now: reconnected) == .available)
        #expect(state.snapshot.subjects[expired.id] == nil)
    }

    private func page(_ items: [CurrentSubjectProjection], at time: Date, actionable: Int) -> CurrentInboxResponse {
        .init(items: items, retired: [], total: items.count, cursor: nil, hasMore: false,
              counts: .init(actionable: actionable, currentUnread: items.count),
              nextExpiryAt: items.compactMap(\.currentUntil).min(), serverTime: time)
    }
    private func subject(_ index: Int, time: Date, deadline: Date? = nil, revision: Int = 1) -> CurrentSubjectProjection {
        let suffix = "11111111-1111-1111-1111-" + String(format: "%012d", index)
        return .init(subjectId: "sub_" + suffix, notificationId: "ntf_" + suffix,
            kind: deadline == nil ? .progress : .decision, version: .init(generation: 1, revision: revision),
            title: "Fixture", summary: "Fixture", source: "Fixture", createdAt: time, updatedAt: time, occurredAt: time,
            acceptedAt: time, readAt: nil, currentUntil: deadline, freshUntil: deadline == nil ? time.addingTimeInterval(30) : nil,
            deliverUntil: time.addingTimeInterval(15), freshness: .unknown,
            interaction: deadline.map { .init(id: "int_" + suffix, type: .approval, state: .pending, expiresAt: $0) }, activity: nil, resources: nil)
    }
}
