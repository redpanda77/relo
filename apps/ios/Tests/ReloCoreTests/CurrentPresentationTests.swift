import Foundation
import Testing
@testable import ReloCore

@Suite("Current attention and immutable drafts")
struct CurrentPresentationTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func independentApprovalSurvives250NewerEventsAndUsesGlobalCount() throws {
        let decision = subject(1)
        var state = try state([decision], total: 500, actionable: 400)
        for page in 0..<5 {
            let notices = (0..<50).map { subject(100 + page * 50 + $0, kind: .notice) }
            try state.snapshot.apply(response(notices, total: 500, actionable: 400))
        }
        let screen = CurrentInboxPresentation(state: state, now: now)
        #expect(screen.needsMe.map(\.subjectId) == [decision.subjectId])
        #expect(screen.actionableCount == 400)
        let identity = try #require(CurrentDecisionIdentity(subject: decision, scope: state.scope.storage))
        #expect(CurrentInboxPresentation.availability(for: identity, state: state, now: now) == .available)
    }

    /// Past its deadline a question stays listed until the server retires it (missed questions
    /// take late answers); the phone only stops offering submission and drops the unprovable count.
    @Test func originalDeadlineKeepsQuestionButStopsSubmissionOffline() throws {
        let decision = subject(1)
        var state = try state([decision], total: 500, actionable: 400)
        state.connection = .offline
        let identity = try #require(CurrentDecisionIdentity(subject: decision, scope: state.scope.storage))
        let later = now.addingTimeInterval(301)
        let screen = CurrentInboxPresentation(state: state, now: later)
        #expect(screen.needsMe.count == 1)
        #expect(screen.actionableCount == nil)
        #expect(CurrentInboxPresentation.availability(for: identity, state: state, now: later) == .expired)
    }

    @Test func replacementDoesNotRebaseTypedRequestIdentity() throws {
        let original = subject(1), replacement = subject(1, version: .init(generation: 2, revision: 1), request: 2)
        var state = try state([original])
        let draftIdentity = try #require(CurrentDecisionIdentity(subject: original, scope: state.scope.storage))
        var draft = CurrentDecisionDraft(identity: draftIdentity, title: original.title, prompt: original.summary)
        draft.text = "Keep this original answer"
        try state.snapshot.apply(response([replacement]))
        state.verifiedVersions[replacement.id] = replacement.version
        #expect(draft.availability(in: state, now: now) == .replaced)
        #expect(draft.identity.interactionID == original.interaction?.id)
        #expect(draft.text == "Keep this original answer")
        #expect(draftIdentity != CurrentDecisionIdentity(subject: replacement, scope: state.scope.storage))
    }

    @Test func progressFreshnessDoesNotExpireAnIndependentDecision() throws {
        let decision = subject(1), progress = subject(2, kind: .progress, freshUntil: now.addingTimeInterval(-1))
        let state = try state([decision, progress])
        let screen = CurrentInboxPresentation(state: state, now: now)
        #expect(screen.needsMe.count == 1)
        let identity = try #require(CurrentDecisionIdentity(subject: decision, scope: state.scope.storage))
        #expect(CurrentInboxPresentation.availability(for: identity, state: state, now: now) == .available)
    }

    @Test func restoredOrWrongScopeDraftCannotSubmitAndNeverInventsGlobalTotals() throws {
        let decision = subject(1)
        var state = try state([decision], total: 500, actionable: 400)
        let identity = try #require(CurrentDecisionIdentity(subject: decision, scope: state.scope.storage))
        state.timeVerified = false
        #expect(CurrentInboxPresentation.availability(for: identity, state: state, now: now) == .unverified)
        #expect(CurrentInboxPresentation(state: state, now: now).actionableCount == nil)
        let other = try StorageScope(serverOrigin: URL(string: "https://other.test")!, accountID: "account", deviceID: "device")
        let foreignDraft = try #require(CurrentDecisionIdentity(subject: decision, scope: other))
        #expect(CurrentInboxPresentation.availability(for: foreignDraft, state: state, now: now) == .differentAccount)
    }

    private func state(_ subjects: [CurrentSubjectProjection], total: Int = 2, actionable: Int = 1) throws -> CurrentRuntimeState {
        let scope = SessionScope(storage: try StorageScope(serverOrigin: URL(string: "https://example.test")!, accountID: "account", deviceID: "device"), credentialVersion: 1)
        var state = CurrentRuntimeState(scope: scope)
        try state.snapshot.apply(response(subjects, total: total, actionable: actionable))
        state.timeVerified = true; state.countsAreCurrent = true; state.connection = .current
        state.verifiedVersions = Dictionary(uniqueKeysWithValues: subjects.map { ($0.id, $0.version) })
        return state
    }
    private func response(_ subjects: [CurrentSubjectProjection], total: Int = 2, actionable: Int = 1) -> CurrentInboxResponse {
        .init(items: subjects, retired: [], total: total, cursor: "next", hasMore: true,
              counts: .init(actionable: actionable, currentUnread: total), nextExpiryAt: now.addingTimeInterval(300), serverTime: now)
    }
    private func subject(_ index: Int, kind: RelevanceKind = .decision, version: CurrentVersion = .init(generation: 1, revision: 1), request: Int? = nil, freshUntil: Date? = nil) -> CurrentSubjectProjection {
        let suffix = String(format: "%012d", index), requestSuffix = String(format: "%012d", request ?? index)
        return .init(subjectId: "sub_11111111-1111-1111-1111-" + suffix,
                     notificationId: "ntf_11111111-1111-1111-1111-" + requestSuffix,
                     kind: kind, version: version, title: "Current \(index)", summary: "Summary", source: "Fixture",
                     createdAt: now, updatedAt: now, occurredAt: now, acceptedAt: now, readAt: nil,
                     currentUntil: kind == .progress ? nil : now.addingTimeInterval(300), freshUntil: freshUntil,
                     deliverUntil: now.addingTimeInterval(60), freshness: .unknown,
                     interaction: kind == .decision ? .init(id: "int_11111111-1111-1111-1111-" + requestSuffix, type: .text, state: .pending, expiresAt: now.addingTimeInterval(300)) : nil,
                     activity: nil, resources: nil)
    }
}
