import AVFoundation
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
    /// True at launch and after a real trip to the background, until `foregrounded()` completes.
    @State private var needsForegrounding = true

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
                    switch scenePhase {
                    case .background:
                        model.backgrounded()
                        needsForegrounding = true
                    case .active:
                        // Only a return from the background (or launch) does the foreground work.
                        // `.inactive` (Control Center, Notification Center, the app switcher, a
                        // screenshot) keeps the stream and connection as they are, so coming back
                        // from it needs nothing. A pass cut short by a phase change runs again.
                        guard needsForegrounding else { return }
                        await model.foregrounded()
                        if !Task.isCancelled { needsForegrounding = false }
                    default:
                        return
                    }
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
                    } else if ReloDeepLink.isSetup(url) {
                        model.openComputerSetup()
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
        // Relo's push sounds go to where iOS looks for them (off the main path, a no-op once there).
        ReloPushSounds.install()
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
        // A question answered elsewhere: its notification leaves at once, before the refresh.
        let settled = SettledNotifications.ids(in: userInfo)
        Task { @MainActor in
            await SettledNotifications.remove(settled)
            let refreshed = await BackgroundRefreshCoordinator.shared.refresh()
            completionHandler(refreshed ? .newData : .noData)
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        let category = notification.request.content.categoryIdentifier
        return await MainActor.run {
            NotificationCenter.default.post(name: .reloPushReceived, object: nil)
            return ReloCuePlayer.shared.foregroundPresentation(category: category)
        }
    }

    /// Where a tapped notification leads, read from the response before any work starts (the response itself is
    /// not Sendable).
    enum NotificationRoute: Sendable {
        case approveAccess(String)
        case openAccess(String)
        case securitySettings
        case action(NotificationActionRequest)
        case open(String)
        case url(URL)
        case none
    }

    // The completion-handler form, not `async`: the async bridge called the completion off the main thread, and UIKit
    // aborted on it (SIGABRT in -[UIApplication _performBlockAfterCATransactionCommitSynchronizes:]) on every tap that
    // opened the app. The completion now runs on the main actor, once the route is handled.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping @Sendable () -> Void
    ) {
        let route = Self.route(for: response)
        Task { @MainActor in
            await Self.handle(route)
            completionHandler()
        }
    }

    nonisolated private static func route(for response: UNNotificationResponse) -> NotificationRoute {
        let tapped = response.actionIdentifier != UNNotificationDismissActionIdentifier
        let relo = response.notification.request.content.userInfo["relo"] as? [String: Any]
        // "New device wants access": Approve right here (iOS already asked for Face ID or the passcode), or open the
        // request sheet.
        if tapped, let relo, let id = ReloDeepLink.accessRequestID(relo: relo) {
            return response.actionIdentifier == ReloAccessRequestNotification.approveAction ? .approveAccess(id) : .openAccess(id)
        }
        // A notice without a request id opens Settings → Devices, where the device is approved.
        if tapped, let relo, ReloDeepLink.opensSecuritySettings(relo: relo) { return .securitySettings }
        if let notificationID = reloNotificationID(from: response.notification.request.content.userInfo) {
            if let request = actionRequest(from: response, notificationID: notificationID) { return .action(request) }
            return tapped ? .open(notificationID) : .none
        }
        guard let value = relo?["deepLink"] as? String, let url = NotificationDestinationPolicy.validatedURL(value) else { return .none }
        return .url(url)
    }

    @MainActor private static func handle(_ route: NotificationRoute) async {
        switch route {
        case .approveAccess(let id): await DeviceAccessActionCoordinator.shared.approve(id)
        case .openAccess(let id): await NotificationNavigationCoordinator.shared.openAccessRequest(id)
        case .securitySettings: await NotificationNavigationCoordinator.shared.openSecuritySettings()
        case .action(let request): await BackgroundNotificationActionCoordinator.shared.handle(request)
        case .open(let notificationID): await NotificationNavigationCoordinator.shared.open(notificationID)
        case .url(let url): await UIApplication.shared.open(url)
        case .none: break
        }
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
        let browserReview = UNNotificationAction(identifier: ReloBrowserLinkNotification.reviewAction, title: "Review",
                                                 options: [.foreground])
        let fixed: Set<UNNotificationCategory> = [
            UNNotificationCategory(identifier: ReloBrowserLinkNotification.categoryIdentifier,
                                   actions: [browserReview], intentIdentifiers: []),
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

    /// A tapped notification asked for Settings → Devices (held until the app consumes it,
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

// MARK: - Relo's cues (ADR 0013)

extension ReloCue {
    /// ADR 0013's haptic for each moment: needs you is a medium tap, failed an error, your turn a light tap, and
    /// done, sent and linked are success. (SwiftUI has one success pattern, so done is not a lighter one.)
    var feedback: SensoryFeedback {
        switch self {
        case .needsYou: .impact(weight: .medium)
        case .failed: .error
        case .yourTurn: .impact(weight: .light)
        case .done, .sent, .linked: .success
        }
    }
}

/// Puts Relo's push sounds where iOS looks for them. A push's `aps.sound` names a file that iOS finds in the app
/// bundle or in the app container's `Library/Sounds`. The cues ship in the asset catalog (data sets, so the project
/// file needs no resource entry), which a push cannot see, so each launch copies the six `.caf` files into
/// `Library/Sounds`. Cheap and idempotent: a file already there with the same bytes is left alone.
enum ReloPushSounds {
    static func install() {
        Task.detached(priority: .utility) {
            let files = FileManager.default
            guard let library = files.urls(for: .libraryDirectory, in: .userDomainMask).first else { return }
            let folder = library.appendingPathComponent("Sounds", isDirectory: true)
            try? files.createDirectory(at: folder, withIntermediateDirectories: true)
            for cue in ReloCue.allCases {
                guard let data = NSDataAsset(name: cue.rawValue)?.data else { continue }
                let file = folder.appendingPathComponent(cue.fileName)
                if (try? Data(contentsOf: file)) == data { continue }
                try? data.write(to: file, options: .atomic)
            }
        }
    }
}

/// The in-app cues: the same files a push names, played from the asset catalog on the ambient audio session (the
/// silent switch mutes them and other audio keeps playing), at a modest volume, in the foreground only.
/// The rules of ADR 0013, section 2 live in `ReloCueGate`: once per moment id and one cue every 2 s. The first
/// observation after launch is the baseline, and is the director's to keep (see `ReloDeckDirector`).
@MainActor
final class ReloCuePlayer {
    static let shared = ReloCuePlayer()

    /// Now is the selected tab and the app is active (set by NowView): the question's card is on screen.
    var nowOnScreen = false

    private var gate = ReloCueGate()
    private var players: [ReloCue: AVAudioPlayer] = [:]
    private var sessionReady = false
    /// The last time a push in the foreground played its own cue, so the in-app one stays out of its way.
    private var lastPushCueAt = Date.distantPast
    /// The last time an in-app cue played, so a push that follows it presents without its own sound.
    private var lastAppCueAt = Date.distantPast
    private static let volume: Float = 0.6
    private static let pushWindow: TimeInterval = 5

    /// Plays `cue` for the moment `id` (once per id; with no id, each call is its own moment).
    func play(_ cue: ReloCue, id: String? = nil) {
        guard UIApplication.shared.applicationState == .active else { return }
        // One channel per moment: a push that just played its own cue carried this one.
        if cue.isPushCue, Date.now.timeIntervalSince(lastPushCueAt) < Self.pushWindow { return }
        guard gate.admit(cue, id: id ?? UUID().uuidString), let player = player(for: cue) else { return }
        startSession()
        player.volume = Self.volume
        player.currentTime = 0
        player.play()
        if cue.isPushCue { lastAppCueAt = .now }
    }

    /// How a push is presented while Relo is open (`willPresent`).
    /// - A question, with Now on screen: the card and the in-app cue (sound and haptic) carry it, so only the
    ///   notification list and the badge update, with no banner and no sound. Deciding "this very card is on
    ///   screen" would need the card's id in the push; "Now is the visible tab" is the rule that holds from what
    ///   exists, and the question is on Now's first section whenever it is.
    /// - Anything else keeps its banner and its own cue (`.sound` plays the file the push names), unless an in-app
    ///   cue just played: one channel per moment.
    func foregroundPresentation(category: String) -> UNNotificationPresentationOptions {
        if nowOnScreen, Self.isQuestion(category: category) { return [.list, .badge] }
        if Date.now.timeIntervalSince(lastAppCueAt) < Self.pushWindow { return [.banner, .list, .badge] }
        lastPushCueAt = .now
        return [.banner, .list, .sound, .badge]
    }

    private static func isQuestion(category: String) -> Bool {
        ["RELO_APPROVAL", "RELO_YES_NO", "RELO_CHOICE", "RELO_TEXT"].contains(category)
            || category == ChoiceNotificationCategoryPolicy.staticCategoryIdentifier
            || ChoiceNotificationCategoryPolicy.isPerQuestionCategory(category)
    }

    private func startSession() {
        guard !sessionReady else { return }
        sessionReady = true
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.ambient, mode: .default)
        try? session.setActive(true)
    }

    private func player(for cue: ReloCue) -> AVAudioPlayer? {
        if let player = players[cue] { return player }
        guard let data = NSDataAsset(name: cue.rawValue)?.data,
              let player = try? AVAudioPlayer(data: data, fileTypeHint: AVFileType.caf.rawValue) else { return nil }
        player.prepareToPlay()
        players[cue] = player
        return player
    }
}

private extension ReloCue {
    /// The cues a push carries as its own sound (the server's `notification-sounds.ts`); sent and linked are in-app only.
    var isPushCue: Bool { self != .sent && self != .linked }
}
