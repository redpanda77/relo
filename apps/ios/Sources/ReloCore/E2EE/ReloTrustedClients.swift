import Foundation

/// Computers (CLI identity keys) this phone accepts sealed content from (docs/END-TO-END-ENCRYPTION.md).
/// Like WhatsApp and Signal, a computer is trusted the first time the phone sees its key ("auto"); a
/// changed key is trusted again with a visible "security code changed" notice. Comparing the security
/// code is an optional upgrade to "verified".
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
        public var previousKeyId: String
    }

    public var clientId: String
    public var name: String
    public var keyId: String
    public var publicKey: String
    public var verifiedAt: Date
    /// "auto" (trusted on first use) or "verified" (security code compared); absent means verified.
    public var level: String?
    public var notice: Notice?

    public var isVerified: Bool { level != "auto" }
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
    /// Not seen yet: trusted automatically the next time keys are refreshed.
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
        return pinned.isVerified ? .verified : .auto
    }

    public func notice(for client: ReloClientKey) throws -> ReloTrustedClient.Notice? {
        try store.load().first(where: { $0.clientId == client.clientId && $0.publicKey == client.publicKey })?.notice
    }

    /// Trust on first use: pins every computer not seen yet, and re-pins a changed key with a notice.
    @discardableResult
    public func autoTrust(_ clients: [ReloClientKey], now: Date = Date()) throws -> Bool {
        var pinned = try store.load()
        var changed = false
        for client in clients {
            guard let key = try? ReloE2EE.data(base64URL: client.publicKey, length: 65, field: "client_key"),
                  ReloE2EE.keyID(publicKeyX963: key) == client.keyId else { continue }
            let existing = pinned.firstIndex { $0.clientId == client.clientId }
            if let existing, pinned[existing].publicKey == client.publicKey { continue }
            let previous = existing.map { pinned[$0] }
            let entry = ReloTrustedClient(
                clientId: client.clientId, name: client.name, keyId: client.keyId, publicKey: client.publicKey,
                verifiedAt: now, level: "auto",
                notice: previous.map { .init(at: now, previousKeyId: $0.keyId) }
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

    public func forget(clientId: String) throws {
        try store.save(try store.load().filter { $0.clientId != clientId })
    }

    /// Key id → X9.63 public key, the form `ReloE2EE.open` takes.
    public func trustedSenders() throws -> [String: Data] {
        var senders: [String: Data] = [:]
        for client in try store.load() {
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
