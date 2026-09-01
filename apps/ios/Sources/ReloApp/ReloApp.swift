import ReloCore
import Combine
import SwiftUI
import UserNotifications

@main
struct ReloApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model: AppModel
    @StateObject private var notificationNavigation = NotificationNavigationCoordinator.shared
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let model = AppModel.live()
        _model = StateObject(wrappedValue: model)
        BackgroundRefreshCoordinator.shared.install(model: model)
    }

    var body: some Scene {
        WindowGroup {
            HomeView(model: model)
                .task {
                    await model.start()
                }
                .task(id: scenePhase) {
                    guard scenePhase == .active else { return }
                    await model.foregrounded()
                    var attempt = 0
                    while !Task.isCancelled {
                        do {
                            try await Task.sleep(
                                for: .seconds(
                                    model.foregroundRefreshDelaySeconds(afterAttempt: attempt)
                                )
                            )
                        } catch {
                            return
                        }
                        await model.refresh()
                        attempt = min(attempt + 1, 5)
                    }
                }
                .onReceive(notificationNavigation.$notificationID.compactMap { $0 }) { notificationID in
                    notificationNavigation.consume(notificationID)
                    Task { await model.openNotification(notificationID: notificationID) }
                }
                .onReceive(notificationNavigation.$actionRequest.compactMap { $0 }) { request in
                    notificationNavigation.consume(request)
                    Task {
                        await model.notificationResponseQueued(notificationID: request.notificationID)
                    }
                }
                .onReceive(notificationNavigation.$actionFailure.compactMap { $0 }) { failure in
                    notificationNavigation.consume(failure)
                    Task {
                        await model.notificationResponseFailed(
                            notificationID: failure.request.notificationID,
                            action: failure.request.action
                        )
                    }
                }
                .onReceive(NotificationCenter.default.publisher(for: .reloPushReceived)) { _ in
                    Task { await model.refresh() }
                }
                .onReceive(NotificationCenter.default.publisher(for: .reloDeviceTokenChanged)) { _ in
                    Task { await model.pushRegistrationChanged() }
                }
                .onOpenURL { url in
                    if let identity = ReloDeepLink.activityIdentity(from: url) {
                        Task { await model.openActivity(identity: identity) }
                    }
                }
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        Self.registerNotificationCategories()
        // APNs may rotate its ordinary token between launches, and ActivityKit may
        // wake this process in the background before SwiftUI scene tasks run.
        application.registerForRemoteNotifications()
        BackgroundLiveActivityTokenRegistrar.start()
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
        BackgroundLiveActivityTokenRegistrar.reconnect()
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

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        NotificationCenter.default.post(name: .reloPushReceived, object: nil)
        completionHandler([.banner, .list, .sound, .badge])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        defer { completionHandler() }
        NotificationCenter.default.post(name: .reloPushReceived, object: nil)
        if let notificationID = Self.reloNotificationID(
            from: response.notification.request.content.userInfo
        ) {
            let request = Self.actionRequest(from: response, notificationID: notificationID)
            let wasPersisted = request.map(Self.persistActionRequest) ?? false
            Task { @MainActor in
                if let request {
                    if wasPersisted {
                        NotificationNavigationCoordinator.shared.respond(request)
                    } else {
                        NotificationNavigationCoordinator.shared.fail(request)
                    }
                } else {
                    NotificationNavigationCoordinator.shared.open(notificationID)
                }
            }
            return
        }
        guard
            let relo = response.notification.request.content.userInfo["relo"] as? [String: Any],
            let value = relo["deepLink"] as? String,
            let url = NotificationDestinationPolicy.validatedURL(value)
        else { return }
        UIApplication.shared.open(url)
    }

    private static func reloNotificationID(from userInfo: [AnyHashable: Any]) -> String? {
        guard let relo = userInfo["relo"] as? [String: Any] else { return nil }
        guard let notificationID = relo["notificationId"] as? String,
              ReloIdentifier.isValid(notificationID)
        else { return nil }
        return notificationID
    }

    private static func actionRequest(
        from response: UNNotificationResponse,
        notificationID: String
    ) -> NotificationActionRequest? {
        let action: NotificationInteractionAction
        switch response.actionIdentifier {
        case "RELO_APPROVE": action = .approve
        case "RELO_DENY": action = .deny
        case "RELO_YES": action = .yes
        case "RELO_NO": action = .no
        case "RELO_REPLY": action = .answer
        default: return nil
        }
        let text = (response as? UNTextInputNotificationResponse)?.userText
        return NotificationActionRequest(notificationID: notificationID, action: action, text: text)
    }

    private static func registerNotificationCategories() {
        let approve = UNNotificationAction(identifier: "RELO_APPROVE", title: "Approve", options: [.authenticationRequired, .foreground])
        let deny = UNNotificationAction(identifier: "RELO_DENY", title: "Deny", options: [.authenticationRequired, .foreground, .destructive])
        let yes = UNNotificationAction(identifier: "RELO_YES", title: "Yes", options: [.authenticationRequired, .foreground])
        let no = UNNotificationAction(identifier: "RELO_NO", title: "No", options: [.authenticationRequired, .foreground, .destructive])
        let reply = UNTextInputNotificationAction(
            identifier: "RELO_REPLY",
            title: "Reply",
            options: [.authenticationRequired, .foreground],
            textInputButtonTitle: "Send",
            textInputPlaceholder: "Short response"
        )
        UNUserNotificationCenter.current().setNotificationCategories([
            UNNotificationCategory(identifier: "RELO_APPROVAL", actions: [approve, deny], intentIdentifiers: []),
            UNNotificationCategory(identifier: "RELO_YES_NO", actions: [yes, no], intentIdentifiers: []),
            UNNotificationCategory(identifier: "RELO_TEXT", actions: [reply], intentIdentifiers: []),
        ])
    }

    private static func persistActionRequest(_ request: NotificationActionRequest) -> Bool {
        guard
            let credential = try? KeychainDeviceCredentialStore().load(),
            let queue = try? responseFile()
        else { return false }
        let accountID = credential.accountId
        let trimmedText = NotificationReplyPolicy.normalized(request.text)
        if request.action == .answer, !NotificationReplyPolicy.isValid(trimmedText) { return false }
        let response = PendingNotificationResponse(
            accountID: accountID,
            deviceID: credential.deviceId,
            notificationID: request.notificationID,
            action: request.action,
            value: trimmedText.map { ["response": $0] } ?? [:],
            idempotencyKey: "ios:\(credential.installationId):\(request.notificationID):\(request.action.rawValue)",
            expiresAt: .now.addingTimeInterval(86_400)
        )
        return (try? queue.enqueue(response)) != nil
    }

    private static func responseFile() throws -> CrossProcessResponseFile {
        guard
            let group = Bundle.main.object(forInfoDictionaryKey: "RELOAppGroup") as? String,
            let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
        else { throw CrossProcessResponseFileError.lockUnavailable }
        return CrossProcessResponseFile(
            baseDirectory: root.appendingPathComponent("protected-actions", isDirectory: true)
        )
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
            return await model.refresh()
        }
    }

    func refresh() async -> Bool {
        guard let handler else { return false }
        return await handler()
    }
}

struct NotificationActionRequest: Equatable {
    let notificationID: String
    let action: NotificationInteractionAction
    let text: String?
}

struct NotificationActionFailure: Equatable {
    let request: NotificationActionRequest
}

@MainActor
final class NotificationNavigationCoordinator: ObservableObject {
    static let shared = NotificationNavigationCoordinator()

    @Published private(set) var notificationID: String?
    @Published private(set) var actionRequest: NotificationActionRequest?
    @Published private(set) var actionFailure: NotificationActionFailure?

    private init() {}

    func open(_ notificationID: String) {
        self.notificationID = notificationID
    }

    func consume(_ notificationID: String) {
        guard self.notificationID == notificationID else { return }
        self.notificationID = nil
    }


    func respond(_ request: NotificationActionRequest) {
        actionRequest = request
    }

    func consume(_ request: NotificationActionRequest) {
        guard actionRequest == request else { return }
        actionRequest = nil
    }

    func fail(_ request: NotificationActionRequest) {
        actionFailure = NotificationActionFailure(request: request)
    }

    func consume(_ failure: NotificationActionFailure) {
        guard actionFailure == failure else { return }
        actionFailure = nil
    }
}

extension Notification.Name {
    static let reloPushReceived = Notification.Name("relo.push-received")
    static let reloDeviceTokenChanged = Notification.Name("relo.device-token-changed")
}
