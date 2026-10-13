import CryptoKit
import Foundation
import ReloCore
import Security

/// Keys created inside the Secure Enclave: the private scalar never leaves it, and the stored blob
/// is useless on any other device.
public struct ReloSecureEnclaveKeyFactory: ReloKeyFactory {
    public init() {}

    public static var isAvailable: Bool { SecureEnclave.isAvailable }

    public func makeIdentity() throws -> ReloStoredKey {
        let key = try SecureEnclave.P256.Signing.PrivateKey()
        return ReloStoredKey(kind: .secureEnclave, data: key.dataRepresentation, publicKey: key.publicKey.x963Representation)
    }

    /// CryptoKit's default makes a key usable only while the iPhone is unlocked, which left the Lock
    /// Screen and notifications on placeholders. Prekeys only receive content, so like WhatsApp's and
    /// Signal's message keys they work after the first unlock since boot; they never leave this device.
    public func makePrekey() throws -> ReloStoredKey {
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(
            nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, .privateKeyUsage, &error
        ) else { throw error!.takeRetainedValue() as Error }
        let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: access)
        return ReloStoredKey(kind: .secureEnclave, data: key.dataRepresentation, publicKey: key.publicKey.x963Representation,
                             usableWhileLocked: true)
    }

    public func signer(for identity: ReloStoredKey) throws -> any ReloIdentitySigning {
        guard identity.kind == .secureEnclave else { return try ReloSoftwareKeyFactory().signer(for: identity) }
        return SecureEnclaveIdentity(key: try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: identity.data))
    }

    public func opener(for prekey: ReloStoredKey) throws -> any ReloPrekeyOpening {
        guard prekey.kind == .secureEnclave else { return try ReloSoftwareKeyFactory().opener(for: prekey) }
        return SecureEnclavePrekey(key: try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: prekey.data))
    }

    private struct SecureEnclaveIdentity: ReloIdentitySigning {
        let key: SecureEnclave.P256.Signing.PrivateKey
        var publicKeyX963: Data { key.publicKey.x963Representation }
        func sign(_ message: Data) throws -> Data { try key.signature(for: message).rawRepresentation }
    }

    private struct SecureEnclavePrekey: ReloPrekeyOpening {
        let key: SecureEnclave.P256.KeyAgreement.PrivateKey
        func openContentKey(encapsulatedKey: Data, ciphertext: Data, info: Data, aad: Data) throws -> Data {
            var recipient = try HPKE.Recipient(
                privateKey: key, ciphersuite: ReloE2EE.ciphersuite, info: info, encapsulatedKey: encapsulatedKey
            )
            return try recipient.open(ciphertext, authenticating: aad)
        }
    }
}
