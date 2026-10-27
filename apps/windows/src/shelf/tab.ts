// The Shelf's tab descriptor and its registration with the notch's tab host.
//
// The host (src/relo/tabs.ts, written by another change) owns the tab bar. This file works with or without it:
//  - `registerShelfTab()` calls `registerTab(shelfTab)` from ../relo/tabs when that module exists in the build;
//    import it once from the notch entry (src/main.tsx): `import "./shelf/tab"` runs it.
//  - Without that module, `shelfTab` is exported for the host to register itself.
//
// What the host must do for parity with the Mac:
//  - show the tab only when `shelfTab.visible(settings)` (boringShelf);
//  - select it when a drag arrives: `shelfStore().onDragEvent(e => e.phase === "enter" && select("shelf"))`, so the
//    notch (already opened by Rust, which treats a drag over the window as hovering it) lands on the shelf;
//  - select it on open when `opensByDefault(shelfStore().get())` (open shelf by default if items are present);
//  - render `shelfTab.View` with `active` (this tab is on screen) and `onFit`.
import { createElement, type ComponentType } from "react"
import { opensByDefault, shelfStore } from "./store"
import type { ShelfSettings } from "./types"
import { ShelfView, type ShelfViewProps } from "./ShelfView"

export interface ShelfTabDescriptor {
  id: "shelf"
  title: string
  /** Position among tabs: after Relo (0). */
  order: number
  /** SVG path data (24x24, stroke) for the tab button. */
  iconPath: string
  visible: (settings: ShelfSettings) => boolean
  View: ComponentType<ShelfViewProps>
  /** Select this tab when a drag enters the notch. */
  selectOnDrag: true
  /** Select this tab when the notch opens and this returns true. */
  selectOnOpen: () => boolean
}

export const shelfTab: ShelfTabDescriptor = {
  id: "shelf",
  title: "Shelf",
  order: 10,
  iconPath: "M4 13l2-7h12l2 7M4 13v5a1 1 0 001 1h14a1 1 0 001-1v-5M4 13h4l1 2h6l1-2h4",
  visible: (s) => s.enabled,
  View: ShelfView,
  selectOnDrag: true,
  selectOnOpen: () => opensByDefault(shelfStore().get()),
}

// Vite resolves this at build time: an empty object when ../relo/tabs.ts does not exist yet.
const hosts = import.meta.glob<{ registerTab?: (tab: unknown) => void }>("../relo/tabs.ts", { eager: true })

export function registerShelfTab(): boolean {
  for (const mod of Object.values(hosts)) {
    if (typeof mod.registerTab === "function") {
      mod.registerTab(shelfTab)
      return true
    }
  }
  return false
}

registerShelfTab()

/** For a host that renders tabs itself: the shelf as an element. */
export const shelfElement = (props: ShelfViewProps = {}) => createElement(ShelfView, props)
