import ReloTransport
import ReloRuntime
import ReloPersistence
import ActivityKit
import Combine
import Network
import OSLog
import ReloCore
import SwiftUI
import UIKit
import UserNotifications

@MainActor
@Observable
final class AppModel {
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

    var accountState: AccountState = .restoring {
        didSet {
            if oldValue != accountState,
               accountState != .signedIn, accountState != .restoring {
                invalidateSelectionScope()
            }
        }
    }
    private(set) var hasRestoredLocalAccount = false
    var registrationState: RegistrationState = .idle
    var account: AccountSummary?
    var accountUser: AccountUser?
    var credential: DeviceCredential? {
        didSet { if oldValue != credential { invalidateSelectionScope() } }
    }
    var permission: PermissionState = .unknown
    var items: [InboxItem] = []
    private(set) var currentNavigationRevision = 0
    private(set) var currentState: CurrentRuntimeState? { didSet { currentStateSubject.send(currentState) } }
    private var decisionDrafts: [String: CurrentDecisionDraft] = [:]
    private(set) var historySnapshot = InboxHistorySnapshot.offlineCache(items: [])
    /// The server's Now summary (`GET /api/now`); set by the Now summary controller (stream D1).
    var nowSummary: NowSummary?
    /// Bumped when Now should refetch its summary at once (after dismissing a missed question).
    private(set) var nowRefetchRequest = 0
    /// Missed questions being dismissed: kept off Now until the server's next summary drops them.
    @ObservationIgnored private var dismissingQuestionIDs: Set<String> = []
    /// Missed questions the server says are no longer missed (answered late, opened elsewhere, or gone):
    /// a stale or cached summary must not bring them back.
    @ObservationIgnored private var settledQuestionIDs: Set<String> = []
    /// A short line when dismissing a missed question failed; the row is back.
    var nowDismissError: String?
    /// Works being ended right now, and works this phone ended (the detail then says so).
    private(set) var endingWorkIDs: Set<String> = []
    private(set) var endedNotificationIDs: Set<String> = []
    /// Why ending a work failed, and which work it was.
    var endWorkError: String?
    var endWorkErrorWorkID: String?
    /// Agent sessions from the last inbox snapshot (empty from older servers).
    private(set) var historyLoadState: HistoryLoadState = .idle
    var syncState: SyncState = .idle
    var lastSyncedAt: Date?
    var authenticationError: String?
    var signOutError: String?
    var accountDeletionError: String?
    private(set) var isDeletingAccount = false
    var pushRegistrationError: String?
    private(set) var apnsTokenState = APNSTokenSessionState()
    var serverAcceptedCurrentAPNSToken = false
    private(set) var deliveryTransportStatus: DeliveryTransportStatus?
    private(set) var deliveryTransportStatusError: String?
    private(set) var protectedRegistrationResetAvailable = false
    /// Ticks each time something asks for Settings → Devices (relo://settings/security, or the
    /// "New device wants access" notification): the root view goes there and the list refreshes.
    private(set) var securitySettingsRequests = 0
    /// Settings → Devices was asked for and the Settings screen has not opened it yet.
    var securitySettingsNavigationPending = false
    private(set) var selectedNotificationID: String? {
        didSet { if oldValue != selectedNotificationID { selectedNotificationDetail = nil } }
    }
    var respondingNotificationID: String?
    var interactionError: String?
    private(set) var queuedResponseNotificationIDs = Set<String>()
    private(set) var responseFeedbackByNotificationID: [String: NotificationResponseFeedback] = [:] {
        didSet { responseFeedbackSubject.send(responseFeedbackByNotificationID) }
    }
    private(set) var unreadCount = 0
    private(set) var unreadByProject: [String: Int] = [:]
    private(set) var withdrawingNotificationID: String?
    private(set) var selectedNotificationDetail: InboxNotificationDetail? {
        didSet { selectedNotificationDetailSubject.send(selectedNotificationDetail) }
    }
    /// Every assignment, including transient ones, for race tests and non-SwiftUI observers.
    @ObservationIgnored private let currentStateSubject = CurrentValueSubject<CurrentRuntimeState?, Never>(nil)
    @ObservationIgnored private let responseFeedbackSubject =
        CurrentValueSubject<[String: NotificationResponseFeedback], Never>([:])
    @ObservationIgnored private let selectedNotificationDetailSubject =
        CurrentValueSubject<InboxNotificationDetail?, Never>(nil)
    var currentStateChanges: AnyPublisher<CurrentRuntimeState?, Never> { currentStateSubject.eraseToAnyPublisher() }
    var responseFeedbackChanges: AnyPublisher<[String: NotificationResponseFeedback], Never> {
        responseFeedbackSubject.eraseToAnyPublisher()
    }
    var selectedNotificationDetailChanges: AnyPublisher<InboxNotificationDetail?, Never> {
        selectedNotificationDetailSubject.eraseToAnyPublisher()
    }

    private let system: AppSystemServices
    private(set) var attentionDate = Date.now
    @ObservationIgnored private var replyDraftState = ReplyDraftState()

    var attention: InboxAttentionProjection.Snapshot {
        InboxAttentionProjection.make(items: items + [selectedNotificationDetail?.item].compactMap { $0 }, now: attentionDate,
            acceptedNotificationIDs: Set(responseFeedbackByNotificationID.filter { $0.value.phase == .accepted }.keys),
            queuedNotificationIDs: queuedResponseNotificationIDs)
    }

    func updateAttentionClock() { attentionDate = .now }
    func draft(for requestID: String) -> String {
        replyDraftState.transition(to: historyScopeIdentity)
        return replyDraftState.text(requestID: requestID)
    }
    func saveDraft(_ text: String, for requestID: String) {
        replyDraftState.transition(to: historyScopeIdentity)
        replyDraftState.set(text, requestID: requestID)
    }
    var serverOrigin: String { serverURL.absoluteString }
    /// The server the owner entered or signed in to; nil until then. Onboarding never offers a
    /// default: people host Relo in their own places.
    private(set) var chosenServerOrigin: String?
    /// What the Now deck presents. It lives here, not in a view, so rebuilt views never replay it.
    @ObservationIgnored let deckDirector = ReloDeckDirector()
    /// Set by a fresh sign-in until Now has played its "account linked" boot sequence once.
    private(set) var linkCeremonyPending = false
    func finishLinkCeremony() { linkCeremonyPending = false }
    /// Origin changes are offered only before authentication; a connected account uses sign-out.
    func selectServerOrigin(_ value: String) -> Bool {
        guard !hasLocalAccountAccess, !isAuthenticating,
              let components = URLComponents(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.path.isEmpty || components.path == "/",
              let url = components.url, ServerEndpointPolicy.accepts(url)
        else {
            authenticationError = "Enter an HTTPS server origin, or HTTP on your local network."
            return false
        }
        serverURL = url
        apiClient = HTTPMobileAPIClient(baseURL: url)
        RuntimeServerOrigin.persist(url)
        chosenServerOrigin = url.absoluteString
        authenticationError = nil
        return true
    }

    #if DEBUG
    /// In-memory preview models skip restoration; establish their fictional account scope.
    func configurePreviewAccountScope() {
        selectedAccountId = credential?.accountId
    }

    func configurePreviewResponses() {
        queuedResponseNotificationIDs = ["ntf_previewapproval"]
        responseFeedbackByNotificationID = [
            "ntf_previewapproval": .init(phase: .queued, action: .approve),
            "ntf_previewyesno": .init(phase: .rejected, action: .yes, message: "Response not recorded. Try again.")
        ]
    }
    #endif

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
    @ObservationIgnored private(set) var apiClient: any MobileAPIClient
    private let liveActivityCoordinator: LiveActivityCommandCoordinator
    let pendingResponseStore: any AccountScopedPendingResponseStoring
    let diagnostics: any DiagnosticStoring
    private(set) var diagnosticResponseStatus: RecoveryStatus = .pending
    private(set) var diagnosticResponseConfirmedAt: Date?
    private(set) var diagnosticQueueDepths: [OperationDiagnostic.Operation: Int] = [:]
    private(set) var diagnosticQueuesCheckedAt: Date?
    private(set) var diagnosticQueueIssues: [OperationDiagnostic.Operation: RecoveryStatus] = [:]
    @ObservationIgnored private lazy var responseSubmitter = PendingResponseSubmitter(host: self)
    private let notificationReceiptStore: any ScopedNotificationReceiptStoring
    private let receiptCoordinator = ReceiptCoordinator()
    @ObservationIgnored private var boundReceiptScopeIdentity: String?
    @ObservationIgnored private var reportedLegacyReceiptRetirements = 0
    @ObservationIgnored private var reportedNotFoundReceiptRetirements = 0
    private let accountNotificationCleaner: any AccountNotificationClearing
    var serverURL: URL {
        didSet { if oldValue != serverURL { invalidateSelectionScope() } }
    }
    private var accountSession: AccountSession? {
        didSet { if oldValue != accountSession { invalidateSelectionScope() } }
    }
    private let makeInboxDataSource: (URL, String) -> any InboxDataSource
    private let makeCurrentDataSource: (URL, String) -> any CurrentStateSource
    private let makeCurrentCache: (StorageScope) -> any CurrentStateCaching
    @ObservationIgnored private var runtimeReady = false
    private let currentBadge: CurrentBadgeController
    @ObservationIgnored private lazy var sessionController = SessionController(
        makeSource: makeCurrentDataSource, makeCache: makeCurrentCache
    ) { [weak self] state in
        self?.acceptCurrentState(state)
    }
    @ObservationIgnored private var selectionRevision: UInt64 = 0
    @ObservationIgnored private(set) var selectionScopeRevision: UInt64 = 0

    /// True while the task that captured `revision` is uncancelled and still serves the current
    /// account/device selection. Every async step re-checks this before publishing results.
    func isCurrentSelection(_ revision: UInt64) -> Bool {
        !Task.isCancelled && revision == selectionScopeRevision
    }
    private(set) var readState = PendingReadState()
    private let makePendingReadStore: (StorageScope) -> any PendingReadStoring
    @ObservationIgnored private var pendingReadStores: [StorageScope: any PendingReadStoring] = [:]
    @ObservationIgnored private var boundReadScopeIdentity: String?
    @ObservationIgnored private lazy var readCoordinator = PendingReadCoordinator(
        changed: { [weak self] state in
            self?.readState = state
            self?.recordDiagnostic(.init(operation: .readReplay, phase: .completed,
                outcome: RecoveryStatusPolicy.reads(state), priority: .maintenance, queueDepth: state.pendingIDs.count))
        },
        confirmed: { [weak self] in self?.acceptReadConfirmation($0) })
    private let makeDetailCache: (StorageScope) -> any NotificationDetailCaching
    @ObservationIgnored private var detailCache: (any NotificationDetailCaching)?
    private(set) var notificationDetailError: String?
    @ObservationIgnored private var syncEngine: InboxSyncEngine?
    @ObservationIgnored private(set) var inboxRemote: (any InboxDataSource)?
    @ObservationIgnored private var inboxReadWatermark: String?
    @ObservationIgnored private var configuredSyncScopeIdentity: String?
    @ObservationIgnored private var historyPager: InboxHistoryPager?
    @ObservationIgnored private var historyScopeRevision = 0
    @ObservationIgnored private var historyRequestRevision = 0
    private var selectedAccountId: String? {
        didSet { if oldValue != selectedAccountId { invalidateSelectionScope() } }
    }
    @ObservationIgnored private var registrationInProgress = false
    @ObservationIgnored private var registrationPending = false
    @ObservationIgnored private var registrationRecoveryTask: Task<Void, Never>?
    @ObservationIgnored private var hasStarted = false
    private let historyRepair = HistoryRepairCoordinator()
    private let maintenance = ScopedMaintenanceCoordinator()
    @ObservationIgnored private var isForeground = true
    @ObservationIgnored private var historyRequested = false
    @ObservationIgnored private var pendingNotificationID: String?
    @ObservationIgnored private var pendingActivityIdentity: LiveActivityIdentity?
    @ObservationIgnored private var activityUpdatesTask: Task<Void, Never>?
    @ObservationIgnored private var activityContentUpdateTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var activityStateUpdateTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var activityObservationScopeByNativeID: [String: String] = [:]
    @ObservationIgnored private var deliveryStatusScopeIdentity: String?
    @ObservationIgnored private var deliveryStatusLastAttemptAt: Date?
    private var selectedItemSnapshot = InboxSelectedItemSnapshot()
    @ObservationIgnored private var selectedCachedDetail = false

    private(set) var outageBannerShown = false
    @ObservationIgnored private var offlineSince: Date?
    @ObservationIgnored private var outageBannerTask: Task<Void, Never>?
    @ObservationIgnored private var pathMonitor: NWPathMonitor?

    var isRegistered: Bool { credential != nil && registrationState == .registered }
    /// The server cannot be reached right now (offline, VPN off, server down).
    var serverUnreachable: Bool {
        guard hasLocalAccountAccess else { return false }
        // A brief outage (a redeploy) stays silent; the banner waits out `OutageBannerPolicy.grace`.
        if currentState?.connection == .offline, outageBannerShown { return true }
        if case .failed(let message) = registrationState,
           message.hasPrefix("Server unreachable") || message.contains("unavailable") { return true }
        return false
    }
    /// Linked, live, and the first counts are in: the deck's HUD has something true to show.
    var deckConnected: Bool {
        isRegistered && currentState?.connection == .current && currentPresentation.actionableCount != nil
    }
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
    var presentationScopeIdentity: String {
        ReloPresentationScope(serverOrigin: serverOrigin, account: account, session: accountSession,
                              credential: credential, user: accountUser).identity
    }
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
    var currentSyncScopeIdentity: String? {
        guard
            let credential,
            accountState != .signedOut, accountState != .signingOut, accountState != .disabled,
            credential.accountId == selectedAccountId,
            accountSession?.account?.accountId == nil || accountSession?.account?.accountId == credential.accountId,
            let storage = try? StorageScope(serverOrigin: serverURL, accountID: credential.accountId, deviceID: credential.deviceId)
        else { return nil }
        return "\(storage.fileKey)|\(accountSession?.sessionId ?? "device-only")|\(credential.credentialVersion)|\(selectionScopeRevision)"
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
        notificationReceiptStore: any ScopedNotificationReceiptStoring,
        accountNotificationCleaner: any AccountNotificationClearing,
        serverURL: URL,
        diagnostics: any DiagnosticStoring = NoopDiagnosticStore(),
        system: AppSystemServices? = nil,
        makeInboxDataSource: @escaping (URL, String) -> any InboxDataSource = {
            HTTPInboxDataSource(baseURL: $0, token: $1)
        },
        makeCurrentDataSource: @escaping (URL, String) -> any CurrentStateSource = {
            HTTPCurrentStateSource(baseURL: $0, token: $1)
        },
        makeCurrentCache: @escaping (StorageScope) -> any CurrentStateCaching = { _ in InMemoryCurrentStateCache() },
        makePendingReadStore: @escaping (StorageScope) -> any PendingReadStoring = { _ in InMemoryPendingReadStore() },
        makeDetailCache: @escaping (StorageScope) -> any NotificationDetailCaching = { _ in InMemoryNotificationDetailCache() }
    ) {
        let resolvedSystem = system ?? .live
        self.system = resolvedSystem
        self.currentBadge = CurrentBadgeController { count in await resolvedSystem.setBadgeCount(count) }
        self.makeInboxDataSource = makeInboxDataSource
        self.makeCurrentDataSource = makeCurrentDataSource
        self.makeCurrentCache = makeCurrentCache
        self.makeDetailCache = makeDetailCache
        self.makePendingReadStore = makePendingReadStore
        self.accountState = accountState
        self.hasRestoredLocalAccount = accountState != .restoring
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
        self.diagnostics = diagnostics
    }

    convenience init(dependencies: AppDependencies) {
        self.init(
            credentialStore: dependencies.credentialStore,
            accountSessionStore: dependencies.accountSessionStore,
            installationIDStore: dependencies.installationIDStore,
            stableDeviceIDStore: dependencies.stableDeviceIDStore,
            pushTokenStore: dependencies.pushTokenStore,
            liveActivityPushToStartTokenStore: dependencies.liveActivityPushToStartTokenStore,
            registrationAttemptStore: dependencies.registrationAttemptStore,
            signOutProgressStore: dependencies.signOutProgressStore,
            storagePreflight: dependencies.storagePreflight,
            cache: dependencies.cache,
            apiClient: dependencies.apiClient,
            liveActivityCoordinator: dependencies.liveActivityCoordinator,
            pendingResponseStore: dependencies.pendingResponseStore,
            notificationReceiptStore: dependencies.notificationReceiptStore,
            accountNotificationCleaner: dependencies.accountNotificationCleaner,
            serverURL: dependencies.serverURL,
            diagnostics: dependencies.diagnostics,
            system: dependencies.system,
            makeInboxDataSource: dependencies.makeInboxDataSource,
            makeCurrentDataSource: dependencies.makeCurrentDataSource,
            makeCurrentCache: dependencies.makeCurrentCache,
            makePendingReadStore: dependencies.makePendingReadStore,
            makeDetailCache: dependencies.makeDetailCache
        )
        chosenServerOrigin = dependencies.chosenServerURL?.absoluteString
        encryptionKeys = dependencies.encryptionKeys
        computerInviteStore = dependencies.computerInviteStore
        answerSigner = dependencies.answerSigner
        devices.shareApproval = { [weak self] client in Task { await self?.shareComputerApproval(client) } }
    }

    /// The owner approved a computer here: sign it now, so it opens on the Mac app, other phones and browsers too.
    func shareComputerApproval(_ client: ReloClientKey) async {
        guard let credential, let encryptionKeys else { return }
        await encryptionKeys.approve(client, credential: credential)
    }

    /// Why this phone's encryption keys could not be created or published, shown in Settings → Devices.
    var encryptionKeysProblem: String?

    static func encryptionKeysProblem(_ error: Error) -> String {
        switch error {
        case CredentialStoreError.keychain(let status):
            "The Keychain refused the encryption keys (status \(status)). Check that this build has the shared Keychain group."
        case MobileAPIError.reauthenticationRequired, MobileAPIError.forbidden:
            "The server refused this iPhone's keys. Sign in again."
        case MobileAPIError.unavailable:
            "The server is unreachable or does not accept encryption keys yet."
        default:
            "Encryption keys could not be published: \(String(describing: error))"
        }
    }

    /// The context of the sealed question this phone opened for `notificationID`, or nil when the
    /// question was not sealed or could not be opened (then only the plain signature is sent).
    func openedSealedQuestionContext(notificationID: String) -> String? {
        let placeholders: Set<String> = ["Private notification", ReloSealedCards.promptPlaceholder, "Encrypted question"]
        if let item = items.first(where: { $0.id == notificationID }), let sealed = item.sealed, sealed.content.kind == "question",
           let prompt = item.interaction?.prompt, !placeholders.contains(prompt) {
            return sealed.content.context
        }
        if let cached = currentState?.snapshot.pending?.entries.values.first(where: { $0.item.notificationId == notificationID })?.item,
           let sealed = cached.sealed, sealed.content.kind == "question", !placeholders.contains(cached.summary) {
            return sealed.content.context
        }
        if let subject = currentState?.snapshot.subjects.values.first(where: { $0.projection.notificationId == notificationID })?.projection,
           let sealed = subject.sealed, sealed.content.kind == "question", !placeholders.contains(subject.summary) {
            return sealed.content.context
        }
        return nil
    }

    /// This phone's identity signer for answers; nil in previews and tests.
    @ObservationIgnored var answerSigner: (@Sendable () -> (any ReloIdentitySigning)?)?

    /// End-to-end encryption keys: rotated and published beside the heartbeat. A failure never
    /// affects registration; the next heartbeat retries (docs/ENCRYPTION-PROTOCOL.md, E2.1).
    @ObservationIgnored var encryptionKeys: E2EEKeyMaintenance?

    func maintainEncryptionKeys(credential: DeviceCredential) async {
        guard let encryptionKeys else { return }
        // Unpublished keys only delay sealing to this phone; the next launch or foreground tries again.
        do {
            try await encryptionKeys.run(credential: credential)
            encryptionKeysProblem = nil
        } catch {
            encryptionKeysProblem = Self.encryptionKeysProblem(error)
        }
    }

    var recoveryQueues: [RecoveryQueueStatus] {
        [
            .init(operation: .currentSync, status: RecoveryStatus(outcome: RecoveryStatusPolicy.current(currentState)),
                  depth: nil, lastConfirmedAt: currentState?.snapshot.metadata?.serverTime),
            .init(operation: .responseSubmission, status: requiresReauthentication ? .pausedForAuth : diagnosticQueueIssues[.responseSubmission]
                    ?? ((diagnosticQueueDepths[.responseSubmission] ?? 0) > 0 && diagnosticResponseStatus == .confirmed ? .pending : diagnosticResponseStatus),
                  depth: diagnosticQueueDepths[.responseSubmission], lastConfirmedAt: diagnosticResponseConfirmedAt),
            .init(operation: .readReplay, status: diagnosticQueueIssues[.readReplay] ?? RecoveryStatus(outcome: RecoveryStatusPolicy.reads(readState)),
                  depth: diagnosticQueueDepths[.readReplay], lastConfirmedAt: nil),
            .init(operation: .receiptUpload, status: diagnosticQueueIssues[.receiptUpload] ?? RecoveryStatus(outcome: RecoveryStatusPolicy.receipts(receiptCoordinator.state)),
                  depth: diagnosticQueueDepths[.receiptUpload], lastConfirmedAt: nil)
        ]
    }

    func refreshDiagnosticQueues() async {
        let revision = selectionScopeRevision
        guard let credential,
              let scope = try? StorageScope(serverOrigin: serverURL, accountID: credential.accountId, deviceID: credential.deviceId)
        else { diagnosticQueueDepths = [:]; return }
        var depths: [OperationDiagnostic.Operation: Int] = [:]
        var issues: [OperationDiagnostic.Operation: RecoveryStatus] = [:]
        var lastConfirmedResponse: Date?
        do {
            let responses = try await pendingResponseStore.pending(now: .now)
            depths[.responseSubmission] = responses.filter { $0.accountID == scope.accountID && $0.deviceID == scope.deviceID }.count
            let confirmations = try await pendingResponseStore.notificationConfirmations(now: .now)
            lastConfirmedResponse = confirmations.filter { $0.accountID == scope.accountID && $0.deviceID == scope.deviceID }
                .map(\.confirmedAt).max()
        } catch { issues[.responseSubmission] = .pausedForStorage }
        do { depths[.readReplay] = try await makePendingReadStore(scope).pending(limit: 1_000).count }
        catch { issues[.readReplay] = .pausedForStorage }
        do {
            let receiptScope = try ReceiptScope(serverOrigin: scope.serverOrigin, accountId: scope.accountID, deviceId: scope.deviceID)
            let receipts = try await notificationReceiptStore.pending(scope: receiptScope, limit: 200)
            depths[.receiptUpload] = receipts.records.count
        } catch { issues[.receiptUpload] = .pausedForStorage }
        guard revision == selectionScopeRevision else { return }
        diagnosticQueueDepths = depths; diagnosticQueueIssues = issues; diagnosticQueuesCheckedAt = .now
        if let lastConfirmedResponse {
            diagnosticResponseConfirmedAt = max(lastConfirmedResponse, diagnosticResponseConfirmedAt ?? lastConfirmedResponse)
        }
    }

    func recordDiagnostic(_ event: OperationDiagnostic) {
        if event.operation == .responseSubmission {
            diagnosticResponseStatus = RecoveryStatus(outcome: event.outcome)
            diagnosticQueueIssues.removeValue(forKey: .responseSubmission)
            diagnosticQueueDepths.removeValue(forKey: .responseSubmission)
            if event.outcome == .confirmed { diagnosticResponseConfirmedAt = event.timestamp }
        }
        Task { [diagnostics] in await diagnostics.record(event) }
    }

    static func diagnosticMilliseconds(since start: ContinuousClock.Instant) -> Double {
        let elapsed = start.duration(to: .now).components
        return Double(elapsed.seconds) * 1_000 + Double(elapsed.attoseconds) / 1e15
    }

    static func live() -> AppModel {
        AppModel(dependencies: .live())
    }

    func start() async {
        guard !hasStarted else { return }
        hasStarted = true
        protectedRegistrationResetAvailable = false
        accountState = .restoring
        hasRestoredLocalAccount = false
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
        pushRegistrationError = system.pushRegistrationError()
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

        runtimeReady = true
        accountState = credential != nil || accountSession != nil ? .signedIn : .signedOut
        synchronizeCurrentSession()
        system.startActivityObservation(self)
        var revision = selectionScopeRevision
        await updatePermission()
        guard isCurrentSelection(revision) else { return }

        if let accountId = accountSession?.account?.accountId {
            guard await selectAndLoadCache(accountId: accountId) else { return }
        } else if accountSession == nil, let accountId = credential?.accountId {
            guard await selectAndLoadCache(accountId: accountId) else { return }
        }

        revision = selectionScopeRevision
        // Mount the account's content once local restoration finishes. Remote validation
        // must neither gate saved content nor first mount an empty feed before its cache.
        hasRestoredLocalAccount = true

        var accountSessionIsValid = false
        if let storedSession = accountSession {
            do {
                var validated = try await apiClient.validateAccountSession(token: storedSession.accessToken)
                guard isCurrentSelection(revision) else { return }
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
                guard isCurrentSelection(revision) else { return }
                accountState = .reauthenticationRequired
            } catch MobileAPIError.accountDisabled {
                guard isCurrentSelection(revision) else { return }
                accountState = .disabled
            } catch {
                guard isCurrentSelection(revision) else { return }
                // Keep the last authenticated account usable with its cached inbox
                // when Relo server is temporarily unreachable. Only an authoritative
                // 401/403 above may require authentication again.
                accountState = .signedIn
            }
        } else {
            accountState = credential == nil ? .signedOut : .reauthenticationRequired
        }

        revision = selectionScopeRevision
        // A valid existing device credential remains usable while registration
        // reconciliation is delayed. Registration convergence must not gate the
        // cached Inbox or a healthy device bearer on cold start.
        if credential != nil {
            registrationState = .registered
            await configureSyncEngine()
            guard isCurrentSelection(revision) else { return }
            await synchronizeLiveActivityTokens()
            guard isCurrentSelection(revision) else { return }
            await sendHeartbeat()
            guard isCurrentSelection(revision) else { return }
            if let credential { await maintainEncryptionKeys(credential: credential) }
            guard isCurrentSelection(revision) else { return }
            await refresh()
            guard isCurrentSelection(revision) else { return }
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

    /// Opens the server's sign-in page in the system browser (PKCE) and exchanges the returned code.
    /// `signUp` opens the sign-up form ("Create account"); a new account is then offered the Connect a computer wizard.
    func signInWithBrowser(signUp: Bool = false) async -> Bool {
        guard !isAuthenticating else { return false }
        authenticationError = nil
        signOutError = nil
        deliveryTransportStatus = nil
        deliveryTransportStatusError = nil
        deliveryStatusScopeIdentity = nil
        deliveryStatusLastAttemptAt = nil

        // A first sign-in needs a server the owner entered; signing in again keeps the current one.
        guard chosenServerOrigin != nil || hasLocalAccountAccess else {
            authenticationError = "Enter your Relo server's address first."
            return false
        }
        let flow = BrowserSignIn()
        guard let url = flow.authorizationURL(origin: serverURL, signUp: signUp) else {
            authenticationError = authenticationMessage(for: MobileAPIError.invalidRequest)
            return false
        }
        accountState = .signingIn
        do {
            let callback: URL
            do { callback = try await BrowserSignInSession.authenticate(url: url) }
            catch BrowserSignInSession.Failure.cancelled {
                accountState = credential == nil ? .signedOut : .reauthenticationRequired
                return false
            }
            guard case .code(let code) = try flow.parse(callback: callback) else {
                accountState = credential == nil ? .signedOut : .reauthenticationRequired
                return false
            }
            let installationId = try installationIDStore.loadOrCreate().uuidString.lowercased()
            let session = try await apiClient.exchangeBrowserSignIn(
                code: code, codeVerifier: flow.verifier, installationId: installationId
            )
            try await retireCurrentDeviceBinding()
            try accountSessionStore.save(session)
            accountSession = session
            accountUser = session.user
            RuntimeServerOrigin.persist(serverURL)
            chosenServerOrigin = serverOrigin
            linkCeremonyPending = true
            account = nil
            items = []
            clearHistory()
            await updateApplicationBadge()
            lastSyncedAt = nil
            syncEngine = nil
            inboxRemote = nil
            configuredSyncScopeIdentity = nil
            selectedAccountId = nil
            accountState = .signedIn
            // This iPhone registers only with notification permission, and the inbox syncs only once
            // it is registered: ask now, as part of signing in, rather than leaving it to Settings.
            await updatePermission()
            if permission == .allowed { await registerDevice(force: true) } else { await requestNotifications() }
            computerSetupOfferPending = true
            return accountSession != nil
        } catch {
            accountState = credential == nil ? .signedOut : .reauthenticationRequired
            authenticationError = authenticationMessage(for: error)
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
        guard !Task.isCancelled else { return false }
        sessionController.receive(.reconcile)
        requestMaintenance()
        guard let scope = currentSyncScopeIdentity else { return false }
        return await historyRepair.repair(scope: scope) { [weak self] in
            guard let self, self.currentSyncScopeIdentity == scope, !Task.isCancelled else { return false }
            return await self.performRefresh()
        }
    }

    #if DEBUG
    /// Capture and preview hosts only: stage a current-work snapshot without a server.
    func previewAcceptCurrentState(_ state: CurrentRuntimeState) { acceptCurrentState(state) }
    #endif

    private func acceptCurrentState(_ state: CurrentRuntimeState?) {
        func nativeVersions(_ value: CurrentRuntimeState?) -> [String: CurrentVersion] {
            guard let value else { return [:] }
            return value.snapshot.subjects.reduce(into: [:]) { result, element in
                if element.value.projection.activity != nil { result[element.key] = element.value.projection.version }
            }
        }
        let previous = nativeVersions(currentState)
        if currentState?.connection != state?.connection || currentState?.persistence != state?.persistence
            || currentState?.snapshot.metadata?.serverTime != state?.snapshot.metadata?.serverTime {
            recordDiagnostic(.init(operation: .currentSync, phase: state?.connection == .connecting ? .started : .completed,
                outcome: RecoveryStatusPolicy.current(state), priority: .current))
        }
        let wasOffline = currentState?.connection == .offline
        let previousServerTime = currentState?.snapshot.metadata?.serverTime
        currentState = state
        // The stream woke (a card changed, a session started, stopped or ended): agent sessions and
        // History come with the inbox, so read it again soon.
        if state?.connection == .current, state?.snapshot.metadata?.serverTime != previousServerTime { followInbox() }
        trackOutage(offline: state?.connection == .offline)
        // The first good current-state read after an outage also clears a stale legacy sync failure.
        if wasOffline, state?.connection == .current, case .offline = syncState { Task { _ = await self.refresh() } }
        if state == nil {
            decisionDrafts = [:]; diagnosticQueueDepths = [:]; diagnosticQueuesCheckedAt = nil; diagnosticQueueIssues = [:]
            diagnosticResponseStatus = .pending; diagnosticResponseConfirmedAt = nil
        }
        let count = state.map { CurrentInboxPresentation(state: $0, now: $0.snapshot.evaluatedAt ?? Date()).actionableCount } ?? 0
        if let count { currentBadge.set(count) }
        if state?.connection == .current, previous != nativeVersions(state),
           let scope = currentSyncScopeIdentity, configuredSyncScopeIdentity == scope {
            scheduleNativeReconciliation(snapshot: InboxSnapshot(items: items), scope: scope)
        }
    }

    /// Agent sessions and History arrive with the inbox, which the current-state stream does not
    /// carry. A wake on that stream, or the Now screen's minute tick, syncs the inbox again, at most
    /// once per `maxAge`; calls in between share the one pending sync.
    static let inboxFollowInterval: TimeInterval = 20
    @ObservationIgnored private var inboxFollowTask: Task<Void, Never>?
    @ObservationIgnored private var inboxFollowedAt = Date.distantPast

    func followInbox(maxAge: TimeInterval = AppModel.inboxFollowInterval) {
        guard isForeground, inboxFollowTask == nil, let scope = currentSyncScopeIdentity,
              configuredSyncScopeIdentity == scope else { return }
        let wait = max(1, maxAge - Date().timeIntervalSince(inboxFollowedAt))
        inboxFollowTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(wait))
            guard let self else { return }
            defer { self.inboxFollowTask = nil }
            guard !Task.isCancelled, self.isForeground, self.currentSyncScopeIdentity == scope else { return }
            self.inboxFollowedAt = .now
            _ = await self.historyRepair.repair(scope: scope) { [weak self] in
                guard let self, self.currentSyncScopeIdentity == scope, !Task.isCancelled else { return false }
                return await self.performRefresh(quiet: true)
            }
        }
    }

    private func trackOutage(offline: Bool) {
        guard offline else {
            offlineSince = nil; outageBannerTask?.cancel(); outageBannerTask = nil
            if outageBannerShown { outageBannerShown = false }
            return
        }
        guard offlineSince == nil else { return }
        let since = Date(); offlineSince = since
        let policy = OutageBannerPolicy.standard
        outageBannerTask = Task { @MainActor [weak self] in
            if let wait = policy.remaining(offlineSince: since, now: Date()), wait > 0 {
                try? await Task.sleep(for: .seconds(wait))
            }
            guard !Task.isCancelled, let self, self.offlineSince == since else { return }
            self.outageBannerShown = true
        }
    }

    /// Foreground only: a path that becomes usable retries the unreachable server at once.
    private func startPathMonitor() {
        guard pathMonitor == nil else { return }
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            Task { @MainActor in self?.sessionController.retryNow() }
        }
        monitor.start(queue: DispatchQueue(label: "relo.path-monitor"))
        pathMonitor = monitor
    }

    private func requestMaintenance() {
        guard !Task.isCancelled, isForeground, let scope = currentSyncScopeIdentity, configuredSyncScopeIdentity == scope else { return }
        maintenance.bind(scope: scope)
        requestReadRecovery()
        scheduleNativeReconciliation(snapshot: InboxSnapshot(items: items), scope: scope)
        maintenance.request(.commands) { [weak self] in
            guard let self, self.currentSyncScopeIdentity == scope, !Task.isCancelled else { return }
            await self.responseSubmitter.flushPending()
        }
        maintenance.request(.receipts) { [weak self] in
            guard let self, self.currentSyncScopeIdentity == scope, !Task.isCancelled else { return }
            await self.flushLiveActivityDismissals()
            guard self.currentSyncScopeIdentity == scope, !Task.isCancelled else { return }
            await self.flushLiveActivityReceipts()
        }
        maintenance.request(.notificationReceipts) { [weak self] in
            guard let self, self.currentSyncScopeIdentity == scope, !Task.isCancelled else { return }
            await self.flushNotificationReceipts()
        }
        maintenance.request(.health) { [weak self] in
            guard let self, self.currentSyncScopeIdentity == scope, !Task.isCancelled else { return }
            await self.refreshDeliveryTransportStatus()
        }
        maintenance.startPolling(delay: { [weak self] attempt in
            .seconds(self?.foregroundRefreshDelaySeconds(afterAttempt: attempt) ?? 60)
        }, tick: { [weak self] in self?.requestMaintenance() })
    }

    func historyViewed() async {
        guard !Task.isCancelled, isForeground else { return }
        historyRequested = true
        guard historyLoadState != .current, let scope = currentSyncScopeIdentity else { return }
        maintenance.bind(scope: scope)
        maintenance.request(.history) { [weak self] in
            guard let self, self.currentSyncScopeIdentity == scope, !Task.isCancelled else { return }
            try? await self.reloadHistoryFromServer()
        }
        await maintenance.wait(for: .history)
    }

    /// `quiet`: a background follow-up sync; the connection status does not flash "Updating".
    private func performRefresh(quiet: Bool = false) async -> Bool {
        guard
            !Task.isCancelled, let syncEngine,
            let expectedScope = configuredSyncScopeIdentity,
            expectedScope == currentSyncScopeIdentity
        else { return false }
        if !quiet { syncState = .syncing }
        do {
            let snapshot = try await syncEngine.synchronize()
            guard
                !Task.isCancelled, expectedScope == configuredSyncScopeIdentity,
                expectedScope == currentSyncScopeIdentity
            else { return false }
            items = snapshot.items.filter { $0.withdrawnAt == nil }
            // Questions answered elsewhere (or withdrawn) that still sit in Notification Center leave it.
            let settled = SettledNotifications.ids(in: snapshot.items)
            Task { await SettledNotifications.remove(settled) }
            inboxReadWatermark = snapshot.readWatermark
            unreadCount = snapshot.unread?.account ?? items.filter { $0.readAt == nil }.count
            unreadByProject = snapshot.unread?.projects ?? [:]
            historySnapshot = InboxHistorySnapshot(items: snapshot.items, cursor: nil, hasMore: false,
                total: snapshot.total ?? snapshot.items.count, source: .server)
            historyLoadState = .current
            readCoordinator.reconcileHistory(snapshot.items)
            lastSyncedAt = snapshot.lastSuccessfulSyncAt
            inboxFollowedAt = .now
            syncState = .current
            resolvePendingNotification()
            resolvePendingActivity()
            reconcileSelectedItem()
            await updateApplicationBadge()
            guard
                !Task.isCancelled, expectedScope == configuredSyncScopeIdentity,
                expectedScope == currentSyncScopeIdentity
            else { return false }
            scheduleNativeReconciliation(snapshot: snapshot, scope: expectedScope)
            requestMaintenance()
            return true
        } catch InboxRemoteError.unauthorized {
            if !Task.isCancelled, expectedScope == configuredSyncScopeIdentity,
               expectedScope == currentSyncScopeIdentity {
                await handleRevokedDeviceCredential()
            }
        } catch {
            if !Task.isCancelled, expectedScope == configuredSyncScopeIdentity,
               expectedScope == currentSyncScopeIdentity {
                syncState = .offline(InboxRefreshErrorGuidance.message(for: error))
                resolvePendingNotification()
                resolvePendingActivity()
            }
        }
        return false
    }

    private func scheduleNativeReconciliation(snapshot: InboxSnapshot, scope: String) {
        guard isForeground else { return }
        maintenance.bind(scope: scope)
        maintenance.request(.nativeActivities) { [weak self] in
            guard let self, self.currentSyncScopeIdentity == scope, !Task.isCancelled else { return }
            let authoritative = await self.fetchAuthoritativeLiveActivities()
            guard self.currentSyncScopeIdentity == scope, !Task.isCancelled else { return }
            await self.applyPendingLiveActivityCommands(from: snapshot.items, authoritativeLiveActivities: authoritative)
            guard self.currentSyncScopeIdentity == scope, !Task.isCancelled else { return }
            if let authoritative {
                await self.convergeLiveActivitiesWithServerTruth(Set(authoritative.activities.map(\.identity)))
            }
        }
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
        dismissNotification()
        let requestRevision = selectionRevision
        let scopeRevision = selectionScopeRevision
        let scopeIdentity = currentSyncScopeIdentity
        guard let scopeIdentity, let credential else { return }
        // Capture the current credential directly; a delayed history configuration
        // must never leave detail using a predecessor account's remote adapter.
        let inboxRemote = makeInboxDataSource(serverURL, credential.accessToken)
        let cache = configuredSyncScopeIdentity == scopeIdentity ? detailCache : nil
        selectedNotificationID = notificationID
        if let item = (items + historySnapshot.items).first(where: { $0.id == notificationID }) {
            selectedItemSnapshot.select(item, scopeIdentity: scopeIdentity)
        }
        @MainActor func ownsSelection() -> Bool {
            !Task.isCancelled && requestRevision == selectionRevision
                && scopeRevision == selectionScopeRevision && scopeIdentity == currentSyncScopeIdentity
                && selectedNotificationID == notificationID
        }
        // Neither disk nor read bookkeeping gates the exact detail request.
        @MainActor @Sendable func restoreCachedSelection() async {
            guard let cached = try? await cache?.load(notificationID: notificationID),
                  ownsSelection(), self.selectedNotificationDetail == nil else { return }
            self.selectedCachedDetail = true
            self.selectedItemSnapshot.select(cached, scopeIdentity: scopeIdentity)
        }
        async let cachedRead: Void = restoreCachedSelection()
        async let read: Void = markNotificationRead(notificationID, remote: inboxRemote, scopeRevision: scopeRevision)
        Task {
            guard scopeRevision == selectionScopeRevision, scopeIdentity == currentSyncScopeIdentity else { return }
            await recordOpened(notificationID: notificationID)
        }
        do {
            let detail = try await inboxRemote.fetchDetail(notificationID: notificationID)
            guard ownsSelection(), detail.item.id == notificationID else { return }
            selectedItemSnapshot.select(detail.item, scopeIdentity: scopeIdentity)
            selectedNotificationDetail = detail
            try? await cache?.save(detail.item)
        } catch {
            guard ownsSelection() else { return }
            notificationDetailError = "Full notification details are unavailable. Try again when connected."
        }
        await cachedRead
        await read
    }

    func markAllNotificationsRead(notificationIDs: [String]? = nil) async {
        let captured = notificationIDs ?? historySnapshot.items.filter { $0.readAt == nil }.map(\.id)
        await queueReadIntent(captured)
    }

    var readRecoveryMessage: String? {
        switch readState.issue {
        case .full: return "Read queue is full. Connect to sync before marking more items."
        case .storage: return "Read status could not be saved on this iPhone. Try again after unlocking."
        case .authorization: return "Reconnect this iPhone to synchronize read status."
        case .invalidResponse: return "Read confirmation was incomplete. Saved changes will be retried."
        case .offline: return "Read status is saved on this iPhone and will sync when connected."
        case nil: return readState.pendingIDs.isEmpty ? nil : "Read status saved; waiting to sync."
        }
    }

    func isRead(_ item: InboxItem) -> Bool { item.readAt != nil || readState.locallyReadIDs.contains(item.id) }

    private func bindReadCoordinator() {
        guard let identity = currentSyncScopeIdentity, identity != boundReadScopeIdentity, let credential,
              let storage = try? StorageScope(serverOrigin: serverURL, accountID: credential.accountId, deviceID: credential.deviceId) else { return }
        let store: any PendingReadStoring
        if let existing = pendingReadStores[storage] { store = existing }
        else { store = makePendingReadStore(storage); pendingReadStores[storage] = store }
        readCoordinator.activate(scope: SessionScope(storage: storage, credentialVersion: credential.credentialVersion),
            store: store, remote: makeInboxDataSource(serverURL, credential.accessToken))
        boundReadScopeIdentity = identity
    }

    private func queueReadIntent(_ ids: [String]) async {
        guard !ids.isEmpty, let identity = currentSyncScopeIdentity else { return }
        bindReadCoordinator()
        guard await readCoordinator.enqueue(ids), currentSyncScopeIdentity == identity else { return }
        requestReadRecovery()
    }

    private func requestReadRecovery() {
        guard isForeground, let identity = currentSyncScopeIdentity else { return }
        bindReadCoordinator(); maintenance.bind(scope: identity)
        maintenance.request(.reads) { [weak self] in
            guard let self, !Task.isCancelled, self.currentSyncScopeIdentity == identity else { return }
            await self.readCoordinator.flush()
        }
    }

    private func acceptReadConfirmation(_ unread: InboxUnreadSummary) {
        guard let identity = currentSyncScopeIdentity, boundReadScopeIdentity == identity else { return }
        unreadCount = unread.account; unreadByProject = unread.projects
        guard isForeground, configuredSyncScopeIdentity == identity else { return }
        maintenance.request(.history) { [weak self] in
            guard let self, self.currentSyncScopeIdentity == identity, !Task.isCancelled else { return }
            try? await self.reloadHistoryFromServer()
        }
    }

    /// The Now summary from the server, minus missed questions this phone is dismissing right now
    /// and those the server already said are settled.
    func receiveNowSummary(_ summary: NowSummary) {
        let hidden = dismissingQuestionIDs.union(settledQuestionIDs)
        guard !hidden.isEmpty else { nowSummary = summary; return }
        nowSummary = summary.removingQuestions(hidden)
    }

    /// Dismisses a missed question from Needs you: the row leaves at once, the server is told, and Now
    /// refetches. A refusal means the row was stale, so it stays gone; any other failure brings it back
    /// with a short error. Never opens the notification.
    func dismissMissedQuestion(questionID: String) async {
        guard let credential, !dismissingQuestionIDs.contains(questionID) else { return }
        nowDismissError = nil
        let before = nowSummary
        dismissingQuestionIDs.insert(questionID)
        nowSummary = nowSummary?.removingQuestions([questionID])
        do {
            try await apiClient.dismissMissedQuestion(credential: credential, questionId: questionID)
            dismissingQuestionIDs.remove(questionID)
            nowRefetchRequest += 1
        } catch MobileAPIError.invalidRequest {
            // The server only refuses a question that is no longer missed (answered late, or not missed
            // any more): the row was stale, so it stays gone and Now refetches. Nothing to tell the owner.
            dismissingQuestionIDs.remove(questionID)
            settledQuestionIDs.insert(questionID)
            nowRefetchRequest += 1
        } catch {
            dismissingQuestionIDs.remove(questionID)
            // The row comes back: as it was, or with the refetch below when a newer summary arrived meanwhile.
            if let before, nowSummary == before.removingQuestions([questionID]) { nowSummary = before }
            nowDismissError = switch error {
            case MobileAPIError.reauthenticationRequired: "Couldn't dismiss: sign in again."
            default: "Couldn't dismiss. Check your connection and try again."
            }
            nowRefetchRequest += 1
        }
    }

    /// Ends a Quiet, Paused or Your-turn work from the phone (plan 12b, 4.11). The work leaves Now at once;
    /// the server decides the outcome (a delivered work ends as finished, anything else as dropped). A refusal
    /// because it is moving again, or any failure, leaves the work where it was with a short line.
    func endWork(workID: String) async {
        guard let credential, !endingWorkIDs.contains(workID) else { return }
        endWorkError = nil
        endWorkErrorWorkID = nil
        endingWorkIDs.insert(workID)
        defer { endingWorkIDs.remove(workID) }
        do {
            try await apiClient.endWork(credential: credential, workId: workID)
            if let notificationID = nowSummary?.item(id: workID)?.notificationId { endedNotificationIDs.insert(notificationID) }
            nowSummary = nowSummary?.removingWork(workID)
            nowRefetchRequest += 1
            _ = await refresh()
        } catch MobileAPIError.workRunning {
            endWorkError = WorkEnding.runningRefusal
            endWorkErrorWorkID = workID
            nowRefetchRequest += 1
        } catch MobileAPIError.invalidRequest {
            // Gone already: Now refetches and the row leaves with it.
            endWorkError = "This work is no longer there."
            endWorkErrorWorkID = workID
            nowRefetchRequest += 1
        } catch MobileAPIError.reauthenticationRequired {
            endWorkError = "Couldn't end the work: sign in again."
            endWorkErrorWorkID = workID
        } catch {
            endWorkError = "Couldn't end the work. Check your connection and try again."
            endWorkErrorWorkID = workID
        }
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

    private func markNotificationRead(
        _ notificationID: String, remote: any InboxDataSource, scopeRevision: UInt64
    ) async {
        guard isCurrentSelection(scopeRevision) else { return }
        await queueReadIntent([notificationID])
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
        await endDuplicateLiveActivities()
    }

    private func invalidateSelectionScope() {
        selectionScopeRevision &+= 1
        detailCache = nil
        boundReadScopeIdentity = nil; readCoordinator.stop()
        boundReceiptScopeIdentity = nil; receiptCoordinator.stop()
        historyRepair.stop(); maintenance.stop(); historyRequested = false
        historyScopeRevision += 1; historyRequestRevision += 1
        dismissNotification()
        synchronizeCurrentSession()
    }

    private func synchronizeCurrentSession() {
        guard runtimeReady, let credential,
              accountState != .signedOut, accountState != .signingOut, accountState != .disabled,
              accountSession?.account?.accountId == nil || accountSession?.account?.accountId == credential.accountId
        else {
            sessionController.stop()
            if runtimeReady { system.configureActivityTokens(nil) }
            return
        }
        do { try sessionController.ensure(origin: serverURL, credential: credential) }
        catch { sessionController.stop() }
        configureLiveActivityTokenContext()
    }

    private func configureLiveActivityTokenContext() {
        guard runtimeReady, let credential, sessionController.state != nil else {
            if runtimeReady { system.configureActivityTokens(nil) }
            return
        }
        let heartbeat = (try? pushTokenStore.load()).flatMap { try? makeHeartbeat(credential: credential, apnsToken: $0) }
        system.configureActivityTokens(.init(origin: serverURL, credential: credential, client: apiClient,
                                             environment: Self.apnsEnvironment, heartbeat: heartbeat))
    }

    var currentPresentation: CurrentInboxPresentation {
        CurrentInboxPresentation(state: currentState, now: currentTime)
    }

    var currentTime: Date { sessionController.currentTime() ?? currentState?.snapshot.evaluatedAt ?? Date() }

    func decisionAvailability(_ identity: CurrentDecisionIdentity) -> CurrentActionAvailability {
        let now = currentTime
        return CurrentInboxPresentation.availability(for: identity, state: sessionController.state, now: now)
    }

    func currentDecision(notificationID: String) -> CurrentDecisionDraft? {
        guard let state = currentState,
              let item = state.snapshot.pending?.entries.values.first(where: { $0.item.notificationId == notificationID })?.item else { return nil }
        let identity = CurrentDecisionIdentity(pending: item, scope: state.scope.storage)
        return decisionDrafts[identity.id] ?? CurrentDecisionDraft(identity: identity, title: item.title, prompt: item.summary)
    }

    var retainedDecisionDrafts: [CurrentDecisionDraft] {
        decisionDrafts.values.filter { $0.identity.scope == currentState?.scope.storage }
            .sorted { $0.identity.expiresAt < $1.identity.expiresAt }
    }

    func retainDecisionDraft(_ draft: CurrentDecisionDraft) {
        guard draft.identity.scope == currentState?.scope.storage else { return }
        if draft.text.isEmpty || responseIsAccepted(for: draft.identity.notificationID) { decisionDrafts.removeValue(forKey: draft.id) }
        else { decisionDrafts[draft.id] = draft }
    }

    func verifyCurrentDecision(_ identity: CurrentDecisionIdentity) async {
        guard identity.scope == currentState?.scope.storage, decisionAvailability(identity) == .unverified else { return }
        await sessionController.refresh(subjectIDs: [identity.subjectID])
    }

    func showCurrentWork() {
        dismissNotification()
        currentNavigationRevision &+= 1
    }

    func retryCurrentStorage() { sessionController.retryStorage() }
    func refreshCurrent() async { await sessionController.refresh() }
    func loadMoreCurrent() async { await sessionController.loadMoreCurrent() }
    func loadMorePending() async { await sessionController.loadMorePending() }

    func currentChangeReceived() { sessionController.receive(.reconcile) }

    func backgrounded() {
        isForeground = false
        sessionController.setForeground(false)
        pathMonitor?.cancel(); pathMonitor = nil
        historyRepair.stop(); maintenance.stop(); readCoordinator.suspend(); receiptCoordinator.suspend()
    }

    func backgroundCurrentRefresh(
        waitForDeadline: @escaping @Sendable () async throws -> Void = { try await Task.sleep(for: .seconds(5)) }
    ) async -> Bool {
        await BoundedDecisionAttempt.run(waitForDeadline: waitForDeadline) { [weak self] in
            guard let self else { return false }
            if !self.runtimeReady {
                do {
                    guard try self.signOutProgressStore.load() == nil,
                          let restored = try self.credentialStore.load() else { return false }
                    self.accountSession = try self.accountSessionStore.load()
                    self.credential = restored
                    self.runtimeReady = true
                    self.isForeground = false
                    self.sessionController.setForeground(false)
                    self.synchronizeCurrentSession()
                } catch { return false }
            }
            return await self.sessionController.reconcileInBackground()
        }
    }

    func dismissNotification() {
        selectionRevision &+= 1
        pendingNotificationID = nil
        pendingActivityIdentity = nil
        selectedNotificationID = nil
        selectedNotificationDetail = nil
        notificationDetailError = nil
        selectedCachedDetail = false
        selectedItemSnapshot.dismiss()
        interactionError = nil
    }

    // MARK: Connect a computer (docs/internal/product/plan/13-onboarding-wizard.md, journey E)

    /// The wizard sheet, opened from Settings, the Live Activity (relo://setup) or the first sign-in of an account.
    var presentsComputerSetup = false
    /// A fresh sign-in asked for the wizard once the account's computers are known and there are none.
    var computerSetupOfferPending = false
    /// The code the wizard showed and its bind half, in the Keychain for the code's 30 minutes.
    @ObservationIgnored var computerInviteStore: any ComputerInviteStoring = InMemoryComputerInviteStore()
    @ObservationIgnored lazy var computerSetup = ConnectComputerModel(app: self)

    func openComputerSetup() { presentsComputerSetup = true }

    /// After a first sign-in: an account with no computer opens the wizard, once.
    func offerComputerSetupIfNew() async {
        guard computerSetupOfferPending, credential != nil else { return }
        await refreshDevices()
        guard case .ready = devices.phase else { return }
        computerSetupOfferPending = false
        if devices.computers.isEmpty, !computerSetup.hasPending { presentsComputerSetup = true }
    }

    func openSecuritySettings() {
        securitySettingsRequests += 1
        securitySettingsNavigationPending = true
    }

    // MARK: Devices (Settings → Devices, the request sheet, Now's "Needs you" row)

    /// Phones and computers of this account, and what waits for the owner's approval here.
    @ObservationIgnored let devices = EncryptionSecurityModel()
    /// The request sheet on screen: a `dev_…` phone, `key_…` computer or `brw_…` browser id.
    var presentedAccessRequestID: String?

    /// The icon of the computer a History origin label names ("MacBook Pro" or "MacBook Pro · Work"): the
    /// account's computers by name, else a laptop. Names come from the same login the cards were sent with.
    func computerIcon(forOrigin label: String?) -> ComputerIcon {
        guard let label, !label.isEmpty else { return .laptop }
        let known = devices.computers.map(\.client).filter { $0.name == label || label.hasPrefix($0.name + " · ") }
        return known.max { $0.name.count < $1.name.count }?.icon ?? .laptop
    }

    func refreshDevices() async {
        await devices.refresh(credential: credential, client: apiClient)
    }

    /// relo://security/request/<id>, the notification's Review, or a tap on Now's "Needs you" row.
    func openAccessRequest(id: String) {
        presentedAccessRequestID = id
        if devices.request(id: id) == nil { Task { await refreshDevices() } }
    }

    /// The notification's Approve, answered without opening Relo (iOS asked for Face ID or the
    /// passcode first: the action is `.authenticationRequired`). False when it could not be done; the
    /// caller then tells the owner to open Relo.
    func approveAccessRequestInBackground(id: String) async -> (approved: Bool, name: String?) {
        // A launch for this action alone has not restored the session; read the stored credential.
        var stored = credential
        if stored == nil {
            do {
                guard try signOutProgressStore.load() == nil else { return (false, nil) }
                stored = try credentialStore.load()
            } catch { return (false, nil) }
        }
        guard let stored else { return (false, nil) }
        await devices.refresh(credential: stored, client: apiClient)
        // A browser is approved only on screen, after comparing its link code.
        guard let request = devices.request(id: id), !request.isBrowser else { return (false, nil) }
        let approved = await devices.approve(request, credential: stored, approver: apiClient as? any DeviceApproving,
                                             signer: answerSigner?())
        return (approved, request.name)
    }

    func openActivity(identity: LiveActivityIdentity) async {
        guard identity.isValid else { return }
        dismissNotification()
        pendingActivityIdentity = identity
        resolvePendingActivity()
        if pendingActivityIdentity != nil {
            _ = await refresh()
        }
    }

    func respond(
        to item: InboxItem,
        action: NotificationInteractionAction,
        text: String? = nil,
        optionID: String? = nil
    ) async {
        guard
            respondingNotificationID == nil,
            !responseIsQueued(for: item.id),
            !responseIsAccepted(for: item.id),
            let credential,
            let interaction = item.interaction,
            NotificationResponsePolicy.supports(action, kind: interaction.kind),
            action != .choose || interaction.option(id: optionID) != nil
        else { return }
        guard interaction.state == .pending, interaction.expiresAt > .now else {
            responseFeedbackByNotificationID[item.id] = NotificationResponseFeedback(
                phase: .rejected, action: action,
                message: interaction.expiresAt <= .now ? "Request expired — nothing sent" : "Request already answered or replaced")
            return
        }
        await protectAndSendResponse(notificationID: item.id, interactionID: interaction.id,
            expiresAt: interaction.expiresAt, credential: credential, action: action, text: text,
            optionID: action == .choose ? optionID : nil)
    }

    /// Current UI submits the immutable request without fetching history or full details first.
    func respond(
        to identity: CurrentDecisionIdentity, action: NotificationInteractionAction, text: String? = nil,
        optionID: String? = nil
    ) async {
        let availability = decisionAvailability(identity)
        guard availability.permitsSubmission, let credential,
              let kind = InboxInteraction.Kind(rawValue: identity.kind.rawValue),
              NotificationResponsePolicy.supports(action, kind: kind),
              action != .choose || identity.options.contains(where: { $0.id == optionID }) else {
            responseFeedbackByNotificationID[identity.notificationID] = NotificationResponseFeedback(
                phase: .rejected, action: action, message: availability.explanation ?? "This action is unavailable.")
            return
        }
        await protectAndSendResponse(notificationID: identity.notificationID, interactionID: identity.interactionID,
            expiresAt: identity.expiresAt, credential: credential, action: action, text: text,
            optionID: action == .choose ? optionID : nil)
    }

    private func protectAndSendResponse(notificationID: String, interactionID: String, expiresAt: Date,
                                        credential: DeviceCredential, action: NotificationInteractionAction, text: String?,
                                        optionID: String? = nil) async {
        let diagnosticID = UUID()
        let diagnosticStart = ContinuousClock.now
        let accountID = credential.accountId
        let responseScopeRevision = selectionScopeRevision
        respondingNotificationID = notificationID
        responseFeedbackByNotificationID[notificationID] = NotificationResponseFeedback(
            phase: .sending,
            action: action
        )
        interactionError = nil
        defer { if respondingNotificationID == notificationID { respondingNotificationID = nil } }

        let trimmedText = NotificationReplyPolicy.normalized(text)
        if action == .answer, !NotificationReplyPolicy.isValid(trimmedText) {
            interactionError = NotificationReplyPolicy.validationMessage
            responseFeedbackByNotificationID[notificationID] = NotificationResponseFeedback(
                phase: .rejected,
                action: action,
                message: NotificationReplyPolicy.validationMessage
            )
            return
        }
        // A choice sends the option it picks, and a different option is a different request.
        let value = optionID.map { ["optionId": $0] } ?? trimmedText.map { ["response": $0] } ?? [:]
        let unsigned = PendingNotificationResponse(
            accountID: accountID,
            deviceID: credential.deviceId,
            notificationID: notificationID,
            action: action,
            value: value,
            idempotencyKey: "ios:\(credential.installationId):\(notificationID):\(action.rawValue)"
                + (optionID.map { ":\($0)" } ?? ""),
            expiresAt: expiresAt,
            interactionID: interactionID,
            serverOrigin: serverURL
        )
        // Signed once, here, so the queued answer retries with identical bytes (E4.2), and bound to the
        // sealed question this phone opened and showed.
        let pending = ReloAnswerSigning.sign(unsigned, signer: answerSigner?(),
                                             question: openedSealedQuestionContext(notificationID: notificationID))
        var selectedResponse = pending
        do {
            let enqueue = try await pendingResponseStore.enqueue(pending)
            guard selectionScopeRevision == responseScopeRevision, self.credential?.accessToken == credential.accessToken else { return }
            switch enqueue {
            case .enqueued:
                responseFeedbackByNotificationID[notificationID] = NotificationResponseFeedback(
                    phase: .queued,
                    action: action
                )
            case .alreadyPending(let existing):
                selectedResponse = existing
                responseFeedbackByNotificationID[notificationID] = NotificationResponseFeedback(
                    phase: .queued,
                    action: existing.action
                )
            case .alreadyNotificationConfirmed(let confirmation):
                recordDiagnostic(.init(operation: .responseSubmission, phase: .completed,
                    timestamp: confirmation.confirmedAt, outcome: .confirmed, priority: .immediate))
                responseFeedbackByNotificationID[notificationID] = NotificationResponseFeedback(
                    phase: .accepted,
                    action: confirmation.action,
                    canonicalState: confirmation.canonicalState
                )
                return
            case .alreadyConfirmed:
                throw LiveActivityResponseConfirmationError.responseMismatch
            }
            recordDiagnostic(.init(operation: .responseSubmission, phase: .persisted, correlationID: diagnosticID,
                durationMilliseconds: Self.diagnosticMilliseconds(since: diagnosticStart), outcome: .pending, priority: .immediate))
            _ = await responseSubmitter.submit(selectedResponse, credential: credential)
        } catch let failure as NotificationResponseFailure {
            if selectionScopeRevision == responseScopeRevision {
                recordDiagnostic(.init(operation: .responseSubmission, phase: .completed, correlationID: diagnosticID,
                    outcome: OperationDiagnostic.outcome(for: MobileAPIError.decisionRejected(failure.reason)), priority: .immediate))
            }
            guard selectionScopeRevision == responseScopeRevision, self.credential?.accessToken == credential.accessToken else { return }
            responseFeedbackByNotificationID[notificationID] = NotificationResponseFeedback(
                phase: .rejected, action: failure.response.action, message: failure.reason.message)
        } catch {
            if selectionScopeRevision == responseScopeRevision {
                recordDiagnostic(.init(operation: .responseSubmission, phase: .completed, correlationID: diagnosticID,
                    outcome: .storageUnavailable, priority: .immediate))
            }
            guard selectionScopeRevision == responseScopeRevision, self.credential?.accessToken == credential.accessToken else { return }
            interactionError = "The response could not be protected locally. Nothing was sent or assumed."
            responseFeedbackByNotificationID[notificationID] = NotificationResponseFeedback(
                phase: .rejected,
                action: action,
                message: "Nothing was sent or assumed — retry"
            )
        }
    }

    func respond(
        notificationID: String, action: NotificationInteractionAction, text: String? = nil, optionID: String? = nil
    ) async {
        if let item = (items + historySnapshot.items).first(where: { $0.id == notificationID }) {
            await respond(to: item, action: action, text: text, optionID: optionID)
            return
        }
        // An identifier alone carries no deadline. Resolve only this exact event;
        // never invent validity or fetch the whole inbox before responding.
        let revision = selectionScopeRevision
        if let detail = try? await inboxRemote?.fetchDetail(notificationID: notificationID),
           revision == selectionScopeRevision, detail.item.id == notificationID {
            await respond(to: detail.item, action: action, text: text, optionID: optionID)
            return
        }
        guard revision == selectionScopeRevision else { return }
        responseFeedbackByNotificationID[notificationID] = NotificationResponseFeedback(
            phase: .rejected, action: action, message: "Request details unavailable — open Relo to retry")
    }

    /// Called from the notification delegate, including a launch without a scene.
    /// Only the protected response scope is restored; no sync, health, or token work.
    func respondToNotificationAction(_ request: NotificationActionRequest) async {
        if credential == nil, accountState == .restoring, !hasStarted {
            do {
                guard let restored = try credentialStore.load() else { return }
                if let metadata = request.metadata,
                   (restored.accountId != metadata.accountID || restored.deviceId != metadata.deviceID) { return }
                credential = restored
                selectedAccountId = restored.accountId
                try await pendingResponseStore.select(accountID: restored.accountId, deviceID: restored.deviceId)
            } catch { return }
        }
        guard !Task.isCancelled, let credential else { return }
        guard let metadata = request.metadata else {
            // Bounded transition for already-delivered notifications. Resolve the
            // immutable event with the captured credential; never grant fresh TTL.
            let revision = selectionScopeRevision
            let remote = inboxRemote ?? makeInboxDataSource(serverURL, credential.accessToken)
            if let detail = try? await remote.fetchDetail(notificationID: request.notificationID),
               isCurrentSelection(revision), self.credential == credential,
               detail.item.id == request.notificationID {
                await respond(to: detail.item, action: request.action, text: request.text, optionID: request.optionID)
            } else if isCurrentSelection(revision) {
                responseFeedbackByNotificationID[request.notificationID] = NotificationResponseFeedback(
                    phase: .rejected, action: request.action,
                    message: "Original request details unavailable — open Relo to retry")
            }
            return
        }
        guard credential.accountId == metadata.accountID, credential.deviceId == metadata.deviceID else { return }
        let item = InboxItem(id: request.notificationID, kind: .notification, sourceName: "Relo",
            title: "Notification response", createdAt: .now,
            interaction: InboxInteraction(id: metadata.interactionID, kind: metadata.kind, prompt: "",
                state: .pending, expiresAt: metadata.expiresAt, options: metadata.options))
        await respond(to: item, action: request.action, text: request.text, optionID: request.optionID)
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

    private var liveActivityApplier: LiveActivityApplier {
        LiveActivityApplier(
            coordinator: liveActivityCoordinator,
            observe: { [weak self] in self?.observeActivityKitUpdates(for: $0) },
            reconnectActivityTokens: { [weak self] in self?.system.reconnectActivityTokens() }
        )
    }

    private func applyPendingLiveActivityCommands(
        from items: [InboxItem],
        authoritativeLiveActivities: ActiveLiveActivityIdentityPage? = nil
    ) async {
        guard let scope = currentSyncScopeIdentity else { return }
        await liveActivityApplier.applyPending(
            from: items,
            authoritativeLiveActivities: authoritativeLiveActivities,
            context: LiveActivityApplicationContext(
                isCurrent: { [weak self] in self?.currentSyncScopeIdentity == scope && !Task.isCancelled },
                deviceID: { [weak self] in self?.credential?.deviceId },
                accountID: { [weak self] in self?.credential?.accountId },
                selectedAccountID: { [weak self] in self?.selectedAccountId },
                selectionRevision: { [weak self] in self?.selectionScopeRevision ?? .max }
            )
        )
    }

    private func flushNotificationReceipts() async {
        guard !Task.isCancelled, let credential, let expectedScope = currentSyncScopeIdentity else { return }
        do {
            if boundReceiptScopeIdentity != expectedScope {
                let storage = try StorageScope(serverOrigin: serverURL, accountID: credential.accountId, deviceID: credential.deviceId)
                let remote = try HTTPNotificationReceiptSource(scope: storage, credential: credential)
                try receiptCoordinator.activate(scope: SessionScope(storage: storage, credentialVersion: credential.credentialVersion),
                    store: notificationReceiptStore, remote: remote)
                boundReceiptScopeIdentity = expectedScope
                reportedNotFoundReceiptRetirements = 0
            }
            await receiptCoordinator.flush()
            guard !Task.isCancelled, expectedScope == currentSyncScopeIdentity else { return }
            let state = receiptCoordinator.state
            recordDiagnostic(.init(operation: .receiptUpload, phase: .completed,
                outcome: RecoveryStatusPolicy.receipts(state), priority: .maintenance))
            let logger = Logger(subsystem: "relo.app", category: "receipts")
            if state.retiredUnscoped > reportedLegacyReceiptRetirements {
                logger.notice("Retired \(state.retiredUnscoped) unscoped predecessor receipts without reassignment")
                reportedLegacyReceiptRetirements = state.retiredUnscoped
            }
            if state.retiredNotFound > reportedNotFoundReceiptRetirements {
                logger.notice("Retired \(state.retiredNotFound) exact-scope receipts after server not-found acknowledgement")
                reportedNotFoundReceiptRetirements = state.retiredNotFound
            }
            if state.issue == .unauthorized { await handleRevokedDeviceCredential() }
            else if state.issue != nil { logger.notice("Receipt replay paused with records retained") }
        } catch { Logger(subsystem: "relo.app", category: "receipts").error("Receipt scope could not be configured") }
    }

    private func retireNotificationReceipts(credential: DeviceCredential?) async throws {
        guard let credential else { return }
        let scope = try ReceiptScope(serverOrigin: serverURL, accountId: credential.accountId, deviceId: credential.deviceId)
        try await notificationReceiptStore.retire(scope: scope)
    }

    private func flushLiveActivityReceipts() async {
        guard !Task.isCancelled, let credential, let expectedScope = currentSyncScopeIdentity else { return }
        let result = await acknowledgementUploader.uploadReceived(
            credential: credential,
            isCurrent: { !Task.isCancelled && expectedScope == currentSyncScopeIdentity },
            credentialUnchanged: { self.credential?.accessToken == credential.accessToken }
        )
        if result == .credentialRevoked { await handleRevokedDeviceCredential() }
    }

    private func flushLiveActivityDismissals() async {
        guard !Task.isCancelled, let credential, let expectedScope = currentSyncScopeIdentity else { return }
        let result = await acknowledgementUploader.uploadDismissals(
            credential: credential,
            isCurrent: { !Task.isCancelled && expectedScope == currentSyncScopeIdentity },
            credentialUnchanged: { self.credential?.accessToken == credential.accessToken }
        )
        if result == .credentialRevoked { await handleRevokedDeviceCredential() }
    }

    private var acknowledgementUploader: LiveActivityAcknowledgementUploader {
        LiveActivityAcknowledgementUploader(coordinator: liveActivityCoordinator, client: apiClient)
    }

    func sendHeartbeat() async {
        guard let credential, !Task.isCancelled else { return }
        let revision = selectionScopeRevision, client = apiClient
        func ownsHeartbeat() -> Bool { isCurrentSelection(revision) && self.credential == credential }
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
            try await client.heartbeat(
                credential: credential,
                heartbeat: try makeHeartbeat(credential: credential, apnsToken: apnsToken)
            )
            guard ownsHeartbeat() else { return }
            serverAcceptedCurrentAPNSToken = apnsTokenAvailable
                && (try? pushTokenStore.load()) == apnsToken
            registrationState = serverAcceptedCurrentAPNSToken ? .registered : .waitingForAPNSToken
            await maintainEncryptionKeys(credential: credential)
        } catch MobileAPIError.reauthenticationRequired, MobileAPIError.forbidden {
            guard ownsHeartbeat() else { return }
            await handleRevokedDeviceCredential()
        } catch {
            guard ownsHeartbeat() else { return }
            if !wasReady {
                registrationState = .failed("Relo server could not confirm this iPhone's current Apple Push token. Retry when connected.")
            }
        }
    }

    func pushRegistrationChanged() async {
        configureLiveActivityTokenContext()
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
        isForeground = true
        sessionController.setForeground(true)
        startPathMonitor()
        synchronizeCurrentSession()
        sessionController.retryNow()
        sessionController.receive(.reconcile)
        requestMaintenance()
        await updatePermission()
        guard !Task.isCancelled, isForeground else { return }
        await synchronizeLiveActivityTokens()
        guard !Task.isCancelled, isForeground else { return }
        if accountSession != nil {
            await registerDevice()
        } else {
            await sendHeartbeat()
            await refresh()
        }
        guard !Task.isCancelled, isForeground else { return }
        // Signed-in phones register instead of sending a heartbeat, so keys are kept current here too.
        if let credential { await maintainEncryptionKeys(credential: credential) }
        guard !Task.isCancelled, isForeground else { return }
        requestMaintenance()
    }

    private func refreshDeliveryTransportStatus(force: Bool = false) async {
        guard let accountSession else {
            deliveryTransportStatus = nil
            deliveryTransportStatusError = nil
            deliveryStatusScopeIdentity = nil
            deliveryStatusLastAttemptAt = nil
            return
        }
        let expectedRevision = selectionScopeRevision, client = apiClient
        let expectedScope = "\(serverURL.absoluteString)|\(accountSession.sessionId)|\(accountSession.user.id)"
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
            let status = try await client.deliveryTransportStatus(
                sessionToken: accountSession.accessToken
            )
            guard
                isCurrentSelection(expectedRevision),
                self.accountSession?.sessionId == accountSession.sessionId,
                self.accountSession?.user.id == accountSession.user.id,
                deliveryStatusScopeIdentity == expectedScope
            else { return }
            deliveryTransportStatus = status
            deliveryTransportStatusError = nil
        } catch {
            guard
                isCurrentSelection(expectedRevision),
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
        let previousState = accountState
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
            // Revoke whenever a credential is still held, even if an earlier attempt recorded it:
            // recovery can re-register the same device id in between, and revoking is idempotent.
            if let credential {
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
            // Complete receipt cleanup before erasing the identity needed to resume this journal.
            try await retireNotificationReceipts(credential: credential)
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
            await encryptionKeys?.forget()
            encryptionKeysProblem = nil
            try signOutProgressStore.delete()
            return true
        } catch {
            // Still signed in: keep the state it had (re-auth, disabled...) and start syncing again,
            // so a failed attempt never leaves the app frozen until relaunch.
            accountState = credential == nil && accountSession == nil ? .signedOut : previousState
            signOutError = Self.signOutFailureMessage(error)
            Task { _ = await self.refresh() }
            return false
        }
    }

    private static func signOutFailureMessage(_ error: Error) -> String {
        switch error as? MobileAPIError {
        case .forbidden?:
            return "Your server refused to remove this iPhone. Open the dashboard to remove it, then try again."
        case .some:
            return "Couldn't reach your Relo server to finish signing out. Check your connection and try again; steps already done won't repeat."
        case nil:
            return "Couldn't clear this iPhone's saved sign-in. Try again."
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
        do {
            try await retireNotificationReceipts(credential: credential)
        } catch { localCleanupFailed = true }
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
        guard let accountSession, !Task.isCancelled,
              accountState != .signedOut, accountState != .signingOut, accountState != .disabled else { return }
        var expectedRevision = selectionScopeRevision
        func ownsRegistration() -> Bool { isCurrentSelection(expectedRevision) }
        let client = apiClient
        authenticationError = nil
        if let prerequisite = registrationPrerequisite(hasAuthenticatedAccount: true) {
            registrationState = prerequisite
            return
        }
        // Launch, foreground and push-token callbacks all ask to register. When the server already
        // registered exactly this request for the credential held, registering again would only
        // rotate the credential and restart the live connection (it never settled on the iPhone).
        if let credential, let request = try? makeRegistrationRequest(),
           registrationAttemptStore.isRegistered(for: request, credentialVersion: credential.credentialVersion) {
            if registrationState != .registered { registrationState = .registered }
            return
        }
        registrationState = .registering
        var stage = DeviceRegistrationStage.localRegistrationData

        do {
            if let sessionAccountID = accountSession.account?.accountId,
               let credentialAccountID = credential?.accountId,
               sessionAccountID != credentialAccountID {
                try await retireCurrentDeviceBinding()
                guard self.accountSession == accountSession, !Task.isCancelled else { return }
                expectedRevision = selectionScopeRevision
            }
            let request = try makeRegistrationRequest()
            let attempt = try registrationAttemptStore.attempt(
                for: request,
                minimumRevision: (credential?.credentialVersion ?? 0) + 1
            )
            stage = .network
            let response = try await client.registerDevice(
                sessionToken: accountSession.accessToken,
                request: request,
                idempotencyKey: attempt.idempotencyKey(installationId: request.installationId,
                                                       sessionId: accountSession.sessionId)
            )
            guard ownsRegistration() else { return }
            await quiesceRefresh()
            guard ownsRegistration() else { return }
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
            expectedRevision = selectionScopeRevision

            let switchedAccounts = previousAccountId != nil && previousAccountId != response.account.accountId
            do {
                try await cache.select(accountId: response.account.accountId)
                guard ownsRegistration() else { return }
                try await liveActivityCoordinator.select(
                    accountID: response.account.accountId,
                    deviceID: response.device.deviceId
                )
                guard ownsRegistration() else { return }
                try await pendingResponseStore.select(
                    accountID: response.account.accountId,
                    deviceID: response.device.deviceId
                )
                guard ownsRegistration() else { return }
                selectedAccountId = response.account.accountId
                expectedRevision = selectionScopeRevision
                let snapshot = try await cache.load()
                guard ownsRegistration() else { return }
                items = snapshot.items
                useCachedHistory(snapshot.items)
                await updateApplicationBadge()
                guard ownsRegistration() else { return }
                lastSyncedAt = snapshot.lastSuccessfulSyncAt
                resolvePendingNotification()
                resolvePendingActivity()
            } catch {
                guard ownsRegistration() else { return }
                // Cache access can fail while protected data is unavailable. Never
                // erase valid bytes or same-account presentation to recover it.
                if switchedAccounts {
                    items = []
                    clearHistory()
                    lastSyncedAt = nil
                }
                syncState = .offline("Protected history is temporarily unavailable; Relo will retry")
            }
            if switchedAccounts {
                syncState = .idle
            }
            do {
                try registrationAttemptStore.recordRegistrationSuccess(credentialVersion: response.device.credentialVersion)
            } catch {
                // Registration-attempt bookkeeping is disposable. Never retain a
                // stale retry deadline after the server accepted registration.
                try? registrationAttemptStore.delete()
            }
            registrationRecoveryTask?.cancel()
            registrationRecoveryTask = nil
            registrationState = .registered
            await configureSyncEngine()
            guard ownsRegistration() else { return }
            await synchronizeLiveActivityTokens()
            guard ownsRegistration() else { return }
            await refresh()
        } catch {
            guard ownsRegistration() else { return }
            applyRegistrationFailure(DeviceRegistrationPolicy.failure(for: error, at: stage))
        }
    }

    private func applyRegistrationFailure(_ failure: DeviceRegistrationFailure) {
        switch failure.accountEffect {
        case .reauthenticationRequired: accountState = .reauthenticationRequired
        case .disabled: accountState = .disabled
        case .none: break
        }
        if failure.advancesAttempt { try? registrationAttemptStore.advanceCurrentAttempt() }
        registrationState = .failed(failure.message)
        if case .scheduled(let seconds) = failure.retry {
            scheduleRegistrationRecoveryAfterFailure(retryAfter: seconds.map(TimeInterval.init))
        }
    }

    private func retireCurrentDeviceBinding() async throws {
        guard let credential else { return }
        let revision = selectionScopeRevision, client = apiClient
        func requireScope() throws {
            guard isCurrentSelection(revision), self.credential == credential else { throw CancellationError() }
        }
        await quiesceRefresh()
        try requireScope()
        try await client.revokeDevice(credential: credential)
        try requireScope()
        await endAllLiveActivities()
        try requireScope()
        try? await liveActivityCoordinator.clearSelectedAccount()
        try requireScope()
        try? await pendingResponseStore.clearSelectedAccount()
        try requireScope()
        try await retireNotificationReceipts(credential: credential)
        try requireScope()
        try credentialStore.delete()
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

    private func selectAndLoadCache(accountId: String) async -> Bool {
        var revision = selectionScopeRevision
        func ownsCacheRead() -> Bool { isCurrentSelection(revision) }
        do {
            try await cache.select(accountId: accountId)
            guard ownsCacheRead() else { return false }
            selectedAccountId = accountId
            revision = selectionScopeRevision
            if let credential {
                try await liveActivityCoordinator.select(accountID: accountId, deviceID: credential.deviceId)
                guard ownsCacheRead() else { return false }
                try await pendingResponseStore.select(accountID: accountId, deviceID: credential.deviceId)
                guard ownsCacheRead() else { return false }
            }
            let snapshot = try await cache.load()
            guard ownsCacheRead() else { return false }
            items = snapshot.items
            useCachedHistory(snapshot.items)
            await updateApplicationBadge()
            guard ownsCacheRead() else { return false }
            lastSyncedAt = snapshot.lastSuccessfulSyncAt
            resolvePendingNotification()
            resolvePendingActivity()
            if credential != nil { registrationState = .registered }
            return true
        } catch {
            guard ownsCacheRead() else { return false }
            syncState = .offline("Protected activity history could not be opened")
            return true
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
        let remote = makeInboxDataSource(serverURL, credential.accessToken)
        inboxRemote = remote
        syncEngine = InboxSyncEngine(remote: remote, cache: boundCache)
        configuredSyncScopeIdentity = scopeIdentity
        bindReadCoordinator()
        historyPager = nil
        if let scope = try? StorageScope(serverOrigin: serverURL, accountID: credential.accountId, deviceID: credential.deviceId) {
            detailCache = makeDetailCache(scope)
        }
        historyScopeRevision += 1
        historyRequestRevision += 1
        historySnapshot = .offlineCache(items: items)
        historyLoadState = .idle
    }

    private func reloadHistoryFromServer() async throws {
        guard let scope = currentSyncScopeIdentity else { return }
        historyLoadState = .loading
        let repaired = await historyRepair.repair(scope: scope) { [weak self] in
            guard let self, self.currentSyncScopeIdentity == scope, !Task.isCancelled else { return false }
            return await self.performRefresh()
        }
        guard !Task.isCancelled, currentSyncScopeIdentity == scope else { return }
        if !repaired { historyLoadState = .offline("Server history is unavailable; showing retained activity") }
    }

    private func useCachedHistory(_ cachedItems: [InboxItem]) {
        historySnapshot = .offlineCache(items: cachedItems)
        historyLoadState = .idle
        reconcileSelectedItem()
    }

    private func reconcileSelectedItem() {
        guard !selectedCachedDetail, selectedNotificationDetail == nil else { return }
        guard let scopeIdentity = currentSyncScopeIdentity else { return }
        selectedItemSnapshot.reconcile(
            scopeIdentity: scopeIdentity,
            availableItems: items + historySnapshot.items
        )
        // Exact detail may be loading outside the retained history window.
        // Only explicit dismissal or a scope transition clears its selection.
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
        historyRepair.stop(); maintenance.stop()
        readCoordinator.suspend(); receiptCoordinator.suspend()
    }

    private func updateApplicationBadge() async {
        guard let count = currentPresentation.actionableCount else { return }
        currentBadge.set(count)
        await currentBadge.waitForUpdate()
    }

    func handleRevokedDeviceCredential() async {
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
        permission = await system.notificationPermission()
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
        let hardware = ReloDeviceModelName.current()
        return DeviceRegistrationRequest(
            stableDeviceId: try stableDeviceIDStore.loadOrCreate(),
            installationId: try installationIDStore.loadOrCreate(),
            name: ReloDeviceModelName.deviceName(systemName: UIDevice.current.name, identifier: hardware.identifier),
            bundleIdentifier: Bundle.main.bundleIdentifier ?? "com.example.relo.notifications",
            appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0",
            appBuild: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0",
            osVersion: UIDevice.current.systemVersion,
            model: hardware.identifier,
            apnsEnvironment: Self.apnsEnvironment,
            apnsToken: try pushTokenStore.load(),
            notificationAuthorization: notificationAuthorization,
            liveActivityAuthorization: ActivityAuthorizationInfo().areActivitiesEnabled ? .authorized : .denied,
            liveActivityPushToStartToken: try liveActivityPushToStartTokenStore.load(),
            isSimulator: hardware.isSimulator
        )
    }

    private func makeHeartbeat(credential: DeviceCredential, apnsToken: String) throws -> DeviceHeartbeat {
        let hardware = ReloDeviceModelName.current()
        return DeviceHeartbeat(
            deviceId: credential.deviceId,
            installationId: try installationIDStore.loadOrCreate(),
            deviceName: ReloDeviceModelName.deviceName(systemName: UIDevice.current.name, identifier: hardware.identifier),
            bundleId: Bundle.main.bundleIdentifier ?? "com.example.relo.notifications",
            appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0",
            appBuild: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0",
            iosVersion: UIDevice.current.systemVersion,
            deviceModel: hardware.identifier,
            apnsToken: apnsToken,
            apnsEnvironment: Self.apnsEnvironment,
            notificationAuthorization: permission == .allowed ? .authorized : .denied,
            liveActivityAuthorization: ActivityAuthorizationInfo().areActivitiesEnabled ? .authorized : .denied,
            liveActivityPushToStartToken: try liveActivityPushToStartTokenStore.load(),
            model: hardware.identifier,
            isSimulator: hardware.isSimulator
        )
    }

    func startLiveActivityObservation() {
        if activityUpdatesTask == nil {
            activityUpdatesTask = Task { @MainActor [weak self] in
                for await activity in Activity<ReloActivityAttributes>.activityUpdates {
                    guard !Task.isCancelled, let self else { return }
                    self.observeActivityKitUpdates(for: activity)
                    self.currentChangeReceived()
                    await self.endDuplicateLiveActivities()
                }
            }
        }
        for activity in Activity<ReloActivityAttributes>.activities {
            observeActivityKitUpdates(for: activity)
        }
        Task { await endDuplicateLiveActivities() }
    }

    /// The server's push-to-start and the app's own start can race and leave two copies of one
    /// card on the Lock Screen; keep the copy furthest along and end the others at once.
    private func endDuplicateLiveActivities() async {
        let live = Activity<ReloActivityAttributes>.activities.filter {
            $0.activityState == .active || $0.activityState == .stale
        }
        let redundant = Set(LiveActivityDuplicates.redundant(live.map {
            .init(nativeID: $0.id, identity: $0.attributes.identity,
                  sequence: $0.content.state.sequence, updatedAt: $0.content.state.updatedAt)
        }))
        guard !redundant.isEmpty else { return }
        for activity in Activity<ReloActivityAttributes>.activities where redundant.contains(activity.id) {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }

    private func synchronizeLiveActivityTokens() async {
        configureLiveActivityTokenContext()
        system.reconnectActivityTokens()
        for activity in Activity<ReloActivityAttributes>.activities {
            observeActivityKitUpdates(for: activity)
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
        guard let snapshot = LiveActivityApplier.snapshot(
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
        currentChangeReceived()
    }

    private func stopObservingActivity(nativeActivityID: String) {
        activityContentUpdateTasks[nativeActivityID]?.cancel()
        activityContentUpdateTasks[nativeActivityID] = nil
        activityStateUpdateTasks[nativeActivityID] = nil
        activityObservationScopeByNativeID[nativeActivityID] = nil
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
        case MobileAPIError.invalidRequest, is BrowserSignIn.CallbackError:
            "That sign-in expired. Tap Sign in to try again."
        case MobileAPIError.accountDisabled, MobileAPIError.forbidden:
            "This Relo server account cannot sign in. Open the dashboard for account recovery."
        case MobileAPIError.rateLimited(let seconds):
            seconds.map { "Too many sign-in attempts. Try again in \($0) seconds." }
                ?? "Too many sign-in attempts. Try again shortly."
        case MobileAPIError.serverUnreachable, MobileAPIError.unavailable, is URLError:
            "Relo server could not be reached. Check this iPhone's connection and the server address, then retry."
        default:
            // Not the network: storing the session on this iPhone (keychain) or reading the reply failed.
            "Sign-in could not finish on this iPhone. Tap Sign in to try again."
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

extension AppModel: PendingResponseHost {
    func setResponseFeedback(for notificationID: String, _ feedback: NotificationResponseFeedback) {
        responseFeedbackByNotificationID[notificationID] = feedback
    }
    func setQueuedResponseNotificationIDs(_ ids: Set<String>) { queuedResponseNotificationIDs = ids }
    func removeQueuedResponse(_ notificationID: String) { queuedResponseNotificationIDs.remove(notificationID) }
    func responseConfirmed(at date: Date?) { diagnosticResponseConfirmedAt = date }
    func reconcileCurrentState() { sessionController.receive(.reconcile) }
}
