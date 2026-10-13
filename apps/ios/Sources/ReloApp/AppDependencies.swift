import ReloTransport
import ReloRuntime
import ReloPersistence
import ReloNotificationSupport
import Foundation
import ReloCore
import UIKit
import UserNotifications

/// Construction values only. Creating these adapters must not start asynchronous work.
@MainActor
struct AppDependencies {
    let credentialStore: any DeviceCredentialStore
    let accountSessionStore: any AccountSessionStore
    let installationIDStore: any InstallationIDStore
    let stableDeviceIDStore: any StableDeviceIDStore
    let pushTokenStore: any PushTokenStore
    let liveActivityPushToStartTokenStore: any PushTokenStore
    let registrationAttemptStore: any RegistrationAttemptStore
    var signOutProgressStore: any SignOutProgressStore = NoopSignOutProgressStore()
    var storagePreflight: any LocalStoragePreflighting = NoopLocalStoragePreflight()
    let cache: any AccountScopedInboxCaching
    let apiClient: any MobileAPIClient
    let liveActivityCoordinator: LiveActivityCommandCoordinator
    let pendingResponseStore: any AccountScopedPendingResponseStoring
    let notificationReceiptStore: any ScopedNotificationReceiptStoring
    let accountNotificationCleaner: any AccountNotificationClearing
    let serverURL: URL
    /// What the owner chose; nil until they enter a server (never the build-time origin).
    var chosenServerURL: URL? = nil
    var diagnostics: any DiagnosticStoring = NoopDiagnosticStore()
    var system: AppSystemServices = .live
    var tokenRegistrar: BackgroundLiveActivityTokenRegistrar? = nil
    /// End-to-end encryption key upkeep; nil in previews and tests.
    var encryptionKeys: E2EEKeyMaintenance? = nil
    var answerSigner: (@Sendable () -> (any ReloIdentitySigning)?)? = nil
    var makeInboxDataSource: (URL, String) -> any InboxDataSource = {
        let sealed = ReloSealedContent.live()
        return HTTPInboxDataSource(baseURL: $0, token: $1, sealedOpener: sealed.opener, nameResolver: sealed.nameResolver)
    }

    var makeCurrentDataSource: (URL, String) -> any CurrentStateSource = {
        let sealed = ReloSealedContent.live()
        return HTTPCurrentStateSource(baseURL: $0, token: $1, nameResolver: sealed.nameResolver, sealedOpener: sealed.opener)
    }
    var makeCurrentCache: (StorageScope) -> any CurrentStateCaching = { _ in InMemoryCurrentStateCache() }

    var makePendingReadStore: (StorageScope) -> any PendingReadStoring = { _ in InMemoryPendingReadStore() }
    var makeDetailCache: (StorageScope) -> any NotificationDetailCaching = { _ in InMemoryNotificationDetailCache() }

    static func live() -> AppDependencies {
        let sealedContent = ReloSealedContent.live()
        ReloSealedCards.install(sealedContent.cardOpener)
        if let book = sealedContent.nameBook { ReloSealedCards.installNames { book.names() } }
        let tokenRegistrar = BackgroundLiveActivityTokenRegistrar()
        var system = AppSystemServices.live
        system.configureActivityTokens = { tokenRegistrar.configure($0) }
        system.reconnectActivityTokens = { tokenRegistrar.reconnect() }
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let reloDirectory = support.appendingPathComponent("Relo", isDirectory: true)
        // Relo authenticates with tokens only. Drop any cookie an older build stored (an email
        // sign-in left a Better Auth session cookie that made sign-out fail with 403).
        HTTPCookieStorage.shared.removeCookies(since: .distantPast)
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
        return AppDependencies(
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
            notificationReceiptStore: FileScopedNotificationReceiptStore(baseDirectory: sharedRoot),
            accountNotificationCleaner: SystemAccountNotificationCleaner(),
            serverURL: origin,
            chosenServerURL: RuntimeServerOrigin.chosen(),
            diagnostics: OSLogDiagnosticSink(store: BoundedDiagnosticStore(
                fileURL: reloDirectory.appendingPathComponent("diagnostics.json"))),
            system: system,
            tokenRegistrar: tokenRegistrar,
            encryptionKeys: E2EEKeyMaintenance(ring: .live(), publisher: HTTPMobileAPIClient(baseURL: origin),
                                               directory: HTTPMobileAPIClient(baseURL: origin), trust: .live()),
            answerSigner: { ReloKeyRing.live().existingIdentitySigner() },
            makeCurrentCache: { scope in
                FileCurrentStateCache(baseDirectory: reloDirectory.appendingPathComponent("current", isDirectory: true), scope: scope)
            },
            makePendingReadStore: { scope in
                FilePendingReadStore(baseDirectory: reloDirectory.appendingPathComponent("reads", isDirectory: true), scope: scope)
            },
            makeDetailCache: { scope in
                FileNotificationDetailCache(baseDirectory: reloDirectory.appendingPathComponent("detail", isDirectory: true), scope: scope)
            }
        )
    }

}

/// Narrow system boundaries used by startup. Production order stays in AppModel.
@MainActor
struct AppSystemServices {
    var notificationPermission: @MainActor () async -> AppModel.PermissionState
    var startActivityObservation: @MainActor (AppModel) -> Void
    var setBadgeCount: @MainActor (Int) async -> Void
    var pushRegistrationError: @MainActor () -> String?
    var configureActivityTokens: @MainActor (LiveActivityTokenContext?) -> Void = { _ in }
    var reconnectActivityTokens: @MainActor () -> Void = {}

    static let live = AppSystemServices(
        notificationPermission: {
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            switch settings.authorizationStatus {
            case .authorized, .provisional, .ephemeral:
                UIApplication.shared.registerForRemoteNotifications()
                return .allowed
            case .denied: return .denied
            default: return .unknown
            }
        },
        startActivityObservation: { $0.startLiveActivityObservation() },
        setBadgeCount: { try? await UNUserNotificationCenter.current().setBadgeCount($0) },
        pushRegistrationError: { UserDefaults.standard.string(forKey: "relo.apnsRegistrationError") }
    )
}

/// Hosted unit tests construct their own injected models. Suppress only automatic
/// application launch work in Debug test processes, never in a Release build.
enum AppLaunchEnvironment {
    static var isHostedTest: Bool {
        #if DEBUG
        ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
            || ProcessInfo.processInfo.environment["XCTestBundlePath"] != nil
        #else
        false
        #endif
    }
}

private struct SystemAccountNotificationCleaner: AccountNotificationClearing, Sendable {
    func clearAllDeliveredAndPendingNotifications() async throws {
        let center = UNUserNotificationCenter.current()
        center.removeAllDeliveredNotifications()
        center.removeAllPendingNotificationRequests()
        try await center.setBadgeCount(0)
    }
}
