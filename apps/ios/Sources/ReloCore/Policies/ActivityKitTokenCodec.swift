import Foundation

public enum ActivityKitTokenCodec {
    public static func hex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }
}
