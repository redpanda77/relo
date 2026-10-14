@testable import ReloRuntime
@testable import ReloPersistence
import Combine
import XCTest
import ReloCore
@testable import Relo

@MainActor
final class NotificationSelectionTests: XCTestCase {
    func testNotificationOutsideHistoryStartsExactDetailImmediately() async throws {
        let fixture = SelectionFixture()
        let model = await fixture.startedModel()
        let request = Task { await model.openNotification(notificationID: "outside-window") }
        await fixture.remote.waitForDetails(1)
        XCTAssertEqual(model.selectedNotificationID, "outside-window")
        XCTAssertNil(model.selectedNotification)
        await fixture.remote.complete(0, with: try fixture.detail("outside-window"))
        await request.value
        XCTAssertEqual(model.selectedNotificationDetail?.item.detail, "Full content")
        XCTAssertEqual(model.selectedNotificationID, "outside-window")
    }

    func testLateAIsNotPublishedUnderBIncludingEvidence() async throws {
        let fixture = SelectionFixture()
        let model = await fixture.startedModel()
        let a = Task { await model.openNotification(notificationID: "A") }
        await fixture.remote.waitForDetails(1)
        let b = Task { await model.openNotification(notificationID: "B") }
        await fixture.remote.waitForDetails(2)
        await fixture.remote.complete(1, with: try fixture.detail("B", evidence: "B evidence"))
        await b.value
        await fixture.remote.complete(0, with: try fixture.detail("A", evidence: "A evidence"))
        await a.value
        XCTAssertEqual(model.selectedNotificationID, "B")
        XCTAssertEqual(model.selectedNotificationDetail?.item.id, "B")
        XCTAssertEqual(model.selectedNotificationDetail?.evidence.interactions.first?.kind, "B evidence")
    }

    func testReturningToACannotAdoptTheFirstARequest() async throws {
        let fixture = SelectionFixture()
        let model = await fixture.startedModel()
        let first = Task { await model.openNotification(notificationID: "A") }
        await fixture.remote.waitForDetails(1)
        let middle = Task { await model.openNotification(notificationID: "B") }
        await fixture.remote.waitForDetails(2)
        let latest = Task { await model.openNotification(notificationID: "A") }
        await fixture.remote.waitForDetails(3)
        await fixture.remote.complete(2, with: try fixture.detail("A", evidence: "latest"))
        await latest.value
        await fixture.remote.complete(0, with: try fixture.detail("A", evidence: "obsolete"))
        await first.value
        await fixture.remote.complete(1, with: try fixture.detail("B", evidence: "obsolete B"))
        await middle.value
        XCTAssertEqual(model.selectedNotificationDetail?.evidence.interactions.first?.kind, "latest")
    }

    func testDismissAndCancellationPreventLatePublication() async throws {
        let fixture = SelectionFixture()
        let model = await fixture.startedModel()
        let dismissed = Task { await model.openNotification(notificationID: "A") }
        await fixture.remote.waitForDetails(1)
        model.dismissNotification()
        await fixture.remote.complete(0, with: try fixture.detail("A"))
        await dismissed.value
        XCTAssertNil(model.selectedNotificationID)
        XCTAssertNil(model.selectedNotificationDetail)
        let cancelled = Task { await model.openNotification(notificationID: "B") }
        await fixture.remote.waitForDetails(2)
        cancelled.cancel()
        await fixture.remote.complete(1, with: try fixture.detail("B"))
        await cancelled.value
        XCTAssertNil(model.selectedNotificationDetail)
    }

    func testReplacementCredentialAndReturnToSameCredentialFenceOldResult() async throws {
        let fixture = SelectionFixture()
        let model = await fixture.startedModel()
        let request = Task { await model.openNotification(notificationID: "A") }
        await fixture.remote.waitForDetails(1)
        model.credential = fixture.credential(accountID: "another-account", version: 2)
        model.credential = fixture.credential()
        await fixture.remote.complete(0, with: try fixture.detail("A"))
        await request.value
        XCTAssertNil(model.selectedNotificationID)
        XCTAssertNil(model.selectedNotificationDetail)
    }

    func testSignOutImmediatelyClearsPublishedDetail() async throws {
        let fixture = SelectionFixture()
        let model = await fixture.startedModel()
        let request = Task { await model.openNotification(notificationID: "A") }
        await fixture.remote.waitForDetails(1)
        await fixture.remote.complete(0, with: try fixture.detail("A"))
        await request.value
        XCTAssertNotNil(model.selectedNotificationDetail)
        model.accountState = .signingOut
        XCTAssertNil(model.selectedNotificationDetail)
        XCTAssertNil(model.selectedNotificationID)
    }

    func testMismatchedResponseIdentityIsRejected() async throws {
        let fixture = SelectionFixture()
        let model = await fixture.startedModel()
        let request = Task { await model.openNotification(notificationID: "A") }
        await fixture.remote.waitForDetails(1)
        await fixture.remote.complete(0, with: try fixture.detail("B"))
        await request.value
        XCTAssertEqual(model.selectedNotificationID, "A")
        XCTAssertNil(model.selectedNotificationDetail)
    }

    func testDetailPublishesWhileReadIsSuspendedAndOldScopeReadCannotPublishCounts() async throws {
        let fixture = SelectionFixture()
        let model = await fixture.startedModel()
        await fixture.remote.holdReads()
        let request = Task { await model.openNotification(notificationID: "A") }
        await fixture.remote.waitForDetails(1)
        await fixture.remote.waitForRead()
        let published = expectation(description: "Detail renders before read bookkeeping finishes")
        let subscription = model.selectedNotificationDetailChanges.sink { detail in
            if detail?.item.id == "A" { published.fulfill() }
        }
        await fixture.remote.complete(0, with: try fixture.detail("A"))
        await fulfillment(of: [published], timeout: 2)
        subscription.cancel()
        model.credential = fixture.credential(accountID: "replacement", version: 2)
        try await fixture.remote.completeRead()
        await request.value
        XCTAssertEqual(model.unreadCount, 0)
        XCTAssertNil(model.selectedNotificationDetail)
    }
}

@MainActor
final class MissedQuestionDismissTests: XCTestCase {
    private let question = "int_00000000-0000-4000-8000-000000000009"

    func testDismissCallsTheDismissRouteAndNeverOpensTheNotification() async throws {
        let fixture = SelectionFixture()
        let model = await fixture.startedModel()
        model.nowSummary = try fixture.missedQuestionSummary()
        let refetches = model.nowRefetchRequest
        let row = try XCTUnwrap(NowScreenInput(summary: try XCTUnwrap(model.nowSummary)).needsYou.first)
        XCTAssertEqual(row.questionID, question)
        XCTAssertEqual(NowScreenModel.needsRow(row).questionID, question, "the Dismiss button gets the question, not the notification")

        await model.dismissMissedQuestion(questionID: question)

        let dismissed = await fixture.api.dismissedQuestions
        XCTAssertEqual(dismissed, [question])
        XCTAssertEqual(model.nowSummary?.needsYou.count, 0, "the row leaves at once")
        XCTAssertNil(model.selectedNotificationID, "Dismiss never opens the card")
        XCTAssertNil(model.nowDismissError)
        XCTAssertEqual(model.nowRefetchRequest, refetches + 1, "Now refetches")
    }

    func testAFailedDismissRestoresTheRowWithAShortError() async throws {
        let fixture = SelectionFixture()
        let model = await fixture.startedModel()
        let summary = try fixture.missedQuestionSummary()
        model.nowSummary = summary
        await fixture.api.failDismissals()

        await model.dismissMissedQuestion(questionID: question)

        XCTAssertEqual(model.nowSummary, summary, "the row comes back")
        XCTAssertNotNil(model.nowDismissError)
        XCTAssertNil(model.selectedNotificationID)
    }

    func testARefusedDismissMeansTheRowWasStaleSoItStaysGoneWithoutAnError() async throws {
        let fixture = SelectionFixture()
        let model = await fixture.startedModel()
        let summary = try fixture.missedQuestionSummary()
        model.nowSummary = summary
        await fixture.api.refuseDismissals()
        let refetches = model.nowRefetchRequest

        await model.dismissMissedQuestion(questionID: question)

        XCTAssertEqual(model.nowSummary?.needsYou.count, 0, "the server says it isn't missed: the row stays gone")
        XCTAssertNil(model.nowDismissError, "nothing to tell the owner")
        XCTAssertEqual(model.nowRefetchRequest, refetches + 1, "Now refetches")
        model.receiveNowSummary(summary)
        XCTAssertEqual(model.nowSummary?.needsYou.count, 0, "a stale or cached summary does not bring it back")
    }
}

@MainActor
private struct SelectionFixture {
    let remote = SelectionRemote()
    let api = SelectionAPI()
    let identity = UUID(uuidString: "11111111-1111-1111-1111-111111111111")!
    var items: [InboxItem] { ["A", "B"].map {
        InboxItem(id: $0, kind: .notification, sourceName: "Test", title: $0, createdAt: .distantPast)
    } }
    func credential(accountID: String = "selection-account", version: Int = 1) -> DeviceCredential {
        DeviceCredential(deviceId: "selection-device", installationId: identity,
                         accessToken: "test-only", issuedAt: .distantPast,
                         accountId: accountID, credentialVersion: version)
    }
    func startedModel() async -> AppModel {
        let actions = InMemoryProtectedActionStore()
        let stores = SelectionStores()
        let model = AppModel(dependencies: AppDependencies(
            credentialStore: SelectionCredentials(value: credential()),
            accountSessionStore: stores, installationIDStore: stores, stableDeviceIDStore: stores,
            pushTokenStore: stores, liveActivityPushToStartTokenStore: stores,
            registrationAttemptStore: stores, cache: SelectionCache(items: items),
            apiClient: api, liveActivityCoordinator: LiveActivityCommandCoordinator(store: actions),
            pendingResponseStore: actions, notificationReceiptStore: stores,
            accountNotificationCleaner: stores, serverURL: URL(string: "https://relo.invalid")!,
            system: AppSystemServices(notificationPermission: { .denied },
                                      startActivityObservation: { _ in }, setBadgeCount: { _ in },
                                      pushRegistrationError: { nil }),
            makeInboxDataSource: { [remote] _, _ in remote },
            makeCurrentDataSource: { _, _ in OfflineCurrentSourceFixture() }
        ))
        await model.start()
        return model
    }
    /// A Now summary whose Needs you holds one missed question.
    func missedQuestionSummary() throws -> NowSummary {
        let json = """
        {"serverTime":"2026-10-14T10:00:00Z",
         "sinceYouLooked":{"since":"2026-10-14T09:00:00Z","finished":0,"failed":0,"waitingOnYou":0,"stoppedWithoutFinishing":0,"needsYou":1},
         "needsYou":[{"id":"act_00000000-0000-4000-8000-000000000001","title":"Ship the release","status":"Deploy to production?",
           "sourceName":"Claude Code","project":"relo","steps":null,"producer":"agent_session","sessionId":null,
           "notificationId":"ntf_00000000-0000-4000-8000-000000000009","startedAt":"2026-10-14T09:58:00Z","declaredAt":"2026-10-14T09:58:00Z",
           "question":{"id":"int_00000000-0000-4000-8000-000000000009","standing":"missed","askedAt":"2026-10-14T09:58:00Z","openedAt":null},
           "owner":{"state":"needs_you","needsYou":"missed_question","evidenceAt":"2026-10-14T09:58:00Z","evidenceSource":"declared",
             "staleDate":"2026-10-14T10:18:00Z","lockScreen":"top","relevance":1,"apnsPriority":10}}],
         "recent":[],"waitingOnYou":[],"quiet":[],"paused":[],"running":[],
         "folds":{"waitingOnYou":0,"quiet":0,"paused":0},"lockScreen":{"cards":[],"needsYouCount":1,"focus":null},
         "sessions":{"sessions":[],"folds":{"idle":0}},"refreshAt":null}
        """
        return try ReloWireJSON.decoder().decode(NowSummary.self, from: Data(json.utf8))
    }

    func detail(_ id: String, evidence: String = "evidence") throws -> InboxNotificationDetail {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let item = try JSONSerialization.jsonObject(with: encoder.encode(items.first { $0.id == id } ?? InboxItem(id: id, kind: .notification, sourceName: "Exact", title: "Outside history", detail: "Full content", createdAt: .distantPast)))
        let data = try JSONSerialization.data(withJSONObject: [
            "item": item, "evidence": ["deliveries": [], "withdrawals": [],
            "interactions": [["kind": evidence, "createdAt": "2026-09-30T00:00:00Z"]]]
        ])
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(InboxNotificationDetail.self, from: data)
    }
}

private actor SelectionRemote: InboxFixtureSource {
    private var requests: [CheckedContinuation<InboxNotificationDetail, any Error>?] = []
    private var detailWaiters: [(Int, CheckedContinuation<Void, Never>)] = []
    private var readWaiters: [CheckedContinuation<Void, Never>] = []
    private var read: CheckedContinuation<InboxReadMutationResponse, any Error>?
    private var shouldHoldReads = false
    func fetchPage(after cursor: String?) async throws -> InboxPage { throw InboxRemoteError.unavailable }
    func fetchHistoryPage(before cursor: String?) async throws -> InboxHistoryPage { throw InboxRemoteError.unavailable }
    func fetchActiveLiveActivities() async throws -> ActiveLiveActivityIdentityPage { throw InboxRemoteError.unavailable }
    func fetchDetail(notificationID: String) async throws -> InboxNotificationDetail {
        try await withCheckedThrowingContinuation { continuation in
            requests.append(continuation)
            let ready = detailWaiters.filter { $0.0 <= requests.count }
            detailWaiters.removeAll { $0.0 <= requests.count }
            ready.forEach { $0.1.resume() }
        }
    }
    func waitForDetails(_ count: Int) async {
        if requests.count >= count { return }
        await withCheckedContinuation { detailWaiters.append((count, $0)) }
    }
    func complete(_ index: Int, with detail: InboxNotificationDetail) {
        let continuation = requests[index]
        requests[index] = nil
        continuation?.resume(returning: detail)
    }
    func holdReads() { shouldHoldReads = true }
    func waitForRead() async {
        if read != nil { return }
        await withCheckedContinuation { readWaiters.append($0) }
    }
    func markRead(notificationID: String) async throws -> InboxReadMutationResponse {
        guard shouldHoldReads else { throw InboxRemoteError.unavailable }
        return try await withCheckedThrowingContinuation { continuation in
            read = continuation
            readWaiters.forEach { $0.resume() }
            readWaiters.removeAll()
        }
    }
    func completeRead() throws {
        let response = try JSONDecoder().decode(InboxReadMutationResponse.self,
            from: Data(#"{"changed":true,"unread":{"account":99,"projects":{}}}"#.utf8))
        let continuation = read
        read = nil
        continuation?.resume(returning: response)
    }
    func markAllRead(watermark: String) async throws -> InboxReadMutationResponse { throw InboxRemoteError.unavailable }
}

private struct SelectionCredentials: DeviceCredentialStore {
    let value: DeviceCredential
    func load() -> DeviceCredential? { value }
    func save(_ credential: DeviceCredential) { XCTFail("Unexpected credential save") }
    func delete() { XCTFail("Unexpected credential delete") }
}
private struct SelectionStores: AccountSessionStore, InstallationIDStore, StableDeviceIDStore,
    PushTokenStore, RegistrationAttemptStore, ScopedNotificationReceiptStoring, AccountNotificationClearing {
    func load() -> AccountSession? { nil }
    func load() -> String? { nil }
    func save(_ session: AccountSession) {}
    func save(_ token: String) {}
    func delete() {}
    func loadOrCreate() -> UUID { UUID(uuidString: "11111111-1111-1111-1111-111111111111")! }
    func attempt(for request: DeviceRegistrationRequest, minimumRevision: Int) -> RegistrationAttempt {
        XCTFail("Unexpected registration")
        return RegistrationAttempt(revision: minimumRevision, request: request)
    }
    func advanceCurrentAttempt() {}
    func pending(limit: Int) -> [String] { [] }
    func remove(notificationIDs: Set<String>) {}
    func clearAllDeliveredAndPendingNotifications() async throws {}
}
private actor SelectionCache: AccountScopedInboxCaching {
    let snapshot: InboxSnapshot
    init(items: [InboxItem]) { snapshot = InboxSnapshot(items: items) }
    func select(accountId: String) {}
    func boundCache(for accountId: String) -> any InboxCache { InMemoryInboxCache(snapshot: snapshot) }
    func load() -> InboxSnapshot { snapshot }
    func save(_ snapshot: InboxSnapshot) {}
    func clearSelectedAccount() {}
}
private actor SelectionAPI: MobileAPIClient {
    private(set) var dismissedQuestions: [String] = []
    var dismissalFails = false
    var dismissalRefused = false
    func failDismissals() { dismissalFails = true }
    func refuseDismissals() { dismissalRefused = true }
    func dismissMissedQuestion(credential: DeviceCredential, questionId: String) async throws {
        dismissedQuestions.append(questionId)
        if dismissalFails { throw MobileAPIError.unavailable }
        if dismissalRefused { throw MobileAPIError.invalidRequest }
    }
    func validateAccountSession(token: String) async throws -> AccountSession { throw MobileAPIError.unavailable }
    func registerDevice(sessionToken: String, request: DeviceRegistrationRequest, idempotencyKey: String) async throws -> DeviceRegistrationResponse { throw MobileAPIError.unavailable }
    func deviceSelf(credential: DeviceCredential) async throws -> DeviceSelfResponse { throw MobileAPIError.unavailable }
    func heartbeat(credential: DeviceCredential, heartbeat: DeviceHeartbeat) async throws { throw MobileAPIError.unavailable }
    func registerLiveActivityToken(credential: DeviceCredential, activityId: String, registration: LiveActivityTokenRegistration) async throws { throw MobileAPIError.unavailable }
    func submitInteraction(credential: DeviceCredential, notificationId: String, action: NotificationInteractionAction, value: [String: String], idempotencyKey: String) async throws {}
    func revokeDevice(credential: DeviceCredential) async throws { throw MobileAPIError.unavailable }
    func signOutAccount(sessionToken: String) async throws { throw MobileAPIError.unavailable }
    func deleteAccount(sessionToken: String, password: String, confirmation: String) async throws { throw MobileAPIError.unavailable }
}
