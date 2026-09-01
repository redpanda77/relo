import Foundation
import ReloCore

#if DEBUG
extension AppModel {
    enum PreviewState: Equatable {
        case ready
        case permissionDenied
        case authenticating
        case waitingForAPNs
        case registering
        case registrationFailed
        case empty
        case offline
        case partialSync
        case reauthenticationRequired
        case disabled
        case signedOut
    }

    static func preview(state: PreviewState) -> AppModel {
        let account = AccountSummary(
            accountId: "acc_preview123456",
            name: "Developer",
            email: "owner@example.com"
        )
        let user = AccountUser(
            id: "better-auth-preview",
            name: account.name,
            email: account.email
        )
        let session = AccountSession(
            accessToken: "preview-account-token",
            sessionId: "preview-session",
            expiresAt: .now.addingTimeInterval(86_400),
            user: user,
            account: account
        )
        let credential = DeviceCredential(
            deviceId: "dev_preview123456",
            installationId: UUID(),
            accessToken: "preview-token-not-for-network-use",
            issuedAt: .now,
            accountId: account.accountId,
            credentialVersion: 1
        )
        let events = [
            InboxItem(id: "evt_server1234", kind: .notification, sourceName: "Relo server · Relo", title: "Idempotency and activity sync are live.", deliveryState: .acceptedByAPNs, createdAt: .now),
            InboxItem(id: "evt_codex1234567", kind: .response, sourceName: "Codex · Approval", title: "Deployment was approved.", result: "Responded", createdAt: .now.addingTimeInterval(-180)),
            InboxItem(id: "evt_backup123456", kind: .notification, sourceName: "Relo server · Backup", title: "Daily PostgreSQL backup completed.", deliveryState: .acceptedByAPNs, createdAt: .now.addingTimeInterval(-420)),
            InboxItem(id: "evt_agent1234567", kind: .liveActivity, sourceName: "Agent · Research", title: "Reference audit completed in 42 seconds.", result: "Completed", createdAt: .now.addingTimeInterval(-720)),
            InboxItem(id: "evt_shell1234567", kind: .notification, sourceName: "Relo server · Shell", title: "Command finished successfully.", deliveryState: .acceptedByAPNs, createdAt: .now.addingTimeInterval(-900)),
            InboxItem(id: "evt_monitor12345", kind: .notification, sourceName: "Relo · Monitor", title: "Private APNs worker is healthy.", deliveryState: .acceptedByAPNs, createdAt: .now.addingTimeInterval(-1_080))
        ]
        let hasAccount = state != .signedOut && state != .authenticating
        let hasCredential = hasAccount && state != .registering && state != .registrationFailed
        let hasNoItems = !hasAccount || state == .empty || state == .registering
        let permission: PermissionState
        switch state {
        case .permissionDenied: permission = .denied
        case .authenticating, .waitingForAPNs, .signedOut: permission = .unknown
        default: permission = .allowed
        }
        let accountState: AccountState
        switch state {
        case .authenticating: accountState = .signingIn
        case .reauthenticationRequired: accountState = .reauthenticationRequired
        case .disabled: accountState = .disabled
        case .signedOut: accountState = .signedOut
        default: accountState = .signedIn
        }
        let registrationState: RegistrationState
        switch state {
        case .registering: registrationState = .registering
        case .registrationFailed: registrationState = .failed("This iPhone could not register with Relo server. Retry when the private server is reachable.")
        case .signedOut: registrationState = .idle
        default: registrationState = .registered
        }
        let syncState: SyncState
        switch state {
        case .ready, .empty, .permissionDenied, .waitingForAPNs, .reauthenticationRequired, .disabled:
            syncState = .current
        case .registering: syncState = .syncing
        case .registrationFailed: syncState = .offline("Relo server is offline")
        case .offline: syncState = .offline("Relo server is offline")
        case .partialSync: syncState = .offline("Sync stopped before the next page")
        case .authenticating, .signedOut: syncState = .idle
        }
        let protectedActions = InMemoryProtectedActionStore()

        return AppModel(
            accountState: accountState,
            registrationState: registrationState,
            account: hasAccount ? account : nil,
            accountUser: hasAccount ? user : nil,
            credential: hasCredential ? credential : nil,
            permission: permission,
            items: hasNoItems ? [] : events,
            syncState: syncState,
            lastSyncedAt: state == .offline || state == .partialSync ? .now.addingTimeInterval(-3_600) : .now,
            apnsTokenAvailable: state != .waitingForAPNs,
            serverAcceptedCurrentAPNSToken: state != .waitingForAPNs && state != .registering,
            accountSession: hasAccount ? session : nil,
            credentialStore: PreviewCredentialStore(credential: hasCredential ? credential : nil),
            accountSessionStore: PreviewAccountSessionStore(session: hasAccount ? session : nil),
            installationIDStore: PreviewInstallationIDStore(),
            stableDeviceIDStore: PreviewStableDeviceIDStore(),
            pushTokenStore: PreviewPushTokenStore(),
            liveActivityPushToStartTokenStore: PreviewPushTokenStore(),
            registrationAttemptStore: PreviewRegistrationAttemptStore(),
            cache: PreviewAccountScopedCache(snapshot: InboxSnapshot(items: hasNoItems ? [] : events)),
            apiClient: PreviewMobileAPIClient(),
            liveActivityCoordinator: LiveActivityCommandCoordinator(store: protectedActions),
            pendingResponseStore: protectedActions,
            notificationReceiptStore: PreviewNotificationReceiptStore(),
            accountNotificationCleaner: PreviewAccountNotificationCleaner(),
            serverURL: URL(string: "http://192.168.1.10:8180")!
        )
    }
}

private struct PreviewCredentialStore: DeviceCredentialStore {
    var credential: DeviceCredential?
    func load() -> DeviceCredential? { credential }
    func save(_ credential: DeviceCredential) {}
    func delete() {}
}

private struct PreviewAccountSessionStore: AccountSessionStore {
    var session: AccountSession?
    func load() -> AccountSession? { session }
    func save(_ session: AccountSession) {}
    func delete() {}
}

private struct PreviewInstallationIDStore: InstallationIDStore {
    var identifier = UUID(uuidString: "6FCBFEF0-19CA-42C4-B931-EEBE1F520DF8")!
    func loadOrCreate() -> UUID { identifier }
}

private struct PreviewStableDeviceIDStore: StableDeviceIDStore {
    var identifier = UUID(uuidString: "11111111-1111-1111-1111-111111111111")!
    func loadOrCreate() -> UUID { identifier }
}

private struct PreviewPushTokenStore: PushTokenStore {
    func load() -> String? { nil }
    func save(_ token: String) {}
    func delete() {}
}

private struct PreviewNotificationReceiptStore: PendingNotificationReceiptStoring {
    func pending(limit: Int) -> [String] { [] }
    func remove(notificationIDs: Set<String>) {}
}

private struct PreviewAccountNotificationCleaner: AccountNotificationClearing {
    func clearAllDeliveredAndPendingNotifications() async throws {}
}

private struct PreviewRegistrationAttemptStore: RegistrationAttemptStore {
    func attempt(for request: DeviceRegistrationRequest, minimumRevision: Int) -> RegistrationAttempt {
        RegistrationAttempt(revision: minimumRevision, request: request)
    }
    func advanceCurrentAttempt() {}
    func delete() {}
}

private actor PreviewAccountScopedCache: AccountScopedInboxCaching {
    private var snapshot: InboxSnapshot
    init(snapshot: InboxSnapshot) { self.snapshot = snapshot }
    func select(accountId: String) {}
    func boundCache(for accountId: String) -> any InboxCache {
        InMemoryInboxCache(snapshot: snapshot)
    }
    func load() -> InboxSnapshot { snapshot }
    func save(_ snapshot: InboxSnapshot) { self.snapshot = snapshot }
    func clearSelectedAccount() { snapshot = InboxSnapshot() }
}

private struct PreviewMobileAPIClient: MobileAPIClient {
    func signIn(email: String, password: String) async throws -> AccountSession { throw MobileAPIError.unavailable }
    func validateAccountSession(token: String) async throws -> AccountSession { throw MobileAPIError.unavailable }
    func registerDevice(sessionToken: String, request: DeviceRegistrationRequest, idempotencyKey: String) async throws -> DeviceRegistrationResponse { throw MobileAPIError.unavailable }
    func deviceSelf(credential: DeviceCredential) async throws -> DeviceSelfResponse { throw MobileAPIError.unavailable }
    func heartbeat(credential: DeviceCredential, heartbeat: DeviceHeartbeat) async throws { throw MobileAPIError.unavailable }
    func registerLiveActivityToken(credential: DeviceCredential, activityId: String, registration: LiveActivityTokenRegistration) async throws { throw MobileAPIError.unavailable }
    func submitInteraction(credential: DeviceCredential, notificationId: String, action: NotificationInteractionAction, value: [String: String], idempotencyKey: String) async throws { throw MobileAPIError.unavailable }
    func revokeDevice(credential: DeviceCredential) async throws { throw MobileAPIError.unavailable }
    func signOutAccount(sessionToken: String) async throws { throw MobileAPIError.unavailable }
    func deleteAccount(sessionToken: String, password: String, confirmation: String) async throws { throw MobileAPIError.unavailable }
}
#endif
