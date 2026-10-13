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

    /// Prekeys only receive content, and the Lock Screen widget and the Notification Service
    /// Extension must open it: a CryptoKit Secure Enclave key is bound to the process that created it
    /// (the app), so those extensions could never use it and Live Activities stayed on placeholders.
    /// Like Signal's and WhatsApp's message keys, prekeys are kept in the shared Keychain item instead:
    /// readable only by Relo and its extensions, after the first unlock, never leaving this device
    /// (AfterFirstUnlockThisDeviceOnly), rotated every 10 hours and deleted after retention. The
    /// identity key, which signs answers and approvals in the app, stays in the Secure Enclave.
    public func makePrekey() throws -> ReloStoredKey {
        try ReloSoftwareKeyFactory().makePrekey()
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
