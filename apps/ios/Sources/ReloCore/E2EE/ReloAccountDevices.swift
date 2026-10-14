import Foundation

/// One phone signed in to this account, as `GET /api/devices/self/devices` lists it for the Devices screen.
public struct ReloAccountPhone: Codable, Equatable, Sendable, Identifiable {
    public let deviceId: String
    public let name: String
    public let model: String?
    public let isSimulator: Bool?
    public let registeredAt: String
    public let lastSeenAt: String?
    /// The phone making the request.
    public let isCurrent: Bool
    /// Computers send it encrypted cards: the account's first phone, or approved by a trusted phone.
    public let trusted: Bool

    public var id: String { deviceId }
    public var lastSeenDate: Date? { lastSeenAt.flatMap(Self.date) }
    public var registeredDate: Date? { Self.date(registeredAt) }
    /// "iPhone Air · Simulator", or nil.
    public var modelLine: String? { ReloDeviceModelName.displayModel(model, isSimulator: isSimulator) }

    public init(deviceId: String, name: String, model: String? = nil, isSimulator: Bool? = nil, registeredAt: String,
                lastSeenAt: String? = nil, isCurrent: Bool, trusted: Bool) {
        self.deviceId = deviceId
        self.name = name
        self.model = model
        self.isSimulator = isSimulator
        self.registeredAt = registeredAt
        self.lastSeenAt = lastSeenAt
        self.isCurrent = isCurrent
        self.trusted = trusted
    }

    static func date(_ value: String) -> Date? { ReloKeyRing.date(value) ?? ISO8601DateFormatter().date(from: value) }
}

/// The account's phones, for the Devices screen. Returns nil when the server is older than the route.
public protocol AccountDeviceListing: Sendable {
    func accountPhones(credential: DeviceCredential) async throws -> [ReloAccountPhone]?
}

/// The one line the Devices screen says about this iPhone.
public enum ReloThisPhoneStatus: Equatable, Sendable {
    case signedOut
    case keysProblem(String)
    case settingUp
    case waitingForApproval
    case ready(trustedComputers: Int)

    /// - Parameters:
    ///   - selfTrusted: what the server says about this phone; nil when it cannot say (older server).
    public static func make(signedIn: Bool, keysProblem: String?, keysReady: Bool, selfTrusted: Bool?,
                            trustedComputers: Int) -> ReloThisPhoneStatus {
        guard signedIn else { return .signedOut }
        if let keysProblem { return .keysProblem(keysProblem) }
        guard keysReady else { return .settingUp }
        if selfTrusted == false { return .waitingForApproval }
        return .ready(trustedComputers: trustedComputers)
    }

    public var line: String {
        switch self {
        case .signedOut: "Sign in to get encrypted cards on this iPhone."
        case .keysProblem(let reason): reason
        case .settingUp: "Setting up encryption on this iPhone…"
        case .waitingForApproval: "Waiting for approval. Approve this iPhone on your other iPhone."
        case .ready(let computers) where computers == 0: "Encrypted cards will come here once a computer signs in."
        case .ready: "Your computers can send encrypted cards to this iPhone."
        }
    }

    public var isGood: Bool { if case .ready = self { true } else { false } }
}

/// The "New device wants access" / "New computer wants access" notification's buttons. The server
/// sends `aps.category` = `categoryIdentifier` and `relo.deepLink` = `relo://security/request/<id>`.
public enum ReloAccessRequestNotification {
    public static let categoryIdentifier = "RELO_DEVICE_ACCESS"
    /// Approves without opening Relo; iOS asks for Face ID or the passcode first.
    public static let approveAction = "RELO_ACCESS_APPROVE"
    /// Opens the request sheet.
    public static let reviewAction = "RELO_ACCESS_REVIEW"
}
