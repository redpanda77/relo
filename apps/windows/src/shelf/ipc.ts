// The shelf's bridge to Rust. Everything is a no-op outside Tauri (tests, a plain browser).
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { inTauri } from "../bridge"
import type { HotRect } from "../geometry"
import type { ShelfDragEvent, ShelfItem, ShelfSettings } from "./types"

function onEvent<T>(name: string, cb: (payload: T) => void): () => void {
  if (!inTauri) return () => {}
  const p = listen<T>(name, (e) => cb(e.payload))
  return () => void p.then((off) => off())
}

const call = <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => invoke<T>(cmd, args)

export interface Snapshot {
  items: ShelfItem[]
  settings: ShelfSettings
}

export const snapshot = (): Promise<Snapshot | null> => (inTauri ? call<Snapshot>("shelf_snapshot").catch(() => null) : Promise.resolve(null))
export const onItems = (cb: (items: ShelfItem[]) => void) => onEvent<ShelfItem[]>("shelf_items", cb)
export const onSettings = (cb: (s: ShelfSettings) => void) => onEvent<ShelfSettings>("shelf_settings", cb)
/** A drag over the notch: the host opens the notch on the shelf tab on "enter". */
export const onDrag = (cb: (e: ShelfDragEvent) => void) => onEvent<ShelfDragEvent>("shelf_drag", cb)
export const onMenu = (cb: (m: { action: string; ids: string[] }) => void) => onEvent<{ action: string; ids: string[] }>("shelf_menu", cb)
export const onError = (cb: (message: string) => void) => onEvent<string>("shelf_error", cb)

export const setSettings = (patch: Partial<ShelfSettings>) => (inTauri ? call<ShelfSettings>("shelf_settings_set", { patch }) : Promise.resolve(null))

export const remove = (ids: string[]) => (inTauri ? call<number>("shelf_remove", { ids }) : Promise.resolve(0))
export const cleanup = () => (inTauri ? call<number>("shelf_cleanup").catch(() => 0) : Promise.resolve(0))
export const rename = (id: string, name: string) => call<void>("shelf_rename", { id, name })
export const open = (id: string) => (inTauri ? call<void>("shelf_open", { id }) : Promise.resolve())
export const quickLook = (ids: string[]) => (inTauri ? call<void>("shelf_quick_look", { ids }) : Promise.resolve())
export const copy = (ids: string[]) => (inTauri ? call<void>("shelf_copy", { ids }) : Promise.resolve())
export const share = (ids: string[]) => (inTauri ? call<void>("shelf_share", { ids }) : Promise.resolve())
export const pickAndShare = () => (inTauri ? call<number>("shelf_pick_and_share") : Promise.resolve(0))
export const contextMenu = (ids: string[]) => (inTauri ? call<void>("shelf_context_menu", { ids }) : Promise.resolve())
/** Starts a drag to Explorer or another app and resolves when it ends (0 nothing, 1 copied, 2 moved). */
export const dragOut = (ids: string[]) => (inTauri ? call<number>("shelf_drag_out", { ids }) : Promise.resolve(0))
export const addPaths = (paths: string[]) => (inTauri ? call<number>("shelf_add_paths", { paths }) : Promise.resolve(0))
export const setShareRect = (rect: HotRect | null) => {
  if (inTauri) void call<void>("shelf_set_share_rect", { rect }).catch(() => {})
}

/** A thumbnail PNG for a file item, as a blob URL; null when the shell has none. */
export async function thumbnail(id: string, size = 112): Promise<string | null> {
  if (!inTauri) return null
  try {
    const buf = await call<ArrayBuffer>("shelf_thumbnail", { id, size })
    return URL.createObjectURL(new Blob([buf], { type: "image/png" }))
  } catch {
    return null
  }
}
