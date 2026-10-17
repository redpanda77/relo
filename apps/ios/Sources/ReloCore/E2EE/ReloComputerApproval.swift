import CryptoKit
import Foundation

/// Computers are approved once, on any trusted device (docs/ENCRYPTION-PROTOCOL.md): a phone, the Mac app or a
/// linked browser signs a computer's login id and current identity key, and every other device trusts the computer
/// after checking that signature against an approver it pinned. The server stores and lists the signatures; it
/// cannot forge one.
public enum ReloComputerApproval {
    /// The bytes the approver's identity key signs (the server's computer-approvals.ts; the Dashboard's envelope.ts).
    public static func signingInput(clientID: String, identityKey: String, approverID: String, signedAt: String) -> Data {
        Data(["\(ReloE2EE.version) approve-computer", clientID, identityKey, approverID, signedAt].joined(separator: "\n").utf8)
    }

    /// The signed body for `POST /api/devices/self/computer-approvals`.
    public static func request(
        for client: ReloClientKey, approverID: String, signer: any ReloIdentitySigning, now: Date = Date()
    ) throws -> ReloComputerApprovalRequest {
        let signedAt = ReloKeyRing.timestamp(now)
        let signature = try signer.sign(signingInput(clientID: client.clientId, identityKey: client.publicKey,
                                                     approverID: approverID, signedAt: signedAt))
        return ReloComputerApprovalRequest(clientId: client.clientId, identityKey: client.publicKey, signedAt: signedAt,
                                           signature: ReloE2EE.base64URL(signature))
    }

    /// A raw r||s P-256 signature (b64u) over `message` by `publicKey` (X9.63).
    public static func verifies(_ signature: String, message: Data, publicKey: Data) -> Bool {
        guard let raw = try? ReloE2EE.data(base64URL: signature, length: 64, field: "signature"),
              let key = try? P256.Signing.PublicKey(x963Representation: publicKey),
              let parsed = try? P256.Signing.ECDSASignature(rawRepresentation: raw) else { return false }
        return key.isValidSignature(parsed, for: message)
    }

    /// The approver (pinned on this device) whose signature covers `client`'s current key, if any.
    public static func approver(of client: ReloClientKey, pinned: [String: Data]) -> String? {
        (client.approvals ?? []).first { approval in
            guard let key = pinned[approval.approverId] else { return false }
            return verifies(approval.signature, message: signingInput(clientID: client.clientId, identityKey: client.publicKey,
                                                                       approverID: approval.approverId, signedAt: approval.signedAt),
                            publicKey: key)
        }?.approverId
    }
}

/// One approver's signature over a computer's current key, as the server lists it with the key.
public struct ReloComputerApprovalSignature: Codable, Equatable, Sendable {
    public let approverId: String
    public let signedAt: String
    /// Raw r||s, base64url.
    public let signature: String

    public init(approverId: String, signedAt: String, signature: String) {
        self.approverId = approverId
        self.signedAt = signedAt
        self.signature = signature
    }
}

public struct ReloComputerApprovalRequest: Codable, Equatable, Sendable {
    public let clientId: String
    public let identityKey: String
    public let signedAt: String
    /// Raw r||s, base64url.
    public let signature: String
}

/// A device or linked browser of the account that can approve (`GET /api/devices/self/approvers`).
public struct ReloApprover: Codable, Equatable, Sendable {
    public struct Voucher: Codable, Equatable, Sendable {
        public let approverId: String
        public let signedAt: String
        public let signature: String
        /// "approve-device" (a device approval) or "link" (a browser's link by a phone).
        public let statement: String

        public init(approverId: String, signedAt: String, signature: String, statement: String) {
            self.approverId = approverId
            self.signedAt = signedAt
            self.signature = signature
            self.statement = statement
        }
    }

    public let id: String
    /// "phone", "mac" or "browser".
    public let kind: String
    public let name: String
    /// Identity public key, base64url X9.63.
    public let identityKey: String
    /// What vouches for this key: the signature of another approver over it.
    public let vouchedBy: Voucher?

    public init(id: String, kind: String, name: String, identityKey: String, vouchedBy: Voucher?) {
        self.id = id
        self.kind = kind
        self.name = name
        self.identityKey = identityKey
        self.vouchedBy = vouchedBy
    }
}

/// An approver this device trusts: its signatures over computers count here.
public struct ReloPinnedApprover: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var identityKey: String
    public var pinnedAt: Date

    public init(id: String, name: String, identityKey: String, pinnedAt: Date) {
        self.id = id
        self.name = name
        self.identityKey = identityKey
        self.pinnedAt = pinnedAt
    }
}

public protocol ReloTrustedApproverStore: Sendable {
    func load() throws -> [ReloPinnedApprover]
    func save(_ approvers: [ReloPinnedApprover]) throws
}

/// The approvers this device trusts, pinned like computers: at first contact, itself and every approver then listed;
/// after that, a new approver (or a new key) only when an approver already pinned vouched for its current key.
public struct ReloTrustedApprovers: Sendable {
    /// A browser's link counts for this long after the phone signed it (the CLI's LINK_DAYS).
    public static let linkLifetime: TimeInterval = 14 * 86_400
    public let store: any ReloTrustedApproverStore

    public init(store: any ReloTrustedApproverStore) {
        self.store = store
    }

    /// Pins what the listing allows and returns approver id → pinned X9.63 key (this device included).
    @discardableResult
    public func update(_ listed: [ReloApprover], selfID: String, selfKey: Data, now: Date = Date()) throws -> [String: Data] {
        var pinned = try store.load()
        let before = pinned
        let key = { (approver: ReloApprover) in try? ReloE2EE.data(base64URL: approver.identityKey, length: 65, field: "identity_key") }
        if pinned.isEmpty {
            pinned = listed.compactMap { approver in
                key(approver) == nil ? nil : ReloPinnedApprover(id: approver.id, name: approver.name, identityKey: approver.identityKey, pinnedAt: now)
            }
        } else {
            var grew = true
            while grew {
                grew = false
                for approver in listed where key(approver) != nil {
                    if pinned.contains(where: { $0.id == approver.id && $0.identityKey == approver.identityKey }) { continue }
                    guard let voucher = approver.vouchedBy, voucher.approverId != approver.id,
                          let by = pinned.first(where: { $0.id == voucher.approverId }),
                          let byKey = try? ReloE2EE.data(base64URL: by.identityKey, length: 65, field: "identity_key"),
                          Self.vouches(voucher, for: approver, key: byKey, now: now) else { continue }
                    pinned.removeAll { $0.id == approver.id }
                    pinned.append(ReloPinnedApprover(id: approver.id, name: approver.name, identityKey: approver.identityKey, pinnedAt: now))
                    grew = true
                }
            }
        }
        let selfEncoded = ReloE2EE.base64URL(selfKey)
        if !pinned.contains(where: { $0.id == selfID && $0.identityKey == selfEncoded }) {
            pinned.removeAll { $0.id == selfID }
            pinned.append(ReloPinnedApprover(id: selfID, name: "This device", identityKey: selfEncoded, pinnedAt: now))
        }
        if pinned != before { try store.save(pinned) }
        return Dictionary(pinned.compactMap { approver in
            (try? ReloE2EE.data(base64URL: approver.identityKey, length: 65, field: "identity_key")).map { (approver.id, $0) }
        }, uniquingKeysWith: { _, last in last })
    }

    /// The pinned approvers' names, for "approved on <name>".
    public func names() -> [String: String] {
        Dictionary(((try? store.load()) ?? []).map { ($0.id, $0.name) }, uniquingKeysWith: { _, last in last })
    }

    static func vouches(_ voucher: ReloApprover.Voucher, for approver: ReloApprover, key: Data, now: Date) -> Bool {
        let message: Data
        switch voucher.statement {
        case "approve-device":
            message = ReloDeviceApproval.signingInput(deviceID: approver.id, identityKey: approver.identityKey,
                                                      phoneDeviceID: voucher.approverId, signedAt: voucher.signedAt)
        case "link":
            guard let signed = ReloKeyRing.date(voucher.signedAt) ?? ISO8601DateFormatter().date(from: voucher.signedAt),
                  now.timeIntervalSince(signed) < linkLifetime else { return false }
            message = ReloBrowserLink.signingInput(browserID: approver.id, identityKey: approver.identityKey,
                                                   phoneDeviceID: voucher.approverId, signedAt: voucher.signedAt)
        default:
            return false
        }
        return ReloComputerApproval.verifies(voucher.signature, message: message, publicKey: key)
    }
}

/// Approving computers, authenticated as this device.
public protocol ComputerApproving: Sendable {
    func approvers(credential: DeviceCredential) async throws -> [ReloApprover]
    func approveComputer(credential: DeviceCredential, request: ReloComputerApprovalRequest) async throws
    /// Signs a computer out of the account (its login stops working). A computer already gone counts as done.
    func revokeComputer(credential: DeviceCredential, clientID: String) async throws
}
