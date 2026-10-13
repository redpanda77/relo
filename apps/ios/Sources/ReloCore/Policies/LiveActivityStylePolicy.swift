import Foundation

public enum LiveActivityStylePolicy {
    public static let supportedStyles: Set<String> = [
        "standard", "ring", "hero", "terminal", "steps",
        "approval", "shell", "verdict", "signal",
    ]

    public static func resolvedStyle(
        _ rawStyle: String?,
        hasValidatedInteraction: Bool
    ) -> String {
        if let rawStyle, supportedStyles.contains(rawStyle) { return rawStyle }
        return hasValidatedInteraction ? "approval" : "standard"
    }
}
