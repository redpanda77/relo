// The shelf's shapes, as Rust sends them (src-tauri/src/shelf/model.rs).

export type ShelfKind = "file" | "text" | "link"

export interface ShelfItem {
  id: string
  kind: ShelfKind
  /** What the tile shows: a file's name, a text's first words, a link without its scheme. */
  name: string
  path: string | null
  text: string | null
  url: string | null
  /** A copy the shelf made itself (dropped data); deleted when the item leaves. */
  isTemporary: boolean
  isDir: boolean
  /** The file is gone; the shelf drops it the next time it appears. */
  missing: boolean
  addedMs: number
}

/** The Mac's Shelf settings (boringShelf, openShelfByDefault, expandedDragDetection, copyOnDrag, autoRemoveShelfItems). */
export interface ShelfSettings {
  enabled: boolean
  openByDefault: boolean
  expandedDragDetection: boolean
  copyOnDrag: boolean
  autoRemove: boolean
  tapToOpen: boolean
}

export const DEFAULT_SETTINGS: ShelfSettings = {
  enabled: true,
  openByDefault: true,
  expandedDragDetection: true,
  copyOnDrag: false,
  autoRemove: false,
  tapToOpen: true,
}

export type DragZone = "shelf" | "share"

/** `shelf_drag`: a file, text or link is being dragged over the notch window. */
export interface ShelfDragEvent {
  phase: "enter" | "over" | "leave" | "drop"
  /** Window-relative physical px. */
  x: number
  y: number
  zone: DragZone
  /** On "drop": how many new items the shelf took. */
  added: number
}
