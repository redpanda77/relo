import ReloPersistence
import ReloCore
import Combine
import SwiftUI
import UserNotifications

#if !RELO_FLOW_CAPTURE
@main
#endif
struct ReloApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var model: AppModel
    @StateObject private var notificationNavigation = NotificationNavigationCoordinator.shared
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let dependencies = AppDependencies.live()
        let model = AppModel(dependencies: dependencies)
        _model = State(initialValue: model)
        appDelegate.tokenRegistrar = dependencies.tokenRegistrar
        BackgroundRefreshCoordinator.shared.install(model: model)
        BackgroundNotificationActionCoordinator.shared.install(model: model)
        DeviceAccessActionCoordinator.shared.install(model: model)
    }

    var body: some Scene {
        WindowGroup {
            HomeView(model: model)
                .preferredColorScheme(.dark)
                .task {
                    guard !AppLaunchEnvironment.isHostedTest else { return }
                    await model.start()
                }
                .task(id: scenePhase) {
                    guard !AppLaunchEnvironment.isHostedTest else { return }
                    guard scenePhase == .active else { model.backgrounded(); return }
                    await model.foregrounded()
                }
                .onReceive(notificationNavigation.$notificationID.compactMap { $0 }) { notificationID in
                    notificationNavigation.consume(notificationID)
                    Task { await model.openNotification(notificationID: notificationID) }
                }
                .onReceive(NotificationCenter.default.publisher(for: .reloPushReceived)) { _ in
                    model.currentChangeReceived()
                }
                .onReceive(NotificationCenter.default.publisher(for: .reloDeviceTokenChanged)) { _ in
                    Task { await model.pushRegistrationChanged() }
                }
                .onReceive(notificationNavigation.$securitySettingsPending.filter { $0 }) { _ in
                    notificationNavigation.consumeSecuritySettings()
                    model.openSecuritySettings()
                }
                .onReceive(notificationNavigation.$accessRequestID.compactMap { $0 }) { id in
                    notificationNavigation.consumeAccessRequest()
                    model.openAccessRequest(id: id)
                }
                .onOpenURL { url in
                    if let id = ReloDeepLink.accessRequestID(from: url) {
                        model.openAccessRequest(id: id)
                    } else if ReloDeepLink.isSecuritySettings(url) {
                        model.openSecuritySettings()
                    } else if let identity = ReloDeepLink.activityIdentity(from: url) {
                        Task { await model.openActivity(identity: identity) }
                    }
                }
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    var tokenRegistrar: BackgroundLiveActivityTokenRegistrar?
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        guard !AppLaunchEnvironment.isHostedTest else { return true }
        UNUserNotificationCenter.current().delegate = self
        Self.registerNotificationCategories()
        // APNs may rotate its ordinary token between launches, and ActivityKit may
        // wake this process in the background before SwiftUI scene tasks run.
        application.registerForRemoteNotifications()
        tokenRegistrar?.start()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken token: Data) {
        let value = token.map { String(format: "%02x", $0) }.joined()
        do {
            try KeychainPushTokenStore().save(value)
            UserDefaults.standard.removeObject(forKey: "relo.apnsRegistrationError")
        } catch {
            UserDefaults.standard.set("The protected APNs token could not be saved.", forKey: "relo.apnsRegistrationError")
        }
        tokenRegistrar?.reconnect()
        NotificationCenter.default.post(name: .reloDeviceTokenChanged, object: nil)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        // A prior token remains useful for diagnostics and retry comparison, but
        // AppModel never treats it as a token received in this app session.
        UserDefaults.standard.set(error.localizedDescription, forKey: "relo.apnsRegistrationError")
        NotificationCenter.default.post(name: .reloDeviceTokenChanged, object: nil)
    }

    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        Task { @MainActor in
            let refreshed = await BackgroundRefreshCoordinator.shared.refresh()
            completionHandler(refreshed ? .newData : .noData)
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        await MainActor.run {
            NotificationCenter.default.post(name: .reloPushReceived, object: nil)
        }
        return [.banner, .list, .sound, .badge]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        // Copy native callback input before crossing to the UI-owned coordinators.
        // The async delegate bridge completes exactly when handling finishes.
        // "New device wants access": Approve right here (iOS already asked for Face ID or the
        // passcode), or open the request sheet.
        if response.actionIdentifier != UNNotificationDismissActionIdentifier,
           let relo = response.notification.request.content.userInfo["relo"] as? [String: Any],
           let id = ReloDeepLink.accessRequestID(relo: relo) {
            if response.actionIdentifier == ReloAccessRequestNotification.approveAction {
                await DeviceAccessActionCoordinator.shared.approve(id)
            } else {
                await NotificationNavigationCoordinator.shared.openAccessRequest(id)
            }
            return
        }
        // A notice without a request id opens Settings → Devices, where the device is approved.
        if response.actionIdentifier != UNNotificationDismissActionIdentifier,
           let relo = response.notification.request.content.userInfo["relo"] as? [String: Any],
           ReloDeepLink.opensSecuritySettings(relo: relo) {
            await NotificationNavigationCoordinator.shared.openSecuritySettings()
            return
        }
        if let notificationID = Self.reloNotificationID(from: response.notification.request.content.userInfo) {
            let request = Self.actionRequest(from: response, notificationID: notificationID)
            let shouldNavigate = response.actionIdentifier != UNNotificationDismissActionIdentifier
            if let request {
                await BackgroundNotificationActionCoordinator.shared.handle(request)
            } else if shouldNavigate {
                await NotificationNavigationCoordinator.shared.open(notificationID)
            }
            return
        }
        guard
            let relo = response.notification.request.content.userInfo["relo"] as? [String: Any],
            let value = relo["deepLink"] as? String,
            let url = NotificationDestinationPolicy.validatedURL(value)
        else { return }
        await MainActor.run { UIApplication.shared.open(url) }
    }

    nonisolated private static func reloNotificationID(from userInfo: [AnyHashable: Any]) -> String? {
        guard let relo = userInfo["relo"] as? [String: Any] else { return nil }
        guard let notificationID = relo["notificationId"] as? String,
              ReloIdentifier.isValid(notificationID)
        else { return nil }
        return notificationID
    }

    nonisolated private static func actionRequest(
        from response: UNNotificationResponse,
        notificationID: String
    ) -> NotificationActionRequest? {
        let action: NotificationInteractionAction
        var optionID: String?
        switch response.actionIdentifier {
        case "RELO_APPROVE": action = .approve
        case "RELO_DENY": action = .deny
        case "RELO_YES": action = .yes
        case "RELO_NO": action = .no
        case let identifier:
            guard let chosen = ChoiceNotificationCategoryPolicy.optionID(fromActionIdentifier: identifier)
            else { return nil }
            action = .choose
            optionID = chosen
        }
        let text = (response as? UNTextInputNotificationResponse)?.userText
        let relo = response.notification.request.content.userInfo["relo"] as? [String: Any] ?? [:]
        return NotificationActionRequest(notificationID: notificationID, action: action, text: text,
            optionID: optionID, metadata: NotificationDecisionMetadata(relo: relo))
    }

    private static func registerNotificationCategories() {
        Task { await installNotificationCategories() }
    }

    nonisolated private static func installNotificationCategories() async {
        let approve = UNNotificationAction(identifier: "RELO_APPROVE", title: "Approve", options: [.authenticationRequired])
        let deny = UNNotificationAction(identifier: "RELO_DENY", title: "Deny", options: [.authenticationRequired, .destructive])
        let yes = UNNotificationAction(identifier: "RELO_YES", title: "Yes", options: [.authenticationRequired])
        let no = UNNotificationAction(identifier: "RELO_NO", title: "No", options: [.authenticationRequired, .destructive])
        let accessApprove = UNNotificationAction(identifier: ReloAccessRequestNotification.approveAction, title: "Approve",
                                                 options: [.authenticationRequired])
        let accessReview = UNNotificationAction(identifier: ReloAccessRequestNotification.reviewAction, title: "Review",
                                                options: [.foreground])
        let fixed: Set<UNNotificationCategory> = [
            UNNotificationCategory(identifier: "RELO_APPROVAL", actions: [approve, deny], intentIdentifiers: []),
            UNNotificationCategory(identifier: ReloAccessRequestNotification.categoryIdentifier,
                                   actions: [accessApprove, accessReview], intentIdentifiers: []),
            UNNotificationCategory(identifier: "RELO_YES_NO", actions: [yes, no], intentIdentifiers: []),
            // A choice's buttons live in its per-question category; this one only opens Relo.
            UNNotificationCategory(
                identifier: ChoiceNotificationCategoryPolicy.staticCategoryIdentifier, actions: [], intentIdentifiers: []),
        ]
        // Keep the per-question categories the Notification Service Extension registered, so
        // delivered choice questions keep their buttons across launches.
        let center = UNUserNotificationCenter.current()
        let registered = await center.notificationCategories()
        center.setNotificationCategories(fixed.union(registered.filter {
            ChoiceNotificationCategoryPolicy.isPerQuestionCategory($0.identifier)
        }))
    }


}

@MainActor
final class BackgroundRefreshCoordinator {
    static let shared = BackgroundRefreshCoordinator()

    private var handler: (() async -> Bool)?

    private init() {}

    func install(model: AppModel) {
        handler = { [weak model] in
            guard let model else { return false }
            return await model.backgroundCurrentRefresh()
        }
    }

    func refresh() async -> Bool {
        guard let handler else { return false }
        return await handler()
    }
}

struct NotificationActionRequest: Equatable, Sendable {
    let notificationID: String
    let action: NotificationInteractionAction
    let text: String?
    /// The option a tapped `RELO_OPTION.<optionId>` action picks.
    var optionID: String? = nil
    var metadata: NotificationDecisionMetadata? = nil
}

@MainActor
final class NotificationNavigationCoordinator: ObservableObject {
    static let shared = NotificationNavigationCoordinator()

    @Published private(set) var notificationID: String?

    private init() {}

    func open(_ notificationID: String) {
        self.notificationID = notificationID
    }

    func consume(_ notificationID: String) {
        guard self.notificationID == notificationID else { return }
        self.notificationID = nil
    }

    /// A tapped notification asked for Settings → Security (held until the app consumes it,
    /// so a tap that launches Relo still lands there).
    @Published private(set) var securitySettingsPending = false

    func openSecuritySettings() {
        securitySettingsPending = true
    }

    func consumeSecuritySettings() {
        securitySettingsPending = false
    }

    /// A tapped access-request notification (held until the app consumes it, like the above).
    @Published private(set) var accessRequestID: String?

    func openAccessRequest(_ id: String) {
        accessRequestID = id
    }

    func consumeAccessRequest() {
        accessRequestID = nil
    }



}

extension Notification.Name {
    static let reloPushReceived = Notification.Name("relo.push-received")
    static let reloDeviceTokenChanged = Notification.Name("relo.device-token-changed")
}
