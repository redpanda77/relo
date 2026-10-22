import CryptoKit
import Foundation

/// A computer signing in with `relo auth login` (the device authorization grant, RFC 8628), approved on this phone.
/// The CLI shows its approval link as a QR code, `https://<server>/cli/authorize?code=ABCD-EFGH`; scanned here, the
/// phone shows what asks to sign in and approves it for this phone's own account.
public enum ReloComputerSignIn {
    /// What the server says the computer asked for.
    public struct Request: Decodable, Equatable, Sendable {
        public let clientName: String
        public let scopes: [String]
        public let status: String
        public let userCode: String
        public let expiresAt: String
        /// The computer's identity key (b64u) the CLI started the sign-in with; nil from an older CLI.
        public let identityKey: String?
        /// The computer's login id (`key_…`), once its login was issued.
        public let clientId: String?
        /// True once that login published the same key the sign-in started with.
        public let keyPublished: Bool?

        public init(clientName: String, scopes: [String], status: String, userCode: String, expiresAt: String,
                    identityKey: String? = nil, clientId: String? = nil, keyPublished: Bool? = nil) {
            self.identityKey = identityKey
            self.clientId = clientId
            self.keyPublished = keyPublished
            self.clientName = clientName
            self.scopes = scopes
            self.status = status
            self.userCode = userCode
            self.expiresAt = expiresAt
        }

        public var isPending: Bool { status == "pending" }
    }

    /// The two-digit number that ties an approval to the computer's key (docs/ENCRYPTION-PROTOCOL.md, "Sign-in number").
    public enum Number {
        public static func compute(userCode: String, identityKey: String) -> String {
            let digest = SHA256.hash(data: Data("relo.e2e.v1 signin-number\n\(userCode)\n\(identityKey)".utf8))
            let bytes = Array(digest)
            let value = (Int(bytes[0]) << 8 | Int(bytes[1])) % 100
            return value < 10 ? "0\(value)" : "\(value)"
        }

        /// The real number and two distinct decoys, shuffled.
        public static func choices<G: RandomNumberGenerator>(real: String, using generator: inout G) -> [String] {
            var options: Set<String> = [real]
            while options.count < 3 {
                options.insert(String(format: "%02d", Int.random(in: 0..<100, using: &generator)))
            }
            return options.shuffled(using: &generator)
        }

        public static func choices(real: String) -> [String] {
            var generator = SystemRandomNumberGenerator()
            return choices(real: real, using: &generator)
        }
    }

    /// The computer key the owner approved: the identity key the number came from, under the login id the server issued.
    public static func approvedKey(clientId: String, name: String, identityKey: String, now: Date = Date()) -> ReloClientKey? {
        guard let key = try? ReloE2EE.data(base64URL: identityKey, length: 65, field: "identityKey") else { return nil }
        let keyId = "k_" + ReloE2EE.base64URL(Data(SHA256.hash(data: key).prefix(16)))
        return ReloClientKey(clientId: clientId, name: name, keyId: keyId, publicKey: identityKey, changedAt: ReloKeyRing.timestamp(now))
    }

    public enum ParseError: Error, Equatable, Sendable, LocalizedError {
        case notASignInCode
        case otherServer(String)

        public var errorDescription: String? {
            switch self {
            case .notASignInCode:
                "This is not a Relo sign-in code. Run relo auth login on the computer and scan the code it shows."
            case .otherServer(let host):
                "This code is for the Relo server at \(host), not the one this iPhone uses."
            }
        }
    }

    public enum DecisionError: Error, Equatable, Sendable, LocalizedError {
        case notFound
        case alreadyDecided
        case phonePending

        public var errorDescription: String? {
            switch self {
            case .notFound: "This sign-in expired or was not found. Run relo auth login on the computer again."
            case .alreadyDecided: "This sign-in was already approved or denied."
            case .phonePending: "Approve this iPhone from one of your trusted devices first, then scan the code again."
            }
        }
    }

    /// The code's alphabet: no 0, 1, I or O, so it reads unambiguously.
    private static let alphabet = Set("23456789ABCDEFGHJKLMNPQRSTUVWXYZ")

    /// `ABCD-EFGH` from a typed or scanned code (spaces, dashes and case are forgiven), or nil.
    public static func normalize(_ code: String) -> String? {
        let characters = code.uppercased().filter { $0 != "-" && !$0.isWhitespace }
        guard characters.count == 8, characters.allSatisfy(alphabet.contains) else { return nil }
        return "\(characters.prefix(4))-\(characters.suffix(4))"
    }

    /// The user code from the CLI's link (it must be this phone's server) or a bare code.
    public static func parse(_ text: String, server: URL) throws -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let code = normalize(trimmed) { return code }
        guard let url = URLComponents(string: trimmed), let scheme = url.scheme?.lowercased(), ["https", "http"].contains(scheme),
              let host = url.host, url.path == "/cli/authorize",
              let code = url.queryItems?.first(where: { $0.name == "code" })?.value.flatMap(normalize) else {
            throw ParseError.notASignInCode
        }
        guard origin(scheme: scheme, host: host, port: url.port) == origin(of: server) else {
            throw ParseError.otherServer(host)
        }
        return code
    }

    private static func origin(of url: URL) -> String {
        origin(scheme: url.scheme?.lowercased() ?? "", host: url.host ?? "", port: url.port)
    }

    private static func origin(scheme: String, host: String, port: Int?) -> String {
        let standard = (scheme == "https" && port == 443) || (scheme == "http" && port == 80)
        return "\(scheme)://\(host.lowercased())\(port.map { standard ? "" : ":\($0)" } ?? "")"
    }
}

/// Reading and deciding a computer's sign-in, authenticated as this phone.
public protocol ComputerSignInApproving: Sendable {
    func computerSignIn(credential: DeviceCredential, userCode: String) async throws -> ReloComputerSignIn.Request
    func decideComputerSignIn(credential: DeviceCredential, userCode: String, approve: Bool) async throws
}

/// Making that command, authenticated as this device.
public protocol ComputerInviting: Sendable {
    /// `macApp`: on a Mac, the command also installs Relo for Mac (the notch) and opens it signed in.
    func inviteComputer(credential: DeviceCredential, level: String, approvals: Bool, agents: [String], macApp: Bool) async throws -> ReloComputerInvite
}
