import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum MobileAPIError: Error, Equatable, Sendable {
    case invalidRequest
    case invalidCredentials
    case accountDisabled
    case reauthenticationRequired
    case forbidden
    case idempotencyConflict
    case rateLimited(retryAfterSeconds: Int?)
    case serverUnreachable
    case unavailable
    case invalidResponse
    /// Ending a work was refused because it is moving again (`work_running`, 409).
    case workRunning
    case decisionRejected(NotificationDecisionRejection)
}

public struct DeliveryTransportStatus: Decodable, Equatable, Sendable {
    public struct APNs: Decodable, Equatable, Sendable {
        public enum Mode: String, Decodable, Sendable {
            case disabled
            case sandbox
            case production
        }

        public enum Semantics: String, Decodable, Sendable {
            case durableInboxRefreshOnly = "durable_inbox_refresh_only"
            case workerDirectAPNs = "worker_direct_apns"
        }

        public let mode: Mode
        public let remoteEnqueueEnabled: Bool
        public let providerCredentialActive: Bool?
        public let deliverySemantics: Semantics

        public var directDeliveryConfigured: Bool {
            deliverySemantics == .workerDirectAPNs
                && mode != .disabled
                && remoteEnqueueEnabled
                && providerCredentialActive != false
        }
    }

    public let apns: APNs
}

public enum AccountDeletionErrorGuidance {
    public static func message(for error: Error) -> String {
        switch error {
        case MobileAPIError.invalidCredentials:
            "The current password is incorrect. Check it and try again; nothing was removed from this iPhone."
        case MobileAPIError.invalidRequest, MobileAPIError.forbidden:
            "Relo server rejected the exact DELETE confirmation. Nothing was removed from this iPhone."
        case MobileAPIError.reauthenticationRequired:
            "Your Relo server session expired. Sign in again before deleting the account; nothing was removed."
        case MobileAPIError.rateLimited(let seconds):
            seconds.map { "Relo server is limiting deletion attempts. Try again in \($0) seconds; nothing was removed." }
                ?? "Relo server is limiting deletion attempts. Try again shortly; nothing was removed."
        default:
            "Relo server could not confirm account deletion. Protected local state was retained; retry when the private server is reachable."
        }
    }
}

public enum DeliveryTransportStatusErrorGuidance {
    public static func message(for error: Error) -> String {
        switch error {
        case MobileAPIError.reauthenticationRequired:
            "Your Relo server session expired. Sign in again to check the delivery path."
        case MobileAPIError.forbidden:
            "This Relo server account cannot read delivery-path status."
        case MobileAPIError.serverUnreachable:
            "Your Relo server is unreachable."
        case MobileAPIError.invalidResponse:
            "Relo server returned an incompatible delivery-path status."
        case MobileAPIError.rateLimited(let seconds):
            seconds.map { "Relo server is limiting status checks. Try again in \($0) seconds." }
                ?? "Relo server is limiting status checks. Try again shortly."
        default:
            "Relo server's delivery-status service is unavailable."
        }
    }
}

public protocol MobileAPIClient: Sendable {
    func submitDecision(credential: DeviceCredential, response: PendingNotificationResponse) async throws -> NotificationDecisionAcknowledgement
    func exchangeBrowserSignIn(
        code: String,
        codeVerifier: String,
        installationId: String
    ) async throws -> AccountSession
    /// The sign-ins this server offers; a server without the route offers none beyond the browser.
    func signInMethods() async throws -> SignInMethods
    /// Signs in with a native Sign in with Apple identity token; throws `AppleSignInRefusal` when the server says no.
    func signInWithApple(
        identityToken: String,
        nonce: String,
        codeChallenge: String,
        installationId: String,
        name: PersonNameComponents?
    ) async throws -> AccountSession
    func validateAccountSession(token: String) async throws -> AccountSession
    func registerDevice(
        sessionToken: String,
        request: DeviceRegistrationRequest,
        idempotencyKey: String
    ) async throws -> DeviceRegistrationResponse
    func deviceSelf(credential: DeviceCredential) async throws -> DeviceSelfResponse
    func deliveryTransportStatus(sessionToken: String) async throws -> DeliveryTransportStatus
    func withdrawNotification(sessionToken: String, notificationID: String) async throws
    func heartbeat(credential: DeviceCredential, heartbeat: DeviceHeartbeat) async throws
    func registerLiveActivityToken(
        credential: DeviceCredential,
        activityId: String,
        registration: LiveActivityTokenRegistration
    ) async throws
    /// `generation` is the card generation the owner dismissed: the server ignores a dismissal for an older one,
    /// so a replacement card (a new generation) survives its predecessor's dismissal.
    func reportLiveActivityDismissed(
        credential: DeviceCredential,
        activityId: String,
        generation: Int
    ) async throws
    func dismissMissedQuestion(credential: DeviceCredential, questionId: String) async throws
    /// Ends a Quiet, Paused or Your-turn work (`POST api/works/{id}/end`, device bearer).
    func endWork(credential: DeviceCredential, workId: String) async throws
    func submitInteraction(
        credential: DeviceCredential,
        notificationId: String,
        action: NotificationInteractionAction,
        value: [String: String],
        idempotencyKey: String
    ) async throws
    func revokeDevice(credential: DeviceCredential) async throws
    func signOutAccount(sessionToken: String) async throws
    func deleteAccount(sessionToken: String, password: String, confirmation: String) async throws
}

public extension MobileAPIClient {
    func submitDecision(credential: DeviceCredential, response: PendingNotificationResponse) async throws -> NotificationDecisionAcknowledgement {
        throw MobileAPIError.invalidResponse
    }
    func exchangeBrowserSignIn(
        code: String,
        codeVerifier: String,
        installationId: String
    ) async throws -> AccountSession { throw MobileAPIError.unavailable }
    func signInMethods() async throws -> SignInMethods { SignInMethods(apple: false) }
    func signInWithApple(
        identityToken: String,
        nonce: String,
        codeChallenge: String,
        installationId: String,
        name: PersonNameComponents?
    ) async throws -> AccountSession { throw MobileAPIError.unavailable }
    func deliveryTransportStatus(sessionToken: String) async throws -> DeliveryTransportStatus {
        throw MobileAPIError.unavailable
    }

    func withdrawNotification(sessionToken: String, notificationID: String) async throws {
        throw MobileAPIError.unavailable
    }

    /// `generation` is the card generation the owner dismissed: the server ignores a dismissal for an older one,
    /// so a replacement card (a new generation) survives its predecessor's dismissal.
    func reportLiveActivityDismissed(
        credential: DeviceCredential,
        activityId: String,
        generation: Int
    ) async throws {
        throw MobileAPIError.unavailable
    }

    func dismissMissedQuestion(credential: DeviceCredential, questionId: String) async throws {
        throw MobileAPIError.unavailable
    }

    func endWork(credential: DeviceCredential, workId: String) async throws {
        throw MobileAPIError.unavailable
    }
}

public struct DashboardURLProvider: Sendable {
    public let origin: URL

    public init?(origin: URL) {
        guard ServerEndpointPolicy.accepts(origin) else { return nil }
        self.origin = origin
    }

    public var dashboardURL: URL {
        origin.appendingPathComponent("dashboard")
    }
}
