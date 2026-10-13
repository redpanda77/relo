import CryptoKit
import Foundation

public enum NotificationMediaPolicy {
    public struct Key: Hashable, Sendable {
        public let accountID: String
        public let locator: String
        public let maximumPixels: Int
        public init?(accountID: String?, locator: String, maximumPixels: Int) {
            guard let accountID, ReloIdentifier.isValid(accountID), maximumPixels > 0 else { return nil }
            self.accountID = accountID; self.locator = locator; self.maximumPixels = maximumPixels
        }
    }
    public static func accepts(_ asset: LiveActivityDisplayPresentation.AssetReference) -> Bool {
        ReloIdentifier.isValid(asset.assetId) && asset.revision > 0
            && asset.sha256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
            && (1...10_000_000).contains(asset.byteSize)
            && asset.pixelWidth > 0 && asset.pixelHeight > 0
            && ["image/png", "image/jpeg", "image/webp", "image/heic"].contains(asset.mediaType)
    }
    public static func accepts(byteCount: Int64, maximumBytes: Int64, expectedLength: Int64 = -1) -> Bool {
        byteCount > 0 && byteCount <= maximumBytes && (expectedLength <= 0 || expectedLength <= maximumBytes)
    }
    public static func matches(_ data: Data, byteSize: Int, sha256: String) -> Bool {
        guard data.count == byteSize else { return false }
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() == sha256
    }
}
