import Foundation

/// The harnesses drawn as their own mark (the iPhone's SourceLogo, the notch's ReloSourceLogo), from any spelling a source
/// arrives in: the CLI's harness id ("gemini"), its label ("Gemini CLI") or an alias ("gemini-cli").
public enum KnownHarness: String, CaseIterable, Sendable {
    case claudeCode, claudeDesktop, codex, openCode, gemini, antigravity, cursor, copilot, vscode, amp

    public init?(source: String) {
        switch source.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "claude code", "claude", "claude-code": self = .claudeCode
        case "claude desktop", "claude-desktop", "desktop": self = .claudeDesktop
        case "codex", "openai codex", "codex cli": self = .codex
        case "opencode", "open code": self = .openCode
        case "gemini", "gemini cli", "gemini-cli", "google gemini": self = .gemini
        case "antigravity", "google antigravity", "antigravity ide": self = .antigravity
        case "cursor": self = .cursor
        case "copilot", "github copilot", "github-copilot", "copilot-cli": self = .copilot
        case "vscode", "vs code", "vs-code": self = .vscode
        case "amp": self = .amp
        default: return nil
        }
    }

    public var label: String {
        switch self {
        case .claudeCode: "Claude Code"
        case .codex: "Codex"
        case .openCode: "OpenCode"
        case .gemini: "Gemini CLI"
        case .antigravity: "Antigravity"
        case .claudeDesktop: "Claude Desktop"
        case .cursor: "Cursor"
        case .copilot: "GitHub Copilot"
        case .vscode: "VS Code"
        case .amp: "Amp"
        }
    }
}

/// Source (harness) display names: a label table, not a view of its own.
public enum SessionSource {
    public static func label(_ source: String) -> String {
        if let harness = KnownHarness(source: source) { return harness.label }
        return source
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
