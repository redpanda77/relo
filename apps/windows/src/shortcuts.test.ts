import { describe, expect, it } from "vitest"
import { acceleratorOf, DEFAULT_SHORTCUTS, displayAccelerator } from "./shortcuts"

const key = (code: string, k: string, mods: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }> = {}) => ({
  code,
  key: k,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
})

describe("shortcut recorder", () => {
  it("builds an accelerator from modifiers and a key", () => {
    expect(acceleratorOf(key("KeyH", "H", { ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+H")
    expect(acceleratorOf(key("F5", "F5", { altKey: true }))).toBe("Alt+F5")
    expect(acceleratorOf(key("Digit3", "3", { metaKey: true, shiftKey: true }))).toBe("Shift+Super+3")
  })

  it("keeps recording while only modifiers are down, and refuses a bare key", () => {
    expect(acceleratorOf(key("ControlLeft", "Control", { ctrlKey: true }))).toBeNull()
    expect(acceleratorOf(key("KeyH", "h"))).toBeNull()
    expect(acceleratorOf(key("IntlRo", "ろ", { ctrlKey: true }))).toBeNull()
  })

  it("matches the Mac defaults mapped to Ctrl", () => {
    expect(DEFAULT_SHORTCUTS).toEqual({ toggleSneakPeek: "Ctrl+Shift+H", toggleNotchOpen: "Ctrl+Shift+I" })
    expect(displayAccelerator("Super+Shift+K")).toEqual(["Win", "Shift", "K"])
    expect(displayAccelerator("")).toEqual([])
  })
})
