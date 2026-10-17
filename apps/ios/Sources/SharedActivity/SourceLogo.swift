import SwiftUI

/// A known agent's own mark in place of its name ("Claude Code" reads as the Claude Code mascot).
/// Unknown sources keep their name. Marks: Lobe Icons (MIT), template-rendered and tinted here.
enum SourceLogo: Equatable, Sendable {
    case claudeCode, codex, openCode

    init?(sourceName: String) {
        switch sourceName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "claude code", "claude", "claude-code": self = .claudeCode
        case "codex", "openai codex", "codex cli": self = .codex
        case "opencode", "open code": self = .openCode
        default: return nil
        }
    }

    var assetName: String {
        switch self {
        case .claudeCode: "SourceClaudeCode"
        case .codex: "SourceCodex"
        case .openCode: "SourceOpenCode"
        }
    }

    var name: String {
        switch self {
        case .claudeCode: "Claude Code"
        case .codex: "Codex"
        case .openCode: "OpenCode"
        }
    }

    /// The brand's own color where it has one; otherwise the surrounding text color.
    var tint: Color? {
        switch self {
        case .claudeCode: Color(red: 0xD9 / 255, green: 0x77 / 255, blue: 0x57 / 255)
        case .codex, .openCode: nil
        }
    }
}

/// The source as its logo when known, else as its name with a fallback symbol.
struct SourceMark: View {
    let name: String
    var fallbackSymbol: String? = nil
    var size: CGFloat = 14

    var body: some View {
        if let logo = SourceLogo(sourceName: name) {
            Image(logo.assetName)
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .frame(width: size, height: size)
                .foregroundStyle(logo.tint ?? Color.primary)
                .accessibilityLabel(logo.name)
        } else if let fallbackSymbol {
            Label(name, systemImage: fallbackSymbol)
                .labelStyle(SourceMarkLabelStyle())
        } else {
            Text(name)
        }
    }
}

private struct SourceMarkLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 3) { configuration.icon.imageScale(.small); configuration.title }
    }
}
