import CryptoKit
import Foundation

/// relo.e2e.v1: the on-device half of end-to-end encrypted content
/// (docs/END-TO-END-ENCRYPTION.md). HPKE is CryptoKit's RFC 9180 implementation with
/// DHKEM(P-256, HKDF-SHA256), HKDF-SHA256 and AES-256-GCM; the CLI's node:crypto implementation
/// is pinned to it by the shared vectors in `e2ee-v1.json`.
public enum ReloE2EE {
    public static let version = "relo.e2e.v1"
    public static let kinds: Set<String> = ["notice", "question", "card", "card-update", "reply", "grouping-key", "names"]
    public static let ciphersuite = HPKE.Ciphersuite.P256_SHA256_AES_GCM_256
    static let wrapInfo = Data("relo.e2e.v1 content-key".utf8)
    static let padBlock = 256
    static let maximumPlaintext = 64 * 1024
}

public enum ReloE2EEError: Error, Equatable, Sendable {
    case invalidEnvelope(String)
    case unexpectedKind
    case unexpectedContext
    case untrustedSender
    case invalidSignature
    case notARecipient
    case prekeyUnavailable
    case decryptionFailed
    case invalidPadding
    case plaintextTooLarge
}

/// Wire form of a sealed envelope. Field names match the CLI and the server's opaque storage.
public struct ReloEnvelope: Codable, Hashable, Sendable {
    public struct Recipient: Codable, Hashable, Sendable {
        public var device: String
        public var prekey: String
        public var enc: String
        public var key: String

        public init(device: String, prekey: String, enc: String, key: String) {
            self.device = device
            self.prekey = prekey
            self.enc = enc
            self.key = key
        }
    }

    public var v: String
    public var kind: String
    public var context: String
    public var sender: String
    public var recipients: [Recipient]
    public var nonce: String
    public var ct: String
    public var sig: String
}

/// A receiving prekey. Software keys serve tests and the simulator; Secure Enclave keys conform too.
public protocol ReloPrekeyOpening: Sendable {
    func openContentKey(encapsulatedKey: Data, ciphertext: Data, info: Data, aad: Data) throws -> Data
}

public struct ReloSoftwarePrekey: ReloPrekeyOpening {
    public let privateKey: P256.KeyAgreement.PrivateKey

    public init(privateKey: P256.KeyAgreement.PrivateKey) {
        self.privateKey = privateKey
    }

    public func openContentKey(encapsulatedKey: Data, ciphertext: Data, info: Data, aad: Data) throws -> Data {
        var recipient = try HPKE.Recipient(
            privateKey: privateKey, ciphersuite: ReloE2EE.ciphersuite, info: info, encapsulatedKey: encapsulatedKey
        )
        return try recipient.open(ciphertext, authenticating: aad)
    }
}

/// An identity key that signs answers and prekeys. Secure Enclave keys conform in the app.
public protocol ReloIdentitySigning: Sendable {
    var publicKeyX963: Data { get }
    func sign(_ message: Data) throws -> Data
}

public struct ReloSoftwareIdentity: ReloIdentitySigning {
    public let privateKey: P256.Signing.PrivateKey

    public init(privateKey: P256.Signing.PrivateKey) {
        self.privateKey = privateKey
    }

    public var publicKeyX963: Data { privateKey.publicKey.x963Representation }

    public func sign(_ message: Data) throws -> Data {
        try privateKey.signature(for: message).rawRepresentation
    }
}

public extension ReloE2EE {
    // MARK: Encoding

    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func data(base64URL value: String, length: Int? = nil, field: String) throws -> Data {
        guard value.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else {
            throw ReloE2EEError.invalidEnvelope(field)
        }
        var base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        guard let decoded = Data(base64Encoded: base64), base64URL(decoded) == value else {
            throw ReloE2EEError.invalidEnvelope(field)
        }
        if let length, decoded.count != length { throw ReloE2EEError.invalidEnvelope(field) }
        return decoded
    }

    /// "k_" + first 16 bytes of SHA-256 over the X9.63 public key, base64url.
    static func keyID(publicKeyX963: Data) -> String {
        "k_" + base64URL(Data(SHA256.hash(data: publicKeyX963).prefix(16)))
    }

    // MARK: Signatures

    static func verify(signature: Data, message: Data, publicKeyX963: Data) -> Bool {
        guard signature.count == 64,
              let key = try? P256.Signing.PublicKey(x963Representation: publicKeyX963),
              let parsed = try? P256.Signing.ECDSASignature(rawRepresentation: signature) else { return false }
        return key.isValidSignature(parsed, for: message)
    }

    static func prekeySigningInput(deviceID: String, prekeyID: String, publicKeyX963: Data, createdAt: String) -> Data {
        Data([("\(version) prekey"), deviceID, prekeyID, base64URL(publicKeyX963), createdAt].joined(separator: "\n").utf8)
    }

    static func answerSigningInput(
        interactionID: String, notificationID: String, deviceID: String, value: String, respondedAt: String
    ) -> Data {
        Data(["\(version) answer", interactionID, notificationID, deviceID, value, respondedAt].joined(separator: "\n").utf8)
    }

    /// An answer to a sealed question also signs the context of the question envelope the phone
    /// opened: a value only the asking CLI chose, so the server cannot move the approval elsewhere.
    static func questionAnswerSigningInput(
        interactionID: String, notificationID: String, deviceID: String, value: String, respondedAt: String, question: String
    ) -> Data {
        Data(["\(version) answer-to", interactionID, notificationID, deviceID, value, respondedAt, question].joined(separator: "\n").utf8)
    }

    static func signingInput(_ envelope: ReloEnvelope) -> Data {
        let recipients = envelope.recipients
            .sorted { lhs, rhs in
                if lhs.device != rhs.device { return Array(lhs.device.utf8).lexicographicallyPrecedes(Array(rhs.device.utf8)) }
                return Array(lhs.prekey.utf8).lexicographicallyPrecedes(Array(rhs.prekey.utf8))
            }
            .map { [$0.device, $0.prekey, $0.enc, $0.key].joined(separator: " ") }
        let lines = ["\(version) envelope", envelope.kind, envelope.context, envelope.sender, envelope.nonce, envelope.ct]
        return Data((lines + recipients).joined(separator: "\n").utf8)
    }

    // MARK: Envelope

    static func validateShape(_ envelope: ReloEnvelope) throws {
        guard envelope.v == version else { throw ReloE2EEError.invalidEnvelope("version") }
        guard kinds.contains(envelope.kind) else { throw ReloE2EEError.invalidEnvelope("kind") }
        try assertBinding(envelope.context, field: "context")
        guard envelope.sender.hasPrefix("k_"), envelope.sender.count == 24,
              (try? data(base64URL: String(envelope.sender.dropFirst(2)), length: 16, field: "sender")) != nil else {
            throw ReloE2EEError.invalidEnvelope("sender")
        }
        _ = try data(base64URL: envelope.nonce, length: 12, field: "nonce")
        let ciphertext = try data(base64URL: envelope.ct, field: "ciphertext")
        guard ciphertext.count >= padBlock + 16, (ciphertext.count - 16) % padBlock == 0 else {
            throw ReloE2EEError.invalidEnvelope("ciphertext")
        }
        _ = try data(base64URL: envelope.sig, length: 64, field: "signature")
        guard (1...16).contains(envelope.recipients.count) else { throw ReloE2EEError.invalidEnvelope("recipients") }
        for recipient in envelope.recipients {
            try assertBinding(recipient.device, field: "device")
            try assertBinding(recipient.prekey, field: "prekey")
            _ = try data(base64URL: recipient.enc, length: 65, field: "enc")
            _ = try data(base64URL: recipient.key, length: 48, field: "wrapped_key")
        }
    }

    /// Verifies the sender against `trustedSenders` (key id → X9.63 public key), then opens the entry
    /// for `deviceID`. Returns the sealed JSON bytes.
    static func open(
        _ envelope: ReloEnvelope,
        deviceID: String,
        prekey: (String) -> (any ReloPrekeyOpening)?,
        trustedSenders: [String: Data],
        expectedKind: String? = nil,
        expectedContext: String? = nil
    ) throws -> Data {
        try validateShape(envelope)
        if let expectedKind, envelope.kind != expectedKind { throw ReloE2EEError.unexpectedKind }
        if let expectedContext, envelope.context != expectedContext { throw ReloE2EEError.unexpectedContext }
        guard let senderKey = trustedSenders[envelope.sender], keyID(publicKeyX963: senderKey) == envelope.sender else {
            throw ReloE2EEError.untrustedSender
        }
        let signature = try data(base64URL: envelope.sig, length: 64, field: "signature")
        guard verify(signature: signature, message: signingInput(envelope), publicKeyX963: senderKey) else {
            throw ReloE2EEError.invalidSignature
        }
        guard let entry = envelope.recipients.first(where: { $0.device == deviceID }) else {
            throw ReloE2EEError.notARecipient
        }
        guard let opener = prekey(entry.prekey) else { throw ReloE2EEError.prekeyUnavailable }
        let contentKey: Data
        do {
            contentKey = try opener.openContentKey(
                encapsulatedKey: try data(base64URL: entry.enc, length: 65, field: "enc"),
                ciphertext: try data(base64URL: entry.key, length: 48, field: "wrapped_key"),
                info: wrapInfo,
                aad: wrapAAD(envelope, device: entry.device, prekey: entry.prekey)
            )
        } catch let error as ReloE2EEError {
            throw error
        } catch {
            throw ReloE2EEError.decryptionFailed
        }
        let sealed = try data(base64URL: envelope.ct, field: "ciphertext")
        let padded: Data
        do {
            let box = try AES.GCM.SealedBox(
                nonce: AES.GCM.Nonce(data: try data(base64URL: envelope.nonce, length: 12, field: "nonce")),
                ciphertext: sealed.prefix(sealed.count - 16),
                tag: sealed.suffix(16)
            )
            padded = try AES.GCM.open(box, using: SymmetricKey(data: contentKey), authenticating: bodyAAD(envelope))
        } catch {
            throw ReloE2EEError.decryptionFailed
        }
        return try unpad(padded)
    }

    /// Seals `content` (JSON bytes) for each recipient prekey and signs with `sender`.
    static func seal(
        kind: String,
        context: String,
        sender: any ReloIdentitySigning,
        recipients: [(deviceID: String, prekeyID: String, publicKeyX963: Data)],
        content: Data
    ) throws -> ReloEnvelope {
        guard kinds.contains(kind) else { throw ReloE2EEError.invalidEnvelope("kind") }
        guard (1...16).contains(recipients.count) else { throw ReloE2EEError.invalidEnvelope("recipients") }
        try assertBinding(context, field: "context")
        var envelope = ReloEnvelope(
            v: version, kind: kind, context: context, sender: keyID(publicKeyX963: sender.publicKeyX963),
            recipients: [], nonce: "", ct: "", sig: ""
        )
        let contentKey = SymmetricKey(size: .bits256)
        let nonce = AES.GCM.Nonce()
        envelope.nonce = base64URL(Data(nonce))
        let box = try AES.GCM.seal(try pad(content), using: contentKey, nonce: nonce, authenticating: bodyAAD(envelope))
        envelope.ct = base64URL(box.ciphertext + box.tag)
        let keyBytes = contentKey.withUnsafeBytes { Data($0) }
        for recipient in recipients {
            try assertBinding(recipient.deviceID, field: "device")
            try assertBinding(recipient.prekeyID, field: "prekey")
            var hpke = try HPKE.Sender(
                recipientKey: P256.KeyAgreement.PublicKey(x963Representation: recipient.publicKeyX963),
                ciphersuite: ciphersuite, info: wrapInfo
            )
            let wrapped = try hpke.seal(keyBytes, authenticating: wrapAAD(envelope, device: recipient.deviceID, prekey: recipient.prekeyID))
            envelope.recipients.append(.init(
                device: recipient.deviceID, prekey: recipient.prekeyID,
                enc: base64URL(hpke.encapsulatedKey), key: base64URL(wrapped)
            ))
        }
        envelope.sig = base64URL(try sender.sign(signingInput(envelope)))
        return envelope
    }

    // MARK: Safety number

    /// 60 digits both sides display; equal only when both hold the same pair of identity keys.
    static func safetyNumber(_ keyA: Data, _ keyB: Data) -> String {
        let a = fingerprintGroups(keyA)
        let b = fingerprintGroups(keyB)
        let aFirst = !Array(keyB).lexicographicallyPrecedes(Array(keyA))
        return (aFirst ? a + b : b + a).joined(separator: " ")
    }
}

extension ReloE2EE {
    static func assertBinding(_ value: String, field: String) throws {
        guard (1...200).contains(value.utf8.count), value.utf8.allSatisfy({ (0x21...0x7e).contains($0) }) else {
            throw ReloE2EEError.invalidEnvelope(field)
        }
    }

    static func bodyAAD(_ envelope: ReloEnvelope) -> Data {
        Data([version, envelope.kind, envelope.context, envelope.sender].joined(separator: "\n").utf8)
    }

    static func wrapAAD(_ envelope: ReloEnvelope, device: String, prekey: String) -> Data {
        bodyAAD(envelope) + Data("\n\(device)\n\(prekey)".utf8)
    }

    static func pad(_ plaintext: Data) throws -> Data {
        guard plaintext.count <= maximumPlaintext else { throw ReloE2EEError.plaintextTooLarge }
        var framed = Data()
        withUnsafeBytes(of: UInt32(plaintext.count).bigEndian) { framed.append(contentsOf: $0) }
        framed.append(plaintext)
        let size = (framed.count + padBlock - 1) / padBlock * padBlock
        framed.append(Data(count: size - framed.count))
        return framed
    }

    static func unpad(_ padded: Data) throws -> Data {
        let bytes = Array(padded)
        guard bytes.count >= 4, bytes.count % padBlock == 0 else { throw ReloE2EEError.invalidPadding }
        let length = Int(bytes[0]) << 24 | Int(bytes[1]) << 16 | Int(bytes[2]) << 8 | Int(bytes[3])
        guard length <= bytes.count - 4, length <= maximumPlaintext,
              bytes[(4 + length)...].allSatisfy({ $0 == 0 }) else { throw ReloE2EEError.invalidPadding }
        return Data(bytes[4..<(4 + length)])
    }

    static func fingerprintGroups(_ publicKey: Data) -> [String] {
        var hash = Data([0, 0]) + publicKey
        for _ in 0..<5200 {
            var hasher = SHA512()
            hasher.update(data: hash)
            hasher.update(data: publicKey)
            hash = Data(hasher.finalize())
        }
        let bytes = Array(hash)
        return stride(from: 0, to: 30, by: 5).map { offset in
            let value = bytes[offset..<(offset + 5)].reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
            let digits = String(value % 100_000)
            return String(repeating: "0", count: 5 - digits.count) + digits
        }
    }
}
