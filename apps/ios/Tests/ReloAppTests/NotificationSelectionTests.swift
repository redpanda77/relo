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
private struct SelectionFixture {
    let remote = SelectionRemote()
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
            apiClient: SelectionAPI(), liveActivityCoordinator: LiveActivityCommandCoordinator(store: actions),
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
