import Foundation
import CryptoKit

public enum StorageScopeError: Error { case invalidOrigin, invalidIdentity }

/// Stable across token refresh; changes whenever authority moves to another origin/account/device.
public struct StorageScope: Codable, Hashable, Sendable {
    public let serverOrigin: URL
    public let accountID: String
    public let deviceID: String

    public init(serverOrigin: URL, accountID: String, deviceID: String) throws {
        guard ServerEndpointPolicy.accepts(serverOrigin),
              var parts = URLComponents(url: serverOrigin, resolvingAgainstBaseURL: false),
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/" else { throw StorageScopeError.invalidOrigin }
        guard !accountID.isEmpty, !deviceID.isEmpty, accountID.utf8.count <= 200, deviceID.utf8.count <= 200 else {
            throw StorageScopeError.invalidIdentity
        }
        parts.scheme = parts.scheme?.lowercased(); parts.host = parts.host?.lowercased(); parts.path = ""
        if (parts.scheme == "https" && parts.port == 443) || (parts.scheme == "http" && parts.port == 80) { parts.port = nil }
        guard let canonical = parts.url else { throw StorageScopeError.invalidOrigin }
        self.serverOrigin = canonical; self.accountID = accountID; self.deviceID = deviceID
    }

    /// Length framing prevents ambiguous concatenation; the key contains no raw endpoint or identity.
    public var fileKey: String {
        let input = [serverOrigin.absoluteString, accountID, deviceID].map { "\($0.utf8.count):\($0)" }.joined()
        return SHA256.hash(data: Data(input.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

public struct SessionScope: Equatable, Sendable {
    public let storage: StorageScope
    public let credentialVersion: Int
    public let generation: UUID
    public init(storage: StorageScope, credentialVersion: Int, generation: UUID = UUID()) {
        self.storage = storage; self.credentialVersion = credentialVersion; self.generation = generation
    }
}
