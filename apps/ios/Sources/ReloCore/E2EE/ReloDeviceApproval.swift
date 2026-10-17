import Foundation

/// Approving a new phone from this trusted one (docs/ENCRYPTION-PROTOCOL.md, "New devices are
/// approved on a trusted phone"). A phone that signs in after the first is pending: computers seal
/// nothing to it until a phone they trust signs its identity key here.
public enum ReloDeviceApproval {
    /// The bytes the phone's identity key signs.
    public static func signingInput(deviceID: String, identityKey: String, phoneDeviceID: String, signedAt: String) -> Data {
        Data(["\(ReloE2EE.version) approve-device", deviceID, identityKey, phoneDeviceID, signedAt].joined(separator: "\n").utf8)
    }

    /// The signed body for `POST /api/devices/self/approvals`.
    public static func request(
        for device: ReloPendingDevice, phoneDeviceID: String, signer: any ReloIdentitySigning, now: Date = Date()
    ) throws -> ReloDeviceApprovalRequest {
        let signedAt = ReloKeyRing.timestamp(now)
        let signature = try signer.sign(signingInput(
            deviceID: device.deviceId, identityKey: device.identityKey, phoneDeviceID: phoneDeviceID, signedAt: signedAt))
        return ReloDeviceApprovalRequest(deviceId: device.deviceId, identityKey: device.identityKey, signedAt: signedAt,
                                         signature: ReloE2EE.base64URL(signature))
    }

    /// `^dev_[0-9a-f-]{36}$`, safe to put in a request path.
    public static func isDeviceID(_ value: String) -> Bool {
        guard value.hasPrefix("dev_") else { return false }
        let rest = value.dropFirst(4)
        return rest.count == 36 && rest.allSatisfy { $0 == "-" || ("0"..."9").contains($0) || ("a"..."f").contains($0) }
    }
}

/// A phone of this account waiting for approval (`GET /api/devices/self/pending-devices`).
public struct ReloPendingDevice: Codable, Equatable, Sendable, Identifiable {
    public let deviceId: String
    public let name: String
    public let model: String?
    public let registeredAt: String
    public let keyId: String
    /// Identity public key, base64url X9.63, exactly as the server lists it (it is what gets signed).
    public let identityKey: String
    /// Optional: servers that know it say whether the device is a simulator.
    public let isSimulator: Bool?

    public var id: String { deviceId }
    /// "iPhone Air · Simulator", or nil.
    public var modelLine: String? { ReloDeviceModelName.displayModel(model, isSimulator: isSimulator) }
    public var registeredDate: Date? { ReloKeyRing.date(registeredAt) ?? ISO8601DateFormatter().date(from: registeredAt) }

    public init(deviceId: String, name: String, model: String? = nil, registeredAt: String, keyId: String, identityKey: String,
                isSimulator: Bool? = nil) {
        self.isSimulator = isSimulator
        self.deviceId = deviceId
        self.name = name
        self.model = model
        self.registeredAt = registeredAt
        self.keyId = keyId
        self.identityKey = identityKey
    }

    /// The name to show: the device's name (the marketing name when it is just "iPhone"), else its
    /// model, else "A new device".
    public var displayName: String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let friendlyModel = ReloDeviceModelName.displayModel(model).map { $0.replacingOccurrences(of: " · Simulator", with: "") }
        if ["iphone", "ipad"].contains(trimmed.lowercased()), let friendlyModel, friendlyModel != "Simulator" { return friendlyModel }
        if !trimmed.isEmpty { return trimmed }
        return friendlyModel.flatMap { $0 == "Simulator" ? nil : $0 } ?? "A new device"
    }

    /// A short key id for display: "k_AbCdEfGh…".
    public var shortKeyID: String {
        keyId.count > 12 ? String(keyId.prefix(10)) + "…" : keyId
    }
}

public struct ReloDeviceApprovalRequest: Codable, Equatable, Sendable {
    public let deviceId: String
    public let identityKey: String
    public let signedAt: String
    /// Raw r||s, base64url.
    public let signature: String
}

public enum DeviceApprovalError: Error, Equatable, Sendable, LocalizedError {
    /// 404: the device is gone (signed out, or declined elsewhere).
    case unknownDevice
    /// 409: the device's identity key changed since the list was loaded.
    case identityMismatch

    public var errorDescription: String? {
        switch self {
        case .unknownDevice:
            "This device is no longer waiting for access. It may have signed out."
        case .identityMismatch:
            "This device's keys changed since the list loaded. Pull to refresh and try again."
        }
    }
}

/// Device-authenticated approval endpoints.
public protocol DeviceApproving: Sendable {
    func pendingDevices(credential: DeviceCredential) async throws -> [ReloPendingDevice]
    func approveDevice(credential: DeviceCredential, request: ReloDeviceApprovalRequest) async throws
    func declineDevice(credential: DeviceCredential, deviceID: String) async throws
}
