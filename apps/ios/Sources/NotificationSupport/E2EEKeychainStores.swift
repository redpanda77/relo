import Foundation
import ReloCore
import Security

/// Stores the end-to-end encryption key ring in the Keychain. With `accessGroup` (the app and both
/// extensions share it) the Notification Service Extension and the Live Activity widget can open
/// envelopes and sign answers. Readable after first unlock so a locked phone can still decrypt;
/// never synced or backed up (`ThisDeviceOnly`). On a device the entries are Secure Enclave blobs.
public struct KeychainKeyRingStore: ReloKeyRingStore {
    public static let account = "e2ee-key-ring-v1"
    private let service: String
    private let accessGroup: String?

    public init(service: String, accessGroup: String?) {
        self.service = service
        self.accessGroup = accessGroup
    }

    public func load() throws -> ReloKeyRingState? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw CredentialStoreError.keychain(status) }
        guard let data = result as? Data else { throw CredentialStoreError.invalidData }
        return try JSONDecoder().decode(ReloKeyRingState.self, from: data)
    }

    public func save(_ state: ReloKeyRingState) throws {
        let attributes: [String: Any] = [
            kSecValueData as String: try JSONEncoder().encode(state),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(baseQuery as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var insertion = baseQuery
            attributes.forEach { insertion[$0.key] = $0.value }
            let added = SecItemAdd(insertion as CFDictionary, nil)
            guard added == errSecSuccess else { throw CredentialStoreError.keychain(added) }
        } else if status != errSecSuccess {
            throw CredentialStoreError.keychain(status)
        }
    }

    public func delete() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw CredentialStoreError.keychain(status) }
    }

    private var baseQuery: [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: Self.account,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }
}

public extension ReloKeyRing {
    /// The key ring the app and its extensions share. The Keychain access group comes from the
    /// `RELOKeychainAccessGroup` Info.plist key (`<TEAM ID>.<bundle id>.e2ee`); an unsigned build
    /// without a team prefix falls back to the process's own Keychain.
    static func sharedAccessGroup(bundle: Bundle = .main) -> String? {
        (bundle.object(forInfoDictionaryKey: "RELOKeychainAccessGroup") as? String)
            .flatMap { $0.range(of: #"^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$"#, options: .regularExpression) == nil ? nil : $0 }
    }

    static func live(bundle: Bundle = .main, policy: ReloKeyRingPolicy = .init()) -> ReloKeyRing {
        let group = sharedAccessGroup(bundle: bundle)
        let factory: any ReloKeyFactory = ReloSecureEnclaveKeyFactory.isAvailable ? ReloSecureEnclaveKeyFactory() : ReloSoftwareKeyFactory()
        return ReloKeyRing(store: KeychainKeyRingStore(service: "relo.e2ee", accessGroup: group), factory: factory, policy: policy)
    }
}

/// The computers this phone trusts, in the same shared Keychain group as the key ring so the
/// Notification Service Extension can check senders.
public struct KeychainTrustedClientStore: ReloTrustedClientStore {
    public static let account = "e2ee-trusted-clients-v1"
    private let service: String
    private let accessGroup: String?

    public init(service: String = "relo.e2ee", accessGroup: String?) {
        self.service = service
        self.accessGroup = accessGroup
    }

    public func load() throws -> [ReloTrustedClient] {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess else { throw CredentialStoreError.keychain(status) }
        guard let data = result as? Data else { throw CredentialStoreError.invalidData }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode([ReloTrustedClient].self, from: data)
    }

    public func save(_ clients: [ReloTrustedClient]) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let attributes: [String: Any] = [
            kSecValueData as String: try encoder.encode(clients),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(baseQuery as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var insertion = baseQuery
            attributes.forEach { insertion[$0.key] = $0.value }
            let added = SecItemAdd(insertion as CFDictionary, nil)
            guard added == errSecSuccess else { throw CredentialStoreError.keychain(added) }
        } else if status != errSecSuccess {
            throw CredentialStoreError.keychain(status)
        }
    }

    private var baseQuery: [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: Self.account,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }
}

public extension ReloTrustedClients {
    static func live(bundle: Bundle = .main) -> ReloTrustedClients {
        ReloTrustedClients(store: KeychainTrustedClientStore(accessGroup: ReloKeyRing.sharedAccessGroup(bundle: bundle)))
    }
}

/// The replay ledger, shared by the app and the Notification Service Extension through the same
/// Keychain group, so a replay is caught whichever process opens the envelope first.
public struct KeychainReplayLedger: ReloReplayLedger {
    public static let account = "e2ee-replay-ledger-v1"
    private let service: String
    private let accessGroup: String?

    public init(service: String = "relo.e2ee", accessGroup: String?) {
        self.service = service
        self.accessGroup = accessGroup
    }

    public func admit(context: String, itemID: String, now: Date) -> Bool {
        var entries = load()
        let before = entries
        let admitted = ReloReplayRules.admit(&entries, context: context, itemID: itemID, now: now)
        // A ledger that cannot be written never blocks reading; it only weakens replay detection.
        if entries != before { save(entries) }
        return admitted
    }

    private func load() -> [String: ReloReplayEntry] {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return [:] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return (try? decoder.decode([String: ReloReplayEntry].self, from: data)) ?? [:]
    }

    private func save(_ entries: [String: ReloReplayEntry]) {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(entries) else { return }
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        if SecItemUpdate(baseQuery as CFDictionary, attributes as CFDictionary) == errSecItemNotFound {
            var insertion = baseQuery
            attributes.forEach { insertion[$0.key] = $0.value }
            SecItemAdd(insertion as CFDictionary, nil)
        }
    }

    private var baseQuery: [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: Self.account,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }
}

/// Handle → name for opaque project, topic and task names (E2.5), shared by the app, the
/// Notification Service Extension and the widget through the same Keychain group.
public final class KeychainNameBook: ReloNameBook, @unchecked Sendable {
    public static let account = "e2ee-name-book-v1"
    private let service: String
    private let accessGroup: String?
    private let lock = NSLock()

    public init(service: String = "relo.e2ee", accessGroup: String?) {
        self.service = service
        self.accessGroup = accessGroup
    }

    private typealias Entry = ReloNames.Entry
    /// Rows read names on every render; the Keychain is read at most once a second per process.
    private var cached: (at: Date, names: [String: String])?

    public func names() -> [String: String] {
        lock.withLock {
            if let cached, Date().timeIntervalSince(cached.at) < 1 { return cached.names }
            let names = load().mapValues(\.name)
            cached = (Date(), names)
            return names
        }
    }

    public func learn(_ names: [String: String], sender: String) {
        lock.withLock {
            let current = load()
            let learned = ReloNames.learning(names, sender: sender, into: current)
            if learned != current { save(learned) }
            cached = (Date(), learned.mapValues(\.name))
        }
    }

    private func load() -> [String: Entry] {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return [:] }
        // A book saved before senders were recorded holds plain names; it is replaced from envelopes.
        return (try? JSONDecoder().decode([String: Entry].self, from: data)) ?? [:]
    }

    private func save(_ names: [String: Entry]) {
        guard let data = try? JSONEncoder().encode(names) else { return }
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        if SecItemUpdate(baseQuery as CFDictionary, attributes as CFDictionary) == errSecItemNotFound {
            var insertion = baseQuery
            attributes.forEach { insertion[$0.key] = $0.value }
            SecItemAdd(insertion as CFDictionary, nil)
        }
    }

    private var baseQuery: [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: Self.account,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }
}

public enum ReloEncryptionState {
    /// Signing out ends this phone's encryption identity for the account: keys, trusted computers,
    /// linked browsers, names and the replay ledger are deleted, so nothing carries over to another
    /// account or server (and no browser link is ever renewed again).
    public static func forget(bundle: Bundle = .main) {
        let group = ReloKeyRing.sharedAccessGroup(bundle: bundle)
        for account in [KeychainKeyRingStore.account, KeychainTrustedClientStore.account, KeychainNameBook.account,
                        KeychainReplayLedger.account, KeychainLinkedBrowserStore.account] {
            var query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: "relo.e2ee",
                kSecAttrAccount as String: account,
            ]
            if let group { query[kSecAttrAccessGroup as String] = group }
            SecItemDelete(query as CFDictionary)
        }
    }
}
