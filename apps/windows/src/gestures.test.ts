import { describe, expect, it } from "vitest"
import { gestureOutcome } from "./gestures"

describe("gestureOutcome (the Mac's guards)", () => {
  const closed = { open: false, onReloTab: false }
  const open = { open: true, onReloTab: false }

  it("a click or a pan down opens only a closed notch", () => {
    expect(gestureOutcome({ kind: "click" }, closed)).toBe("open")
    expect(gestureOutcome({ kind: "open" }, closed)).toBe("open")
    expect(gestureOutcome({ kind: "click" }, open)).toBeNull()
    expect(gestureOutcome({ kind: "open" }, open)).toBeNull()
  })

  it("a pan up closes an open notch, except on the Relo tab or while sharing holds it", () => {
    expect(gestureOutcome({ kind: "close" }, open)).toBe("close")
    expect(gestureOutcome({ kind: "close" }, { ...open, onReloTab: true })).toBeNull()
    expect(gestureOutcome({ kind: "close" }, { ...open, holdOpen: true })).toBeNull()
    expect(gestureOutcome({ kind: "close" }, closed)).toBeNull()
  })

  it("scroll progress alone does nothing", () => {
    expect(gestureOutcome({ kind: "scroll", direction: "down", progress: 0.5 }, closed)).toBeNull()
  })
})
