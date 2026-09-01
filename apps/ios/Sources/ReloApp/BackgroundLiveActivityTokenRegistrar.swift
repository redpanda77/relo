import ActivityKit
import ReloCore
import UIKit
import UserNotifications

@MainActor
enum BackgroundLiveActivityTokenRegistrar {
    private static let runtime = Runtime()

    static func start() {
        runtime.start()
    }

    static func reconnect() {
        runtime.reconnect()
    }

    private final class Runtime {
        private var activityUpdatesTask: Task<Void, Never>?
        private var pushToStartTask: Task<Void, Never>?
        private var activityTokenTasks: [String: Task<Void, Never>] = [:]
        private var registrationTasks: [String: Task<Void, Never>] = [:]
        private var desiredCandidates: [String: LiveActivityTokenRegistrationCandidate] = [:]
        private var registeredTokens: [String: String] = [:]
        private var desiredPushToStartToken: String?
        private var registeredPushToStartToken: String?
        private var pushToStartRegistrationTask: Task<Void, Never>?

        func start() {
            guard activityUpdatesTask == nil else {
                reconnect()
                return
            }
            for activity in Activity<ReloActivityAttributes>.activities {
                observe(activity)
            }
            activityUpdatesTask = Task { @MainActor [weak self] in
                for await activity in Activity<ReloActivityAttributes>.activityUpdates {
                    guard !Task.isCancelled, let self else { return }
                    self.observe(activity)
                }
            }

            if #available(iOS 17.2, *) {
                if let current = Activity<ReloActivityAttributes>.pushToStartToken {
                    receivedPushToStartToken(current)
                }
                pushToStartTask = Task { @MainActor [weak self] in
                    for await token in Activity<ReloActivityAttributes>.pushToStartTokenUpdates {
                        guard !Task.isCancelled, let self else { return }
                        self.receivedPushToStartToken(token)
                    }
                }
            }
        }

        func reconnect() {
            if #available(iOS 17.2, *),
               let current = Activity<ReloActivityAttributes>.pushToStartToken {
                receivedPushToStartToken(current)
            }
            for activity in Activity<ReloActivityAttributes>.activities {
                observe(activity)
                if let token = activity.pushToken {
                    queue(token, for: activity)
                }
            }
        }

        private func observe(_ activity: Activity<ReloActivityAttributes>) {
            guard activityTokenTasks[activity.id] == nil else { return }
            if let token = activity.pushToken {
                queue(token, for: activity)
            }
            activityTokenTasks[activity.id] = Task { @MainActor [weak self] in
                for await token in activity.pushTokenUpdates {
                    guard !Task.isCancelled, let self else { return }
                    self.queue(token, for: activity)
                }
            }
        }

        private func queue(
            _ tokenData: Data,
            for activity: Activity<ReloActivityAttributes>
        ) {
            let token = ActivityKitTokenCodec.hex(tokenData)
            let candidate = LiveActivityTokenRegistrationCandidate(
                activityID: activity.attributes.eventID,
                generation: activity.attributes.generation,
                nativeActivityID: activity.id,
                token: token,
                accountID: activity.attributes.accountID
            )
            guard candidate.isValid else { return }
            desiredCandidates[activity.id] = candidate
            guard registrationTasks[activity.id] == nil else { return }
            registrationTasks[activity.id] = Task { @MainActor [weak self] in
                await self?.drainActivityRegistration(nativeActivityID: activity.id)
            }
        }

        private func drainActivityRegistration(nativeActivityID: String) async {
            defer { registrationTasks[nativeActivityID] = nil }
            while let candidate = desiredCandidates[nativeActivityID] {
                if registeredTokens[nativeActivityID] == candidate.token {
                    desiredCandidates[nativeActivityID] = nil
                    return
                }
                let outcome = await LiveActivityTokenRegistrationRetrier.run(candidate) {
                    await Self.registerActivityToken($0)
                }
                guard desiredCandidates[nativeActivityID] == candidate else { continue }
                if outcome == .registered {
                    registeredTokens[nativeActivityID] = candidate.token
                }
                desiredCandidates[nativeActivityID] = nil
            }
        }

        private func receivedPushToStartToken(_ tokenData: Data) {
            let token = ActivityKitTokenCodec.hex(tokenData)
            guard !token.isEmpty else { return }
            do {
                try KeychainPushTokenStore(
                    account: "live-activity-push-to-start-token"
                ).save(token)
            } catch {
                return
            }
            desiredPushToStartToken = token
            guard pushToStartRegistrationTask == nil else { return }
            pushToStartRegistrationTask = Task { @MainActor [weak self] in
                await self?.drainPushToStartRegistration()
            }
        }

        private func drainPushToStartRegistration() async {
            defer { pushToStartRegistrationTask = nil }
            while let token = desiredPushToStartToken {
                if registeredPushToStartToken == token {
                    desiredPushToStartToken = nil
                    return
                }
                let outcome = await Self.registerPushToStartToken(token)
                guard desiredPushToStartToken == token else { continue }
                if outcome == .registered {
                    registeredPushToStartToken = token
                }
                desiredPushToStartToken = nil
            }
        }

        private static func registerActivityToken(
            _ candidate: LiveActivityTokenRegistrationCandidate
        ) async -> LiveActivityTokenRegistrationAttempt {
            guard let credential = try? KeychainDeviceCredentialStore().load() else {
                return .retryable
            }
            guard candidate.matches(accountID: credential.accountId) else {
                return .terminal
            }
            do {
                try await HTTPMobileAPIClient(baseURL: apiOrigin).registerLiveActivityToken(
                    credential: credential,
                    activityId: candidate.activityID,
                    registration: LiveActivityTokenRegistration(
                        token: candidate.token,
                        nativeActivityId: candidate.nativeActivityID,
                        environment: apnsEnvironment,
                        generation: candidate.generation
                    )
                )
                return .registered
            } catch MobileAPIError.reauthenticationRequired,
                    MobileAPIError.forbidden,
                    MobileAPIError.invalidRequest {
                return .terminal
            } catch {
                return .retryable
            }
        }

        private static func registerPushToStartToken(
            _ token: String
        ) async -> LiveActivityTokenRegistrationOutcome {
            await LiveActivityTokenRegistrationRetrier.run {
                await uploadPushToStartToken(token)
            }
        }

        private static func uploadPushToStartToken(
            _ token: String
        ) async -> LiveActivityTokenRegistrationAttempt {
            guard
                let credential = try? KeychainDeviceCredentialStore().load(),
                let apnsToken = try? KeychainPushTokenStore().load()
            else { return .retryable }
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            let notificationsAuthorized = switch settings.authorizationStatus {
            case .authorized, .provisional, .ephemeral: true
            default: false
            }
            let deviceName = await UIDevice.current.name
            let iosVersion = await UIDevice.current.systemVersion
            do {
                let heartbeat = DeviceHeartbeat(
                    deviceId: credential.deviceId,
                    installationId: try KeychainInstallationIDStore().loadOrCreate(),
                    deviceName: deviceName,
                    bundleId: Bundle.main.bundleIdentifier ?? "com.example.relo.notifications",
                    appVersion: Bundle.main.object(
                        forInfoDictionaryKey: "CFBundleShortVersionString"
                    ) as? String ?? "0",
                    appBuild: Bundle.main.object(
                        forInfoDictionaryKey: "CFBundleVersion"
                    ) as? String ?? "0",
                    iosVersion: iosVersion,
                    deviceModel: modelIdentifier,
                    apnsToken: apnsToken,
                    apnsEnvironment: apnsEnvironment,
                    notificationAuthorization: notificationsAuthorized ? .authorized : .denied,
                    liveActivityAuthorization: ActivityAuthorizationInfo().areActivitiesEnabled ? .authorized : .denied,
                    liveActivityPushToStartToken: token
                )
                try await HTTPMobileAPIClient(baseURL: apiOrigin).heartbeat(
                    credential: credential,
                    heartbeat: heartbeat
                )
                return .registered
            } catch MobileAPIError.reauthenticationRequired,
                    MobileAPIError.forbidden,
                    MobileAPIError.invalidRequest {
                return .terminal
            } catch {
                return .retryable
            }
        }

        private static var apiOrigin: URL {
            RuntimeServerOrigin.current()
                ?? URL(string: "https://relo.invalid")!
        }

        private static var apnsEnvironment: String {
            #if DEBUG
            "sandbox"
            #else
            "production"
            #endif
        }

        private static var modelIdentifier: String {
            var systemInfo = utsname()
            uname(&systemInfo)
            return withUnsafePointer(to: &systemInfo.machine) {
                $0.withMemoryRebound(to: CChar.self, capacity: 1) {
                    String(cString: $0)
                }
            }
        }
    }
}
