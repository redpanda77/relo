import CryptoKit
import Foundation

/// Linking a web Dashboard browser from this phone (docs/END-TO-END-ENCRYPTION.md, "Linked browsers").
/// The browser shows `relo-link:1:<browserId>:<identity key b64u>`; the phone's identity key signs
/// the link so computers seal to that browser only on the word of a phone they trust.
public enum ReloBrowserLink {
    public static let scheme = "relo-link"
    public static let version = "1"

    /// A scanned, well-formed link code.
    public struct Code: Equatable, Sendable {
        public let browserID: String
        /// Browser identity public key, base64url X9.63 (exactly as scanned).
        public let identityKey: String
        public let identityKeyX963: Data
    }

    public enum ParseError: Error, Equatable, Sendable, LocalizedError {
        case notALinkCode
        case unsupportedVersion
        case invalidBrowserID
        case invalidIdentityKey

        public var errorDescription: String? {
            switch self {
            case .notALinkCode:
                "This is not a Relo link code. Open Relo's web Dashboard and scan the code it shows."
            case .unsupportedVersion:
                "This link code is from a newer Relo. Update Relo on this iPhone and try again."
            case .invalidBrowserID, .invalidIdentityKey:
                "This link code is damaged. Reload the Dashboard and scan the new code."
            }
        }
    }

    /// Parses `relo-link:1:<browserId>:<identityPublicKey b64u>`; anything else is rejected.
    public static func parse(_ text: String) throws -> Code {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = trimmed.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        guard parts.count >= 2, parts[0] == scheme else { throw ParseError.notALinkCode }
        guard parts[1] == version else { throw ParseError.unsupportedVersion }
        guard parts.count == 4 else { throw ParseError.notALinkCode }
        let browserID = parts[2], identityKey = parts[3]
        guard isBrowserID(browserID) else { throw ParseError.invalidBrowserID }
        guard identityKey.count == 87,
              let key = try? ReloE2EE.data(base64URL: identityKey, length: 65, field: "identityKey"),
              key.first == 0x04,
              (try? P256.Signing.PublicKey(x963Representation: key)) != nil else {
            throw ParseError.invalidIdentityKey
        }
        return Code(browserID: browserID, identityKey: identityKey, identityKeyX963: key)
    }

    /// `^brw_[0-9a-f-]{36}$`
    public static func isBrowserID(_ value: String) -> Bool {
        guard value.hasPrefix("brw_") else { return false }
        let rest = value.dropFirst(4)
        return rest.count == 36 && rest.allSatisfy { $0 == "-" || ("0"..."9").contains($0) || ("a"..."f").contains($0) }
    }

    /// The bytes the phone's identity key signs.
    public static func signingInput(browserID: String, identityKey: String, phoneDeviceID: String, signedAt: String) -> Data {
        Data(["\(ReloE2EE.version) link", browserID, identityKey, phoneDeviceID, signedAt].joined(separator: "\n").utf8)
    }

    /// The signed body for `POST /api/devices/self/links`.
    public static func request(
        for code: Code, phoneDeviceID: String, signer: any ReloIdentitySigning, now: Date = Date()
    ) throws -> ReloBrowserLinkRequest {
        try request(browserID: code.browserID, identityKey: code.identityKey, phoneDeviceID: phoneDeviceID, signer: signer, now: now)
    }
}

public struct ReloBrowserLinkRequest: Codable, Equatable, Sendable {
    public let browserId: String
    public let identityKey: String
    public let signedAt: String
    /// Raw r||s, base64url.
    public let signature: String
}

public struct ReloLinkedBrowser: Codable, Equatable, Sendable, Identifiable {
    public let browserId: String
    public let name: String
    public let linkedAt: String
    public var id: String { browserId }
    public var linkedDate: Date? { ReloKeyRing.date(linkedAt) }

    public init(browserId: String, name: String, linkedAt: String) {
        self.browserId = browserId
        self.name = name
        self.linkedAt = linkedAt
    }
}

public enum BrowserLinkError: Error, Equatable, Sendable, LocalizedError {
    /// 404: the server does not know this browser for this account.
    case unknownBrowser
    /// 409: the browser's identity key changed since the code was shown.
    case identityMismatch

    public var errorDescription: String? {
        switch self {
        case .unknownBrowser:
            "Relo doesn't know this browser. Make sure it is signed in to the same Relo account, then scan again."
        case .identityMismatch:
            "This browser's code has changed. Reload the Dashboard and scan the new code."
        }
    }
}

/// Device-authenticated linked-browser endpoints.
public protocol BrowserLinking: Sendable {
    func linkBrowser(credential: DeviceCredential, request: ReloBrowserLinkRequest) async throws -> ReloLinkedBrowser
    func linkedBrowsers(credential: DeviceCredential) async throws -> [ReloLinkedBrowser]
    func unlinkBrowser(credential: DeviceCredential, browserID: String) async throws
}
