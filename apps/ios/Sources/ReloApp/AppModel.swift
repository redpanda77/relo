import ActivityKit
import Combine
import CryptoKit
import ReloCore
import SwiftUI
import UIKit
import UserNotifications

private struct SystemAccountNotificationCleaner: AccountNotificationClearing, @unchecked Sendable {
    private let center = UNUserNotificationCenter.current()

    func clearAllDeliveredAndPendingNotifications() async throws {
        center.removeAllDeliveredNotifications()
        center.removeAllPendingNotificationRequests()
        try await center.setBadgeCount(0)
    }
}

private struct LiveActivityContentDigestPayload: Encodable {
    let headline: String
    let detail: String?
    let progress: Double?
    let status: String
    let sequence: Int
    let style: ReloActivityAttributes.Style
    let symbol: LiveActivitySymbol
    let privacy: ReloActivityAttributes.Privacy
    let accentColor: String
    let expiresAt: Date?
    let staleAt: Date?
    let primaryLabel: String?
    let secondaryLabel: String?
    let interaction: ReloActivityAttributes.Interaction?

    init(_ state: ReloActivityAttributes.ContentState) {
        headline = state.headline
        detail = state.detail
        progress = state.progress
        status = state.status
        sequence = state.sequence
        style = state.style
        symbol = state.symbol
        privacy = state.privacy
        accentColor = state.accentColor
        expiresAt = state.expiresAt
        staleAt = state.staleAt
        primaryLabel = state.primaryLabel
        secondaryLabel = state.secondaryLabel
        interaction = state.interaction
    }
}

@MainActor
final class AppModel: ObservableObject {
    enum PermissionState: Equatable {
        case unknown
        case allowed
        case denied
    }

    enum AccountState: Equatable {
        case restoring
        case signedOut
        case signingIn
        case signedIn
        case reauthenticationRequired
        case disabled
        case signingOut
    }

    typealias RegistrationState = DeviceRegistrationPhase

    enum SyncState: Equatable {
        case idle
        case syncing
        case current
        case offline(String)
    }

    enum HistoryLoadState: Equatable {
        case idle
        case loading
        case current
        case offline(String)
    }

    @Published var accountState: AccountState = .restoring
    @Published var registrationState: RegistrationState = .idle
    @Published var account: AccountSummary?
    @Published var accountUser: AccountUser?
    @Published var credential: DeviceCredential?
    @Published var permission: PermissionState = .unknown
    @Published var items: [InboxItem] = []
    @Published private(set) var historySnapshot = InboxHistorySnapshot.offlineCache(items: [])
    @Published private(set) var historyLoadState: HistoryLoadState = .idle
    @Published var syncState: SyncState = .idle
    @Published var lastSyncedAt: Date?
    @Published var authenticationError: String?
    @Published var signOutError: String?
    @Published var accountDeletionError: String?
    @Published private(set) var isDeletingAccount = false
    @Published var pushRegistrationError: String?
    @Published private(set) var apnsTokenState = APNSTokenSessionState()
    @Published var serverAcceptedCurrentAPNSToken = false
    @Published private(set) var deliveryTransportStatus: DeliveryTransportStatus?
    @Published private(set) var deliveryTransportStatusError: String?
    @Published private(set) var protectedRegistrationResetAvailable = false
    @Published var selectedNotificationID: String?
    @Published var respondingNotificationID: String?
    @Published var interactionError: String?
    @Published private(set) var queuedResponseNotificationIDs = Set<String>()
    @Published private(set) var responseFeedbackByNotificationID: [String: NotificationResponseFeedback] = [:]
    @Published private(set) var unreadCount = 0
    @Published private(set) var unreadByProject: [String: Int] = [:]
    @Published private(set) var withdrawingNotificationID: String?
    @Published private(set) var selectedNotificationDetail: InboxNotificationDetail?

    private let credentialStore: any DeviceCredentialStore
    private let accountSessionStore: any AccountSessionStore
    private let installationIDStore: any InstallationIDStore
    private let stableDeviceIDStore: any StableDeviceIDStore
    private let pushTokenStore: any PushTokenStore
    private let liveActivityPushToStartTokenStore: any PushTokenStore
    private let registrationAttemptStore: any RegistrationAttemptStore
    private let signOutProgressStore: any SignOutProgressStore
    private let storagePreflight: any LocalStoragePreflighting
    private let cache: any AccountScopedInboxCaching
    private var apiClient: any MobileAPIClient
    private let liveActivityCoordinator: LiveActivityCommandCoordinator
    private let pendingResponseStore: any AccountScopedPendingResponseStoring
    private let notificationReceiptStore: any PendingNotificationReceiptStoring
    private let accountNotificationCleaner: any AccountNotificationClearing
    private var serverURL: URL
    private var accountSession: AccountSession?
    private var syncEngine: InboxSyncEngine?
    private var inboxRemote: HTTPInboxDataSource?
    private var inboxReadWatermark: String?
    private var configuredSyncScopeIdentity: String?
    private var historyPager: InboxHistoryPager?
    private var historyScopeRevision = 0
    private var historyRequestRevision = 0
    private var selectedAccountId: String?
    private var registrationInProgress = false
    private var registrationPending = false
    private var registrationRecoveryTask: Task<Void, Never>?
    private var hasStarted = false
    private var refreshTask: Task<Bool, Never>?
    private var refreshGeneration = 0
    private var refreshRequestedWhileRunning = false
    private var pendingNotificationID: String?
    private var pendingActivityIdentity: LiveActivityIdentity?
    private var pushToStartTokenTask: Task<Void, Never>?
    private var activityUpdatesTask: Task<Void, Never>?
    private var activityPushTokenTasks: [String: Task<Void, Never>] = [:]
    private var activityContentUpdateTasks: [String: Task<Void, Never>] = [:]
    private var activityStateUpdateTasks: [String: Task<Void, Never>] = [:]
    private var activityObservationScopeByNativeID: [String: String] = [:]
    private var deliveryStatusScopeIdentity: String?
    private var deliveryStatusLastAttemptAt: Date?
    private var selectedItemSnapshot = InboxSelectedItemSnapshot()

    var isRegistered: Bool { credential != nil && registrationState == .registered }
    var hasLocalAccountAccess: Bool { credential != nil || accountSession != nil }
    var apnsTokenAvailable: Bool { apnsTokenState.currentSessionTokenAvailable }
    var cachedAPNSTokenAvailable: Bool { apnsTokenState.cachedTokenAvailable }
    var liveActivitiesAuthorized: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }
    var liveActivityPushToStartTokenAvailable: Bool {
        do { return try liveActivityPushToStartTokenStore.load()?.isEmpty == false }
        catch { return false }
    }
    var activeLiveActivityCount: Int { Activity<ReloActivityAttributes>.activities.count }
    var isReady: Bool {
        DeviceReadinessPolicy.isReady(
            permissionAllowed: permission == .allowed,
            deviceRegistered: isRegistered,
            apnsTokenAvailable: apnsTokenAvailable,
            serverAcceptedCurrentAPNSToken: serverAcceptedCurrentAPNSToken,
            hasPushRegistrationError: pushRegistrationError != nil,
            liveActivitiesAuthorized: liveActivitiesAuthorized,
            liveActivityPushToStartTokenAvailable: liveActivityPushToStartTokenAvailable,
            syncCurrent: syncState == .current
        )
    }
    var dashboardURL: URL { serverURL.appendingPathComponent("dashboard") }
    var signedInEmail: String? { account?.email ?? accountSession?.user.email ?? accountUser?.email }
    var historyScopeIdentity: String {
        let phase = switch accountState {
        case .restoring: "restoring"
        case .signedOut: "signed-out"
        case .signingIn: "signing-in"
        case .signedIn: "signed-in"
        case .reauthenticationRequired: "reauthentication-required"
        case .disabled: "disabled"
        case .signingOut: "signing-out"
        }
        let accountID = account?.accountId
            ?? accountSession?.account?.accountId
            ?? credential?.accountId
            ?? "none"
        let sessionID = accountSession?.sessionId ?? "none"
        let deviceID = credential?.deviceId ?? "none"
        let credentialVersion = credential?.credentialVersion ?? 0
        return "\(phase)|\(accountID)|\(accountUser?.id ?? "none")|\(sessionID)|\(deviceID)|\(credentialVersion)"
    }
    private var currentSyncScopeIdentity: String? {
        guard
            let credential,
            credential.accountId == selectedAccountId,
            accountSession?.account?.accountId == nil || accountSession?.account?.accountId == credential.accountId
        else { return nil }
        let accountID = credential.accountId
        return "\(accountID)|\(accountSession?.sessionId ?? "device-only")|\(credential.deviceId)|\(credential.credentialVersion)"
    }
    var requiresReauthentication: Bool { accountState == .reauthenticationRequired }
    var isAuthenticating: Bool { accountState == .signingIn }
    var isSigningOut: Bool { accountState == .signingOut }
    var canDeleteAccount: Bool { accountSession != nil && accountState == .signedIn }
    var selectedNotification: InboxItem? {
        guard let selectedNotificationID else { return nil }
        return selectedItemSnapshot.item?.id == selectedNotificationID
            ? selectedItemSnapshot.item
            : nil
    }
    var historyItems: [InboxItem] { historySnapshot.items }
    var historyTotal: Int? { historySnapshot.total }
    var historyHasMore: Bool { historySnapshot.hasMore }
    var historyIsServerBacked: Bool { historySnapshot.source == .server }
    var isLoadingHistory: Bool { historyLoadState == .loading }
    var pendingResponseCount: Int { queuedResponseNotificationIDs.count }
    var healthSnapshot: DeviceHealthSnapshot {
        let notificationPermission: DeviceNotificationPermissionHealth = switch permission {
        case .unknown: .unknown
        case .allowed: .allowed
        case .denied: .denied
        }
        let inbox: DeviceInboxHealth = switch syncState {
        case .idle: .idle
        case .syncing: .syncing
        case .current: .current
        case .offline(let detail): .offline(detail)
        }
        return DeviceHealthProjection.project(
            accountNeedsAttention: accountState == .disabled || accountState == .reauthenticationRequired,
            notificationPermission: notificationPermission,
            registration: registrationState,
            deviceCredentialPresent: credential != nil,
            apnsTokenAvailable: apnsTokenAvailable,
            serverAcceptedCurrentAPNSToken: serverAcceptedCurrentAPNSToken,
            hasPushRegistrationError: pushRegistrationError != nil,
            liveActivitiesAuthorized: liveActivitiesAuthorized,
            liveActivityPushToStartTokenAvailable: liveActivityPushToStartTokenAvailable,
            activeLiveActivityCount: activeLiveActivityCount,
            inbox: inbox,
            hasCachedActivity: !items.isEmpty,
            deliveryTransportStatus: deliveryTransportStatus,
            deliveryTransportError: deliveryTransportStatusError
        )
    }
    func responseIsQueued(for notificationID: String) -> Bool {
        queuedResponseNotificationIDs.contains(notificationID)
    }
    func responseFeedback(for notificationID: String) -> NotificationResponseFeedback? {
        responseFeedbackByNotificationID[notificationID]
    }
    func responseIsAccepted(for notificationID: String) -> Bool {
        responseFeedbackByNotificationID[notificationID]?.phase == .accepted
    }
    func foregroundRefreshDelaySeconds(afterAttempt attempt: Int) -> Int64 {
        InboxRefreshPolicy.foregroundDelaySeconds(
            afterAttempt: attempt,
            directPushAvailable: deliveryTransportStatus?.apns.directDeliveryConfigured
        )
    }

    init(
        accountState: AccountState = .restoring,
        registrationState: RegistrationState = .idle,
        account: AccountSummary? = nil,
        accountUser: AccountUser? = nil,
        credential: DeviceCredential? = nil,
        permission: PermissionState = .unknown,
        items: [InboxItem] = [],
        syncState: SyncState = .idle,
        lastSyncedAt: Date? = nil,
        apnsTokenAvailable: Bool = false,
        serverAcceptedCurrentAPNSToken: Bool = false,
        deliveryTransportStatus: DeliveryTransportStatus? = nil,
        accountSession: AccountSession? = nil,
        credentialStore: any DeviceCredentialStore,
        accountSessionStore: any AccountSessionStore,
        installationIDStore: any InstallationIDStore,
        stableDeviceIDStore: any StableDeviceIDStore,
        pushTokenStore: any PushTokenStore,
        liveActivityPushToStartTokenStore: any PushTokenStore,
        registrationAttemptStore: any RegistrationAttemptStore,
        signOutProgressStore: any SignOutProgressStore = NoopSignOutProgressStore(),
        storagePreflight: any LocalStoragePreflighting = NoopLocalStoragePreflight(),
        cache: any AccountScopedInboxCaching,
        apiClient: any MobileAPIClient,
        liveActivityCoordinator: LiveActivityCommandCoordinator,
        pendingResponseStore: any AccountScopedPendingResponseStoring,
        notificationReceiptStore: any PendingNotificationReceiptStoring,
        accountNotificationCleaner: any AccountNotificationClearing,
        serverURL: URL
    ) {
        self.accountState = accountState
        self.registrationState = registrationState
        self.account = account
        self.accountUser = accountUser
        self.credential = credential
        self.permission = permission
        self.items = items
        self.historySnapshot = .offlineCache(items: items)
        self.syncState = syncState
        self.lastSyncedAt = lastSyncedAt
        self.apnsTokenState = APNSTokenSessionState(
            cachedTokenAvailable: apnsTokenAvailable,
            currentSessionTokenAvailable: apnsTokenAvailable
        )
        self.serverAcceptedCurrentAPNSToken = serverAcceptedCurrentAPNSToken
        self.deliveryTransportStatus = deliveryTransportStatus
        self.accountSession = accountSession
        self.credentialStore = credentialStore
        self.accountSessionStore = accountSessionStore
        self.installationIDStore = installationIDStore
        self.stableDeviceIDStore = stableDeviceIDStore
        self.pushTokenStore = pushTokenStore
        self.liveActivityPushToStartTokenStore = liveActivityPushToStartTokenStore
        self.registrationAttemptStore = registrationAttemptStore
        self.signOutProgressStore = signOutProgressStore
        self.storagePreflight = storagePreflight
        self.cache = cache
        self.apiClient = apiClient
        self.liveActivityCoordinator = liveActivityCoordinator
        self.pendingResponseStore = pendingResponseStore
        self.notificationReceiptStore = notificationReceiptStore
        self.accountNotificationCleaner = accountNotificationCleaner
        self.serverURL = serverURL
    }

    static func live() -> AppModel {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let reloDirectory = support.appendingPathComponent("Relo", isDirectory: true)
        let origin = RuntimeServerOrigin.current()
            ?? URL(string: "https://relo.invalid")!
        let protectedActions = AccountScopedProtectedActionStore(
            baseDirectory: reloDirectory.appendingPathComponent("accounts", isDirectory: true)
        )
        let appGroup = Bundle.main.object(forInfoDictionaryKey: "RELOAppGroup") as? String
        let sharedRoot = appGroup.flatMap {
            FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: $0)
        } ?? reloDirectory.appendingPathComponent("shared", isDirectory: true)
        let responseStore = AccountScopedCrossProcessResponseStore(
            baseDirectory: sharedRoot.appendingPathComponent("protected-actions", isDirectory: true)
        )
        return AppModel(
            credentialStore: KeychainDeviceCredentialStore(),
            accountSessionStore: KeychainAccountSessionStore(),
            installationIDStore: KeychainInstallationIDStore(),
            stableDeviceIDStore: KeychainStableDeviceIDStore(),
            pushTokenStore: KeychainPushTokenStore(),
            liveActivityPushToStartTokenStore: KeychainPushTokenStore(
                account: "live-activity-push-to-start-token"
            ),
            registrationAttemptStore: KeychainRegistrationAttemptStore(),
            signOutProgressStore: KeychainSignOutProgressStore(),
            storagePreflight: KeychainLocalStoragePreflight(
                accountsDirectory: reloDirectory.appendingPathComponent("accounts", isDirectory: true)
            ),
            cache: AccountScopedInboxCache(
                baseDirectory: reloDirectory.appendingPathComponent("accounts", isDirectory: true)
            ),
            apiClient: HTTPMobileAPIClient(baseURL: origin),
            liveActivityCoordinator: LiveActivityCommandCoordinator(store: protectedActions),
            pendingResponseStore: responseStore,
            notificationReceiptStore: FilePendingNotificationReceiptStore(baseDirectory: sharedRoot),
            accountNotificationCleaner: SystemAccountNotificationCleaner(),
            serverURL: origin
        )
    }

    func start() async {
        guard !hasStarted else { return }
        hasStarted = true
        protectedRegistrationResetAvailable = false
        accountState = .restoring
        do {
            try storagePreflight.run()
        } catch LocalStoragePreflightError.protectedAccountSessionUnreadable {
            accountState = .signedOut
            registrationState = .failed("The protected Relo server account session is unreadable. Sign in again to recover it.")
            syncState = .offline("Protected account storage could not be opened")
            return
        } catch LocalStoragePreflightError.protectedDeviceCredentialUnreadable {
            accountState = .reauthenticationRequired
            registrationState = .failed("The local device credential store is unreadable. Sign in again before registering this iPhone.")
            syncState = .offline("Protected device storage could not be opened")
            return
        } catch LocalStoragePreflightError.protectedStableDeviceIDUnreadable {
            accountState = .signedOut
            protectedRegistrationResetAvailable = true
            registrationState = .failed("The protected device identity is unreadable. Reset this iPhone's Relo registration to recover it.")
            syncState = .offline("Protected device identity could not be opened")
            return
        } catch LocalStoragePreflightError.protectedInstallationIDUnreadable {
            accountState = .signedOut
            protectedRegistrationResetAvailable = true
            registrationState = .failed("The protected installation identity is unreadable. Reset this iPhone's Relo registration to recover it.")
            syncState = .offline("Protected installation identity could not be opened")
            return
        } catch LocalStoragePreflightError.durableSignOutProgressUnreadable {
            accountState = .signedOut
            registrationState = .failed("Sign-out recovery data is unreadable. Your account and device credentials were preserved.")
            syncState = .offline("Sign-out recovery data could not be opened")
            return
        } catch {
            accountState = .signedOut
            registrationState = .failed("Local storage migration failed before registration.")
            syncState = .offline("Local storage migration failed")
            return
        }
        startLiveActivityObservation()
        await updatePermission()
        pushRegistrationError = UserDefaults.standard.string(forKey: "relo.apnsRegistrationError")
        apnsTokenState = .restored(cachedTokenAvailable: (try? pushTokenStore.load()) != nil)

        do {
            accountSession = try accountSessionStore.load()
            credential = try credentialStore.load()
            accountUser = accountSession?.user
            account = accountSession?.account
        } catch {
            accountState = .signedOut
            syncState = .offline("Protected local data could not be opened")
            return
        }

        if (try? signOutProgressStore.load()) != nil {
            _ = await signOut()
            return
        }

        if let accountId = accountSession?.account?.accountId {
            await selectAndLoadCache(accountId: accountId)
        } else if accountSession == nil, let accountId = credential?.accountId {
            await selectAndLoadCache(accountId: accountId)
        }

        var accountSessionIsValid = false
        if let storedSession = accountSession {
            do {
                var validated = try await apiClient.validateAccountSession(token: storedSession.accessToken)
                if let account = storedSession.account {
                    validated = validated.attaching(account: account)
                }
                try accountSessionStore.save(validated)
                accountSession = validated
                accountUser = validated.user
                account = validated.account ?? account
                accountState = .signedIn
                accountSessionIsValid = true
            } catch MobileAPIError.reauthenticationRequired {
                accountState = .reauthenticationRequired
            } catch MobileAPIError.accountDisabled {
                accountState = .disabled
            } catch {
                // Keep the last authenticated account usable with its cached inbox
                // when Relo server is temporarily unreachable. Only an authoritative
                // 401/403 above may require authentication again.
                accountState = .signedIn
            }
        } else {
            accountState = credential == nil ? .signedOut : .reauthenticationRequired
        }

        // A valid existing device credential remains usable while registration
        // reconciliation is delayed. Registration convergence must not gate the
        // cached Inbox or a healthy device bearer on cold start.
        if credential != nil {
            registrationState = .registered
            await configureSyncEngine()
            await synchronizeLiveActivityTokens()
            await sendHeartbeat()
            await refresh()
        }
        if accountSessionIsValid {
            await registerDevice()
        }
    }

    func resetProtectedDeviceRegistration() async {
        guard protectedRegistrationResetAvailable else { return }
        do {
            try storagePreflight.resetDeviceRegistrationState()
            protectedRegistrationResetAvailable = false
            registrationState = .idle
            syncState = .idle
            hasStarted = false
            await start()
        } catch {
            registrationState = .failed("The protected device registration could not be reset. Restart this iPhone and try again.")
        }
    }

    func signIn(email: String, password: String) async -> Bool {
        authenticationError = nil
        signOutError = nil
        deliveryTransportStatus = nil
        deliveryTransportStatusError = nil
        deliveryStatusScopeIdentity = nil
        deliveryStatusLastAttemptAt = nil
        let trimmedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedEmail.isEmpty, (8...128).contains(password.count) else {
            authenticationError = "Enter your Relo server account email and an 8–128 character password."
            return false
        }

        accountState = .signingIn
        do {
            let session = try await apiClient.signIn(email: trimmedEmail, password: password)
            try await retireCurrentDeviceBinding()
            try accountSessionStore.save(session)
            accountSession = session
            accountUser = session.user
            account = nil
            items = []
            clearHistory()
            await updateApplicationBadge()
            lastSyncedAt = nil
            syncEngine = nil
            configuredSyncScopeIdentity = nil
            selectedAccountId = nil
            accountState = .signedIn
            await registerDevice(force: true)
            return accountSession != nil
        } catch {
            accountState = credential == nil ? .signedOut : .reauthenticationRequired
            authenticationError = authenticationMessage(for: error)
            return false
        }
    }

    func connect(scannedValue: String) async -> Bool {
        authenticationError = nil
        accountState = .signingIn
        do {
            let document = try ReloConnectionDocument.decode(scannedValue: scannedValue)
            let installationId = try installationIDStore.loadOrCreate().uuidString.lowercased()
            let client = HTTPMobileAPIClient(baseURL: document.origin)
            let session = try await client.consumeConnectionGrant(
                document: document, installationId: installationId
            )
            try await retireCurrentDeviceBinding()
            RuntimeServerOrigin.persist(document.origin)
            apiClient = client
            serverURL = document.origin
            try accountSessionStore.save(session)
            accountSession = session
            accountUser = session.user
            account = nil
            items = []
            clearHistory()
            syncEngine = nil
            inboxRemote = nil
            configuredSyncScopeIdentity = nil
            selectedAccountId = nil
            accountState = .signedIn
            await registerDevice(force: true)
            return accountSession != nil
        } catch {
            accountState = credential == nil ? .signedOut : .reauthenticationRequired
            authenticationError = "That Relo connection code is invalid, expired, already used, or the server is unavailable. Generate a fresh code in Dashboard → Connections."
            return false
        }
    }

    func requestNotifications() async {
        do {
            _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
            UIApplication.shared.registerForRemoteNotifications()
        } catch {
            permission = .denied
        }
        await updatePermission()
        if accountSession != nil {
            await registerDevice(force: true)
        } else {
            await sendHeartbeat()
        }
    }

    func retryDeviceRegistration() async {
        if pushRegistrationError != nil {
            UserDefaults.standard.removeObject(forKey: "relo.apnsRegistrationError")
            pushRegistrationError = nil
            apnsTokenState = apnsTokenState.retryingRegistration()
            serverAcceptedCurrentAPNSToken = false
            UIApplication.shared.registerForRemoteNotifications()
        }
        await updatePermission()
        if accountSession != nil {
            await registerDevice(force: true)
        } else {
            await sendHeartbeat()
        }
    }

    func registerDevice(force: Bool = false) async {
        guard accountSession != nil, !isDeletingAccount else { return }
        if force {
            registrationRecoveryTask?.cancel()
            registrationRecoveryTask = nil
        } else if let retryAt = try? registrationAttemptStore.recoveryState()?.nextRetryAt,
                  retryAt > Date() {
            scheduleRegistrationRecovery(at: retryAt)
            return
        }
        if registrationInProgress {
            registrationPending = true
            return
        }

        registrationInProgress = true
        repeat {
            registrationPending = false
            await performRegistration()
        } while registrationPending
        registrationInProgress = false
    }

    private func scheduleRegistrationRecovery(at retryAt: Date) {
        guard accountSession != nil, !isDeletingAccount else { return }
        registrationRecoveryTask?.cancel()
        registrationRecoveryTask = Task { @MainActor [weak self] in
            let delay = max(0, retryAt.timeIntervalSinceNow)
            if delay > 0 {
                let nanoseconds = UInt64(min(delay, 86_400) * 1_000_000_000)
                try? await Task.sleep(nanoseconds: nanoseconds)
            }
            guard !Task.isCancelled, let self else { return }
            self.registrationRecoveryTask = nil
            guard self.accountSession != nil else { return }
            await self.registerDevice(force: true)
        }
    }

    private func scheduleRegistrationRecoveryAfterFailure(retryAfter: TimeInterval? = nil) {
        let now = Date()
        let recovery = (try? registrationAttemptStore.recordTransientFailure(
            now: now,
            retryAfter: retryAfter
        )) ?? RegistrationRecoveryPolicy.recordingTransientFailure(
            previousFailures: 0,
            now: now,
            retryAfter: retryAfter
        )
        scheduleRegistrationRecovery(at: recovery.nextRetryAt ?? now.addingTimeInterval(5))
    }

    @discardableResult
    func refresh() async -> Bool {
        if let refreshTask {
            refreshRequestedWhileRunning = true
            return await refreshTask.value
        }
        let task = Task<Bool, Never> { @MainActor [weak self] in
            guard let self else { return false }
            var refreshed = await self.performRefresh()
            while !Task.isCancelled && self.refreshRequestedWhileRunning {
                self.refreshRequestedWhileRunning = false
                refreshed = await self.performRefresh() || refreshed
            }
            return refreshed
        }
        refreshGeneration += 1
        let generation = refreshGeneration
        refreshTask = task
        let refreshed = await task.value
        if refreshGeneration == generation {
            refreshTask = nil
        }
        return refreshed
    }

    private func performRefresh() async -> Bool {
        guard
            let syncEngine,
            let expectedScope = configuredSyncScopeIdentity,
            expectedScope == currentSyncScopeIdentity
        else { return false }
        syncState = .syncing
        do {
            await flushLiveActivityDismissals()
            await flushLiveActivityReceipts()
            await flushPendingResponses()
            let snapshot = try await syncEngine.synchronize()
            guard
                expectedScope == configuredSyncScopeIdentity,
                expectedScope == currentSyncScopeIdentity
            else { return false }
            items = snapshot.items.filter { $0.withdrawnAt == nil }
            inboxReadWatermark = snapshot.readWatermark
            unreadCount = snapshot.unread?.account ?? items.filter { $0.readAt == nil }.count
            unreadByProject = snapshot.unread?.projects ?? [:]
            let visibleHistory = InboxHistoryRefreshPolicy.visibleSnapshot(
                current: historySnapshot,
                refreshedCacheItems: snapshot.items
            )
            if visibleHistory != historySnapshot {
                historySnapshot = visibleHistory
                historyLoadState = .idle
                reconcileSelectedItem()
            }
            lastSyncedAt = snapshot.lastSuccessfulSyncAt
            syncState = .current
            resolvePendingNotification()
            resolvePendingActivity()
            reconcileSelectedItem()
            await updateApplicationBadge()
            guard
                expectedScope == configuredSyncScopeIdentity,
                expectedScope == currentSyncScopeIdentity
            else { return false }
            let authoritativeLiveActivities = await fetchAuthoritativeLiveActivities()
            await applyPendingLiveActivityCommands(
                from: snapshot.items,
                authoritativeLiveActivities: authoritativeLiveActivities
            )
            if let authoritativeLiveActivities {
                await convergeLiveActivitiesWithServerTruth(
                    Set(authoritativeLiveActivities.activities.map(\.identity))
                )
            }
            await flushNotificationReceipts(
                authoritativeNotificationIDs: Set(snapshot.items.map(\.id))
            )
            await flushLiveActivityReceipts()
            await refreshDeliveryTransportStatus()
            guard
                expectedScope == configuredSyncScopeIdentity,
                expectedScope == currentSyncScopeIdentity
            else { return false }
            try await reloadHistoryFromServer()
            return true
        } catch InboxRemoteError.unauthorized {
            if expectedScope == configuredSyncScopeIdentity,
               expectedScope == currentSyncScopeIdentity {
                await handleRevokedDeviceCredential()
            }
        } catch {
            if expectedScope == configuredSyncScopeIdentity,
               expectedScope == currentSyncScopeIdentity {
                syncState = .offline(InboxRefreshErrorGuidance.message(for: error))
                resolvePendingNotification()
                resolvePendingActivity()
            }
        }
        return false
    }

    func loadOlderHistory() async {
        guard !isLoadingHistory, let historyPager, historySnapshot.hasMore else { return }
        let expectedRevision = historyScopeRevision
        historyRequestRevision += 1
        let expectedRequest = historyRequestRevision
        historyLoadState = .loading
        do {
            let snapshot = try await historyPager.loadMore()
            guard
                expectedRevision == historyScopeRevision,
                expectedRequest == historyRequestRevision
            else { return }
            historySnapshot = snapshot
            historyLoadState = .current
            reconcileSelectedItem()
        } catch InboxRemoteError.unauthorized {
            guard
                expectedRevision == historyScopeRevision,
                expectedRequest == historyRequestRevision
            else { return }
            await handleRevokedDeviceCredential()
        } catch {
            guard
                expectedRevision == historyScopeRevision,
                expectedRequest == historyRequestRevision
            else { return }
            historyLoadState = .offline("Older activity could not be loaded")
        }
    }

    func openNotification(notificationID: String) async {
        interactionError = nil
        selectedNotificationDetail = nil
        pendingNotificationID = notificationID
        if NotificationRouteResolver.contains(
            notificationID: notificationID,
            in: items + historySnapshot.items
        ) {
            resolvePendingNotification()
        }
        if pendingNotificationID != nil {
            await refresh()
        }
        await markNotificationRead(notificationID)
        do {
            selectedNotificationDetail = try await inboxRemote?.fetchDetail(
                notificationID: notificationID
            )
        } catch { /* The cached/list projection remains usable offline. */ }
    }

    func markAllNotificationsRead() async {
        guard let inboxRemote, let watermark = inboxReadWatermark else { return }
        do {
            let response = try await inboxRemote.markAllRead(watermark: watermark)
            unreadCount = response.unread.account
            unreadByProject = response.unread.projects
            _ = await refresh()
        } catch { interactionError = "Read state could not be synchronized." }
    }

    func withdrawNotification(_ notificationID: String) async {
        guard let accountSession, withdrawingNotificationID == nil else { return }
        interactionError = nil
        withdrawingNotificationID = notificationID
        defer { withdrawingNotificationID = nil }
        do {
            try await apiClient.withdrawNotification(
                sessionToken: accountSession.accessToken,
                notificationID: notificationID
            )
            _ = await refresh()
            if selectedNotificationID == notificationID { dismissNotification() }
        } catch MobileAPIError.reauthenticationRequired {
            interactionError = "Your account session expired. Sign in again before withdrawing this notification."
        } catch {
            interactionError = "Withdrawal was not confirmed. The notification remains available."
        }
    }

    func canWithdraw(_ item: InboxItem) -> Bool {
        accountSession != nil && item.kind == .notification && item.liveActivity == nil
            && item.activitySummary == nil && item.withdrawnAt == nil
    }

    private func markNotificationRead(_ notificationID: String) async {
        guard let inboxRemote else { return }
        do {
            let response = try await inboxRemote.markRead(notificationID: notificationID)
            unreadCount = response.unread.account
            unreadByProject = response.unread.projects
            _ = await refresh()
        } catch { /* Opening remains available offline; the next refresh may retry. */ }
    }

    private func fetchAuthoritativeLiveActivities() async -> ActiveLiveActivityIdentityPage? {
        guard let inboxRemote else { return nil }
        do {
            return try await inboxRemote.fetchActiveLiveActivities()
        } catch {
            return nil
        }
    }

    private func convergeLiveActivitiesWithServerTruth(
        _ authoritative: Set<LiveActivityIdentity>
    ) async {
        guard let selectedAccountId else { return }
        for activity in Activity<ReloActivityAttributes>.activities
        where activity.attributes.accountID == selectedAccountId
            && !authoritative.contains(activity.attributes.identity) {
            var state = activity.content.state
            state.interaction = nil
            state.updatedAt = .now
            await activity.end(ActivityContent(state: state,staleDate: nil),dismissalPolicy: .immediate)
        }
    }

    func dismissNotification() {
        selectedNotificationID = nil
        selectedNotificationDetail = nil
        selectedItemSnapshot.dismiss()
        interactionError = nil
    }

    func openActivity(identity: LiveActivityIdentity) async {
        guard identity.isValid else { return }
        interactionError = nil
        pendingActivityIdentity = identity
        resolvePendingActivity()
        if pendingActivityIdentity != nil {
            _ = await refresh()
        }
    }

    func respond(
        to item: InboxItem,
        action: NotificationInteractionAction,
        text: String? = nil
    ) async {
        guard
            let credential,
            let interaction = item.interaction,
            interaction.state == .pending,
            interaction.expiresAt > .now,
            NotificationResponsePolicy.supports(action, kind: interaction.kind)
        else { return }
        let accountID = credential.accountId
        respondingNotificationID = item.id
        responseFeedbackByNotificationID[item.id] = NotificationResponseFeedback(
            phase: .sending,
            action: action
        )
        interactionError = nil
        defer { respondingNotificationID = nil }

        let trimmedText = NotificationReplyPolicy.normalized(text)
        if action == .answer, !NotificationReplyPolicy.isValid(trimmedText) {
            interactionError = NotificationReplyPolicy.validationMessage
            responseFeedbackByNotificationID[item.id] = NotificationResponseFeedback(
                phase: .rejected,
                action: action,
                message: NotificationReplyPolicy.validationMessage
            )
            return
        }
        let value = trimmedText.map { ["response": $0] } ?? [:]
        let pending = PendingNotificationResponse(
            accountID: accountID,
            deviceID: credential.deviceId,
            notificationID: item.id,
            action: action,
            value: value,
            idempotencyKey: "ios:\(credential.installationId):\(item.id):\(action.rawValue)",
            expiresAt: interaction.expiresAt
        )
        do {
            let enqueue = try await pendingResponseStore.enqueue(pending)
            switch enqueue {
            case .enqueued:
                responseFeedbackByNotificationID[item.id] = NotificationResponseFeedback(
                    phase: .queued,
                    action: action
                )
            case .alreadyPending(let existing):
                responseFeedbackByNotificationID[item.id] = NotificationResponseFeedback(
                    phase: .queued,
                    action: existing.action
                )
            case .alreadyNotificationConfirmed(let confirmation):
                responseFeedbackByNotificationID[item.id] = NotificationResponseFeedback(
                    phase: .accepted,
                    action: confirmation.action,
                    canonicalState: confirmation.canonicalState
                )
                return
            case .alreadyConfirmed:
                throw LiveActivityResponseConfirmationError.responseMismatch
            }
            await flushPendingResponses()
            await refresh()
        } catch {
            interactionError = "The response could not be protected locally. Nothing was sent or assumed."
            responseFeedbackByNotificationID[item.id] = NotificationResponseFeedback(
                phase: .rejected,
                action: action,
                message: "Nothing was sent or assumed — retry"
            )
        }
    }

    func respond(notificationID: String, action: NotificationInteractionAction, text: String? = nil) async {
        await openNotification(notificationID: notificationID)
        if let item = (items + historySnapshot.items).first(where: { $0.id == notificationID }) {
            await respond(to: item, action: action, text: text)
            return
        }
        guard let credential else { return }
        let accountID = credential.accountId
        let trimmedText = NotificationReplyPolicy.normalized(text)
        if action == .answer, !NotificationReplyPolicy.isValid(trimmedText) {
            interactionError = NotificationReplyPolicy.validationMessage
            return
        }
        let pending = PendingNotificationResponse(
            accountID: accountID,
            deviceID: credential.deviceId,
            notificationID: notificationID,
            action: action,
            value: trimmedText.map { ["response": $0] } ?? [:],
            idempotencyKey: "ios:\(credential.installationId):\(notificationID):\(action.rawValue)",
            expiresAt: .now.addingTimeInterval(86_400)
        )
        do {
            let enqueue = try await pendingResponseStore.enqueue(pending)
            switch enqueue {
            case .enqueued:
                responseFeedbackByNotificationID[notificationID] = NotificationResponseFeedback(
                    phase: .queued,
                    action: action
                )
            case .alreadyPending(let existing):
                responseFeedbackByNotificationID[notificationID] = NotificationResponseFeedback(
                    phase: .queued,
                    action: existing.action
                )
            case .alreadyNotificationConfirmed(let confirmation):
                responseFeedbackByNotificationID[notificationID] = NotificationResponseFeedback(
                    phase: .accepted,
                    action: confirmation.action,
                    canonicalState: confirmation.canonicalState
                )
                return
            case .alreadyConfirmed:
                throw LiveActivityResponseConfirmationError.responseMismatch
            }
            await flushPendingResponses()
        } catch {
            interactionError = "The response could not be protected locally. Nothing was sent or assumed."
            responseFeedbackByNotificationID[notificationID] = NotificationResponseFeedback(
                phase: .rejected,
                action: action,
                message: "Nothing was sent or assumed — retry"
            )
        }
    }

    func notificationResponseQueued(notificationID: String) async {
        await openNotification(notificationID: notificationID)
        await flushPendingResponses()
    }

    func notificationResponseFailed(
        notificationID: String,
        action: NotificationInteractionAction
    ) async {
        await openNotification(notificationID: notificationID)
        responseFeedbackByNotificationID[notificationID] = NotificationResponseFeedback(
            phase: .rejected,
            action: action,
            message: "The action could not be protected locally — retry in Relo"
        )
        interactionError = "The notification action could not be protected locally. Nothing was sent or assumed."
    }

    private func resolvePendingNotification() {
        guard
            let notificationID = pendingNotificationID,
            let item = (items + historySnapshot.items).first(where: { $0.id == notificationID }),
            let scopeIdentity = currentSyncScopeIdentity
        else { return }
        pendingNotificationID = nil
        selectedNotificationID = notificationID
        selectedItemSnapshot.select(item, scopeIdentity: scopeIdentity)
        Task { await recordOpened(notificationID: notificationID) }
    }

    private func resolvePendingActivity() {
        guard let identity = pendingActivityIdentity else { return }
        guard
            let item = (items + historySnapshot.items).first(where: {
                $0.liveActivity?.identity == identity
            }),
            let scopeIdentity = currentSyncScopeIdentity
        else { return }
        pendingActivityIdentity = nil
        pendingNotificationID = nil
        selectedNotificationID = item.id
        selectedItemSnapshot.select(item, scopeIdentity: scopeIdentity)
        Task { await recordOpened(notificationID: item.id) }
    }

    private func recordOpened(notificationID: String) async {
        guard let credential else { return }
        try? await apiClient.submitInteraction(
            credential: credential,
            notificationId: notificationID,
            action: .opened,
            value: [:],
            idempotencyKey: "ios:\(credential.installationId):\(notificationID):opened"
        )
    }

    private func applyPendingLiveActivityCommands(
        from items: [InboxItem],
        authoritativeLiveActivities: ActiveLiveActivityIdentityPage? = nil
    ) async {
        guard let credential else { return }
        do {
            let pending = try await liveActivityCoordinator.pending(
                items: items,
                targetDeviceID: credential.deviceId
            )
            let locallyActive = Set(
                Activity<ReloActivityAttributes>.activities
                    .filter { $0.attributes.accountID == selectedAccountId }
                    .map { $0.attributes.identity }
            )
            let recoveryPlan = LiveActivityReinstallationRecoveryPolicy.plan(
                pending: pending,
                authoritativeCommands: authoritativeLiveActivities?.activities.compactMap(\.recoveryEnvelope) ?? [],
                authoritativeActiveIdentities: Set(
                    authoritativeLiveActivities?.activities.map(\.identity) ?? []
                ),
                locallyActiveIdentities: locallyActive,
                now: .now
            )
            var blockedActivities = Set<LiveActivityIdentity>()
            for envelope in recoveryPlan.commands {
                guard !blockedActivities.contains(envelope.command.identity) else { continue }
                let isAuthoritativeRecovery = recoveryPlan.recoveryCommandKeys.contains(envelope.commandKey)
                    && !Activity<ReloActivityAttributes>.activities.contains {
                        $0.attributes.accountID == selectedAccountId
                            && $0.attributes.identity == envelope.command.identity
                    }
                let outcome = await applyLiveActivityCommand(
                    envelope,
                    allowsAuthoritativeRecovery: isAuthoritativeRecovery
                )
                guard outcome != .failed else {
                    blockedActivities.insert(envelope.command.identity)
                    continue
                }
                if outcome == .ignored {
                    try await liveActivityCoordinator.acknowledge(envelope)
                    continue
                }
                let alertScheduled = try await liveActivityCoordinator.isAlertScheduled(for: envelope)
                if !isAuthoritativeRecovery && envelope.command.requiresAppAlert && !alertScheduled {
                    guard await scheduleCompanionAlert(
                        envelope.command,
                        companionNotificationID: envelope.eventID
                    ) else {
                        blockedActivities.insert(envelope.command.identity)
                        continue
                    }
                    try await liveActivityCoordinator.acknowledgeAlertScheduled(for: envelope)
                }
                try await liveActivityCoordinator.acknowledge(envelope)
            }
        } catch {
            // The Inbox remains authoritative; an unacknowledged command is retried.
        }
    }

    private func applyLiveActivityCommand(
        _ envelope: LiveActivityCommandEnvelope,
        allowsAuthoritativeRecovery: Bool = false
    ) async -> LiveActivityApplicationOutcome {
        let command = envelope.command
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return .failed }
        guard let accountID = credential?.accountId else { return .failed }
        let presentation = command.presentation
        let display = command.lockScreenDisplay

        let state = ReloActivityAttributes.ContentState(
            generation: command.generation,
            updatedAt: envelope.createdAt,
            sequence: command.sequence ?? 0,
            expiresAt: command.expiresAt,
            staleAt: command.staleAt,
            interaction: display.allowsInteraction ? command.interaction.map {
                ReloActivityAttributes.Interaction(
                    id: $0.id,
                    notificationID: $0.notificationId,
                    targetDeviceID: command.targetDeviceId,
                    accountID: accountID,
                    kind: $0.kind.rawValue,
                    state: $0.state.rawValue,
                    credential: $0.credential,
                    expiresAtUnixSeconds: Int64($0.expiresAt.timeIntervalSince1970.rounded(.down))
                )
            } : nil,
            presentation: presentation
        )
        let fallbackStaleDate = Date().addingTimeInterval(600)
        let staleDate = command.staleAt
            ?? command.expiresAt.map { min($0, fallbackStaleDate) }
            ?? fallbackStaleDate
        let content = ActivityContent(
            state: state,
            staleDate: staleDate,
            relevanceScore: command.relevanceScore
        )
        guard let expected = liveActivitySnapshot(
            activityID: command.activityId,
            generation: command.generation,
            state: state,
            isTerminal: command.operation == .end
        ) else { return .failed }
        do {
            let activities = Activity<ReloActivityAttributes>.activities
            let existing = activities.first {
                $0.attributes.identity == command.identity
            }
            if existing == nil,
               activities.contains(where: {
                   $0.attributes.eventID == command.activityId
                       && $0.attributes.generation > command.generation
               }) {
                return .ignored
            }
            let observed = existing.flatMap(liveActivitySnapshot)
            if try await liveActivityCoordinator.applicationJournal(for: envelope) == nil {
                switch command.operation {
                case .start:
                    if existing != nil {
                        guard let observed else { return .failed }
                        let incomingSequence = command.sequence ?? 0
                        if incomingSequence == observed.sequence, observed == expected {
                            try await liveActivityCoordinator.recordExactConvergenceSuccess(
                                for: envelope,
                                observed: observed,
                                expected: expected
                            )
                            return .alreadyCurrent
                        }
                        switch LiveActivityCommandOrderingPolicy.evaluate(
                            operation: command.operation,
                            incomingSequence: incomingSequence,
                            incomingTimestamp: envelope.createdAt,
                            expiresAt: command.expiresAt,
                            observedSequence: observed.sequence,
                            observedTimestamp: existing?.content.state.updatedAt ?? .distantPast,
                            now: .now
                        ) {
                        case .apply: break
                        case .stale: return .ignored
                        case .conflict: return .failed
                        }
                    } else {
                        if try await liveActivityCoordinator.recordObservedSystemConvergenceSuccess(
                            for: envelope,
                            expected: expected
                        ) {
                            return .alreadyCurrent
                        }
                        guard allowsAuthoritativeRecovery || command.permitsLocalStart else { return .failed }
                        guard LiveActivityCommandOrderingPolicy.permitsInitialStart(
                            sequence: command.sequence ?? 0,
                            timestamp: envelope.createdAt,
                            expiresAt: command.expiresAt,
                            now: .now
                        ) else { return .ignored }
                    }
                case .update:
                    guard existing != nil else {
                        if try await liveActivityCoordinator.recordObservedSystemConvergenceSuccess(
                            for: envelope,
                            expected: expected
                        ) {
                            return .alreadyCurrent
                        }
                        guard allowsAuthoritativeRecovery || command.permitsLocalRecovery else { return .failed }
                        guard LiveActivityCommandOrderingPolicy.permitsInitialStart(
                            sequence: command.sequence ?? 0,
                            timestamp: envelope.createdAt,
                            expiresAt: command.expiresAt,
                            now: .now
                        ) else { return .ignored }
                        break
                    }
                    guard let observed else { return .failed }
                    let incomingSequence = command.sequence ?? 0
                    if incomingSequence == observed.sequence, observed == expected {
                        try await liveActivityCoordinator.recordExactConvergenceSuccess(
                            for: envelope,
                            observed: observed,
                            expected: expected
                        )
                        return .alreadyCurrent
                    }
                    switch LiveActivityCommandOrderingPolicy.evaluate(
                        operation: command.operation,
                        incomingSequence: incomingSequence,
                        incomingTimestamp: envelope.createdAt,
                        expiresAt: command.expiresAt,
                        observedSequence: observed.sequence,
                        observedTimestamp: existing?.content.state.updatedAt ?? .distantPast,
                        now: .now
                    ) {
                    case .apply: break
                    case .stale: return .ignored
                    case .conflict: return .failed
                    }
                case .end:
                    guard existing != nil else {
                        if try await liveActivityCoordinator.recordObservedSystemConvergenceSuccess(
                            for: envelope,
                            expected: expected
                        ) {
                            return .alreadyCurrent
                        }
                        return .ignored
                    }
                    guard let observed else { return .failed }
                    if observed == expected, observed.isTerminal {
                        try await liveActivityCoordinator.recordExactConvergenceSuccess(
                            for: envelope,
                            observed: observed,
                            expected: expected
                        )
                        return .alreadyCurrent
                    }
                    if observed.isTerminal { return .ignored }
                    switch LiveActivityCommandOrderingPolicy.evaluate(
                        operation: command.operation,
                        incomingSequence: command.sequence ?? 0,
                        incomingTimestamp: envelope.createdAt,
                        expiresAt: command.expiresAt,
                        observedSequence: observed.sequence,
                        observedTimestamp: existing?.content.state.updatedAt ?? .distantPast,
                        now: .now
                    ) {
                    case .apply: break
                    case .stale: return .ignored
                    case .conflict: return .failed
                    }
                }
            }
            return await performJournaledLiveActivityMutation(
                envelope,
                accountID: accountID,
                existing: existing,
                content: content,
                expected: expected,
                priorActive: command.operation == .end ? observed : nil,
                observed: observed,
                allowsAuthoritativeRecovery: allowsAuthoritativeRecovery
            )
        } catch {
            return .failed
        }
    }

    private func performJournaledLiveActivityMutation(
        _ envelope: LiveActivityCommandEnvelope,
        accountID: String,
        existing: Activity<ReloActivityAttributes>?,
        content: ActivityContent<ReloActivityAttributes.ContentState>,
        expected: LiveActivitySystemSnapshot,
        priorActive: LiveActivitySystemSnapshot?,
        observed: LiveActivitySystemSnapshot?,
        allowsAuthoritativeRecovery: Bool
    ) async -> LiveActivityApplicationOutcome {
        let command = envelope.command
        return await LiveActivityApplicationOrchestrator.apply(
            coordinator: liveActivityCoordinator,
            envelope: envelope,
            expected: expected,
            priorActive: priorActive,
            observed: observed
        ) {
            switch command.operation {
            case .start:
                if let existing {
                    await existing.update(content)
                } else {
                    let display = command.lockScreenDisplay
                    let style = ReloActivityAttributes.Style(rawValue: display.style) ?? .standard
                    let attributes = ReloActivityAttributes(
                        eventID: command.activityId,
                        generation: command.generation,
                        sourceName: display.sourceName,
                        style: style,
                        accountID: accountID
                    )
                    let activity = try Activity<ReloActivityAttributes>.request(
                        attributes: attributes,
                        content: content,
                        pushType: .token
                    )
                    observePushTokenUpdates(for: activity)
                    observeActivityKitUpdates(for: activity)
                    await registerCurrentPushToken(for: activity)
                }
            case .update:
                if let existing {
                    await existing.update(content)
                } else if allowsAuthoritativeRecovery || command.permitsLocalRecovery {
                    let display = command.lockScreenDisplay
                    let style = ReloActivityAttributes.Style(rawValue: display.style) ?? .standard
                    let attributes = ReloActivityAttributes(
                        eventID: command.activityId,
                        generation: command.generation,
                        sourceName: display.sourceName,
                        style: style,
                        accountID: accountID
                    )
                    let activity = try Activity<ReloActivityAttributes>.request(
                        attributes: attributes,
                        content: content,
                        pushType: .token
                    )
                    observePushTokenUpdates(for: activity)
                    observeActivityKitUpdates(for: activity)
                    await registerCurrentPushToken(for: activity)
                } else {
                    throw LiveActivityCommandCoordinatorError.missingActivity
                }
            case .end:
                guard let existing else { throw LiveActivityCommandCoordinatorError.missingActivity }
                let dismissal: ActivityUIDismissalPolicy = if let seconds = command.dismissAfterSeconds, seconds > 0 {
                    .after(.now.addingTimeInterval(TimeInterval(seconds)))
                } else {
                    .immediate
                }
                await existing.end(content, dismissalPolicy: dismissal)
            }
        }
    }

    private func liveActivitySnapshot(
        _ activity: Activity<ReloActivityAttributes>
    ) -> LiveActivitySystemSnapshot? {
        liveActivitySnapshot(
            activityID: activity.attributes.eventID,
            generation: activity.attributes.generation,
            state: activity.content.state,
            isTerminal: activity.activityState == .ended || activity.activityState == .dismissed
        )
    }

    private func liveActivitySnapshot(
        activityID: String,
        generation: Int,
        state: ReloActivityAttributes.ContentState,
        isTerminal: Bool
    ) -> LiveActivitySystemSnapshot? {
        guard state.generation == generation else { return nil }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(LiveActivityContentDigestPayload(state)) else { return nil }
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        return LiveActivitySystemSnapshot(
            activityID: activityID,
            generation: generation,
            sequence: state.sequence,
            contentDigest: digest,
            isTerminal: isTerminal
        )
    }

    private func scheduleCompanionAlert(
        _ command: LiveActivityCommand,
        companionNotificationID: String
    ) async -> Bool {
        let display = command.lockScreenDisplay
        let notification = UNMutableNotificationContent()
        notification.title = display.headline
        notification.body = [display.status, display.detail].compactMap { $0 }.joined(separator: " · ")
        notification.sound = .default
        notification.threadIdentifier = "relo-live-activities"
        if display.allowsInteraction, let interaction = command.interaction {
            notification.categoryIdentifier = switch interaction.kind {
            case .approval: "RELO_APPROVAL"
            case .yesNo: "RELO_YES_NO"
            case .text: "RELO_TEXT"
            }
        }
        notification.userInfo = [
            "relo": ["notificationId": command.interaction?.notificationId ?? companionNotificationID]
        ]
        let request = UNNotificationRequest(
            identifier: "\(companionNotificationID).live-activity-companion",
            content: notification,
            trigger: nil
        )
        do {
            try await UNUserNotificationCenter.current().add(request)
            return true
        } catch {
            return false
        }
    }

    private func flushPendingResponses() async {
        guard let credential else { return }
        let expectedAccessToken = credential.accessToken
        let accountID = credential.accountId
        let liveActivityResponseFile = try? LiveActivityResponseStorage.responseQueue()
        if
            let confirmations = try? liveActivityResponseFile?.confirmations(
                accountID: accountID,
                deviceID: credential.deviceId,
                now: .now
            )
        {
            await LiveActivityResponseReplayCoordinator.replay(confirmations) { confirmation, presentedAt in
                _ = await LiveActivityResponseActivityPresenter.present(
                    confirmation,
                    presentedAt: presentedAt
                )
            }
        }
        let pending: [PendingNotificationResponse]
        do {
            let confirmations = try await pendingResponseStore.notificationConfirmations(now: .now)
            for confirmation in confirmations where confirmation.deviceID == credential.deviceId
                && confirmation.accountID == credential.accountId {
                responseFeedbackByNotificationID[confirmation.notificationID] = NotificationResponseFeedback(
                    phase: .accepted,
                    action: confirmation.action,
                    canonicalState: confirmation.canonicalState
                )
            }
            pending = try await pendingResponseStore.pending(now: .now)
            queuedResponseNotificationIDs = Set(
                pending.compactMap { response in
                    response.deviceID == credential.deviceId && response.accountID == credential.accountId
                        ? response.notificationID
                        : nil
                }
            )
            for response in pending where response.deviceID == credential.deviceId
                && response.accountID == credential.accountId {
                responseFeedbackByNotificationID[response.notificationID] = NotificationResponseFeedback(
                    phase: .queued,
                    action: response.action
                )
            }
        } catch {
            interactionError = "Protected queued responses could not be opened."
            return
        }
        for response in pending where response.deviceID == credential.deviceId
            && response.accountID == credential.accountId {
            guard self.credential?.accessToken == expectedAccessToken else { return }
            do {
                switch response.endpoint {
                case .notification:
                    try await apiClient.submitInteraction(
                        credential: credential,
                        notificationId: response.notificationID,
                        action: response.action,
                        value: response.value,
                        idempotencyKey: response.idempotencyKey
                    )
                    guard self.credential?.accessToken == expectedAccessToken else { return }
                    let confirmation = try await pendingResponseStore.confirmNotification(
                        response,
                        confirmedAt: .now
                    )
                    responseFeedbackByNotificationID[response.notificationID] = NotificationResponseFeedback(
                        phase: .accepted,
                        action: confirmation.action,
                        canonicalState: confirmation.canonicalState
                    )
                    interactionError = nil
                case .liveActivity:
                    guard let liveActivityResponseFile else {
                        throw LiveActivityResponseTransport.SubmissionError.invalidConfiguration
                    }
                    let outcome = await LiveActivityResponseIntentOrchestrator.retry(
                        response,
                        queue: liveActivityResponseFile,
                        submit: LiveActivityResponseTransport.submit,
                        present: LiveActivityResponseActivityPresenter.present
                    )
                    switch outcome {
                    case .accepted, .duplicateConfirmed:
                        break
                    case .queued, .duplicatePending:
                        interactionError = "Response queued securely. Relo will retry when Relo server is reachable."
                        return
                    case .rejected:
                        queuedResponseNotificationIDs.remove(response.notificationID)
                        interactionError = "A queued Live Activity response expired or was rejected."
                    }
                }
                queuedResponseNotificationIDs.remove(response.notificationID)
            } catch LiveActivityResponseTransport.SubmissionError.rejected {
                try? await pendingResponseStore.remove(id: response.id)
                queuedResponseNotificationIDs.remove(response.notificationID)
                if response.endpoint == .liveActivity {
                    await LiveActivityResponseActivityPresenter.present(
                        LiveActivityResponsePresentationCommand(
                            phase: .rejected,
                            response: response,
                            canonicalState: nil,
                            presentedAt: .now
                        )
                    )
                }
                interactionError = "A queued Live Activity response expired or was rejected."
            } catch MobileAPIError.idempotencyConflict {
                try? await pendingResponseStore.remove(id: response.id)
                queuedResponseNotificationIDs.remove(response.notificationID)
                responseFeedbackByNotificationID[response.notificationID] = NotificationResponseFeedback(
                    phase: .rejected,
                    action: response.action,
                    message: "Already answered or expired — refresh before retrying"
                )
                interactionError = "This request was already answered or has expired."
            } catch MobileAPIError.invalidRequest {
                let resolution = await PendingResponseQueueFailureHandler.handle(
                    .invalidRequest,
                    response: response,
                    store: pendingResponseStore
                )
                if resolution == .discardedInvalidResponse {
                    queuedResponseNotificationIDs.remove(response.notificationID)
                    responseFeedbackByNotificationID[response.notificationID] = NotificationResponseFeedback(
                        phase: .rejected,
                        action: response.action,
                        message: "Invalid response — retry in Relo"
                    )
                    interactionError = "This queued response was rejected as invalid and will not be retried."
                } else {
                    interactionError = "The rejected response could not be removed from the protected queue. Relo will try again."
                    return
                }
            } catch MobileAPIError.reauthenticationRequired, MobileAPIError.forbidden {
                try? await pendingResponseStore.remove(id: response.id)
                await handleRevokedDeviceCredential()
                interactionError = "This iPhone must be registered again before responding."
                return
            } catch {
                if response.endpoint == .liveActivity {
                    await LiveActivityResponseActivityPresenter.present(
                        LiveActivityResponsePresentationCommand(
                            phase: .queued,
                            response: response,
                            canonicalState: nil,
                            presentedAt: .now
                        )
                    )
                }
                responseFeedbackByNotificationID[response.notificationID] = NotificationResponseFeedback(
                    phase: .queued,
                    action: response.action
                )
                interactionError = "Response queued securely. Relo will retry when Relo server is reachable."
                return
            }
        }
    }

    private func flushNotificationReceipts(authoritativeNotificationIDs: Set<String>) async {
        guard let credential, let expectedScope = currentSyncScopeIdentity else { return }
        let notificationIDs = NotificationReceiptScopePolicy.eligible(
            pendingNotificationIDs: notificationReceiptStore.pending(limit: 200),
            authoritativeNotificationIDs: authoritativeNotificationIDs
        ).prefix(25)
        var completed = Set<String>()

        for notificationID in notificationIDs {
            guard expectedScope == currentSyncScopeIdentity,
                  self.credential?.accessToken == credential.accessToken
            else { return }
            do {
                try await apiClient.submitInteraction(
                    credential: credential,
                    notificationId: notificationID,
                    action: .received,
                    value: [:],
                    idempotencyKey: "ios:\(credential.installationId):\(notificationID):received"
                )
                completed.insert(notificationID)
            } catch MobileAPIError.idempotencyConflict {
                completed.insert(notificationID)
            } catch MobileAPIError.reauthenticationRequired, MobileAPIError.forbidden {
                notificationReceiptStore.remove(notificationIDs: completed)
                guard self.credential?.accessToken == credential.accessToken else { return }
                await handleRevokedDeviceCredential()
                return
            } catch {
                break
            }
        }

        guard expectedScope == currentSyncScopeIdentity,
              self.credential?.accessToken == credential.accessToken
        else { return }
        notificationReceiptStore.remove(notificationIDs: completed)
    }

    private func flushLiveActivityReceipts() async {
        guard
            let credential,
            let expectedScope = currentSyncScopeIdentity
        else { return }
        let eventIDs: [String]
        do {
            eventIDs = try await liveActivityCoordinator.pendingReceivedEventIDs(limit: 25)
        } catch {
            return
        }
        var completed = Set<String>()

        for eventID in eventIDs {
            guard
                expectedScope == currentSyncScopeIdentity,
                self.credential?.accessToken == credential.accessToken
            else { return }
            do {
                try await apiClient.submitInteraction(
                    credential: credential,
                    notificationId: eventID,
                    action: .received,
                    value: [:],
                    idempotencyKey: "ios:\(credential.installationId):\(eventID):received"
                )
                completed.insert(eventID)
            } catch MobileAPIError.idempotencyConflict {
                completed.insert(eventID)
            } catch MobileAPIError.reauthenticationRequired, MobileAPIError.forbidden {
                if expectedScope == currentSyncScopeIdentity {
                    try? await liveActivityCoordinator.removeReceivedEventIDs(completed)
                }
                guard self.credential?.accessToken == credential.accessToken else { return }
                await handleRevokedDeviceCredential()
                return
            } catch {
                break
            }
        }

        guard
            expectedScope == currentSyncScopeIdentity,
            self.credential?.accessToken == credential.accessToken
        else { return }
        try? await liveActivityCoordinator.removeReceivedEventIDs(completed)
    }

    private func flushLiveActivityDismissals() async {
        guard
            let credential,
            let expectedScope = currentSyncScopeIdentity
        else { return }
        let identities: [LiveActivityIdentity]
        do {
            identities = try await liveActivityCoordinator.pendingDismissedActivityIdentities(limit: 25)
        } catch {
            return
        }
        var completed = Set<LiveActivityIdentity>()
        for identity in identities {
            guard
                expectedScope == currentSyncScopeIdentity,
                self.credential?.accessToken == credential.accessToken
            else { return }
            do {
                try await apiClient.reportLiveActivityDismissed(
                    credential: credential,
                    activityId: identity.activityID
                )
                completed.insert(identity)
            } catch MobileAPIError.invalidRequest {
                completed.insert(identity)
            } catch MobileAPIError.reauthenticationRequired, MobileAPIError.forbidden {
                try? await liveActivityCoordinator.removeDismissedActivityIdentities(completed)
                guard self.credential?.accessToken == credential.accessToken else { return }
                await handleRevokedDeviceCredential()
                return
            } catch {
                break
            }
        }
        guard expectedScope == currentSyncScopeIdentity else { return }
        try? await liveActivityCoordinator.removeDismissedActivityIdentities(completed)
    }

    func sendHeartbeat() async {
        guard let credential else { return }
        if let prerequisite = registrationPrerequisite(hasAuthenticatedAccount: true) {
            registrationState = prerequisite
            return
        }
        guard let apnsToken = try? pushTokenStore.load() else {
            registrationState = .waitingForAPNSToken
            return
        }

        let wasReady = registrationState == .registered && serverAcceptedCurrentAPNSToken
        if !wasReady { registrationState = .registering }

        do {
            try await apiClient.heartbeat(
                credential: credential,
                heartbeat: try makeHeartbeat(credential: credential, apnsToken: apnsToken)
            )
            serverAcceptedCurrentAPNSToken = apnsTokenAvailable
                && (try? pushTokenStore.load()) == apnsToken
            registrationState = serverAcceptedCurrentAPNSToken ? .registered : .waitingForAPNSToken
        } catch MobileAPIError.reauthenticationRequired, MobileAPIError.forbidden {
            await handleRevokedDeviceCredential()
        } catch {
            if !wasReady {
                registrationState = .failed("Relo server could not confirm this iPhone's current Apple Push token. Retry when connected.")
            }
        }
    }

    func pushRegistrationChanged() async {
        pushRegistrationError = UserDefaults.standard.string(forKey: "relo.apnsRegistrationError")
        let cachedTokenAvailable = (try? pushTokenStore.load()) != nil
        if pushRegistrationError == nil {
            apnsTokenState = apnsTokenState.receivingCurrentToken(
                persistedTokenAvailable: cachedTokenAvailable
            )
        } else {
            apnsTokenState = apnsTokenState.registrationFailed(
                cachedTokenAvailable: cachedTokenAvailable
            )
        }
        serverAcceptedCurrentAPNSToken = false
        if accountSession != nil {
            await registerDevice(force: true)
        } else {
            await sendHeartbeat()
        }
    }

    func foregrounded() async {
        await updatePermission()
        await synchronizeLiveActivityTokens()
        if accountSession != nil {
            await registerDevice()
        } else {
            await sendHeartbeat()
            await refresh()
        }
        await refreshDeliveryTransportStatus()
    }

    private func refreshDeliveryTransportStatus(force: Bool = false) async {
        guard let accountSession else {
            deliveryTransportStatus = nil
            deliveryTransportStatusError = nil
            deliveryStatusScopeIdentity = nil
            deliveryStatusLastAttemptAt = nil
            return
        }
        let expectedScope = "\(accountSession.sessionId)|\(accountSession.user.id)"
        if deliveryStatusScopeIdentity != expectedScope {
            deliveryTransportStatus = nil
            deliveryTransportStatusError = nil
            deliveryStatusScopeIdentity = expectedScope
            deliveryStatusLastAttemptAt = nil
        }
        let now = Date.now
        if !force,
           let lastAttempt = deliveryStatusLastAttemptAt,
           now.timeIntervalSince(lastAttempt) < 60 {
            return
        }
        deliveryStatusLastAttemptAt = now
        do {
            let status = try await apiClient.deliveryTransportStatus(
                sessionToken: accountSession.accessToken
            )
            guard
                self.accountSession?.sessionId == accountSession.sessionId,
                self.accountSession?.user.id == accountSession.user.id,
                deliveryStatusScopeIdentity == expectedScope
            else { return }
            deliveryTransportStatus = status
            deliveryTransportStatusError = nil
        } catch {
            guard
                self.accountSession?.sessionId == accountSession.sessionId,
                self.accountSession?.user.id == accountSession.user.id,
                deliveryStatusScopeIdentity == expectedScope
            else { return }
            deliveryTransportStatusError = DeliveryTransportStatusErrorGuidance.message(for: error)
        }
    }

    func signOut() async -> Bool {
        signOutError = nil
        authenticationError = nil
        guard credential != nil || accountSession != nil else { return true }
        registrationRecoveryTask?.cancel()
        registrationRecoveryTask = nil
        accountState = .signingOut
        await quiesceRefresh()

        do {
            let deviceID = credential?.deviceId
            let sessionID = accountSession?.sessionId
            var progress = try signOutProgressStore.load()
            if progress?.deviceId != deviceID || progress?.sessionId != sessionID {
                progress = SignOutProgress(
                    deviceId: deviceID,
                    sessionId: sessionID,
                    deviceRevoked: credential == nil,
                    sessionRevoked: accountSession == nil
                )
                try signOutProgressStore.save(progress!)
            }
            if progress?.deviceRevoked != true, let credential {
                try await apiClient.revokeDevice(credential: credential)
                progress = progress?.recordingDeviceRevocation()
                try signOutProgressStore.save(progress!)
            }
            await endAllLiveActivities()
            if progress?.sessionRevoked != true, let accountSession {
                try await apiClient.signOutAccount(sessionToken: accountSession.accessToken)
                progress = progress?.recordingSessionRevocation()
                try signOutProgressStore.save(progress!)
            }
            let currentAccountId = accountSession?.account?.accountId ?? credential?.accountId
            if selectedAccountId != nil, selectedAccountId == currentAccountId {
                try await cache.clearSelectedAccount()
            }
            try credentialStore.delete()
            try accountSessionStore.delete()
            try registrationAttemptStore.delete()
            try? await UNUserNotificationCenter.current().setBadgeCount(0)
            self.accountSession = nil
            self.deliveryTransportStatus = nil
            self.deliveryTransportStatusError = nil
            self.deliveryStatusScopeIdentity = nil
            self.deliveryStatusLastAttemptAt = nil
            self.credential = nil
            self.account = nil
            self.accountUser = nil
            self.items = []
            clearHistory()
            self.lastSyncedAt = nil
            self.syncEngine = nil
            self.configuredSyncScopeIdentity = nil
            self.selectedAccountId = nil
            self.selectedNotificationID = nil
            self.pendingNotificationID = nil
            self.pendingActivityIdentity = nil
            self.queuedResponseNotificationIDs = []
            self.responseFeedbackByNotificationID = [:]
            self.serverAcceptedCurrentAPNSToken = false
            self.syncState = .idle
            self.registrationState = .idle
            self.accountState = .signedOut
            try? await liveActivityCoordinator.clearSelectedAccount()
            try? await pendingResponseStore.clearSelectedAccount()
            let pendingReceipts = Set(notificationReceiptStore.pending(limit: Int.max))
            notificationReceiptStore.remove(notificationIDs: pendingReceipts)
            try signOutProgressStore.delete()
            return true
        } catch {
            accountState = credential == nil ? .signedOut : .signedIn
            signOutError = "Sign-out paused after its last confirmed step. Retry to resume safely; completed revocations will not be repeated."
            return false
        }
    }

    func clearAccountDeletionError() {
        accountDeletionError = nil
    }

    func deleteAccount(password: String, confirmation: String) async -> Bool {
        accountDeletionError = nil
        guard !isDeletingAccount else { return false }
        guard AccountDeletionConfirmationPolicy.isValid(
            password: password,
            confirmation: confirmation
        ) else {
            accountDeletionError = "Enter your 8–128 character password and type DELETE exactly. Nothing was removed."
            return false
        }
        guard let accountSession else {
            accountDeletionError = "Sign in again before deleting this account. Nothing was removed."
            return false
        }
        await quiesceRefresh()

        isDeletingAccount = true
        defer { isDeletingAccount = false }

        do {
            try await apiClient.deleteAccount(
                sessionToken: accountSession.accessToken,
                password: password,
                confirmation: AccountDeletionConfirmationPolicy.requiredConfirmation
            )
        } catch {
            accountDeletionError = AccountDeletionErrorGuidance.message(for: error)
            return false
        }

        await endAllLiveActivities()
        var localCleanupFailed = false
        let accountID = selectedAccountId ?? accountSession.account?.accountId ?? credential?.accountId
        if let accountID {
            do {
                try await cache.select(accountId: accountID)
                try await cache.clearSelectedAccount()
            } catch { localCleanupFailed = true }
            if let deviceID = credential?.deviceId {
                do {
                    try await liveActivityCoordinator.select(accountID: accountID, deviceID: deviceID)
                    try await liveActivityCoordinator.clearSelectedAccount()
                } catch { localCleanupFailed = true }
                do {
                    try await pendingResponseStore.select(accountID: accountID, deviceID: deviceID)
                    try await pendingResponseStore.clearSelectedAccount()
                } catch { localCleanupFailed = true }
            }
        }
        do { try credentialStore.delete() } catch { localCleanupFailed = true }
        do { try accountSessionStore.delete() } catch { localCleanupFailed = true }
        do { try registrationAttemptStore.delete() } catch { localCleanupFailed = true }
        let pendingReceipts = Set(notificationReceiptStore.pending(limit: Int.max))
        notificationReceiptStore.remove(notificationIDs: pendingReceipts)
        do {
            try await AccountDeletionNotificationCleanup.perform(using: accountNotificationCleaner)
        } catch {
            localCleanupFailed = true
        }

        self.accountSession = nil
        self.deliveryTransportStatus = nil
        self.deliveryTransportStatusError = nil
        self.deliveryStatusScopeIdentity = nil
        self.deliveryStatusLastAttemptAt = nil
        self.credential = nil
        self.account = nil
        self.accountUser = nil
        self.items = []
        clearHistory()
        self.lastSyncedAt = nil
        self.syncEngine = nil
        self.configuredSyncScopeIdentity = nil
        self.selectedAccountId = nil
        self.selectedNotificationID = nil
        self.respondingNotificationID = nil
        self.interactionError = nil
        self.signOutError = nil
        self.pendingNotificationID = nil
        self.pendingActivityIdentity = nil
        self.queuedResponseNotificationIDs = []
        self.responseFeedbackByNotificationID = [:]
        self.serverAcceptedCurrentAPNSToken = false
        self.syncState = .idle
        self.registrationState = .idle
        self.accountState = .signedOut

        if localCleanupFailed {
            authenticationError = "The Relo server account was deleted, but iOS could not verify every local cleanup step. Restart Relo before signing in again."
        }
        return true
    }

    private func performRegistration() async {
        enum Stage {
            case localRegistrationData
            case network
            case credentialStore
            case accountSessionStore
        }
        guard let accountSession else { return }
        authenticationError = nil
        if let prerequisite = registrationPrerequisite(hasAuthenticatedAccount: true) {
            registrationState = prerequisite
            return
        }
        registrationState = .registering
        var stage = Stage.localRegistrationData

        do {
            if let sessionAccountID = accountSession.account?.accountId,
               let credentialAccountID = credential?.accountId,
               sessionAccountID != credentialAccountID {
                try await retireCurrentDeviceBinding()
            }
            let request = try makeRegistrationRequest()
            let attempt = try registrationAttemptStore.attempt(
                for: request,
                minimumRevision: (credential?.credentialVersion ?? 0) + 1
            )
            stage = .network
            let response = try await apiClient.registerDevice(
                sessionToken: accountSession.accessToken,
                request: request,
                idempotencyKey: attempt.idempotencyKey(installationId: request.installationId)
            )
            await quiesceRefresh()
            serverAcceptedCurrentAPNSToken = apnsTokenAvailable
                && request.apnsToken != nil
                && (try? pushTokenStore.load()) == request.apnsToken

            let previousAccountId = credential?.accountId
            let responseIsNewer = previousAccountId != response.account.accountId
                || response.device.credentialVersion > (credential?.credentialVersion ?? 0)
            if responseIsNewer {
                stage = .credentialStore
                let newCredential = DeviceCredential(
                    deviceId: response.device.deviceId,
                    installationId: response.device.installationId,
                    accessToken: response.credential.accessToken,
                    issuedAt: response.credential.issuedAt,
                    expiresAt: response.credential.expiresAt,
                    accountId: response.account.accountId,
                    credentialVersion: response.device.credentialVersion
                )
                try credentialStore.save(newCredential)
                credential = newCredential
            }

            stage = .accountSessionStore
            let updatedSession = accountSession.attaching(account: response.account)
            try accountSessionStore.save(updatedSession)
            self.accountSession = updatedSession
            self.account = response.account
            self.accountUser = updatedSession.user
            self.accountState = .signedIn

            let switchedAccounts = previousAccountId != nil && previousAccountId != response.account.accountId
            do {
                try await cache.select(accountId: response.account.accountId)
                try await liveActivityCoordinator.select(
                    accountID: response.account.accountId,
                    deviceID: response.device.deviceId
                )
                try await pendingResponseStore.select(
                    accountID: response.account.accountId,
                    deviceID: response.device.deviceId
                )
                selectedAccountId = response.account.accountId
                let snapshot = try await cache.load()
                items = snapshot.items
                useCachedHistory(snapshot.items)
                await updateApplicationBadge()
                lastSyncedAt = snapshot.lastSuccessfulSyncAt
                resolvePendingNotification()
                resolvePendingActivity()
            } catch {
                try? await cache.clearSelectedAccount()
                items = []
                clearHistory()
                lastSyncedAt = nil
                syncState = .offline("Local cache migration failed; history will resynchronize from Relo server")
            }
            if switchedAccounts {
                syncState = .idle
            }
            do {
                try registrationAttemptStore.recordRegistrationSuccess()
            } catch {
                // Registration-attempt bookkeeping is disposable. Never retain a
                // stale retry deadline after the server accepted registration.
                try? registrationAttemptStore.delete()
            }
            registrationRecoveryTask?.cancel()
            registrationRecoveryTask = nil
            registrationState = .registered
            await configureSyncEngine()
            await synchronizeLiveActivityTokens()
            await refresh()
        } catch MobileAPIError.reauthenticationRequired {
            accountState = .reauthenticationRequired
            registrationState = .failed("Sign in again to register this iPhone.")
        } catch MobileAPIError.accountDisabled {
            accountState = .disabled
            registrationState = .failed("This Relo server account is disabled.")
        } catch MobileAPIError.tailnetUnavailable {
            registrationState = .failed("Tailnet unavailable. Connect Tailscale, then retry device registration.")
            scheduleRegistrationRecoveryAfterFailure()
        } catch MobileAPIError.idempotencyConflict {
            try? registrationAttemptStore.advanceCurrentAttempt()
            registrationState = .failed("Registration changed while it was being saved. Relo will retry automatically.")
            scheduleRegistrationRecoveryAfterFailure()
        } catch MobileAPIError.invalidRequest {
            registrationState = .failed("Registration rejected. Relo server did not accept this device's registration details.")
        } catch MobileAPIError.invalidResponse {
            registrationState = .failed("Registration rejected because Relo server returned an unreadable response.")
        } catch MobileAPIError.rateLimited(let seconds) {
            let suffix = seconds.map { " Try again in \($0) seconds." } ?? " Try again shortly."
            registrationState = .failed("Relo server is limiting registration requests.\(suffix)")
            scheduleRegistrationRecoveryAfterFailure(retryAfter: seconds.map(TimeInterval.init))
        } catch MobileAPIError.unavailable {
            registrationState = .failed("Relo server is reachable by configuration, but the registration server is unavailable.")
            scheduleRegistrationRecoveryAfterFailure()
        } catch {
            switch stage {
            case .localRegistrationData, .credentialStore:
                registrationState = .failed("The local device credential store is unreadable. Registration was not completed.")
            case .accountSessionStore:
                registrationState = .failed("The protected account session store is unreadable. Sign in again before registering.")
            case .network:
                registrationState = .failed("The registration server failed unexpectedly.")
                scheduleRegistrationRecoveryAfterFailure()
            }
        }
    }

    private func retireCurrentDeviceBinding() async throws {
        guard let credential else { return }
        await quiesceRefresh()
        try await apiClient.revokeDevice(credential: credential)
        await endAllLiveActivities()
        try credentialStore.delete()
        try? await liveActivityCoordinator.clearSelectedAccount()
        try? await pendingResponseStore.clearSelectedAccount()
        let pendingReceipts = Set(notificationReceiptStore.pending(limit: Int.max))
        notificationReceiptStore.remove(notificationIDs: pendingReceipts)
        self.credential = nil
        queuedResponseNotificationIDs = []
        responseFeedbackByNotificationID = [:]
        syncEngine = nil
        configuredSyncScopeIdentity = nil
        clearHistory()
        registrationState = .idle
        serverAcceptedCurrentAPNSToken = false
        selectedNotificationID = nil
        pendingNotificationID = nil
    }

    private func endAllLiveActivities() async {
        for activity in Activity<ReloActivityAttributes>.activities {
            var state = activity.content.state
            state.interaction = nil
            state.updatedAt = .now
            await activity.end(
                ActivityContent(state: state, staleDate: nil),
                dismissalPolicy: .immediate
            )
        }
    }

    private func selectAndLoadCache(accountId: String) async {
        do {
            try await cache.select(accountId: accountId)
            selectedAccountId = accountId
            if let credential {
                try await liveActivityCoordinator.select(accountID: accountId, deviceID: credential.deviceId)
                try await pendingResponseStore.select(accountID: accountId, deviceID: credential.deviceId)
            }
            let snapshot = try await cache.load()
            items = snapshot.items
            useCachedHistory(snapshot.items)
            await updateApplicationBadge()
            lastSyncedAt = snapshot.lastSuccessfulSyncAt
            resolvePendingNotification()
            resolvePendingActivity()
            if credential != nil { registrationState = .registered }
        } catch {
            syncState = .offline("Protected activity history could not be opened")
        }
    }

    private func configureSyncEngine() async {
        guard
            let credential,
            credential.accountId == selectedAccountId,
            let scopeIdentity = currentSyncScopeIdentity
        else { return }
        let accountID = credential.accountId
        let boundCache: any InboxCache
        do {
            boundCache = try await cache.boundCache(for: accountID)
        } catch {
            syncState = .offline("Protected activity history could not be opened")
            return
        }
        guard scopeIdentity == currentSyncScopeIdentity else { return }
        if configuredSyncScopeIdentity != scopeIdentity {
            selectedNotificationID = nil
            selectedItemSnapshot.dismiss()
        }
        let remote = HTTPInboxDataSource(baseURL: serverURL, token: credential.accessToken)
        inboxRemote = remote
        syncEngine = InboxSyncEngine(remote: remote, cache: boundCache)
        configuredSyncScopeIdentity = scopeIdentity
        historyPager = InboxHistoryPager(remote: remote)
        historyScopeRevision += 1
        historyRequestRevision += 1
        historySnapshot = .offlineCache(items: items)
        historyLoadState = .idle
    }

    private func reloadHistoryFromServer() async throws {
        guard let historyPager else { return }
        let expectedRevision = historyScopeRevision
        historyRequestRevision += 1
        let expectedRequest = historyRequestRevision
        historyLoadState = .loading
        do {
            let snapshot = try await historyPager.reload()
            guard
                expectedRevision == historyScopeRevision,
                expectedRequest == historyRequestRevision
            else { return }
            historySnapshot = snapshot
            historyLoadState = .current
            reconcileSelectedItem()
        } catch InboxRemoteError.unauthorized {
            throw InboxRemoteError.unauthorized
        } catch {
            guard
                expectedRevision == historyScopeRevision,
                expectedRequest == historyRequestRevision
            else { return }
            let visibleHistory = InboxHistoryRefreshPolicy.visibleSnapshot(
                current: historySnapshot,
                refreshedCacheItems: items
            )
            if visibleHistory != historySnapshot {
                historySnapshot = visibleHistory
            }
            historyLoadState = .offline("Server history is unavailable; showing retained activity")
            reconcileSelectedItem()
        }
    }

    private func useCachedHistory(_ cachedItems: [InboxItem]) {
        historySnapshot = .offlineCache(items: cachedItems)
        historyLoadState = .idle
        reconcileSelectedItem()
    }

    private func reconcileSelectedItem() {
        guard let scopeIdentity = currentSyncScopeIdentity else { return }
        selectedItemSnapshot.reconcile(
            scopeIdentity: scopeIdentity,
            availableItems: items + historySnapshot.items
        )
        if selectedItemSnapshot.item == nil {
            selectedNotificationID = nil
        }
    }

    private func clearHistory() {
        historyScopeRevision += 1
        historyRequestRevision += 1
        historyPager = nil
        historySnapshot = .offlineCache(items: [])
        historyLoadState = .idle
        selectedNotificationID = nil
        selectedItemSnapshot.dismiss()
    }

    private func quiesceRefresh() async {
        guard let refreshTask else {
            refreshRequestedWhileRunning = false
            return
        }
        refreshGeneration += 1
        refreshTask.cancel()
        _ = await refreshTask.value
        self.refreshTask = nil
        refreshRequestedWhileRunning = false
    }

    private func updateApplicationBadge() async {
        let count = InboxBadgeProjection.pendingInteractionCount(in: items)
        try? await UNUserNotificationCenter.current().setBadgeCount(count)
    }

    private func handleRevokedDeviceCredential() async {
        do {
            try credentialStore.delete()
        } catch {
            registrationState = .failed("The revoked local device credential could not be removed. Protected credential storage is unreadable.")
            syncState = .offline("Protected device storage could not be updated")
            return
        }
        credential = nil
        syncEngine = nil
        configuredSyncScopeIdentity = nil
        historyPager = nil
        historyScopeRevision += 1
        historyRequestRevision += 1
        historySnapshot = .offlineCache(items: items)
        historyLoadState = .idle
        selectedNotificationID = nil
        selectedItemSnapshot.dismiss()
        queuedResponseNotificationIDs = []
        responseFeedbackByNotificationID = [:]
        registrationState = .idle
        syncState = .offline("This iPhone must be registered again")
        if accountSession != nil {
            accountState = .signedIn
            try? registrationAttemptStore.advanceCurrentAttempt()
            scheduleRegistrationRecovery(at: Date())
        } else {
            accountState = .reauthenticationRequired
        }
    }

    private func updatePermission() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            permission = .allowed
            UIApplication.shared.registerForRemoteNotifications()
        case .denied:
            permission = .denied
        default:
            permission = .unknown
        }
    }

    private func registrationPrerequisite(hasAuthenticatedAccount: Bool) -> RegistrationState? {
        DeviceRegistrationPolicy.prerequisitePhase(
            hasAuthenticatedAccount: hasAuthenticatedAccount,
            permissionAllowed: permission == .allowed,
            apnsTokenAvailable: apnsTokenAvailable,
            pushRegistrationFailed: pushRegistrationError != nil
        )
    }

    private func makeRegistrationRequest() throws -> DeviceRegistrationRequest {
        DeviceRegistrationRequest(
            stableDeviceId: try stableDeviceIDStore.loadOrCreate(),
            installationId: try installationIDStore.loadOrCreate(),
            name: UIDevice.current.name,
            bundleIdentifier: Bundle.main.bundleIdentifier ?? "com.example.relo.notifications",
            appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0",
            appBuild: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0",
            osVersion: UIDevice.current.systemVersion,
            model: Self.modelIdentifier,
            apnsEnvironment: Self.apnsEnvironment,
            apnsToken: try pushTokenStore.load(),
            notificationAuthorization: notificationAuthorization,
            liveActivityAuthorization: ActivityAuthorizationInfo().areActivitiesEnabled ? .authorized : .denied,
            liveActivityPushToStartToken: try liveActivityPushToStartTokenStore.load()
        )
    }

    private func makeHeartbeat(credential: DeviceCredential, apnsToken: String) throws -> DeviceHeartbeat {
        DeviceHeartbeat(
            deviceId: credential.deviceId,
            installationId: try installationIDStore.loadOrCreate(),
            deviceName: UIDevice.current.name,
            bundleId: Bundle.main.bundleIdentifier ?? "com.example.relo.notifications",
            appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0",
            appBuild: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0",
            iosVersion: UIDevice.current.systemVersion,
            deviceModel: Self.modelIdentifier,
            apnsToken: apnsToken,
            apnsEnvironment: Self.apnsEnvironment,
            notificationAuthorization: permission == .allowed ? .authorized : .denied,
            liveActivityAuthorization: ActivityAuthorizationInfo().areActivitiesEnabled ? .authorized : .denied,
            liveActivityPushToStartToken: try liveActivityPushToStartTokenStore.load()
        )
    }

    private func startLiveActivityObservation() {
        if #available(iOS 17.2, *), pushToStartTokenTask == nil {
            pushToStartTokenTask = Task { @MainActor [weak self] in
                for await tokenData in Activity<ReloActivityAttributes>.pushToStartTokenUpdates {
                    guard !Task.isCancelled, let self else { return }
                    await self.receivedPushToStartToken(tokenData)
                }
            }
        }

        if activityUpdatesTask == nil {
            activityUpdatesTask = Task { @MainActor [weak self] in
                for await activity in Activity<ReloActivityAttributes>.activityUpdates {
                    guard !Task.isCancelled, let self else { return }
                    self.observePushTokenUpdates(for: activity)
                    self.observeActivityKitUpdates(for: activity)
                    _ = await self.refresh()
                    self.observeActivityKitUpdates(for: activity)
                    await self.registerCurrentPushToken(for: activity)
                }
            }
        }

        for activity in Activity<ReloActivityAttributes>.activities {
            observePushTokenUpdates(for: activity)
            observeActivityKitUpdates(for: activity)
        }
    }

    private func receivedPushToStartToken(_ tokenData: Data) async {
        let token = ActivityKitTokenCodec.hex(tokenData)
        guard !token.isEmpty else { return }
        do {
            try liveActivityPushToStartTokenStore.save(token)
        } catch {
            return
        }
        if credential != nil {
            await sendHeartbeat()
        } else if accountSession != nil {
            await registerDevice(force: true)
        }
    }

    private func synchronizeLiveActivityTokens() async {
        for activity in Activity<ReloActivityAttributes>.activities {
            observePushTokenUpdates(for: activity)
            observeActivityKitUpdates(for: activity)
            await registerCurrentPushToken(for: activity)
        }
    }

    private func observeActivityKitUpdates(
        for activity: Activity<ReloActivityAttributes>
    ) {
        guard let expectedScope = currentSyncScopeIdentity else { return }
        if activityObservationScopeByNativeID[activity.id] != expectedScope {
            activityContentUpdateTasks[activity.id]?.cancel()
            activityStateUpdateTasks[activity.id]?.cancel()
            activityContentUpdateTasks[activity.id] = nil
            activityStateUpdateTasks[activity.id] = nil
            activityObservationScopeByNativeID[activity.id] = expectedScope
        }

        if activityContentUpdateTasks[activity.id] == nil {
            activityContentUpdateTasks[activity.id] = Task { @MainActor [weak self] in
                for await content in activity.contentUpdates {
                    guard !Task.isCancelled, let self else { return }
                    await self.recordActivityKitObservation(
                        activity: activity,
                        content: content,
                        state: activity.activityState,
                        expectedScope: expectedScope
                    )
                }
            }
        }

        if activityStateUpdateTasks[activity.id] == nil {
            activityStateUpdateTasks[activity.id] = Task { @MainActor [weak self] in
                guard let self else { return }
                await self.recordActivityKitObservation(
                    activity: activity,
                    content: activity.content,
                    state: activity.activityState,
                    expectedScope: expectedScope
                )
                for await state in activity.activityStateUpdates {
                    guard !Task.isCancelled else { return }
                    await self.recordActivityKitObservation(
                        activity: activity,
                        content: activity.content,
                        state: state,
                        expectedScope: expectedScope
                    )
                    if state == .ended || state == .dismissed {
                        self.stopObservingActivity(nativeActivityID: activity.id)
                        return
                    }
                }
            }
        }
    }

    private func recordActivityKitObservation(
        activity: Activity<ReloActivityAttributes>,
        content: ActivityContent<ReloActivityAttributes.ContentState>,
        state: ActivityState,
        expectedScope: String
    ) async {
        guard expectedScope == currentSyncScopeIdentity else { return }
        let isTerminal = state == .ended || state == .dismissed
        guard let snapshot = liveActivitySnapshot(
            activityID: activity.attributes.eventID,
            generation: activity.attributes.generation,
            state: content.state,
            isTerminal: isTerminal
        ) else { return }
        do {
            try await liveActivityCoordinator.recordSystemObservation(
                LiveActivitySystemObservation(
                    snapshot: snapshot,
                    contentUpdatedAt: content.state.updatedAt,
                    observedAt: .now
                )
            )
        } catch {
            return
        }
        if state == .dismissed {
            try? await liveActivityCoordinator.recordPresentationDismissal(
                identity: activity.attributes.identity
            )
            await flushLiveActivityDismissals()
        }
        guard expectedScope == currentSyncScopeIdentity else { return }
        _ = await refresh()
    }

    private func stopObservingActivity(nativeActivityID: String) {
        activityPushTokenTasks[nativeActivityID]?.cancel()
        activityContentUpdateTasks[nativeActivityID]?.cancel()
        activityPushTokenTasks[nativeActivityID] = nil
        activityContentUpdateTasks[nativeActivityID] = nil
        activityStateUpdateTasks[nativeActivityID] = nil
        activityObservationScopeByNativeID[nativeActivityID] = nil
    }

    private func observePushTokenUpdates(for activity: Activity<ReloActivityAttributes>) {
        guard activityPushTokenTasks[activity.id] == nil else { return }
        activityPushTokenTasks[activity.id] = Task { @MainActor [weak self] in
            for await tokenData in activity.pushTokenUpdates {
                guard !Task.isCancelled, let self else { return }
                await self.registerPushToken(tokenData, for: activity)
            }
        }
    }

    private func registerCurrentPushToken(for activity: Activity<ReloActivityAttributes>) async {
        guard let tokenData = activity.pushToken else { return }
        await registerPushToken(tokenData, for: activity)
    }

    private func registerPushToken(
        _ tokenData: Data,
        for activity: Activity<ReloActivityAttributes>
    ) async {
        guard
            let credential,
            ReloDeepLink.activityURL(identity: activity.attributes.identity) != nil,
            (items + historySnapshot.items).contains(where: {
                $0.liveActivity?.identity == activity.attributes.identity
                    && $0.liveActivity?.targetDeviceId == credential.deviceId
            })
        else { return }
        let token = ActivityKitTokenCodec.hex(tokenData)
        guard !token.isEmpty else { return }

        do {
            try await apiClient.registerLiveActivityToken(
                credential: credential,
                activityId: activity.attributes.eventID,
                registration: LiveActivityTokenRegistration(
                    token: token,
                    nativeActivityId: activity.id,
                    environment: Self.apnsEnvironment,
                    generation: activity.attributes.generation
                )
            )
        } catch MobileAPIError.reauthenticationRequired, MobileAPIError.forbidden {
            guard self.credential?.accessToken == credential.accessToken else { return }
            await handleRevokedDeviceCredential()
        } catch {
            // Foreground synchronization retries the current token without logging it.
        }
    }

    private var notificationAuthorization: AuthorizationState {
        switch permission {
        case .allowed: .authorized
        case .denied: .denied
        case .unknown: .pending
        }
    }

    private func authenticationMessage(for error: Error) -> String {
        switch error {
        case MobileAPIError.invalidRequest:
            "Check the email and password fields."
        case MobileAPIError.invalidCredentials:
            "The email or password is incorrect."
        case MobileAPIError.accountDisabled, MobileAPIError.forbidden:
            "This Relo server account cannot sign in. Open the dashboard for account recovery."
        case MobileAPIError.rateLimited(let seconds):
            seconds.map { "Too many sign-in attempts. Try again in \($0) seconds." }
                ?? "Too many sign-in attempts. Try again shortly."
        default:
            "Relo server could not be reached. Confirm this iPhone is on the private home network and retry."
        }
    }

    private static var modelIdentifier: String {
        var systemInfo = utsname()
        uname(&systemInfo)
        return withUnsafePointer(to: &systemInfo.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) }
        }
    }

    private static var apnsEnvironment: String {
        #if DEBUG
        "sandbox"
        #else
        "production"
        #endif
    }
}
