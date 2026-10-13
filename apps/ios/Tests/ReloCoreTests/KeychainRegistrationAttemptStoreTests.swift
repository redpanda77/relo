@testable import ReloPersistence
import Foundation
import Security
import XCTest
@testable import ReloCore

final class KeychainRegistrationAttemptStoreTests: XCTestCase {
    func testCurrentStoragePreservesSessionAndClearsDisposableState() throws {
        let service = "com.example.relo.notifications.tests.\(UUID().uuidString)"
        let accountsDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
            .appendingPathComponent("accounts", isDirectory: true)
        defer {
            for account in Self.preflightAccounts {
                SecItemDelete(keychainQuery(service: service, account: account) as CFDictionary)
            }
            try? FileManager.default.removeItem(at: accountsDirectory.deletingLastPathComponent())
        }
        let session = AccountSession(
            accessToken: "session-token",
            sessionId: "session_legacy123456",
            expiresAt: Date(timeIntervalSince1970: 1_800_000_000),
            user: AccountUser(
                id: "usr_legacy123456",
                name: "Test User",
                email: "test@example.com"
            )
        )
        try KeychainAccountSessionStore(service: service).save(session)
        try addKeychainData(
            VersionedStorageCodec.encode(
                DevelopmentResetSchema.currentVersion,
                schemaVersion: DevelopmentResetSchema.currentVersion
            ),
            service: service,
            account: "local-storage-schema"
        )
        try addKeychainData(
            Data(#"{"revision":3,"request":{"obsolete":true}}"#.utf8),
            service: service,
            account: "registration-attempt"
        )
        let accountInbox = accountsDirectory
            .appendingPathComponent("acc_legacy123456", isDirectory: true)
            .appendingPathComponent("inbox.json")
        try FileManager.default.createDirectory(
            at: accountInbox.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data("incompatible-cache".utf8).write(to: accountInbox)

        try KeychainLocalStoragePreflight(
            service: service,
            accountsDirectory: accountsDirectory
        ).run()

        XCTAssertEqual(try KeychainAccountSessionStore(service: service).load(), session)
        XCTAssertTrue(FileManager.default.fileExists(atPath: accountInbox.path))
        XCTAssertEqual(
            SecItemCopyMatching(
                keychainQuery(service: service, account: "registration-attempt") as CFDictionary,
                nil
            ),
            errSecItemNotFound
        )
    }
    func testPreflightPreservesIncompatibleProtectedStateWhenMarkerIsRetired() throws {
        let service = "com.example.relo.notifications.tests.\(UUID().uuidString)"
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let accountsDirectory = root.appendingPathComponent("accounts", isDirectory: true)
        defer {
            for account in Self.preflightAccounts {
                SecItemDelete(keychainQuery(service: service, account: account) as CFDictionary)
            }
            try? FileManager.default.removeItem(at: root)
        }

        try addKeychainData(
            Data(#"{"accessToken":"retired-unversioned-session"}"#.utf8),
            service: service,
            account: "account-session"
        )
        try addKeychainData(
            VersionedStorageCodec.encode(1, schemaVersion: 1),
            service: service,
            account: "local-storage-schema"
        )
        let staleAccountFile = accountsDirectory
            .appendingPathComponent("acc_retired", isDirectory: true)
            .appendingPathComponent("inbox.json")
        try FileManager.default.createDirectory(
            at: staleAccountFile.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data("retired-cache".utf8).write(to: staleAccountFile)

        XCTAssertThrowsError(try KeychainLocalStoragePreflight(
            service: service,
            accountsDirectory: accountsDirectory
        ).run()) { error in
            XCTAssertEqual(error as? LocalStoragePreflightError, .protectedAccountSessionUnreadable)
        }
        XCTAssertThrowsError(try KeychainAccountSessionStore(service: service).load())
        XCTAssertEqual(try Data(contentsOf: staleAccountFile), Data("retired-cache".utf8))
        XCTAssertEqual(
            SecItemCopyMatching(
                keychainQuery(service: service, account: "local-storage-schema") as CFDictionary,
                nil
            ),
            errSecSuccess
        )
    }

    func testAttemptReplacesPersistedRequestFromOlderSchema() throws {
        let service = "com.example.relo.notifications.tests.\(UUID().uuidString)"
        let account = "registration-attempt"
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        defer { SecItemDelete(query as CFDictionary) }
        let request = registrationRequest()
        var legacyRequest = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any]
        )
        legacyRequest.removeValue(forKey: "capabilities")
        var item = query
        item[kSecValueData as String] = try JSONSerialization.data(withJSONObject: [
            "revision": 3,
            "request": legacyRequest,
        ])
        XCTAssertEqual(SecItemAdd(item as CFDictionary, nil), errSecSuccess)

        let attempt = try KeychainRegistrationAttemptStore(service: service, account: account)
            .attempt(for: request, minimumRevision: 4)

        XCTAssertEqual(attempt.revision, 4)
        XCTAssertEqual(attempt.request, request)
    }

    func testAttemptAdvancesWhenCredentialRequiresNewerRevision() throws {
        let service = "com.example.relo.notifications.tests.\(UUID().uuidString)"
        let account = "registration-attempt"
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        defer { SecItemDelete(query as CFDictionary) }
        let request = registrationRequest()
        let store = KeychainRegistrationAttemptStore(service: service, account: account)

        let first = try store.attempt(for: request, minimumRevision: 3)
        let advanced = try store.attempt(for: request, minimumRevision: 4)
        let persisted = try store.attempt(for: request, minimumRevision: 4)

        XCTAssertEqual(first.revision, 3)
        XCTAssertEqual(advanced.revision, 4)
        XCTAssertEqual(persisted, advanced)
    }

    func testRegistrationRecoveryBackoffIsBoundedAndHonorsServerRetryAfter() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        var state = RegistrationRecoveryState()
        let expectedDelays: [TimeInterval] = [5, 15, 60, 300, 900, 900]

        for expectedDelay in expectedDelays {
            state = RegistrationRecoveryPolicy.recordingTransientFailure(
                previousFailures: state.consecutiveFailures,
                now: now
            )
            XCTAssertEqual(state.nextRetryAt?.timeIntervalSince(now), expectedDelay)
        }

        let serverLimited = RegistrationRecoveryPolicy.recordingTransientFailure(
            previousFailures: 0,
            now: now,
            retryAfter: 120
        )
        XCTAssertEqual(serverLimited.nextRetryAt?.timeIntervalSince(now), 120)
    }

    func testRegistrationRecoveryStateSurvivesRelaunchAndClearsAfterSuccess() throws {
        let service = "com.example.relo.notifications.tests.\(UUID().uuidString)"
        let account = "registration-attempt"
        defer { SecItemDelete(keychainQuery(service: service, account: account) as CFDictionary) }
        let request = registrationRequest()
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let store = KeychainRegistrationAttemptStore(service: service, account: account)
        _ = try store.attempt(for: request, minimumRevision: 1)

        let firstFailure = try store.recordTransientFailure(now: now, retryAfter: nil)
        let relaunchedStore = KeychainRegistrationAttemptStore(service: service, account: account)
        XCTAssertEqual(try relaunchedStore.recoveryState(), firstFailure)

        try relaunchedStore.recordRegistrationSuccess()
        XCTAssertEqual(
            try store.recoveryState(),
            RegistrationRecoveryState(consecutiveFailures: 0, nextRetryAt: nil)
        )
        XCTAssertEqual(try store.attempt(for: request, minimumRevision: 1).revision, 1)
    }

    func testPreflightRepairsDisposableStoresEvenWhenResetMarkerIsCurrent() throws {
        let service = "com.example.relo.notifications.tests.\(UUID().uuidString)"
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer {
            for account in Self.preflightAccounts {
                SecItemDelete(keychainQuery(service: service, account: account) as CFDictionary)
            }
            try? FileManager.default.removeItem(at: root)
        }
        try addKeychainData(
            VersionedStorageCodec.encode(
                DevelopmentResetSchema.currentVersion,
                schemaVersion: DevelopmentResetSchema.currentVersion
            ),
            service: service,
            account: "local-storage-schema"
        )
        try addKeychainData(Data("corrupt-attempt".utf8), service: service, account: "registration-attempt")
        try addKeychainData(Data([0xFF, 0xFE]), service: service, account: "apns-token")
        try addKeychainData(
            Data([0xFF, 0xFE]),
            service: service,
            account: "live-activity-push-to-start-token"
        )

        try KeychainLocalStoragePreflight(
            service: service,
            accountsDirectory: root.appendingPathComponent("accounts", isDirectory: true)
        ).run()

        for account in ["registration-attempt", "apns-token", "live-activity-push-to-start-token"] {
            XCTAssertEqual(
                SecItemCopyMatching(keychainQuery(service: service, account: account) as CFDictionary, nil),
                errSecItemNotFound
            )
        }
    }

    func testPreflightRecreatesUnreadableDisposableResetMarker() throws {
        let service = "com.example.relo.notifications.tests.\(UUID().uuidString)"
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer {
            for account in Self.preflightAccounts {
                SecItemDelete(keychainQuery(service: service, account: account) as CFDictionary)
            }
            try? FileManager.default.removeItem(at: root)
        }
        try addKeychainData(
            Data("corrupt-reset-marker".utf8),
            service: service,
            account: "local-storage-schema"
        )

        try KeychainLocalStoragePreflight(
            service: service,
            accountsDirectory: root.appendingPathComponent("accounts", isDirectory: true)
        ).run()

        XCTAssertNoThrow(try KeychainLocalStoragePreflight(
            service: service,
            accountsDirectory: root.appendingPathComponent("accounts", isDirectory: true)
        ).run())
        XCTAssertEqual(
            SecItemCopyMatching(
                keychainQuery(service: service, account: "local-storage-schema") as CFDictionary,
                nil
            ),
            errSecSuccess
        )
    }

    func testPreflightRetainsUnreadableProtectedIdentityAndReportsRecoveryState() throws {
        let service = "com.example.relo.notifications.tests.\(UUID().uuidString)"
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer {
            for account in Self.preflightAccounts {
                SecItemDelete(keychainQuery(service: service, account: account) as CFDictionary)
            }
            try? FileManager.default.removeItem(at: root)
        }
        try addKeychainData(
            VersionedStorageCodec.encode("not-a-uuid", schemaVersion: LocalStoreSchema.stableDeviceID),
            service: service,
            account: "stable-device-id"
        )
        try addKeychainData(
            VersionedStorageCodec.encode(
                DevelopmentResetSchema.currentVersion,
                schemaVersion: DevelopmentResetSchema.currentVersion
            ),
            service: service,
            account: "local-storage-schema"
        )

        XCTAssertThrowsError(try KeychainLocalStoragePreflight(
            service: service,
            accountsDirectory: root.appendingPathComponent("accounts", isDirectory: true)
        ).run()) { error in
            XCTAssertEqual(error as? LocalStoragePreflightError, .protectedStableDeviceIDUnreadable)
        }
        XCTAssertEqual(
            SecItemCopyMatching(
                keychainQuery(service: service, account: "stable-device-id") as CFDictionary,
                nil
            ),
            errSecSuccess
        )
    }

    func testPreflightRetainsUnreadableDurableSignOutProgress() throws {
        let service = "com.example.relo.notifications.tests.\(UUID().uuidString)"
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer {
            for account in Self.preflightAccounts {
                SecItemDelete(keychainQuery(service: service, account: account) as CFDictionary)
            }
            try? FileManager.default.removeItem(at: root)
        }
        try addKeychainData(
            Data(#"{"schemaVersion":2,"payload":{"step":"unknown"}}"#.utf8),
            service: service,
            account: "sign-out-progress"
        )
        try addKeychainData(
            VersionedStorageCodec.encode(
                DevelopmentResetSchema.currentVersion,
                schemaVersion: DevelopmentResetSchema.currentVersion
            ),
            service: service,
            account: "local-storage-schema"
        )

        XCTAssertThrowsError(try KeychainLocalStoragePreflight(
            service: service,
            accountsDirectory: root.appendingPathComponent("accounts", isDirectory: true)
        ).run()) { error in
            XCTAssertEqual(error as? LocalStoragePreflightError, .durableSignOutProgressUnreadable)
        }
        XCTAssertEqual(
            SecItemCopyMatching(
                keychainQuery(service: service, account: "sign-out-progress") as CFDictionary,
                nil
            ),
            errSecSuccess
        )
    }

    func testExplicitRegistrationResetPreservesAccountAndSignOutProgress() throws {
        let service = "com.example.relo.notifications.tests.\(UUID().uuidString)"
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let accountsDirectory = root.appendingPathComponent("accounts", isDirectory: true)
        defer {
            for account in Self.preflightAccounts {
                SecItemDelete(keychainQuery(service: service, account: account) as CFDictionary)
            }
            try? FileManager.default.removeItem(at: root)
        }
        let session = AccountSession(
            accessToken: "session-token",
            sessionId: "session_reset123456",
            expiresAt: Date(timeIntervalSince1970: 1_800_000_000),
            user: AccountUser(
                id: "usr_reset123456",
                name: "Test User",
                email: "test@example.com"
            )
        )
        let progress = SignOutProgress(
            deviceId: "dev_reset123456",
            sessionId: session.sessionId,
            deviceRevoked: true
        )
        try KeychainAccountSessionStore(service: service).save(session)
        try KeychainSignOutProgressStore(service: service).save(progress)
        try KeychainDeviceCredentialStore(service: service).save(DeviceCredential(
            deviceId: "dev_reset123456",
            installationId: UUID(),
            accessToken: "device-token",
            issuedAt: Date(timeIntervalSince1970: 1_700_000_000),
            accountId: "acc_reset123456",
            credentialVersion: 1
        ))
        _ = try KeychainStableDeviceIDStore(service: service).loadOrCreate()
        _ = try KeychainInstallationIDStore(service: service).loadOrCreate()
        try KeychainPushTokenStore(service: service).save("apns-token")
        _ = try KeychainRegistrationAttemptStore(service: service)
            .attempt(for: registrationRequest(), minimumRevision: 1)
        let accountInboxURL = accountsDirectory
            .appendingPathComponent("acc_reset123456", isDirectory: true)
            .appendingPathComponent("inbox.json")
        try FileManager.default.createDirectory(
            at: accountInboxURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data("cache".utf8).write(to: accountInboxURL)

        try KeychainLocalStoragePreflight(
            service: service,
            accountsDirectory: accountsDirectory
        ).resetDeviceRegistrationState()

        XCTAssertEqual(try KeychainAccountSessionStore(service: service).load(), session)
        XCTAssertEqual(try KeychainSignOutProgressStore(service: service).load(), progress)
        for account in [
            "device-credential",
            "stable-device-id",
            "installation-id",
            "apns-token",
            "registration-attempt",
        ] {
            XCTAssertEqual(
                SecItemCopyMatching(keychainQuery(service: service, account: account) as CFDictionary, nil),
                errSecItemNotFound
            )
        }
        XCTAssertEqual(try Data(contentsOf: accountInboxURL), Data("cache".utf8))
        // Preflight after explicit recovery must not erase the preserved account.
        try KeychainLocalStoragePreflight(service: service, accountsDirectory: accountsDirectory).run()
        XCTAssertEqual(try KeychainAccountSessionStore(service: service).load(), session)
        XCTAssertEqual(try Data(contentsOf: accountInboxURL), Data("cache".utf8))
    }

    private func registrationRequest() -> DeviceRegistrationRequest {
        DeviceRegistrationRequest(
            stableDeviceId: UUID(uuidString: "11111111-1111-4111-8111-111111111111")!,
            installationId: UUID(uuidString: "22222222-2222-4222-8222-222222222222")!,
            name: "iPhone",
            bundleIdentifier: "com.example.relo.notifications",
            appVersion: "0.1.0",
            appBuild: "1",
            osVersion: "26.5.2",
            model: "iPhone16,2",
            apnsEnvironment: "sandbox",
            notificationAuthorization: .authorized,
            liveActivityAuthorization: .authorized
        )
    }

    private func keychainQuery(service: String, account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    private func addKeychainData(_ data: Data, service: String, account: String) throws {
        var item = keychainQuery(service: service, account: account)
        item[kSecValueData as String] = data
        XCTAssertEqual(SecItemAdd(item as CFDictionary, nil), errSecSuccess)
    }

    private static let preflightAccounts = [
        "account-session",
        "device-credential",
        "stable-device-id",
        "installation-id",
        "apns-token",
        "live-activity-push-to-start-token",
        "registration-attempt",
        "sign-out-progress",
        "local-storage-schema",
    ]
}
