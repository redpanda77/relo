import ReloCore
import SwiftUI

/// A known agent's own mark in place of its name ("Claude Code" reads as the Claude Code mascot).
/// Unknown sources keep their name. Which sources are known: ReloCore's KnownHarness.
/// Marks: Lobe Icons (MIT) for Claude Code, OpenCode and Antigravity; Simple Icons (CC0) for the rest.
struct SourceLogo: Equatable, Sendable {
    let harness: KnownHarness

    static let claudeCode = SourceLogo(harness: .claudeCode)

    init(harness: KnownHarness) { self.harness = harness }

    init?(sourceName: String) {
        guard let harness = KnownHarness(source: sourceName) else { return nil }
        self.harness = harness
    }

    var assetName: String {
        switch harness {
        case .claudeCode: "SourceClaudeCode"
        case .codex: "SourceCodex"
        case .openCode: "SourceOpenCode"
        case .gemini: "SourceGemini"
        case .antigravity: "SourceAntigravity"
        case .claudeDesktop: "SourceClaudeDesktop"
        case .cursor: "SourceCursor"
        case .copilot: "SourceCopilot"
        case .vscode: "SourceVSCode"
        case .amp: "SourceAmp"
        }
    }

    var name: String { harness.label }

    /// The brand's own color where it has one; otherwise the surrounding text color.
    var tint: Color? {
        switch harness {
        case .claudeCode: Color(red: 0xD9 / 255, green: 0x77 / 255, blue: 0x57 / 255)
        case .claudeDesktop: Color(red: 0xD9 / 255, green: 0x77 / 255, blue: 0x57 / 255)
        case .gemini: Color(red: 0x31 / 255, green: 0x86 / 255, blue: 0xFF / 255)
        case .vscode: Color(red: 0x00 / 255, green: 0x7A / 255, blue: 0xCC / 255)
        case .codex, .openCode, .antigravity, .cursor, .copilot, .amp: nil
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
