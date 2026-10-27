import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { toggleCue } from "../sound/cues"
import { DEFAULTS, normalize } from "./store"
import { shortcutAction } from "./windowKeys"

const key = (k: string, over: Partial<Parameters<typeof shortcutAction>[0]> = {}) => ({ key: k, ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, ...over })
const src = (file: string) => readFileSync(path.resolve(import.meta.dirname, file), "utf8")

describe("Settings window keys (K03)", () => {
  it("maps Ctrl+, to Settings and Ctrl+Q to quit, and nothing else", () => {
    expect(shortcutAction(key(","))).toBe("settings")
    expect(shortcutAction(key("q"))).toBe("quit")
    expect(shortcutAction(key("Q"))).toBe("quit")
    expect(shortcutAction(key("q", { ctrlKey: false }))).toBeNull()
    expect(shortcutAction(key("q", { shiftKey: true }))).toBeNull()
    expect(shortcutAction(key(",", { altKey: true }))).toBeNull()
    expect(shortcutAction(key("w"))).toBeNull()
  })
})

describe("interface cues in Settings and onboarding (A09, A15-A17, G14)", () => {
  it("rises for on and falls for off", () => {
    expect(toggleCue(true)).toBe("on")
    expect(toggleCue(false)).toBe("off")
  })
  it("is wired: switches and ticks, page turns, section changes", () => {
    expect(src("ui.tsx")).toContain("uiCue(toggleCue(!checked))")
    expect(src("SettingsApp.tsx")).toContain('uiCue("section")')
    expect(src("onboarding/Onboarding.tsx")).toContain('uiCue("turn")')
    expect(src("../local/LocalSetupView.tsx")).toContain("<Check")
  })
})

describe("settings the notch and displays read (C01, G12, D01)", () => {
  it("has the Mac's defaults", () => {
    expect(DEFAULTS).toMatchObject({ enableShadow: true, extendHoverArea: false, autoSwitchDisplay: true })
  })
  it("normalises them to booleans", () => {
    expect(normalize({ enableShadow: false, extendHoverArea: true, autoSwitchDisplay: false })).toMatchObject({ enableShadow: false, extendHoverArea: true, autoSwitchDisplay: false })
    expect(normalize({ enableShadow: "no", extendHoverArea: 1, autoSwitchDisplay: null })).toMatchObject({ enableShadow: true, extendHoverArea: false, autoSwitchDisplay: true })
  })
})
