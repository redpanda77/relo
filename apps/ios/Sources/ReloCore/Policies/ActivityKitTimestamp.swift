import Foundation

public enum ActivityKitTimestamp {
    public static func date(fromUnixSeconds seconds: Double) -> Date {
        Date(timeIntervalSince1970: seconds)
    }

    public static func date(fromISO8601 value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        let standard = ISO8601DateFormatter()
        standard.formatOptions = [.withInternetDateTime]
        return standard.date(from: value)
    }
}
