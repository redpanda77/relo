import Foundation

public struct AccountSummary: Codable, Equatable, Sendable {
    public let accountId: String
    public let name: String
    public let email: String
    public let imageUrl: URL?

    public init(accountId: String, name: String, email: String, imageUrl: URL? = nil) {
        self.accountId = accountId
        self.name = name
        self.email = email
        self.imageUrl = imageUrl
    }
}

public struct AccountUser: Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let email: String
    public let image: URL?

    public init(id: String, name: String, email: String, image: URL? = nil) {
        self.id = id
        self.name = name
        self.email = email
        self.image = image
    }
}

public struct AccountSession: Codable, Equatable, Sendable {
    public let accessToken: String
    public let sessionId: String
    public let expiresAt: Date
    public let user: AccountUser
    public let account: AccountSummary?

    public init(
        accessToken: String,
        sessionId: String,
        expiresAt: Date,
        user: AccountUser,
        account: AccountSummary? = nil
    ) {
        self.accessToken = accessToken
        self.sessionId = sessionId
        self.expiresAt = expiresAt
        self.user = user
        self.account = account
    }

    public func updating(user: AccountUser, sessionId: String, expiresAt: Date) -> AccountSession {
        AccountSession(
            accessToken: accessToken,
            sessionId: sessionId,
            expiresAt: expiresAt,
            user: user,
            account: account
        )
    }

    public func attaching(account: AccountSummary) -> AccountSession {
        AccountSession(
            accessToken: accessToken,
            sessionId: sessionId,
            expiresAt: expiresAt,
            user: user,
            account: account
        )
    }
}

public enum AccountDeletionConfirmationPolicy {
    public static let requiredConfirmation = "DELETE"

    public static func isValid(password: String, confirmation: String) -> Bool {
        (8...128).contains(password.utf16.count)
            && confirmation == requiredConfirmation
    }
}

public protocol AccountNotificationClearing: Sendable {
    func clearAllDeliveredAndPendingNotifications() async throws
}

public enum AccountDeletionNotificationCleanup {
    public static func perform(using cleaner: any AccountNotificationClearing) async throws {
        try await cleaner.clearAllDeliveredAndPendingNotifications()
    }
}

public struct DeviceCredential: Codable, Equatable, Sendable {
    public let deviceId: String
    public let installationId: UUID
    public let accessToken: String
    public let issuedAt: Date
    public let expiresAt: Date?
    public let accountId: String
    public let credentialVersion: Int

    public init(
        deviceId: String,
        installationId: UUID,
        accessToken: String,
        issuedAt: Date,
        expiresAt: Date? = nil,
        accountId: String,
        credentialVersion: Int
    ) {
        self.deviceId = deviceId
        self.installationId = installationId
        self.accessToken = accessToken
        self.issuedAt = issuedAt
        self.expiresAt = expiresAt
        self.accountId = accountId
        self.credentialVersion = credentialVersion
    }

    private enum CodingKeys: String, CodingKey {
        case deviceId
        case installationId
        case accessToken
        case issuedAt
        case expiresAt
        case accountId
        case credentialVersion
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.deviceId = try container.decode(String.self, forKey: .deviceId)
        self.installationId = try container.decode(UUID.self, forKey: .installationId)
        self.accessToken = try container.decode(String.self, forKey: .accessToken)
        self.issuedAt = try container.decode(Date.self, forKey: .issuedAt)
        self.expiresAt = try container.decodeIfPresent(Date.self, forKey: .expiresAt)
        self.accountId = try container.decode(String.self, forKey: .accountId)
        self.credentialVersion = try container.decode(Int.self, forKey: .credentialVersion)
    }
}

public enum AuthorizationState: String, Codable, Equatable, Sendable {
    case authorized
    case denied
    case pending
}

/// What this build can answer, declared on registration and every heartbeat. The server sends
/// a phone only the questions its declared capabilities cover.
public enum DeviceCapability {
    public static let choiceQuestions = "choice_questions"
    public static let supported = [choiceQuestions]
}

public struct DeviceRegistrationRequest: Codable, Equatable, Sendable {
    public let stableDeviceId: UUID
    public let installationId: UUID
    public let name: String
    public let bundleIdentifier: String
    public let appVersion: String
    public let appBuild: String
    public let osVersion: String
    public let model: String
    public let apnsEnvironment: String
    public let apnsToken: String?
    public let notificationAuthorization: AuthorizationState
    public let liveActivityAuthorization: AuthorizationState
    public let liveActivityPushToStartToken: String?
    public let capabilities: [String]

    public init(
        stableDeviceId: UUID,
        installationId: UUID,
        name: String,
        bundleIdentifier: String,
        appVersion: String,
        appBuild: String,
        osVersion: String,
        model: String,
        apnsEnvironment: String,
        apnsToken: String? = nil,
        notificationAuthorization: AuthorizationState,
        liveActivityAuthorization: AuthorizationState,
        liveActivityPushToStartToken: String? = nil,
        capabilities: [String] = DeviceCapability.supported
    ) {
        self.stableDeviceId = stableDeviceId
        self.installationId = installationId
        self.name = name
        self.bundleIdentifier = bundleIdentifier
        self.appVersion = appVersion
        self.appBuild = appBuild
        self.osVersion = osVersion
        self.model = model
        self.apnsEnvironment = apnsEnvironment
        self.apnsToken = apnsToken
        self.notificationAuthorization = notificationAuthorization
        self.liveActivityAuthorization = liveActivityAuthorization
        self.liveActivityPushToStartToken = liveActivityPushToStartToken
        self.capabilities = capabilities
    }

    private enum CodingKeys: String, CodingKey {
        case stableDeviceId, installationId, name, bundleIdentifier, appVersion, appBuild, osVersion, model
        case apnsEnvironment, apnsToken, notificationAuthorization, liveActivityAuthorization
        case liveActivityPushToStartToken, capabilities
    }

    /// A request saved by an older build has no capabilities; it declared none.
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        stableDeviceId = try values.decode(UUID.self, forKey: .stableDeviceId)
        installationId = try values.decode(UUID.self, forKey: .installationId)
        name = try values.decode(String.self, forKey: .name)
        bundleIdentifier = try values.decode(String.self, forKey: .bundleIdentifier)
        appVersion = try values.decode(String.self, forKey: .appVersion)
        appBuild = try values.decode(String.self, forKey: .appBuild)
        osVersion = try values.decode(String.self, forKey: .osVersion)
        model = try values.decode(String.self, forKey: .model)
        apnsEnvironment = try values.decode(String.self, forKey: .apnsEnvironment)
        apnsToken = try values.decodeIfPresent(String.self, forKey: .apnsToken)
        notificationAuthorization = try values.decode(AuthorizationState.self, forKey: .notificationAuthorization)
        liveActivityAuthorization = try values.decode(AuthorizationState.self, forKey: .liveActivityAuthorization)
        liveActivityPushToStartToken = try values.decodeIfPresent(String.self, forKey: .liveActivityPushToStartToken)
        capabilities = try values.decodeIfPresent([String].self, forKey: .capabilities) ?? []
    }
}

public struct RegisteredDeviceSummary: Codable, Equatable, Sendable {
    public let deviceId: String
    public let installationId: UUID
    public let registrationState: String
    public let credentialVersion: Int

    public init(
        deviceId: String,
        installationId: UUID,
        registrationState: String,
        credentialVersion: Int
    ) {
        self.deviceId = deviceId
        self.installationId = installationId
        self.registrationState = registrationState
        self.credentialVersion = credentialVersion
    }
}

public struct IssuedDeviceCredential: Codable, Equatable, Sendable {
    public let accessToken: String
    public let issuedAt: Date
    public let expiresAt: Date?

    public init(accessToken: String, issuedAt: Date, expiresAt: Date? = nil) {
        self.accessToken = accessToken
        self.issuedAt = issuedAt
        self.expiresAt = expiresAt
    }
}

public struct DeviceRegistrationResponse: Codable, Equatable, Sendable {
    public let account: AccountSummary
    public let device: RegisteredDeviceSummary
    public let credential: IssuedDeviceCredential

    public init(
        account: AccountSummary,
        device: RegisteredDeviceSummary,
        credential: IssuedDeviceCredential
    ) {
        self.account = account
        self.device = device
        self.credential = credential
    }
}

public struct DeviceSelfResponse: Codable, Equatable, Sendable {
    public let account: AccountSummary
    public let device: RegisteredDeviceSummary

    public init(account: AccountSummary, device: RegisteredDeviceSummary) {
        self.account = account
        self.device = device
    }
}

public struct DeviceHeartbeat: Codable, Equatable, Sendable {
    public let deviceId: String
    public let installationId: UUID
    public let deviceName: String
    public let bundleId: String
    public let appVersion: String
    public let appBuild: String
    public let iosVersion: String
    public let deviceModel: String
    public let apnsToken: String
    public let apnsEnvironment: String
    public let notificationAuthorization: AuthorizationState
    public let liveActivityAuthorization: AuthorizationState
    public let liveActivityPushToStartToken: String?
    public let capabilities: [String]

    public init(
        deviceId: String,
        installationId: UUID,
        deviceName: String,
        bundleId: String,
        appVersion: String,
        appBuild: String,
        iosVersion: String,
        deviceModel: String,
        apnsToken: String,
        apnsEnvironment: String,
        notificationAuthorization: AuthorizationState,
        liveActivityAuthorization: AuthorizationState,
        liveActivityPushToStartToken: String? = nil,
        capabilities: [String] = DeviceCapability.supported
    ) {
        self.deviceId = deviceId
        self.installationId = installationId
        self.deviceName = deviceName
        self.bundleId = bundleId
        self.appVersion = appVersion
        self.appBuild = appBuild
        self.iosVersion = iosVersion
        self.deviceModel = deviceModel
        self.apnsToken = apnsToken
        self.apnsEnvironment = apnsEnvironment
        self.notificationAuthorization = notificationAuthorization
        self.liveActivityAuthorization = liveActivityAuthorization
        self.liveActivityPushToStartToken = liveActivityPushToStartToken
        self.capabilities = capabilities
    }

}

public struct RegistrationAttempt: Codable, Equatable, Sendable {
    public let revision: Int
    public let request: DeviceRegistrationRequest

    public init(revision: Int, request: DeviceRegistrationRequest) {
        self.revision = revision
        self.request = request
    }

    /// Scoped to the sign-in: sign-out resets the revision to 1, and a key an earlier sign-in
    /// already used with a different request is refused by the server as a conflict (409).
    public func idempotencyKey(installationId: UUID, sessionId: String) -> String {
        "ios-register:\(installationId.uuidString.lowercased()):\(sessionId):\(revision)"
    }
}

public struct RegistrationRecoveryState: Codable, Equatable, Sendable {
    public let consecutiveFailures: Int
    public let nextRetryAt: Date?

    public init(consecutiveFailures: Int = 0, nextRetryAt: Date? = nil) {
        self.consecutiveFailures = max(0, consecutiveFailures)
        self.nextRetryAt = nextRetryAt
    }
}

public enum RegistrationRecoveryPolicy {
    private static let retryDelays: [TimeInterval] = [5, 15, 60, 300, 900]

    public static func recordingTransientFailure(
        previousFailures: Int,
        now: Date,
        retryAfter: TimeInterval? = nil
    ) -> RegistrationRecoveryState {
        let failures = max(0, previousFailures) + 1
        let policyDelay = retryDelays[min(failures - 1, retryDelays.count - 1)]
        let delay = max(policyDelay, retryAfter ?? 0)
        return RegistrationRecoveryState(
            consecutiveFailures: failures,
            nextRetryAt: now.addingTimeInterval(delay)
        )
    }
}

public protocol DeviceCredentialStore: Sendable {
    func load() throws -> DeviceCredential?
    func save(_ credential: DeviceCredential) throws
    func delete() throws
}

public protocol AccountSessionStore: Sendable {
    func load() throws -> AccountSession?
    func save(_ session: AccountSession) throws
    func delete() throws
}

public protocol InstallationIDStore: Sendable {
    func loadOrCreate() throws -> UUID
}

public protocol StableDeviceIDStore: Sendable {
    func loadOrCreate() throws -> UUID
}

public protocol PushTokenStore: Sendable {
    func load() throws -> String?
    func save(_ token: String) throws
    func delete() throws
}

public protocol RegistrationAttemptStore: Sendable {
    func attempt(for request: DeviceRegistrationRequest, minimumRevision: Int) throws -> RegistrationAttempt
    func advanceCurrentAttempt() throws
    func recoveryState() throws -> RegistrationRecoveryState?
    @discardableResult
    func recordTransientFailure(now: Date, retryAfter: TimeInterval?) throws -> RegistrationRecoveryState
    func recordRegistrationSuccess() throws
    /// Records that the server registered the current attempt and issued `credentialVersion`.
    func recordRegistrationSuccess(credentialVersion: Int) throws
    /// True when the server already registered exactly this request and issued the credential
    /// version this iPhone holds: registering again would only rotate the credential.
    func isRegistered(for request: DeviceRegistrationRequest, credentialVersion: Int) -> Bool
    func delete() throws
}

public extension RegistrationAttemptStore {
    func recordRegistrationSuccess(credentialVersion: Int) throws { try recordRegistrationSuccess() }
    func isRegistered(for request: DeviceRegistrationRequest, credentialVersion: Int) -> Bool { false }

    func recoveryState() throws -> RegistrationRecoveryState? { nil }

    @discardableResult
    func recordTransientFailure(
        now: Date,
        retryAfter: TimeInterval?
    ) throws -> RegistrationRecoveryState {
        RegistrationRecoveryPolicy.recordingTransientFailure(
            previousFailures: 0,
            now: now,
            retryAfter: retryAfter
        )
    }

    func recordRegistrationSuccess() throws {}
}

public struct SignOutProgress: Codable, Equatable, Sendable {
    public let deviceId: String?
    public let sessionId: String?
    public let deviceRevoked: Bool
    public let sessionRevoked: Bool

    public init(
        deviceId: String?,
        sessionId: String?,
        deviceRevoked: Bool = false,
        sessionRevoked: Bool = false
    ) {
        self.deviceId = deviceId
        self.sessionId = sessionId
        self.deviceRevoked = deviceRevoked
        self.sessionRevoked = sessionRevoked
    }

    public func recordingDeviceRevocation() -> SignOutProgress {
        SignOutProgress(
            deviceId: deviceId,
            sessionId: sessionId,
            deviceRevoked: true,
            sessionRevoked: sessionRevoked
        )
    }

    public func recordingSessionRevocation() -> SignOutProgress {
        SignOutProgress(
            deviceId: deviceId,
            sessionId: sessionId,
            deviceRevoked: deviceRevoked,
            sessionRevoked: true
        )
    }
}

public protocol SignOutProgressStore: Sendable {
    func load() throws -> SignOutProgress?
    func save(_ progress: SignOutProgress) throws
    func delete() throws
}

public struct NoopSignOutProgressStore: SignOutProgressStore {
    public init() {}
    public func load() throws -> SignOutProgress? { nil }
    public func save(_ progress: SignOutProgress) throws {}
    public func delete() throws {}
}
