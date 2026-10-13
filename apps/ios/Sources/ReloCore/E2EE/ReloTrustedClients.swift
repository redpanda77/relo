import Foundation

/// Computers (CLI identity keys) this phone accepts sealed content from (docs/END-TO-END-ENCRYPTION.md).
/// Like WhatsApp and Signal, the computers present when the phone first signs in are trusted
/// automatically ("auto"); a computer that appears after that waits ("pending") until the owner approves
/// it on this phone, the way a linked device is approved on the phone (docs/HARDENING.md, gap 3). A
/// trusted computer's changed key is trusted again with a visible "security code changed" notice.
/// Comparing the security code is an optional upgrade to "verified".
public struct ReloClientKey: Codable, Equatable, Sendable, Identifiable {
    public var clientId: String
    public var name: String
    public var keyId: String
    public var publicKey: String
    public var changedAt: String

    public var id: String { clientId }

    public init(clientId: String, name: String, keyId: String, publicKey: String, changedAt: String) {
        self.clientId = clientId
        self.name = name
        self.keyId = keyId
        self.publicKey = publicKey
        self.changedAt = changedAt
    }
}

public struct ReloTrustedClient: Codable, Equatable, Sendable {
    public struct Notice: Codable, Equatable, Sendable {
        public var at: Date
        /// The replaced key for a "security code changed" notice; absent for a new computer.
        public var previousKeyId: String?
        /// "security_code_changed" or "new_computer"; absent in notices saved before this field existed.
        public var kind: String?
    }

    public var clientId: String
    public var name: String
    public var keyId: String
    public var publicKey: String
    public var verifiedAt: Date
    /// "auto" (trusted on first use or approved), "verified" (security code compared), "pending"
    /// (waiting for the owner's approval) or "declined"; absent means verified.
    public var level: String?
    public var notice: Notice?

    public var isVerified: Bool { level == nil || level == "verified" }
    /// Opens sealed content: verified, or trusted automatically or by approval.
    public var isTrusted: Bool { isVerified || level == "auto" }
}

public protocol ReloTrustedClientStore: Sendable {
    func load() throws -> [ReloTrustedClient]
    func save(_ clients: [ReloTrustedClient]) throws
}

public enum ReloClientTrust: String, Equatable, Sendable {
    /// Security code compared by the owner.
    case verified
    /// Trusted on first use (or after a change, with a notice).
    case auto
    /// Appeared after this phone's first contact: opens nothing until the owner approves it here.
    case pending
    /// The owner declined it on this phone: opens nothing.
    case declined
    /// Not seen yet: trusted (or held as pending) the next time keys are refreshed.
    case new
}

public struct ReloTrustedClients: Sendable {
    public let store: any ReloTrustedClientStore

    public init(store: any ReloTrustedClientStore) {
        self.store = store
    }

    public func trust(of client: ReloClientKey) throws -> ReloClientTrust {
        guard let pinned = try store.load().first(where: { $0.clientId == client.clientId }),
              pinned.publicKey == client.publicKey else { return .new }
        switch pinned.level {
        case "pending": return .pending
        case "declined": return .declined
        default: return pinned.isVerified ? .verified : .auto
        }
    }

    /// Every computer this phone trusts, including ones the server no longer lists.
    public func all() throws -> [ReloTrustedClient] { try store.load() }

    public func notice(for client: ReloClientKey) throws -> ReloTrustedClient.Notice? {
        try store.load().first(where: { $0.clientId == client.clientId && $0.publicKey == client.publicKey })?.notice
    }

    /// Trust on first use: pins the computers present at first contact, holds any later computer as
    /// pending, and re-pins a trusted computer's changed key with a notice.
    @discardableResult
    public func autoTrust(_ clients: [ReloClientKey], now: Date = Date()) throws -> Bool {
        var pinned = try store.load()
        var changed = false
        // The first computers are trusted silently; any computer after them waits for approval.
        let firstContact = pinned.isEmpty
        for client in clients {
            guard let key = try? ReloE2EE.data(base64URL: client.publicKey, length: 65, field: "client_key"),
                  ReloE2EE.keyID(publicKeyX963: key) == client.keyId else { continue }
            let existing = pinned.firstIndex { $0.clientId == client.clientId }
            if let existing, pinned[existing].publicKey == client.publicKey { continue }
            let previous = existing.map { pinned[$0] }
            // A trusted computer's new key stays trusted (WhatsApp's "security code changed"); a new key
            // behind a computer that was never approved still waits.
            let trusted = previous.map(\.isTrusted) ?? firstContact
            let entry = ReloTrustedClient(
                clientId: client.clientId, name: client.name, keyId: client.keyId, publicKey: client.publicKey,
                verifiedAt: now, level: trusted ? "auto" : "pending",
                notice: previous.map { .init(at: now, previousKeyId: $0.keyId, kind: trusted ? "security_code_changed" : "new_computer") }
                    ?? (firstContact ? nil : .init(at: now, previousKeyId: nil, kind: "new_computer"))
            )
            if let existing { pinned[existing] = entry } else { pinned.append(entry) }
            changed = true
        }
        if changed { try store.save(pinned) }
        return changed
    }

    /// The same 60 digits `relo keys verify` prints on that computer.
    public func safetyNumber(phoneIdentity: Data, client: ReloClientKey) throws -> String {
        ReloE2EE.safetyNumber(phoneIdentity, try ReloE2EE.data(base64URL: client.publicKey, length: 65, field: "client_key"))
    }

    /// Called only after the owner confirms the numbers match on both screens.
    public func markVerified(_ client: ReloClientKey, now: Date = Date()) throws {
        let key = try ReloE2EE.data(base64URL: client.publicKey, length: 65, field: "client_key")
        guard ReloE2EE.keyID(publicKeyX963: key) == client.keyId else { throw ReloE2EEError.untrustedSender }
        var clients = try store.load().filter { $0.clientId != client.clientId }
        clients.append(ReloTrustedClient(clientId: client.clientId, name: client.name, keyId: client.keyId,
                                         publicKey: client.publicKey, verifiedAt: now, level: "verified"))
        try store.save(clients)
    }

    /// The computers waiting for the owner's approval on this phone.
    public func pending() throws -> [ReloTrustedClient] {
        try store.load().filter { $0.level == "pending" }
    }

    /// The owner approved a waiting computer on this phone: its sealed content opens from now on.
    public func approve(clientId: String, keyId: String, now: Date = Date()) throws {
        try setLevel("auto", clientId: clientId, keyId: keyId, now: now)
    }

    /// The owner declined a waiting computer: it stays listed and opens nothing.
    public func decline(clientId: String, keyId: String, now: Date = Date()) throws {
        try setLevel("declined", clientId: clientId, keyId: keyId, now: now)
    }

    private func setLevel(_ level: String, clientId: String, keyId: String, now: Date) throws {
        var clients = try store.load()
        guard let index = clients.firstIndex(where: { $0.clientId == clientId && $0.keyId == keyId }) else {
            throw ReloE2EEError.untrustedSender
        }
        clients[index].level = level
        clients[index].verifiedAt = now
        try store.save(clients)
    }

    public func forget(clientId: String) throws {
        try store.save(try store.load().filter { $0.clientId != clientId })
    }

    /// Key id → X9.63 public key, the form `ReloE2EE.open` takes.
    public func trustedSenders() throws -> [String: Data] {
        var senders: [String: Data] = [:]
        for client in try store.load() where client.isTrusted {
            if let key = try? ReloE2EE.data(base64URL: client.publicKey, length: 65, field: "client_key"),
               ReloE2EE.keyID(publicKeyX963: key) == client.keyId {
                senders[client.keyId] = key
            }
        }
        return senders
    }
}

/// Reads the account's CLI identity keys (`GET /api/clients/keys`).
public protocol ClientKeyDirectory: Sendable {
    func clientKeys(credential: DeviceCredential) async throws -> [ReloClientKey]
}
