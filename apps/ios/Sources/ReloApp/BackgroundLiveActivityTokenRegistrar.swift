import ReloTransport
import ReloRuntime
import ReloPersistence
import ActivityKit
import ReloCore
import UIKit
import UserNotifications

/// Native event adapter. Foreground and background callbacks share one registration owner.
@MainActor
final class BackgroundLiveActivityTokenRegistrar {
    private let runtime = Runtime()
    private var appOwnsContext = false
    private var bootstrapRevision: UInt64 = 0
    private var bootstrapTask: Task<Void, Never>?

    func start() {
        runtime.start()
        reconnect()
    }

    func configure(_ context: LiveActivityTokenContext?) {
        appOwnsContext = true
        bootstrapRevision &+= 1
        bootstrapTask?.cancel(); bootstrapTask = nil
        runtime.configure(context)
        runtime.start()
    }

    func reconnect() {
        guard !appOwnsContext else { runtime.reconnect(); return }
        bootstrapRevision &+= 1
        bootstrapTask?.cancel(); bootstrapTask = nil
        let revision = bootstrapRevision
        do {
            // A background launch can precede AppModel.start. Capture protected authority once.
            guard try KeychainSignOutProgressStore().load() == nil,
                  let credential = try KeychainDeviceCredentialStore().load(),
                  let origin = RuntimeServerOrigin.current() else { runtime.configure(nil); return }
            let session = try KeychainAccountSessionStore().load()
            guard session?.account?.accountId == nil || session?.account?.accountId == credential.accountId else {
                runtime.configure(nil); return
            }
            let client = HTTPMobileAPIClient(baseURL: origin)
            runtime.configure(.init(origin: origin, credential: credential, client: client, environment: Self.environment, heartbeat: nil))
            // Activity tokens are already eligible; only push-to-start waits for heartbeat metadata.
            let apnsToken = try KeychainPushTokenStore().load()
            let installation = try KeychainInstallationIDStore().loadOrCreate()
            bootstrapTask = Task { @MainActor [weak self] in
                let settings = await UNUserNotificationCenter.current().notificationSettings()
                guard !Task.isCancelled, let self, !self.appOwnsContext,
                      self.bootstrapRevision == revision, let apnsToken else { return }
                let authorization: AuthorizationState = switch settings.authorizationStatus {
                case .authorized, .provisional, .ephemeral: .authorized
                case .denied: .denied
                default: .pending
                }
                let hardware = ReloDeviceModelName.current()
                let heartbeat = DeviceHeartbeat(deviceId: credential.deviceId, installationId: installation,
                    deviceName: ReloDeviceModelName.deviceName(systemName: UIDevice.current.name, identifier: hardware.identifier), bundleId: Bundle.main.bundleIdentifier ?? "com.example.relo.notifications",
                    appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0",
                    appBuild: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0",
                    iosVersion: UIDevice.current.systemVersion, deviceModel: hardware.identifier,
                    apnsToken: apnsToken, apnsEnvironment: Self.environment, notificationAuthorization: authorization,
                    liveActivityAuthorization: ActivityAuthorizationInfo().areActivitiesEnabled ? .authorized : .denied,
                    model: hardware.identifier, isSimulator: hardware.isSimulator)
                self.runtime.configure(.init(origin: origin, credential: credential, client: client, environment: Self.environment, heartbeat: heartbeat))
                self.bootstrapTask = nil
            }
        } catch {
            // Inaccessible protected state cannot authorize a new background registration.
            runtime.configure(nil)
        }
    }

    @MainActor
    private final class Runtime {
        private let owner = LiveActivityTokenRuntime()
        private var scope: SessionScope?
        private var credential: DeviceCredential?
        private var configuration: Task<Void, Never>?
        private var revision: UInt64 = 0
        private var activityUpdatesTask: Task<Void, Never>?
        private var pushToStartTask: Task<Void, Never>?
        private var activityTokenTasks: [String: Task<Void, Never>] = [:]
        private var activityStateTasks: [String: Task<Void, Never>] = [:]
        private var persistedPushToken: String?

        func configure(_ context: LiveActivityTokenContext?) {
            let storage = context.flatMap { try? StorageScope(serverOrigin: $0.origin, accountID: $0.credential.accountId, deviceID: $0.credential.deviceId) }
            if storage != scope?.storage || context?.credential != credential {
                if let storage, let context { scope = SessionScope(storage: storage, credentialVersion: context.credential.credentialVersion) }
                else { scope = nil }
                credential = context?.credential
            }
            revision &+= 1
            let previous = configuration, binding = scope.flatMap { context?.binding(scope: $0) }
            configuration = Task { [owner] in
                await previous?.value
                await owner.configure(binding)
            }
            reconnect()
        }

        func start() {
            guard activityUpdatesTask == nil else { return }
            activityUpdatesTask = Task { @MainActor [weak self] in
                for await activity in Activity<ReloActivityAttributes>.activityUpdates {
                    guard !Task.isCancelled, let self else { return }
                    self.observe(activity)
                }
            }
            pushToStartTask = Task { @MainActor [weak self] in
                for await token in Activity<ReloActivityAttributes>.pushToStartTokenUpdates {
                    guard !Task.isCancelled, let self else { return }
                    self.receivedPushToStartToken(token)
                }
            }
            reconnect()
        }

        func reconnect() {
            if let token = Activity<ReloActivityAttributes>.pushToStartToken { receivedPushToStartToken(token) }
            for activity in Activity<ReloActivityAttributes>.activities {
                observe(activity)
                if activity.activityState != .ended, activity.activityState != .dismissed, let token = activity.pushToken {
                    queue(token, for: activity)
                }
            }
        }

        private func observe(_ activity: Activity<ReloActivityAttributes>) {
            guard activity.activityState != .ended, activity.activityState != .dismissed,
                  activityTokenTasks[activity.id] == nil else { return }
            if let token = activity.pushToken { queue(token, for: activity) }
            activityTokenTasks[activity.id] = Task { @MainActor [weak self] in
                for await token in activity.pushTokenUpdates {
                    guard !Task.isCancelled, let self else { return }
                    self.queue(token, for: activity)
                }
            }
            activityStateTasks[activity.id] = Task { @MainActor [weak self] in
                for await state in activity.activityStateUpdates {
                    guard !Task.isCancelled, let self else { return }
                    if state == .ended || state == .dismissed {
                        self.activityTokenTasks.removeValue(forKey: activity.id)?.cancel()
                        self.activityStateTasks.removeValue(forKey: activity.id)?.cancel()
                        await self.owner.forget(nativeActivityID: activity.id)
                        return
                    }
                }
            }
        }

        private func queue(_ token: Data, for activity: Activity<ReloActivityAttributes>) {
            let candidate = LiveActivityTokenRegistrationCandidate(activityID: activity.attributes.eventID,
                generation: activity.attributes.generation, nativeActivityID: activity.id,
                token: ActivityKitTokenCodec.hex(token), accountID: activity.attributes.accountID)
            let barrier = configuration, expected = revision
            Task { @MainActor [weak self] in
                await barrier?.value
                guard let self, self.revision == expected,
                      activity.activityState != .ended, activity.activityState != .dismissed else { return }
                await self.owner.offer(candidate)
            }
        }

        private func receivedPushToStartToken(_ data: Data) {
            let token = ActivityKitTokenCodec.hex(data)
            guard !token.isEmpty else { return }
            if persistedPushToken != token {
                do {
                    try KeychainPushTokenStore(account: "live-activity-push-to-start-token").save(token)
                    persistedPushToken = token
                } catch { /* The current token can still be registered during this process. */ }
            }
            let barrier = configuration, expected = revision
            Task { @MainActor [weak self] in
                await barrier?.value
                guard let self, self.revision == expected else { return }
                await self.owner.offerPushToStart(token)
            }
        }
    }

    private static var environment: String {
        #if DEBUG
        "sandbox"
        #else
        "production"
        #endif
    }
}
