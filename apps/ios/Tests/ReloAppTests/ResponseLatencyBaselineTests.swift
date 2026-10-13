@testable import ReloRuntime
@testable import ReloPersistence
import XCTest
import ReloCore
@testable import Relo

/// Opt-in baseline through the shipping AppModel and cross-process protected file store.
/// The injected API boundary excludes URLSession, server, radio and OS notification scheduling.
@MainActor
final class ResponseLatencyBaselineTests: XCTestCase {
    func testTapToRequestBaseline() async throws {
        let source = ProcessInfo.processInfo.environment["RELO_BENCHMARK_SOURCE_COMMIT"] ?? ""
        try XCTSkipIf(source.isEmpty, "Run scripts/benchmark-latency.sh for measured samples")
        XCTAssertNotNil(source.range(of: "^[a-f0-9]{40,64}$", options: .regularExpression))
        var spans: [[String: String]] = []
        for blocked in [false, true] {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: directory) }
            let actions = AccountScopedCrossProcessResponseStore(baseDirectory: directory)
            let ledger = InMemoryProtectedActionStore()
            let api = LatencyAPI()
            let stores = LatencyStores()
            let credential = DeviceCredential(deviceId: "latency-device",
                installationId: UUID(uuidString: "11111111-1111-1111-1111-111111111111")!,
                accessToken: "test-only", issuedAt: .distantPast, accountId: "latency-account", credentialVersion: 1)
            try await actions.select(accountID: credential.accountId, deviceID: credential.deviceId)
            let model = AppModel(dependencies: AppDependencies(
                credentialStore: LatencyCredentials(value: credential), accountSessionStore: stores,
                installationIDStore: stores, stableDeviceIDStore: stores, pushTokenStore: stores,
                liveActivityPushToStartTokenStore: stores, registrationAttemptStore: stores,
                cache: LatencyCache(items: []), apiClient: api,
                liveActivityCoordinator: LiveActivityCommandCoordinator(store: ledger), pendingResponseStore: actions,
                notificationReceiptStore: stores, accountNotificationCleaner: stores,
                serverURL: URL(string: "https://relo.invalid")!,
                system: AppSystemServices(notificationPermission: { .denied }, startActivityObservation: { _ in },
                    setBadgeCount: { _ in }, pushRegistrationError: { nil }),
                makeInboxDataSource: { _, _ in LatencyOfflineInbox() },
                makeCurrentDataSource: { _, _ in OfflineCurrentSourceFixture() }))
            await model.start()
            if blocked {
                _ = try await actions.enqueue(PendingNotificationResponse(accountID: credential.accountId,
                    deviceID: credential.deviceId, notificationID: "older-unavailable", action: .approve,
                    value: [:], idempotencyKey: "older-unavailable", expiresAt: .now.addingTimeInterval(900)))
            }
            for index in 0..<(blocked ? 20 : 100) {
                let id = "latency-\(index)"
                let item = InboxItem(id: id, kind: .notification, sourceName: "Fixture", title: "Fixture",
                    createdAt: .now, interaction: InboxInteraction(id: "request-\(index)", kind: .approval,
                    prompt: "Fixture", state: .pending, expiresAt: .now.addingTimeInterval(900)))
                let start = DispatchTime.now().uptimeNanoseconds
                await model.respond(to: item, action: .approve)
                let requestStart = await api.requestStart(for: id)
                let end = requestStart ?? DispatchTime.now().uptimeNanoseconds
                spans.append(["stage": "tap_to_request_start",
                    "scenario": blocked ? "appmodel_older_unavailable_response" : "appmodel_protected_store_warm",
                    "sourceCommit": source, "process": "ios-hosted-benchmark", "clock": "monotonic",
                    "outcome": requestStart == nil ? "failed" : "ok", "startNs": String(start), "endNs": String(end)])
                // Baseline failures remain failures in the report; do not hide head-of-line blocking.
                if !blocked { XCTAssertNotNil(requestStart) }
            }
        }
        let lines = try spans.map { String(decoding: try JSONSerialization.data(withJSONObject: $0, options: [.sortedKeys]), as: UTF8.self) }.joined(separator: "\n")
        let attachment = XCTAttachment(data: Data((lines + "\n").utf8), uniformTypeIdentifier: "public.json")
        attachment.name = "relo-latency-response.ndjson"; attachment.lifetime = .keepAlways; add(attachment)
    }
}

private struct LatencyOfflineInbox: InboxFixtureSource {
    func fetchPage(after cursor: String?) async throws -> InboxPage { throw InboxRemoteError.unavailable }
    func fetchHistoryPage(before cursor: String?) async throws -> InboxHistoryPage { throw InboxRemoteError.unavailable }
    func fetchActiveLiveActivities() async throws -> ActiveLiveActivityIdentityPage { throw InboxRemoteError.unavailable }
    func fetchDetail(notificationID: String) async throws -> InboxNotificationDetail { throw InboxRemoteError.unavailable }
    func markRead(notificationID: String) async throws -> InboxReadMutationResponse { throw InboxRemoteError.unavailable }
    func markAllRead(watermark: String) async throws -> InboxReadMutationResponse { throw InboxRemoteError.unavailable }
}

private struct LatencyCredentials: DeviceCredentialStore {
    let value: DeviceCredential
    func load() -> DeviceCredential? { value }
    func save(_ credential: DeviceCredential) { XCTFail("Unexpected credential save") }
    func delete() { XCTFail("Unexpected credential delete") }
}
private struct LatencyStores: AccountSessionStore, InstallationIDStore, StableDeviceIDStore,
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
private actor LatencyCache: AccountScopedInboxCaching {
    let snapshot: InboxSnapshot
    init(items: [InboxItem]) { snapshot = InboxSnapshot(items: items) }
    func select(accountId: String) {}
    func boundCache(for accountId: String) -> any InboxCache { InMemoryInboxCache(snapshot: snapshot) }
    func load() -> InboxSnapshot { snapshot }
    func save(_ snapshot: InboxSnapshot) {}
    func clearSelectedAccount() {}
}
private actor LatencyAPI: MobileAPIClient {
    func submitDecision(credential: DeviceCredential, response: PendingNotificationResponse) async throws -> NotificationDecisionAcknowledgement {
        try await submitInteraction(credential: credential, notificationId: response.notificationID,
            action: response.action, value: response.value, idempotencyKey: response.idempotencyKey)
        return .init(id: response.interactionID ?? "missing", state: NotificationResponsePolicy.canonicalState(for: response.action)!, respondedAt: .now)
    }
    var starts: [String: UInt64] = [:]
    func requestStart(for id: String) -> UInt64? { starts[id] }

    func validateAccountSession(token: String) async throws -> AccountSession { throw MobileAPIError.unavailable }
    func registerDevice(sessionToken: String, request: DeviceRegistrationRequest, idempotencyKey: String) async throws -> DeviceRegistrationResponse { throw MobileAPIError.unavailable }
    func deviceSelf(credential: DeviceCredential) async throws -> DeviceSelfResponse { throw MobileAPIError.unavailable }
    func heartbeat(credential: DeviceCredential, heartbeat: DeviceHeartbeat) async throws { throw MobileAPIError.unavailable }
    func registerLiveActivityToken(credential: DeviceCredential, activityId: String, registration: LiveActivityTokenRegistration) async throws { throw MobileAPIError.unavailable }
    func submitInteraction(credential: DeviceCredential, notificationId: String, action: NotificationInteractionAction, value: [String: String], idempotencyKey: String) async throws {
        if notificationId == "older-unavailable" { throw MobileAPIError.unavailable }
        starts[notificationId] = DispatchTime.now().uptimeNanoseconds
    }
    func revokeDevice(credential: DeviceCredential) async throws { throw MobileAPIError.unavailable }
    func signOutAccount(sessionToken: String) async throws { throw MobileAPIError.unavailable }
    func deleteAccount(sessionToken: String, password: String, confirmation: String) async throws { throw MobileAPIError.unavailable }
}
