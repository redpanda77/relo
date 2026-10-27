import Foundation
import ReloCore
import Security

#if os(macOS)
/// Whether this process uses the data-protection keychain: the signed Mac app does (its keychain access group
/// entitlement), so access belongs to the app's ID and macOS never asks per item. A process without the entitlement
/// (the package's tests) keeps the file-based keychain, which needs none.
public enum ReloDataProtectionKeychain {
    public static let available: Bool = {
        guard let task = SecTaskCreateFromSelf(nil) else { return false }
        return SecTaskCopyValueForEntitlement(task, "keychain-access-groups" as CFString, nil) != nil
    }()
}
#endif

/// Stores the end-to-end encryption key ring in the Keychain. With `accessGroup` (the app and both
/// extensions share it) the Notification Service Extension and the Live Activity widget can open
/// envelopes and sign answers. Readable after first unlock so a locked phone can still decrypt;
/// never synced or backed up (`ThisDeviceOnly`). On a device the entries are Secure Enclave blobs.
public struct KeychainKeyRingStore: ReloKeyRingStore {
    public static let account = "e2ee-key-ring-v1"
    private let service: String
    private let accessGroup: String?
    private let mirror: ReloWidgetKeyMirror?
    private let readsMirror: Bool

    /// `readsMirror`: the Live Activity widget, which has no Keychain, opens with the mirror's
    /// prekeys instead (read-only: a state loaded from it is never saved back).
    public init(service: String, accessGroup: String?, mirror: ReloWidgetKeyMirror? = .shared, readsMirror: Bool = false) {
        self.service = service
        self.accessGroup = accessGroup
        self.mirror = mirror
        self.readsMirror = readsMirror
    }

    public func load() throws -> ReloKeyRingState? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        if status == errSecNotAvailable, readsMirror, let snapshot = mirror?.load() {
            return ReloKeyRingState(identity: ReloWidgetKeyMirror.noIdentity, prekeys: snapshot.prekeys)
        }
        guard status == errSecSuccess else { throw CredentialStoreError.keychain(status) }
        guard let data = result as? Data else { throw CredentialStoreError.invalidData }
        return try JSONDecoder().decode(ReloKeyRingState.self, from: data)
    }

    public func save(_ state: ReloKeyRingState) throws {
        guard state.identity != ReloWidgetKeyMirror.noIdentity else { throw CredentialStoreError.invalidData }
        defer {
            mirror?.update { $0.prekeys = ReloWidgetKeyMirror.openable(state.prekeys) }
            ReloE2EEGeneration.bump()
        }
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
        defer { ReloE2EEGeneration.bump() }
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
        #if os(macOS)
        // The data-protection keychain, as on iOS: access belongs to the app's ID, so macOS never asks the owner to
        // allow an app per item (the file-based login keychain did, again whenever the signing changed).
        if ReloDataProtectionKeychain.available { query[kSecUseDataProtectionKeychain as String] = true }
        #endif
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

    static func live(bundle: Bundle = .main, policy: ReloKeyRingPolicy = .init(), readsMirror: Bool = false) -> ReloKeyRing {
        let group = sharedAccessGroup(bundle: bundle)
        let factory: any ReloKeyFactory = ReloSecureEnclaveKeyFactory.isAvailable ? ReloSecureEnclaveKeyFactory() : ReloSoftwareKeyFactory()
        return ReloKeyRing(store: KeychainKeyRingStore(service: "relo.e2ee", accessGroup: group, readsMirror: readsMirror),
                           factory: factory, policy: policy)
    }
}

/// The computers this phone trusts, in the same shared Keychain group as the key ring so the
/// Notification Service Extension can check senders.
public struct KeychainTrustedClientStore: ReloTrustedClientStore {
    public static let account = "e2ee-trusted-clients-v1"
    private let service: String
    private let accessGroup: String?
    private let mirror: ReloWidgetKeyMirror?
    private let readsMirror: Bool

    public init(service: String = "relo.e2ee", accessGroup: String?, mirror: ReloWidgetKeyMirror? = .shared,
                readsMirror: Bool = false) {
        self.service = service
        self.accessGroup = accessGroup
        self.mirror = mirror
        self.readsMirror = readsMirror
    }

    public func load() throws -> [ReloTrustedClient] {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return [] }
        if status == errSecNotAvailable, readsMirror, let snapshot = mirror?.load() { return snapshot.trusted }
        guard status == errSecSuccess else { throw CredentialStoreError.keychain(status) }
        guard let data = result as? Data else { throw CredentialStoreError.invalidData }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode([ReloTrustedClient].self, from: data)
    }

    public func save(_ clients: [ReloTrustedClient]) throws {
        defer {
            mirror?.update { $0.trusted = clients }
            ReloE2EEGeneration.bump()
        }
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
        #if os(macOS)
        // The data-protection keychain, as on iOS: access belongs to the app's ID, so macOS never asks the owner to
        // allow an app per item (the file-based login keychain did, again whenever the signing changed).
        if ReloDataProtectionKeychain.available { query[kSecUseDataProtectionKeychain as String] = true }
        #endif
        return query
    }
}

public extension ReloTrustedClients {
    static func live(bundle: Bundle = .main, readsMirror: Bool = false) -> ReloTrustedClients {
        ReloTrustedClients(store: KeychainTrustedClientStore(accessGroup: ReloKeyRing.sharedAccessGroup(bundle: bundle),
                                                             readsMirror: readsMirror))
    }
}

/// The approvers this device trusts (ReloTrustedApprovers): their signatures over computers count here.
public struct KeychainTrustedApproverStore: ReloTrustedApproverStore {
    public static let account = "e2ee-trusted-approvers-v1"
    private let service: String
    private let accessGroup: String?

    public init(service: String = "relo.e2ee", accessGroup: String?) {
        self.service = service
        self.accessGroup = accessGroup
    }

    public func load() throws -> [ReloPinnedApprover] {
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
        return try decoder.decode([ReloPinnedApprover].self, from: data)
    }

    public func save(_ approvers: [ReloPinnedApprover]) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let attributes: [String: Any] = [
            kSecValueData as String: try encoder.encode(approvers),
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
        #if os(macOS)
        // The data-protection keychain, as on iOS: access belongs to the app's ID, so macOS never asks the owner to
        // allow an app per item (the file-based login keychain did, again whenever the signing changed).
        if ReloDataProtectionKeychain.available { query[kSecUseDataProtectionKeychain as String] = true }
        #endif
        return query
    }
}

public extension ReloTrustedApprovers {
    static func live(bundle: Bundle = .main) -> ReloTrustedApprovers {
        ReloTrustedApprovers(store: KeychainTrustedApproverStore(accessGroup: ReloKeyRing.sharedAccessGroup(bundle: bundle)))
    }
}

/// The replay ledger, shared by the app and the Notification Service Extension through the same
/// Keychain group, so a replay is caught whichever process opens the envelope first.
///
/// Each process keeps the ledger in memory and treats the Keychain as its backing store: a context
/// already known is answered without touching the Keychain (a snapshot admits hundreds), an unknown
/// one first re-reads the Keychain when the copy is more than 2 s old (the other process may have
/// admitted it meanwhile), and a change is written through at once unless one was written in the last
/// second, when a single trailing write carries the burst. A ledger that cannot be written never
/// blocks reading; it only weakens replay detection.
public struct KeychainReplayLedger: ReloReplayLedger {
    public static let account = "e2ee-replay-ledger-v1"
    private let service: String
    private let accessGroup: String?
    private let memory: Memory

    public init(service: String = "relo.e2ee", accessGroup: String?) {
        self.service = service
        self.accessGroup = accessGroup
        self.memory = Memory.shared(for: "\(service)|\(accessGroup ?? "")")
    }

    /// Sign-out deleted the Keychain item: the in-memory copy must not resurrect it.
    public static func forgetMemory() { Memory.forgetAll() }

    /// One per process and Keychain item, so every `ReloSealedContent.live()` shares it.
    fileprivate final class Memory: @unchecked Sendable {
        private static let registry = NSLock()
        private nonisolated(unsafe) static var all: [String: Memory] = [:]

        static func shared(for key: String) -> Memory {
            registry.withLock {
                if let known = all[key] { return known }
                let made = Memory()
                all[key] = made
                return made
            }
        }

        static func forgetAll() {
            let memories = registry.withLock { Array(all.values) }
            for memory in memories { memory.reset() }
        }

        let lock = NSLock()
        var entries: [String: ReloReplayEntry] = [:]
        var loadedAt: Date?
        var wroteAt = Date.distantPast
        var dirty = false
        var flushScheduled = false

        func reset() {
            lock.withLock {
                entries = [:]
                loadedAt = nil
                dirty = false
            }
        }
    }

    public func admit(context: String, itemID: String, now: Date) -> Bool {
        memory.lock.withLock {
            let clock = Date()
            if let known = memory.entries[context], memory.loadedAt != nil { return known.itemID == itemID }
            // Unknown here: another process may know it, so a stale copy is refreshed first.
            if memory.loadedAt.map({ clock.timeIntervalSince($0) > 2 }) ?? true {
                // What this process admitted and has not written yet outranks the Keychain's copy.
                memory.entries = load().merging(memory.entries) { _, mine in mine }
                memory.loadedAt = clock
            }
            let existed = memory.entries[context] != nil
            let admitted = ReloReplayRules.admit(&memory.entries, context: context, itemID: itemID, now: now)
            if admitted, !existed {
                memory.dirty = true
                if clock.timeIntervalSince(memory.wroteAt) >= 1 {
                    flush()
                } else if !memory.flushScheduled {
                    memory.flushScheduled = true
                    let service = service, group = accessGroup
                    DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 1) {
                        let ledger = KeychainReplayLedger(service: service, accessGroup: group)
                        ledger.memory.lock.withLock {
                            ledger.memory.flushScheduled = false
                            if ledger.memory.dirty { ledger.flush() }
                        }
                    }
                }
            }
            return admitted
        }
    }

    /// Caller holds `memory.lock`. Merges what the other process wrote since, so neither erases the other.
    private func flush() {
        let merged = load().merging(memory.entries) { _, mine in mine }
        memory.entries = merged
        save(merged)
        memory.dirty = false
        memory.wroteAt = Date()
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
        #if os(macOS)
        // The data-protection keychain, as on iOS: access belongs to the app's ID, so macOS never asks the owner to
        // allow an app per item (the file-based login keychain did, again whenever the signing changed).
        if ReloDataProtectionKeychain.available { query[kSecUseDataProtectionKeychain as String] = true }
        #endif
        return query
    }
}

/// Handle → name for opaque project, topic and task names (E2.5), shared by the app, the
/// Notification Service Extension and the widget through the same Keychain group.
public final class KeychainNameBook: ReloNameBook, @unchecked Sendable {
    public static let account = "e2ee-name-book-v1"
    private let service: String
    private let accessGroup: String?
    private let mirror: ReloWidgetKeyMirror?
    private let readsMirror: Bool
    private let lock = NSLock()

    public init(service: String = "relo.e2ee", accessGroup: String?, mirror: ReloWidgetKeyMirror? = .shared,
                readsMirror: Bool = false) {
        self.service = service
        self.accessGroup = accessGroup
        self.mirror = mirror
        self.readsMirror = readsMirror
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
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecNotAvailable, readsMirror, let snapshot = mirror?.load() {
            return snapshot.names.mapValues { ReloNames.Entry(name: $0, sender: "") }
        }
        guard status == errSecSuccess, let data = result as? Data else { return [:] }
        // A book saved before senders were recorded holds plain names; it is replaced from envelopes.
        return (try? JSONDecoder().decode([String: Entry].self, from: data)) ?? [:]
    }

    private func save(_ names: [String: Entry]) {
        guard !readsMirror else { return }
        mirror?.update { $0.names = names.mapValues(\.name) }
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
        #if os(macOS)
        // The data-protection keychain, as on iOS: access belongs to the app's ID, so macOS never asks the owner to
        // allow an app per item (the file-based login keychain did, again whenever the signing changed).
        if ReloDataProtectionKeychain.available { query[kSecUseDataProtectionKeychain as String] = true }
        #endif
        return query
    }
}

public enum ReloEncryptionState {
    /// Signing out forgets what this phone learned for the account: trusted computers and approvers, linked
    /// browsers, names and the replay ledger are deleted (and no browser link is ever renewed again).
    /// The phone's own keys stay in the Secure Enclave, like WhatsApp keeping its keys on a phone that
    /// signs in again: computers recognise the same identity key under the new registration and keep
    /// sealing without any check. Old prekeys still expire on the usual schedule.
    public static func forget(bundle: Bundle = .main) {
        let group = ReloKeyRing.sharedAccessGroup(bundle: bundle)
        for account in [KeychainTrustedClientStore.account, KeychainNameBook.account,
                        KeychainReplayLedger.account, KeychainLinkedBrowserStore.account, KeychainTrustedApproverStore.account] {
            var query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: "relo.e2ee",
                kSecAttrAccount as String: account,
            ]
            if let group { query[kSecAttrAccessGroup as String] = group }
            #if os(macOS)
            if ReloDataProtectionKeychain.available { query[kSecUseDataProtectionKeychain as String] = true }
            #endif
            SecItemDelete(query as CFDictionary)
        }
        ReloWidgetKeyMirror.shared?.update {
            $0.trusted = []
            $0.names = [:]
        }
        KeychainReplayLedger.forgetMemory()
        ReloE2EEGeneration.bump()
    }
}

/// What the Live Activity widget needs to open sealed cards, kept where it can read it.
///
/// The widget process that draws Live Activities has no Keychain at all (`errSecNotAvailable`), so
/// the Keychain items the app and the Notification Service Extension use can never open a card
/// there. The app and the extension write this copy whenever they save: the software prekeys'
/// private halves, the trusted computers and the project names. Never the identity key, which stays
/// in the Secure Enclave. Like the Keychain items it is readable only after the first unlock since
/// boot (complete-until-first-authentication), only by Relo and its extensions (the App Group), and
/// never leaves this iPhone (excluded from backups). Retired prekeys leave it with the key ring.
public struct ReloWidgetKeyMirror: Sendable {
    public struct Snapshot: Codable, Equatable, Sendable {
        public var prekeys: [ReloStoredPrekey] = []
        public var trusted: [ReloTrustedClient] = []
        public var names: [String: String] = [:]
    }

    /// Stands in for the identity in a key ring loaded from the mirror; such a ring is never saved.
    public static let noIdentity = ReloStoredKey(kind: .software, data: Data(), publicKey: Data())

    public let url: URL

    public init(url: URL) { self.url = url }

    public static let shared: ReloWidgetKeyMirror? = {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "RELOAppGroup") as? String,
              let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return nil }
        return ReloWidgetKeyMirror(url: root.appendingPathComponent("Library/Application Support/Relo/e2ee-widget-v1.json"))
    }()

    /// Shares the last known step labels between the app and the widget through the App Group, next to the mirror.
    public static func installLabelMemory() {
        ReloStepLabelMemory.configure(file: shared?.url.deletingLastPathComponent().appendingPathComponent("step-labels-v1.json"))
    }

    /// Only software prekeys open outside the process that made them.
    static func openable(_ prekeys: [ReloStoredPrekey]) -> [ReloStoredPrekey] {
        prekeys.filter { $0.key.kind == .software }
    }

    public func load() -> Snapshot? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(Snapshot.self, from: data)
    }

    public func update(_ change: (inout Snapshot) -> Void) {
        var snapshot = load() ?? Snapshot()
        let before = snapshot
        change(&snapshot)
        guard snapshot != before || !FileManager.default.fileExists(atPath: url.path) else { return }
        write(snapshot)
    }

    /// Copies the Keychain's current state; the app calls it at launch so an existing install fills it.
    public func refresh(ring: ReloKeyRingState?, trusted: [ReloTrustedClient], names: [String: String]) {
        update {
            $0.prekeys = Self.openable(ring?.prekeys ?? [])
            $0.trusted = trusted
            $0.names = names
        }
    }

    private func write(_ snapshot: Snapshot) {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(snapshot) else { return }
        let directory = url.deletingLastPathComponent()
        #if os(iOS)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                 attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        guard (try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])) != nil else { return }
        #else
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard (try? data.write(to: url, options: .atomic)) != nil else { return }
        #endif
        var excluded = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? excluded.setResourceValues(values)
    }
}
