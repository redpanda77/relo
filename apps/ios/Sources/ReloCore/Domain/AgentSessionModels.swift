import Foundation

/// Source (harness) display names: a label table, not a view of its own.
public enum SessionSource {
    public static func label(_ source: String) -> String {
        switch source {
        case "claude-code": "Claude Code"
        case "codex": "Codex"
        case "opencode": "OpenCode"
        case "gemini": "Gemini CLI"
        case "cursor": "Cursor"
        default: source
        }
    }

    /// "MacBook Pro · Work".
    public static func groupTitle(computer: String?, account: String?) -> String {
        let parts = [computer, account].compactMap { value -> String? in
            let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return trimmed.isEmpty ? nil : trimmed
        }
        return parts.isEmpty ? "Unknown computer" : parts.joined(separator: " · ")
    }
}
