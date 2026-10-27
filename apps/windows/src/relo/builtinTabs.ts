// The notch's tabs beyond Relo, registered with the tab host (relo/tabs.ts) in the Mac's order: System, Music, Shelf
// (TabSelectionView.tabs). Import it once from the notch entry (src/main.tsx); calling it again changes nothing.
//
//   - Music: `musicTab` (src/music/index.ts step 1; id "home").
//   - Shelf: `shelfTab` (src/shelf/tab.ts). The bar shows it only while the Shelf is switched on (`boringShelf`), and
//     the notch selects it when a drag enters and when it opens with items on it (`shelfSelectsOnDrag`, `shelfOpensByDefault`).
//   - System: `systemTab` (src/system).

import { createElement } from "react"
import { musicTab } from "../music"
import { shelfTab } from "../shelf/tab"
import { shelfStore } from "../shelf/store"
import { ShelfView } from "../shelf/ShelfView"
import { systemTab } from "../system"
import { registerTab } from "./tabs"

let registered = false

/** True when the Shelf is switched on in its settings (the tab is shown only then). */
export const shelfEnabled = (): boolean => shelfTab.visible(shelfStore().get().settings)

/** "Open shelf by default": the notch opens on the Shelf when it holds items. */
export const shelfOpensByDefault = (): boolean => shelfTab.selectOnOpen()

/** The first "enter" of a drag over the notch (Rust treats a drag over the window as hovering it). */
export function onShelfDragEnter(cb: () => void): () => void {
  void shelfStore().start()
  return shelfStore().onDragEvent((e) => {
    if (e.phase === "enter" && shelfTab.selectOnDrag && shelfEnabled()) cb()
  })
}

export function registerBuiltinTabs(): void {
  if (registered) return
  registered = true
  registerTab({ id: "system", icon: createElement(systemTab.icon), view: systemTab.view })
  registerTab({ id: musicTab.id, label: musicTab.label, icon: musicTab.icon, view: musicTab.view, height: musicTab.height })
  void shelfStore().start()
  registerTab({
    id: shelfTab.id,
    label: shelfTab.title,
    view: ShelfView,
    icon: undefined,
    visible: shelfEnabled,
    subscribeVisible: (cb) => shelfStore().subscribe(cb),
  })
}

/** Test hook: lets `registerBuiltinTabs` run again after `resetTabs`. */
export function forgetBuiltinTabs(): void {
  registered = false
}
