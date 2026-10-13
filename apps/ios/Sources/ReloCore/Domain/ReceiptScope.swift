import CryptoKit
import Foundation

public enum ReceiptScopeError: Error, Equatable, Sendable { case invalidOrigin, invalidIdentity }

public struct ReceiptScope: Codable, Hashable, Sendable {
    public let serverOriginHash: String
    public let accountId: String
    public let deviceId: String

    public init(serverOriginHash: String, accountId: String, deviceId: String) throws {
        guard serverOriginHash.utf8.count == 64,
              serverOriginHash.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              Self.validID(accountId, prefix: "acc_"), Self.validID(deviceId, prefix: "dev_")
        else { throw ReceiptScopeError.invalidIdentity }
        self.serverOriginHash = serverOriginHash; self.accountId = accountId; self.deviceId = deviceId
    }
    public init(serverOrigin: URL, accountId: String, deviceId: String) throws {
        try self.init(serverOriginHash: Self.originHash(serverOrigin), accountId: accountId, deviceId: deviceId)
    }
    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(serverOriginHash: values.decode(String.self, forKey: .serverOriginHash),
                      accountId: values.decode(String.self, forKey: .accountId),
                      deviceId: values.decode(String.self, forKey: .deviceId))
    }
    public static func originHash(_ origin: URL) throws -> String {
        guard var parts = URLComponents(url: origin, resolvingAgainstBaseURL: false),
              let scheme = parts.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil, parts.path.isEmpty || parts.path == "/"
        else { throw ReceiptScopeError.invalidOrigin }
        parts.scheme = scheme; parts.host = host.lowercased(); parts.path = ""
        if (scheme == "https" && parts.port == 443) || (scheme == "http" && parts.port == 80) { parts.port = nil }
        guard let normalized = parts.url?.absoluteString else { throw ReceiptScopeError.invalidOrigin }
        return SHA256.hash(data: Data(normalized.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    static func validID(_ value: String, prefix: String) -> Bool {
        guard value.hasPrefix(prefix), (prefix.count + 8...200).contains(value.utf8.count) else { return false }
        return value.dropFirst(prefix.count).utf8.allSatisfy {
            (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45
        }
    }
}

public struct NotificationReceiptRecord: Codable, Hashable, Sendable {
    public let scope: ReceiptScope
    public let notificationID: String
    public let capturedAt: Date
    public init(scope: ReceiptScope, notificationID: String, capturedAt: Date = Date()) throws {
        guard ReceiptScope.validID(notificationID, prefix: "ntf_"), capturedAt.timeIntervalSince1970.isFinite
        else { throw ReceiptScopeError.invalidIdentity }
        self.scope = scope; self.notificationID = notificationID; self.capturedAt = capturedAt
    }
    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(scope: values.decode(ReceiptScope.self, forKey: .scope),
                      notificationID: values.decode(String.self, forKey: .notificationID),
                      capturedAt: values.decode(Date.self, forKey: .capturedAt))
    }
}

public struct NotificationReceiptBatch: Equatable, Sendable {
    public let records: [NotificationReceiptRecord]
    /// Persisted count of predecessor entries retired without assigning them to a new scope.
    public let retiredUnscopedCount: Int
    public init(records: [NotificationReceiptRecord], retiredUnscopedCount: Int = 0) {
        self.records = records; self.retiredUnscopedCount = retiredUnscopedCount
    }
}
