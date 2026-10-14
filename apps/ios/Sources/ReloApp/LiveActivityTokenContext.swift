import ReloRuntime
import Foundation
import ReloCore

/// Composition-time inputs; retries use these values without consulting global state.
struct LiveActivityTokenContext: Sendable {
    let origin: URL
    let credential: DeviceCredential
    let client: any MobileAPIClient
    let environment: String
    let heartbeat: DeviceHeartbeat?

    func binding(scope: SessionScope) -> LiveActivityTokenBinding {
        let uploadPush: (@Sendable (String) async -> LiveActivityTokenRegistrationAttempt)?
        if let heartbeat {
            uploadPush = { token in
                let request = DeviceHeartbeat(deviceId: heartbeat.deviceId, installationId: heartbeat.installationId,
                    deviceName: heartbeat.deviceName, bundleId: heartbeat.bundleId, appVersion: heartbeat.appVersion,
                    appBuild: heartbeat.appBuild, iosVersion: heartbeat.iosVersion, deviceModel: heartbeat.deviceModel,
                    apnsToken: heartbeat.apnsToken, apnsEnvironment: heartbeat.apnsEnvironment,
                    notificationAuthorization: heartbeat.notificationAuthorization, liveActivityAuthorization: heartbeat.liveActivityAuthorization,
                    liveActivityPushToStartToken: token, model: heartbeat.model, isSimulator: heartbeat.isSimulator)
                return await Self.attempt { try await client.heartbeat(credential: credential, heartbeat: request) }
            }
        } else { uploadPush = nil }
        return LiveActivityTokenBinding(scope: scope, registerActivity: { candidate in
            await Self.attempt {
                try await client.registerLiveActivityToken(credential: credential, activityId: candidate.activityID,
                    registration: .init(token: candidate.token, nativeActivityId: candidate.nativeActivityID,
                                        environment: environment, generation: candidate.generation))
            }
        }, registerPushToStart: uploadPush)
    }

    private static func attempt(_ send: () async throws -> Void) async -> LiveActivityTokenRegistrationAttempt {
        do { try Task.checkCancellation(); try await send(); return .registered }
        catch is CancellationError { return .terminal }
        catch MobileAPIError.reauthenticationRequired, MobileAPIError.forbidden, MobileAPIError.invalidRequest { return .terminal }
        catch { return .retryable }
    }
}
