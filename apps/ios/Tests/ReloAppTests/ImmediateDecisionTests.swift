@testable import ReloRuntime
@testable import ReloPersistence
import XCTest
import Testing
import Combine
@testable import ReloCore
@testable import Relo

@MainActor
final class ImmediateDecisionTests: XCTestCase {
    func testRecoveryFailureDoesNotBlockAnotherSavedDecision() async throws {
        let fixture = try await Fixture.make()
        defer { fixture.model.backgrounded(); fixture.removeFiles() }
        _ = try await fixture.store.enqueue(fixture.pending("older-unavailable", action: .deny))
        _ = try await fixture.store.enqueue(fixture.pending("new", action: .approve))
        let accepted = expectation(description: "Independent saved decision accepted")
        let observation = fixture.model.responseFeedbackChanges.first { $0["new"]?.phase == .accepted }
            .sink { _ in accepted.fulfill() }
        _ = await fixture.model.refresh()
        await fulfillment(of: [accepted], timeout: 2)
        let pending = try await fixture.store.pending(now: .now)
        XCTAssertEqual(pending.map(\.notificationID), ["older-unavailable"])
        observation.cancel()
    }

    func testBackgroundDeadlineRetainsSavedReplyAndLateFailureCannotRevokeSession() async throws {
        let fixture = try await Fixture.make(start: false)
        defer { fixture.removeFiles() }
        let gate = DeadlineGate(), started = expectation(description: "background network started")
        await fixture.api.hold { started.fulfill() }
        let metadata = try XCTUnwrap(NotificationDecisionMetadata(relo: [
            "accountId": fixture.credential.accountId, "deviceId": fixture.credential.deviceId,
            "interactionId": "request-held", "interactionType": "approval",
            "interactionExpiresAt": Date.now.addingTimeInterval(300).ISO8601Format(),
        ]))
        let owner = BackgroundNotificationActionCoordinator(waitForDeadline: { await gate.wait() })
        owner.install(model: fixture.model)
        let handling = Task { await owner.handle(.init(notificationID: "held", action: .approve, text: nil, metadata: metadata)) }
        await fulfillment(of: [started], timeout: 2)
        await gate.fire()
        await handling.value
        let pending = try await fixture.store.pending(now: .now)
        XCTAssertEqual(pending.map(\.notificationID), ["held"])
        await fixture.api.release()
        await Task.yield()
        XCTAssertEqual(fixture.model.credential, fixture.credential)
        XCTAssertNotEqual(fixture.model.responseFeedbackByNotificationID["held"]?.phase, .accepted)
    }

    func testNotificationButtonSubmitsWithoutStartingAppOrFetchingInbox() async throws {
        let fixture = try await Fixture.make(start: false)
        defer { fixture.removeFiles() }
        let deadline = Date.now.addingTimeInterval(300)
        let metadata = try XCTUnwrap(NotificationDecisionMetadata(relo: [
            "accountId": fixture.credential.accountId, "deviceId": fixture.credential.deviceId,
            "interactionId": "request-background", "interactionType": "approval",
            "interactionExpiresAt": deadline.ISO8601Format(),
        ]))
        let owner = BackgroundNotificationActionCoordinator()
        owner.install(model: fixture.model)
        await owner.handle(NotificationActionRequest(notificationID: "background", action: .approve,
            text: nil, metadata: metadata))
        let calls = await fixture.api.calls
        XCTAssertEqual(calls.map(\.0), ["background"])
        let responses = await fixture.api.responses
        XCTAssertEqual(responses.first?.interactionID, "request-background")
        XCTAssertEqual(responses.first?.serverOrigin, URL(string: "https://relo.invalid"))
        XCTAssertEqual(responses.first?.expiresAt.timeIntervalSince1970 ?? 0,
            metadata.expiresAt.timeIntervalSince1970, accuracy: 0.001)
        XCTAssertEqual(fixture.model.responseFeedbackByNotificationID["background"]?.phase, .accepted)
        let fetches = await fixture.remote.fetches
        XCTAssertEqual(fetches, 0)
    }

    func testExpiredOrWrongAccountButtonNeverSendsAndMissingMetadataGetsNoInventedDeadline() async throws {
        let fixture = try await Fixture.make()
        defer { fixture.removeFiles() }
        for (id, account, expiry) in [("expired", fixture.credential.accountId, Date.distantPast),
                                      ("wrong-account", "different-account", Date.distantFuture)] {
            let metadata = try XCTUnwrap(NotificationDecisionMetadata(relo: [
                "accountId": account, "deviceId": fixture.credential.deviceId,
                "interactionId": "request-\(id)", "interactionType": "approval",
                "interactionExpiresAt": expiry.ISO8601Format(),
            ]))
            await fixture.model.respondToNotificationAction(.init(notificationID: id, action: .approve,
                text: nil, metadata: metadata))
        }
        await fixture.model.respondToNotificationAction(.init(notificationID: "legacy", action: .approve, text: nil))
        await fixture.model.respond(notificationID: "unknown", action: .approve)
        let calls = await fixture.api.calls, pending = try await fixture.store.pending(now: .now)
        XCTAssertTrue(calls.isEmpty); XCTAssertTrue(pending.isEmpty)
        XCTAssertEqual(fixture.model.responseFeedbackByNotificationID["expired"]?.phase, .rejected)
        XCTAssertEqual(fixture.model.responseFeedbackByNotificationID["legacy"]?.phase, .rejected)
    }

    func testDeadlineCompletesWithoutWaitingForNoncooperativeOperationAndIgnoresLateResult() async {
        let gate = DeadlineGate()
        let started = expectation(description: "operation started")
        var continuation: CheckedContinuation<Bool, Never>?
        var completions = 0
        let attempt = Task { @MainActor in
            let value = await BoundedDecisionAttempt.run(waitForDeadline: { await gate.wait() }) {
                await withCheckedContinuation { continuation = $0; started.fulfill() }
            }
            completions += 1
            return value
        }
        await fulfillment(of: [started], timeout: 2)
        await gate.fire()
        let result = await attempt.value
        XCTAssertFalse(result); XCTAssertEqual(completions, 1)
        continuation?.resume(returning: true)
        await Task.yield()
        XCTAssertEqual(completions, 1)
    }

    func testFailedOlderResponseCannotBlockNewDecisionOrRequireRefresh() async throws {
        let fixture = try await Fixture.make()
        defer { fixture.removeFiles() }
        // Isolate direct submission from the independently scheduled startup retry pass.
        fixture.model.backgrounded()
        _ = try await fixture.store.enqueue(fixture.pending("older-unavailable", action: .deny))
        await fixture.model.respond(to: fixture.item("new"), action: .approve)
        let calls = await fixture.api.calls
        XCTAssertEqual(calls.map(\.0), ["new"])
        XCTAssertEqual(fixture.model.responseFeedbackByNotificationID["new"]?.phase, .accepted)
        let remaining = try await fixture.store.pending(now: .now)
        XCTAssertEqual(remaining.map(\.notificationID), ["older-unavailable"])
        let fetches = await fixture.remote.fetches
        XCTAssertEqual(fetches, fixture.initialFetches)
    }

    func testDuplicateTapSendsTheFirstDurablyStoredChoice() async throws {
        let fixture = try await Fixture.make()
        defer { fixture.removeFiles() }
        _ = try await fixture.store.enqueue(fixture.pending("new", action: .deny))
        await fixture.model.respond(to: fixture.item("new"), action: .approve)
        let calls = await fixture.api.calls
        XCTAssertEqual(calls.count, 1)
        XCTAssertEqual(calls.first?.1, .deny)
        XCTAssertEqual(fixture.model.responseFeedbackByNotificationID["new"]?.action, .deny)
        XCTAssertEqual(fixture.model.responseFeedbackByNotificationID["new"]?.phase, .accepted)
    }

    func testOldSessionFailureCannotRevokeReplacementCredential() async throws {
        let fixture = try await Fixture.make()
        defer { fixture.removeFiles() }
        let started = expectation(description: "old session request started")
        await fixture.api.hold { started.fulfill() }
        let request = Task { await fixture.model.respond(to: fixture.item("held"), action: .approve) }
        await fulfillment(of: [started], timeout: 2)
        fixture.model.credential = DeviceCredential(deviceId: "replacement-device", installationId: UUID(),
            accessToken: "replacement-test-only", issuedAt: .now, accountId: "replacement-account", credentialVersion: 2)
        await fixture.api.release()
        await request.value
        XCTAssertEqual(fixture.model.credential?.accountId, "replacement-account")
        XCTAssertNotEqual(fixture.model.responseFeedbackByNotificationID["held"]?.phase, .accepted)
        XCTAssertNil(fixture.model.interactionError)
        let confirmations = try await fixture.store.notificationConfirmations(now: .now)
        XCTAssertTrue(confirmations.isEmpty)
    }

    func testSuspendedDecisionJoinsDuplicateAndDoesNotBlockAnotherDecision() async {
        let coordinator = ImmediateDecisionCoordinator()
        let key = ImmediateDecisionCoordinator.Key(scope: "scope", decision: "first")
        let started = expectation(description: "first request started")
        let joined = expectation(description: "duplicate joined")
        var continuation: CheckedContinuation<Void, Never>?
        var attempts = 0
        let first = Task { @MainActor in
            await coordinator.submit(key: key) {
                attempts += 1
                await withCheckedContinuation { continuation = $0; started.fulfill() }
                return true
            }
        }
        await fulfillment(of: [started], timeout: 2)
        let duplicate = Task { @MainActor in
            joined.fulfill()
            return await coordinator.submit(key: key) { attempts += 1; return false }
        }
        await fulfillment(of: [joined], timeout: 2)
        let other = await coordinator.submit(key: .init(scope: "scope", decision: "second")) { true }
        XCTAssertTrue(other); XCTAssertEqual(attempts, 1)
        continuation?.resume()
        let firstResult = await first.value, duplicateResult = await duplicate.value
        XCTAssertTrue(firstResult); XCTAssertTrue(duplicateResult)
        let retry = await coordinator.submit(key: key) { attempts += 1; return true }
        XCTAssertTrue(retry); XCTAssertEqual(attempts, 2)
    }
    func testCurrentApprovalSubmitsDirectlyWithoutHistoryMembershipOrDetailFetch() async throws {
        let source = CurrentDecisionSource()
        let fixture = try await Fixture.make(currentSource: source)
        defer { fixture.model.backgrounded(); fixture.removeFiles() }
        let painted = expectation(description: "Independent pending request painted")
        let observation = fixture.model.currentStateChanges.compactMap { $0 }.first { $0.pendingConnection == .current }
            .sink { _ in painted.fulfill() }
        await fulfillment(of: [painted], timeout: 2)
        let draft = try XCTUnwrap(fixture.model.currentDecision(notificationID: CurrentDecisionSource.notification(1)))
        XCTAssertTrue(fixture.model.items.isEmpty)
        XCTAssertEqual(fixture.model.decisionAvailability(draft.identity), .available)
        await fixture.model.respond(to: draft.identity, action: .approve)
        let calls = await fixture.api.responses
        XCTAssertEqual(calls.count, 1)
        XCTAssertEqual(calls.first?.notificationID, draft.identity.notificationID)
        XCTAssertEqual(calls.first?.interactionID, draft.identity.interactionID)
        XCTAssertEqual(calls.first?.expiresAt, draft.identity.expiresAt)
        let historyFetches = await fixture.remote.fetches
        XCTAssertEqual(historyFetches, fixture.initialFetches)
        XCTAssertEqual(fixture.model.responseFeedback(for: draft.identity.notificationID)?.phase, .accepted)
        observation.cancel()
    }

    func testReplacementKeepsOriginalDraftAndRejectsItsSubmissionLocally() async throws {
        let source = CurrentDecisionSource()
        let fixture = try await Fixture.make(currentSource: source)
        defer { fixture.model.backgrounded(); fixture.removeFiles() }
        let painted = expectation(description: "First request painted")
        let first = fixture.model.currentStateChanges.compactMap { $0 }.first { $0.pendingConnection == .current }
            .sink { _ in painted.fulfill() }
        await fulfillment(of: [painted], timeout: 2)
        var draft = try XCTUnwrap(fixture.model.currentDecision(notificationID: CurrentDecisionSource.notification(1)))
        draft.text = "Answer belongs to request one"
        fixture.model.retainDecisionDraft(draft)
        await source.replace()
        let replaced = expectation(description: "Replacement request painted")
        let second = fixture.model.currentStateChanges.compactMap { $0 }.first {
            $0.snapshot.pending?.entries.values.contains { $0.item.notificationId == CurrentDecisionSource.notification(2) } == true
        }.sink { _ in replaced.fulfill() }
        await fixture.model.refreshCurrent()
        await fulfillment(of: [replaced], timeout: 2)
        XCTAssertEqual(fixture.model.decisionAvailability(draft.identity), .replaced)
        XCTAssertEqual(fixture.model.retainedDecisionDrafts.first?.text, draft.text)
        XCTAssertEqual(fixture.model.retainedDecisionDrafts.first?.identity, draft.identity)
        await fixture.model.respond(to: draft.identity, action: .approve)
        let calls = await fixture.api.responses
        XCTAssertTrue(calls.isEmpty)
        XCTAssertEqual(fixture.model.responseFeedback(for: draft.identity.notificationID)?.phase, .rejected)
        first.cancel(); second.cancel()
    }

}

@Suite("Diagnostic recovery presentation") @MainActor
struct DiagnosticRecoveryPresentationTests {
    @Test func pendingReplyNeverLooksConfirmedAndLastConfirmationSurvivesAnotherPendingReply() async throws {
        let fixture = try await Fixture.make()
        defer { fixture.removeFiles() }
        fixture.model.accountState = .signedIn
        await fixture.model.respond(to: fixture.item("older-unavailable"), action: .approve)
        await fixture.model.refreshDiagnosticQueues()
        var queue = try #require(fixture.model.recoveryQueues.first { $0.operation == .responseSubmission })
        #expect(queue.status == .retrying)
        #expect(queue.depth == 1)
        #expect(queue.lastConfirmedAt == nil)
        await fixture.model.respond(to: fixture.item("new-confirmed"), action: .approve)
        await fixture.model.refreshDiagnosticQueues()
        queue = try #require(fixture.model.recoveryQueues.first { $0.operation == .responseSubmission })
        #expect(queue.status == .pending)
        #expect(queue.depth == 1)
        #expect(queue.lastConfirmedAt != nil)
    }

    @Test(.timeLimit(.minutes(1))) func diagnosticWriterCannotBlockAnImmediateDecision() async throws {
        let diagnostic = SuspendedDiagnosticSink()
        let fixture = try await Fixture.make(diagnostics: diagnostic)
        defer { fixture.removeFiles() }
        fixture.model.accountState = .signedIn
        await fixture.model.respond(to: fixture.item("new-confirmed"), action: .approve)
        #expect(fixture.model.responseFeedback(for: "new-confirmed")?.phase == .accepted)
        #expect(await fixture.api.responses.count == 1)
        await diagnostic.release()
    }
}

private actor SuspendedDiagnosticSink: DiagnosticStoring {
    private var blocked = true
    private var waiting: [CheckedContinuation<Void, Never>] = []
    func record(_ event: OperationDiagnostic) async {
        if blocked { await withCheckedContinuation { waiting.append($0) } }
    }
    func snapshot() -> DiagnosticSnapshot { .init(events: [], capacity: 500, persistenceUnavailable: false) }
    func release() { blocked = false; waiting.forEach { $0.resume() }; waiting = [] }
}

@MainActor
private struct Fixture {
    let directory: URL
    let credential: DeviceCredential
    let store: AccountScopedCrossProcessResponseStore
    let api: DecisionAPI
    let remote: DecisionInbox
    let model: AppModel
    let initialFetches: Int

    static func make(start: Bool = true, currentSource: any CurrentStateSource = OfflineCurrentSourceFixture(), diagnostics: any DiagnosticStoring = NoopDiagnosticStore()) async throws -> Fixture {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = AccountScopedCrossProcessResponseStore(baseDirectory: directory)
        let credential = DeviceCredential(deviceId: "fixture-device", installationId: UUID(),
            accessToken: "test-only", issuedAt: .distantPast, accountId: "fixture-account", credentialVersion: 1)
        await store.select(accountID: credential.accountId, deviceID: credential.deviceId)
        let api = DecisionAPI(), remote = DecisionInbox(), stores = DecisionStores()
        let model = AppModel(dependencies: AppDependencies(
            credentialStore: DecisionCredentials(value: credential), accountSessionStore: stores,
            installationIDStore: stores, stableDeviceIDStore: stores, pushTokenStore: stores,
            liveActivityPushToStartTokenStore: stores, registrationAttemptStore: stores,
            cache: DecisionCache(), apiClient: api,
            liveActivityCoordinator: LiveActivityCommandCoordinator(store: InMemoryProtectedActionStore()),
            pendingResponseStore: store, notificationReceiptStore: stores, accountNotificationCleaner: stores,
            serverURL: URL(string: "https://relo.invalid")!,
            diagnostics: diagnostics,
            system: AppSystemServices(notificationPermission: { .denied }, startActivityObservation: { _ in },
                setBadgeCount: { _ in }, pushRegistrationError: { nil }),
            makeInboxDataSource: { _, _ in remote },
            makeCurrentDataSource: { _, _ in currentSource }))
        if start { await model.start() }
        return Fixture(directory: directory, credential: credential, store: store, api: api,
            remote: remote, model: model, initialFetches: await remote.fetches)
    }
    func removeFiles() { try? FileManager.default.removeItem(at: directory) }
    func pending(_ id: String, action: NotificationInteractionAction) -> PendingNotificationResponse {
        PendingNotificationResponse(accountID: credential.accountId, deviceID: credential.deviceId,
            notificationID: id, action: action, value: [:], idempotencyKey: "original:\(id):\(action.rawValue)",
            expiresAt: .now.addingTimeInterval(900), interactionID: "request-\(id)",
            serverOrigin: URL(string: "https://relo.invalid"))
    }
    func item(_ id: String) -> InboxItem {
        InboxItem(id: id, kind: .notification, sourceName: "Fixture", title: "Fixture", createdAt: .now,
            interaction: InboxInteraction(id: "request-\(id)", kind: .approval, prompt: "Fixture",
                state: .pending, expiresAt: .now.addingTimeInterval(900)))
    }
}

private actor DecisionInbox: InboxFixtureSource {
    var fetches = 0
    func fetchPage(after cursor: String?) async throws -> InboxPage { fetches += 1; throw InboxRemoteError.unavailable }
    func fetchHistoryPage(before cursor: String?) async throws -> InboxHistoryPage { throw InboxRemoteError.unavailable }
    func fetchActiveLiveActivities() async throws -> ActiveLiveActivityIdentityPage { throw InboxRemoteError.unavailable }
    func fetchDetail(notificationID: String) async throws -> InboxNotificationDetail { throw InboxRemoteError.unavailable }
    func markRead(notificationID: String) async throws -> InboxReadMutationResponse { throw InboxRemoteError.unavailable }
    func markAllRead(watermark: String) async throws -> InboxReadMutationResponse { throw InboxRemoteError.unavailable }
}
private struct DecisionCredentials: DeviceCredentialStore {
    let value: DeviceCredential
    func load() -> DeviceCredential? { value }
    func save(_ credential: DeviceCredential) { XCTFail("Unexpected credential save") }
    func delete() { XCTFail("Unexpected credential delete") }
}
private struct DecisionStores: AccountSessionStore, InstallationIDStore, StableDeviceIDStore,
    PushTokenStore, RegistrationAttemptStore, ScopedNotificationReceiptStoring, AccountNotificationClearing {
    func load() -> AccountSession? { nil }
    func load() -> String? { nil }
    func save(_ session: AccountSession) {}
    func save(_ token: String) {}
    func delete() {}
    func loadOrCreate() -> UUID { UUID(uuidString: "11111111-1111-1111-1111-111111111111")! }
    func attempt(for request: DeviceRegistrationRequest, minimumRevision: Int) -> RegistrationAttempt {
        XCTFail("Unexpected registration"); return RegistrationAttempt(revision: minimumRevision, request: request)
    }
    func advanceCurrentAttempt() {}
    func pending(limit: Int) -> [String] { [] }
    func remove(notificationIDs: Set<String>) {}
    func clearAllDeliveredAndPendingNotifications() async throws {}
}
private actor DecisionCache: AccountScopedInboxCaching {
    func select(accountId: String) {}
    func boundCache(for accountId: String) -> any InboxCache { InMemoryInboxCache(snapshot: InboxSnapshot(items: [])) }
    func load() -> InboxSnapshot { InboxSnapshot(items: []) }
    func save(_ snapshot: InboxSnapshot) {}
    func clearSelectedAccount() {}
}
private actor DecisionAPI: MobileAPIClient {
    var responses: [PendingNotificationResponse] = []
    func submitDecision(credential: DeviceCredential, response: PendingNotificationResponse) async throws -> NotificationDecisionAcknowledgement {
        responses.append(response)
        try await submitInteraction(credential: credential, notificationId: response.notificationID,
            action: response.action, value: response.value, idempotencyKey: response.idempotencyKey)
        return .init(id: response.interactionID ?? "missing", state: NotificationResponsePolicy.canonicalState(for: response.action)!, respondedAt: .now)
    }
    var calls: [(String, NotificationInteractionAction)] = []
    var onStart: (@Sendable () -> Void)?
    var suspended: CheckedContinuation<Void, Never>?
    func hold(onStart: @escaping @Sendable () -> Void) { self.onStart = onStart }
    func release() { suspended?.resume(); suspended = nil }
    func submitInteraction(credential: DeviceCredential, notificationId: String, action: NotificationInteractionAction, value: [String: String], idempotencyKey: String) async throws {
        calls.append((notificationId, action))
        if notificationId == "held", let onStart {
            await withCheckedContinuation { suspended = $0; onStart() }
            throw MobileAPIError.forbidden
        }
        if notificationId == "older-unavailable" { throw MobileAPIError.unavailable }
    }
    func validateAccountSession(token: String) async throws -> AccountSession { throw MobileAPIError.unavailable }
    func registerDevice(sessionToken: String, request: DeviceRegistrationRequest, idempotencyKey: String) async throws -> DeviceRegistrationResponse { throw MobileAPIError.unavailable }
    func deviceSelf(credential: DeviceCredential) async throws -> DeviceSelfResponse { throw MobileAPIError.unavailable }
    func heartbeat(credential: DeviceCredential, heartbeat: DeviceHeartbeat) async throws { throw MobileAPIError.unavailable }
    func registerLiveActivityToken(credential: DeviceCredential, activityId: String, registration: LiveActivityTokenRegistration) async throws { throw MobileAPIError.unavailable }
    func revokeDevice(credential: DeviceCredential) async throws { throw MobileAPIError.unavailable }
    func signOutAccount(sessionToken: String) async throws { throw MobileAPIError.unavailable }
    func deleteAccount(sessionToken: String, password: String, confirmation: String) async throws { throw MobileAPIError.unavailable }
}

private actor DeadlineGate {
    private var fired = false
    private var continuation: CheckedContinuation<Void, Never>?
    func wait() async {
        if fired { return }
        await withCheckedContinuation { continuation = $0 }
    }
    func fire() { fired = true; continuation?.resume(); continuation = nil }
}

private actor CurrentDecisionSource: CurrentStateSource {
    private var revision = 1
    private let deadline = Date.now.addingTimeInterval(900)
    nonisolated static func notification(_ revision: Int) -> String { "ntf_11111111-1111-1111-1111-" + String(format: "%012d", revision) }
    func replace() { revision += 1 }
    func fetchCurrent(ids: [String]?) -> CurrentInboxResponse {
        .init(items: [], retired: (ids ?? []).map { .init(subjectId: $0, reason: .notFound, version: nil) },
            total: 1, cursor: nil, hasMore: false, counts: .init(actionable: 1, currentUnread: 1), nextExpiryAt: deadline, serverTime: .now)
    }
    func fetchCurrentPage(after cursor: String?) -> CurrentInboxResponse { fetchCurrent(ids: nil) }
    func fetchPending(after cursor: String?, limit: Int) -> PendingCurrentPage {
        let item = PendingCurrentDecision(subjectId: "sub_11111111-1111-1111-1111-111111111111",
            notificationId: Self.notification(revision), version: .init(generation: 1, revision: revision), kind: .decision,
            title: "Current approval", summary: "Original question", source: "Test", createdAt: .now, readAt: nil, urgencyRank: 0,
            interaction: .init(id: "int_11111111-1111-1111-1111-" + String(format: "%012d", revision),
                type: .approval, state: .pending, expiresAt: deadline))
        return .init(items: [item], total: 1, hasMore: false, cursor: nil, nextExpiryAt: deadline, serverTime: .now)
    }
    nonisolated func changes() -> AsyncThrowingStream<CurrentChangeHint, Error> { AsyncThrowingStream { $0.finish() } }
}
