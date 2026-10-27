import { describe, expect, it } from "vitest"
import { IDLE_DRAG, reduceDrag } from "./drag"
import { createShelfStore, opensByDefault, type ShelfIO } from "./store"
import { DEFAULT_SETTINGS, type ShelfDragEvent, type ShelfItem } from "./types"

const item = (id: string, over: Partial<ShelfItem> = {}): ShelfItem => ({
  id,
  kind: "file",
  name: `${id}.txt`,
  path: `C:\\${id}.txt`,
  text: null,
  url: null,
  isTemporary: false,
  isDir: false,
  missing: false,
  addedMs: 0,
  ...over,
})

function fakeIO(initial: ShelfItem[]) {
  const cb = { items: [] as Array<(i: ShelfItem[]) => void>, drag: [] as Array<(e: ShelfDragEvent) => void>, settings: [] as Array<(s: typeof DEFAULT_SETTINGS) => void> }
  const io: ShelfIO = {
    snapshot: async () => ({ items: initial, settings: { ...DEFAULT_SETTINGS, copyOnDrag: true } }),
    onItems: (f) => (cb.items.push(f), () => {}),
    onSettings: (f) => (cb.settings.push(f), () => {}),
    onDrag: (f) => (cb.drag.push(f), () => {}),
    onError: () => () => {},
  }
  return { io, cb }
}

const ev = (phase: ShelfDragEvent["phase"], zone: ShelfDragEvent["zone"] = "shelf", added = 0): ShelfDragEvent => ({ phase, x: 0, y: 0, zone, added })

describe("drag state", () => {
  it("follows enter, zone changes, leave and drop", () => {
    let s = reduceDrag(IDLE_DRAG, ev("enter"))
    expect(s).toEqual({ over: true, zone: "shelf", lastAdded: 0 })
    s = reduceDrag(s, ev("over", "share"))
    expect(s.zone).toBe("share")
    expect(reduceDrag(s, ev("leave"))).toEqual(IDLE_DRAG)
    expect(reduceDrag(s, ev("drop", "shelf", 3))).toEqual({ over: false, zone: null, lastAdded: 3 })
  })
  it("an over in the same zone is the same state (no re-render)", () => {
    const s = reduceDrag(IDLE_DRAG, ev("enter"))
    expect(reduceDrag(s, ev("over"))).toBe(s)
  })
})

describe("shelf store", () => {
  it("loads the snapshot and keeps following Rust", async () => {
    const { io, cb } = fakeIO([item("a"), item("b")])
    const store = createShelfStore(io)
    expect(store.get().loaded).toBe(false)
    await store.start()
    expect(store.get().items.map((i) => i.id)).toEqual(["a", "b"])
    expect(store.get().settings.copyOnDrag).toBe(true)
    cb.items[0]!([item("a"), item("b"), item("c")])
    expect(store.get().items).toHaveLength(3)
  })

  it("drops selection and rename of items that left", async () => {
    const { io, cb } = fakeIO([item("a"), item("b")])
    const store = createShelfStore(io)
    await store.start()
    store.click("a", { shift: false, toggle: false })
    store.click("b", { shift: false, toggle: true })
    store.setRenaming("b")
    cb.items[0]!([item("a")])
    expect([...store.get().selection.ids]).toEqual(["a"])
    expect(store.get().renaming).toBeNull()
  })

  it("exposes drag events to the host and tracks the highlight", async () => {
    const { io, cb } = fakeIO([])
    const store = createShelfStore(io)
    await store.start()
    const seen: string[] = []
    store.onDragEvent((e) => seen.push(e.phase))
    cb.drag[0]!(ev("enter"))
    expect(store.get().drag.over).toBe(true)
    cb.drag[0]!(ev("drop", "shelf", 2))
    expect(seen).toEqual(["enter", "drop"])
    expect(store.get().drag.over).toBe(false)
  })

  it("a drag carries the selection", async () => {
    const { io } = fakeIO([item("a"), item("b"), item("c")])
    const store = createShelfStore(io)
    await store.start()
    store.selectAll()
    expect(store.dragIdsFrom("b")).toEqual(["a", "b", "c"])
    store.clearSelection()
    expect(store.dragIdsFrom("b")).toEqual(["b"])
  })

  it("opens by default only when enabled, set so and not empty", () => {
    const base = { items: [item("a")], settings: DEFAULT_SETTINGS }
    expect(opensByDefault(base)).toBe(true)
    expect(opensByDefault({ ...base, items: [] })).toBe(false)
    expect(opensByDefault({ ...base, settings: { ...DEFAULT_SETTINGS, openByDefault: false } })).toBe(false)
    expect(opensByDefault({ ...base, settings: { ...DEFAULT_SETTINGS, enabled: false } })).toBe(false)
  })
})
