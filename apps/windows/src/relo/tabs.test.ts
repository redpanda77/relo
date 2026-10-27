import { afterEach, describe, expect, it } from "vitest"
import { getTab, registerTab, resetTabs, subscribeTabs, tabToOpen, tabs } from "./tabs"

afterEach(() => resetTabs())

describe("tab registry", () => {
  it("lists the Mac's tabs in order with their heights", () => {
    expect(tabs().map((t) => t.id)).toEqual(["relo", "system", "home", "shelf"])
    expect(tabs().map((t) => t.label)).toEqual(["Relo", "System", "Music", "Shelf"])
    expect(getTab("system")?.height).toBe(250)
    expect(getTab("home")?.height).toBe(190)
    expect(getTab("shelf")?.height).toBe(190) // the Mac's fixed height, not the 220 its view once asked for
  })
  it("registers a view and notifies", () => {
    let calls = 0
    const off = subscribeTabs(() => (calls += 1))
    const view = () => null
    const unregister = registerTab({ id: "system", icon: null, view })
    expect(getTab("system")?.view).toBe(view)
    unregister()
    expect(getTab("system")?.view).toBeNull()
    expect(calls).toBe(2)
    off()
  })
  it("appends unknown ids after the built-in ones and honours a height", () => {
    registerTab({ id: "extra", view: () => null, label: "Extra", height: 300 })
    expect(tabs().at(-1)).toMatchObject({ id: "extra", label: "Extra", height: 300 })
  })
})

describe("tabToOpen (remember last tab)", () => {
  it("opens on Relo unless remembering", () => {
    expect(tabToOpen("shelf", false, "shelf")).toBe("relo")
    expect(tabToOpen("shelf", true, "home")).toBe("home")
    expect(tabToOpen("shelf", true, "gone")).toBe("shelf")
    expect(tabToOpen("nope", true, null)).toBe("relo")
  })
})
