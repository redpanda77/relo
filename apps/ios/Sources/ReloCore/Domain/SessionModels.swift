import Foundation

public enum DeviceRegistrationPhase: Equatable, Sendable {
    case idle
    case waitingForPermission
    case waitingForAPNSToken
    case registering
    case registered
    case failed(String)
}

public struct APNSTokenSessionState: Equatable, Sendable {
    public let cachedTokenAvailable: Bool
    public let currentSessionTokenAvailable: Bool

    public init(
        cachedTokenAvailable: Bool = false,
        currentSessionTokenAvailable: Bool = false
    ) {
        self.cachedTokenAvailable = cachedTokenAvailable
        self.currentSessionTokenAvailable = currentSessionTokenAvailable
    }

    public static func restored(cachedTokenAvailable: Bool) -> APNSTokenSessionState {
        APNSTokenSessionState(
            cachedTokenAvailable: cachedTokenAvailable,
            currentSessionTokenAvailable: false
        )
    }

    public func receivingCurrentToken(persistedTokenAvailable: Bool) -> APNSTokenSessionState {
        APNSTokenSessionState(
            cachedTokenAvailable: persistedTokenAvailable,
            currentSessionTokenAvailable: persistedTokenAvailable
        )
    }

    public func registrationFailed(cachedTokenAvailable: Bool) -> APNSTokenSessionState {
        APNSTokenSessionState(
            cachedTokenAvailable: cachedTokenAvailable,
            currentSessionTokenAvailable: false
        )
    }

    public func retryingRegistration() -> APNSTokenSessionState {
        APNSTokenSessionState(
            cachedTokenAvailable: cachedTokenAvailable,
            currentSessionTokenAvailable: false
        )
    }
}

public enum DeviceHealthSeverity: Equatable, Sendable {
    case normal
    case checking
    case degraded
    case actionRequired
}

public struct DeviceHealthStatus: Equatable, Sendable {
    public let label: String
    public let detail: String?
    public let severity: DeviceHealthSeverity

    public init(label: String, detail: String? = nil, severity: DeviceHealthSeverity) {
        self.label = label
        self.detail = detail
        self.severity = severity
    }
}

public struct DeviceHealthSnapshot: Equatable, Sendable {
    public let readiness: DeviceHealthStatus
    public let notifications: DeviceHealthStatus
    public let registration: DeviceHealthStatus
    public let liveActivities: DeviceHealthStatus
    public let inboxSync: DeviceHealthStatus
    public let deliveryPath: DeviceHealthStatus
}

public enum DeviceNotificationPermissionHealth: Equatable, Sendable {
    case unknown
    case allowed
    case denied
}

public enum DeviceInboxHealth: Equatable, Sendable {
    case idle
    case syncing
    case current
    case offline(String)
}
