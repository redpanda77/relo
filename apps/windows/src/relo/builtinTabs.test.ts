import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { forgetBuiltinTabs, registerBuiltinTabs, shelfEnabled } from "./builtinTabs"
import { getTab, isTabVisible, registerTab, resetTabs, subscribeVisibleTabs, tabOnOpen, tabs, visibleTabs, visibleTabsKey } from "./tabs"
import { shelfStore } from "../shelf/store"
import { DEFAULT_SETTINGS } from "../shelf/types"

beforeEach(() => {
  resetTabs()
  forgetBuiltinTabs()
  registerBuiltinTabs()
})
afterEach(() => {
  resetTabs()
  forgetBuiltinTabs()
})

describe("the notch's tabs", () => {
  it("registers System, Music and Shelf with views, in the Mac's order after Relo", () => {
    expect(visibleTabs().map((t) => t.id)).toEqual(["relo", "system", "home", "shelf"])
    expect(tabs().map((t) => t.label)).toEqual(["Relo", "System", "Music", "Shelf"])
    expect(getTab("relo")?.view).toBeNull() // the notch renders the Relo tab itself
    for (const id of ["system", "home", "shelf"]) expect(getTab(id)?.view, id).toBeTypeOf("function")
  })

  it("gives each tab the Mac's open height (System 250, Music and Shelf 190)", () => {
    expect(getTab("system")?.height).toBe(250)
    expect(getTab("home")?.height).toBe(190)
    expect(getTab("shelf")?.height).toBe(190)
  })

  it("registering twice changes nothing", () => {
    const before = tabs()
    registerBuiltinTabs()
    expect(tabs()).toBe(before)
  })

  it("hides the Shelf while it is switched off, and says when that changes", () => {
    // The Shelf's own registration reads its store's settings (on by default) and listens to the store.
    expect(shelfStore().get().settings.enabled).toBe(DEFAULT_SETTINGS.enabled)
    expect(shelfEnabled()).toBe(true)
    let calls = 0
    const off = subscribeVisibleTabs(() => (calls += 1))
    const key = visibleTabsKey()
    expect(isTabVisible("shelf")).toBe(true)
    // A switched-off Shelf (what `visible` answers once the store says `enabled: false`) leaves the bar.
    registerTab({ id: "shelf", view: () => null, visible: () => false })
    expect(visibleTabs().map((t) => t.id)).toEqual(["relo", "system", "home"])
    expect(isTabVisible("shelf")).toBe(false)
    expect(visibleTabsKey()).not.toBe(key)
    expect(calls).toBeGreaterThan(0)
    off()
  })

  it("accepts the Shelf descriptor's own shape (View, title, iconPath)", () => {
    resetTabs()
    registerTab({ id: "shelf", View: () => null, title: "Shelf", iconPath: "M0 0h24" })
    expect(getTab("shelf")).toMatchObject({ label: "Shelf" })
    expect(getTab("shelf")?.view).toBeTypeOf("function")
    expect(getTab("shelf")?.icon).not.toBeNull()
    // A descriptor's `visible(settings)` needs the shelf's settings: it is not called as a plain `visible()`.
    registerTab({ id: "shelf", View: () => null, visible: ((s: { enabled: boolean }) => s.enabled) as never })
    expect(isTabVisible("shelf")).toBe(true)
  })
})

describe("which tab the notch lands on (BoringViewModel.close)", () => {
  it("is Relo, unless remembering the last tab", () => {
    expect(tabOnOpen({ current: "system", remember: false, last: "system", shelfByDefault: false })).toBe("relo")
    expect(tabOnOpen({ current: "system", remember: true, last: "home", shelfByDefault: false })).toBe("home")
  })
  it("is the Shelf when it opens by default with items, even over a remembered tab", () => {
    expect(tabOnOpen({ current: "relo", remember: false, last: null, shelfByDefault: true })).toBe("shelf")
    expect(tabOnOpen({ current: "home", remember: true, last: "home", shelfByDefault: true })).toBe("shelf")
  })
  it("never lands on a tab that is hidden", () => {
    registerTab({ id: "shelf", view: () => null, visible: () => false })
    expect(tabOnOpen({ current: "relo", remember: true, last: "shelf", shelfByDefault: true })).toBe("relo")
  })
})
