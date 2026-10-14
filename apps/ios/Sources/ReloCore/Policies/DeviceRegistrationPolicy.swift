import Foundation

public enum DeviceRegistrationPolicy {
    public static func prerequisitePhase(
        hasAuthenticatedAccount: Bool,
        permissionAllowed: Bool,
        apnsTokenAvailable: Bool,
        pushRegistrationFailed: Bool
    ) -> DeviceRegistrationPhase? {
        // Linking this iPhone needs only a signed-in account. Notifications are an extra on top:
        // without permission or an Apple Push token the device still registers and syncs, and it
        // registers again with the token once one arrives (`pushRegistrationChanged`).
        guard hasAuthenticatedAccount else { return .idle }
        return nil
    }
}

/// Where a registration attempt was when it failed; decides the message for unexpected errors.
public enum DeviceRegistrationStage: Sendable {
    case localRegistrationData
    case network
    case credentialStore
    case accountSessionStore
}

/// What the app does after a failed registration: what to show, whether the account state
/// changes, whether to advance the idempotent attempt, and whether to retry on its own.
public struct DeviceRegistrationFailure: Equatable, Sendable {
    public enum AccountEffect: Equatable, Sendable { case none, reauthenticationRequired, disabled }
    public enum Retry: Equatable, Sendable {
        case none
        /// Retry with backoff; a server Retry-After (seconds) overrides the backoff when present.
        case scheduled(retryAfterSeconds: Int?)
    }

    public let message: String
    public let accountEffect: AccountEffect
    public let advancesAttempt: Bool
    public let retry: Retry

    public init(message: String, accountEffect: AccountEffect = .none, advancesAttempt: Bool = false, retry: Retry = .none) {
        self.message = message
        self.accountEffect = accountEffect
        self.advancesAttempt = advancesAttempt
        self.retry = retry
    }
}

public extension DeviceRegistrationPolicy {
    static func failure(for error: Error, at stage: DeviceRegistrationStage) -> DeviceRegistrationFailure {
        switch error as? MobileAPIError {
        case .reauthenticationRequired:
            return .init(message: "Sign in again to register this iPhone.", accountEffect: .reauthenticationRequired)
        case .accountDisabled:
            return .init(message: "This Relo server account is disabled.", accountEffect: .disabled)
        case .serverUnreachable:
            return .init(message: "Server unreachable. Check your connection; Relo will retry device registration.",
                         retry: .scheduled(retryAfterSeconds: nil))
        case .idempotencyConflict:
            return .init(message: "Registration changed while it was being saved. Relo will retry automatically.",
                         advancesAttempt: true, retry: .scheduled(retryAfterSeconds: nil))
        case .invalidRequest:
            return .init(message: "Registration rejected. Relo server did not accept this device's registration details.")
        case .invalidResponse:
            return .init(message: "Registration rejected because Relo server returned an unreadable response.")
        case .rateLimited(let seconds):
            let suffix = seconds.map { " Try again in \($0) seconds." } ?? " Try again shortly."
            return .init(message: "Relo server is limiting registration requests.\(suffix)",
                         retry: .scheduled(retryAfterSeconds: seconds))
        case .unavailable:
            return .init(message: "Relo server is reachable by configuration, but the registration server is unavailable.",
                         retry: .scheduled(retryAfterSeconds: nil))
        default:
            switch stage {
            case .localRegistrationData, .credentialStore:
                return .init(message: "The local device credential store is unreadable. Registration was not completed.")
            case .accountSessionStore:
                return .init(message: "The protected account session store is unreadable. Sign in again before registering.")
            case .network:
                return .init(message: "The registration server failed unexpectedly.", retry: .scheduled(retryAfterSeconds: nil))
            }
        }
    }
}
