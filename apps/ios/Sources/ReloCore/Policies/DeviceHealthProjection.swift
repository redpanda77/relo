import Foundation

public enum DeviceHealthProjection {
    public static func project(
        accountNeedsAttention: Bool,
        notificationPermission: DeviceNotificationPermissionHealth,
        registration: DeviceRegistrationPhase,
        deviceCredentialPresent: Bool,
        apnsTokenAvailable: Bool,
        serverAcceptedCurrentAPNSToken: Bool,
        hasPushRegistrationError: Bool,
        liveActivitiesAuthorized: Bool,
        liveActivityPushToStartTokenAvailable: Bool,
        activeLiveActivityCount: Int,
        inbox: DeviceInboxHealth,
        hasCachedActivity: Bool,
        deliveryTransportStatus: DeliveryTransportStatus?,
        deliveryTransportError: String?
    ) -> DeviceHealthSnapshot {
        let notifications = switch notificationPermission {
        case .allowed:
            DeviceHealthStatus(label: "Allowed", severity: .normal)
        case .denied:
            DeviceHealthStatus(label: "Off", severity: .actionRequired)
        case .unknown:
            DeviceHealthStatus(label: "Permission needed", severity: .actionRequired)
        }
        let registrationStatus = registrationStatus(
            phase: registration,
            apnsTokenAvailable: apnsTokenAvailable,
            serverAcceptedCurrentAPNSToken: serverAcceptedCurrentAPNSToken,
            hasPushRegistrationError: hasPushRegistrationError
        )
        let liveActivityStatus = liveActivityStatus(
            authorized: liveActivitiesAuthorized,
            pushToStartTokenAvailable: liveActivityPushToStartTokenAvailable,
            activeCount: activeLiveActivityCount
        )
        let inboxStatus = inboxStatus(inbox)
        let deliveryStatus = deliveryStatus(
            deliveryTransportStatus,
            error: deliveryTransportError
        )
        let ready = DeviceReadinessPolicy.isReady(
            permissionAllowed: notificationPermission == .allowed,
            deviceRegistered: deviceCredentialPresent && registration == .registered,
            apnsTokenAvailable: apnsTokenAvailable,
            serverAcceptedCurrentAPNSToken: serverAcceptedCurrentAPNSToken,
            hasPushRegistrationError: hasPushRegistrationError,
            liveActivitiesAuthorized: liveActivitiesAuthorized,
            liveActivityPushToStartTokenAvailable: liveActivityPushToStartTokenAvailable,
            syncCurrent: inbox == .current
        )
        let readiness: DeviceHealthStatus
        if accountNeedsAttention
            || notificationPermission != .allowed
            || registrationStatus.severity == .actionRequired
            || liveActivityStatus.severity == .actionRequired {
            readiness = DeviceHealthStatus(label: "Needs attention", severity: .actionRequired)
        } else if case .offline = inbox, hasCachedActivity {
            readiness = DeviceHealthStatus(
                label: "Offline",
                detail: "Recent activity remains available on this iPhone.",
                severity: .degraded
            )
        } else if ready || (inbox == .syncing && hasCachedActivity && DeviceReadinessPolicy.isReady(
            permissionAllowed: notificationPermission == .allowed,
            deviceRegistered: deviceCredentialPresent && registration == .registered,
            apnsTokenAvailable: apnsTokenAvailable,
            serverAcceptedCurrentAPNSToken: serverAcceptedCurrentAPNSToken,
            hasPushRegistrationError: hasPushRegistrationError,
            liveActivitiesAuthorized: liveActivitiesAuthorized,
            liveActivityPushToStartTokenAvailable: liveActivityPushToStartTokenAvailable,
            syncCurrent: true
        )) {
            readiness = DeviceHealthStatus(label: "Ready", severity: .normal)
        } else if registration == .registering || inbox == .syncing {
            readiness = DeviceHealthStatus(label: "Checking", severity: .checking)
        } else {
            readiness = DeviceHealthStatus(label: "Setting up", severity: .checking)
        }
        return DeviceHealthSnapshot(
            readiness: readiness,
            notifications: notifications,
            registration: registrationStatus,
            liveActivities: liveActivityStatus,
            inboxSync: inboxStatus,
            deliveryPath: deliveryStatus
        )
    }

    private static func liveActivityStatus(
        authorized: Bool,
        pushToStartTokenAvailable: Bool,
        activeCount: Int
    ) -> DeviceHealthStatus {
        guard authorized else {
            return DeviceHealthStatus(
                label: "Unavailable",
                detail: "Enable Live Activities in iPhone settings.",
                severity: .actionRequired
            )
        }
        guard pushToStartTokenAvailable else {
            return DeviceHealthStatus(
                label: "Awaiting start token",
                detail: "Apple has not issued the remote Live Activity start token yet.",
                severity: .checking
            )
        }
        let countLabel = activeCount == 1 ? "1 active" : "\(activeCount) active"
        return DeviceHealthStatus(
            label: "Ready",
            detail: countLabel,
            severity: .normal
        )
    }

    private static func registrationStatus(
        phase: DeviceRegistrationPhase,
        apnsTokenAvailable: Bool,
        serverAcceptedCurrentAPNSToken: Bool,
        hasPushRegistrationError: Bool
    ) -> DeviceHealthStatus {
        switch phase {
        case .registered where apnsTokenAvailable
            && serverAcceptedCurrentAPNSToken
            && !hasPushRegistrationError:
            DeviceHealthStatus(label: "Registered", severity: .normal)
        case .registered:
            DeviceHealthStatus(label: "Confirming Apple Push", severity: .checking)
        case .registering:
            DeviceHealthStatus(label: "Registering", severity: .checking)
        case .waitingForPermission:
            DeviceHealthStatus(label: "Notification permission needed", severity: .actionRequired)
        case .waitingForAPNSToken:
            DeviceHealthStatus(label: "Waiting for Apple Push", severity: .checking)
        case .failed(let message):
            DeviceHealthStatus(label: "Needs attention", detail: message, severity: .actionRequired)
        case .idle:
            DeviceHealthStatus(label: "Waiting", severity: .checking)
        }
    }

    private static func inboxStatus(_ inbox: DeviceInboxHealth) -> DeviceHealthStatus {
        switch inbox {
        case .idle:
            DeviceHealthStatus(label: "Waiting", severity: .checking)
        case .syncing:
            DeviceHealthStatus(label: "Syncing", severity: .checking)
        case .current:
            DeviceHealthStatus(label: "Current", severity: .normal)
        case .offline(let detail):
            DeviceHealthStatus(label: "Offline", detail: detail, severity: .degraded)
        }
    }

    private static func deliveryStatus(
        _ status: DeliveryTransportStatus?,
        error: String?
    ) -> DeviceHealthStatus {
        guard let apns = status?.apns else {
            return error.map {
                DeviceHealthStatus(label: "Unavailable", detail: $0, severity: .degraded)
            } ?? DeviceHealthStatus(label: "Checking", severity: .checking)
        }
        let label: String
        let detail: String
        let severity: DeviceHealthSeverity
        if apns.deliverySemantics == .durableInboxRefreshOnly {
            label = "Inbox sync only"
            detail = "Live Activities synchronize while Relo is open. Background arrival requires direct ActivityKit APNs."
            severity = .degraded
        } else if apns.providerCredentialActive == false {
            label = "APNs credentials inactive"
            detail = "Relo server cannot authenticate with Apple Push. Inbox synchronization remains available while Relo is open."
            severity = .degraded
        } else {
            label = apns.directDeliveryConfigured ? "Direct Apple Push" : "Direct APNs unavailable"
            detail = "Relo server can enqueue direct Apple Push. Apple acceptance does not confirm that this iPhone applied the event."
            severity = apns.directDeliveryConfigured ? .normal : .degraded
        }
        return DeviceHealthStatus(
            label: label,
            detail: error.map { "\($0) Showing the last known delivery path. \(detail)" } ?? detail,
            severity: error == nil ? severity : .degraded
        )
    }
}
