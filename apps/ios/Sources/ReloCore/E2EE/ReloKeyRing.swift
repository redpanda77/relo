import CryptoKit
import Foundation

/// The phone's end-to-end encryption keys (docs/END-TO-END-ENCRYPTION.md, E2.1).
///
/// One identity key signs prekeys and answers; prekeys receive sealed content. A new prekey replaces
/// the current one every `rotationInterval`; a replaced prekey keeps opening late envelopes until
/// `retention + grace` has passed, then its private half is deleted for good. On a device both are
/// Secure Enclave keys whose stored form is an opaque blob only this Secure Enclave can use.
public struct ReloKeyRingPolicy: Equatable, Sendable {
    public var rotationInterval: TimeInterval
    public var retention: TimeInterval
    public var grace: TimeInterval

    public init(rotationInterval: TimeInterval = 10 * 3600, retention: TimeInterval = 10 * 3600, grace: TimeInterval = 2 * 3600) {
        self.rotationInterval = rotationInterval
        self.retention = retention
        self.grace = grace
    }
}

/// A stored private key: Secure Enclave `dataRepresentation` or a software raw scalar.
public struct ReloStoredKey: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable { case secureEnclave, software }
    public var kind: Kind
    public var data: Data
    public var publicKey: Data
    /// True when the key opens envelopes while the iPhone is locked (after its first unlock since
    /// boot), so notifications and the Lock Screen show real text. Absent on keys made before this.
    public var usableWhileLocked: Bool? = nil

    public init(kind: Kind, data: Data, publicKey: Data, usableWhileLocked: Bool? = nil) {
        self.kind = kind
        self.data = data
        self.publicKey = publicKey
        self.usableWhileLocked = usableWhileLocked
    }
}

public struct ReloStoredPrekey: Codable, Equatable, Sendable {
    public var id: String
    public var createdAt: String
    public var retiredAt: Date?
    public var key: ReloStoredKey
}

public struct ReloKeyRingState: Codable, Equatable, Sendable {
    public var identity: ReloStoredKey
    /// Newest first; the first entry without `retiredAt` is current.
    public var prekeys: [ReloStoredPrekey]
}

public protocol ReloKeyRingStore: Sendable {
    func load() throws -> ReloKeyRingState?
    func save(_ state: ReloKeyRingState) throws
    func delete() throws
}

/// Creates and restores keys. `ReloSecureEnclaveKeyFactory` on devices, software in the simulator and tests.
public protocol ReloKeyFactory: Sendable {
    func makeIdentity() throws -> ReloStoredKey
    func makePrekey() throws -> ReloStoredKey
    func signer(for identity: ReloStoredKey) throws -> any ReloIdentitySigning
    func opener(for prekey: ReloStoredKey) throws -> any ReloPrekeyOpening
}

/// What the phone publishes: its identity key and the current prekey, signed for this device id.
public struct ReloPublishedDeviceKeys: Codable, Equatable, Sendable {
    public struct Prekey: Codable, Equatable, Sendable {
        public var prekeyId: String
        public var publicKey: String
        public var createdAt: String
        public var signature: String
    }

    public var identityKey: String
    public var prekey: Prekey
}

public struct ReloKeyRing: Sendable {
    public let store: any ReloKeyRingStore
    public let factory: any ReloKeyFactory
    public let policy: ReloKeyRingPolicy

    public init(store: any ReloKeyRingStore, factory: any ReloKeyFactory, policy: ReloKeyRingPolicy = .init()) {
        self.store = store
        self.factory = factory
        self.policy = policy
    }

    /// Creates the identity on first use, rotates the prekey when due and deletes expired private
    /// prekeys. Returns the state after saving it.
    @discardableResult
    public func maintain(now: Date = Date()) throws -> ReloKeyRingState {
        let original = try store.load()
        var state = try original ?? ReloKeyRingState(identity: factory.makeIdentity(), prekeys: [])
        let current = state.prekeys.first { $0.retiredAt == nil }
        // A prekey that only works while unlocked is replaced at once (the Lock Screen needs it).
        let due = current.map {
            (Self.date($0.createdAt) ?? .distantPast).addingTimeInterval(policy.rotationInterval) <= now
                || $0.key.usableWhileLocked != true
        } ?? true
        if due {
            state.prekeys = state.prekeys.map { prekey in
                var retired = prekey
                if retired.retiredAt == nil { retired.retiredAt = now }
                return retired
            }
            let fresh = ReloStoredPrekey(id: Self.newPrekeyID(), createdAt: Self.timestamp(now), retiredAt: nil, key: try factory.makePrekey())
            state.prekeys.insert(fresh, at: 0)
        }
        let deleteAfter = policy.retention + policy.grace
        state.prekeys.removeAll { prekey in
            guard let retiredAt = prekey.retiredAt else { return false }
            return retiredAt.addingTimeInterval(deleteAfter) <= now
        }
        if state != original { try store.save(state) }
        return state
    }

    /// The signed publication for `deviceID` (the server's public `dev_…` id).
    public func publication(deviceID: String, state: ReloKeyRingState) throws -> ReloPublishedDeviceKeys {
        guard let current = state.prekeys.first(where: { $0.retiredAt == nil }) else { throw ReloE2EEError.prekeyUnavailable }
        let signer = try factory.signer(for: state.identity)
        let input = ReloE2EE.prekeySigningInput(
            deviceID: deviceID, prekeyID: current.id, publicKeyX963: current.key.publicKey, createdAt: current.createdAt
        )
        return ReloPublishedDeviceKeys(
            identityKey: ReloE2EE.base64URL(state.identity.publicKey),
            prekey: .init(prekeyId: current.id, publicKey: ReloE2EE.base64URL(current.key.publicKey),
                          createdAt: current.createdAt, signature: ReloE2EE.base64URL(try signer.sign(input)))
        )
    }

    /// Opens envelopes for this device with whichever stored prekey they name; deleted prekeys cannot.
    public func prekeyOpener(state: ReloKeyRingState) -> (String) -> (any ReloPrekeyOpening)? {
        let factory = self.factory
        let prekeys = state.prekeys
        return { id in
            guard let stored = prekeys.first(where: { $0.id == id }) else { return nil }
            return try? factory.opener(for: stored.key)
        }
    }

    public func identitySigner(state: ReloKeyRingState) throws -> any ReloIdentitySigning {
        try factory.signer(for: state.identity)
    }

    static func newPrekeyID() -> String {
        var bytes = SystemRandomNumberGenerator()
        let random = Data((0..<12).map { _ in UInt8.random(in: .min ... .max, using: &bytes) })
        return "pk_" + ReloE2EE.base64URL(random)
    }

    static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter.string(from: date)
    }

    static func date(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value)
    }
}

// MARK: Key factories

public struct ReloSoftwareKeyFactory: ReloKeyFactory {
    public init() {}

    public func makeIdentity() throws -> ReloStoredKey {
        let key = P256.Signing.PrivateKey()
        return ReloStoredKey(kind: .software, data: key.rawRepresentation, publicKey: key.publicKey.x963Representation)
    }

    public func makePrekey() throws -> ReloStoredKey {
        let key = P256.KeyAgreement.PrivateKey()
        return ReloStoredKey(kind: .software, data: key.rawRepresentation, publicKey: key.publicKey.x963Representation,
                             usableWhileLocked: true)
    }

    public func signer(for identity: ReloStoredKey) throws -> any ReloIdentitySigning {
        guard identity.kind == .software else { throw ReloE2EEError.prekeyUnavailable }
        return ReloSoftwareIdentity(privateKey: try P256.Signing.PrivateKey(rawRepresentation: identity.data))
    }

    public func opener(for prekey: ReloStoredKey) throws -> any ReloPrekeyOpening {
        guard prekey.kind == .software else { throw ReloE2EEError.prekeyUnavailable }
        return ReloSoftwarePrekey(privateKey: try P256.KeyAgreement.PrivateKey(rawRepresentation: prekey.data))
    }
}

/// Publishes the phone's keys to the server's key directory (`PUT /api/devices/self/keys`).
public protocol DeviceKeyPublishing: Sendable {
    func publishDeviceKeys(credential: DeviceCredential, keys: ReloPublishedDeviceKeys) async throws
}
