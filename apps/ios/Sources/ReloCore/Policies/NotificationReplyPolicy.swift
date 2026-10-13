import Foundation

public enum NotificationReplyPolicy {
    public static let maximumUTF16CodeUnits = 4_000
    public static let validationMessage = "Enter a response between 1 and 4,000 characters."

    public static func normalized(_ text: String?) -> String? {
        text?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public static func isValid(_ text: String?) -> Bool {
        (1...maximumUTF16CodeUnits).contains(utf16Count(text))
    }

    public static func utf16Count(_ text: String?) -> Int {
        normalized(text)?.utf16.count ?? 0
    }
}
