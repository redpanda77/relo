// The shelf's page-side state: items and settings (Rust owns them and pushes changes), the selection, and the state
// of an incoming drag. A small external store so the tab, the settings page and the host can all read it.
import { useSyncExternalStore } from "react"
import { IDLE_DRAG, reduceDrag, type DragState } from "./drag"
import * as ipc from "./ipc"
import { click, dragIds, EMPTY_SELECTION, prune, selectAll, type ClickModifiers, type Selection } from "./selection"
import { DEFAULT_SETTINGS, type ShelfDragEvent, type ShelfItem, type ShelfSettings } from "./types"

export interface ShelfState {
  loaded: boolean
  items: ShelfItem[]
  settings: ShelfSettings
  selection: Selection
  drag: DragState
  /** Item being renamed in place. */
  renaming: string | null
  error: string | null
}

export interface ShelfIO {
  snapshot(): Promise<{ items: ShelfItem[]; settings: ShelfSettings } | null>
  onItems(cb: (items: ShelfItem[]) => void): () => void
  onSettings(cb: (s: ShelfSettings) => void): () => void
  onDrag(cb: (e: ShelfDragEvent) => void): () => void
  onError(cb: (m: string) => void): () => void
}

export const realIO: ShelfIO = { snapshot: ipc.snapshot, onItems: ipc.onItems, onSettings: ipc.onSettings, onDrag: ipc.onDrag, onError: ipc.onError }

export const INITIAL: ShelfState = { loaded: false, items: [], settings: DEFAULT_SETTINGS, selection: EMPTY_SELECTION, drag: IDLE_DRAG, renaming: null, error: null }

export const order = (s: ShelfState) => s.items.map((i) => i.id)

/** The Mac opens the notch on the shelf when it has items and "open shelf by default" is on. */
export const opensByDefault = (s: Pick<ShelfState, "items" | "settings">) => s.settings.enabled && s.settings.openByDefault && s.items.length > 0

export interface ShelfStore {
  get(): ShelfState
  start(): Promise<void>
  subscribe(cb: () => void): () => void
  click(id: string, m: ClickModifiers): void
  clearSelection(): void
  selectAll(): void
  setRenaming(id: string | null): void
  dragIdsFrom(id: string): string[]
  /** Called from the drag handlers of the host to know a drag is over the notch. */
  onDragEvent(cb: (e: ShelfDragEvent) => void): () => void
  dismissError(): void
  setError(message: string): void
}

export function createShelfStore(io: ShelfIO): ShelfStore {
  let state = INITIAL
  let starting: Promise<void> | null = null
  const listeners = new Set<() => void>()
  const dragListeners = new Set<(e: ShelfDragEvent) => void>()
  const set = (next: Partial<ShelfState>) => {
    state = { ...state, ...next }
    listeners.forEach((l) => l())
  }
  const setItems = (items: ShelfItem[]) => {
    const selection = prune(state.selection, items.map((i) => i.id))
    set({ items, selection, renaming: state.renaming && items.some((i) => i.id === state.renaming) ? state.renaming : null })
  }
  return {
    get: () => state,
    start() {
      starting ??= (async () => {
        io.onItems(setItems)
        io.onSettings((settings) => set({ settings }))
        io.onError((error) => set({ error }))
        io.onDrag((e) => {
          set({ drag: reduceDrag(state.drag, e) })
          dragListeners.forEach((l) => l(e))
        })
        const snap = await io.snapshot()
        if (snap) setItems(snap.items)
        set({ loaded: true, ...(snap ? { settings: snap.settings } : {}) })
      })()
      return starting
    },
    subscribe(cb) {
      listeners.add(cb)
      return () => void listeners.delete(cb)
    },
    click: (id, m) => set({ selection: click(state.selection, id, order(state), m) }),
    clearSelection: () => state.selection.ids.size && set({ selection: EMPTY_SELECTION }),
    selectAll: () => set({ selection: selectAll(order(state)) }),
    setRenaming: (renaming) => set({ renaming }),
    dragIdsFrom: (id) => dragIds(state.selection, id, order(state)),
    onDragEvent(cb) {
      dragListeners.add(cb)
      return () => void dragListeners.delete(cb)
    },
    dismissError: () => set({ error: null }),
    setError: (error) => set({ error }),
  }
}

let singleton: ShelfStore | null = null
/** The app's one store, backed by Rust. */
export const shelfStore = (): ShelfStore => (singleton ??= createShelfStore(realIO))

/** `const s = useShelf()`: live shelf state in any window (starts the store). */
export function useShelf(store: ShelfStore = shelfStore()): ShelfState {
  return useSyncExternalStore(
    (cb) => {
      void store.start()
      return store.subscribe(cb)
    },
    store.get,
    store.get,
  )
}
