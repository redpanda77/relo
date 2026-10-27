// The Shelf tab: the Mac's ShelfView (a share tile beside a dashed drop panel of items), ShelfItemView and
// FileShareView, in the notch's language. Drops are handled natively (OLE, in Rust); this page shows the result,
// highlights the zone a drag is over, and starts drags OUT of the shelf.
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react"
import { setKeyboard } from "../bridge"
import { toHotRect } from "../geometry"
import { COLORS } from "../relo/ui/theme"
import * as ipc from "./ipc"
import { shelfStore, useShelf, type ShelfStore } from "./store"
import type { ShelfItem } from "./types"

const ACCENT = COLORS.running
const DRAG_THRESHOLD = 3

// ---- Glyphs ----

const Glyph = ({ d, size = 28 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
)
const GLYPH = {
  tray: "M4 13l2-7h12l2 7M4 13v5a1 1 0 001 1h14a1 1 0 001-1v-5M4 13h4l1 2h6l1-2h4M12 3v6M9.5 6.5L12 9l2.5-2.5",
  share: "M12 15V4M8 7.5L12 4l4 3.5M6 12v7h12v-7",
  text: "M5 6h14M5 10h14M5 14h9M5 18h6",
  link: "M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1",
  file: "M7 3h7l5 5v12a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1zM14 3v5h5",
  folder: "M3 7a1 1 0 011-1h5l2 2h9a1 1 0 011 1v9a1 1 0 01-1 1H4a1 1 0 01-1-1z",
  missing: "M12 8v5M12 16v.01M10.3 4.2L2.8 17a2 2 0 001.7 3h15a2 2 0 001.7-3L13.7 4.2a2 2 0 00-3.4 0z",
}

// ---- Thumbnails ----

const thumbCache = new Map<string, string | null>()
const thumbWaiting = new Map<string, Promise<string | null>>()

/** The shell's thumbnail for a file item (its icon when it has no preview); null until it arrives. */
export function useThumbnail(item: ShelfItem): string | null {
  const key = `${item.id}:${item.path ?? ""}`
  const [url, setUrl] = useState<string | null>(thumbCache.get(key) ?? null)
  useEffect(() => {
    if (item.kind !== "file" || item.missing) return
    if (thumbCache.has(key)) {
      setUrl(thumbCache.get(key) ?? null)
      return
    }
    let live = true
    let p = thumbWaiting.get(key)
    if (!p) {
      p = ipc.thumbnail(item.id).then((u) => {
        thumbCache.set(key, u)
        thumbWaiting.delete(key)
        return u
      })
      thumbWaiting.set(key, p)
    }
    void p.then((u) => live && setUrl(u))
    return () => {
      live = false
    }
  }, [key, item.kind, item.id, item.missing])
  return url
}

// ---- One item ----

export interface ItemTileProps {
  item: ShelfItem
  selected: boolean
  renaming: boolean
  thumb: string | null
  onPointerDown?: (e: ReactPointerEvent<HTMLDivElement>) => void
  onDoubleClick?: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  onRename?: (name: string | null) => void
}

function glyphFor(item: ShelfItem): string {
  if (item.missing) return GLYPH.missing
  if (item.kind === "text") return GLYPH.text
  if (item.kind === "link") return GLYPH.link
  return item.isDir ? GLYPH.folder : GLYPH.file
}

export function ItemTile({ item, selected, renaming, thumb, onPointerDown, onDoubleClick, onContextMenu, onRename }: ItemTileProps) {
  const style: CSSProperties = {
    width: 96,
    background: selected ? "color-mix(in srgb, " + ACCENT + " 18%, transparent)" : "transparent",
    boxShadow: selected ? `inset 0 0 0 2px color-mix(in srgb, ${ACCENT} 80%, transparent)` : "inset 0 0 0 1px transparent",
  }
  return (
    <div
      role="option"
      aria-selected={selected}
      data-shelf-item={item.id}
      data-kind={item.kind}
      className="flex shrink-0 select-none flex-col items-center gap-0.5 rounded-xl px-1 py-2 transition-colors duration-100"
      style={style}
      title={item.path ?? item.url ?? item.text ?? item.name}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      <div className="flex items-center justify-center overflow-hidden rounded-xl" style={{ width: 56, height: 56, boxShadow: "0 2px 3px rgb(0 0 0 / 0.15)", background: thumb ? "transparent" : "rgb(255 255 255 / 0.92)", color: "#2a2a33" }}>
        {thumb ? <img src={thumb} alt="" draggable={false} style={{ width: "100%", height: "100%", objectFit: "contain" }} /> : <Glyph d={glyphFor(item)} />}
      </div>
      {renaming ? (
        <RenameField initial={item.name} onDone={(name) => onRename?.(name)} />
      ) : (
        <div className="w-full text-center text-[12px] font-medium leading-[15px] text-white" style={{ height: 30, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", wordBreak: "break-word", opacity: item.missing ? 0.45 : 1 }}>
          {item.name}
        </div>
      )}
    </div>
  )
}

function RenameField({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    // The notch never takes focus; a text field is the one time it must (as the sign-in server field does).
    setKeyboard(true)
    const el = ref.current
    if (el) {
      el.focus()
      const dot = initial.lastIndexOf(".")
      el.setSelectionRange(0, dot > 0 ? dot : initial.length)
    }
    return () => setKeyboard(false)
  }, [initial])
  const finish = (commit: boolean) => onDone(commit ? (ref.current?.value ?? initial) : null)
  return (
    <input
      ref={ref}
      defaultValue={initial}
      aria-label="Rename"
      className="w-full rounded bg-white/15 px-1 text-center text-[12px] text-white outline-none"
      style={{ height: 22, marginTop: 4 }}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(true)
        else if (e.key === "Escape") finish(false)
        e.stopPropagation()
      }}
      onBlur={() => finish(true)}
    />
  )
}

// ---- Share tile and empty state ----

export function ShareTile({ highlight, busy, onClick, tileRef }: { highlight: boolean; busy?: boolean; onClick?: () => void; tileRef?: React.Ref<HTMLDivElement> }) {
  return (
    <div
      ref={tileRef}
      role="button"
      aria-label="Share"
      data-shelf-share
      data-highlight={highlight ? "" : undefined}
      onClick={onClick}
      className="relative flex shrink-0 flex-col items-center justify-center gap-1.5 rounded-xl"
      style={{
        width: 128,
        background: "linear-gradient(135deg, rgb(0 0 0 / 0.35), rgb(0 0 0 / 0.2))",
        border: `3px dashed ${highlight ? ACCENT : "rgb(255 255 255 / 0.1)"}`,
        boxShadow: "0 2px 6px rgb(0 0 0 / 0.6)",
        cursor: "pointer",
      }}
    >
      <div className="flex items-center justify-center rounded-full" style={{ width: 55, height: 55, background: `rgb(255 255 255 / ${highlight ? 0.11 : 0.09})`, color: highlight ? ACCENT : "#9a9aa5", transform: highlight ? "scale(1.06)" : "none", transition: "transform 0.25s" }}>
        <Glyph d={GLYPH.share} size={30} />
      </div>
      <div className="text-[15px] font-semibold text-white/80">{busy ? "Sharing..." : "Share"}</div>
    </div>
  )
}

export function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2.5 text-white/50">
      <Glyph d={GLYPH.tray} size={34} />
      <div className="text-[18px] font-medium">Drop files here</div>
    </div>
  )
}

// ---- The tab ----

export interface ShelfViewProps {
  /** The shelf tab is the one on screen (the notch is open on it). Drops on the share tile need this. */
  active?: boolean
  /** Reports the height the tab needs, as the Relo tab does. */
  onFit?: (height: number) => void
  store?: ShelfStore
}

export function ShelfView({ active = true, onFit, store = shelfStore() }: ShelfViewProps) {
  const s = useShelf(store)
  const tile = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  const items = s.items
  const overShelf = s.drag.over && s.drag.zone === "shelf"
  const overShare = s.drag.over && s.drag.zone === "share"

  useEffect(() => onFit?.(220), [onFit])

  // Items whose files vanished leave the shelf when it appears (the Mac's cleanupInvalidItems).
  useEffect(() => {
    if (active) void ipc.cleanup()
  }, [active])

  // Tell Rust where the share tile is, so a drop on it shares instead of keeping. The notch springs open, so
  // keep reporting while this tab is on screen; null when it is not.
  useEffect(() => {
    if (!active) {
      ipc.setShareRect(null)
      return
    }
    let last = ""
    const report = () => {
      const r = tile.current?.getBoundingClientRect()
      if (!r) return
      const hot = toHotRect(r, window.devicePixelRatio)
      const k = hot.join(",")
      if (k !== last) {
        last = k
        ipc.setShareRect(hot)
      }
    }
    report()
    const t = setInterval(report, 120)
    return () => {
      clearInterval(t)
      ipc.setShareRect(null)
    }
  }, [active])

  // A menu choice the page handles itself.
  useEffect(
    () =>
      ipc.onMenu((m) => {
        if (m.action === "rename" && m.ids[0]) store.setRenaming(m.ids[0])
      }),
    [store],
  )

  // Starting a drag out: press on an item, move past the threshold, hand over to the OS drag loop.
  const press = useCallback(
    (item: ShelfItem, e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      store.click(item.id, { shift: e.shiftKey, toggle: e.ctrlKey || e.metaKey })
      const from = { x: e.clientX, y: e.clientY }
      const move = (m: PointerEvent) => {
        if (Math.hypot(m.clientX - from.x, m.clientY - from.y) <= DRAG_THRESHOLD) return
        cleanup()
        void ipc.dragOut(store.dragIdsFrom(item.id)).catch(() => {})
      }
      const cleanup = () => {
        window.removeEventListener("pointermove", move)
        window.removeEventListener("pointerup", cleanup)
        window.removeEventListener("pointercancel", cleanup)
      }
      window.addEventListener("pointermove", move)
      window.addEventListener("pointerup", cleanup)
      window.addEventListener("pointercancel", cleanup)
    },
    [store],
  )

  const selectedIds = [...s.selection.ids]
  const onKey = (e: KeyboardEvent) => {
    if (s.renaming) return
    if (e.key === " " && selectedIds.length) {
      e.preventDefault()
      void ipc.quickLook(selectedIds)
    } else if (e.key === "Enter") selectedIds.forEach((id) => void ipc.open(id))
    else if (e.key === "Delete" || e.key === "Backspace") void ipc.remove(selectedIds)
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault()
      store.selectAll()
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && selectedIds.length) void ipc.copy(selectedIds)
    else if (e.key === "Escape") store.clearSelection()
  }

  useEffect(() => {
    if (!s.error) return
    const t = setTimeout(store.dismissError, 5000)
    return () => clearTimeout(t)
  }, [s.error, store])

  const finishRename = async (item: ShelfItem, name: string | null) => {
    store.setRenaming(null)
    if (name === null || name.trim() === item.name) return
    try {
      await ipc.rename(item.id, name.trim())
    } catch (err) {
      store.setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="flex h-full w-full gap-3 p-3 outline-none" tabIndex={0} onKeyDown={onKey} data-shelf-view>
      <ShareTile
        tileRef={tile}
        highlight={overShare}
        busy={busy}
        onClick={() => {
          setBusy(true)
          void ipc.pickAndShare().finally(() => setBusy(false))
        }}
      />
      <div
        role="listbox"
        aria-label="Shelf"
        aria-multiselectable
        data-shelf-panel
        data-highlight={overShelf ? "" : undefined}
        className="relative min-w-0 flex-1 rounded-2xl"
        style={{ border: `3px dashed ${overShelf ? ACCENT : "rgb(255 255 255 / 0.1)"}`, transition: "border-color 0.15s" }}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.shelfScroll !== undefined) store.clearSelection()
        }}
      >
        {items.length === 0 ? (
          <EmptyState />
        ) : (
          <div data-shelf-scroll className="flex h-full items-center gap-2 overflow-x-auto overflow-y-hidden p-2" style={{ scrollbarWidth: "none" }}>
            {items.map((item) => (
              <ItemTileConnected key={item.id} item={item} store={store} press={press} onRename={(name) => void finishRename(item, name)} />
            ))}
          </div>
        )}
        {s.error && (
          <div role="alert" className="absolute inset-x-3 bottom-1 rounded-md bg-black/70 px-2 py-1 text-center text-[11px] text-[#ff7a66]" onClick={store.dismissError}>
            {s.error}
          </div>
        )}
      </div>
    </div>
  )
}

function ItemTileConnected({ item, store, press, onRename }: { item: ShelfItem; store: ShelfStore; press: (item: ShelfItem, e: ReactPointerEvent<HTMLDivElement>) => void; onRename: (name: string | null) => void }) {
  const s = useShelf(store)
  const thumb = useThumbnail(item)
  return (
    <ItemTile
      item={item}
      selected={s.selection.ids.has(item.id)}
      renaming={s.renaming === item.id}
      thumb={thumb}
      onPointerDown={(e) => press(item, e)}
      onDoubleClick={() => [...store.get().selection.ids].forEach((id) => void ipc.open(id))}
      onContextMenu={(e) => {
        e.preventDefault()
        if (!store.get().selection.ids.has(item.id)) store.click(item.id, { shift: false, toggle: false })
        void ipc.contextMenu([...store.get().selection.ids])
      }}
      onRename={onRename}
    />
  )
}
