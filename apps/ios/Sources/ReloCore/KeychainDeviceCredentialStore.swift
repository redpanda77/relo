import Foundation
import CryptoKit
import Security

public enum CredentialStoreError: Error, Equatable {
    case keychain(OSStatus)
    case invalidData
}

public struct KeychainDeviceCredentialStore: DeviceCredentialStore, @unchecked Sendable {
    private let store: KeychainDataStore

    public init(service: String = "com.example.relo.notifications", account: String = "device-credential") {
        store = KeychainDataStore(service: service, account: account)
    }

    public func load() throws -> DeviceCredential? {
        guard let data = try store.load() else { return nil }
        return try VersionedStorageCodec.decode(
            PersistedDeviceCredential.self,
            from: data,
            schemaVersion: LocalStoreSchema.deviceCredential
        ).payload.credential
    }

    public func save(_ credential: DeviceCredential) throws {
        try store.save(VersionedStorageCodec.encode(
            PersistedDeviceCredential(credential),
            schemaVersion: LocalStoreSchema.deviceCredential
        ))
    }

    public func delete() throws { try store.delete() }
}

public struct KeychainInstallationIDStore: InstallationIDStore, @unchecked Sendable {
    private let store: KeychainUUIDStore

    public init(service: String = "com.example.relo.notifications", account: String = "installation-id") {
        store = KeychainUUIDStore(
            service: service,
            account: account,
            schemaVersion: LocalStoreSchema.installationID
        )
    }

    public func loadOrCreate() throws -> UUID { try store.loadOrCreate() }
}

public struct KeychainStableDeviceIDStore: StableDeviceIDStore, @unchecked Sendable {
    private let store: KeychainUUIDStore

    public init(service: String = "com.example.relo.notifications", account: String = "stable-device-id") {
        self.store = KeychainUUIDStore(
            service: service,
            account: account,
            schemaVersion: LocalStoreSchema.stableDeviceID
        )
    }

    public func loadOrCreate() throws -> UUID {
        try store.loadOrCreate()
    }
}

public struct KeychainAccountSessionStore: AccountSessionStore, @unchecked Sendable {
    private let store: KeychainDataStore

    public init(service: String = "com.example.relo.notifications", account: String = "account-session") {
        store = KeychainDataStore(service: service, account: account)
    }

    public func load() throws -> AccountSession? {
        guard let data = try store.load() else { return nil }
        return try VersionedStorageCodec.decode(
            PersistedAccountSession.self,
            from: data,
            schemaVersion: LocalStoreSchema.accountSession
        ).payload.session
    }

    public func save(_ session: AccountSession) throws {
        try store.save(VersionedStorageCodec.encode(
            PersistedAccountSession(session),
            schemaVersion: LocalStoreSchema.accountSession
        ))
    }
    public func delete() throws { try store.delete() }
}

public struct KeychainPushTokenStore: PushTokenStore, @unchecked Sendable {
    private let store: KeychainDataStore

    public init(service: String = "com.example.relo.notifications", account: String = "apns-token") {
        self.store = KeychainDataStore(service: service, account: account)
    }

    public func load() throws -> String? {
        guard let data = try store.load() else { return nil }
        return try VersionedStorageCodec.decode(
            String.self,
            from: data,
            schemaVersion: LocalStoreSchema.pushToken
        ).payload
    }

    public func save(_ token: String) throws {
        try store.save(VersionedStorageCodec.encode(
            token,
            schemaVersion: LocalStoreSchema.pushToken
        ))
    }

    public func delete() throws {
        try store.delete()
    }

    public func repairIfUnreadable() throws {
        do {
            _ = try load()
        } catch {
            try delete()
        }
    }

}

public struct KeychainRegistrationAttemptStore: RegistrationAttemptStore, @unchecked Sendable {
    private let store: KeychainCodableStore<PersistedRegistrationAttempt>

    public init(service: String = "com.example.relo.notifications", account: String = "registration-attempt") {
        self.store = KeychainCodableStore(
            service: service,
            account: account,
            schemaVersion: LocalStoreSchema.registrationAttempt
        )
    }

    public func attempt(
        for request: DeviceRegistrationRequest,
        minimumRevision: Int
    ) throws -> RegistrationAttempt {
        let existing: PersistedRegistrationAttempt?
        do {
            existing = try store.load()
        } catch {
            try store.delete()
            existing = nil
        }
        let fingerprint = try Self.fingerprint(request)
        if let existing,
           existing.requestFingerprint == fingerprint,
           existing.revision >= minimumRevision {
            return RegistrationAttempt(revision: existing.revision, request: request)
        }
        let revision = max(max((existing?.revision ?? 0) + 1, minimumRevision), 1)
        try store.save(PersistedRegistrationAttempt(
            revision: revision,
            requestFingerprint: fingerprint,
            transientFailureCount: nil,
            nextRetryAt: nil
        ))
        return RegistrationAttempt(
            revision: revision,
            request: request
        )
    }

    public func advanceCurrentAttempt() throws {
        guard let existing = try store.load() else { return }
        try store.save(PersistedRegistrationAttempt(
            revision: existing.revision + 1,
            requestFingerprint: existing.requestFingerprint,
            transientFailureCount: existing.transientFailureCount,
            nextRetryAt: existing.nextRetryAt
        ))
    }

    public func recoveryState() throws -> RegistrationRecoveryState? {
        let existing: PersistedRegistrationAttempt?
        do {
            existing = try store.load()
        } catch {
            try store.delete()
            return nil
        }
        guard let existing else { return nil }
        return RegistrationRecoveryState(
            consecutiveFailures: existing.transientFailureCount ?? 0,
            nextRetryAt: existing.nextRetryAt
        )
    }

    @discardableResult
    public func recordTransientFailure(
        now: Date,
        retryAfter: TimeInterval?
    ) throws -> RegistrationRecoveryState {
        guard let existing = try store.load() else {
            return RegistrationRecoveryPolicy.recordingTransientFailure(
                previousFailures: 0,
                now: now,
                retryAfter: retryAfter
            )
        }
        let recovery = RegistrationRecoveryPolicy.recordingTransientFailure(
            previousFailures: existing.transientFailureCount ?? 0,
            now: now,
            retryAfter: retryAfter
        )
        try store.save(PersistedRegistrationAttempt(
            revision: existing.revision,
            requestFingerprint: existing.requestFingerprint,
            transientFailureCount: recovery.consecutiveFailures,
            nextRetryAt: recovery.nextRetryAt
        ))
        return recovery
    }

    public func recordRegistrationSuccess() throws {
        guard let existing = try store.load() else { return }
        try store.save(PersistedRegistrationAttempt(
            revision: existing.revision,
            requestFingerprint: existing.requestFingerprint,
            transientFailureCount: nil,
            nextRetryAt: nil
        ))
    }

    public func delete() throws {
        try store.delete()
    }

    public func repairIfUnreadable() throws {
        do {
            _ = try store.load()
        } catch {
            try store.delete()
        }
    }

    private static func fingerprint(_ request: DeviceRegistrationRequest) throws -> String {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return SHA256.hash(data: try encoder.encode(request)).map { String(format: "%02x", $0) }.joined()
    }
}

public struct KeychainSignOutProgressStore: SignOutProgressStore, @unchecked Sendable {
    private let store: KeychainCodableStore<SignOutProgress>

    public init(service: String = "com.example.relo.notifications", account: String = "sign-out-progress") {
        store = KeychainCodableStore(
            service: service,
            account: account,
            schemaVersion: LocalStoreSchema.signOutProgress
        )
    }

    public func load() throws -> SignOutProgress? { try store.load() }
    public func save(_ progress: SignOutProgress) throws { try store.save(progress) }
    public func delete() throws { try store.delete() }
}

private struct KeychainUUIDStore: @unchecked Sendable {
    private let store: KeychainDataStore
    private let schemaVersion: Int

    init(
        service: String,
        account: String,
        schemaVersion: Int
    ) {
        self.store = KeychainDataStore(service: service, account: account)
        self.schemaVersion = schemaVersion
    }

    func loadOrCreate() throws -> UUID {
        if let data = try store.load() {
            let stored = try VersionedStorageCodec.decode(
                String.self,
                from: data,
                schemaVersion: schemaVersion
            ).payload
            guard let identifier = UUID(uuidString: stored) else {
                throw CredentialStoreError.invalidData
            }
            return identifier
        }
        let identifier = UUID()
        try store.save(VersionedStorageCodec.encode(
            identifier.uuidString,
            schemaVersion: schemaVersion
        ))
        return identifier
    }
}

private struct KeychainCodableStore<Value: Codable>: @unchecked Sendable {
    private let store: KeychainDataStore
    private let schemaVersion: Int

    init(
        service: String,
        account: String,
        schemaVersion: Int
    ) {
        self.store = KeychainDataStore(service: service, account: account)
        self.schemaVersion = schemaVersion
    }

    func load() throws -> Value? {
        guard let data = try store.load() else { return nil }
        return try VersionedStorageCodec.decode(
            Value.self,
            from: data,
            schemaVersion: schemaVersion
        ).payload
    }

    func save(_ value: Value) throws {
        try store.save(VersionedStorageCodec.encode(value, schemaVersion: schemaVersion))
    }

    func delete() throws {
        try store.delete()
    }
}

private struct PersistedDeviceCredential: Codable {
    let deviceId: String
    let installationId: UUID
    let accessToken: String
    let issuedAt: Date
    let expiresAt: Date?
    let accountId: String
    let credentialVersion: Int

    init(_ credential: DeviceCredential) {
        deviceId = credential.deviceId
        installationId = credential.installationId
        accessToken = credential.accessToken
        issuedAt = credential.issuedAt
        expiresAt = credential.expiresAt
        accountId = credential.accountId
        credentialVersion = credential.credentialVersion
    }

    var credential: DeviceCredential {
        DeviceCredential(
            deviceId: deviceId,
            installationId: installationId,
            accessToken: accessToken,
            issuedAt: issuedAt,
            expiresAt: expiresAt,
            accountId: accountId,
            credentialVersion: credentialVersion
        )
    }
}

private struct PersistedAccountSession: Codable {
    let accessToken: String
    let sessionId: String
    let expiresAt: Date
    let userId: String
    let userName: String
    let userEmail: String
    let userImage: URL?
    let accountId: String?
    let accountName: String?
    let accountEmail: String?
    let accountImageUrl: URL?

    init(_ session: AccountSession) {
        accessToken = session.accessToken
        sessionId = session.sessionId
        expiresAt = session.expiresAt
        userId = session.user.id
        userName = session.user.name
        userEmail = session.user.email
        userImage = session.user.image
        accountId = session.account?.accountId
        accountName = session.account?.name
        accountEmail = session.account?.email
        accountImageUrl = session.account?.imageUrl
    }

    var session: AccountSession {
        let account: AccountSummary? = if let accountId, let accountName, let accountEmail {
            AccountSummary(
                accountId: accountId,
                name: accountName,
                email: accountEmail,
                imageUrl: accountImageUrl
            )
        } else {
            nil
        }
        return AccountSession(
            accessToken: accessToken,
            sessionId: sessionId,
            expiresAt: expiresAt,
            user: AccountUser(id: userId, name: userName, email: userEmail, image: userImage),
            account: account
        )
    }
}

private struct PersistedRegistrationAttempt: Codable {
    let revision: Int
    let requestFingerprint: String
    let transientFailureCount: Int?
    let nextRetryAt: Date?
}

public enum LocalStoragePreflightError: Error, Equatable {
    case protectedAccountSessionUnreadable
    case protectedDeviceCredentialUnreadable
    case protectedStableDeviceIDUnreadable
    case protectedInstallationIDUnreadable
    case durableSignOutProgressUnreadable
}

public protocol LocalStoragePreflighting: Sendable {
    func run() throws
    func resetDeviceRegistrationState() throws
}

public struct NoopLocalStoragePreflight: LocalStoragePreflighting {
    public init() {}
    public func run() throws {}
    public func resetDeviceRegistrationState() throws {}
}

public struct KeychainLocalStoragePreflight: LocalStoragePreflighting, @unchecked Sendable {
    private let service: String
    private let accountsDirectory: URL

    public init(
        service: String = "com.example.relo.notifications",
        accountsDirectory: URL
    ) {
        self.service = service
        self.accountsDirectory = accountsDirectory
    }

    public func run() throws {
        let schemaStore = KeychainCodableStore<Int>(
            service: service,
            account: "local-storage-schema",
            schemaVersion: DevelopmentResetSchema.currentVersion
        )
        let resetVersion: Int?
        do {
            resetVersion = try schemaStore.load()
        } catch {
            // This marker controls a disposable development reset. It must never
            // become another protected record capable of blocking registration.
            try schemaStore.delete()
            resetVersion = nil
        }

        if resetVersion != DevelopmentResetSchema.currentVersion {
            // Development builds intentionally support one local-storage contract.
            // Keychain records survive an app reinstall, so a contract cutover must
            // discard the complete retired account/device binding before attempting
            // to decode any protected value. Saving the marker last makes this reset
            // idempotent if the process stops part-way through.
            try resetAllLocalState()
            try schemaStore.save(DevelopmentResetSchema.currentVersion)
        }

        do {
            _ = try KeychainAccountSessionStore(service: service).load()
        } catch {
            throw LocalStoragePreflightError.protectedAccountSessionUnreadable
        }
        do {
            _ = try KeychainDeviceCredentialStore(service: service).load()
        } catch {
            throw LocalStoragePreflightError.protectedDeviceCredentialUnreadable
        }
        do {
            _ = try KeychainStableDeviceIDStore(service: service).loadOrCreate()
        } catch {
            throw LocalStoragePreflightError.protectedStableDeviceIDUnreadable
        }
        do {
            _ = try KeychainInstallationIDStore(service: service).loadOrCreate()
        } catch {
            throw LocalStoragePreflightError.protectedInstallationIDUnreadable
        }
        do {
            _ = try KeychainSignOutProgressStore(service: service).load()
        } catch {
            throw LocalStoragePreflightError.durableSignOutProgressUnreadable
        }

        try KeychainRegistrationAttemptStore(service: service).repairIfUnreadable()
        try KeychainPushTokenStore(service: service).repairIfUnreadable()
        try KeychainPushTokenStore(
            service: service,
            account: "live-activity-push-to-start-token"
        ).repairIfUnreadable()

    }

    public func resetDeviceRegistrationState() throws {
        // This is an explicit recovery action for protected device identity.
        // Preserve the authenticated account, sign-out progress, and durable
        // user responses while rebuilding all device-registration material.
        for account in [
            "device-credential",
            "stable-device-id",
            "installation-id",
            "apns-token",
            "live-activity-push-to-start-token",
            "registration-attempt",
            "local-storage-schema",
        ] {
            try KeychainDataStore(service: service, account: account).delete()
        }
        removeAccountFiles()
    }

    private func resetAllLocalState() throws {
        for account in [
            "account-session",
            "device-credential",
            "stable-device-id",
            "installation-id",
            "apns-token",
            "live-activity-push-to-start-token",
            "registration-attempt",
            "sign-out-progress",
            "local-storage-schema",
        ] {
            try KeychainDataStore(service: service, account: account).delete()
        }
        removeAccountFiles()
    }

    private func removeAccountFiles() {
        guard FileManager.default.fileExists(atPath: accountsDirectory.path) else { return }
        try? FileManager.default.removeItem(at: accountsDirectory)
    }
}

private struct KeychainDataStore: @unchecked Sendable {
    private let service: String
    private let account: String

    init(service: String, account: String) {
        self.service = service
        self.account = account
    }

    func load() throws -> Data? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw CredentialStoreError.keychain(status) }
        guard let data = result as? Data else { throw CredentialStoreError.invalidData }
        return data
    }

    func save(_ data: Data) throws {
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        let status = SecItemUpdate(baseQuery as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var insertion = baseQuery
            attributes.forEach { insertion[$0.key] = $0.value }
            let addStatus = SecItemAdd(insertion as CFDictionary, nil)
            guard addStatus == errSecSuccess else { throw CredentialStoreError.keychain(addStatus) }
        } else if status != errSecSuccess {
            throw CredentialStoreError.keychain(status)
        }
    }

    func delete() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw CredentialStoreError.keychain(status)
        }
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
    }
}
