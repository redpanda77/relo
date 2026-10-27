import { describe, expect, it } from "vitest"
import { closedContent, closedHeightOf, extendedRect, fitsContent, gestureEffect, gestureFeedback, NO_FEEDBACK, rememberLastTabOf, showsTabs, shortcutEffect, OPEN_IN_NOTCH_MS, SHORTCUT_OPEN_MS, SHORTCUT_SNEAK_MS, type ClosedInputs } from "./notchState"

const base: ClosedInputs = { closedActivity: true, live: false, musicActive: false, expanding: { show: false, type: "music" }, hidden: false }
const content = (over: Partial<ClosedInputs>) => closedContent({ ...base, ...over })

describe("what holds the closed notch (ContentView.showsReloClosed)", () => {
  it("Relo shows its pilot light with nothing live and no music", () => {
    expect(content({})).toBe("relo")
  })
  it("Relo keeps the notch while something is live, even over playing music", () => {
    expect(content({ live: true, musicActive: true })).toBe("relo")
  })
  it("music takes the notch from Relo's pilot light, not from live work", () => {
    expect(content({ musicActive: true })).toBe("music")
    expect(content({ live: true, musicActive: true })).toBe("relo")
  })
  it("with Relo's closed activity off, music or nothing", () => {
    expect(content({ closedActivity: false })).toBe("plain")
    expect(content({ closedActivity: false, live: true, musicActive: true })).toBe("music")
  })
  it("the music expansion (shortcut) wins over Relo while it shows", () => {
    expect(content({ live: true, musicActive: true, expanding: { show: true, type: "music" } })).toBe("music")
    expect(content({ live: true, expanding: { show: true, type: "music" } })).toBe("plain")
  })
  it("a full-screen app hides everything", () => {
    expect(content({ live: true, musicActive: true, hidden: true })).toBe("plain")
  })
})

describe("closed height (Settings > General)", () => {
  it("is the setting within the slider's 15..45", () => {
    expect(closedHeightOf(32)).toBe(32)
    expect(closedHeightOf(10)).toBe(15)
    expect(closedHeightOf(20)).toBe(20)
    expect(closedHeightOf(90)).toBe(45)
    expect(closedHeightOf(Number.NaN)).toBe(32)
    expect(closedHeightOf(30.4)).toBe(30)
  })
})

describe("shortcut events (boringNotchApp.swift:490-546)", () => {
  const ctx = { open: false, sneakStyle: "standard" as const, sneakShowing: false, expandingShowing: false }
  it("toggleNotchOpen opens a closed notch and closes itself after 3 s, and closes an open one", () => {
    expect(shortcutEffect("toggleNotchOpen", ctx)).toEqual({ kind: "open", autoCloseMs: SHORTCUT_OPEN_MS })
    expect(SHORTCUT_OPEN_MS).toBe(3000)
    expect(shortcutEffect("toggleNotchOpen", { ...ctx, open: true })).toEqual({ kind: "close" })
  })
  it("openNotch (tray, Home) opens a closed notch on Relo and closes after 5 s unless hovered", () => {
    expect(shortcutEffect("openNotch", ctx)).toEqual({ kind: "open", autoCloseMs: OPEN_IN_NOTCH_MS, tab: "relo" })
    expect(shortcutEffect("openNotch", { ...ctx, open: true })).toBeNull()
  })
  it("toggleSneakPeek toggles the standard peek for 3 s, or the inline expansion", () => {
    expect(shortcutEffect("toggleSneakPeek", ctx)).toEqual({ kind: "sneak", show: true, ms: SHORTCUT_SNEAK_MS })
    expect(shortcutEffect("toggleSneakPeek", { ...ctx, sneakShowing: true })).toEqual({ kind: "sneak", show: false, ms: SHORTCUT_SNEAK_MS })
    expect(shortcutEffect("toggleSneakPeek", { ...ctx, sneakStyle: "inline" })).toEqual({ kind: "expanding", show: true })
    expect(shortcutEffect("toggleSneakPeek", { ...ctx, sneakStyle: "inline", expandingShowing: true })).toEqual({ kind: "expanding", show: false })
  })
})

describe("notch_gesture events (gestures.ts gestureOutcome)", () => {
  const closed = { open: false, tab: "relo", holdOpen: false }
  const open = (tab: string, holdOpen = false) => ({ open: true, tab, holdOpen })
  it("a click or a pan down opens only a closed notch", () => {
    expect(gestureEffect({ kind: "click" }, closed)).toBe("open")
    expect(gestureEffect({ kind: "open" }, closed)).toBe("open")
    expect(gestureEffect({ kind: "click" }, open("relo"))).toBeNull()
  })
  it("a pan up closes an open notch, never on the Relo tab (it scrolls) and never while something holds it", () => {
    expect(gestureEffect({ kind: "close" }, open("system"))).toBe("close")
    expect(gestureEffect({ kind: "close" }, open("relo"))).toBeNull()
    expect(gestureEffect({ kind: "close" }, open("home", true))).toBeNull()
    expect(gestureEffect({ kind: "close" }, closed)).toBeNull()
  })
  it("scrolling progress alone changes nothing", () => {
    expect(gestureEffect({ kind: "scroll", direction: "down", progress: 0.5 }, closed)).toBeNull()
  })
})

describe("header settings", () => {
  it("tabs show always, or only when there is more than one", () => {
    expect(showsTabs({ alwaysShowTabs: true, tabCount: 1 })).toBe(true)
    expect(showsTabs({ alwaysShowTabs: false, tabCount: 1 })).toBe(false)
    expect(showsTabs({ alwaysShowTabs: false, tabCount: 3 })).toBe(true)
  })
  it("hiding the tabs by choice drops 'remember last tab'", () => {
    expect(rememberLastTabOf({ rememberLastTab: true, alwaysShowTabs: false })).toBe(false)
    expect(rememberLastTabOf({ rememberLastTab: true, alwaysShowTabs: true })).toBe(true)
  })
})

describe("gesture feedback (ContentView.gestureScale)", () => {
  const down = (progress: number) => ({ kind: "scroll", direction: "down", progress }) as const
  const up = (progress: number) => ({ kind: "scroll", direction: "up", progress }) as const
  it("a closed notch grows 1% per progress point, 20 points at the threshold", () => {
    expect(gestureFeedback(down(0.5), { open: false, tab: "relo" }).scale).toBeCloseTo(1.1)
    expect(gestureFeedback(down(1), { open: false, tab: "relo" }).scale).toBeCloseTo(1.2)
    expect(gestureFeedback(down(0), { open: false, tab: "relo" })).toEqual(NO_FEEDBACK)
  })
  it("an up scroll on a closed notch and non-scroll gestures do nothing", () => {
    expect(gestureFeedback(up(1), { open: false, tab: "relo" })).toEqual(NO_FEEDBACK)
    expect(gestureFeedback({ kind: "open" }, { open: false, tab: "relo" })).toEqual(NO_FEEDBACK)
  })
  it("an open notch off the Relo tab shrinks and dims as it is pulled shut; the Relo tab scrolls instead", () => {
    const f = gestureFeedback(up(1), { open: true, tab: "system" })
    expect(f.scale).toBeCloseTo(0.8)
    expect(f.contentOpacity).toBeCloseTo(0.7)
    expect(gestureFeedback(up(1), { open: true, tab: "relo" })).toEqual(NO_FEEDBACK)
  })
  it("progress is clamped to the threshold", () => {
    expect(gestureFeedback(down(5), { open: false, tab: "relo" }).scale).toBeCloseTo(1.2)
  })
})

describe("extend hover area and the tabs' heights (G12, shelf)", () => {
  it("the hot rect grows to the sides and below only when the setting is on", () => {
    const r = { left: 100, top: 0, width: 185, height: 32 }
    expect(extendedRect(r, false)).toEqual(r)
    expect(extendedRect(r, true)).toEqual({ left: 88, top: 0, width: 209, height: 42 })
  })
  it("no tab but Relo is fitted to what its view reports: the Shelf opens at the Mac's 190", () => {
    expect(fitsContent("shelf")).toBe(false)
    expect(fitsContent("system")).toBe(false)
    expect(fitsContent("home")).toBe(false)
  })
})
