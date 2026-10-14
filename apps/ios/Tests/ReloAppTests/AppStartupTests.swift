@testable import ReloTransport
@testable import ReloRuntime
@testable import ReloPersistence
import XCTest
import Combine
import ReloNotificationSupport
import Darwin
@testable import ReloCore
@testable import Relo

@MainActor
final class AppStartupTests: XCTestCase {
    func testConstructionDoesNotStartExternalWork() async {
        let fixture = StartupFixture()
        let model = AppModel(dependencies: fixture.dependencies)

        XCTAssertEqual(model.accountState, .restoring)
        XCTAssertEqual(fixture.observerStarts, 0)
        XCTAssertEqual(fixture.permissionReads, 0)
        XCTAssertEqual(fixture.badgeWrites, [])
        let requests = await fixture.api.requests
        let cacheReads = await fixture.cache.loads
        XCTAssertEqual(requests, 0)
        XCTAssertEqual(cacheReads, 0)
    }

    func testStartCanUseInjectedServicesAndCachedItems() async {
        let fixture = StartupFixture()
        let model = AppModel(dependencies: fixture.dependencies)
        await model.start()

        XCTAssertEqual(model.items.map(\.id), [fixture.item.id])
        XCTAssertEqual(model.permission, .denied)
        XCTAssertEqual(model.accountState, .signedIn)
        XCTAssertEqual(fixture.observerStarts, 1)
        XCTAssertEqual(fixture.permissionReads, 1)
        XCTAssertEqual(fixture.badgeWrites, [0])
        let requests = await fixture.api.requests
        XCTAssertEqual(requests, 1)

        await model.start()
        XCTAssertEqual(fixture.observerStarts, 1)
        let requestsAfterSecondStart = await fixture.api.requests
        XCTAssertEqual(requestsAfterSecondStart, 1)
    }
}

@MainActor
private final class StartupFixture {
    let item = InboxItem(id: "evt_startup123456", kind: .notification,
                         sourceName: "Test", title: "Cached", createdAt: .distantPast)
    let api = StartupAPI()
    lazy var cache = StartupCache(snapshot: InboxSnapshot(items: [item]))
    var observerStarts = 0
    var permissionReads = 0
    var badgeWrites: [Int] = []
    var credentialStore: any DeviceCredentialStore = EmptyCredentialStore()
    var permissionGate: StartupPermissionGate?
    var currentSource: (any CurrentStateSource)?
    var inboxSource: any InboxDataSource = StartupUnavailableInbox()
    var tokenContexts: [LiveActivityTokenContext?] = []

    var dependencies: AppDependencies {
        let actions = InMemoryProtectedActionStore()
        return AppDependencies(
            credentialStore: credentialStore,
            accountSessionStore: StartupSessionStore(),
            installationIDStore: StartupIdentityStore(),
            stableDeviceIDStore: StartupIdentityStore(),
            pushTokenStore: EmptyPushStore(),
            liveActivityPushToStartTokenStore: EmptyPushStore(),
            registrationAttemptStore: StartupAttemptStore(),
            cache: cache,
            apiClient: api,
            liveActivityCoordinator: LiveActivityCommandCoordinator(store: actions),
            pendingResponseStore: actions,
            notificationReceiptStore: EmptyReceiptStore(),
            accountNotificationCleaner: EmptyNotificationCleaner(),
            serverURL: URL(string: "https://relo.invalid")!,
            system: AppSystemServices(
                notificationPermission: { [self] in
                    permissionReads += 1
                    if let permissionGate { await permissionGate.wait() }
                    return .denied
                },
                startActivityObservation: { [self] _ in observerStarts += 1 },
                setBadgeCount: { [self] count in badgeWrites.append(count) },
                pushRegistrationError: { nil },
                configureActivityTokens: { [self] in tokenContexts.append($0) }
            ),
            makeInboxDataSource: { [inboxSource] _, _ in inboxSource },
            makeCurrentDataSource: { [currentSource] origin, token in
                currentSource ?? HTTPCurrentStateSource(baseURL: origin, token: token)
            }
        )
    }
}

private struct EmptyCredentialStore: DeviceCredentialStore {
    func load() -> DeviceCredential? { nil }
    func save(_ credential: DeviceCredential) { XCTFail("Unexpected credential write") }
    func delete() { XCTFail("Unexpected credential deletion") }
}

private struct StartupSessionStore: AccountSessionStore {
    func load() -> AccountSession? {
        AccountSession(accessToken: "test-only", sessionId: "session-test",
                       expiresAt: .distantFuture,
                       user: AccountUser(id: "test-user", name: "Test", email: "test@example.com"),
                       account: AccountSummary(accountId: "acc_startup123456", name: "Test", email: "test@example.com"))
    }
    func save(_ session: AccountSession) { XCTFail("Offline validation must not write a session") }
    func delete() { XCTFail("Unavailable server must not delete a session") }
}

private struct StartupIdentityStore: InstallationIDStore, StableDeviceIDStore {
    func loadOrCreate() -> UUID { UUID(uuidString: "11111111-1111-1111-1111-111111111111")! }
}

private struct EmptyPushStore: PushTokenStore {
    func load() -> String? { nil }
    func save(_ token: String) { XCTFail("Unexpected token write") }
    func delete() { XCTFail("Unexpected token deletion") }
}

private struct StartupAttemptStore: RegistrationAttemptStore {
    func attempt(for request: DeviceRegistrationRequest, minimumRevision: Int) -> RegistrationAttempt {
        XCTFail("Unexpected registration attempt")
        return RegistrationAttempt(revision: minimumRevision, request: request)
    }
    func advanceCurrentAttempt() {}
    func delete() {}
}

private struct EmptyReceiptStore: ScopedNotificationReceiptStoring {
    func pending(limit: Int) -> [String] { [] }
    func remove(notificationIDs: Set<String>) {}
}

private struct EmptyNotificationCleaner: AccountNotificationClearing {
    func clearAllDeliveredAndPendingNotifications() async throws { XCTFail("Unexpected system cleanup") }
}

private actor StartupCache: AccountScopedInboxCaching {
    let snapshot: InboxSnapshot
    private(set) var loads = 0
    init(snapshot: InboxSnapshot) { self.snapshot = snapshot }
    func select(accountId: String) {}
    func boundCache(for accountId: String) -> any InboxCache { InMemoryInboxCache(snapshot: snapshot) }
    private var blocked = false
    private var gate: CheckedContinuation<Void, Never>?
    private var loadWaiters: [CheckedContinuation<Void, Never>] = []
    func waitUntilRead() async {
        if loads > 0 { return }
        await withCheckedContinuation { loadWaiters.append($0) }
    }
    func blockReads() { blocked = true }
    func releaseReads() { blocked = false; gate?.resume(); gate = nil }
    func load() async -> InboxSnapshot {
        loads += 1
        let ready = loadWaiters; loadWaiters = []; ready.forEach { $0.resume() }
        if blocked { await withCheckedContinuation { gate = $0 } }
        return snapshot
    }
    func save(_ snapshot: InboxSnapshot) { XCTFail("Unexpected cache write") }
    func clearSelectedAccount() { XCTFail("Unexpected cache deletion") }
}

private actor StartupAPI: MobileAPIClient {
    private(set) var requests = 0
    private(set) var tokenRegistrations: [(DeviceCredential, String, LiveActivityTokenRegistration)] = []
    func validateAccountSession(token: String) async throws -> AccountSession {
        requests += 1
        throw MobileAPIError.unavailable
    }
    func registerDevice(sessionToken: String, request: DeviceRegistrationRequest, idempotencyKey: String) async throws -> DeviceRegistrationResponse { throw MobileAPIError.unavailable }
    func deviceSelf(credential: DeviceCredential) async throws -> DeviceSelfResponse { throw MobileAPIError.unavailable }
    func heartbeat(credential: DeviceCredential, heartbeat: DeviceHeartbeat) async throws { throw MobileAPIError.unavailable }
    func registerLiveActivityToken(credential: DeviceCredential, activityId: String, registration: LiveActivityTokenRegistration) async throws {
        tokenRegistrations.append((credential, activityId, registration))
        throw MobileAPIError.unavailable
    }
    func submitInteraction(credential: DeviceCredential, notificationId: String, action: NotificationInteractionAction, value: [String: String], idempotencyKey: String) async throws { throw MobileAPIError.unavailable }
    func revokeDevice(credential: DeviceCredential) async throws { throw MobileAPIError.unavailable }
    func signOutAccount(sessionToken: String) async throws { throw MobileAPIError.unavailable }
    func deleteAccount(sessionToken: String, password: String, confirmation: String) async throws { throw MobileAPIError.unavailable }
}


extension AppStartupTests {
    func testCurrentPaintAndHintsBypassSuspendedPermissionAndHistory() async throws {
        let fixture = StartupFixture(), permission = StartupPermissionGate(), source = StartupCurrentSource()
        fixture.permissionGate = permission
        fixture.currentSource = source
        fixture.credentialStore = StartupBoundCredentialStore()
        await fixture.cache.blockReads()
        let model = AppModel(dependencies: fixture.dependencies)
        let firstPaint = expectation(description: "Current state painted while permission is suspended")
        let first = model.currentStateChanges.compactMap { $0 }.first { $0.connection == .current }
            .sink { _ in firstPaint.fulfill() }
        let startup = Task { await model.start() }
        await fulfillment(of: [firstPaint], timeout: 3)
        XCTAssertEqual(model.currentState?.snapshot.subjects.values.first?.projection.title, "Immediate 1")
        let beforePermission = await fixture.cache.loads
        XCTAssertEqual(beforePermission, 0)
        let tokenContext = try XCTUnwrap(fixture.tokenContexts.compactMap { $0 }.last)
        let currentScope = try XCTUnwrap(model.currentState?.scope)
        XCTAssertNil(tokenContext.heartbeat) // No ordinary APNs token or permission result is required.
        XCTAssertTrue(model.items.isEmpty)
        let binding = tokenContext.binding(scope: currentScope)
        let attempt = await binding.registerActivity(.init(activityID: "act_startup123456", generation: 2,
            nativeActivityID: "native-startup", token: "fixture-token", accountID: currentScope.storage.accountID))
        XCTAssertEqual(attempt, .retryable) // The injected server is offline, but it receives the immediate attempt.
        let registered = await fixture.api.tokenRegistrations
        XCTAssertEqual(registered.count, 1)
        XCTAssertEqual(registered.first?.0, tokenContext.credential)
        XCTAssertEqual(registered.first?.1, "act_startup123456")
        XCTAssertEqual(registered.first?.2.generation, 2)
        await model.start() // Concurrent startup must not create another owner.
        let requests = await source.requests
        XCTAssertEqual(requests, 1)
        await permission.release()
        // Registration/history startup is now allowed to enter the suspended cache read.
        await fixture.cache.waitUntilRead()
        let historyReads = await fixture.cache.loads
        XCTAssertEqual(historyReads, 1)
        let secondPaint = expectation(description: "A hint paints while history remains suspended")
        let second = model.currentStateChanges.compactMap { $0 }.first {
            $0.snapshot.subjects.values.first?.projection.title == "Immediate 2"
        }.sink { _ in secondPaint.fulfill() }
        model.currentChangeReceived()
        await fulfillment(of: [secondPaint], timeout: 3)
        XCTAssertEqual(model.currentState?.snapshot.subjects.values.first?.projection.title, "Immediate 2")
        model.backgrounded()
        XCTAssertEqual(model.currentState?.connection, .inactive)
        await fixture.cache.releaseReads()
        await startup.value
        first.cancel(); second.cancel()
    }
}

private actor StartupPermissionGate {
    private var released = false
    private var continuation: CheckedContinuation<Void, Never>?
    func wait() async {
        if released { return }
        await withCheckedContinuation { continuation = $0 }
    }
    func release() { released = true; continuation?.resume(); continuation = nil }
}

private struct StartupBoundCredentialStore: DeviceCredentialStore {
    func load() -> DeviceCredential? {
        .init(deviceId: "dev_startup123456", installationId: UUID(uuidString: "11111111-1111-1111-1111-111111111111")!,
              accessToken: "fixture-only", issuedAt: .distantPast, accountId: "acc_startup123456", credentialVersion: 1)
    }
    func save(_ credential: DeviceCredential) {}
    func delete() {}
}

private actor StartupCurrentSource: CurrentStateSource {
    private(set) var requests = 0
    nonisolated let stream: AsyncThrowingStream<CurrentChangeHint, Error>
    nonisolated let continuation: AsyncThrowingStream<CurrentChangeHint, Error>.Continuation
    nonisolated let onStream: @Sendable () -> Void
    private let gate: StartupRegistrationGate?
    init(gate: StartupRegistrationGate? = nil, onStream: @escaping @Sendable () -> Void = {}) {
        (stream, continuation) = AsyncThrowingStream.makeStream()
        self.gate = gate; self.onStream = onStream
    }
    func fetchCurrent(ids: [String]?) async throws -> CurrentInboxResponse {
        requests += 1
        if let gate { await gate.wait() }
        let time = Date(), id = "sub_11111111-1111-1111-1111-111111111111"
        let item = CurrentSubjectProjection(subjectId: id, notificationId: nil, kind: .notice,
            version: .init(generation: 1, revision: requests), title: "Immediate \(requests)", summary: "Current source", source: "Fixture",
            createdAt: time, updatedAt: time, occurredAt: time, acceptedAt: time, readAt: nil,
            currentUntil: time.addingTimeInterval(900), freshUntil: nil, deliverUntil: time.addingTimeInterval(60), freshness: .unknown,
            interaction: nil, activity: nil, resources: nil)
        return .init(items: [item], retired: [], total: 1, cursor: nil, hasMore: false,
                     counts: .init(actionable: 0, currentUnread: 1), nextExpiryAt: item.currentUntil, serverTime: time)
    }
    func fetchCurrentPage(after cursor: String?) async throws -> CurrentInboxResponse { try await fetchCurrent(ids: nil) }
    func fetchPending(after cursor: String?, limit: Int) async throws -> PendingCurrentPage { throw InboxRemoteError.unavailable }
    nonisolated func changes() -> AsyncThrowingStream<CurrentChangeHint, Error> { onStream(); return stream }
}

private struct StartupUnavailableInbox: InboxFixtureSource {
    func fetchPage(after cursor: String?) async throws -> InboxPage { throw InboxRemoteError.unavailable }
    func fetchHistoryPage(before cursor: String?) async throws -> InboxHistoryPage { throw InboxRemoteError.unavailable }
    func fetchDetail(notificationID: String) async throws -> InboxNotificationDetail { throw InboxRemoteError.unavailable }
    func markRead(notificationID: String) async throws -> InboxReadMutationResponse { throw InboxRemoteError.unavailable }
    func markAllRead(watermark: String) async throws -> InboxReadMutationResponse { throw InboxRemoteError.unavailable }
    func fetchActiveLiveActivities() async throws -> ActiveLiveActivityIdentityPage { throw InboxRemoteError.unavailable }
}

extension AppStartupTests {
    func testDelayedHistoryCannotOverwriteNewerCurrentAttentionAndHintsSkipHistory() async throws {
        let fixture = StartupFixture(), gate = StartupRegistrationGate(), source = StartupCurrentSource()
        let inbox = DelayedHistoryInbox(gate: gate)
        fixture.credentialStore = StartupBoundCredentialStore()
        fixture.currentSource = source; fixture.inboxSource = inbox
        let model = AppModel(dependencies: fixture.dependencies)
        let painted = expectation(description: "Current paints while history is suspended")
        let paint = model.currentStateChanges.compactMap { $0 }.first { $0.connection == .current }
            .sink { _ in painted.fulfill() }
        let startup = Task { await model.start() }
        await gate.started()
        await fulfillment(of: [painted], timeout: 2)
        paint.cancel()
        let revision = try XCTUnwrap(model.currentState?.snapshot.subjects.values.first?.projection.version.revision)
        let updated = expectation(description: "Current hint renders without waiting for history")
        let observe = model.currentStateChanges.compactMap { $0 }.first {
            $0.connection == .current && ($0.snapshot.subjects.values.first?.projection.version.revision ?? 0) > revision
        }.sink { _ in updated.fulfill() }
        source.continuation.yield(.init(subjectIds: [], invalidateCounts: true))
        await fulfillment(of: [updated], timeout: 2)
        observe.cancel()
        let currentRevision = model.currentState?.snapshot.subjects.values.first?.projection.version
        await gate.release(); await startup.value
        XCTAssertEqual(model.unreadCount, 777)
        XCTAssertEqual(model.currentState?.snapshot.subjects.values.first?.projection.version, currentRevision)
        XCTAssertEqual(model.currentPresentation.actionableCount, 0)
        XCTAssertTrue(model.currentPresentation.needsMe.isEmpty)
        XCTAssertEqual(fixture.badgeWrites.last, 0)
        let requests = await inbox.requests
        XCTAssertEqual(requests, 1)
        model.backgrounded()
    }

    func testBackgroundCurrentReadSkipsPermissionHistoryHealthAndStream() async throws {
        let fixture = StartupFixture()
        fixture.credentialStore = StartupBoundCredentialStore()
        fixture.currentSource = StartupCurrentSource(onStream: { XCTFail("Background wakeup opened a stream") })
        let model = AppModel(dependencies: fixture.dependencies)
        let refreshed = await model.backgroundCurrentRefresh()
        XCTAssertTrue(refreshed)
        XCTAssertEqual(model.currentState?.snapshot.subjects.count, 1)
        XCTAssertEqual(model.currentState?.connection, .inactive)
        XCTAssertEqual(fixture.permissionReads, 0)
        XCTAssertEqual(fixture.observerStarts, 0)
        let historyReads = await fixture.cache.loads, healthReads = await fixture.api.requests
        XCTAssertEqual(historyReads, 0); XCTAssertEqual(healthReads, 0)
    }

    func testBackgroundDeadlineCompletesAndDeactivatesNoncooperativeRead() async throws {
        let fixture = StartupFixture(), network = StartupRegistrationGate(), deadline = StartupRegistrationGate()
        fixture.credentialStore = StartupBoundCredentialStore()
        fixture.currentSource = StartupCurrentSource(gate: network, onStream: { XCTFail("Unexpected background stream") })
        let model = AppModel(dependencies: fixture.dependencies)
        let request = Task { await model.backgroundCurrentRefresh(waitForDeadline: { await deadline.wait() }) }
        await network.started(); await deadline.started()
        let cancelled = expectation(description: "Background owner deactivated")
        let observation = model.currentStateChanges.compactMap { $0 }.first { $0.connection == .inactive }
            .sink { _ in cancelled.fulfill() }
        await deadline.release()
        let refreshed = await request.value
        XCTAssertFalse(refreshed)
        await fulfillment(of: [cancelled], timeout: 2)
        XCTAssertTrue(model.currentState?.snapshot.subjects.isEmpty == true)
        await network.release()
        observation.cancel()
    }

    func testForegroundRepairLoadsHistoryOnlyAfterHistoryIsViewed() async throws {
        let fixture = StartupFixture(), inbox = StartupCountingInbox()
        fixture.credentialStore = StartupBoundCredentialStore()
        fixture.currentSource = OfflineCurrentSourceFixture()
        fixture.inboxSource = inbox
        let model = AppModel(dependencies: fixture.dependencies)
        await model.start(); _ = await model.refresh()
        let before = await inbox.historyRequests
        XCTAssertEqual(before, 2)
        await model.historyViewed()
        let after = await inbox.historyRequests
        XCTAssertEqual(after, before)
        XCTAssertEqual(model.historyLoadState, .current)
        model.backgrounded()
    }

    func testLateStartupCacheReadCannotPublishIntoReplacementScope() async throws {
        let fixture = StartupFixture()
        fixture.credentialStore = StartupBoundCredentialStore()
        fixture.currentSource = OfflineCurrentSourceFixture()
        await fixture.cache.blockReads()
        let model = AppModel(dependencies: fixture.dependencies)
        let startup = Task { await model.start() }
        await fixture.cache.waitUntilRead()
        let replacement = DeviceCredential(deviceId: "dev_replacement123", installationId: UUID(),
            accessToken: "replacement-only", issuedAt: .now, accountId: "acc_replacement123", credentialVersion: 9)
        model.credential = replacement
        model.items = []
        model.accountState = .signedIn
        await fixture.cache.releaseReads(); await startup.value
        XCTAssertEqual(model.credential, replacement)
        XCTAssertTrue(model.items.isEmpty)
        let validations = await fixture.api.requests
        XCTAssertEqual(validations, 0)
    }

    func testLateRegistrationSuccessOrFailureCannotChangeReplacementSession() async throws {
        for fails in [false, true] {
            let fixture = StartupFixture(), gate = StartupRegistrationGate(), base = fixture.dependencies
            let api = SuccessfulRegistrationAPI(beforeRegistration: {
                await gate.wait()
                if fails { throw MobileAPIError.reauthenticationRequired }
            })
            let model = AppModel(accountState: .signedIn, credential: StartupBoundCredentialStore().load(),
                permission: .allowed, items: [fixture.item], apnsTokenAvailable: true,
                accountSession: StartupSessionStore().load(), credentialStore: StartupBoundCredentialStore(),
                accountSessionStore: RegistrationSessionStore(), installationIDStore: base.installationIDStore,
                stableDeviceIDStore: base.stableDeviceIDStore, pushTokenStore: RegistrationPushStore(),
                liveActivityPushToStartTokenStore: base.liveActivityPushToStartTokenStore,
                registrationAttemptStore: RegistrationAttemptFixture(), cache: RegistrationDeniedCache(),
                apiClient: api, liveActivityCoordinator: base.liveActivityCoordinator,
                pendingResponseStore: base.pendingResponseStore, notificationReceiptStore: base.notificationReceiptStore,
                accountNotificationCleaner: base.accountNotificationCleaner, serverURL: base.serverURL,
                system: base.system, makeInboxDataSource: { _, _ in StartupUnavailableInbox() },
                makeCurrentDataSource: { _, _ in OfflineCurrentSourceFixture() })
            let registration = Task { await model.registerDevice(force: true) }
            await gate.started()
            let replacement = DeviceCredential(deviceId: "dev_replacement123", installationId: UUID(),
                accessToken: "replacement-only", issuedAt: .now, accountId: "acc_replacement123", credentialVersion: 9)
            model.credential = replacement
            model.registrationState = .registered
            await gate.release(); await registration.value
            XCTAssertEqual(model.credential, replacement)
            XCTAssertEqual(model.accountState, .signedIn)
            XCTAssertEqual(model.registrationState, .registered)
        }
    }

    func testRegistrationCacheDenialPreservesBytesAndSameAccountPresentation() async throws {
        let fixture = StartupFixture(), failedCache = RegistrationDeniedCache()
        let base = fixture.dependencies
        let model = AppModel(accountState: .signedIn, credential: StartupBoundCredentialStore().load(),
            permission: .allowed, items: [fixture.item], apnsTokenAvailable: true,
            accountSession: StartupSessionStore().load(), credentialStore: StartupBoundCredentialStore(),
            accountSessionStore: RegistrationSessionStore(), installationIDStore: base.installationIDStore,
            stableDeviceIDStore: base.stableDeviceIDStore, pushTokenStore: RegistrationPushStore(),
            liveActivityPushToStartTokenStore: base.liveActivityPushToStartTokenStore,
            registrationAttemptStore: RegistrationAttemptFixture(), cache: failedCache,
            apiClient: SuccessfulRegistrationAPI(), liveActivityCoordinator: base.liveActivityCoordinator,
            pendingResponseStore: base.pendingResponseStore, notificationReceiptStore: base.notificationReceiptStore,
            accountNotificationCleaner: base.accountNotificationCleaner, serverURL: base.serverURL,
            system: base.system, makeInboxDataSource: { _, _ in StartupUnavailableInbox() })
        await model.registerDevice(force: true)
        let deletes = await failedCache.deletes
        XCTAssertEqual(deletes, 0)
        XCTAssertEqual(model.items, [fixture.item])
        XCTAssertEqual(model.credential?.credentialVersion, 2)
    }
}

private actor DelayedHistoryInbox: InboxFixtureSource {
    let gate: StartupRegistrationGate
    private(set) var requests = 0
    init(gate: StartupRegistrationGate) { self.gate = gate }
    func fetchPage(after cursor: String?) async -> InboxPage {
        requests += 1
        await gate.wait()
        let old = InboxItem(id: "historical-request", kind: .notification, sourceName: "History", title: "Old decision",
            createdAt: .distantPast, interaction: .init(id: "historical-interaction", kind: .approval, prompt: "Obsolete?",
                state: .pending, expiresAt: .distantFuture))
        return .init(items: [old], cursor: nil, hasMore: false, serverTime: .now,
            unread: .init(account: 777, projects: [:]))
    }
    func fetchHistoryPage(before cursor: String?) throws -> InboxHistoryPage { throw InboxRemoteError.unavailable }
    func fetchDetail(notificationID: String) throws -> InboxNotificationDetail { throw InboxRemoteError.unavailable }
    func markRead(notificationID: String) throws -> InboxReadMutationResponse { throw InboxRemoteError.unavailable }
    func markAllRead(watermark: String) throws -> InboxReadMutationResponse { throw InboxRemoteError.unavailable }
    func fetchActiveLiveActivities() throws -> ActiveLiveActivityIdentityPage { throw InboxRemoteError.unavailable }
}

private actor RegistrationDeniedCache: AccountScopedInboxCaching {
    private(set) var deletes = 0
    func select(accountId: String) {}
    func boundCache(for accountId: String) -> any InboxCache { InMemoryInboxCache() }
    func clearSelectedAccount() { deletes += 1 }
    func load() throws -> InboxSnapshot { throw InboxStorageError.unavailable }
    func save(_ snapshot: InboxSnapshot) {}
}
private struct RegistrationSessionStore: AccountSessionStore {
    func load() -> AccountSession? { StartupSessionStore().load() }
    func save(_ session: AccountSession) {}
    func delete() {}
}
private struct RegistrationPushStore: PushTokenStore {
    func load() -> String? { "fixture-apns" }
    func save(_ token: String) {}
    func delete() {}
}
private struct RegistrationAttemptFixture: RegistrationAttemptStore {
    func attempt(for request: DeviceRegistrationRequest, minimumRevision: Int) -> RegistrationAttempt {
        RegistrationAttempt(revision: minimumRevision, request: request)
    }
    func advanceCurrentAttempt() {}
    func delete() {}
}
private struct SuccessfulRegistrationAPI: MobileAPIClient {
    var beforeRegistration: @Sendable () async throws -> Void = {}
    func registerDevice(sessionToken: String, request: DeviceRegistrationRequest, idempotencyKey: String) async throws -> DeviceRegistrationResponse {
        try await beforeRegistration()
        return .init(account: .init(accountId: "acc_startup123456", name: "Test", email: "test@example.com"),
              device: .init(deviceId: "dev_startup123456", installationId: request.installationId, registrationState: "active", credentialVersion: 2),
              credential: .init(accessToken: "fixture-refreshed", issuedAt: Date()))
    }
    func validateAccountSession(token: String) async throws -> AccountSession { throw MobileAPIError.unavailable }
    func deviceSelf(credential: DeviceCredential) async throws -> DeviceSelfResponse { throw MobileAPIError.unavailable }
    func heartbeat(credential: DeviceCredential, heartbeat: DeviceHeartbeat) async throws { throw MobileAPIError.unavailable }
    func registerLiveActivityToken(credential: DeviceCredential, activityId: String, registration: LiveActivityTokenRegistration) async throws { throw MobileAPIError.unavailable }
    func submitInteraction(credential: DeviceCredential, notificationId: String, action: NotificationInteractionAction, value: [String: String], idempotencyKey: String) async throws { throw MobileAPIError.unavailable }
    func revokeDevice(credential: DeviceCredential) async throws { throw MobileAPIError.unavailable }
    func signOutAccount(sessionToken: String) async throws { throw MobileAPIError.unavailable }
    func deleteAccount(sessionToken: String, password: String, confirmation: String) async throws { throw MobileAPIError.unavailable }
}

private actor StartupRegistrationGate {
    private var entered = false
    private var ready: CheckedContinuation<Void, Never>?
    private var completion: CheckedContinuation<Void, Never>?
    func wait() async {
        entered = true
        await withCheckedContinuation { completion = $0; ready?.resume(); ready = nil }
    }
    func started() async {
        if entered { return }
        await withCheckedContinuation { ready = $0 }
    }
    func release() { completion?.resume(); completion = nil }
}

private actor StartupCountingInbox: InboxFixtureSource {
    private(set) var historyRequests = 0
    func fetchPage(after cursor: String?) -> InboxPage {
        historyRequests += 1
        return .init(items: [], cursor: nil, hasMore: false, serverTime: .now)
    }
    func fetchHistoryPage(before cursor: String?) -> InboxHistoryPage {
        historyRequests += 1
        return .init(items: [], cursor: nil, hasMore: false, total: 0, serverTime: .now)
    }
    func fetchDetail(notificationID: String) throws -> InboxNotificationDetail { throw InboxRemoteError.unavailable }
    func markRead(notificationID: String) throws -> InboxReadMutationResponse { throw InboxRemoteError.unavailable }
    func markAllRead(watermark: String) throws -> InboxReadMutationResponse { throw InboxRemoteError.unavailable }
    func fetchActiveLiveActivities() throws -> ActiveLiveActivityIdentityPage { throw InboxRemoteError.unavailable }
}


extension AppStartupTests {
    func testReceiptCleanupFailurePreservesSignOutJournalAndIdentityUntilRetry() async throws {
        let base = StartupFixture().dependencies
        let sessionStore = ReceiptCleanupSessionStore(session: try XCTUnwrap(StartupSessionStore().load()))
        let journal = ReceiptCleanupJournal()
        let receipts = ReceiptCleanupFailureStore()
        let api = ReceiptCleanupAPI()
        let model = AppModel(
            accountState: .signedIn, credential: StartupBoundCredentialStore().load(), accountSession: sessionStore.load(),
            credentialStore: ReceiptCleanupCredentialStore(), accountSessionStore: sessionStore,
            installationIDStore: base.installationIDStore, stableDeviceIDStore: base.stableDeviceIDStore,
            pushTokenStore: base.pushTokenStore, liveActivityPushToStartTokenStore: base.liveActivityPushToStartTokenStore,
            registrationAttemptStore: base.registrationAttemptStore, signOutProgressStore: journal,
            cache: base.cache, apiClient: api, liveActivityCoordinator: base.liveActivityCoordinator,
            pendingResponseStore: base.pendingResponseStore, notificationReceiptStore: receipts,
            accountNotificationCleaner: base.accountNotificationCleaner, serverURL: base.serverURL, system: base.system
        )
        let first = await model.signOut()
        XCTAssertFalse(first)
        XCTAssertNotNil(model.signOutError)
        XCTAssertNotNil(sessionStore.load())
        XCTAssertEqual(journal.load()?.sessionRevoked, true)
        XCTAssertEqual(receipts.pending(limit: 200), ["ntf_cleanup"])
        receipts.allowRemoval()
        let second = await model.signOut()
        XCTAssertTrue(second)
        XCTAssertNil(sessionStore.load())
        XCTAssertNil(journal.load())
        XCTAssertTrue(receipts.pending(limit: 200).isEmpty)
        let revocations = await api.revocations
        XCTAssertEqual(revocations, 1, "Retry resumes cleanup without repeating confirmed revocation")
    }
}

private struct ReceiptCleanupCredentialStore: DeviceCredentialStore {
    func load() -> DeviceCredential? { nil }
    func save(_ credential: DeviceCredential) {}
    func delete() {}
}
private final class ReceiptCleanupSessionStore: AccountSessionStore, @unchecked Sendable {
    private let lock = NSLock()
    private var session: AccountSession?
    init(session: AccountSession) { self.session = session }
    func load() -> AccountSession? { lock.withLock { session } }
    func save(_ session: AccountSession) { lock.withLock { self.session = session } }
    func delete() { lock.withLock { session = nil } }
}
private final class ReceiptCleanupJournal: SignOutProgressStore, @unchecked Sendable {
    private let lock = NSLock()
    private var value: SignOutProgress?
    func load() -> SignOutProgress? { lock.withLock { value } }
    func save(_ progress: SignOutProgress) { lock.withLock { value = progress } }
    func delete() { lock.withLock { value = nil } }
}
private final class ReceiptCleanupFailureStore: ScopedNotificationReceiptStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var fails = true
    private var ids = ["ntf_cleanup"]
    func allowRemoval() { lock.withLock { fails = false } }
    func pending(limit: Int) -> [String] { lock.withLock { Array(ids.prefix(limit)) } }
    func remove(notificationIDs: Set<String>) throws {
        try lock.withLock {
            if fails { throw CocoaError(.fileWriteNoPermission) }
            ids.removeAll { notificationIDs.contains($0) }
        }
    }
}
private actor ReceiptCleanupAPI: MobileAPIClient {
    private(set) var revocations = 0
    func signOutAccount(sessionToken: String) async throws { revocations += 1 }
    func revokeDevice(credential: DeviceCredential) async throws {}
    func validateAccountSession(token: String) async throws -> AccountSession { throw MobileAPIError.unavailable }
    func registerDevice(sessionToken: String, request: DeviceRegistrationRequest, idempotencyKey: String) async throws -> DeviceRegistrationResponse { throw MobileAPIError.unavailable }
    func deviceSelf(credential: DeviceCredential) async throws -> DeviceSelfResponse { throw MobileAPIError.unavailable }
    func heartbeat(credential: DeviceCredential, heartbeat: DeviceHeartbeat) async throws { throw MobileAPIError.unavailable }
    func registerLiveActivityToken(credential: DeviceCredential, activityId: String, registration: LiveActivityTokenRegistration) async throws { throw MobileAPIError.unavailable }
    func submitInteraction(credential: DeviceCredential, notificationId: String, action: NotificationInteractionAction, value: [String: String], idempotencyKey: String) async throws { throw MobileAPIError.unavailable }
    func deleteAccount(sessionToken: String, password: String, confirmation: String) async throws { throw MobileAPIError.unavailable }
}

private extension ReceiptCleanupFailureStore {
    func retire(scope: ReceiptScope) async throws { try remove(notificationIDs: Set(pending(limit: 200))) }
}

/// Hosted AppModel integration; the opt-in run attaches monotonic spans. Presentation
/// means the observable state and UI projection are ready, not a CoreAnimation frame.
@MainActor
final class InboxIntegrationTests: XCTestCase {
    func testCurrentPaintWithFullRecoveryQueuesAndBoundedBurst() async throws {
        let commit = ProcessInfo.processInfo.environment["RELO_BENCHMARK_SOURCE_COMMIT"] ?? ""
        let measured = !commit.isEmpty
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let origin = URL(string: "https://relo.invalid")!
        let credential = StartupBoundCredentialStore().load()!
        let scope = try StorageScope(serverOrigin: origin, accountID: credential.accountId, deviceID: credential.deviceId)
        let reads = FilePendingReadStore(baseDirectory: directory, scope: scope)
        try await reads.enqueue((0..<1000).map { IntegratedCurrentSource.id("ntf_", $0 + 1000) })
        let receipts = NotificationReceiptFile(baseDirectory: directory)
        let receiptScope = try ReceiptScope(serverOrigin: origin, accountId: credential.accountId, deviceId: credential.deviceId)
        for index in 0..<200 {
            try receipts.append(record: .init(scope: receiptScope, notificationID: IntegratedCurrentSource.id("ntf_", index + 1000)))
        }
        let source = IntegratedCurrentSource()
        let cache = FileCurrentStateCache(baseDirectory: directory, scope: scope)
        var initial = CurrentCacheSnapshot()
        for page in 0..<5 { try initial.apply(await source.page(offset: page * 50)) }
        for offset in [0, 50, 100] { try initial.applyPending(await source.pending(offset: offset), limit: 50) }
        initial.prepareForSave(wallTime: Date())
        try await cache.save(initial)
        var spans: [[String: String]] = []
        var coldBytes = 0
        for cold in 0..<(measured ? 20 : 1) {
            await source.setOnline(false)
            let fixture = StartupFixture(), permission = StartupPermissionGate()
            fixture.credentialStore = StartupBoundCredentialStore()
            fixture.currentSource = source; fixture.permissionGate = permission
            let base = fixture.dependencies
            let model = AppModel(dependencies: AppDependencies(
                credentialStore: base.credentialStore, accountSessionStore: base.accountSessionStore,
                installationIDStore: base.installationIDStore, stableDeviceIDStore: base.stableDeviceIDStore,
                pushTokenStore: base.pushTokenStore, liveActivityPushToStartTokenStore: base.liveActivityPushToStartTokenStore,
                registrationAttemptStore: base.registrationAttemptStore, cache: base.cache, apiClient: base.apiClient,
                liveActivityCoordinator: base.liveActivityCoordinator, pendingResponseStore: base.pendingResponseStore,
                notificationReceiptStore: FileScopedNotificationReceiptStore(baseDirectory: directory),
                accountNotificationCleaner: base.accountNotificationCleaner, serverURL: base.serverURL,
                system: base.system, makeInboxDataSource: base.makeInboxDataSource,
                makeCurrentDataSource: base.makeCurrentDataSource, makeCurrentCache: { _ in cache },
                makePendingReadStore: { _ in reads }))
            let painted = expectation(description: "Cold current cache painted before history")
            var end: UInt64 = 0
            let subscription = model.currentStateChanges.compactMap { $0 }.first {
                $0.persistence == .available && $0.snapshot.subjects.count == 250
            }.sink { state in
                let presentation = CurrentInboxPresentation(state: state, now: state.snapshot.evaluatedAt ?? Date())
                XCTAssertEqual(presentation.needsMe.count, 101)
                end = DispatchTime.now().uptimeNanoseconds; painted.fulfill()
            }
            let start = DispatchTime.now().uptimeNanoseconds
            let startup = Task { await model.start() }
            await fulfillment(of: [painted], timeout: 5)
            subscription.cancel()
            spans.append(span(commit, "cold_cached_current_full_queues", start, end))
            let historyLoads = await fixture.cache.loads
            XCTAssertEqual(historyLoads, 0)
            let queuedReads = try await reads.pending(limit: 1000)
            XCTAssertEqual(queuedReads.count, 1000)
            XCTAssertEqual(try receipts.pending(scope: receiptScope, limit: 200).records.count, 200)
            coldBytes = try JSONEncoder().encode(model.currentState!.snapshot).count
            XCTAssertLessThan(coldBytes, 1_000_000)
            if cold == 0 {
                await source.setOnline(true)
                let connected = expectation(description: "Transport recovered")
                let connection = model.currentStateChanges.compactMap { $0 }.first { $0.connection == .current }
                    .sink { _ in connected.fulfill() }
                model.currentChangeReceived()
                await fulfillment(of: [connected], timeout: 5); connection.cancel()
                await model.refreshCurrent()
                let requestsBeforeHints = await source.requestCount
                for index in 0..<(measured ? 100 : 2) {
                    let revision = await source.advance()
                    let ready = expectation(description: "Hint publishes the new current revision")
                    let reconciled = expectation(description: "Cached identities finish bounded reconciliation")
                    var finished: UInt64 = 0
                    let changed = model.currentStateChanges.compactMap { $0 }.first {
                        $0.connection == .current && $0.snapshot.subjects[IntegratedCurrentSource.id("sub_", 1)]?.projection.version.revision == revision
                    }.sink { state in
                        XCTAssertEqual(CurrentInboxPresentation(state: state, now: Date()).actionableCount, 101)
                        finished = DispatchTime.now().uptimeNanoseconds; ready.fulfill()
                    }
                    let repaired = model.currentStateChanges.compactMap { $0 }.first {
                        $0.snapshot.subjects.count == 250 && $0.snapshot.subjects.values.allSatisfy { $0.projection.version.revision == revision }
                    }.sink { _ in reconciled.fulfill() }
                    let started = DispatchTime.now().uptimeNanoseconds
                    for _ in 0..<(index.isMultiple(of: 2) ? 1 : 30) { model.currentChangeReceived() }
                    await fulfillment(of: [ready, reconciled], timeout: 5)
                    changed.cancel(); repaired.cancel()
                    spans.append(span(commit, index.isMultiple(of: 2) ? "warm_hint_250_summaries" : "burst_30_hints_250_summaries", started, finished))
                }
                // Finish the independent inventory scan; every valid action has fresh authority.
                let pending = expectation(description: "First pending page refreshed")
                let freshPending = model.currentStateChanges.compactMap { $0 }.first { $0.pendingConnection == .current }
                    .sink { _ in pending.fulfill() }
                await fulfillment(of: [pending], timeout: 5); freshPending.cancel()
                await model.loadMorePending(); await model.loadMorePending()
                let state = try XCTUnwrap(model.currentState)
                XCTAssertEqual(state.snapshot.pending?.entries.count, 101)
                for entry in state.snapshot.pending!.entries.values {
                    let identity = CurrentDecisionIdentity(pending: entry.item, scope: scope)
                    XCTAssertEqual(CurrentInboxPresentation.availability(for: identity, state: state, now: model.currentTime), .available)
                }
                let requests = await source.requestCount
                // An unscoped push hint reconciles 250 known subjects in five reads of
                // at most 50. Thirty duplicate hints must not multiply those reads.
                XCTAssertEqual(requests - requestsBeforeHints, (measured ? 100 : 2) * 5)
                let laterHistoryLoads = await fixture.cache.loads
                XCTAssertEqual(laterHistoryLoads, 0)
            }
            model.backgrounded(); await permission.release(); await startup.value
        }
        if measured {
            let lines = try spans.map { String(decoding: try JSONSerialization.data(withJSONObject: $0, options: [.sortedKeys]), as: UTF8.self) }.joined(separator: "\n")
            let attachment = XCTAttachment(data: Data((lines + "\n").utf8), uniformTypeIdentifier: "public.json")
            attachment.name = "relo-latency-current.ndjson"; attachment.lifetime = .keepAlways; add(attachment)
            var usage = rusage()
            XCTAssertEqual(getrusage(RUSAGE_SELF, &usage), 0)
            let shape = XCTAttachment(string: "{\"sourceCommit\":\"\(commit)\",\"fixture\":\"integrated-v1\",\"currentCacheBytes\":\(coldBytes),\"cachedSummaries\":250,\"validPending\":101,\"readQueue\":1000,\"receipts\":200,\"peakHostProcessRSSBytes\":\(usage.ru_maxrss)}")
            shape.name = "relo-current-shape.json"; shape.lifetime = .keepAlways; add(shape)
        }
    }
    private func span(_ commit: String, _ scenario: String, _ start: UInt64, _ end: UInt64) -> [String: String] {
        ["stage": "foreground_hint_to_render", "scenario": scenario, "sourceCommit": commit,
         "process": "ios-hosted-current", "clock": "monotonic", "outcome": end >= start ? "ok" : "failed",
         "startNs": String(start), "endNs": String(max(start, end))]
    }
}

private actor IntegratedCurrentSource: CurrentStateSource {
    private let time = Date()
    private var online = false
    private var revision = 1
    private(set) var requestCount = 0
    nonisolated let stream: AsyncThrowingStream<CurrentChangeHint, Error>
    nonisolated let hints: AsyncThrowingStream<CurrentChangeHint, Error>.Continuation
    init() { (stream, hints) = AsyncThrowingStream.makeStream() }
    nonisolated static func id(_ prefix: String, _ n: Int) -> String { prefix + "11111111-1111-1111-1111-" + String(format: "%012d", n) }
    func setOnline(_ value: Bool) { online = value }
    func advance() -> Int { revision += 1; return revision }
    func page(offset: Int = 0, ids: [String]? = nil) -> CurrentInboxResponse {
        let indices = ids?.compactMap { Int($0.suffix(12)) } ?? Array((offset+1)...(offset+50))
        let items = indices.map { n in
            CurrentSubjectProjection(subjectId: Self.id("sub_", n), notificationId: Self.id("ntf_", n),
                kind: .notice, version: .init(generation: 1, revision: revision), title: "Current", summary: String(repeating: "s", count: 240), source: "Fixture",
                createdAt: time, updatedAt: Date(), occurredAt: time, acceptedAt: time, readAt: nil,
                currentUntil: time.addingTimeInterval(900), freshUntil: nil, deliverUntil: time.addingTimeInterval(60), freshness: .unknown,
                interaction: nil, activity: nil, resources: nil)
        }
        return .init(items: items, retired: [], total: 351, cursor: ids == nil && offset < 200 ? String(offset+50) : nil,
            hasMore: ids == nil && offset < 200, counts: .init(actionable: 101, currentUnread: 351),
            nextExpiryAt: time.addingTimeInterval(900), serverTime: Date())
    }
    func pending(offset: Int) -> PendingCurrentPage {
        let items = (offset..<min(offset+50, 101)).map { n in
            PendingCurrentDecision(subjectId: Self.id("sub_", n+500), notificationId: Self.id("ntf_", n+500), version: .init(generation: 1, revision: 1),
                kind: .decision, title: "Decision", summary: "Still valid", source: "Fixture", createdAt: time, readAt: nil, urgencyRank: 0,
                interaction: .init(id: Self.id("int_", n+500), type: .approval, state: .pending, expiresAt: time.addingTimeInterval(900)))
        }
        return .init(items: items, total: 101, hasMore: offset+50 < 101, cursor: offset+50 < 101 ? String(offset+50) : nil,
            nextExpiryAt: time.addingTimeInterval(900), serverTime: Date())
    }
    func fetchCurrent(ids: [String]?) async throws -> CurrentInboxResponse {
        requestCount += 1; guard online else { throw InboxRemoteError.unavailable }; return page(ids: ids)
    }
    func fetchCurrentPage(after cursor: String?) async throws -> CurrentInboxResponse {
        guard online else { throw InboxRemoteError.unavailable }; return page(offset: Int(cursor ?? "0") ?? 0)
    }
    func fetchPending(after cursor: String?, limit: Int) async throws -> PendingCurrentPage {
        guard online else { throw InboxRemoteError.unavailable }; return pending(offset: Int(cursor ?? "0") ?? 0)
    }
    nonisolated func changes() -> AsyncThrowingStream<CurrentChangeHint, Error> { stream }
}

/// The Now deck's presentation rules, run on a fast clock.
@MainActor
final class ReloDeckDirectorTests: XCTestCase {
    private func director() -> ReloDeckDirector {
        ReloDeckDirector(timing: .init(offlineHold: .milliseconds(200), returnHold: .milliseconds(100),
                                       coalesce: .milliseconds(40), armAfter: .milliseconds(100),
                                       hapticCooldown: 2, ceremonyScale: 0.05,
                                       powerOnAfterAway: 0.15, powerOnAtLaunch: false))
    }

    private func snapshot(total: Int = 3, needsYou: Int? = 0, running: Int = 0) -> ReloDeckDirector.Snapshot {
        .init(summary: InboxTodaySummary(notifications: total, liveActivities: 0, active: 0, finished: 0),
              needsYou: needsYou,
              tasks: (0..<running).map { ReloHoloTask(id: "task-\($0)", progress: nil) },
              mix: NowMix(counts: [:]), satellites: [])
    }

    private func input(_ snapshot: ReloDeckDirector.Snapshot, trusted: Bool = true, reachable: Bool = true,
                       linkPending: Bool = false, visible: Bool = true) -> ReloDeckDirector.Input {
        .init(snapshot: snapshot, trusted: trusted, reachable: reachable, linkPending: linkPending,
              visible: visible, working: !trusted, reduceMotion: false)
    }

    private func settle(_ milliseconds: Int = 180) async { try? await Task.sleep(for: .milliseconds(milliseconds)) }

    func testFirstObservationIsBaselineNotNews() async {
        let deck = director()
        deck.ingest(input(snapshot(total: 2), trusted: false))
        XCTAssertEqual(deck.shown?.summary.total, 2)
        deck.ingest(input(snapshot(total: 5, needsYou: 1)))
        await settle()
        XCTAssertEqual(deck.shown?.summary.total, 5)
        XCTAssertEqual(deck.waves, 0, "data arriving on open is not news")
        XCTAssertEqual(deck.newsTicks, 0)
        XCTAssertTrue(deck.armed)
    }

    func testOnlyRealChangesWhileWatchingRipple_andHapticsAreRateLimited() async {
        let deck = director()
        deck.ingest(input(snapshot(needsYou: 0)))
        await settle()
        deck.ingest(input(snapshot(needsYou: 1)))
        await settle(80)
        XCTAssertEqual(deck.waves, 1)
        XCTAssertEqual(deck.newsTicks, 1)
        deck.ingest(input(snapshot(needsYou: 2)))
        await settle(80)
        XCTAssertEqual(deck.waves, 2)
        XCTAssertEqual(deck.newsTicks, 1, "a second request inside the cooldown does not buzz again")
    }

    func testBurstsCoalesceIntoOneChange() async {
        let deck = director()
        deck.ingest(input(snapshot(total: 1)))
        await settle()
        for total in 2...6 { deck.ingest(input(snapshot(total: total))) }
        await settle(100)
        XCTAssertEqual(deck.shown?.summary.total, 6)
        XCTAssertEqual(deck.waves, 1)
    }

    func testUntrustedDipsAreHeld() async {
        let deck = director()
        deck.ingest(input(snapshot(total: 4, needsYou: 1, running: 2)))
        await settle()
        deck.ingest(input(snapshot(total: 0, needsYou: nil, running: 0), trusted: false))
        await settle()
        XCTAssertEqual(deck.shown?.summary.total, 4)
        XCTAssertEqual(deck.shown?.tasks.count, 2, "running work never drops to zero and back while reconnecting")
        XCTAssertEqual(deck.waves, 0)
    }

    func testWakingWithABriefReconnectNeverGoesDormantOrReboots() async {
        let deck = director()
        deck.ingest(input(snapshot()))
        await settle()
        deck.ingest(input(snapshot(), trusted: false, visible: false))     // asleep
        deck.ingest(input(snapshot(), trusted: false, reachable: false))   // waking, briefly out of reach
        await settle(60)
        deck.ingest(input(snapshot()))                                     // back within the hold
        await settle(300)
        XCTAssertEqual(deck.phase, .live)
        XCTAssertEqual(deck.successTicks, 0)
        XCTAssertEqual(deck.waves, 0)
    }

    func testSustainedOutageGoesDormantThenFadesBackQuietly() async {
        let deck = director()
        deck.ingest(input(snapshot()))
        await settle()
        deck.ingest(input(snapshot(), trusted: false, reachable: false))
        await settle(300)
        XCTAssertEqual(deck.phase, .dormant)
        XCTAssertFalse(deck.linking)
        deck.ingest(input(snapshot(total: 7)))
        await settle(150)                                                  // return hold 100 ms; plate lasts 110 ms
        XCTAssertEqual(deck.phase, .live)
        XCTAssertEqual(deck.shown?.summary.total, 7)
        XCTAssertEqual(deck.badge?.word, "ONLINE")
        XCTAssertEqual(deck.successTicks, 0, "a reconnect is not a celebration")
        await settle(800)
        XCTAssertEqual(deck.revealed, 6)
    }

    func testCeremonyRunsOnceAndJumpsToTheEndWhenInterrupted() async {
        let deck = director()
        deck.ingest(input(snapshot(), trusted: false, linkPending: true))
        XCTAssertEqual(deck.phase, .dormant)
        XCTAssertTrue(deck.linking)
        deck.ingest(input(snapshot(), linkPending: true))
        XCTAssertEqual(deck.phase, .booting)
        XCTAssertEqual(deck.successTicks, 1)
        deck.ingest(input(snapshot(), linkPending: true, visible: false))  // switched away mid-boot
        XCTAssertEqual(deck.phase, .live)
        XCTAssertEqual(deck.revealed, 6)
        XCTAssertNil(deck.greeting)
        XCTAssertEqual(deck.ceremonyFinishes, 1)
        deck.ingest(input(snapshot(), linkPending: true))                  // back, flag not cleared yet
        await settle(300)
        XCTAssertEqual(deck.successTicks, 1, "the ceremony never replays")
        XCTAssertEqual(deck.phase, .live)
    }

    func testCeremonyStartsOnceLinkedEvenBeforeLiveCountsArrive() {
        let deck = director()
        var linked = input(snapshot(needsYou: nil), trusted: false, linkPending: true)
        deck.ingest(linked)
        XCTAssertEqual(deck.phase, .dormant)
        linked.linked = true
        deck.ingest(linked)
        XCTAssertEqual(deck.phase, .booting, "a slow live connection never leaves the deck stuck on LINKING")
    }

    func testComingBackAfterAWhilePowersTheHUDOnQuietly() async {
        let deck = director()
        deck.ingest(input(snapshot()))
        await settle()
        deck.ingest(input(snapshot(), visible: false))
        await settle(200)                                                  // away longer than the threshold
        deck.ingest(input(snapshot()))
        XCTAssertEqual(deck.badge?.word, "ACTIVE")
        XCTAssertEqual(deck.revealed, 0, "the HUD builds up again")
        XCTAssertFalse(deck.armed)
        await settle(800)
        XCTAssertEqual(deck.revealed, 6)
        XCTAssertEqual(deck.moduleBuilds.count, 4, "every module built")
        XCTAssertEqual(deck.successTicks, 0, "no haptic for coming back")
        XCTAssertEqual(deck.waves, 0)
    }

    func testScrollingTheDeckAwayIsNotTimeAway() async {
        let deck = director()
        deck.ingest(input(snapshot()))
        await settle()
        var scrolled = input(snapshot(), visible: false)
        scrolled.onScreen = true                                           // Now still showing, deck scrolled off
        deck.ingest(scrolled)
        XCTAssertFalse(deck.armed, "effects pause while the deck is out of view")
        await settle(200)                                                  // longer than the away threshold
        deck.ingest(input(snapshot()))
        XCTAssertNil(deck.badge, "scrolling back never replays the power-on")
        XCTAssertEqual(deck.revealed, 6)
    }

    func testABriefLookAwayDoesNotPowerOnAgain() async {
        let deck = director()
        deck.ingest(input(snapshot()))
        await settle()
        deck.ingest(input(snapshot(), visible: false))
        deck.ingest(input(snapshot()))
        XCTAssertNil(deck.badge)
        XCTAssertEqual(deck.revealed, 6)
    }

    func testLosingTheServerShowsOffline() async {
        let deck = director()
        deck.ingest(input(snapshot()))
        await settle()
        deck.ingest(input(snapshot(), trusted: false, reachable: false))
        await settle(300)
        XCTAssertEqual(deck.phase, .dormant)
        XCTAssertEqual(deck.badge?.word, "OFFLINE")
        XCTAssertEqual(deck.badge?.warning, true)
    }

    func testCeremonyCompletesOnItsTimeline() async {
        let deck = director()
        deck.ingest(input(snapshot(), linkPending: true))
        await settle(900)                                                  // ~10.8 s × 0.05
        XCTAssertEqual(deck.phase, .live)
        XCTAssertEqual(deck.revealed, 6)
        XCTAssertEqual(deck.ceremonyFinishes, 1)
    }
}
