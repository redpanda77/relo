import Foundation

/// Computers (CLI identity keys) the owner verified on this phone (docs/END-TO-END-ENCRYPTION.md, E2.4).
/// The phone opens sealed content only from these keys, so a server that signs with its own key is
/// refused. Verification pins the exact public key: a computer whose key changes must be verified again.
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
    public var clientId: String
    public var name: String
    public var keyId: String
    public var publicKey: String
    public var verifiedAt: Date
}

public protocol ReloTrustedClientStore: Sendable {
    func load() throws -> [ReloTrustedClient]
    func save(_ clients: [ReloTrustedClient]) throws
}

public enum ReloClientTrust: String, Equatable, Sendable {
    case trusted, unverified, changed
}

public struct ReloTrustedClients: Sendable {
    public let store: any ReloTrustedClientStore

    public init(store: any ReloTrustedClientStore) {
        self.store = store
    }

    public func trust(of client: ReloClientKey) throws -> ReloClientTrust {
        guard let pinned = try store.load().first(where: { $0.clientId == client.clientId }) else { return .unverified }
        return pinned.publicKey == client.publicKey ? .trusted : .changed
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
                                         publicKey: client.publicKey, verifiedAt: now))
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
