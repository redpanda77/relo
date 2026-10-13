import Foundation

public enum DeviceReadinessPolicy {
    public static func isReady(
        permissionAllowed: Bool,
        deviceRegistered: Bool,
        apnsTokenAvailable: Bool,
        serverAcceptedCurrentAPNSToken: Bool,
        hasPushRegistrationError: Bool,
        liveActivitiesAuthorized: Bool,
        liveActivityPushToStartTokenAvailable: Bool,
        syncCurrent: Bool
    ) -> Bool {
        permissionAllowed
            && deviceRegistered
            && apnsTokenAvailable
            && serverAcceptedCurrentAPNSToken
            && !hasPushRegistrationError
            && liveActivitiesAuthorized
            && liveActivityPushToStartTokenAvailable
            && syncCurrent
    }
}
