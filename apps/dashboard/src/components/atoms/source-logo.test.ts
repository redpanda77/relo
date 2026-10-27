import { describe, expect, it } from "vitest"

import { sourceLogo, toolLabel } from "@/components/atoms/source-logo"
import { sourceLabel } from "@/features/inbox/sessions-model"

describe("sourceLogo", () => {
  it.each([
    ["claude-code", "Claude Code"],
    ["Claude Code", "Claude Code"],
    ["codex", "Codex"],
    ["Codex", "Codex"],
    ["opencode", "OpenCode"],
    ["gemini", "Gemini CLI"],
    ["Gemini CLI", "Gemini CLI"],
    ["gemini-cli", "Gemini CLI"],
    ["antigravity", "Antigravity"],
    ["Antigravity", "Antigravity"],
    ["google antigravity", "Antigravity"],
    ["claude-desktop", "Claude Desktop"],
    ["cursor", "Cursor"],
    ["copilot", "GitHub Copilot"],
    ["GitHub Copilot", "GitHub Copilot"],
    ["vscode", "VS Code"],
    ["amp", "Amp"],
  ])("draws %s as the %s mark", (source, name) => {
    expect(sourceLogo(source)?.name).toBe(name)
  })

  it("keeps an unknown source as its name", () => {
    expect(sourceLogo("Release bot")).toBeNull()
    expect(toolLabel("release-bot")).toBe("Release Bot")
  })

  it("resolves the Sessions label back to the same mark", () => {
    for (const source of ["claude-code", "codex", "opencode", "gemini", "antigravity", "claude-desktop", "cursor", "copilot", "vscode", "amp"]) {
      expect(sourceLogo(sourceLabel(source))?.name).toBe(sourceLogo(source)?.name)
    }
  })
})
