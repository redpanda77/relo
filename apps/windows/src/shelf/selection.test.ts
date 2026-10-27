import { describe, expect, it } from "vitest"
import { click, dragIds, EMPTY_SELECTION, prune, selectAll, selectRange, selectSingle, toggle } from "./selection"

const order = ["a", "b", "c", "d", "e"]
const ids = (s: { ids: ReadonlySet<string> }) => [...s.ids].sort()

describe("shelf selection", () => {
  it("a plain click selects one; on a selected item it keeps the selection", () => {
    const one = click(EMPTY_SELECTION, "b", order, { shift: false, toggle: false })
    expect(ids(one)).toEqual(["b"])
    const many = selectAll(order)
    expect(click(many, "c", order, { shift: false, toggle: false })).toBe(many)
  })

  it("ctrl toggles and moves the anchor", () => {
    let s = selectSingle("a")
    s = toggle(s, "c")
    expect(ids(s)).toEqual(["a", "c"])
    s = toggle(s, "a")
    expect(ids(s)).toEqual(["c"])
    expect(s.anchor).toBe("a")
  })

  it("shift selects the range from the anchor, either direction", () => {
    const s = selectSingle("b")
    expect(ids(selectRange(s, "d", order))).toEqual(["b", "c", "d"])
    expect(ids(selectRange(selectSingle("d"), "b", order))).toEqual(["b", "c", "d"])
    expect(ids(click(s, "e", order, { shift: true, toggle: false }))).toEqual(["b", "c", "d", "e"])
    // an anchor that left the shelf falls back to one item
    expect(ids(selectRange({ ids: new Set(["zz"]), anchor: "zz" }, "c", order))).toEqual(["c"])
  })

  it("prune forgets items that left", () => {
    const s = prune(selectAll(order), ["a", "c"])
    expect(ids(s)).toEqual(["a", "c"])
    const same = selectSingle("a")
    expect(prune(same, order)).toBe(same)
    expect(prune(selectSingle("e"), ["a"]).ids.size).toBe(0)
  })

  it("a drag carries the whole selection when it starts on a member, else just the item, in shelf order", () => {
    const s = { ids: new Set(["d", "b"]), anchor: "b" }
    expect(dragIds(s, "d", order)).toEqual(["b", "d"])
    expect(dragIds(s, "a", order)).toEqual(["a"])
    expect(dragIds(selectSingle("b"), "b", order)).toEqual(["b"])
  })
})
