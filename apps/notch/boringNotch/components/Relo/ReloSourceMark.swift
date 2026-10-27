//
//  ReloSourceMark.swift
//  Relo Notch
//
//  A known agent's own mark in place of its name, as on the iPhone and the Dashboard (apps/ios
//  SharedActivity/SourceLogo.swift; marks: Lobe Icons, MIT, and Simple Icons, CC0). Unknown sources keep their name.
//

import ReloCore
import SwiftUI

struct ReloSourceLogo: Equatable {
    let harness: KnownHarness

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

struct ReloSourceMark: View {
    let name: String
    var size: CGFloat = 11

    var body: some View {
        if let logo = ReloSourceLogo(sourceName: name) {
            Image(logo.assetName)
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .frame(width: size, height: size)
                .foregroundStyle(logo.tint ?? ReloNotchTheme.secondaryText)
                .accessibilityLabel(logo.name)
        } else {
            Text(name)
        }
    }
}
