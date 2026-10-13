import Foundation

public enum LiveActivityPresentationFormatting {
    public static let defaultAccentColor = "#5ED8B7"

    public static func normalizedAccentColor(_ value: String?) -> String {
        guard let value, value.utf8.count == 7, value.first == "#" else {
            return defaultAccentColor
        }
        let hex = value.dropFirst()
        guard hex.unicodeScalars.allSatisfy({ scalar in
            (48...57).contains(scalar.value)
                || (65...70).contains(scalar.value)
                || (97...102).contains(scalar.value)
        }) else {
            return defaultAccentColor
        }
        return value.uppercased()
    }

    public static func normalizedActionLabel(_ value: String?) -> String? {
        guard let value else { return nil }
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard
            (1...24).contains(normalized.utf16.count),
            normalized.unicodeScalars.allSatisfy({
                !CharacterSet.controlCharacters.contains($0)
            })
        else { return nil }
        return normalized
    }
}
