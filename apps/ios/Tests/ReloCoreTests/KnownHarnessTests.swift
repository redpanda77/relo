import Testing
@testable import ReloCore

/// Every harness with its own mark resolves from the spellings a source arrives in (the CLI's id, its label, an
/// alias), so SourceLogo draws it on cards, Now and the HUD.
@Suite struct KnownHarnessTests {
    @Test(arguments: [
        ("claude-code", KnownHarness.claudeCode), ("Claude Code", .claudeCode),
        ("codex", .codex), ("Codex", .codex), ("codex cli", .codex),
        ("opencode", .openCode), ("OpenCode", .openCode),
        ("gemini", .gemini), ("Gemini CLI", .gemini), ("gemini-cli", .gemini), ("Gemini", .gemini), (" GEMINI ", .gemini),
        ("antigravity", .antigravity), ("Antigravity", .antigravity), ("google antigravity", .antigravity),
        ("claude-desktop", .claudeDesktop), ("Claude Desktop", .claudeDesktop),
        ("cursor", .cursor), ("Cursor", .cursor), ("copilot", .copilot), ("GitHub Copilot", .copilot),
        ("vscode", .vscode), ("VS Code", .vscode), ("amp", .amp), ("Amp", .amp),
    ])
    func resolves(source: String, harness: KnownHarness) {
        #expect(KnownHarness(source: source) == harness)
    }

    @Test func unknownSourcesKeepTheirName() {
        #expect(KnownHarness(source: "Release bot") == nil)
        #expect(SessionSource.label("Release bot") == "Release bot")
        #expect(SessionSource.label("cursor") == "Cursor")
    }

    @Test func labelsMatchTheCLI() {
        #expect(SessionSource.label("gemini") == "Gemini CLI")
        #expect(SessionSource.label("antigravity") == "Antigravity")
        #expect(SessionSource.label("codex") == "Codex")
        #expect(SessionSource.label("opencode") == "OpenCode")
        #expect(SessionSource.label("claude-code") == "Claude Code")
        // The HUD passes the label back into SourceMark: it must resolve to the same mark.
        for harness in KnownHarness.allCases { #expect(KnownHarness(source: harness.label) == harness) }
    }
}
