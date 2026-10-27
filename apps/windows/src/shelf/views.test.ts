import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ShelfPageView } from "../settings/shelf"
import { EmptyState, ItemTile, ShareTile, ShelfView } from "./ShelfView"
import { createShelfStore } from "./store"
import { DEFAULT_SETTINGS, type ShelfItem } from "./types"

const item = (over: Partial<ShelfItem> = {}): ShelfItem => ({ id: "x", kind: "file", name: "report.pdf", path: "C:\\r\\report.pdf", text: null, url: null, isTemporary: false, isDir: false, missing: false, addedMs: 0, ...over })
const html = (el: React.ReactElement) => renderToStaticMarkup(el)

describe("shelf views", () => {
  it("an item shows its name and selection state", () => {
    const h = html(createElement(ItemTile, { item: item(), selected: true, renaming: false, thumb: null }))
    expect(h).toContain("report.pdf")
    expect(h).toContain('aria-selected="true"')
    expect(h).toContain('data-kind="file"')
    expect(html(createElement(ItemTile, { item: item(), selected: false, renaming: false, thumb: null }))).toContain('aria-selected="false"')
  })

  it("a thumbnail replaces the glyph", () => {
    const h = html(createElement(ItemTile, { item: item(), selected: false, renaming: false, thumb: "blob:abc" }))
    expect(h).toContain('src="blob:abc"')
    expect(html(createElement(ItemTile, { item: item(), selected: false, renaming: false, thumb: null }))).not.toContain("<img")
  })

  it("text and link items show their stand-in names, a missing file is dimmed", () => {
    expect(html(createElement(ItemTile, { item: item({ kind: "link", name: "example.com/a", path: null, url: "https://example.com/a" }), selected: false, renaming: false, thumb: null }))).toContain("example.com/a")
    expect(html(createElement(ItemTile, { item: item({ missing: true }), selected: false, renaming: false, thumb: null }))).toContain("opacity:0.45")
  })

  it("renaming swaps the name for a field", () => {
    expect(html(createElement(ItemTile, { item: item(), selected: true, renaming: true, thumb: null }))).toContain('aria-label="Rename"')
  })

  it("the share tile highlights when a drag is over it", () => {
    expect(html(createElement(ShareTile, { highlight: true }))).toContain("data-highlight")
    expect(html(createElement(ShareTile, { highlight: false }))).not.toContain("data-highlight")
    expect(html(createElement(ShareTile, { highlight: false, busy: true }))).toContain("Sharing...")
  })

  it("the empty shelf invites a drop", () => {
    expect(html(createElement(EmptyState))).toContain("Drop files here")
  })

  it("the tab shows the empty state, then items, and highlights the panel under a drag", async () => {
    const cb: { items?: (i: ShelfItem[]) => void; drag?: (e: never) => void } = {}
    const store = createShelfStore({
      snapshot: async () => ({ items: [], settings: DEFAULT_SETTINGS }),
      onItems: (f) => ((cb.items = f), () => {}),
      onSettings: () => () => {},
      onDrag: (f) => ((cb.drag = f as never), () => {}),
      onError: () => () => {},
    })
    await store.start()
    expect(html(createElement(ShelfView, { store }))).toContain("Drop files here")
    cb.items!([item({ id: "a", name: "a.png" }), item({ id: "b", name: "b.png" })])
    const h = html(createElement(ShelfView, { store }))
    expect(h).toContain("a.png")
    expect(h).toContain("b.png")
    expect(h).not.toContain("Drop files here")
    ;(cb.drag as (e: unknown) => void)({ phase: "enter", x: 0, y: 0, zone: "shelf", added: 0 })
    expect(html(createElement(ShelfView, { store }))).toContain("data-shelf-panel")
    expect(html(createElement(ShelfView, { store }))).toMatch(/data-shelf-panel="" data-highlight=""|data-highlight="" /)
  })

  it("the settings page lists the Mac's shelf options and reflects their state", () => {
    const h = html(createElement(ShelfPageView, { settings: { ...DEFAULT_SETTINGS, autoRemove: true }, onChange: () => {} }))
    for (const t of ["Enable shelf", "Open shelf by default if items are present", "Expanded drag detection area", "Copy items on drag", "Remove from shelf after dragging", "Tap the shelf to open items", "Windows share sheet"]) {
      expect(h).toContain(t)
    }
    expect(h.match(/aria-checked="true"/g)?.length).toBe(5)
    expect(h.match(/aria-checked="false"/g)?.length).toBe(1)
  })
})
